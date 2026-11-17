import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@lib/auth.tsx';
import { useDocumentTitle, useMediaQuery } from '@lib/hooks.ts';
import { CommandPalette } from '../components/shell/CommandPalette.tsx';
import { Sidebar } from '../components/shell/Sidebar.tsx';
import { Topbar } from '../components/shell/Topbar.tsx';
import { routeTitle } from '../components/shell/nav.ts';

/** 控制台外壳：侧边栏 + 顶栏 + 命令面板 + 内容区。 */
export function AppShell() {
  const location = useLocation();
  const { partitions } = useAuth();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useDocumentTitle(routeTitle(location.pathname, partitions));

  // 路由变化后收起移动端抽屉与命令面板，避免遮挡新页面。
  useEffect(() => {
    setDrawerOpen(false);
    setPaletteOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar
        open={drawerOpen}
        collapsed={collapsed}
        onClose={() => setDrawerOpen(false)}
        onToggleCollapse={() => setCollapsed((value) => !value)}
      />
      {drawerOpen && isMobile ? (
        <div className="sidebar-backdrop" role="presentation" onClick={() => setDrawerOpen(false)} />
      ) : null}

      <div className="app-body">
        <Topbar
          onOpenMenu={() => setDrawerOpen(true)}
          onToggleSidebar={() => setCollapsed((value) => !value)}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        <main className="app-main">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
