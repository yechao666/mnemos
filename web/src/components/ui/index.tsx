import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.tsx';
import { Sparkline } from '../charts/index.tsx';

export type Tone = 'violet' | 'cyan' | 'pink' | 'amber' | 'lime' | 'blue' | 'red' | 'slate' | 'green';

export { Icon };
export type { IconName };

/* ================================================================== */
/* 按钮                                                                */
/* ================================================================== */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  block,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variant !== 'secondary' ? `btn-${variant}` : '',
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
    block ? 'btn-block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === 'sm' ? 13 : 15} /> : null}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: 'sm' | 'md';
  variant?: ButtonVariant;
}

export function IconButton({ icon, label, size = 'md', variant = 'ghost', className = '', ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={['btn', 'btn-icon', variant !== 'secondary' ? `btn-${variant}` : '', size === 'sm' ? 'btn-sm' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
    </button>
  );
}

/* ================================================================== */
/* 表面                                                                */
/* ================================================================== */

export interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  accent?: 'violet' | 'cyan';
  glow?: boolean;
  pad?: boolean;
  style?: CSSProperties;
  onClick?: () => void;
}

export function Card({ children, className = '', hover, accent, glow, pad, style, onClick }: CardProps) {
  const classes = [
    'card',
    hover ? 'card-hover' : '',
    accent === 'violet' ? 'card-accent' : accent === 'cyan' ? 'card-accent-cyan' : '',
    glow ? 'card-glow' : '',
    pad ? 'card-pad' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} style={style} onClick={onClick}>
      {children}
    </div>
  );
}

export function SectionHead({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-head">
      <div>
        <div className="section-title">{title}</div>
        {desc ? <div className="card-sub">{desc}</div> : null}
      </div>
      {actions ? <div className="hstack">{actions}</div> : null}
    </div>
  );
}

