import { z } from 'zod';
import QRCode from 'qrcode';
import { prisma, withTx, type Db } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { parseOrThrow } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { consumeAll } from '@/server/security/rate-limit';
import type { UserContext } from '@/server/context';
import { verifyPassword } from './password';
import { revokeUserSessions } from './session';
import {
  decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp,
} from './totp';

interface MfaUser {
  id: string;
  mfaEnabled: boolean;
  mfaSecretEnc: string | null;
  mfaLastUsedStep: number;
}

/**
 * Check a second factor: an authenticator code OR a recovery code. Each is single-use
 * (TOTP via the last-used time-step, recovery codes via used_at), claimed atomically.
 */
export async function verifySecondFactor(db: Db, user: MfaUser, code: string): Promise<'totp' | 'recovery' | null> {
  const trimmed = code.trim();
  if (/^\d{3}\s?\d{3}$/.test(trimmed) && user.mfaSecretEnc) {
    const step = verifyTotp(decryptSecret(user.mfaSecretEnc), trimmed, user.mfaLastUsedStep);
    if (step === null) return null;
    // Compare-and-set so two concurrent requests cannot both spend the same code.
    const won = await db.user.updateMany({ where: { id: user.id, mfaLastUsedStep: { lt: step } }, data: { mfaLastUsedStep: step } });
    return won.count === 1 ? 'totp' : null;
  }
  if (/^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(trimmed)) {
    const claimed = await db.mfaRecoveryCode.updateMany({
      where: { userId: user.id, codeHash: hashRecoveryCode(trimmed), usedAt: null },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1 ? 'recovery' : null;
  }
  return null;
}

export const mfaCodeSchema = z.object({ code: z.string().trim().min(6).max(20) });
export const mfaReauthSchema = z.object({ password: z.string().min(1).max(128), code: z.string().trim().min(6).max(20) });

/** Start enrolment: generate a pending secret (not active until a code proves the app works). */
export async function startMfaSetup(ctx: UserContext) {
  await consumeAll([{ key: `mfa-setup:user:${ctx.user.id}`, limit: 10, windowSec: 3600 }]);
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (user.mfaEnabled) throw Errors.conflict('Two-factor authentication is already on.');
  const secret = generateTotpSecret();
  await prisma().user.update({ where: { id: user.id }, data: { mfaPendingSecretEnc: encryptSecret(secret) } });
  const uri = otpauthUri(secret, user.email);
  return { secret, otpauthUri: uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 }) };
}

/** Finish enrolment: a valid code from the app turns MFA on and returns recovery codes (shown once). */
export async function enableMfa(ctx: UserContext, input: unknown) {
  const { code } = parseOrThrow(mfaCodeSchema, input);
  await consumeAll([{ key: `mfa-attempt:user:${ctx.user.id}`, limit: 10, windowSec: 900 }]);
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (user.mfaEnabled) throw Errors.conflict('Two-factor authentication is already on.');
  if (!user.mfaPendingSecretEnc) throw Errors.badRequest('Start the setup first.');
  const step = verifyTotp(decryptSecret(user.mfaPendingSecretEnc), code, 0);
  if (step === null) throw Errors.validation({ code: 'That code is not right. Check the time on your phone and try again.' });

  const codes = generateRecoveryCodes();
  await withTx(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { mfaEnabled: true, mfaEnabledAt: new Date(), mfaSecretEnc: user.mfaPendingSecretEnc, mfaPendingSecretEnc: null, mfaLastUsedStep: step },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId: user.id, codeHash: hashRecoveryCode(c) })) });
    // Everyone else signed in as this person must now prove the second factor next time.
    await revokeUserSessions(tx, user.id, ctx.sessionId);
    await recordAudit(tx, ctx.meta, { action: AuditActions.mfaEnabled, userId: user.id, resourceType: 'user', resourceId: user.id });
    await emailUser(tx, user, 'security', (to, name) => templates.mfaEnabled(to, user.firstName || name));
  });
  return { recoveryCodes: codes };
}

/** Password + a current code (or recovery code) prove it is really the account owner. */
async function assertPasswordAndFactor(ctx: UserContext, input: unknown) {
  const { password, code } = parseOrThrow(mfaReauthSchema, input);
  await consumeAll([{ key: `mfa-attempt:user:${ctx.user.id}`, limit: 10, windowSec: 900 }]);
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!user.mfaEnabled) throw Errors.conflict('Two-factor authentication is not on.');
  if (!(await verifyPassword(user.passwordHash, password))) throw Errors.validation({ password: 'Incorrect password.' });
  if (!(await verifySecondFactor(prisma(), user, code))) throw Errors.validation({ code: 'That code is not valid.' });
  return user;
}

export async function disableMfa(ctx: UserContext, input: unknown): Promise<void> {
  const user = await assertPasswordAndFactor(ctx, input);
  const required = await prisma().membership.findFirst({
    where: { userId: user.id, status: 'ACTIVE', business: { status: 'ACTIVE', requireMfa: true } },
    include: { business: { select: { name: true } } },
  });
  if (required) throw Errors.conflict(`${required.business.name} requires two-factor authentication, so it cannot be turned off.`);
  await withTx(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaEnabledAt: null, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaLastUsedStep: 0 } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.mfaDisabled, userId: user.id, resourceType: 'user', resourceId: user.id });
    await emailUser(tx, user, 'security', (to, name) => templates.mfaDisabled(to, user.firstName || name));
  });
}

export async function regenerateRecoveryCodes(ctx: UserContext, input: unknown) {
  const user = await assertPasswordAndFactor(ctx, input);
  const codes = generateRecoveryCodes();
  await withTx(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId: user.id, codeHash: hashRecoveryCode(c) })) });
    await recordAudit(tx, ctx.meta, { action: AuditActions.mfaRecoveryCodesRegenerated, userId: user.id, resourceType: 'user', resourceId: user.id });
    await emailUser(tx, user, 'security', (to, name) => templates.recoveryCodesRegenerated(to, user.firstName || name));
  });
  return { recoveryCodes: codes };
}

export async function getMfaStatus(userId: string) {
  const user = await prisma().user.findUniqueOrThrow({ where: { id: userId } });
  const remaining = user.mfaEnabled ? await prisma().mfaRecoveryCode.count({ where: { userId, usedAt: null } }) : 0;
  return { enabled: user.mfaEnabled, enabledAt: user.mfaEnabledAt, recoveryCodesRemaining: remaining };
}
