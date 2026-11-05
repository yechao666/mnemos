import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ExtractionMode, ProjectSettings, ProjectStatus, RetrievalWeights } from '@shared';
import { ENVIRONMENTS, PROJECT_STATUSES, REGIONS } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { fmtCompact, fmtPct } from '@lib/format.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  Field,
  Input,
  PageHead,
  SectionHead,
  Segmented,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@ui';
import { PendingProject, SettingsSection } from '../../components/project-ops/common.tsx';

interface MemoryForm {
  extractionMode: ExtractionMode;
  dedupeThreshold: number;
  graphEnabled: boolean;
  retentionDays: number;
}

interface RetrievalForm {
  topK: number;
  threshold: number;
  weights: RetrievalWeights;
}

interface IntegrationForm {
  monthlyQuota: number;
  webhookUrl: string;
  locale: string;
}

interface InfoForm {
  name: string;
  description: string;
  status: ProjectStatus;
  region: string;
  env: string;
}

const DEFAULT_MEMORY: MemoryForm = {
  extractionMode: 'additive',
  dedupeThreshold: 0.92,
  graphEnabled: true,
  retentionDays: 365,
};

const DEFAULT_RETRIEVAL: RetrievalForm = {
  topK: 8,
  threshold: 0.12,
  weights: { semantic: 0.45, keyword: 0.3, entity: 0.15, recency: 0.1 },
};

const DEFAULT_INTEGRATION: IntegrationForm = {
  monthlyQuota: 5_000_000,
  webhookUrl: '',
  locale: 'zh-CN',
};

const DEFAULT_INFO: InfoForm = {
  name: '',
  description: '',
  status: 'active',
  region: 'cn-shanghai',
  env: 'production',
};

const WEIGHT_FIELDS: { key: keyof RetrievalWeights; label: string }[] = [
  { key: 'semantic', label: '语义向量' },
  { key: 'keyword', label: '关键词 BM25' },
  { key: 'entity', label: '实体命中' },
  { key: 'recency', label: '时效性' },
];

const EXTRACTION_COPY: Record<ExtractionMode, string> = {
  additive: '每次写入都追加新记忆，保留完整上下文，适合对话流水与事件记录。',
  consolidate: '写入时合并相似记忆、更新已有条目，减少冗余，适合长期偏好与事实。',
};

function memoryFromSettings(settings: ProjectSettings): MemoryForm {
  return {
    extractionMode: settings.extractionMode,
    dedupeThreshold: settings.dedupeThreshold,
    graphEnabled: settings.graphEnabled,
    retentionDays: settings.retentionDays,
  };
}

function retrievalFromSettings(settings: ProjectSettings): RetrievalForm {
  return {
    topK: settings.topK,
    threshold: settings.threshold,
    weights: { ...settings.weights },
  };
}

function integrationFromSettings(settings: ProjectSettings): IntegrationForm {
  return {
    monthlyQuota: settings.monthlyQuota,
    webhookUrl: settings.webhookUrl ?? '',
    locale: settings.locale,
  };
}

