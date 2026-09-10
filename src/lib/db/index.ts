import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { seedIfEmpty } from './seed';
import { migrateReactionsUnified } from './migrateReactions';

/**
 * VibeBin database layer — Turso/libSQL edition.
 *
 * - If TURSO_DATABASE_URL is set, connect to Turso (HTTP/WebSocket).
 * - Otherwise fall back to a local SQLite file for development.
 *
 * The schema is created automatically on first use — no migrations to run.
 */
export type DB = LibSQLDatabase<typeof schema>;

// Tables added after initial launch. Idempotent (CREATE ... IF NOT EXISTS):
// included in the fresh-database schema AND re-run on every boot of
// pre-existing databases so they pick up new tables without a migration tool.
const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    otp_hash TEXT,
    otp_purpose TEXT,
    otp_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_verifications_user_idx ON email_verifications (user_id)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, kind)
  )`,

  // Bootstrap initialization marker (records that first-install seed data
  // has been applied — see src/lib/db/seed.ts). Idempotent + safe on every
  // boot of pre-existing databases.
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,

  // Username reservations — owner/admin-reserved usernames that normal
  // users can never claim. `username` is stored lower-cased and unique
  // (COLLATE NOCASE), so matching is case-insensitive at the DB level.
  // `target_username` is the canonical username of the real owner profile
  // the alias redirects to. No user row is created for a reservation.
  `CREATE TABLE IF NOT EXISTS username_reservations (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    target_username TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  // Follow system — one row per directed follow relationship. The
  // composite primary key makes duplicate follows impossible; self-follows
  // are rejected by the API/library layer. Indexes keep the follower and
  // following counts and list queries indexed.
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, following_id)
  )`,
  `CREATE INDEX IF NOT EXISTS follows_following_idx ON follows (following_id)`,
  `CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows (follower_id)`,

  // Bookmarks — a signed-in user's saved posts. One row per (user, paste)
  // pair: the composite primary key makes duplicate bookmarks impossible
  // at the DB level, and both foreign keys cascade (deleting a paste or a
  // user removes the related bookmarks permanently). The (user_id,
  // created_at) index backs the keyset-paginated "saved posts" listing.
  `CREATE TABLE IF NOT EXISTS bookmarks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paste_id TEXT NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, paste_id)
  )`,
  `CREATE INDEX IF NOT EXISTS bookmarks_paste_idx ON bookmarks (paste_id)`,
  `CREATE INDEX IF NOT EXISTS bookmarks_user_created_idx ON bookmarks (user_id, created_at)`,

  // Reactions — the UNIFIED post reaction system: ONE reaction per user
  // per paste, enforced by the composite primary key (user_id, paste_id).
  // The former Like ❤️ is one value of `reaction` (see
  // src/lib/db/migrateReactions.ts for the one-time unification of the
  // old likes table and the old multi-reaction table). `reaction` holds
  // the canonical value only — a single Unicode emoji ('❤️', '🔥') or the
  // sticker pack's existing canonical token (e.g. ':wave:') — never
  // rendered HTML. Both foreign keys cascade, so deleting a paste or a
  // user removes the reaction. The (paste_id, reaction) index backs the
  // grouped per-post counts and (paste_id, user_id) backs the "my
  // reaction on this post" read.
  `CREATE TABLE IF NOT EXISTS reactions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paste_id TEXT NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, paste_id)
  )`,
  `CREATE INDEX IF NOT EXISTS reactions_paste_reaction_idx ON reactions (paste_id, reaction)`,
  `CREATE INDEX IF NOT EXISTS reactions_paste_user_idx ON reactions (paste_id, user_id)`,

  // Notifications — one row per recipient per event (FOLLOW / LIKE /
  // NEW_POST / ADMIN). `dedupe_key` is the idempotency handle: the unique
  // index collapses repeated events into one notification (SQLite treats
  // NULLs as distinct, so rows without a key are never collapsed).
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    actor_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    paste_id TEXT REFERENCES pastes(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    link TEXT,
    dedupe_key TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx ON notifications (recipient_user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx ON notifications (recipient_user_id, is_read, created_at)`,
  `CREATE INDEX IF NOT EXISTS notifications_paste_idx ON notifications (paste_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (dedupe_key)`,
];

