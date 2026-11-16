import type {
  ApiScope,
  MemoryCategory,
  MemorySource,
  MemoryStatus,
  ProjectStatus,
  Role,
  DemoAccount,
} from './types.ts';

export const APP_NAME = 'Mnemos';
export const APP_TAGLINE = '企业级 AI 记忆基础设施';
export const APP_VERSION = '1.1.0';
export const DEFAULT_SERVER_PORT = 4380;
export const PAGE_SIZE = 20;

export const ROLES: { value: Role; label: string; desc: string }[] = [
  { value: 'owner', label: '所有者', desc: '全部权限，可转让与删除项目' },
  { value: 'admin', label: '管理员', desc: '管理密钥、成员、设置与记忆' },
  { value: 'developer', label: '开发者', desc: '读写记忆、创建密钥' },
  { value: 'viewer', label: '只读', desc: '仅可查看数据与用量' },
];

export const ROLE_RANK: Record<Role, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

export const SCOPES: { value: ApiScope; label: string; desc: string }[] = [
  { value: 'memories:read', label: '记忆读取', desc: '搜索、列表、详情、历史' },
  { value: 'memories:write', label: '记忆写入', desc: '新增、更新、删除记忆' },
  { value: 'graph:read', label: '图谱读取', desc: '实体关系与图谱查询' },
  { value: 'admin', label: '管理', desc: '用量、审计与项目配置' },
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
  { value: 'conversation', label: '对话抽取' },
  { value: 'api', label: 'API 写入' },
  { value: 'agent', label: 'Agent 写入' },
  { value: 'import', label: '导入' },
  { value: 'playground', label: '演练场' },
  { value: 'dream', label: '复盘总结' },
];

export const CATEGORY_LABEL: Record<MemoryCategory, string> = Object.fromEntries(
  MEMORY_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<MemoryCategory, string>;

export const MEMORY_STATUSES: { value: MemoryStatus; label: string }[] = [
  { value: 'active', label: '生效中' },
  { value: 'archived', label: '已归档' },
  { value: 'deleted', label: '已删除' },
];

export const PROJECT_STATUSES: { value: ProjectStatus; label: string; tone: 'success' | 'warning' | 'muted' }[] = [
  { value: 'active', label: '运行中', tone: 'success' },
  { value: 'paused', label: '已暂停', tone: 'warning' },
  { value: 'archived', label: '已归档', tone: 'muted' },
];

export const SIGNAL_LABELS: { key: 'semantic' | 'keyword' | 'entity' | 'recency' | 'importance'; label: string; color: string }[] = [
  { key: 'semantic', label: '语义向量', color: 'violet' },
  { key: 'keyword', label: '关键词 BM25', color: 'cyan' },
  { key: 'entity', label: '实体命中', color: 'pink' },
  { key: 'recency', label: '时效性', color: 'amber' },
  { key: 'importance', label: '重要度', color: 'lime' },
];

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'lin.wei@mnemos.dev',
    name: '林薇',
    role: 'owner',
    password: 'mnemos-demo',
    title: '平台负责人',
  },
  {
    email: 'chen.hao@mnemos.dev',
    name: '陈昊',
    role: 'admin',
    password: 'mnemos-demo',
    title: '记忆平台工程师',
  },
  {
    email: 'su.yan@mnemos.dev',
    name: '苏妍',
    role: 'viewer',
    password: 'mnemos-demo',
    title: '数据合规审计',
  },
];

export const EMBEDDING_MODELS = [
  { value: 'mnemos-hash-384', label: 'Mnemos Hash-384（本地、免密钥）' },
  { value: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small' },
  { value: 'bge-m3', label: 'BGE-M3（自托管）' },
  { value: 'qwen3-embedding', label: 'Qwen3-Embedding（自托管）' },
];

export const REGIONS = [
  { value: 'cn-shanghai', label: '华东 · 上海' },
  { value: 'cn-beijing', label: '华北 · 北京' },
  { value: 'ap-singapore', label: '亚太 · 新加坡' },
  { value: 'eu-frankfurt', label: '欧洲 · 法兰克福' },
  { value: 'us-west', label: '美西 · 俄勒冈' },
];

export const ENVIRONMENTS = [
  { value: 'production', label: '生产环境' },
  { value: 'staging', label: '预发布' },
  { value: 'sandbox', label: '沙箱' },
];

export const DEFAULT_PROJECT_SETTINGS = {
  extractionMode: 'additive' as const,
  embeddingModel: 'mnemos-hash-384',
  topK: 8,
  threshold: 0.12,
  retentionDays: 365,
  graphEnabled: true,
  dedupeThreshold: 0.92,
  weights: { semantic: 0.45, keyword: 0.3, entity: 0.15, recency: 0.1 },
  monthlyQuota: 5_000_000,
  locale: 'zh-CN',
  briefMaxChars: 500,
  briefEnabled: true,
  dreamEnabled: true,
  dreamIntervalMinutes: 1440,
  reportsEnabled: true,
  weeklyReportDay: 5,
  weeklyReportTime: '17:00',
  monthlyReportDay: 1,
  monthlyReportTime: '09:00',
};

/* ------------------------------------------------------------------ */
/* 记忆简报 / 做梦                                                     */
/* ------------------------------------------------------------------ */

export const BRIEF_MIN_CHARS = 100;
export const BRIEF_MAX_CHARS = 5_000;
export const BRIEF_DEFAULT_CHARS = 500;
/** 生成简报时最多扫描/纳入的最近记忆条数。 */
export const BRIEF_RECENT_LIMIT = 40;

export const DREAM_MIN_INTERVAL_MINUTES = 1;
export const DREAM_MAX_INTERVAL_MINUTES = 60 * 24 * 30;
export const DREAM_DEFAULT_INTERVAL_MINUTES = 1440;
export const DREAM_BATCH_SIZE = 50;
export const DREAM_MAX_BATCH_SIZE = 200;
/** 洞见正文的最短长度，过短视为无效输出。 */
export const DREAM_MIN_INSIGHT_CHARS = 20;
/** 每次做梦最多写入的洞见条数。 */
export const DREAM_MAX_INSIGHTS = 5;

/** 记忆分类 → CSS 变量后缀（与 web 端 tokens 对应）。 */
export const TONE_COLORS = ['violet', 'cyan', 'pink', 'amber', 'lime', 'blue', 'red', 'slate'] as const;
