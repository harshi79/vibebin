/**
 * Email OTP verification + password recovery core.
 *
 * Two purposes share one OTP mechanism (one pending OTP per account):
 *
 *  - 'verify'    — settings: a signed-in user proves control of a recovery
 *                  email (6-digit code, 10-minute TTL). On success the email
 *                  becomes the user's verified recovery email.
 *  - 'recovery'  — forgot password: a 6-digit code is sent to the account's
 *                  VERIFIED recovery email. On success a one-time reset
 *                  token is issued via the existing hardened
 *                  `issuePasswordReset` (BUG #1) and the code is consumed.
 *
 * Security properties:
 *  - only the SHA-256 hash of the OTP is stored (never the code);
 *  - OTPs expire after 10 minutes and are one-time (cleared on use);
 *  - requests and verification attempts are rate-limited (fixed window);
 *  - recovery responses are uniform for unknown user / no verified email /
 *    wrong code / expired code — no username or email enumeration;
 *  - knowing a username alone can never produce a reset: an email must be
 *    verified first, and only its holder receives the code.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './db';
import { emailVerifications, rateLimits, users } from './db/schema';
import { isEmailEnabled, otpEmailHtml, sendEmail } from './email';
import { issuePasswordReset } from './passwordReset';

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REQUEST_WINDOW_MS = 15 * 60 * 1000; // max 5 sends / 15 min per target
const REQUEST_MAX = 5;
const VERIFY_WINDOW_MS = 10 * 60 * 1000; // max 5 tries / 10 min per account
const VERIFY_MAX = 5;

export type OtpPurpose = 'verify' | 'recovery';

export type RequestOtpResult =
  | { ok: true; sent: boolean }
  | { ok: false; error: 'invalid-email' | 'email-in-use' | 'rate-limited' | 'email-unavailable' };

export type VerifyOtpResult =
  | { ok: true; purpose: 'verify'; email: string }
  | { ok: true; purpose: 'recovery'; resetToken: string; expiresIn: number }
  | { ok: false; error: 'invalid-code' | 'rate-limited' };

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Normalizes and validates an email address. Returns null when invalid. */
export function normalizeEmail(raw: string): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

/** OTPs are exactly 6 digits. */
function isWellFormedCode(code: string): boolean {
  return /^\d{6}$/.test(code ?? '');
}

function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Fixed-window rate limiter. Returns true while under the cap.
 * The window resets after `windowMs` of inactivity.
 */
async function rateLimitAllow(
  key: string,
  kind: string,
  windowMs: number,
  max: number,
): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(rateLimits)
      .where(and(eq(rateLimits.key, key), eq(rateLimits.kind, kind)))
      .limit(1);
    let windowStart: number;
    let count: number;
    if (row && now - row.windowStart.getTime() < windowMs) {
      windowStart = row.windowStart.getTime();
      count = row.count + 1;
    } else {
      windowStart = now;
      count = 1;
    }
    await tx
      .insert(rateLimits)
      .values({ key, kind, windowStart: new Date(windowStart), count })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.kind],
        set: { windowStart: new Date(windowStart), count },
      });
    return count <= max;
  });
}

async function findUser(username: string) {
  const db = await getDb();
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.username, username.trim()))
    .limit(1);
  return u ?? null;
}

/**
 * Resolves a recovery target: the user + their VERIFIED recovery email.
 * Email takes precedence over username; exactly one user is resolved, so an
 * OTP can never be issued across accounts. Returns null for every "no
 * eligible account" case (unknown user, unknown email, unverified email).
 */
