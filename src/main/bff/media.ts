import { randomBytes } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import {
  audioCacheKey,
  createAudioCacheWriter,
  serveAudioFromCache,
} from '../cache/audio';
import { getConfig } from '../config/store';
import {
  openGatewayStream,
  requestGatewayJson,
  type GatewayClientOptions,
  type GatewayStreamResponse,
} from './gateway';
import { errorPayload, sendJson } from './respond';

/**
 * 音频取流代理。
 *
 * 渲染进程只拿 `/media/<id>`，由主进程负责：
 *   1. 优先请求 CDN 直链，并附加平台要求的 Referer / Origin / UA；
 *   2. 直连失败（防盗链、绑 IP、跨网）时透明回退到网关 `/api/stream`；
 *   3. 透传 Range，支持拖动进度条；
 *   4. 令牌过期（401）时用 platform + id + quality 重新解析一次。
 *
 * 这样渲染进程的 `<audio>` 不需要任何自定义请求头，也不接触平台地址与凭据。
 */

interface DirectTarget {
  url: string;
  headers: Record<string, string>;
}

export interface MediaRegistration {
  platform: string;
  trackId: string;
  quality: string;
  /** 网关代理地址（相对 `/api/stream...`）；一起听共享地址也用它存 CDN 直链。 */
  proxyPath: string;
  direct?: DirectTarget;
  /**
   * 只走直连，直连失败就报错。
   *
   * 一起听共享地址的「代理路径」其实就是那条 CDN 地址本身，网关无法按路径转发它，
   * 所以失败时不能退回 `/api/stream`（那会拿一个完整 URL 当路径拼，必然 404）。
   */
  directOnly?: boolean;
}

interface MediaEntry extends MediaRegistration {
  id: string;
  createdAt: number;
  lastUsed: number;
}

interface ResolvedPlayback {
  url?: string;
  direct?: DirectTarget;
}

const entries = new Map<string, MediaEntry>();
const ENTRY_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;
let lastSweep = 0;

/** `/api/stream?t=...` 的令牌无法反解，用一次性的映射把令牌绑到稳定缓存键。 */
const streamKeys = new Map<string, { key: string; at: number }>();
const STREAM_KEY_TTL_MS = 20 * 60 * 1000;

