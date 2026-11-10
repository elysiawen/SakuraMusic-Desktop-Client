import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { AudioCacheState } from '@shared/ipc';
import { deleteMedia, getMedia, putMedia, touchMedia } from '../db/media';
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

/**
 * 查询一首音频的缓存状态（纯本地磁盘查询，无副作用）。
 * - null：没有缓存（连文件都没有，或元数据不可信）
 * - 'partial'：只有前缀，还没完整缓存
 * - 'full'：完整缓存，下次断网也能播
 */
export function queryAudioCacheState(key: string): AudioCacheState {
  const file = audioFile(key);
  const meta = readMeta(key);
  if (!existsSync(file) || meta.total === null || meta.total <= 0) return null;
  const size = statSync(file).size;
  if (size > meta.total) return null; // 元数据比文件还小，不可信
  if (size >= meta.total) return 'full';
  return 'partial';
}

function hash(key: string): string {
  return createHash('sha1').update(key, 'utf8').digest('hex');
}

function audioFile(key: string): string {
  return join(audioCacheDir(), `${hash(key)}.audio`);
}

function readMeta(key: string): AudioMeta {
  const meta = getMedia('audio', hash(key));
  if (!meta) return { total: null };
  return {
    total: meta.total !== null && meta.total >= 0 ? meta.total : null,
    mime: meta.mime ?? undefined,
  };
}

function writeMeta(key: string, meta: AudioMeta, bytes: number): void {
  try {
    putMedia('audio', hash(key), {
      total: meta.total,
      mime: meta.mime ?? null,
      bytes,
    });
  } catch (error) {
    console.error('[cache] 写入音频元数据失败：', error);
  }
}

function cachedSize(file: string): number {
  try {
    return existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
}

/** 丢掉一整份音频缓存（没有元数据的前缀不能留，否则会一直毒化这首歌）。 */
function discardAudioCache(key: string): void {
  try {
    unlinkSync(audioFile(key));
  } catch {
    // 还被读流占用：删不掉就留到下次；这次仍按未命中回源。
  }
  try {
    deleteMedia('audio', hash(key));
  } catch {
    // ignore
  }
}

function touchAudio(key: string): void {
  try {
    touchMedia('audio', hash(key));
  } catch {
    // 访问时间只用于 LRU，失败不影响播放。
  }
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
  /*
   * 前缀可用的前提是 DB 记着完整长度。没有元数据（进程被强杀、写到一半
   * 就退出）或长度对不上，这份缓存就不可信：若按「总长未知」以 206 + `*` 返回，
   * Chromium 算不出时长、进度条拖不动，播到前缀末尾还会直接判为播完跳下一首。
   * 整份丢掉、回源重下，让这首歌恢复正常。
   *
   * 正在写的文件不能删（会打断写入器），这一次先回源，等写完下回再用。
   */
  if (meta.total === null || meta.total <= 0 || size > meta.total) {
    if (!WRITING.has(key)) discardAudioCache(key);
    return false;
  }

  const total = meta.total;
  const complete = size >= total;
  const mime = meta.mime ?? 'audio/mpeg';
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;

  if (rangeHeader) {
    // 后缀范围（bytes=-N）以完整文件长度为基准，前缀缓存无法给出正确结果。
    if (!complete && /^bytes=-/i.test(rangeHeader.trim())) return false;

    const parsed = parseRange(rangeHeader, size);
    if (!parsed) return false;

    if (parsed.start >= size) {
      if (complete) {
        touchAudio(key);
        sendUnsatisfiable(res, total);
        return true;
      }
      // 还没缓存到这里，交给上游继续下载。
      return false;
    }

    const last = complete ? total - 1 : size - 1;
    const end = Math.min(parsed.end ?? last, last);
    if (end < parsed.start) {
      sendUnsatisfiable(res, total);
      return true;
    }

    touchAudio(key);
    sendRange(req, res, file, 206, parsed.start, end, total, mime);
    return true;
  }

  touchAudio(key);
  if (complete) {
    // 完整曲目：可以按普通 200 返回，浏览器后续拖动也都能命中。
    sendRange(req, res, file, 200, 0, size - 1, total, mime);
  } else {
    // 只有前缀：206 并如实报出总长，浏览器据此算时长并提供拖动。
    sendRange(req, res, file, 206, 0, size - 1, total, mime);
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
      deleteMedia('audio', hash(key));
    } catch {
      // ignore
    }
  };

  let pendingMeta: AudioMeta | null = null;
  /** 等文件句柄真正关闭后再写元数据 / 触发淘汰，避免 Windows 下占用冲突。 */
  out.once('close', () => {
    cleanupEmpty();
    if (!failed && written > 0 && pendingMeta) writeMeta(key, pendingMeta, written);
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
