import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupInfo } from '../../../shared/src/types.ts';
import type { BackupController, Logger } from '../contracts.ts';
import { ensureDir, type Env } from '../env.ts';
import { writeAudit } from '../lib/audit.ts';

/**
 * 备份控制器：SQLite `VACUUM INTO` 生成一致性快照，滚动保留最近 14 份。
 * 文件命名：mnemos-YYYYMMDD-HHmmss-<kind>.db（UTC 时间，便于排序）。
 */

const BACKUP_FILE_PATTERN = /^[A-Za-z0-9._-]+\.db$/;
const BACKUP_NAME_PATTERN = /^mnemos-(\d{8})-(\d{6})-(manual|scheduled|preflight)\.db$/;
const MAX_BACKUPS = 14;
const COLLISION_RETRIES = 40;

export interface BackupDeps {
  db: DatabaseSync;
  env: Env;
  logger: Logger;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function timestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function kindOf(fileName: string): BackupInfo['kind'] {
  const match = BACKUP_NAME_PATTERN.exec(fileName);
  const kind = match?.[3];
  return kind === 'scheduled' || kind === 'preflight' ? kind : 'manual';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/** 备份文件 → BackupInfo；id 由文件名派生，扫描多次结果稳定。 */
function toInfo(fullPath: string, fileName: string): BackupInfo | null {
  try {
    const stat = statSync(fullPath);
    if (!stat.isFile()) return null;
    return {
      id: `bak_${fileName.replace(/\.db$/, '')}`,
      file: fileName,
      sizeBytes: stat.size,
      createdAt: stat.mtime.toISOString(),
      kind: kindOf(fileName),
    };
  } catch {
    return null;
  }
}

export function createBackupController(deps: BackupDeps): BackupController {
  const { db, env, logger } = deps;
  const backupDir = resolve(env.backupDir);

  function scan(): BackupInfo[] {
    let names: string[];
    try {
      names = readdirSync(backupDir);
    } catch {
      return [];
    }
    const infos: BackupInfo[] = [];
    for (const name of names) {
      if (!BACKUP_FILE_PATTERN.test(name)) continue;
      if (!name.startsWith('mnemos-')) continue;
      const info = toInfo(join(backupDir, name), name);
      if (info) infos.push(info);
    }
    return infos.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.file < b.file ? 1 : -1));
  }

  function prune(): void {
    const infos = scan();
    if (infos.length <= MAX_BACKUPS) return;
    for (const info of infos.slice(MAX_BACKUPS)) {
      try {
        unlinkSync(join(backupDir, info.file));
        logger.info('backup.pruned', { file: info.file, kept: MAX_BACKUPS });
      } catch (error) {
        logger.warn('backup.prune_failed', { file: info.file, error });
      }
    }
  }

  function audit(action: string, actor: string | undefined, info: BackupInfo): void {
    try {
      writeAudit(db, {
        actor: actor
          ? { type: 'user', id: 'ops', label: actor }
          : { type: 'system', id: 'system', label: 'system' },
        action,
        resourceType: 'backup',
        resourceId: info.id,
        detail: { file: info.file, kind: info.kind, sizeBytes: info.sizeBytes },
      });
    } catch (error) {
      logger.warn('backup.audit_failed', { file: info.file, error });
    }
  }

  async function create(kind: BackupInfo['kind'], actor?: string): Promise<BackupInfo> {
    ensureDir(backupDir);
    let fileName = `mnemos-${timestamp(new Date())}-${kind}.db`;
    for (let attempt = 0; attempt < COLLISION_RETRIES && existsSync(join(backupDir, fileName)); attempt += 1) {
      // 同一秒内连续备份：等待时钟推进，保持命名规范不引入额外后缀。
      await sleep(25);
      fileName = `mnemos-${timestamp(new Date())}-${kind}.db`;
    }
    const fullPath = join(backupDir, fileName);
    if (!fullPath.startsWith(backupDir + sep)) {
      throw new Error(`备份路径越界：${fileName}`);
    }
    if (existsSync(fullPath)) {
      throw new Error(`备份文件已存在：${fileName}`);
    }

    const escaped = fullPath.replace(/'/g, "''");
    try {
      db.exec(`VACUUM INTO '${escaped}'`);
    } catch (error) {
      logger.error('backup.failed', { file: fileName, error });
      throw error;
    }

    const info = toInfo(fullPath, fileName);
    if (!info) throw new Error(`备份文件写入后不可读：${fileName}`);
    audit('ops.backup.created', actor, info);
    logger.info('backup.created', { file: info.file, kind: info.kind, sizeBytes: info.sizeBytes, actor });
    prune();
    return info;
  }

  function list(): BackupInfo[] {
    return scan();
  }

  /** 仅接受 basename 且匹配 `^[A-Za-z0-9._-]+\.db$`，并必须真实存在于备份目录。 */
  function pathOf(fileName: string): string | null {
    if (!fileName || fileName !== basename(fileName)) return null;
    if (!BACKUP_FILE_PATTERN.test(fileName)) return null;
    const fullPath = resolve(backupDir, fileName);
    if (!fullPath.startsWith(backupDir + sep)) return null;
    if (!existsSync(fullPath)) return null;
    try {
      const stat = statSync(fullPath);
      return stat.isFile() ? fullPath : null;
    } catch {
      return null;
    }
  }

  return { create, list, pathOf };
}
