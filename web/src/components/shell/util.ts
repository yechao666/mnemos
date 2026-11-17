import type { Tone } from '@ui';
import type { PartitionStatus } from '@lib/types.ts';

/** 分区配色：由 id 派生，保证同一分区在侧栏、卡片、顶栏颜色一致。 */
const PARTITION_TONES: Tone[] = ['violet', 'cyan', 'pink', 'amber', 'lime', 'blue'];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function partitionTone(seed: string): Tone {
  return PARTITION_TONES[hashString(seed) % PARTITION_TONES.length] ?? 'violet';
}

/** 分区方块的首字：中文取首字，英文取首字母。 */
export function partitionInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '区';
  const first = Array.from(trimmed)[0] ?? '区';
  return first.toUpperCase();
}

const STATUS_LABEL: Record<PartitionStatus, string> = {
  active: '运行中',
  paused: '已暂停',
  archived: '已归档',
};

export function partitionStatusLabel(status: PartitionStatus | string | undefined): string {
  return STATUS_LABEL[(status ?? 'active') as PartitionStatus] ?? String(status ?? '—');
}

export function partitionStatusTone(status: PartitionStatus | string | undefined): Tone {
  if (status === 'paused') return 'amber';
  if (status === 'archived') return 'slate';
  return 'green';
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
