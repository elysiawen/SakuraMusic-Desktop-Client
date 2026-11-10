import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { OfflineItem, OfflineLibrary } from '@shared/offline';
import { getConfig } from '../config/store';
import {
  clearOfflineItems,
  deleteOfflineItems,
  findOfflineItem,
  listOfflineItems,
  upsertOfflineItem,
} from '../db/offline';

/**
 * 下载索引。
 *
 * 记录存在 SQLite 的 offline_items，音频文件仍在用户选的下载目录，
 * DB 只记相对文件名。
 * 读路径不再对全部记录做 existsSync：只有启动时后台分批校验一次，
 * 播放时按单条校验，列表直接读表。
 */
export interface StoredOfflineItem extends OfflineItem {
  fileName: string;
  mime: string;
}

const SUB_DIR = 'Sakura Music';
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const PRUNE_BATCH = 500;

let lastPruneAt = 0;
let pruning = false;

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

/**
 * 用户可能在资源管理器里删掉文件：启动时后台分批校验一次，之后每 5 分钟
 * 最多一次。刻意不放进请求路径，免得一次列表/播放要 stat 掉全部记录。
 */
export function pruneMissingFiles(): void {
  if (pruning || Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  pruning = true;
  const root = downloadRoot();
  const items = listOfflineItems();
  let index = 0;

  const step = (): void => {
    const end = Math.min(index + PRUNE_BATCH, items.length);
    const missing: string[] = [];
    for (; index < end; index++) {
      if (!existsSync(join(root, items[index].fileName))) missing.push(items[index].key);
    }
    if (missing.length) deleteOfflineItems(missing);
    if (index < items.length) {
      setImmediate(step);
    } else {
      lastPruneAt = Date.now();
      pruning = false;
    }
  };
  setImmediate(step);
}

export function listItems(): StoredOfflineItem[] {
  return listOfflineItems();
}

/** 播放路径：主键点查 + 单条文件存在性校验，与记录总数无关。 */
export function findItem(key: string): StoredOfflineItem | null {
  const item = findOfflineItem(key);
  if (!item) return null;
  if (!existsSync(join(downloadRoot(), item.fileName))) {
    deleteOfflineItems([key]);
    return null;
  }
  return item;
}

export function library(): OfflineLibrary {
  const items = listItems();
  return {
    items: items.map(({ fileName: _fileName, mime: _mime, ...item }) => item),
    usedBytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0),
  };
}

export function upsertItem(item: StoredOfflineItem): void {
  upsertOfflineItem(item);
}

/** 删除一条记录与它的文件；返回是否删到了记录。 */
export function removeItem(key: string): boolean {
  const target = findOfflineItem(key);
  if (!target) return false;

  try {
    unlinkSync(join(downloadRoot(), target.fileName));
  } catch {
    // 文件可能已经被用户删掉，索引照样要清。
  }

  deleteOfflineItems([key]);
  return true;
}

export function clearItems(): void {
  const items = listOfflineItems();
  const root = downloadRoot();

  for (const item of items) {
    try {
      unlinkSync(join(root, item.fileName));
    } catch {
      // 同上：删不掉的单个文件不该挡住整体清理。
    }
  }

  clearOfflineItems();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 目录被占用时留空目录即可。
  }
}

export function finalSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
