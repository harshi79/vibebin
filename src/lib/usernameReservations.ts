import { eq } from 'drizzle-orm';
import { usernameReservations, type UsernameReservation } from './db/schema';
import type { DB } from './db';

/**
 * Username reservation helpers (owner/admin-only feature).
 *
 * A reservation maps a lower-cased reserved name to the canonical username
 * of a real owner profile. Matching is case-insensitive via the column's
 * COLLATE NOCASE (no lower() wrapper, so the unique index stays usable).
 * No user account is ever created for a reservation.
 */

/** Same shape as the app's username validation (letters, numbers, underscore). */
export const RESERVATION_NAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/** Canonical form used for storage + comparison. */
export function normalizeReservedName(name: string): string {
  return name.trim().toLowerCase();
}

/** Case-insensitive lookup of a reservation by username. */
export async function getReservation(
  db: DB,
  username: string,
): Promise<UsernameReservation | null> {
  const [row] = await db
    .select()
    .from(usernameReservations)
    .where(eq(usernameReservations.username, username))
    .limit(1);
  return row ?? null;
}

/** Whether a username is reserved (case-insensitive). */
export async function isReservedUsername(db: DB, username: string): Promise<boolean> {
  return (await getReservation(db, username)) !== null;
}

/**
 * Resolves the target profile username for a reserved name, or null when
 * the name is not reserved. Used by the /u/[username] route to redirect
 * reserved aliases to the owner's real profile.
 */
export async function getReservationTarget(
  db: DB,
  username: string,
): Promise<string | null> {
  const reservation = await getReservation(db, username);
  return reservation ? reservation.targetUsername : null;
}
