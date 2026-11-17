import type { MemoryCategory, ProjectSettings, Role } from '../../../shared/src/types.ts';

/** 演示数据集：面向企业多项目场景的策展记忆（可复现、无随机性）。 */

export interface SeedFact {
  text: string;
  category: MemoryCategory;
  daysAgo: number;
  importance?: number;
  tags?: string[];
  /** 覆盖 persona 的 agentId（Agent 原生场景） */
  agentId?: string;
  /** 所属任务 key，对应 SeedProject.tasks 中的 key */
  taskKey?: string;
  /** 可见性，默认 project（项目共享） */
  visibility?: 'project' | 'agent' | 'task';
}

export interface SeedPersona {
  /** 人类用户 ID；Agent 场景可留空 */
  userId?: string;
  label: string;
  agentId: string;
  facts: SeedFact[];
}

export interface SeedAgent {
  id: string;
  name: string;
  role: string;
  model: string;
  description: string;
  capabilities: string[];
  status?: 'active' | 'idle' | 'retired';
}

export interface SeedTask {
  key: string;
  id: string;
  title: string;
  goal: string;
  ownerAgentId: string;
  status: 'open' | 'active' | 'done' | 'abandoned';
  branch?: string;
  summary?: string;
  startDaysAgo: number;
  endDaysAgo?: number;
}

export interface SeedProject {
  slug: string;
  name: string;
  description: string;
  region: string;
  env: string;
  status: 'active' | 'paused' | 'archived';
  settings: Partial<ProjectSettings>;
  members: { email: string; role: Role }[];
  personas: SeedPersona[];
  synthTemplates: string[];
  synthTopics: string[];
  /** Agent 注册表（可选） */
  agents?: SeedAgent[];
  /** 任务会话（可选） */
  tasks?: SeedTask[];
}

const f = (
  text: string,
  category: MemoryCategory,
  daysAgo: number,
  importance = 0.62,
  tags: string[] = [],
): SeedFact => ({ text, category, daysAgo, importance, tags });

export const ORG = {
  id: 'org_yunshu',
  name: '云枢智能科技',
  slug: 'yunshu',
  plan: 'enterprise',
};

export const USERS = [
  {
    id: 'usr_linwei',
    email: 'lin.wei@mnemos.dev',
    name: '林薇',
    role: 'owner' as Role,
    title: '平台负责人',
    avatarColor: 'violet',
  },
  {
    id: 'usr_chenhao',
    email: 'chen.hao@mnemos.dev',
    name: '陈昊',
    role: 'admin' as Role,
    title: '记忆平台工程师',
    avatarColor: 'cyan',
  },
  {
    id: 'usr_suyan',
    email: 'su.yan@mnemos.dev',
    name: '苏妍',
    role: 'viewer' as Role,
    title: '数据合规审计',
    avatarColor: 'slate',
  },
  {
    id: 'usr_zhouye',
    email: 'zhou.ye@mnemos.dev',
    name: '周野',
    role: 'developer' as Role,
    title: '算法工程师',
    avatarColor: 'blue',
  },
  {
    id: 'usr_helan',
    email: 'he.lan@mnemos.dev',
    name: '何澜',
    role: 'admin' as Role,
    title: '业务运营',
    avatarColor: 'pink',
  },
  {
    id: 'usr_zhenglin',
    email: 'zheng.lin@mnemos.dev',
    name: '郑霖',
    role: 'developer' as Role,
    title: '外包协作（已离职）',
    avatarColor: 'amber',
    status: 'disabled',
  },
];

export const DEMO_PASSWORD = 'mnemos-demo';

