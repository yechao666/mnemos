import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'shared/src/index.ts'),
      '@ui': resolve(here, 'src/components/ui/index.tsx'),
      '@charts': resolve(here, 'src/components/charts/index.tsx'),
      '@lib': resolve(here, 'src/lib'),
    },
  },
  server: {
    port: 4381,
    strictPort: true,
    fs: { allow: [root] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:4380', changeOrigin: true },
      '/v1': { target: 'http://127.0.0.1:4380', changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
