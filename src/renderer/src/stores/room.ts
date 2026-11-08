import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ApiError } from '@/api/client';
import {
  roomApi,
  type EntitlementPlatform,
  type RoomAction,
  type RoomActionPayload,
  type RoomEntitlement,
  type RoomEntitlementPending,
  type RoomMember,
  type RoomPlayback,
  type RoomSource,
  type RoomTrack,
  type RoomView,
} from '@/api/rooms';
import type { Quality, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { onRoomEvent, setTakeSeatHandler, useDevicesStore } from './devices';
import { useAuthStore } from './auth';
import { usePlayerStore, type PlayMode } from './player';

/**
 * 一起听（双人房）。
 *
 * 服务端是**权威**：队列、播放态、进度都在网关里，本机提交操作、再把房间状态镜像到
 * 播放器（协议见 `sakura-music/docs/together-protocol.md`）。
 *
 * 与「多设备遥控」的区别在于**谁说了算**：遥控是点对点指令，一起听是共享现场，
 * 播放器不再跟着本机操作走，而是跟着房间走。
 *
 * 只做 `duo`：多人房（`group`）在网关侧虽已定义，桌面端暂无管理区。
 */

/** 镜像节拍：太快没必要（人耳分辨不出），太慢进度会飘。 */
const SYNC_TICK_MS = 250;
/** 进度差超过这个值就直接 seek（再小就让它自己跑）。 */
const SYNC_SEEK_S = 1.5;
/** 曲尾守卫：离结尾这么近就不再纠偏，等服务端那一帧。 */
const END_GUARD_S = 0.6;
const STORAGE_KEY = 'sakura.room';
/** 请另一台设备接席位后，等它真的接上的最长时间。 */
const SEAT_HANDOFF_MS = 6_000;

/** 会员共享支持的两个平台。 */
const ENTITLEMENT_PLATFORMS: readonly EntitlementPlatform[] = ['netease', 'qq'];

/** 「各用各的」：服务端没有授权信息时的兜底。 */
function emptyEntitlement(): RoomEntitlement {
  return {
    active: { netease: null, qq: null },
    pending: { netease: null, qq: null },
  };
}

interface PersonalSnapshot {
  queue: UnifiedTrack[];
  index: number;
  position: number;
  playing: boolean;
  mode: PlayMode;
}

function readStoredRoom(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredRoom(code: string | null): void {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存储不可用不影响本次会话。
  }
}

/** 服务端清洗过的曲目摘要 → 本地可播放的完整曲目。 */
function toUnified(track: RoomTrack): UnifiedTrack {
  return {
    key: track.key,
    title: track.title,
    artists: [{ name: track.artists }],
    album: { name: track.album, cover: track.cover ?? undefined },
    durationMs: track.durationMs,
    sources: track.sources.map((source) => ({
      platform: source.platform,
      id: source.id,
      mid: source.mid,
      numericId: source.numericId,
    })),
    vip: track.vip,
  };
}

export const useRoomStore = defineStore('room', () => {
  const devices = useDevicesStore();
  const player = usePlayerStore();
  const auth = useAuthStore();
  const toast = useToast();

  const code = ref<string | null>(null);
  const kind = ref<'duo'>('duo');
  const capacity = ref(2);
  const members = ref<RoomMember[]>([]);
  const queue = ref<RoomTrack[]>([]);
  const index = ref(0);
  const playback = ref<RoomPlayback | null>(null);

  /** 两人历史累计一起听时长（秒），来自房间快照。 */
  const togetherSeconds = ref(0);
  const togetherSessionSeconds = ref(0);
  const togetherCounting = ref(false);
  /** 快照对应的服务端时刻，用来把「正在走的那一段」推演到此刻。 */
  let togetherSyncedAt = 0;

  /** 本机只是旁观：账号在房间里，但播放挂在另一台设备上。 */
  const spectating = ref(false);

  let tickTimer: number | undefined;
  let syncing = false;
  /**
   * 最近一首在本机放不出来的曲目。
   *
   * 镜像每 250ms 会检查一次「该不该换歌」，失败不记下来就会对同一首反复解析、反复弹错。
   * 房间切歌时清空，给它下一次机会。
   */
  let failedKey: string | null = null;
  /**
   * 已经因为「借到会员」重装过的曲目。
   *
   * 每首只试一次：提供方本来就没有这个档位的权限时，重装只会换回另一条试听地址，
   * 白白重新缓冲一次。退房时随房间一起清空。
   */
  const sharedReloaded = new Set<string>();
  /**
   * 拿到手的共享地址，键为 `${platform}:${trackKey}`。
   *
   * 只放内存、不持久化：地址有寿命（实测网易云 25 分钟），存下来的多半已经失效。
   * 上限 20 条——够覆盖一次房间里的来回切歌，又不会无限长。
   */
  const sharedSources = new Map<string, RoomSource>();
  /** 已经就「拿不到共享地址」提示过：同一段时间内不要每次切歌都弹一遍。 */
  let sharedMissingNotified = false;
  /** 入房前的个人现场，退出时恢复。 */
  let personal: PersonalSnapshot | null = null;
  let joining = false;
  let reconciling = false;
  let initialized = false;

  const active = computed(() => code.value !== null);
  /**
   * 本机就是席位设备：房间的播放在这台机器上。
   * 它也是私人电台互斥的判据——旁观设备的播放器归自己用，电台照常可用。
   */
  const seatActive = computed(() => active.value && !spectating.value);
  const me = computed(() => members.value.find((item) => item.deviceId === devices.selfId) ?? null);
  /**
   * 本**账号**在房间里的那条成员。
   *
   * 与 [me] 的区别正是「旁观」：同一账号的第二台设备收到快照时自己那条也是 `me: false`，
   * 只有账号级标记认得出它。
   */
  const accountMember = computed(
    () => members.value.find((item) => item.mine) ?? members.value.find((item) => item.me) ?? null,
  );
  /**
   * 另一位成员（**按账号**取）。
   *
   * 不能用 `!me`：本机旁观时，自己账号的那条也是 `me: false`，照它取会把「我自己」当成对方。
   */
  const partner = computed(() => {
    const selfUserId = accountMember.value?.userId ?? null;
    return members.value.find((item) => item.userId !== selfUserId) ?? null;
  });
  const currentTrack = computed<RoomTrack | null>(() => playback.value?.track ?? null);
  const playing = computed(() => playback.value?.playing === true);

  // ---- 会员共享（按平台分开） ----

  /** 会员共享状态。老服务端没有这个字段时按「各用各的」兜底。 */
  const entitlement = ref<RoomEntitlement>(emptyEntitlement());

  /** 我的账号 id：旁观设备上也要能判断「这条权益是不是我的」。 */
  const myUserId = computed(() => accountMember.value?.userId ?? auth.user?.id ?? null);

  /**
   * 我正在为房间提供哪些平台的权益。
   *
   * 只在**我占着席位**时才有意义：真正要用我的凭据解析地址的是这台设备。
   */
  const mySharedPlatforms = computed<EntitlementPlatform[]>(() => {
    const userId = myUserId.value;
    if (!userId) return [];
    return ENTITLEMENT_PLATFORMS.filter(
      (platform) => entitlement.value.active[platform] === userId,
    );
  });

  /** 需要**我**点头的共享请求（对方要用我的会员）。双人房里最多一条。 */
  const entitlementRequestsForMe = computed<RoomEntitlementPending[]>(() => {
    const userId = myUserId.value;
    if (!userId) return [];
    return ENTITLEMENT_PLATFORMS.map((platform) => entitlement.value.pending[platform]).filter(
      (item): item is RoomEntitlementPending => Boolean(item && item.targetUserId === userId),
    );
  });

  /** 某平台当前用谁的权益；`null` = 各用各的。 */
  function entitlementOwner(platform: EntitlementPlatform): string | null {
    return entitlement.value.active[platform] ?? null;
  }

  /** 房间进度推算到此刻（已校正本机与服务端的时钟差）。 */
  function livePosition(state: RoomPlayback | null = playback.value): number {
    if (!state) return 0;
    if (!state.playing) return state.position;
    const elapsed = (Date.now() + devices.serverOffset - state.positionAt) / 1000;
    const next = state.position + Math.max(0, elapsed);
    return state.duration > 0 ? Math.min(state.duration, next) : next;
  }

  function togetherRunning(): number {
    if (!togetherCounting.value) return 0;
    return Math.max(0, (Date.now() + devices.serverOffset - togetherSyncedAt) / 1000);
  }

  const togetherLive = (): number => togetherSeconds.value + togetherRunning();
  const togetherSessionLive = (): number => togetherSessionSeconds.value + togetherRunning();

  // ---- 个人现场 ----

  function capturePersonal(): void {
    personal = {
      queue: [...player.queue],
      index: player.index,
      position: player.currentTime,
      playing: player.playing,
      mode: player.mode,
    };
    /*
     * 入房前就暂停落盘：服务端会在响应到达之前把房间快照推过来，那一刻播放器已被房间
     * 队列接管；落盘若还开着，用户的个人现场就被房间队列覆盖了。
     */
    player.setPersistencePaused(true);
  }

  function restorePersonal(): void {
    const saved = personal;
    personal = null;
    // 先恢复落盘，再摆现场：恢复后的队列会被正确写回，而不是房间队列。
    player.setPersistencePaused(false);
    if (!saved) return;

    player.setMode(saved.mode);
    if (saved.queue.length === 0) {
      player.clearQueue();
      return;
    }
    void (async () => {
      try {
        await player.playQueue(saved.queue, Math.max(0, Math.min(saved.index, saved.queue.length - 1)));
        player.seek(saved.position);
        if (!saved.playing) player.pause();
      } catch {
        // 恢复失败就停在那里，用户自己点播放。
      }
    })();
  }

  // ---- 房间生命周期 ----

  function startTick(): void {
    if (tickTimer !== undefined) return;
    tickTimer = window.setInterval(() => void syncToRoom(), SYNC_TICK_MS);
  }

  function stopTick(): void {
    if (tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
  }

  /**
   * 进入房间（`seat` = 本机是不是占着席位）。
   *
   * 旁观不接管播放器：一个字节都不碰，只把房间显示出来。
   */
  function enterRoom(roomCode: string, seat = true): void {
    code.value = roomCode;
    spectating.value = !seat;
    writeStoredRoom(roomCode);
    if (!seat) {
      stopTick();
      player.setRoomEndedHook(null);
      player.setPersistencePaused(false);
      return;
    }
    player.setPersistencePaused(true);
    player.setRoomEndedHook((endedKey) => {
      /*
       * 只报「刚播完的这首正好是房间当前曲目」的情况。
       *
       * 本机切歌比房间广播慢一点（借对方会员时还要先请求地址），两边在曲尾附近会
       * 重叠：房间已经切到下一首，本机旧歌这才播完。此时若拿房间的当前 key 去上报，
       * 服务端会把刚切到的这首也当「播完」再跳一次——听感就是 VIP 歌莫名其妙被跳过。
       */
      if (playback.value?.track?.key !== endedKey) return;
      void act('ended', { trackKey: endedKey });
    });
    startTick();
  }

  /** 本地收尾：清空房间状态，恢复个人现场。服务端侧的退出由调用方负责。 */
  function finalizeLeave(restore = true): void {
    stopTick();
    player.setRoomEndedHook(null);
    writeStoredRoom(null);
    code.value = null;
    spectating.value = false;
    kind.value = 'duo';
    capacity.value = 2;
    members.value = [];
    queue.value = [];
    index.value = 0;
    playback.value = null;
    togetherSeconds.value = 0;
    togetherSessionSeconds.value = 0;
    togetherCounting.value = false;
    togetherSyncedAt = 0;
    // 共享地址与「已提示过」标记都跟着房间走：下一个房间不该复用上一个的直链。
    sharedSources.clear();
    sharedReloaded.clear();
    sharedMissingNotified = false;
    entitlement.value = emptyEntitlement();
    if (restore) restorePersonal();
    else {
      personal = null;
      player.setPersistencePaused(false);
    }
  }

  /** 席位被同账号的另一台设备接走：降级为旁观，房间继续显示。 */
  function degradeToSpectating(): void {
    stopTick();
    player.setRoomEndedHook(null);
    spectating.value = true;
    player.setPersistencePaused(false);
    restorePersonal();
  }

  // ---- 快照应用 ----

  /**
   * 房间队列铺到播放器上。
   *
   * **刻意不直接对齐 `player.index`**：镜像循环判断「是不是换了歌」靠的就是
   * `player.current.key !== 房间曲目.key`。这里若先把下标指过去，`player.current`
   * 立刻变成房间曲目，镜像会误判成「同一首」而只做一次 `play()`——音频停在旧歌上。
   */
  function applyQueueToPlayer(view: RoomView): void {
    const loadedKey = player.current?.key ?? null;
    const roomTrackKey = view.queue[view.index]?.key ?? null;
    player.queue = view.queue.map(toUnified);
    player.index = loadedKey && loadedKey === roomTrackKey ? view.index : -1;
  }

  function applyRoom(
    payload:
      | {
          room?: RoomView | null;
          serverNow?: number;
          reason?: 'seat_taken' | 'kicked';
          deviceName?: string;
        }
      | null,
  ): void {
    const view = payload?.room ?? null;
    if (!view) {
      if (!code.value) return;

      if (payload?.reason === 'seat_taken') {
        toast.info(
          payload.deviceName
            ? `一起听已转移到「${payload.deviceName}」，本机改为旁观`
            : '一起听已转移到你的另一台设备，本机改为旁观',
        );
        degradeToSpectating();
        return;
      }

      toast.info('对方结束了一起听');
      finalizeLeave();
      return;
    }

    if (!joining && code.value !== null && code.value !== view.code) return;

    const deviceId = devices.selfId;
    const mySeat = view.members.find((member) => member.deviceId === deviceId) ?? null;
    const accountSeat = view.members.find((member) => member.mine) ?? null;
    // 席位不在本机、账号也不在房间里（被移出 / 宽限期已过）：当作已经离开。
    if (!mySeat && !accountSeat) {
      if (code.value === view.code) finalizeLeave();
      return;
    }

    /*
     * 私人电台与一起听互斥：服务端把本机拉去**占席位**时，电台自动结束。
     *
     * 只看 mySeat：同一账号的另一台设备刚入房时，本机这一帧是旁观，
     * 播放器仍归自己用（下面也会在 !mySeat 处直接返回），电台不该被停。
     * 这条路径不经过 create/join/transfer —— 第一帧快照直接推到这里，UI 层拦不住；
     * 只在「刚进房间」时处理，后续每次快照都触发会反复弹提示。
     */
    if (mySeat && !code.value && radioActive()) {
      player.stopRadio();
      toast.info('本机已进入「一起听」，私人电台已停止', 6000);
    }

    code.value = view.code;
    writeStoredRoom(view.code);
    kind.value = 'duo';
    capacity.value = view.capacity;
    members.value = view.members;
    queue.value = view.queue;
    index.value = view.index;
    togetherSeconds.value = Math.max(0, Math.floor(view.togetherSeconds));
    togetherSessionSeconds.value = Math.max(0, Math.floor(view.togetherSessionSeconds));
    togetherCounting.value = view.togetherCounting === true;
    /*
     * 会员共享状态。老服务端没有这个字段：缺省成「各用各的」，让客户端在网关没升级时
     * 也能正常显示面板（而不是崩在一个 undefined 上）。
     */
    entitlement.value = {
      active: view.entitlement?.active ?? { netease: null, qq: null },
      pending: view.entitlement?.pending ?? { netease: null, qq: null },
    };
    // 快照里的授权可能已经变了（提供方退出房间就是这么传过来的）：作废对应缓存。
    pruneSharedSources();
    togetherSyncedAt = typeof payload?.serverNow === 'number' ? payload.serverNow : Date.now();
    spectating.value = mySeat === null;

    // 旁观：状态记下就够了，播放器不归房间管。
    if (!mySeat) return;
    applyQueueToPlayer(view);
  }

  function applyPlayback(payload: (RoomPlayback & { serverNow?: number }) | null): void {
    if (!payload) return;
    if (!joining && code.value === null) return;

    // 房间换歌了就清掉「这首放不出来」的记忆：下一首重新给一次机会。
    if (payload.track?.key !== playback.value?.track?.key) failedKey = null;

    playback.value = {
      index: payload.index,
      playing: payload.playing,
      position: payload.position,
      positionAt: payload.positionAt,
      duration: payload.duration,
      track: payload.track,
      mode: payload.mode,
      skipReason: payload.skipReason,
      skippedTitle: payload.skippedTitle,
    };

    // 模式跟着房间走：房间改了两端一起改。
    if (payload.mode) player.setMode(payload.mode);

    if (payload.skipReason === 'unplayable' && payload.skippedTitle) {
      toast.info(`「${payload.skippedTitle}」播不了，已自动跳过`);
    }
  }

  // ---- 会员共享：向服务端要一条「别人的会员」地址 ----

  /** 当前曲目属于哪个平台（取流坐标里第一个认识的）。 */
  function platformOf(track: RoomTrack): EntitlementPlatform | null {
    for (const source of track.sources) {
      if (source.platform === 'netease' || source.platform === 'qq') return source.platform;
    }
    return null;
  }

  /** 这一平台当前是不是在借**别人**的权益；是的话返回对方的 userId。 */
  function borrowsFrom(platform: EntitlementPlatform): string | null {
    const ownerId = entitlement.value.active[platform] ?? null;
    if (!ownerId) return null;
    return ownerId === myUserId.value ? null : ownerId;
  }

  /** 授权变化后清掉不再有效的共享地址：撤销共享后那条直链不该再被捡起来用。 */
  function pruneSharedSources(): void {
    for (const [key, item] of sharedSources) {
      if (entitlement.value.active[item.platform] !== item.ownerUserId) sharedSources.delete(key);
    }
  }

  /**
   * 换歌前拿一条「对方会员」的播放地址。
   *
   * 解析在**服务端**完成：它用权益提供方存在服务器上的凭据换出 CDN 直链，本机只拿到地址。
   * 对方用「仅本机」凭据时服务端拿不到，会明确报错——那种情况下共享不可用，只能各用各的。
   * 拿不到就返回 `null`，由播放器走自己的正常解析：宁可降级，也不能因此把整首跳过。
   */
  async function fetchSharedSource(track: RoomTrack): Promise<RoomSource | null> {
    const platform = platformOf(track);
    if (!platform || !borrowsFrom(platform)) return null;

    const key = `${platform}:${track.key}`;
    const cached = sharedSources.get(key);
    if (cached) return cached;

    try {
      const data = await roomApi.fetchSource({
        deviceId: devices.selfId,
        platform,
        trackKey: track.key,
        quality: player.quality,
      });
      sharedSources.set(key, data);
      if (sharedSources.size > 20) {
        const oldest = sharedSources.keys().next().value;
        if (oldest) sharedSources.delete(oldest);
      }
      sharedMissingNotified = false;
      return data;
    } catch (error) {
      /*
       * 最常见的是对方用了「仅本机」凭据，其次是授权刚被撤销。
       * 说一次就够——否则用户看到的现象和「共享根本没生效」完全一样，无从判断。
       */
      if (!sharedMissingNotified) {
        sharedMissingNotified = true;
        const fallback = `${partner.value?.nickname ?? '对方'} 的会员暂时不可用，先用自己的账号播放`;
        toast.info(error instanceof Error && error.message ? error.message : fallback, 6000);
      }
      return null;
    }
  }

  // ---- 把播放器镜像到房间 ----

  async function syncToRoom(): Promise<void> {
    if (!active.value || spectating.value || syncing) return;
    const state = playback.value;
    if (!state) return;

    const track = state.track;
    if (!track) {
      if (player.playing) player.pause();
      return;
    }

    // 换了歌（或本机还没上这首）：按房间状态重建，并从房间进度接着放。
    if (player.current?.key !== track.key) {
      if (track.sources.length === 0) return;
      // 这首已经确认放不出来：不再反复解析，等房间切歌。
      if (failedKey === track.key) return;
      syncing = true;
      try {
        /*
         * 借别人会员时先向服务端要地址（播放器的共享来源回调只读缓存）。
         * 要不到就用自己解析，不能因此把整首跳过。
         */
        await fetchSharedSource(track);
        if (!seatActive.value || playback.value?.track?.key !== track.key) return;
        const list = queue.value.map(toUnified);
        await player.playTrack(toUnified(track), list.length > 0 ? list : [toUnified(track)]);
        // 换歌途中房间结束了、或本机被降级为旁观：这段迟到的收尾不能再动播放器。
        if (!seatActive.value) return;
        const at = livePosition(state);
        if (at > 0.5) player.seek(at);
        if (!state.playing) player.pause();
      } catch {
        failedKey = track.key;
      } finally {
        syncing = false;
      }
      return;
    }

    /*
     * 同一首却只拿到试听片段，而房间已经开了会员共享：重新装一次。
     *
     * 授权常常是在歌已经开始放之后才到账的（对方刚点确认、快照刚同步到这里），
     * 那一次解析只能拿到自己账号的试听；重开播放器后共享地址缓存也是空的，
     * 若不重装就会把 30 秒片段一直放到底，听感就是 VIP 歌被跳过。
     * 每首只试一次（见 sharedReloaded），避免提供方本就没权限时反复重装。
     */
    if (player.trial && track.sources.length > 0) {
      const platform = platformOf(track);
      if (platform && borrowsFrom(platform) && !sharedReloaded.has(track.key)) {
        sharedReloaded.add(track.key);
        syncing = true;
        try {
          const source = await fetchSharedSource(track);
          // 只有拿到完整音源才重装：拿到的还是试听（对方自己也没权限）时重装也不会更好。
          if (source && source.trial !== true && seatActive.value) {
            const list = queue.value.map(toUnified);
            await player.playTrack(toUnified(track), list.length > 0 ? list : [toUnified(track)]);
            const at = livePosition(state);
            if (at > 0.5) player.seek(at);
            if (!state.playing) player.pause();
          }
        } finally {
          syncing = false;
        }
        return;
      }
    }

    const expected = livePosition(state);

    /*
     * 曲尾守卫：房间说在播、推算也到了尾部，本机同样停在尾部——这首其实已经放完，
     * `ended` 已上报，正等服务端把「往哪走」推回来。此时若照房间的「在播」去 play()，
     * 音频会从 0 重来，下一拍又因为偏差被 seek 回尾部，进度条就在两端来回抽。
     */
    const atTail = state.duration > 0 && expected >= state.duration - END_GUARD_S;
    const localDuration = player.duration > 0 ? player.duration : state.duration;
    const localTail = localDuration > 0 && player.currentTime >= localDuration - END_GUARD_S;
    if (atTail && localTail) return;

    if (state.playing && !player.playing) player.play();
    else if (!state.playing && player.playing) player.pause();

    if (Math.abs(player.currentTime - expected) > SYNC_SEEK_S) player.seek(expected);
  }

  // ---- 操作 ----

  /**
   * 提交一个房间操作。
   *
   * 刻意**不做本地抢先执行**：服务端权威，等它回声再统一应用，避免两端各走各的。
   */
  async function act(action: RoomAction, payload?: RoomActionPayload, quiet = false): Promise<void> {
    if (!code.value || spectating.value) return;
    const deviceId = devices.selfId;
    if (!deviceId) return;
    try {
      await roomApi.act({ deviceId, action, payload });
    } catch (error) {
      // 房间已经不在服务端了（网关重启 / 解散 / 席位过期）：本地收尾，别让镜像继续拽播放器。
      if (error instanceof ApiError && error.status === 404) {
        toast.info('一起听已结束');
        finalizeLeave();
        return;
      }
      if (!quiet) toast.error(error instanceof Error ? error.message : '操作失败');
    }
  }

  function toggle(): void {
    void act(playing.value ? 'pause' : 'play');
  }

  function next(): void {
    void act('next');
  }

  function prev(): void {
    void act('prev');
  }

  function seek(seconds: number): void {
    void act('seek', { position: Math.max(0, seconds) });
  }

  /** 队列面板点某一首：房间里由服务端决定「放哪首」，两端一起跳。 */
  function playAt(at: number): void {
    void act('playAt', { index: at });
  }

  /** 队列面板移除某一首（房间共享队列，会同步给对方）。 */
  function removeAt(at: number): void {
    void act('remove', { index: at });
  }

  /** 切换模式：房间里必须走房间（两端一起变），不能只改本机。 */
  function cycleMode(): void {
    const order: PlayMode[] = ['order', 'all', 'one', 'shuffle'];
    const at = order.indexOf(playback.value?.mode ?? 'order');
    void act('setMode', { mode: order[(at + 1) % order.length] ?? 'order' });
  }

  /**
   * 改某平台的会员共享归属。
   *
   * - `targetUserId = null`：回到「各用各的」（撤销不需要对方同意）
   * - 传自己：直接分享
   * - 传对方：只是**发起请求**，要等对方 `ackEntitlement` 之后才生效
   *
   * 不做本地乐观更新：生效一律以服务端回推的 `room-entitlement` 为准，
   * 否则「等待对方确认」会被界面先显示成已生效。
   */
  function setEntitlement(platform: EntitlementPlatform, targetUserId: string | null): void {
    void act('setEntitlement', { platform, targetUserId });
  }

  /** 权益提供方确认（`accept: true`）或拒绝一次共享请求。 */
  function ackEntitlement(platform: EntitlementPlatform, accept: boolean): void {
    void act('ackEntitlement', { platform, accept });
  }

  // ---- 建房 / 入房 / 退出 ----

  function requireDevice(): string | null {
    const deviceId = devices.selfId;
    if (!deviceId) {
      toast.error('设备服务还没连上，请稍后再试');
      return null;
    }
    return deviceId;
  }

  /* -------------------- 与私人电台互斥 -------------------- */

  /** 本机是否正在听私人电台。 */
  function radioActive(): boolean {
    return Boolean(player.radio);
  }

  /**
   * 拦下「让本机占席位」的动作（create / join / transfer），并说明原因。
   * 旁观设备只是看房间状态，不受这条约束。
   */
  function radioBlocksRoom(): boolean {
    if (!radioActive()) return false;
    toast.error('正在播放私人电台，请先退出电台再在本机使用「一起听」');
    return true;
  }

  /** 创建房间：带上本机当前队列与模式，一起听从「你现在的歌单」开始。 */
  async function create(): Promise<void> {
    if (radioBlocksRoom()) return;
    if (joining || active.value) return;
    const deviceId = requireDevice();
    if (!deviceId) return;

    joining = true;
    capturePersonal();
    try {
      const result = await roomApi.create({
        deviceId,
        deviceKind: window.sakura.platform === 'win32' ? 'windows' : 'web',
        kind: 'duo',
        queue: player.queue,
        index: Math.max(0, player.index),
        mode: player.mode,
      });
      enterRoom(result.code);
      toast.success(`一起听已创建，房间码 ${result.code}`);
    } catch (error) {
      restorePersonal();
      toast.error(error instanceof Error ? error.message : '创建一起听失败');
    } finally {
      joining = false;
    }
  }

  async function join(codeRaw: string): Promise<void> {
    if (radioBlocksRoom()) return;
    const normalized = codeRaw.trim().toUpperCase();
    if (!normalized || joining || active.value) return;
    const deviceId = requireDevice();
    if (!deviceId) return;

    joining = true;
    capturePersonal();
    try {
      await roomApi.join({
        code: normalized,
        deviceId,
        deviceKind: window.sakura.platform === 'win32' ? 'windows' : 'web',
      });
      enterRoom(normalized);
      toast.success('已加入一起听');
    } catch (error) {
      restorePersonal();
      toast.error(error instanceof Error ? error.message : '加入一起听失败');
    } finally {
      joining = false;
    }
  }

  /** 退出房间（自己离开；房间还有人就继续）。 */
  async function leave(): Promise<void> {
    const roomCode = code.value;
    const wasSeat = !spectating.value;
    finalizeLeave(wasSeat);
    if (!roomCode) return;
    try {
      await roomApi.leave(devices.selfId);
    } catch {
      // 退出失败也不影响本地收尾；服务端那份会随断线宽限到期清掉。
    }
  }

  /**
   * 把播放转移到本机（同一账号的另一台设备正在放时，界面上那一下）。
   *
   * 就是 `join`：服务端「一个账号只占一个席位」，join 的语义本来就是接席位。
   */
  async function transfer(): Promise<void> {
    if (radioBlocksRoom()) return;
    const roomCode = code.value;
    const deviceId = devices.selfId;
    if (!roomCode || !deviceId || joining) return;

    joining = true;
    /*
     * 旁观期间本机还放着自己的东西，没有个人现场快照；接席位前补一份，
     * 否则之后退出房间时没有可恢复的现场。
     */
    const captured = personal === null;
    if (captured) capturePersonal();
    try {
      await roomApi.join({
        code: roomCode,
        deviceId,
        deviceKind: window.sakura.platform === 'win32' ? 'windows' : 'web',
      });
      enterRoom(roomCode);
      toast.success('声音已切到这台设备');
    } catch (error) {
      if (captured) {
        personal = null;
        player.setPersistencePaused(false);
      }
      toast.error(error instanceof Error ? error.message : '接回一起听失败');
    } finally {
      joining = false;
    }
  }

  /**
   * 请另一台设备接走一起听的席位，并等它**真的接上**。
   *
   * 指令只保证「送到」；真正接席位是那台设备自己去 `join`。所以这里盯的是房间状态：
   * 我账号的席位换到它身上才算成功。设备离线、连接半死都会在超时后落到 false。
   */
  async function handSeatTo(target: string): Promise<boolean> {
    if (!(await devices.send(target, 'takeSeat'))) return false;
    const deadline = Date.now() + SEAT_HANDOFF_MS;
    while (Date.now() < deadline) {
      if (accountMember.value?.deviceId === target) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return false;
  }

  /** 结束房间：双人房人人可结束，一个人走房间就散了。 */
  async function dissolve(): Promise<void> {
    if (spectating.value) return;
    const roomCode = code.value;
    finalizeLeave();
    if (!roomCode) return;
    try {
      await roomApi.dissolve(devices.selfId);
    } catch {
      // 同上。
    }
    toast.info('已结束一起听');
  }

  /**
   * 重连 / 重启后对账：本地记着房间码时，先看席位在不在本机。
   *
   * 直接 `join` 会把播放从另一台设备抢过来，所以必须先 `preview`。
   */
  async function reconcile(): Promise<void> {
    // 首连的 `hello` 与 selfId 的 watcher 会同时触发一次：重入会让个人现场被暂存两遍。
    if (reconciling || joining || active.value) return;
    /*
     * 电台播放中不让本机自动占席位：join 会用房间队列顶掉电台，而自动对账
     * 每次连上都会跑，静默跳过即可（用户没主动点一起听，不该弹提示）。
     * 旁观身份照常恢复——同账号另一台设备在放，与本机这台听什么无关。
     * 房间码仍留在 localStorage，退出电台后下次刷新照样能回去。
     */
    const radioOn = radioActive();
    const stored = readStoredRoom();
    const deviceId = devices.selfId;
    if (!stored || !deviceId) return;

    reconciling = true;
    try {
      const preview = await roomApi.preview(stored);
      if (preview.mine && preview.mine !== deviceId) {
        // 席位在我另一台设备上：一起听跟着那台走了，本机只当旁观（电台照常听）。
        enterRoom(stored, false);
        return;
      }
      if (radioOn) return;
      joining = true;
      capturePersonal();
      try {
        await roomApi.join({
          code: stored,
          deviceId,
          deviceKind: window.sakura.platform === 'win32' ? 'windows' : 'web',
        });
        enterRoom(stored);
      } finally {
        joining = false;
      }
    } catch (error) {
      // 房间确实没了：清掉本地记录，下次不再问。
      if (error instanceof ApiError && error.status === 404) writeStoredRoom(null);
    } finally {
      reconciling = false;
    }
  }

  /** 只注册一次：SSE 事件转发 + 连上设备后对账。 */
  function init(): void {
    if (initialized) return;
    initialized = true;

    onRoomEvent((event, payload) => {
      if (event === 'room') {
        applyRoom(payload as Parameters<typeof applyRoom>[0]);
        return;
      }
      if (event === 'room-playback') {
        applyPlayback(payload as RoomPlayback & { serverNow?: number });
        return;
      }
      if (event === 'room-entitlement') {
        const data = payload as (RoomEntitlement & { serverNow?: number }) | null;
        if (!data) return;
        // 已经离开房间了：这一帧是离开前发出的，丢掉即可。
        if (code.value === null) return;
        entitlement.value = {
          active: data.active ?? { netease: null, qq: null },
          pending: data.pending ?? { netease: null, qq: null },
        };
        // 撤销 / 换人之后，旧的直链立即作废，别让它被下一次重播捡起来用。
        pruneSharedSources();
        return;
      }
      if (event === 'hello') {
        // 连接（重）建立：断线期间房间可能已经散了，重新对一次账。
        if (!active.value) void reconcile();
      }
    });

    watch(
      () => devices.selfId,
      (deviceId) => {
        if (deviceId) void reconcile();
      },
      { immediate: true },
    );

    /*
     * 把「共享地址去哪儿找」告诉播放器：它每次起播时问一句，拿不到就自己解析。
     * 用回调而不是把地址塞进播放器状态，是因为地址的生命周期归房间管。
     */
    player.setSharedSourceProvider((platform, trackKey) => {
      if (platform !== 'netease' && platform !== 'qq') return null;
      const item = sharedSources.get(`${platform}:${trackKey}`);
      if (!item) return null;
      // 自己提供的地址不必再从房间绕一圈回来。
      if (item.ownerUserId === myUserId.value) return null;
      // 主进程会把 CDN 直链登记成同源 /media/<id>；没有就退回自己的解析。
      const url = item.media?.direct;
      if (!url) return null;
      return {
        url,
        trial: item.trial,
        quality: item.quality as Quality | undefined,
      };
    });

    // 别的设备请本机接走席位（`takeSeat` 指令）：本机是旁观就接过来。
    setTakeSeatHandler(() => {
      if (spectating.value) void transfer();
    });
  }

  return {
    code,
    kind,
    capacity,
    members,
    queue,
    index,
    playback,
    active,
    spectating,
    seatActive,
    me,
    accountMember,
    partner,
    currentTrack,
    playing,
    togetherSeconds,
    togetherSessionSeconds,
    togetherCounting,
    togetherLive,
    togetherSessionLive,
    /** 会员共享状态（按平台）。 */
    entitlement,
    entitlementOwner,
    myUserId,
    mySharedPlatforms,
    entitlementRequestsForMe,
    setEntitlement,
    ackEntitlement,
    livePosition,
    init,
    create,
    join,
    leave,
    dissolve,
    /** 把播放从同账号的另一台设备转移过来（旁观时唯一的那个动作）。 */
    transfer,
    /** 请另一台设备接走席位，并等它真的接上（超时返回 false）。 */
    handSeatTo,
    act,
    toggle,
    next,
    prev,
    seek,
    playAt,
    removeAt,
    cycleMode,
  };
});