export const PROJECTS: SeedProject[] = [
  {
    slug: 'aurora-support',
    name: 'Aurora 智能客服',
    description: '面向 Aurora Cloud 的客户支持智能体，跨会话记住客户偏好、套餐、历史工单与合规约束。',
    region: 'cn-shanghai',
    env: 'production',
    status: 'active',
    settings: {
      extractionMode: 'consolidate',
      embeddingModel: 'mnemos-hash-384',
      topK: 8,
      threshold: 0.14,
      retentionDays: 365,
      graphEnabled: true,
      dedupeThreshold: 0.93,
      monthlyQuota: 8_000_000,
      weights: { semantic: 0.45, keyword: 0.25, entity: 0.2, recency: 0.1 },
    },
    members: [
      { email: 'lin.wei@mnemos.dev', role: 'owner' },
      { email: 'chen.hao@mnemos.dev', role: 'admin' },
      { email: 'he.lan@mnemos.dev', role: 'developer' },
      { email: 'su.yan@mnemos.dev', role: 'viewer' },
    ],
    personas: [
      {
        userId: 'cust-1042',
        label: '张倩 · 杭州星野零售',
        agentId: 'agent-support-l1',
        facts: [
          f('张倩是 Aurora Cloud 企业版客户，公司为杭州星野零售，账号规模 240 个坐席。', 'identity', 42, 0.82, ['企业版', '零售']),
          f('张倩偏好通过企业微信联系，工作日上午 9 点至 11 点回复最快，不接受电话回访。', 'preference', 40, 0.74, ['联络偏好']),
          f('张倩的团队使用自定义工单字段「门店编号」，升级工单时必须保留该字段。', 'constraint', 38, 0.8, ['工单字段']),
          f('张倩正在评估把知识库迁移到 Aurora Knowledge，预计 12 月完成预算审批。', 'plan', 12, 0.7, ['迁移']),
          f('张倩反馈 10 月 18 日的批量导出任务失败过两次，对导出稳定性比较敏感。', 'event', 20, 0.66, ['导出']),
        ],
      },
      {
        userId: 'cust-2087',
        label: '李哲 · 深圳云杉科技',
        agentId: 'agent-support-t2',
        facts: [
          f('李哲是深圳云杉科技的技术负责人，负责 Aurora Cloud 的 API 集成与 SSO 配置。', 'identity', 55, 0.84, ['技术负责人']),
          f('李哲只接受带可复现步骤和 trace id 的排查结论，拒绝模糊答复。', 'preference', 51, 0.78, ['排查规范']),
          f('云杉科技使用 SAML 2.0 单点登录，IdP 为 Azure AD，租户域名为 yunshan.com。', 'fact', 48, 0.72, ['SSO']),
          f('李哲计划在 11 月底前完成 webhook 重试策略改造，需要我方提供幂等键方案。', 'plan', 9, 0.75, ['webhook']),
        ],
      },
      {
        userId: 'cust-3311',
        label: '王芮 · 客服主管',
        agentId: 'agent-support-l1',
        facts: [
          f('王芮负责 60 人客服团队，关注坐席上手速度与话术一致性。', 'identity', 33, 0.75, ['团队管理']),
          f('王芮偏好每周一上午收到上周服务质量周报，格式为 CSV 加图表摘要。', 'preference', 30, 0.7, ['周报']),
          f('王芮要求所有涉及退款承诺的回复必须先经主管审核。', 'constraint', 28, 0.86, ['退款', '合规']),
          f('王芮在 9 月试点过 AI 辅助回复，坐席平均处理时长下降了 18%。', 'event', 26, 0.68, ['AI 辅助']),
        ],
      },
      {
        userId: 'cust-4520',
        label: '陈国栋 · 华北制药集团',
        agentId: 'agent-billing',
        facts: [
          f('陈国栋是华北制药集团的财务负责人，审批 Aurora 年度续费。', 'identity', 60, 0.8, ['财务']),
          f('陈国栋要求发票抬头与合同主体完全一致，抬头为「华北制药集团股份有限公司」。', 'constraint', 58, 0.9, ['发票', '财务']),
          f('该客户走年度预付加季度对账流程，对账日为每季度最后一个工作日。', 'fact', 45, 0.7, ['对账']),
        ],
      },
      {
        userId: 'cust-5673',
        label: '刘思远 · 移动端产品',
        agentId: 'agent-support-t2',
        facts: [
          f('刘思远是 Aurora 移动端 App 的产品经理，重点关注 SDK 崩溃率。', 'identity', 25, 0.76, ['移动端']),
          f('刘思远希望新功能灰度先覆盖 5% 用户，观察 72 小时后再放量。', 'preference', 22, 0.72, ['灰度']),
          f('刘思远反馈 v3.2 的离线缓存策略在弱网下会丢失草稿。', 'event', 8, 0.74, ['缺陷']),
        ],
      },
      {
        userId: 'cust-6810',
        label: '赵敏 · 数据合规',
        agentId: 'agent-support-l1',
        facts: [
          f('赵敏负责数据合规，要求所有记忆数据保留不超过 180 天，并支持按客户 ID 导出。', 'constraint', 36, 0.88, ['合规', '保留期']),
          f('赵敏只接受通过工单系统流转的正式答复，不接受即时消息承诺。', 'preference', 34, 0.76, ['流程']),
        ],
      },
      {
        userId: 'cust-7734',
        label: '孙倩文 · 启明教育',
        agentId: 'agent-support-l1',
        facts: [
          f('孙倩文是启明教育的教务负责人，使用 Aurora 处理招生咨询，日均 1200 会话。', 'identity', 29, 0.78, ['教育']),
          f('孙倩文偏好语音转文字的会话摘要，摘要需要标注家长情绪。', 'preference', 27, 0.7, ['摘要']),
          f('启明教育在寒暑假前两周有咨询高峰，需要提前扩容。', 'fact', 24, 0.72, ['容量']),
          f('孙倩文要求未成年学员信息不得出现在会话摘要中。', 'constraint', 21, 0.9, ['未成年人', '合规']),
        ],
      },
      {
        userId: 'cust-8891',
        label: '何俊 · 精密制造',
        agentId: 'agent-support-t2',
        facts: [
          f('何俊是精密制造企业的 IT 经理，负责 Aurora 与 MES 系统对接。', 'identity', 31, 0.77, ['制造', '集成']),
          f('何俊的团队只在每周三下午进行变更，变更窗口 14:00 至 17:00。', 'constraint', 30, 0.82, ['变更窗口']),
          f('何俊要求接口调用失败时返回可读的中文错误码。', 'preference', 19, 0.68, ['接口']),
        ],
      },
      {
        userId: 'cust-9021',
        label: '郭婉 · 连锁诊所',
        agentId: 'agent-billing',
        facts: [
          f('郭婉是连锁诊所的运营负责人，关注多门店账单合并。', 'identity', 23, 0.74, ['医疗', '账单']),
          f('郭婉希望账单按门店维度拆分，并支持导出到金蝶。', 'preference', 20, 0.7, ['导出']),
          f('该客户合同含 12% 的年度用量递增条款。', 'fact', 18, 0.76, ['合同']),
        ],
      },
      {
        userId: 'cust-9214',
        label: '马骁 · 游戏社区运营',
        agentId: 'agent-support-l1',
        facts: [
          f('马骁是游戏公司的社区运营，关注大版本更新期的舆情。', 'identity', 17, 0.73, ['游戏']),
          f('马骁要求负面舆情在 10 分钟内触发升级。', 'constraint', 15, 0.84, ['舆情', 'SLA']),
          f('马骁偏好用短句和结论先行的回复风格。', 'preference', 13, 0.64, ['风格']),
        ],
      },
      {
        userId: 'agent-support-l1',
        label: '一线支持助手',
        agentId: 'agent-support-l1',
        facts: [
          f('一线支持助手对退款类问题必须引用《退款政策 v4.2》条款编号。', 'constraint', 70, 0.9, ['政策']),
          f('遇到 P1 事故时，一线助手应在 2 分钟内升级到二线并同步事故频道。', 'plan', 68, 0.86, ['事故']),
        ],
      },
      {
        userId: 'agent-support-t2',
        label: '二线支持助手',
        agentId: 'agent-support-t2',
        facts: [
          f('二线支持助手需要先复现问题，再给出根因、影响面与临时规避方案。', 'constraint', 65, 0.88, ['排查']),
          f('二线助手的排查记录要附上相关日志片段与 trace id。', 'preference', 63, 0.8, ['排查']),
        ],
      },
      {
        userId: 'agent-billing',
        label: '账单助手',
        agentId: 'agent-billing',
        facts: [
          f('账单助手在回答费用问题前必须确认客户合同周期与折扣条款。', 'constraint', 62, 0.9, ['账单']),
          f('涉及退款的计算需同时给出原路退回与余额抵扣两种方案。', 'preference', 61, 0.78, ['退款']),
        ],
      },
    ],
    synthTemplates: [
      '{user} 在 {date} 的工单中确认了 {topic} 的后续跟进安排。',
      '{user} 于 {date} 反馈 {topic} 相关问题已临时规避，等待下一版本修复。',
      '工单 {date}：{user} 咨询 {topic} 的配置方式，需附操作截图。',
      '{user} 在 {date} 的会话中提到 {topic} 的验收标准已由主管确认。',
    ],
    synthTopics: ['工单批量导出', 'SSO 登录异常', '坐席质检规则', '会话摘要模板', 'Webhook 重试', '知识库同步', '账单拆分', '权限继承'],
  },
  {
    slug: 'atlas-copilot',
    name: 'Atlas 研发助手',
    description: '为研发团队提供代码评审、故障复盘与排期记忆，按工程师与代码仓隔离。',
    region: 'cn-beijing',
    env: 'production',
    status: 'active',
    settings: {
      extractionMode: 'additive',
      embeddingModel: 'mnemos-hash-384',
      topK: 10,
      threshold: 0.1,
      retentionDays: 730,
      graphEnabled: true,
      dedupeThreshold: 0.95,
      monthlyQuota: 12_000_000,
      weights: { semantic: 0.5, keyword: 0.25, entity: 0.15, recency: 0.1 },
    },
    members: [
      { email: 'zhou.ye@mnemos.dev', role: 'admin' },
      { email: 'chen.hao@mnemos.dev', role: 'developer' },
      { email: 'lin.wei@mnemos.dev', role: 'owner' },
    ],
    personas: [
      {
        userId: 'dev-zhouye',
        label: '周野 · 检索服务负责人',
        agentId: 'agent-code-review',
        facts: [
          f('周野负责记忆检索服务，主分支为 release/2026.11。', 'identity', 44, 0.78, ['检索']),
          f('周野要求所有 PR 必须附带压测数据与回滚方案。', 'preference', 41, 0.8, ['PR 规范']),
          f('周野在 10 月 21 日排查过一次向量检索超时，根因是 HNSW 的 ef 参数过低。', 'event', 15, 0.76, ['事故', '检索']),
          f('周野在 10 月 28 日完成混合检索的 BM25 权重调优，召回率提升 6 个百分点。', 'event', 6, 0.74, ['调优']),
        ],
      },
      {
        userId: 'dev-qianbo',
        label: '钱博 · on-call',
        agentId: 'agent-oncall',
        facts: [
          f('钱博是本周 on-call，负责 20:00 至次日 8:00 的 P1 响应。', 'plan', 5, 0.72, ['值班']),
          f('钱博偏好先看监控看板再拉群，避免过度响应。', 'preference', 30, 0.66, ['响应']),
          f('钱博在 10 月 30 日处理过一次写入放大告警，通过限流与批量合并缓解。', 'event', 7, 0.7, ['告警']),
        ],
      },
      {
        userId: 'dev-luxi',
        label: '陆希 · 控制台前端',
        agentId: 'agent-code-review',
        facts: [
          f('陆希维护记忆控制台前端，技术栈为 React 19 与 Vite。', 'fact', 38, 0.72, ['前端']),
          f('陆希坚持组件不引入第三方 UI 库，样式统一走设计 token。', 'preference', 35, 0.75, ['设计系统']),
          f('陆希计划在 11 月中旬上线命令面板与键盘快捷键。', 'plan', 11, 0.68, ['路线图']),
        ],
      },
      {
        userId: 'dev-hanfeng',
        label: '韩峰 · 架构负责人',
        agentId: 'agent-arch',
        facts: [
          f('韩峰是架构负责人，要求新服务必须提供容量评估与故障演练记录。', 'constraint', 50, 0.86, ['架构评审']),
          f('韩峰在 9 月评审中否决了把记忆与业务库混部的方案。', 'event', 34, 0.8, ['架构决策']),
          f('韩峰要求灰度发布先覆盖内部账号，观察 24 小时。', 'constraint', 28, 0.78, ['发布']),
        ],
      },
      {
        userId: 'dev-duanran',
        label: '段然 · 产品设计',
        agentId: 'agent-product',
        facts: [
          f('段然负责记忆控制台的产品设计，偏好信息密度高的界面。', 'preference', 37, 0.68, ['产品']),
          f('段然要求所有空态都给出下一步操作。', 'constraint', 33, 0.74, ['体验']),
          f('段然计划在 12 月上线记忆质量评分与漂移告警。', 'plan', 10, 0.7, ['路线图']),
        ],
      },
      {
        userId: 'dev-shenli',
        label: '沈黎 · QA',
        agentId: 'agent-code-review',
        facts: [
          f('沈黎负责回归测试，关注多项目隔离与中文检索准确性。', 'identity', 36, 0.72, ['测试']),
          f('沈黎维护 240 条中文检索用例，覆盖简称、同义词与错别字。', 'fact', 32, 0.75, ['测试集']),
        ],
      },
      {
        userId: 'agent-code-review',
        label: '代码评审助手',
        agentId: 'agent-code-review',
        facts: [
          f('代码评审助手要求所有 SQL 使用参数化查询，禁止字符串拼接。', 'constraint', 60, 0.9, ['安全']),
          f('评审发现 P0 级问题时，助手应直接 @ 值班负责人并创建事故单。', 'plan', 58, 0.84, ['流程']),
          f('代码评审助手对新增依赖会检查许可证与维护活跃度。', 'preference', 52, 0.76, ['依赖治理']),
        ],
      },
      {
        userId: 'agent-oncall',
        label: '值班助手',
        agentId: 'agent-oncall',
        facts: [
          f('值班助手处理 P1 事故时，先确认影响面再执行回滚，回滚需双人确认。', 'constraint', 56, 0.9, ['事故']),
          f('事故复盘需在 48 小时内提交，包含时间线与改进项负责人。', 'plan', 54, 0.82, ['复盘']),
          f('P2 故障的响应时限为 4 小时，超时自动升级。', 'constraint', 49, 0.8, ['SLA']),
        ],
      },
      {
        userId: 'agent-arch',
        label: '架构助手',
        agentId: 'agent-arch',
        facts: [
          f('架构助手在给出方案时必须列出三种备选与取舍。', 'preference', 47, 0.78, ['评审']),
          f('架构助手引用容量数据时必须注明采集时间与压测环境。', 'constraint', 46, 0.76, ['数据可信']),
        ],
      },
    ],
    synthTemplates: [
      '{user} 在 {date} 的评审纪要中确认了 {topic} 的负责人与截止时间。',
      '{date} 的故障复盘：{user} 提出 {topic} 需要补充监控与告警。',
      '{user} 在 {date} 的迭代计划中认领了 {topic} 的实现。',
      '{date} 的技术分享由 {user} 主讲 {topic}。',
    ],
    synthTopics: ['混合检索排序', '向量索引重建', '控制台路由', '审计日志归档', '用量统计口径', '多租户隔离', '密钥轮换', '发布流水线'],
  },
  {
    slug: 'helios-knowledge',
    name: 'Helios 知识中台',
    description: '沉淀行业研究与产品知识，支持多团队共享实体图谱，强调来源可追溯。',
    region: 'ap-singapore',
    env: 'staging',
    status: 'active',
    settings: {
      extractionMode: 'additive',
      embeddingModel: 'bge-m3',
      topK: 6,
      threshold: 0.18,
      retentionDays: 540,
      graphEnabled: true,
      dedupeThreshold: 0.94,
      monthlyQuota: 3_000_000,
      weights: { semantic: 0.4, keyword: 0.25, entity: 0.25, recency: 0.1 },
    },
    members: [
      { email: 'he.lan@mnemos.dev', role: 'owner' },
      { email: 'lin.wei@mnemos.dev', role: 'admin' },
      { email: 'su.yan@mnemos.dev', role: 'viewer' },
    ],
    personas: [
      {
        userId: 'analyst-wangyan',
        label: '王砚 · 行业研究',
        agentId: 'agent-rag',
        facts: [
          f('王砚负责行业研究，关注新能源与储能赛道。', 'identity', 40, 0.78, ['研究']),
          f('王砚要求引用结论必须标注报告名称与页码。', 'constraint', 39, 0.88, ['引用']),
          f('王砚偏好先给结论再用三点论据展开。', 'preference', 36, 0.7, ['表达']),
          f('王砚在 10 月的储能专题中指出，工商业储能装机增速已连续三个季度放缓。', 'event', 14, 0.72, ['储能']),
        ],
      },
      {
        userId: 'analyst-songqi',
        label: '宋琦 · 竞品情报',
        agentId: 'agent-summarizer',
        facts: [
          f('宋琦负责竞品情报，每周输出竞品动态简报。', 'plan', 38, 0.75, ['竞品']),
          f('宋琦要求简报包含定价变化与渠道动作两个固定栏目。', 'constraint', 37, 0.8, ['简报']),
          f('宋琦在最近一期简报中标记了北岸科技的两项渠道政策调整。', 'event', 12, 0.68, ['竞品']),
        ],
      },
      {
        userId: 'pm-xuran',
        label: '徐冉 · 知识治理',
        agentId: 'agent-rag',
        facts: [
          f('徐冉负责知识库治理，要求每个实体至少有 3 条来源支撑。', 'constraint', 42, 0.86, ['治理']),
          f('徐冉计划在 12 月完成知识图谱的实体去重与合并。', 'plan', 16, 0.74, ['图谱']),
          f('徐冉维护的实体类型体系包括公司、产品、人物、技术与政策五类。', 'fact', 35, 0.78, ['图谱']),
        ],
      },
      {
        userId: 'legal-tangning',
        label: '唐宁 · 法务合规',
        agentId: 'agent-summarizer',
        facts: [
          f('唐宁是法务顾问，关注合同条款与数据合规。', 'identity', 41, 0.76, ['法务']),
          f('唐宁要求涉及个人数据的结论标注适用法规条款。', 'constraint', 34, 0.9, ['合规']),
          f('唐宁在 9 月建议对跨境数据传输场景单独建立知识分区。', 'event', 29, 0.72, ['跨境']),
        ],
      },
      {
        userId: 'agent-rag',
        label: '检索助手',
        agentId: 'agent-rag',
        facts: [
          f('检索助手在回答行业问题时优先使用 2025 年之后发布的报告。', 'preference', 44, 0.8, ['时效']),
          f('检索结果不足三条时，助手必须明确说明证据不足。', 'constraint', 43, 0.92, ['可信度']),
        ],
      },
      {
        userId: 'agent-summarizer',
        label: '摘要助手',
        agentId: 'agent-summarizer',
        facts: [
          f('摘要助手输出控制在 200 字以内，并保留全部数字与专有名词。', 'constraint', 45, 0.88, ['摘要']),
          f('摘要助手遇到互相矛盾的来源时需并列呈现并标注冲突。', 'preference', 44, 0.84, ['冲突']),
        ],
      },
    ],
    synthTemplates: [
      '{date} 入库：{user} 补充了 {topic} 相关报告与来源标注。',
      '{user} 在 {date} 的评审中调整了 {topic} 的实体归类。',
      '{date} 的周会纪要提到 {topic} 需要补充一手访谈证据。',
    ],
    synthTopics: ['储能政策', '竞品定价', '行业白皮书', '专利分析', '供应链风险', '跨境合规'],
  },
  {
    slug: 'nova-sales',
    name: 'Nova 销售教练',
    description: '为销售团队记住客户画像、商机阶段与谈判偏好，用于陪练与跟进提醒。',
    region: 'cn-shanghai',
    env: 'sandbox',
    status: 'active',
    settings: {
      extractionMode: 'consolidate',
      embeddingModel: 'mnemos-hash-384',
      topK: 6,
      threshold: 0.2,
      retentionDays: 180,
      graphEnabled: false,
      dedupeThreshold: 0.9,
      monthlyQuota: 1_500_000,
      weights: { semantic: 0.4, keyword: 0.3, entity: 0.15, recency: 0.15 },
    },
    members: [
      { email: 'he.lan@mnemos.dev', role: 'owner' },
      { email: 'chen.hao@mnemos.dev', role: 'developer' },
    ],
    personas: [
      {
        userId: 'rep-chenmo',
        label: '陈默 · 华东制造业',
        agentId: 'agent-coach',
        facts: [
          f('陈默负责华东区制造业客户，季度目标 680 万。', 'identity', 26, 0.76, ['目标']),
          f('陈默偏好用案例对比开场，不喜欢直接报价。', 'preference', 25, 0.7, ['话术']),
          f('陈默在 10 月的某次竞标中因未澄清交付周期丢单。', 'event', 13, 0.74, ['丢单']),
        ],
      },
      {
        userId: 'rep-linxiao',
        label: '林晓 · 渠道合作',
        agentId: 'agent-coach',
        facts: [
          f('林晓负责渠道合作，关注伙伴返点与联合方案。', 'identity', 27, 0.72, ['渠道']),
          f('林晓要求每次拜访后 24 小时内录入跟进记录。', 'constraint', 24, 0.8, ['CRM']),
          f('林晓计划在 11 月拓展两家区域集成商。', 'plan', 9, 0.66, ['拓展']),
        ],
      },
      {
        userId: 'mgr-yangfan',
        label: '杨帆 · 销售总监',
        agentId: 'agent-coach',
        facts: [
          f('杨帆是华东区销售总监，要求商机阶段每周复核。', 'constraint', 30, 0.82, ['管理']),
          f('杨帆偏好用赢单率与周期长度评估打法。', 'preference', 28, 0.7, ['复盘']),
          f('杨帆在季度复盘中提出把陪练频次从每月一次提升到每周一次。', 'plan', 8, 0.68, ['陪练']),
        ],
      },
      {
        userId: 'agent-coach',
        label: '陪练助手',
        agentId: 'agent-coach',
        facts: [
          f('陪练助手在角色扮演中会模拟采购、法务与技术三类异议。', 'preference', 32, 0.8, ['陪练']),
          f('陪练结束后给出三处改进建议，并引用客户原话。', 'constraint', 31, 0.82, ['反馈']),
        ],
      },
    ],
    synthTemplates: [
      '{user} 在 {date} 的陪练中练习了 {topic} 场景。',
      '{date} 的商机复盘：{user} 总结 {topic} 需要提前准备材料。',
    ],
    synthTopics: ['价格异议', '交付周期', '竞品替换', '法务条款', '续约谈判'],
  },
  {
    slug: 'orbit-internal',
    name: 'Orbit 内部 Copilot',
    description: '内部效率助手，记住员工工具偏好与流程约束（已暂停，等待迁移到 Helios）。',
    region: 'eu-frankfurt',
    env: 'staging',
    status: 'paused',
    settings: {
      extractionMode: 'additive',
      embeddingModel: 'text-embedding-3-small',
      topK: 5,
      threshold: 0.22,
      retentionDays: 90,
      graphEnabled: false,
      dedupeThreshold: 0.95,
      monthlyQuota: 800_000,
      weights: { semantic: 0.55, keyword: 0.25, entity: 0.1, recency: 0.1 },
    },
    members: [
      { email: 'lin.wei@mnemos.dev', role: 'owner' },
      { email: 'su.yan@mnemos.dev', role: 'viewer' },
    ],
    personas: [
      {
        userId: 'emp-gaoyuan',
        label: '高远 · 行政',
        agentId: 'agent-internal',
        facts: [
          f('高远是行政负责人，管理办公用品与差旅审批。', 'identity', 22, 0.74, ['行政']),
          f('高远要求差旅报销单必须附电子发票与行程单。', 'constraint', 21, 0.84, ['报销']),
          f('差旅标准：一线城市住宿每晚不超过 600 元。', 'fact', 20, 0.8, ['差旅']),
        ],
      },
      {
        userId: 'emp-wutong',
        label: '吴桐 · HRBP',
        agentId: 'agent-internal',
        facts: [
          f('吴桐是 HRBP，关注入职流程与试用期反馈。', 'identity', 19, 0.72, ['HR']),
          f('吴桐偏好用清单形式给出待办。', 'preference', 18, 0.66, ['表达']),
          f('入职第一天需完成账号申请、设备领取与安全培训。', 'plan', 17, 0.78, ['入职']),
        ],
      },
      {
        userId: 'agent-internal',
        label: '内部助手',
        agentId: 'agent-internal',
        facts: [
          f('内部 Copilot 已暂停服务，计划迁移到 Helios 知识中台。', 'event', 12, 0.8, ['迁移']),
          f('员工数据保留期为 90 天，满足最小化原则。', 'constraint', 16, 0.86, ['合规']),
        ],
      },
    ],
    synthTemplates: ['{user} 在 {date} 的会话中询问了 {topic} 的流程。'],
    synthTopics: ['差旅审批', '设备申领', '试用期考核'],
  },
];

