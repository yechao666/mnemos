/**
 * 项目周报 / 月报：把结构化项目记录（决策、进展、经验教训、复盘洞见）
 * 按自然周/自然月聚合为可直接阅读的 Markdown，不依赖 LLM。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  MemoryCategory,
  MemoryReport,
  MemoryReportItem,
  MemoryReportPeriod,
  MemoryReportSection,
} from '../../../shared/src/types.ts';

interface ReportRow {
  id: string;
  content: string;
  category: string;
  created_at: string;
  agent_id: string | null;
  task_id: string | null;
  metadata: string;
}

const SECTION_META: Array<{
  key: MemoryReportSection['key'];
  title: string;
  categories: MemoryCategory[];
}> = [
  { key: 'progress', title: '关键进展', categories: ['progress'] },
  { key: 'decisions', title: '重要决策', categories: ['decision'] },
  { key: 'lessons', title: '经验教训', categories: ['lesson'] },
  { key: 'risks', title: '风险与阻塞', categories: ['risk'] },
  { key: 'changes', title: '变更', categories: ['change'] },
  { key: 'acceptance', title: '验收与质量', categories: ['acceptance'] },
  { key: 'assumptions', title: '假设与待确认', categories: ['assumption'] },
  { key: 'dependencies', title: '依赖与承诺', categories: ['dependency'] },
  { key: 'insights', title: '复盘总结', categories: ['insight'] },
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** 以 UTC 计算自然周（周一 00:00）或自然月。anchor 为 YYYY-MM-DD。 */
export function reportRange(period: MemoryReportPeriod, anchor?: string, now = new Date()): { start: number; end: number } {
  const base = anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor)
    ? new Date(`${anchor}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') {
    const day = (base.getUTCDay() + 6) % 7;
    const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - day);
    return { start, end: start + 7 * 24 * 60 * 60 * 1000 };
  }
  const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1);
  const end = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1);
  return { start, end };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function buildMemoryReport(
  db: DatabaseSync,
  projectId: string,
  period: MemoryReportPeriod,
  anchor?: string,
): MemoryReport {
  const range = reportRange(period, anchor);
  const start = new Date(range.start).toISOString();
  const end = new Date(range.end).toISOString();
  const categoryList = SECTION_META.flatMap((section) => section.categories);
  const placeholders = categoryList.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, content, category, created_at, agent_id, task_id, metadata
         FROM memories
        WHERE project_id = ? AND status = 'active' AND visibility = 'project'
          AND category IN (${placeholders})
          AND created_at >= ? AND created_at < ?
        ORDER BY created_at DESC
        LIMIT 300`,
    )
    .all(projectId, ...categoryList, start, end) as unknown as ReportRow[];

  const items = rows.map((row) => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* ignore */ }
    const item: MemoryReportItem = {
      id: row.id,
      content: row.content,
      category: row.category as MemoryCategory,
      createdAt: row.created_at,
    };
    if (row.agent_id) item.agentId = row.agent_id;
    if (row.task_id) item.taskId = row.task_id;
    if (typeof metadata.status === 'string') item.status = metadata.status;
    if (typeof metadata.severity === 'string') item.severity = metadata.severity;
    return item;
  });

  const sections = SECTION_META.map((section) => {
    const sectionItems = items.filter((item) => section.categories.includes(item.category));
    return { key: section.key, title: section.title, count: sectionItems.length, items: sectionItems };
  });
  const counts = Object.fromEntries(
    sections.map((section) => [section.key, section.count]),
  ) as MemoryReport['counts'];

  const title = period === 'week' ? '项目周报' : '项目月报';
  const lines = [
    `# ${title}`,
    '',
    `- 周期：${isoDay(range.start)} ~ ${isoDay(range.end - 24 * 60 * 60 * 1000)}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
  ];
  for (const section of sections) {
    lines.push(`## ${section.title}（${section.count}）`, '');
    if (section.items.length === 0) {
      lines.push('_本周期暂无记录_', '');
      continue;
    }
    for (const item of section.items.slice(0, 30)) {
      const date = item.createdAt.slice(0, 10);
      lines.push(`- ${oneLine(item.content)}（${date}）`);
    }
    lines.push('');
  }
  return {
    projectId,
    period,
    title: `${title} · ${isoDay(range.start)}`,
    start,
    end,
    sections,
    counts,
    markdown: lines.join('\n').trimEnd(),
  };
}
