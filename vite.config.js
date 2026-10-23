import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runTrace } = require('./src/tracer');

function traceApiPlugin() {
  return {
    name: 'trace-api',
    configureServer(server) {
      server.middlewares.use('/api/trace', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const result = await runTrace(payload);
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), traceApiPlugin()],
  base: './',
  root: 'src/renderer',
  build: { outDir: '../../renderer-dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
