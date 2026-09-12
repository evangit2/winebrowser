#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = await realpath(resolve(projectRoot, 'dist'));
const basePath = '/winebrowser/';
const port = Number(process.env.PORT ?? 4193);
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.webp', 'image/webp'],
  ['.zip', 'application/zip'],
]);

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(text);
}

async function fileForPath(pathname) {
  if (pathname === '/') return { redirect: basePath };
  if (pathname === basePath.slice(0, -1)) return { redirect: basePath };
  if (!pathname.startsWith(basePath)) return null;

  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice(basePath.length));
  } catch {
    return null;
  }
  if (relativePath.includes('\0') || relativePath.includes('\\')) return null;
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '.' || part === '..')) return null;

  const candidate = resolve(distRoot, relativePath || 'index.html');
  const candidateRelative = relative(distRoot, candidate);
  if (
    candidateRelative === '..' ||
    candidateRelative.startsWith(`..${sep}`) ||
    resolve(distRoot, candidateRelative) !== candidate
  )
    return null;

  let realFile;
  try {
    realFile = await realpath(candidate);
  } catch {
    return null;
  }
  const realRelative = relative(distRoot, realFile);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`)) return null;

  try {
    const info = await stat(realFile);
    if (!info.isFile()) return null;
    return { path: realFile, size: info.size };
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  } catch {
    sendText(response, 400, 'Bad request\n');
    return;
  }

  const file = await fileForPath(pathname);
  if (file?.redirect) {
    response.writeHead(302, {
      Location: file.redirect,
      'Content-Length': '0',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end();
    return;
  }
  if (!file) {
    sendText(response, 404, 'Not found\n');
    return;
  }

  response.writeHead(200, {
    'Content-Length': file.size,
    'Content-Type': mimeTypes.get(extname(file.path).toLowerCase()) ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file.path).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Pages-style static server: http://127.0.0.1:${port}${basePath}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
