import { createHash } from 'node:crypto';
import { app } from 'electron';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_KINDS,
  type CacheKind,
  type CacheStats,
  type CacheUsage,
} from '@shared/cache';
import { getConfig } from '../config/store';
import { clearResponses, readResponse, responseUsage, writeResponse } from '../db/cache';
import { clearMedia, deleteMedia, mediaUsage, oldestMedia } from '../db/media';

/**
 * 桌面端缓存。
 *
 * DB 只放结构化数据：
 *   - lyric / meta：上游 JSON 响应文本
 *   - audio / cover：total / mime / bytes / accessed_at 等元数据
 * 媒体文件仍在 userData 下的 `sakura-cache`，按 <hash>.audio / <hash>.img 存；
 * 统计、LRU、清理都查表，不再 readdir + stat 整个目录。
 */

const MB = 1024 * 1024;
const ROOT_DIR = 'sakura-cache';

export type JsonCacheKind = 'lyric' | 'meta';

function cacheRoot(): string {
  return join(app.getPath('userData'), ROOT_DIR);
}

export function cacheDir(kind: CacheKind | JsonCacheKind): string {
  const dir = join(cacheRoot(), kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function audioCacheDir(): string {
  return cacheDir('audio');
}

export function coverCacheDir(): string {
  return cacheDir('cover');
}

export function audioLimitBytes(): number {
  const mb = getConfig().audioCacheMb;
  return mb < 0 ? Number.POSITIVE_INFINITY : mb * MB;
}

export function coverLimitBytes(): number {
  const mb = getConfig().coverCacheMb;
  return mb < 0 ? Number.POSITIVE_INFINITY : mb * MB;
}

export function responseTtlMs(kind: JsonCacheKind): number {
  const config = getConfig();
  const days = kind === 'lyric' ? config.lyricCacheDays : config.metaCacheDays;
  return days < 0 ? Number.POSITIVE_INFINITY : days * 24 * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ */
/* JSON 响应缓存                                                       */
/* ------------------------------------------------------------------ */

function cacheName(key: string): string {
  // 固定长度主键，避免签名图片 URL 或长曲目键触发 Windows 路径长度限制。
  return createHash('sha1').update(key, 'utf8').digest('hex');
}

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // 文件刚好被清理/被杀软占用时忽略，下次再处理。
  }
}

/** 读取仍新鲜的响应；过期返回 null，但保留记录供断网回退。 */
export function readResponseCache(kind: JsonCacheKind, key: string): string | null {
  const entry = readResponse(kind, cacheName(key));
  if (!entry) return null;
  if (Date.now() - entry.savedAt > responseTtlMs(kind)) return null;
  return entry.payload;
}

/** 忽略 TTL 读取旧响应，只在网关不可达时使用。 */
export function readStaleResponseCache(kind: JsonCacheKind, key: string): string | null {
  return readResponse(kind, cacheName(key))?.payload ?? null;
}

export function writeResponseCache(kind: JsonCacheKind, key: string, payload: string): void {
  try {
    writeResponse(kind, cacheName(key), payload);
  } catch (error) {
    // 缓存写失败不影响本次请求，但要留痕，避免静默降级难排查。
    console.error('[cache] 写入响应缓存失败：', error);
  }
}

/**
 * 哪些接口值得缓存：只缓存 GET 的歌词、歌曲/专辑/歌手详情。
 * 发现页、搜索、歌单列表会随时间变化，不进磁盘缓存。
 */
export function apiCacheKind(pathname: string): JsonCacheKind | null {
  if (/^\/api\/track\/[^/]+\/[^/]+\/lyric$/.test(pathname)) return 'lyric';
  if (/^\/api\/track\/[^/]+\/[^/]+$/.test(pathname)) return 'meta';
  if (/^\/api\/(?:album|artist)\/[^/]+\/[^/]+$/.test(pathname)) return 'meta';
  return null;
}

/** 缓存键与安卓端一致：路径 + 排序后的 query。 */
export function responseCacheKey(pathname: string, search: string): string {
  const params = [...new URLSearchParams(search).entries()].sort(
    (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
  );
  const query = new URLSearchParams(params).toString();
  return query ? `${pathname}?${query}` : pathname;
}

/* ------------------------------------------------------------------ */
/* 统计 / 清理 / LRU                                                   */
/* ------------------------------------------------------------------ */

export function getCacheStats(): CacheStats {
  const response = responseUsage();
  const media = mediaUsage();
  const kinds: CacheUsage[] = CACHE_KINDS.map((kind) => {
    if (kind === 'lyric' || kind === 'meta') {
      return { kind, bytes: response[kind].bytes, entries: response[kind].entries };
    }
    return { kind, bytes: media[kind].bytes, entries: media[kind].entries };
  });
  return {
    kinds,
    totalBytes: kinds.reduce((sum, usage) => sum + usage.bytes, 0),
  };
}

/** 删掉目录里的媒体文件与写入中途留下的 .part。 */
function clearDir(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.audio') || name.endsWith('.img') || name.endsWith('.part')) {
      removeFile(join(dir, name));
    }
  }
}

/** 清理一类或全部缓存；下载目录不在其中。 */
export function clearCache(kind?: CacheKind): void {
  const targets: CacheKind[] = kind ? [kind] : [...CACHE_KINDS];
  for (const target of targets) {
    if (target === 'lyric' || target === 'meta') clearResponses(target);
    else clearMedia(target);
    clearDir(join(cacheRoot(), target));
  }
}

/**
 * 把音频/封面缓存压回用户设置的上限，按 DB 里的 accessed_at 淘汰最久未用的。
 * 额度为 0 时会清空该类；正在播放、被系统占用的文件删不掉就留到下次。
 */
export function trimCache(kind: 'audio' | 'cover'): void {
  const limit = kind === 'audio' ? audioLimitBytes() : coverLimitBytes();
  if (!Number.isFinite(limit)) return;

  let total = mediaUsage()[kind].bytes;
  if (total <= limit) return;

  const dir = join(cacheRoot(), kind);
  const ext = kind === 'audio' ? '.audio' : '.img';
  for (const victim of oldestMedia(kind)) {
    if (total <= limit) break;
    const base = join(dir, victim.cacheKey);
    removeFile(`${base}${ext}`);
    deleteMedia(kind, victim.cacheKey);
    total -= victim.bytes;
  }
}

/** 启动时把上次异常退出留下的临时文件清掉；只有音频/封面会写临时文件。 */
export function cleanupTempFiles(): void {
  for (const kind of ['audio', 'cover'] as const) {
    const dir = join(cacheRoot(), kind);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.part') || name.endsWith('.tmp')) removeFile(join(dir, name));
    }
  }
}
