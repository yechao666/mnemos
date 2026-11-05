import type { DatabaseSync } from 'node:sqlite';
import type { Env } from './env.ts';
import type { Logger } from './contracts.ts';
import { tableCount } from './db/index.ts';
import { newId, nowIso } from './lib/ids.ts';
import { hashPassword } from './lib/password.ts';

export interface BootstrapResult {
  orgId: string;
  userId: string;
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertPassword(password: string): void {
  if (password.length < 10) throw new Error('MNEMOS_BOOTSTRAP_PASSWORD 至少 10 位');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('MNEMOS_BOOTSTRAP_PASSWORD 必须同时包含字母与数字');
  }
}

/**
 * 生产模式首次启动：没有用户时创建初始组织与 owner。
 * 演示模式（MNEMOS_DEMO=1）由 seed 负责，不走这里。
 */
export function bootstrapAdminIfNeeded(db: DatabaseSync, env: Env, logger: Logger): BootstrapResult | null {
  if (tableCount(db, 'users') > 0) return null;

  const email = env.bootstrapEmail?.trim().toLowerCase();
  const password = env.bootstrapPassword ?? '';
  if (!email || !password) {
    throw new Error(
      '数据库中没有用户：生产模式需要设置 MNEMOS_BOOTSTRAP_EMAIL 与 MNEMOS_BOOTSTRAP_PASSWORD 以创建初始管理员；' +
        '演示环境可设置 MNEMOS_DEMO=1。',
    );
  }
  if (!EMAIL_RE.test(email)) throw new Error(`MNEMOS_BOOTSTRAP_EMAIL 非法：${email}`);
  assertPassword(password);

  const at = nowIso();
  const orgId = newId('org');
  const userId = newId('usr');
  const orgName = env.bootstrapOrgName?.trim() || '默认组织';
  const slugBase = (env.bootstrapOrgSlug?.trim() || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = slugBase || 'default';

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
      orgId,
      orgName,
      slug,
      'enterprise',
      at,
    );
    db.prepare(
      `INSERT INTO users
         (id, org_id, email, name, role, title, avatar_color, password_hash, status, password_changed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      userId,
      orgId,
      email,
      env.bootstrapName?.trim() || '平台管理员',
      'owner',
      '平台所有者',
      'violet',
      hashPassword(password),
      at,
      at,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  logger.warn('已创建初始管理员，请登录后立即修改密码并吊销临时凭证', {
    email,
    org: orgName,
  });
  return { orgId, userId, email };
}
