/** v6 控制台常量：产品信息、分页与筛选项（不依赖 @shared，避免后端重建期间的类型漂移）。 */

import type { Tone } from '@ui';
import type {
  AttachmentKind,
  MemoryCategory,
  MemoryHistoryEvent,
  MemoryScope,
  MemorySearchMode,
  PersonStatus,
  PersonType,
  PiiRedactionMode,
  PrivacyAction,
  PrivacyMaskMode,
  PrivacyRuleKind,
  PrivacyRuleScope,
  RetrievalSignal,
  RetrievalWeights,
  Role,
} from './types.ts';

export const APP_NAME = 'Mnemos';
export const APP_TAGLINE = '分区 · 人 · 记忆';
export const APP_VERSION = '6.2.0';

/** 人/记忆列表每页条数（游标分页；契约默认 50，最大 200）。 */
export const PAGE_SIZE = 50;
/** 人列表固定行高（虚拟滚动窗口化依赖固定行高）。 */
export const PERSON_ROW_HEIGHT = 56;

export const ROLE_RANK: Record<Role, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

export const ROLE_LABEL: Record<Role, string> = {
  owner: '所有者',
  admin: '管理员',
  developer: '开发者',
  viewer: '只读',
};

export const PARTITION_STATUSES: { value: 'active' | 'paused' | 'archived'; label: string }[] = [
  { value: 'active', label: '运行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'archived', label: '已归档' },
];

export const PARTITION_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...PARTITION_STATUSES.map((item) => ({ value: item.value, label: item.label })),
];

export const PERSON_TYPES: { value: PersonType; label: string; desc: string }[] = [
  { value: 'human', label: '真人', desc: 'App 用户、员工、客户等自然人' },
  { value: 'agent', label: '智能体', desc: 'AI Agent / 数字员工' },
  { value: 'service', label: '服务', desc: '后台服务或系统身份' },
  { value: 'other', label: '其他', desc: '无法归类的主体' },
];

export const PERSON_STATUSES: { value: PersonStatus; label: string }[] = [
  { value: 'active', label: '生效中' },
  { value: 'archived', label: '已归档' },
  { value: 'deleted', label: '已删除' },
];

export const PERSON_TYPE_OPTIONS: { value: PersonType | ''; label: string }[] = [
  { value: '', label: '全部类型' },
  ...PERSON_TYPES.map((item) => ({ value: item.value, label: item.label })),
];

export const PERSON_STATUS_OPTIONS: { value: PersonStatus | ''; label: string }[] = [
  { value: '', label: '全部状态' },
  ...PERSON_STATUSES.map((item) => ({ value: item.value, label: item.label })),
];

export type PersonSort = 'recent' | 'new' | 'name';

export const PERSON_SORT_OPTIONS: { value: PersonSort; label: string }[] = [
  { value: 'recent', label: '最近活跃' },
  { value: 'new', label: '最新建档' },
  { value: 'name', label: '姓名排序' },
];

export const MEMORY_SCOPES: { value: MemoryScope; label: string; desc: string }[] = [
  { value: 'person', label: '仅本人', desc: '只有该人可见' },
  { value: 'partition', label: '分区共享', desc: '分区内所有人可见' },
  { value: 'session', label: '仅会话', desc: '只在当前会话内可见' },
];

export const SCOPE_OPTIONS: { value: MemoryScope | ''; label: string }[] = [
  { value: '', label: '全部范围' },
  ...MEMORY_SCOPES.map((item) => ({ value: item.value, label: item.label })),
];

export const MEMORY_CATEGORIES: { value: MemoryCategory; label: string }[] = [
  { value: 'preference', label: '偏好' },
  { value: 'identity', label: '身份' },
  { value: 'fact', label: '事实' },
  { value: 'plan', label: '计划' },
  { value: 'relationship', label: '关系' },
  { value: 'event', label: '事件' },
  { value: 'skill', label: '技能' },
  { value: 'constraint', label: '约束' },
  { value: 'context', label: '上下文' },
  { value: 'insight', label: '洞见' },
  { value: 'decision', label: '决策' },
  { value: 'progress', label: '进展' },
  { value: 'lesson', label: '经验' },
  { value: 'risk', label: '风险' },
  { value: 'change', label: '变更' },
  { value: 'acceptance', label: '验收' },
  { value: 'assumption', label: '假设' },
  { value: 'dependency', label: '依赖' },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  MEMORY_CATEGORIES.map((item) => [item.value, item.label]),
);

export const CATEGORY_OPTIONS: { value: MemoryCategory | ''; label: string }[] = [
  { value: '', label: '全部分类' },
  ...MEMORY_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
];

export const SOURCE_LABEL: Record<string, string> = {
  conversation: '对话抽取',
  api: 'API 写入',
  agent: '智能体写入',
  import: '导入',
  playground: '演练场',
  dream: '做梦沉淀',
};

