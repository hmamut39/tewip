// Drift-lab server: serves lab/app/<LAB_VERSION>/ (v1 = what the tests were written for,
// v2 = the changed release) plus a fake orders API that is down in v2.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.LAB_PORT ?? 4180);
const VERSION = process.env.LAB_VERSION === 'v2' ? 'v2' : 'v1';

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/api/health') return void res.writeHead(200).end('ok');
  if (path === '/api/orders') {
    // ENV case: in v2 the orders service is unavailable.
    return void (VERSION === 'v2' ? res.writeHead(503).end('{"error":"orders service unavailable"}') : res.writeHead(200).end('[]'));
  }
  try {
    const body = await readFile(join(import.meta.dirname, 'app', VERSION, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`lab ${VERSION} on http://127.0.0.1:${PORT}`));
