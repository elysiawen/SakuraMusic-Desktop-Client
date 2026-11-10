import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { getDb } from './index';

/** meta 的 JSON 响应缓存；歌词内容是磁盘文件，不进数据库。 */

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
    read: db.prepare(
      "SELECT payload, saved_at FROM response_cache WHERE kind = 'meta' AND cache_key = ?",
    ),
    write: db.prepare(`
      INSERT INTO response_cache (kind, cache_key, payload, bytes, saved_at, accessed_at)
      VALUES ('meta', ?, ?, ?, ?, ?)
      ON CONFLICT(kind, cache_key) DO UPDATE SET
        payload=excluded.payload, bytes=excluded.bytes,
        saved_at=excluded.saved_at, accessed_at=excluded.accessed_at`),
    remove: db.prepare("DELETE FROM response_cache WHERE kind = 'meta' AND cache_key = ?"),
    clear: db.prepare("DELETE FROM response_cache WHERE kind = 'meta'"),
    usage: db.prepare(
      "SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM response_cache WHERE kind = 'meta'",
    ),
  };
  return stmts;
}

/** 读一条；payload 不是合法 JSON 时按损坏处理，删掉这一行。 */
export function readResponse(cacheKey: string): ResponseEntry | null {
  const row = sql().read.get(cacheKey) as Row | undefined;
  if (!row || typeof row.payload !== 'string') return null;
  try {
    JSON.parse(row.payload);
  } catch {
    sql().remove.run(cacheKey);
    return null;
  }
  return { payload: row.payload, savedAt: Number(row.saved_at) || 0 };
}

export function writeResponse(cacheKey: string, payload: string): void {
  const now = Date.now();
  sql().write.run(cacheKey, payload, Buffer.byteLength(payload, 'utf8'), now, now);
}

export function clearResponses(): void {
  sql().clear.run();
}

export function responseUsage(): Usage {
  const row = sql().usage.get() as Row;
  return { bytes: Number(row.bytes) || 0, entries: Number(row.entries) || 0 };
}
