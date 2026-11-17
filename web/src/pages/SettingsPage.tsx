import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { MemoryScope, PartitionStatus } from '@lib/types.ts';
import { MEMORY_SCOPES, PARTITION_STATUSES } from '@lib/constants.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  PageHead,
  Select,
  SectionHead,
  Switch,
  Textarea,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { fmtFullDateTime } from '@lib/format.ts';

interface FormState {
  name: string;
  description: string;
  status: PartitionStatus;
  defaultScope: MemoryScope;
  personAutoCreate: boolean;
  briefMaxChars: string;
  dreamEnabled: boolean;
  dreamIntervalMinutes: string;
}

function formFromPartition(partition: {
  name: string;
  description: string;
  status: PartitionStatus;
  settings: Record<string, unknown>;
}): FormState {
  const settings = partition.settings ?? {};
  return {
    name: partition.name,
    description: partition.description,
    status: partition.status,
    defaultScope: (settings.defaultScope as MemoryScope) ?? 'partition',
    personAutoCreate: settings.personAutoCreate !== false,
    briefMaxChars: String(settings.briefMaxChars ?? 500),
    dreamEnabled: settings.dreamEnabled !== false,
    dreamIntervalMinutes: String(settings.dreamIntervalMinutes ?? 1440),
  };
}

/** 分区设置：名称/描述/状态 + 默认 scope、自动建档、简报与做梦参数。 */
export function SettingsPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { partition, refresh } = usePartitionContext();
  const toast = useToast();

  const initial = useMemo(() => (partition ? formFromPartition(partition) : null), [partition]);
  const [form, setForm] = useState<FormState | null>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(initial);
    setError(null);
  }, [initial]);

  const patch = (next: Partial<FormState>) => setForm((current) => (current ? { ...current, ...next } : current));

  const save = async () => {
    if (!form || saving) return;
    if (!form.name.trim()) {
      setError('分区名称不能为空。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.partitions.update(partitionId, {
        name: form.name.trim(),
        description: form.description.trim(),
        status: form.status,
        settings: {
          ...(partition?.settings ?? {}),
          defaultScope: form.defaultScope,
          personAutoCreate: form.personAutoCreate,
          briefMaxChars: Number(form.briefMaxChars) || 500,
          dreamEnabled: form.dreamEnabled,
          dreamIntervalMinutes: Number(form.dreamIntervalMinutes) || 1440,
        },
      });
      await refresh();
      toast.success('分区设置已保存');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (!partition || !form) {
    return (
      <Card pad>
        <div className="tiny dim">正在加载分区设置…</div>
      </Card>
    );
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="设置"
        title="分区设置"
        desc="分区内的默认行为：新记忆的可见范围、人的自动建档、简报字数与做梦周期。"
        actions={
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            保存设置
          </Button>
        }
      />

      {error ? <Callout tone="red" icon="alert">{error}</Callout> : null}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card pad>
          <SectionHead title="基础信息" desc="名称与描述用于控制台展示；slug 创建后不可修改。" />
          <div className="vstack gap-12 mt-12">
            <Field label="分区名称" required htmlFor="settings-name">
              <Input
                id="settings-name"
                value={form.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>
            <Field label="描述" htmlFor="settings-desc">
              <Textarea
                id="settings-desc"
                value={form.description}
                onChange={(event) => patch({ description: event.target.value })}
                style={{ minHeight: 84 }}
              />
            </Field>
            <div className="grid grid-2" style={{ gap: 12 }}>
              <Field label="状态" htmlFor="settings-status">
                <Select
                  id="settings-status"
                  options={PARTITION_STATUSES.map((item) => ({ value: item.value, label: item.label }))}
                  value={form.status}
                  onChange={(event) => patch({ status: event.target.value as PartitionStatus })}
                />
              </Field>
              <Field label="slug" htmlFor="settings-slug" hint="只读">
                <Input id="settings-slug" className="mono" value={partition.slug} readOnly />
              </Field>
            </div>
            <div className="tiny dim">
              <div>内部 ID：<span className="mono">{partition.id}</span></div>
              <div>创建于 {fmtFullDateTime(partition.createdAt)} · 更新于 {fmtFullDateTime(partition.updatedAt)}</div>
            </div>
          </div>
        </Card>

        <Card pad>
          <SectionHead title="记忆默认行为" desc="写入时未显式指定 scope 的缺省策略。" />
          <div className="vstack gap-16 mt-12">
            <Field label="默认可见范围" htmlFor="settings-scope" hint={MEMORY_SCOPES.find((item) => item.value === form.defaultScope)?.desc}>
              <Select
                id="settings-scope"
                options={MEMORY_SCOPES.map((item) => ({ value: item.value, label: item.label }))}
                value={form.defaultScope}
                onChange={(event) => patch({ defaultScope: event.target.value as MemoryScope })}
              />
            </Field>

            <div className="between">
              <div>
                <div className="small">写入时自动建档</div>
                <div className="tiny dim">写记忆时 person 不存在则自动创建（推荐开启）。</div>
              </div>
              <Switch checked={form.personAutoCreate} onChange={(next) => patch({ personAutoCreate: next })} />
            </div>

            <div className="between">
              <div>
                <div className="small">自动做梦</div>
                <div className="tiny dim">定时把新记忆巩固成洞见。</div>
              </div>
              <Switch checked={form.dreamEnabled} onChange={(next) => patch({ dreamEnabled: next })} />
            </div>

            <div className="grid grid-2" style={{ gap: 12 }}>
              <Field label="简报字数上限" htmlFor="settings-brief">
                <Input
                  id="settings-brief"
                  value={form.briefMaxChars}
                  onChange={(event) => patch({ briefMaxChars: event.target.value.replace(/[^0-9]/g, '') })}
                />
              </Field>
              <Field label="做梦周期（分钟）" htmlFor="settings-dream">
                <Input
                  id="settings-dream"
                  value={form.dreamIntervalMinutes}
                  onChange={(event) => patch({ dreamIntervalMinutes: event.target.value.replace(/[^0-9]/g, '') })}
                />
              </Field>
            </div>
          </div>
        </Card>
      </div>

      <Card pad>
        <SectionHead
          title="只读的 settings JSON"
          desc="后端保留 settings 自由字段；控制台只编辑上表中的常用项，其余设置保持原样。"
          actions={<Badge tone="slate" size="sm">v6 分区设置</Badge>}
        />
        <pre className="code-body mt-12" style={{ maxHeight: 220, overflow: 'auto' }}>
          {JSON.stringify(partition.settings ?? {}, null, 2)}
        </pre>
      </Card>

      <Callout tone="slate" icon="info">
        分区归档后仍可读取历史记忆；需要恢复时把状态改回「运行中」。设置变更会记录到审计日志。
      </Callout>
    </div>
  );
}
