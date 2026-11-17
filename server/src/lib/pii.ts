import type { PartitionSettings } from '../../../shared/src/types.ts';

/**
 * v6.1 P2 PII 轻量脱敏（partition.settings.piiRedaction='basic' 时启用）。
 *
 * 规则（按顺序处理，保留后四位）：
 *  - 邮箱：`alice@example.com` → `a***@example.com`
 *  - 身份证：18 位（末位可 X）→ 前 6 位 + `********` + 后 4 位
 *  - 手机号：中国大陆 11 位（1[3-9] 开头）→ 前 3 位 + `****` + 后 4 位
 *  - 银行卡：16–19 位连续数字 → `*` 重复（长度-4）+ 后 4 位
 *
 * 只做确定性正则，不引入额外依赖；不改变内容结构（长度尽量保持一致，便于审计比对）。
 */

export type PiiKind = 'email' | 'id_card' | 'phone' | 'bank_card';

export interface PiiRedactionResult {
  text: string;
  redacted: boolean;
  kinds: PiiKind[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ID_CARD_RE = /(?<![0-9A-Za-z])(\d{17}[\dXx])(?![0-9A-Za-z])/g;
const PHONE_RE = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
const BANK_CARD_RE = /(?<!\d)(\d{16,19})(?!\d)/g;

function maskKeepLast(value: string, keep = 4): string {
  const chars = [...value];
  if (chars.length <= keep) return value;
  return '*'.repeat(chars.length - keep) + chars.slice(-keep).join('');
}

function redactEmail(match: string): string {
  const at = match.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = match.slice(0, at);
  const domain = match.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

function redactIdCard(match: string): string {
  if (match.length < 10) return maskKeepLast(match);
  return `${match.slice(0, 6)}${'*'.repeat(match.length - 10)}${match.slice(-4)}`;
}

function redactPhone(match: string): string {
  return `${match.slice(0, 3)}${'*'.repeat(Math.max(0, match.length - 7))}${match.slice(-4)}`;
}

/** 对一段文本做 basic PII 脱敏。 */
export function redactPii(text: string): PiiRedactionResult {
  if (!text) return { text, redacted: false, kinds: [] };
  const kinds: PiiKind[] = [];
  let output = text;

  if (EMAIL_RE.test(output)) {
    EMAIL_RE.lastIndex = 0;
    output = output.replace(EMAIL_RE, redactEmail);
    kinds.push('email');
  }
  EMAIL_RE.lastIndex = 0;

  if (ID_CARD_RE.test(output)) {
    ID_CARD_RE.lastIndex = 0;
    output = output.replace(ID_CARD_RE, redactIdCard);
    kinds.push('id_card');
  }
  ID_CARD_RE.lastIndex = 0;

  if (PHONE_RE.test(output)) {
    PHONE_RE.lastIndex = 0;
    output = output.replace(PHONE_RE, redactPhone);
    kinds.push('phone');
  }
  PHONE_RE.lastIndex = 0;

  if (BANK_CARD_RE.test(output)) {
    BANK_CARD_RE.lastIndex = 0;
    output = output.replace(BANK_CARD_RE, (match) => maskKeepLast(match));
    kinds.push('bank_card');
  }
  BANK_CARD_RE.lastIndex = 0;

  return { text: output, redacted: kinds.length > 0, kinds };
}

/** 按分区设置决定是否脱敏（off=原样返回）。 */
export function applyPiiRedaction(
  settings: Pick<PartitionSettings, 'piiRedaction'>,
  text: string,
): PiiRedactionResult {
  if (settings.piiRedaction !== 'basic') return { text, redacted: false, kinds: [] };
  return redactPii(text);
}