import { createHash } from 'node:crypto';
import { app } from 'electron';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
 *   - meta：上游 JSON 响应文本
 *   - audio / cover：total / mime / bytes / accessed_at 等元数据
 * 歌词内容与媒体文件都不入库，以文件形式留在 userData 下的 `sakura-cache`：
 *   - lyric/<hash>.json：歌词响应文本，mtime 即保存时间
 *   - audio/<hash>.audio、cover/<hash>.img：音频前缀与封面
 * 音频/封面的统计与 LRU 查表；歌词按文件直接读取，统计时扫一次 lyric 目录。
 */

const MB = 1024 * 1024;
const ROOT_DIR = 'sakura-cache';
const LYRIC_EXT = '.json';

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

interface CachedResponse {
  payload: string;
  savedAt: number;
}

/** 歌词内容按曲目存成文件，不进数据库；mtime 天然就是保存时间。 */
function readLyricFile(hashed: string): CachedResponse | null {
  const file = join(cacheDir('lyric'), `${hashed}${LYRIC_EXT}`);
  try {
    const savedAt = statSync(file).mtimeMs;
    const payload = readFileSync(file, 'utf8');
    JSON.parse(payload);
    return { payload, savedAt };
  } catch {
    // 不存在或写坏了都按未命中处理，下次请求会重新落一份。
    return null;
  }
}

function writeLyricFile(hashed: string, payload: string): void {
  try {
    writeFileSync(join(cacheDir('lyric'), `${hashed}${LYRIC_EXT}`), payload, 'utf8');
  } catch (error) {
    console.error('[cache] 写入歌词缓存失败：', error);
  }
}

function readCached(kind: JsonCacheKind, hashed: string): CachedResponse | null {
  return kind === 'lyric' ? readLyricFile(hashed) : readResponse(hashed);
}

/** 读取仍新鲜的响应；过期返回 null，但保留记录供断网回退。 */
export function readResponseCache(kind: JsonCacheKind, key: string): string | null {
  const entry = readCached(kind, cacheName(key));
  if (!entry) return null;
  if (Date.now() - entry.savedAt > responseTtlMs(kind)) return null;
  return entry.payload;
}

/** 忽略 TTL 读取旧响应，只在网关不可达时使用。 */
export function readStaleResponseCache(kind: JsonCacheKind, key: string): string | null {
  return readCached(kind, cacheName(key))?.payload ?? null;
}

export function writeResponseCache(kind: JsonCacheKind, key: string, payload: string): void {
  const hashed = cacheName(key);
  if (kind === 'lyric') {
    writeLyricFile(hashed, payload);
    return;
  }
  try {
    writeResponse(hashed, payload);
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

/** 歌词是文件，统计时扫一次目录；meta 与媒体元数据直接查表。 */
function lyricUsage(): { bytes: number; entries: number } {
  const dir = join(cacheRoot(), 'lyric');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { bytes: 0, entries: 0 };
  }
  let bytes = 0;
  let entries = 0;
  for (const name of names) {
    if (!name.endsWith(LYRIC_EXT)) continue;
    try {
      bytes += statSync(join(dir, name)).size;
      entries += 1;
    } catch {
      // 文件刚好被清理掉就跳过。
    }
  }
  return { bytes, entries };
}

export function getCacheStats(): CacheStats {
  const meta = responseUsage();
  const media = mediaUsage();
  const kinds: CacheUsage[] = CACHE_KINDS.map((kind) => {
    if (kind === 'lyric') return { kind, ...lyricUsage() };
    if (kind === 'meta') return { kind, bytes: meta.bytes, entries: meta.entries };
    return { kind, bytes: media[kind].bytes, entries: media[kind].entries };
  });
  return {
    kinds,
    totalBytes: kinds.reduce((sum, usage) => sum + usage.bytes, 0),
  };
}

function clearDir(dir: string, extensions: readonly string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (extensions.some((ext) => name.endsWith(ext))) removeFile(join(dir, name));
  }
}

/** 清理一类或全部缓存；下载目录不在其中。 */
export function clearCache(kind?: CacheKind): void {
  const targets: CacheKind[] = kind ? [kind] : [...CACHE_KINDS];
  for (const target of targets) {
    if (target === 'meta') {
      clearResponses();
      continue;
    }
    if (target === 'lyric') {
      clearDir(join(cacheRoot(), 'lyric'), [LYRIC_EXT]);
      continue;
    }
    clearMedia(target);
    const ext = target === 'audio' ? '.audio' : '.img';
    clearDir(join(cacheRoot(), target), [ext, '.part']);
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
