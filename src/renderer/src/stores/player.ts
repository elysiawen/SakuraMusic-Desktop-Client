import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { musicApi } from '@/api';
import {
  PREMIUM_QUALITIES,
  QUALITY_LABEL,
  qualityLabel,
  type LyricResult,
  type Platform,
  type Quality,
  type TrackSource,
  type UnifiedTrack,
} from '@/api/types';
import { offlineApi } from '@/api/offline';
import { useToast } from '@/composables/useToast';
import { QUALITY_ORDER } from '@/utils/track';
import { useOfflineStore } from './offline';

export type RepeatMode = 'off' | 'all' | 'one';
export type PlayMode = 'order' | 'all' | 'one' | 'shuffle';
export type RouteMode = 'auto' | 'direct' | 'proxy';

interface PersistedPlayerState {
  volume?: number;
  quality?: Quality;
  repeat?: RepeatMode;
  shuffle?: boolean;
  preferredPlatform?: Platform | null;
  proxyOnly?: Platform[];
  routeMode?: Partial<Record<Platform, RouteMode>>;
  queue?: UnifiedTrack[];
  index?: number;
  position?: number;
}

const STORAGE_KEY = 'sakura.player';
const MAX_PERSISTED_QUEUE = 200;

export const PLAY_QUALITIES = QUALITY_ORDER;

/**
 * 一条由「一起听」房间提供的播放地址（用的是房间里另一方的会员权益）。
 *
 * 桌面端拿到的是主进程登记过的同源 `/media/<id>`：直链与防盗链请求头都留在主进程，
 * 渲染进程既设不了请求头，CSP 也只允许同源媒体。
 */
export interface SharedStream {
  url: string;
  /** 只拿到试听片段（提供方自己也没权限）。 */
  trial?: boolean;
  /** 提供方实际拿到的档位。 */
  quality?: Quality;
}

/**
 * 共享地址的提供者。返回 `null` 表示「这首没有可用的共享地址」，退回自己的解析。
 *
 * 由 room store 注入：它持有共享地址，也知道当前平台是不是在借别人的会员。
 */
export type SharedSourceProvider = (platform: Platform, trackKey: string) => SharedStream | null;

function isQuality(value: unknown): value is Quality {
  return typeof value === 'string' && value in QUALITY_LABEL;
}

function capQueue(queue: UnifiedTrack[], index: number): { queue: UnifiedTrack[]; index: number } {
  if (queue.length <= MAX_PERSISTED_QUEUE) return { queue, index };
  const at = Math.min(Math.max(0, index), queue.length - 1);
  const half = Math.floor(MAX_PERSISTED_QUEUE / 2);
  const start = Math.min(Math.max(0, at - half), queue.length - MAX_PERSISTED_QUEUE);
  return { queue: queue.slice(start, start + MAX_PERSISTED_QUEUE), index: at - start };
}

function loadPersisted(): PersistedPlayerState {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as PersistedPlayerState;
  } catch {
    return {};
  }
}

function pickSource(track: UnifiedTrack, preferred: Platform | null): TrackSource | null {
  if (preferred) {
    const matched = track.sources.find((source) => source.platform === preferred);
    if (matched) return matched;
  }
  return track.sources[0] ?? null;
}

/**
 * 播放器。
 *
 * 与 web 版的差异：音频只有一个同源地址 `/media/<id>`，直连/CDN 请求头/代理回退
 * 全部由主进程 BFF 处理。这里只负责队列、进度、歌词与系统媒体控制。
 */
