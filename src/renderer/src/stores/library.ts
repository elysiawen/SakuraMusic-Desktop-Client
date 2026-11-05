import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { credentialApi, libraryApi, platformApi } from '@/api/library';
import type {
  Platform,
  PlatformImportResult,
  Playlist,
  PlaylistSummary,
  ServerCredential,
  UnifiedTrack,
} from '@/api/types';

/**
 * 音乐库。
 *
 * 三套数据刻意分开：Sakura 本地库（歌单/收藏/历史）、平台账号自己的库（只读）、平台凭据。
 * 「导入」是单向复制，本地库之后与平台各走各的，不产生同步关系。
 */
export const useLibraryStore = defineStore('library', () => {
  const playlists = ref<Playlist[]>([]);
  const favorites = ref<UnifiedTrack[]>([]);
  const favoriteKeys = ref<Set<string>>(new Set());
  const history = ref<UnifiedTrack[]>([]);
  const credentials = ref<ServerCredential[]>([]);
  /** 「仅本机」凭据存在主进程，网关不列出来，这里单独记一份绑定状态。 */
  const localBound = ref<Platform[]>([]);
  const platformPlaylists = ref<Record<Platform, PlaylistSummary[]>>({ netease: [], qq: [] });
  const platformLoading = ref<Partial<Record<Platform, boolean>>>({});
  const importing = ref('');
  const loading = ref(false);
  const error = ref('');

  const totalTracks = computed(() =>
    playlists.value.reduce((sum, item) => sum + item.trackCount, 0),
  );

  function isFavorite(track: UnifiedTrack): boolean {
    return favoriteKeys.value.has(track.key);
  }

  function credentialFor(platform: Platform): ServerCredential | null {
    return credentials.value.find((item) => item.platform === platform) ?? null;
  }

  /** 服务器上有凭据，或本机保险库里有凭据。 */
  function isBound(platform: Platform): boolean {
    return Boolean(credentialFor(platform)) || localBound.value.includes(platform);
  }

  /** 只有本机凭据、服务器没有 —— 界面据此标「仅本机」。 */
  function isLocalOnly(platform: Platform): boolean {
    return !credentialFor(platform) && localBound.value.includes(platform);
  }

  async function loadLocalBound(): Promise<void> {
    try {
      localBound.value = (await window.sakura.platformCredentials.list()).platforms;
    } catch {
      localBound.value = [];
    }
  }

  async function saveLocalCredential(platform: Platform, cookie: string): Promise<void> {
    const state = await window.sakura.platformCredentials.save({ platform, cookie });
    localBound.value = state.platforms;
  }

  async function clearLocalCredential(platform: Platform): Promise<void> {
    const state = await window.sakura.platformCredentials.clear(platform);
    localBound.value = state.platforms;
  }

  async function loadPlaylists(): Promise<void> {
    playlists.value = (await libraryApi.listPlaylists()).items;
  }

  async function loadFavorites(): Promise<void> {
    const result = await libraryApi.listFavorites();
    favorites.value = result.items;
    favoriteKeys.value = new Set(result.keys);
  }

  async function loadHistory(): Promise<void> {
    history.value = (await libraryApi.listHistory()).items;
  }

  async function loadCredentials(): Promise<void> {
    credentials.value = (await credentialApi.listServer()).items;
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      await Promise.all([
        loadPlaylists(),
        loadFavorites(),
        loadHistory(),
        loadCredentials(),
        loadLocalBound(),
      ]);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '读取音乐库失败';
    } finally {
      loading.value = false;
    }
  }

  async function toggleFavorite(track: UnifiedTrack): Promise<boolean> {
    const next = !isFavorite(track);
    await libraryApi.setFavorite(track, next);

    const keys = new Set(favoriteKeys.value);
    if (next) keys.add(track.key);
    else keys.delete(track.key);
    favoriteKeys.value = keys;

    if (next) favorites.value = [track, ...favorites.value];
    else favorites.value = favorites.value.filter((item) => item.key !== track.key);
    return next;
  }

  async function createPlaylist(name: string, description?: string): Promise<Playlist> {
    const result = await libraryApi.createPlaylist(name, description);
    playlists.value = [result.playlist, ...playlists.value];
    return result.playlist;
  }

  /** 名称与描述走同一条 PATCH，一次改完，避免只生效一半。 */
  async function updatePlaylist(
    id: string,
    input: { name?: string; description?: string },
  ): Promise<void> {
    await libraryApi.updatePlaylist(id, input);
    playlists.value = playlists.value.map((item) => (item.id === id ? { ...item, ...input } : item));
  }

  async function deletePlaylist(id: string): Promise<void> {
    await libraryApi.deletePlaylist(id);
    playlists.value = playlists.value.filter((item) => item.id !== id);
  }

  async function addToPlaylist(id: string, track: UnifiedTrack): Promise<boolean> {
    const result = await libraryApi.addTrack(id, track);
    await loadPlaylists();
    return result.added;
  }

  async function removeFromPlaylist(id: string, track: UnifiedTrack): Promise<void> {
    const source = track.sources[0];
    if (!source) return;
    await libraryApi.removeTrack(id, source.platform, source.id);
    await loadPlaylists();
  }

  async function recordPlay(track: UnifiedTrack): Promise<void> {
    try {
      await libraryApi.recordPlay(track);
      history.value = [track, ...history.value.filter((item) => item.key !== track.key)].slice(0, 300);
    } catch {
      // 历史记录失败不影响播放。
    }
  }

  async function clearHistory(): Promise<void> {
    await libraryApi.clearHistory();
    history.value = [];
  }

  async function loadPlatformPlaylists(platform: Platform): Promise<void> {
    platformLoading.value = { ...platformLoading.value, [platform]: true };
    try {
      const result = await platformApi.playlists(platform);
      platformPlaylists.value = { ...platformPlaylists.value, [platform]: result.items };
    } finally {
      platformLoading.value = { ...platformLoading.value, [platform]: false };
    }
  }

  async function importPlaylist(platform: Platform, id: string): Promise<PlatformImportResult> {
    importing.value = `${platform}:${id}`;
    try {
      const result = await platformApi.importPlaylist(platform, id);
      await loadPlaylists();
      return result;
    } finally {
      importing.value = '';
    }
  }

  async function importFavorites(platform: Platform): Promise<PlatformImportResult> {
    importing.value = `${platform}:favorites`;
    try {
      const result = await platformApi.importFavorites(platform);
      await loadPlaylists();
      return result;
    } finally {
      importing.value = '';
    }
  }

  async function refreshCredential(platform: Platform): Promise<void> {
    const result = await credentialApi.refresh(platform);
    // 「仅本机」模式下 QQ 会换出一份新 cookie，得写回主进程，否则下次还用旧的。
    if (result.mode === 'local' && result.credential?.cookie) {
      await saveLocalCredential(platform, result.credential.cookie);
    }
    await loadCredentials();
  }

  async function unbind(platform: Platform): Promise<void> {
    await clearLocalCredential(platform);
    if (credentialFor(platform)) await credentialApi.unbind(platform);
    await loadCredentials();
    platformPlaylists.value = { ...platformPlaylists.value, [platform]: [] };
  }

  return {
    playlists,
    favorites,
    favoriteKeys,
    history,
    credentials,
    localBound,
    platformPlaylists,
    platformLoading,
    importing,
    loading,
    error,
    totalTracks,
    isFavorite,
    credentialFor,
    isBound,
    isLocalOnly,
    loadLocalBound,
    saveLocalCredential,
    clearLocalCredential,
    loadPlaylists,
    loadFavorites,
    loadHistory,
    loadCredentials,
    loadAll,
    toggleFavorite,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    recordPlay,
    clearHistory,
    loadPlatformPlaylists,
    importPlaylist,
    importFavorites,
    refreshCredential,
    unbind,
  };
});
