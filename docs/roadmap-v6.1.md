# Mnemos v6.1 —— 记忆质量升级路线（P0/P1/P2）

> 前提：**暂不更换数据库**（继续 SQLite 单节点）。目标：补齐与主流记忆系统的三项硬差距
> （语义检索、记忆演化、结构化画像/评测），并完成 P2 的图/生态/多模态/合规。
>
> 本文件是 v6.1 的实现契约；每项含验收标准。schema 升到 **v7**（幂等迁移，兼容 v6 数据）。

## 0. 总览

| 阶段 | 能力 | 状态目标 |
| --- | --- | --- |
| P0 | 混合检索（本地 embedding + FTS + 时效/重要度）、写入管线（去重/合并/取代/异步任务/幂等）、memory_history + feedback、schema v7 | 检索可解释、冲突可处理、历史可追溯 |
| P1 | 结构化画像（person_facts + profile 摘要）、人生命周期（merge/archive/export/delete）、时序查询（valid_from/valid_to/as_of）、评测 harness | 记忆可演进、可迁移、可度量 |
| P2 | 实体/关系图、Python SDK、MCP server、LangChain 适配、多模态附件、PII/合规 | 生态与治理补齐 |

## 1. schema v7（SQLite，不换库）

### 1.1 `memories` 增量

```sql
ALTER TABLE memories ADD COLUMN normalized_hash TEXT;   -- 归一化内容哈希（去重）
ALTER TABLE memories ADD COLUMN embedding BLOB;         -- 本地 embedding（float32 数组）
ALTER TABLE memories ADD COLUMN embedding_model TEXT;   -- mnemos-hash-384 / 外部模型名
ALTER TABLE memories ADD COLUMN dim INTEGER;
ALTER TABLE memories ADD COLUMN valid_from TEXT;        -- 事实生效时间（默认=created_at）
ALTER TABLE memories ADD COLUMN valid_to TEXT;          -- 失效时间；NULL=当前有效
ALTER TABLE memories ADD COLUMN superseded_by TEXT;     -- 被哪条记忆取代
ALTER TABLE memories ADD COLUMN supersedes TEXT;        -- 取代了哪条记忆
ALTER TABLE memories ADD COLUMN fact_key TEXT;          -- 槽位键（如 preference.language）
ALTER TABLE memories ADD COLUMN feedback_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN feedback_down INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_memories_valid ON memories(partition_id, person_id, valid_to, created_at DESC);
CREATE INDEX idx_memories_fact ON memories(partition_id, person_id, fact_key);
CREATE INDEX idx_memories_hash ON memories(partition_id, person_id, normalized_hash);
```

### 1.2 新表

```sql
-- 逐条记忆的变更历史（ADD/UPDATE/MERGE/SUPERSEDE/DELETE/NOOP/FEEDBACK）
memory_history(
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, person_id TEXT, memory_id TEXT NOT NULL,
  event TEXT NOT NULL, old_content TEXT, new_content TEXT,
  actor TEXT, reason TEXT, meta TEXT DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX idx_history_memory ON memory_history(memory_id, created_at DESC);
CREATE INDEX idx_history_partition ON memory_history(partition_id, created_at DESC);

-- 检索反馈（帮助置信度/重要度调整）
memory_feedback(
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, memory_id TEXT NOT NULL, person_id TEXT,
  helpful INTEGER NOT NULL, query TEXT, actor TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_memory ON memory_feedback(memory_id, created_at DESC);

-- 异步写管线任务：consolidate/embed/extract/profile/summarize
memory_jobs(
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending|running|done|failed
  payload TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL, locked_at TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON memory_jobs(status, run_after);
CREATE INDEX idx_jobs_partition ON memory_jobs(partition_id, created_at DESC);

-- 结构化画像：事实槽位（当前有效 = valid_to IS NULL）
person_facts(
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, person_id TEXT NOT NULL,
  key TEXT NOT NULL, value TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.7,
  valid_from TEXT NOT NULL, valid_to TEXT, source_memory_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_facts_person ON person_facts(partition_id, person_id, valid_to);

-- 画像摘要缓存
person_profiles(
  partition_id TEXT NOT NULL, person_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', source_hash TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL, PRIMARY KEY(partition_id, person_id)
);

-- 多模态附件（P2）：媒体本身可由调用方托管，这里存 URL/元数据/描述
memory_attachments(
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- image|audio|video|file
  url TEXT NOT NULL, mime TEXT, size INTEGER, caption TEXT, created_at TEXT NOT NULL
);

-- 写请求幂等（P0）
idempotency_keys(
  key TEXT PRIMARY KEY, partition_id TEXT, method TEXT, path TEXT,
  status INTEGER, body TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
```

