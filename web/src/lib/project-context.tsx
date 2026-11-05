import { createContext, useContext } from 'react';
import type { ProjectSummary } from '@shared';

/**
 * 项目上下文契约：由 ProjectLayout 提供，项目内所有子页面消费。
 * 避免每个页面重复请求项目详情，并保证顶栏/页签数据一致。
 */
export interface ProjectContextValue {
  project: ProjectSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<ProjectSummary | null>;
  setProject: (project: ProjectSummary | null) => void;
}

const FALLBACK: ProjectContextValue = {
  project: null,
  loading: true,
  error: null,
  refresh: async () => null,
  setProject: () => undefined,
};

export const ProjectContext = createContext<ProjectContextValue>(FALLBACK);

export function useProjectContext(): ProjectContextValue {
  return useContext(ProjectContext);
}
