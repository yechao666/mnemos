import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { memoryContentHash } from '../lib/text.ts';
import { PRIVACY_CATALOG, PRIVACY_GROUPS } from './privacy-catalog.ts';
import { newId, nowIso } from '../lib/ids.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

/** v6 重建：全新空库自动建；v5 库不迁移（v5 保留在 data/，v6 使用 data-v6/）。 */
export const SCHEMA_VERSION = 10;

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


/** 内置隐私规则库：分组 + 规则（v9，按行业/领域）。 */
function seedPrivacyRules(db: Db): void {
  const at = nowIso();
  const groupStmt = db.prepare(
    `INSERT INTO privacy_rule_groups (key, name, industry, description, sort_order, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name, industry = excluded.industry,
       description = excluded.description, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
  );
  for (const group of PRIVACY_GROUPS) {
    groupStmt.run(group.key, group.name, group.industry, group.description, group.sortOrder, at, at);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO privacy_rules
       (id, scope, partition_id, code, name, kind, pattern, flags, instruction, entity_type, action,
        mask_mode, mask_keep_last, mask_keep_first, enabled, priority, builtin,
        group_key, validator, context_keywords, case_sensitive, region, severity, created_at, updated_at)
     VALUES (?, 'global', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE privacy_rules SET
       name = ?, kind = ?, pattern = ?, flags = ?, instruction = ?, entity_type = ?,
       mask_mode = ?, mask_keep_last = ?, mask_keep_first = ?, priority = ?,
       group_key = ?, validator = ?, context_keywords = ?, case_sensitive = ?, region = ?, severity = ?,
       updated_at = ?
     WHERE scope = 'global' AND partition_id = '' AND code = ? AND builtin = 1`,
  );
  for (const rule of PRIVACY_CATALOG) {
    const flags = rule.flags ?? 'g';
    const context = JSON.stringify(rule.contextKeywords ?? []);
    insert.run(
      newId('prv'),
      rule.code,
      rule.name,
      rule.kind,
      rule.pattern ?? null,
      flags,
      rule.instruction ?? null,
      rule.entityType,
      rule.action ?? 'mask',
      rule.maskMode ?? 'keepLast',
      rule.maskKeepLast ?? 4,
      rule.maskKeepFirst ?? 0,
      rule.enabled ? 1 : 0,
      rule.priority,
      rule.groupKey,
      rule.validator ?? 'none',
      context,
      rule.caseSensitive === false ? 0 : 1,
      rule.region ?? 'global',
      rule.severity ?? 'medium',
      at,
      at,
    );
    // 已存在的内置规则：同步目录字段（保留 enabled/action 等管理端可改项）。
    update.run(
      rule.name,
      rule.kind,
      rule.pattern ?? null,
      flags,
      rule.instruction ?? null,
      rule.entityType,
      rule.maskMode ?? 'keepLast',
      rule.maskKeepLast ?? 4,
      rule.maskKeepFirst ?? 0,
      rule.priority,
      rule.groupKey,
      rule.validator ?? 'none',
      context,
      rule.caseSensitive === false ? 0 : 1,
      rule.region ?? 'global',
      rule.severity ?? 'medium',
      at,
      rule.code,
    );
  }
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
    privacy_scanned_at: 'TEXT',
  });
  ensure('privacy_rules', {
    group_key: "TEXT NOT NULL DEFAULT 'common'",
    validator: "TEXT NOT NULL DEFAULT 'none'",
    context_keywords: "TEXT NOT NULL DEFAULT '[]'",
    case_sensitive: 'INTEGER NOT NULL DEFAULT 1',
    region: "TEXT NOT NULL DEFAULT 'global'",
    severity: "TEXT NOT NULL DEFAULT 'medium'",
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

  if (existingVersion > 0 && existingVersion < 7) backfillV7(db);
  if (existingVersion > 0 && existingVersion < 9) {
    // v8 旧内置 code 迁移到 v9 目录（name→person_name，medical→diagnosis）。
    db.prepare("UPDATE OR IGNORE privacy_rules SET code = 'person_name' WHERE code = 'name'").run();
    db.prepare("UPDATE OR IGNORE privacy_rules SET code = 'diagnosis' WHERE code = 'medical'").run();
  }
  seedPrivacyRules(db);
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
