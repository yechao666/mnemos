import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * v6.3 隐私规则库：结构 / 校验位校验器。
 *
 * 正则只能保证「长得像」，校验器负责排除「格式对但校验位/日期/范围非法」的误报。
 * 统一入口 `validateValue(validator, value): boolean`：
 * - `none`（默认）恒为 true；
 * - 未知 validator 采用 fail-open（返回 true，仅首次告警），避免规则库升级前后行为不一致；
 * - 所有校验器都是纯函数、无副作用，可安全用于同步扫描路径。
 */

export const VALIDATOR_NAMES = [
  'none',
  'luhn',
  'cn_id',
  'us_ssn',
  'us_itin',
  'iban',
  'vin',
  'ipv4',
  'ipv6',
  'mac',
  'jwt',
  'uscc',
  'eth',
  'btc',
  'coordinates',
  'uuid',
] as const;

export type ValidatorName = (typeof VALIDATOR_NAMES)[number];

const VALIDATOR_SET = new Set<string>(VALIDATOR_NAMES);
const warned = new Set<string>();

export function isKnownValidator(name: string): boolean {
  return VALIDATOR_SET.has(name);
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/* ------------------------------------------------------------------ */
/* 1. luhn（银行卡 / 信用卡 / IMEI）                                    */
/* ------------------------------------------------------------------ */

/** Luhn（mod 10）：去除非数字、长度 ≥ 12。 */
export function luhnValid(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/* ------------------------------------------------------------------ */
/* 2. cn_id（18 位居民身份证，GB 11643-1999）                          */
/* ------------------------------------------------------------------ */

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_ID_CHECK_CODES = '10X98765432';

function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1800 || year > 2200) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

export function cnIdValid(value: string): boolean {
  const id = value.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const birth = id.slice(6, 14);
  const year = Number(birth.slice(0, 4));
  const month = Number(birth.slice(4, 6));
  const day = Number(birth.slice(6, 8));
  if (!isRealDate(year, month, day)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (id.charCodeAt(i) - 48) * (CN_ID_WEIGHTS[i] ?? 0);
  return CN_ID_CHECK_CODES[sum % 11] === id[17];
}

/* ------------------------------------------------------------------ */
/* 3/4. us_ssn / us_itin                                               */
/* ------------------------------------------------------------------ */

/** 去掉 SSN/ITIN 常见分隔符（`123-45-6789` / `123456789`）。 */
function nineDigits(value: string): string | null {
  const compact = value.replace(/[\s-]/g, '');
  return /^\d{9}$/.test(compact) ? compact : null;
}

/** 美国 SSN：区号非 000/666/9xx，组号 ≠ 00，序号 ≠ 0000。 */
export function usSsnValid(value: string): boolean {
  const digits = nineDigits(value);
  if (!digits) return false;
  const area = Number(digits.slice(0, 3));
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

/** 美国 ITIN：9xx-7x/8x/9x-xxxx。 */
export function usItinValid(value: string): boolean {
  const digits = nineDigits(value);
  if (!digits) return false;
  if (!digits.startsWith('9')) return false;
  if (!['7', '8', '9'].includes(digits[3] ?? '')) return false;
  if (digits.slice(5) === '0000') return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 5. iban（mod 97）                                                   */
/* ------------------------------------------------------------------ */

export function ibanValid(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      remainder = (remainder * 100 + (code - 55)) % 97;
    } else {
      return false;
    }
  }
  return remainder === 1;
}

/* ------------------------------------------------------------------ */
/* 6. vin（17 位车架号，含第 9 位校验位）                               */
/* ------------------------------------------------------------------ */

const VIN_VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function vinValid(value: string): boolean {
  const vin = value.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const char = vin[i] ?? '';
    const numeric = char >= '0' && char <= '9' ? Number(char) : VIN_VALUES[char];
    if (numeric === undefined) return false;
    sum += numeric * (VIN_WEIGHTS[i] ?? 0);
  }
  const expected = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin[8] === expected;
}

/* ------------------------------------------------------------------ */
/* 7/8. ipv4 / ipv6 / mac                                              */
/* ------------------------------------------------------------------ */

export function ipv4Valid(value: string): boolean {
  return isIP(value.trim()) === 4;
}

export function ipv6Valid(value: string): boolean {
  return isIP(value.trim()) === 6;
}

export function macValid(value: string): boolean {
  const mac = value.trim();
  if (/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/.test(mac)) return true;
  // Cisco 风格：aabb.ccdd.eeff
  return /^[0-9A-Fa-f]{4}(\.[0-9A-Fa-f]{4}){2}$/.test(mac);
}

/* ------------------------------------------------------------------ */
/* 9. jwt（3 段 base64url，header JSON 含 alg）                         */
/* ------------------------------------------------------------------ */

function isBase64Url(part: string): boolean {
  return part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part);
}

