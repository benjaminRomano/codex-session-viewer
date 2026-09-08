import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/output/**', '**/outputs/**', '**/target/**'] },
  },
  worker: { format: 'es' },
  // Already-open clients can start workers after a rebuild. Keep their hashed
  // JS/WASM assets available instead of returning the SPA HTML for a stale URL.
  build: { target: 'es2022', emptyOutDir: false },
  test: { include: ['src/**/*.test.ts', 'tests/**/*.test.ts'], environment: 'node' },
});
