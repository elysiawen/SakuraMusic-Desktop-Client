import type { Platform } from '@/api/types';

/** 秒 → `m:ss` / `h:mm:ss`。 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** 调色板里的平台短名。 */
export function platformName(platform: string): string {
  if (platform === 'netease') return '网易云';
  if (platform === 'qq') return 'QQ 音乐';
  return platform;
}

/** 路由参数 → 平台。只有两个平台，未知值按网易云处理。 */
export function parsePlatform(value: unknown): Platform {
  return value === 'qq' ? 'qq' : 'netease';
}

/**
 * 字节 → 可读字符串。
 * 统一两处实现：offline.ts（只显示 MB/GB）与 SettingsView.vue（B/KB/MB/GB）。
 * 这里保留 SettingsView 的完整版本，offline.ts 的调用方只传 MB 以上的值，不会触发 B/KB 分支。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  const text = index === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[index]}`;
}
