import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { getSessionUser } from '@/lib/auth';
import { followUser, unfollowUser } from '@/lib/follows';
import { notifyFollow, notifySafely } from '@/lib/notifications';

export const runtime = 'nodejs';

type Props = { params: Promise<{ username: string }> };

async function findTargetByUsername(username: string) {
  const db = await getDb();
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return target ?? null;
}

/**
 * Follow / unfollow endpoint.
 * - POST follows the named user; DELETE unfollows (both idempotent).
 * - Guests get 401 (the client redirects them to /register?next=…).
 * - Self-follows are rejected with 400; unknown users with 404.
 */
export async function POST(_req: Request, { params }: Props) {
  const { username } = await params;
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  const target = await findTargetByUsername(username);
  if (!target) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }
  if (target.id === session.user.id) {
    return NextResponse.json({ error: 'You cannot follow yourself.' }, { status: 400 });
  }
  const result = await followUser(session.user.id, target.id);
  // Notify the followed user — only when a NEW follow row was created
  // (`following` is false for a repeated follow), and only after the
  // follow itself succeeded. A notification failure never changes the
  // follow response.
  if (result.following) {
    await notifySafely(() =>
      notifyFollow({ id: session.user.id, username: session.user.username }, target.id),
    );
  }
  return NextResponse.json({
    ok: true,
    following: result.following,
    followersCount: result.followersCount,
  });
}

export async function DELETE(_req: Request, { params }: Props) {
  const { username } = await params;
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  const target = await findTargetByUsername(username);
  if (!target) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }
  if (target.id === session.user.id) {
    return NextResponse.json({ error: 'You cannot unfollow yourself.' }, { status: 400 });
  }
  const result = await unfollowUser(session.user.id, target.id);
  return NextResponse.json({
    ok: true,
    following: result.following,
    followersCount: result.followersCount,
  });
}
