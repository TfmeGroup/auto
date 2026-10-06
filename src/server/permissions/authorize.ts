import { Errors } from '@/lib/errors';
import type { BusinessContext } from '@/server/context';
import type { Permission } from './catalog';

/** True if the caller holds the permission in the current business. */
export function can(ctx: Pick<BusinessContext, 'permissions'>, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

/** Throw FORBIDDEN unless the caller holds the permission. */
export function requirePermission(ctx: Pick<BusinessContext, 'permissions'>, permission: Permission): void {
  if (!ctx.permissions.has(permission)) throw Errors.forbidden();
}

/** Throw FORBIDDEN unless the caller holds at least one of the permissions. */
export function requireAnyPermission(ctx: Pick<BusinessContext, 'permissions'>, permissions: Permission[]): void {
  if (!permissions.some((p) => ctx.permissions.has(p))) throw Errors.forbidden();
}
