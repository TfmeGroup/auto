import { z } from 'zod';
import { prisma } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { consumeAll } from '@/server/security/rate-limit';
import type { UserContext } from '@/server/context';
import { verifySecondFactor } from './mfa';
import { verifyPassword } from './password';

export const reauthSchema = z.object({
  password: z.string().min(1, 'Enter your password').max(128),
  mfaCode: z.string().trim().max(20).optional(),
});

/**
 * Step-up re-authentication for dangerous actions (ownership transfer, closing a
 * business, deactivating an account): the signed-in person must prove who they
 * are again — their password and, if they use MFA, a fresh code — right now,
 * regardless of how long their session has been open.
 */
export async function verifyReauth(ctx: UserContext, input: { password?: string; mfaCode?: string }): Promise<void> {
  await consumeAll([{ key: `reauth:user:${ctx.user.id}`, limit: 8, windowSec: 900 }]);
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });

  const fail = async (field: 'password' | 'mfaCode', message: string) => {
    await recordAudit(prisma(), ctx.meta, { action: AuditActions.reauthFailed, userId: user.id, resourceType: 'user', resourceId: user.id, metadata: { field } });
    throw Errors.validation({ [field]: message });
  };

  if (!input.password || !(await verifyPassword(user.passwordHash, input.password))) return fail('password', 'Incorrect password.');
  if (user.mfaEnabled) {
    if (!input.mfaCode) return fail('mfaCode', 'Enter a code from your authenticator app.');
    if (!(await verifySecondFactor(prisma(), user, input.mfaCode))) return fail('mfaCode', 'That code is not valid.');
  }
}
