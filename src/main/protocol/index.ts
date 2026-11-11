import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { net, protocol } from 'electron';

/**
 * 页面与全部请求共用的固定 origin。
 *
 * 以前生产版把页面托管在 `http://127.0.0.1:<随机端口>`：origin 每次重启都变，
 * localStorage 跟着失效，只能额外做一份主进程状态镜像；页面还得靠 `?k=` 302
 * 换 Cookie，而 dev 由 Vite 提供页面，CSP / 重定向 / 资源 404 的语义全都不一样。
 *
 * 现在 dev 和 release 都从 `sakura://app` 加载，只有「静态文件从哪来」不同：
 * dev 转发到 Vite dev server，release 直接读 out/renderer。API / 媒体 / SSE
 * 一律由同一个 handler 转发到进程内 BFF，页面永远看不到端口与令牌。
 */

export const APP_SCHEME = 'sakura';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;

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

const BFF_PREFIXES = ['/api/', '/media/', '/offline/', '/connect/'];

/** Host 指向 sakura://app，编码与长度由 Chromium 重算；这些头带过去只会出错。 */
const STRIP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'upgrade-insecure-requests',
]);

export interface AppProtocolOptions {
  /** out/renderer 的绝对路径。 */
  rendererRoot: string;
  /** dev 时 Vite dev server 根地址（无尾斜杠）；生产为 null。 */
  devServerUrl: string | null;
  /** 进程内 BFF 根地址（端口随机，页面不可见）。 */
  bffUrl: string;
  /** 内部访问令牌：只出现在主进程 -> BFF 这一跳。 */
  secret: string;
}

/** 必须在 app.whenReady() 之前调用，且整个进程只能调一次。 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

function collectHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });
  return headers;
}

function isBffPath(pathname: string): boolean {
  return BFF_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * API / 封面 / 音频 Range / SSE：流式透传，不缓冲、不落地。
 *
 * 用主进程的 node:http 直连本机 BFF，而不是 net.fetch：后者走 Chromium 网络栈，
 * 同一个 127.0.0.1 origin 只有 6 条连接。快速切歌时页面 abort 只取消「页面 →
 * 协议层」这一跳，协议层请求的 signal 实测并不会触发，于是废弃的 resolve 把
 * 连接占满，用户最后点的那首要排队等它们超时才轮到。
 */
async function forwardToBff(
  request: Request,
  options: AppProtocolOptions,
  pathAndQuery: string,
): Promise<Response> {
  const headers = collectHeaders(request);
  headers['x-sakura-bff'] = options.secret;
  // JSON 请求体很小，读成字符串再发，省掉 ReadableStream duplex 的兼容问题。
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.text() : undefined;
  const target = new URL(options.bffUrl);

  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: pathAndQuery,
        method: request.method,
        headers: {
          ...headers,
          ...(body !== undefined
            ? { 'content-length': String(Buffer.byteLength(body, 'utf8')) }
            : {}),
        },
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        // hop-by-hop 头不能塞进 Web Response，长度由它按 body 自己算。
        responseHeaders.delete('transfer-encoding');
        responseHeaders.delete('connection');
        responseHeaders.delete('keep-alive');
        resolve(
          new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 502,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body, 'utf8');
    req.end();
  });
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function serveAsset(
  request: Request,
  options: AppProtocolOptions,
  pathAndQuery: string,
  pathname: string,
): Promise<Response> {
  // dev：Vite 负责把 index.html / 模块转换好；协议层只转发，保留 HMR 的 ?t= 等 query。
  if (options.devServerUrl) {
    return net.fetch(options.devServerUrl + pathAndQuery, {
      method: request.method,
      headers: collectHeaders(request),
    });
  }

  const root = resolve(options.rendererRoot);
  const relative = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(root, `.${relative}`);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return notFound();
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': String(data.length),
      // ES module 必须带正确 MIME；nosniff 阻止浏览器把 HTML 猜成 JS。
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control':
        ext === '.html'
          ? 'no-cache, no-store, must-revalidate'
          : 'public, max-age=31536000, immutable',
    };
    // CSP 写在 index.html 的 meta 里，dev / release 是同一份，不需要响应头。
    return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers });
  } catch {
    // 缺文件就是 404：以前回退 index.html 会让动态 import 拿到 HTML 后静默失败。
    return notFound();
  }
}

/** 在 app.whenReady() 之后、任何窗口 loadURL 之前调用。 */
export function registerAppProtocol(options: AppProtocolOptions): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const pathAndQuery = url.pathname + url.search;
    try {
      if (isBffPath(url.pathname)) return await forwardToBff(request, options, pathAndQuery);
      return await serveAsset(request, options, pathAndQuery, url.pathname);
    } catch {
      return new Response('Local service unavailable', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  });
}
