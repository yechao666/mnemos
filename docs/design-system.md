# Mnemos 控制台设计系统

> 本文件是 Mnemos v6 控制台（信息架构：组织 → 分区 → 人 → 记忆）的视觉与组件约定。
> **禁止**新增 UI 依赖、**禁止**修改 `web/src/styles/*.css`、`web/src/components/ui/*`、`web/src/components/charts/*`。
> 需要新样式时：优先用已有类 + 少量 inline style；确需全局样式请在汇报中提出，由 Lead 统一添加。

## 1. 技术栈与路径别名

- React 19 + Vite 7 + TypeScript（原生 TS，无 Tailwind、无 UI 库、无图表库）
- 别名（vite + tsconfig 已配置）：
  - `@shared` → `shared/src/index.ts`（领域类型 + 常量）
  - `@ui` → `web/src/components/ui/index.tsx`（组件库）
  - `@charts` → `web/src/components/charts/index.tsx`（SVG 图表）
  - `@lib/*` → `web/src/lib/*`（`api.ts` / `auth.tsx` / `hooks.ts` / `format.ts` / `tone.ts` / `partition-context.tsx` / `types.ts` / `constants.ts`）

## 2. 视觉语言：Aurora Console

- 深空黑底（`--bg`）+ 极光渐变（紫 `--violet` → 青 `--cyan`），所有强调色只用 token 变量。
- 表面层级：`.card`（玻璃 + 1px 发丝边）→ `.popover` / `.modal` / `.drawer`（更高层级、更强阴影）。
- 字体：系统字体栈；数字一律 `font-variant-numeric: tabular-nums`（`.mono`）。
- 圆角：卡片 `--radius-lg(16)`，按钮/输入 `--radius-sm(9)`，徽章全圆。
- 间距：4 的倍数；页面区块间距 20px，卡片内 16–20px。
- 动效：`var(--ease)`，180–320ms；进入用 `fade-up`（`.page` 已内置）。
- 文案：中文、专业、克制；**不使用 emoji**；金额/数量使用 `format.ts` 的格式化函数。
- 响应式：≤1024px 侧边栏抽屉化；≤1180px KPI 两列；≤900px 单列。表格用 `.table-wrap` 横向滚动。

## 3. 布局类

| 类 | 用途 |
| --- | --- |
| `.app-shell` `.app-body` `.app-main` | 外层骨架（AppShell 用） |
| `.sidebar` `.sidebar.open` `.sidebar-backdrop` `.sidebar-brand` `.brand-mark` `.brand-name` `.brand-sub` | 侧边栏 |
| `.nav` `.nav-section` `.nav-item` `.nav-item.active` `.nav-badge` `.sidebar-foot` `.usage-meter` `.usage-meter-head` | 导航 |
| `.topbar` `.crumbs` `.crumb` `.crumb-sep` | 顶栏 / 面包屑 |
| `.popover` `.popover-item` `.popover-item.active` `.popover-label` `.popover-sep` | 下拉面板 |
| `.search-trigger` `.user-chip` `.user-meta` `.user-name` `.user-role` | 顶栏控件 |
| `.page` `.page-head` `.page-eyebrow` `.page-title` `.page-desc` `.page-actions` | 页面头 |
| `.section` `.section-head` `.section-title` `.divider` | 区块 |
| `.grid` `.grid-2` `.grid-3` `.grid-4` `.span-2` `.span-3` `.span-all` | 网格 |
| `.split` `.detail-panel` `.metric-grid` `.metric` `.metric-label` `.metric-value` | 双栏详情 |
| `.hstack` `.vstack` `.between` `.center` `.wrap` `.grow` `.ml-auto` | flex 工具 |
| `.gap-2/4/6/8/10/12/16/20/24` `.mt-4…mt-24` `.mb-8/12/16` | 间距 |
| `.muted` `.dim` `.soft` `.tiny` `.small` `.strong` `.mono` `.truncate` `.clamp-2` `.right` `.nowrap` | 文本工具 |
| `.text-gradient` `.kbd` `.pill` `.chip` `.chip-row` `.tag` `.dot` `.status-dot` | 小元素 |

## 4. 组件库（`@ui`）

```tsx
import { Button, Card, Badge, Stat, Table, Modal, Drawer, Tabs, Segmented,
  Pagination, Input, Select, Textarea, Field, Switch, Checkbox, SearchInput,
  PageHead, SectionHead, EmptyState, LoadingBlock, ErrorState, Skeleton,
  Avatar, Callout, CodeBlock, CopyButton, Dropdown, ConfirmDialog, useToast,
  Icon, Kbd, Progress, Delta, Spinner, IconButton } from '@ui';
```

关键 props：