function infoFromProject(project: { name: string; description: string; status: ProjectStatus; region: string; env: string }): InfoForm {
  return {
    name: project.name,
    description: project.description,
    status: project.status,
    region: project.region,
    env: project.env,
  };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sliderPct(value: number, min: number, max: number): string {
  if (!Number.isFinite(value)) return '0%';
  const pct = ((value - min) / (max - min)) * 100;
  return `${Math.max(0, Math.min(100, pct))}%`;
}

function messageOf(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : '保存失败，请稍后重试。';
}

export function SettingsPage() {
  const { project, loading: projectLoading, error: projectError, refresh } = useProjectContext();
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const projectId = project?.id ?? routeProjectId ?? '';
  const navigate = useNavigate();
  const toast = useToast();

  const [memory, setMemory] = useState<MemoryForm>(DEFAULT_MEMORY);
  const [memoryBase, setMemoryBase] = useState<MemoryForm>(DEFAULT_MEMORY);
  const [retrieval, setRetrieval] = useState<RetrievalForm>(DEFAULT_RETRIEVAL);
  const [retrievalBase, setRetrievalBase] = useState<RetrievalForm>(DEFAULT_RETRIEVAL);
  const [integration, setIntegration] = useState<IntegrationForm>(DEFAULT_INTEGRATION);
  const [integrationBase, setIntegrationBase] = useState<IntegrationForm>(DEFAULT_INTEGRATION);
  const [info, setInfo] = useState<InfoForm>(DEFAULT_INFO);
  const [infoBase, setInfoBase] = useState<InfoForm>(DEFAULT_INFO);

  const [savingMemory, setSavingMemory] = useState(false);
  const [savingRetrieval, setSavingRetrieval] = useState(false);
  const [savingIntegration, setSavingIntegration] = useState(false);
  const [savingInfo, setSavingInfo] = useState(false);

  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    const settings = project.settings;
    const nextMemory = memoryFromSettings(settings);
    const nextRetrieval = retrievalFromSettings(settings);
    const nextIntegration = integrationFromSettings(settings);
    const nextInfo = infoFromProject(project);
    setMemory(nextMemory);
    setMemoryBase(nextMemory);
    setRetrieval(nextRetrieval);
    setRetrievalBase(nextRetrieval);
    setIntegration(nextIntegration);
    setIntegrationBase(nextIntegration);
    setInfo(nextInfo);
    setInfoBase(nextInfo);
    // 仅在切换项目时重置表单，避免保存后的 context 刷新覆盖未保存编辑。
  }, [project?.id]);

  if (!project || !projectId) {
    return (
      <div className="page">
        <PageHead eyebrow="项目 · 配置" title="项目设置" desc="配置记忆处理、检索默认值、配额与项目元信息。" />
        <PendingProject
          loading={projectLoading}
          error={projectError}
          onRetry={() => {
            void refresh();
          }}
        />
      </div>
    );
  }

  const memoryDirty = JSON.stringify(memory) !== JSON.stringify(memoryBase);
  const retrievalDirty = JSON.stringify(retrieval) !== JSON.stringify(retrievalBase);
  const integrationDirty = JSON.stringify(integration) !== JSON.stringify(integrationBase);
  const infoDirty = JSON.stringify(info) !== JSON.stringify(infoBase);

  const dedupeError =
    !Number.isFinite(memory.dedupeThreshold) || memory.dedupeThreshold < 0.5 || memory.dedupeThreshold > 1
      ? '去重阈值需在 0.5–1 之间'
      : null;
  const retentionError =
    !Number.isInteger(memory.retentionDays) || memory.retentionDays < 30 || memory.retentionDays > 1095
      ? '保留天数需为 30–1095 的整数'
      : null;
  const memoryValid = !dedupeError && !retentionError;

  const weightSum =
    retrieval.weights.semantic + retrieval.weights.keyword + retrieval.weights.entity + retrieval.weights.recency;
  const weightsNormalized = Number.isFinite(weightSum) && Math.abs(weightSum - 1) < 0.005;
  const topKError =
    !Number.isInteger(retrieval.topK) || retrieval.topK < 1 || retrieval.topK > 20 ? '默认 topK 需为 1–20 的整数' : null;
  const thresholdError =
    !Number.isFinite(retrieval.threshold) || retrieval.threshold < 0 || retrieval.threshold > 1
      ? '召回阈值需在 0–1 之间'
      : null;
  const retrievalValid = !topKError && !thresholdError;

  const quotaError =
    !Number.isFinite(integration.monthlyQuota) || integration.monthlyQuota < 0
      ? '每月配额需为不小于 0 的数值'
      : null;
  const webhookError =
    integration.webhookUrl.trim().length > 0 && !isValidHttpUrl(integration.webhookUrl.trim())
      ? '请输入有效的 http(s) Webhook 地址'
      : null;
  const integrationValid = !quotaError && !webhookError;

  const infoNameError =
    info.name.trim().length === 0
      ? '项目名称不能为空'
      : info.name.trim().length > 60
        ? '项目名称不能超过 60 个字符'
        : null;
  const infoValid = !infoNameError;

  const saveMemory = async () => {
    if (!memoryValid || savingMemory) return;
    setSavingMemory(true);
    setMemoryError(null);
    try {
      await api.projects.settings.update(projectId, {
        extractionMode: memory.extractionMode,
        dedupeThreshold: memory.dedupeThreshold,
        graphEnabled: memory.graphEnabled,
        retentionDays: memory.retentionDays,
      });
      setMemoryBase(memory);
      toast.success('记忆处理设置已保存');
      void refresh();
    } catch (cause) {
      setMemoryError(messageOf(cause));
    } finally {
      setSavingMemory(false);
    }
  };

  const saveRetrieval = async () => {
    if (!retrievalValid || savingRetrieval) return;
    setSavingRetrieval(true);
    setRetrievalError(null);
    try {
      await api.projects.settings.update(projectId, {
        topK: retrieval.topK,
        threshold: retrieval.threshold,
        weights: retrieval.weights,
      });
      setRetrievalBase(retrieval);
      toast.success('检索默认值已保存');
      void refresh();
    } catch (cause) {
      setRetrievalError(messageOf(cause));
    } finally {
      setSavingRetrieval(false);
    }
  };

  const saveIntegration = async () => {
    if (!integrationValid || savingIntegration) return;
    setSavingIntegration(true);
    setIntegrationError(null);
    try {
      const webhookUrl = integration.webhookUrl.trim();
      await api.projects.settings.update(projectId, {
        monthlyQuota: integration.monthlyQuota,
        webhookUrl,
        locale: integration.locale,
      });
      setIntegrationBase({ ...integration, webhookUrl });
      toast.success('配额与集成设置已保存');
      void refresh();
    } catch (cause) {
      setIntegrationError(messageOf(cause));
    } finally {
      setSavingIntegration(false);
    }
  };

  const saveInfo = async () => {
    if (!infoValid || savingInfo) return;
    setSavingInfo(true);
    setInfoError(null);
    try {
      const nextInfo: InfoForm = {
        ...info,
        name: info.name.trim(),
        description: info.description.trim(),
      };
      await api.projects.update(projectId, {
        name: nextInfo.name,
        description: nextInfo.description,
        status: nextInfo.status,
        region: nextInfo.region,
        env: nextInfo.env,
      });
      setInfo(nextInfo);
      setInfoBase(nextInfo);
      toast.success('项目信息已更新');
      await refresh();
    } catch (cause) {
      setInfoError(messageOf(cause));
    } finally {
      setSavingInfo(false);
    }
  };

  const normalizeWeights = () => {
    setRetrieval((prev) => {
      const weights = prev.weights;
      const sum = weights.semantic + weights.keyword + weights.entity + weights.recency;
      if (!Number.isFinite(sum) || sum <= 0) return prev;
      return {
        ...prev,
        weights: {
          semantic: weights.semantic / sum,
          keyword: weights.keyword / sum,
          entity: weights.entity / sum,
          recency: weights.recency / sum,
        },
      };
    });
  };

  const archiveProject = async () => {
    if (archiving) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await api.projects.remove(projectId);
      toast.success(`项目「${project.name}」已归档`);
      navigate('/projects');
    } catch (cause) {
      setArchiveError(messageOf(cause));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · 配置"
        title="项目设置"
        desc="配置记忆处理、检索默认值、配额与项目元信息；修改会写入审计日志。"
      />

      <SettingsSection
        title="记忆处理"
        desc="控制写入时的抽取、去重与图谱行为，以及数据保留周期。"
        dirty={memoryDirty}
        saving={savingMemory}
        disabled={!memoryValid}
        error={memoryError}
        onSave={() => void saveMemory()}
        saveLabel="保存记忆处理"
      >
        <Field label="抽取模式" hint={EXTRACTION_COPY[memory.extractionMode]}>
          <div className="hstack">
            <Segmented<ExtractionMode>
              options={[
                { value: 'additive', label: '追加模式' },
                { value: 'consolidate', label: '合并模式' },
              ]}
              value={memory.extractionMode}
              onChange={(next) => setMemory((prev) => ({ ...prev, extractionMode: next }))}
            />
          </div>
        </Field>

        <Field
          label={
            <span className="between">
              <span>去重阈值</span>
              <span className="mono small muted">{fmtPct(memory.dedupeThreshold * 100, 1)}</span>
            </span>
          }
          error={dedupeError ?? undefined}
          hint="相似度达到该值的记忆会被判定为重复，0.5–1 之间。"
        >
          <input
            className="slider"
            type="range"
            min={0.5}
            max={1}
            step={0.01}
            value={Number.isFinite(memory.dedupeThreshold) ? memory.dedupeThreshold : 0.5}
            style={{ '--pct': sliderPct(memory.dedupeThreshold, 0.5, 1) } as CSSProperties}
            onChange={(event) =>
              setMemory((prev) => ({ ...prev, dedupeThreshold: Number(event.target.value) }))
            }
          />
        </Field>

        <div className="between">
          <div>
            <div className="small soft">知识图谱抽取</div>
            <div className="tiny dim">从记忆中抽取实体与关系，供图谱页与 entity 检索信号使用。</div>
          </div>
          <span style={{ flexShrink: 0 }}>
            <Switch
              checked={memory.graphEnabled}
              onChange={(checked) => setMemory((prev) => ({ ...prev, graphEnabled: checked }))}
              label={memory.graphEnabled ? '已启用' : '已关闭'}
            />
          </span>
        </div>

        <Field
          label="数据保留天数"
          htmlFor="retention-days"
          error={retentionError ?? undefined}
          hint="超过保留期的记忆与关联审计数据会被清理，范围 30–1095 天。"
        >
          <Input
            id="retention-days"
            type="number"
            min={30}
            max={1095}
            step={1}
            value={Number.isFinite(memory.retentionDays) ? memory.retentionDays : ''}
            onChange={(event) =>
              setMemory((prev) => ({ ...prev, retentionDays: Number(event.target.value) }))
            }
            suffix="天"
            style={{ paddingLeft: 11, paddingRight: 34 }}
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="检索默认值"
        desc="检索 API 未显式传参时使用的默认 topK、阈值与混合检索权重。"
        dirty={retrievalDirty}
        saving={savingRetrieval}
        disabled={!retrievalValid}
        error={retrievalError}
        onSave={() => void saveRetrieval()}
        saveLabel="保存检索默认值"
      >
        <div className="grid grid-2">
          <Field
            label="默认 topK"
            htmlFor="default-topk"
            error={topKError ?? undefined}
            hint="单次检索返回的记忆条数，范围 1–20。"
          >
            <Input
              id="default-topk"
              type="number"
              min={1}
              max={20}
              step={1}
              value={Number.isFinite(retrieval.topK) ? retrieval.topK : ''}
              onChange={(event) =>
                setRetrieval((prev) => ({ ...prev, topK: Number(event.target.value) }))
              }
            />
          </Field>
          <Field
            label="召回阈值"
            htmlFor="default-threshold"
            error={thresholdError ?? undefined}
            hint="低于该分数的结果会被过滤，范围 0–1。"
          >
            <Input
              id="default-threshold"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={Number.isFinite(retrieval.threshold) ? retrieval.threshold : ''}
              onChange={(event) =>
                setRetrieval((prev) => ({ ...prev, threshold: Number(event.target.value) }))
              }
            />
          </Field>
        </div>

        <div>
          <div className="between mb-12">
            <div>
              <div className="small soft">检索权重</div>
              <div className="tiny dim">四个信号共同决定最终排序，建议总和保持为 1。</div>
            </div>
            <div className="hstack gap-8" style={{ flexShrink: 0 }}>
              <span className="tiny dim nowrap">总和</span>
              <Badge tone={weightsNormalized ? 'green' : 'amber'} size="sm">
                {Number.isFinite(weightSum) ? weightSum.toFixed(2) : '—'}
              </Badge>
              <Button size="sm" variant="ghost" onClick={normalizeWeights} disabled={!Number.isFinite(weightSum) || weightSum <= 0}>
                归一化
              </Button>
            </div>
          </div>
          <div className="grid grid-2">
            {WEIGHT_FIELDS.map((field) => {
              const value = retrieval.weights[field.key];
              return (
                <div key={field.key} className="vstack gap-6">
                  <div className="between">
                    <span className="small soft">{field.label}</span>
                    <span className="mono tiny dim">{value.toFixed(2)}</span>
                  </div>
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    aria-label={field.label}
                    value={Number.isFinite(value) ? value : 0}
                    style={{ '--pct': sliderPct(value, 0, 1) } as CSSProperties}
                    onChange={(event) =>
                      setRetrieval((prev) => ({
                        ...prev,
                        weights: { ...prev.weights, [field.key]: Number(event.target.value) },
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-12">
            {weightsNormalized ? (
              <div className="tiny dim">权重总和为 1.00，检索将直接按当前比例加权。</div>
            ) : (
              <Callout tone="amber" icon="alert">
                权重总和不等于 1（当前 {Number.isFinite(weightSum) ? weightSum.toFixed(2) : '—'}）。检索时会按比例自动归一化；建议调整滑块或点击「归一化」。
              </Callout>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="配额与集成"
        desc="控制每月注入 Token 配额、Webhook 通知与默认语言。"
        dirty={integrationDirty}
        saving={savingIntegration}
        disabled={!integrationValid}
        error={integrationError}
        onSave={() => void saveIntegration()}
        saveLabel="保存配额与集成"
      >
        <Field
          label="每月记忆注入配额"
          htmlFor="monthly-quota"
          error={quotaError ?? undefined}
          hint={`当前约 ${fmtCompact(integration.monthlyQuota)} tokens / 月，超出后新请求会返回 429。`}
        >
          <Input
            id="monthly-quota"
            type="number"
            min={0}
            step={100000}
            value={Number.isFinite(integration.monthlyQuota) ? integration.monthlyQuota : ''}
            onChange={(event) =>
              setIntegration((prev) => ({ ...prev, monthlyQuota: Number(event.target.value) }))
            }
            suffix="tokens"
            style={{ paddingLeft: 11, paddingRight: 60 }}
          />
        </Field>

        <Field
          label="Webhook URL"
          htmlFor="webhook-url"
          error={webhookError ?? undefined}
          hint="可选。记忆写入、配额告警等事件会以 POST JSON 推送。"
        >
          <Input
            id="webhook-url"
            type="url"
            value={integration.webhookUrl}
            placeholder="https://example.com/hooks/mnemos"
            onChange={(event) =>
              setIntegration((prev) => ({ ...prev, webhookUrl: event.target.value }))
            }
          />
        </Field>

        <Field label="默认语言" htmlFor="locale" hint="影响抽取提示词与系统生成内容的语言。">
          <Select
            id="locale"
            value={integration.locale}
            options={[
              { value: 'zh-CN', label: '简体中文（zh-CN）' },
              { value: 'en-US', label: 'English（en-US）' },
            ]}
            onChange={(event) => setIntegration((prev) => ({ ...prev, locale: event.target.value }))}
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="项目信息"
        desc="项目名称、描述、运行状态与部署位置。"
        dirty={infoDirty}
        saving={savingInfo}
        disabled={!infoValid}
        error={infoError}
        onSave={() => void saveInfo()}
        saveLabel="保存项目信息"
      >
        <div className="grid grid-2">
          <Field
            label="项目名称"
            htmlFor="project-name"
            required
            error={infoNameError ?? undefined}
            hint="展示在侧边栏与顶栏，最多 60 个字符。"
          >
            <Input
              id="project-name"
              value={info.name}
              onChange={(event) => setInfo((prev) => ({ ...prev, name: event.target.value }))}
            />
          </Field>
          <Field label="项目状态" htmlFor="project-status" hint="暂停后 API 仍可读取，但写入会被拒绝。">
            <Select
              id="project-status"
              value={info.status}
              options={PROJECT_STATUSES.map((status) => ({ value: status.value, label: status.label }))}
              onChange={(event) =>
                setInfo((prev) => ({ ...prev, status: event.target.value as ProjectStatus }))
              }
            />
          </Field>
          <div className="span-2">
            <Field label="项目描述" htmlFor="project-description" hint="说明项目用途与接入团队，最多 200 个字符。">
              <Textarea
                id="project-description"
                rows={3}
                maxLength={200}
                value={info.description}
                onChange={(event) => setInfo((prev) => ({ ...prev, description: event.target.value }))}
              />
            </Field>
          </div>
          <Field label="区域" htmlFor="project-region" hint="决定数据驻留与网络延迟。">
            <Select
              id="project-region"
              value={info.region}
              options={REGIONS}
              onChange={(event) => setInfo((prev) => ({ ...prev, region: event.target.value }))}
            />
          </Field>
          <Field label="环境" htmlFor="project-env" hint="用于区分生产、预发布与沙箱流量。">
            <Select
              id="project-env"
              value={info.env}
              options={ENVIRONMENTS}
              onChange={(event) => setInfo((prev) => ({ ...prev, env: event.target.value }))}
            />
          </Field>
        </div>
      </SettingsSection>

      <Card pad>
        <SectionHead title="危险操作" desc="归档项目会释放配额并从项目列表与导航中移除。" />
        <div className="mt-16">
          <Callout tone="amber" icon="alert">
            归档后项目进入只读状态，记忆与审计数据保留 {project.settings.retentionDays} 天，到期后永久删除。归档操作会写入审计日志，且无法在控制台内撤销。
          </Callout>
        </div>
        {archiveError ? (
          <div className="mt-16">
            <Callout tone="red" icon="alert">
              {archiveError}
            </Callout>
          </div>
        ) : null}
        <div className="between mt-16">
          <div className="small muted">归档项目「{project.name}」</div>
          <Button
            variant="danger"
            icon="trash"
            disabled={project.status === 'archived'}
            onClick={() => setArchiveOpen(true)}
          >
            归档项目
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={() => {
          void archiveProject();
        }}
        loading={archiving}
        title="归档项目"
        description={`确定归档「${project.name}」吗？项目将从列表移除，数据保留 ${project.settings.retentionDays} 天后清除。`}
        confirmLabel="确认归档"
      />
    </div>
  );
}
