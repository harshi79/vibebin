import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

// ------------------------------------------------------------------
// Users
// ------------------------------------------------------------------
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(), // UUID stored as text
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    usernameChangedAt: integer('username_changed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('users_created_idx').on(t.createdAt)],
);

// ------------------------------------------------------------------
// Account creation tracking — enforces "max N accounts per IP"
// ------------------------------------------------------------------
export const signupIps = sqliteTable('signup_ips', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  ip: text('ip').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

// ------------------------------------------------------------------
// Profiles — fully customizable, no media is stored on the server
// (avatars, banners, video banners are all remote URLs only).
// ------------------------------------------------------------------
export type ProfileLink = { label: string; url: string; color: string };

export const profiles = sqliteTable('profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  bio: text('bio').notNull().default(''),
  bioEnabled: integer('bio_enabled', { mode: 'boolean' }).notNull().default(true),
  avatarUrl: text('avatar_url'),
  bannerUrl: text('banner_url'),
  bannerType: text('banner_type').notNull().default('image'), // 'image' | 'video'
  nameFrom: text('name_from').notNull().default('#a78bfa'),
  nameTo: text('name_to').notNull().default('#22d3ee'),
  nameStyle: text('name_style').notNull().default('gradient'), // 'solid' | 'gradient'
  // expanded effect set: none | typewriter | shimmer | neon | rainbow | fire | glitch | wave | aurora | gold
  nameEffect: text('name_effect').notNull().default('none'),
  effectSpeed: integer('effect_speed').notNull().default(50), // 0-100
  effectIntensity: integer('effect_intensity').notNull().default(60), // 0-100
  accent: text('accent').notNull().default('#8b5cf6'),
  links: text('links', { mode: 'json' }).$type<ProfileLink[]>().notNull().default([]),
  views: integer('views').notNull().default(0),
  // Custom emoji + short status text shown beside the name / username.
  statusEmoji: text('status_emoji').notNull().default(''),
  statusText: text('status_text').notNull().default(''),
});

// ------------------------------------------------------------------
// Password resets — one-time, expiring, opaque tokens (sha256 stored).
// ------------------------------------------------------------------
export const passwordResets = sqliteTable(
  'password_resets',
  {
    id: text('id').primaryKey(), // UUID stored as text
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
);

// ------------------------------------------------------------------
// Pastes — the unified editor creates every new paste as a 'rich' row:
// content is a JSON `RichDoc` whose lines may be completely unstyled
// (that IS the plain text case) or carry font / size / color / token
// formatting. 'plain' rows (raw text content) are the legacy format:
// still served and rendered exactly as before, never newly created.
// ------------------------------------------------------------------
export const pastes = sqliteTable(
  'pastes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Untitled'),
    titleColor: text('title_color'),
    // 'plain' or 'rich'
    format: text('format').notNull().default('plain'),
    content: text('content').notNull(),
    language: text('language').notNull().default('plaintext'),
    visibility: text('visibility').notNull().default('public'), // 'public' | 'unlisted'
    passwordHash: text('password_hash'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    views: integer('views').notNull().default(0),
    // Denormalized counter for the unified reaction system: the number of
    // ❤️ reactions + retained legacy anonymous likes (keeps count-only
    // reads off the reactions/likes tables). Maintained by reactions.ts.
    likesCount: integer('likes_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('pastes_user_idx').on(t.userId),
    index('pastes_created_idx').on(t.createdAt),
    index('pastes_expires_idx').on(t.expiresAt),
  ],
);

// ------------------------------------------------------------------
// Follows — one directed relationship per row (follower → following).
// The composite primary key makes duplicate follows impossible at the
// DB level; self-follows are rejected by the API/library layer.
// ------------------------------------------------------------------
export const follows = sqliteTable(
  'follows',
  {
    followerId: text('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followingId: text('following_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followingId] }),
    index('follows_following_idx').on(t.followingId),
    index('follows_follower_idx').on(t.followerId),
  ],
);

