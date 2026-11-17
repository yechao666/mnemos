import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * 自实现窗口化列表（不引入依赖）：固定行高 + 绝对定位，只渲染可视窗口内的行。
 * 用于百万级人列表：DOM 行数恒定（约可视行数 + overscan），滚动到底触发服务端下一页。
 */
export interface WindowedListProps<T> {
  items: T[];
  rowHeight: number;
  overscan?: number;
  renderRow: (item: T, index: number) => ReactNode;
  rowKey: (item: T, index: number) => string;
  /** 距离底部约 2 行时触发（内部已防重复触发，调用方仍应自行去重） */
  onEndReached?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  className?: string;
  style?: CSSProperties;
  empty?: ReactNode;
  footer?: ReactNode;
  label?: string;
}

export function WindowedList<T>({
  items,
  rowHeight,
  overscan = 8,
  renderRow,
  rowKey,
  onEndReached,
  hasMore = false,
  loadingMore = false,
  className = '',
  style,
  empty,
  footer,
  label,
}: WindowedListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const onEndReachedRef = useRef(onEndReached);
  onEndReachedRef.current = onEndReached;
  const moreRef = useRef({ hasMore, loadingMore });
  moreRef.current = { hasMore, loadingMore };

  const triggerIfNearBottom = useCallback(
    (el: HTMLDivElement) => {
      if (!moreRef.current.hasMore || moreRef.current.loadingMore) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight * 2) {
        onEndReachedRef.current?.();
      }
    },
    [rowHeight],
  );

  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
      triggerIfNearBottom(el);
    });
  }, [triggerIfNearBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 首页不足以填满视口（或筛选后行数很少）时继续拉下一页。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (moreRef.current.hasMore && !moreRef.current.loadingMore && el.scrollHeight <= el.clientHeight + rowHeight) {
      onEndReachedRef.current?.();
    }
  }, [items.length, rowHeight]);

  useEffect(
    () => () => {
      if (frame.current) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  const total = items.length;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil((viewportHeight || rowHeight * 12) / rowHeight) + overscan * 2;
  const end = Math.min(total, start + visible);
  const slice = items.slice(start, end);

  return (
    <div className={`v6-vlist ${className}`} style={style} ref={scrollRef} onScroll={onScroll} aria-label={label}>
      {total === 0 ? (
        <div className="v6-vlist-empty">{empty}</div>
      ) : (
        <div className="v6-vlist-inner" style={{ height: total * rowHeight }} role="list" aria-rowcount={total}>
          {slice.map((item, index) => {
            const absoluteIndex = start + index;
            return (
              <div
                key={rowKey(item, absoluteIndex)}
                className="v6-vrow"
                role="listitem"
                aria-posinset={absoluteIndex + 1}
                aria-setsize={total}
                style={{ top: absoluteIndex * rowHeight, height: rowHeight }}
              >
                {renderRow(item, absoluteIndex)}
              </div>
            );
          })}
        </div>
      )}
      {footer ? <div className="v6-vlist-foot">{footer}</div> : null}
    </div>
  );
}
