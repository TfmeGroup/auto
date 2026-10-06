import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with OWASP-recommended minimums (19 MiB, t=2, p=1). Parameters are
 * embedded in each hash, so they can be raised later without invalidating old
 * hashes (see needsRehash).
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/**
 * A real hash of a random password, verified when the account doesn't exist so
 * "unknown email" and "wrong password" take the same time (no user enumeration).
 */
let dummyHash: Promise<string> | null = null;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  return dummyHash.then((h) => verifyPassword(h, password));
}
