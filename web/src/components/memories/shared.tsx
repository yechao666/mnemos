import type { Memory } from '@lib/types.ts';
import { CATEGORY_LABEL } from '@lib/constants.ts';
import { toneForCategory } from '@lib/tone.ts';
import { Badge, Icon, type Tone } from '@ui';
import { ScopeBadge } from '../persons/shared.tsx';

/** 记忆在控制台的统一展示：分类、内容、元信息、时序状态与反馈。 */

export function CategoryBadge({ category, size }: { category: string; size?: 'sm' }) {
  return (
    <Badge tone={toneForCategory(category)} size={size}>
      {CATEGORY_LABEL[category] ?? category}
    </Badge>
  );
}

export function categoryDotTone(category: string): Tone {
  return toneForCategory(category);
}

/** 内容展示：可选截断 + 分类色条 + 标签。 */
export function MemoryContent({
  memory,
  clamp = true,
  maxWidth,
}: {
  memory: Pick<Memory, 'content' | 'category' | 'tags' | 'importance'>;
  clamp?: boolean;
  maxWidth?: number;
}) {
  const tone = toneForCategory(memory.category);
  return (
    <div className={`mem-content tone-${tone}`} style={{ maxWidth }}>
      <div className={clamp ? 'clamp-2' : undefined} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {memory.content}
      </div>
      {memory.tags.length ? (
        <div className="chip-row mt-4">
          {memory.tags.slice(0, 6).map((tag) => (
            <span className="tag" key={tag}>
              #{tag}
            </span>
          ))}
          {memory.tags.length > 6 ? <span className="tiny dim">+{memory.tags.length - 6}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* v6.1 时序状态                                                       */
/* ------------------------------------------------------------------ */

export type MemoryTemporalState = 'current' | 'expired' | 'superseded';

export function memoryTemporalState(
  memory: Pick<Memory, 'validTo' | 'supersededBy'>,
): MemoryTemporalState {
  if (memory.supersededBy) return 'superseded';
  if (memory.validTo) return 'expired';
  return 'current';
}

/**
 * 时序徽标：当前有效 / 已失效（validTo）/ 已被取代（supersededBy）。
 * 「已被取代」可点击跳到新版本记忆（列表/详情共用）。
 */
export function MemoryTemporalBadge({
  memory,
  size,
  onOpenSuperseded,
}: {
  memory: Pick<Memory, 'validTo' | 'supersededBy' | 'validFrom'>;
  size?: 'sm';
  onOpenSuperseded?: (memoryId: string) => void;
}) {
  const state = memoryTemporalState(memory);
  if (state === 'superseded') {
    return (
      <span className="hstack gap-4" title={`已被 ${memory.supersededBy} 取代`}>
        <Badge tone="amber" size={size} dot>
          已被取代
        </Badge>
        {onOpenSuperseded && memory.supersededBy ? (
          <button
            type="button"
            className="link-button tiny"
            onClick={(event) => {
              event.stopPropagation();
              onOpenSuperseded(memory.supersededBy!);
            }}
          >
            查看新版本
          </button>
        ) : null}
      </span>
    );
  }
  if (state === 'expired') {
    return (
      <span title={memory.validTo ? `失效于 ${memory.validTo}` : '已失效'}>
        <Badge tone="slate" size={size} dot>
          已失效
        </Badge>
      </span>
    );
  }
  return (
    <span title={memory.validFrom ? `自 ${memory.validFrom} 起有效` : '当前有效'}>
      <Badge tone="green" size={size} dot>
        当前有效
      </Badge>
    </span>
  );
}

/** 事实槽位键（如 preference.language）。 */
export function MemoryFactKey({ factKey }: { factKey: string | undefined }) {
  if (!factKey) return null;
  return (
    <span className="chip mono" title={`事实槽位 ${factKey}`}>
      <Icon name="tag" size={10} />
      {factKey}
    </span>
  );
}

/** 反馈计数：有帮助 / 没帮助（没有反馈时不占位）。 */
export function MemoryFeedbackBadge({
  memory,
  size,
}: {
  memory: Pick<Memory, 'feedbackUp' | 'feedbackDown'>;
  size?: 'sm';
}) {
  const up = memory.feedbackUp ?? 0;
  const down = memory.feedbackDown ?? 0;
  if (!up && !down) return null;
  return (
    <>
      {up ? (
        <Badge tone="green" size={size}>
          有帮助 {up}
        </Badge>
      ) : null}
      {down ? (
        <Badge tone="red" size={size}>
          没帮助 {down}
        </Badge>
      ) : null}
    </>
  );
}

/** 记忆元信息行：scope / 分类 / 时序状态 / 事实槽位 / 来源 / 会话 / 重要度 / 反馈。 */
export function MemoryMeta({
  memory,
  onOpenSuperseded,
}: {
  memory: Memory;
  onOpenSuperseded?: (memoryId: string) => void;
}) {
  return (
    <div className="chip-row">
      <ScopeBadge scope={memory.scope} size="sm" />
      <CategoryBadge category={memory.category} size="sm" />
      <MemoryTemporalBadge memory={memory} size="sm" onOpenSuperseded={onOpenSuperseded} />
      <MemoryFactKey factKey={memory.factKey} />
      {memory.source === 'dream' ? (
        <Badge tone="violet" size="sm" dot>
          <Icon name="sparkles" size={10} /> 做梦沉淀
        </Badge>
      ) : null}
      <span className="tiny dim">重要度 {memory.importance.toFixed(2)}</span>
      <MemoryFeedbackBadge memory={memory} size="sm" />
      {memory.sessionId ? (
        <span className="chip mono" title={memory.sessionId}>
          <Icon name="branch" size={11} />
          <span className="truncate" style={{ maxWidth: 130 }}>{memory.sessionId}</span>
        </span>
      ) : null}
    </div>
  );
}
