import type {
  ApiScope,
  MemoryCategory,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  PartitionSettings,
  PartitionStatus,
  PersonStatus,
  PersonType,
  Role,
  DemoAccount,
} from './types.ts';

export const APP_NAME = 'Mnemos';
export const APP_TAGLINE = '企业级 AI 记忆基础设施';
export const APP_VERSION = '6.3.0';
export const DEFAULT_SERVER_PORT = 4380;

/** 游标分页：默认 50，最大 200。 */
export const CURSOR_LIMIT_DEFAULT = 50;
export const CURSOR_LIMIT_MAX = 200;

export const ROLES: { value: Role; label: string; desc: string }[] = [
  { value: 'owner', label: '所有者', desc: '全部权限，可转让与删除分区' },
  { value: 'admin', label: '管理员', desc: '管理密钥、成员、设置与记忆' },
  { value: 'developer', label: '开发者', desc: '读写记忆、创建密钥' },
  { value: 'viewer', label: '只读', desc: '仅可查看数据与用量' },
];

export const ROLE_RANK: Record<Role, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

/** 演示账号（仅 MNEMOS_DEMO=1；密码与 seed 保持一致，便于开发测试一键登录）。 */
export const DEMO_PASSWORD = 'Demo123456';

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'admin@mnemos.dev',
    name: '演示管理员',
    role: 'owner',
    password: DEMO_PASSWORD,
    title: '平台管理员',
  },
  {
    email: 'dev@mnemos.dev',
    name: '演示开发者',
    role: 'developer',
    password: DEMO_PASSWORD,
    title: '应用开发者',
  },
  {
    email: 'viewer@mnemos.dev',
    name: '演示查看者',
    role: 'viewer',
    password: DEMO_PASSWORD,
    title: '数据审计',
  },
];

/** 企业微信 Mock 登录：仅开发/演示环境启用（MNEMOS_WECOM_MOCK=1 或 DEMO）。 */
export const WECOM_MOCK_CONFIG = {
  provider: { slug: 'wecom' as const, name: '企业微信（Mock）' },
  appid: 'ww-mock-appid',
  agentid: '1000001',
  account: { email: 'admin@mnemos.dev', name: '演示管理员' },
  hint: '开发/测试环境专用：跳过真实扫码，直接以演示管理员登录。',
};

export const SCOPES: { value: ApiScope; label: string; desc: string }[] = [
  { value: 'memories:read', label: '记忆读取', desc: '搜索、列表、详情、简报与上下文' },
  { value: 'memories:write', label: '记忆写入', desc: '新增、更新、删除记忆' },
  { value: 'admin', label: '管理', desc: '分区、人、密钥、用量与审计' },
];

export const PARTITION_STATUSES: { value: PartitionStatus; label: string; tone: 'success' | 'warning' | 'muted' }[] = [
  { value: 'active', label: '运行中', tone: 'success' },
  { value: 'paused', label: '已暂停', tone: 'warning' },
  { value: 'archived', label: '已归档', tone: 'muted' },
];

export const PERSON_TYPES: { value: PersonType; label: string; desc: string }[] = [
  { value: 'human', label: '真人', desc: 'App 用户 / 员工' },
  { value: 'agent', label: '智能体', desc: 'Agent / 助手' },
  { value: 'service', label: '服务', desc: '系统 / 服务账号' },
  { value: 'other', label: '其他', desc: '未分类主体' },
];

export const PERSON_STATUSES: { value: PersonStatus; label: string }[] = [
  { value: 'active', label: '活跃' },
  { value: 'archived', label: '已归档' },
  { value: 'deleted', label: '已删除' },
];

