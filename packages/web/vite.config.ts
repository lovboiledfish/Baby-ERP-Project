import { defineConfig } from 'vite';

/**
 * Dev: `npm run dev -w @steward/web` (http://127.0.0.1:5173) proxies the API to the
 * instance on :3000. Build: `npm run build -w @steward/web` writes dist/, which the
 * server serves (with SPA fallback) at http://127.0.0.1:3000/now/nav.
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
