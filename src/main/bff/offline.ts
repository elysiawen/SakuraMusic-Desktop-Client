import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import type { OfflineDownloadRequest } from '@shared/offline';
import { downloadTrack, type DownloadProgress } from '../offline/download';
import {
  clearItems,
  filePathOf,
  findItem,
  library,
  removeItem,
} from '../offline/store';
import { errorPayload, sendJson } from './respond';

/**
 * 本地离线库。
 *
 * 文件是用户主动下载的音频，索引在主进程；渲染进程只通过 `/offline/stream/<key>`
 * 播放，因此不需要知道文件路径，也不受 file:// 限制。
 *
 * Range 必须支持，否则拖动进度条会退化成整首重新加载。
 */

const MAX_BODY_BYTES = 512 * 1024;

/**
 * 下载进度用 SSE 推给界面。
 *
 * POST 仍然等整首下完才返回（成功/失败都在响应里），SSE 只负责「下到多少了」，
 * 这样界面不必轮询，也不会因为断线而丢掉下载结果。
 */
const subscribers = new Set<ServerResponse>();

function broadcast(progress: DownloadProgress): void {
  if (subscribers.size === 0) return;

  const payload = `data: ${JSON.stringify(progress)}\n\n`;
  for (const subscriber of [...subscribers]) {
    if (subscriber.writableEnded) {
      subscribers.delete(subscriber);
      continue;
    }
    try {
      subscriber.write(payload);
    } catch {
      subscribers.delete(subscriber);
    }
  }
}

function openEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  subscribers.add(res);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(': ping\n\n');
    } catch {
      // 真正的清理交给 close 事件。
    }
  }, 15000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/** 应用退出前结束所有 SSE，否则 `server.close()` 会一直等这些长连接。 */
export function closeAllOfflineEvents(): void {
  for (const subscriber of subscribers) {
    try {
      subscriber.end();
    } catch {
      // 已经断开就算了。
    }
  }
  subscribers.clear();
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isDownloadRequest(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OfflineDownloadRequest {
  return (
    typeof value.key === 'string' &&
    (value.platform === 'netease' || value.platform === 'qq') &&
    typeof value.id === 'string' &&
    typeof value.quality === 'string' &&
    typeof value.title === 'string' &&
    Array.isArray(value.artists)
  );
}

function serveFile(req: IncomingMessage, res: ServerResponse, path: string, mime: string): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    sendJson(res, 404, errorPayload('offline_missing', '本地文件已丢失，请重新下载'));
    return;
  }

  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const baseHeaders: Record<string, string | number> = {
    'Content-Type': mime || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const rawStart = match[1];
      const rawEnd = match[2];

      let start = rawStart ? Number(rawStart) : 0;
      let end = rawEnd ? Number(rawEnd) : size - 1;
      // `bytes=-N`：要末尾 N 个字节。
      if (!rawStart && rawEnd) {
        start = Math.max(0, size - Number(rawEnd));
        end = size - 1;
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      end = Math.min(end, size - 1);

      res.writeHead(206, {
        ...baseHeaders,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = createReadStream(path, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export async function handleOffline(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const rest = url.pathname.slice('/offline/'.length);
  const [action, ...tail] = rest.split('/');

  if (action === 'list' && req.method === 'GET') {
    sendJson(res, 200, library());
    return;
  }

  if (action === 'events' && req.method === 'GET') {
    openEvents(req, res);
    return;
  }

  if (action === 'download' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (error) {
      sendJson(res, 400, errorPayload('bad_request', error instanceof Error ? error.message : '请求无效'));
      return;
    }

    if (!isDownloadRequest(body)) {
      sendJson(res, 400, errorPayload('bad_request', '下载参数不完整'));
      return;
    }

    try {
      const item = await downloadTrack(body, broadcast);
      sendJson(res, 200, { item });
    } catch (error) {
      sendJson(
        res,
        502,
        errorPayload('download_failed', error instanceof Error ? error.message : '下载失败'),
      );
    }
    return;
  }

  if (action === 'item' && req.method === 'DELETE') {
    const key = decodeURIComponent(tail.join('/'));
    if (!removeItem(key)) {
      sendJson(res, 404, errorPayload('offline_missing', '没有这条下载记录'));
      return;
    }
    sendJson(res, 200, { ok: true, ...library() });
    return;
  }

  if (action === 'all' && req.method === 'DELETE') {
    clearItems();
    sendJson(res, 200, { ok: true, ...library() });
    return;
  }

  if (action === 'stream' && (req.method === 'GET' || req.method === 'HEAD')) {
    const key = decodeURIComponent(tail.join('/'));
    const item = findItem(key);
    if (!item) {
      sendJson(res, 404, errorPayload('offline_missing', '这首歌还没有下载到本地'));
      return;
    }

    const path = filePathOf(item);
    if (!existsSync(path)) {
      sendJson(res, 404, errorPayload('offline_missing', '本地文件已丢失，请重新下载'));
      return;
    }

    serveFile(req, res, path, item.mime);
    return;
  }

  sendJson(res, 404, errorPayload('not_found', '未知的离线接口'));
}
