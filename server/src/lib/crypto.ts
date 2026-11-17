import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * v6.1 P2 可选字段级加密（AES-256-GCM）。
 *
 * - 密钥来自环境变量 `MNEMOS_ENCRYPTION_KEY`（任意字符串，内部 SHA-256 派生 32 字节 key）。
 * - 未配置时所有函数原样返回明文（零成本、零迁移）。
 * - 密文格式：`v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>`；读取时按前缀识别，
 *   历史明文数据仍可原样读出（不会因为开启加密而损坏旧数据）。
 * - 只加密敏感短字段（目前仅 memory_attachments.url），不加密 memories.content，
 *   避免破坏 FTS / embedding / 去重哈希。
 */

export const ENCRYPTION_ENV_KEY = 'MNEMOS_ENCRYPTION_KEY';
export const ENCRYPTED_PREFIX = 'v1';

const IV_BYTES = 12;

export function encryptionKeyFromEnv(value: string | undefined = process.env[ENCRYPTION_ENV_KEY]): Buffer | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** 密文是否为本模块产出的 v1 格式（用于读取时判断是否需要解密）。 */
export function isEncryptedField(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${ENCRYPTED_PREFIX}:`);
}

/**
 * 加密字段；未配置密钥或空值时原样返回。
 * 每次调用随机 IV，保证相同明文得到不同密文。
 */
export function encryptField(plaintext: string, key: Buffer | null = encryptionKeyFromEnv()): string {
  if (!key || plaintext === '') return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTED_PREFIX,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * 解密字段：非 v1 密文（历史明文）原样返回；密文但无密钥时抛错（避免把密文当 URL 使用）。
 * 密钥不匹配 / 数据损坏时 GCM 校验失败，抛错提示。
 */
export function decryptField(value: string, key: Buffer | null = encryptionKeyFromEnv()): string {
  if (!isEncryptedField(value)) return value;
  if (!key) throw new Error('检测到加密附件 URL，但未配置 MNEMOS_ENCRYPTION_KEY，无法解密');
  const parts = value.split(':');
  if (parts.length !== 4) throw new Error('加密字段格式非法（期望 v1:iv:tag:cipher）');
  const [, ivPart, tagPart, cipherPart] = parts;
  try {
    const iv = Buffer.from(ivPart ?? '', 'base64');
    const tag = Buffer.from(tagPart ?? '', 'base64');
    const ciphertext = Buffer.from(cipherPart ?? '', 'base64');
    if (iv.length !== IV_BYTES) throw new Error('IV 长度非法');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error(
      `无法解密字段：${error instanceof Error ? error.message : String(error)}（密钥不匹配或数据损坏）`,
    );
  }
}
