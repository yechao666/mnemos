import type {
  Agent,
  AgentStatus,
  BriefingSectionKey,
  Memory,
  MemoryVisibility,
  Task,
  TaskStatus,
} from '@shared';
import { Badge, Icon, type IconName, type Tone } from '@ui';
import { useCopy } from '@lib/hooks.ts';
import { fmtDateTime, truncateMiddle } from '@lib/format.ts';
import { projectTone } from '../shared.tsx';

/** Agent 原生模型在控制台内的统一展示约定：状态、可见性、任务引用与简报分区。 */

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

export const AGENT_STATUS_META: Record<AgentStatus, { label: string; tone: Tone; icon: IconName }> = {
  active: { label: '活跃', tone: 'green', icon: 'zap' },
  idle: { label: '空闲', tone: 'slate', icon: 'clock' },
  retired: { label: '已退役', tone: 'red', icon: 'xCircle' },
};

export const AGENT_STATUS_OPTIONS: { value: AgentStatus; label: string }[] = (
  Object.keys(AGENT_STATUS_META) as AgentStatus[]
).map((value) => ({ value, label: AGENT_STATUS_META[value].label }));

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: Tone; icon: IconName }> = {
  open: { label: '待开始', tone: 'amber', icon: 'clock' },
  active: { label: '进行中', tone: 'green', icon: 'play' },
  done: { label: '已完成', tone: 'blue', icon: 'checkCircle' },
  abandoned: { label: '已放弃', tone: 'slate', icon: 'xCircle' },
};

export function isTaskRunning(status: TaskStatus | undefined): boolean {
  return status === 'open' || status === 'active';
}

/** 后端尚未实现新路由时会返回 404 / 「未找到路由」，用于给出更具体的降级提示。 */
export function isNotFoundError(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.includes('404') || message.includes('未找到路由') || message.includes('不存在');
}

/** 按 Agent 名称生成稳定色调，保证卡片、抽屉、概览里同一 Agent 颜色一致。 */
export function agentTone(agent: Pick<Agent, 'id' | 'name'>): Tone {
  return projectTone(`${agent.name}:${agent.id}`);
}

/**
 * Avatar 对中文只取末两字；若名称是「开发 Agent」这类中英混排，末两字会变成「nt」。
 * 这里优先取第一段中文，让头像落回 Agent 的中文身份。
 */
export function agentAvatarName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'Agent';
  const chinese = trimmed.split(/[·\s]+/).find((part) => /[\u4e00-\u9fff]/.test(part));
  return chinese ? chinese.slice(0, 2) : trimmed;
}

export function AgentStatusDot({ status }: { status: AgentStatus }) {
  const meta = AGENT_STATUS_META[status] ?? AGENT_STATUS_META.idle;
  return (
    <span className="status-dot" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} title={`状态：${meta.label}`}>
      <span className={`dot tone-${meta.tone}`} style={{ boxShadow: 'none' }} />
      {meta.label}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const meta = TASK_STATUS_META[status] ?? TASK_STATUS_META.open;
  return (
    <Badge tone={meta.tone} size="sm" dot>
      {meta.label}
    </Badge>
  );
}

/** 任务起止时间：进行中的任务只显示开始时间。 */
export function taskTimeRange(task: Pick<Task, 'startedAt' | 'endedAt'>): string {
  if (!task.startedAt) return '时间未知';
  const start = fmtDateTime(task.startedAt);
  return task.endedAt ? `${start} → ${fmtDateTime(task.endedAt)}` : `${start} 开始`;
}

/* ------------------------------------------------------------------ */
/* 可见性                                                              */
/* ------------------------------------------------------------------ */

export const VISIBILITY_META: Record<MemoryVisibility, { label: string; tone: Tone; icon: IconName }> = {
  project: { label: '项目共享', tone: 'green', icon: 'users' },
  agent: { label: 'Agent 私有', tone: 'violet', icon: 'bot' },
  task: { label: '任务内', tone: 'amber', icon: 'branch' },
};

export const VISIBILITY_OPTIONS: { value: MemoryVisibility; label: string }[] = (
  Object.keys(VISIBILITY_META) as MemoryVisibility[]
).map((value) => ({ value, label: VISIBILITY_META[value].label }));

export function visibilityOf(memory: Pick<Memory, 'visibility'>): MemoryVisibility {
  return memory.visibility ?? 'project';
}

export function VisibilityBadge({ visibility }: { visibility: MemoryVisibility }) {
  const meta = VISIBILITY_META[visibility] ?? VISIBILITY_META.project;
  return (
    <Badge tone={meta.tone} size="sm" dot>
      {meta.label}
    </Badge>
  );
}

/** 任务 ID 引用：mono chip，点击复制完整 ID，避免在表格里撑破布局。 */
export function TaskIdChip({ taskId }: { taskId: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      className="chip chip-clickable mono"
      title={`点击复制任务 ID：${taskId}`}
      onClick={(event) => {
        event.stopPropagation();
        copy(taskId);
      }}
    >
      <Icon name="branch" size={11} />
      <span className="truncate" style={{ maxWidth: 132 }}>
        {copied ? '已复制' : truncateMiddle(taskId, 10, 6)}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 简报                                                                */
/* ------------------------------------------------------------------ */

export const BRIEFING_SECTION_FALLBACK: Record<BriefingSectionKey, string> = {
  project: '项目背景',
  conventions: '规范与约定',
  decisions: '关键决策',
  experience: '可复用经验',
  incidents: '事故与教训',
  agent_notes: 'Agent 私有笔记',
  open_tasks: '进行中任务',
};

export const BRIEFING_SECTION_ICONS: Record<BriefingSectionKey, IconName> = {
  project: 'folder',
  conventions: 'book',
  decisions: 'checkCircle',
  experience: 'star',
  incidents: 'alert',
  agent_notes: 'bot',
  open_tasks: 'branch',
};
