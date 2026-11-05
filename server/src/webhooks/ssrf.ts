import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Webhook SSRF 防护。
 *
 * 两阶段：
 *  1. `parseWebhookUrl` / `assertWebhookUrl`：同步校验协议、凭据、端口、长度，
 *     并对字面量 IP / localhost / 元数据主机名做同步拒绝（创建/更新时使用）。
 *  2. `assertUrlSafeForDelivery`：额外解析 DNS，逐个地址判定，投递前必须调用
 *     （DNS rebinding 与域名解析到内网都能被拦截）。
 *
 * `allowPrivate`（MNEMOS_WEBHOOK_ALLOW_PRIVATE=1）仅放行 loopback / 私网 / 链路本地，
 * 云元数据地址始终拒绝。
 */

export const MAX_WEBHOOK_URL_LENGTH = 2048;

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'reserved'
  | 'unspecified'
  | 'multicast';

export type WebhookUrlErrorCode =
  | 'url_too_long'
  | 'invalid_url'
  | 'invalid_protocol'
  | 'credentials_not_allowed'
  | 'missing_host'
  | 'invalid_port'
  | 'dns_failed'
  | 'metadata_address'
  | 'private_address'
  | 'reserved_address';

export class WebhookUrlError extends Error {
  readonly code: WebhookUrlErrorCode;

  constructor(code: WebhookUrlErrorCode, message: string) {
    super(message);
    this.name = 'WebhookUrlError';
    this.code = code;
  }
}

export interface WebhookUrlGuardOptions {
  allowPrivate?: boolean;
  /** 测试注入：解析主机名到 IP 列表；默认使用 dns.lookup。 */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.tencentyun.com',
]);

const METADATA_ADDRESSES = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200']);

const LOCALHOST_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

interface Ipv6Metadata {
  bytes: number[];
  label: string;
}

function parseIpv6Constant(value: string): Ipv6Metadata {
  const bytes = parseIpv6(value);
  if (!bytes) throw new Error(`内置 IPv6 常量非法：${value}`);
  return { bytes, label: value };
}

const METADATA_IPV6: Ipv6Metadata[] = [parseIpv6Constant('fd00:ec2::254')];

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) return lower.slice(1, -1);
  return lower;
}

function isLocalhostHostname(host: string): boolean {
  return LOCALHOST_HOSTNAMES.has(host) || host.endsWith('.localhost');
}

/**
 * 同步 URL 形状校验：
 *  - 仅 http/https；禁止 file:/data: 等；
 *  - 禁止 URL 内嵌用户名/密码；
 *  - 长度 ≤ 2048；显式端口 1–65535。
 */
