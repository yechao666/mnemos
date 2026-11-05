import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorState,
  LoadingBlock,
  SectionHead,
  Table,
  type Column,
} from '@ui';

/** 项目上下文尚未就绪（或失败）时的统一占位。 */
export function PendingProject({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card pad>
      {loading ? (
        <LoadingBlock label="正在载入项目信息…" />
      ) : (
        <ErrorState message={error ?? '无法确定当前项目，请返回项目列表后重试。'} onRetry={onRetry} />
      )}
    </Card>
  );
}

/**
 * 设置页分区容器：标题 + 描述 + 表单 + 保存状态。
 * 所有分区共用同一套脏检查 / 保存中 / 失败提示的视觉规则。
 */
export function SettingsSection({
  title,
  desc,
  children,
  dirty,
  saving,
  disabled,
  error,
  onSave,
  saveLabel = '保存更改',
  action,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  error?: string | null;
  onSave: () => void;
  saveLabel?: string;
  action?: ReactNode;
}) {
  return (
    <Card pad>
      <SectionHead title={title} desc={desc} actions={action} />
      <div className="vstack gap-16 mt-16">{children}</div>
      {error ? (
        <div className="mt-16">
          <Callout tone="red" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}
      <div className="divider mt-20" />
      <div className="between">
        <span className="tiny dim">{dirty ? '有未保存的更改' : '所有更改均已保存'}</span>
        <Button
          variant="primary"
          icon="check"
          loading={saving}
          disabled={!dirty || disabled}
          onClick={onSave}
        >
          {saveLabel}
        </Button>
      </div>
    </Card>
  );
}

/**
 * 为宽表格提供外层横向滚动与最小宽度。
 * 组件库的 Table 在窄屏会被自动布局压扁，这里保证列宽不被挤压。
 */
export function TableScroller({ minWidth, children }: { minWidth?: number; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={minWidth ? { minWidth } : undefined}>{children}</div>
    </div>
  );
}

/** 文档中的端点行：METHOD + 路径。 */
export function Endpoint({
  method,
  path,
  note,
}: {
  method: string;
  path: string;
  note?: ReactNode;
}) {
  const normalized = method.toLowerCase();
  return (
    <div className="endpoint">
      <span className={`method method-${normalized}`}>{method.toUpperCase()}</span>
      <span className="mono">{path}</span>
      {note ? (
        <span className="tiny dim" style={{ marginLeft: 'auto' }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

export interface DocParam {
  name: string;
  type: string;
  required?: boolean;
  desc: ReactNode;
}

/** 文档参数说明表。 */
export function DocParamTable({
  items,
  nameHeader = '参数',
}: {
  items: DocParam[];
  nameHeader?: string;
}) {
  const columns: Column<DocParam>[] = [
    {
      key: 'name',
      header: nameHeader,
      width: 190,
      render: (row) => <span className="mono">{row.name}</span>,
    },
    {
      key: 'type',
      header: '类型',
      width: 110,
      render: (row) => <span className="tiny dim mono">{row.type}</span>,
    },
    {
      key: 'required',
      header: '必填',
      width: 64,
      render: (row) =>
        row.required ? (
          <Badge tone="red" size="sm">
            是
          </Badge>
        ) : (
          <span className="tiny dim">否</span>
        ),
    },
    {
      key: 'desc',
      header: '说明',
      render: (row) => <span className="small muted">{row.desc}</span>,
    },
  ];

  return (
    <TableScroller minWidth={720}>
      <Table columns={columns} rows={items} rowKey={(row) => row.name} />
    </TableScroller>
  );
}
