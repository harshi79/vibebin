/**
 * Database-efficiency regression tests (Audit #2 implementation).
 *
 * - Username lookups now rely on the column-level COLLATE NOCASE (no
 *   lower() wrapper), so `eq(users.username, value)` matches
 *   case-insensitively and can use the username unique index.
 * - The admin search LIKE predicate dropped the redundant lower() wrapper
 *   while staying case-insensitive (SQLite's LIKE is ASCII case-insensitive
 *   by default).
 * - The two new base-table indexes (users_created_idx, pastes_expires_idx)
 *   are created by the bootstrap schema/migration.
 *
 * Runs against a throwaway local SQLite database seeded by `seedIfEmpty`
 * (users: demo, nova) — the same pattern as the other DB-backed suites.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

// Point the local fallback database at a throwaway dir and keep any
// remote-database env vars from leaking into the suite. Must run before
// the first getDb() call.
const tmpDir = mkdtempSync(join(tmpdir(), 'vibebin-username-index-test-'));
process.chdir(tmpDir);
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.VERCEL;

import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { requestPasswordReset } from '@/lib/passwordReset';

beforeAll(async () => {
  await getDb(); // bootstraps schema + seed (demo / nova)
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('case-insensitive username lookup (COLLATE NOCASE)', () => {
  it('eq(users.username, value) matches regardless of input case', async () => {
    const db = await getDb();
    for (const needle of ['demo', 'Demo', 'DEMO', 'dEmO']) {
      const [row] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.username, needle))
        .limit(1);
      expect(row).toBeDefined();
      expect(row!.username).toBe('demo');
    }
  });

  it('returns no row for an unknown username', async () => {
    const db = await getDb();
    const rows = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.username, 'no_such_user_xyz'))
      .limit(1);
    expect(rows).toHaveLength(0);
  });

  it('LIKE without lower() still matches case-insensitively (admin search)', async () => {
    const db = await getDb();
    const rows = await db
      .select({ username: users.username })
      .from(users)
      .where(sql`${users.username} LIKE ${'%DEMO%'}`)
      .limit(10);
    expect(rows.map((r) => r.username)).toContain('demo');
  });

  it('password recovery resolves the username case-insensitively', async () => {
    const db = await getDb();
    const [demo] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'demo'))
      .limit(1);
    const result = await requestPasswordReset({ username: 'DEMO', sessionUserId: demo!.id });
    expect(result.issued).toBe(true);
  });
});

describe('base-table performance indexes', () => {
  it('creates users_created_idx on users(created_at)', async () => {
    const db = await getDb();
    const indexes = await db.all<{ name: string }>(sql.raw(`PRAGMA index_list('users')`));
    expect(indexes.map((i) => i.name)).toContain('users_created_idx');
  });

  it('creates pastes_expires_idx on pastes(expires_at)', async () => {
    const db = await getDb();
    const indexes = await db.all<{ name: string }>(sql.raw(`PRAGMA index_list('pastes')`));
    expect(indexes.map((i) => i.name)).toContain('pastes_expires_idx');
  });
});
