import type { Metadata } from 'next';
import { sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import AdminNav from '@/components/AdminNav';
import UsersAdminClient from '@/components/UsersAdminClient';

export const metadata: Metadata = { title: 'Users · Admin' };
export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<{ q?: string }> };

export default async function AdminUsersPage({ searchParams }: Props) {
  await requireAdmin();
  const { q = '' } = await searchParams;
  const db = await getDb();
  const where = q.trim()
    ? sql`${users.username} LIKE ${`%${q.trim().toLowerCase()}%`}`
    : sql`1`;
  const rows = await db
    .select({ id: users.id, username: users.username, createdAt: users.createdAt })
    .from(users)
    .where(where)
    .orderBy(sql`${users.createdAt} desc`)
    .limit(200);
  return (
    <div className="pt-10">
      <AdminNav active="/admin/users" />
      <h1 className="mt-6 text-2xl font-black tracking-tight text-white">Users</h1>
      <p className="mt-1 text-sm text-zinc-400">Search and click a user to assign tags.</p>
      <UsersAdminClient initial={rows} initialQuery={q} />
    </div>
  );
}
