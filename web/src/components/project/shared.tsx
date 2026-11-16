import type { MemoryCategory, MemorySource } from '@shared';
import { CATEGORY_LABEL, SIGNAL_LABELS, TONE_COLORS } from '@shared';
import { Badge, Icon, type IconName, type Tone } from '@ui';
import { toneForCategory } from '@lib/tone.ts';
import { fmtPct } from '@lib/format.ts';

/** 项目工作区内复用的轻量展示组件与格式化工具。 */

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 按项目名生成稳定的语义色调，保证同一项目在列表与工作区颜色一致。 */
export function projectTone(seed: string): Tone {
  if (!seed) return 'violet';
  return TONE_COLORS[hashString(seed) % TONE_COLORS.length] as Tone;
}

/** 中文取后两字 / 英文取首字母，用于项目 mark。 */
export function projectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'M';
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed.slice(0, 2);
  const parts = trimmed.split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = parts.map((part) => part.slice(0, 1).toUpperCase()).join('');
  return initials || trimmed.slice(0, 2).toUpperCase();
}

export const SOURCE_LABEL: Record<MemorySource, string> = {
  conversation: '对话',
  api: 'API',
  agent: 'Agent',
  import: '批量导入',
  playground: '演练场',
  dream: '复盘总结整理',
};

export function fmtRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return fmtPct(value <= 1 ? value * 100 : value);
}

/** 将 0–1（或 0–100）的分值归一到百分比宽度。 */
export function normalizePct(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
}

export function formatSignalValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value <= 1 ? value.toFixed(2) : value.toFixed(0);
}

export function formatScore(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return '—';
  return score <= 1 ? score.toFixed(3) : score.toFixed(1);
}

export type SignalKey = 'semantic' | 'keyword' | 'entity' | 'recency' | 'importance';
export type SignalValues = Partial<Record<SignalKey, number>>;

/** 相关度条：分数 + 进度条，供记忆表格与演练场复用。 */
export function ScoreMeter({
  score,
  tone = 'violet',
  showValue = true,
}: {
  score: number;
  tone?: Tone;
  showValue?: boolean;
}) {
  return (
    <span className={`score-bar tone-${tone}`}>
      <span className="score-track">
        <span className="score-fill" style={{ width: `${normalizePct(score)}%` }} />
      </span>
      {showValue ? <span>{formatScore(score)}</span> : null}
    </span>
  );
}

/** 五信号分解列表（semantic / keyword / entity / recency / importance）。 */
export function SignalBreakdown({
  values,
  skipMissing = false,
}: {
  values: SignalValues;
  skipMissing?: boolean;
}) {
  const signals = skipMissing
    ? SIGNAL_LABELS.filter((signal) => values[signal.key] != null)
    : SIGNAL_LABELS;
  return (
    <div className="signal-list">
      {signals.map((signal) => {
        const value = values[signal.key];
        return (
          <div key={signal.key} className={`signal-row tone-${signal.color}`}>
            <span>{signal.label}</span>
            <span className="signal-track">
              <span className="signal-fill" style={{ width: `${normalizePct(value)}%` }} />
            </span>
            <span className="mono right">{formatSignalValue(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 记忆内容 + 分类徽章 + 标签，用于列表行与概览。 */
export function MemoryContent({
  content,
  category,
  tags,
  clamp = true,
  maxWidth,
}: {
  content: string;
  category: MemoryCategory;
  tags: string[];
  clamp?: boolean;
  maxWidth?: number;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className={`mem-content${clamp ? ' clamp-2' : ''}`}
        style={maxWidth ? { maxWidth } : undefined}
      >
        {content}
      </div>
      <div className="chip-row mt-4">
        <Badge tone={toneForCategory(category)} size="sm">
          {CATEGORY_LABEL[category]}
        </Badge>
        {tags.slice(0, 3).map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        {tags.length > 3 ? <span className="tiny dim">+{tags.length - 3}</span> : null}
      </div>
    </div>
  );
}

const SCOPE_MAX = 132;

/** user / agent / run 作用域 chips。 */
export function ScopeChips({
  userId,
  agentId,
  runId,
}: {
  userId?: string;
  agentId?: string;
  runId?: string;
}) {
  if (!userId && !agentId && !runId) return <span className="tiny dim">全局作用域</span>;
  return (
    <div className="vstack gap-4" style={{ alignItems: 'flex-start' }}>
      {userId ? (
        <span className="chip" title={userId}>
          <Icon name="user" size={11} />
          <span className="truncate" style={{ maxWidth: SCOPE_MAX }}>
            {userId}
          </span>
        </span>
      ) : null}
      {agentId ? (
        <span className="chip" title={agentId}>
          <Icon name="bot" size={11} />
          <span className="truncate" style={{ maxWidth: SCOPE_MAX }}>
            {agentId}
          </span>
        </span>
      ) : null}
      {runId ? (
        <span className="chip" title={runId}>
          <Icon name="branch" size={11} />
          <span className="truncate" style={{ maxWidth: SCOPE_MAX }}>
            {runId}
          </span>
        </span>
      ) : null}
    </div>
  );
}

const EVENT_TONES: Record<string, Tone> = {
  ADD: 'green',
  UPDATE: 'amber',
  MERGE: 'violet',
  DELETE: 'red',
  NOOP: 'slate',
};

export function toneForEvent(event: string): Tone {
  return EVENT_TONES[event] ?? 'slate';
}

const EVENT_ICONS: Record<string, IconName> = {
  ADD: 'plus',
  UPDATE: 'pencil',
  MERGE: 'branch',
  DELETE: 'trash',
  NOOP: 'minus',
};

export function iconForEvent(event: string): IconName {
  return EVENT_ICONS[event] ?? 'activity';
}

/** 审计动作 → 时间线图标。 */
export function iconForAction(action: string): IconName {
  if (action.startsWith('memory.delete')) return 'trash';
  if (action.startsWith('memory.create')) return 'plus';
  if (action.startsWith('memory.update')) return 'pencil';
  if (action.startsWith('memory.search') || action.startsWith('search.')) return 'search';
  if (action.startsWith('memory.feedback')) return 'star';
  if (action.startsWith('key.')) return 'key';
  if (action.startsWith('member.')) return 'users';
  if (action.startsWith('project.')) return 'folder';
  if (action.startsWith('settings.')) return 'settings';
  if (action.startsWith('auth.')) return 'user';
  return 'activity';
}

/** 简易可选行样式（概览点击行与图谱关系行复用）。 */
export const clickableRowStyle = {
  width: '100%',
  textAlign: 'left' as const,
  padding: '8px 0',
  cursor: 'pointer',
};
