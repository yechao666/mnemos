import { useCallback, useEffect, useRef, useState } from 'react';

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
