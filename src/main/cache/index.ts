import { createHash } from 'node:crypto';
import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_KINDS,
  type CacheKind,
  type CacheStats,
  type CacheUsage,
} from '@shared/cache';
import { getConfig } from '../config/store';

/**
 * 桌面端磁盘缓存。
 *
 * 目录放在 userData 下的 `sakura-cache`，与 Chromium 自己的 `Cache` 目录分开，
 * 避免清理缓存时误删页面资源。分类与安卓端一致：
 *   - audio：边播边存的音频前缀
 *   - cover：封面/头像图片
 *   - lyric / meta：JSON 响应，带 TTL，可断网回退旧数据
 */

export const MB = 1024 * 1024;
const CACHE_SCHEMA = 1;
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

interface CacheEntry {
  v?: number;
  savedAt?: number;
  payload?: string;
}

function cacheName(key: string): string {
  // 固定长度的文件名，避免签名图片 URL 或长曲目键触发 Windows 路径长度限制。
  return createHash('sha1').update(key, 'utf8').digest('hex');
}

function responseFile(kind: JsonCacheKind, key: string): string {
  return join(cacheDir(kind), `${cacheName(key)}.json`);
}

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // 文件刚好被清理/被杀软占用时忽略，下次再处理。
  }
}

function readEntry(file: string): CacheEntry | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry;
    if (typeof parsed.savedAt !== 'number' || typeof parsed.payload !== 'string') {
      removeFile(file);
      return null;
    }
    if (parsed.v !== CACHE_SCHEMA) {
      removeFile(file);
      return null;
    }
    // 模型/字段变化时缓存可能不再是合法 JSON，直接丢掉。
    JSON.parse(parsed.payload);
    return parsed;
  } catch {
    removeFile(file);
    return null;
  }
}

/** 读取仍新鲜的响应；过期返回 null，但保留文件供断网回退。 */
export function readResponseCache(kind: JsonCacheKind, key: string): string | null {
  const entry = readEntry(responseFile(kind, key));
  if (!entry || entry.savedAt === undefined) return null;
  if (Date.now() - entry.savedAt > responseTtlMs(kind)) return null;
  return entry.payload ?? null;
}

/** 忽略 TTL 读取旧响应，只在网关不可达时使用。 */
export function readStaleResponseCache(kind: JsonCacheKind, key: string): string | null {
  const entry = readEntry(responseFile(kind, key));
  return entry?.payload ?? null;
}

export function writeResponseCache(kind: JsonCacheKind, key: string, payload: string): void {
  const file = responseFile(kind, key);
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(cacheDir(kind), { recursive: true });
    writeFileSync(
      tmp,
      JSON.stringify({ v: CACHE_SCHEMA, savedAt: Date.now(), payload }),
      'utf8',
    );
    renameSync(tmp, file);
  } catch {
    removeFile(tmp);
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

interface DiskFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function listFiles(
  dir: string,
  match: (name: string) => boolean,
): DiskFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const files: DiskFile[] = [];
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isFile()) files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // 文件可能刚被另一个请求删掉。
    }
  }
  return files;
}

function usageOf(kind: CacheKind): CacheUsage {
  const dir = join(cacheRoot(), kind);
  const files =
    kind === 'audio'
      ? listFiles(dir, (name) => name.endsWith('.audio'))
      : kind === 'cover'
        ? listFiles(dir, (name) => name.endsWith('.img'))
        : listFiles(dir, (name) => name.endsWith('.json'));

  return {
    kind,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    entries: files.length,
  };
}

export function getCacheStats(): CacheStats {
  const kinds = CACHE_KINDS.map(usageOf);
  return {
    kinds,
    totalBytes: kinds.reduce((sum, usage) => sum + usage.bytes, 0),
  };
}

function clearDir(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.json') || name.endsWith('.audio') || name.endsWith('.img') || name.endsWith('.part')) {
      removeFile(join(dir, name));
    }
  }
}

/** 清理一类或全部缓存；下载目录不在其中。 */
export function clearCache(kind?: CacheKind): void {
  const targets: CacheKind[] = kind ? [kind] : [...CACHE_KINDS];
  for (const target of targets) clearDir(join(cacheRoot(), target));
}

function removeSidecar(file: string): void {
  removeFile(file.replace(/\.[^.]+$/, '.json'));
}

/**
 * 把音频/封面缓存压回用户设置的上限，淘汰最久未访问的文件。
 * 额度为 0 时会清空该类；正在播放、被系统占用的文件删不掉就留到下次。
 */
export function trimCache(kind: 'audio' | 'cover'): void {
  const limit = kind === 'audio' ? audioLimitBytes() : coverLimitBytes();
  if (!Number.isFinite(limit)) return;

  const dir = join(cacheRoot(), kind);
  const files = listFiles(dir, (name) => name.endsWith(kind === 'audio' ? '.audio' : '.img'));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= limit) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (total <= limit) break;
    removeFile(file.path);
    removeSidecar(file.path);
    total -= file.size;
  }
}

/** 启动时把上次异常退出留下的临时文件清掉。 */
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
