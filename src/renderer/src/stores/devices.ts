import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { DesktopConfig } from '@shared/ipc';
import {
  connectApi,
  type CommandAction,
  type RemoteDevice,
  type RemotePlayMode,
  type RemoteTrack,
} from '@/api/connect';
import type { Platform, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from './auth';
import { usePlayerStore } from './player';

/**
 * 多设备在线与遥控。
 *
 * 「在线」= 一条活着的 SSE 长连接（由主进程透传网关）。本机每秒上报一次播放状态，
 * 网关把整份设备列表广播给同账号的其它设备；指令是点对点的 POST，控制端不碰音频。
 *
 * 播放进度由控制端按 `positionAt` + 服务端时间偏移推算，避免两台机器的时钟差
 * 直接把进度条带偏。
 */

const REPORT_INTERVAL_MS = 1000;

const PLAY_MODES: RemotePlayMode[] = ['order', 'all', 'one', 'shuffle'];

/** 设备名的长度上限，与网关的清洗规则保持一致。 */
const NAME_MAX = 40;

/** 下发指令后等目标设备补报状态的时长，超了就提示「可能已离线」。 */
const COMMAND_ACK_MS = 4_000;
/** 等对方补报时的查询间隔，纯本地数值比较。 */
const COMMAND_ACK_POLL_MS = 80;

/** 等「接管」的回程（对方把队列 `transfer` 回来）最长多久。 */
const TAKE_OVER_MS = 5_000;

/** 向对方要播放列表的最短间隔：面板反复开合不该变成请求洪流。 */
const QUEUE_ASK_GAP_MS = 1_500;
/** 遥控改了对方队列之后，等它落地再要最新那份（太快会拿到改之前的）。 */
const QUEUE_REFRESH_DELAY_MS = 400;
/**
 * 对方队列在控制端最多缓存多少首。
 *
 * 队列要经网关转发一次，而指令 payload 的上限是 512KB；每首都带取流坐标，
 * 截到 200 首与「一起听」的房间队列是同一量级，够显示也够操作。
 */
const REMOTE_QUEUE_MAX = 200;

/** 跟随播放时，进度差超过这个值才 seek（再小就让它自己跑）。 */
const FOLLOW_SEEK_S = 1.5;
/**
 * 目标设备在广播里缺席多久，才认定它真的下线。
 *
 * 设备重连时，旧连接被摘除与新连接入册之间会短暂不在列表里。一帧看不见就停止跟随，
 * 一次毫秒级的中断会让同步播放永久停摆 —— following 已经清掉，对方回来了也不会自动恢复。
 */
const LEADER_GRACE_MS = 15_000;

/** 一次远程指令的最终结果：`ok` 表示对方确实执行了（补报了新状态）。 */
export type ControlResult = 'ok' | 'noResponse' | 'offline' | 'failed';

/** 控制端缓存的一份对方队列快照（`queue` 请求的应答）。 */
export interface RemoteQueue {
  queue: RemoteTrack[];
  /** 应答那一刻对方正在播的下标。 */
  index: number;
  /** 收到时刻（本地时钟）。 */
  at: number;
}

/**
 * 一起听（房间）事件的订阅口。
 *
 * 房间事件与设备事件复用**同一条** SSE（见网关 `services/rooms.ts` 的推送），但两者的
 * store 是分开的。让 `devices` 反过来导入 `room` 会形成循环依赖（room 需要 selfId 与
 * 时间偏移），所以这里只留一个模块级的转发口，由 room store 自己订阅。
 */
type RoomEventHandler = (event: string, payload: unknown) => void;

const roomHandlers = new Set<RoomEventHandler>();

/** 订阅房间事件（`room` / `room-playback` / `room-entitlement`，以及重连后的 `hello`）。 */
export function onRoomEvent(handler: RoomEventHandler): () => void {
  roomHandlers.add(handler);
  return () => {
    roomHandlers.delete(handler);
  };
}

function emitRoomEvent(event: string, payload: unknown): void {
  for (const handler of roomHandlers) {
    try {
      handler(event, payload);
    } catch {
      // 一个订阅者出错不该影响其它订阅者，更不该把 SSE 回调打崩。
    }
  }
}

/**
 * 「把一起听席位接到本机」的转发口。
 *
 * 设备 store 不能直接导入房间 store（房间反过来要用 selfId、serverOffset 与 send，
 * 直接互相 import 会成环），所以和房间事件一样留一个模块级注册点，由 room store 自己填。
 */
let takeSeatHandler: (() => void) | null = null;

/** 注册「接走一起听席位」的处理函数（传 `null` 注销）。 */
export function setTakeSeatHandler(handler: (() => void) | null): void {
  takeSeatHandler = handler;
}

/** 房间事件名，与网关推送的事件名一致。 */
const ROOM_EVENTS = ['room', 'room-playback', 'room-entitlement'] as const;

function isPlayMode(value: unknown): value is RemotePlayMode {
  return typeof value === 'string' && PLAY_MODES.includes(value as RemotePlayMode);
}

/** 把本地曲目裁成「对方看列表需要的那几个字段」。 */
function toRemoteTrack(track: UnifiedTrack): RemoteTrack {
  return {
    key: track.key,
    title: track.title,
    artists: track.artists.map((item) => item.name).join(' / '),
    album: track.album.name,
    cover: track.album.cover ?? null,
    durationMs: track.durationMs,
    sources: track.sources.map((source) => ({
      platform: source.platform,
      id: source.id,
      mid: source.mid,
    })),
  };
}

export const useDevicesStore = defineStore('devices', () => {
  const player = usePlayerStore();
  const auth = useAuthStore();
  const toast = useToast();

  const selfId = ref('');
  const deviceName = ref('');
  const devices = ref<RemoteDevice[]>([]);
  const connected = ref(false);
  const error = ref('');
  /** 服务端时间 - 本机时间（毫秒）。推算对方进度时用。 */
  const serverOffset = ref(0);

  /** 正在跟随的设备 id（null = 没在跟随）。 */
  const following = ref<string | null>(null);

  /** 按 deviceId 缓存的对方播放列表（`queue` 请求的应答）。 */
  const remoteQueues = ref<Record<string, RemoteQueue>>({});

  let source: EventSource | null = null;
  let reportTimer: number | undefined;
  let stopWatch: (() => void) | null = null;
  /** 每台设备上一次「要队列」的时刻，用来给反复开合的面板去重。 */
  const queueAskedAt = new Map<string, number>();
  /** 已收到过几次对端的 `transfer`（回程），「接管」等的是它。 */
  const transferSeq = ref(0);
  /** 跟随目标开始缺席的时刻；null 表示它就在列表里。 */
  let leaderMissingSince: number | null = null;
  let followTimer: number | undefined;
  /** 换歌过程中别再被下一轮广播打断（切换曲目本身又会触发一轮广播）。 */
  let syncing = false;

  const selfDevice = computed(
    () => devices.value.find((item) => item.deviceId === selfId.value) ?? null,
  );
  const others = computed(() => devices.value.filter((item) => item.deviceId !== selfId.value));
  const onlineOthers = computed(() => others.value.filter((item) => item.online));
  /** 别处有歌在放：用于在入口上提示「另一台设备正在播放」。 */
  const othersPlaying = computed(() => others.value.some((item) => item.state?.playing === true));

  function snapshot(): Record<string, unknown> {
    const track = player.current;

    return {
      track: track
        ? {
            key: track.key,
            title: track.title,
            artists: track.artists.map((artist) => artist.name).join(' / '),
            album: track.album.name,
            cover: track.album.cover ?? null,
            durationMs: track.durationMs,
            sources: track.sources.map((source) => ({
              platform: source.platform,
              id: source.id,
              mid: source.mid,
            })),
          }
        : null,
      playing: player.playing,
      position: player.currentTime,
      // 音频元数据没加载出来时用曲目自带时长兜底，免得远端显示 0:00。
      duration: player.duration > 0 ? player.duration : track ? track.durationMs / 1000 : 0,
      volume: player.muted ? 0 : player.volume,
      quality: player.actualQuality ?? player.quality,
      queueLength: player.queue.length,
      playMode: player.mode,
      // 让别的设备看得到「本机在跟着谁」，被跟随的一方才能确认对方跟上了。
      following: following.value ?? undefined,
    };
  }

  async function flush(): Promise<void> {
    if (!connected.value || !selfId.value) return;
    try {
      await connectApi.reportState(selfId.value, snapshot());
    } catch {
      // 断线期间上报失败很正常，重连后会补一份完整状态。
    }
  }

  function scheduleReport(): void {
    if (!connected.value || reportTimer !== undefined) return;
    reportTimer = window.setTimeout(() => {
      reportTimer = undefined;
      void flush();
    }, REPORT_INTERVAL_MS);
  }

  /** 把某台设备上报的进度推算到「现在」，已校正时钟差。 */
  function positionOf(device: RemoteDevice): number {
    const state = device.state;
    if (!state) return 0;
    if (!state.playing) return state.position;

    const elapsed = (Date.now() + serverOffset.value - state.positionAt) / 1000;
    const next = state.position + Math.max(0, elapsed);
    return state.duration > 0 ? Math.min(state.duration, next) : next;
  }

  /**
   * 发一条指令，只关心网关有没有接住（失败会抛）。
   *
   * 与 [control] 的区别：不弹错、不挂「对方到底响应了没有」的送达确认。
   */
  async function post(target: string, action: CommandAction, payload?: unknown): Promise<void> {
    if (!selfId.value) throw new Error('还没有连上设备服务');
    await connectApi.sendCommand({ deviceId: selfId.value, target, action, payload });
  }

  /** 只发指令、不等回执：用于不改变播放状态的一类动作（如一起听接席位）。 */
  async function send(target: string, action: CommandAction, payload?: unknown): Promise<boolean> {
    if (!target) return false;
    try {
      await post(target, action, payload);
      return true;
    } catch {
      return false;
    }
  }

  function applyDevices(payload: { devices?: RemoteDevice[]; serverNow?: number }): void {
    devices.value = payload.devices ?? [];
    if (typeof payload.serverNow === 'number') serverOffset.value = payload.serverNow - Date.now();
    // 设备下线后它那份播放列表缓存就没用了：留着的话，它重新上线时会先闪一屏旧队列。
    pruneRemoteQueues();
  }

  function handleHello(data: { deviceId?: string; devices?: RemoteDevice[]; serverNow?: number }): void {
    selfId.value = String(data.deviceId ?? '');
    applyDevices(data);
    connected.value = true;
    error.value = '';
    void flush();
    // 房间 store 靠这一帧知道「连接回来了」，好重新对账自己还在不在房间里。
    emitRoomEvent('hello', data);
    void syncToLeader();
  }

  // ---- 远程队列 ----

  function pruneRemoteQueues(): void {
    const alive = new Set(devices.value.map((item) => item.deviceId));
    const next: Record<string, RemoteQueue> = {};
    let dropped = false;
    for (const [id, entry] of Object.entries(remoteQueues.value)) {
      if (alive.has(id)) next[id] = entry;
      else dropped = true;
    }
    if (dropped) remoteQueues.value = next;
  }

  /** 向某台设备要一份播放列表快照。 */
  async function requestQueue(target: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - (queueAskedAt.get(target) ?? 0) < QUEUE_ASK_GAP_MS) return;
    queueAskedAt.set(target, now);
    await send(target, 'queue');
  }

  /** `queue` 请求的应答：把本机队列回传给请求方。 */
  async function replyQueue(target: string): Promise<void> {
    await send(target, 'queueState', {
      queue: player.queue.slice(0, REMOTE_QUEUE_MAX).map(toRemoteTrack),
      index: player.index,
    });
  }

  /** 记下收到的队列快照。 */
  function rememberQueue(from: string, data: Record<string, unknown>): void {
    if (!from) return;
    const queue = Array.isArray(data.queue) ? (data.queue as RemoteTrack[]) : [];
    const index = Number(data.index);
    remoteQueues.value = {
      ...remoteQueues.value,
      [from]: {
        queue: queue.slice(0, REMOTE_QUEUE_MAX),
        index: Number.isInteger(index) ? index : 0,
        at: Date.now(),
      },
    };
  }

  /**
   * 遥控对方的播放列表：跳播 / 移除 / 追加。
   *
   * 本地缓存先按意图就地改掉（点下去马上有反馈），随后再向对方要一份最新的对齐 ——
   * 乐观更新只是为了不让人干等一个往返，最终仍以对方回传的那份为准。
   */
  async function controlQueue(
    target: string,
    action: 'playAt' | 'remove' | 'add',
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const ok = await send(target, action, payload);
    if (!ok) {
      toast.info('对方没有响应，可能已离线');
      return false;
    }

    const cached = remoteQueues.value[target];
    if (cached) {
      const queue = [...cached.queue];
      let index = cached.index;
      if (action === 'playAt') {
        const at = Number(payload.index);
        if (Number.isInteger(at) && at >= 0 && at < queue.length) index = at;
      } else if (action === 'remove') {
        const at = Number(payload.index);
        if (Number.isInteger(at) && at >= 0 && at < queue.length) {
          queue.splice(at, 1);
          if (at < index) index -= 1;
          else if (at === index) index = Math.min(index, queue.length - 1);
        }
      } else if (action === 'add' && payload.track) {
        // 同一首已经在对方队列里时对方会拒绝，这里不猜它的结果：等 400ms 后的刷新对齐。
        queue.push(toRemoteTrack(payload.track as UnifiedTrack));
      }
      remoteQueues.value = { ...remoteQueues.value, [target]: { queue, index, at: Date.now() } };
    }

    window.setTimeout(() => void requestQueue(target, true), QUEUE_REFRESH_DELAY_MS);
    return true;
  }

  // ---- 本机执行远程指令 ----

  /** 对方要接管：把队列交出去，然后停下自己。 */
  async function handover(target: string): Promise<void> {
    if (!target) return;
    await post(target, 'transfer', {
      queue: player.queue,
      index: player.index,
      position: player.currentTime,
      playing: player.playing,
    });
    player.pause();
    toast.info('播放已移交到另一台设备');
  }

  /** 接管对方的队列：铺到播放器上并从对方的位置接着放。 */
  async function adopt(payload: Record<string, unknown>): Promise<void> {
    const incoming = Array.isArray(payload.queue) ? (payload.queue as UnifiedTrack[]) : [];
    if (incoming.length === 0) return;

    const index = Number(payload.index ?? 0);
    const position = Number(payload.position ?? 0);

    await player.playQueue(incoming, Number.isFinite(index) ? index : 0);
    if (position > 0.5) player.seek(position);
    toast.info('已接管对方的播放队列');
  }

  async function applyCommand(command: {
    from: string;
    action: string;
    payload: unknown;
  }): Promise<void> {
    const payload = (command.payload ?? {}) as Record<string, unknown>;

    /*
     * 队列快照的往返既不碰播放器、也不改变任何状态，所以不进下面那段「执行 → 补报」：
     * 一次列表请求不该再触发一轮 devices 全量广播。
     */
    if (command.action === 'queueState') {
      rememberQueue(command.from, payload);
      return;
    }
    if (command.action === 'queue') {
      await replyQueue(command.from);
      return;
    }

    switch (command.action) {
      case 'play':
      case 'transfer': {
        const queue = Array.isArray(payload.queue) ? (payload.queue as UnifiedTrack[]) : [];
        if (queue.length > 0) await adopt(payload);
        else player.play();
        // 回程到了：正等着的 takeOver 靠它判成功（`play` 不算，那只是让我们开始播）。
        if (command.action === 'transfer') transferSeq.value += 1;
        break;
      }
      case 'pause':
        player.pause();
        break;
      case 'toggle':
        player.toggle();
        break;
      case 'next':
        await player.next();
        break;
      case 'prev':
        await player.prev();
        break;
      case 'seek':
        player.seek(Number(payload.position ?? 0));
        break;
      case 'volume':
        player.setVolume(Number(payload.volume ?? 1));
        break;
      case 'mode':
        if (isPlayMode(payload.mode)) player.setMode(payload.mode);
        break;
      case 'playAt':
        if (typeof payload.index === 'number') void player.playAt(payload.index);
        break;
      case 'remove':
        player.removeFromQueueAt(Number(payload.index ?? -1));
        break;
      case 'add':
        if (payload.track) player.enqueue(payload.track as UnifiedTrack);
        break;
      case 'release':
        // 别的设备要接管：停下自己，把队列与进度交回去（收件人是发起方）。
        await handover(command.from);
        break;
      case 'takeSeat':
        /*
         * 一起听：另一台设备请本机把房间的席位接过去。
         * 走的是和「转移到本机」完全同一条路（`join` 接席位），不另起一套实现。
         */
        takeSeatHandler?.();
        break;
      case 'follow': {
        // 对端请本机跟随它：收件人就是发起方。
        if (!command.from) break;
        following.value = command.from;
        startFollowWatch();
        const name = devices.value.find((item) => item.deviceId === command.from)?.name ?? '对方';
        toast.info(`已跟随「${name}」播放`);
        void syncToLeader();
        break;
      }
      case 'unfollow':
        // 对方撤回了请求。只清「跟着它」这一种，避免误伤本机自己设的跟随对象。
        if (command.from && following.value !== command.from) break;
        stopFollowing(true);
        break;
      default:
        break;
    }

    /*
     * 立刻补报：控制端正是靠「这台设备的 positionAt 变了」来确认指令真的被执行了。
     * 走 1 秒的防抖上报会让每次点击都慢一拍才知道结果。
     */
    void flush();
  }

  // ---- 跟随播放 ----

  /**
   * 沿跟随链走到源头：目标自己也在跟别人时，本机该对的是链尾那台。
   *
   * 中间每一台都只是镜像，跟着它等于把它的残差再叠一层，源头换歌时还要多等一次转发。
   */
  function resolveFollowSource(id: string): string {
    const seen = new Set<string>([selfId.value, id]);
    let current = id;

    for (;;) {
      const next = devices.value.find((item) => item.deviceId === current)?.state?.following;
      if (!next || seen.has(next)) return current;
      if (!devices.value.some((item) => item.deviceId === next)) return current;
      seen.add(next);
      current = next;
    }
  }

  /** 目标设备缺席太久就真的收手（宽限期兜的是「瞬断重连」）。 */
  function expireLeaderIfGone(): void {
    if (!following.value || leaderMissingSince === null) return;
    if (Date.now() - leaderMissingSince < LEADER_GRACE_MS) return;

    leaderMissingSince = null;
    following.value = null;
    stopFollowWatch();
    toast.info('跟随的设备已离线，已停止同步');
  }

  function startFollowWatch(): void {
    if (followTimer !== undefined) return;
    followTimer = window.setInterval(expireLeaderIfGone, 1000);
  }

  function stopFollowWatch(): void {
    if (followTimer === undefined) return;
    window.clearInterval(followTimer);
    followTimer = undefined;
  }

  /**
   * 跟上目标设备的进度。
   *
   * 由 devices 广播驱动：每收到一份新状态就比对一次，不一致才动手，所以它是收敛的。
   * 两端各自缓冲、各自解码，偏差只能靠 seek 收拾，阈值因此放宽到秒级。
   */
  async function syncToLeader(): Promise<void> {
    if (!following.value || syncing) return;

    const target = resolveFollowSource(following.value);
    if (target !== following.value) following.value = target;

    const leader = devices.value.find((item) => item.deviceId === target);
    if (!leader) {
      if (leaderMissingSince === null) leaderMissingSince = Date.now();
      return;
    }
    leaderMissingSince = null;

    const state = leader.state;
    if (!state?.track) return;

    // 曲目不同：换歌。摘要里的歌手是拼好的字符串，还原成单条歌手即可（不影响播放）。
    if (state.track.key !== (player.current?.key ?? '')) {
      if (state.track.sources.length === 0) return;
      syncing = true;
      try {
        await player.playTrack({
          key: state.track.key,
          title: state.track.title,
          artists: [{ name: state.track.artists }],
          album: { name: state.track.album, cover: state.track.cover ?? undefined },
          durationMs: state.track.durationMs,
          sources: state.track.sources.map((item) => ({
            platform: item.platform as Platform,
            id: item.id,
            mid: item.mid,
          })),
        });
        const at = positionOf(leader);
        if (at > 0.5) player.seek(at);
        if (!state.playing) player.pause();
      } catch {
        // 取流失败（版权限制、对方没绑账号等）：放弃这一轮，下次广播还会再试。
      } finally {
        syncing = false;
      }
      return;
    }

    // 同一首歌：先对齐播放态，再收拾进度偏差。
    if (state.playing && !player.playing) player.play();
    else if (!state.playing && player.playing) player.pause();

    const expected = positionOf(leader);
    if (Math.abs(player.currentTime - expected) > FOLLOW_SEEK_S) player.seek(expected);
  }

  /** 跟随某台设备播放（只读镜像：跟随期间的传输控制不转发给对方）。 */
  function follow(device: RemoteDevice): void {
    if (device.deviceId === selfId.value) return;

    const sourceId = resolveFollowSource(device.deviceId);
    const source = devices.value.find((item) => item.deviceId === sourceId) ?? device;

    /*
     * 防循环：源头正在跟随本机的话，先请它停止。双向互跟没有意义 ——
     * 两边都是镜像、谁都没有权威，有偏差时只会互相拉扯。
     */
    if (source.state?.following === selfId.value) void send(source.deviceId, 'unfollow');
    leaderMissingSince = null;
    following.value = source.deviceId;
    startFollowWatch();
    toast.success(
      sourceId === device.deviceId
        ? `已跟随「${source.name}」播放`
        : `「${device.name}」跟随的是「${source.name}」，已直接跟随源头`,
    );
    void syncToLeader();
  }

  /** 停止跟随。`quiet` 用于对方撤回请求时，不重复提示。 */
  function stopFollowing(quiet = false): void {
    if (!following.value) return;
    leaderMissingSince = null;
    following.value = null;
    stopFollowWatch();
    if (!quiet) toast.info('已停止跟随');
  }

  /**
   * 请对方跟随本机播放 —— 与 [follow] 相反的那个方向。
   *
   * 本机只把意图发出去，真正把自己设成跟随者的还是对方。
   */
  async function requestFollow(device: RemoteDevice): Promise<ControlResult> {
    // 防循环：本机正在跟随对方的话，先停掉。
    if (following.value === device.deviceId) stopFollowing(true);
    return control(device.deviceId, 'follow');
  }

  /** 请对方停止跟随本机。 */
  async function cancelFollow(device: RemoteDevice): Promise<ControlResult> {
    return control(device.deviceId, 'unfollow');
  }

  /**
   * 接管对方的播放（协议里的场景 A）。
   *
   * 发 `release` 只是「请了」——真正发生的是对方暂停自己、把队列 `transfer` 回本机。
   * 所以等的是回程：`transferSeq` 涨了才算成功，超时就如实说没交过来。
   */
  async function takeOver(device: RemoteDevice): Promise<boolean> {
    const seen = transferSeq.value;
    const result = await control(device.deviceId, 'release', undefined, true);
    if (result !== 'ok') {
      toast.info(
        result === 'offline' ? `「${device.name}」可能已离线` : '没发出去，检查一下网络',
      );
      return false;
    }

    const deadline = Date.now() + TAKE_OVER_MS;
    while (Date.now() < deadline) {
      if (transferSeq.value > seen) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    toast.info(`「${device.name}」没有把播放交过来，可能已离线`);
    return false;
  }

  // ---- 连接生命周期 ----

  async function connect(): Promise<void> {
    if (!auth.isAuthenticated || source) return;

    let config: DesktopConfig;
    try {
      config = await window.sakura.getConfig();
    } catch {
      return;
    }

    deviceName.value = config.deviceName || 'Windows 设备';

    const kind: 'windows' | 'web' = window.sakura.platform === 'win32' ? 'windows' : 'web';
    const events = new EventSource(
      connectApi.eventsPath({ deviceId: config.deviceId, name: deviceName.value, kind }),
    );
    source = events;

    events.addEventListener('hello', (event) => {
      try {
        handleHello(
          JSON.parse((event as MessageEvent).data) as {
            deviceId: string;
            devices: RemoteDevice[];
            serverNow: number;
          },
        );
      } catch {
        // 帧格式不对就当没收到，等下一次广播。
      }
    });

    events.addEventListener('devices', (event) => {
      try {
        applyDevices(
          JSON.parse((event as MessageEvent).data) as {
            devices: RemoteDevice[];
            serverNow: number;
          },
        );
        // 跟随中：每收到一份新状态就比对一次（只有不一致才会动手）。
        void syncToLeader();
      } catch {
        // 同上。
      }
    });

    events.addEventListener('command', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          from: string;
          action: string;
          payload: unknown;
        };
        void applyCommand(data);
      } catch {
        // 非法指令忽略。
      }
    });

    // 房间事件走同一条连接：解析后转给订阅者（`stores/room.ts`）。
    for (const name of ROOM_EVENTS) {
      events.addEventListener(name, (event) => {
        try {
          emitRoomEvent(name, JSON.parse((event as MessageEvent).data));
        } catch {
          // 帧格式不对就当没收到，等下一次广播。
        }
      });
    }

    events.onerror = () => {
      connected.value = false;
      error.value = '设备连接已断开，正在重连…';
    };

    if (!stopWatch) {
      stopWatch = watch(
        () => [
          player.current?.key,
          player.playing,
          player.volume,
          player.muted,
          player.quality,
          player.mode,
          player.currentTime,
          following.value,
        ],
        () => scheduleReport(),
      );
    }
  }

  function disconnect(): void {
    source?.close();
    source = null;
    stopWatch?.();
    stopWatch = null;
    if (reportTimer !== undefined) {
      window.clearTimeout(reportTimer);
      reportTimer = undefined;
    }
    stopFollowWatch();
    following.value = null;
    leaderMissingSince = null;
    remoteQueues.value = {};
    queueAskedAt.clear();
    connected.value = false;
    selfId.value = '';
    devices.value = [];
    error.value = '';
  }

  async function reconnect(): Promise<void> {
    disconnect();
    await connect();
  }

  /** 改设备名：名字随连接带上服务端，所以要重连一次。 */
  async function rename(next: string): Promise<boolean> {
    const name = next.trim().slice(0, NAME_MAX);
    if (!name || name === deviceName.value) return false;

    try {
      await window.sakura.updateConfig({ deviceName: name });
    } catch {
      toast.error('改名失败，请稍后再试');
      return false;
    }
    deviceName.value = name;
    await reconnect();
    toast.success('设备名已更新');
    return true;
  }

  /**
   * 控制另一台设备：本机只发指令，音频仍由那台设备自己拉。
   *
   * 网关回 `ok` 只代表「已经写进那条连接」，不代表对方还在——所以要等一个送达确认。
   * 被遥控的设备执行完会立刻补报状态，因此「它的 positionAt 变了」就是最可靠的证据。
   */
  async function control(
    target: string,
    action: CommandAction,
    payload?: unknown,
    /** 调用方自己处理结果时不弹提示（避免「没响应」和它自己的说明叠两条）。 */
    silent = false,
  ): Promise<ControlResult> {
    const known = devices.value.find((item) => item.deviceId === target);
    const before = known?.state?.positionAt ?? null;
    const label = known?.name ?? '目标设备';

    try {
      await post(target, action, payload);
    } catch (caught) {
      if (!silent) toast.error(caught instanceof Error ? caught.message : '控制失败');
      return 'failed';
    }

    // 接管是一个往返（release → 对端回传 transfer），确认交给回程那一步；
    // takeSeat 也不改播放进度，用 positionAt 判断「有没有响应」只会误报。
    if (action === 'release' || action === 'takeSeat') return 'ok';

    // 等确认：对方执行完会立刻补报状态，`positionAt` 变了就是它真的动了。
    const deadline = Date.now() + COMMAND_ACK_MS;
    while (Date.now() < deadline) {
      const current = devices.value.find((item) => item.deviceId === target);
      if (!current) {
        if (!silent) toast.info(`「${label}」已离线`);
        return 'offline';
      }
      const after = current.state?.positionAt ?? null;
      // 目标本来空闲（从没上报过状态）：现在有状态了，就是它执行并补报过。
      if (after !== null && (before === null || after > before)) return 'ok';
      await new Promise((resolve) => window.setTimeout(resolve, COMMAND_ACK_POLL_MS));
    }

    if (!silent) toast.info(`「${label}」没有响应，可能已离线`);
    return 'noResponse';
  }

  return {
    selfId,
    deviceName,
    devices,
    connected,
    error,
    serverOffset,
    selfDevice,
    others,
    onlineOthers,
    othersPlaying,
    following,
    remoteQueues,
    positionOf,
    connect,
    disconnect,
    reconnect,
    flush,
    /** 只发指令、不等回执（返回是否送达）。 */
    send,
    control,
    takeOver,
    requestQueue,
    controlQueue,
    follow,
    stopFollowing,
    requestFollow,
    cancelFollow,
    rename,
  };
});
