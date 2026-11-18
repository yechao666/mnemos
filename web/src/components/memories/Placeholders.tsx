import type { MemoryPlaceholder } from '@lib/types.ts';
import {
  MAX_PLACEHOLDER_VALUE,
  PLACEHOLDER_KEY_PATTERN,
  PLACEHOLDER_TOKEN_REGEX,
} from '@lib/constants.ts';
import { Badge, Button, IconButton, Input } from '@ui';

/**
 * v6.2 隐私占位符 UI：
 *  - 新建记忆：占位符映射编辑器（key / value 行，正文 `{{key}}` 校验）；
 *  - 记忆抽屉：占位符列表（key / kind / encrypted，可按需 reveal 真实值）。
 *
 * 约定（docs/privacy-rules.md §3）：key 为 `[A-Za-z0-9_-]{3,64}`；正文只保存 token，
 * 真实值放进 placeholders 映射由服务端加密存储；正文未使用的映射会被服务端忽略。
 */

export interface PlaceholderDraft {
  key: string;
  value: string;
}

function tokenRegex(): RegExp {
  return new RegExp(PLACEHOLDER_TOKEN_REGEX.source, 'g');
}

/** 正文中按出现顺序去重的合法 token key。 */
export function extractPlaceholderKeys(content: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(tokenRegex())) {
    const key = match[1];
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** 正文中格式非法的 `{{...}}`（key 不符合 [A-Za-z0-9_-]{3,64} 或未闭合）。 */
export function findInvalidPlaceholders(content: string): string[] {
  const invalid: string[] = [];
  const complete = /\{\{([^{}]*)\}\}/g;
  for (const match of content.matchAll(complete)) {
    const inner = (match[1] ?? '').trim();
    if (!PLACEHOLDER_KEY_PATTERN.test(inner)) invalid.push(match[0]);
  }
  const leftover = content.replace(tokenRegex(), '');
  if (/\{\{/.test(leftover) && invalid.length === 0) invalid.push('未闭合的 {{');
  return [...new Set(invalid)];
}

/** 校验映射草稿；返回首个错误（null = 通过）。 */
export function validatePlaceholderDrafts(
  content: string,
  drafts: PlaceholderDraft[],
): string | null {
  const invalidTokens = findInvalidPlaceholders(content);
  if (invalidTokens.length) {
    return `正文占位符格式不合法：${invalidTokens.slice(0, 3).join('、')}（key 需为 [A-Za-z0-9_-]{3,64}）`;
  }

  const seen = new Set<string>();
  for (let index = 0; index < drafts.length; index += 1) {
    const key = drafts[index]!.key.trim();
    const value = drafts[index]!.value;
    if (!key && !value.trim()) continue;
    if (!key) return `第 ${index + 1} 行映射缺少 key`;
    if (!PLACEHOLDER_KEY_PATTERN.test(key)) {
      return `映射 key「${key}」不合法：需要 3–64 位字母 / 数字 / _ / -`;
    }
    if (seen.has(key)) return `映射 key「${key}」重复`;
    seen.add(key);
    if (value.length > MAX_PLACEHOLDER_VALUE) {
      return `映射「${key}」的真实值超过 ${MAX_PLACEHOLDER_VALUE} 字符`;
    }
  }

  const missing = extractPlaceholderKeys(content).filter((key) => {
    const draft = drafts.find((item) => item.key.trim() === key);
    return !draft || !draft.value.trim();
  });
  if (missing.length) {
    return `正文引用了未提供真实值的占位符：${missing.slice(0, 5).map((key) => `{{${key}}}`).join('、')}`;
  }
  return null;
}

/** 草稿 → API 映射；默认只提交正文实际引用的 key。 */
export function placeholderDraftsToMap(
  content: string,
  drafts: PlaceholderDraft[],
): Record<string, string> {
  const used = new Set(extractPlaceholderKeys(content));
  const map: Record<string, string> = {};
  for (const draft of drafts) {
    const key = draft.key.trim();
    if (!key || !used.has(key)) continue;
    const value = draft.value;
    if (!value.trim()) continue;
    map[key] = value;
  }
  return map;
}

/** 正文里出现的 token 数量（用于列表/编辑器提示）。 */
export function placeholderUsage(content: string, drafts: PlaceholderDraft[]): {
  tokens: string[];
  mapped: number;
  missing: number;
} {
  const tokens = extractPlaceholderKeys(content);
  const mapped = tokens.filter((key) => {
    const draft = drafts.find((item) => item.key.trim() === key);
    return Boolean(draft && draft.value.trim());
  }).length;
  return { tokens, mapped, missing: tokens.length - mapped };
}

/** 占位符徽标：key + kind + encrypted（抽屉与列表复用）。 */
export function PlaceholderBadges({ placeholder }: { placeholder: MemoryPlaceholder }) {
  return (
    <span className="hstack gap-6 wrap">
      <span className="placeholder-token mono">{`{{${placeholder.placeholder}}}`}</span>
      {placeholder.kind ? <Badge tone="slate" size="sm">{placeholder.kind}</Badge> : null}
      <Badge tone={placeholder.encrypted ? 'green' : 'amber'} size="sm" dot>
        {placeholder.encrypted ? '已加密' : '明文'}
      </Badge>
    </span>
  );
}

/** 抽屉里的真实值展示：未 reveal 时显示掩码，reveal 后显示 value。 */
export function PlaceholderValue({
  placeholder,
  revealed,
}: {
  placeholder: MemoryPlaceholder;
  revealed: boolean;
}) {
  if (!revealed) {
    return <span className="placeholder-value is-hidden mono" aria-label="真实值已隐藏">••••••</span>;
  }
  if (!placeholder.value) {
    return <span className="tiny dim">（服务端未返回解密值）</span>;
  }
  return <span className="placeholder-value mono">{placeholder.value}</span>;
}

/**
 * 占位符映射编辑器（新建记忆）。
 * 父级负责在正文出现新 token 时补行；这里只做行内编辑与校验提示。
 */
export function PlaceholderEditor({
  value,
  onChange,
  content,
  showErrors = false,
  disabled = false,
}: {
  value: PlaceholderDraft[];
  onChange: (next: PlaceholderDraft[]) => void;
  /** 记忆正文：用于标注哪些 key 被引用。 */
  content: string;
  showErrors?: boolean;
  disabled?: boolean;
}) {
  const tokens = extractPlaceholderKeys(content);
  const tokenSet = new Set(tokens);
  const usage = placeholderUsage(content, value);

  const update = (index: number, patch: Partial<PlaceholderDraft>) => {
    onChange(value.map((draft, current) => (current === index ? { ...draft, ...patch } : draft)));
  };
  const remove = (index: number) => onChange(value.filter((_, current) => current !== index));
  const add = () => onChange([...value, { key: '', value: '' }]);
  const syncFromContent = () => {
    const existing = new Set(value.map((draft) => draft.key.trim()));
    const missing = tokens.filter((key) => !existing.has(key));
    if (!missing.length) return;
    onChange([...value, ...missing.map((key) => ({ key, value: '' }))]);
  };

  return (
    <div className="placeholder-editor">
      <div className="between wrap gap-8">
        <div>
          <div className="small">隐私占位符映射（可选）</div>
          <div className="tiny dim">
            正文只写 <span className="mono">{'{{key}}'}</span>，真实值放这里由服务端加密存储；正文不会落明文。
          </div>
        </div>
        <div className="hstack gap-6 wrap">
          <Badge tone={usage.missing ? 'amber' : 'slate'} size="sm">
            引用 {usage.tokens.length} · 已映射 {usage.mapped}
          </Badge>
          <Button size="sm" variant="ghost" icon="refresh" disabled={disabled || usage.missing <= 0} onClick={syncFromContent}>
            从正文同步
          </Button>
        </div>
      </div>

      {value.length === 0 ? (
        <div className="placeholder-editor-empty tiny dim">
          还没有映射。可以在正文写 <span className="mono">{'{{phone_a1b2}}'}</span>，再点「从正文同步」补行；
          或直接「添加映射」。
        </div>
      ) : (
        <div className="vstack gap-8 mt-8">
          {value.map((draft, index) => {
            const key = draft.key.trim();
            const used = Boolean(key && tokenSet.has(key));
            const rowError = showErrors && used && !draft.value.trim() ? '缺少真实值' : null;
            return (
              <div className="placeholder-row" key={index}>
                <Input
                  aria-label={`占位符 ${index + 1} key`}
                  className="mono"
                  value={draft.key}
                  disabled={disabled}
                  placeholder="phone_a1b2"
                  maxLength={64}
                  onChange={(event) => update(index, { key: event.target.value.replace(/[^A-Za-z0-9_-]/g, '') })}
                />
                <Input
                  aria-label={`占位符 ${index + 1} 真实值`}
                  className="mono"
                  value={draft.value}
                  disabled={disabled}
                  placeholder="例如 13812345678（仅提交给服务端）"
                  onChange={(event) => update(index, { value: event.target.value })}
                />
                <span className="tiny dim nowrap">{used ? '正文已引用' : key ? '正文未使用（忽略）' : '待填 key'}</span>
                <IconButton
                  icon="trash"
                  label={`删除第 ${index + 1} 行映射`}
                  size="sm"
                  disabled={disabled}
                  onClick={() => remove(index)}
                />
                {rowError ? <div className="field-error" style={{ gridColumn: '1 / -1' }}>{rowError}</div> : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="hstack gap-8 mt-8">
        <Button size="sm" variant="secondary" icon="plus" disabled={disabled} onClick={add}>
          添加映射
        </Button>
        <span className="tiny dim">key 规则：3–64 位字母 / 数字 / _ / -；未被正文引用的映射会被忽略。</span>
      </div>

      {tokens.length ? (
        <div className="placeholder-example mt-8">
          <div className="tiny dim">正文中的占位符</div>
          <div className="chip-row mt-4">
            {tokens.map((key) => {
              const draft = value.find((item) => item.key.trim() === key);
              const mapped = Boolean(draft && draft.value.trim());
              return (
                <span key={key} className={`placeholder-token mono${mapped ? ' is-mapped' : ' is-missing'}`}>
                  {`{{${key}}}`}
                </span>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="tiny dim mt-6">
          示例：正文「手机号是 <span className="mono">{'{{phone_a1b2}}'}</span>」→ 映射
          <span className="mono"> phone_a1b2 = 13812345678</span>。检索/简报时服务端会在生成提示词前替换回真实值。
        </div>
      )}
    </div>
  );
}
