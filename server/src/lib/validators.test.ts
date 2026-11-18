import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VALIDATOR_NAMES,
  btcValid,
  cnIdValid,
  coordinatesValid,
  ethValid,
  ibanValid,
  ipv4Valid,
  ipv6Valid,
  jwtValid,
  luhnValid,
  macValid,
  usItinValid,
  usSsnValid,
  usccValid,
  uuidValid,
  validateValue,
  vinValid,
} from '../lib/validators.ts';

/** v6.3 隐私规则库：每个 validator 的正例 / 反例。 */

test('validators：luhn（银行卡 / IMEI）', () => {
  assert.equal(luhnValid('4111 1111 1111 1111'), true);
  assert.equal(luhnValid('490154203237518'), true, 'IMEI 15 位');
  assert.equal(luhnValid('4111111111111112'), false);
  assert.equal(luhnValid('12345678901'), false, '长度 < 12');
});

test('validators：cn_id（GB11643 校验位 + 出生日期）', () => {
  assert.equal(cnIdValid('11010519491231002X'), true);
  assert.equal(cnIdValid('11010519491231002x'), true, '小写 x 兼容');
  assert.equal(cnIdValid('110105194912310021'), false, '校验位错误');
  assert.equal(cnIdValid('11010519491332002X'), false, '13 月非法日期');
  assert.equal(cnIdValid('11010519490230002X'), false, '2 月 30 日非法');
  assert.equal(cnIdValid('1101051949123100'), false, '长度不足');
});

test('validators：us_ssn / us_itin', () => {
  assert.equal(usSsnValid('123-45-6789'), true);
  assert.equal(usSsnValid('123456789'), true, '无分隔符兼容');
  assert.equal(usSsnValid('000-12-3456'), false, '区号 000');
  assert.equal(usSsnValid('666-12-3456'), false, '区号 666');
  assert.equal(usSsnValid('900-12-3456'), false, '区号 9xx');
  assert.equal(usSsnValid('123-00-6789'), false, '组号 00');
  assert.equal(usSsnValid('123-45-0000'), false, '序号 0000');

  assert.equal(usItinValid('912-70-1234'), true);
  assert.equal(usItinValid('912-80-1234'), true);
  assert.equal(usItinValid('912-90-1234'), true);
  assert.equal(usItinValid('912-60-1234'), false, '中间组首位非 7/8/9');
  assert.equal(usItinValid('812-70-1234'), false, '非 9 开头');
  assert.equal(usItinValid('912-70-0000'), false, '序号 0000');
});

test('validators：iban（mod 97）', () => {
  assert.equal(ibanValid('GB82WEST12345698765432'), true);
  assert.equal(ibanValid('GB82 WEST 1234 5698 7654 32'), true, '忽略空格');
  assert.equal(ibanValid('GB82WEST12345698765431'), false, '校验位错误');
  assert.equal(ibanValid('GB82'), false, '长度不足');
  assert.equal(ibanValid('1B82WEST12345698765432'), false, '国家码非字母');
});

test('validators：vin（17 位 + 第 9 位校验位）', () => {
  assert.equal(vinValid('1HGCM82633A004352'), true);
  assert.equal(vinValid('1hgcm82633a004352'), true, '小写兼容');
  assert.equal(vinValid('1HGCM82633A004353'), false, '校验位错误');
  assert.equal(vinValid('1HGCM82633A00435I'), false, '含非法字符 I');
  assert.equal(vinValid('1HGCM82633A00435'), false, '长度不足');
});

test('validators：ipv4 / ipv6（node:net isIP）', () => {
  assert.equal(ipv4Valid('192.168.1.1'), true);
  assert.equal(ipv4Valid('0.0.0.0'), true);
  assert.equal(ipv4Valid('256.1.1.1'), false, '段越界');
  assert.equal(ipv4Valid('192.168.1'), false);
  assert.equal(ipv4Valid('2001:db8::1'), false, 'ipv6 不是 ipv4');

  assert.equal(ipv6Valid('2001:db8::1'), true);
  assert.equal(ipv6Valid('::1'), true);
  assert.equal(ipv6Valid('2001:db8:::1'), false);
  assert.equal(ipv6Valid('192.168.1.1'), false);
});

