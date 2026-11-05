import { PROJECT_STATUSES, type ProjectStatus } from '@shared';
import type { Tone } from '@ui';

/** 项目配色：由 id 派生，保证同一项目在侧栏、卡片、顶栏颜色一致。 */
const PROJECT_TONES: Tone[] = ['violet', 'cyan', 'pink', 'amber', 'lime', 'blue'];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function projectTone(seed: string): Tone {
  return PROJECT_TONES[hashString(seed) % PROJECT_TONES.length] ?? 'violet';
}

/** 项目方块的首字：中文取首字，英文取首字母。 */
export function projectInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '记';
  const first = Array.from(trimmed)[0] ?? '记';
  return first.toUpperCase();
}

export function projectStatusLabel(status: ProjectStatus): string {
  return PROJECT_STATUSES.find((item) => item.value === status)?.label ?? status;
}

/** slug 生成：仅保留小写字母、数字与连字符（中文名称回退到短哈希）。 */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function shortHash(value: string): string {
  return hashString(value).toString(36).slice(0, 6);
}
