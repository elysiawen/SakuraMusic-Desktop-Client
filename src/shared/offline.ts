/** 离线下载在渲染进程与主进程之间共享的形状。 */

export interface OfflineItem {
  /** 与曲目 `track.key` 一致，用于和在线数据对齐、去重。 */
  key: string;
  platform: 'netease' | 'qq';
  /** 平台侧的曲目 id：离线列表要能重新拼回可播放的曲目。 */
  id: string;
  quality: string;
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
  limitBytes: number;
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
  /** 下载完成后总量超过上限：文件留着，但界面该提示清理。 */
  overLimit: boolean;
}

/** `/offline/stream/<key>`，可直接作为 `<audio>` 的地址。 */
export function offlineStreamPath(key: string): string {
  return `/offline/stream/${encodeURIComponent(key)}`;
}