/** 分区页签（信息架构只保留 v6 领域）。 */
export const PARTITION_TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '.', label: '概览', end: true },
  { to: 'persons', label: '人' },
  { to: 'memories', label: '记忆', end: true },
  { to: 'graph', label: '图谱', end: true },
  { to: 'keys', label: '密钥', end: true },
  { to: 'usage', label: '用量', end: true },
  { to: 'audit', label: '审计', end: true },
  { to: 'privacy', label: '隐私', end: true },
  { to: 'settings', label: '设置', end: true },
  { to: 'docs', label: 'API 文档', end: true },
];

/* ------------------------------------------------------------------ */
/* v6.1 P2：多模态附件 / 实体类型 / PII 合规                           */
/* ------------------------------------------------------------------ */

export const ATTACHMENT_KINDS: {
  value: AttachmentKind;
  label: string;
  desc: string;
  tone: Tone;
}[] = [
  { value: 'image', label: '图片', desc: '截图、设计稿、照片（抽屉内展示缩略图）', tone: 'violet' },
  { value: 'audio', label: '音频', desc: '语音消息、录音（以链接/播放器展示）', tone: 'cyan' },
  { value: 'video', label: '视频', desc: '演示、录屏（以链接/播放器展示）', tone: 'pink' },
  { value: 'file', label: '文件', desc: '文档、压缩包等（下载链接）', tone: 'slate' },
];

export const ATTACHMENT_KIND_LABEL: Record<AttachmentKind, string> = Object.fromEntries(
  ATTACHMENT_KINDS.map((item) => [item.value, item.label]),
) as Record<AttachmentKind, string>;

/** 附件上限与服务端一致：每记忆 ≤10 条、url ≤2000 字符、caption ≤1000。 */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_URL = 2000;
export const MAX_ATTACHMENT_CAPTION = 1000;

/** 实体类型展示（当前规则抽取主要产出 concept；保留常见类型供后续扩展）。 */
export const ENTITY_TYPE_META: Record<string, { label: string; tone: Tone }> = {
  concept: { label: '概念', tone: 'violet' },
  person: { label: '人物', tone: 'blue' },
  org: { label: '组织', tone: 'green' },
  place: { label: '地点', tone: 'cyan' },
  event: { label: '事件', tone: 'amber' },
  product: { label: '产品', tone: 'pink' },
  other: { label: '其他', tone: 'slate' },
};

export function entityTypeMeta(type: string | undefined | null): { label: string; tone: Tone } {
  return (type && ENTITY_TYPE_META[type]) || ENTITY_TYPE_META.other;
}

/** PII 脱敏级别（分区设置 settings.piiRedaction）。 */
export const PII_REDACTION_OPTIONS: {
  value: PiiRedactionMode;
  label: string;
  desc: string;
}[] = [
  {
    value: 'off',
    label: '关闭',
    desc: '记忆原文落库；如需保留完整联系方式（例如客服工单）时使用。',
  },
  {
    value: 'basic',
    label: '基础脱敏',
    desc: '写入前对手机号 / 邮箱 / 身份证 / 银行卡做正则脱敏，其余内容不变。',
  },
];

/** 脱敏示例（设置页展示，帮助理解 basic 的效果）。 */
export const PII_REDACTION_EXAMPLES: { label: string; before: string; after: string }[] = [
  { label: '手机号', before: '联系我 13812345678', after: '联系我 138****5678' },
  { label: '邮箱', before: 'alice@example.com', after: 'a***@example.com' },
  { label: '身份证', before: '110101199001011234', after: '110101********1234' },
  { label: '银行卡', before: '6222021234567890123', after: '622202********0123' },
];

/* ------------------------------------------------------------------ */
/* v6.2 隐私规则域                                                     */
/* ------------------------------------------------------------------ */

export const PRIVACY_SCOPE_OPTIONS: { value: PrivacyRuleScope; label: string; desc: string }[] = [
  { value: 'partition', label: '当前分区', desc: '只影响本分区；同 code 时覆盖全局规则' },
  { value: 'global', label: '全局', desc: '组织级默认规则，由 owner 维护，可被分区覆盖' },
];

export const PRIVACY_RULE_KINDS: { value: PrivacyRuleKind; label: string; desc: string }[] = [
  { value: 'regex', label: '正则扫描', desc: '确定性匹配，无需 LLM；可精确控制 pattern 与 flags。' },
  { value: 'prompt', label: '提示词（LLM）', desc: '把抽取指令交给 LLM；需开启 privacyLlmEnabled 且配置 LLM。' },
];

export const PRIVACY_RULE_KIND_LABEL: Record<PrivacyRuleKind, string> = {
  regex: '正则',
  prompt: '提示词',
};

export const PRIVACY_ACTION_OPTIONS: { value: PrivacyAction; label: string; desc: string }[] = [
  { value: 'mask', label: '打码', desc: '按 maskMode 替换为 *（保留可读结构）' },
  { value: 'placeholder', label: '占位符', desc: '替换为 {{pii_xxx}} token，真实值加密存映射表' },
];

export const PRIVACY_ACTION_LABEL: Record<PrivacyAction, string> = {
  mask: '打码',
  placeholder: '占位符',
};

