import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { verifyPassword, createSession } from '@/lib/auth';

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password are required.' }, { status: 400 });
  }

  const db = await getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  // constant-ish time: always run a compare
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, '$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpQqM3vVix0uJtD.9sChsF.CSo0Na');

  if (!user || !ok) {
    return NextResponse.json({ error: 'Wrong username or password.' }, { status: 401 });
  }

  await createSession(user);
  return NextResponse.json({ ok: true, username: user.username });
}
