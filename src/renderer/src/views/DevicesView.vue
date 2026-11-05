<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import type { RemoteDevice, RemotePlayMode } from '@/api/connect';
import { useDevicesStore } from '@/stores/devices';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useToast } from '@/composables/useToast';
import { cachedImage } from '@/utils/cacheImage';
import { formatTime } from '@/utils/format';

/**
 * 设备页。
 *
 * 遥控其它设备的传输 / 进度 / 音量 / 播放模式 / 播放列表，双向跟随，投放与接管，
 * 改本机设备名；一起听进行中则只剩「让声音切到这台」。
 */
const devices = useDevicesStore();
const player = usePlayerStore();
const room = useRoomStore();
const toast = useToast();

/* ---------------- 心跳：把「时间在走」变成可被追踪的依赖 ---------------- */

/** 只有真的有设备在放歌才需要走秒：都停着的话进度本来就不会变。 */
const anyPlaying = computed(() => devices.devices.some((item) => item.state?.playing === true));
const tick = ref(0);
let tickTimer: number | undefined;

watch(
  anyPlaying,
  (playing) => {
    if (playing && tickTimer === undefined) {
      tickTimer = window.setInterval(() => {
        tick.value += 1;
      }, 1000);
    } else if (!playing && tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
  },
  { immediate: true },
);

/* ---------------- 设备与身份 ---------------- */

function isSelf(device: RemoteDevice): boolean {
  return device.deviceId === devices.selfId;
}

function iconOf(device: RemoteDevice): string {
  if (device.kind === 'android') return 'phone';
  if (device.kind === 'windows') return 'laptop';
  return 'device';
}

const KIND_LABEL: Record<string, string> = {
  windows: 'Windows',
  web: '网页端',
  android: 'Android',
};

function kindLabel(device: RemoteDevice): string {
  return KIND_LABEL[device.kind] ?? '设备';
}

/** 本机永远置顶。 */
const orderedDevices = computed(() => {
  const self = devices.devices.filter((item) => item.deviceId === devices.selfId);
  const others = devices.devices.filter((item) => item.deviceId !== devices.selfId);
  return [...self, ...others];
});

const onlineCount = computed(() => devices.devices.filter((item) => item.online).length);
const playingCount = computed(() => devices.devices.filter((item) => item.state?.playing).length);

/** 房间进行中——本机是席位或旁观都算。 */
const roomActive = computed(() => room.active);
/** 房间席位所在的那台设备（我账号的）。它放的是房间的歌，对内容控制只读。 */
const roomSeatId = computed(() => room.accountMember?.deviceId ?? null);

function isRoomSeat(device: RemoteDevice): boolean {
  return roomActive.value && device.deviceId === roomSeatId.value;
}

/** 「让声音切到这台」在途：指令已发出、等对方接上，期间不让连点。 */
const seating = ref(false);

/* ---------------- 卡片上的曲目信息 ---------------- */

function coverOf(device: RemoteDevice): string {
  return cachedImage(device.state?.track?.cover);
}

function trackTitle(device: RemoteDevice): string {
  return device.state?.track?.title ?? '';
}

function trackArtists(device: RemoteDevice): string {
  return device.state?.track?.artists ?? '';
}

function trackAlbum(device: RemoteDevice): string {
  return device.state?.track?.album ?? '';
}

function statusOf(device: RemoteDevice): string {
  if (!device.state?.track) return '空闲';
  return device.state.playing ? '播放中' : '已暂停';
}

function trackLineOf(device: RemoteDevice): string {
  const state = device.state;
  if (!state?.track) return isSelf(device) ? '没有在放歌' : '空闲';
  return `${state.track.title} — ${state.track.artists}`;
}

function emptyHint(device: RemoteDevice): string {
  return isSelf(device) ? '从搜索或发现页挑一首开始' : '可以点「播到这台」把本机播放交给它';
}

function controlHint(device: RemoteDevice): string {
  return device.state?.playing ? `暂停「${device.name}」` : `让「${device.name}」播放`;
}

function castHint(device: RemoteDevice): string {
  if (player.queue.length > 0) return `把本机正在播放的内容交给「${device.name}」`;
  return `把「${device.name}」正在播放的内容接到本机`;
}

/** 跟随中的设备名，用于顶部那句提示。 */
const followingName = computed(
  () => devices.devices.find((item) => item.deviceId === devices.following)?.name ?? '设备',
);

function followHint(device: RemoteDevice): string {
  return devices.following === device.deviceId
    ? `停止跟随「${device.name}」`
    : `跟随「${device.name}」同步播放`;
}

function requestFollowHint(device: RemoteDevice): string {
  return device.state?.following === devices.selfId
    ? `让「${device.name}」停止跟随本机`
    : `让「${device.name}」跟随本机播放`;
}

/**
 * 「跟随它」能不能出现。
 *
 * 除了「它有内容可跟」，还有一个必须放行的情形：**本机正跟着它**。
 * 否则它一停下，连「停止跟随」的入口都会跟着消失。
 */
function canFollowTarget(device: RemoteDevice): boolean {
  return Boolean(device.state?.track) || devices.following === device.deviceId;
}

/**
 * 「播到这台」能不能出现：本机有内容可交出去，或它手里有内容可接过来。
 * 设备空着恰恰是把本机播放送过去的最好时机。
 */
function canCast(device: RemoteDevice): boolean {
  return player.queue.length > 0 || Boolean(device.state?.track);
}

/* ---------------- 遥控操作 ---------------- */

async function togglePlay(device: RemoteDevice): Promise<void> {
  // 用明确的 play / pause，而不是 toggle：指令要表达意图，不依赖双方状态严丝合缝。
  await devices.control(device.deviceId, device.state?.playing ? 'pause' : 'play');
}

async function skip(device: RemoteDevice, action: 'prev' | 'next'): Promise<void> {
  await devices.control(device.deviceId, action);
}

function toggleFollow(device: RemoteDevice): void {
  if (devices.following === device.deviceId) devices.stopFollowing();
  else devices.follow(device);
}

/** 反向：请对方跟随本机。它跟不跟由它自己决定，本机只是发请求。 */
async function toggleRequestFollow(device: RemoteDevice): Promise<void> {
  if (device.state?.following === devices.selfId) {
    await devices.cancelFollow(device);
    return;
  }
  // 「请它跟随」也要等它真的动起来（它会补报状态），不然只是我们一厢情愿。
  const result = await devices.requestFollow(device);
  if (result === 'ok') toast.success(`已请「${device.name}」跟随本机`);
}

/**
 * 「播到这台」：
 * - 本机有内容 → 连队列带进度交给对方，本机停下；
 * - 本机是空的 → 反过来把对方手里的接到本机。
 */
async function activate(device: RemoteDevice): Promise<void> {
  if (player.queue.length > 0) {
    /*
     * 先停下再等确认：交给对方时本机继续出声就是两个声音叠在一起。
     * 但没交出去必须回滚——停在那里会让人以为「已经投过去了」，实际一片安静。
     */
    const wasPlaying = player.playing;
    player.pause();
    const result = await devices.control(
      device.deviceId,
      'transfer',
      { queue: player.queue, index: player.index, position: player.currentTime },
      true,
    );
    if (result !== 'ok') {
      if (wasPlaying) player.play();
      toast.info(`「${device.name}」没有接过去，已恢复本机播放`);
      return;
    }
    toast.success(`已交给「${device.name}」播放`);
  } else if (device.state?.track) {
    // 接管是往返：队列真的回传了才算成功（提示由 takeOver 自己给）。
    if (!(await devices.takeOver(device))) return;
    toast.success(`已从「${device.name}」接过来`);
  } else {
    toast.info('两边都没有可播放的内容');
  }
}

/**
 * 一起听：「让声音切到这台」。
 *
 * 只是**请**它接席位——真正的动作是它自己 `join`。所以等的是房间状态：
 * 席位真的换到它身上才算成功。
 */
async function takeSeatThere(device: RemoteDevice): Promise<void> {
  if (seating.value) return;
  seating.value = true;
  try {
    if (await room.handSeatTo(device.deviceId)) {
      toast.success(`声音已切到「${device.name}」`);
    } else {
      toast.info(`「${device.name}」没有接过去，可能已离线或没响应`);
    }
  } finally {
    seating.value = false;
  }
}

/* ---------------- 进度 / 音量：草稿值与本地推算 ---------------- */

function positionText(device: RemoteDevice): string {
  void tick.value;
  if (!device.state) return '0:00';
  return formatTime(Math.max(0, sliderValue(device, 'progress')));
}

function durationText(device: RemoteDevice): string {
  const duration = device.state?.duration ?? 0;
  return duration > 0 ? formatTime(duration) : '--:--';
}

/** 进度条的填充比例（%），跟着草稿值走。 */
function progressPercent(device: RemoteDevice): number {
  const max = Math.max(1, device.state?.duration ?? 0);
  return Math.min(100, Math.max(0, (sliderValue(device, 'progress') / max) * 100));
}

/** 音量条的填充比例（%）。 */
function volumePercent(device: RemoteDevice): number {
  return Math.round(Math.min(1, Math.max(0, sliderValue(device, 'volume'))) * 100);
}

function volumeIcon(device: RemoteDevice): string {
  return volumePercent(device) === 0 ? 'mute' : 'volume';
}

/*
 * 滑块的「草稿值」：key 是 `${deviceId}:progress|volume`。
 *
 * 它有两段生命期，少一段都会闪：
 * - 手指按着（committedAt === null）：进度每秒跟着 tick 重渲染，:value 若一直绑推算值，
 *   滑块会在手指底下被拽回服务端那个位置；
 * - 松手之后（committedAt 有值）：指令还在往返，对方的真实值仍是旧的。此时若立刻删掉草稿，
 *   滑块会先掉回旧位置，等回执广播到了再跳回手指的位置 —— 就是那一下「闪回去又闪回来」。
 *   所以草稿要留到「对方的真实值追上了它」或者等超时（对方没响应时的兜底）再撤。
 */
interface SliderDraft {
  deviceId: string;
  kind: 'progress' | 'volume';
  /** 被拖到的位置（进度为秒，音量为 0..1）。 */
  value: number;
  /** 松手提交的时刻；null = 手指还按着。 */
  committedAt: number | null;
  /** 提交时对方在放的曲目：换了歌，这条进度草稿就没意义了。 */
  trackKey: string;
}

/** 松手后最多等这么久：对方执行完会立刻补报状态，这里只是失败时的兜底。 */
const SLIDER_ACK_MS = 1_200;
/** 草稿落地检查的间隔：只是本地数值比较，不发请求。 */
const SLIDER_SETTLE_MS = 100;
/** 判定「真实值已追上草稿」的容差。 */
const PROGRESS_TOLERANCE_S = 1.5;
const VOLUME_TOLERANCE = 0.006;

const drafts = ref<Record<string, SliderDraft>>({});
let settleTimer: number | undefined;

function dragKey(device: RemoteDevice, kind: 'progress' | 'volume'): string {
  return `${device.deviceId}:${kind}`;
}

/** 不加草稿时，这台设备此刻的真实值。 */
function realValueOf(device: RemoteDevice, kind: 'progress' | 'volume'): number {
  if (kind === 'volume') return device.state?.volume ?? 1;
  void tick.value;
  return devices.positionOf(device);
}

/** 草稿是否还代表「这一刻该显示的值」：设备还在、歌没换（只有进度在意换歌）。 */
function draftApplies(draft: SliderDraft, device: RemoteDevice): boolean {
  if (draft.kind === 'volume') return true;
  return (device.state?.track?.key ?? '') === draft.trackKey;
}

/** 草稿什么时候可以放手。 */
function draftSettled(draft: SliderDraft, device: RemoteDevice | null, now: number): boolean {
  if (!device || !draftApplies(draft, device)) return true;
  if (draft.committedAt === null) return false;
  if (now - draft.committedAt > SLIDER_ACK_MS) return true;

  const tolerance = draft.kind === 'volume' ? VOLUME_TOLERANCE : PROGRESS_TOLERANCE_S;
  return Math.abs(realValueOf(device, draft.kind) - draft.value) <= tolerance;
}

function stopSettleTimer(): void {
  if (settleTimer === undefined) return;
  window.clearInterval(settleTimer);
  settleTimer = undefined;
}

/** 把已经落地的草稿摘掉；摘干净了就不再轮询。 */
function settleDrafts(): void {
  const entries = Object.entries(drafts.value);
  if (entries.length === 0) {
    stopSettleTimer();
    return;
  }

  const now = performance.now();
  let changed = false;
  const next: Record<string, SliderDraft> = {};

  for (const [key, draft] of entries) {
    const device = devices.devices.find((item) => item.deviceId === draft.deviceId) ?? null;
    if (draftSettled(draft, device, now)) changed = true;
    else next[key] = draft;
  }

  if (changed) drafts.value = next;
  if (Object.keys(next).length === 0) stopSettleTimer();
}

function ensureSettleTimer(): void {
  if (settleTimer !== undefined) return;
  settleTimer = window.setInterval(settleDrafts, SLIDER_SETTLE_MS);
}

function sliderValue(device: RemoteDevice, kind: 'progress' | 'volume'): number {
  // 草稿优先：按着时就是手指的位置，松手后则是「等对方回执」的那个目标值。
  const draft = drafts.value[dragKey(device, kind)];
  if (draft && draftApplies(draft, device)) return draft.value;

  if (kind === 'volume') return device.state?.volume ?? 1;
  void tick.value;
  return devices.positionOf(device);
}

function onSliderInput(device: RemoteDevice, kind: 'progress' | 'volume', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  // 拖动中只改本地草稿、不发指令：每移动一格发一次会把对方刷爆（松手才发）。
  drafts.value = {
    ...drafts.value,
    [dragKey(device, kind)]: {
      deviceId: device.deviceId,
      kind,
      value,
      committedAt: null,
      trackKey: device.state?.track?.key ?? '',
    },
  };
}

/** 松手才发指令，并把草稿留到对方回执之后再撤（否则会先闪回旧位置）。 */
async function onSliderCommit(
  device: RemoteDevice,
  kind: 'progress' | 'volume',
  event: Event,
): Promise<void> {
  const key = dragKey(device, kind);
  const value = Number((event.target as HTMLInputElement).value);

  drafts.value = {
    ...drafts.value,
    [key]: {
      deviceId: device.deviceId,
      kind,
      value,
      committedAt: performance.now(),
      trackKey: device.state?.track?.key ?? '',
    },
  };

  // 值本来就在这儿（或者设备刚换了歌）：没什么可等的，立刻放掉。
  settleDrafts();
  if (drafts.value[key]) ensureSettleTimer();

  if (kind === 'volume') await devices.control(device.deviceId, 'volume', { volume: value });
  else await devices.control(device.deviceId, 'seek', { position: value });
}

/* ---------------- 播放模式 ---------------- */

const MODE_ITEMS: { mode: RemotePlayMode; icon: string; label: string; hint: string }[] = [
  { mode: 'order', icon: 'order', label: '顺序播放', hint: '播完最后一首就停下' },
  { mode: 'all', icon: 'repeat', label: '列表循环', hint: '播完自动回到第一首' },
  { mode: 'one', icon: 'repeat-one', label: '单曲循环', hint: '反复播放当前这一首' },
  { mode: 'shuffle', icon: 'shuffle', label: '随机播放', hint: '随机跳到队列中的某一首' },
];

function modeOf(device: RemoteDevice): (typeof MODE_ITEMS)[number] | null {
  return MODE_ITEMS.find((item) => item.mode === device.state?.playMode) ?? null;
}

/** 那个图标按钮本身就是「它现在用的模式」；没报过的老客户端用循环的图标兜底。 */
function modeIconOf(device: RemoteDevice): string {
  return modeOf(device)?.icon ?? 'repeat';
}

function modeHint(device: RemoteDevice): string {
  const current = modeOf(device);
  return current ? `播放模式：${current.label}（点击切换）` : '播放模式：未知（点击切换）';
}

/* ---------------- 模式菜单 / 播放列表浮层 ---------------- */

type FloatKind = 'mode' | 'queue';

interface FloatBox {
  kind: FloatKind;
  deviceId: string;
  left: number;
  top: number | null;
  bottom: number | null;
  maxHeight: number;
}

const float = ref<FloatBox | null>(null);
const floatRef = ref<HTMLElement | null>(null);

/** 两块浮层的宽度，与样式里的宽度保持一致（摆位要用）。 */
const MODE_MENU_W = 228;
const QUEUE_PANEL_W = 332;

/** 浮层现在的归属设备（设备可能中途下线，所以每次按 id 现查）。 */
const floatDevice = computed(
  () => devices.devices.find((item) => item.deviceId === float.value?.deviceId) ?? null,
);

/** 浮层里那份队列快照（没拉到时为 null）。 */
const floatQueue = computed(() =>
  floatDevice.value ? (devices.remoteQueues[floatDevice.value.deviceId] ?? null) : null,
);

/**
 * 打开 / 收起浮层，并贴着按钮摆好位置。
 *
 * 只依赖「常量宽度 + 可用空间」，不看渲染后的尺寸，所以不需要先隐藏再测量。
 */
function toggleFloat(kind: FloatKind, device: RemoteDevice, event: MouseEvent): void {
  if (float.value?.kind === kind && float.value.deviceId === device.deviceId) {
    float.value = null;
    return;
  }
  const button = event.currentTarget as HTMLElement | null;
  if (!button) return;

  const anchor = button.getBoundingClientRect();
  const gutter = 8;
  const width = kind === 'queue' ? QUEUE_PANEL_W : MODE_MENU_W;
  const left = Math.max(gutter, Math.min(anchor.right - width, window.innerWidth - width - gutter));
  // 朝空间大的那一侧展开；贴边距用的是「按钮与视口」的距离，面板长高也不会盖住按钮。
  const aboveSpace = anchor.top - gutter * 2;
  const belowSpace = window.innerHeight - anchor.bottom - gutter * 2;
  const placeAbove = aboveSpace >= belowSpace;
  float.value = {
    kind,
    deviceId: device.deviceId,
    left,
    top: placeAbove ? null : anchor.bottom + gutter,
    bottom: placeAbove ? window.innerHeight - anchor.top + gutter : null,
    maxHeight: Math.max(140, placeAbove ? aboveSpace : belowSpace),
  };

  // 播放列表是按需拉的：每次打开都要一份新的，否则看到的还是上次那份快照。
  if (kind === 'queue') void devices.requestQueue(device.deviceId, true);
}

const floatStyle = computed(() => {
  const box = float.value;
  if (!box) return {};
  return {
    left: `${box.left}px`,
    top: box.top === null ? undefined : `${box.top}px`,
    bottom: box.bottom === null ? undefined : `${box.bottom}px`,
    maxHeight: `${box.maxHeight}px`,
  };
});

/** 选中一种模式：浮层收起，指令发给那台设备。 */
function selectMode(mode: RemotePlayMode): void {
  const device = floatDevice.value;
  float.value = null;
  if (!device || device.state?.playMode === mode) return;
  void devices.control(device.deviceId, 'mode', { mode });
}

function refreshQueue(): void {
  const device = floatDevice.value;
  if (device) void devices.requestQueue(device.deviceId, true);
}

/** 点列表里的某一行 = 让那台设备播这一首。 */
function playRemoteAt(index: number): void {
  const device = floatDevice.value;
  if (device) void devices.controlQueue(device.deviceId, 'playAt', { index });
}

function removeRemoteAt(index: number): void {
  const device = floatDevice.value;
  if (device) void devices.controlQueue(device.deviceId, 'remove', { index });
}

/** 把本机当前这首追加到对方的播放列表（对方已有同一首时会拒绝，由它自己提示）。 */
function addCurrentToRemote(): void {
  const device = floatDevice.value;
  const track = player.current;
  if (!device || !track) return;
  void devices.controlQueue(device.deviceId, 'add', { track });
}

/* ---------------- 浮层与改名弹窗的收起 ---------------- */

const renaming = ref(false);
const draftName = ref('');
const nameInput = ref<HTMLInputElement | null>(null);
const renameRef = ref<HTMLElement | null>(null);

async function startRename(): Promise<void> {
  draftName.value = devices.selfDevice?.name ?? devices.deviceName;
  renaming.value = true;
  await nextTick();
  nameInput.value?.select();
}

function commitRename(): void {
  const name = draftName.value.trim();
  if (!name) return;
  renaming.value = false;
  void devices.rename(name);
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target instanceof Node ? event.target : null;

  // 点的是浮层本身：不关它（里面的按钮自己会收尾）。
  if (target && floatRef.value?.contains(target)) return;
  // 改名弹窗 Teleport 到了 body，和页面不在同一棵树里。
  if (target && renameRef.value?.contains(target)) return;
  // 点的是那两个开关图标：交给它们的 click 去「开 / 关」，这里别抢先关掉。
  if (target instanceof Element && target.closest('[data-float-toggle]')) return;

  if (float.value) float.value = null;

  if (!renaming.value) return;
  if (target instanceof Element && target.closest('.dev-modal')) return;
  renaming.value = false;
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (renaming.value) renaming.value = false;
  else if (float.value) float.value = null;
}

/** 浮层是 fixed 定位、按按钮的屏幕位置摆的：页面一滚，它就得收起。 */
function onDocumentScroll(event: Event): void {
  if (!float.value) return;
  const target = event.target instanceof Node ? event.target : null;
  if (target && floatRef.value?.contains(target)) return;
  float.value = null;
}

/** 视口尺寸一变，刚才算好的贴边位置就不准了；直接收起，下次点开重新摆。 */
function onWindowResize(): void {
  if (float.value) float.value = null;
}

/* 设备下线时，属于它的浮层要一起消失。 */
watch(floatDevice, (device) => {
  if (!device) float.value = null;
});

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
  document.addEventListener('scroll', onDocumentScroll, true);
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeyDown);
  document.removeEventListener('scroll', onDocumentScroll, true);
  window.removeEventListener('resize', onWindowResize);
  if (tickTimer !== undefined) window.clearInterval(tickTimer);
  stopSettleTimer();
});
</script>

