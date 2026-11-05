import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const ITERATIONS = 120_000;
const KEYLEN = 32;
const DIGEST = 'sha256';

/** 返回 `pbkdf2$iterations$saltHex$hashHex`，用于 SQLite 存储。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = parts[2]!;
  const expected = Buffer.from(parts[3]!, 'hex');
  const actual = pbkdf2Sync(password, salt, iterations, expected.length, DIGEST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
