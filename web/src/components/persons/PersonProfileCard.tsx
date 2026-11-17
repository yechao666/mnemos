import { useState } from 'react';
import type { PersonFact } from '@lib/types.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Input,
  Skeleton,
  useToast,
} from '@ui';
import { api, isNotFoundError } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtFullDateTime, fmtInt, fmtRelative, truncateMiddle } from '@lib/format.ts';

interface FactDraft {
  key: string;
  value: string;
  confidence: string;
}

const EMPTY_DRAFT: FactDraft = { key: '', value: '', confidence: '0.7' };

function parseConfidence(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** 置信度：数字 + 细进度条，颜色按高低区分。 */
function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone = pct >= 80 ? 'green' : pct >= 55 ? 'amber' : 'slate';
  return (
    <span className="fact-confidence" title={`置信度 ${pct}%`}>
      <span className={`signal-track fact-confidence-track tone-${tone}`}>
        <span className="signal-fill" style={{ width: `${pct}%`, background: `var(--${tone})` }} />
      </span>
      <span className="tiny dim mono">{pct}%</span>
    </span>
  );
}

/**
 * v6.1 P1 人画像卡：当前 facts（key/value/confidence/validFrom + 来源记忆）+ 画像摘要。
 * facts 支持内联新增/编辑/删除；摘要支持生成/刷新/复制并展示 generatedAt。
 * 接口未就绪（404）时卡片内显示错误态，不影响人详情其他部分。
 */
