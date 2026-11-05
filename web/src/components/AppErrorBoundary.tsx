import { Component, type ReactNode } from 'react';
import { Badge, Button, Card } from '@ui';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  copied: boolean;
  copyFailed: boolean;
}

function fingerprintOf(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}

/**
 * 应用级错误边界：渲染期异常时展示品牌化错误页。
 * 堆栈仅写入剪贴板供反馈，不渲染到 UI，避免泄露内部实现细节。
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { error: null, copied: false, copyFailed: false };
  }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      copied: false,
      copyFailed: false,
    };
  }

  private copyDetail = (): void => {
    const { error } = this.state;
    if (!error) return;
    const pathname = typeof window === 'undefined' ? '—' : window.location.pathname;
    const detail = [
      'Mnemos 控制台渲染错误',
      `时间：${new Date().toISOString()}`,
      `页面：${pathname}`,
      `错误：${error.name}: ${error.message}`,
      error.stack ? `堆栈：\n${error.stack}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      this.setState({ copyFailed: true, copied: false });
      return;
    }
    void navigator.clipboard.writeText(detail).then(
      () => this.setState({ copied: true, copyFailed: false }),
      () => this.setState({ copyFailed: true, copied: false }),
    );
  };

  override render(): ReactNode {
    const { error, copied, copyFailed } = this.state;
    if (!error) return this.props.children;

    const pathname = typeof window === 'undefined' ? '—' : window.location.pathname;
    const code = fingerprintOf(`${error.name}:${error.message}`);

    return (
      <div className="center" style={{ minHeight: '100vh', padding: 24 }}>
        <Card pad style={{ maxWidth: 540, width: '100%' }}>
          <div className="hstack gap-10" style={{ marginBottom: 24 }}>
            <div
              className="brand-mark"
              aria-hidden="true"
              style={{ width: 34, height: 34, borderRadius: 10, fontSize: 15 }}
            >
              M
            </div>
            <div>
              <div className="brand-name">Mnemos</div>
              <div className="brand-sub">企业记忆基础设施</div>
            </div>
            <span className="ml-auto">
              <Badge tone="red" size="sm" dot>渲染异常</Badge>
            </span>
          </div>

          <h1 className="page-title" style={{ fontSize: 21 }}>页面渲染出错</h1>
          <p className="page-desc" style={{ marginTop: 8 }}>
            控制台遇到了未预期的错误，已隔离本次异常，服务端数据未受影响。
            请重载页面后重试；若问题持续出现，请复制错误信息并联系平台管理员。
          </p>

          <div className="divider mt-20" />

          <div className="hstack wrap gap-8 mt-16">
            <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
              重载页面
            </Button>
            <Button icon={copied ? 'check' : 'copy'} onClick={this.copyDetail}>
              {copied ? '已复制' : '复制错误信息'}
            </Button>
            <a className="btn btn-ghost" href="/">返回概览</a>
          </div>

          {copyFailed ? (
            <div className="tiny dim mt-8">复制失败，请使用浏览器开发者工具复制错误信息。</div>
          ) : null}

          <div className="divider mt-20" />
          <div className="between wrap gap-8 tiny dim mt-12">
            <span>错误编号 {code}</span>
            <span className="mono truncate" title={pathname}>页面 {pathname}</span>
          </div>
        </Card>
      </div>
    );
  }
}
