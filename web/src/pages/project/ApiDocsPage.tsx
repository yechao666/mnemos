import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SCOPES } from '@shared';
import { useProjectContext } from '@lib/project-context.tsx';
import {
  Badge,
  Callout,
  Card,
  CodeBlock,
  PageHead,
  Segmented,
  Table,
  type Column,
} from '@ui';
import {
  DocParamTable,
  Endpoint,
  TableScroller,
  type DocParam,
} from '../../components/project-ops/common.tsx';
import {
  addSample,
  authSample,
  briefSample,
  dreamSample,
  graphSample,
  manageSample,
  quickstartSample,
  searchSample,
  statsSample,
  type DocLang,
} from '../../components/project-ops/docs/samples.ts';

const LANG_OPTIONS: { value: DocLang; label: string }[] = [
  { value: 'curl', label: 'curl' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
];

const CODE_LABEL: Record<DocLang, string> = {
  curl: 'bash',
  typescript: 'typescript',
  python: 'python',
};

const DOC_NAV = [
  { id: 'quickstart', label: '快速开始' },
  { id: 'auth', label: '认证与作用域' },
  { id: 'write', label: '记忆写入' },
  { id: 'search', label: '记忆检索' },
  { id: 'agent', label: 'Agent 原生接入' },
  { id: 'brief-dream', label: '记忆简报与复盘总结' },
  { id: 'manage', label: '记忆管理' },
  { id: 'graph', label: '图谱与统计' },
  { id: 'errors', label: '错误码' },
];

const ERROR_EXAMPLE = `{
  "error": {
    "code": "insufficient_scope",
    "message": "API Key 缺少 memories:write 作用域",
    "details": {
      "required": ["memories:write"],
      "granted": ["memories:read"]
    }
  }
}`;

interface ErrorCodeRow {
  status: string;
  code: string;
  desc: string;
  advice: string;
}

const ERROR_CODES: ErrorCodeRow[] = [
  { status: '401', code: 'unauthorized', desc: '缺少或无效的 API Key', advice: '检查 Authorization 请求头与密钥是否已吊销。' },
  { status: '403', code: 'forbidden', desc: '作用域不足、项目已暂停或无访问权限', advice: '核对 Key 作用域、项目状态与成员权限。' },
  { status: '404', code: 'not_found', desc: '记忆或资源不存在', advice: '确认资源 ID 属于当前项目且未被删除。' },
  { status: '409', code: 'conflict', desc: '写入冲突或去重过程中的并发冲突', advice: '重新读取最新记忆后重试，避免并行修改同一条记忆。' },
  { status: '422', code: 'validation_error', desc: '参数校验失败', advice: '检查 snake_case 字段名、类型与取值范围。' },
  { status: '429', code: 'rate_limited', desc: '超出密钥限流或月度注入配额', advice: '按 Retry-After 指数退避；必要时提升限流或配额。' },
];

export function ApiDocsPage() {
  const { project } = useProjectContext();
  const projectId = project?.id ?? '{project_id}';
  const [lang, setLang] = useState<DocLang>('curl');
  const [active, setActive] = useState('quickstart');

  const baseUrl = useMemo(
    () => (typeof window === 'undefined' ? 'https://console.mnemos.dev' : window.location.origin),
    [],
  );

  useEffect(() => {
    const elements = DOC_NAV.map((item) => document.getElementById(item.id)).filter(
      (element): element is HTMLElement => Boolean(element),
    );
    if (!elements.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: [0, 1] },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const addParams: DocParam[] = [
    { name: 'messages', type: 'ChatMessage[]', desc: '对话消息数组，与 text 二选一。role 支持 user / assistant / system / tool。' },
    { name: 'text', type: 'string', desc: '纯文本输入，与 messages 二选一；适合导入已有文案或笔记。' },
    { name: 'project_id', type: 'string', desc: `目标项目；使用项目级 API Key 时可省略。当前项目：${projectId}。` },
    { name: 'user_id', type: 'string', desc: '记忆归属的用户标识；检索时可用同一标识过滤。' },
    { name: 'agent_id', type: 'string', desc: '记忆归属的智能体标识。' },
    { name: 'run_id', type: 'string', desc: '一次运行 / 会话的标识，用于隔离临时上下文。' },
    { name: 'app_id', type: 'string', desc: '接入应用的标识，适合多应用共享项目时区分来源。' },
    { name: 'metadata', type: 'object', desc: '自定义键值对，原样保存并随记忆返回。' },
    { name: 'tags', type: 'string[]', desc: '标签列表，可参与检索过滤。' },
    { name: 'infer', type: 'boolean', desc: '是否由服务端自动抽取事实与关系，默认 true。' },
    { name: 'mode', type: "'additive' | 'consolidate'", desc: '抽取模式；缺省时使用项目设置中的默认值。' },
  ];

  const searchParams: DocParam[] = [
    { name: 'query', type: 'string', required: true, desc: '自然语言查询；支持中文，无需预分词。' },
    { name: 'project_id', type: 'string', desc: '目标项目；使用项目级 API Key 时可省略。' },
    { name: 'user_id', type: 'string', desc: '只检索指定用户范围内的记忆。' },
    { name: 'agent_id', type: 'string', desc: '只检索指定智能体范围内的记忆。' },
    { name: 'run_id', type: 'string', desc: '只检索指定运行范围内的记忆。' },
    { name: 'top_k', type: 'number', desc: '返回条数，1–20；缺省时使用项目设置中的默认 topK。' },
    { name: 'threshold', type: 'number', desc: '最低相关性分数，0–1；低于阈值的结果会被过滤。' },
    {
      name: 'filters',
      type: 'object',
      desc: (
        <span>
          过滤条件：<span className="mono">status</span>、<span className="mono">category</span>、
          <span className="mono">tags</span>、<span className="mono">created_after</span>、
          <span className="mono">created_before</span>、<span className="mono">min_importance</span>、
          <span className="mono">metadata</span>。
        </span>
      ),
    },
  ];

  const briefParams: DocParam[] = [
    {
      name: 'agentId',
      type: 'string',
      desc: '不传 = 审计全量视角（含所有 Agent 私有）；传 = 该 Agent 视角（项目共享 + 其私有，排除其他 Agent 私有）。',
    },
    { name: 'maxChars', type: 'number', desc: '临时覆盖项目 briefMaxChars，100–5000；不落库。' },
    { name: 'force', type: 'boolean', desc: 'true / 1 跳过缓存重新生成。' },
  ];

  const scopeRows = SCOPES.map((scope) => ({
    value: scope.value,
    label: scope.label,
    desc: scope.desc,
  }));

  const scopeColumns: Column<(typeof scopeRows)[number]>[] = [
    {
      key: 'value',
      header: '作用域',
      width: 180,
      render: (row) => <span className="mono">{row.value}</span>,
    },
    {
      key: 'label',
      header: '权限',
      width: 110,
      render: (row) => <span className="small soft">{row.label}</span>,
    },
    {
      key: 'desc',
      header: '说明',
      render: (row) => <span className="small muted">{row.desc}</span>,
    },
  ];

  const errorColumns: Column<ErrorCodeRow>[] = [
    {
      key: 'status',
      header: 'HTTP',
      width: 70,
      render: (row) => (
        <Badge tone={row.status === '429' || row.status === '401' ? 'red' : row.status === '403' ? 'amber' : 'slate'} size="sm">
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'code',
      header: '错误码',
      width: 170,
      mono: true,
      render: (row) => <span className="mono tiny">{row.code}</span>,
    },
    {
      key: 'desc',
      header: '含义',
      width: 250,
      render: (row) => <span className="small muted">{row.desc}</span>,
    },
    {
      key: 'advice',
      header: '处理建议',
      render: (row) => <span className="tiny dim">{row.advice}</span>,
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · 开发"
        title="API 文档"
        desc="通过 REST API 接入 Mnemos：写入记忆、混合检索、管理记忆与读取图谱。"
        actions={<Segmented<DocLang> options={LANG_OPTIONS} value={lang} onChange={setLang} />}
      />

      <Callout tone="cyan" icon="key">
        <div className="hstack gap-8 wrap">
          <span>调用前请到</span>
          <Link to="../keys" className="strong" style={{ color: 'var(--cyan)' }}>
            「密钥」页面
          </Link>
          <span>创建或轮换 API Key，并按最小作用域原则授权。示例中的项目 ID 为</span>
          <span className="code-inline">{projectId}</span>。
        </div>
      </Callout>

      <div className="doc-layout">
        <aside className="doc-nav" aria-label="文档目录">
          {DOC_NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={`doc-nav-item ${active === item.id ? 'active' : ''}`}
              onClick={() => setActive(item.id)}
            >
              {item.label}
            </a>
          ))}
        </aside>

        <div className="vstack gap-20">
          <section id="quickstart" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">快速开始</div>
                  <p className="doc-p">
                    Mnemos 提供与语言无关的 REST API，所有请求使用 JSON。base URL 为
                    <span className="code-inline">{baseUrl}</span>
                    ，当前项目 ID 为
                    <span className="code-inline">{projectId}</span>。
                  </p>
                </div>

                <Endpoint method="GET" path={`${baseUrl}/api/health`} note="健康检查，无需认证" />

                <div className="doc-h3">三步接入</div>
                <div className="vstack gap-10">
                  <div className="hstack gap-10">
                    <span className="kbd">1</span>
                    <span className="small muted">
                      创建 API Key，并写入环境变量 <span className="code-inline">MNEMOS_API_KEY</span>。
                    </span>
                  </div>
                  <div className="hstack gap-10">
                    <span className="kbd">2</span>
                    <span className="small muted">
                      调用 <span className="code-inline">POST /v1/memories</span> 写入对话或文本。
                    </span>
                  </div>
                  <div className="hstack gap-10">
                    <span className="kbd">3</span>
                    <span className="small muted">
                      调用 <span className="code-inline">POST /v1/memories/search</span>，把结果注入模型上下文。
                    </span>
                  </div>
                </div>

                <CodeBlock
                  code={quickstartSample(baseUrl, lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 初始化与健康检查`}
                />
              </div>
            </Card>
          </section>

          <section id="auth" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">认证与作用域</div>
                  <p className="doc-p">
                    所有 <span className="code-inline">/v1</span> 请求都需要在
                    <span className="code-inline">Authorization</span> 头中携带 Bearer API Key。密钥仅能访问所属项目，作用域决定可执行的操作。
                  </p>
                </div>

                <Endpoint method="GET" path="/v1/stats" note="任意受保护接口都需要认证" />
                <CodeBlock
                  code={authSample(lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · Bearer 认证`}
                />

                <div className="doc-h3">作用域说明</div>
                <TableScroller minWidth={620}>
                  <Table
                    columns={scopeColumns}
                    rows={scopeRows}
                    rowKey={(row) => row.value}
                  />
                </TableScroller>

                <div className="doc-h3">认证失败响应</div>
                <p className="doc-p">
                  失败时返回非 2xx 状态码，响应体统一为 <span className="mono">error</span> 对象。以下为缺少写入作用域的示例：
                </p>
                <CodeBlock code={ERROR_EXAMPLE} language="json" title="403 · insufficient_scope" />
              </div>
            </Card>
          </section>

          <section id="write" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">记忆写入</div>
                  <p className="doc-p">
                    传入对话消息或纯文本，服务端按项目的抽取模式生成记忆；返回本次新增、合并与跳过的结果。
                  </p>
                </div>

                <Endpoint method="POST" path="/v1/memories" note="写入记忆，参数使用 snake_case" />
                <DocParamTable items={addParams} />

                <Callout tone="violet" icon="info">
                  写入是幂等友好的：<span className="mono">additive</span> 模式保留全部输入，
                  <span className="mono">consolidate</span> 模式会合并相似记忆。可通过
                  <span className="code-inline">infer: false</span> 跳过自动抽取。
                </Callout>

                <div className="doc-h3">示例</div>
                <CodeBlock
                  code={addSample(baseUrl, projectId, lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 写入记忆`}
                />
              </div>
            </Card>
          </section>

          <section id="search" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">记忆检索</div>
                  <p className="doc-p">
                    检索是混合式的：语义向量、关键词 BM25、实体命中、时效性与重要度共同决定排序，最终按项目权重融合。
                  </p>
                </div>

                <Endpoint method="POST" path="/v1/memories/search" note="混合检索，参数使用 snake_case" />
                <DocParamTable items={searchParams} />

                <Callout tone="violet" icon="info">
                  默认 topK、召回阈值与四维权重来自项目设置；可在
                  <Link to="../settings" className="strong" style={{ color: 'var(--violet)' }}>
                    「项目设置」
                  </Link>
                  中调整。提高 <span className="code-inline">semantic</span> 权重偏向语义相近，
                  提高 <span className="code-inline">keyword</span> 权重偏向字面命中。
                </Callout>

                <div className="doc-h3">示例</div>
                <CodeBlock
                  code={searchSample(baseUrl, projectId, lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 检索记忆`}
                />
              </div>
            </Card>
          </section>

          <section id="agent" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">Agent 原生接入</div>
                  <p className="doc-p">
                    推荐路径：Agent 启动任务时先拉「任务简报」，把项目里其他 Agent 留下的规范、决策与事故经验注入提示词；
                    任务结束时把决策与教训写回项目共享记忆，供下一个 Agent（或下周的自己）复用。
                  </p>
                </div>

                <Endpoint method="POST" path="/v1/agents" note="注册 Agent：名称、角色、模型、能力标签" />
                <Endpoint method="POST" path="/v1/tasks" note="开始任务：标题、目标、owner_agent_id、分支" />
                <Endpoint method="POST" path="/v1/context" note="拉取任务简报，返回分 section 的记忆与可注入 prompt" />
                <Endpoint method="POST" path="/v1/tasks/{id}/finish" note="结束任务并沉淀 decisions / lessons" />

                <Callout tone="cyan" icon="shield">
                  可见性三档：<span className="code-inline">project</span>（默认，项目共享）、
                  <span className="code-inline">agent</span>（仅写入它的 Agent）、
                  <span className="code-inline">task</span>（仅当前任务）。
                  控制台默认以审计视角可以看到全部私有记忆。
                </Callout>

                <div className="doc-h3">示例：开始任务 → 拉简报 → 结束并沉淀</div>
                <CodeBlock
                  language="bash"
                  title="bash · Agent 原生流程"
                  code={`BASE="${baseUrl}"
KEY="$MNEMOS_API_KEY"

# 1) 开始任务
TASK=$(curl -s -X POST "$BASE/v1/tasks" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"title":"拆分订单查询服务","goal":"大促 P99 < 300ms","owner_agent_id":"agent-coder","branch":"feat/query-service"}' \
  | jq -r '.task.id')

# 2) 拉取任务简报（可直接拼进 system prompt）
curl -s -X POST "$BASE/v1/context" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"agent_id\":\"agent-coder\",\"task_id\":\"$TASK\",\"budget_tokens\":1200}"

# 3) 结束任务：决策与教训自动写入项目共享记忆
curl -s -X POST "$BASE/v1/tasks/$TASK/finish" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"summary":"查询服务拆分首期完成","decisions":["查询走 read replica，按 order_id 分片"],"lessons":["拆分前补齐双写对账"],"agent_id":"agent-coder"}'

# 4) 只有自己可读的草稿
curl -s -X POST "$BASE/v1/memories" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"text\":\"私有草稿：跨分片统计走离线汇总\",\"agent_id\":\"agent-coder\",\"task_id\":\"$TASK\",\"visibility\":\"agent\"}"`}
                />
              </div>
            </Card>
          </section>

          <section id="brief-dream" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">记忆简报与复盘总结</div>
                  <p className="doc-p">
                    记忆简报把最近的项目共享记忆压成有字符上限、可直接注入 system prompt 的文本；
                    记忆复盘总结增量巩固尚未整理的新记忆，产出 <span className="code-inline">category=insight</span>、
                    <span className="code-inline">source=dream</span> 的项目共享洞见。两者都通过控制台接口管理。
                  </p>
                </div>

                <div className="vstack gap-8">
                  <Endpoint method="GET" path="/api/projects/{id}/memory/brief" note="读取简报；agentId / maxChars / force 可选" />
                  <Endpoint method="PATCH" path="/api/projects/{id}/memory/brief" note="更新字符上限（100–5000）并重新生成" />
                  <Endpoint method="GET" path="/api/projects/{id}/memory/dream" note="设置、待整理数、最近 10 次运行" />
                  <Endpoint method="PATCH" path="/api/projects/{id}/memory/dream" note="enabled / intervalMinutes（至少一个）" />
                  <Endpoint method="POST" path="/api/projects/{id}/memory/dream/run" note="手动触发；运行中返回 409" />
                </div>

                <Callout tone="amber" icon="key">
                  <span className="mono">/api</span> 控制台接口需要登录后的会话令牌（<span className="code-inline">MNEMOS_SESSION_TOKEN</span>），
                  不是 <span className="mono">mnemos_live_*</span> API Key。
                </Callout>

                <div className="doc-h3">读取简报参数</div>
                <DocParamTable items={briefParams} />

                <div className="doc-h3">示例：读取 / 更新简报</div>
                <CodeBlock
                  code={briefSample(baseUrl, projectId, lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 记忆简报`}
                />

                <div className="doc-h3">示例：查看状态 / 配置 / 手动复盘总结</div>
                <CodeBlock
                  code={dreamSample(baseUrl, projectId, lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 记忆复盘总结`}
                />

                <Callout tone="cyan" icon="shield">
                  复盘总结只巩固 <span className="mono">visibility='project'</span> 的项目共享记忆；Agent 私有与任务记忆不参与，
                  不会被写进项目洞见。洞见固定 <span className="mono">visibility='project'</span>，并通过
                  <span className="mono"> metadata.dreamRunId / sourceMemoryIds</span> 保留来源。
                </Callout>
              </div>
            </Card>
          </section>

          <section id="manage" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">记忆管理</div>
                  <p className="doc-p">
                    支持读取单条、更新内容 / 分类 / 重要度、删除单条，以及批量删除。批量删除必须显式传入
                    <span className="code-inline">confirm: true</span>，防止误操作。
                  </p>
                </div>

                <div className="vstack gap-8">
                  <Endpoint method="GET" path="/v1/memories/{id}" note="读取单条记忆与历史" />
                  <Endpoint method="PUT" path="/v1/memories/{id}" note="更新内容、分类、重要度" />
                  <Endpoint method="DELETE" path="/v1/memories/{id}" note="删除单条记忆" />
                  <Endpoint method="POST" path="/v1/memories/batch" note="批量删除需 confirm: true" />
                </div>

                <Callout tone="amber" icon="alert">
                  删除操作默认软删除：记录进入 <span className="mono">deleted</span> 状态，并写入审计日志；后续可由保留策略清理。
                </Callout>

                <div className="doc-h3">示例</div>
                <CodeBlock
                  code={manageSample(lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 读取 / 更新 / 删除`}
                />
              </div>
            </Card>
          </section>

          <section id="graph" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">图谱与统计</div>
                  <p className="doc-p">
                    图谱接口返回实体节点与关系边，用于可视化与实体检索；统计接口返回项目级记忆、检索、延迟与配额指标。
                  </p>
                </div>

                <div className="vstack gap-8">
                  <Endpoint method="GET" path="/v1/graph" note="支持 limit，默认 120" />
                  <Endpoint method="GET" path="/v1/stats" note="项目级统计" />
                </div>

                <div className="doc-h3">图谱查询</div>
                <CodeBlock
                  code={graphSample(lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 读取图谱`}
                />

                <div className="doc-h3">项目统计</div>
                <CodeBlock
                  code={statsSample(lang)}
                  language={CODE_LABEL[lang]}
                  title={`${CODE_LABEL[lang]} · 读取统计`}
                />
              </div>
            </Card>
          </section>

          <section id="errors" className="doc-section">
            <Card pad>
              <div className="vstack gap-16">
                <div>
                  <div className="doc-h2">错误码</div>
                  <p className="doc-p">
                    所有错误响应都包含机器可读的 <span className="mono">code</span> 与中文
                    <span className="mono">message</span>。遇到 429 时请按
                    <span className="code-inline">Retry-After</span> 指数退避重试。
                  </p>
                </div>

                <TableScroller minWidth={720}>
                  <Table columns={errorColumns} rows={ERROR_CODES} rowKey={(row) => row.status} />
                </TableScroller>

                <Callout tone="violet" icon="info">
                  写入与检索均为网络调用，建议客户端设置 10 秒超时，并对 429 / 5xx 使用带抖动的指数退避。4xx 通常不应自动重试。
                </Callout>
              </div>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
