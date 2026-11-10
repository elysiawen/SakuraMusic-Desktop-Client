import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/** 生产模式下 BFF 托管的渲染进程静态资源。 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self' ws:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options: { html: boolean },
): void {
  const stat = statSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    // 带内容哈希的资源长期缓存；入口页绝不缓存，发版后立刻拿到新清单。
    'Cache-Control': options.html
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=31536000, immutable',
  };
  if (options.html) headers['Content-Security-Policy'] = CSP;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathname: string,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400);
    res.end();
    return;
  }

  const rootPath = resolve(root);
  const relative = decoded === '/' ? '/index.html' : decoded;
  const filePath = resolve(rootPath, `.${relative}`);

  if (filePath !== rootPath && !filePath.startsWith(rootPath + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath).toLowerCase();
    sendFile(req, res, filePath, { html: ext === '.html' });
    return;
  }

  // 静态资源缺文件绝不能回落到 HTML：浏览器拿到 200 + text/html 的 index.html，
  // 动态 import 只会抛一个笼统的解析错误，Vue 异步组件又会把失败渲染成空节点，
  // 表现就是全屏播放页只剩 AppShell 那层深色底色。SPA 回退只给页面路由。
  const looksLikeAsset =
    decoded.startsWith('/assets/') ||
    /\.(?:js|mjs|css|json|map|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|txt)$/i.test(decoded);
  if (looksLikeAsset) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Asset not found.');
    return;
  }

  // SPA 路由回退：没匹配到文件的路径交给 index.html。
  const indexFile = join(rootPath, 'index.html');
  if (existsSync(indexFile)) {
    sendFile(req, res, indexFile, { html: true });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Renderer build not found. Run `npm run build` first.');
}