<template>
  <div class="devices-view">
    <header class="hero">
      <span class="hero-glow" />
      <div class="hero-main">
        <p class="eyebrow">多设备</p>
        <h1>设备与遥控</h1>
        <p class="hero-desc">
          同一个账号在其它设备上打开 Sakura，就会出现在这里。遥控只发指令，声音仍在对方设备上播放；
          跟随则把本机变成它的镜像输出。
        </p>
      </div>

      <div class="hero-side">
        <div class="stats">
          <div class="stat">
            <strong>{{ devices.devices.length }}</strong>
            <span>设备</span>
          </div>
          <div class="stat">
            <strong>{{ onlineCount }}</strong>
            <span>在线</span>
          </div>
          <div class="stat">
            <strong>{{ playingCount }}</strong>
            <span>播放中</span>
          </div>
        </div>

        <div class="hero-actions">
          <span class="chip" :class="{ warn: !devices.connected }">
            <AppIcon :name="devices.connected ? 'wifi' : 'alert'" :size="12" />
            {{ devices.connected ? '设备服务已连接' : devices.error || '设备服务未连接' }}
          </span>
          <button type="button" class="btn hero-btn" @click="devices.reconnect()">
            <AppIcon name="refresh" :size="13" />
            重连
          </button>
        </div>
      </div>
    </header>

    <!-- 跟随中：说清「本机在跟着谁走」，并给一个明确的出口。 -->
    <div v-if="devices.following" class="banner follow">
      <span class="banner-icon"><AppIcon name="link" :size="14" /></span>
      <span class="truncate">正在跟随「{{ followingName }}」同步播放</span>
      <button type="button" class="btn banner-btn" @click="devices.stopFollowing()">停止跟随</button>
    </div>

    <!-- 一起听进行中：内容控制归房间，这里只剩「决定声音从哪台出」。 -->
    <div v-if="roomActive" class="banner room">
      <span class="banner-icon"><AppIcon name="users" :size="14" /></span>
      <span class="truncate">一起听进行中：播放由房间统一管，可以把声音切到另一台</span>
    </div>

    <section v-if="devices.devices.length === 0" class="empty">
      <span class="empty-disc">
        <AppIcon name="monitor" :size="30" :stroke-width="1.3" />
      </span>
      <h2>正在查找设备…</h2>
      <p>
        在另一台电脑或手机上打开同一个服务器并登录，设备会自动出现在这里。
        当前{{ devices.connected ? '连接正常' : '还没有连上设备服务' }}。
      </p>
      <button v-if="!devices.connected" type="button" class="btn" @click="devices.reconnect()">
        <AppIcon name="refresh" :size="13" />
        重新连接
      </button>
    </section>

    <div v-else class="device-grid">
      <article
        v-for="device in orderedDevices"
        :key="device.deviceId"
        class="dev-card"
        :class="{
          'is-self': isSelf(device),
          'is-following': devices.following === device.deviceId,
          'is-playing': device.state?.playing,
          'is-offline': !device.online,
        }"
      >
        <!-- 用封面本身做一层模糊底光：既不抢文字，又能一眼认出它在放什么。 -->
        <span
          v-if="coverOf(device)"
          class="art-glow"
          :style="{ '--art': `url(${coverOf(device)})` }"
        />

        <header class="card-head">
          <span class="kind-badge">
            <AppIcon :name="iconOf(device)" :size="15" />
          </span>

          <span class="head-copy">
            <strong class="dev-name truncate" :title="`${device.name}（${kindLabel(device)}）`">
              {{ device.name }}
            </strong>
            <span class="meta-line">
              <span class="online-dot" :class="{ on: device.online }" />
              <span class="truncate">{{ kindLabel(device) }} · {{ device.online ? '在线' : '离线' }}</span>
              <span v-if="isSelf(device)" class="tag">本机</span>
              <span v-else-if="isRoomSeat(device)" class="tag">一起听中</span>
              <span v-else-if="devices.following === device.deviceId" class="tag accent">跟随中</span>
              <span v-else-if="device.state?.following === devices.selfId" class="tag accent">跟随我中</span>
            </span>
          </span>

          <button
            v-if="isSelf(device)"
            type="button"
            class="btn-icon rename"
            title="给这台设备改名"
            @click="startRename"
          >
            <AppIcon name="edit" :size="14" />
          </button>

          <!-- 播放键放在头部右侧：图标说明「点它会做什么」，文字说明「它现在怎么样」。 -->
          <span v-else-if="!isRoomSeat(device)" class="transport">
            <button
              type="button"
              class="btn-icon skip"
              :disabled="!device.state?.track"
              :title="`「${device.name}」上一首`"
              @click="skip(device, 'prev')"
            >
              <AppIcon name="prev" :size="13" filled />
            </button>
            <button
              type="button"
              class="btn play-pill"
              :class="{ 'is-playing': device.state?.playing }"
              :disabled="!device.state?.track"
              :title="device.state?.track ? controlHint(device) : `「${device.name}」没有在放歌`"
              @click="togglePlay(device)"
            >
              <AppIcon :name="device.state?.playing ? 'pause' : 'play'" :size="11" filled />
              {{ statusOf(device) }}
            </button>
            <button
              type="button"
              class="btn-icon skip"
              :disabled="!device.state?.track"
              :title="`「${device.name}」下一首`"
              @click="skip(device, 'next')"
            >
              <AppIcon name="next" :size="13" filled />
            </button>
          </span>
        </header>

        <div class="now" :class="{ 'is-empty': !device.state?.track }">
          <span class="cover" :class="{ 'is-playing': device.state?.playing }">
            <img v-if="coverOf(device)" :src="coverOf(device)" alt="" />
            <AppIcon v-else :name="iconOf(device)" :size="26" :stroke-width="1.35" />
            <span v-if="device.state?.playing" class="eq" aria-hidden="true">
              <i /><i /><i />
            </span>
          </span>

          <div class="now-copy">
            <template v-if="device.state?.track">
              <strong class="truncate" :title="trackLineOf(device)">{{ trackTitle(device) }}</strong>
              <span class="truncate artists">{{ trackArtists(device) }}</span>
              <span class="truncate album">{{ trackAlbum(device) }}</span>
            </template>
            <template v-else>
              <strong class="muted">还没有播放内容</strong>
              <span class="album">{{ emptyHint(device) }}</span>
            </template>
          </div>
        </div>

        <!-- 进度：要有内容才谈得上拖 -->
        <div
          v-if="!isSelf(device) && !isRoomSeat(device) && device.state?.track"
          class="control progress"
        >
          <span class="time">{{ positionText(device) }}</span>
          <input
            class="slider"
            type="range"
            min="0"
            :max="Math.max(1, device.state.duration || 0)"
            step="1"
            :value="sliderValue(device, 'progress')"
            :style="{ '--fill': `${progressPercent(device)}%` }"
            title="拖动调整它的播放进度"
            @input="onSliderInput(device, 'progress', $event)"
            @change="onSliderCommit(device, 'progress', $event)"
          />
          <span class="time">{{ durationText(device) }}</span>
        </div>

        <!-- 本机：进度只读展示（真正的拖动在底部播放条上），让卡片不空一块。 -->
        <div v-if="isSelf(device) && device.state?.track" class="control progress">
          <span class="time">{{ positionText(device) }}</span>
          <span class="static-bar" title="本机播放进度（可在底部播放条上拖动）">
            <span class="static-fill" :style="{ width: `${progressPercent(device)}%` }" />
          </span>
          <span class="time">{{ durationText(device) }}</span>
        </div>

        <!--
          音量是**设备**自己的属性，与在放什么无关：它只是没在放歌，不代表不需要合适的响度，
          所以这一行不跟着「有内容」一起藏起来。
        -->
        <div v-if="!isSelf(device)" class="control volume">
          <span class="vol-icon" :title="`调整「${device.name}」的音量`">
            <AppIcon :name="volumeIcon(device)" :size="14" />
          </span>
          <input
            class="slider"
            type="range"
            min="0"
            max="1"
            step="0.02"
            :value="sliderValue(device, 'volume')"
            :style="{ '--fill': `${volumePercent(device)}%` }"
            :title="`调整「${device.name}」的音量`"
            @input="onSliderInput(device, 'volume', $event)"
            @change="onSliderCommit(device, 'volume', $event)"
          />

          <!-- 行尾两个图标：左边的就是「它现在用的模式」，右边是它的播放列表。 -->
          <button
            v-if="!isRoomSeat(device)"
            type="button"
            class="btn-icon mini"
            :class="{
              'is-active': float?.kind === 'mode' && float.deviceId === device.deviceId,
            }"
            data-float-toggle
            :title="modeHint(device)"
            @click="toggleFloat('mode', device, $event)"
          >
            <AppIcon :name="modeIconOf(device)" :size="15" />
          </button>
          <button
            v-if="!isRoomSeat(device)"
            type="button"
            class="btn-icon mini"
            :class="{
              'is-active': float?.kind === 'queue' && float.deviceId === device.deviceId,
            }"
            data-float-toggle
            :title="
              device.state?.queueLength
                ? `查看并调整「${device.name}」的播放列表（${device.state.queueLength} 首）`
                : `查看并调整「${device.name}」的播放列表`
            "
            @click="toggleFloat('queue', device, $event)"
          >
            <AppIcon name="list" :size="15" />
          </button>
        </div>

        <!--
          远程操作：只对别的设备。空着的设备恰恰最需要这几个入口，所以不再要求它有内容。
          一起听期间这一块只剩「让声音切到这台」：内容控制归房间。
        -->
        <footer
          v-if="!isSelf(device) && (!roomActive || !isRoomSeat(device))"
          class="card-foot"
        >
          <template v-if="roomActive">
            <button
              type="button"
              class="btn dev-btn"
              :disabled="seating"
              :title="`把一起听的播放转到「${device.name}」，本机改为只看`"
              @click="takeSeatThere(device)"
            >
              {{ seating ? '正在切换…' : '让声音切到这台' }}
            </button>
          </template>
          <template v-else>
            <button
              v-if="canFollowTarget(device)"
              type="button"
              class="btn dev-btn"
              :class="{ 'is-active': devices.following === device.deviceId }"
              :title="followHint(device)"
              @click="toggleFollow(device)"
            >
              {{ devices.following === device.deviceId ? '停止跟随' : '跟随它' }}
            </button>
            <button
              type="button"
              class="btn dev-btn"
              :class="{ 'is-active': device.state?.following === devices.selfId }"
              :title="requestFollowHint(device)"
              @click="toggleRequestFollow(device)"
            >
              跟随我
            </button>
            <button
              v-if="canCast(device)"
              type="button"
              class="btn dev-btn"
              :title="castHint(device)"
              @click="activate(device)"
            >
              播到这台
            </button>
          </template>
        </footer>

        <p v-if="isSelf(device)" class="self-hint">
          这台就是当前设备 · 改名后别人的设备列表会跟着变
        </p>
      </article>
    </div>

    <p class="footnote">
      遥控与投放都不搬运音频：接管的设备会自己向服务器取流。队列与跟随关系都随指令一起过去。
    </p>

    <!--
      浮层：模式菜单与播放列表共用，与播放条上那两个同一套长相。
      Teleport 到 body 是为了躲开卡片的 overflow 裁剪，位置由 toggleFloat 按按钮算。
    -->
    <Teleport to="body">
      <div
        v-if="float?.kind === 'mode'"
        ref="floatRef"
        class="dev-float dev-float-mode popover"
        :style="floatStyle"
        role="listbox"
      >
        <button
          v-for="item in MODE_ITEMS"
          :key="item.mode"
          type="button"
          class="dev-mode-item"
          :class="{ 'is-active': floatDevice?.state?.playMode === item.mode }"
          role="option"
          :aria-selected="floatDevice?.state?.playMode === item.mode"
          @click="selectMode(item.mode)"
        >
          <span class="dev-mode-icon"><AppIcon :name="item.icon" :size="15" /></span>
          <span class="dev-mode-copy">
            <span class="dev-mode-label">{{ item.label }}</span>
            <span class="muted dev-mode-hint">{{ item.hint }}</span>
          </span>
          <AppIcon
            v-if="floatDevice?.state?.playMode === item.mode"
            name="check"
            :size="14"
            :stroke-width="2.6"
          />
        </button>
      </div>

      <!-- 播放列表：表头（哪台设备、多少首）+ 可滚动列表 + 底栏（追加本机当前） -->
      <div
        v-else-if="float?.kind === 'queue' && floatDevice"
        ref="floatRef"
        class="dev-float dev-float-queue popover"
        :style="floatStyle"
      >
        <header class="queue-head">
          <span class="queue-device">
            <span class="queue-badge">
              <AppIcon :name="iconOf(floatDevice)" :size="13" />
            </span>
            <span class="queue-head-copy">
              <span class="queue-title-line">
                <strong class="truncate">{{ floatDevice.name }}</strong>
                <span class="queue-pill">播放列表</span>
              </span>
              <span class="queue-sub">
                共 {{ floatQueue?.queue.length ?? floatDevice.state?.queueLength ?? 0 }} 首<template
                  v-if="floatQueue && floatQueue.index >= 0"
                >
                  · 正在播第 {{ floatQueue.index + 1 }} 首</template
                >
              </span>
            </span>
          </span>
          <span class="queue-tools">
            <button
              type="button"
              class="queue-tool"
              title="重新读取对方的播放列表"
              @click="refreshQueue"
            >
              <AppIcon name="refresh" :size="14" />
            </button>
            <button type="button" class="queue-tool" title="收起" @click="float = null">
              <AppIcon name="close" :size="14" />
            </button>
          </span>
        </header>

        <div class="dev-float-body queue-body">
          <div v-if="!floatQueue" class="queue-empty">
            <span class="queue-empty-icon"><AppIcon name="refresh" :size="18" class="spin" /></span>
            <p>正在读取对方的播放列表…</p>
            <span>对方版本较旧时可能读不到</span>
          </div>
          <div v-else-if="floatQueue.queue.length === 0" class="queue-empty">
            <span class="queue-empty-icon"><AppIcon name="list" :size="18" /></span>
            <p>对方的播放列表是空的</p>
            <span>可以把本机正在播放的加进去</span>
          </div>
          <ol v-else class="queue-list">
            <li v-for="(track, i) in floatQueue.queue" :key="`${track.key}-${i}`">
              <div class="queue-row" :class="{ 'is-current': i === floatQueue.index }">
                <button
                  type="button"
                  class="queue-main"
                  :title="`让「${floatDevice.name}」播放「${track.title}」`"
                  @click="playRemoteAt(i)"
                >
                  <span class="queue-cover">
                    <img v-if="track.cover" :src="cachedImage(track.cover)" alt="" loading="lazy" />
                    <AppIcon v-else name="music" :size="15" :stroke-width="1.5" />
                    <span v-if="i === floatQueue.index" class="queue-eq" aria-hidden="true">
                      <i /><i /><i />
                    </span>
                  </span>
                  <span class="queue-copy">
                    <span class="truncate queue-name">{{ track.title }}</span>
                    <span class="truncate queue-artist">{{ track.artists }}</span>
                  </span>
                  <span class="queue-time">{{ formatTime(track.durationMs / 1000) }}</span>
                </button>
                <button
                  type="button"
                  class="queue-remove"
                  :title="`从「${floatDevice.name}」的播放列表移除「${track.title}」`"
                  @click="removeRemoteAt(i)"
                >
                  <AppIcon name="close" :size="12" />
                </button>
              </div>
            </li>
          </ol>
        </div>

        <footer class="queue-foot">
          <button
            type="button"
            class="queue-add"
            :disabled="!player.current"
            :title="
              player.current
                ? `把本机正在播放的「${player.current.title}」加到对方的播放列表`
                : '本机没有在放歌'
            "
            @click="addCurrentToRemote"
          >
            <AppIcon name="plus" :size="14" />
            <span class="truncate">
              {{ player.current ? `加入「${player.current.title}」` : '本机没有在放歌' }}
            </span>
          </button>
        </footer>
      </div>
    </Teleport>

    <!-- 改名弹窗：卡片里塞输入框会把布局挤乱，单独一个弹窗更省事。 -->
    <Teleport to="body">
      <div v-if="renaming" ref="renameRef" class="dev-mask" @click.self="renaming = false">
        <div class="dev-modal" role="dialog" aria-modal="true" aria-label="给这台设备改名">
          <header class="dev-modal-head">
            <div>
              <p class="eyebrow">设备名</p>
              <h2>给这台设备改名</h2>
            </div>
            <button type="button" class="btn-icon" title="关闭（Esc）" @click="renaming = false">
              <AppIcon name="close" :size="15" />
            </button>
          </header>

          <label class="dev-field">
            <span class="field-label">设备名称</span>
            <input
              ref="nameInput"
              v-model="draftName"
              class="input"
              :maxlength="40"
              placeholder="给这台设备起个名字"
              @keyup.enter="commitRename"
            />
          </label>

          <p class="dev-modal-tip muted">
            名字会显示在同账号其它设备的列表里，保存后会重新连接一次设备服务。
          </p>

          <footer class="dev-modal-foot">
            <button type="button" class="btn btn-ghost" @click="renaming = false">取消</button>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="!draftName.trim()"
              @click="commitRename"
            >
              保存
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.devices-view {
  display: flex;
  max-width: 1240px;
  margin: 0 auto;
  flex-direction: column;
  gap: 16px;
  animation: fade-up var(--dur-slow) var(--ease);
}

