import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { OfflineItem, OfflineLibrary } from '@shared/offline';
import { getConfig } from '../config/store';

/**
 * 下载索引。
 *
 * 索引存在 userData，音频文件存在用户选的下载目录（`<downloadDir>/Sakura Music/`）。
 * 索引只记相对文件名，换目录后旧记录会失效 —— 读取时顺手把它们清掉，
 * 免得列表里点开一首放不出来的歌。
 */

export interface StoredOfflineItem extends OfflineItem {
  fileName: string;
  mime: string;
}

interface IndexFile {
  v: number;
  items: StoredOfflineItem[];
}

const FILE_VERSION = 1;
const SUB_DIR = 'Sakura Music';

let cache: StoredOfflineItem[] | null = null;

function indexPath(): string {
  return join(app.getPath('userData'), 'offline-index.json');
}

/** 下载目录（自动创建）。 */
export function downloadRoot(): string {
  const configured = getConfig().downloadDir || app.getPath('downloads');
  const root = join(configured, SUB_DIR);
  mkdirSync(root, { recursive: true });
  return root;
}

export function filePathOf(item: StoredOfflineItem): string {
  return join(downloadRoot(), item.fileName);
}

function readIndex(): StoredOfflineItem[] {
  if (cache) return cache;

  const file = indexPath();
  if (!existsSync(file)) {
    cache = [];
    return cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as IndexFile;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    cache = items.filter(
      (item) =>
        item &&
        typeof item.key === 'string' &&
        typeof item.fileName === 'string' &&
        (item.platform === 'netease' || item.platform === 'qq'),
    );
  } catch {
    cache = [];
  }
  return cache;
}

function persist(items: StoredOfflineItem[]): void {
  const file = indexPath();
  mkdirSync(app.getPath('userData'), { recursive: true });

  const data: IndexFile = { v: FILE_VERSION, items };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);

  cache = items;
}

/** 文件被用户在资源管理器里删掉时，索引也要跟着清。 */
function pruneMissing(items: StoredOfflineItem[]): StoredOfflineItem[] {
  const root = downloadRoot();
  const alive = items.filter((item) => existsSync(join(root, item.fileName)));
  if (alive.length !== items.length) persist(alive);
  return alive;
}

export function listItems(): StoredOfflineItem[] {
  return pruneMissing(readIndex());
}

export function findItem(key: string): StoredOfflineItem | null {
  return listItems().find((item) => item.key === key) ?? null;
}

export function totalBytes(): number {
  return listItems().reduce((sum, item) => sum + (item.bytes || 0), 0);
}

export function library(): OfflineLibrary {
  const items = listItems();
  return {
    items: items.map(({ fileName: _fileName, mime: _mime, ...item }) => item),
    usedBytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0),
  };
}

export function upsertItem(item: StoredOfflineItem): void {
  const items = listItems().filter((entry) => entry.key !== item.key);
  persist([item, ...items]);
}

/** 删除一条记录与它的文件；返回是否删到了记录。 */
export function removeItem(key: string): boolean {
  const items = listItems();
  const target = items.find((item) => item.key === key);
  if (!target) return false;

  try {
    unlinkSync(join(downloadRoot(), target.fileName));
  } catch {
    // 文件可能已经被用户删掉，索引照样要清。
  }

  persist(items.filter((item) => item.key !== key));
  return true;
}

export function clearItems(): void {
  const items = listItems();
  const root = downloadRoot();

  for (const item of items) {
    try {
      unlinkSync(join(root, item.fileName));
    } catch {
      // 同上：删不掉的单个文件不该挡住整体清理。
    }
  }

  persist([]);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 目录被占用时留空目录即可。
  }
}

/** 下载写临时文件时用，避免半成品被索引引用。 */
export function tempPathFor(fileName: string): string {
  return join(downloadRoot(), `${fileName}.part`);
}

export function finalSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
