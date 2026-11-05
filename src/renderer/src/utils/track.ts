import { qualityLabel, type Platform, type PlaylistSummary, type Quality, type UnifiedTrack } from '@/api/types';

/**
 * 音质档位从低到高。
 *
 * 平台没给 `qualities` 时用它兜底列全档；「不知道有哪些档」和「没有某一档」要分开。
 */
export const QUALITY_ORDER: Quality[] = [
  'standard',
  'high',
  'lossless',
  'hires',
  'spatial',
  'master',
  'surround',
];

/** 曲目实际存在的最高档；`null` 表示平台没给信息，不是「没有」。 */
export function topQuality(track: UnifiedTrack): Quality | null {
  const listed = track.qualities;
  if (!listed?.length) return null;

  for (let at = QUALITY_ORDER.length - 1; at >= 0; at -= 1) {
    const quality = QUALITY_ORDER[at];
    if (quality && listed.includes(quality)) return quality;
  }
  return null;
}

/** 紧凑处展示的档位名；不知道时返回空串，界面据此不渲染芯片。 */
export function trackQualityLabel(track: UnifiedTrack, platform?: Platform): string {
  const quality = topQuality(track);
  return quality ? qualityLabel(quality, platform ?? track.sources[0]?.platform) : '';
}

/** 发现页的 section 里曲目与歌单混在一起，用这个区分。 */
export function isTrack(item: UnifiedTrack | PlaylistSummary): item is UnifiedTrack {
  return 'artists' in item;
}