async function resolveRecoveryTarget(
  username?: string,
  email?: string,
): Promise<{ userId: string; email: string } | null> {
  const db = await getDb();
  const normEmail = email ? normalizeEmail(email) : null;
  if (normEmail) {
    const [row] = await db
      .select()
      .from(emailVerifications)
      .where(
        and(eq(emailVerifications.email, normEmail), eq(emailVerifications.emailVerified, true)),
      )
      .limit(1);
    return row ? { userId: row.userId, email: row.email } : null;
  }
  const name = (username ?? '').trim();
  if (!name) return null;
  const user = await findUser(name);
  if (!user) return null;
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(and(eq(emailVerifications.userId, user.id), eq(emailVerifications.emailVerified, true)))
    .limit(1);
  return row ? { userId: row.userId, email: row.email } : null;
}

/**
 * Consumes the pending OTP for `userId` if it matches `code` and belongs to
 * `purpose`. One-time by construction: the UPDATE is conditional on the
 * current hash, so concurrent verifications can only succeed once.
 */
async function consumePendingOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string,
): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.userId, userId))
    .limit(1);
  const hash = row?.otpHash ?? null;
  const pending =
    !!row &&
    !!hash &&
    row.otpPurpose === purpose &&
    row.otpExpiresAt !== null &&
    row.otpExpiresAt.getTime() > Date.now();
  if (!pending || !hash || hash !== sha256hex(code)) return false;

  await db.transaction(async (tx) => {
    await tx
      .update(emailVerifications)
      .set({
        emailVerified: purpose === 'verify' ? true : row.emailVerified,
        otpHash: null,
        otpPurpose: null,
        otpExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(emailVerifications.id, row.id), eq(emailVerifications.otpHash, hash)));
  });
  // Confirm we are the consumer (a racing verifier may have cleared first).
  const [after] = await db
    .select({ otpHash: emailVerifications.otpHash })
    .from(emailVerifications)
    .where(eq(emailVerifications.userId, userId))
    .limit(1);
  return after.otpHash === null;
}

async function clearPendingOtp(userId: string) {
  const db = await getDb();
  await db
    .update(emailVerifications)
    .set({ otpHash: null, otpPurpose: null, otpExpiresAt: null, updatedAt: new Date() })
    .where(eq(emailVerifications.userId, userId));
}

export async function requestOtp(input: {
  purpose: OtpPurpose;
  userId?: string | null;
  email?: string;
  username?: string;
}): Promise<RequestOtpResult> {
  if (input.purpose === 'verify') {
    // --- Settings flow: signed-in user proves a recovery email. ---
    if (!input.userId) return { ok: false, error: 'invalid-email' };
    const email = normalizeEmail(input.email ?? '');
    if (!email) return { ok: false, error: 'invalid-email' };

    const db = await getDb();
    const [taken] = await db
      .select({ id: emailVerifications.id })
      .from(emailVerifications)
      .where(
        and(eq(emailVerifications.email, email), sql`${emailVerifications.userId} != ${input.userId}`),
      )
      .limit(1);
    if (taken) return { ok: false, error: 'email-in-use' };

    if (
      !(await rateLimitAllow(`otp-req:${input.userId}`, 'otp-req', REQUEST_WINDOW_MS, REQUEST_MAX))
    ) {
      return { ok: false, error: 'rate-limited' };
    }
    if (!isEmailEnabled()) return { ok: false, error: 'email-unavailable' };

    const code = newOtpCode();
    // Send first: a failed delivery leaves no dangling OTP behind.
    const sent = await sendEmail(
      email,
      'Verify your recovery email — VibeBin',
      otpEmailHtml(code, 'verify'),
    );
    if (!sent) return { ok: false, error: 'email-unavailable' };

    const now = new Date();
    const values = {
      email,
      emailVerified: false, // a (re)requested email is unverified until its OTP passes
      otpHash: sha256hex(code),
      otpPurpose: 'verify' as const,
      otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
      updatedAt: now,
    };
    const [existing] = await db
      .select({ id: emailVerifications.id })
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, input.userId))
      .limit(1);
    if (existing) {
      await db
        .update(emailVerifications)
        .set(values)
        .where(eq(emailVerifications.userId, input.userId));
    } else {
      await db
        .insert(emailVerifications)
        .values({ id: randomUUID(), userId: input.userId, createdAt: now, ...values });
    }
    return { ok: true, sent: true };
  }

  // --- Recovery flow: the code goes to the VERIFIED recovery email only.
  //     Every ineligible case collapses to { sent: false } so the response
  //     is identical for unknown user / unknown email / unverified email.
  const target = await resolveRecoveryTarget(input.username, input.email);
  if (!target) return { ok: true, sent: false };
  if (
    !(await rateLimitAllow(`otp-req:${target.email}`, 'otp-req', REQUEST_WINDOW_MS, REQUEST_MAX))
  ) {
    return { ok: true, sent: false };
  }
  if (!isEmailEnabled()) return { ok: true, sent: false };

  const code = newOtpCode();
  const sent = await sendEmail(
    target.email,
    'Your VibeBin password recovery code',
    otpEmailHtml(code, 'recovery'),
  );
  if (!sent) return { ok: true, sent: false };

  const db = await getDb();
  await db
    .update(emailVerifications)
    .set({
      otpHash: sha256hex(code),
      otpPurpose: 'recovery',
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      updatedAt: new Date(),
    })
    .where(eq(emailVerifications.userId, target.userId));
  return { ok: true, sent: true };
}

