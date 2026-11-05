/**
 * 规则式抽取用词典（离线、确定性）。
 * 仅被 extract.ts 使用；放在独立文件里便于按语种/领域维护与扩充。
 */

import type { MemoryCategory } from '../../../shared/src/types.ts';

/* ------------------------------------------------------------------ */
/* 人名                                                                */
/* ------------------------------------------------------------------ */

/** 常见中文姓氏（覆盖 80% 以上人口）。 */
export const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'.split('');

/** 称谓（长词在前，避免「总经理」被「经理」抢先匹配）。 */
export const PERSON_TITLES = ['总经理', '董事长', '总监', '总裁', '经理', '主管', '老师', '先生', '女士', '小姐', '博士', '教授', '同学', '医生', '律师', '工程师', '设计师', '研究员', '组长'];

/** 姓氏 + 常见词组合造成的误判。 */
export const NAME_BLACKLIST = new Set([
  '高兴', '早上', '晚上', '马上', '方向', '于是', '石头', '江湖', '毛病', '温度', '严重',
  '万元', '钱包', '严肃', '程序', '白色', '金色', '蓝色', '数据库', '开源', '夏天', '白天',
  '方式', '方法', '方便', '方面', '文章', '文化', '风景', '风险', '方案', '时常', '周末',
  '周围', '张量', '陈述', '何况', '余额', '孙子', '王国', '黄色', '黄金', '叶子', '程度',
]);

/* ------------------------------------------------------------------ */
/* 组织 / 地点                                                         */
/* ------------------------------------------------------------------ */

/** 组织后缀：「技术/行业」后缀也要覆盖，否则「杭州星野零售」这类客户名会漏识别。 */
export const ORG_SUFFIXES = [
  '股份有限公司', '有限责任公司', '有限公司', '集团', '公司', '科技', '教育', '零售', '制药',
  '医疗', '制造', '金融', '保险', '物流', '传媒', '企业', '团队', '部门', '事业部', '实验室',
  '研究院', '研究所', '大学', '学院', '中心', '银行', '医院', '工作室', '委员会', '基金会',
];

export const ORG_PREFIX_BLACKLIST = ['这个', '那个', '一个', '一家', '两家', '整个', '每个', '任何', '有些', '某些', '其他', '部分', '上述', '下列', '相关', '所在', '附近', '周边', '不同', '相同', '该', '本', '贵', '我们', '你们', '他们', '她们', '咱们', '股份有限', '有限', '股份'];

/** 城市 / 国家（无「市」「省」后缀时也能识别）。 */
export const PLACES = new Set([
  '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州', '天津',
  '重庆', '长沙', '郑州', '青岛', '厦门', '大连', '宁波', '无锡', '合肥', '济南', '福州',
  '东莞', '佛山', '香港', '澳门', '台北', '台湾', '新加坡', '东京', '大阪', '京都', '首尔',
  '纽约', '旧金山', '湾区', '西雅图', '波士顿', '伦敦', '巴黎', '柏林', '法兰克福', '慕尼黑',
  '阿姆斯特丹', '苏黎世', '悉尼', '墨尔本', '多伦多', '温哥华', '班加罗尔', '迪拜', '以色列',
  '中国', '美国', '日本', '韩国', '德国', '法国', '英国', '加拿大', '澳大利亚', '印度',
  '荷兰', '瑞士', '瑞典', '挪威', '丹麦', '芬兰', '西班牙', '意大利', '巴西',
]);

/** 行政区/建筑后缀（配合 2~6 个汉字前缀）。 */
export const LOCATION_SUFFIX = '市|省|区|县|路|街|大道|大厦|园区|广场|机场|车站|公园|镇|村';
export const LOCATION_PREFIX_BLACKLIST = ['这个', '那个', '一个', '整个', '每个', '任何', '有些', '某些', '其他', '部分', '上述', '下列', '相关', '负责', '所在', '附近', '周边', '不同', '相同', '地区', '园区', '该', '本'];

/* ------------------------------------------------------------------ */
/* 技术 / 产品                                                         */
/* ------------------------------------------------------------------ */

