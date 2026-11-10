import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { StoredOfflineItem } from '../offline/store';
import { getDb } from './index';

/** offline_items 的读写；音频文件本身仍在磁盘上，这里只有记录。 */

type Row = Record<string, unknown>;

interface Statements {
  list: StatementSync;
  find: StatementSync;
  upsert: StatementSync;
  remove: StatementSync;
}

let stmts: Statements | null = null;
let owner: DatabaseSync | null = null;

function sql(): Statements {
  // 连接可能换过（退出后重开）：只在同一个 DatabaseSync 上复用预编译语句。
  const db = getDb();
  if (stmts && owner === db) return stmts;
  owner = db;
  stmts = {
    list: db.prepare('SELECT * FROM offline_items ORDER BY created_at DESC'),
    find: db.prepare('SELECT * FROM offline_items WHERE key = ?'),
    upsert: db.prepare(`
      INSERT INTO offline_items
        (key, platform, id, quality, actual_quality, title, artists, album_name,
         album_cover, duration_ms, bytes, created_at, file_name, mime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        platform=excluded.platform, id=excluded.id, quality=excluded.quality,
        actual_quality=excluded.actual_quality, title=excluded.title, artists=excluded.artists,
        album_name=excluded.album_name, album_cover=excluded.album_cover,
        duration_ms=excluded.duration_ms, bytes=excluded.bytes,
        created_at=excluded.created_at, file_name=excluded.file_name, mime=excluded.mime`),
    remove: db.prepare('DELETE FROM offline_items WHERE key = ?'),
  };
  return stmts;
}

function toItem(row: Row): StoredOfflineItem {
  let artists: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.artists ?? '[]'));
    if (Array.isArray(parsed)) artists = parsed.map(String);
  } catch {
    // 损坏的 artists 不该让整条记录消失。
  }
  return {
    key: String(row.key),
    platform: row.platform === 'qq' ? 'qq' : 'netease',
    id: String(row.id),
    quality: String(row.quality),
    ...(row.actual_quality ? { actualQuality: String(row.actual_quality) } : {}),
    title: String(row.title),
    artists,
    albumName: String(row.album_name),
    albumCover: String(row.album_cover),
    durationMs: Number(row.duration_ms) || 0,
    bytes: Number(row.bytes) || 0,
    createdAt: String(row.created_at),
    fileName: String(row.file_name),
    mime: String(row.mime),
  };
}

export function listOfflineItems(): StoredOfflineItem[] {
  return (sql().list.all() as Row[]).map(toItem);
}

export function findOfflineItem(key: string): StoredOfflineItem | null {
  const row = sql().find.get(key) as Row | undefined;
  return row ? toItem(row) : null;
}

export function upsertOfflineItem(item: StoredOfflineItem): void {
  sql().upsert.run(
    item.key,
    item.platform,
    item.id,
    item.quality,
    item.actualQuality ?? null,
    item.title,
    JSON.stringify(item.artists ?? []),
    item.albumName,
    item.albumCover,
    item.durationMs,
    item.bytes,
    item.createdAt,
    item.fileName,
    item.mime,
  );
}

export function deleteOfflineItems(keys: string[]): void {
  if (keys.length === 0) return;
  const db = getDb();
  const stmt = sql().remove;
  db.exec('BEGIN');
  try {
    for (const key of keys) stmt.run(key);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function clearOfflineItems(): void {
  getDb().exec('DELETE FROM offline_items');
}
