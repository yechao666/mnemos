-- Mnemos schema (SQLite). 契约文件：字段名/语义由 Lead 维护，engine 可新增索引但不得重命名。
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,
  event_types     TEXT NOT NULL DEFAULT '[]',
  enabled         INTEGER NOT NULL DEFAULT 1,
  description     TEXT NOT NULL DEFAULT '',
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_delivery_at TEXT,
  last_status     INTEGER,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  disabled_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  event_id        TEXT,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 6,
  next_attempt_at TEXT,
  response_status INTEGER,
  response_body   TEXT,
  latency_ms      INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL,
  delivered_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (key, project_id)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);

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

CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  plan       TEXT NOT NULL DEFAULT 'enterprise',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  title         TEXT,
  avatar_color  TEXT NOT NULL DEFAULT 'violet',
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  password_changed_at TEXT,
  last_login_at TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  region      TEXT NOT NULL DEFAULT 'cn-shanghai',
  env         TEXT NOT NULL DEFAULT 'production',
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'developer',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  prefix              TEXT NOT NULL,
  key_hash            TEXT NOT NULL UNIQUE,
  scopes              TEXT NOT NULL DEFAULT '[]',
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  last_used_at        TEXT,
  revoked_at          TEXT,
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 600,
  expires_at          TEXT,
  allowed_ips         TEXT NOT NULL DEFAULT '[]',
  rotated_from        TEXT,
  rotated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_keys_project ON api_keys(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         TEXT,
  agent_id        TEXT,
  run_id          TEXT,
  app_id          TEXT,
  task_id         TEXT,
  visibility      TEXT NOT NULL DEFAULT 'project',
  content         TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'fact',
  importance      REAL NOT NULL DEFAULT 0.5,
  confidence      REAL NOT NULL DEFAULT 0.8,
  source          TEXT NOT NULL DEFAULT 'api',
  status          TEXT NOT NULL DEFAULT 'active',
  tags            TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count    INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,
  embedding       BLOB,
  embedding_model TEXT,
  dim             INTEGER,
  dreamed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(project_id, user_id, agent_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_recent ON memories(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_id, normalized_hash);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_task ON memories(project_id, task_id);
CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(project_id, visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_history (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  event       TEXT NOT NULL,
  old_content TEXT,
  new_content TEXT,
  actor       TEXT NOT NULL,
  reason      TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_project ON memory_history(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'assistant',
  model         TEXT NOT NULL DEFAULT 'deepseek-chat',
  description   TEXT NOT NULL DEFAULT '',
  capabilities  TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  last_active_at TEXT,
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id, status, last_active_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  goal            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  owner_agent_id  TEXT,
  branch          TEXT,
  summary         TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(project_id, owner_agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'concept',
  normalized    TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (project_id, normalized, type)
);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id, mention_count DESC);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  salience  REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_mementity_entity ON memory_entities(entity_id);

CREATE TABLE IF NOT EXISTS relations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation         TEXT NOT NULL,
  memory_id        TEXT,
  weight           REAL NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  UNIQUE (project_id, source_entity_id, target_entity_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_relations_project ON relations(project_id, weight DESC);

CREATE TABLE IF NOT EXISTS memory_terms (
  memory_id  TEXT NOT NULL,
  project_id TEXT NOT NULL,
  term       TEXT NOT NULL,
  tf         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (memory_id, term)
);
CREATE INDEX IF NOT EXISTS idx_terms_lookup ON memory_terms(project_id, term);
CREATE INDEX IF NOT EXISTS idx_terms_memory ON memory_terms(memory_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT,
  project_id    TEXT,
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
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id           TEXT PRIMARY KEY,
  org_id       TEXT,
  project_id   TEXT NOT NULL,
  api_key_id   TEXT,
  channel      TEXT NOT NULL DEFAULT 'console',
  operation    TEXT NOT NULL,
  method       TEXT NOT NULL DEFAULT 'POST',
  path         TEXT NOT NULL DEFAULT '',
  status       INTEGER NOT NULL DEFAULT 200,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  memory_tokens INTEGER NOT NULL DEFAULT 0,
  actor        TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_org ON usage_events(org_id, created_at DESC);

/* ------------------------------------------------------------------ */
/* 记忆简报 / 做梦                                                      */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS memory_briefs (
  project_id   TEXT NOT NULL,
  scope        TEXT NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  max_chars    INTEGER NOT NULL,
  model        TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scope)
);

CREATE TABLE IF NOT EXISTS memory_dream_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL,
  input_count   INTEGER NOT NULL DEFAULT 0,
  insight_count INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,
  error         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_project ON memory_dream_runs(project_id, started_at DESC);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '4');
