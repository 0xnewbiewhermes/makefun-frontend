// Local static server for app/ (Node 22, standard library only): `node serve.ts [--port 8080]`, then open
// http://localhost:8080. Serves files under app/ only, with the MIME types ES modules need, and no caching so an edit
// shows on reload. A development convenience, not a production server.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(fileURLToPath(new URL('./app', import.meta.url)));
const portFlag = process.argv.indexOf('--port');
const port = portFlag > -1 ? Number(process.argv[portFlag + 1]) || 8080 : 8080;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function resolveAppFile(urlPath: string): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(join(appRoot, pathname));
  if (file !== appRoot && !file.startsWith(appRoot + sep)) return null;
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

createServer(async (request, response) => {
  const file = await resolveAppFile(request.url ?? '/');
  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const body = await readFile(file);
  response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(request.method === 'HEAD' ? undefined : body);
}).listen(port, '127.0.0.1', () => console.log(`serving app/ on http://localhost:${port}`));
