import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 本地 SQLite：只存结构化数据，媒体文件（音频、封面、下载歌曲）仍在磁盘上。
 *
 * 用 Electron 内置的 node:sqlite：同步 API 与现有调用链一致，不需要 native
 * 模块 / rebuild / asarUnpack。全项目只有这里 import node:sqlite，将来要换
 * better-sqlite3 时只改这一处。
 *
 *   kv                桌面配置、会话令牌、平台凭据（值经 safeStorage 加密）
 *   offline_items     离线下载记录（只记 file_name，不记音频）
 *   response_cache    lyric/meta 的 JSON 响应文本
 *   media_cache       audio/cover 的元数据：total / mime / bytes / accessed_at
 */

const DB_FILE = 'sakura.db';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('[db] 数据库尚未初始化');
  return db;
}

/** 退出时收尾：checkpoint WAL、释放文件句柄（幂等）。 */
export function closeDatabase(): void {
  const conn = db;
  db = null;
  try {
    conn?.close();
  } catch (error) {
    console.error('[db] 关闭数据库失败：', error);
  }
}

export function initDatabase(userDataDir: string): void {
  if (db) return;
  mkdirSync(userDataDir, { recursive: true });
  const path = join(userDataDir, DB_FILE);
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA synchronous = NORMAL');
  conn.exec('PRAGMA busy_timeout = 5000');
  createSchema(conn);
  // 凭据也在这里：POSIX 上把库文件设为 0600。
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // 权限改不了不该挡住启动。
    }
  }
  db = conn;
}

function createSchema(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS offline_items (
      key TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      id TEXT NOT NULL,
      quality TEXT NOT NULL,
      actual_quality TEXT,
      title TEXT NOT NULL,
      artists TEXT NOT NULL,
      album_name TEXT NOT NULL,
      album_cover TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_offline_created ON offline_items(created_at DESC);
    CREATE TABLE IF NOT EXISTS response_cache (
      kind TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      saved_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      PRIMARY KEY (kind, cache_key)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS media_cache (
      kind TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      total INTEGER,
      mime TEXT,
      bytes INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      PRIMARY KEY (kind, cache_key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_media_accessed ON media_cache(kind, accessed_at);
  `);
}