// ------------------------------------------------------------------
// Likes (LEGACY, post-unification) — anonymous visitor hearts only.
//
// The Like ❤️ was unified into the `reactions` system: a signed-in
// user's like IS the ❤️ reaction (one row in `reactions`, primary key
// (user_id, paste_id)), and `src/lib/likes.ts` is now a compatibility
// layer that delegates to it. This table only retains the anonymous
// likes created before unification (salted IP hash, no user id): they
// cannot be represented per-user and are never written again — they
// merely keep counting toward the post's ❤️ total so no existing like
// is silently lost. All signed-in like rows were converted to ❤️
// reactions by the one-time migration (src/lib/db/migrateReactions.ts)
// and removed here, so this table is NOT an independent source of
// truth for anyone's reaction state.
// ------------------------------------------------------------------
export const likes = sqliteTable(
  'likes',
  {
    id: text('id').primaryKey(), // UUID stored as text
    pasteId: text('paste_id')
      .notNull()
      .references(() => pastes.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    ipHash: text('ip_hash'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('likes_paste_idx').on(t.pasteId),
    index('likes_user_idx').on(t.userId),
  ],
);

// ------------------------------------------------------------------
// Bookmarks — one saved post per paste per signed-in user (guests can
// never bookmark; there is no anonymous bookmark). The composite primary
// key makes duplicate bookmarks impossible at the DB level; both foreign
// keys cascade, so deleting a paste or a user removes the related
// bookmarks automatically. Removing a bookmark deletes the row
// permanently (no soft-delete).
// ------------------------------------------------------------------
export const bookmarks = sqliteTable(
  'bookmarks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pasteId: text('paste_id')
      .notNull()
      .references(() => pastes.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.pasteId] }),
    index('bookmarks_paste_idx').on(t.pasteId),
    index('bookmarks_user_created_idx').on(t.userId, t.createdAt),
  ],
);

// ------------------------------------------------------------------
// Reactions — the UNIFIED post reaction system.
//
// ONE reaction per user per paste, EVER. The composite primary key on
// (user_id, paste_id) is the database-level guarantee: a user can hold
// zero or exactly one reaction on a post, never two. (The previous
// design keyed on (user_id, paste_id, reaction), which permitted one
// row per DIFFERENT reaction — that multi-reaction model was wrong and
// was migrated away; see src/lib/db/migrateReactions.ts.)
//
// The former "Like" ❤️ is not a separate system anymore: it is simply
// one value of this table's `reaction` column. `pastes.likes_count`
// remains as the denormalized ❤️ counter (❤️ reactions + legacy
// anonymous likes) so list/profile views keep working unchanged.
//
// Guests can never react (no anonymous/IP actor here — the same
// deliberate difference from the legacy like system that bookmarks
// make); the API layer resolves the user id from the session only.
//
// `reaction` stores the canonical value ONLY — either a single Unicode
// emoji grapheme ("❤️", "🔥") or the sticker pack's existing canonical
// token (":wave:"), never rendered HTML, markup or a URL. The sticker
// system is reused as-is: tokens are validated against the `stickers`
// table and the existing renderers resolve them at display time.
//
// Both foreign keys cascade, so deleting a paste or a user removes the
// reaction automatically; removing a reaction deletes the row
// permanently (no soft-delete). Changing a reaction REPLACES the single
// row atomically (upsert on the composite primary key).
// ------------------------------------------------------------------
export const reactions = sqliteTable(
  'reactions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pasteId: text('paste_id')
      .notNull()
      .references(() => pastes.id, { onDelete: 'cascade' }),
    // Canonical token: ':wave:' (sticker) or a single Unicode emoji
    // ('❤️' is the former Like). Exactly ONE value per user per paste.
    reaction: text('reaction').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.pasteId] }),
    // Grouped counts for one post ("how many of each reaction").
    index('reactions_paste_reaction_idx').on(t.pasteId, t.reaction),
    // "What did I react with on this post" + cascade lookups.
    index('reactions_paste_user_idx').on(t.pasteId, t.userId),
  ],
);

