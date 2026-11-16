import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Memory, MemoryCategory } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  PageHead,
  SearchInput,
  Select,
  Table,
  type Column,
} from '@ui';
import { useAsync } from '@lib/hooks.ts';
import { api } from '@lib/api.ts';
import { fmtRelative } from '@lib/format.ts';
import { toneForCategory } from '@lib/tone.ts';

type RecordCategory = Extract<MemoryCategory, 'decision' | 'progress' | 'lesson' | 'risk' | 'change' | 'acceptance' | 'assumption' | 'dependency'>;

const CATEGORY_META: Array<{ value: RecordCategory; label: string; description: string }> = [
  { value: 'decision', label: '重要决策', description: '方向、选型、取舍与不可逆判断' },
  { value: 'progress', label: '关键进展', description: '阶段成果、里程碑与值得同步的变化' },
  { value: 'lesson', label: '经验教训', description: '踩过的坑、有效做法与下次要注意的事' },
  { value: 'risk', label: '风险与阻塞', description: '可能影响交付的风险、当前阻塞与升级项' },
  { value: 'change', label: '变更', description: '范围、排期、验收标准或方案基线变化' },
  { value: 'acceptance', label: '验收与质量', description: '测试、评审、验收结果与质量证据' },
  { value: 'assumption', label: '假设与待确认', description: '未验证前提、外部答复与未决问题' },
  { value: 'dependency', label: '依赖与承诺', description: '跨团队依赖、外部交付承诺与延期风险' },
];

const CATEGORY_LABEL = Object.fromEntries(CATEGORY_META.map((item) => [item.value, item.label])) as Record<RecordCategory, string>;
const CATEGORY_ORDER = new Map(CATEGORY_META.map((item, index) => [item.value, index]));

function metadataField(memory: Memory, key: string): string {
  const value = memory.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '—';
}

/** 项目记录：以表格承载结构化过程信息。 */
export function RecordsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [category, setCategory] = useState<'all' | RecordCategory>('all');
  const [keyword, setKeyword] = useState('');

  const recordsAsync = useAsync(
    () => api.memories.list(projectId, { pageSize: 100, includePrivate: false, status: 'active' }),
    [projectId],
    Boolean(projectId),
  );

  const allRecords = useMemo(
    () => (recordsAsync.data?.items ?? [])
      .filter((memory) => CATEGORY_ORDER.has(memory.category as RecordCategory))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [recordsAsync.data],
  );
  const rows = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return allRecords.filter((memory) => (category === 'all' || memory.category === category)
      && (!query || memory.content.toLowerCase().includes(query)));
  }, [allRecords, category, keyword]);

  const columns: Column<Memory>[] = [
    {
      key: 'category',
      header: '类型',
      width: 116,
      sortValue: (memory) => CATEGORY_LABEL[memory.category as RecordCategory] ?? memory.category,
      render: (memory) => (
        <Badge tone={toneForCategory(memory.category)} size="sm">
          {CATEGORY_LABEL[memory.category as RecordCategory] ?? memory.category}
        </Badge>
      ),
    },
    {
      key: 'content',
      header: '记录内容',
      sortValue: (memory) => memory.content,
      render: (memory) => <div className="small" style={{ lineHeight: 1.55 }}>{memory.content}</div>,
    },
    { key: 'status', header: '状态', width: 88, sortValue: (memory) => metadataField(memory, 'status'), render: (memory) => metadataField(memory, 'status') },
    { key: 'severity', header: '严重度', width: 82, sortValue: (memory) => metadataField(memory, 'severity'), render: (memory) => metadataField(memory, 'severity') },
    { key: 'task', header: '来源任务', width: 128, sortValue: (memory) => memory.taskId ?? '', render: (memory) => memory.taskId ? <span className="mono tiny">{memory.taskId.slice(0, 14)}</span> : '—' },
    { key: 'createdAt', header: '时间', width: 108, sortValue: (memory) => memory.createdAt, render: (memory) => <span className="tiny muted" title={memory.createdAt}>{fmtRelative(memory.createdAt)}</span> },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · 记录"
        title="项目记录"
        desc="以表格维护项目过程信息：重要决策、关键进展、经验教训、风险阻塞、变更、验收质量、未决假设和外部依赖。周报/月报请到「复盘总结」页生成。"
      />
      <Callout tone="violet" icon="sparkles">
        这里不记录任务流水账。只保留会影响后续判断和交付的过程事实；普通完成状态、逐文件改动和临时输出留在任务历史。
      </Callout>
      <Card>
        <div className="toolbar" style={{ padding: '12px 14px' }}>
          <div className="toolbar-left">
            <SearchInput value={keyword} onChange={setKeyword} placeholder="搜索记录内容" />
            <Select
              value={category}
              options={[{ value: 'all', label: '全部类型' }, ...CATEGORY_META.map((item) => ({ value: item.value, label: item.label }))]}
              onChange={(event) => setCategory(event.target.value as 'all' | RecordCategory)}
              aria-label="按记录类型筛选"
              style={{ width: 150 }}
            />
            <span className="tiny dim">共 {allRecords.length} 条</span>
          </div>
          <div className="toolbar-right">
            <Button size="sm" icon="refresh" loading={recordsAsync.loading} onClick={() => void recordsAsync.refresh()}>刷新</Button>
          </div>
        </div>
        {recordsAsync.error ? <div style={{ padding: 14 }}><ErrorState message={recordsAsync.error} onRetry={() => void recordsAsync.refresh()} /></div> : (
          <Table
            columns={columns}
            rows={rows}
            sortable
            resizable
            rowKey={(memory) => memory.id}
            loading={recordsAsync.loading && !recordsAsync.data}
            empty={<EmptyState icon="layers" title="暂无项目记录" description="DSH 完成任务后，会在有实质内容时写入对应过程记录。" compact />}
          />
        )}
      </Card>
    </div>
  );
}
