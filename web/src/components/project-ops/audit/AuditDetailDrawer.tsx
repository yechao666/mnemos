import type { AuditLog } from '@shared';
import { fmtFullDateTime } from '@lib/format.ts';
import { actionLabel } from '@lib/tone.ts';
import { Avatar, Badge, CodeBlock, Drawer, Field, type Tone } from '@ui';

const ACTOR_META: Record<AuditLog['actorType'], { label: string; tone: Tone }> = {
  user: { label: '用户', tone: 'violet' },
  api_key: { label: 'API Key', tone: 'cyan' },
  system: { label: '系统', tone: 'slate' },
};

export function AuditDetailDrawer({ log, onClose }: { log: AuditLog | null; onClose: () => void }) {
  if (!log) return null;
  const actor = ACTOR_META[log.actorType] ?? { label: String(log.actorType), tone: 'slate' as Tone };
  const detailJson = JSON.stringify(log.detail ?? {}, null, 2);

  return (
    <Drawer
      open
      onClose={onClose}
      title="审计详情"
      subtitle={`${actionLabel(log.action)} · ${fmtFullDateTime(log.createdAt)}`}
      wide
    >
      <div className="vstack gap-20">
        <div className="metric-grid">
          <div className="metric">
            <span className="metric-label">执行者</span>
            <span className="hstack gap-8">
              <Avatar name={log.actorLabel} tone={actor.tone} size="sm" />
              <span className="small soft">{log.actorLabel}</span>
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">执行者类型</span>
            <span>
              <Badge tone={actor.tone} size="sm">
                {actor.label}
              </Badge>
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">动作</span>
            <span className="small soft">
              {actionLabel(log.action)} <span className="mono tiny dim">({log.action})</span>
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">资源</span>
            <span className="small soft">
              {log.resourceType}
              {log.resourceId ? <span className="mono tiny dim"> / {log.resourceId}</span> : null}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">执行者 ID</span>
            <span className="mono tiny dim">{log.actorId ?? '—'}</span>
          </div>
          <div className="metric">
            <span className="metric-label">IP 地址</span>
            <span className="mono tiny dim">{log.ip ?? '—'}</span>
          </div>
          <div className="metric">
            <span className="metric-label">发生时间</span>
            <span className="small soft">{fmtFullDateTime(log.createdAt)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">审计 ID</span>
            <span className="mono tiny dim">{log.id}</span>
          </div>
        </div>

        <Field label="User-Agent" hint="客户端在请求中声明的标识，可用于排查来源。">
          <div className="code-inline" style={{ whiteSpace: 'normal', wordBreak: 'break-all', lineHeight: 1.7 }}>
            {log.userAgent ?? '—'}
          </div>
        </Field>

        <div>
          <div className="doc-h3 mb-8">详情 JSON</div>
          <CodeBlock code={detailJson} language="json" title="detail.json" />
        </div>
      </div>
    </Drawer>
  );
}