// ------------------------------------------------------------------
// Notifications — one row per recipient per event.
//
// `type` is a stable internal identifier (FOLLOW | LIKE | NEW_POST |
// ADMIN), never a UI string. `pasteId` is this project's name for the
// referenced post (pastes ARE the posts) and is null for follow/admin
// events. `dedupeKey` is the idempotency handle: a unique index collapses
// repeated events (same follow, same like, same post/follower pair) into a
// single notification — SQLite treats NULL keys as distinct, so unkeyed
// rows are never collapsed. Admin broadcasts pass a per-broadcast key so
// one broadcast operation yields exactly one row per user.
// ------------------------------------------------------------------
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(), // UUID stored as text
    recipientUserId: text('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'FOLLOW' | 'LIKE' | 'NEW_POST' | 'ADMIN'
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'cascade' }),
    pasteId: text('paste_id').references(() => pastes.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    message: text('message').notNull().default(''),
    // Optional in-app target (e.g. '/p/<id>' or '/u/<username>').
    link: text('link'),
    dedupeKey: text('dedupe_key'),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('notifications_recipient_created_idx').on(t.recipientUserId, t.createdAt),
    index('notifications_recipient_unread_idx').on(t.recipientUserId, t.isRead, t.createdAt),
    index('notifications_paste_idx').on(t.pasteId),
    uniqueIndex('notifications_dedupe_idx').on(t.dedupeKey),
  ],
);

// ------------------------------------------------------------------
// Admin-managed tags (label, color, optional effect).
// Plus a join table for user <-> tag assignments.
// ------------------------------------------------------------------
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(), // UUID stored as text
  label: text('label').notNull().unique(),
  color: text('color').notNull().default('#a78bfa'),
  // '', 'shimmer', 'neon', 'rainbow', 'fire', 'gold'
  effect: text('effect').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const userTags = sqliteTable(
  'user_tags',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tagId] })],
);

// ------------------------------------------------------------------
// Server sticker pack — admin-curated, in addition to unicode emoji.
// Stored as text/url only; no media bytes on the server.
// ------------------------------------------------------------------
export const stickers = sqliteTable('stickers', {
  id: text('id').primaryKey(), // UUID stored as text
  // the short token a user types in the editor, e.g. ":wave:"
  token: text('token').notNull().unique(),
  // image/gif url OR an emoji fallback if no url
  url: text('url'),
  emoji: text('emoji'),
  label: text('label').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

// ------------------------------------------------------------------
// Username reservations — owner/admin-reserved usernames that normal
// users can never claim. Each row maps a reserved (lower-cased) name to
// the canonical username of a real owner profile it redirects to. No user
// account is created for a reservation.
// ------------------------------------------------------------------
export const usernameReservations = sqliteTable('username_reservations', {
  id: text('id').primaryKey(), // UUID stored as text
  username: text('username').notNull().unique(),
  targetUsername: text('target_username').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

// ------------------------------------------------------------------
// Bootstrap initialization marker.
//
// Records that the app's first-install seed data (demo users, default
// tags, default stickers, ...) has already been applied to this database.
// This is what lets a genuine "first install" receive its seed data while
// guaranteeing that admin-deleted seed rows are NOT resurrected on a later
// boot. See src/lib/db/seed.ts.
// ------------------------------------------------------------------
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// ------------------------------------------------------------------
// Email verification / OTP recovery — one recovery email per user,
// one account per email. Only the SHA-256 hash of a pending 6-digit
// OTP is ever stored (never the code itself).
// ------------------------------------------------------------------
export const emailVerifications = sqliteTable(
  'email_verifications',
  {
    id: text('id').primaryKey(), // UUID stored as text
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Normalized (trimmed, lower-cased) at write time.
    email: text('email').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    // Pending OTP (at most one at a time per account).
    otpHash: text('otp_hash'), // sha256 hex of the current 6-digit code, or null
    // 'verify' (settings) or 'recovery' (forgot password)
    otpPurpose: text('otp_purpose'),
    otpExpiresAt: integer('otp_expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('email_verifications_user_idx').on(t.userId)],
);

// ------------------------------------------------------------------
// Generic fixed-window rate limiting (OTP requests / verification
// attempts). Keyed per account or per mailbox as appropriate.
// ------------------------------------------------------------------
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.kind] })],
);

export type User = typeof users.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type UsernameReservation = typeof usernameReservations.$inferSelect;
export type Paste = typeof pastes.$inferSelect;
export type Like = typeof likes.$inferSelect;
export type Bookmark = typeof bookmarks.$inferSelect;
export type Reaction = typeof reactions.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Follow = typeof follows.$inferSelect;
export type Sticker = typeof stickers.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type RateLimit = typeof rateLimits.$inferSelect;
