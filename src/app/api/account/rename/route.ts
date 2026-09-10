import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { getSessionUser, createSession } from '@/lib/auth';
import { isReservedUsername } from '@/lib/usernameReservations';

const RESERVED = new Set([
  'api', 'login', 'register', 'dashboard', 'settings', 'p', 'u', 'new',
  'about', 'admin', 'explore', 'recent', 'paste', 'pastes', 'profile',
  'vibebin', 'help', 'support', 'terms', 'privacy', 'static', '_next',
  'favicon.ico', 'account', 'logout',
]);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const RENAME_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  let body: { username?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const newName = (body.username || '').trim();
  if (!USERNAME_RE.test(newName)) {
    return NextResponse.json(
      { error: 'Username must be 3–20 characters (letters, numbers, underscores).' },
      { status: 400 },
    );
  }
  if (RESERVED.has(newName.toLowerCase())) {
    return NextResponse.json({ error: 'That username is reserved.' }, { status: 400 });
  }
  if (newName === session.user.username) {
    return NextResponse.json({ error: 'That is already your username.' }, { status: 400 });
  }

  // Locked if past the window or if user already used their one rename.
  const tooLate = Date.now() - session.user.createdAt.getTime() > RENAME_WINDOW_MS;
  if (tooLate) {
    return NextResponse.json(
      { error: 'Your username is locked. You can no longer rename.' },
      { status: 403 },
    );
  }
  if ((session.user as { usernameChangedAt?: Date | null }).usernameChangedAt) {
    return NextResponse.json(
      { error: 'You have already renamed your account once.' },
      { status: 403 },
    );
  }

  const db = await getDb();
  if (await isReservedUsername(db, newName)) {
    return NextResponse.json({ error: 'That username is reserved.' }, { status: 400 });
  }
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, newName))
    .limit(1);
  if (existing) {
    return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 });
  }

  await db
    .update(users)
    .set({ username: newName, usernameChangedAt: new Date() })
    .where(eq(users.id, session.user.id));

  await createSession({ id: session.user.id, username: newName });

  return NextResponse.json({ ok: true, username: newName });
}
