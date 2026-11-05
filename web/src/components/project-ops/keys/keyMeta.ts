import type { ApiKey } from '@shared';
import type { Tone } from '@ui';

export type KeyLifecycle = 'active' | 'expiring' | 'expired' | 'revoked';

/** 到期前 7 天进入「即将过期」状态。 */
export const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function keyExpiresAt(key: ApiKey): number | null {
  if (!key.expiresAt) return null;
  const parsed = Date.parse(key.expiresAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 由吊销、过期与剩余有效期推导密钥生命周期。 */
export function keyLifecycle(key: ApiKey, now = Date.now()): KeyLifecycle {
  if (key.revokedAt) return 'revoked';
  const expiresAt = keyExpiresAt(key);
  if (expiresAt === null) return 'active';
  if (expiresAt <= now) return 'expired';
  if (expiresAt - now <= EXPIRING_WINDOW_MS) return 'expiring';
  return 'active';
}

export const KEY_LIFECYCLE_META: Record<KeyLifecycle, { label: string; tone: Tone; hint: string }> = {
  active: { label: '生效', tone: 'green', hint: '密钥可正常调用' },
  expiring: { label: '即将过期', tone: 'amber', hint: '7 天内到期，建议尽快轮换' },
  expired: { label: '已过期', tone: 'red', hint: '已无法调用，请创建或轮换新密钥' },
  revoked: { label: '已吊销', tone: 'slate', hint: '已无法调用' },
};

/** 可用于调用公开 API 的密钥（未吊销且未过期）。 */
export function keyIsUsable(key: ApiKey): boolean {
  const lifecycle = keyLifecycle(key);
  return lifecycle === 'active' || lifecycle === 'expiring';
}

export const KEY_GRACE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '立即失效' },
  { value: 1, label: '1 小时' },
  { value: 24, label: '24 小时' },
  { value: 72, label: '72 小时' },
];
