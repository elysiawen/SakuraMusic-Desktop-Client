import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEV_BFF_PORT } from '@shared/constants';
import { handleCover } from '../cache/cover';
import { handleApi } from './apiProxy';
import { handleConnectEvents } from './connect';
import { handleMedia } from './media';
import { closeAllOfflineEvents, handleOffline } from './offline';
import { errorPayload, sendJson } from './respond';
import { serveStatic } from './static';

/**
 * 本地 BFF（Backend For Frontend）。
 *
 * 只监听回环地址。生产模式下还会托管渲染进程的静态产物，因此页面、API、音频
 * 全部同源，浏览器侧的 CORS / HttpOnly Cookie 限制在这套架构里都不存在。
 *
 * 防本机其它进程滥用：生产模式首次打开页面必须带一次性 `?k=<secret>`，
 * 服务端据此下发 HttpOnly 的本地访问 Cookie，之后 `/api` 才可用。
 */

export interface BffOptions {
  dev: boolean;
  rendererRoot: string;
}

export interface BffHandle {
  url: string;
  port: number;
  secret: string;
  close: () => Promise<void>;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) {
      try {
        return decodeURIComponent(trimmed.slice(eq + 1));
      } catch {
        return trimmed.slice(eq + 1);
      }
    }
  }
  return null;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: BffOptions,
  secret: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (!options.dev && url.searchParams.get('k') === secret) {
    // 只摘掉一次性令牌，其余 query 必须原样带回：独立播放窗口 / 桌面歌词窗口
    // 靠 `?window=nowplaying` / `?window=lyric` 决定挂哪个根组件。重定向成光秃秃的
    // `/` 会让发布版弹出窗口加载整个主壳，看起来就是一层底色、播放页没出来。
    url.searchParams.delete('k');
    const query = url.searchParams.toString();
    res.writeHead(302, {
      Location: `${pathname}${query ? `?${query}` : ''}`,
      'Set-Cookie': `sakura_bff=${secret}; Path=/; HttpOnly; SameSite=Strict`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  const needsSecret =
    pathname.startsWith('/api/') ||
    pathname.startsWith('/media/') ||
    pathname.startsWith('/offline/') ||
    pathname.startsWith('/connect/');

  if (!options.dev && needsSecret) {
    if (parseCookie(req.headers.cookie, 'sakura_bff') !== secret) {
      sendJson(res, 403, errorPayload('forbidden', '本地访问令牌无效'));
      return;
    }
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  if (pathname.startsWith('/connect/events')) {
    await handleConnectEvents(req, res, url);
    return;
  }
  if (pathname === '/media/cover') {
    await handleCover(req, res, url);
    return;
  }
  if (pathname.startsWith('/media/')) {
    handleMedia(req, res, url);
    return;
  }
  if (pathname.startsWith('/offline/')) {
    await handleOffline(req, res, url);
    return;
  }

  if (options.dev) {
    sendJson(res, 404, errorPayload('not_found', '开发模式下页面由 Vite 提供，BFF 只处理 /api'));
    return;
  }

  serveStatic(req, res, options.rendererRoot, pathname);
}

export function startBff(options: BffOptions): Promise<BffHandle> {
  const secret = randomBytes(24).toString('base64url');
  const server = createServer((req, res) => {
    void route(req, res, options, secret).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, errorPayload('desktop_bff_error', '本地服务处理请求失败'));
      } else {
        res.end();
      }
    });
  });

  // 固定端口只用于开发和冒烟测试；正式运行随机端口，避免与本机其它进程冲突。
  const envPort = Number(process.env.SAKURA_BFF_PORT);
  const port = options.dev ? DEV_BFF_PORT : Number.isFinite(envPort) && envPort > 0 ? envPort : 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        secret,
        close: () =>
          new Promise<void>((done) => {
            // 进度 SSE 是长连接，不主动结束会让 close 一直等下去。
            closeAllOfflineEvents();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