/* ---------------- 顶部 ---------------- */

.hero {
  position: relative;
  display: flex;
  overflow: hidden;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 26px 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(600px 240px at 6% 0%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 70%),
    linear-gradient(140deg, var(--surface-strong), color-mix(in srgb, var(--surface) 45%, transparent));
  box-shadow: var(--shadow-sm);
}

/* 顶部的装饰光斑：纯粹的观感，不加任何信息。 */
.hero-glow {
  position: absolute;
  top: -90px;
  right: -60px;
  width: 280px;
  height: 280px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent-2) 30%, transparent), transparent 68%);
  pointer-events: none;
}

.hero-main {
  position: relative;
  min-width: 0;
}

.hero h1 {
  margin-top: 4px;
  font-size: 27px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.hero-desc {
  max-width: 560px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.75;
}

.hero-side {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.stats {
  display: flex;
  gap: 8px;
}

.stat {
  display: flex;
  min-width: 62px;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}

.stat strong {
  font-size: 19px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.stat span {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 650;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.hero-btn {
  height: 28px;
  padding: 0 12px;
  font-size: 11.5px;
}

.chip.warn {
  border-color: color-mix(in srgb, #e0453a 35%, transparent);
  color: #e0453a;
}

/* ---------------- 提示条 ---------------- */

.banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 12px;
}

.banner.follow {
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.banner.room {
  border-style: dashed;
}

.banner-icon {
  display: grid;
  width: 22px;
  height: 22px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.banner-btn {
  height: 26px;
  margin-left: auto;
  padding: 0 11px;
  font-size: 11px;
}

/* ---------------- 设备卡片 ---------------- */

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(352px, 1fr));
  align-items: stretch;
  gap: 14px;
}

.dev-card {
  position: relative;
  display: flex;
  overflow: hidden;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--surface-strong) 86%, transparent),
    color-mix(in srgb, var(--surface) 58%, transparent)
  );
  box-shadow: var(--shadow-sm);
  transition:
    transform var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.dev-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-3px);
  box-shadow: var(--shadow-md);
}

