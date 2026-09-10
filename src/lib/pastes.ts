import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { getDb, type DB } from './db';
import { pastes } from './db/schema';
import { getClientIp } from './ip';

const nanoid = customAlphabet('0123456789abcdefghjkmnpqrstuvwxyz', 8);

export { EXPIRY_OPTIONS, expiryFromId, isExpiredDate } from './expiry';
export type { ExpiryId } from './expiry';

export async function generatePasteId(db?: DB): Promise<string> {
  const database: DB = db ?? (await getDb());
  for (let i = 0; i < 5; i++) {
    const id = nanoid();
    const [existing] = await database
      .select({ id: pastes.id })
      .from(pastes)
      .where(eq(pastes.id, id))
      .limit(1);
    if (!existing) return id;
  }
  // Astronomically unlikely; add a time suffix as a last resort.
  return nanoid() + Date.now().toString(36).slice(-4);
}

/**
 * Maximum paste age: pastes older than this are automatically removed even
 * when the creator chose "never" expire. This is a separate maximum-retention
 * rule on top of (and independent from) the user-selected expiry — a paste
 * that expires earlier via its normal `expiresAt` is still removed exactly
 * as before. The month length follows the app's existing convention
 * (1 month = 30 days, see src/lib/expiry.ts), so 6 months = 180 days.
 */
export const PASTE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** The creation-timestamp cutoff beyond which a paste is past retention. */
export function retentionCutoff(now = Date.now()): Date {
  return new Date(now - PASTE_RETENTION_MS);
}

/** True when a paste is older than the retention window (strictly > 6 months). */
export function isPastRetention(createdAt: Date, now = Date.now()): boolean {
  return createdAt.getTime() < now - PASTE_RETENTION_MS;
}

/**
 * Permanently removes expired pastes (lazy cleanup, cheap thanks to the index).
 * Removes pastes that are past their user-selected `expiresAt` OR older than
 * the 6-month retention window (`createdAt`), using the existing delete with
 * its cascade conventions.
 */
export async function purgeExpired(db: DB) {
  await db.delete(pastes).where(
    or(
      and(isNotNull(pastes.expiresAt), lt(pastes.expiresAt, new Date())),
      lt(pastes.createdAt, retentionCutoff()),
    ),
  );
}

const PURGE_INTERVAL_MS = 5 * 60 * 1000;
const purgeG = globalThis as unknown as { __vibepurge?: number };

/**
 * Purge is idempotent, so running it on every page view is wasted work —
 * at most once per process every 5 minutes is plenty (expired pastes are
 * also filtered lazily on read by the viewer).
 */
export async function purgeExpiredIfDue(db: DB): Promise<void> {
  const last = purgeG.__vibepurge ?? 0;
  const now = Date.now();
  if (now - last < PURGE_INTERVAL_MS) return;
  purgeG.__vibepurge = now;
  await purgeExpired(db);
}

export function isExpired(p: { expiresAt: Date | null }): boolean {
  return !!p.expiresAt && p.expiresAt.getTime() <= Date.now();
}

// Lightweight dedup: prevents the same IP from double-counting a paste
// within a 3-second window (covers rapid refreshes / double-taps).
const dedupG = globalThis as unknown as { __vibeviewDedup?: Map<string, number> };
const VIEW_DEDUP_MS = 3000;

function dedupKey(pasteId: string, ip: string): string {
  return `${pasteId}:${ip}`;
}

/**
 * Increment the view counter for a paste, with a short dedup window so
 * rapid refreshes from the same visitor don't inflate the count.
 *
 * Returns the paste's view count AFTER the write (read back atomically
 * via `UPDATE … RETURNING`, so concurrent viewers each see the exact
 * value their own increment produced), or `null` when no write happened
 * — the visitor was deduplicated or the paste no longer exists. Callers
 * that only care about the side effect can ignore the result.
 */
export async function incrementPasteViews(id: string): Promise<number | null> {
  const db = await getDb();

  // getClientIp() uses next/headers which is only available inside
  // request handlers. In other contexts (tests, scripts) it will throw
  // — fall back to a placeholder so the view counter still fires.
  let visitorIp = '0.0.0.0';
  try {
    visitorIp = await getClientIp();
  } catch {
    // not in a request context — keep the fallback
  }

  const now = Date.now();
  const map = dedupG.__vibeviewDedup ?? (dedupG.__vibeviewDedup = new Map());
  const key = dedupKey(id, visitorIp);
  const last = map.get(key) ?? 0;
  if (now - last < VIEW_DEDUP_MS) return null;
  map.set(key, now);

  const [row] = await db
    .update(pastes)
    .set({ views: sql`${pastes.views} + 1` })
    .where(eq(pastes.id, id))
    .returning({ views: pastes.views });
  return row?.views ?? null;
}
