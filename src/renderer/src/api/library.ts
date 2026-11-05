import { apiRequest } from './client';
import type {
  BindCommitResult,
  BindPollResult,
  BindStartResult,
  Platform,
  PlatformImportResult,
  Playlist,
  PlaylistSummary,
  QqLoginType,
  ServerCredential,
  UnifiedTrack,
} from './types';

/**
 * 平台凭据与扫码绑定。
 *
 * 绑定分三步：`start` 拿二维码 → 轮询 `poll` 等扫码 → `commit` 选存储位置。
 * 「仅本机」模式的凭据留在主进程，服务器上不留痕。
 */
export const credentialApi = {
  listServer: () => apiRequest<{ items: ServerCredential[] }>('/api/credentials'),

  startBind: (platform: Platform, loginType?: QqLoginType) =>
    apiRequest<BindStartResult>('/api/bind/start', {
      method: 'POST',
      body: { platform, loginType },
    }),

  pollBind: (platform: Platform, identifier: string, loginType?: string) =>
    apiRequest<BindPollResult>('/api/bind/poll', {
      query: { platform, identifier, loginType },
    }),

  /** 释放扫码会话；手机端扫码靠它及时断开上游长连接。 */
  releaseBind: (loginType: string, identifier: string) =>
    apiRequest<{ ok: boolean }>('/api/bind/session', {
      method: 'DELETE',
      query: { loginType, identifier },
    }),

  commitBind: (ticket: string, mode: 'server' | 'local') =>
    apiRequest<BindCommitResult>('/api/bind/commit', {
      method: 'POST',
      body: { ticket, mode },
    }),

  unbind: (platform: Platform) =>
    apiRequest<{ ok: boolean }>(`/api/credentials/${platform}`, { method: 'DELETE' }),

  refresh: (platform: Platform) =>
    apiRequest<{
      mode: 'server' | 'local';
      valid: boolean;
      profile?: { nickname: string; avatar?: string };
      credential?: { cookie: string; raw?: Record<string, unknown> };
      message?: string;
    }>(`/api/credentials/${platform}/refresh`, { method: 'POST' }),

  status: (platform: Platform) =>
    apiRequest<{
      bound: boolean;
      valid: boolean;
      profile?: { nickname: string; avatar?: string };
    }>(`/api/credentials/${platform}/status`),
};

/** Sakura 自己的歌单、收藏与播放历史（本地库，存在服务器上）。 */
export const libraryApi = {
  listPlaylists: () => apiRequest<{ items: Playlist[] }>('/api/playlists'),

  createPlaylist: (name: string, description?: string) =>
    apiRequest<{ playlist: Playlist }>('/api/playlists', {
      method: 'POST',
      body: { name, description },
    }),

  getPlaylist: (id: string) =>
    apiRequest<{ playlist: Playlist; items: UnifiedTrack[] }>(`/api/playlists/${id}`),

  updatePlaylist: (id: string, input: { name?: string; description?: string }) =>
    apiRequest<{ ok: boolean }>(`/api/playlists/${id}`, { method: 'PATCH', body: input }),

  deletePlaylist: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/playlists/${id}`, { method: 'DELETE' }),

  addTrack: (id: string, track: UnifiedTrack) =>
    apiRequest<{ added: boolean; trackCount: number }>(`/api/playlists/${id}/tracks`, {
      method: 'POST',
      body: { track },
    }),

  removeTrack: (id: string, platform: Platform, trackId: string) =>
    apiRequest<{ ok: boolean; trackCount: number }>(
      `/api/playlists/${id}/tracks/${platform}/${encodeURIComponent(trackId)}`,
      { method: 'DELETE' },
    ),

  listFavorites: () =>
    apiRequest<{ items: UnifiedTrack[]; keys: string[] }>('/api/favorites'),

  setFavorite: (track: UnifiedTrack, favorite: boolean) =>
    apiRequest<{ favorite: boolean }>('/api/favorites', {
      method: 'POST',
      body: { track, favorite },
    }),

  listHistory: (limit = 100) =>
    apiRequest<{ items: UnifiedTrack[] }>('/api/history', { query: { limit } }),

  recordPlay: (track: UnifiedTrack) =>
    apiRequest<{ ok: boolean }>('/api/history', { method: 'POST', body: { track } }),

  clearHistory: () => apiRequest<{ ok: boolean }>('/api/history', { method: 'DELETE' }),
};

/**
 * 平台账号自己的音乐库（只读）。
 *
 * 与 `libraryApi` 是两套数据：这里读绑定账号在平台上的收藏与歌单，只展示不写回；
 * 「导入」只是单向复制一份到本地，之后各走各的。
 */
export const platformApi = {
  favorites: (platform: Platform, page = 1, limit = 50) =>
    apiRequest<{
      platform: Platform;
      title?: string;
      total?: number;
      items: UnifiedTrack[];
      page: number;
      limit: number;
    }>(`/api/platform/${platform}/favorites`, { query: { page, limit } }),

  playlists: (platform: Platform) =>
    apiRequest<{ items: PlaylistSummary[] }>(`/api/platform/${platform}/playlists`),

  importPlaylist: (platform: Platform, id: string) =>
    apiRequest<PlatformImportResult>(
      `/api/platform/${platform}/playlists/${encodeURIComponent(id)}/import`,
      { method: 'POST' },
    ),

  importFavorites: (platform: Platform) =>
    apiRequest<PlatformImportResult>(`/api/platform/${platform}/favorites/import`, {
      method: 'POST',
    }),
};
