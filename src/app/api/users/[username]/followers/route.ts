import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { getSessionUser } from '@/lib/auth';
import { getFollowList } from '@/lib/follows';

export const runtime = 'nodejs';

type Props = { params: Promise<{ username: string }> };

/**
 * Public followers/following list for a profile.
 * GET ?kind=followers (default) | ?kind=following
 *
 * Guests may read lists (the client shows follow buttons that route
 * guests to /register). Each entry carries the viewer's follow state
 * (`isFollowing`) and whether the entry is the viewer themselves
 * (`isOwn` — the UI hides the follow action for that row).
 */
export async function GET(req: Request, { params }: Props) {
  const { username } = await params;
  const kind = new URL(req.url).searchParams.get('kind') === 'following' ? 'following' : 'followers';

  const db = await getDb();
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  const session = await getSessionUser();
  const list = await getFollowList(target.id, kind, session?.user.id ?? null);
  const viewerUsername = session?.user.username ?? null;

  return NextResponse.json({
    users: list.map((entry) => ({
      ...entry,
      isOwn: viewerUsername !== null && entry.username === viewerUsername,
    })),
  });
}
