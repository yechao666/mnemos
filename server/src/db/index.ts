import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

/** v6 重建：全新空库自动建；v5 库不迁移（v5 保留在 data/，v6 使用 data-v6/）。 */
export const SCHEMA_VERSION = 6;

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

/**
 * 幂等建表 + 版本校验。
 *
 * - 空库：执行 schema.sql，写入 schema_version=6。
 * - v6 库：schema.sql 幂等（IF NOT EXISTS），触发器/索引缺失时补齐。
 * - v5 及更早库：直接拒绝并提示使用 data-v6/，避免把旧域表与新表混在一起。
 */
export function migrate(db: Db): void {
  const existingVersion = getSchemaVersion(db);
  if (existingVersion > 0 && existingVersion < SCHEMA_VERSION) {
    const legacy = tableExists(db, 'projects') || tableExists(db, 'agents') || tableExists(db, 'tasks');
    throw new Error(
      `检测到 v${existingVersion} 数据库（${legacy ? '包含旧领域表' : '旧 schema'}）：v6 为干净重建，不迁移旧数据。` +
        '请使用新的数据目录（默认 data-v6/，MNEMOS_DATA_DIR / MNEMOS_DB_PATH 可覆盖）。',
    );
  }

  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
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
