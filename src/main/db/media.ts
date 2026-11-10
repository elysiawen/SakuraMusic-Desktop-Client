import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { getDb } from './index';

/**
 * audio / cover 的元数据（不含任何二进制）。
 * 文件仍是 <hash>.audio / <hash>.img，DB 只记长度、类型、占用与最近访问时间，
 * 让统计和 LRU 不必再 readdir + stat 整个目录。
 */

type MediaKind = 'audio' | 'cover';

interface MediaMeta {
  /** 音频完整长度；封面为 null。 */
  total: number | null;
  mime: string | null;
  /** 实际落盘字节数，用于容量统计与淘汰。 */
  bytes: number;
}

interface MediaUsage {
  bytes: number;
  entries: number;
}

type Row = Record<string, unknown>;

interface Statements {
  get: StatementSync;
  put: StatementSync;
  touch: StatementSync;
  remove: StatementSync;
  clear: StatementSync;
  clearAll: StatementSync;
  usage: StatementSync;
  oldest: StatementSync;
}

let stmts: Statements | null = null;
let owner: DatabaseSync | null = null;

function sql(): Statements {
  // 连接可能换过（退出后重开）：只在同一个 DatabaseSync 上复用预编译语句。
  const db = getDb();
  if (stmts && owner === db) return stmts;
  owner = db;
  stmts = {
    get: db.prepare('SELECT total, mime, bytes FROM media_cache WHERE kind = ? AND cache_key = ?'),
    put: db.prepare(`
      INSERT INTO media_cache (kind, cache_key, total, mime, bytes, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, cache_key) DO UPDATE SET
        total=excluded.total, mime=excluded.mime, bytes=excluded.bytes,
        accessed_at=excluded.accessed_at`),
    touch: db.prepare('UPDATE media_cache SET accessed_at = ? WHERE kind = ? AND cache_key = ?'),
    remove: db.prepare('DELETE FROM media_cache WHERE kind = ? AND cache_key = ?'),
    clear: db.prepare('DELETE FROM media_cache WHERE kind = ?'),
    clearAll: db.prepare('DELETE FROM media_cache'),
    usage: db.prepare(
      'SELECT kind, COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM media_cache GROUP BY kind',
    ),
    oldest: db.prepare(
      'SELECT cache_key, bytes FROM media_cache WHERE kind = ? ORDER BY accessed_at ASC',
    ),
  };
  return stmts;
}

export function getMedia(kind: MediaKind, cacheKey: string): MediaMeta | null {
  const row = sql().get.get(kind, cacheKey) as Row | undefined;
  if (!row) return null;
  return {
    total: typeof row.total === 'number' ? row.total : null,
    mime: typeof row.mime === 'string' ? row.mime : null,
    bytes: Number(row.bytes) || 0,
  };
}

export function putMedia(kind: MediaKind, cacheKey: string, meta: MediaMeta): void {
  sql().put.run(kind, cacheKey, meta.total, meta.mime, meta.bytes, Date.now());
}

export function touchMedia(kind: MediaKind, cacheKey: string): void {
  sql().touch.run(Date.now(), kind, cacheKey);
}

export function deleteMedia(kind: MediaKind, cacheKey: string): void {
  sql().remove.run(kind, cacheKey);
}

export function clearMedia(kind?: MediaKind): void {
  if (kind) sql().clear.run(kind);
  else sql().clearAll.run();
}

export function mediaUsage(): Record<MediaKind, MediaUsage> {
  const result: Record<MediaKind, MediaUsage> = {
    audio: { bytes: 0, entries: 0 },
    cover: { bytes: 0, entries: 0 },
  };
  for (const row of sql().usage.all() as Row[]) {
    if (row.kind !== 'audio' && row.kind !== 'cover') continue;
    result[row.kind] = { bytes: Number(row.bytes) || 0, entries: Number(row.entries) || 0 };
  }
  return result;
}

/** LRU 淘汰顺序：最久未访问的排前面。 */
export function oldestMedia(kind: MediaKind): { cacheKey: string; bytes: number }[] {
  return (sql().oldest.all(kind) as Row[]).map((row) => ({
    cacheKey: String(row.cache_key),
    bytes: Number(row.bytes) || 0,
  }));
}