export const MEMORY_CATEGORIES: { value: MemoryCategory; label: string; color: string }[] = [
  { value: 'preference', label: '偏好', color: 'violet' },
  { value: 'identity', label: '身份', color: 'blue' },
  { value: 'fact', label: '事实', color: 'cyan' },
  { value: 'plan', label: '计划', color: 'amber' },
  { value: 'relationship', label: '关系', color: 'pink' },
  { value: 'event', label: '事件', color: 'orange' },
  { value: 'skill', label: '技能', color: 'lime' },
  { value: 'constraint', label: '约束', color: 'red' },
  { value: 'context', label: '上下文', color: 'slate' },
  { value: 'insight', label: '洞见', color: 'amber' },
  { value: 'decision', label: '重要决策', color: 'blue' },
  { value: 'progress', label: '关键进展', color: 'green' },
  { value: 'lesson', label: '经验教训', color: 'red' },
  { value: 'risk', label: '风险与阻塞', color: 'red' },
  { value: 'change', label: '变更', color: 'amber' },
  { value: 'acceptance', label: '验收与质量', color: 'green' },
  { value: 'assumption', label: '假设与待确认', color: 'violet' },
  { value: 'dependency', label: '依赖与承诺', color: 'blue' },
];

export const MEMORY_SOURCES: { value: MemorySource; label: string }[] = [
  { value: 'api', label: 'API 写入' },
  { value: 'conversation', label: '对话' },
  { value: 'agent', label: 'Agent 写入' },
  { value: 'import', label: '导入' },
  { value: 'playground', label: '演练场' },
  { value: 'dream', label: '做梦巩固' },
];

export const MEMORY_STATUSES: { value: MemoryStatus; label: string }[] = [
  { value: 'active', label: '生效中' },
  { value: 'archived', label: '已归档' },
  { value: 'deleted', label: '已删除' },
];

export const MEMORY_SCOPES: { value: MemoryScope; label: string; desc: string }[] = [
  { value: 'person', label: '仅本人', desc: '只有该人可见' },
  { value: 'partition', label: '分区共享', desc: '分区内多人可见' },
  { value: 'session', label: '仅会话', desc: '只在所属会话内可见' },
];

export const CATEGORY_LABEL: Record<MemoryCategory, string> = Object.fromEntries(
  MEMORY_CATEGORIES.map((item) => [item.value, item.label]),
) as Record<MemoryCategory, string>;

export const DEFAULT_PARTITION_SETTINGS: PartitionSettings = {
  defaultScope: 'partition',
  briefMaxChars: 1200,
  briefEnabled: true,
  dreamEnabled: true,
  dreamIntervalMinutes: 1440,
  retentionDays: 0,
  monthlyQuota: 0,
  personAutoCreate: true,
  locale: 'zh-CN',
  retrievalMode: 'hybrid',
  retrievalWeights: { vector: 0.45, keyword: 0.3, recency: 0.15, importance: 0.1, entity: 0 },
  embeddingModel: 'mnemos-hash-384',
  mergeThreshold: 0.95,
  dedupeThreshold: 0.98,
  autoExtractEntities: true,
  piiRedaction: 'off',
  privacyLlmEnabled: false,
};

/** 多模态附件（P2）上限：每记忆最多 10 个、URL 最长 2000 字符。 */
export const ATTACHMENT_KINDS = ['image', 'audio', 'video', 'file'] as const;
export const MAX_ATTACHMENTS_PER_MEMORY = 10;
export const MAX_ATTACHMENT_URL_LENGTH = 2000;
export const MAX_ATTACHMENT_CAPTION_LENGTH = 1000;

/** 检索模式选项（控制台/文档共用）。 */
export const RETRIEVAL_MODES: { value: 'hybrid' | 'keyword' | 'vector'; label: string }[] = [
  { value: 'hybrid', label: '混合检索' },
  { value: 'keyword', label: '关键词' },
  { value: 'vector', label: '语义向量' },
];

export const EMBEDDING_MODELS = [
  { value: 'mnemos-hash-384', label: 'Mnemos Hash-384（本地、免密钥）' },
  { value: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small（外部）' },
];


/** 隐私规则类型选项（控制台/文档共用）。 */
export const PRIVACY_RULE_KINDS: { value: 'regex' | 'prompt'; label: string; desc: string }[] = [
  { value: 'regex', label: '正则扫描', desc: '直接对文本做确定性匹配与替换，无需 LLM。' },
  { value: 'prompt', label: '提示词（LLM）', desc: '把抽取指令交给 LLM 识别，适合人名/地址/凭据等。' },
];
