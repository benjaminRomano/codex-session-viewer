import { createServer } from 'vite';
// An isolated server prevents development hot reloads from interrupting file streams.
const server = await createServer({
  server: { host: '127.0.0.1', port: 5177, strictPort: true, hmr: false },
});
await server.listen();