export function PageHead({
  eyebrow,
  title,
  desc,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
        <h1 className="page-title">{title}</h1>
        {desc ? <p className="page-desc">{desc}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

/* ================================================================== */
/* 表单                                                                */
/* ================================================================== */

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      {label ? (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="req">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
  suffix?: ReactNode;
}

export function Input({ icon, suffix, className = '', ...rest }: InputProps) {
  if (!icon && !suffix) return <input className={`input ${className}`} {...rest} />;
  return (
    <div className="input-wrap">
      {icon ? (
        <span className="input-icon">
          <Icon name={icon} size={15} />
        </span>
      ) : null}
      <input className={`input ${className}`} style={icon ? undefined : { paddingLeft: 11 }} {...rest} />
      {suffix ? <span className="input-suffix">{suffix}</span> : null}
    </div>
  );
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  options,
  className = '',
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { options: SelectOption[] }) {
  return (
    <select className={`select ${className}`} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      {label ? <span className="switch-label">{label}</span> : null}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  autoFocus,
  onSubmit,
  className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  className?: string;
}) {
  return (
    <div className={`input-wrap ${className}`} style={{ minWidth: 220 }}>
      <span className="input-icon">
        <Icon name="search" size={15} />
      </span>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) onSubmit();
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* 展示元素                                                            */
/* ================================================================== */

export function Badge({
  tone = 'slate',
  children,
  size,
  dot,
  solid,
  outline,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  size?: 'sm';
  dot?: boolean;
  solid?: boolean;
  outline?: boolean;
  className?: string;
}) {
  return (
    <span
      className={[
        'badge',
        `tone-${tone}`,
        size === 'sm' ? 'badge-sm' : '',
        solid ? 'badge-solid' : outline ? 'badge-outline' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot ? <span className="dot" style={{ width: 5, height: 5, boxShadow: 'none' }} /> : null}
      {children}
    </span>
  );
}

export function Dot({ tone = 'green', pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={`dot tone-${tone} ${pulse ? 'dot-pulse' : ''}`} />;
}

export function Avatar({
  name,
  tone = 'violet',
  size = 'md',
  square,
}: {
  name: string;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  square?: boolean;
}) {
  const initials = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return '?';
    if (/[\u4e00-\u9fff]/.test(trimmed)) {
      // 小尺寸头像只放一个字，避免 22px 圆内两字挤压
      return size === 'sm' ? trimmed.slice(-1) : trimmed.slice(-2);
    }
    return trimmed
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('');
  }, [name, size]);
  return (
    <span
      className={[`avatar tone-${tone}`, size === 'sm' ? 'avatar-sm' : size === 'lg' ? 'avatar-lg' : '', square ? 'avatar-square' : '']
        .filter(Boolean)
        .join(' ')}
      title={name}
    >
      {initials}
    </span>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner-lg" style={{ width: size, height: size }} />;
}

export function Skeleton({
  w = '100%',
  h = 12,
  circle,
  style,
}: {
  w?: number | string;
  h?: number | string;
  circle?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`skeleton ${circle ? 'skeleton-circle' : ''}`}
      style={{ display: 'block', width: w, height: h, ...style }}
    />
  );
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon = 'layers',
  title,
  description,
  action,
  compact,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="empty" style={compact ? { padding: '30px 20px' } : undefined}>
      <div className="empty-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="empty-title">{title}</div>
      {description ? <div className="empty-desc">{description}</div> : null}
      {action ? <div className="empty-actions">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon="alert"
      title="加载失败"
      description={message ?? '请求未成功，请稍后重试。'}
      action={onRetry ? <Button size="sm" icon="refresh" onClick={onRetry}>重试</Button> : undefined}
    />
  );
}

export function Progress({ value, tone = 'violet', thin }: { value: number; tone?: Tone; thin?: boolean }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className={`progress ${thin ? 'progress-thin' : ''}`}>
      <div
        className="progress-bar"
        style={{
          width: `${clamped}%`,
          background: `linear-gradient(90deg, var(--${tone}), color-mix(in srgb, var(--${tone}) 55%, #ffffff))`,
        }}
      />
    </div>
  );
}

export function Delta({ value, suffix = '%' }: { value: number; suffix?: string }) {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const cls = normalized > 0 ? 'delta-up' : normalized < 0 ? 'delta-down' : 'delta-flat';
  const icon = normalized > 0 ? 'arrowUpRight' : normalized < 0 ? 'arrowDownRight' : 'minus';
  return (
    <span className={`delta ${cls}`}>
      <Icon name={icon} size={11} strokeWidth={2.2} />
      {Math.abs(normalized).toFixed(1)}
      {suffix}
    </span>
  );
}

export function Stat({
  label,
  value,
  unit,
  icon,
  tone = 'violet',
  delta,
  deltaSuffix,
  hint,
  spark,
  sparkColor,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  icon?: IconName;
  tone?: Tone;
  delta?: number;
  deltaSuffix?: string;
  hint?: ReactNode;
  spark?: number[];
  sparkColor?: string;
}) {
  return (
    <div className={`kpi tone-${tone}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon ? (
          <span className="kpi-icon">
            <Icon name={icon} size={14} />
          </span>
        ) : null}
      </div>
      <div className="kpi-value">
        {value}
        {unit ? <span className="kpi-unit">{unit}</span> : null}
      </div>
      <div className="kpi-foot">
        {typeof delta === 'number' ? <Delta value={delta} suffix={deltaSuffix ?? '%'} /> : null}
        {hint ? <span className="truncate">{hint}</span> : null}
        {spark && spark.length > 1 ? (
          <span style={{ marginLeft: 'auto' }}>
            <Sparkline data={spark} color={sparkColor ?? 'var(--violet)'} width={68} height={22} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Callout({
  tone = 'violet',
  icon = 'info',
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div className={`callout tone-${tone}`}>
      <span style={{ color: `var(--${tone})`, flexShrink: 0, marginTop: 1 }}>
        <Icon name={icon} size={15} />
      </span>
      <div>{children}</div>
    </div>
  );
}

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={done ? 'check' : 'copy'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          /* 忽略剪贴板不可用 */
        }
        setDone(true);
        window.setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? '已复制' : label}
    </Button>
  );
}

export function CodeBlock({ code, title, language = 'bash' }: { code: string; title?: string; language?: string }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="mono">{title ?? language}</span>
        <CopyButton value={code} />
      </div>
      <pre className="code-body">{code}</pre>
    </div>
  );
}

/* ================================================================== */
/* 交互式覆盖层                                                        */
/* ================================================================== */

function useEscape(handler: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handler, active]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${size === 'lg' ? 'modal-lg' : size === 'sm' ? 'modal-sm' : ''}`} role="dialog" aria-modal="true">
        {title ? (
          <div className="modal-head">
            <div>
              <div className="modal-title">{title}</div>
              {description ? <div className="modal-desc">{description}</div> : null}
            </div>
            <IconButton icon="x" label="关闭" onClick={onClose} />
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <div className="drawer-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={`drawer ${wide ? 'drawer-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle ? <div className="modal-desc">{subtitle}</div> : null}
          </div>
          <IconButton icon="x" label="关闭" onClick={onClose} />
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = '确认',
  tone = 'red',
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: Tone;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant={tone === 'red' ? 'danger' : 'primary'}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="small muted">此操作将被记录到审计日志，且可能无法撤销。</div>
    </Modal>
  );
}

export function Dropdown({
  trigger,
  children,
  align = 'left',
  width,
}: {
  trigger: ReactNode | ((open: boolean) => ReactNode);
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="project-switcher" ref={ref}>
      <div onClick={() => setOpen((v) => !v)}>{typeof trigger === 'function' ? trigger(open) : trigger}</div>
      {open ? (
        <div className="popover" style={{ ...(align === 'right' ? { right: 0 } : { left: 0 }), top: 'calc(100% + 8px)', width }}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: string; label: ReactNode; count?: number }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={t.key === value}
          className={`tab ${t.key === value ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {typeof t.count === 'number' ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={`seg-item ${o.value === value ? 'active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const pages = useMemo(() => {
    const list: number[] = [];
    const start = Math.max(1, Math.min(page - 2, totalPages - 4));
    for (let i = start; i < start + 5 && i <= totalPages; i += 1) list.push(i);
    return list;
  }, [page, totalPages]);

  return (
    <div className="between" style={{ padding: '12px 16px' }}>
      <div className="tiny dim">
        共 {total.toLocaleString('zh-CN')} 条 · 每页 {pageSize} 条
      </div>
      <div className="hstack gap-4">
        <IconButton icon="chevronLeft" label="上一页" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} />
        {pages.map((p) => (
          <button
            key={p}
            className={`btn btn-sm ${p === page ? 'btn-secondary' : 'btn-ghost'}`}
            style={{ minWidth: 30, justifyContent: 'center' }}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ))}
        <IconButton
          icon="chevronRight"
          label="下一页"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        />
      </div>
    </div>
  );
}

/* ================================================================== */
/* 表格                                                                */
/* ================================================================== */

export interface Column<T> {
  key: string;
  header: ReactNode;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  render?: (row: T, index: number) => ReactNode;
  mono?: boolean;
  className?: string;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  empty,
  selectedKeys,
  onToggleKey,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  selectedKeys?: Set<string>;
  onToggleKey?: (key: string) => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} h={34} />
        ))}
      </div>
    );
  }
  if (!rows.length) return <div>{empty ?? <EmptyState title="暂无数据" description="调整筛选条件或创建第一条记录。" compact />}</div>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {onToggleKey ? <th style={{ width: 36 }} aria-label="选择" /> : null}
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, textAlign: c.align ?? 'left' }}
                className={c.className}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row);
            const selected = selectedKeys?.has(key);
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{
                  cursor: onRowClick ? 'pointer' : undefined,
                  background: selected ? 'rgba(139,124,255,0.08)' : undefined,
                }}
              >
                {onToggleKey ? (
                  <td onClick={(e) => e.stopPropagation()} style={{ paddingRight: 0 }}>
                    <input
                      type="checkbox"
                      aria-label="选择行"
                      checked={Boolean(selected)}
                      onChange={() => onToggleKey(key)}
                      style={{ accentColor: '#8b7cff', width: 15, height: 15 }}
                    />
                  </td>
                ) : null}
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={[c.mono ? 'cell-mono' : '', c.className ?? ''].join(' ')}
                    style={{ textAlign: c.align ?? 'left' }}
                  >
                    {c.render ? c.render(row, i) : String((row as unknown as Record<string, unknown>)[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ================================================================== */
/* Toast                                                               */
/* ================================================================== */

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title?: string;
  message: string;
}

interface ToastApi {
  push: (t: Omit<ToastItem, 'id'>) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_META: Record<ToastKind, { tone: Tone; icon: IconName }> = {
  success: { tone: 'green', icon: 'checkCircle' },
  error: { tone: 'red', icon: 'xCircle' },
  info: { tone: 'blue', icon: 'info' },
  warning: { tone: 'amber', icon: 'alert' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++idRef.current;
      setItems((prev) => [...prev.slice(-3), { ...t, id }]);
      window.setTimeout(() => remove(id), 4200);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (message, title) => push({ kind: 'success', message, title }),
      error: (message, title) => push({ kind: 'error', message, title }),
      info: (message, title) => push({ kind: 'info', message, title }),
      warning: (message, title) => push({ kind: 'warning', message, title }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toaster">
          {items.map((t) => {
            const meta = KIND_META[t.kind];
            return (
              <div key={t.id} className={`toast tone-${meta.tone}`}>
                <span className="toast-icon">
                  <Icon name={meta.icon} size={13} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {t.title ? <div style={{ color: 'var(--text)', fontWeight: 600, fontSize: 12.5 }}>{t.title}</div> : null}
                  <div style={{ marginTop: t.title ? 2 : 0 }}>{t.message}</div>
                </div>
                <button className="toast-close" onClick={() => remove(t.id)} aria-label="关闭提示">
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

const FALLBACK_TOAST: ToastApi = {
  push: () => undefined,
  success: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warning: () => undefined,
};

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? FALLBACK_TOAST;
}
