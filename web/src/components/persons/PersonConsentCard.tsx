import { useEffect, useMemo, useState } from 'react';
import type { Person } from '@lib/types.ts';
import { api } from '@lib/api.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  IconButton,
  Input,
  SectionHead,
  Segmented,
  Textarea,
  useToast,
} from '@ui';

/**
 * 人详情里的「同意 / 合规标记（consent）」编辑器（v6.1 P2）：
 *  - 键值对模式：逐条编辑 key / value（value 支持字符串、数字、布尔与 JSON）；
 *  - JSON 模式：直接编辑完整对象；
 *  - 保存走 PATCH /api/partitions/:p/persons/:person（consent 为整体覆盖），成功/失败都有提示。
 *
 * consent 是自由 JSON，不做字段白名单：调用方可以放 marketing / analytics / version 等标记。
 */

const SAMPLE_KEYS = ['analytics', 'marketing', 'dataRetentionDays', 'version'];

type EditorMode = 'kv' | 'json';

interface ConsentRow {
  key: string;
  value: string;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 键值对里的 value：能解析为 JSON（数字/布尔/对象/数组/带引号字符串）就解析，否则按原字符串。 */
function parseValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (/^["'[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rowsFromConsent(consent: Record<string, unknown> | undefined): ConsentRow[] {
  return Object.entries(consent ?? {}).map(([key, value]) => ({ key, value: formatValue(value) }));
}

function rowsToConsent(rows: ConsentRow[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    result[key] = parseValue(row.value);
  }
  return result;
}

export function PersonConsentCard({
  partitionId,
  personRef,
  person,
  canManage,
  onChanged,
}: {
  partitionId: string;
  personRef: string;
  person: Person;
  canManage: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<EditorMode>('kv');
  const [rows, setRows] = useState<ConsentRow[]>(() => rowsFromConsent(person.consent));
  const [jsonText, setJsonText] = useState(() => JSON.stringify(person.consent ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 切换人（或保存后父级刷新）时以服务端数据重置表单。
  const consentSignature = useMemo(() => JSON.stringify(person.consent ?? {}), [person.consent]);
  useEffect(() => {
    setRows(rowsFromConsent(person.consent));
    setJsonText(JSON.stringify(person.consent ?? {}, null, 2));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.id, consentSignature]);

  const consentCount = Object.keys(person.consent ?? {}).length;
  const editedCount = useMemo(() => rows.filter((row) => row.key.trim()).length, [rows]);

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    setError(null);
    if (next === 'json') {
      setJsonText(JSON.stringify(rowsToConsent(rows), null, 2));
      setMode('json');
      return;
    }
    const parsed = parseJsonObject(jsonText);
    if (!parsed) {
      setError('JSON 不是合法对象，无法切换为键值对模式。请先修正 JSON 或清空。');
      return;
    }
    setRows(rowsFromConsent(parsed));
    setMode('kv');
  };

  const save = async () => {
    if (!canManage || saving) return;
    let consent: Record<string, unknown>;
    if (mode === 'json') {
      if (!jsonText.trim()) {
        consent = {};
      } else {
        const parsed = parseJsonObject(jsonText);
        if (!parsed) {
          setError('consent 必须是合法的 JSON 对象（不能是数组或原始值）。');
          return;
        }
        consent = parsed;
      }
    } else {
      const seen = new Set<string>();
      for (const row of rows) {
        const key = row.key.trim();
        if (!key) continue;
        if (seen.has(key)) {
          setError(`键「${key}」重复，请合并后再保存。`);
          return;
        }
        seen.add(key);
      }
      consent = rowsToConsent(rows);
    }

    setSaving(true);
    setError(null);
    try {
      await api.persons.update(partitionId, personRef, { consent });
      toast.success('同意标记（consent）已保存');
      await onChanged?.();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存 consent 失败';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const addRow = () => {
    const used = new Set(rows.map((row) => row.key.trim()));
    const sample = SAMPLE_KEYS.find((key) => !used.has(key));
    setRows([...rows, { key: sample ?? '', value: sample ? 'true' : '' }]);
    setError(null);
  };

  const patchRow = (index: number, patch: Partial<ConsentRow>) => {
    setRows(rows.map((row, current) => (current === index ? { ...row, ...patch } : row)));
    setError(null);
  };

  return (
    <Card pad>
      <SectionHead
        title="同意与合规标记（consent）"
        desc="自由 JSON，整体覆盖保存；用于记录用户的同意范围、数据保留约定等合规信息。保存会写入审计日志。"
        actions={
          <div className="hstack gap-8 wrap">
            <Badge tone={consentCount ? 'green' : 'slate'} size="sm" dot>
              {consentCount ? `已设置 ${consentCount} 项` : '未设置'}
            </Badge>
            {canManage ? (
              <Button size="sm" variant="primary" icon="check" loading={saving} onClick={() => void save()}>
                保存 consent
              </Button>
            ) : (
              <Badge tone="slate" size="sm">只读权限</Badge>
            )}
          </div>
        }
      />

      <div className="between wrap gap-8 mt-12">
        <div className="tiny dim">
          键值对模式适合逐项维护；JSON 模式适合从导出数据粘贴。value 支持字符串、数字、布尔与嵌套 JSON。
        </div>
        <Segmented
          options={[
            { value: 'kv', label: '键值对' },
            { value: 'json', label: 'JSON' },
          ]}
          value={mode}
          onChange={(next) => switchMode(next as EditorMode)}
        />
      </div>

      {mode === 'kv' ? (
        <div className="consent-rows mt-10">
          {rows.length === 0 ? (
            <div className="tiny dim">
              暂无 consent 项。常见示例：<span className="mono">analytics: true</span>、
              <span className="mono">marketing: false</span>、<span className="mono">version: &quot;2026-01&quot;</span>。
            </div>
          ) : (
            rows.map((row, index) => (
              <div className="consent-row" key={index}>
                <Input
                  aria-label={`consent 键 ${index + 1}`}
                  className="mono"
                  value={row.key}
                  disabled={!canManage || saving}
                  placeholder="键，例如 analytics"
                  onChange={(event) => patchRow(index, { key: event.target.value })}
                />
                <Input
                  aria-label={`consent 值 ${index + 1}`}
                  className="mono"
                  value={row.value}
                  disabled={!canManage || saving}
                  placeholder="值，例如 true / 30 / 2026-01"
                  onChange={(event) => patchRow(index, { value: event.target.value })}
                />
                {canManage ? (
                  <IconButton
                    icon="trash"
                    label={`删除 consent 项 ${row.key || index + 1}`}
                    size="sm"
                    disabled={saving}
                    onClick={() => setRows(rows.filter((_, current) => current !== index))}
                  />
                ) : (
                  <span />
                )}
              </div>
            ))
          )}
          {canManage ? (
            <div className="hstack gap-8 mt-8">
              <Button size="sm" variant="secondary" icon="plus" onClick={addRow} disabled={saving}>
                添加一项
              </Button>
              <span className="tiny dim">当前 {editedCount} 项；空键会被忽略</span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-10">
          <Field
            label="consent JSON"
            htmlFor="person-consent-json"
            hint="必须是 JSON 对象（{ ... }）；留空等价于清空 consent。"
          >
            <Textarea
              id="person-consent-json"
              className="mono"
              value={jsonText}
              readOnly={!canManage || saving}
              spellCheck={false}
              style={{ minHeight: 168, fontSize: 12, lineHeight: 1.7 }}
              onChange={(event) => {
                setJsonText(event.target.value);
                setError(null);
              }}
            />
          </Field>
        </div>
      )}

      {error ? (
        <div className="mt-8">
          <Callout tone="red" icon="alert">{error}</Callout>
        </div>
      ) : null}

      {person.consent && Object.keys(person.consent).length ? (
        <details className="history-fold mt-10">
          <summary>当前已保存的 consent</summary>
          <pre className="history-meta">{JSON.stringify(person.consent, null, 2)}</pre>
        </details>
      ) : null}

      {!canManage ? (
        <div className="tiny dim mt-8">当前账号无写入权限，只能查看 consent。</div>
      ) : (
        <div className="tiny dim mt-8">
          保存为整体覆盖：未包含的键会被删除。修改后点击右上角「保存 consent」生效。
        </div>
      )}
    </Card>
  );
}