/* 正在出声的那台：留一圈强调色，扫一眼就知道声音从哪儿来。 */
.dev-card.is-playing {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  box-shadow: 0 22px 44px -30px color-mix(in srgb, var(--accent) 90%, transparent);
}

/* 正在跟随的那台：左侧一道竖线。 */
.dev-card.is-following {
  border-color: color-mix(in srgb, var(--accent) 42%, transparent);
  box-shadow: inset 2px 0 0 var(--accent);
}

/* 本机没什么可控制的，弱化成一圈虚线，视觉上退到后面去。 */
.dev-card.is-self {
  border-style: dashed;
  background: color-mix(in srgb, var(--surface) 34%, transparent);
  box-shadow: none;
}

/* 离线：整张卡退后一层，但仍可悬停看清细节。 */
.dev-card.is-offline {
  opacity: 0.72;
}

.dev-card.is-offline:hover {
  opacity: 1;
}

/* 封面本身的模糊底光：有封面才出现，透明度压得很低，只做氛围。 */
.art-glow {
  position: absolute;
  top: -70px;
  right: -40px;
  left: -40px;
  height: 210px;
  background-image: var(--art);
  background-position: center 30%;
  background-size: cover;
  filter: blur(42px) saturate(1.2);
  opacity: 0.28;
  pointer-events: none;
}

