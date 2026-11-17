import type { Memory } from '@lib/types.ts';
import { CATEGORY_LABEL } from '@lib/constants.ts';
import { toneForCategory } from '@lib/tone.ts';
import { Badge, Icon, type Tone } from '@ui';
import { ScopeBadge } from '../persons/shared.tsx';

/** 记忆在控制台的统一展示：分类、内容、元信息。 */

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

/** 记忆元信息行：scope / 来源 / 会话 / 重要度。 */
export function MemoryMeta({ memory }: { memory: Memory }) {
  return (
    <div className="chip-row">
      <ScopeBadge scope={memory.scope} size="sm" />
      <CategoryBadge category={memory.category} size="sm" />
      {memory.source === 'dream' ? (
        <Badge tone="violet" size="sm" dot>
          <Icon name="sparkles" size={10} /> 做梦沉淀
        </Badge>
      ) : null}
      <span className="tiny dim">重要度 {memory.importance.toFixed(2)}</span>
      {memory.sessionId ? (
        <span className="chip mono" title={memory.sessionId}>
          <Icon name="branch" size={11} />
          <span className="truncate" style={{ maxWidth: 130 }}>{memory.sessionId}</span>
        </span>
      ) : null}
    </div>
  );
}
