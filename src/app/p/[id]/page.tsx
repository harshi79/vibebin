import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { pastes, users, profiles, stickers } from '@/lib/db/schema';
import { getSessionUser, getUserTags } from '@/lib/auth';
import { isBookmarked } from '@/lib/bookmarks';
import { getReactionState } from '@/lib/reactions';
import { purgeExpiredIfDue, incrementPasteViews } from '@/lib/pastes';
import { getFollowCounts, isFollowingUser, countPublicPastes } from '@/lib/follows';
import { sanitizeNameEffect, type NameStyle } from '@/lib/nameEffects';
import { loadStickerByToken } from '@/lib/stickerPack.server';
import ProfileHoverCard, { type ProfileHoverData } from '@/components/ProfileHoverCard';
import { formatViews, timeAgo } from '@/lib/format';
import {
  parsePasteContent,
  isRichDoc,
  hasRichFormatting,
  richDocHasStickerMarks,
  richDocToPlainText,
} from '@/lib/pasteFormat';
import PasteViewer from '@/components/PasteViewer';
import RichPasteView from '@/components/RichPasteView';
import UnlockForm from '@/components/UnlockForm';
import OwnerActions from '@/components/OwnerActions';
import ExpiryCountdown from '@/components/ExpiryCountdown';
import CopyButton from '@/components/CopyButton';
import CopyLinkButton from '@/components/CopyLinkButton';
import Avatar from '@/components/Avatar';
import BookmarkButton from '@/components/BookmarkButton';
import ReactionBar from '@/components/ReactionBar';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

// Shared toolbar button styling — one cohesive action bar for the paste view.
const TOOLBAR_BTN = 'btn-ghost !rounded-md !px-3 !py-2 text-xs font-bold uppercase tracking-wide';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const db = await getDb();
    const [paste] = await db
      .select({ title: pastes.title })
      .from(pastes)
      .where(eq(pastes.id, id))
      .limit(1);
    if (paste) return { title: paste.title };
  } catch {
    /* ignore */
  }
  return { title: 'Paste' };
}

