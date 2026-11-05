import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  newWebhookSecret,
  parseSignatureHeader,
  signPayload,
  verifySignature,
} from './signature.ts';

const SECRET = newWebhookSecret();
const BODY = JSON.stringify({ id: 'evt_1', type: 'memory.created', data: { text: '中文载荷' } });
const TIMESTAMP = 1_700_000_000;

test('secret 格式为 whsec_<base64url 32B>，且每次不同', () => {
  const first = newWebhookSecret();
  const second = newWebhookSecret();
  assert.match(first, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.length, 'whsec_'.length + 43);
  assert.notEqual(first, second);
});

test('signPayload 生成 t=..,v1=..，同输入结果稳定', () => {
  const header = signPayload(SECRET, BODY, TIMESTAMP);
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.equal(header, signPayload(SECRET, BODY, TIMESTAMP));
  assert.notEqual(header, signPayload(SECRET, `${BODY} `, TIMESTAMP));
});

test('verifySignature 接受正确签名（含时间戳容差）', () => {
  const header = signPayload(SECRET, BODY, TIMESTAMP);
  assert.equal(verifySignature(SECRET, BODY, header, { nowSeconds: TIMESTAMP }), true);
  assert.equal(
    verifySignature(SECRET, BODY, header, {
      nowSeconds: TIMESTAMP + DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
    }),
    true,
  );
  assert.equal(
    verifySignature(SECRET, BODY, header, {
      nowSeconds: TIMESTAMP + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1,
    }),
    false,
  );
});

test('篡改 body / 错误 secret / 格式错误均验签失败', () => {
  const header = signPayload(SECRET, BODY, TIMESTAMP);
  assert.equal(verifySignature(SECRET, `${BODY}x`, header, { nowSeconds: TIMESTAMP }), false);
  assert.equal(verifySignature(newWebhookSecret(), BODY, header, { nowSeconds: TIMESTAMP }), false);
  assert.equal(verifySignature(SECRET, BODY, '', { nowSeconds: TIMESTAMP }), false);
  assert.equal(verifySignature(SECRET, BODY, 'v1=deadbeef', { nowSeconds: TIMESTAMP }), false);
  assert.equal(verifySignature(SECRET, BODY, 't=nan,v1=deadbeef', { nowSeconds: TIMESTAMP }), false);
  assert.equal(
    verifySignature(SECRET, BODY, `t=${TIMESTAMP},v1=${'0'.repeat(64)}`, { nowSeconds: TIMESTAMP }),
    false,
  );
});

test('parseSignatureHeader 解析 t/v1 并忽略未知字段', () => {
  const header = `t=${TIMESTAMP},v1=${'a'.repeat(64)}`;
  assert.deepEqual(parseSignatureHeader(header), {
    timestamp: TIMESTAMP,
    signature: 'a'.repeat(64),
  });
  assert.deepEqual(parseSignatureHeader(`t=${TIMESTAMP}, v2=zzz, v1=${'b'.repeat(64)}`), {
    timestamp: TIMESTAMP,
    signature: 'b'.repeat(64),
  });
  assert.equal(parseSignatureHeader('t=1'), null);
  assert.equal(parseSignatureHeader('t=1,v1=xyz'), null);
});
