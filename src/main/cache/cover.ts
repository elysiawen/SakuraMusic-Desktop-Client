import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { URL } from 'node:url';
import { errorPayload, sendJson } from '../bff/respond';
import { getMedia, putMedia, touchMedia } from '../db/media';
import { coverCacheDir, coverLimitBytes, trimCache } from './index';

/**
 * 封面/头像缓存。
 *
 * 网易云、QQ 的封面 CDN 有防盗链与跨域限制，直接交给页面加载时既拿不到
 * 离线副本，也无法统计占用。这里统一改成同源 `/media/cover?url=...`：
 * 主进程不带任何 Sakura Cookie 去取图，按 URL 落盘，LRU 压回上限。
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface ImageMeta {
  contentType: string;
}

interface ImageResponse {
  status: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
}

function hash(url: string): string {
  return createHash('sha1').update(url, 'utf8').digest('hex');
}

function imageFile(url: string): string {
  return join(coverCacheDir(), `${hash(url)}.img`);
}

function readMeta(url: string): ImageMeta {
  return { contentType: getMedia('cover', hash(url))?.mime || 'image/jpeg' };
}

function writeMeta(url: string, meta: ImageMeta, bytes: number): void {
  try {
    putMedia('cover', hash(url), {
      total: null,
      mime: meta.contentType,
      bytes,
    });
  } catch (error) {
    console.error('[cache] 写入封面元数据失败：', error);
  }
}

function touchCover(url: string): void {
  try {
    touchMedia('cover', hash(url));
  } catch {
    // 访问时间只用于 LRU，失败不影响出图。
  }
}

function serveImage(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  contentType: string,
  cacheUrl: string,
): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    sendJson(res, 404, errorPayload('cover_missing', '封面缓存不存在'));
    return;
  }
  if (size <= 0) {
    sendJson(res, 404, errorPayload('cover_missing', '封面缓存为空'));
    return;
  }

  touchCover(cacheUrl);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': size,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  stream.pipe(res);
  res.on('close', () => stream.destroy());
}

function requestImage(
  target: URL,
  redirectsLeft: number,
): Promise<ImageResponse | null> {
  return new Promise((resolve) => {
    const isHttps = target.protocol === 'https:';
    const transport = (isHttps ? https : http) as typeof https;

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : isHttps ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Sakura Music Desktop',
        },
        timeout: 15000,
      },
      (upstream) => {
        const status = upstream.statusCode ?? 0;

        if (status >= 300 && status < 400 && upstream.headers.location && redirectsLeft > 0) {
          upstream.resume();
          try {
            const next = new URL(upstream.headers.location, target);
            void requestImage(next, redirectsLeft - 1).then(resolve);
          } catch {
            resolve(null);
          }
          return;
        }

        if (status !== 200) {
          upstream.resume();
          resolve(null);
          return;
        }

        request.setTimeout(0);
        upstream.setTimeout(0);
        resolve({ status, headers: upstream.headers, stream: upstream });
      },
    );

    request.setTimeout(15000, () => request.destroy());
    request.on('error', () => resolve(null));
    request.end();
  });
}

function headerValue(
  headers: IncomingHttpHeaders,
  key: string,
): string | undefined {
  const value = headers[key];
  return Array.isArray(value) ? value.join(', ') : value;
}

function forwardImage(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: ImageResponse,
  contentType: string,
  cacheTarget: string | null,
  cacheUrl: string,
): void {
  const length = headerValue(upstream.headers, 'content-length');
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  if (length) headers['Content-Length'] = length;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    upstream.stream.resume();
    res.end();
    return;
  }

  if (!cacheTarget) {
    upstream.stream.pipe(res);
    upstream.stream.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
    res.on('close', () => upstream.stream.destroy());
    return;
  }

  const out = createWriteStream(cacheTarget);
  let cacheFailed = false;

  out.on('error', () => {
    cacheFailed = true;
  });
  upstream.stream.on('data', (chunk: Buffer) => {
    if (!cacheFailed) out.write(chunk);
  });
  upstream.stream.once('end', () => {
    out.end();
  });
  out.once('close', () => {
    if (cacheFailed) {
      try {
        unlinkSync(cacheTarget);
      } catch {
        // ignore
      }
      return;
    }
    const file = imageFile(cacheUrl);
    try {
      renameSync(cacheTarget, file);
      let bytes = 0;
      try {
        bytes = statSync(file).size;
      } catch {
        // 文件刚被清理就按 0 记，不影响出图。
      }
      writeMeta(cacheUrl, { contentType }, bytes);
      trimCache('cover');
    } catch {
      try {
        unlinkSync(cacheTarget);
      } catch {
        // ignore
      }
    }
  });
  upstream.stream.on('error', () => {
    cacheFailed = true;
    out.destroy();
    if (!res.writableEnded) res.destroy();
  });
  res.on('close', () => {
    // 正常读完时 close 会在 end 之后触发，此时不要打断落盘。
    if (upstream.stream.readableEnded) return;
    cacheFailed = true;
    upstream.stream.destroy();
    out.destroy();
    try {
      unlinkSync(cacheTarget);
    } catch {
      // ignore
    }
  });

  upstream.stream.pipe(res);
}

/**
 * `/media/cover?url=...`。
 *
 * 命中磁盘缓存直接返回；缓存关闭（上限 0）时仍然代理，只是不落盘。
 * 上游失败但有旧图时用旧图，覆盖弱网/断网场景。
 */
export async function handleCover(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const raw = url.searchParams.get('url') ?? '';
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    sendJson(res, 400, errorPayload('invalid_cover_url', '封面地址无效'));
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    sendJson(res, 400, errorPayload('invalid_cover_url', '封面地址只支持 http/https'));
    return;
  }

  target.hash = '';
  const cacheUrl = target.href;
  const file = imageFile(cacheUrl);
  const cached = existsSync(file) && statSync(file).size > 0;
  if (cached) {
    serveImage(req, res, file, readMeta(cacheUrl).contentType, cacheUrl);
    return;
  }

  const upstream = await requestImage(target, 3);
  if (!upstream) {
    sendJson(res, 502, errorPayload('cover_unreachable', '封面加载失败'));
    return;
  }

  const contentType = headerValue(upstream.headers, 'content-type') ?? '';
  const knownLength = Number(headerValue(upstream.headers, 'content-length') ?? '');
  if (!contentType.toLowerCase().startsWith('image/') || (Number.isFinite(knownLength) && knownLength > MAX_IMAGE_BYTES)) {
    upstream.stream.resume();
    sendJson(res, 502, errorPayload('cover_invalid', '封面响应不是有效图片'));
    return;
  }

  const cacheTarget = coverLimitBytes() > 0 ? `${file}.part` : null;
  forwardImage(req, res, upstream, contentType, cacheTarget, cacheUrl);
}
