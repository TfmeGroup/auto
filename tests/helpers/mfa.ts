import { prisma } from '@/server/db/client';
import { enableMfa, startMfaSetup } from '@/server/auth/mfa';
import { currentStep, decryptSecret, totpAtStep } from '@/server/auth/totp';
import { ownerQuery, userContext, type TestUser } from './factory';

/** Turn MFA on for a user exactly as the app does (setup -> verify a real code), returning what the UI would show. */
export async function enableMfaFor(user: TestUser) {
  const ctx = await userContext(user);
  const setup = await startMfaSetup(ctx);
  const { recoveryCodes } = await enableMfa(ctx, { code: totpAtStep(setup.secret, currentStep()) });
  return { secret: setup.secret, recoveryCodes, ctx };
}

/** A currently-valid code for the user, ignoring replay protection (tests use many codes per 30 s step). */
export async function freshCode(user: TestUser): Promise<string> {
  await ownerQuery('UPDATE users SET mfa_last_used_step = 0 WHERE id = $1', [user.id]);
  const u = await prisma().user.findUniqueOrThrow({ where: { id: user.id } });
  return totpAtStep(decryptSecret(u.mfaSecretEnc!), currentStep());
}