/** 每个项目预置的 API Key（演示用固定密钥，便于直接 curl 验证）。 */
/**
 * Agent 原生场景：Python 微服务开发。
 * 4 个 Agent 在 6 个任务中跨时间接力：架构决策、缺陷复盘、幂等改造、升级、当前任务。
 * 记忆通过 project 可见性在 Agent 之间共享，agent/task 可见性用于私有草稿与任务内上下文。
 */
export const ORION_PROJECT: SeedProject = {
  slug: 'orion-python',
  name: 'Orion 订单服务 · Python',
  description: '一个真实的 Python/FastAPI 订单服务：4 个 Agent 在 6 个任务中接力开发，架构决策、踩坑经验与规范在项目内共享。',
  region: 'cn-shanghai',
  env: 'production',
  status: 'active',
  settings: {
    extractionMode: 'consolidate',
    embeddingModel: 'mnemos-hash-384',
    topK: 8,
    threshold: 0.12,
    retentionDays: 730,
    graphEnabled: true,
    dedupeThreshold: 0.93,
    monthlyQuota: 6_000_000,
    weights: { semantic: 0.45, keyword: 0.3, entity: 0.15, recency: 0.1 },
  },
  members: [
    { email: 'chen.hao@mnemos.dev', role: 'owner' },
    { email: 'zhou.ye@mnemos.dev', role: 'admin' },
    { email: 'lin.wei@mnemos.dev', role: 'viewer' },
  ],
  agents: [
    {
      id: 'agent-arch',
      name: '架构师 Agent',
      role: 'architect',
      model: 'deepseek-chat',
      description: '负责服务边界、ADR、依赖升级与接口契约评审。',
      capabilities: ['architecture', 'adr', 'python', 'review'],
      status: 'active',
    },
    {
      id: 'agent-coder',
      name: '开发 Agent',
      role: 'developer',
      model: 'deepseek-coder',
      description: '负责 FastAPI/SQLAlchemy 实现、缺陷修复与测试补齐。',
      capabilities: ['python', 'fastapi', 'sqlalchemy', 'tests'],
      status: 'active',
    },
    {
      id: 'agent-reviewer',
      name: '评审 Agent',
      role: 'reviewer',
      model: 'deepseek-chat',
      description: '做代码评审、并发/安全审查，把踩坑经验沉淀为约束。',
      capabilities: ['code-review', 'security', 'performance'],
      status: 'idle',
    },
    {
      id: 'agent-oncall',
      name: '值班 Agent',
      role: 'oncall',
      model: 'deepseek-chat',
      description: '负责线上告警、事故复盘与回滚决策。',
      capabilities: ['incident', 'observability', 'rollback'],
      status: 'active',
    },
  ],
  tasks: [
    {
      key: 't-101',
      id: 'task_orion_bootstrap',
      title: '搭建订单服务骨架',
      goal: '确立 FastAPI + SQLAlchemy async 架构、目录约定与 CI 门禁。',
      ownerAgentId: 'agent-arch',
      status: 'done',
      branch: 'feat/bootstrap',
      summary: '落地 FastAPI 骨架、repository 分层、uv 依赖管理与 ruff/mypy/pytest 门禁。',
      startDaysAgo: 63,
      endDaysAgo: 56,
    },
    {
      key: 't-104',
      id: 'task_orion_oversell',
      title: '库存超卖并发缺陷修复',
      goal: '定位双十一预演中的超卖问题并修复事务边界。',
      ownerAgentId: 'agent-coder',
      status: 'done',
      branch: 'fix/stock-lock',
      summary: '行锁 + 同事务扣减，补充 50 并发压测；值班完成事故复盘。',
      startDaysAgo: 40,
      endDaysAgo: 36,
    },
    {
      key: 't-112',
      id: 'task_orion_payment',
      title: '支付回调幂等改造',
      goal: '消除支付回调重复处理导致的重复发货。',
      ownerAgentId: 'agent-coder',
      status: 'done',
      branch: 'fix/idempotency',
      summary: 'payment_events 幂等表 + 唯一键 + 死信队列，评审补充幂等键约束。',
      startDaysAgo: 22,
      endDaysAgo: 18,
    },
    {
      key: 't-121',
      id: 'task_orion_py312',
      title: '升级 Python 3.12 与依赖',
      goal: '完成运行时升级并验证性能与兼容性。',
      ownerAgentId: 'agent-arch',
      status: 'done',
      branch: 'chore/python312',
      summary: '升级 Python 3.12、pydantic v2、SQLAlchemy 2.0；uvloop 使 QPS 提升 12%。',
      startDaysAgo: 9,
      endDaysAgo: 7,
    },
    {
      key: 't-130',
      id: 'task_orion_split_query',
      title: '拆分订单查询服务',
      goal: '把查询流量从主库拆出，目标大促 P99 < 300ms。',
      ownerAgentId: 'agent-coder',
      status: 'active',
      branch: 'feat/query-service',
      startDaysAgo: 2,
    },
    {
      key: 't-140',
      id: 'task_orion_otel',
      title: '接入 OpenTelemetry 链路追踪',
      goal: '覆盖 FastAPI 与 SQLAlchemy，建立订单链路可观测性。',
      ownerAgentId: 'agent-oncall',
      status: 'active',
      branch: 'feat/otel',
      startDaysAgo: 1,
    },
  ],
  personas: [
    {
      label: '架构师 Agent · 历史决策',
      agentId: 'agent-arch',
      facts: [
        f('订单服务采用 FastAPI + SQLAlchemy 2.0 async，PostgreSQL 16 作为主库，Redis 仅用于幂等与限流。', 'fact', 61, 0.92, ['ADR']),
        f('所有数据库访问必须经过 repository 层，禁止在 router 中直接写 SQL。', 'constraint', 60, 0.9, ['分层']),
        f('项目目录约定：app/api、app/services、app/repositories、app/models、tests/。', 'fact', 59, 0.8, ['约定']),
        f('本地依赖用 uv 管理，锁文件 uv.lock，CI 必须使用同一版本。', 'constraint', 58, 0.82, ['工具链']),
        f('合并前必须通过 ruff format、ruff check、mypy --strict 与 pytest，覆盖率门禁 80%。', 'constraint', 57, 0.88, ['CI']),
        f('Python 3.12 升级完成，不再支持 3.9；pydantic v2 与 SQLAlchemy 2.0 已兼容。', 'fact', 8, 0.85, ['升级']),
        f('升级后 asyncio 默认使用 uvloop，订单查询压测 QPS 提升 12%。', 'event', 7, 0.7, ['性能']),
        f('拆分查询服务前必须先冻结查询接口契约，避免双写期间口径不一致。', 'constraint', 1, 0.88, ['拆分']),
        f('订单服务负责人是陈昊（chen.hao@mnemos.dev），重大变更需要他评审。', 'identity', 55, 0.8, ['负责人']),
      ].map((fact, index) => ({ ...fact, taskKey: index < 5 ? 't-101' : index < 7 ? 't-121' : index === 7 ? 't-130' : undefined })),
    },
    {
      label: '开发 Agent · 缺陷与实现',
      agentId: 'agent-coder',
      facts: [
        f('库存超卖根因：下单事务 SELECT 库存时未加锁，两个并发请求同时读到 10 件库存。', 'event', 39, 0.92, ['事故']),
        f('修复方案：SELECT ... FOR UPDATE 锁库存行，扣减与订单写入放入同一事务。', 'fact', 38, 0.9, ['修复']),
        f('库存服务统一入口 deduct_stock(sku_id, qty, order_id, lock=True)，必须传 order_id 做幂等。', 'fact', 36, 0.85, ['接口']),
        f('支付回调改造为幂等表 payment_events，唯一键 (channel, event_id)。', 'fact', 21, 0.9, ['幂等']),
        f('回调处理顺序：验签 → 落幂等表 → 更新订单 → 发领域事件，任一步失败整体回滚。', 'plan', 19, 0.82, ['流程']),
        f('查询服务拆分草稿：先读 read replica，再按 order_id 分片，跨分片统计是风险点。', 'plan', 1, 0.7, ['草稿']),
        f('大促压测结论：数据库连接池 20 增至 40 后，订单查询 P99 从 620ms 降到 280ms。', 'event', 25, 0.78, ['压测']),
      ].map((fact, index) => ({
        ...fact,
        taskKey: index < 3 ? 't-104' : index < 5 ? 't-112' : index === 5 ? 't-130' : undefined,
        visibility: index === 5 ? 'agent' : 'project',
      })),
    },
    {
      label: '评审 Agent · 约束沉淀',
      agentId: 'agent-reviewer',
      facts: [
        f('并发扣减类缺陷必须补充并发压测用例，至少 50 并发重复 100 次。', 'constraint', 37, 0.86, ['评审']),
        f('幂等键必须与业务单号绑定，不能只用回调请求 id 作为幂等键。', 'constraint', 20, 0.88, ['评审']),
        f('上次拆分 payment 服务时双写对账脚本漏了退款单，这次拆分前要先补对账。', 'event', 1, 0.85, ['复盘']),
      ].map((fact, index) => ({ ...fact, taskKey: index < 2 ? (index === 0 ? 't-104' : 't-112') : 't-130' })),
    },
    {
      label: '值班 Agent · 线上经验',
      agentId: 'agent-oncall',
      facts: [
        f('事故 2026-09-28 库存超卖 3 单已人工补偿，复盘要求库存变更统一走服务方法。', 'event', 37, 0.88, ['事故']),
        f('支付回调失败进入死信队列 payments.dlq，值班需 15 分钟内处理。', 'constraint', 18, 0.8, ['值班']),
        f('生产告警阈值：订单查询 P99 > 800ms 持续 5 分钟升级为 P2。', 'constraint', 1, 0.78, ['告警']),
        f('OpenTelemetry 接入：FastAPI 中间件 + SQLAlchemy 事件埋点，采样率 10%。', 'plan', 1, 0.72, ['可观测']),
      ].map((fact, index) => ({ ...fact, taskKey: index === 0 ? 't-104' : index === 1 ? 't-112' : 't-140' })),
    },
  ],
  synthTemplates: [
    '{user} 在 {date} 的评审记录中确认了 {topic} 需要补充回归测试。',
    '{date} 的每日站会：{user} 同步了 {topic} 的进展与阻塞。',
    '{user} 在 {date} 的代码评审中提出 {topic} 的可读性改进建议。',
  ],
  synthTopics: ['查询分页', '连接池配置', '幂等表清理', '错误码映射', '对账脚本', '日志脱敏'],
};

