import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { musicApi } from '@/api';
import { usePreferencesStore } from '@/stores/preferences';
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
import type { AudioCacheState } from '@shared/ipc';
import { offlineApi } from '@/api/offline';
import { useToast } from '@/composables/useToast';
import { cachedImage } from '@/utils/cacheImage';
import { QUALITY_ORDER } from '@/utils/track';
import { useOfflineStore } from './offline';

export type RepeatMode = 'off' | 'all' | 'one';
export type PlayMode = 'order' | 'all' | 'one' | 'shuffle';
export type RouteMode = 'auto' | 'direct' | 'proxy';

interface PersistedPlayerState {
  volume?: number;
  muted?: boolean;
  quality?: Quality;
  repeat?: RepeatMode;
  shuffle?: boolean;
  preferredPlatform?: Platform | null;
  proxyOnly?: Platform[];
  routeMode?: Partial<Record<Platform, RouteMode>>;
  queue?: UnifiedTrack[];
  index?: number;
  position?: number;
  /** 上次的电台现场：刷新后还能接着自动续歌（服务端会话丢了会自动新建一个）。 */
  radio?: { platform: Platform; session: string; hasMore: boolean };
}

/** 正在听的电台（私人 FM / QQ 猜你喜欢）。它不是一份歌单，而是会不断往下补的流。 */
export interface RadioState {
  platform: Platform;
  /** 网关的电台会话号：服务端据此记住「已经推过哪些歌」。 */
  session: string;
  /** 正在请求下一批，挡住 timeupdate 每 250ms 一拍的并发请求。 */
  loading: boolean;
  /** 电台流是否仍激活（只有 stopRadio 会结束）；空批次不关闭电台，改用冷却重试。 */
  hasMore: boolean;
}

const STORAGE_KEY = 'sakura.player';
/** 落盘保留的队列上限（Android 端的 PlaybackSessionStore 用的是同一个数）。 */
const MAX_PERSISTED_QUEUE = 200;
/**
 * 只剩最后一首时才补下一批：首页那 3 首（QQ 是 5 首）要按顺序放完，
 * 别刚点开就打请求。留一整首歌的时间给网络，足够接上、不会断歌。
 */
