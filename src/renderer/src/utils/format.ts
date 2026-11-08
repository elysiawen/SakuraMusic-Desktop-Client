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

/**
 * 把「一起听了多久」说成人话。
 *
 * 与 `formatTime`（mm:ss，给单曲进度用）不同：这是长期累计的时段，以分钟/小时为主，
 * 而且要能表达「刚开始」这种 0 附近的状况，不能显示成 0:00。
 */
export function formatTogetherDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '刚刚开始';
  const total = Math.floor(seconds);
  if (total < 60) return '不到 1 分钟';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes} 分钟`;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

/**
 * 一起听明细里的时间点：日期 + 时刻。
 *
 * 与 `formatRelativeTime`（「3 分钟前」）不同：翻明细时要的是**具体哪天**；
 * 同一年不写年份，跨年的才带上。
 */
export function formatSessionTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';
  const sameYear = time.getFullYear() === new Date().getFullYear();
  return time.toLocaleString('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 「3 分钟前」这类相对时间，用于伙伴列表里的「最近」。 */
export function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(time).toLocaleDateString('zh-CN');
}

/** 由昵称生成一个稳定的柔和渐变色，用于默认头像。 */
export function avatarGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  const from = `hsl(${hash}, 78%, 72%)`;
  const to = `hsl(${(hash + 48) % 360}, 74%, 62%)`;
  return `linear-gradient(135deg, ${from}, ${to})`;
}
