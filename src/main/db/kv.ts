import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { getDb } from './index';

/**
 * 少量 KV：桌面配置、会话令牌、平台凭据。
 * 后两者的值仍由 safeStorage 加密后才写进来，DB 里不放明文凭据。
 */

interface Statements {
  get: StatementSync;
  set: StatementSync;
  del: StatementSync;
}

let stmts: Statements | null = null;
let owner: DatabaseSync | null = null;

function sql(): Statements {
  // 连接可能换过（退出后重开）：只在同一个 DatabaseSync 上复用预编译语句。
  const db = getDb();
  if (stmts && owner === db) return stmts;
  owner = db;
  stmts = {
    get: db.prepare('SELECT value FROM kv WHERE key = ?'),
    set: db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    del: db.prepare('DELETE FROM kv WHERE key = ?'),
  };
  return stmts;
}

export function getKv(key: string): string | null {
  const row = sql().get.get(key) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

export function setKv(key: string, value: string): void {
  sql().set.run(key, value);
}

export function deleteKv(key: string): void {
  sql().del.run(key);
}
