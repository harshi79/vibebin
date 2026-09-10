import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from './db';
import { passwordResets, users } from './db/schema';
import { hashPassword, verifyPassword } from './auth';

const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PER_HOUR = 5;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Issues a one-time password-reset token for a user.
 * Only one valid (unused, unexpired) token exists per user at any time —
 * issuing a new one invalidates older ones. Returns the opaque token
 * (the caller delivers it to the user); only its hash is stored.
 */
export async function issuePasswordReset(userId: string): Promise<{ token: string; expiresIn: number }> {
  const db = await getDb();

  // Abuse guard: at most a handful of resets per hour per user.
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [recent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(passwordResets)
    .where(and(eq(passwordResets.userId, userId), gt(passwordResets.createdAt, since)));
  if (Number(recent?.n ?? 0) >= MAX_PER_HOUR) {
    throw new Error('rate-limited');
  }

  const token = 'vbpr_' + randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  // Replace any previous (still unused) tokens for this user. The
  // delete + insert run in one transaction so two concurrent requests
  // cannot leave two live (unused, unexpired) tokens for the same user.
  await db.transaction(async (tx) => {
    await tx
      .delete(passwordResets)
      .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    await tx.insert(passwordResets).values({
      id: randomUUID(),
      userId,
      tokenHash: sha256(token),
      expiresAt,
      createdAt: new Date(),
    });
  });

  return { token, expiresIn: RESET_TTL_MS / 1000 };
}

export type ResetRequestOutcome =
  | { issued: true; token: string; expiresIn: number }
  | { issued: false; reason: 'not-signed-in' | 'user-not-found' | 'username-mismatch' | 'rate-limited' };

/**
 * Issues a password-reset token for `username`, gated on proof of device
 * control: the requester must hold a valid session (`sessionUserId`) for
 * the very account being reset.
 *
 * VibeBin accounts have no email or phone, so the only in-app proof that
 * "this device belongs to this account" is the account's own session
 * cookie. An unauthenticated requester who merely knows the username —
 * or a signed-in attacker targeting a different account — can never
 * obtain a token.
 *
 * Every failure returns the same shape (`{ issued: false }`, no token),
 * so callers can respond identically and the API never reveals whether a
 * username exists or whether it belongs to the requesting session
 * (no username enumeration).
 */
export async function requestPasswordReset(input: {
  username: string;
  sessionUserId: string | null;
}): Promise<ResetRequestOutcome> {
  // No session at all → no proof of device control. This is the
  // unauthenticated-attacker case; it is indistinguishable from every
  // other failure.
  if (!input.sessionUserId) return { issued: false, reason: 'not-signed-in' };

  const username = (input.username || '').trim();
  if (!username) return { issued: false, reason: 'user-not-found' };

  const db = await getDb();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!user) return { issued: false, reason: 'user-not-found' };

  // The session must belong to the account being reset: a signed-in user
  // can only reset their own account, never someone else's.
  if (user.id !== input.sessionUserId) return { issued: false, reason: 'username-mismatch' };

  try {
    const { token, expiresIn } = await issuePasswordReset(user.id);
    return { issued: true, token, expiresIn };
  } catch (err) {
    if (err instanceof Error && err.message === 'rate-limited') {
      return { issued: false, reason: 'rate-limited' };
    }
    throw err;
  }
}

export type ResetError = 'invalid' | 'expired' | 'used';

/**
 * Atomically consumes a reset token and sets a new password.
 * Invalid, expired and already-used tokens all return a safe error so
 * the caller can show a clear, non-enumerating message.
 */
export async function consumePasswordReset(
  token: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: ResetError }> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, sha256(token)))
    .limit(1);

  if (!row) return { ok: false, error: 'invalid' };
  if (row.usedAt) return { ok: false, error: 'used' };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, error: 'expired' };

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) return { ok: false, error: 'invalid' };

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    // Mark used first so a second, parallel request cannot claim it.
    const [claimed] = await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt)))
      .returning({ id: passwordResets.id });
    if (!claimed) return; // already consumed by a concurrent request
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  });

  const [after] = await db.select().from(passwordResets).where(eq(passwordResets.id, row.id)).limit(1);
  return after?.usedAt ? { ok: true } : { ok: false, error: 'used' };
}

/** Changes the password after verifying the current one (signed-in flow). */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, error: 'Account not found.' };

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) return { ok: false, error: 'Current password is incorrect.' };

  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  return { ok: true };
}

/** Cleans up expired rows (cheap, indexed by user). */
export async function purgeExpiredResets(): Promise<void> {
  const db = await getDb();
  await db.delete(passwordResets).where(lt(passwordResets.expiresAt, new Date()));
}