test('validators：mac', () => {
  assert.equal(macValid('00:1A:2B:3C:4D:5E'), true);
  assert.equal(macValid('00-1a-2b-3c-4d-5e'), true);
  assert.equal(macValid('001a.2b3c.4d5e'), true, 'Cisco 风格');
  assert.equal(macValid('00:1A:2B:3C:4D'), false);
  assert.equal(macValid('GG:1A:2B:3C:4D:5E'), false);
});

test('validators：jwt（3 段 base64url + header.alg）', () => {
  const valid =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(jwtValid(valid), true);
  assert.equal(jwtValid('abc.def'), false, '只有 2 段');
  assert.equal(jwtValid('abc.def.ghi!'), false, '非法 base64url 字符');

  const noAlgHeader = Buffer.from(JSON.stringify({ typ: 'JWT' })).toString('base64url');
  assert.equal(jwtValid(`${noAlgHeader}.e30.c2ln`), false, 'header 缺 alg');
  const notJsonHeader = Buffer.from('not-json').toString('base64url');
  assert.equal(jwtValid(`${notJsonHeader}.e30.c2ln`), false, 'header 非 JSON');
});

test('validators：uscc（统一社会信用代码 mod 31）', () => {
  assert.equal(usccValid('91350100M000100Y43'), true);
  assert.equal(usccValid('913101150764381666'), true);
  assert.equal(usccValid('91350100M000100Y44'), false, '校验位错误');
  assert.equal(usccValid('91350100M000100Y4'), false, '长度不足');
  assert.equal(usccValid('91350100M000100Y4I'), false, '含非法字符 I');
});

test('validators：eth', () => {
  assert.equal(ethValid('0x52908400098527886E0F7030069857D2E4169EE7'), true);
  assert.equal(ethValid('0x52908400098527886e0f7030069857d2e4169ee7'), true);
  assert.equal(ethValid('0x52908400098527886E0F7030069857D2E4169EE'), false, '长度不足');
  assert.equal(ethValid('52908400098527886E0F7030069857D2E4169EE7'), false, '缺 0x');
});

test('validators：btc（base58check，P2PKH / P2SH）', () => {
  assert.equal(btcValid('1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), true);
  assert.equal(btcValid('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), true, 'P2SH');
  assert.equal(btcValid('1BoatSLRHtKNngkdXEeobR76b53LETtpyU'), false, '校验和错误');
  assert.equal(btcValid('2BoatSLRHtKNngkdXEeobR76b53LETtpyT'), false, '版本字节非法');
  assert.equal(btcValid('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7k'), false, 'bech32 不是 base58check');
});

test('validators：coordinates（lat,lng 范围）', () => {
  assert.equal(coordinatesValid('39.9042,116.4074'), true);
  assert.equal(coordinatesValid('39.9042，116.4074'), true, '中文逗号');
  assert.equal(coordinatesValid('-90.000,-180.000'), true);
  assert.equal(coordinatesValid('91.0,116.4'), false, '纬度越界');
  assert.equal(coordinatesValid('39.9,200.0'), false, '经度越界');
  assert.equal(coordinatesValid('39.9'), false, '缺少经度');
});

test('validators：uuid', () => {
  assert.equal(uuidValid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(uuidValid('550E8400-E29B-41D4-A716-446655440000'), true);
  assert.equal(uuidValid('550e8400e29b41d4a716446655440000'), false);
  assert.equal(uuidValid('550e8400-e29b-41d4-a716-44665544000'), false);
});

test('validateValue：none / 未知 validator fail-open / 统一入口', () => {
  assert.equal(validateValue(undefined, 'anything'), true);
  assert.equal(validateValue('', 'anything'), true);
  assert.equal(validateValue('none', 'anything'), true);
  assert.equal(validateValue('unknown-validator', 'anything'), true, '未知 validator fail-open');
  assert.equal(validateValue('luhn', '4111111111111111'), true);
  assert.equal(validateValue('luhn', '4111111111111112'), false);
  assert.equal(validateValue('CN_ID', '11010519491231002X'), true, '大小写兼容');
  for (const name of VALIDATOR_NAMES) {
    assert.equal(typeof name, 'string');
  }
});