const TECH_WORDS = [
  'ai', 'api', 'bm25', 'cli', 'css', 'gpt', 'grpc', 'html', 'http', 'https', 'json', 'llm',
  'mcp', 'mem0', 'mnemos', 'oauth', 'rag', 'rest', 'typescript', 'javascript', 'python',
  'java', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'haskell', 'elixir', 'erlang',
  'lua', 'dart', 'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'node', 'deno',
  'bun', 'nestjs', 'django', 'flask', 'fastapi', 'rails', 'laravel', 'vite', 'webpack',
  'rollup', 'esbuild', 'tailwind', 'bootstrap', 'jquery', 'redux', 'zustand', 'graphql',
  'prisma', 'sqlite', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis',
  'elasticsearch', 'clickhouse', 'duckdb', 'kafka', 'rabbitmq', 'nats', 'minio', 's3',
  'spark', 'flink', 'airflow', 'dbt', 'snowflake', 'bigquery', 'redshift', 'docker',
  'kubernetes', 'k8s', 'helm', 'terraform', 'ansible', 'nginx', 'linux', 'macos', 'windows',
  'ubuntu', 'debian', 'aws', 'gcp', 'azure', 'aliyun', 'github', 'gitlab', 'git', 'jenkins',
  'prometheus', 'grafana', 'sentry', 'datadog', 'openai', 'anthropic', 'claude', 'deepseek',
  'qwen', 'llama', 'mistral', 'gemini', 'langchain', 'llamaindex', 'huggingface', 'pytorch',
  'tensorflow', 'numpy', 'pandas', 'sklearn', 'embedding', 'vector', 'faiss', 'milvus',
  'qdrant', 'pinecone', 'chroma', 'weaviate', 'figma', 'notion', 'slack', 'jira',
  'confluence', 'vscode', 'jetbrains', 'vercel', 'netlify', 'cloudflare', 'supabase',
  'firebase', 'node.js', 'mysql', 'ollama', 'vllm', 'tika',
];

/** 展示用标准写法（键为小写）。 */
const TECH_DISPLAY: Record<string, string> = {
  ai: 'AI', api: 'API', bm25: 'BM25', cli: 'CLI', css: 'CSS', gpt: 'GPT', grpc: 'gRPC',
  html: 'HTML', http: 'HTTP', https: 'HTTPS', json: 'JSON', llm: 'LLM', mcp: 'MCP',
  mem0: 'mem0', mnemos: 'Mnemos', oauth: 'OAuth', rag: 'RAG', rest: 'REST',
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java',
  rust: 'Rust', ruby: 'Ruby', php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', scala: 'Scala',
  react: 'React', vue: 'Vue', angular: 'Angular', svelte: 'Svelte', nextjs: 'Next.js',
  node: 'Node', 'node.js': 'Node.js', deno: 'Deno', bun: 'Bun', nestjs: 'NestJS',
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', vite: 'Vite', webpack: 'Webpack',
  graphql: 'GraphQL', sqlite: 'SQLite', postgres: 'PostgreSQL', postgresql: 'PostgreSQL',
  mysql: 'MySQL', mongodb: 'MongoDB', redis: 'Redis', kafka: 'Kafka', docker: 'Docker',
  kubernetes: 'Kubernetes', k8s: 'K8s', terraform: 'Terraform', nginx: 'Nginx',
  linux: 'Linux', macos: 'macOS', windows: 'Windows', aws: 'AWS', gcp: 'GCP',
  azure: 'Azure', github: 'GitHub', gitlab: 'GitLab', git: 'Git', openai: 'OpenAI',
  claude: 'Claude', deepseek: 'DeepSeek', qwen: 'Qwen', llama: 'Llama', gemini: 'Gemini',
  huggingface: 'HuggingFace', pytorch: 'PyTorch', tensorflow: 'TensorFlow',
  numpy: 'NumPy', pandas: 'Pandas', embedding: 'embedding', faiss: 'Faiss',
  milvus: 'Milvus', qdrant: 'Qdrant', pinecone: 'Pinecone', weaviate: 'Weaviate',
  figma: 'Figma', notion: 'Notion', slack: 'Slack', jira: 'Jira', vscode: 'VS Code',
  vercel: 'Vercel', supabase: 'Supabase', firebase: 'Firebase', ollama: 'Ollama',
  vllm: 'vLLM',
};

