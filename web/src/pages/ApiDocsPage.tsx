import { useParams } from 'react-router-dom';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { Badge, Callout, Card, CodeBlock, PageHead, SectionHead } from '@ui';
import { fmtInt } from '@lib/format.ts';

interface Endpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  desc: string;
  auth?: string;
}

interface Group {
  id: string;
  title: string;
  desc: string;
  endpoints: Endpoint[];
}

/** v6 API 文档（精简）：只列重建后的分区 / 人 / 记忆端点。 */
export function ApiDocsPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { partition, stats } = usePartitionContext();
  const slug = partition?.slug ?? partitionId;
  const base = `/v1/partitions/${slug}`;
  // 文档示例展示当前控制台地址；SSR/测试环境下回退到本地默认端口。
  const origin = typeof window === 'undefined' ? 'http://127.0.0.1:4380' : window.location.origin;

  const groups: Group[] = [
    {
      id: 'partitions',
      title: '分区',
      desc: '分区（App / 项目 / 租户）是隔离单元；:partition 支持内部 id 或 slug。',
      endpoints: [
        { method: 'POST', path: '/v1/partitions', desc: '创建或幂等 upsert 分区（org key + admin）', auth: 'org key' },
        { method: 'GET', path: `${base}`, desc: '分区信息与 settings（不含敏感字段）' },
        { method: 'GET', path: `${base}/stats`, desc: '分区统计，直接读 partition_stats（O(1)）' },
      ],
    },
    {
      id: 'persons',
      title: '人',
      desc: '人是记忆的主体（human / agent / service / other），不是登录账号。',
      endpoints: [
        { method: 'GET', path: `${base}/persons?cursor&limit&q&type&status&sort`, desc: '人列表：游标分页 + FTS 前缀搜索；sort=recent|new|name' },
        { method: 'PUT', path: `${base}/persons/:externalId`, desc: '按 external id 建档 / 更新人' },
        { method: 'GET', path: `${base}/persons/:person`, desc: ':person 支持内部 id 或 external id' },
        { method: 'PATCH', path: `${base}/persons/:person`, desc: '更新 display_name / attributes / status' },
        { method: 'GET', path: `${base}/persons/:person/memories?cursor&limit&scope&category`, desc: '该人的记忆（游标分页）' },
        { method: 'POST', path: `${base}/persons/:person/memories`, desc: '写入记忆（person 必填；scope 缺省取分区设置）' },
        { method: 'GET', path: `${base}/persons/:person/brief?force&maxChars`, desc: '人级简报（可注入提示词）' },
        { method: 'POST', path: `${base}/persons/:person/context`, desc: '人级上下文：资料 + 简报 + 记忆 + 共享' },
        { method: 'GET', path: `${base}/persons/:person/dream`, desc: '人级做梦状态' },
        { method: 'POST', path: `${base}/persons/:person/dream/run`, desc: '立即为该人做梦（admin）' },
      ],
    },
    {
      id: 'memories',
      title: '记忆',
      desc: '记忆永远属于一个人；scope=person|partition|session 决定可见范围。',
      endpoints: [
        { method: 'GET', path: `${base}/memories?cursor&limit&personId&scope&category&q`, desc: '分区记忆列表（游标 + 过滤 + FTS）' },
        { method: 'GET', path: `${base}/memories/:id`, desc: '记忆详情' },
        { method: 'PATCH', path: `${base}/memories/:id`, desc: '更新内容 / 分类 / 状态 / 标签' },
        { method: 'DELETE', path: `${base}/memories/:id`, desc: '删除记忆（审计留痕）' },
      ],
    },
    {
      id: 'partition-ops',
      title: '分区运营',
      desc: '密钥、用量、审计与分区设置。',
      endpoints: [
        { method: 'GET', path: `${base}/keys`, desc: '分区密钥列表' },
        { method: 'POST', path: `${base}/keys`, desc: '创建分区密钥（secret 仅返回一次）' },
        { method: 'POST', path: `${base}/keys/:id/rotate`, desc: '轮换密钥' },
        { method: 'DELETE', path: `${base}/keys/:id`, desc: '吊销密钥' },
        { method: 'GET', path: `${base}/usage?days=30`, desc: '用量聚合' },
        { method: 'GET', path: `${base}/audit?cursor&limit`, desc: '审计日志（游标分页）' },
        { method: 'GET', path: `${base}/dream`, desc: '分区级做梦状态' },
        { method: 'POST', path: `${base}/dream/run`, desc: '分区级做梦（admin）' },
      ],
    },
  ];

  const curlPerson = `# 列出最近活跃的人（游标分页，limit 默认 50 / 最大 200）
curl "${origin}/v1/partitions/${slug}/persons?limit=50&sort=recent" \\
  -H "Authorization: Bearer $MNEMOS_API_KEY"

# 响应（不返回 total，避免百万行 COUNT；头部统计读 partition_stats）
{
  "items": [
    {
      "id": "prs_...",
      "external_id": "user_42",
      "type": "human",
      "display_name": "张明",
      "memory_count": 128,
      "shared_memory_count": 3,
      "last_seen_at": "2026-11-17T12:00:00.000Z"
    }
  ],
  "next_cursor": "eyJ2IjoiMjAyNi0xMS0xN1Qx...",
  "partition_stats": {
    "persons_total": ${fmtInt(stats?.personsTotal ?? 0)},
    "memories_total": ${fmtInt(stats?.memoriesTotal ?? 0)},
    "shared_total": ${fmtInt(stats?.sharedTotal ?? 0)}
  }
}`;

  const curlMemory = `# 按人写入一条私有记忆
curl -X POST "${origin}/v1/partitions/${slug}/persons/user_42/memories" \\
  -H "Authorization: Bearer $MNEMOS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "偏好深色界面，回复尽量简短",
    "scope": "person",
    "category": "preference"
  }'`;

  const cursorDoc = `// 游标协议：base64(sort_value|id)
// 下一页请求带上上一次响应里的 next_cursor；next_cursor 为 null 表示已到底。
GET ${base}/persons?sort=recent&limit=50
GET ${base}/persons?sort=recent&limit=50&cursor=<next_cursor>`;

  return (
    <div className="page">
      <PageHead
        eyebrow="API 文档"
        title="v6 API"
        desc="中立记忆服务：分区 → 人 → 记忆。公开 v1 路径使用 snake_case；控制台 /api 与之同构（camelCase）。旧 v5 端点（agents / tasks / projects / graph 等）在 v6 已删除。"
        actions={<Badge tone="violet" size="sm">契约 docs/v6-architecture.md</Badge>}
      />

      <div className="doc-layout">
        <nav className="doc-nav" aria-label="文档目录">
          <div className="tiny dim" style={{ padding: '0 10px 6px' }}>端点分组</div>
          {groups.map((group) => (
            <a key={group.id} href={`#${group.id}`} className="doc-nav-item">
              {group.title}
            </a>
          ))}
          <a href="#cursor" className="doc-nav-item">游标分页</a>
          <a href="#errors" className="doc-nav-item">鉴权与错误</a>
        </nav>

        <div className="vstack gap-16" style={{ minWidth: 0 }}>
          <Card pad>
            <SectionHead title="基础信息" desc="所有端点默认在 /v1/partitions/:partition/ 下。" />
            <div className="vstack gap-8 mt-12 small">
              <div><span className="dim">Base URL · </span><span className="mono">{base}</span></div>
              <div><span className="dim">鉴权 · </span><span className="mono">Authorization: Bearer &lt;api_key&gt;</span></div>
              <div><span className="dim">分区参数 · </span>内部 id 或 slug（<span className="mono">{slug}</span>）</div>
              <div><span className="dim">JSON · </span>公开 v1 为 snake_case；控制台 /api 为 camelCase</div>
            </div>
          </Card>

          {groups.map((group) => (
            <Card key={group.id} pad>
              <div id={group.id} style={{ scrollMarginTop: 80 }}>
                <SectionHead title={group.title} desc={group.desc} />
              </div>
              <div className="vstack gap-8 mt-12">
                {group.endpoints.map((endpoint) => (
                  <div className="endpoint" key={`${endpoint.method}-${endpoint.path}`}>
                    <span className={`method method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
                    <span className="mono small" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{endpoint.path}</span>
                    <span className="tiny dim" style={{ marginLeft: 'auto', textAlign: 'right' }}>{endpoint.desc}</span>
                  </div>
                ))}
              </div>
            </Card>
          ))}

          <Card pad>
            <div id="cursor" style={{ scrollMarginTop: 80 }}>
              <SectionHead title="游标分页" desc="人 / 记忆 / 审计列表统一使用游标协议，不返回 total。" />
            </div>
            <div className="mt-12">
              <CodeBlock code={cursorDoc} title="cursor" language="http" />
            </div>
            <Callout tone="slate" icon="info">
              limit 默认 50、最大 200；服务端 keyset：WHERE (sort_value, id) &lt; (?, ?)。
              头部统计读 partition_stats，响应不包含每个人逐条统计。
            </Callout>
          </Card>

          <Card pad>
            <SectionHead title="示例" desc="写入一条记忆，再按人读取简报。" />
            <div className="mt-12">
              <CodeBlock code={curlPerson} title="list persons" language="bash" />
            </div>
            <div className="mt-12">
              <CodeBlock code={curlMemory} title="add memory" language="bash" />
            </div>
          </Card>

          <Card pad>
            <div id="errors" style={{ scrollMarginTop: 80 }}>
              <SectionHead title="鉴权与错误" desc="分区密钥只能访问自身分区；组织密钥（owner）可访问本组织任意分区。" />
            </div>
            <div className="vstack gap-8 mt-12 small">
              <div><span className="mono">401 unauthorized</span> · 密钥缺失或无效</div>
              <div><span className="mono">403 forbidden</span> · 作用域不足或跨分区访问</div>
              <div><span className="mono">404 not_found</span> · 分区 / 人 / 记忆不存在</div>
              <div><span className="mono">409 conflict</span> · 幂等冲突或正在执行做梦</div>
              <div><span className="mono">429 rate_limited</span> · 超过密钥限流</div>
            </div>
            <div className="tiny dim mt-12">
              控制台错误体：<span className="mono">{`{ "error": { "code", "message", "details?", "requestId" } }`}</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
