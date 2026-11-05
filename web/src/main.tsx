import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastProvider } from './components/ui/index.tsx';
import { AuthProvider } from './lib/auth.tsx';
import { AppRoutes } from './app/routes.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 节点缺失');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppErrorBoundary>
            <AppRoutes />
          </AppErrorBoundary>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
