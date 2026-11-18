import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { memoryContentHash } from '../lib/text.ts';
import { newId, nowIso } from '../lib/ids.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

/** v6 重建：全新空库自动建；v5 库不迁移（v5 保留在 data/，v6 使用 data-v6/）。 */
export const SCHEMA_VERSION = 8;

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


/** 全局内置隐私规则（regex 默认启用；prompt 默认禁用，需分区开启 + LLM）。 */
function seedPrivacyRules(db: Db): void {
  const row = db.prepare("SELECT COUNT(*) AS c FROM privacy_rules WHERE scope = 'global'").get() as unknown as {
    c: number;
  };
  if (row.c > 0) return;
  const at = nowIso();
  interface SeedRule {
    code: string;
    name: string;
    kind: string;
    pattern?: string;
    instruction?: string;
    entityType: string;
    action: string;
    maskMode: string;
    keepFirst: number;
    keepLast: number;
    priority: number;
    enabled: number;
  }
  const rules: SeedRule[] = [
    {
      code: 'email', name: '邮箱', kind: 'regex',
      pattern: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
      entityType: 'email', action: 'mask', maskMode: 'email', keepFirst: 0, keepLast: 0, priority: 10,
      enabled: 1,
    },
    {
      code: 'id_card', name: '身份证号', kind: 'regex',
      pattern: String.raw`(?<![0-9A-Za-z])(\d{17}[\dXx])(?![0-9A-Za-z])`,
      entityType: 'id_card', action: 'mask', maskMode: 'keepFirstLast', keepFirst: 6, keepLast: 4, priority: 20,
      enabled: 1,
    },
    {
      code: 'phone', name: '手机号', kind: 'regex',
      pattern: String.raw`(?<!\d)(1[3-9]\d{9})(?!\d)`,
      entityType: 'phone', action: 'mask', maskMode: 'keepFirstLast', keepFirst: 3, keepLast: 4, priority: 30,
      enabled: 1,
    },
    {
      code: 'bank_card', name: '银行卡号', kind: 'regex',
      pattern: String.raw`(?<!\d)(\d{16,19})(?!\d)`,
      entityType: 'bank_card', action: 'mask', maskMode: 'keepLast', keepFirst: 0, keepLast: 4, priority: 40,
      enabled: 1,
    },
    {
      code: 'name', name: '人名', kind: 'prompt',
      instruction: '识别人名：中文姓名、英文姓名（含称呼）；返回原文中出现的姓名。',
      entityType: 'name', action: 'mask', maskMode: 'keepFirstLast', keepFirst: 1, keepLast: 1, priority: 110,
      enabled: 0,
    },
    {
      code: 'address', name: '地址', kind: 'prompt',
      instruction: '识别详细地址：省市区、街道、门牌号、楼层房间等。',
      entityType: 'address', action: 'mask', maskMode: 'full', keepFirst: 0, keepLast: 0, priority: 120,
      enabled: 0,
    },
    {
      code: 'credential', name: '账号凭据', kind: 'prompt',
      instruction: '识别账号、密码、API Key、Token、验证码、密钥等凭据。',
      entityType: 'credential', action: 'mask', maskMode: 'full', keepFirst: 0, keepLast: 0, priority: 130,
      enabled: 0,
    },
    {
      code: 'medical', name: '健康信息', kind: 'prompt',
      instruction: '识别疾病、诊断、用药、体检指标、过敏史等健康信息。',
      entityType: 'medical', action: 'mask', maskMode: 'full', keepFirst: 0, keepLast: 0, priority: 140,
      enabled: 0,
    },
  ];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO privacy_rules
       (id, scope, partition_id, code, name, kind, pattern, flags, instruction, entity_type, action,
        mask_mode, mask_keep_last, mask_keep_first, enabled, priority, builtin, created_at, updated_at)
     VALUES (?, 'global', '', ?, ?, ?, ?, 'g', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const rule of rules) {
    insert.run(
      newId('prv'),
      rule.code,
      rule.name,
      rule.kind,
      rule.pattern ?? null,
      rule.instruction ?? null,
      rule.entityType,
      rule.action,
      rule.maskMode,
      rule.keepLast,
      rule.keepFirst,
      rule.enabled,
      rule.priority,
      at,
      at,
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
