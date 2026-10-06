import { Errors } from '@/lib/errors';
import type { Tx } from '@/server/db/client';
import type { BusinessContext } from '@/server/context';

/** Helpers for the people and places a workshop record can point at. */

export interface Technician {
  membershipId: string;
  name: string;
  roleName: string;
}

/**
 * Active members who can be put on jobs. A member with a technician profile is a technician exactly when the profile says so and is
 * active (a deactivated technician cannot be given new work, and someone marked "not a technician" is not offered). A member without
 * a profile follows the original rule: their role includes job.edit.
 */
export async function listTechnicians(tx: Tx, businessId: string): Promise<Technician[]> {
  const rows = await tx.$queryRaw<{ id: string; name: string; role: string }[]>`
    SELECT m.id, u.name, r.name AS role
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      JOIN roles r ON r.id = m.role_id
      LEFT JOIN technician_profiles tp ON tp.membership_id = m.id
     WHERE m.business_id = ${businessId}::uuid AND m.status = 'ACTIVE'
       AND (
         (tp.id IS NULL AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = m.role_id AND rp.permission = 'job.edit'))
         OR (tp.id IS NOT NULL AND tp.is_technician AND tp.status = 'ACTIVE')
       )
     ORDER BY lower(u.name)`;
  return rows.map((r) => ({ membershipId: r.id, name: r.name, roleName: r.role }));
}

/** Display names for membership ids (people who have left still resolve, so history stays readable). */
export async function memberNames(tx: Tx, businessId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT m.id, COALESCE(u.name, m.invited_email, 'Former member') AS name
      FROM memberships m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.business_id = ${businessId}::uuid AND m.id = ANY(${unique}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The membership must be an ACTIVE member of THIS business, otherwise the assignment is refused. */
export async function assertActiveMember(tx: Tx, businessId: string, membershipId: string, field = 'technician'): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM memberships WHERE id = ${membershipId}::uuid AND business_id = ${businessId}::uuid AND status = 'ACTIVE'`;
  if (rows.length === 0) throw Errors.validation({ [field]: 'Choose an active member of this business.' });
}

/**
 * The membership must be an active member who may be given work: a technician whose profile marks them inactive (or not a
 * technician) is refused, so future work is never assigned to someone who has been deactivated. Existing assignments stay untouched.
 */
export async function assertAssignableTechnician(tx: Tx, businessId: string, membershipId: string, field = 'technician'): Promise<void> {
  await assertActiveMember(tx, businessId, membershipId, field);
  const tp = await tx.technicianProfile.findFirst({ where: { businessId, membershipId }, select: { isTechnician: true, status: true } });
  if (tp && (!tp.isTechnician || tp.status !== 'ACTIVE')) throw Errors.validation({ [field]: tp.isTechnician ? 'That technician has been deactivated and cannot be given new work.' : 'That person is not set up as a technician.' });
}

export async function assertLocation(tx: Tx, businessId: string, locationId: string): Promise<void> {
  const l = await tx.location.findFirst({ where: { id: locationId, businessId, status: 'ACTIVE' }, select: { id: true } });
  if (!l) throw Errors.validation({ locationId: 'Choose a location of this business.' });
}

/**
 * The locations a member may work with, or null when they may use all of them. Records with no location
 * stay visible to everyone.
 */
export async function visibleLocationIds(tx: Tx, ctx: BusinessContext): Promise<string[] | null> {
  if (ctx.membership.allLocations) return null;
  const rows = await tx.membershipLocation.findMany({ where: { membershipId: ctx.membership.id }, select: { locationId: true } });
  return rows.map((r) => r.locationId);
}

export const locationWhere = (ids: string[] | null) => (ids ? { OR: [{ locationId: null }, { locationId: { in: ids } }] } : {});