### 1.3 `persons` 增量

```sql
ALTER TABLE persons ADD COLUMN merged_into TEXT;    -- 人合并后指向 canonical
ALTER TABLE persons ADD COLUMN consent TEXT DEFAULT '{}';   -- 同意/合规标记
ALTER TABLE persons ADD COLUMN deleted_at TEXT;      -- 软删除
```

### 1.4 图（P2）

```sql
entities(id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, name TEXT NOT NULL,
         type TEXT NOT NULL DEFAULT 'concept', normalized TEXT NOT NULL,
         mention_count INTEGER DEFAULT 1, created_at TEXT NOT NULL,
         UNIQUE(partition_id, normalized, type));
memory_entities(memory_id TEXT NOT NULL, entity_id TEXT NOT NULL, salience REAL DEFAULT 1,
                PRIMARY KEY(memory_id, entity_id));
relations(id TEXT PRIMARY KEY, partition_id TEXT NOT NULL,
          source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL,
          relation TEXT NOT NULL, memory_id TEXT, weight REAL DEFAULT 1, created_at TEXT NOT NULL,
          UNIQUE(partition_id, source_entity_id, target_entity_id, relation));
```

## 2. P0：混合检索 + 写入管线 + 历史/反馈

### 2.1 检索

- **本地 embedding**：恢复确定性 CJK 感知 hash-384（v5 `engine/embed.ts` 思路），写入时计算并落库；外部模型可选（`partition.settings.embeddingModel`），失败回退本地。
- **候选集**：FTS5 前缀/子串（top 300）+ 该人最近 200 + 同分区 scope=partition 最近 200，按 id 去重；再对候选做 cosine 重排。
- **融合打分**：`score = Σ w_i * normalized_i`，信号：`vector / keyword / recency / importance / entity(可选)`；权重放 `PartitionSettings.retrievalWeights`，默认 `0.45 / 0.3 / 0.15 / 0.1 / 0`。
- **模式**：`mode=hybrid|keyword|vector`（默认 hybrid）；`as_of` 时序查询（P1）；`valid_only=true` 默认排除 `valid_to` 非空。
- **上下文装配**：token 预算 + MMR 去冗 + 引用 id + 人级/分区级混合；返回 `signals` 与 `strategy`。
- **验收**：同义词/改写查询在 30 条测试用例上 recall@5 ≥ 0.8（keyword-only 基线对比）；`/memories/search` 返回 `signals.vector/keyword/recency/importance`。

### 2.2 写入管线

- 写记忆时：归一化 → `normalized_hash` → 同人+同分区 dedupe：
  - 完全重复（hash 相同）→ `NOOP`（history 记录，返回已有记忆）；
  - 余弦 ≥ `mergeThreshold`(0.95) → `MERGE`（更新内容/重要度/标签，history MERGE）；
  - 显式 `supersedes_id` 或相同 `fact_key` → 旧记忆 `valid_to=now / superseded_by=new`，新记忆 `supersedes=old`（history SUPERSEDE）。
- **异步队列**：写入事务内 enqueue `embed`（如未落 embedding）、`extract`（实体）、`profile`（画像摘要）；worker 在 main 进程每 1s 处理（批量、attempts、失败退避、`locked_at` 防重复）。
- **幂等**：支持 `Idempotency-Key`（POST 写接口），24h 内相同 key+body 返回首次响应；冲突 409。
- **验收**：重复写入返回 NOOP 不新增；相似写入 MERGE；supersede 后默认检索不再返回旧事实；worker 处理任务且重启不丢。

