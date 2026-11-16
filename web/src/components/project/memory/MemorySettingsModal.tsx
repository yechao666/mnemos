import { useEffect, useState } from 'react';
import type { MemoryDreamStatus } from '@shared';
import {
  BRIEF_DEFAULT_CHARS,
  BRIEF_MAX_CHARS,
  BRIEF_MIN_CHARS,
  DREAM_MAX_INTERVAL_MINUTES,
  DREAM_MIN_INTERVAL_MINUTES,
} from '@shared';
import { Button, Field, Input, Modal, Select, Switch, useToast } from '@ui';
import { api } from '@lib/api.ts';
import {
  INTERVAL_UNIT_OPTIONS,
  intervalLabel,
  splitInterval,
  toMinutes,
  type IntervalUnit,
} from './shared.tsx';

export interface MemorySettingsModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** 当前复盘总结状态（用于回显开关与周期） */
  dream: MemoryDreamStatus | null;
  /** 当前简报字数上限 */
  briefMaxChars: number;
  /** 保存成功后通知页面刷新简报与复盘总结状态 */
  onSaved: () => void;
}

/**
 * 复盘总结设置：复盘总结开关 + 周期（分钟/小时/天，提交前统一换算为分钟）+ 简报字数上限。
 * 保存时并行写入复盘总结设置与简报设置。
 */
export function MemorySettingsModal({
  open,
  onClose,
  projectId,
  dream,
  briefMaxChars,
  onSaved,
}: MemorySettingsModalProps) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(true);
  const [intervalValue, setIntervalValue] = useState('1');
  const [unit, setUnit] = useState<IntervalUnit>('days');
  const [briefMax, setBriefMax] = useState(String(BRIEF_DEFAULT_CHARS));
  const [saving, setSaving] = useState(false);

  // 打开弹窗时按最新数据回显；关闭后不保留编辑中的状态。
  useEffect(() => {
    if (!open) return;
    setEnabled(dream?.settings.enabled ?? true);
    const split = splitInterval(dream?.settings.intervalMinutes);
    setIntervalValue(split.value);
    setUnit(split.unit);
    setBriefMax(String(briefMaxChars || BRIEF_DEFAULT_CHARS));
  }, [open, dream?.settings.enabled, dream?.settings.intervalMinutes, briefMaxChars]);

  const save = async () => {
    const amount = Number(intervalValue);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('请输入有效的复盘总结周期数值');
      return;
    }
    const minutes = toMinutes(amount, unit);
    if (minutes < DREAM_MIN_INTERVAL_MINUTES || minutes > DREAM_MAX_INTERVAL_MINUTES) {
      toast.error(
        `复盘总结周期需在 ${intervalLabel(DREAM_MIN_INTERVAL_MINUTES)}–${intervalLabel(
          DREAM_MAX_INTERVAL_MINUTES,
        )} 之间`,
      );
      return;
    }
    const chars = Number(briefMax);
    if (!Number.isInteger(chars) || chars < BRIEF_MIN_CHARS || chars > BRIEF_MAX_CHARS) {
      toast.error(`简报字数需在 ${BRIEF_MIN_CHARS}–${BRIEF_MAX_CHARS} 之间`);
      return;
    }

    setSaving(true);
    try {
      await Promise.all([
        api.updateMemoryDream(projectId, { enabled, intervalMinutes: minutes }),
        api.updateMemoryBriefSettings(projectId, chars),
      ]);
      toast.success('复盘总结设置已保存');
      onClose();
      onSaved();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存复盘总结设置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title="复盘总结设置"
      description="配置定时复盘总结与记忆简报长度；复盘总结会把新增活跃记忆整理为洞见。"
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            保存设置
          </Button>
        </>
      }
    >
      <div className="vstack gap-16">
        <div className="memory-settings-row">
          <div>
            <div className="strong">启用定时复盘总结</div>
            <div className="tiny dim mt-4">
              后台按周期增量整理活跃记忆，只处理尚未复盘总结的新增记忆。
            </div>
          </div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>

        <Field
          label="复盘总结周期"
          htmlFor="memory-dream-interval"
          hint={`最短 ${intervalLabel(DREAM_MIN_INTERVAL_MINUTES)}，最长 ${intervalLabel(
            DREAM_MAX_INTERVAL_MINUTES,
          )}；保存时自动换算为分钟。`}
        >
          <div className="memory-dream-cycle">
            <Input
              id="memory-dream-interval"
              className="memory-dream-number"
              value={intervalValue}
              inputMode="decimal"
              aria-label="复盘总结周期数值"
              onChange={(event) => setIntervalValue(event.target.value.replace(/[^0-9.]/g, ''))}
            />
            <Select
              className="memory-dream-unit"
              value={unit}
              aria-label="复盘总结周期单位"
              options={INTERVAL_UNIT_OPTIONS}
              onChange={(event) => setUnit(event.target.value as IntervalUnit)}
            />
          </div>
        </Field>

        <Field
          label="记忆简报最大字数"
          htmlFor="memory-brief-max"
          hint={`${BRIEF_MIN_CHARS}–${BRIEF_MAX_CHARS} 字，默认 ${BRIEF_DEFAULT_CHARS}；仅取最近活跃记忆与洞见。`}
        >
          <Input
            id="memory-brief-max"
            className="memory-dream-number"
            value={briefMax}
            inputMode="numeric"
            aria-label="记忆简报最大字数"
            onChange={(event) => setBriefMax(event.target.value.replace(/[^0-9]/g, ''))}
          />
        </Field>

        <div className="tiny dim">
          保存后会立即按新的字数上限重新生成记忆简报；周期调整从下一次定时任务开始生效。
        </div>
      </div>
    </Modal>
  );
}
