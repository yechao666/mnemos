import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Org, Partition, User } from './types.ts';
import { api, getToken, setToken, UNAUTHORIZED_EVENT } from './api.ts';

export interface AuthState {
  user: User | null;
  org: Org | null;
  /** v6：组织下的分区（取代 v5 的 projects） */
  partitions: Partition[];
  loading: boolean;
  error: string | null;
}

export interface AuthApi extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

const EMPTY: AuthState = { user: null, org: null, partitions: [], loading: false, error: null };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    ...EMPTY,
    loading: Boolean(getToken()),
  });

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setState(EMPTY);
      return;
    }
    try {
      const me = await api.auth.me();
      setState({ user: me.user, org: me.org, partitions: me.partitions, loading: false, error: null });
    } catch (error) {
      setState({
        ...EMPTY,
        error: error instanceof Error ? error.message : '会话已失效',
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUnauthorized = () => {
      setToken(null);
      setState({ ...EMPTY, error: '登录状态已过期，请重新登录' });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.auth.login(email, password);
    setToken(result.token);
    setState((prev) => ({ ...prev, user: result.user, org: result.org, loading: true, error: null }));
    const me = await api.auth.me();
    setState({ user: me.user, org: me.org, partitions: me.partitions, loading: false, error: null });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* 会话可能已过期 */
    }
    setToken(null);
    setState(EMPTY);
  }, []);

  const value = useMemo<AuthApi>(() => ({ ...state, login, logout, refresh }), [state, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
