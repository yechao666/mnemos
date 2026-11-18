-- Mnemos v6 schema（SQLite）。契约：docs/v6-architecture.md 第 2 节。
--
-- v6 是重建：只保留 分区（partitions）/ 人（persons）/ 记忆（memories）三个核心，
-- 旧域（agents / tasks / 任务简报 / 项目记录 / 复盘 / reports / webhooks / graph /
-- entities / relations / memory_terms）一律不建表、不做兼容。
--
-- 计数维护：persons / memories / sessions 的增删改由触发器维护
-- partition_stats 与 persons.memory_count/shared_memory_count/last_memory_at，
-- 列表页只读反规范化字段，不做 COUNT(*)；批量导入后调用 reconcile 校准。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/* ------------------------------------------------------------------ */
/* 组织与控制台账号（仅用于登录 / 权限，与「人」无关）                  */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  plan       TEXT NOT NULL DEFAULT 'enterprise',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'viewer',
  title                 TEXT,
  avatar_color          TEXT NOT NULL DEFAULT 'violet',
  password_hash         TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  password_changed_at   TEXT,
  last_login_at         TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  created_at            TEXT NOT NULL,
  last_seen_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  last_seen_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

/* ------------------------------------------------------------------ */
/* 分区（Partition）：取代 v5 的 projects                               */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS partitions (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (org_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_partitions_org ON partitions(org_id, created_at ASC);

/* ------------------------------------------------------------------ */
/* 人（Person）：记忆的主体，分区内一等实体                            */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS persons (
  id                  TEXT PRIMARY KEY,
  partition_id        TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
  external_id         TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'human',
  display_name        TEXT NOT NULL DEFAULT '',
  attributes          TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'active',
  -- 反规范化计数（触发器维护）：避免列表 N+1 / COUNT(*)
  memory_count        INTEGER NOT NULL DEFAULT 0,
  shared_memory_count INTEGER NOT NULL DEFAULT 0,
  session_count       INTEGER NOT NULL DEFAULT 0,
  last_memory_at      TEXT,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  merged_into         TEXT,
  consent             TEXT NOT NULL DEFAULT '{}',
  deleted_at          TEXT,
  UNIQUE (partition_id, type, external_id)
);

-- 列表 / 搜索索引（百万级）
-- 每种排序都准备「过滤 status」「不过滤 status」「type 过滤」三套，保证任意列表组合都能走索引排序。
CREATE INDEX IF NOT EXISTS idx_persons_recent     ON persons(partition_id, status, last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_persons_new        ON persons(partition_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_persons_name       ON persons(partition_id, status, display_name, id);
CREATE INDEX IF NOT EXISTS idx_persons_recent_all ON persons(partition_id, last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_persons_new_all    ON persons(partition_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_persons_name_all   ON persons(partition_id, display_name, id);
CREATE INDEX IF NOT EXISTS idx_persons_type_recent ON persons(partition_id, type, last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_persons_ext         ON persons(partition_id, external_id);

-- FTS5（外部内容表 + 同步触发器）：q 前缀检索 external_id / display_name
CREATE VIRTUAL TABLE IF NOT EXISTS persons_fts USING fts5(
  external_id,
  display_name,
  content = 'persons',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS persons_fts_ai AFTER INSERT ON persons BEGIN
  INSERT INTO persons_fts(rowid, external_id, display_name)
  VALUES (new.rowid, new.external_id, new.display_name);
END;

CREATE TRIGGER IF NOT EXISTS persons_fts_ad AFTER DELETE ON persons BEGIN
  INSERT INTO persons_fts(persons_fts, rowid, external_id, display_name)
  VALUES ('delete', old.rowid, old.external_id, old.display_name);
END;

CREATE TRIGGER IF NOT EXISTS persons_fts_au AFTER UPDATE ON persons BEGIN
  INSERT INTO persons_fts(persons_fts, rowid, external_id, display_name)
  VALUES ('delete', old.rowid, old.external_id, old.display_name);
  INSERT INTO persons_fts(rowid, external_id, display_name)
  VALUES (new.rowid, new.external_id, new.display_name);
END;

/* ------------------------------------------------------------------ */
/* 会话（可选分组：一次对话 / 任务）                                   */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  partition_id TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_person ON sessions(partition_id, person_id, started_at DESC);

/* ------------------------------------------------------------------ */
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  partition_id    TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
  person_id       TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  actor_person_id TEXT,
  scope           TEXT NOT NULL DEFAULT 'partition',
  session_id      TEXT,
  category        TEXT NOT NULL DEFAULT 'fact',
  content         TEXT NOT NULL,
  importance      REAL NOT NULL DEFAULT 0.5,
  confidence      REAL NOT NULL DEFAULT 0.8,
  source          TEXT NOT NULL DEFAULT 'api',
  status          TEXT NOT NULL DEFAULT 'active',
  tags            TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  expires_at      TEXT,
  dreamed_at      TEXT,
  normalized_hash TEXT,
  embedding       BLOB,
  embedding_model TEXT,
  dim             INTEGER,
  valid_from      TEXT,
  valid_to        TEXT,
  superseded_by   TEXT,
  supersedes      TEXT,
  fact_key        TEXT,
  feedback_up     INTEGER NOT NULL DEFAULT 0,
  feedback_down   INTEGER NOT NULL DEFAULT 0,
  privacy_scanned_at TEXT
);
-- 排序键放在 status 之前：列表默认不带 status 过滤，保证 ORDER BY created_at 可直接走索引。
CREATE INDEX IF NOT EXISTS idx_memories_person ON memories(partition_id, person_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memories_scope  ON memories(partition_id, scope, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memories_valid  ON memories(partition_id, person_id, valid_to, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memories_fact   ON memories(partition_id, person_id, fact_key, valid_to);
CREATE INDEX IF NOT EXISTS idx_memories_hash   ON memories(partition_id, person_id, normalized_hash);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(partition_id, category, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(partition_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memories_recent ON memories(partition_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(partition_id, session_id);

-- FTS5（检索用：content 全文）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content = 'memories',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

/* ------------------------------------------------------------------ */
/* 简报 / 做梦                                                         */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS memory_briefs (
  partition_id TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
  scope_key    TEXT NOT NULL,
  person_id    TEXT,
  text         TEXT NOT NULL DEFAULT '',
  max_chars    INTEGER NOT NULL,
  model        TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (partition_id, scope_key)
);

CREATE TABLE IF NOT EXISTS dream_runs (
  id            TEXT PRIMARY KEY,
  partition_id  TEXT NOT NULL REFERENCES partitions(id) ON DELETE CASCADE,
  person_id     TEXT,
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL,
  input_count   INTEGER NOT NULL DEFAULT 0,
  insight_count INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,
  error         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_partition ON dream_runs(partition_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dream_runs_person ON dream_runs(partition_id, person_id, started_at DESC);

/* ------------------------------------------------------------------ */
/* API Key（分区 / 组织）                                              */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS api_keys (
  id                 TEXT PRIMARY KEY,
  partition_id       TEXT REFERENCES partitions(id) ON DELETE CASCADE,
  org_id             TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL DEFAULT 'partition',
  name               TEXT NOT NULL,
  prefix             TEXT NOT NULL,
  key_hash           TEXT NOT NULL UNIQUE,
  scopes             TEXT NOT NULL DEFAULT '[]',
  created_by         TEXT,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  revoked_at         TEXT,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 600,
  expires_at         TEXT,
  allowed_ips        TEXT NOT NULL DEFAULT '[]',
  rotated_from       TEXT,
  rotated_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_keys_partition ON api_keys(partition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keys_org ON api_keys(org_id, created_at DESC);

/* ------------------------------------------------------------------ */
/* 分区统计（头部聚合；触发器维护，列表页不再 COUNT(*)）                 */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS partition_stats (
  partition_id    TEXT PRIMARY KEY REFERENCES partitions(id) ON DELETE CASCADE,
  persons_total   INTEGER NOT NULL DEFAULT 0,
  persons_human   INTEGER NOT NULL DEFAULT 0,
  persons_agent   INTEGER NOT NULL DEFAULT 0,
  persons_service INTEGER NOT NULL DEFAULT 0,
  memories_total  INTEGER NOT NULL DEFAULT 0,
  shared_total    INTEGER NOT NULL DEFAULT 0,
  sessions_total  INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS partitions_stats_ai AFTER INSERT ON partitions BEGIN
  INSERT OR IGNORE INTO partition_stats (partition_id, updated_at)
  VALUES (new.id, new.created_at);
END;

/* --- persons 计数 --- */

CREATE TRIGGER IF NOT EXISTS persons_stats_ai AFTER INSERT ON persons BEGIN
  UPDATE partition_stats
     SET persons_total   = persons_total + 1,
         persons_human   = persons_human + (CASE WHEN new.type = 'human' THEN 1 ELSE 0 END),
         persons_agent   = persons_agent + (CASE WHEN new.type = 'agent' THEN 1 ELSE 0 END),
         persons_service = persons_service + (CASE WHEN new.type = 'service' THEN 1 ELSE 0 END),
         updated_at      = new.created_at
   WHERE partition_id = new.partition_id;
END;

CREATE TRIGGER IF NOT EXISTS persons_stats_ad AFTER DELETE ON persons BEGIN
  UPDATE partition_stats
     SET persons_total   = MAX(0, persons_total - 1),
         persons_human   = MAX(0, persons_human - (CASE WHEN old.type = 'human' THEN 1 ELSE 0 END)),
         persons_agent   = MAX(0, persons_agent - (CASE WHEN old.type = 'agent' THEN 1 ELSE 0 END)),
         persons_service = MAX(0, persons_service - (CASE WHEN old.type = 'service' THEN 1 ELSE 0 END)),
         updated_at      = old.updated_at
   WHERE partition_id = old.partition_id;
END;

CREATE TRIGGER IF NOT EXISTS persons_stats_au AFTER UPDATE OF type ON persons BEGIN
  UPDATE partition_stats
     SET persons_human   = MAX(0, persons_human + (CASE WHEN new.type = 'human' THEN 1 ELSE 0 END) - (CASE WHEN old.type = 'human' THEN 1 ELSE 0 END)),
         persons_agent   = MAX(0, persons_agent + (CASE WHEN new.type = 'agent' THEN 1 ELSE 0 END) - (CASE WHEN old.type = 'agent' THEN 1 ELSE 0 END)),
         persons_service = MAX(0, persons_service + (CASE WHEN new.type = 'service' THEN 1 ELSE 0 END) - (CASE WHEN old.type = 'service' THEN 1 ELSE 0 END)),
         updated_at      = new.updated_at
   WHERE partition_id = new.partition_id;
END;

/* --- memories 计数 + 人的反规范化计数 --- */

CREATE TRIGGER IF NOT EXISTS memories_stats_ai AFTER INSERT ON memories BEGIN
  UPDATE partition_stats
     SET memories_total = memories_total + 1,
         shared_total   = shared_total + (CASE WHEN new.scope = 'partition' THEN 1 ELSE 0 END),
         updated_at     = new.created_at
   WHERE partition_id = new.partition_id;

  UPDATE persons
     SET memory_count        = memory_count + (CASE WHEN new.scope IN ('person', 'session') THEN 1 ELSE 0 END),
         shared_memory_count = shared_memory_count + (CASE WHEN new.scope = 'partition' THEN 1 ELSE 0 END),
         last_memory_at      = CASE
                                 WHEN last_memory_at IS NULL OR last_memory_at < new.created_at THEN new.created_at
                                 ELSE last_memory_at
                               END,
         last_seen_at        = CASE WHEN last_seen_at < new.created_at THEN new.created_at ELSE last_seen_at END,
         updated_at          = CASE WHEN updated_at < new.created_at THEN new.created_at ELSE updated_at END
   WHERE id = new.person_id;
END;

CREATE TRIGGER IF NOT EXISTS memories_stats_ad AFTER DELETE ON memories BEGIN
  UPDATE partition_stats
     SET memories_total = MAX(0, memories_total - 1),
         shared_total   = MAX(0, shared_total - (CASE WHEN old.scope = 'partition' THEN 1 ELSE 0 END)),
         updated_at     = old.updated_at
   WHERE partition_id = old.partition_id;

  UPDATE persons
     SET memory_count        = MAX(0, memory_count - (CASE WHEN old.scope IN ('person', 'session') THEN 1 ELSE 0 END)),
         shared_memory_count = MAX(0, shared_memory_count - (CASE WHEN old.scope = 'partition' THEN 1 ELSE 0 END)),
         updated_at          = old.updated_at
   WHERE id = old.person_id;
END;

CREATE TRIGGER IF NOT EXISTS memories_scope_au AFTER UPDATE OF scope ON memories BEGIN
  UPDATE partition_stats
     SET shared_total = MAX(0, shared_total
           + (CASE WHEN new.scope = 'partition' THEN 1 ELSE 0 END)
           - (CASE WHEN old.scope = 'partition' THEN 1 ELSE 0 END)),
         updated_at = new.updated_at
   WHERE partition_id = new.partition_id;

  UPDATE persons
     SET memory_count = MAX(0, memory_count
           + (CASE WHEN new.scope IN ('person', 'session') THEN 1 ELSE 0 END)
           - (CASE WHEN old.scope IN ('person', 'session') THEN 1 ELSE 0 END)),
         shared_memory_count = MAX(0, shared_memory_count
           + (CASE WHEN new.scope = 'partition' THEN 1 ELSE 0 END)
           - (CASE WHEN old.scope = 'partition' THEN 1 ELSE 0 END)),
         updated_at = new.updated_at
   WHERE id = new.person_id;
END;

/* --- sessions 计数 --- */

CREATE TRIGGER IF NOT EXISTS sessions_stats_ai AFTER INSERT ON sessions BEGIN
  UPDATE partition_stats
     SET sessions_total = sessions_total + 1,
         updated_at     = new.started_at
   WHERE partition_id = new.partition_id;

  UPDATE persons
     SET session_count = session_count + 1,
         updated_at    = CASE WHEN updated_at < new.started_at THEN new.started_at ELSE updated_at END
   WHERE id = new.person_id;
END;

CREATE TRIGGER IF NOT EXISTS sessions_stats_ad AFTER DELETE ON sessions BEGIN
  UPDATE partition_stats
     SET sessions_total = MAX(0, sessions_total - 1)
   WHERE partition_id = old.partition_id;

  UPDATE persons
     SET session_count = MAX(0, session_count - 1)
   WHERE id = old.person_id;
END;

/* ------------------------------------------------------------------ */
/* 基础运营：审计 / 用量 / 维护                                        */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT,
  partition_id  TEXT,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  actor_label   TEXT NOT NULL,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  detail        TEXT NOT NULL DEFAULT '{}',
  ip            TEXT,
  user_agent    TEXT,
  request_id    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_partition ON audit_logs(partition_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id            TEXT PRIMARY KEY,
  org_id        TEXT,
  partition_id  TEXT NOT NULL,
  api_key_id    TEXT,
  channel       TEXT NOT NULL DEFAULT 'console',
  operation     TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'POST',
  path          TEXT NOT NULL DEFAULT '',
  status        INTEGER NOT NULL DEFAULT 200,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  result_count  INTEGER NOT NULL DEFAULT 0,
  memory_tokens INTEGER NOT NULL DEFAULT 0,
  actor         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_partition ON usage_events(partition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_org ON usage_events(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '{}',
  actor       TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_started ON maintenance_runs(started_at DESC);

/* ------------------------------------------------------------------ */
/* v6.1：记忆质量（P0/P1/P2）                                          */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS memory_history (
  id            TEXT PRIMARY KEY,
  partition_id  TEXT NOT NULL,
  person_id     TEXT,
  memory_id     TEXT NOT NULL,
  event         TEXT NOT NULL,
  old_content   TEXT,
  new_content   TEXT,
  actor         TEXT,
  reason        TEXT,
  meta          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_partition ON memory_history(partition_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_feedback (
  id          TEXT PRIMARY KEY,
  partition_id TEXT NOT NULL,
  memory_id   TEXT NOT NULL,
  person_id   TEXT,
  helpful     INTEGER NOT NULL,
  query       TEXT,
  actor       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_memory ON memory_feedback(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id            TEXT PRIMARY KEY,
  partition_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  payload       TEXT NOT NULL DEFAULT '{}',
  attempts      INTEGER NOT NULL DEFAULT 0,
  run_after     TEXT NOT NULL,
  locked_at     TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON memory_jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_partition ON memory_jobs(partition_id, created_at DESC);

CREATE TABLE IF NOT EXISTS person_facts (
  id            TEXT PRIMARY KEY,
  partition_id  TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.7,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  source_memory_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_person ON person_facts(partition_id, person_id, valid_to);

CREATE TABLE IF NOT EXISTS person_profiles (
  partition_id  TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  source_hash   TEXT NOT NULL DEFAULT '',
  generated_at  TEXT NOT NULL,
  PRIMARY KEY (partition_id, person_id)
);

CREATE TABLE IF NOT EXISTS memory_attachments (
  id            TEXT PRIMARY KEY,
  partition_id  TEXT NOT NULL,
  memory_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER,
  caption       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_memory ON memory_attachments(memory_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  partition_id  TEXT,
  method        TEXT,
  path          TEXT,
  status        INTEGER,
  body          TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  partition_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'concept',
  normalized    TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (partition_id, normalized, type)
);
CREATE INDEX IF NOT EXISTS idx_entities_partition ON entities(partition_id, mention_count DESC);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id  TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  salience   REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);

CREATE TABLE IF NOT EXISTS relations (
  id               TEXT PRIMARY KEY,
  partition_id     TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation         TEXT NOT NULL,
  memory_id        TEXT,
  weight           REAL NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  UNIQUE (partition_id, source_entity_id, target_entity_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_relations_partition ON relations(partition_id, weight DESC);

/* ------------------------------------------------------------------ */
/* v6.2：隐私规则域（schema v8）                                        */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS privacy_rules (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,                 -- global | partition
  partition_id    TEXT NOT NULL DEFAULT '',      -- global 为空串
  code            TEXT NOT NULL,                 -- email/phone/id_card/...
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- regex | prompt
  pattern         TEXT,
  flags           TEXT NOT NULL DEFAULT 'g',
  instruction     TEXT,
  entity_type     TEXT NOT NULL DEFAULT 'pii',
  action          TEXT NOT NULL DEFAULT 'mask',  -- mask | placeholder
  mask_mode       TEXT NOT NULL DEFAULT 'keepLast',
  mask_keep_last  INTEGER NOT NULL DEFAULT 4,
  mask_keep_first INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 100,
  builtin         INTEGER NOT NULL DEFAULT 0,
  group_key       TEXT NOT NULL DEFAULT 'common',
  validator       TEXT NOT NULL DEFAULT 'none',
  context_keywords TEXT NOT NULL DEFAULT '[]',
  case_sensitive  INTEGER NOT NULL DEFAULT 1,
  region          TEXT NOT NULL DEFAULT 'global',
  severity        TEXT NOT NULL DEFAULT 'medium',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (scope, partition_id, code)
);
CREATE INDEX IF NOT EXISTS idx_privacy_rules_scope ON privacy_rules(scope, partition_id, enabled, priority);
CREATE INDEX IF NOT EXISTS idx_privacy_rules_group ON privacy_rules(scope, partition_id, group_key);

CREATE TABLE IF NOT EXISTS privacy_rule_groups (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  industry    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 100,
  builtin     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_placeholders (
  id            TEXT PRIMARY KEY,
  partition_id  TEXT NOT NULL,
  memory_id     TEXT NOT NULL,
  placeholder   TEXT NOT NULL,
  value_cipher  TEXT NOT NULL,
  encrypted     INTEGER NOT NULL DEFAULT 0,
  kind          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (memory_id, placeholder)
);
CREATE INDEX IF NOT EXISTS idx_placeholders_memory ON memory_placeholders(memory_id);

/* ------------------------------------------------------------------ */
/* v6.4：大模型设置（schema v10）                                       */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS llm_providers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  protocol           TEXT NOT NULL DEFAULT 'openai',
  base_url           TEXT NOT NULL,
  default_model      TEXT,
  api_key_cipher     TEXT NOT NULL DEFAULT '',
  api_key_encrypted  INTEGER NOT NULL DEFAULT 0,
  input_price        REAL NOT NULL DEFAULT 0,
  output_price       REAL NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_stage_configs (
  stage         TEXT PRIMARY KEY,
  provider_id   TEXT,
  model         TEXT,
  temperature   REAL NOT NULL DEFAULT 0.2,
  max_tokens    INTEGER NOT NULL DEFAULT 1024,
  timeout_ms    INTEGER NOT NULL DEFAULT 20000,
  system_prompt TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                TEXT PRIMARY KEY,
  stage             TEXT NOT NULL,
  provider_id       TEXT,
  model             TEXT,
  protocol          TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_stage ON llm_calls(stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at DESC);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '10');
