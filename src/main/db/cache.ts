import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { getDb } from './index';

/** lyric/meta 的 JSON 响应缓存（纯文本数据，不是媒体文件）。 */

type ResponseKind = 'lyric' | 'meta';

interface ResponseEntry {
  payload: string;
  savedAt: number;
}

interface Usage {
  bytes: number;
  entries: number;
}

type Row = Record<string, unknown>;

interface Statements {
  read: StatementSync;
  write: StatementSync;
  remove: StatementSync;
  clear: StatementSync;
  clearAll: StatementSync;
  usage: StatementSync;
}

let stmts: Statements | null = null;
let owner: DatabaseSync | null = null;

function sql(): Statements {
  // 连接可能换过（退出后重开）：只在同一个 DatabaseSync 上复用预编译语句。
  const db = getDb();
  if (stmts && owner === db) return stmts;
  owner = db;
  stmts = {
    read: db.prepare('SELECT payload, saved_at FROM response_cache WHERE kind = ? AND cache_key = ?'),
    write: db.prepare(`
      INSERT INTO response_cache (kind, cache_key, payload, bytes, saved_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, cache_key) DO UPDATE SET
        payload=excluded.payload, bytes=excluded.bytes,
        saved_at=excluded.saved_at, accessed_at=excluded.accessed_at`),
    remove: db.prepare('DELETE FROM response_cache WHERE kind = ? AND cache_key = ?'),
    clear: db.prepare('DELETE FROM response_cache WHERE kind = ?'),
    clearAll: db.prepare('DELETE FROM response_cache'),
    usage: db.prepare(
      'SELECT kind, COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM response_cache GROUP BY kind',
    ),
  };
  return stmts;
}

/** 读一条；payload 不是合法 JSON 时按损坏处理，删掉这一行。 */
export function readResponse(kind: ResponseKind, cacheKey: string): ResponseEntry | null {
  const row = sql().read.get(kind, cacheKey) as Row | undefined;
  if (!row || typeof row.payload !== 'string') return null;
  try {
    JSON.parse(row.payload);
  } catch {
    sql().remove.run(kind, cacheKey);
    return null;
  }
  return { payload: row.payload, savedAt: Number(row.saved_at) || 0 };
}

export function writeResponse(kind: ResponseKind, cacheKey: string, payload: string): void {
  const now = Date.now();
  sql().write.run(kind, cacheKey, payload, Buffer.byteLength(payload, 'utf8'), now, now);
}

export function clearResponses(kind?: ResponseKind): void {
  if (kind) sql().clear.run(kind);
  else sql().clearAll.run();
}

export function responseUsage(): Record<ResponseKind, Usage> {
  const result: Record<ResponseKind, Usage> = {
    lyric: { bytes: 0, entries: 0 },
    meta: { bytes: 0, entries: 0 },
  };
  for (const row of sql().usage.all() as Row[]) {
    if (row.kind !== 'lyric' && row.kind !== 'meta') continue;
    result[row.kind] = { bytes: Number(row.bytes) || 0, entries: Number(row.entries) || 0 };
  }
  return result;
}
