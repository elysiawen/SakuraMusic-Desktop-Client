import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import { MAX_API_BODY } from '@shared/constants';
import { captureSetCookie, clearSessionCookie, hasSessionCookie } from '../auth/cookieVault';
import { platformCredentialHeader } from '../auth/platformVault';
import { getConfig } from '../config/store';
import {
  GatewayError,
  openGatewayStream,
  requestGatewayJson,
  type GatewayClientOptions,
} from './gateway';
import { proxyAudioStream, registerMedia } from './media';
import { errorPayload, sendJson } from './respond';

/**
 * `/api/*` 反代。
 *
 * 渲染进程只看到同源响应；会话 Cookie 由主进程注入，`Set-Cookie` 在转发前被摘掉。
 * SSE 单独走流式分支：不能收集完整响应，也不能设 socket 超时。
 */

const AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/register']);

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_API_BODY) {
        fail(new BodyTooLargeError('请求体超过 2MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

function handleFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof BodyTooLargeError) {
    sendJson(res, 413, errorPayload('payload_too_large', '请求体超过 2MB'));
    return;
  }
  if (error instanceof GatewayError) {
    if (error.code === 'certificate') {
      sendJson(res, 502, errorPayload('gateway_certificate', '网关证书不受信任，请检查服务器设置'));
      return;
    }
    if (error.code === 'timeout') {
      sendJson(res, 504, errorPayload('gateway_timeout', '网关响应超时'));
      return;
    }
    if (error.code === 'network') {
      sendJson(res, 502, errorPayload('gateway_unreachable', '无法连接网关，请确认服务器地址与网络'));
      return;
    }
  }
  sendJson(res, 500, errorPayload('desktop_bff_error', '桌面端转发请求失败'));
}

async function proxySse(
  client: GatewayClientOptions,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const upstream = await openGatewayStream(client, path, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
    timeoutMs: 15000,
  });

  if (upstream.status === 401) {
    clearSessionCookie();
    upstream.stream.resume();
    sendJson(res, 401, errorPayload('unauthorized', '登录状态已过期，请重新登录'));
    return;
  }

  if (upstream.status >= 400) {
    upstream.stream.resume();
    sendJson(res, upstream.status, errorPayload('upstream_error', `网关返回 ${upstream.status}`));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders();

  upstream.stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  upstream.stream.pipe(res);

  res.on('close', () => {
    upstream.stream.destroy();
  });
}

/**
 * `play/resolve` 的响应改写：
 * - 把平台 CDN 直链登记成随机媒体 id，渲染进程只拿 `/media/<id>`；
 * - 保留网关代理地址作为 `media.proxy`；
 * - 隐去 `direct` 里的请求头，避免把防盗链参数散落到渲染进程与日志里。
 */
function rewritePlayResolve(upstreamBody: Buffer, requestBody: Buffer | undefined): Buffer {
  try {
    const request = JSON.parse(requestBody?.toString('utf8') ?? '{}') as {
      platform?: string;
      id?: string;
      quality?: string;
    };
    const result = JSON.parse(upstreamBody.toString('utf8')) as {
      url?: string;
      direct?: { url: string; headers?: Record<string, string> };
      actualQuality?: string;
    };

    if (!result?.url || !request.platform || !request.id) return upstreamBody;

    const mediaId = registerMedia({
      platform: request.platform,
      trackId: request.id,
      quality: result.actualQuality ?? request.quality ?? 'high',
      proxyPath: result.url,
      direct: result.direct
        ? { url: result.direct.url, headers: result.direct.headers ?? {} }
        : undefined,
    });

    return Buffer.from(
      JSON.stringify({
        ...result,
        direct: undefined,
        media: {
          direct: result.direct ? `/media/${mediaId}` : undefined,
          proxy: result.url,
        },
      }),
    );
  } catch {
    return upstreamBody;
  }
}

/**
 * `rooms/source` 的响应改写：把「用对方会员解析出来的 CDN 地址」登记成同源媒体 id。
 *
 * 渲染进程设不了 `Referer` 等请求头，CSP 也只允许同源媒体（`media-src 'self'`），
 * 所以直链与请求头都留在主进程，页面只拿到 `/media/<id>`。
 */
function rewriteRoomSource(upstreamBody: Buffer, requestBody: Buffer | undefined): Buffer {
  try {
    const request = JSON.parse(requestBody?.toString('utf8') ?? '{}') as {
      platform?: string;
      trackKey?: string;
      quality?: string;
    };
    const result = JSON.parse(upstreamBody.toString('utf8')) as {
      url?: string;
      headers?: Record<string, string>;
      quality?: string;
      [key: string]: unknown;
    };

    if (!result?.url) return upstreamBody;

    const mediaId = registerMedia({
      platform: request.platform ?? 'shared',
      trackId: request.trackKey ?? '',
      quality: result.quality ?? request.quality ?? 'high',
      proxyPath: result.url,
      direct: { url: result.url, headers: result.headers ?? {} },
      directOnly: true,
    });

    return Buffer.from(
      JSON.stringify({
        ...result,
        url: undefined,
        headers: undefined,
        media: { direct: `/media/${mediaId}` },
      }),
    );
  } catch {
    return upstreamBody;
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const config = getConfig();
  if (!config.baseUrl) {
    sendJson(res, 503, errorPayload('server_not_configured', '还没有配置 Sakura Music 服务器'));
    return;
  }

  const client: GatewayClientOptions = {
    baseUrl: config.baseUrl,
    allowInvalidCert: config.allowInvalidCert,
  };
  const path = `${url.pathname}${url.search}`;
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    if (url.pathname === '/api/connect/events') {
      await proxySse(client, path, req, res);
      return;
    }

    // 音频必须流式转发；走下面的 JSON 分支会把整首歌读进内存。
    if (url.pathname === '/api/stream') {
      await proxyAudioStream(req, res, url);
      return;
    }

    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    const headers: Record<string, string> = {};
    const contentType = req.headers['content-type'];
    if (contentType) headers['Content-Type'] = contentType;

    /*
     * 「仅本机」模式的平台凭据由主进程注入。
     * 渲染进程传来的同名头一律不转发：凭据只应来自本机保险库，不接受页面侧伪造。
     */
    const credential = platformCredentialHeader();
    if (credential) headers['X-Sakura-Credential'] = credential;

    const upstream = await requestGatewayJson(client, path, {
      method,
      body,
      headers,
      timeoutMs: 20000,
    });

    captureSetCookie(upstream.headers['set-cookie']);

    // 会话失效时清掉本地令牌；登录/注册的 401 是「密码不对」，不能当成会话过期。
    if (upstream.status === 401 && hasSessionCookie() && !AUTH_PATHS.has(url.pathname)) {
      clearSessionCookie();
    }

    const responseBody =
      url.pathname === '/api/play/resolve' && upstream.status === 200
        ? rewritePlayResolve(upstream.body, body)
        : url.pathname === '/api/rooms/source' && upstream.status === 200
          ? rewriteRoomSource(upstream.body, body)
          : upstream.body;

    const responseHeaders: Record<string, string | number> = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': responseBody.length,
    };
    const upstreamType = upstream.headers['content-type'];
    responseHeaders['Content-Type'] = upstreamType ?? 'application/json; charset=utf-8';

    res.writeHead(upstream.status, responseHeaders);
    res.end(responseBody);
  } catch (error) {
    handleFailure(res, error);
  }
}
