import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimes,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { audioCacheDir, audioLimitBytes, trimCache } from './index';

/**
 * 音频流缓存：顺序前缀命中。
 *
 * 首次播放从 0 开始边播边写；已缓存的前缀可以直接回放，浏览器继续请求
 * `bytes=<前缀长度>-` 时再回源并接着追加。只缓存连续前缀，不在磁盘上制造空洞，
 * 因此拖到尚未缓存的位置会照常回源。
 */

interface AudioMeta {
  total: number | null;
  mime?: string;
}

const WRITING = new Set<string>();

export function audioCacheKey(platform: string, trackId: string, quality: string): string {
  return `${platform}:${trackId}:${quality}`;
}

function hash(key: string): string {
  return createHash('sha1').update(key, 'utf8').digest('hex');
}

function audioFile(key: string): string {
  return join(audioCacheDir(), `${hash(key)}.audio`);
}

function metaFile(key: string): string {
  return join(audioCacheDir(), `${hash(key)}.json`);
}

function readMeta(key: string): AudioMeta {
  try {
    const parsed = JSON.parse(readFileSync(metaFile(key), 'utf8')) as AudioMeta;
    return {
      total:
        typeof parsed.total === 'number' && parsed.total >= 0 ? parsed.total : null,
      mime: typeof parsed.mime === 'string' ? parsed.mime : undefined,
    };
  } catch {
    return { total: null };
  }
}

function writeMeta(key: string, meta: AudioMeta): void {
  const file = metaFile(key);
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(audioCacheDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(meta), 'utf8');
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function cachedSize(file: string): number {
  try {
    return existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
}

function touch(file: string): void {
  const now = new Date();
  utimes(file, now, now, () => {
    // 访问时间只用于 LRU，失败不影响播放。
  });
}

interface ByteRange {
  start: number;
  end?: number;
}

function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return null;
  const end = endRaw ? Number(endRaw) : undefined;
  if (end !== undefined && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

function sendRange(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  status: number,
  start: number,
  end: number,
  total: number | string,
  mime: string,
): void {
  const length = end - start + 1;
  const headers: Record<string, string | number> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': length,
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(file, { start, end });
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  stream.pipe(res);
  res.on('close', () => stream.destroy());
}

function sendUnsatisfiable(res: ServerResponse, total: number | string): void {
  res.writeHead(416, {
    'Content-Range': `bytes */${total}`,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
  });
  res.end();
}

/**
 * 命中缓存时直接响应；返回 false 表示交给上游。
 *
 * 只负责「已连续缓存的部分」，剩余区间由浏览器继续发请求时回源。
 */
export function serveAudioFromCache(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): boolean {
  if (audioLimitBytes() <= 0) return false;

  const file = audioFile(key);
  const size = cachedSize(file);
  if (size <= 0) return false;

  const meta = readMeta(key);
  const total = meta.total !== null && meta.total >= size ? meta.total : null;
  const complete = total !== null && size >= total;
  const mime = meta.mime ?? 'audio/mpeg';
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;

  if (rangeHeader) {
    // 后缀范围（bytes=-N）以完整文件长度为基准，前缀缓存无法给出正确结果。
    if (!complete && /^bytes=-/i.test(rangeHeader.trim())) return false;

    const parsed = parseRange(rangeHeader, size);
    if (!parsed) return false;

    if (parsed.start >= size) {
      if (complete && total !== null) {
        touch(file);
        sendUnsatisfiable(res, total);
        return true;
      }
      // 还没缓存到这里，交给上游继续下载。
      return false;
    }

    const last = complete && total !== null ? total - 1 : size - 1;
    const end = Math.min(parsed.end ?? last, last);
    if (end < parsed.start) {
      sendUnsatisfiable(res, total ?? '*');
      return true;
    }

    touch(file);
    sendRange(req, res, file, 206, parsed.start, end, total ?? '*', mime);
    return true;
  }

  touch(file);
  if (complete && total !== null) {
    // 完整曲目：可以按普通 200 返回，浏览器后续拖动也都能命中。
    sendRange(req, res, file, 200, 0, size - 1, total, mime);
  } else {
    // 只有前缀：用 206 明确告知完整长度未知/更大，浏览器会继续请求剩余部分。
    sendRange(req, res, file, 206, 0, size - 1, meta.total ?? '*', mime);
  }
  return true;
}

export interface AudioCacheWriter {
  write: (chunk: Buffer) => void;
  finish: (total: number | null, mime: string) => void;
  abort: () => void;
}

/**
 * 创建一个顺序写入器；startOffset 必须正好等于当前缓存长度，否则放弃缓存，
 * 避免把不连续的数据拼坏。HEAD 请求不需要 writer。
 */
export function createAudioCacheWriter(
  key: string,
  startOffset: number,
  total: number | null,
  mime: string,
): AudioCacheWriter | null {
  if (audioLimitBytes() <= 0 || WRITING.has(key)) return null;

  const file = audioFile(key);
  const existing = cachedSize(file);
  if (startOffset !== existing) return null;

  if (startOffset === 0) trimCache('audio');

  WRITING.add(key);
  let released = false;
  let finalizing = false;
  let failed = false;
  let written = startOffset;
  const prior = startOffset === 0 ? { total: null } : readMeta(key);
  const out: Writable = createWriteStream(file, {
    flags: startOffset === 0 ? 'w' : 'a',
  });
  out.on('error', () => {
    failed = true;
  });

  const release = (): void => {
    if (released) return;
    released = true;
    WRITING.delete(key);
  };

  const cleanupEmpty = (): void => {
    if (written > 0) return;
    try {
      unlinkSync(file);
    } catch {
      // ignore
    }
    try {
      unlinkSync(metaFile(key));
    } catch {
      // ignore
    }
  };

  let pendingMeta: AudioMeta | null = null;
  /** 等文件句柄真正关闭后再写 sidecar / 触发淘汰，避免 Windows 下占用冲突。 */
  out.once('close', () => {
    cleanupEmpty();
    if (!failed && written > 0 && pendingMeta) writeMeta(key, pendingMeta);
    if (!failed && written > 0) {
      trimCache('audio');
    }
    release();
  });

  return {
    write(chunk: Buffer): void {
      if (released || failed) return;
      written += chunk.length;
      out.write(chunk);
    },
    finish(nextTotal: number | null, nextMime: string): void {
      if (released || finalizing) return;
      finalizing = true;
      // 上游正常读完但没有给总长度（chunked 200）时，写入量就是完整长度。
      const length = nextTotal ?? prior.total ?? total ?? (startOffset === 0 ? written : null);
      pendingMeta = { total: length, mime: nextMime || prior.mime };
      out.end();
    },
    abort(): void {
      if (released || finalizing) return;
      finalizing = true;
      // 中断时保留已写入的连续前缀；完整长度沿用之前已知的值。
      pendingMeta = { total: prior.total ?? total, mime: mime || prior.mime };
      out.end();
    },
  };
}
