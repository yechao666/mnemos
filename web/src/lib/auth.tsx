import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Org, Project, User } from '@shared';
import { api, getToken, setToken, UNAUTHORIZED_EVENT } from './api.ts';

export interface AuthState {
  user: User | null;
  org: Org | null;
  projects: Project[];
  loading: boolean;
  error: string | null;
}

export interface AuthApi extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    org: null,
    projects: [],
    loading: Boolean(getToken()),
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setState({ user: null, org: null, projects: [], loading: false, error: null });
      return;
    }
    try {
      const me = await api.auth.me();
      setState({ user: me.user, org: me.org, projects: me.projects, loading: false, error: null });
    } catch (error) {
      setState({
        user: null,
        org: null,
        projects: [],
        loading: false,
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
      setState({ user: null, org: null, projects: [], loading: false, error: '登录状态已过期，请重新登录' });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.auth.login(email, password);
    setToken(result.token);
    setState((prev) => ({ ...prev, user: result.user, org: result.org, loading: true, error: null }));
    const me = await api.auth.me();
    setState({ user: me.user, org: me.org, projects: me.projects, loading: false, error: null });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* 会话可能已过期 */
    }
    setToken(null);
    setState({ user: null, org: null, projects: [], loading: false, error: null });
  }, []);

  const value = useMemo<AuthApi>(() => ({ ...state, login, logout, refresh }), [state, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
