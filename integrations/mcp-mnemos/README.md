# `mnemos-mcp` — Mnemos v6.1 MCP server

把 **Mnemos 记忆服务**接入任意 MCP 客户端（DeepSeek Harness / Claude Desktop 等）。
纯 Node **零依赖**，stdio 传输、按行分隔 JSON-RPC 2.0，不依赖 MCP SDK。

- 工具：`mnemos_search` / `mnemos_add` / `mnemos_brief` / `mnemos_context` /
  `mnemos_person` / `mnemos_profile`（P1，可选）/ `mnemos_status`；
- 资源：分区统计、人的简报、人的画像；
- 协议：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、
  `resources/list`、`resources/read`；
- 工具失败返回 `{content, isError: true}`（不抛进程崩溃）；协议错误返回 JSON-RPC error；
- stdout 只写 JSON-RPC，日志走 stderr。

> 契约：Mnemos v6.1 公开 `/v1` API（`snake_case`，API Key 鉴权，游标分页）。
> 本 server 不做事实抽取、不缓存记忆，只是 API 的薄封装。

---

## 1. 运行

要求 **Node ≥ 18.17**（使用全局 `fetch`），无需 `npm install`、无需构建：

```bash
MNEMOS_BASE_URL=http://127.0.0.1:4380 \
MNEMOS_API_KEY=mnemos_live_… \
MNEMOS_PARTITION=ws-demo \
MNEMOS_PERSON=dsh-agent \
node src/index.js
```

进程从 stdin 读 JSON-RPC（每行一条），向 stdout 写响应。可直接手工冒烟：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/index.js
```

## 2. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MNEMOS_BASE_URL` | `http://127.0.0.1:4380` | Mnemos 地址（不带尾斜杠） |
| `MNEMOS_API_KEY` | 空 | `mnemos_live_…` API Key；读写需要 |
| `MNEMOS_PARTITION` | 空 | 默认分区（内部 id 或 slug）；除 `mnemos_status` 外多数工具必需 |
| `MNEMOS_PERSON` | `dsh-agent` | 默认人 external_id |
| `MNEMOS_TIMEOUT_MS` | `30000` | 单请求超时（毫秒） |

工具参数里的 `partition` / `person` 可覆盖默认值。

## 3. 工具

### `mnemos_search`

混合检索（默认 `hybrid`：关键词 + 向量 + 时效 + 重要度），返回带 `score`、`signals`
（`vector/keyword/recency/importance/entity`）与 `matched_on` 的命中。

```json
{"query": "评审偏好", "top_k": 5, "mode": "hybrid", "scope": "partition"}
```

- 默认按 `MNEMOS_PERSON` 过滤；`all_people: true` 时不按人过滤（分区范围）。
- 其他参数：`category`、`as_of`（P1 时序）、`include_superseded`、`partition`。

### `mnemos_add`

写入一条记忆（原文入库）；返回 `{memory, event, superseded_id}`：

- 完全重复 → `NOOP`（不新增）；相似内容 → `MERGE`；
- `supersedes_id` 或同 `fact_key` → 旧记忆 `valid_to=now`（`SUPERSEDE`）；
- 未知人自动 `PUT` 建档后重试（默认 `person_type=agent`）；
- 支持 `idempotency_key`（24h 内相同 key+body 返回首次响应）。

```json
{"content": "评审必须覆盖回滚方案", "category": "constraint", "scope": "partition", "tags": ["评审"]}
```

### `mnemos_brief` / `mnemos_context`

- `mnemos_brief`：人的记忆简报，返回文本 + `{count, cached, generated_at}`；
- `mnemos_context`：资料 + 简报 + 相关记忆 + 分区共享知识，返回可直接注入的 `prompt`。

```json
{"query": "评审关注点", "budget_tokens": 800}
```

### `mnemos_person`

`get`（默认人）/ `list`（游标分页：`q/type/status/sort/cursor/limit/include_merged`）/ `upsert` / `update`。

```json
{"action": "list", "q": "user", "limit": 20}
```

### `mnemos_profile`（可选，P1）

