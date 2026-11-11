import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { AudioCacheState } from '@shared/ipc';
import { deleteMedia, getMedia, putMedia, touchMedia } from '../db/media';
import { audioCacheDir, audioLimitBytes, trimCache } from './index';

/**
 * 音频缓存只认「整首下完」这一种状态。
 *
 * 拉流时边播边写临时文件；只有上游明确给了完整长度、且确实收满，才转正为缓存。
 * 中途切歌、连接断开、上游没给长度，一律整份丢弃 —— 这次和下次都纯拉流。
 * 不做前缀回放：前缀终究还要回源，却要额外维护 206 续传和一大堆边界情况。
 */

interface AudioMeta {
  total: number;
  mime: string | null;
}

const WRITING = new Set<string>();

export function audioCacheKey(platform: string, trackId: string, quality: string): string {
  return `${platform}:${trackId}:${quality}`;
}

/** 查询缓存状态（纯本地磁盘查询，无副作用）：只有完整文件才算命中。 */
export function queryAudioCacheState(key: string): AudioCacheState {
  const file = audioFile(key);
  const meta = readMeta(key);
  if (meta.total <= 0 || !existsSync(file)) return null;
  return statSync(file).size === meta.total ? 'full' : null;
}

function hash(key: string): string {
  return createHash('sha1').update(key, 'utf8').digest('hex');
}

function audioFile(key: string): string {
  return join(audioCacheDir(), `${hash(key)}.audio`);
}

function readMeta(key: string): AudioMeta {
  const meta = getMedia('audio', hash(key));
  return { total: meta?.total ?? 0, mime: meta?.mime ?? null };
}

function writeMeta(key: string, total: number, mime: string | null): void {
  try {
    putMedia('audio', hash(key), { total, mime, bytes: total });
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

/** 删掉没下完的临时文件及其元数据；这次与下次都按纯拉流处理。 */
function discardAudioCache(key: string): void {
  try {
    unlinkSync(audioFile(key));
  } catch {
    // 可能还被读流占用，留到下次；这次仍按未命中回源。
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
  total: number,
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

function sendUnsatisfiable(res: ServerResponse, total: number): void {
  res.writeHead(416, {
    'Content-Range': `bytes */${total}`,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
  });
  res.end();
}

/**
 * 命中完整缓存就直接响应；返回 false 表示这次纯拉流。
 * 半截文件（写到一半崩掉、旧版残留）在这里被丢弃，不参与回放。
 */
export function serveAudioFromCache(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): boolean {
  if (audioLimitBytes() <= 0) return false;

  const file = audioFile(key);
  const meta = readMeta(key);
  if (meta.total <= 0 || !existsSync(file)) return false;

  const size = cachedSize(file);
  if (size !== meta.total) {
    if (!WRITING.has(key)) discardAudioCache(key);
    return false;
  }

  const total = meta.total;
  const mime = meta.mime ?? 'audio/mpeg';
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;

  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, size);
    if (!parsed) {
      sendUnsatisfiable(res, total);
      return true;
    }
    if (parsed.start >= size) {
      touchAudio(key);
      sendUnsatisfiable(res, total);
      return true;
    }
    const end = Math.min(parsed.end ?? size - 1, size - 1);
    if (end < parsed.start) {
      sendUnsatisfiable(res, total);
      return true;
    }
    touchAudio(key);
    sendRange(req, res, file, 206, parsed.start, end, total, mime);
    return true;
  }

  touchAudio(key);
  sendRange(req, res, file, 200, 0, size - 1, total, mime);
  return true;
}

export interface AudioCacheWriter {
  write: (chunk: Buffer) => void;
  /** 上游流正常结束：只有收满 total 才转正，否则整份丢弃。 */
  finish: () => void;
  /** 中途断开 / 切歌：整份丢弃。 */
  abort: () => void;
}

/**
 * 只在「从 0 开始、上游给了完整长度」时尝试缓存，否则返回 null 表示纯拉流。
 * 写入过程中磁盘上只是一份临时文件，没转正就不算缓存。
 */
export function createAudioCacheWriter(
  key: string,
  startOffset: number,
  total: number | null,
  mime: string,
): AudioCacheWriter | null {
  if (
    audioLimitBytes() <= 0 ||
    WRITING.has(key) ||
    startOffset !== 0 ||
    total === null ||
    total <= 0
  ) {
    return null;
  }

  trimCache('audio');
  WRITING.add(key);
  const file = audioFile(key);
  let released = false;
  let finalizing = false;
  let failed = false;
  let written = 0;
  let complete = false;
  const out: Writable = createWriteStream(file, { flags: 'w' });
  out.on('error', () => {
    failed = true;
  });

  const release = (): void => {
    if (released) return;
    released = true;
    WRITING.delete(key);
  };

  /** 等文件句柄真正关闭再删/写元数据，避免 Windows 下占用冲突。 */
  out.once('close', () => {
    if (!failed && complete) {
      writeMeta(key, total, mime);
      trimCache('audio');
    } else {
      discardAudioCache(key);
    }
    release();
  });

  return {
    write(chunk: Buffer): void {
      if (released || failed) return;
      written += chunk.length;
      out.write(chunk);
    },
    finish(): void {
      if (released || finalizing) return;
      finalizing = true;
      complete = written === total;
      out.end();
    },
    abort(): void {
      if (released || finalizing) return;
      finalizing = true;
      complete = false;
      out.end();
    },
  };
}
