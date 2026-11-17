import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptField, encryptField, encryptionKeyFromEnv, isEncryptedField } from './crypto.ts';

/** v6.1 P2：可选字段加密（AES-256-GCM）单元测试。 */

const KEY_ENV = 'MNEMOS_ENCRYPTION_KEY';

function withKey<T>(key: string | undefined, fn: () => T): T {
  const saved = process.env[KEY_ENV];
  try {
    if (key === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = key;
    return fn();
  } finally {
    if (saved === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = saved;
  }
}

test('crypto：未配置密钥时明文透传（零迁移成本）', () => {
  withKey(undefined, () => {
    assert.equal(encryptionKeyFromEnv(), null);
    const url = 'https://cdn.example.com/media/login.png';
    assert.equal(encryptField(url), url);
    assert.equal(decryptField(url), url);
    assert.equal(isEncryptedField(url), false);
  });
});

test('crypto：配置密钥后 AES-256-GCM roundtrip + v1:iv:tag:cipher 格式', () => {
  withKey('p2-test-encryption-key', () => {
    assert.ok(encryptionKeyFromEnv());
    const url = 'https://cdn.example.com/media/secret-doc.pdf?token=abc';
    const encrypted = encryptField(url);
    assert.notEqual(encrypted, url);
    assert.ok(isEncryptedField(encrypted));
    const parts = encrypted.split(':');
    assert.equal(parts.length, 4, '密文格式应为 v1:base64(iv):base64(tag):base64(cipher)');
    assert.equal(parts[0], 'v1');
    for (const part of parts.slice(1)) assert.ok(Buffer.from(part, 'base64').length > 0);
    assert.equal(decryptField(encrypted), url);
    // 随机 IV：相同明文两次密文不同
    assert.notEqual(encryptField(url), encrypted);
    // 历史明文仍可读
    assert.equal(decryptField('legacy-plain-url'), 'legacy-plain-url');
    // 空字符串不加密
    assert.equal(encryptField(''), '');
  });
});

test('crypto：密钥不匹配 / 密文损坏时报错（不静默返回密文）', () => {
  withKey('key-one', () => {
    const encrypted = encryptField('https://example.com/a.png');
    withKey('key-two', () => {
      assert.throws(() => decryptField(encrypted), /无法解密/);
    });
    assert.throws(() => decryptField('v1:bad'), /格式非法/);
  });
  withKey(undefined, () => {
    const saved = process.env[KEY_ENV];
    process.env[KEY_ENV] = 'key-one';
    const encrypted = encryptField('https://example.com/b.png');
    if (saved === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = saved;
    assert.throws(() => decryptField(encrypted), /MNEMOS_ENCRYPTION_KEY/);
  });
});
