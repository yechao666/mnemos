import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** 生成带前缀的短 ID，例如 mem_9f2c1a4b7d3e5f60 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoDaysAgo(days: number, from: Date = new Date()): string {
  const d = new Date(from.getTime() - days * 86_400_000);
  return d.toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** API Key 明文：mnemos_live_<随机>；仅创建时返回一次。 */
export function newApiKeySecret(): { secret: string; prefix: string; hash: string } {
  const body = randomBytes(24).toString('base64url');
  const secret = `mnemos_live_${body}`;
  return { secret, prefix: secret.slice(0, 18), hash: sha256(secret) };
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function utcDayStart(daysAgo: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
