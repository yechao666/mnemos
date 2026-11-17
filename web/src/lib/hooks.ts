import { useCallback, useEffect, useRef, useState } from 'react';
import type { CursorPage, PartitionStats } from './types.ts';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** 极简数据请求 hook：自动取消过期响应，支持手动刷新。 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: enabled,
    error: null,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const generation = useRef(0);

  const run = useCallback(async (): Promise<T | null> => {
    const mine = ++generation.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      if (mine === generation.current) setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      if (mine === generation.current) {
        setState((prev) => ({
          data: prev.data,
          loading: false,
          error: error instanceof Error ? error.message : '请求失败',
        }));
      }
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    void run();
    return () => {
      generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    ...state,
    refresh: run,
    setData: (data: T | null) => setState((prev) => ({ ...prev, data })),
  };
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useInterval(callback: () => void, delay: number | null): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (delay === null) return;
    const id = window.setInterval(() => saved.current(), delay);
    return () => window.clearInterval(id);
  }, [delay]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Mnemos`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** 复制到剪贴板并短暂反馈。 */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    void navigator.clipboard
      .writeText(text)
      .catch(() => undefined)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      });
  }, []);
  return [copied, copy];
}

/* ------------------------------------------------------------------ */
/* 游标列表（服务端 keyset 分页，不加载全量、不需要 total）             */
/* ------------------------------------------------------------------ */

export interface CursorListState<T> {
  items: T[];
  nextCursor: string | null;
  partitionStats?: PartitionStats;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * 游标分页列表状态机：首屏只取第一页；滚动到底调用 loadMore 追加下一页。
 * 筛选条件变化时（deps 变化）自动重置并丢弃过期响应。
 */
export function useCursorList<T>(
  loadPage: (cursor: string | null) => Promise<CursorPage<T>>,
  deps: unknown[],
  enabled = true,
): CursorListState<T> {
  const loadRef = useRef(loadPage);
  loadRef.current = loadPage;

  const [state, setState] = useState<{
    items: T[];
    nextCursor: string | null;
    partitionStats?: PartitionStats;
    loading: boolean;
    loadingMore: boolean;
    error: string | null;
  }>({ items: [], nextCursor: null, loading: enabled, loadingMore: false, error: null });

  const generation = useRef(0);
  const busy = useRef(false);
  const cursorRef = useRef<string | null>(null);

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    busy.current = true;
    cursorRef.current = null;
    setState((prev) => ({ ...prev, items: [], nextCursor: null, loading: true, loadingMore: false, error: null }));
    try {
      const page = await loadRef.current(null);
      if (mine !== generation.current) return;
      busy.current = false;
      cursorRef.current = page.nextCursor;
      setState({
        items: page.items,
        nextCursor: page.nextCursor,
        partitionStats: page.partitionStats,
        loading: false,
        loadingMore: false,
        error: null,
      });
    } catch (error) {
      if (mine !== generation.current) return;
      busy.current = false;
      setState((prev) => ({
        ...prev,
        loading: false,
        loadingMore: false,
        error: error instanceof Error ? error.message : '加载失败',
      }));
    }
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || busy.current) return;
    const mine = generation.current;
    busy.current = true;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    try {
      const page = await loadRef.current(cursor);
      if (mine !== generation.current) return;
      busy.current = false;
      cursorRef.current = page.nextCursor;
      setState((prev) => ({
        ...prev,
        items: prev.items.concat(page.items),
        nextCursor: page.nextCursor,
        partitionStats: page.partitionStats ?? prev.partitionStats,
        loadingMore: false,
        error: null,
      }));
    } catch (error) {
      if (mine !== generation.current) return;
      busy.current = false;
      setState((prev) => ({
        ...prev,
        loadingMore: false,
        error: error instanceof Error ? error.message : '加载更多失败',
      }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ items: [], nextCursor: null, loading: false, loadingMore: false, error: null });
      return;
    }
    void loadFirst();
    return () => {
      generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return {
    ...state,
    hasMore: Boolean(state.nextCursor),
    refresh: loadFirst,
    loadMore,
  };
}