.dev-card > *:not(.art-glow) {
  position: relative;
  z-index: 1;
}

.card-head {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.kind-badge {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-muted);
}

.head-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.dev-name {
  min-width: 0;
  font-size: 13.5px;
  font-weight: 720;
  letter-spacing: -0.01em;
}

.meta-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 10.5px;
}

/* 名称/形态那一行里的文字要能被压缩，否则标签一多就把整行顶出去。 */
.meta-line > .truncate {
  min-width: 0;
}

.online-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--border-strong);
}

.online-dot.on {
  background: #4caf7d;
  box-shadow: 0 0 0 3px color-mix(in srgb, #4caf7d 20%, transparent);
}

.tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
}

.tag.accent {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  color: var(--accent);
}

.rename {
  width: 30px;
  height: 30px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

/* 头部右侧的播放键。 */
.transport {
  display: flex;
  margin-left: auto;
  flex: none;
  align-items: center;
  gap: 3px;
}

.skip {
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-muted);
}

.play-pill {
  display: inline-flex;
  height: 26px;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.play-pill.is-playing {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.play-pill:disabled,
.skip:disabled {
  opacity: 0.45;
}

/* ---------------- 正在播放 ---------------- */

.now {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 13px;
}

.now.is-empty {
  opacity: 0.86;
}

.cover {
  position: relative;
  display: grid;
  width: 84px;
  height: 84px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
  border-radius: 15px;
  background:
    radial-gradient(circle at 32% 26%, var(--accent-soft), transparent 64%),
    var(--surface);
  color: var(--text-faint);
  box-shadow: 0 14px 26px -18px rgba(0, 0, 0, 0.75);
  transition: box-shadow var(--dur) var(--ease);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 在放的那台：封面描一圈强调色。 */
.cover.is-playing {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 34%, transparent),
    0 16px 30px -18px color-mix(in srgb, var(--accent) 80%, transparent);
}

/* 三根跳动的音量条：不用文字也能看出「它在出声」。 */
.eq {
  position: absolute;
  right: 7px;
  bottom: 7px;
  display: flex;
  height: 14px;
  align-items: flex-end;
  gap: 2px;
  padding: 3px 4px;
  border-radius: 6px;
  background: rgba(10, 10, 14, 0.5);
  backdrop-filter: blur(3px);
}

.eq i {
  width: 2.5px;
  height: 100%;
  border-radius: 2px;
  background: #fff;
  transform-origin: bottom;
  animation: eq-bounce 900ms ease-in-out infinite;
}

.eq i:nth-child(2) {
  animation-delay: -0.3s;
}

.eq i:nth-child(3) {
  animation-delay: -0.6s;
}

@keyframes eq-bounce {
  0%,
  100% {
    transform: scaleY(0.32);
  }
  50% {
    transform: scaleY(1);
  }
}

.now-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.now-copy strong {
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.now-copy .artists {
  color: var(--text-muted);
  font-size: 11.5px;
}

.now-copy .album {
  color: var(--text-faint);
  font-size: 10.5px;
}

/* ---------------- 滑杆 ---------------- */

.control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.time {
  min-width: 34px;
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.control.progress .time:last-child {
  text-align: right;
}

.vol-icon {
  display: grid;
  width: 16px;
  flex: none;
  place-items: center;
  color: var(--text-faint);
}

/* 原生 range 差异太大，统一成「渐变填充 + 悬停才出现的小圆点」，与播放条一致。 */
.slider {
  --fill: 0%;
  height: 6px;
  flex: 1;
  min-width: 0;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 999px;
  background-image:
    linear-gradient(90deg, var(--accent), var(--accent-2)),
    linear-gradient(var(--border-strong), var(--border-strong));
  background-repeat: no-repeat;
  background-size:
    var(--fill) 100%,
    100% 100%;
  cursor: pointer;
  outline: none;
}

.slider::-webkit-slider-thumb {
  width: 11px;
  height: 11px;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 50%;
  background: #fff;
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.3),
    0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.slider:hover::-webkit-slider-thumb,
.slider:active::-webkit-slider-thumb,
.slider:focus-visible::-webkit-slider-thumb {
  opacity: 1;
  transform: none;
}

/* 本机的只读进度条：同一套配色，但不接受拖动。 */
.static-bar {
  position: relative;
  height: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border-strong);
}

.static-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 800ms linear;
}

.mini {
  width: 27px;
  height: 27px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.mini.is-active {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------------- 卡片底部 ---------------- */

.card-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
  padding-top: 11px;
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}

.dev-btn {
  height: 30px;
  flex: 1 1 auto;
  min-width: 68px;
  padding: 0 10px;
  font-size: 11.5px;
  font-weight: 650;
}

/* 跟随中：按钮本身要能表明「再点一下是取消」。 */
.dev-btn.is-active {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.self-hint {
  margin-top: auto;
  padding-top: 11px;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.6;
}

/* ---------------- 空状态与脚注 ---------------- */

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 60px 20px;
  text-align: center;
}

.empty-disc {
  display: grid;
  width: 84px;
  height: 84px;
  margin-bottom: 6px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background:
    radial-gradient(circle at 34% 28%, var(--accent-soft), transparent 62%),
    var(--surface);
  color: var(--text-faint);
}

.empty h2 {
  font-size: 15px;
  font-weight: 700;
}

.empty p {
  max-width: 440px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.footnote {
  padding: 0 4px;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.7;
}

/* ---------------- 浮层（模式 / 播放列表） ---------------- */

/* 外观（边框 / 圆角 / 实心底 / 投影）由 .popover 统一提供。 */
.dev-float {
  position: fixed;
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: fade-up var(--dur) var(--ease);
}

.dev-float-mode {
  width: 228px;
  max-width: calc(100vw - 16px);
  padding: 7px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.dev-float-queue {
  width: 332px;
  max-width: calc(100vw - 16px);
}

.dev-mode-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border-radius: 10px;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  transition: background var(--dur-fast) var(--ease);
}

.dev-mode-item:hover {
  background: var(--surface-hover);
}

.dev-mode-item.is-active {
  background: linear-gradient(135deg, var(--accent-soft), transparent 82%);
  color: var(--accent);
}

.dev-mode-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-muted);
}

.dev-mode-item:hover .dev-mode-icon {
  color: var(--text);
}

.dev-mode-item.is-active .dev-mode-icon {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.dev-mode-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
}

.dev-mode-label {
  font-weight: 650;
}

.dev-mode-hint {
  color: var(--text-faint);
  font-size: 10.5px;
}

/* ---------------- 播放列表：表头 ---------------- */

.queue-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 10px 11px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--accent) 8%, transparent),
    transparent 88%
  );
}

