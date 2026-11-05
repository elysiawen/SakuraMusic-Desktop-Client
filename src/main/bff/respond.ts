import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/** 原样返回已缓存的 JSON 文本，避免重复序列化。 */
export function sendRawJson(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

export function errorPayload(code: string, message: string): unknown {
  return { error: { code, message } };
}
