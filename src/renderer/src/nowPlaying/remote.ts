import type { Quality } from '@/api/types';
import { router } from '@/router';
import { usePlayerStore } from '@/stores/player';
import { useUiStore } from '@/stores/ui';
import type { NowPlayingCommand } from '@shared/ipc';
import type { NowPlayingSnapshot } from './types';

/**
 * 弹出式播放窗口的「镜像桥」（弹出窗口侧）。
 *
 * 音频与真实播放器都留在主窗口：这里把 player store 改造成一面镜子——
 * 主窗口的快照（np:state）进来就刷状态，播放动作改成发命令（np:command）
 * 回主窗口执行。逐帧进度（preciseTime）在两次快照之间用本地时钟插值，
 * 逐字擦除才够顺；频谱（attachAnalyser）拿不到主窗口的音频图，返回 null
 * 让沉浸样式的可视化退化为模拟波形。
 */
export function initNowPlayingRemote(): void {
  const player = usePlayerStore();
  const ui = useUiStore();

  // 镜像 store 不落盘：localStorage 两个窗口共享，写下去会把主窗口的现场顶掉。
  player.setPersistencePaused(true);
  // 播放页组件以 `ui.lyricsOpen` 为显示门槛；镜像窗口里它恒为开。
  ui.lyricsOpen = true;

  /** 进度锚点：快照之间按本地时钟插值（见 preciseTime 覆写）。 */
  let anchorTime = 0;
  let anchorPlaying = false;
  let anchorAt = performance.now();
  /** 上一拍队列的指纹（指针 + 各曲 key）：没变就不换引用。 */
  let queueSig = '';

  function apply(raw: unknown): void {
    const snap = raw as NowPlayingSnapshot | null;
    if (!snap || typeof snap !== 'object') return;

    // 队列与歌词是对象：快照每 250ms 都是新实例，内容没变就别换引用，
    // 否则 computed 每拍失效一次，歌词还要反复重排。
    const nextSig = `${snap.index}|${snap.queue.map((item) => item.key).join(',')}`;
    if (nextSig !== queueSig) {
      queueSig = nextSig;
      // 队列整条镜像：播放列表面板能看能点，但点歌/删歌仍发命令回主窗口做。
      player.queue = snap.queue;
      player.index = snap.index;
    }
    player.preferredPlatform = snap.preferredPlatform;
    const lyric = player.lyric;
    if (
      lyric.lrc !== snap.lyric.lrc ||
      lyric.trans !== snap.lyric.trans ||
      lyric.roma !== snap.lyric.roma ||
      lyric.yrc !== snap.lyric.yrc ||
      lyric.qrc !== snap.lyric.qrc
    ) {
      player.lyric = snap.lyric;
    }
    player.lyricLoading = snap.lyricLoading;
    player.loading = snap.loading;
    player.playing = snap.playing;
    player.currentTime = snap.time;
    player.duration = snap.duration;
    player.repeat = snap.repeat;
    player.shuffle = snap.shuffle;
    player.volume = snap.volume;
    player.muted = snap.muted;
    player.quality = snap.quality;
    player.actualQuality = snap.actualQuality;
    player.usingDirect = snap.usingDirect;
    player.usingShared = snap.usingShared;
    player.audioCache = snap.audioCache;
    // 直接写 ref、不走 setNowPlayingMode：回声快照不该再发一遍换样式命令。
    ui.nowPlayingMode = snap.nowPlayingMode;

    anchorTime = snap.time;
    anchorPlaying = snap.playing;
    anchorAt = performance.now();
  }

  function send(command: NowPlayingCommand): void {
    window.sakura.nowPlaying.sendCommand(command);
  }

  /* ---- 播放动作「出嘴不出手」：本地只改镜子观感，真实动作发回主窗口 ---- */

  player.toggle = (): void => {
    anchorPlaying = !anchorPlaying;
    anchorAt = performance.now();
    player.playing = anchorPlaying;
    send({ type: 'toggle' });
  };

  player.play = (): void => {
    anchorPlaying = true;
    anchorAt = performance.now();
    player.playing = true;
    send({ type: 'play' });
  };

  player.pause = (): void => {
    anchorPlaying = false;
    anchorAt = performance.now();
    player.playing = false;
    send({ type: 'pause' });
  };

  player.next = async (): Promise<void> => {
    anchorTime = 0;
    anchorAt = performance.now();
    send({ type: 'next' });
  };

  player.prev = async (): Promise<void> => {
    anchorTime = 0;
    anchorAt = performance.now();
    send({ type: 'prev' });
  };

  player.seek = (seconds: number): void => {
    anchorTime = seconds;
    anchorAt = performance.now();
    player.currentTime = seconds;
    send({ type: 'seek', seconds });
  };

  player.setVolume = (value: number): void => {
    player.volume = Math.min(1, Math.max(0, value));
    send({ type: 'setVolume', value });
  };

  player.toggleMute = (): void => {
    player.muted = !player.muted;
    send({ type: 'toggleMute' });
  };

  player.cycleMode = (): void => {
    send({ type: 'cycleMode' });
  };

  player.setQuality = async (quality: Quality): Promise<void> => {
    send({ type: 'setQuality', quality });
  };

  player.playAt = async (at: number): Promise<void> => {
    player.index = at;
    player.playing = true;
    anchorTime = 0;
    anchorPlaying = true;
    anchorAt = performance.now();
    send({ type: 'playAt', index: at });
  };

  player.removeFromQueueAt = (at: number): void => {
    send({ type: 'removeFromQueueAt', index: at });
  };

  player.clearQueue = (): void => {
    send({ type: 'clearQueue' });
  };

  player.preciseTime = (): number => {
    const base = anchorPlaying ? anchorTime + (performance.now() - anchorAt) / 1000 : anchorTime;
    return player.duration > 0 ? Math.min(Math.max(base, 0), player.duration) : Math.max(base, 0);
  };

  player.attachAnalyser = (): AnalyserNode | null => null;

  /* ---- 壳层 UI：换样式同步回主窗口；「收起」（封面点击 / Esc）就是关掉自己 ----
   * 左上角的「缩回播放器」按钮不走这里：它发 popIn 命令（见 NowPlayingTopActions）。 */

  ui.setNowPlayingMode = (mode: string): void => {
    ui.nowPlayingMode = mode;
    send({ type: 'setNowPlayingMode', mode });
  };

  const closeSelf = (): void => {
    void window.sakura.nowPlaying.closeWindow();
  };
  ui.closeLyrics = closeSelf;
  ui.toggleLyrics = closeSelf;

  // 歌手/专辑链接在这里没有详情页可开：路由让给主窗口，自己随点击收起
  // （三个样式的链接都带 `ui.closeLyrics()`，也就是 closeSelf）。
  router.afterEach((to, from) => {
    if (to.fullPath === from.fullPath) return;
    send({ type: 'navigate', path: to.fullPath });
  });

  // 挂载即补齐：晚于主窗口首拍才加载出来也不丢，之后持续吃快照。
  void window.sakura.nowPlaying.getState().then(apply);
  window.sakura.nowPlaying.onState(apply);
}
