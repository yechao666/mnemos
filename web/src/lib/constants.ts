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
export const APP_VERSION = '6.3.0';

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

/* ---------------- v6.3 规则库：分组 / 校验器 / 严重级别 ---------------- */

/** 规则库分组元信息（与服务端 privacy-catalog.ts 对齐；接口未上线时用于兜底展示）。 */
export interface PrivacyGroupMeta {
  key: string;
  name: string;
  industry: string;
  description: string;
  sortOrder: number;
}

export const PRIVACY_GROUPS: PrivacyGroupMeta[] = [
  { key: 'common', name: '通用个人信息', industry: '通用', description: '姓名、地址、生日、邮编等自然人基础信息。', sortOrder: 10 },
  { key: 'contact', name: '联系方式', industry: '通用', description: '邮箱、手机号、座机、国际号码、微信号。', sortOrder: 20 },
  { key: 'identity_cn', name: '中国证件', industry: '政务 / 实名', description: '身份证、护照、港澳台通行证、驾驶证、社保/医保等。', sortOrder: 30 },
  { key: 'identity_intl', name: '国际证件', industry: '跨境 / 合规', description: 'SSN、ITIN、护照、VAT 等国际证件与税号。', sortOrder: 40 },
  { key: 'finance', name: '金融支付', industry: '金融', description: '银行卡、信用卡、CVV、IBAN、SWIFT、证券/基金/保单/发票。', sortOrder: 50 },
  { key: 'healthcare', name: '医疗健康', industry: '医疗', description: '病历号、医保卡、处方、检验单、诊断/用药/指标/基因。', sortOrder: 60 },
  { key: 'hr', name: '人力资源', industry: 'HR', description: '工号、薪资、绩效等员工敏感信息。', sortOrder: 70 },
  { key: 'ecommerce', name: '电商零售', industry: '电商', description: '订单号、运单号、收件人信息。', sortOrder: 80 },
  { key: 'internet', name: '网络与设备', industry: '互联网', description: 'IP、MAC、Android ID、广告标识等设备/网络标识。', sortOrder: 90 },
  { key: 'credentials', name: '账号凭据', industry: '安全', description: '密码、API Key、JWT、私钥、连接串、验证码。', sortOrder: 100 },
  { key: 'education', name: '教育', industry: '教育', description: '学号、准考证号、成绩。', sortOrder: 110 },
  { key: 'legal', name: '法律政务', industry: '法律 / 政务', description: '案号、合同号、律师证、统一社会信用代码。', sortOrder: 120 },
  { key: 'automotive', name: '汽车交通', industry: '汽车', description: '车牌、VIN、发动机号。', sortOrder: 130 },
  { key: 'location', name: '位置信息', industry: 'LBS', description: '经纬度、geohash 等精确位置。', sortOrder: 140 },
  { key: 'biometric', name: '生物特征', industry: '安全 / 医疗', description: '指纹、人脸、虹膜、声纹、DNA 等。', sortOrder: 150 },
  { key: 'crypto', name: '区块链', industry: 'Web3', description: 'ETH/BTC 地址、私钥、助记词。', sortOrder: 160 },
  { key: 'telecom', name: '通信', industry: '运营商', description: 'IMEI、IMSI、ICCID、国际号码。', sortOrder: 170 },
  { key: 'realestate', name: '房产', industry: '地产', description: '房产证/不动产权证号、产权人信息。', sortOrder: 180 },
];

export const PRIVACY_GROUP_LABEL: Record<string, string> = Object.fromEntries(
  PRIVACY_GROUPS.map((group) => [group.key, group.name]),
);

export const PRIVACY_GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部分组' },
  ...PRIVACY_GROUPS.map((group) => ({ value: group.key, label: `${group.name} · ${group.industry}` })),
];

/** 规则校验器（对应服务端 validators.ts）；none 表示不做结构校验。 */
export const PRIVACY_VALIDATORS: { value: string; label: string; desc: string }[] = [
  { value: 'none', label: '不校验', desc: '仅按正则命中，不做结构/校验位检查（误报率最高）。' },
  { value: 'luhn', label: 'Luhn 校验位', desc: '银行卡、信用卡、IMEI 等；过滤掉校验位不正确的数字串。' },
  { value: 'cn_id', label: '中国身份证', desc: 'GB11643 校验位 + 出生日期校验。' },
  { value: 'us_ssn', label: '美国 SSN', desc: '过滤无效号段（000/666/900+ 等）。' },
  { value: 'us_itin', label: '美国 ITIN', desc: '9xx-7x/8x-xxxx 号段校验。' },
  { value: 'iban', label: 'IBAN', desc: 'mod97 校验。' },
  { value: 'vin', label: '车架号 VIN', desc: '17 位 VIN 校验位 + 非法字母过滤。' },
  { value: 'ipv4', label: 'IPv4', desc: '使用 node:net isIP 校验。' },
  { value: 'ipv6', label: 'IPv6', desc: '使用 node:net isIP 校验。' },
  { value: 'mac', label: 'MAC 地址', desc: '6 组十六进制校验。' },
  { value: 'jwt', label: 'JWT', desc: '三段结构 + header 可解析为 JSON。' },
  { value: 'uscc', label: '统一社会信用代码', desc: '18 位 mod31 校验。' },
  { value: 'eth', label: 'ETH 地址', desc: '0x + 40 位十六进制。' },
  { value: 'btc', label: 'BTC 地址', desc: 'Base58Check 校验。' },
  { value: 'coordinates', label: '经纬度坐标', desc: '纬度 −90~90、经度 −180~180。' },
  { value: 'uuid', label: 'UUID', desc: '8-4-4-4-12 格式。' },
];

export const PRIVACY_VALIDATOR_LABEL: Record<string, string> = Object.fromEntries(
  PRIVACY_VALIDATORS.map((item) => [item.value, item.label]),
);

/** 严重级别：影响告警与审计优先级。 */
export const PRIVACY_SEVERITIES: {
  value: 'low' | 'medium' | 'high';
  label: string;
  desc: string;
  tone: Tone;
}[] = [
  { value: 'low', label: '低', desc: '弱标识 / 辅助信息，误报影响小。', tone: 'slate' },
  { value: 'medium', label: '中', desc: '一般敏感信息，默认级别。', tone: 'amber' },
  { value: 'high', label: '高', desc: '强标识 / 高敏信息，建议启用并关注命中。', tone: 'red' },
];

export const PRIVACY_SEVERITY_LABEL: Record<'low' | 'medium' | 'high', string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export const PRIVACY_SEVERITY_TONE: Record<'low' | 'medium' | 'high', Tone> = {
  low: 'slate',
  medium: 'amber',
  high: 'red',
};

/** 常见适用地区（可自由输入，如 CN / US / EU / global）。 */
export const PRIVACY_REGION_OPTIONS: { value: string; label: string }[] = [
  { value: 'global', label: 'global · 全球' },
  { value: 'CN', label: 'CN · 中国' },
  { value: 'US', label: 'US · 美国' },
  { value: 'EU', label: 'EU · 欧盟' },
  { value: 'UK', label: 'UK · 英国' },
  { value: 'JP', label: 'JP · 日本' },
];

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