.queue-device {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.queue-badge {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-muted);
}

.queue-head-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.queue-title-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.queue-title-line strong {
  min-width: 0;
  font-size: 13px;
  font-weight: 720;
  letter-spacing: -0.01em;
}

.queue-pill {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 9px;
  font-weight: 700;
}

.queue-sub {
  color: var(--text-faint);
  font-size: 10.5px;
}

.queue-tools {
  display: flex;
  flex: none;
  gap: 2px;
}

.queue-tool {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 8px;
  color: var(--text-muted);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.queue-tool:hover {
  background: var(--surface-hover);
  color: var(--text);
}

/* ---------------- 播放列表：列表 ---------------- */

.dev-float-body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.queue-body {
  padding: 5px;
}

.queue-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 26px 16px;
  text-align: center;
}

.queue-empty-icon {
  display: grid;
  width: 42px;
  height: 42px;
  margin-bottom: 5px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  color: var(--text-faint);
}

.queue-empty p {
  color: var(--text-muted);
  font-size: 12px;
}

.queue-empty p + span {
  color: var(--text-faint);
  font-size: 10.5px;
}

.queue-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 3px;
  border-radius: 11px;
  transition: background var(--dur-fast) var(--ease);
}

.queue-row:hover {
  background: var(--surface-hover);
}

