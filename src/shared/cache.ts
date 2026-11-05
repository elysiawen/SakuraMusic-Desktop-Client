/**
 * 缓存分类与统计契约。
 *
 * 分类与安卓端保持一致：音频流、封面、歌词、歌曲信息；下载不属于缓存。
 */

export const CACHE_KINDS = ['audio', 'cover', 'lyric', 'meta'] as const;

export type CacheKind = (typeof CACHE_KINDS)[number];

export const CACHE_KIND_LABEL: Record<CacheKind, string> = {
  audio: '音频',
  cover: '封面',
  lyric: '歌词',
  meta: '歌曲信息',
};

export const CACHE_KIND_HINT: Record<CacheKind, string> = {
  audio: '边播边存，按播放顺序缓存；超出上限时淘汰最久未用的',
  cover: '封面与头像图片，离线时也能显示',
  lyric: '歌词按曲目缓存，断网时回退到旧歌词',
  meta: '歌曲、专辑、歌手详情，断网时回退到旧数据',
};

export interface CacheUsage {
  kind: CacheKind;
  bytes: number;
  entries: number;
}

export interface CacheStats {
  kinds: CacheUsage[];
  /** 四类缓存合计，不含离线下载。 */
  totalBytes: number;
}