export async function verifyOtp(input: {
  purpose: OtpPurpose;
  userId?: string | null;
  email?: string;
  username?: string;
  code: string;
}): Promise<VerifyOtpResult> {
  const code = (input.code ?? '').trim();
  if (!isWellFormedCode(code)) return { ok: false, error: 'invalid-code' };

  if (input.purpose === 'verify') {
    // --- Settings flow: the account is known via the session, so specific
    //     failure reasons are safe to surface (no cross-account leak).
    if (!input.userId) return { ok: false, error: 'invalid-code' };

    const allowed = await rateLimitAllow(
      `otp-ver:${input.userId}`,
      'otp-ver',
      VERIFY_WINDOW_MS,
      VERIFY_MAX,
    );
    if (!allowed) {
      // Too many attempts: kill the pending OTP so a fresh one is required.
      await clearPendingOtp(input.userId);
      return { ok: false, error: 'rate-limited' };
    }

    if (!(await consumePendingOtp(input.userId, 'verify', code))) {
      return { ok: false, error: 'invalid-code' };
    }

    const db = await getDb();
    const [row] = await db
      .select({ email: emailVerifications.email })
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, input.userId))
      .limit(1);
    return { ok: true, purpose: 'verify', email: row?.email ?? '' };
  }

  // --- Recovery flow: fully uniform failures (no enumeration). ---
  const target = await resolveRecoveryTarget(input.username, input.email);
  if (!target) return { ok: false, error: 'invalid-code' };

  const allowed = await rateLimitAllow(
    `otp-ver:${target.userId}`,
    'otp-ver',
    VERIFY_WINDOW_MS,
    VERIFY_MAX,
  );
  if (!allowed) {
    await clearPendingOtp(target.userId);
    return { ok: false, error: 'rate-limited' };
  }

  if (!(await consumePendingOtp(target.userId, 'recovery', code))) {
    return { ok: false, error: 'invalid-code' };
  }

  // OTP consumed — now mint the hardened one-time reset token (its own
  // transaction; not nested inside another one).
  try {
    const { token, expiresIn } = await issuePasswordReset(target.userId);
    return { ok: true, purpose: 'recovery', resetToken: token, expiresIn };
  } catch (err) {
    if (err instanceof Error && err.message === 'rate-limited') {
      // BUG #1 per-account reset cap: OTP consumed, no token issued.
      return { ok: false, error: 'rate-limited' };
    }
    throw err;
  }
}

/** Current recovery email state for the settings UI. */
export async function getRecoveryEmail(
  userId: string,
): Promise<{ email: string; verified: boolean } | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.userId, userId))
    .limit(1);
  if (!row) return null;
  return { email: row.email, verified: row.emailVerified };
}
