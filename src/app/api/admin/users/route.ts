import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isAdmin } from '@/lib/auth';

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const db = await getDb();
  const where = q
    ? sql`${users.username} LIKE ${`%${q}%`}`
    : sql`1`;
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(where)
    .orderBy(sql`${users.createdAt} desc`)
    .limit(200);
  return NextResponse.json({ users: rows });
}