export function PersonProfileCard({
  partitionId,
  personRef,
  canManage,
  onOpenMemory,
  onChanged,
}: {
  partitionId: string;
  personRef: string;
  canManage: boolean;
  onOpenMemory?: (memoryId: string) => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const query = useAsync(
    () => api.persons.profile(partitionId, personRef),
    [partitionId, personRef],
    Boolean(partitionId && personRef),
  );
  const profile = query.data;
  const facts = profile?.facts ?? [];

  const [draft, setDraft] = useState<FactDraft>(EMPTY_DRAFT);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<FactDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refreshAll = async () => {
    await query.refresh();
    onChanged?.();
  };

  const submitNew = async () => {
    const key = draft.key.trim();
    const value = draft.value.trim();
    if (!key || !value) {
      toast.warning('事实槽位的 key 与 value 都不能为空');
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      await api.persons.facts.upsert(partitionId, personRef, {
        key,
        value,
        confidence: parseConfidence(draft.confidence),
      });
      setDraft(EMPTY_DRAFT);
      toast.success(`已写入事实槽位 ${key}`);
      await refreshAll();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '写入事实失败');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (fact: PersonFact) => {
    setEditId(fact.id);
    setEditDraft({ key: fact.key, value: fact.value, confidence: String(fact.confidence) });
  };

  const submitEdit = async (fact: PersonFact) => {
    const key = editDraft.key.trim();
    const value = editDraft.value.trim();
    if (!key || !value) {
      toast.warning('事实槽位的 key 与 value 都不能为空');
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      await api.persons.facts.upsert(partitionId, personRef, {
        key,
        value,
        confidence: parseConfidence(editDraft.confidence),
        sourceMemoryId: fact.sourceMemoryId,
      });
      setEditId(null);
      toast.success(`已更新事实槽位 ${key}`);
      await refreshAll();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '更新事实失败');
    } finally {
      setSaving(false);
    }
  };

  const removeFact = async (fact: PersonFact) => {
    if (removingId) return;
    setRemovingId(fact.id);
    try {
      await api.persons.facts.remove(partitionId, personRef, fact.id);
      toast.success(`已删除事实槽位 ${fact.key}`);
      if (editId === fact.id) setEditId(null);
      await refreshAll();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除事实失败');
    } finally {
      setRemovingId(null);
    }
  };

  const regenerateSummary = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const next = await api.persons.profile(partitionId, personRef, { force: true });
      query.setData(next);
      if (next.summary.trim()) toast.success('画像摘要已生成');
      else toast.info('画像摘要为空：先写入记忆或事实槽位后再试');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '生成画像摘要失败');
    } finally {
      setGenerating(false);
    }
  };

  const factEditor = (fact: PersonFact) => (
    <div className="fact-editor">
      <Input
        value={editDraft.key}
        aria-label="事实 key"
        placeholder="key（如 preference.language）"
        onChange={(event) => setEditDraft((prev) => ({ ...prev, key: event.target.value }))}
      />
      <Input
        value={editDraft.value}
        aria-label="事实 value"
        placeholder="value"
        onChange={(event) => setEditDraft((prev) => ({ ...prev, value: event.target.value }))}
      />
      <Input
        type="number"
        min={0}
        max={1}
        step={0.05}
        value={editDraft.confidence}
        aria-label="事实置信度"
        placeholder="0–1"
        style={{ width: 104 }}
        onChange={(event) => setEditDraft((prev) => ({ ...prev, confidence: event.target.value }))}
      />
      <div className="hstack gap-6">
        <Button size="sm" variant="primary" icon="check" loading={saving} onClick={() => void submitEdit(fact)}>
          保存
        </Button>
        <Button size="sm" variant="ghost" icon="x" onClick={() => setEditId(null)}>
          取消
        </Button>
      </div>
    </div>
  );

  return (
    <Card pad>
      <div className="between wrap gap-10">
        <div>
          <div className="section-title">画像</div>
          <div className="tiny dim mt-4">
            结构化事实槽位（person_facts）+ 画像摘要。同 key 的新事实会关闭旧值；记忆 metadata.factKey 也会自动沉淀到这里。
          </div>
        </div>
        <div className="hstack gap-8 wrap">
          <Badge tone="violet" size="sm" dot>
            事实 {fmtInt(facts.length)}
          </Badge>
          {profile?.generatedAt ? (
            <span className="tiny dim" title={fmtFullDateTime(profile.generatedAt)}>
              摘要生成于 {fmtRelative(profile.generatedAt)}
            </span>
          ) : null}
          {profile?.summary ? <CopyButton value={profile.summary} label="复制摘要" /> : null}
          <Button
            size="sm"
            variant="secondary"
            icon={profile?.summary ? 'refresh' : 'sparkles'}
            loading={generating}
            onClick={() => void regenerateSummary()}
          >
            {profile?.summary ? '刷新摘要' : '生成摘要'}
          </Button>
          <IconButton
            icon="refresh"
            label="刷新画像"
            size="sm"
            disabled={query.loading}
            onClick={() => void query.refresh()}
          />
        </div>
      </div>

      {query.error && !profile ? (
        <div className="vstack gap-10 mt-12">
          <ErrorState message={query.error} onRetry={() => void query.refresh()} />
          {isNotFoundError(query.error) ? (
            <Callout tone="amber" icon="info">
              画像接口尚未就绪（404）或该人不存在。后端上线后点击「重试」加载，人详情其他部分不受影响。
            </Callout>
          ) : null}
        </div>
      ) : query.loading && !profile ? (
        <div className="vstack gap-8 mt-12">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} h={48} style={{ borderRadius: 10 }} />
          ))}
        </div>
      ) : (
        <>
          <div className="profile-summary mt-12">
            {profile?.summary?.trim() ? (
              profile.summary
            ) : (
              <span className="tiny dim">
                暂无画像摘要：由异步 profile 任务或「生成摘要」按 facts + 最近记忆压缩生成。
              </span>
            )}
          </div>

          <div className="divider mt-16" />

          <div className="between wrap gap-8 mt-12">
            <div className="hstack gap-8">
              <span className="section-title" style={{ fontSize: 13 }}>事实槽位</span>
              <span className="tiny dim">当前有效 {fmtInt(facts.length)} 条</span>
            </div>
            {query.loading ? <span className="tiny dim">刷新中…</span> : null}
          </div>

          {facts.length === 0 ? (
            <div className="mt-10">
              <EmptyState
                compact
                icon="tag"
                title="还没有事实槽位"
                description="写入带 factKey 的记忆，或在下方手动新增一条（如 preference.language = zh-CN）。"
              />
            </div>
          ) : (
            <div className="fact-list mt-10">
              {facts.map((fact) =>
                editId === fact.id ? (
                  <div key={fact.id} className="fact-row is-editing">
                    {factEditor(fact)}
                  </div>
                ) : (
                  <div key={fact.id} className="fact-row">
                    <span className="fact-key mono" title={fact.key}>
                      <Icon name="tag" size={11} />
                      {fact.key}
                    </span>
                    <span className="fact-value" title={fact.value}>{fact.value}</span>
                    <ConfidenceBar value={fact.confidence} />
                    <span className="tiny dim nowrap" title={fmtFullDateTime(fact.validFrom)}>
                      自 {fmtRelative(fact.validFrom)}
                    </span>
                    {fact.validTo ? (
                      <Badge tone="slate" size="sm" dot>已失效</Badge>
                    ) : null}
                    {fact.sourceMemoryId ? (
                      <span className="fact-source">
                        <span className="tiny dim">来源</span>
                        <button
                          type="button"
                          className="link-button mono tiny"
                          title={fact.sourceMemoryId}
                          onClick={() => onOpenMemory?.(fact.sourceMemoryId!)}
                          disabled={!onOpenMemory}
                        >
                          {truncateMiddle(fact.sourceMemoryId, 8, 5)}
                        </button>
                      </span>
                    ) : null}
                    {canManage ? (
                      <span className="fact-actions">
                        <IconButton
                          icon="pencil"
                          label={`编辑事实 ${fact.key}`}
                          size="sm"
                          onClick={() => startEdit(fact)}
                        />
                        <IconButton
                          icon="trash"
                          label={`删除事实 ${fact.key}`}
                          size="sm"
                          disabled={removingId === fact.id}
                          onClick={() => void removeFact(fact)}
                        />
                      </span>
                    ) : null}
                  </div>
                ),
              )}
            </div>
          )}

          {canManage ? (
            <div className="fact-add mt-12">
              <div className="tiny dim" style={{ marginBottom: 6 }}>新增 / 覆盖事实槽位</div>
              <div className="fact-editor">
                <Input
                  value={draft.key}
                  aria-label="新事实 key"
                  placeholder="key（如 preference.language）"
                  onChange={(event) => setDraft((prev) => ({ ...prev, key: event.target.value }))}
                />
                <Input
                  value={draft.value}
                  aria-label="新事实 value"
                  placeholder="value"
                  onChange={(event) => setDraft((prev) => ({ ...prev, value: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitNew();
                  }}
                />
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.confidence}
                  aria-label="新事实置信度"
                  placeholder="0–1"
                  style={{ width: 104 }}
                  onChange={(event) => setDraft((prev) => ({ ...prev, confidence: event.target.value }))}
                />
                <Button size="sm" variant="primary" icon="plus" loading={saving} onClick={() => void submitNew()}>
                  新增事实
                </Button>
              </div>
            </div>
          ) : (
            <div className="tiny dim mt-10">只读：维护事实槽位需要 admin 及以上角色。</div>
          )}
        </>
      )}
    </Card>
  );
}
