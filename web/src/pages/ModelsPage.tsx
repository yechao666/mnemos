import { useMemo } from 'react';
import type { LlmProvider, LlmStageConfig, LlmUsageSummary } from '@lib/types.ts';
import { LLM_STAGES, ROLE_LABEL, ROLE_RANK } from '@lib/constants.ts';
import { api, llmErrorHint } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { Button, Callout, PageHead, Stat } from '@ui';
import { ProviderSection } from '../components/models/ProviderSection.tsx';
import { StageSection } from '../components/models/StageSection.tsx';
import { UsageSection } from '../components/models/UsageSection.tsx';

const EMPTY_PROVIDERS: LlmProvider[] = [];
const EMPTY_STAGES: LlmStageConfig[] = [];
const EMPTY_USAGE: LlmUsageSummary[] = [];

/**
 * v6.4 模型设置：供应商 + 按阶段分配模型 + 测试连接 + 近 30 天用量。
 * 后端直连 OpenAI 兼容 / Anthropic API，不依赖 DSH；接口未上线/无权限时页面以提示态展示。
 */
export function ModelsPage() {
  const { user } = useAuth();
  const isAdmin = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.admin);

  const status = useAsync(() => api.llm.status(), [], isAdmin);
  const providers = useAsync(() => api.llm.providers.list(), [], isAdmin);
  const stages = useAsync(() => api.llm.stages.list(), [], isAdmin);
  const usage = useAsync(() => api.llm.usage(30), [], isAdmin);

  const providerList = providers.data ?? EMPTY_PROVIDERS;
  const stageList = stages.data ?? EMPTY_STAGES;
  const usageList = usage.data ?? EMPTY_USAGE;

  const enabledProviders = providerList.filter((provider) => provider.enabled).length;
  const statusUnavailable = Boolean(status.error && !status.data);
  const providersUnavailable = Boolean(providers.error && !providers.data);
  const stagesUnavailable = Boolean(stages.error && !stages.data);
  const assignedStages = useMemo(
    () =>
      LLM_STAGES.map((item) => item.value).filter((stage) => {
        const config = stageList.find((item) => item.stage === stage);
        return Boolean(config?.providerId);
      }).length,
    [stageList],
  );

  const refreshAll = () => {
    void Promise.all([status.refresh(), providers.refresh(), stages.refresh(), usage.refresh()]);
  };

  const refreshing = status.loading || providers.loading || stages.loading || usage.loading;

  if (!isAdmin) {
    return (
      <div className="page">
        <PageHead
          eyebrow="组织"
          title="模型设置"
          desc="直连 OpenAI 兼容 / Anthropic API，不依赖 DSH。为每个记忆阶段选择供应商、模型与参数。"
        />
        <Callout tone="violet" icon="server">
          <strong>直连模式：</strong>后端直接调用供应商 API，DSH 插件只作为记忆客户端，不参与模型调用；
          未配置时回退环境变量 <span className="mono">MNEMOS_LLM_*</span>，调用失败静默回退确定性逻辑。
        </Callout>
        <Callout tone="amber" icon="lock">
          模型设置需要管理员（owner / admin）权限。当前账号为「{user ? ROLE_LABEL[user.role] : '未登录'}」，
          请联系组织管理员调整配置。
        </Callout>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="组织"
        title="模型设置"
        desc="直连 OpenAI 兼容 / Anthropic API，不依赖 DSH。为每个记忆阶段选择供应商与模型，控制温度、输出上限与超时，降低 token 成本。"
        actions={
          <Button icon="refresh" loading={refreshing} onClick={refreshAll}>
            刷新
          </Button>
        }
      />

      <Callout tone="violet" icon="server">
        <strong>直连模式：</strong>后端直接调用供应商 API（OpenAI 兼容 / Anthropic 协议），DSH 插件只作为记忆客户端。
        阶段未配置时回退环境变量 <span className="mono">MNEMOS_LLM_*</span>；调用失败（超时 / 非 2xx）静默回退确定性逻辑，不阻断主流程。
      </Callout>

      {status.error ? (
        <Callout tone="amber" icon="alert">
          <div className="between wrap" style={{ gap: 10 }}>
            <span>无法读取 LLM 状态：{llmErrorHint(status.error)}</span>
            <Button size="sm" icon="refresh" onClick={() => void status.refresh()}>重试</Button>
          </div>
        </Callout>
      ) : null}

      <div className="kpi-grid">
        <Stat
          label="直连模式"
          value="OpenAI / Anthropic"
          icon="server"
          tone="violet"
          hint="不依赖 DSH"
        />
        <Stat
          label="环境变量回退"
          value={
            status.loading && !status.data
              ? '检测中'
              : statusUnavailable
                ? '未知'
                : status.data?.envFallbackConfigured
                  ? '已配置'
                  : '未配置'
          }
          icon="terminal"
          tone={statusUnavailable ? 'slate' : status.data?.envFallbackConfigured ? 'green' : 'slate'}
          hint="MNEMOS_LLM_*"
        />
        <Stat
          label="供应商"
          value={statusUnavailable && providersUnavailable ? '—' : status.data?.providers ?? providerList.length}
          unit="个"
          icon="cpu"
          tone="cyan"
          hint={`启用 ${enabledProviders} 个`}
        />
        <Stat
          label="阶段分配"
          value={stagesUnavailable ? '—' : `${assignedStages}/${LLM_STAGES.length}`}
          icon="layers"
          tone={stagesUnavailable ? 'slate' : assignedStages > 0 ? 'amber' : 'slate'}
          hint="已分配供应商的阶段"
        />
      </div>

      <div className="tiny dim" style={{ marginTop: -8 }}>
        API Key 存储：
        {status.loading && !status.data
          ? '检测中…'
          : status.error && !status.data
            ? '未知（无法读取状态）'
            : status.data?.encryptionConfigured
              ? 'AES-256-GCM 加密（MNEMOS_ENCRYPTION_KEY）'
              : '未配置加密密钥，服务端将明文存储并标记'}
        。测试连接与用量统计不会记录 prompt 内容。
      </div>

      <ProviderSection
        providers={providerList}
        loading={providers.loading}
        error={providers.error}
        onRefresh={async () => {
          await providers.refresh();
          await status.refresh();
        }}
        onChanged={async () => {
          await providers.refresh();
          await status.refresh();
        }}
        onDeleted={async () => {
          await stages.refresh();
          await status.refresh();
        }}
      />

      <StageSection
        stages={stageList}
        providers={providerList}
        loading={stages.loading}
        error={stages.error}
        providersLoading={providers.loading}
        providersUnavailable={Boolean(providers.error)}
        onRefresh={async () => {
          await stages.refresh();
          await status.refresh();
        }}
        onChanged={async () => {
          await status.refresh();
        }}
      />

      <UsageSection
        usage={usageList}
        loading={usage.loading}
        error={usage.error}
        onRefresh={async () => {
          await usage.refresh();
        }}
      />
    </div>
  );
}
