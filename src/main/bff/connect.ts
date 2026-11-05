import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import { getConfig } from '../config/store';
import { openGatewayStream, type GatewayClientOptions } from './gateway';
import { errorPayload, sendJson } from './respond';

/**
 * 设备连接的 SSE 透传。
 *
 * `/connect/events` 是「设备在线」的定义：一条活着的长连接。桌面端不能直接连网关
 * （凭据与证书都在主进程），所以这里把上游 SSE 原样 pipe 给渲染进程，
 * 由渲染进程用 `EventSource` 解析 `hello` / `devices` / `command` 事件。
 *
 * 指令与状态上报走普通的 `/api/connect/state|command`，不需要单独代理。
 */
export async function handleConnectEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return;
  }

  const config = getConfig();
  if (!config.baseUrl) {
    sendJson(res, 503, errorPayload('server_not_configured', '还没有配置 Sakura Music 服务器'));
    return;
  }

  const client: GatewayClientOptions = {
    baseUrl: config.baseUrl,
    allowInvalidCert: config.allowInvalidCert,
  };

  let upstream;
  try {
    upstream = await openGatewayStream(client, `/api/connect/events${url.search}`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      timeoutMs: 12000,
    });
  } catch {
    if (!res.headersSent) {
      sendJson(res, 502, errorPayload('connect_unreachable', '无法连接设备服务'));
    }
    return;
  }

  if (upstream.status !== 200) {
    upstream.stream.resume();
    if (!res.headersSent) {
      sendJson(
        res,
        upstream.status,
        errorPayload('connect_failed', `设备服务返回 ${upstream.status}`),
      );
    }
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  upstream.stream.on('data', (chunk: Buffer) => {
    if (res.writableEnded) return;
    res.write(chunk);
  });
  upstream.stream.on('end', () => {
    if (!res.writableEnded) res.end();
  });
  upstream.stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  res.on('close', () => upstream.stream.destroy());
}
