import { apiRequest } from './client';
import type { PlatformManifest, PreferenceEntry } from './types';

/**
 * 云端偏好（key-value，网关不解释语义）。
 *
 * 平台开关存在 `platforms` 这个键上，换设备登录同一账号能直接拿到同一份配置。
 */
export const preferenceApi = {
  list: () => apiRequest<{ items: PreferenceEntry[] }>('/api/preferences'),

  put: (key: string, value: unknown) =>
    apiRequest<PreferenceEntry>(`/api/preferences/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { value },
    }),

  remove: (key: string) =>
    apiRequest<{ ok: boolean }>(`/api/preferences/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
};

/** 平台清单与静态能力：设置页据此决定渲染哪些开关。 */
export const platformMetaApi = {
  list: () => apiRequest<{ items: PlatformManifest[] }>('/api/platforms'),
};
