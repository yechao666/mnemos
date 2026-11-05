import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUrlSafeForDelivery,
  assertWebhookUrl,
  classifyAddress,
  parseIpv6,
  WebhookUrlError,
} from './ssrf.ts';

function resolver(map: Record<string, string[]>): (hostname: string) => Promise<string[]> {
  return async (hostname: string) => {
    const value = map[hostname];
    if (!value) throw new Error(`ENOTFOUND ${hostname}`);
    return value;
  };
}

function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebhookUrlError, `期望 WebhookUrlError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('回环地址：默认拒绝，allowPrivate 放行', async () => {
  await rejectsWithCode(assertUrlSafeForDelivery('http://127.0.0.1:8080/hook'), 'private_address');
  const allowed = await assertUrlSafeForDelivery('http://127.0.0.1:8080/hook', { allowPrivate: true });
  assert.equal(allowed.hostname, '127.0.0.1');

  await rejectsWithCode(assertUrlSafeForDelivery('http://localhost/hook'), 'private_address');
  await assertUrlSafeForDelivery('http://localhost/hook', { allowPrivate: true });
});

test('私网 10.x / 172.16 / 192.168：默认拒绝，allowPrivate 放行', async () => {
  for (const url of ['http://10.1.2.3/hook', 'http://172.20.0.9/hook', 'http://192.168.1.10/hook']) {
    await rejectsWithCode(assertUrlSafeForDelivery(url), 'private_address');
    await assertUrlSafeForDelivery(url, { allowPrivate: true });
  }
});

test('链路本地地址（非元数据）即使 allowPrivate 也拒绝', async () => {
  await rejectsWithCode(assertUrlSafeForDelivery('http://169.254.1.1/hook', { allowPrivate: true }), 'private_address');
  await rejectsWithCode(assertUrlSafeForDelivery('http://[fe80::1]/hook', { allowPrivate: true }), 'private_address');
});

test('云元数据地址始终拒绝（即使 allowPrivate）', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials',
    'http://100.100.100.200/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
  ]) {
    await rejectsWithCode(assertUrlSafeForDelivery(url, { allowPrivate: true }), 'metadata_address');
    await rejectsWithCode(assertUrlSafeForDelivery(url), 'metadata_address');
  }
  await rejectsWithCode(assertUrlSafeForDelivery('http://metadata.google.internal/hook'), 'metadata_address');
});

test('仅允许 http/https：file:/data:/gopher 等拒绝', async () => {
  for (const url of ['file:///etc/passwd', 'data:text/plain;base64,SGVsbG8=', 'gopher://example.com/']) {
    await rejectsWithCode(assertUrlSafeForDelivery(url), 'invalid_protocol');
  }
});

test('URL 内用户名密码、超长、非法端口被拒绝', () => {
  assert.throws(
    () => assertWebhookUrl('https://user:pass@example.com/hook'),
    (error: unknown) => error instanceof WebhookUrlError && error.code === 'credentials_not_allowed',
  );
  assert.throws(
    () => assertWebhookUrl(`https://example.com/${'a'.repeat(2_050)}`),
    (error: unknown) => error instanceof WebhookUrlError && error.code === 'url_too_long',
  );
  assert.throws(
    () => assertWebhookUrl('http://example.com:0/hook'),
    (error: unknown) => error instanceof WebhookUrlError && error.code === 'invalid_port',
  );
  assert.throws(() => assertWebhookUrl('http://example.com:70000/hook'), (error: unknown) => {
    return error instanceof WebhookUrlError && (error.code === 'invalid_port' || error.code === 'invalid_url');
  });
});

test('公网域名解析到公网 IP 时通过', async () => {
  const url = await assertUrlSafeForDelivery('https://hooks.example.com/mnemos', {
    resolveHost: resolver({ 'hooks.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] }),
  });
  assert.equal(url.protocol, 'https:');
});

test('DNS 解析失败 / 空结果拒绝（fail closed）', async () => {
  await rejectsWithCode(
    assertUrlSafeForDelivery('https://missing.example.com/hook', {
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
    }),
    'dns_failed',
  );
  await rejectsWithCode(
    assertUrlSafeForDelivery('https://empty.example.com/hook', { resolveHost: async () => [] }),
    'dns_failed',
  );
  await rejectsWithCode(
    assertUrlSafeForDelivery('https://exfil.example.com/hook', { resolveHost: async () => ['10.0.0.7'] }),
    'private_address',
  );
});

test('同步创建校验拦截字面量内网地址与 localhost，但放行公网域名', () => {
  assert.throws(
    () => assertWebhookUrl('https://10.0.0.1/hook'),
    (error: unknown) => error instanceof WebhookUrlError && error.code === 'private_address',
  );
  assert.throws(
    () => assertWebhookUrl('http://127.0.0.1/hook'),
    (error: unknown) => error instanceof WebhookUrlError && error.code === 'private_address',
  );
  assert.throws(
    () => assertWebhookUrl('http://169.254.169.254/latest/meta-data/'),
    (error: unknown) => error instanceof WebhookUrlError && error.code === 'metadata_address',
  );
  // 公网域名与公网 IP 保存阶段直接放行，投递前再做完整 DNS 校验。
  assert.equal(assertWebhookUrl('https://hooks.example.com/mnemos').hostname, 'hooks.example.com');
  assert.equal(assertWebhookUrl('https://93.184.216.34/hook').hostname, '93.184.216.34');
  assert.equal(assertWebhookUrl('http://127.0.0.1/hook', { allowPrivate: true }).hostname, '127.0.0.1');
});

test('classifyAddress 覆盖 IPv4 / IPv6 / IPv4 映射', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('10.0.0.1'), 'private');
  assert.equal(classifyAddress('172.31.255.255'), 'private');
  assert.equal(classifyAddress('192.168.0.1'), 'private');
  assert.equal(classifyAddress('169.254.169.254'), 'metadata');
  assert.equal(classifyAddress('169.254.1.1'), 'link-local');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('fd00::1'), 'private');
  assert.equal(classifyAddress('fe80::1'), 'link-local');
  assert.equal(classifyAddress('fd00:ec2::254'), 'metadata');
  assert.equal(classifyAddress('::ffff:10.0.0.1'), 'private');
  assert.equal(classifyAddress('2001:4860:4860::8888'), 'public');
});

test('parseIpv6 正确处理压缩与内嵌 IPv4', () => {
  assert.equal(parseIpv6('::1')?.length, 16);
  assert.deepEqual(parseIpv6('::1')?.slice(15), [1]);
  assert.equal(parseIpv6('not-an-ip'), null);
  assert.deepEqual(parseIpv6('::ffff:127.0.0.1')?.slice(12), [127, 0, 0, 1]);
});
