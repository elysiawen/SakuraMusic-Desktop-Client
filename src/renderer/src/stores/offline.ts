import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { offlineApi, openProgressEvents, type OfflineProgressEvent } from '@/api/offline';
import type { OfflineItem } from '@shared/offline';
import type { Quality, UnifiedTrack } from '@/api/types';

/**
 * 本地下载库。
 *
 * 注意这里是「用户主动下载」的音频，与流媒体缓存是两套东西：
 * 下载的文件归用户所有（在下载目录里能直接看到），删除也只删这些文件。
 */
export const useOfflineStore = defineStore('offline', () => {
  const items = ref<OfflineItem[]>([]);
  const usedBytes = ref(0);
  const loading = ref(false);
  const error = ref('');
  /** 按 track.key 记正在下载的曲目，避免重复点击。 */
  const downloading = ref<Record<string, boolean>>({});
  /** 下载进度（来自本地 BFF 的 SSE）。 */
  const progress = ref<Record<string, OfflineProgressEvent>>({});

  const keys = computed(() => new Set(items.value.map((item) => item.key)));
  const byKey = computed(() => new Map(items.value.map((item) => [item.key, item])));

  const usedText = computed(() => formatBytes(usedBytes.value));

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  function has(key: string): boolean {
    return keys.value.has(key);
  }

  function itemOf(key: string): OfflineItem | null {
    return byKey.value.get(key) ?? null;
  }

  function isDownloading(key: string): boolean {
    return Boolean(downloading.value[key]);
  }

  function progressOf(key: string): OfflineProgressEvent | null {
    return progress.value[key] ?? null;
  }

  /** 0 表示还拿不到总长度（上游没给 content-length）。 */
  function percentOf(key: string): number {
    const current = progress.value[key];
    if (!current || current.total <= 0) return 0;
    return Math.min(99, Math.round((current.received / current.total) * 100));
  }

  const activeDownloads = computed(() => Object.keys(progress.value).length);

  let detach: (() => void) | null = null;

  function connectProgress(): void {
    if (detach) return;
    detach = openProgressEvents((event) => {
      progress.value = { ...progress.value, [event.key]: event };
    });
  }

  function disconnectProgress(): void {
    detach?.();
    detach = null;
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const state = await offlineApi.list();
      items.value = state.items;
      usedBytes.value = state.usedBytes;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '读取本地下载失败';
    } finally {
      loading.value = false;
    }
  }

  async function download(track: UnifiedTrack, quality: Quality): Promise<OfflineItem> {
    const source = track.sources[0];
    if (!source) throw new Error('这首歌没有可下载的音源');

    downloading.value = { ...downloading.value, [track.key]: true };
    try {
      const result = await offlineApi.download({
        key: track.key,
        platform: source.platform,
        id: source.id,
        quality,
        title: track.title,
        artists: track.artists.map((artist) => artist.name),
        albumName: track.album.name,
        albumCover: track.album.cover ?? '',
        durationMs: track.durationMs,
      });

      const previous = items.value.find((item) => item.key === result.item.key);
      items.value = [result.item, ...items.value.filter((item) => item.key !== result.item.key)];
      usedBytes.value =
        Math.max(0, usedBytes.value - (previous?.bytes ?? 0)) + result.item.bytes;
      return result.item;
    } finally {
      const next = { ...downloading.value };
      delete next[track.key];
      downloading.value = next;

      const nextProgress = { ...progress.value };
      delete nextProgress[track.key];
      progress.value = nextProgress;
    }
  }

  async function remove(key: string): Promise<void> {
    const target = items.value.find((item) => item.key === key);
    await offlineApi.remove(key);
    items.value = items.value.filter((item) => item.key !== key);
    usedBytes.value = Math.max(0, usedBytes.value - (target?.bytes ?? 0));
  }

  async function clear(): Promise<void> {
    await offlineApi.clear();
    items.value = [];
    usedBytes.value = 0;
  }

  return {
    items,
    usedBytes,
    loading,
    error,
    downloading,
    progress,
    activeDownloads,
    keys,
    byKey,
    usedText,
    formatBytes,
    has,
    itemOf,
    isDownloading,
    progressOf,
    percentOf,
    connectProgress,
    disconnectProgress,
    load,
    download,
    remove,
    clear,
  };
});
