import type { Agent, Task } from '@shared';
import { Avatar, Badge, Card, Icon } from '@ui';
import { fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { agentAvatarName, AgentStatusDot, agentTone } from './shared.tsx';

const MAX_CAPABILITIES = 6;

/** Agent 注册表卡片：身份、能力与记忆足迹的快速概览。 */
export function AgentCard({
  agent,
  recentTask,
  onOpen,
}: {
  agent: Agent;
  recentTask?: Task;
  onOpen: () => void;
}) {
  const stats = agent.stats ?? { memories: 0, privateMemories: 0, tasks: 0 };
  const capabilities = agent.capabilities ?? [];
  const hiddenCapabilities = Math.max(0, capabilities.length - MAX_CAPABILITIES);

  return (
    <Card hover pad className="vstack gap-12" style={{ cursor: 'pointer', height: '100%' }} onClick={onOpen}>
      <div className="between gap-12" style={{ alignItems: 'flex-start' }}>
        <div className="hstack gap-10" style={{ minWidth: 0 }}>
          <Avatar name={agentAvatarName(agent.name)} tone={agentTone(agent)} size="lg" square />
          <div style={{ minWidth: 0 }}>
            <div className="hstack gap-6 wrap" style={{ minWidth: 0 }}>
              <span className="strong truncate" style={{ fontSize: 14 }} title={agent.name}>
                {agent.name}
              </span>
              {agent.role ? (
                <Badge tone="cyan" size="sm">
                  {agent.role}
                </Badge>
              ) : null}
            </div>
            <div className="tiny dim mono truncate mt-4" title={agent.model || '未指定模型'}>
              {agent.model || '未指定模型'}
            </div>
          </div>
        </div>
        <AgentStatusDot status={agent.status} />
      </div>

      <div className="small muted clamp-2" style={{ minHeight: 38 }}>
        {agent.description || '暂无描述，可在详情中补充职责与能力边界。'}
      </div>

      <div className="chip-row">
        {capabilities.length ? (
          <>
            {capabilities.slice(0, MAX_CAPABILITIES).map((capability) => (
              <span key={capability} className="tag">
                {capability}
              </span>
            ))}
            {hiddenCapabilities > 0 ? <span className="tiny dim">+{hiddenCapabilities}</span> : null}
          </>
        ) : (
          <span className="tiny dim">未声明能力</span>
        )}
      </div>

      <div className="divider" />

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <div className="metric">
          <span className="metric-label">记忆</span>
          <span className="metric-value">{fmtInt(stats.memories)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">私有</span>
          <span className="metric-value">{fmtInt(stats.privateMemories)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">任务</span>
          <span className="metric-value">{fmtInt(stats.tasks)}</span>
        </div>
      </div>

      <div className="vstack gap-4" style={{ minWidth: 0 }}>
        <span className="tiny dim">最近任务</span>
        {recentTask ? (
          <div className="hstack gap-6" style={{ minWidth: 0 }}>
            <Icon name="branch" size={12} />
            <span className="small truncate" style={{ color: 'var(--text-soft)' }} title={recentTask.title}>
              {recentTask.title}
            </span>
          </div>
        ) : stats.tasks > 0 ? (
          <span className="small dim">参与 {fmtInt(stats.tasks)} 个任务（非主责）</span>
        ) : (
          <span className="small dim">尚无任务记录</span>
        )}
      </div>

      <div className="between gap-8">
        <span className="tiny dim" title={agent.lastActiveAt ? fmtFullDateTime(agent.lastActiveAt) : undefined}>
          {agent.lastActiveAt ? `最近活跃 ${fmtRelative(agent.lastActiveAt)}` : '尚无活动记录'}
        </span>
        <span className="tiny dim hstack gap-4">
          查看详情
          <Icon name="arrowRight" size={12} />
        </span>
      </div>
    </Card>
  );
}
