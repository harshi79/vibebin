import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { pastes, profiles, users } from '@/lib/db/schema';
import { getSessionUser, getUserTags, isAdmin } from '@/lib/auth';
import { getReservationTarget } from '@/lib/usernameReservations';
import { computeBadges } from '@/lib/badges';
import { formatDate, formatViews } from '@/lib/format';
import NameDisplay from '@/components/NameDisplay';
import { sanitizeNameEffect } from '@/lib/nameEffects';
import Avatar from '@/components/Avatar';
import SafeImage from '@/components/SafeImage';
import PasteCard from '@/components/PasteCard';
import SocialPlatformIcon from '@/components/SocialPlatformIcon';
import { detectSocialPlatform } from '@/lib/socialPlatform';
import AdminTags from '@/components/AdminTags';
import TagBadge from '@/components/TagBadge';
import EmojiStatus from '@/components/EmojiStatus';
import FollowButton from '@/components/FollowButton';
import FollowStats from '@/components/FollowStats';
import { loadStickerByToken } from '@/lib/stickerPack.server';
import { getFollowCounts, isFollowingUser } from '@/lib/follows';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username}` };
}

export default async function ProfilePage({ params }: Props) {
  const { username } = await params;
  const db = await getDb();

  // Owner-reserved aliases resolve to the owner's real profile (no user
  // account is created for the alias). Matching is case-insensitive.
  const reservationTarget = await getReservationTarget(db, username);
  if (reservationTarget) {
    redirect(`/u/${reservationTarget}`);
  }

  const [row] = await db
    .select({ user: users, profile: profiles })
    .from(users)
    .leftJoin(profiles, eq(users.id, profiles.userId))
    .where(eq(users.username, username))
    .limit(1);

  if (!row) notFound();

  const user = row.user;
  const profile = row.profile ?? {
    userId: user.id,
    displayName: null,
    bio: '',
    bioEnabled: true,
    avatarUrl: null,
    bannerUrl: null,
    bannerType: 'image',
    nameFrom: '#a78bfa',
    nameTo: '#22d3ee',
    nameStyle: 'gradient',
    nameEffect: 'none',
    effectSpeed: 50,
    effectIntensity: 60,
    accent: '#8b5cf6',
    links: [],
    views: 0,
    statusEmoji: '',
    statusText: '',
  };

  const [session, adminStatus, userTags, userPastes, statusSticker, followCounts] = await Promise.all([
    getSessionUser(),
    isAdmin(),
    getUserTags(user.id),
    db
      .select()
      .from(pastes)
      .where(eq(pastes.userId, user.id))
      .orderBy(desc(pastes.pinned), desc(pastes.createdAt))
      .limit(100),
    loadStickerByToken(profile.statusEmoji, db),
    getFollowCounts(user.id),
  ]);

  const isOwner = session?.user.id === user.id;
  const isFollowing =
    session && !isOwner ? await isFollowingUser(session.user.id, user.id) : false;

  const nowVisible = userPastes.filter(
    (paste) =>
      (!paste.expiresAt || paste.expiresAt.getTime() > Date.now()) &&
      (isOwner || paste.visibility === 'public'),
  );
  const pinned = nowVisible.filter((paste) => paste.pinned);
  const rest = nowVisible.filter((paste) => !paste.pinned);

  const [, badges] = await Promise.all([
    isOwner
      ? Promise.resolve()
      : db
          .update(profiles)
          .set({ views: sql`${profiles.views} + 1` })
          .where(eq(profiles.userId, user.id)),
    computeBadges(user, profile, nowVisible),
  ]);

  const totalViews = nowVisible.reduce((s, paste) => s + paste.views, 0);
  const totalLikes = nowVisible.reduce((s, paste) => s + (paste.likesCount ?? 0), 0);

  return (
    <div className="pt-4 sm:pt-6">
      <div className="animate-fade-up relative h-40 overflow-hidden rounded-xl border-2 border-[color:var(--vb-line)] shadow-[6px_6px_0_0_var(--vb-ink)] sm:h-44 lg:h-48">
        {profile.bannerUrl && profile.bannerType === 'video' ? (
          <video
            src={profile.bannerUrl}
            autoPlay
            muted
            loop
            playsInline
            className="h-full w-full object-cover"
          />
        ) : profile.bannerUrl ? (
          <SafeImage src={profile.bannerUrl} className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background: `linear-gradient(120deg, ${profile.nameFrom}33, ${profile.accent}55 45%, ${profile.nameTo}33)`,
            }}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-night-950/90 via-night-950/20 to-transparent" />
      </div>

      <div className="animate-fade-up relative -mt-10 px-1 sm:-mt-12 sm:px-6" style={{ animationDelay: '60ms' }}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end">
            <div
              className="w-fit rounded-full border-2 p-1"
              style={{
                borderColor: 'var(--vb-line)',
                background: 'var(--vb-panel)',
                boxShadow: `6px 6px 0 var(--vb-ink)`,
              }}
            >
              <Avatar
                value={profile.avatarUrl}
                label={profile.displayName || user.username}
                className="h-20 w-20 sm:h-24 sm:w-24"
              />
            </div>
            <div className="min-w-0 pb-1">
              {/* One logical row: display name → title/tag → EmojiStatus.
                  Every child is an inline-flex with items-center so the
                  unicode status and the animated sticker/GIF status share
                  the exact same vertically-centered slot. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1 className="inline-flex min-w-0 items-center break-words text-3xl font-black uppercase leading-[0.95] tracking-tight sm:text-5xl">
                  <NameDisplay
                    text={profile.displayName || user.username}
                    from={profile.nameFrom}
                    to={profile.nameTo}
                    style={profile.nameStyle as 'solid' | 'gradient'}
                    effect={sanitizeNameEffect(profile.nameEffect)}
                    speed={profile.effectSpeed}
                    intensity={profile.effectIntensity}
                  />
                </h1>
                {userTags.length > 0 && (
                  <div className="inline-flex flex-wrap items-center gap-1.5">
                    {userTags.map((tag) => (
                      <TagBadge
                        key={tag.id}
                        label={tag.label}
                        color={tag.color}
                        effect={tag.effect}
                        size="sm"
                      />
                    ))}
                  </div>
                )}
                {/* Status emoji/GIF sits after the display name + title badges. */}
                <EmojiStatus
                  value={profile.statusEmoji}
                  pack={statusSticker ? [statusSticker] : undefined}
                  className="inline-flex shrink-0 items-center text-xl leading-none sm:text-3xl"
                  title={profile.statusText || 'Status'}
                />
              </div>
              {/* Second line: username · joined date · text status */}
              <p className="mt-2 break-words font-mono text-xs text-zinc-400 sm:text-sm">
                @{user.username} · joined {formatDate(user.createdAt)}
                {profile.statusText ? <span className="ml-1.5 text-zinc-500">· {profile.statusText}</span> : null}
              </p>
            </div>
          </div>
          {!isOwner && (
            <div className="flex shrink-0 items-center self-start pt-1 sm:self-end">
              <FollowButton
                username={user.username}
                initialFollowing={isFollowing}
                guest={!session}
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 sm:mt-3">
          {badges.map((badge) => (
            <span
              key={badge.id}
              className="inline-flex items-center gap-1 rounded border border-black/40 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wide text-white shadow-[2px_2px_0_0_var(--vb-ink)]"
              style={{ background: `linear-gradient(100deg, ${badge.from}, ${badge.to})` }}
              title={badge.label}
            >
              {badge.emoji} {badge.label}
            </span>
          ))}
          <FollowStats
            username={user.username}
            followersCount={followCounts.followers}
            followingCount={followCounts.following}
            guest={!session}
          />
          <span className="chip">{formatViews(profile.views)} profile views</span>
          <span className="chip">{nowVisible.length} pastes</span>
          <span className="chip">{formatViews(totalViews)} paste views</span>
          <span className="chip">♥ {formatViews(totalLikes)} likes</span>
        </div>

        {profile.bioEnabled && profile.bio && (
          <p className="mt-5 max-w-3xl whitespace-pre-wrap border-l-4 border-[color:var(--vb-line)] pl-4 text-sm leading-7 text-zinc-300 sm:mt-4 sm:text-[15px]">
            {profile.bio}
          </p>
        )}

        {profile.links.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2.5 sm:mt-3">
            {profile.links.map((link, i) => {
              const detected = detectSocialPlatform(link.url);
              const label = (link.label ?? '').trim() || detected.label;
              const accent = detected.color;
              return (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="flex items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-bold transition-transform hover:-translate-x-px hover:-translate-y-px hover:brightness-110"
                  style={{
                    borderColor: `${accent}66`,
                    background: `${accent}14`,
                    color: accent,
                  }}
                >
                  <SocialPlatformIcon platform={detected.icon} className="h-4 w-4 shrink-0" />
                  <span>{label}</span>
                </a>
              );
            })}
          </div>
        )}

        {adminStatus && !isOwner && (
          <AdminTags userId={user.id} initialTagIds={userTags.map((tag) => tag.id)} />
        )}
      </div>

      <section className="mt-10">
        {pinned.length > 0 && (
          <>
            <h2 className="mb-4 text-xl font-black uppercase tracking-tight text-white sm:text-2xl">Pinned</h2>
            <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {pinned.map((paste) => (
                <PasteCard key={paste.id} paste={paste} />
              ))}
            </div>
          </>
        )}

        <h2 className="mb-4 text-xl font-black uppercase tracking-tight text-white sm:text-2xl">Pastes</h2>
        {rest.length === 0 && pinned.length === 0 ? (
          <p className="card rounded-lg px-6 py-8 text-center text-zinc-400 sm:px-8 sm:py-10">
            {isOwner ? (
              <>
                You haven&apos;t created any pastes yet.{' '}
                <Link href="/paste" className="font-semibold text-brand-300 hover:text-brand-200">
                  Create your first
                </Link>
              </>
            ) : (
              'No public pastes yet.'
            )}
          </p>
        ) : rest.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing else here yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((paste) => (
              <PasteCard key={paste.id} paste={paste} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
