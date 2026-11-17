import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { memoryContentHash } from '../lib/text.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

/** v6 重建：全新空库自动建；v5 库不迁移（v5 保留在 data/，v6 使用 data-v6/）。 */
export const SCHEMA_VERSION = 7;

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

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as unknown as { name: string } | undefined;
  return Boolean(row);
}

function tableColumns(db: Db, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

/** SQLite 不支持 ADD COLUMN IF NOT EXISTS：逐列幂等补齐（v6 → v7）。 */
function ensureColumns(db: Db): void {
  const ensure = (table: string, definitions: Record<string, string>) => {
    const existing = tableColumns(db, table);
    if (existing.size === 0) return;
    for (const [name, ddl] of Object.entries(definitions)) {
      if (existing.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  };
  ensure('memories', {
    normalized_hash: 'TEXT',
    embedding: 'BLOB',
    embedding_model: 'TEXT',
    dim: 'INTEGER',
    valid_from: 'TEXT',
    valid_to: 'TEXT',
    superseded_by: 'TEXT',
    supersedes: 'TEXT',
    fact_key: 'TEXT',
    feedback_up: 'INTEGER NOT NULL DEFAULT 0',
    feedback_down: 'INTEGER NOT NULL DEFAULT 0',
  });
  ensure('persons', { merged_into: 'TEXT', consent: "TEXT NOT NULL DEFAULT '{}'", deleted_at: 'TEXT' });
}

/** v6 → v7 数据回填：内容哈希（去重）与生效时间；embedding 由异步任务补齐。 */
function backfillV7(db: Db): void {
  const rows = db.prepare('SELECT id, content FROM memories WHERE normalized_hash IS NULL').all() as unknown as {
    id: string;
    content: string;
  }[];
  if (rows.length === 0) {
    db.exec('UPDATE memories SET valid_from = COALESCE(valid_from, created_at) WHERE valid_from IS NULL');
    return;
  }
  db.exec('BEGIN');
  try {
    const update = db.prepare(
      'UPDATE memories SET normalized_hash = ?, valid_from = COALESCE(valid_from, created_at) WHERE id = ?',
    );
    for (const row of rows) update.run(memoryContentHash(row.content), row.id);
    db.exec('UPDATE memories SET valid_from = COALESCE(valid_from, created_at) WHERE valid_from IS NULL');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 幂等建表 + 版本迁移。
 *
 * - 空库：执行 schema.sql，写入 schema_version。
 * - v6 库：自动升级到 v7（补列/建新表/回填哈希与生效时间）。
 * - v5 及更早库：直接拒绝并提示使用 data-v6/（v6 是干净重建）。
 */
export function migrate(db: Db): void {
  const existingVersion = getSchemaVersion(db);
  if (existingVersion > 0 && existingVersion < 6) {
    const legacy = tableExists(db, 'projects') || tableExists(db, 'agents') || tableExists(db, 'tasks');
    throw new Error(
      `检测到 v${existingVersion} 数据库（${legacy ? '包含旧领域表' : '旧 schema'}）：v6 为干净重建，不迁移旧数据。` +
        '请使用新的数据目录（默认 data-v6/，MNEMOS_DATA_DIR / MNEMOS_DB_PATH 可覆盖）。',
    );
  }

  // 先补列（旧库），再执行 schema.sql（新表/索引/触发器幂等创建）。
  if (existingVersion > 0) ensureColumns(db);
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  ensureColumns(db);

  if (existingVersion > 0 && existingVersion < SCHEMA_VERSION) backfillV7(db);
  setSchemaVersion(db, SCHEMA_VERSION);
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
