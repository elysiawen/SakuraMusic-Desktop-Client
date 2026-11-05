import { apiRequest } from './client';
import type {
  AlbumDetail,
  ArtistDetail,
  CollectionDetail,
  DiscoverFeed,
  LyricResult,
  PlaylistSummary,
  PlayResolveResult,
  Platform,
  Quality,
  SearchResult,
  SearchType,
  UnifiedTrack,
} from './types';

/** M1 需要的音乐聚合接口；与网关 `docs/API.md` 的 3.4 / 3.5 对齐。 */
export const musicApi = {
  search: (keyword: string, type: SearchType = 'song', page = 1, limit = 20, platforms?: string) =>
    apiRequest<SearchResult>('/api/search', {
      query: { keyword, type, page, limit, platforms },
    }),

  track: (platform: Platform, id: string) =>
    apiRequest<{ track: UnifiedTrack }>(`/api/track/${platform}/${encodeURIComponent(id)}`),

  lyric: (platform: Platform, id: string) =>
    apiRequest<LyricResult>(`/api/track/${platform}/${encodeURIComponent(id)}/lyric`),

  artist: (platform: Platform, id: string) =>
    apiRequest<ArtistDetail>(`/api/artist/${platform}/${encodeURIComponent(id)}`),

  album: (platform: Platform, id: string) =>
    apiRequest<AlbumDetail>(`/api/album/${platform}/${encodeURIComponent(id)}`),

  discoverFeed: (platforms?: string) =>
    apiRequest<DiscoverFeed>('/api/discover/feed', { query: { platforms } }),

  toplists: (platform: Platform) =>
    apiRequest<{ items: PlaylistSummary[] }>('/api/toplists', { query: { platform } }),

  toplist: (platform: Platform, id: string, page = 1, limit = 100) =>
    apiRequest<CollectionDetail>(`/api/toplist/${platform}/${encodeURIComponent(id)}`, {
      query: { page, limit },
    }),

  collection: (platform: Platform, id: string, page = 1, limit = 100) =>
    apiRequest<CollectionDetail>(`/api/collection/${platform}/${encodeURIComponent(id)}`, {
      query: { page, limit },
    }),

  /**
   * 解析播放地址。
   *
   * 主进程 BFF 会把响应里的 `direct` 换成同源的 `/media/<id>`，并额外返回
   * `media.proxy`；渲染进程只使用 `media`，不接触 CDN 地址与防盗链请求头。
   */
  resolvePlay: (platform: Platform, id: string, quality: Quality) =>
    apiRequest<PlayResolveResult>('/api/play/resolve', {
      method: 'POST',
      body: { platform, id, quality },
    }),
};