// Indexes on the BASE tables (users, pastes). These can't live inside
// MIGRATION_STATEMENTS because they reference tables that are created later
// in SCHEMA_STATEMENTS below (a CREATE INDEX before the table exists fails).
// They are applied idempotently to pre-existing databases on every boot, and
// appended to the fresh-database schema so brand-new databases get them too.
const BASE_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at)`,
  `CREATE INDEX IF NOT EXISTS pastes_expires_idx ON pastes (expires_at)`,
];

const SCHEMA_STATEMENTS = [
  ...MIGRATION_STATEMENTS,
  // Base users table.
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    username_changed_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT,
    bio TEXT NOT NULL DEFAULT '',
    bio_enabled INTEGER NOT NULL DEFAULT 1,
    avatar_url TEXT,
    banner_url TEXT,
    banner_type TEXT NOT NULL DEFAULT 'image',
    name_from TEXT NOT NULL DEFAULT '#a78bfa',
    name_to TEXT NOT NULL DEFAULT '#22d3ee',
    name_style TEXT NOT NULL DEFAULT 'gradient',
    name_effect TEXT NOT NULL DEFAULT 'none',
    effect_speed INTEGER NOT NULL DEFAULT 50,
    effect_intensity INTEGER NOT NULL DEFAULT 60,
    accent TEXT NOT NULL DEFAULT '#8b5cf6',
    links TEXT NOT NULL DEFAULT '[]',
    views INTEGER NOT NULL DEFAULT 0,
    status_emoji TEXT NOT NULL DEFAULT '',
    status_text TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id)`,

  `CREATE TABLE IF NOT EXISTS pastes (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Untitled',
    title_color TEXT,
    format TEXT NOT NULL DEFAULT 'plain',
    content TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'plaintext',
    visibility TEXT NOT NULL DEFAULT 'public',
    password_hash TEXT,
    expires_at INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    likes_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS pastes_user_idx ON pastes (user_id)`,
  `CREATE INDEX IF NOT EXISTS pastes_created_idx ON pastes (created_at)`,

  // Likes — a paste can be liked or unliked (no dislikes).
  // One like per signed-in user, one per anonymous IP (salted hash).
  `CREATE TABLE IF NOT EXISTS likes (
    id TEXT PRIMARY KEY,
    paste_id TEXT NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    ip_hash TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS likes_paste_idx ON likes (paste_id)`,
  `CREATE INDEX IF NOT EXISTS likes_user_idx ON likes (user_id)`,
  // Partial unique indexes for deduplication
  `CREATE UNIQUE INDEX IF NOT EXISTS likes_paste_user_idx ON likes (paste_id, user_id) WHERE user_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS likes_paste_ip_idx ON likes (paste_id, ip_hash) WHERE ip_hash IS NOT NULL`,

  // Per-IP signup tracking (max 3 accounts per IP).
  `CREATE TABLE IF NOT EXISTS signup_ips (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS signup_ips_ip_idx ON signup_ips (ip)`,

  // Admin-managed tags + assignments.
  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#a78bfa',
    effect TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_tags (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, tag_id)
  )`,

  // Server sticker pack (for the rich-text editor).
  `CREATE TABLE IF NOT EXISTS stickers (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    url TEXT,
    emoji TEXT,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,

  // Base-table performance indexes (see BASE_INDEX_STATEMENTS above).
  ...BASE_INDEX_STATEMENTS,
];

const g = globalThis as unknown as { __vibedb?: Promise<DB> };

async function createDb(): Promise<DB> {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl) {
    // Connect to Turso (remote database)
    const client = createClient({
      url: tursoUrl,
      authToken: tursoToken,
    });
    return drizzle(client, { schema });
  }

  // Local development: use a local SQLite file
  if (process.env.VERCEL) {
    throw new Error(
      'TURSO_DATABASE_URL is required on Vercel. ' +
        'Add your Turso connection string in Vercel → Settings → Environment Variables.',
    );
  }

  const client = createClient({
    url: 'file:local.db',
  });
  return drizzle(client, { schema });
}

/**
 * Returns the shared database connection, bootstrapping schema + seed data
 * once per process.
 */
export async function getDb(): Promise<DB> {
  if (!g.__vibedb) {
    g.__vibedb = (async () => {
      const db = await createDb();

      // Enable foreign key enforcement (SQLite requires this per connection)
      await db.run(sql`PRAGMA foreign_keys = ON`);

      // Check if users table exists
      const exists = await db.all(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
      );

      if (exists.length > 0) {
        // Existing deployment: schema already exists — apply the
        // idempotent additions for newer tables, run the one-time
        // data migrations (marker-guarded), then seed if needed.
        for (const stmt of MIGRATION_STATEMENTS) {
          await db.run(sql.raw(stmt));
        }
        for (const stmt of BASE_INDEX_STATEMENTS) {
          await db.run(sql.raw(stmt));
        }
        await migrateReactionsUnified(db);
        await seedIfEmpty(db);
        return db;
      }

      // Fresh database: create all tables
      for (const stmt of SCHEMA_STATEMENTS) {
        await db.run(sql.raw(stmt));
      }
      // Fresh databases are created with the unified schema already;
      // this only records the migration marker so later boots no-op.
      await migrateReactionsUnified(db);
      await seedIfEmpty(db);
      return db;
    })();
  }
  return g.__vibedb;
}