const RADIO_REFILL_AHEAD = 0;
/** 续播失败后的冷却：别让 timeupdate 每 250ms 就重试一次，把上游打进风控。 */
const RADIO_RETRY_MS = 20_000;

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
  /** 沉浸歌词页的频谱：audio 接进 Web Audio 图后常驻，两个变量记接线结果。 */
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
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
   *
   * **非空 = 房间真的接管了本机播放**，可以用来挡住电台续播。
   */
  let roomEndedHook: ((endedKey: string) => void) | null = null;
  /**
   * 一起听会员共享：房间把「用对方会员解析出来的地址」从这里递进来。
   *
   * 用回调而不是把地址塞进播放器状态：地址的生命周期归房间管（它知道什么时候失效），
   * 播放器只在每次起播时问一句「这首有共享地址吗」。
   */
  let sharedSourceProvider: SharedSourceProvider | null = null;
  /** 共享地址播放失败时的回落地址（本机账号解析出来的那条）。 */
  let sharedFallback: string | null = null;

  /** 非空 = 这份队列是电台流，快见底时会自动续歌，且不循环回旧歌。 */
  const radio = ref<RadioState | null>(null);
  /** 上次发起续播的时刻；成功清零，失败留作冷却。 */
  let radioRetryAt = 0;
  /** 续播提示的节流：timeupdate 每 250ms 一拍，别把 toast 刷屏。 */
  let radioErrorAt = 0;
  /** 正在进行的续播；点「下一首」时若在途就复用它，别重复发也别直接停。 */
  let radioInFlight: Promise<number> | null = null;
  /** 已经播到队尾、正在等续播：补歌回来后要自动接着播，否则会停在最后一首。 */
  let radioTailStopped = false;

  const queue = ref<UnifiedTrack[]>([]);
  const index = ref(-1);
  const playing = ref(false);
  const loading = ref(false);
  const error = ref('');
  const currentTime = ref(0);
  const duration = ref(0);
  const volume = ref(typeof persisted.volume === 'number' ? persisted.volume : 0.8);
  const muted = ref(persisted.muted === true);
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
  /** 当前这一首的本地音频缓存状态：null = 没缓存，'partial' = 前缀，'full' = 完整。 */
  const audioCache = ref<'full' | 'partial' | null>(null);

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

  // 电台现场跟着队列一起回来：队列里的歌还在，快放完时就能接着自动续。
  if (persisted.radio?.platform && Array.isArray(persisted.queue) && persisted.queue.length > 0) {
    radio.value = {
      platform: persisted.radio.platform,
      session: persisted.radio.session ?? '',
      loading: false,
      // 旧版本可能往 localStorage 里存过 hasMore: false；电台是否激活只看它是否存在，
      // 刷新后一律按「还能续」恢复，别让历史数据把电台钉死。
      hasMore: true,
    };
  }

  function persist(): void {
    // 房间里播放器装的是房间队列：写下去等于把用户的个人现场覆盖掉。
    if (persistencePaused) return;
    const capped = capQueue(queue.value, index.value);
    const state: PersistedPlayerState = {
      volume: volume.value,
      muted: muted.value,
      quality: quality.value,
      repeat: repeat.value,
      shuffle: shuffle.value,
      preferredPlatform: preferredPlatform.value,
      proxyOnly: proxyOnly.value,
      routeMode: routeMode.value,
      queue: capped.queue,
      index: capped.index,
      position: currentTime.value,
      radio: radio.value
        ? {
            platform: radio.value.platform,
            session: radio.value.session,
            hasMore: radio.value.hasMore,
          }
        : undefined,
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

  /** 窗口卸载前把节流挂起的写入立刻做完，避免最后两秒进度丢失。 */
  function flushPersist(): void {
    if (persistTimer !== undefined) {
      window.clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    persist();
  }
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
  document.addEventListener('visibilitychange', () => {
    // 收进托盘 / 切走窗口时也会触发，顺手存一次。
    if (document.visibilityState === 'hidden') flushPersist();
  });

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
      artwork: track.album.cover
        ? [{ src: cachedImage(track.album.cover), sizes: '300x300' }]
        : [],
    });
    updatePositionState();
  }

  function ensureAudio(): HTMLAudioElement {
    if (audio) return audio;

    const element = new Audio();
    element.preload = 'metadata';
    element.volume = volume.value;
    element.muted = muted.value;

    element.addEventListener('timeupdate', () => {
      // 电台续播按「队列还剩几首」判断，与音频进度无关，解析新地址期间也照常检查。
      maybeRefill();
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
       *
       * 上报的必须是**本机刚播完的这一首**（`current` 此刻还没变）：房间可能已经
       * 先一步切到下一首了，若拿去和房间的当前曲目比对，就会把新切到的那首也报成
       * 「播完」，服务端随即多跳一首——借对方会员时地址要先请求，本机总是慢半拍，
       * 这个多跳几乎每首都会撞上。
       */
      if (roomEndedHook) {
        playing.value = false;
        const endedKey = current.value?.key ?? null;
        if (endedKey) {
          const hook = roomEndedHook;
          window.setTimeout(() => hook(endedKey), 0);
        }
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

  /**
   * 沉浸式歌词页要取频谱时调用：把 audio 接进 Web Audio 图并返回 AnalyserNode。
   *
   * 播放地址全是主进程登记过的同源 `/media/...`（含封面代理），所以
   * `createMediaElementSource` 不会踩跨域静音的坑。接线只发生一次
   * （同一元素重复 createMediaElementSource 会抛），之后复用同一个 analyser。
   * 返回 null 表示环境不支持，调用方用模拟节拍兜底。
   */
  function attachAnalyser(): AnalyserNode | null {
    const element = ensureAudio();
    if (analyser) {
      // 浏览器自动播放策略可能把 context 挂起：每次取用都顺手恢复一次。
      if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume();
      return analyser;
    }
    try {
      const context = new AudioContext();
      const source = context.createMediaElementSource(element);
      const node = context.createAnalyser();
      node.fftSize = 512;
      node.smoothingTimeConstant = 0.82;
      source.connect(node);
      node.connect(context.destination);
      audioCtx = context;
      analyser = node;
      if (context.state === 'suspended') void context.resume();
      return node;
    } catch {
      return null;
    }
  }

  /**
   * 逐帧级的播放位置。`currentTime` 只靠 timeupdate 刷新（约 4Hz），
   * 沉浸式歌词的行内扫光按它走会一格一格跳，这里直接读元素时钟。
   */
  function preciseTime(): number {
    return audio ? audio.currentTime : currentTime.value;
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

  /**
   * 已补全过的单曲详情，按 `platform:id` 缓存。
   *
   * 「一起听」的房间快照每次变化都会把队列整个重建一遍，补全会被反复问到；有了缓存
   * 才不会为同一首歌反复发请求。
   */
  const metadataCache = new Map<string, UnifiedTrack>();

  /**
   * 补全歌手 / 专辑的跳转坐标（`id` + `platform`），以及**音质档位清单与各档体积**。
   *
   * 房间里的曲目是服务端清洗过的摘要，只留下歌手名与专辑名；照它重建出来的曲目没有
   * 坐标，全屏播放页里的歌手与专辑就退化成不可点的纯文字，音质面板也拿不到 `qualitySizes`
   * （收藏、历史里按文本存的歌一样）。网易云的搜索/歌单结果还只带基础档，高级档与体积
   * 都要单曲详情才知道（`qualitiesComplete: false` 就是它的信号）。
   *
   * 这里在播放时按需拉一次单曲详情，只补不覆盖，失败也不影响播放。
   */
  async function enrichMetadata(track: UnifiedTrack): Promise<void> {
    const source = track.sources[0];
    if (!source) return;
    const needArtists = track.artists.some((item) => !item.id || !item.platform);
    const needAlbum = !track.album.id || !track.album.platform;
    const needQualities = track.qualitiesComplete !== true;
    if (!needArtists && !needAlbum && !needQualities) return;

    const cacheKey = `${source.platform}:${source.id}`;
    let detail = metadataCache.get(cacheKey);
    if (!detail) {
      try {
        detail = (await musicApi.track(source.platform, source.id)).track;
        if (metadataCache.size > 200) metadataCache.clear();
        metadataCache.set(cacheKey, detail);
      } catch {
        return; // 补全失败无关紧要，静默忽略
      }
    }

    /*
     * 期间可能切了歌、或房间快照重建了队列：先认当前下标（同一首歌在队列里可能出现
     * 多次，按 key 找会补到前面那条、界面上这条依然不可点），下标对不上再按 key 找。
     */
    const atPosition = queue.value[index.value];
    const target =
      atPosition?.key === track.key
        ? atPosition
        : queue.value.find((item) => item.key === track.key);
    if (!target) return;
    /*
     * 详情里的坐标按理自带 platform；偶尔上游只给 id 时，用取流用的那个平台兜底
     * （歌手/专辑 ID 本来就是该平台体系内的），否则仍是「有 id 却拼不出跳转」。
     */
    if (needArtists && detail.artists.some((item) => item.id)) {
      target.artists = detail.artists.map((item) => ({
        ...item,
        platform: item.platform ?? source.platform,
      }));
    }
    if (needAlbum && detail.album.id) {
      target.album = {
        ...target.album,
        id: detail.album.id,
        platform: detail.album.platform ?? source.platform,
      };
    }
    /*
     * 档位与体积同源：面板里「xxM · 规格」那行读的就是 qualitySizes。
     * 详情没给体积时留下列表里已有的那份，别把「知道」抹成「不知道」。
     */
    if (needQualities && detail.qualities) {
      target.qualities = detail.qualities;
      target.qualitySizes = detail.qualitySizes ?? target.qualitySizes;
      // 标成完整，免得后面每次队列重建都再补一遍。
      target.qualitiesComplete = true;
    }
  }

  /*
   * 房间/跟随会整队重建（成员或队列一变就来一帧），所以不能只在起播时补一次：
   * 盯着「当前曲目」，重建之后也自动补回来。补全改的是曲目对象的属性，`current`
   * 依赖的是队列下标与对象引用，改属性不会反过来触发这个 watch，不会形成循环。
   */
  watch(
    current,
    (track) => {
      if (track) void enrichMetadata(track);
    },
    { immediate: true },
  );

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
    audioCache.value = null; // 重置缓存态，等 BFF resolve 完再查
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

        // offline 里的文件都是完整下载的，直接标 full
        audioCache.value = 'full';
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

        // 查 BFF 侧的音频缓存状态（异步，不阻塞播放；token 避免竞态）
        probeAudioCache(source.platform, source.id, actualQuality.value, token);
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

      probeAudioCache(source.platform, source.id, actualQuality.value, token);
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

  /** 异步查本地音频缓存，结果写入 audioCache。token 用于防止上一首的回调覆盖当前首。 */
  function probeAudioCache(
    platform: string,
    trackId: string,
    quality: string,
    token: number,
  ): void {
    const key = `${platform}:${trackId}:${quality}`;
    // window.sakura 是 Electron preload 注入的，web 版没有；优雅降级跳过。
    const api = (window as { sakura?: { cache?: { audioCheck?: (k: string) => Promise<AudioCacheState> } } })
      .sakura;
    if (!api?.cache?.audioCheck) return;
    void api.cache.audioCheck(key).then((state) => {
      if (token === loadToken) audioCache.value = state;
    });
  }

  async function playTrack(track: UnifiedTrack, list?: UnifiedTrack[]): Promise<void> {
    // 单独点一首 / 换一张列表都是明确的新意图，电台流到此结束。
    stopRadio();
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
    // 用户明确换了队列，电台流到此为止；否则会一直往别人的歌单后面追加电台歌。
    stopRadio();
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

    // 电台是「一路往前」的流：随机跳回听过的歌、或列表循环绕回开头都不合语义。
    const endlessRadio = Boolean(radio.value);
    let moved = false;
    if (!endlessRadio && shuffle.value && queue.value.length > 1) {
      let at = index.value;
      while (at === index.value) at = Math.floor(Math.random() * queue.value.length);
      index.value = at;
      moved = true;
    } else if (index.value < queue.value.length - 1) {
      index.value += 1;
      moved = true;
    } else if (endlessRadio) {
      /*
       * 电台撞到队尾：通常是提前续播还没回来（网络慢、或用户连点下一首）。
       * 只要还在电台模式就再要一批 —— 不因之前某次失败/空批次而放弃。
       * refillRadio 会复用在途请求，所以这里能等到那批补歌的结果。
       */
      const added = await refillRadio(true);
      if (added > 0 && index.value < queue.value.length - 1) {
        index.value += 1;
        moved = true;
      } else {
        // 续播还在路上（或刚失败进入冷却）：记住这个位置，补歌回来自动接着播。
        radioTailStopped = true;
        pause();
        seek(0);
        return;
      }
    } else if (repeat.value === 'all' || !auto) {
      index.value = 0;
      moved = true;
    } else {
      pause();
      seek(0);
      return;
    }

    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    if (moved) await start();
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
    // 明确暂停 = 不想听：队尾等续播的那次自动接上也一并撤掉。
    radioTailStopped = false;
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

  /** 把「自然播完」交给房间（传 `null` 收回）；参数是本机刚播完那首的 key。 */
  function setRoomEndedHook(hook: ((endedKey: string) => void) | null): void {
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
    stopRadio();
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

  /* ------------------------------ 电台续播 ------------------------------ */

  /** 房间是否真的接管了本机播放（桌面端语义：roomEndedHook 存在 = 席位占着）。 */
  function roomControlsPlayback(): boolean {
    return Boolean(roomEndedHook);
  }

  function stopRadio(): void {
    radio.value = null;
    radioRetryAt = 0;
    radioTailStopped = false;
  }

  /** 向网关要一批：`reset` 表示新开一个电台，否则带上会话号与当前队列的 key 去重。 */
  async function fetchRadio(
    options: { reset?: boolean; exclude?: string[] } = {},
  ): Promise<UnifiedTrack[]> {
    const state = radio.value;
    if (!state || state.loading) return [];
    radio.value = { ...state, loading: true };
    try {
      const batch = await musicApi.radio(
        state.platform,
        options.reset ? undefined : state.session || undefined,
        6,
        options.exclude ?? [],
      );
      if (radio.value && radio.value.platform === state.platform) {
        radio.value = {
          platform: batch.platform,
          session: batch.session,
          loading: false,
          /*
           * 网关的 hasMore 只说明「这一批有没有拿到新歌」，不是电台流的开关：
           * 上游把听过的歌又推一遍很常见，采信它会让一次抖动永久停播。
           * 电台流只由 stopRadio()（用户换歌单）结束，空批次交给冷却重试。
           */
          hasMore: true,
        };
      }
      return batch.items;
    } catch (error) {
      radioRetryAt = Date.now();
      if (radio.value && radio.value.platform === state.platform) {
        radio.value = { ...state, loading: false };
      }
      // 续播失败不弹 toast（timeupdate 每 250ms 一拍会刷屏），留日志、冷却后自动重试；
      // 首次接入失败则要说清楚为什么没歌。
      if (options.reset) {
        toast.error(error instanceof Error ? error.message : '电台接入失败');
      } else {
        console.warn('[sakura] 电台续播失败，稍后重试', error);
        if (Date.now() - radioErrorAt > 60_000) {
          radioErrorAt = Date.now();
          const reason = error instanceof Error ? error.message : '未知错误';
          toast.error(`电台续播失败：${reason}；请确认网关已重启，或点「下一首」重试`);
        }
      }
      return [];
    }
  }

  /**
   * 开始听一个平台的电台。
   *
   * `initialTracks` 是首页卡片背后那一整批（网易云私人 FM 3 首、QQ 猜你喜欢 5 首）：
   * 发现页已经把它们取回来了，卡片只是把第一首画成封面。直接整批入队、按顺序放完，
   * **点开时一次电台请求都不打**；等最后一首开始播了，再由 maybeRefill 去要下一批。
   */
  async function startRadio(
    platform: Platform,
    initialTracks: UnifiedTrack[] = [],
  ): Promise<UnifiedTrack[]> {
    stopRadio();
    radio.value = { platform, session: '', loading: false, hasMore: true };

    let list = [...initialTracks];
    if (list.length === 0) {
      list = await fetchRadio({ reset: true });
      if (list.length === 0) {
        stopRadio();
        return [];
      }
    }
    // 刻意不经过 playQueue：那会清掉刚建立的电台状态（只有用户主动换歌单才该清）。
    queue.value = [...list];
    index.value = 0;
    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
    toast.success('私人电台已开始，快听完时会自动续歌');
    return list;
  }

  async function doRefill(force: boolean): Promise<number> {
    const state = radio.value;
    if (!state || roomControlsPlayback()) return 0;
    if (!force && Date.now() - radioRetryAt < RADIO_RETRY_MS) return 0;
    const items = await fetchRadio({ exclude: queue.value.map((item) => item.key) });
    if (!radio.value || radio.value.platform !== state.platform) return 0;

    const existing = new Set(queue.value.map((item) => item.key));
    const fresh = items.filter((item) => !existing.has(item.key));
    if (fresh.length > 0) {
      queue.value = [...queue.value, ...fresh];
      radioRetryAt = Date.now();
      // 之前已经播到队尾停下了：补歌到了就自动接上，不等用户再点一下。
      if (radioTailStopped) {
        radioTailStopped = false;
        pendingSeek = 0;
        currentTime.value = 0;
        duration.value = fresh[0]?.durationMs ? fresh[0].durationMs / 1000 : 0;
        await start();
      }
    } else {
      radioRetryAt = Date.now();
      console.warn('[sakura] 电台续播：这次没拿到新歌，稍后重试');
      if (Date.now() - radioErrorAt > 60_000) {
        radioErrorAt = Date.now();
        toast.error('电台这批没有新歌，稍后会自动重试；也可以点「下一首」立即再试');
      }
      // 停在队尾时 playing=false，音频事件和队列 watch 都不会再触发，
      // 光靠「稍后自动重试」根本等不来。这里显式排一次延时重试。
      if (index.value >= queue.value.length - 1) {
        setTimeout(() => {
          if (radio.value) void refillRadio(true);
        }, RADIO_RETRY_MS);
      }
    }
    return fresh.length;
  }

  /** 追加一批新歌；返回实际加进去的条数。在途时复用同一个请求，不重复打上游。 */
  async function refillRadio(force = false): Promise<number> {
    if (radioInFlight) return radioInFlight;
    const pending = doRefill(force);
    radioInFlight = pending;
    try {
      return await pending;
    } finally {
      if (radioInFlight === pending) radioInFlight = null;
    }
  }

  /** 最后一首开始播了才补下一批。 */
  function maybeRefill(): void {
    const state = radio.value;
    if (!state || state.loading || roomControlsPlayback()) return;
    if (Date.now() - radioRetryAt < RADIO_RETRY_MS) return;
    if (index.value < 0 || queue.value.length === 0) return;
    if (queue.value.length - 1 - index.value > RADIO_REFILL_AHEAD) return;
    radioRetryAt = Date.now();
    console.info(`[sakura] 电台续播触发：${state.platform}，队列剩 ${queue.value.length - 1 - index.value} 首`);
    void refillRadio(true);
  }

  watch(playing, (value) => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = value ? 'playing' : 'paused';
    }
  });

  watch(
    () => [queue.value, index.value, radio.value] as const,
    () => persist(),
  );

  /** 正在听的电台平台被关掉时自动停掉，不续了。 */
  watch(
    () => usePreferencesStore().enabled,
    (enabled) => {
      const current = radio.value;
      if (current && enabled[current.platform] === false) {
        stopRadio();
      }
    },
    { deep: true },
  );

  /*
   * 队列/下标变化也检查一次续播：暂停在最后一首、跳歌、或 timeupdate 还没来时，
   * 光靠音频事件会漏掉触发。maybeRefill 自带冷却与在途去重，重复调用没有副作用。
   */
  watch([() => queue.value.length, () => index.value], () => maybeRefill());

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
    audioCache,
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
    /** 沉浸式歌词页取 AnalyserNode（失败返回 null）。 */
    attachAnalyser,
    /** 逐帧级播放位置（歌词扫光用）。 */
    preciseTime,
    cycleMode,
    setQuality,
    setPreferredPlatform,
    setRouteMode,
    enqueue,
    playNext,
    removeFromQueue,
    removeFromQueueAt,
    clearQueue,
    /** 当前电台（null = 普通队列）；队列面板可据此显示「自动续播中」。 */
    radio,
    startRadio,
    stopRadio,
    refillRadio,
  };
});
