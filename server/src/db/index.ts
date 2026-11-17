import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { newId, nowIso } from '../lib/ids.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

export const SCHEMA_VERSION = 5;

/** 打开 SQLite（WAL）。:memory: 用于测试。 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

function tableColumns(db: Db, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

/**
 * 幂等补列。SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，因此在执行 schema.sql 之前
 * 逐列检查；schema.sql 中的索引依赖这些列，必须先补齐。
 */
function ensureColumns(db: Db): void {
  const ensure = (table: string, definitions: Record<string, string>) => {
    const existing = tableColumns(db, table);
    if (existing.size === 0) return; // 表尚未创建，交给 schema.sql
    for (const [name, ddl] of Object.entries(definitions)) {
      if (existing.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  };

  ensure('memories', {
    task_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'project'",
    dreamed_at: 'TEXT',
    person_id: 'TEXT',
    actor_person_id: 'TEXT',
    scope: "TEXT NOT NULL DEFAULT 'partition'",
    session_id: 'TEXT',
  });
  ensure('memory_briefs', { person_id: 'TEXT' });
  ensure('memory_dream_runs', { person_id: 'TEXT' });
  ensure('users', {
    status: "TEXT NOT NULL DEFAULT 'active'",
    password_changed_at: 'TEXT',
    last_login_at: 'TEXT',
    failed_login_attempts: 'INTEGER NOT NULL DEFAULT 0',
    locked_until: 'TEXT',
  });
  ensure('sessions', { last_seen_at: 'TEXT', revoked_at: 'TEXT' });
  ensure('api_keys', {
    expires_at: 'TEXT',
    allowed_ips: "TEXT NOT NULL DEFAULT '[]'",
    rotated_from: 'TEXT',
    rotated_at: 'TEXT',
    kind: "TEXT NOT NULL DEFAULT 'project'",
    org_id: 'TEXT',
  });
  ensure('audit_logs', { request_id: 'TEXT' });
}

export function getSchemaVersion(db: Db): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(db: Db, version: number): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

/**
 * 迁移注册表。每次 schema 变更追加一个版本：
 * 列级变更写进 ensureColumns（幂等），数据回填/索引等写进 up()。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 5,
    name: 'neutral-person-model',
    up: (db) => {
      // v5：记忆以人（Person）组织、以分区（Partition）隔离。
      // 结构列/表已由 ensureColumns + schema.sql 完成，这里回填存量数据：
      // 1) memories.agent_id → person(type=agent)；2) memories.user_id → person(type=human)；
      // 3) person_id/actor_person_id 回填；4) visibility → scope；5) session_id；6) api_keys.org_id。
      const now = nowIso();
      const insertPerson = db.prepare(
        `INSERT OR IGNORE INTO persons
           (id, project_id, external_id, type, display_name, attributes, status, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, ?)`,
      );
      const findPerson = db.prepare('SELECT id FROM persons WHERE project_id = ? AND type = ? AND external_id = ?');

      const agentRows = db
        .prepare(
          `SELECT project_id, agent_id AS external_id, MAX(updated_at) AS last_at
             FROM memories
            WHERE agent_id IS NOT NULL AND agent_id <> ''
            GROUP BY project_id, agent_id`,
        )
        .all() as unknown as { project_id: string; external_id: string; last_at: string | null }[];
      for (const row of agentRows) {
        const agent = db
          .prepare('SELECT name FROM agents WHERE project_id = ? AND id = ?')
          .get(row.project_id, row.external_id) as unknown as { name?: string } | undefined;
        const lastAt = row.last_at || now;
        const existing = findPerson.get(row.project_id, 'agent', row.external_id) as unknown as { id?: string } | undefined;
        const id = existing?.id ?? newId('prs');
        insertPerson.run(id, row.project_id, row.external_id, 'agent', agent?.name ?? '', lastAt, lastAt, now, now);
        db.prepare(
          `UPDATE memories
              SET person_id = ?, actor_person_id = COALESCE(actor_person_id, ?)
            WHERE project_id = ? AND agent_id = ?`,
        ).run(id, id, row.project_id, row.external_id);
      }

      const userRows = db
        .prepare(
          `SELECT project_id, user_id AS external_id, MAX(updated_at) AS last_at
             FROM memories
            WHERE user_id IS NOT NULL AND user_id <> '' AND (agent_id IS NULL OR agent_id = '')
            GROUP BY project_id, user_id`,
        )
        .all() as unknown as { project_id: string; external_id: string; last_at: string | null }[];
      for (const row of userRows) {
        const lastAt = row.last_at || now;
        const existing = findPerson.get(row.project_id, 'human', row.external_id) as unknown as { id?: string } | undefined;
        const id = existing?.id ?? newId('prs');
        insertPerson.run(id, row.project_id, row.external_id, 'human', row.external_id, lastAt, lastAt, now, now);
        db.prepare(
          `UPDATE memories
              SET person_id = ?, actor_person_id = COALESCE(actor_person_id, ?)
            WHERE project_id = ? AND user_id = ? AND (agent_id IS NULL OR agent_id = '')`,
        ).run(id, id, row.project_id, row.external_id);
      }

      // 可见性 → scope（存量行 scope 默认 partition）。
      db.exec(
        `UPDATE memories
            SET scope = CASE visibility
                          WHEN 'agent' THEN 'person'
                          WHEN 'task' THEN 'session'
                          ELSE 'partition'
                        END`,
      );
      db.exec('UPDATE memories SET session_id = COALESCE(task_id, run_id) WHERE session_id IS NULL');
      db.exec(
        'UPDATE api_keys SET org_id = (SELECT p.org_id FROM projects p WHERE p.id = api_keys.project_id) WHERE org_id IS NULL',
      );
    },
  },
  {
    version: 4,
    name: 'brief-and-dream',
    up: () => {
      // memories.dreamed_at、memory_briefs、memory_dream_runs 由 ensureColumns + schema.sql 幂等创建；
      // 无需数据回填（存量记忆 dreamed_at 为 NULL，首次做梦会做一次增量巩固）。
    },
  },
  {
    version: 3,
    name: 'webhooks-and-observability',
    up: () => {
      // 表结构由 schema.sql 幂等创建；无需数据回填。
    },
  },
  {
    version: 2,
    name: 'production-hardening',
    up: (db) => {
      // v1 → v2：记忆可见性/任务列、用户状态与登录锁定、密钥生命周期、审计 requestId。
      // 结构变更已由 ensureColumns 幂等完成，这里补数据一致性。
      db.exec("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''");
      db.exec("UPDATE api_keys SET allowed_ips = '[]' WHERE allowed_ips IS NULL OR allowed_ips = ''");
      db.exec("UPDATE memories SET visibility = 'project' WHERE visibility IS NULL OR visibility = ''");
    },
  },
];

/** 幂等建表 + 版本迁移。 */
export function migrate(db: Db): void {
  ensureColumns(db);
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  ensureColumns(db);

  let current = getSchemaVersion(db);
  if (current === 0) {
    current = SCHEMA_VERSION;
    setSchemaVersion(db, current);
  }
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      setSchemaVersion(db, migration.version);
      db.exec('COMMIT');
      current = migration.version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${migration.name} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 忽略回滚失败 */
    }
    throw error;
  }
}

export function tableCount(db: Db, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function hasSeedData(db: Db): boolean {
  return tableCount(db, 'orgs') > 0;
}

export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    /* noop */
  }
}