读取 `GET /v1/partitions/:p/persons/:person/profile`（facts + 摘要；`force: true` 跳过
缓存重算）。若服务端尚未上线 P1 端点，返回明确的 `isError`（提示 404），不影响其他工具。

### `mnemos_status`

连接自检：服务可达性、分区统计、默认人是否存在、API Key 是否配置（**不输出密钥**）。
适合在新环境里第一步调用。

## 4. 资源

| URI | MIME | 说明 |
| --- | --- | --- |
| `mnemos://partition/<partition>/stats` | `application/json` | 分区统计（`partition_stats`，O(1)） |
| `mnemos://person/<person>/brief` | `text/plain` | 人的记忆简报文本 |
| `mnemos://person/<person>/profile` | `application/json` | 人的结构化画像（P1） |

`resources/list` 按当前 `MNEMOS_PARTITION` / `MNEMOS_PERSON` 生成具体 URI；
`resources/read` 解析 `mnemos://...` 后调用对应 `/v1` 端点。

## 5. DeepSeek Harness（DSH）配置示例

DSH 通过 ACP 的 `mcpServers` 数组配置 stdio server；`env` 是 `{name, value}` 数组：

```json
{
  "mcpServers": [
    {
      "name": "mnemos",
      "command": "node",
      "args": [
        "/Volumes/wd2025/devel/aiworker/mnemos/integrations/mcp-mnemos/src/index.js"
      ],
      "env": [
        { "name": "MNEMOS_BASE_URL", "value": "http://127.0.0.1:4380" },
        { "name": "MNEMOS_API_KEY", "value": "mnemos_live_…" },
        { "name": "MNEMOS_PARTITION", "value": "ws-demo" },
        { "name": "MNEMOS_PERSON", "value": "dsh-agent" }
      ]
    }
  ]
}
```

`command` 用 `node` 的绝对路径更稳妥（`which node`），`args[0]` 必须指向本仓库
`src/index.js` 的绝对路径。若 DSH 的插件/客户端支持 MCP 设置页，把同样的
`name/command/args/env` 填进去即可。

## 6. Claude Desktop 配置示例

编辑 `claude_desktop_config.json`（macOS：
`~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "node",
      "args": [
        "/Volumes/wd2025/devel/aiworker/mnemos/integrations/mcp-mnemos/src/index.js"
      ],
      "env": {
        "MNEMOS_BASE_URL": "http://127.0.0.1:4380",
        "MNEMOS_API_KEY": "mnemos_live_…",
        "MNEMOS_PARTITION": "ws-demo",
        "MNEMOS_PERSON": "dsh-agent"
      }
    }
  }
}
```

重启客户端后应能看到 7 个 `mnemos_*` 工具和 3 个资源。

## 7. 测试

测试用本地 `node:http` fake Mnemos + 直接调用 handler，**不依赖真实后端**：

```bash
cd integrations/mcp-mnemos
node --test test/
```

覆盖：`initialize` / 通知 / `ping` / `tools/list` / `tools/call`（search、add 的
404 自动建档重试、brief、context、person CRUD、status）/ 错误 → `isError` /
未知方法 → `-32601` / 非法 JSON → `-32700` / resources list+read / 配置默认值。

## 8. 目录结构

```text
integrations/mcp-mnemos/
├── src/
│   ├── index.js     # stdio 入口（readline → JSON-RPC）
│   ├── server.js    # 协议分发 + 错误兜底
│   ├── tools.js     # 工具/资源定义与实现
│   ├── client.js    # fetch 客户端 + 错误映射
│   └── config.js    # 环境变量
├── test/server.test.mjs
├── package.json
└── README.md
```

## 9. 限制

- 不做重试/降级（单次请求；工具调用失败直接返回 `isError`）。
- 只实现 stdio 传输；HTTP/SSE 传输不在本包范围。
- 资源 URI 的人级资源使用 `MNEMOS_PARTITION`；跨分区读取请用工具参数 `partition`。
- `mnemos_profile` 依赖 v6.1 P1 后端；未上线时返回 404 提示。