PROJECTS.push(ORION_PROJECT);

/* ------------------------------------------------------------------ */
/* 中立记忆服务 v5 演示：人（Person）+ 人级 / 分区共享记忆             */
/* ------------------------------------------------------------------ */

/** 人级（scope=person）演示记忆。 */
export interface SeedPersonMemory {
  text: string;
  category: MemoryCategory;
  daysAgo: number;
  importance?: number;
  tags?: string[];
  /** 会话 ID（用于演示人的 sessions 统计） */
  sessionId?: string;
}

/** 演示用的人（记忆主体）。 */
export interface SeedPerson {
  /** 调用方定义的人 ID（App user_id / Agent id） */
  externalId: string;
  type: 'human' | 'agent';
  displayName: string;
  attributes?: Record<string, unknown>;
  status?: 'active' | 'archived';
  /** 该人的私有记忆（scope=person） */
  memories: SeedPersonMemory[];
}

/** 分区共享记忆（scope=partition）。 */
export interface SeedSharedMemory {
  text: string;
  category: MemoryCategory;
  daysAgo: number;
  importance?: number;
  tags?: string[];
  /** 可选：仍可归属某个人（如「客户 X 的合同条款」），但分区内共享 */
  personExternalId?: string;
  /** 可选：写入者（演示 actor 与人不同） */
  actorExternalId?: string;
  sessionId?: string;
}