export function parseWebhookUrl(raw: string): URL {
  if (typeof raw !== 'string') {
    throw new WebhookUrlError('invalid_url', 'Webhook URL 必须是字符串');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new WebhookUrlError('invalid_url', 'Webhook URL 不能为空');
  if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
    throw new WebhookUrlError('url_too_long', `Webhook URL 长度不能超过 ${MAX_WEBHOOK_URL_LENGTH} 字符`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebhookUrlError('invalid_url', 'Webhook URL 格式不合法');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebhookUrlError('invalid_protocol', `Webhook 仅支持 http/https，收到 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new WebhookUrlError('credentials_not_allowed', 'Webhook URL 不允许包含用户名或密码');
  }
  if (!url.hostname) {
    throw new WebhookUrlError('missing_host', 'Webhook URL 缺少主机名');
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new WebhookUrlError('invalid_port', `Webhook 端口不合法：${url.port}`);
    }
  }
  return url;
}

/**
 * 创建/更新时的同步防护：协议、形状 + 字面量地址与已知元数据主机名。
 * 域名在保存时不做 DNS 解析（离线/内网环境也能创建），投递前再做完整校验。
 */
export function assertWebhookUrl(raw: string, options: { allowPrivate?: boolean } = {}): URL {
  const url = parseWebhookUrl(raw);
  const host = normalizeHostname(url.hostname);

  if (METADATA_HOSTNAMES.has(host)) {
    throw new WebhookUrlError('metadata_address', '目标主机指向云元数据服务，已拒绝');
  }
  if (isLocalhostHostname(host)) {
    if (!options.allowPrivate) {
      throw new WebhookUrlError(
        'private_address',
        '目标地址为回环地址，已拒绝（本地测试可设置 MNEMOS_WEBHOOK_ALLOW_PRIVATE=1）',
      );
    }
    return url;
  }
  if (isIP(host) !== 0) {
    assertAddressAllowed(classifyAddress(host), options.allowPrivate === true);
  }
  return url;
}

/**
 * 投递前的完整 SSRF 校验：解析 DNS 并逐个地址判定，任一地址被禁止即拒绝。
 * DNS 解析失败也拒绝（fail closed）。
 */
export async function assertUrlSafeForDelivery(
  raw: string,
  options: WebhookUrlGuardOptions = {},
): Promise<URL> {
  const url = parseWebhookUrl(raw);
  const host = normalizeHostname(url.hostname);

  if (METADATA_HOSTNAMES.has(host)) {
    throw new WebhookUrlError('metadata_address', '目标主机指向云元数据服务，已拒绝');
  }

  let addresses: string[];
  if (isLocalhostHostname(host)) {
    addresses = ['127.0.0.1', '::1'];
  } else if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    const resolver = options.resolveHost ?? defaultResolveHost;
    try {
      addresses = await resolver(host);
    } catch {
      throw new WebhookUrlError('dns_failed', `无法解析 Webhook 主机名：${host}`);
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new WebhookUrlError('dns_failed', `无法解析 Webhook 主机名：${host}`);
    }
  }

  for (const address of addresses) {
    assertAddressAllowed(classifyAddress(address), options.allowPrivate === true);
  }
  return url;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function assertAddressAllowed(addressClass: AddressClass, allowPrivate: boolean): void {
  if (addressClass === 'public') return;
  if (addressClass === 'metadata') {
    throw new WebhookUrlError('metadata_address', '目标地址指向云元数据服务，已拒绝');
  }
  if (addressClass === 'loopback') {
    if (allowPrivate) return;
    throw new WebhookUrlError(
      'private_address',
      '目标地址为回环地址，已拒绝（本地测试可设置 MNEMOS_WEBHOOK_ALLOW_PRIVATE=1）',
    );
  }
  if (addressClass === 'private') {
    if (allowPrivate) return;
    throw new WebhookUrlError(
      'private_address',
      '目标地址属于私网网段，已拒绝（本地测试可设置 MNEMOS_WEBHOOK_ALLOW_PRIVATE=1）',
    );
  }
  if (addressClass === 'link-local') {
    // allowPrivate 仅放行 loopback / 私网；链路本地（169.254.0.0/16、fe80::/10）始终拒绝。
    throw new WebhookUrlError('private_address', '目标地址属于链路本地网段，已拒绝');
  }
  if (addressClass === 'multicast') {
    throw new WebhookUrlError('reserved_address', '目标地址属于组播/保留网段，已拒绝');
  }
  if (addressClass === 'unspecified') {
    throw new WebhookUrlError('reserved_address', '目标地址为未指定地址（0.0.0.0 等），已拒绝');
  }
  throw new WebhookUrlError('reserved_address', '目标地址属于保留网段，已拒绝');
}

/** 地址归类（导出供测试/诊断）。无法解析的地址按 reserved 处理（拒绝）。 */
export function classifyAddress(address: string): AddressClass {
  const normalized = normalizeHostname(address.trim());
  const family = isIP(normalized);
  if (family === 4) return classifyIpv4(normalized);
  if (family === 6) return classifyIpv6(normalized);
  return 'reserved';
}

function classifyIpv4(address: string): AddressClass {
  if (METADATA_ADDRESSES.has(address)) return 'metadata';
  const octets = address.split('.').map((part) => Number(part));
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  const third = octets[2] ?? 0;

  if (first === 0) return 'unspecified';
  if (first === 127) return 'loopback';
  if (first === 10) return 'private';
  if (first === 172 && second >= 16 && second <= 31) return 'private';
  if (first === 192 && second === 168) return 'private';
  // CGNAT 100.64.0.0/10
  if (first === 100 && second >= 64 && second <= 127) return 'private';
  if (first === 169 && second === 254) return 'link-local';
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return 'reserved';
  if (first === 192 && second === 88 && third === 99) return 'reserved';
  if (first === 198 && (second === 18 || second === 19)) return 'reserved';
  if (first === 198 && second === 51 && third === 100) return 'reserved';
  if (first === 203 && second === 0 && third === 113) return 'reserved';
  if (first >= 224 && first <= 239) return 'multicast';
  if (first >= 240) return 'reserved';
  return 'public';
}

function classifyIpv6(address: string): AddressClass {
  const bytes = parseIpv6(address);
  if (!bytes) return 'reserved';

  // ::ffff:a.b.c.d（IPv4 映射）
  const prefixZero = bytes.slice(0, 10).every((byte) => byte === 0);
  if (prefixZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classifyIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  // NAT64 64:ff9b::/96
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return classifyIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes.every((byte) => byte === 0)) return 'unspecified';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'loopback';
  if (METADATA_IPV6.some((item) => item.bytes.every((byte, index) => byte === bytes[index]))) return 'metadata';
  // fc00::/7 唯一本地地址
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return 'private';
  // fe80::/10 链路本地
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return 'link-local';
  if (bytes[0] === 0xff) return 'multicast';
  // IPv4-compatible ::a.b.c.d（已废弃，仍按 IPv4 归类）
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return classifyIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  return 'public';
}

/** 解析 IPv6 为 16 字节；支持 `::` 压缩、内嵌 IPv4 与 zone id。非法返回 null。 */
export function parseIpv6(input: string): number[] | null {
  let address = normalizeHostname(input.trim());
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address.length === 0) return null;

  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = address.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map((part) => Number(part));
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const explicit = [...head, ...tail];
  const missing = 8 - explicit.length;
  if (halves.length === 1) {
    if (explicit.length !== 8) return null;
  } else if (missing < 0) {
    return null;
  }

  const groups =
    halves.length === 1
      ? explicit
      : [...head, ...new Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}
