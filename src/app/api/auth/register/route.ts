import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users, profiles, signupIps } from '@/lib/db/schema';
import { hashPassword, createSession } from '@/lib/auth';
import { getClientIp } from '@/lib/ip';
import { isReservedUsername } from '@/lib/usernameReservations';

const RESERVED = new Set([
  'api', 'login', 'register', 'dashboard', 'settings', 'p', 'u', 'new',
  'about', 'admin', 'explore', 'recent', 'paste', 'pastes', 'profile',
  'vibebin', 'help', 'support', 'terms', 'privacy', 'static', '_next',
  'favicon.ico', 'account', 'logout',
]);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MAX_ACCOUNTS_PER_IP = 3;

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const username = (body.username || '').trim();
  const password = body.password || '';

  if (!USERNAME_RE.test(username)) {
    return NextResponse.json(
      { error: 'Username must be 3–20 characters (letters, numbers, underscores).' },
      { status: 400 },
    );
  }
  if (RESERVED.has(username.toLowerCase())) {
    return NextResponse.json({ error: 'That username is reserved.' }, { status: 400 });
  }
  if (password.length < 6 || password.length > 100) {
    return NextResponse.json({ error: 'Password must be 6–100 characters.' }, { status: 400 });
  }

  const db = await getDb();

  // Owner-reserved usernames can never be claimed (case-insensitive).
  if (await isReservedUsername(db, username)) {
    return NextResponse.json({ error: 'That username is reserved.' }, { status: 400 });
  }

  // Per-IP signup limit. We check the case-sensitive IP string exactly
  // as it appears in the x-forwarded-for header (first hop). This is the
  // closest approximation of the "real" client on Vercel.
  const ip = await getClientIp();
  if (ip && ip !== '0.0.0.0') {
    const [countRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(signupIps)
      .where(sql`${signupIps.ip} = ${ip}`);
    const count = Number(countRow?.n ?? 0);
    if (count >= MAX_ACCOUNTS_PER_IP) {
      return NextResponse.json(
        { error: `You can only create ${MAX_ACCOUNTS_PER_IP} accounts from this network.` },
        { status: 429 },
      );
    }
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existing) {
    return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();
  const [user] = await db
    .insert(users)
    .values({ id: randomUUID(), username, passwordHash, createdAt: now })
    .returning();

  await db.insert(profiles).values({ userId: user.id, displayName: user.username });
  if (ip && ip !== '0.0.0.0') {
    await db.insert(signupIps).values({ userId: user.id, ip, createdAt: now });
  }

  await createSession(user);
  return NextResponse.json({ ok: true, username: user.username });
}