export function jwtValid(value: string): boolean {
  const parts = value.trim().split('.');
  if (parts.length !== 3) return false;
  if (!parts.every(isBase64Url)) return false;
  try {
    const header = Buffer.from(parts[0] ?? '', 'base64url').toString('utf8');
    if (!header.startsWith('{')) return false;
    const parsed = JSON.parse(header) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const alg = (parsed as { alg?: unknown }).alg;
    return typeof alg === 'string' && alg.trim().length > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 10. uscc（统一社会信用代码，mod 31）                                 */
/* ------------------------------------------------------------------ */

const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

export function usccValid(value: string): boolean {
  const code = value.trim().toUpperCase();
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const index = USCC_CHARSET.indexOf(code[i] ?? '');
    if (index < 0) return false;
    sum += index * (USCC_WEIGHTS[i] ?? 0);
  }
  const check = (31 - (sum % 31)) % 31;
  return USCC_CHARSET[check] === code[17];
}

/* ------------------------------------------------------------------ */
/* 11. eth（0x + 40 hex）                                             */
/* ------------------------------------------------------------------ */

export function ethValid(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/* ------------------------------------------------------------------ */
/* 12. btc（base58check，P2PKH / P2SH）                                */
/* ------------------------------------------------------------------ */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(value: string): Buffer | null {
  let num = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) return null;
    num = num * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export function btcValid(value: string): boolean {
  const address = value.trim();
  if (!/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return false;
  const decoded = decodeBase58(address);
  if (!decoded || decoded.length !== 25) return false;
  const version = decoded[0];
  if (version !== 0x00 && version !== 0x05) return false;
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const hash = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest();
  return hash.subarray(0, 4).equals(checksum);
}

/* ------------------------------------------------------------------ */
/* 13. coordinates（lat,lng 范围）                                      */
/* ------------------------------------------------------------------ */

export function coordinatesValid(value: string): boolean {
  const parts = value.trim().split(/\s*[,，]\s*/);
  if (parts.length !== 2) return false;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (parts[0] === '' || parts[1] === '') return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/* ------------------------------------------------------------------ */
/* 14. uuid                                                           */
/* ------------------------------------------------------------------ */

export function uuidValid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value.trim(),
  );
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

const VALIDATORS: Record<string, (value: string) => boolean> = {
  none: () => true,
  luhn: luhnValid,
  cn_id: cnIdValid,
  us_ssn: usSsnValid,
  us_itin: usItinValid,
  iban: ibanValid,
  vin: vinValid,
  ipv4: ipv4Valid,
  ipv6: ipv6Valid,
  mac: macValid,
  jwt: jwtValid,
  uscc: usccValid,
  eth: ethValid,
  btc: btcValid,
  coordinates: coordinatesValid,
  uuid: uuidValid,
};

/**
 * 校验命中值是否满足规则声明的 validator。
 * - 空/缺省 validator → true；
 * - `none` → true；
 * - 未知 validator → fail-open（true），首次调用打印一次告警；
 * - 校验器内部异常 → fail-open（不因单条规则导致整次扫描失败）。
 */
export function validateValue(validator: string | null | undefined, value: string): boolean {
  const name = (validator ?? '').trim().toLowerCase();
  if (!name || name === 'none') return true;
  const fn = VALIDATORS[name];
  if (!fn) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[privacy] 未知 validator "${name}"：按 fail-open 处理（不拦截命中）`);
    }
    return true;
  }
  try {
    return fn(value);
  } catch {
    return true;
  }
}
