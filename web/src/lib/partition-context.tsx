import { createContext, useContext } from 'react';
import type { Partition, PartitionStats } from './types.ts';

/**
 * 分区上下文：由 PartitionLayout 提供，分区内所有子页面消费。
 * 避免每个页面重复请求分区详情与统计，保证顶栏/页签数据一致。
 */
export interface PartitionContextValue {
  partition: Partition | null;
  stats: PartitionStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<Partition | null>;
  setPartition: (partition: Partition | null) => void;
}

const FALLBACK: PartitionContextValue = {
  partition: null,
  stats: null,
  loading: true,
  error: null,
  refresh: async () => null,
  setPartition: () => undefined,
};

export const PartitionContext = createContext<PartitionContextValue>(FALLBACK);

export function usePartitionContext(): PartitionContextValue {
  return useContext(PartitionContext);
}