/** 技术词表：小写写法 → 展示写法。 */
export const TECH_TERMS: Record<string, string> = Object.fromEntries(
  TECH_WORDS.map((word) => [word, TECH_DISPLAY[word] ?? word]),
);

/** 英文专名过滤：非专名的常见词。 */
export const ENGLISH_COMMON = new Set([
  'the', 'this', 'that', 'these', 'those', 'i', 'we', 'you', 'he', 'she', 'it', 'they',
  'a', 'an', 'and', 'but', 'or', 'if', 'then', 'so', 'yes', 'no', 'ok', 'okay', 'please',
  'thanks', 'thank', 'hello', 'hi', 'hey', 'note', 'also', 'however', 'because', 'what',
  'when', 'where', 'why', 'how', 'which', 'who', 'can', 'could', 'should', 'would', 'will',
  'may', 'might', 'must', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does',
  'did', 'have', 'has', 'had', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'of',
  'as', 'not', 'now', 'here', 'there', 'all', 'any', 'some', 'more', 'most', 'other',
  'such', 'only', 'own', 'same', 'just', 'very', 'too', 'also', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'user', 'assistant', 'system', 'api', 'http', 'https', 'www', 'com', 'app', 'id', 'ai',
  'please', 'note', 'sorry', 'great', 'good', 'best', 'new', 'old', 'read', 'write', 'run',
]);

/* ------------------------------------------------------------------ */
/* 时间                                                                */
/* ------------------------------------------------------------------ */

/** 时间表达式（正则源码，编译于 extract.ts）。 */
export const TIME_PATTERNS: string[] = [
  '\\d{4}\\s*[-/年]\\s*\\d{1,2}\\s*[-/月]\\s*\\d{1,2}\\s*日?',
  '\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日',
  '\\d{1,2}\\s*[:：]\\s*\\d{2}',
  '(?:今天|明天|后天|昨天|前天|本周|这周|上周|下周|本月|这个月|下个月|上个月|本季度|上季度|下季度|今年|明年|去年|最近|刚才|月底|月初|年底|周[一二三四五六日天]|星期[一二三四五六日天])',
  '\\d+\\s*(?:个)?(?:小时|分钟|天|周|星期|个月|年)(?:前|后|内|以后|以前)',
  '(?:上午|下午|中午|晚上|凌晨|早上)\\s*\\d{1,2}\\s*点(?:半|\\d{1,2}分)?',
];

/* ------------------------------------------------------------------ */
/* 分类 / 打分                                                         */
/* ------------------------------------------------------------------ */

/** 分类词典（不含 fact：fact 是兜底类）。 */
export const CATEGORY_LEXICON: Record<Exclude<MemoryCategory, 'fact'>, string[]> = {
  preference: ['喜欢', '偏好', '偏爱', '讨厌', '不喜欢', '爱用', '习惯用', '更愿意', '倾向于', '最喜欢', 'prefer', 'favorite', 'dislike', 'love'],
  identity: ['我叫', '我是', '我的名字', '名字叫', '姓名', '身份', '职位', '担任', '出生于', '来自', 'my name', 'i am', 'job title'],
  plan: ['计划', '打算', '准备', '将要', '即将', '下一步', '目标', '预计', '待办', '截止', 'todo', 'plan to', 'going to', 'deadline'],
  relationship: ['朋友', '同事', '领导', '老板', '团队', '搭档', '合作', '汇报', '下属', '上级', '配偶', '妻子', '丈夫', '父亲', '母亲', '儿子', '女儿', '导师', 'colleague', 'manager', 'works with'],
  event: ['会议', '讨论', '发布', '上线', '参加', '举行', '发生', '昨天', '上周', '本周', '完成', '拜访', '演讲', '培训', 'meeting', 'launched', 'released'],
  skill: ['熟悉', '精通', '擅长', '掌握', '熟练', '经验', '技能', '会写', '开发', '编程', '搭建', '实现', 'skilled', 'experienced', 'familiar', 'expert'],
  constraint: ['必须', '不要', '禁止', '不能', '只能', '务必', '限制', '要求', '避免', '不允许', '切记', 'must', 'never', 'avoid', 'required'],
  context: ['当前', '目前', '现在', '正在', '本次', '这个项目', '本项目', '这次', '当下', 'currently', 'ongoing', 'this project'],
};

