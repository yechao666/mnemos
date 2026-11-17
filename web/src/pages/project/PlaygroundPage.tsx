import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AddMemoryResult, ExtractionMode, MemoryScope, SearchResponse } from '@shared';
import { CATEGORY_LABEL } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  LoadingBlock,
  PageHead,
  SectionHead,
  Segmented,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@ui';
import { api, type PlaygroundAddInput } from '@lib/api.ts';
import { fmtFullDateTime, fmtInt, fmtMs, fmtRelative } from '@lib/format.ts';
import { toneForCategory } from '@lib/tone.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import {
  iconForEvent,
  ScoreMeter,
  ScopeChips,
  SignalBreakdown,
  toneForEvent,
} from '../../components/project/shared.tsx';
import { SCOPE_WRITE_OPTIONS } from '../../components/project/person/shared.tsx';

type DraftRole = 'user' | 'assistant' | 'system';
type AddMode = 'conversation' | 'text';

interface DraftMessage {
  id: number;
  role: DraftRole;
  content: string;
}

const ROLE_OPTIONS: { value: DraftRole; label: string }[] = [
  { value: 'user', label: 'user' },
  { value: 'assistant', label: 'assistant' },
  { value: 'system', label: 'system' },
];

const ADD_MODE_OPTIONS: { value: AddMode; label: string }[] = [
  { value: 'conversation', label: '对话' },
  { value: 'text', label: '纯文本' },
];

const EXTRACTION_OPTIONS: { value: ExtractionMode; label: string }[] = [
  { value: 'additive', label: 'additive · 逐条追加' },
  { value: 'consolidate', label: 'consolidate · 合并相似' },
];