/** 一个项目的中立人维度演示数据。 */
export interface SeedNeutralDemo {
  persons: SeedPerson[];
  shared: SeedSharedMemory[];
  /** 可选的人级做梦演示：为某人生成一条 person scope 洞见 */
  personDream?: {
    personExternalId: string;
    id: string;
    inputCount: number;
    daysAgo: number;
    summary: string;
    insight: { text: string; title: string; sourceTexts: string[] };
  };
}

/**
 * 两个基准场景：
 * - `aurora-support`：消费类 App 客户（human）+ 礼宾 Agent，CLIENT 私有偏好与分区共享的客服规范；
 * - `orion-python`：研发协作区（human 负责人/工程师 + 测试 Agent），私有草稿与团队发布/评审约定。
 */
export const NEUTRAL_DEMO: Record<string, SeedNeutralDemo> = {
  'aurora-support': {
    persons: [
      {
        externalId: 'cust-8899',
        type: 'human',
        displayName: '许清 · 上海观澜传媒',
        attributes: { tier: 'enterprise', plan: 'Aurora Cloud', seats: 120, source: 'app' },
        memories: [
          {
            text: '许清是上海观澜传媒的客户成功负责人，账号下 120 个坐席，续约决策人。',
            category: 'identity',
            daysAgo: 18,
            importance: 0.82,
            tags: ['身份', '企业版'],
          },
          {
            text: '许清偏好英文界面与周一上午的账单提醒，不接受电话回访。',
            category: 'preference',
            daysAgo: 16,
            importance: 0.74,
            tags: ['联络偏好'],
          },
          {
            text: '许清要求涉及合同的回复必须先经其助理邮箱确认，不得直接对外承诺条款。',
            category: 'constraint',
            daysAgo: 9,
            importance: 0.88,
            tags: ['合规', '合同'],
            sessionId: 'sess_aurora_8899_1016',
          },
          {
            text: '许清在 10 月 16 日反馈批量导出偶发超时，对导出稳定性比较敏感。',
            category: 'event',
            daysAgo: 30,
            importance: 0.66,
            tags: ['导出'],
          },
        ],
      },
      {
        externalId: 'cust-9101',
        type: 'human',
        displayName: '赵铭 · 成都云帆科技',
        attributes: { tier: 'growth', plan: 'Aurora Cloud', source: 'app' },
        memories: [
          {
            text: '赵铭是成都云帆科技的技术负责人，负责 Aurora Cloud 的 API 集成与限流配置。',
            category: 'identity',
            daysAgo: 22,
            importance: 0.8,
            tags: ['技术负责人'],
          },
          {
            text: '赵铭的个人手机号仅用于 P1 事故升级，不得写进工单备注或对外共享。',
            category: 'constraint',
            daysAgo: 15,
            importance: 0.9,
            tags: ['隐私', '升级'],
          },
          {
            text: '赵铭正在评估 Aurora Knowledge 与现有 Confluence 的导入兼容性，预计 12 月前给出结论。',
            category: 'plan',
            daysAgo: 6,
            importance: 0.72,
            tags: ['迁移评估'],
            sessionId: 'sess_aurora_9101_1028',
          },
        ],
      },
      {
        externalId: 'agent-vip-concierge',
        type: 'agent',
        displayName: 'VIP 礼宾 Agent',
        attributes: { model: 'deepseek-chat', scope: 'vip', owner: 'aurora-support' },
        memories: [
          {
            text: '礼宾 Agent 的私有笔记：回复 cust-8899 需附 SLA 与升级路径，回复 cust-9101 需附 API 限流说明。',
            category: 'context',
            daysAgo: 4,
            importance: 0.7,
            tags: ['私有笔记'],
          },
          {
            text: '礼宾 Agent 的私有话术草稿：企业客户先确认续约风险，再给出补偿方案。',
            category: 'preference',
            daysAgo: 5,
            importance: 0.62,
            tags: ['话术'],
          },
        ],
      },
    ],
    shared: [
      {
        text: '客服团队通用约定：P1 工单 30 分钟内首响，P2 四小时内，P3 一个工作日内。',
        category: 'constraint',
        daysAgo: 55,
        importance: 0.9,
        tags: ['SLA'],
      },
      {
        text: '退款承诺类回复必须附带到账时效与工单编号，禁止口头承诺具体金额。',
        category: 'constraint',
        daysAgo: 44,
        importance: 0.86,
        tags: ['合规', '退款'],
        actorExternalId: 'agent-vip-concierge',
      },
      {
        text: 'Aurora Cloud 企业版默认提供 99.9% SLA，未达标部分按季度服务抵扣。',
        category: 'fact',
        daysAgo: 40,
        importance: 0.78,
        tags: ['SLA', '合同'],
      },
    ],
    personDream: {
      personExternalId: 'cust-8899',
      id: 'dream_seed_aurora_cust8899',
      inputCount: 3,
      daysAgo: 7,
      summary: '把许清的偏好与合同约束归纳为礼宾回复要点',
      insight: {
        title: '企业客户回复先对齐合同约束',
        text: '对许清这类企业客户，回复顺序应为：先确认合同与预算约束（合同条款须经助理邮箱确认），再给出导出稳定性与 SLA 说明；账单提醒固定在周一上午，且避免电话回访。',
        sourceTexts: ['许清要求涉及合同的回复必须先经其助理邮箱确认', '许清偏好英文界面与周一上午的账单提醒'],
      },
    },
  },
  'orion-python': {
    persons: [
      {
        externalId: 'dev-linwei',
        type: 'human',
        displayName: '林薇 · 平台负责人',
        attributes: { role: 'platform-owner', team: 'mnemos', email: 'lin.wei@mnemos.dev' },
        memories: [
          {
            text: '林薇的私有笔记：查询服务拆分先只读灰度，观察 3 天指标再切写流量。',
            category: 'plan',
            daysAgo: 2,
            importance: 0.74,
            tags: ['拆分', '灰度'],
            sessionId: 'sess_orion_linwei_1115',
          },
          {
            text: '林薇偏好中文评审意见，并要求附风险等级与回滚方案。',
            category: 'preference',
            daysAgo: 30,
            importance: 0.7,
            tags: ['评审偏好'],
          },
        ],
      },
      {
        externalId: 'dev-zhouye',
        type: 'human',
        displayName: '周野 · 算法工程师',
        attributes: { role: 'engineer', team: 'query', email: 'zhou.ye@mnemos.dev' },
        memories: [
          {
            text: '周野的私有假设：order_id 分片在 618 峰值下可能热点，需要预留预分片方案。',
            category: 'assumption',
            daysAgo: 2,
            importance: 0.72,
            tags: ['分片', '风险'],
          },
          {
            text: '周野熟悉 SQLAlchemy async 与连接池调优，可负责查询服务性能验证。',
            category: 'skill',
            daysAgo: 28,
            importance: 0.68,
            tags: ['技能'],
          },
        ],
      },
      {
        externalId: 'agent-tester',
        type: 'agent',
        displayName: '测试 Agent',
        attributes: { model: 'deepseek-coder', owner: 'orion-python' },
        memories: [
          {
            text: '测试 Agent 私有：订单拆分回归用例在 tests/query_split/，需覆盖跨分片统计与退款单。',
            category: 'plan',
            daysAgo: 3,
            importance: 0.76,
            tags: ['测试', '回归'],
            sessionId: 'sess_orion_tester_1114',
          },
        ],
      },
    ],
    shared: [
      {
        text: '发布窗口约定：工作日 14:00–17:00 可发布，大促前 48 小时冻结发布。',
        category: 'constraint',
        daysAgo: 50,
        importance: 0.88,
        tags: ['发布'],
      },
      {
        text: '代码评审 SLA：PR 提交后 4 小时内首评，超过 24 小时自动升级给负责人。',
        category: 'constraint',
        daysAgo: 36,
        importance: 0.84,
        tags: ['评审', 'SLA'],
      },
      {
        text: '查询服务拆分期间保持双读，主库仍是唯一写入口，切换前必须完成对账脚本。',
        category: 'decision',
        daysAgo: 5,
        importance: 0.86,
        tags: ['拆分', '决策'],
        personExternalId: 'dev-linwei',
      },
      {
        text: '团队共识：所有并发相关缺陷必须补 50 并发压测用例，修复后再合并。',
        category: 'lesson',
        daysAgo: 33,
        importance: 0.8,
        tags: ['并发', '复盘'],
        actorExternalId: 'agent-tester',
      },
    ],
  },
};


