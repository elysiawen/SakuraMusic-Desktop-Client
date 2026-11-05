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
