import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { usernameReservations, users } from '@/lib/db/schema';
import { isAdmin } from '@/lib/auth';
import { normalizeReservedName, RESERVATION_NAME_RE } from '@/lib/usernameReservations';

async function requireAdmin() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const guard = await requireAdmin();
  if (guard) return guard;
  const db = await getDb();
  const rows = await db.select().from(usernameReservations).orderBy(asc(usernameReservations.username));
  return NextResponse.json({ reservations: rows });
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard) return guard;

  let body: { username?: string; targetUsername?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const username = normalizeReservedName(String(body.username ?? ''));
  const targetRaw = String(body.targetUsername ?? '').trim();

  if (!RESERVATION_NAME_RE.test(username)) {
    return NextResponse.json(
      { error: 'Username must be 3–20 characters (letters, numbers, underscores).' },
      { status: 400 },
    );
  }
  if (!targetRaw) {
    return NextResponse.json({ error: 'Target profile is required.' }, { status: 400 });
  }

  const db = await getDb();

  // The target must be a real, existing profile (never a fake account).
  const [targetUser] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.username, targetRaw))
    .limit(1);
  if (!targetUser) {
    return NextResponse.json({ error: 'Target profile does not exist.' }, { status: 400 });
  }

  // Never shadow an existing real username/account.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existingUser) {
    return NextResponse.json(
      { error: 'That username belongs to an existing account.' },
      { status: 409 },
    );
  }

  // Duplicate reservation (case-insensitive) handled cleanly.
  const [existingReservation] = await db
    .select({ id: usernameReservations.id })
    .from(usernameReservations)
    .where(eq(usernameReservations.username, username))
    .limit(1);
  if (existingReservation) {
    return NextResponse.json({ error: 'That username is already reserved.' }, { status: 409 });
  }

  const [row] = await db
    .insert(usernameReservations)
    .values({
      id: randomUUID(),
      username,
      targetUsername: targetUser.username,
      createdAt: new Date(),
    })
    .returning();

  return NextResponse.json({ reservation: row });
}

export async function DELETE(req: Request) {
  const guard = await requireAdmin();
  if (guard) return guard;

  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  if (!id) return NextResponse.json({ error: 'Missing id.' }, { status: 400 });

  const db = await getDb();
  await db.delete(usernameReservations).where(eq(usernameReservations.id, id));
  return NextResponse.json({ ok: true });
}