export const PRIVACY_MASK_MODES: { value: PrivacyMaskMode; label: string; desc: string }[] = [
  { value: 'email', label: '邮箱模式', desc: 'a***@domain（保留域名）' },
  { value: 'keepFirstLast', label: '保留首尾', desc: '前 N + * + 后 M（身份证 6/4、手机 3/4）' },
  { value: 'keepLast', label: '只保留末位', desc: '* + 后 N 位（默认 4）' },
  { value: 'full', label: '全部打码', desc: '整个命中片段替换为 *' },
];

export const PRIVACY_MASK_MODE_LABEL: Record<PrivacyMaskMode, string> = {
  email: '邮箱模式',
  keepFirstLast: '保留首尾',
  keepLast: '保留末位',
  full: '全部打码',
};

/** 内置常用实体类型（可自由输入，下面是常见建议值）。 */
export const PRIVACY_ENTITY_TYPES: { value: string; label: string }[] = [
  { value: 'email', label: 'email · 邮箱' },
  { value: 'phone', label: 'phone · 手机号' },
  { value: 'id_card', label: 'id_card · 身份证' },
  { value: 'bank_card', label: 'bank_card · 银行卡' },
  { value: 'name', label: 'name · 姓名' },
  { value: 'address', label: 'address · 地址' },
  { value: 'credential', label: 'credential · 凭据' },
  { value: 'medical', label: 'medical · 医疗' },
];

/** 预览示例文本：覆盖 regex 内置规则与 prompt 常见实体。 */
export const PRIVACY_PREVIEW_SAMPLE =
  '联系张伟：手机 13812345678，邮箱 zhangwei@example.com，身份证 110101199001011234，银行卡 6222021234567890123。';

/** 占位符 key 规则（与服务端一致）：[A-Za-z0-9_-]{3,64}。 */
export const PLACEHOLDER_KEY_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
export const PLACEHOLDER_TOKEN_REGEX = /\{\{([A-Za-z0-9_-]{3,64})\}\}/g;
export const MAX_PLACEHOLDER_VALUE = 2000;


/* ------------------------------------------------------------------ */
/* v6.1 检索 / 历史 / 反馈                                             */
/* ------------------------------------------------------------------ */

export const RETRIEVAL_MODES: { value: MemorySearchMode; label: string; desc: string }[] = [
  { value: 'hybrid', label: '混合', desc: '向量 + 关键词 + 时效 + 重要度融合（默认）' },
  { value: 'keyword', label: '关键词', desc: '仅 FTS5 关键词检索' },
  { value: 'vector', label: '向量', desc: '仅本地 embedding 语义相似度' },
];

export const EMBEDDING_MODELS: { value: string; label: string }[] = [
  { value: 'mnemos-hash-384', label: 'Mnemos Hash-384（本地、免密钥）' },
  { value: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small（外部）' },
];

/** 与 shared 默认值一致；后端尚未返回新字段时用作表单初值。 */
export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = {
  vector: 0.45,
  keyword: 0.3,
  recency: 0.15,
  importance: 0.1,
  entity: 0,
};

export const DEFAULT_RETRIEVAL_SETTINGS = {
  retrievalMode: 'hybrid' as MemorySearchMode,
  retrievalWeights: DEFAULT_RETRIEVAL_WEIGHTS,
  embeddingModel: 'mnemos-hash-384',
  mergeThreshold: 0.95,
  dedupeThreshold: 0.98,
  autoExtractEntities: true,
};

export const RETRIEVAL_SIGNAL_META: {
  key: RetrievalSignal;
  label: string;
  short: string;
  tone: Tone;
  desc: string;
}[] = [
  { key: 'vector', label: '向量', short: 'vec', tone: 'violet', desc: 'embedding 余弦相似度' },
  { key: 'keyword', label: '关键词', short: 'kw', tone: 'cyan', desc: 'FTS5 关键词命中' },
  { key: 'recency', label: '时效', short: 'rec', tone: 'green', desc: '越新越高的时间衰减' },
  { key: 'importance', label: '重要度', short: 'imp', tone: 'amber', desc: '写入时的 importance' },
  { key: 'entity', label: '实体', short: 'ent', tone: 'pink', desc: '实体/关系命中（P2 启用）' },
];

export const HISTORY_EVENT_META: Record<MemoryHistoryEvent, { label: string; tone: Tone; desc: string }> = {
  ADD: { label: '新增', tone: 'green', desc: '写入了一条新记忆' },
  UPDATE: { label: '更新', tone: 'blue', desc: '内容或元信息被修改' },
  MERGE: { label: '合并', tone: 'violet', desc: '相似记忆合并进本条' },
  SUPERSEDE: { label: '取代', tone: 'amber', desc: '旧事实被新记忆取代' },
  DELETE: { label: '删除', tone: 'red', desc: '记忆被删除/归档' },
  NOOP: { label: '未新增', tone: 'slate', desc: '重复写入被去重' },
  FEEDBACK: { label: '反馈', tone: 'cyan', desc: '用户标记有帮助/没帮助' },
  RESTORE: { label: '恢复', tone: 'lime', desc: '记忆被恢复' },
  PRIVACY: { label: '隐私处理', tone: 'pink', desc: '隐私规则 / 占位符替换' },
};