/* 正在播的那一行：整行淡淡染色，左缘再压一道竖线。 */
.queue-row.is-current {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--accent);
}

.queue-main {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 9px;
  padding: 5px 4px 5px 6px;
  text-align: left;
}

.queue-cover {
  position: relative;
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
  border-radius: 9px;
  background:
    radial-gradient(circle at 32% 26%, var(--accent-soft), transparent 66%),
    var(--surface);
  color: var(--text-faint);
}

.queue-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.queue-row.is-current .queue-cover {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

/* 正在播的那一首：封面盖一层暗罩 + 三根跳动的条。 */
.queue-eq {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  padding-bottom: 8px;
  background: rgba(10, 10, 14, 0.42);
  backdrop-filter: blur(1.5px);
}

.queue-eq i {
  width: 2.5px;
  height: 11px;
  border-radius: 2px;
  background: #fff;
  transform-origin: bottom;
  animation: eq-bounce 900ms ease-in-out infinite;
}

.queue-eq i:nth-child(2) {
  animation-delay: -0.3s;
}

.queue-eq i:nth-child(3) {
  animation-delay: -0.6s;
}

.queue-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
}

.queue-name {
  width: 100%;
  font-size: 12px;
  font-weight: 600;
}

.queue-row.is-current .queue-name {
  color: var(--accent);
}