/** 分类平局时的优先级（越靠前越优先）。 */
export const CATEGORY_PRIORITY: MemoryCategory[] = [
  'constraint', 'preference', 'identity', 'relationship', 'plan', 'skill', 'event', 'context', 'fact',
];

/** 各分类的基础重要度。 */
export const IMPORTANCE_BASE: Record<MemoryCategory, number> = {
  preference: 0.68,
  identity: 0.74,
  fact: 0.52,
  plan: 0.6,
  relationship: 0.58,
  event: 0.5,
  skill: 0.62,
  constraint: 0.8,
  context: 0.38,
};

/** 强调词 → 提高重要度。 */
export const EMPHASIS_RE = /(重要|务必|一定要|必须|切记|记住|永远|始终|从不|坚决|critical|important|always|never|must|remember)/i;
/** 模糊限定词 → 降低置信度。 */
export const HEDGE_RE = /(可能|也许|大概|好像|似乎|或许|差不多|不一定|听说|maybe|probably|perhaps|might|approximately|roughly)/i;
/** 确定语气 → 提高置信度。 */
export const ASSERTIVE_RE = /(一定|肯定|确定|绝对|确实|毫无疑问|definitely|certainly|absolutely)/i;

/* ------------------------------------------------------------------ */
/* 噪声过滤                                                            */
/* ------------------------------------------------------------------ */

/** 纯寒暄/应答句。 */
export const GREETING_RE = /^(你好|您好|你们好|大家好|嗨|哈喽|早安|早上好|中午好|下午好|晚上好|晚安|谢谢|多谢|感谢|辛苦了|不客气|再见|拜拜|回头聊|好的|好吧|好|行|可以|嗯+|哦+|收到|明白|了解|知道了|没问题|ok|okay|hi|hello|hey|thanks|thank you|bye|good morning|good night|good evening|sure|got it|no problem)(呀|啊|哦|呢|哈|啦|了|的)?[\s!！。.,，~～…]*$/i;

/** 助手消息里的客套/引导语开头（这类句子通常没有事实价值）。 */
export const ASSISTANT_FILLER_RE = /^(当然|好的|可以|没问题|明白了|以下是|如下|建议|需要我|如果你|如需|希望|祝|请|让我|我会|我可以|已经为你|根据你|为了|首先|其次|另外|总结|总的来说|是的|这个|其实|简单来说|换句话说|不过|所以)/;

/* ------------------------------------------------------------------ */
/* 关系                                                                */
/* ------------------------------------------------------------------ */

/** 动词模式 → 关系标签（按顺序匹配，先具体后宽泛）。 */
export const RELATION_PATTERNS: { relation: string; pattern: RegExp; weight: number }[] = [
  { relation: '使用', pattern: /(使用|用了|采用|基于|依赖|借助|using|uses|used|based on|built with)/i, weight: 0.9 },
  { relation: '负责', pattern: /(负责|主管|主导|管理|带领|owner|leads|leading|manages|in charge)/i, weight: 0.9 },
  { relation: '属于', pattern: /(属于|隶属|归属|belongs to|part of)/i, weight: 0.85 },
  { relation: '任职于', pattern: /(任职|就职|工作于|供职|加入|现任|works at|works for|joined|employed by)/i, weight: 0.9 },
  { relation: '偏好', pattern: /(喜欢|偏好|偏爱|倾向|爱用|prefers|preferred|likes|favor)/i, weight: 0.85 },
];

/** 关系兜底标签。 */
export const RELATION_FALLBACK = '相关';
export const RELATION_FALLBACK_WEIGHT = 0.5;

/** 实体类型 → 基础显著度。 */
export const ENTITY_SALIENCE: Record<string, number> = {
  person: 0.85,
  organization: 0.75,
  product: 0.65,
  technology: 0.65,
  location: 0.55,
  time: 0.45,
  concept: 0.5,
};