/** 演示用 Webhook 订阅（不实际外发：示例域名不可达，用于展示投递日志与状态）。 */
export const DEMO_WEBHOOKS: Record<
  string,
  {
    id: string;
    name: string;
    url: string;
    secret: string;
    eventTypes: string[];
    enabled: boolean;
    description: string;
    createdBy: string;
    daysAgo: number;
    deliveries: {
      eventType: string;
      status: 'success' | 'failed' | 'dead';
      attempts: number;
      responseStatus?: number;
      latencyMs?: number;
      error?: string;
      minutesAgo: number;
    }[];
  }[]
> = {
  'orion-python': [
    {
      id: 'whk_orion_events',
      name: '订单事件 → 内部事件总线',
      url: 'https://events.example.com/hooks/mnemos/orders',
      secret: 'whsec_demo_orion_events_2026',
      eventTypes: ['memory.created', 'memory.updated', 'task.finished'],
      enabled: true,
      description: '把记忆写入与任务完成事件推送到内部事件总线，供看板与告警消费。',
      createdBy: 'usr_chenhao',
      daysAgo: 18,
      deliveries: [
        { eventType: 'memory.created', status: 'success', attempts: 1, responseStatus: 200, latencyMs: 38, minutesAgo: 12 },
        { eventType: 'task.finished', status: 'success', attempts: 1, responseStatus: 200, latencyMs: 52, minutesAgo: 95 },
        { eventType: 'memory.created', status: 'failed', attempts: 2, responseStatus: 503, latencyMs: 301, error: 'upstream 503', minutesAgo: 240 },
        { eventType: 'memory.updated', status: 'success', attempts: 1, responseStatus: 200, latencyMs: 41, minutesAgo: 400 },
        { eventType: 'memory.created', status: 'dead', attempts: 6, responseStatus: 500, latencyMs: 1200, error: '服务持续 5xx，已进入死信', minutesAgo: 960 },
      ],
    },
    {
      id: 'whk_orion_audit',
      name: '合规归档（已暂停）',
      url: 'https://audit.example.com/hooks/mnemos',
      secret: 'whsec_demo_orion_audit_2026',
      eventTypes: ['memory.updated', 'memory.deleted'],
      enabled: false,
      description: '合规要求把记忆变更同步到归档系统；当前暂停等待对方开通白名单。',
      createdBy: 'usr_suyan',
      daysAgo: 30,
      deliveries: [],
    },
  ],
};