.queue-artist {
  width: 100%;
  color: var(--text-faint);
  font-size: 10.5px;
}

.queue-time {
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

/* 移除键平时淡出，悬停或正在播的那行才露出来，列表看着更干净。 */
.queue-remove {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  border-radius: 7px;
  color: var(--text-faint);
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.queue-row:hover .queue-remove,
.queue-row.is-current .queue-remove,
.queue-remove:focus-visible {
  opacity: 1;
}

.queue-remove:hover {
  background: color-mix(in srgb, #e0453a 14%, transparent);
  color: #e0453a;
}

/* ---------------- 播放列表：底栏 ---------------- */

.queue-foot {
  flex: none;
  padding: 8px;
  border-top: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}

.queue-add {
  display: flex;
  width: 100%;
  height: 34px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px dashed color-mix(in srgb, var(--accent) 34%, var(--border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.queue-add:hover:not(:disabled) {
  border-style: solid;
  background: var(--accent-soft);
}

.queue-add:disabled {
  border-color: var(--border);
  background: transparent;
  color: var(--text-faint);
  opacity: 0.7;
}

/* ---------------- 改名弹窗 ---------------- */

.dev-mask {
  position: fixed;
  z-index: var(--z-overlay);
  display: grid;
  inset: 0;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(6px);
}

.dev-modal {
  display: flex;
  width: min(420px, 100%);
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background: var(--surface-strong);
  box-shadow: var(--shadow-lg);
  animation: fade-up var(--dur) var(--ease);
}

.dev-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dev-modal-head h2 {
  margin-top: 3px;
  font-size: 16px;
  font-weight: 750;
}

.dev-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dev-modal-tip {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
}

.dev-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .hero {
    align-items: flex-start;
  }

  .hero-side {
    align-items: flex-start;
  }

  .hero-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 900px) {
  .device-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 窄窗口：统计块藏起来，把宽度让给文字。 */
@media (max-width: 720px) {
  .stats {
    display: none;
  }

  .cover {
    width: 72px;
    height: 72px;
  }
}
</style>