export default async function PastePage({ params }: Props) {
  const { id } = await params;
  const db = await getDb();

  const [[paste], , session] = await Promise.all([
    db.select().from(pastes).where(eq(pastes.id, id)).limit(1),
    // Throttled expiry purge — avoids a DELETE on every page view; expired
    // pastes are also filtered lazily below.
    purgeExpiredIfDue(db),
    getSessionUser(),
  ]);
  if (!paste) notFound();

  const isOwner = !!session && session.user.id === paste.userId;

  if (!isOwner && !paste.passwordHash) {
    // One round trip: the increment reads back the stored count through
    // `UPDATE … RETURNING`, so no second full-row SELECT is needed. When
    // the visitor is deduplicated (rapid refresh) nothing is written and
    // the count already loaded above is displayed unchanged.
    const views = await incrementPasteViews(paste.id);
    if (views !== null) paste.views = views;
  }

  if (paste.expiresAt && paste.expiresAt.getTime() <= Date.now()) {
    return (
      <div className="grid min-h-[50vh] place-items-center pt-8 text-center">
        <div className="card animate-pop max-w-md rounded-xl p-6 text-center sm:p-8">
          <p className="text-4xl">⏳</p>
          <h1 className="mt-4 text-2xl font-black uppercase tracking-tight text-white">This paste has expired</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            This paste was set to expire and is no longer available.
          </p>
          <Link href="/paste" className="btn-primary mt-6 px-5 py-2.5 text-sm font-semibold">
            Create new paste
          </Link>
        </div>
      </div>
    );
  }

  const locked = !!paste.passwordHash && !isOwner;

  // Parse the stored content BEFORE the data fan-out (pure CPU, no I/O)
  // so the sticker-pack read below can be skipped when nothing rendered
  // on this page would use it.
  const rawUrl = `/p/${paste.id}/raw`;
  const isRich = paste.format === 'rich';
  const parsed = parsePasteContent(paste.format, paste.content);
  const richDoc = isRichDoc(parsed) ? parsed : null;
  // The pack only feeds <StickerImage> (url/alt/label lookup for sticker
  // marks). Plain pastes, locked pastes and rich docs without sticker
  // marks render identically without it, so they skip the read entirely.
  const needsStickerPack = !locked && !!richDoc && richDocHasStickerMarks(richDoc);

  // Author chip row (users ⟕ profiles) — resolved as its own promise so
  // the status-sticker lookup can chain off it without holding up the
  // rest of the fan-out.
  const authorRowPromise = paste.userId
    ? db
        .select({
          username: users.username,
          displayName: profiles.displayName,
          avatarUrl: profiles.avatarUrl,
          accent: profiles.accent,
          statusEmoji: profiles.statusEmoji,
          statusText: profiles.statusText,
          nameFrom: profiles.nameFrom,
          nameTo: profiles.nameTo,
          nameStyle: profiles.nameStyle,
          nameEffect: profiles.nameEffect,
          effectSpeed: profiles.effectSpeed,
          effectIntensity: profiles.effectIntensity,
        })
        .from(users)
        .leftJoin(profiles, eq(users.id, profiles.userId))
        .where(eq(users.id, paste.userId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : Promise.resolve(null);

  // ONE fan-out for everything the page needs. The hover-card reads
  // (tags, follow counts, follow state, paste count) depend only on
  // paste.userId, so they start alongside the author row, bookmark and
  // reaction reads instead of waiting for them. Bounded: a handful of
  // indexed queries for one author — no N+1.
  const authorId = paste.userId;
  const [
    authorRow,
    stickerRows,
    bookmarked,
    reactionState,
    authorTags,
    authorCounts,
    authorFollowState,
    authorPastes,
    authorStatusSticker,
  ] = await Promise.all([
    authorRowPromise,
    needsStickerPack
      ? db
          .select({
            token: stickers.token,
            url: stickers.url,
            emoji: stickers.emoji,
            label: stickers.label,
          })
          .from(stickers)
      : Promise.resolve([]),
    // Bookmarks are members-only — guests skip the indexed PK read.
    session ? isBookmarked(session.user.id, paste.id) : Promise.resolve(false),
    // The unified reaction state mirrors the GET /api/pastes/:id/reactions
    // payload: public counts (the ❤️ entry IS the like count) + the
    // signed-in user's ONE reaction (null for guests / none).
    getReactionState(paste.id, session?.user.id ?? null),
    authorId ? getUserTags(authorId) : Promise.resolve([]),
    authorId ? getFollowCounts(authorId) : Promise.resolve({ followers: 0, following: 0 }),
    authorId && session && session.user.id !== authorId
      ? isFollowingUser(session.user.id, authorId)
      : Promise.resolve(false),
    authorId ? countPublicPastes(authorId) : Promise.resolve(0),
    // The author's status sticker is the one read that genuinely needs the
    // author row (its token lives on the profile), so it chains off that
    // promise alone — never off the unrelated reads above.
    authorRowPromise.then((row) =>
      row?.statusEmoji ? loadStickerByToken(row.statusEmoji, db) : null,
    ),
  ]);

  // Profile-preview data for the author identity chip (hover card).
  let authorHover: ProfileHoverData | null = null;
  let followingAuthor = false;
  if (authorRow && paste.userId) {
    followingAuthor = authorFollowState;
    authorHover = {
      username: authorRow.username,
      displayName: authorRow.displayName,
      avatarUrl: authorRow.avatarUrl,
      statusEmoji: authorRow.statusEmoji ?? '',
      statusText: authorRow.statusText ?? '',
      statusSticker: authorStatusSticker,
      tags: authorTags,
      followersCount: authorCounts.followers,
      followingCount: authorCounts.following,
      pastesCount: authorPastes,
      nameFrom: authorRow.nameFrom ?? '#a78bfa',
      nameTo: authorRow.nameTo ?? '#22d3ee',
      nameStyle: (authorRow.nameStyle as NameStyle) ?? 'gradient',
      nameEffect: sanitizeNameEffect(authorRow.nameEffect ?? 'none'),
      effectSpeed: authorRow.effectSpeed ?? 50,
      effectIntensity: authorRow.effectIntensity ?? 60,
    };
  }

  return (
    <div className="animate-fade-up pb-8 pt-2 sm:pt-4">
      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
        <div className="min-w-0">
          <h1
            className="max-w-full break-words text-2xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl"
            style={paste.titleColor ? { color: paste.titleColor } : undefined}
          >
            {paste.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-400 sm:text-sm">
            {authorRow && authorHover ? (
              <ProfileHoverCard data={authorHover} following={followingAuthor} guest={!session}>
                <Link
                  href={`/u/${authorRow.username}`}
                  className="inline-flex min-w-0 max-w-[200px] items-center gap-2 rounded-md border-2 border-[color:var(--vb-line)] bg-[color:var(--vb-panel-2)] py-1 pl-1 pr-3 text-xs font-bold text-zinc-200 transition-colors hover:border-brand-400/60 hover:bg-[#1a1a24] sm:max-w-[240px]"
                >
                  <Avatar value={authorRow.avatarUrl} label={authorRow.username} className="h-5 w-5 sm:h-6 sm:w-6" />
                  <span className="min-w-0 truncate">{authorRow.displayName || authorRow.username}</span>
                </Link>
              </ProfileHoverCard>
            ) : (
              <span className="pill !py-1 !text-xs">Guest author</span>
            )}
            <span className="pill !py-1 !text-xs">{timeAgo(paste.createdAt)}</span>
            <span className="pill !py-1 !text-xs">{formatViews(paste.views)} views</span>
            {paste.visibility === 'unlisted' && <span className="pill !py-1 !text-xs">Unlisted</span>}
            {paste.passwordHash && <span className="pill !py-1 !text-xs">🔒 Protected</span>}
            {!!richDoc && hasRichFormatting(richDoc) && (
              <span className="pill !py-1 !text-xs">Rich formatting</span>
            )}
            {paste.expiresAt && <ExpiryCountdown expiresAt={paste.expiresAt.toISOString()} />}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          {/* ONE unified reaction control — the ❤️ Like is its first/default
              reaction option; there is no separate Like button. */}
          <ReactionBar
            pasteId={paste.id}
            initialCounts={reactionState.counts}
            initialMine={reactionState.mine}
            guest={!session}
          />
          <BookmarkButton pasteId={paste.id} initialBookmarked={bookmarked} guest={!session} />
          <CopyLinkButton id={paste.id} />
          {!locked && richDoc && <CopyButton text={richDocToPlainText(richDoc)} label="Copy content" className={TOOLBAR_BTN} />}
          {!locked && !isRich && <CopyButton text={paste.content} label="Copy content" className={TOOLBAR_BTN} />}
          {!locked && (
            <a href={rawUrl} className={TOOLBAR_BTN}>
              Raw view
            </a>
          )}
          {!locked && (
            <a href={`${rawUrl}?download=1`} className={TOOLBAR_BTN}>
              Download
            </a>
          )}
          {isOwner && <OwnerActions pasteId={paste.id} pinned={paste.pinned} />}
        </div>
      </div>

      <div>
        {locked ? (
          <UnlockForm pasteId={paste.id} />
        ) : richDoc ? (
          <RichPasteView doc={richDoc} stickers={stickerRows} language={paste.language} />
        ) : (
          <PasteViewer content={paste.content} language={paste.language} />
        )}
      </div>
    </div>
  );
}
