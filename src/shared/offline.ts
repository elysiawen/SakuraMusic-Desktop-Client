/** 离线下载在渲染进程与主进程之间共享的形状。 */

/** `/api/play/resolve` 接受的档位，下载请求先在本地校验一遍。 */
export const OFFLINE_QUALITIES = [
  'standard',
  'high',
  'lossless',
  'hires',
  'spatial',
  'master',
  'surround',
] as const;

export interface OfflineItem {
  /** 与曲目 `track.key` 一致，用于和在线数据对齐、去重。 */
  key: string;
  platform: 'netease' | 'qq';
  /** 平台侧的曲目 id：离线列表要能重新拼回可播放的曲目。 */
  id: string;
  /** 下载时请求的音质。 */
  quality: string;
  /** 平台实际给的档位：拿不到请求的档位时会降级，与 quality 不同。 */
  actualQuality?: string;
  title: string;
  artists: string[];
  albumName: string;
  albumCover: string;
  durationMs: number;
  bytes: number;
  createdAt: string;
}

export interface OfflineLibrary {
  items: OfflineItem[];
  usedBytes: number;
}

export interface OfflineDownloadRequest {
  key: string;
  platform: 'netease' | 'qq';
  id: string;
  quality: string;
  title: string;
  artists: string[];
  albumName: string;
  albumCover: string;
  durationMs: number;
}

export interface OfflineDownloadResult {
  item: OfflineItem;
}

/** `/offline/stream/<key>`，可直接作为 `<audio>` 的地址。 */
export function offlineStreamPath(key: string): string {
  return `/offline/stream/${encodeURIComponent(key)}`;
}
