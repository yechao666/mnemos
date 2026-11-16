import type { MemoryBrief, MemoryDreamRunStatus, MemoryDreamTrigger } from '@shared';
import { DREAM_DEFAULT_INTERVAL_MINUTES } from '@shared';
import type { Tone } from '@ui';

/** 记忆简报 / 复盘总结组件共用的换算、标签与小工具。 */

export type IntervalUnit = 'minutes' | 'hours' | 'days';

export const INTERVAL_UNIT_OPTIONS: { value: IntervalUnit; label: string }[] = [
  { value: 'minutes', label: '分钟' },
  { value: 'hours', label: '小时' },
  { value: 'days', label: '天' },
];

const MINUTES_PER_UNIT: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** 把「数值 + 单位」换算成分钟（后端统一存分钟）。 */
export function toMinutes(value: number, unit: IntervalUnit): number {
  return Math.round(value * MINUTES_PER_UNIT[unit]);
}

/** 把分钟换算成人类可读周期：整除时用天/小时，否则用分钟。 */
export function intervalLabel(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return '—';
  const total = Math.round(minutes);
  if (total % 1440 === 0) return `${total / 1440} 天`;
  if (total % 60 === 0) return `${total / 60} 小时`;
  return `${total} 分钟`;
}

/** 分钟 → 表单里的数值与单位（尽量用最大的整数单位，回显更自然）。 */
export function splitInterval(minutes: number | null | undefined): { value: string; unit: IntervalUnit } {
  const total =
    minutes != null && Number.isFinite(minutes) && minutes > 0
      ? Math.round(minutes)
      : DREAM_DEFAULT_INTERVAL_MINUTES;
  if (total % 1440 === 0) return { value: String(total / 1440), unit: 'days' };
  if (total % 60 === 0) return { value: String(total / 60), unit: 'hours' };
  return { value: String(total), unit: 'minutes' };
}

/**
 * 简报生成方式徽标：mnemos-condense（或空 model）为确定性本地压缩，其余视为 LLM 润色。
 */
export function briefModelMeta(brief: MemoryBrief | null): { label: string; tone: Tone } {
  const model = brief?.model?.trim() ?? '';
  const local = !model || model === 'mnemos-condense' || model.startsWith('mnemos-');
  return local ? { label: '本地摘要', tone: 'slate' } : { label: 'LLM 润色', tone: 'cyan' };
}

export function runStatusMeta(status: MemoryDreamRunStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'completed':
      return { label: '完成', tone: 'green' };
    case 'skipped':
      return { label: '跳过', tone: 'slate' };
    case 'failed':
      return { label: '失败', tone: 'red' };
    case 'running':
      return { label: '进行中', tone: 'blue' };
    default:
      return { label: status, tone: 'slate' };
  }
}

export function triggerLabel(trigger: MemoryDreamTrigger): string {
  return trigger === 'manual' ? '手动' : '定时';
}