/** 检索演练场：左侧写入记忆并观察抽取事件，右侧执行检索并拆解信号。 */
export function PlaygroundPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { project } = useProjectContext();

  const nextMessageId = useRef(2);
  const [addMode, setAddMode] = useState<AddMode>('conversation');
  const [messages, setMessages] = useState<DraftMessage[]>([
    { id: 1, role: 'user', content: '' },
  ]);
  const [textValue, setTextValue] = useState('');
  const [userId, setUserId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [personExternalId, setPersonExternalId] = useState('');
  const [scope, setScope] = useState<MemoryScope>(project?.settings.defaultScope ?? 'partition');
  const [sessionId, setSessionId] = useState('');
  const [runId, setRunId] = useState('');
  const [infer, setInfer] = useState(true);
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>(
    project?.settings.extractionMode ?? 'additive',
  );
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addResult, setAddResult] = useState<AddMemoryResult | null>(null);

  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(project?.settings.topK ?? 8);
  const [threshold, setThreshold] = useState(project?.settings.threshold ?? 0.12);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (!project) return;
    setExtractionMode(project.settings.extractionMode);
    setTopK(project.settings.topK);
    setThreshold(project.settings.threshold);
    setScope(project.settings.defaultScope);
    // 仅在切换项目时同步默认设置，避免覆盖用户正在调整的值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const addMessage = () => {
    setMessages((prev) => [
      ...prev,
      { id: nextMessageId.current, role: 'user', content: '' },
    ]);
    nextMessageId.current += 1;
  };

  const updateMessage = (id: number, patch: Partial<DraftMessage>) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  };

  const removeMessage = (id: number) => {
    setMessages((prev) => (prev.length <= 1 ? prev : prev.filter((message) => message.id !== id)));
  };

  const canAdd =
    addMode === 'conversation'
      ? messages.some((message) => message.content.trim().length > 0)
      : textValue.trim().length > 0;

  const submitAdd = async () => {
    if (!projectId || addBusy) return;
    if (scope === 'person' && !personExternalId.trim()) {
      toast.warning('「仅本人」需要填写归属人的 external ID');
      return;
    }
    if (scope === 'session' && !sessionId.trim()) {
      toast.warning('「仅会话」需要填写会话 ID');
      return;
    }
    const payload: PlaygroundAddInput = { infer, mode: extractionMode, scope };
    if (addMode === 'conversation') {
      const trimmed = messages
        .map((message) => ({ role: message.role, content: message.content.trim() }))
        .filter((message) => message.content.length > 0);
      if (!trimmed.length) {
        toast.warning('请至少填写一条消息内容');
        return;
      }
      payload.messages = trimmed;
    } else {
      if (!textValue.trim()) {
        toast.warning('请填写要写入的文本');
        return;
      }
      payload.text = textValue.trim();
    }
    if (personExternalId.trim()) payload.personExternalId = personExternalId.trim();
    if (scope === 'session' && sessionId.trim()) payload.sessionId = sessionId.trim();
    if (userId.trim()) payload.userId = userId.trim();
    if (agentId.trim()) payload.agentId = agentId.trim();
    if (runId.trim()) payload.runId = runId.trim();

    setAddBusy(true);
    setAddError(null);
    try {
      const result = await api.playground.add(projectId, payload);
      setAddResult(result);
      toast.success(`写入完成：抽取 ${result.extracted} 条，合并 ${result.merged} 条`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '写入失败';
      setAddError(message);
      toast.error(message);
    } finally {
      setAddBusy(false);
    }
  };

  const submitSearch = async () => {
    if (!projectId || searchBusy) return;
    const text = query.trim();
    if (!text) {
      toast.warning('请输入检索语句');
      return;
    }
    setSearchBusy(true);
    setSearchError(null);
    try {
      const result = await api.playground.search(projectId, { query: text, topK, threshold });
      setSearchResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : '检索失败';
      setSearchError(message);
      toast.error(message);
    } finally {
      setSearchBusy(false);
    }
  };

  const fillQuery = () => {
    const first = addResult?.results[0];
    if (!first) return;
    setQuery(first.content);
    toast.info('已将写入结果中的第一条记忆填入检索框');
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="演练场"
        title="检索演练场"
        desc="在同一页面写入记忆并观察检索管线，用于验证抽取、去重与多信号融合效果。"
        actions={
          <Button
            variant="ghost"
            icon="list"
            onClick={() => navigate(`/projects/${projectId}/memories`)}
          >
            记忆浏览器
          </Button>
        }
      />

      <div className="grid grid-2">
        <Card pad>
          <SectionHead title="写入记忆" desc="模拟一次从消息到记忆的完整写入" />
          <div className="mt-12">
            <Callout tone="violet" icon="info">
              写入管线：消息 → 抽取 → 去重 → 嵌入 → 入库。归属人决定记忆主体，scope
              决定谁能看到（仅本人 / 分区共享 / 仅会话）；开启 infer 时由模型抽取独立事实。
            </Callout>
          </div>

          <div className="vstack gap-12 mt-16">
            <Segmented options={ADD_MODE_OPTIONS} value={addMode} onChange={setAddMode} />

            {addMode === 'conversation' ? (
              <div className="vstack gap-10">
                {messages.map((message, index) => (
                  <div
                    key={message.id}
                    className="vstack gap-6"
                    style={{
                      padding: 10,
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-faint)',
                      background: 'rgba(0, 0, 0, 0.18)',
                    }}
                  >
                    <div className="between gap-8">
                      <Select
                        options={ROLE_OPTIONS}
                        value={message.role}
                        aria-label={`第 ${index + 1} 条消息角色`}
                        style={{ width: 122 }}
                        onChange={(event) =>
                          updateMessage(message.id, { role: event.target.value as DraftRole })
                        }
                      />
                      <span className="tiny dim">消息 {index + 1}</span>
                      <IconButton
                        icon="trash"
                        label={`删除第 ${index + 1} 条消息`}
                        size="sm"
                        disabled={messages.length === 1 || addBusy}
                        onClick={() => removeMessage(message.id)}
                      />
                    </div>
                    <Textarea
                      rows={3}
                      value={message.content}
                      placeholder={
                        message.role === 'assistant'
                          ? '助手回复内容…'
                          : message.role === 'system'
                            ? '系统指令内容…'
                            : '用户消息内容…'
                      }
                      onChange={(event) => updateMessage(message.id, { content: event.target.value })}
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  icon="plus"
                  block
                  disabled={addBusy}
                  onClick={addMessage}
                >
                  添加消息
                </Button>
              </div>
            ) : (
              <Field label="纯文本" hint="适合直接粘贴一段文本或文档片段。">
                <Textarea
                  rows={7}
                  value={textValue}
                  placeholder="输入要写入的记忆文本…"
                  onChange={(event) => setTextValue(event.target.value)}
                />
              </Field>
            )}

            <div className="grid grid-3">
              <Field label="用户 ID">
                <Input
                  value={userId}
                  placeholder="u_1001"
                  onChange={(event) => setUserId(event.target.value)}
                />
              </Field>
              <Field label="Agent ID">
                <Input
                  value={agentId}
                  placeholder="agent_01"
                  onChange={(event) => setAgentId(event.target.value)}
                />
              </Field>
              <Field label="Run ID">
                <Input
                  value={runId}
                  placeholder="run_2026"
                  onChange={(event) => setRunId(event.target.value)}
                />
              </Field>
            </div>

            <div className="grid grid-3">
              <Field label="归属人 external ID" hint="留空 = 分区共享知识；仅本人范围必填">
                <Input
                  value={personExternalId}
                  placeholder="user-123 / agent-a"
                  onChange={(event) => setPersonExternalId(event.target.value)}
                />
              </Field>
              <Field label="可见范围">
                <Select
                  options={SCOPE_WRITE_OPTIONS}
                  value={scope}
                  aria-label="可见范围"
                  onChange={(event) => setScope(event.target.value as MemoryScope)}
                />
              </Field>
              <Field label="会话 ID" hint="scope=仅会话时必填">
                <Input
                  value={sessionId}
                  placeholder="session_2026_..."
                  onChange={(event) => setSessionId(event.target.value)}
                />
              </Field>
            </div>

            <div className="between gap-12 wrap">
              <Switch checked={infer} onChange={setInfer} label="开启抽取（infer）" />
              <div className="hstack gap-8">
                <span className="tiny dim nowrap">抽取模式</span>
                <Select
                  options={EXTRACTION_OPTIONS}
                  value={extractionMode}
                  aria-label="抽取模式"
                  style={{ width: 184 }}
                  onChange={(event) => setExtractionMode(event.target.value as ExtractionMode)}
                />
              </div>
            </div>

            <Button
              variant="primary"
              icon="send"
              loading={addBusy}
              disabled={addBusy || !canAdd}
              onClick={() => void submitAdd()}
            >
              写入记忆
            </Button>

            {addError ? (
              <Callout tone="red" icon="alert">
                {addError}
              </Callout>
            ) : null}

            {addBusy ? <LoadingBlock label="正在抽取、去重并写入…" /> : null}

            {addResult ? (
              <div className="vstack gap-12">
                <div className="divider" />
                <div className="between gap-12">
                  <div className="section-title">写入结果</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="search"
                    disabled={!addResult.results.length}
                    onClick={fillQuery}
                  >
                    填入检索框
                  </Button>
                </div>
                <div className="chip-row">
                  <span className="chip">耗时 {fmtMs(addResult.tookMs)}</span>
                  <span className="chip">抽取 {fmtInt(addResult.extracted)}</span>
                  <span className="chip">合并 {fmtInt(addResult.merged)}</span>
                  <span className="chip">跳过 {fmtInt(addResult.skipped)}</span>
                </div>
                {addResult.events.length ? (
                  <div className="vstack gap-8">
                    {addResult.events.map((event, index) => (
                      <div
                        key={`${event.type}-${index}`}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border-faint)',
                          background: 'rgba(0, 0, 0, 0.18)',
                        }}
                      >
                        <div className="between gap-8">
                          <Badge tone={toneForEvent(event.type)} size="sm">
                            <span className="hstack gap-4">
                              <Icon name={iconForEvent(event.type)} size={10} />
                              {event.type}
                            </span>
                          </Badge>
                          <span className="tiny dim" title={fmtFullDateTime(event.at)}>
                            {fmtRelative(event.at)}
                          </span>
                        </div>
                        <div className="mem-content clamp-2 mt-4">{event.content}</div>
                        {event.reason ? <div className="tiny dim mt-4">{event.reason}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="tiny dim">本次未产生抽取事件。</div>
                )}
              </div>
            ) : null}
          </div>
        </Card>

        <Card pad>
          <SectionHead title="检索记忆" desc="观察多信号融合与排序过程" />
          <div className="mt-12">
            <Callout tone="cyan" icon="info">
              检索管线：语义向量 + 关键词 BM25 + 实体命中 + 时效性 + 重要度 多信号融合，
              按项目权重归一化排序。
            </Callout>
          </div>

          <div className="vstack gap-12 mt-16">
            <Field label="查询" hint="支持自然语言，例如「用户对座位有什么偏好」。">
              <Textarea
                rows={3}
                value={query}
                placeholder="输入检索语句…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>

            <div className="grid grid-2">
              <Field label="Top K">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={topK}
                  aria-label="返回条数 topK"
                  onChange={(event) =>
                    setTopK(Math.max(1, Math.min(50, Number(event.target.value) || 1)))
                  }
                />
              </Field>
              <Field label="阈值 threshold">
                <div className="hstack gap-10">
                  <input
                    type="range"
                    className="slider"
                    min={0}
                    max={1}
                    step={0.01}
                    value={threshold}
                    aria-label="相关度阈值"
                    onChange={(event) => setThreshold(Number(event.target.value))}
                  />
                  <span className="mono small nowrap" style={{ minWidth: 38 }}>
                    {threshold.toFixed(2)}
                  </span>
                </div>
              </Field>
            </div>

            <Button
              variant="primary"
              icon="search"
              loading={searchBusy}
              disabled={searchBusy || !query.trim()}
              onClick={() => void submitSearch()}
            >
              执行检索
            </Button>

            {searchError ? (
              <Callout tone="red" icon="alert">
                {searchError}
              </Callout>
            ) : null}

            {searchBusy && !searchResult ? (
              <LoadingBlock label="正在融合多信号并排序…" />
            ) : null}

            {searchResult ? (
              <div className="vstack gap-12">
                <div className="divider" />
                <div className="between gap-12 wrap">
                  <div className="hstack gap-8 wrap">
                    <Badge tone="violet" size="sm" dot>
                      检索完成
                    </Badge>
                    <span className="tiny dim">耗时 {fmtMs(searchResult.tookMs)}</span>
                    <span className="mono tiny">命中 {fmtInt(searchResult.total)} 条</span>
                    <span
                      className="chip mono truncate"
                      style={{ maxWidth: 220 }}
                      title={searchResult.strategy}
                    >
                      {searchResult.strategy}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={showRaw ? 'chevronUp' : 'chevronDown'}
                    onClick={() => setShowRaw((prev) => !prev)}
                  >
                    原始响应
                  </Button>
                </div>

                {searchResult.queryTerms.length ? (
                  <div className="chip-row">
                    <span className="tiny dim">查询词</span>
                    {searchResult.queryTerms.map((term) => (
                      <span key={term} className="tag">
                        {term}
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="vstack gap-8">
                  <div className="tiny dim">信号权重</div>
                  <SignalBreakdown values={searchResult.weights} skipMissing />
                </div>

                {showRaw ? (
                  <CodeBlock
                    title="search-response.json"
                    language="json"
                    code={JSON.stringify(searchResult, null, 2)}
                  />
                ) : null}

                {searchResult.results.length ? (
                  <div className="vstack">
                    {searchResult.results.map((hit, index) => (
                      <div
                        key={hit.id}
                        style={{
                          padding: '12px 0',
                          borderTop: index === 0 ? undefined : '1px solid var(--border-faint)',
                        }}
                      >
                        <div className="between gap-12" style={{ alignItems: 'flex-start' }}>
                          <div className="hstack gap-6 wrap">
                            <Badge tone={toneForCategory(hit.category)} size="sm">
                              {CATEGORY_LABEL[hit.category]}
                            </Badge>
                            <span className="tiny dim">重要度 {hit.importance.toFixed(2)}</span>
                            <span className="tiny dim" title={fmtFullDateTime(hit.updatedAt)}>
                              {fmtRelative(hit.updatedAt)}
                            </span>
                          </div>
                          <ScoreMeter score={hit.score} />
                        </div>
                        <div className="mem-content mt-8">{hit.content}</div>
                        <div className="mt-8">
                          <SignalBreakdown values={hit.signals} />
                        </div>
                        <div className="chip-row mt-8">
                          {hit.matchedOn.length ? (
                            hit.matchedOn.map((reason) => (
                              <span key={reason} className="tag">
                                {reason}
                              </span>
                            ))
                          ) : (
                            <span className="tiny dim">无匹配原因</span>
                          )}
                        </div>
                        <div className="mt-6">
                          <ScopeChips userId={hit.userId} agentId={hit.agentId} runId={hit.runId} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    compact
                    icon="search"
                    title="没有命中记忆"
                    description="尝试降低阈值、扩大 Top K，或换一个更宽泛的查询。"
                  />
                )}
              </div>
            ) : !searchBusy ? (
              <EmptyState
                compact
                icon="search"
                title="等待检索"
                description="提交查询后，这里会展示命中分数、信号分解与匹配原因。"
              />
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
