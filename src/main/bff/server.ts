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

/**
 * 进程内 BFF：只处理 API / 媒体 / SSE，不再托管页面。
 *
 * 页面由 `sakura://app` 协议提供（见 main/protocol），所有请求都由主进程的
 * 协议 handler 转发进来。因此端口可以随机、不必让页面知道，也不需要
 * `?k=` 302 和 Cookie 换票：令牌只存在于主进程 -> BFF 这一跳的内部 header。
 */

export interface BffOptions {
  /** 只用于开发时固定端口，方便本机调试；不再影响路由行为。 */
  dev: boolean;
}

export interface BffHandle {
  url: string;
  port: number;
  secret: string;
  close: () => Promise<void>;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  // 所有请求都要带主进程注入的令牌：端口即使被本机其它进程扫到也用不了。
  if (req.headers['x-sakura-bff'] !== secret) {
    sendJson(res, 403, errorPayload('forbidden', '本地访问令牌无效'));
    return;
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

  sendJson(res, 404, errorPayload('not_found', '未知的本地服务路径'));
}

export function startBff(options: BffOptions): Promise<BffHandle> {
  const secret = randomBytes(24).toString('base64url');
  const server = createServer((req, res) => {
    void route(req, res, secret).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, errorPayload('desktop_bff_error', '本地服务处理请求失败'));
      } else {
        res.end();
      }
    });
  });

  // 页面不再直接使用这个地址，随机端口只为避免与本机其它进程冲突。
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