export const DEMO_KEYS: Record<
  string,
  {
    id: string;
    name: string;
    secret: string;
    scopes: string[];
    createdBy: string;
    daysAgo: number;
    revokedDaysAgo?: number;
    /** 剩余有效天数（null/undefined = 永不过期） */
    expiresInDays?: number;
    allowedIps?: string[];
  }[]
> = {
  'aurora-support': [
    {
      id: 'key_aurora_console',
      name: '控制台演示密钥',
      secret: 'mnemos_live_demo_aurora_console',
      scopes: ['memories:read', 'memories:write', 'graph:read'],
      createdBy: 'usr_chenhao',
      daysAgo: 40,
    },
    {
      id: 'key_aurora_legacy',
      name: '旧版工单机器人（已吊销）',
      secret: 'mnemos_live_legacy_ticket_bot',
      scopes: ['memories:read', 'memories:write'],
      createdBy: 'usr_linwei',
      daysAgo: 90,
      revokedDaysAgo: 30,
    },
  ],
  'atlas-copilot': [
    {
      id: 'key_atlas_ci',
      name: 'CI 评审机器人',
      secret: 'mnemos_live_demo_atlas_ci',
      scopes: ['memories:read', 'memories:write', 'graph:read', 'admin'],
      createdBy: 'usr_zhouye',
      daysAgo: 25,
      allowedIps: ['10.0.0.0/8', '127.0.0.1'],
    },
  ],
  'helios-knowledge': [
    {
      id: 'key_helios_rag',
      name: 'RAG 检索服务',
      secret: 'mnemos_live_demo_helios_rag',
      scopes: ['memories:read', 'graph:read'],
      createdBy: 'usr_helan',
      daysAgo: 20,
    },
  ],
  'nova-sales': [
    {
      id: 'key_nova_coach',
      name: '陪练应用',
      secret: 'mnemos_live_demo_nova_coach',
      scopes: ['memories:read', 'memories:write'],
      createdBy: 'usr_helan',
      daysAgo: 12,
    },
  ],
  'orbit-internal': [],
  'orion-python': [
    {
      id: 'key_orion_coder',
      name: 'Orion 开发 Agent',
      secret: 'mnemos_live_demo_orion_coder',
      scopes: ['memories:read', 'memories:write', 'graph:read'],
      createdBy: 'usr_chenhao',
      daysAgo: 6,
    },
    {
      id: 'key_orion_console',
      name: '控制台演示密钥',
      secret: 'mnemos_live_demo_orion_python',
      scopes: ['memories:read', 'memories:write', 'graph:read', 'admin'],
      createdBy: 'usr_zhouye',
      daysAgo: 5,
      expiresInDays: 7,
    },
  ],
};