function normalizeStreamPath(value: string): string | null {
  try {
    const parsed = new URL(value, 'http://127.0.0.1');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function sweepStreamKeys(now: number): void {
  for (const [path, item] of streamKeys) {
    if (now - item.at > STREAM_KEY_TTL_MS) streamKeys.delete(path);
  }
}

/** `play/resolve` 时记住代理地址对应哪首歌，供 `/api/stream` 命中音频缓存。 */
export function rememberStreamCacheKey(
  proxyPath: string,
  platform: string,
  trackId: string,
  quality: string,
): void {
  const path = normalizeStreamPath(proxyPath);
  if (!path || !path.startsWith('/api/stream')) return;
  const now = Date.now();
  sweepStreamKeys(now);
  streamKeys.set(path, {
    key: audioCacheKey(platform, trackId, quality),
    at: now,
  });
}

function streamCacheKey(url: URL): string | null {
  const path = `${url.pathname}${url.search}`;
  const item = streamKeys.get(path);
  if (!item) return null;
  if (Date.now() - item.at > STREAM_KEY_TTL_MS) {
    streamKeys.delete(path);
    return null;
  }
  return item.key;
}

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;

  for (const [id, entry] of entries) {
    if (now - entry.lastUsed > ENTRY_TTL_MS) entries.delete(id);
  }

  if (entries.size <= MAX_ENTRIES) return;
  const sorted = [...entries.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  for (const entry of sorted.slice(0, entries.size - MAX_ENTRIES)) {
    entries.delete(entry.id);
  }
}

/** 把一次 `play/resolve` 的直连信息登记成随机媒体 id。 */
export function registerMedia(input: MediaRegistration): string {
  const now = Date.now();
  sweep(now);

  const id = randomBytes(18).toString('base64url');
  entries.set(id, {
    ...input,
    id,
    createdAt: now,
    lastUsed: now,
  });
  return id;
}

export interface DirectResponse {
  status: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
}

/** 直连平台 CDN；离线下载也复用这一段（带防盗链头与重定向处理）。 */
export function openDirect(
  target: URL,
  headers: Record<string, string>,
  method: string,
  range: string | undefined,
  redirectsLeft: number,
): Promise<DirectResponse | null> {
  return new Promise((resolve) => {
    const isHttps = target.protocol === 'https:';
    const transport = (isHttps ? https : http) as typeof https;

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : isHttps ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          ...(range ? { Range: range } : {}),
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
        timeout: 15000,
      },
      (upstream) => {
        const status = upstream.statusCode ?? 0;

        if (status >= 300 && status < 400 && upstream.headers.location && redirectsLeft > 0) {
          upstream.resume();
          try {
            const next = new URL(upstream.headers.location, target);
            void openDirect(next, headers, method, range, redirectsLeft - 1).then(resolve);
          } catch {
            resolve(null);
          }
          return;
        }

        if (status !== 200 && status !== 206) {
          upstream.resume();
          resolve(null);
          return;
        }

        // 长音频不能被 15 秒的建连超时误伤。
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

function copyAudioHeaders(
  res: ServerResponse,
  headers: IncomingHttpHeaders,
  status: number,
): void {
  const forwarded: Record<string, string | number> = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  for (const key of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    const value = headers[key];
    if (value !== undefined) forwarded[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  if (!forwarded['content-type']) forwarded['content-type'] = 'audio/mpeg';
  if (!forwarded['accept-ranges']) forwarded['accept-ranges'] = 'bytes';

  res.writeHead(status, forwarded);
}

interface UpstreamCacheInfo {
  /** 上游这次响应从哪个字节开始（与缓存键无关的绝对偏移）。 */
  start: number;
  total: number | null;
  mime: string;
}

function headerText(headers: IncomingHttpHeaders, key: string): string | undefined {
  const value = headers[key];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** 从上游响应头推断缓存写入的起点与完整长度。 */
function upstreamCacheInfo(
  status: number,
  headers: IncomingHttpHeaders,
): UpstreamCacheInfo | null {
  const mime = headerText(headers, 'content-type') ?? 'audio/mpeg';
  // 上游偶尔会用 200 返回 HTML/JSON 错误页，别把它当成音频写进缓存。
  if (/^(text\/|application\/(json|xml))|html/i.test(mime)) return null;

  if (status === 200) {
    const length = Number(headerText(headers, 'content-length') ?? '');
    return {
      start: 0,
      total: Number.isFinite(length) && length > 0 ? length : null,
      mime,
    };
  }

  if (status !== 206) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(
    headerText(headers, 'content-range') ?? '',
  );
  if (!match) return null;

  const start = Number(match[1]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isFinite(start)) return null;
  return {
    start,
    total: total !== null && Number.isFinite(total) ? total : null,
    mime,
  };
}

function pipeAudio(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: IncomingHttpHeaders,
  stream: IncomingMessage,
  cacheKey: string | null,
): void {
  copyAudioHeaders(res, headers, status);
  if (req.method === 'HEAD') {
    stream.resume();
    res.end();
    return;
  }

  const info = cacheKey ? upstreamCacheInfo(status, headers) : null;
  const writer =
    info && cacheKey
      ? createAudioCacheWriter(cacheKey, info.start, info.total, info.mime)
      : null;
  let ended = false;

  if (writer) {
    stream.on('data', (chunk: Buffer) => writer.write(chunk));
    stream.once('end', () => {
      ended = true;
      writer.finish();
    });
    stream.once('error', () => writer.abort());
  }

  stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  stream.pipe(res);
  res.on('close', () => {
    if (!ended) writer?.abort();
    stream.destroy();
  });
}

async function refreshEntry(entry: MediaEntry): Promise<boolean> {
  const config = getConfig();
  if (!config.baseUrl) return false;

  const client: GatewayClientOptions = {
    baseUrl: config.baseUrl,
    allowInvalidCert: config.allowInvalidCert,
  };

  try {
    const response = await requestGatewayJson(client, '/api/play/resolve', {
      method: 'POST',
      body: Buffer.from(
        JSON.stringify({
          platform: entry.platform,
          id: entry.trackId,
          quality: entry.quality,
        }),
      ),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 15000,
    });
    if (response.status !== 200) return false;

    const parsed = JSON.parse(response.body.toString('utf8')) as ResolvedPlayback;
    if (!parsed.url) return false;

    entry.proxyPath = parsed.url;
    entry.direct = parsed.direct
      ? { url: parsed.direct.url, headers: parsed.direct.headers ?? {} }
      : undefined;
    return true;
  } catch {
    return false;
  }
}

async function streamEntry(
  entry: MediaEntry,
  req: IncomingMessage,
  res: ServerResponse,
  range: string | undefined,
  retried: boolean,
  cacheKey: string,
): Promise<void> {
  if (entry.direct) {
    let target: URL | null = null;
    try {
      target = new URL(entry.direct.url);
    } catch {
      target = null;
    }

    if (target) {
      const direct = await openDirect(target, entry.direct.headers, req.method ?? 'GET', range, 3);
      if (direct) {
        entry.lastUsed = Date.now();
        pipeAudio(req, res, direct.status, direct.headers, direct.stream, cacheKey);
        return;
      }
    }
  }

  // 一起听共享地址没有可用的网关回退：这里的「代理路径」就是那条 CDN 地址本身。
  if (entry.directOnly) {
    sendJson(res, 502, errorPayload('shared_source_failed', '共享音频地址加载失败'));
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

  let upstream: GatewayStreamResponse;
  try {
    upstream = await openGatewayStream(client, entry.proxyPath, {
      method: req.method ?? 'GET',
      headers: {
        ...(range ? { Range: range } : {}),
        Accept: '*/*',
      },
      timeoutMs: 15000,
    });
  } catch {
    if (!res.headersSent) sendJson(res, 502, errorPayload('stream_unreachable', '无法连接音频源'));
    return;
  }

  if (upstream.status === 401 && !retried) {
    upstream.stream.resume();
    if (await refreshEntry(entry)) {
      await streamEntry(entry, req, res, range, true, cacheKey);
      return;
    }
  }

  if (upstream.status >= 400) {
    upstream.stream.resume();
    if (!res.headersSent) {
      sendJson(
        res,
        upstream.status,
        errorPayload('stream_failed', `音频源返回 ${upstream.status}`),
      );
    }
    return;
  }

  entry.lastUsed = Date.now();
  pipeAudio(req, res, upstream.status, upstream.headers, upstream.stream, cacheKey);
}

export function handleMedia(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const id = url.pathname.slice('/media/'.length).split('/')[0] ?? '';
  const entry = entries.get(id);
  if (!entry) {
    sendJson(res, 404, errorPayload('media_expired', '播放地址已过期，请重新点击播放'));
    return;
  }

  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const cacheKey = audioCacheKey(entry.platform, entry.trackId, entry.quality);
  if (serveAudioFromCache(req, res, cacheKey)) return;

  void streamEntry(entry, req, res, range, false, cacheKey).catch(() => {
    if (!res.headersSent) sendJson(res, 502, errorPayload('stream_failed', '音频加载失败'));
    else res.destroy();
  });
}

/** `/api/stream` 的流式反代：不能走收集完整响应体的 JSON 分支。 */
export async function proxyAudioStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
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
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const cacheKey = streamCacheKey(url);
  if (cacheKey && serveAudioFromCache(req, res, cacheKey)) return;

  let upstream: GatewayStreamResponse;
  try {
    upstream = await openGatewayStream(client, path, {
      method: req.method ?? 'GET',
      headers: {
        ...(range ? { Range: range } : {}),
        Accept: '*/*',
      },
      timeoutMs: 15000,
    });
  } catch {
    sendJson(res, 502, errorPayload('stream_unreachable', '无法连接音频源'));
    return;
  }

  if (upstream.status >= 400) {
    upstream.stream.resume();
    sendJson(res, upstream.status, errorPayload('stream_failed', `音频源返回 ${upstream.status}`));
    return;
  }

  pipeAudio(req, res, upstream.status, upstream.headers, upstream.stream, cacheKey);
}