export const usePlayerStore = defineStore('player', () => {
  const persisted = loadPersisted();
  const toast = useToast();
  const offline = useOfflineStore();

  let audio: HTMLAudioElement | null = null;
  let pendingSeek = 0;
  let resolvingSource = false;
  let loadToken = 0;
  let loadedKey: string | null = null;
  let directFallback: string | null = null;
  let persistTimer: number | undefined;
  let mediaSessionReady = false;
  /**
   * 房间期间暂停个人现场落盘。
   *
   * 一起听会把房间队列铺到播放器上，若照常写 localStorage，用户自己的队列与进度
   * 就被房间内容顶掉了——退出房间后再也找不回来。
   */
  let persistencePaused = false;
  /**
   * 房间的「播完」钩子：非空时自然播完交给它，本机不再自己 `next()`。
   *
   * 房间里「下一首放什么」由服务端权威决定（顺序/循环/单曲/随机都在房间的 mode 里），
   * 本机自行切歌只会和房间状态打架。
   */
  let roomEndedHook: (() => void) | null = null;
  /**
   * 一起听会员共享：房间把「用对方会员解析出来的地址」从这里递进来。
   *
   * 用回调而不是把地址塞进播放器状态：地址的生命周期归房间管（它知道什么时候失效），
   * 播放器只在每次起播时问一句「这首有共享地址吗」。
   */
  let sharedSourceProvider: SharedSourceProvider | null = null;
  /** 共享地址播放失败时的回落地址（本机账号解析出来的那条）。 */
  let sharedFallback: string | null = null;

  const queue = ref<UnifiedTrack[]>([]);
  const index = ref(-1);
  const playing = ref(false);
  const loading = ref(false);
  const error = ref('');
  const currentTime = ref(0);
  const duration = ref(0);
  const volume = ref(typeof persisted.volume === 'number' ? persisted.volume : 0.8);
  const muted = ref(false);
  const quality = ref<Quality>(isQuality(persisted.quality) ? persisted.quality : 'high');
  const actualQuality = ref<Quality | null>(null);
  const trial = ref(false);
  const repeat = ref<RepeatMode>(persisted.repeat ?? 'all');
  const shuffle = ref(persisted.shuffle ?? false);
  const preferredPlatform = ref<Platform | null>(persisted.preferredPlatform ?? null);
  const proxyOnly = ref<Platform[]>(persisted.proxyOnly ?? []);
  const routeMode = ref<Partial<Record<Platform, RouteMode>>>(persisted.routeMode ?? {});
  const lyric = ref<LyricResult>({ lrc: '', trans: '', roma: '' });
  const lyricLoading = ref(false);
  const usingDirect = ref(false);
  /** 当前这一首用的是不是一起听里对方提供的会员地址。 */
  const usingShared = ref(false);

  const current = computed<UnifiedTrack | null>(() => queue.value[index.value] ?? null);
  const activeSource = computed<TrackSource | null>(() =>
    current.value ? pickSource(current.value, preferredPlatform.value) : null,
  );
  const progress = computed(() => (duration.value > 0 ? currentTime.value / duration.value : 0));
  const mode = computed<PlayMode>(() => {
    if (shuffle.value) return 'shuffle';
    if (repeat.value === 'one') return 'one';
    if (repeat.value === 'all') return 'all';
    return 'order';
  });

  const qualityNotice = computed(() => {
    const wanted = quality.value;
    const actual = actualQuality.value;
    if (!actual || actual === wanted) return '';

    const platform = activeSource.value?.platform;
    const wantedLabel = qualityLabel(wanted, platform);
    const actualLabel = qualityLabel(actual, platform);
    const available = current.value?.qualities;

    if (available && !available.includes(wanted)) {
      return `这首歌没有「${wantedLabel}」，已用「${actualLabel}」播放`;
    }
    if (PREMIUM_QUALITIES.includes(wanted)) {
      return `「${wantedLabel}」需要对应等级的会员，当前账号没有这一档，已用「${actualLabel}」播放`;
    }
    if (current.value?.vip) {
      return `「${wantedLabel}」需要会员或购买后才能播放，已用「${actualLabel}」播放`;
    }
    return `平台没有提供「${wantedLabel}」，已用「${actualLabel}」播放`;
  });

  // 恢复上次的现场：摆好队列与进度，但不自动出声。
  if (Array.isArray(persisted.queue) && persisted.queue.length > 0) {
    queue.value = persisted.queue;
    index.value =
      typeof persisted.index === 'number' &&
      persisted.index >= 0 &&
      persisted.index < persisted.queue.length
        ? persisted.index
        : 0;
    currentTime.value =
      typeof persisted.position === 'number' && persisted.position > 0 ? persisted.position : 0;
    pendingSeek = currentTime.value;
    const restored = queue.value[index.value];
    if (restored) duration.value = restored.durationMs / 1000;
  }

  function persist(): void {
    // 房间里播放器装的是房间队列：写下去等于把用户的个人现场覆盖掉。
    if (persistencePaused) return;
    const capped = capQueue(queue.value, index.value);
    const state: PersistedPlayerState = {
      volume: volume.value,
      quality: quality.value,
      repeat: repeat.value,
      shuffle: shuffle.value,
      preferredPlatform: preferredPlatform.value,
      proxyOnly: proxyOnly.value,
      routeMode: routeMode.value,
      queue: capped.queue,
      index: capped.index,
      position: currentTime.value,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, queue: undefined }));
      } catch {
        // 存储不可用时不影响播放。
      }
    }
  }

  function persistSoon(): void {
    if (persistTimer !== undefined) return;
    persistTimer = window.setTimeout(() => {
      persistTimer = undefined;
      persist();
    }, 2000);
  }

  function rememberProxyOnly(platform: Platform): void {
    if (proxyOnly.value.includes(platform)) return;
    proxyOnly.value = [...proxyOnly.value, platform];
    persist();
  }

  function setRouteMode(platform: Platform, next: RouteMode): void {
    routeMode.value = { ...routeMode.value, [platform]: next };
    if (next !== 'proxy') {
      proxyOnly.value = proxyOnly.value.filter((item) => item !== platform);
    }
    persist();
  }

  function setupMediaSession(): void {
    if (!('mediaSession' in navigator) || mediaSessionReady) return;
    mediaSessionReady = true;

    const session = navigator.mediaSession;
    const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler): void => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // 个别平台只支持部分动作。
      }
    };

    bind('play', () => play());
    bind('pause', () => pause());
    bind('stop', () => {
      pause();
      seek(0);
    });
    bind('previoustrack', () => void prev());
    bind('nexttrack', () => void next());
    bind('seekbackward', (details) => seek(currentTime.value - (details.seekOffset ?? 10)));
    bind('seekforward', (details) => seek(currentTime.value + (details.seekOffset ?? 10)));
    bind('seekto', (details) => {
      if (typeof details.seekTime === 'number') seek(details.seekTime);
    });
  }

  function updatePositionState(): void {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    if (typeof session.setPositionState !== 'function') return;
    if (!Number.isFinite(duration.value) || duration.value <= 0) return;

    const position = Math.min(Math.max(currentTime.value, 0), duration.value);
    try {
      session.setPositionState({
        duration: duration.value,
        playbackRate: audio?.playbackRate ?? 1,
        position,
      });
    } catch {
      // 某些状态组合会被浏览器拒绝，忽略即可。
    }
  }

  function updateMediaSession(track: UnifiedTrack | null): void {
    if (!('mediaSession' in navigator)) return;
    setupMediaSession();
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists.map((item) => item.name).join(' / '),
      album: track.album.name,
      artwork: track.album.cover ? [{ src: track.album.cover, sizes: '300x300' }] : [],
    });
    updatePositionState();
  }

  function ensureAudio(): HTMLAudioElement {
    if (audio) return audio;

    const element = new Audio();
    element.preload = 'metadata';
    element.volume = volume.value;

    element.addEventListener('timeupdate', () => {
      if (resolvingSource) return;
      currentTime.value = element.currentTime;
      persistSoon();
      updatePositionState();
    });
    element.addEventListener('loadedmetadata', () => {
      duration.value = Number.isFinite(element.duration) ? element.duration : 0;
      updatePositionState();
    });
    element.addEventListener('durationchange', () => {
      if (Number.isFinite(element.duration) && element.duration > 0) duration.value = element.duration;
    });
    element.addEventListener('play', () => {
      playing.value = true;
    });
    element.addEventListener('pause', () => {
      playing.value = false;
      loading.value = false;
    });
    element.addEventListener('waiting', () => {
      loading.value = true;
    });
    element.addEventListener('playing', () => {
      loading.value = false;
    });
    element.addEventListener('ended', () => {
      /*
       * 房间里「播完往哪走」由服务端定（房间的 mode）：本机只上报，不自己切歌。
       * 用 0ms 定时器挪出 audio 事件栈——上报是请求，不该在事件回调里同步跑。
       */
      if (roomEndedHook) {
        playing.value = false;
        const hook = roomEndedHook;
        window.setTimeout(() => hook(), 0);
        return;
      }
      if (repeat.value === 'one') {
        element.currentTime = 0;
        void element.play();
        return;
      }
      void next(true);
    });
    element.addEventListener('error', () => {
      loading.value = false;
      playing.value = false;
      if (!element.src) return;

      // 共享地址放不出来（对方撤销授权、地址过期等）：一个字节都没出来时退回本机解析。
      if (usingShared.value && sharedFallback && element.readyState === 0) {
        const fallback = sharedFallback;
        sharedFallback = null;
        usingShared.value = false;
        loading.value = true;
        error.value = '';
        element.src = fallback;
        element.load();
        void element.play().catch(() => {
          loading.value = false;
        });
        toast.info('共享的会员地址不可用，已改用本机账号播放');
        return;
      }

      // 直连被 CDN 拒绝：一个字节都没出来时回退到网关代理，并记住该平台。
      if (usingDirect.value && directFallback && element.readyState === 0) {
        const fallback = directFallback;
        directFallback = null;
        usingDirect.value = false;
        const platform = activeSource.value?.platform;
        if (platform) rememberProxyOnly(platform);
        loading.value = true;
        error.value = '';
        element.src = fallback;
        element.load();
        void element.play().catch(() => {
          loading.value = false;
        });
        toast.info('该平台无法直连，已自动切换为网关中转');
        return;
      }

      error.value =
        usingDirect.value && !directFallback
          ? '直连失败：当前取流方式是「直连」，可改为「智能」或「中转」'
          : '音频加载失败，请稍后重试或切换音源';
      toast.error(error.value);
    });

    audio = element;
    return element;
  }

  function revertToLoaded(): void {
    const element = ensureAudio();
    const at = loadedKey ? queue.value.findIndex((item) => item.key === loadedKey) : -1;
    if (at >= 0) {
      index.value = at;
      currentTime.value = element.currentTime;
      duration.value = Number.isFinite(element.duration) ? element.duration : 0;
      playing.value = !element.paused;
      return;
    }

    element.pause();
    element.removeAttribute('src');
    element.load();
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
  }

  async function loadLyric(source: TrackSource | null): Promise<void> {
    if (!source) return;
    lyricLoading.value = true;
    lyric.value = { lrc: '', trans: '', roma: '' };
    try {
      lyric.value = await musicApi.lyric(source.platform, source.id);
    } catch {
      lyric.value = { lrc: '', trans: '', roma: '' };
    } finally {
      lyricLoading.value = false;
    }
  }

  async function start(): Promise<void> {
    const track = current.value;
    if (!track) return;

    const source = activeSource.value;
    if (!source) {
      error.value = '该歌曲没有可用的音源';
      toast.error(error.value);
      return;
    }

    loading.value = true;
    error.value = '';
    actualQuality.value = null;
    // 起播前先摘掉上一首的「共享」标识：解析失败提前返回时，界面不能继续显示它。
    usingShared.value = false;
    sharedFallback = null;
    resolvingSource = true;
    const token = ++loadToken;
    let srcSwapped = false;

    try {
      /*
       * 已下载到本地就直接放本地文件：断网也能听，也省掉一次取流解析。
       * 走 `/offline/stream/<key>` 而不是 file://，这样进度条拖动、Range 都由主进程处理。
       */
      if (offline.has(track.key)) {
        const element = ensureAudio();
        element.src = offlineApi.streamUrl(track.key);
        srcSwapped = true;
        loadedKey = track.key;
        element.volume = volume.value;
        element.muted = muted.value;
        usingDirect.value = false;
        usingShared.value = false;
        directFallback = null;
        sharedFallback = null;
        trial.value = false;
        actualQuality.value =
          (offline.itemOf(track.key)?.quality as Quality | undefined) ?? quality.value;

        const offset = pendingSeek;
        pendingSeek = 0;
        if (offset > 0.5) element.currentTime = offset;
        currentTime.value = offset;
        resolvingSource = false;

        void loadLyric(source);
        updateMediaSession(track);

        await element.play();
        playing.value = true;
        return;
      }

      /*
       * 一起听会员共享：房间可能已经拿到一条「用对方会员解析出来的」同源地址。
       * 有就优先用它（否则没会员的一方永远只能听试听），同时仍解析一次自己的地址，
       * 作为共享地址失败时的回落。
       */
      const shared = sharedSourceProvider?.(source.platform, track.key) ?? null;
      const resolved = await musicApi
        .resolvePlay(source.platform, source.id, quality.value)
        .catch((cause: unknown) => {
          if (shared) return null;
          throw cause;
        });
      if (token !== loadToken) return;

      if (shared) {
        const ownMedia = resolved?.media ?? (resolved?.url ? { proxy: resolved.url } : null);
        sharedFallback = ownMedia?.direct ?? ownMedia?.proxy ?? null;
        usingShared.value = true;
        usingDirect.value = false;
        directFallback = null;

        const element = ensureAudio();
        element.src = shared.url;
        srcSwapped = true;
        loadedKey = track.key;
        element.volume = volume.value;
        element.muted = muted.value;
        trial.value = shared.trial === true;
        actualQuality.value = shared.quality ?? resolved?.actualQuality ?? quality.value;

        const offset = pendingSeek;
        pendingSeek = 0;
        if (offset > 0.5) element.currentTime = offset;
        currentTime.value = offset;
        resolvingSource = false;

        void loadLyric(source);
        updateMediaSession(track);

        await element.play();
        playing.value = true;

        if (shared.trial) toast.info('共享的会员也拿不到完整音源，只能试听');
        return;
      }

      if (!resolved) throw new Error('该歌曲没有可用的播放地址');
      usingShared.value = false;
      sharedFallback = null;

      const media = resolved.media ?? { proxy: resolved.url };
      if (!media.proxy && !media.direct) throw new Error('该歌曲没有可用的播放地址');

      const platformMode = routeMode.value[source.platform] ?? 'auto';
      const preferDirect = platformMode !== 'proxy' && !proxyOnly.value.includes(source.platform);
      const chosen = preferDirect && media.direct ? media.direct : media.proxy;

      usingDirect.value = Boolean(media.direct && chosen === media.direct);
      directFallback = platformMode === 'auto' && media.direct ? media.proxy : null;

      const element = ensureAudio();
      element.src = chosen;
      srcSwapped = true;
      loadedKey = track.key;
      element.volume = volume.value;
      element.muted = muted.value;
      trial.value = resolved.trial;
      actualQuality.value = resolved.actualQuality ?? quality.value;

      const offset = pendingSeek;
      pendingSeek = 0;
      if (offset > 0.5) element.currentTime = offset;
      currentTime.value = offset;
      resolvingSource = false;

      void loadLyric(source);
      updateMediaSession(track);

      await element.play();
      playing.value = true;

      if (resolved.trial) {
        toast.info('该曲目仅能获取试听片段（受版权或会员限制）');
      }
    } catch (caught) {
      if (token !== loadToken) return;
      const message = caught instanceof Error ? caught.message : '播放失败';
      error.value = message;
      if (srcSwapped) playing.value = false;
      else revertToLoaded();
      toast.error(message);
    } finally {
      if (token === loadToken) {
        loading.value = false;
        resolvingSource = false;
      }
    }
  }

  async function playTrack(track: UnifiedTrack, list?: UnifiedTrack[]): Promise<void> {
    if (list && list.length > 0) {
      queue.value = [...list];
      index.value = Math.max(
        0,
        queue.value.findIndex((item) => item.key === track.key),
      );
    } else if (!queue.value.some((item) => item.key === track.key)) {
      queue.value = [track];
      index.value = 0;
    } else {
      index.value = queue.value.findIndex((item) => item.key === track.key);
    }

    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  async function playQueue(list: UnifiedTrack[], startIndex = 0): Promise<void> {
    if (list.length === 0) return;
    queue.value = [...list];
    index.value = Math.min(Math.max(0, startIndex), list.length - 1);
    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  /** 播放队列里的第 `at` 首（队列本身不变，只挪指针）。 */
  async function playAt(at: number): Promise<void> {
    if (at < 0 || at >= queue.value.length) return;
    index.value = at;
    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  async function next(auto = false): Promise<void> {
    if (queue.value.length === 0) return;

    if (shuffle.value && queue.value.length > 1) {
      let at = index.value;
      while (at === index.value) at = Math.floor(Math.random() * queue.value.length);
      index.value = at;
    } else if (index.value < queue.value.length - 1) {
      index.value += 1;
    } else if (repeat.value === 'all' || !auto) {
      index.value = 0;
    } else {
      pause();
      seek(0);
      return;
    }

    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  async function prev(): Promise<void> {
    if (queue.value.length === 0) return;
    if (currentTime.value > 4) {
      seek(0);
      return;
    }

    index.value = index.value > 0 ? index.value - 1 : queue.value.length - 1;
    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  function play(): void {
    const element = ensureAudio();
    if (!element.src) {
      void start();
      return;
    }
    if (element.paused) {
      void element.play().catch((caught: unknown) => {
        error.value = caught instanceof Error ? caught.message : '播放失败';
        toast.error(error.value);
      });
    }
  }

  function pause(): void {
    const element = ensureAudio();
    if (!element.paused) element.pause();
  }

  function toggle(): void {
    const element = ensureAudio();
    if (!element.src) {
      void start();
      return;
    }
    if (element.paused) play();
    else pause();
  }

  function seek(seconds: number): void {
    const element = ensureAudio();
    const target = Math.max(0, Math.min(seconds, duration.value || seconds));

    if (!element.src) {
      currentTime.value = target;
      pendingSeek = target;
      return;
    }

    try {
      element.currentTime = target;
    } catch {
      // 元数据还没到位时浏览器可能拒绝，等 loadedmetadata 后用户再拖一次即可。
    }
    currentTime.value = target;
    updatePositionState();
    persistSoon();
  }

  function setVolume(value: number): void {
    const next = Math.min(1, Math.max(0, value));
    volume.value = next;
    const element = ensureAudio();
    element.volume = next;
    if (next > 0 && element.muted) element.muted = false;
    muted.value = element.muted;
    persistSoon();
  }

  function toggleMute(): void {
    const element = ensureAudio();
    element.muted = !element.muted;
    muted.value = element.muted;
    persistSoon();
  }

  /**
   * 暂停 / 恢复个人现场落盘（进入、退出房间时各调一次）。
   *
   * 恢复时立刻写一次：那一刻播放器上还是房间内容，但调用方紧接着就会摆回个人现场，
   * 队列的 watcher 会再写一遍正确的那份。
   */
  function setPersistencePaused(paused: boolean): void {
    if (persistencePaused === paused) return;
    persistencePaused = paused;
    if (!paused) persist();
  }

  /** 把「自然播完」交给房间（传 `null` 收回）。 */
  function setRoomEndedHook(hook: (() => void) | null): void {
    roomEndedHook = hook;
  }

  /**
   * 注入一起听会员共享的地址来源（传 `null` 收回）。
   *
   * 播放器每次起播时问一句：这首、这个平台，有没有「用对方会员」的地址。
   */
  function setSharedSourceProvider(provider: SharedSourceProvider | null): void {
    sharedSourceProvider = provider;
  }

  /** 远程控制用：直接设定模式，不弹提示，也不切换队列顺序。 */
  function setMode(next: PlayMode): void {
    shuffle.value = next === 'shuffle';
    repeat.value = next === 'one' ? 'one' : next === 'all' ? 'all' : 'off';
    persist();
  }

  function cycleMode(): void {
    const order: PlayMode[] = ['order', 'all', 'one', 'shuffle'];
    const at = order.indexOf(mode.value);
    const nextMode = order[(at + 1) % order.length] ?? 'order';

    shuffle.value = nextMode === 'shuffle';
    repeat.value = nextMode === 'one' ? 'one' : nextMode === 'all' ? 'all' : 'off';
    persist();

    const label: Record<PlayMode, string> = {
      order: '顺序播放',
      all: '列表循环',
      one: '单曲循环',
      shuffle: '随机播放',
    };
    toast.info(label[nextMode]);
  }

  async function setQuality(next: Quality): Promise<void> {
    if (next === quality.value) return;
    quality.value = next;
    actualQuality.value = null;
    persist();

    if (current.value && audio?.src) {
      pendingSeek = audio.currentTime || currentTime.value;
      await start();
    }
  }

  async function setPreferredPlatform(platform: Platform): Promise<void> {
    if (platform === preferredPlatform.value) return;
    if (!current.value?.sources.some((source) => source.platform === platform)) {
      toast.info('这首没有该平台的音源');
      return;
    }

    preferredPlatform.value = platform;
    persist();

    if (current.value && audio?.src) {
      pendingSeek = audio.currentTime || currentTime.value;
      await start();
    }
  }

  function enqueue(track: UnifiedTrack): void {
    if (queue.value.some((item) => item.key === track.key)) {
      toast.info('队列里已经有这首了');
      return;
    }
    queue.value = [...queue.value, track];
    if (index.value < 0) index.value = 0;
    persist();
    toast.success('已加入队列');
  }

  function playNext(track: UnifiedTrack): void {
    if (index.value < 0) {
      queue.value = [track];
      index.value = 0;
    } else {
      const rest = queue.value.filter((item) => item.key !== track.key);
      const at = Math.min(index.value + 1, rest.length);
      queue.value = [...rest.slice(0, at), track, ...rest.slice(at)];
    }
    persist();
    toast.success('已设为下一首');
  }

  function removeFromQueue(key: string): void {
    const at = queue.value.findIndex((item) => item.key === key);
    if (at < 0) return;

    const wasCurrent = at === index.value;
    queue.value = queue.value.filter((item) => item.key !== key);

    if (at < index.value) index.value -= 1;
    else if (wasCurrent) index.value = Math.min(index.value, queue.value.length - 1);

    if (queue.value.length === 0) {
      clearQueue();
      return;
    }
    if (wasCurrent && playing.value) void start();
    persist();
  }

  /** 按下标移除：队列面板拿到的是位置，不是 key。 */
  function removeFromQueueAt(at: number): void {
    const track = queue.value[at];
    if (track) removeFromQueue(track.key);
  }

  function clearQueue(): void {
    const element = ensureAudio();
    element.pause();
    element.removeAttribute('src');
    element.load();
    queue.value = [];
    index.value = -1;
    playing.value = false;
    loading.value = false;
    currentTime.value = 0;
    duration.value = 0;
    lyric.value = { lrc: '', trans: '', roma: '' };
    loadedKey = null;
    usingShared.value = false;
    sharedFallback = null;
    updateMediaSession(null);
    persist();
  }

  watch(playing, (value) => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = value ? 'playing' : 'paused';
    }
  });

  watch(
    () => [queue.value, index.value] as const,
    () => persist(),
  );

  return {
    queue,
    index,
    playing,
    loading,
    error,
    currentTime,
    duration,
    volume,
    muted,
    quality,
    actualQuality,
    trial,
    repeat,
    shuffle,
    mode,
    preferredPlatform,
    proxyOnly,
    routeMode,
    lyric,
    lyricLoading,
    usingDirect,
    /** 当前这首用的是不是一起听里对方提供的会员地址。 */
    usingShared,
    current,
    activeSource,
    progress,
    qualityNotice,
    playTrack,
    playQueue,
    playAt,
    next,
    prev,
    play,
    pause,
    toggle,
    seek,
    setVolume,
    toggleMute,
    setMode,
    /** 房间期间暂停个人现场落盘（退出房间时恢复并写回一次）。 */
    setPersistencePaused,
    /** 房间里把「自然播完」交给服务端处理。 */
    setRoomEndedHook,
    /** 注入一起听会员共享的地址来源（传 null 收回）。 */
    setSharedSourceProvider,
    cycleMode,
    setQuality,
    setPreferredPlatform,
    setRouteMode,
    enqueue,
    playNext,
    removeFromQueue,
    removeFromQueueAt,
    clearQueue,
  };
});