### 2.3 历史 / 反馈

- `GET /memories/:id/history`；`POST /memories/:id/feedback {helpful,query?}` → 更新 `feedback_up/down`，按比例微调 `confidence`（0.05 步长，夹在 0.05–1）。
- 控制台记忆抽屉展示历史时间线与反馈按钮。
- **验收**：每次写/合并/取代/反馈都有 history；反馈后检索排序中 confidence/importance 生效。

## 3. P1：画像 / 生命周期 / 时序 / 评测

- **画像**：`person_facts`（key/value/validity/source）；`GET /persons/:id/profile` 返回当前 facts + 摘要（`person_profiles`，异步生成，LLM 可选）；`PUT /persons/:id/facts` 显式维护；记忆 metadata `factKey` 自动抽取为 fact。
- **生命周期**：`POST /persons/:id/merge {targetId}`（迁移 memories/facts/feedback，源标记 merged_into）；`POST /persons/:id/archive`；`GET /persons/:id/export`（JSON）；`DELETE /persons/:id`（软删，可 `hard=true` 仅 owner）。
- **时序**：`as_of=ISO`（回看当时有效事实）、`include_superseded=true`；检索默认 `valid_only`。
- **评测**：`scripts/eval-memory.ts` 场景集：改写召回、时效更新、冲突取代、隔离、反馈调权、人合并；输出 recall@k/MRR/temporal accuracy/冲突准确率；`pnpm eval`；CI 阈值。
- **验收**：eval 全部场景通过阈值；人合并后检索仍正确；as_of 查询返回历史事实。

## 4. P2：图 / 生态 / 多模态 / 合规

- **实体/关系**：规则抽取（CJK 词典 + 英文词 + 引号实体），写入 `entities/memory_entities/relations`；`GET /graph`、`GET /entities`；检索增加 entity 信号；控制台图谱页（人/分区维度）。
- **Python SDK**：`sdk/python`（requests/urllib，零重依赖），覆盖 partitions/persons/memories/search/brief/context/dream/history/feedback；unittest。
- **MCP server**：`integrations/mcp-mnemos`，暴露 tools（search/add/brief/context/person）与 resources（person profile），stdio 传输；用 Node 实现，无 SDK 依赖。
- **LangChain 适配**：`integrations/langchain-mnemos`（BaseStore 兼容接口，可选依赖），文档示例。
- **多模态**：`memory_attachments` + 写入 `attachments[]`（URL/caption）+ 简报/检索返回附件；控制台展示缩略图/链接；caption 参与 FTS/向量。
- **合规**：PII 正则脱敏（手机/邮箱/身份证/银行卡，按分区设置 `piiRedaction`）、`persons.consent` 字段与导出、字段级加密可选（AES-256-GCM，密钥来自 env）、审计覆盖全部写操作。
- **验收**：graph API 返回实体/边；MCP server 在 DSH/Claude 客户端可发现工具；PII 开关生效；合规导出/删除可用。

## 5. 不换数据库的约束

- 继续 SQLite WAL + 单进程；向量检索用「候选集 + 内存 cosine」，不引入 sqlite-vec 等扩展（可后续加）。
- 百万级人列表保持 keyset 游标 + partition_stats；记忆检索对单分区候选集设上限（默认 500），避免全表扫描。
- 异步任务与 worker 同进程；多副本/Postgres 不在本期。

## 6. 里程碑与验收

1. **M1（P0）**：schema v7 + 混合检索 + 写管线 + history/feedback；`pnpm verify` 全绿；eval 召回用例通过；控制台可见信号/历史/反馈。
2. **M2（P1）**：画像/生命周期/时序/评测 harness；eval 全场景通过；文档与 SDK 同步。
3. **M3（P2）**：图/生态/多模态/合规；MCP 与 Python SDK 冒烟通过；控制台图谱与附件展示。
4. 每个里程碑提交到 `v6-rebuild`（或后续 `v6.1` 分支）并推送；旧 v6 行为保持兼容（新增字段/端点，不破坏现有控制台与 DSH 插件）。
