import type {
  OfflineDownloadRequest,
  OfflineDownloadResult,
  OfflineLibrary,
} from '@shared/offline';
import { offlineStreamPath } from '@shared/offline';

/**
 * 离线库走本地 BFF 的 `/offline/*`，而不是网关的 `/api/*`。
 *
 * 这里直接用 fetch：`apiRequest` 会把路径前缀补成 `/api`，这些接口不在那个命名空间下。
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `本地服务返回 ${response.status}`);
  }
  return payload as T;
}

export interface OfflineProgressEvent {
  key: string;
  received: number;
  total: number;
}

/** 订阅下载进度；返回取消函数。断线后浏览器会自动重连。 */
export function openProgressEvents(handler: (event: OfflineProgressEvent) => void): () => void {
  const source = new EventSource('/offline/events');

  source.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data) as Partial<OfflineProgressEvent>;
      if (typeof data.key === 'string' && typeof data.received === 'number') {
        handler({ key: data.key, received: data.received, total: data.total ?? 0 });
      }
    } catch {
      // 心跳帧与非法数据直接跳过。
    }
  };

  return () => source.close();
}

export const offlineApi = {
  list: () => request<OfflineLibrary>('/offline/list'),

  download: (input: OfflineDownloadRequest) =>
    request<OfflineDownloadResult>('/offline/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  remove: (key: string) =>
    request<{ ok: boolean }>(`/offline/item/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  clear: () => request<{ ok: boolean }>('/offline/all', { method: 'DELETE' }),

  streamUrl: (key: string) => offlineStreamPath(key),
};
