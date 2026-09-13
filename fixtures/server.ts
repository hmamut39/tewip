// Minimal offline fixture server: serves fixtures/ statically plus a few fake API routes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.FIXTURE_PORT ?? 4173);
const ROOT = import.meta.dirname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/api/orders') {
    res.writeHead(500, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ error: 'orders service unavailable' }));
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const rel = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (rel.startsWith('..')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fixture server on http://127.0.0.1:${PORT}`);
});