- `Button`：`variant: primary|secondary|ghost|outline|danger`，`size: sm|md|lg`，`loading`，`icon`（IconName），`iconRight`，`block`
- `IconButton`：`icon`、`label`（必填，aria-label）
- `Card`：`hover`、`accent: 'violet'|'cyan'`、`glow`、`pad`；也可用 `.card-pad` 自行控制内边距
- `Badge`：`tone`（violet/cyan/pink/amber/lime/blue/red/slate/green）、`dot`、`solid`、`outline`、`size="sm"`
- `Stat`：`label`、`value`、`unit`、`icon`、`tone`、`delta`（数字）、`hint`、`spark`（number[]）
- `Table<T>`：`columns: Column<T>[]`（`key/header/render/align/mono/width`）、`rows`、`rowKey`、`onRowClick`、`loading`、`empty`、`selectedKeys`+`onToggleKey`（批量选择）
- `Modal`：`open/onClose/title/description/footer/size`；`Drawer`：`open/onClose/title/subtitle/footer/wide`
- `ConfirmDialog`：危险操作统一用它
- `Dropdown`：`trigger`（节点或 `(open)=>节点`）、`children`（节点或 `(close)=>节点`）、`align`
- `useToast()`：`toast.success(msg)` / `.error` / `.info` / `.warning`
- `Segmented`：`options: {value,label}[]`、`value`、`onChange`
- `Tabs`：`tabs: {key,label,count?}[]`、`value`、`onChange`（受控；页面内切换用）
- `Pagination`：`page/totalPages/total/pageSize/onChange`
- `ErrorState`：`message`、`onRetry`

## 5. 图表（`@charts`）

```tsx
import { LineChart, BarChart, DonutChart, Sparkline, CHART_PALETTE } from '@charts';

<LineChart points={[{label:'11/01', values:[12, 40]}]} series={[{name:'写入', color:'var(--chart-1)'},{name:'检索', color:'var(--chart-2)'}]} height={220} />
<BarChart data={[{label:'搜索', value: 1200}]} horizontal />
<DonutChart data={[{label:'偏好', value: 120, color:'#a78bfa'}]} centerValue="1,204" centerLabel="记忆总量" />
<Sparkline data={[3,5,2,8]} color="var(--chart-2)" />
```

## 6. 数据层

```tsx
import { api, ApiError } from '@lib/api.ts';
import { useAsync, useDebounced, useInterval } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtInt, fmtCompact, fmtBytes, fmtMs, fmtRelative, fmtDateTime, fmtDay, fmtPct } from '@lib/format.ts';
import { toneForCategory, toneForStatus, toneForRole, toneForAction, actionLabel, ROLE_LABEL } from '@lib/tone.ts';
import { usePartitionContext } from '@lib/partition-context.tsx';
```

- 数据加载统一 `useAsync(() => api.xxx(), [deps])` → `{data, loading, error, refresh}`；加载用 `Skeleton`/`LoadingBlock`，失败用 `ErrorState`，空数据用 `EmptyState`。
- 所有写操作后调用 `toast.success`；破坏性操作先 `ConfirmDialog`。
- 时间显示用相对时间（`fmtRelative`）+ `title` 展示精确时间。
- 不用 `Math.random()` 造数据；无数据时展示空态。

## 7. 页面骨架模板

```tsx
export function XxxPage() {
  const { data, loading, error, refresh } = useAsync(() => api.xxx(), []);
  return (
    <div className="page">
      <PageHead eyebrow="..." title="..." desc="..." actions={<Button variant="primary" icon="plus">操作</Button>} />
      <div className="grid grid-4">{/* Stat */}</div>
      <Card>{/* 内容 */}</Card>
    </div>
  );
}
```

## 8. 质量红线

- 每个页面必须覆盖：加载态、错误态、空态、窄屏布局。
- 列表页遵循 v6 游标协议（`items/nextCursor/partitionStats`）：人列表用 `WindowedList` 虚拟滚动 +
  滚动加载，不要一次性拉全量，也不要用 `Pagination` 造 page/total；头部统计读列表响应里的
  `partitionStats`（或分区上下文），不要另发逐行/全表统计请求。
- 不使用 `any`；类型来自 `@shared`；不要 `console.log`。
- 不修改别人负责的文件；先读再写；不要提交 git。
- 完成后运行 `pnpm --filter @mnemos/web run build` 与
  `pnpm exec tsc -p web/tsconfig.json --noEmit`，确保零报错。


## 外壳滚动（桌面 App 式）

- `html/body/#root` 固定为 `height:100%; overflow:hidden`，浏览器页面本身不滚动。
- `.app-shell` 占满 `100dvh`；`.sidebar` 与 `.topbar` 固定；唯一滚动容器是 `.app-scroll`（`overflow-y:auto; overscroll-behavior:contain`）。
- 内容区 `.app-main` 在滚动容器内居中（max-width + padding），路由切换自动回到容器顶部。
- 登录页 `.auth` 自持滚动；移动端同样只有内容容器滚动，抽屉/弹窗用 fixed 覆盖。
