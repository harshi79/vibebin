/**
 * Regression tests — paste view counter read-back.
 *
 * `incrementPasteViews` bumps the counter with ONE statement
 * (`UPDATE … RETURNING views`) and hands the stored post-increment value
 * back to the caller, so the paste page no longer re-SELECTs the full row
 * (content included) just to display the new count. These tests pin:
 *   - the returned value equals what is stored after the write
 *   - each real increment sees exactly the value its own write produced
 *   - a deduplicated repeat view within the window writes nothing and
 *     returns null (the page then keeps the count it already loaded)
 *   - an unknown paste id writes nothing and returns null
 *
 * Same harness as the bookmark suite: a throwaway local SQLite database
 * (the libSQL `file:local.db` fallback pointed at a temp dir before the
 * first DB access), seeded by the app's own `seedIfEmpty`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const tmpDir = mkdtempSync(join(tmpdir(), 'vibebin-paste-views-test-'));
process.chdir(tmpDir);
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.VERCEL;
process.env.AUTH_SECRET = 'unit-test-secret-0123456789-abcdef0123456789';

// Each test picks the "visitor" by IP: incrementPasteViews reads it from
// next/headers (x-forwarded-for), which is what the dedup key is built on.
const { visitor } = vi.hoisted(() => ({ visitor: { ip: '203.0.113.1' } }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ 'x-forwarded-for': visitor.ip }),
}));

import { getDb } from '@/lib/db';
import { pastes } from '@/lib/db/schema';
import { incrementPasteViews } from '@/lib/pastes';

let seq = 0;
async function createPaste(views: number) {
  const db = await getDb();
  seq += 1;
  const [paste] = await db
    .insert(pastes)
    .values({
      id: `views-paste-${seq}`,
      userId: null,
      title: `Views ${seq}`,
      format: 'plain',
      content: 'content',
      language: 'plaintext',
      visibility: 'public',
      views,
      createdAt: new Date(),
    })
    .returning();
  return paste;
}

async function storedViews(id: string): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ views: pastes.views }).from(pastes).where(eq(pastes.id, id)).limit(1);
  return row.views;
}

beforeAll(async () => {
  await getDb();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('incrementPasteViews — RETURNING read-back', () => {
  it('returns the stored post-increment count', async () => {
    visitor.ip = '203.0.113.10';
    const paste = await createPaste(41);
    expect(await incrementPasteViews(paste.id)).toBe(42);
    expect(await storedViews(paste.id)).toBe(42);
  });

  it('distinct visitors each get the exact value their own write produced', async () => {
    const paste = await createPaste(0);
    visitor.ip = '203.0.113.21';
    const first = await incrementPasteViews(paste.id);
    visitor.ip = '203.0.113.22';
    const second = await incrementPasteViews(paste.id);
    visitor.ip = '203.0.113.23';
    const third = await incrementPasteViews(paste.id);
    expect([first, second, third]).toEqual([1, 2, 3]);
    expect(await storedViews(paste.id)).toBe(3);
  });

  it('a deduplicated repeat view writes nothing and returns null', async () => {
    visitor.ip = '203.0.113.30';
    const paste = await createPaste(7);
    expect(await incrementPasteViews(paste.id)).toBe(8);
    // Same visitor, same paste, inside the dedup window → no write.
    expect(await incrementPasteViews(paste.id)).toBeNull();
    expect(await storedViews(paste.id)).toBe(8);
  });

  it('an unknown paste id writes nothing and returns null', async () => {
    visitor.ip = '203.0.113.40';
    expect(await incrementPasteViews('no-such-paste')).toBeNull();
  });
});
