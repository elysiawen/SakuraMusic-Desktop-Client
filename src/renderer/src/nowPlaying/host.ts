import type { Quality } from '@/api/types';
import { useTransport } from '@/composables/useTransport';
import { router } from '@/router';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useUiStore } from '@/stores/ui';
import type { NowPlayingSnapshot } from './types';

/**
 * 弹出式播放窗口的「宿主桥」（主窗口侧）。
 *
 * 弹出窗口不持有音频：主窗口按节拍推快照（np:push），并执行弹出窗口发来的
 * 播放命令（np:command）。同时把「打开全屏歌词」的入口接管掉——弹出窗口开着
 * 时点封面 / 按 L 是把它叫到最前，而不是在主窗口里再叠一层覆盖层：
 * 播放页全局只有一份，要么弹出去了，要么在主程序里。
 */
export function initNowPlayingHost(): void {
  const player = usePlayerStore();
  const room = useRoomStore();
  const transport = useTransport();
  const ui = useUiStore();

  /** 独立播放窗口是否开着：决定快照要不要持续推、封面点击往哪走。 */
  let attached = false;
  let beat: number | undefined;

  function snapshot(): unknown {
    const state: NowPlayingSnapshot = {
      queue: player.queue,
      index: player.index,
      preferredPlatform: player.preferredPlatform,
      lyric: player.lyric,
      lyricLoading: player.lyricLoading,
      loading: player.loading,
      playing: player.playing,
      time: player.currentTime,
      duration: player.duration,
      mode: player.mode,
      repeat: player.repeat,
      shuffle: player.shuffle,
      volume: player.volume,
      muted: player.muted,
      quality: player.quality,
      actualQuality: player.actualQuality,
      usingDirect: player.usingDirect,
      usingShared: player.usingShared,
      audioCache: player.audioCache,
      nowPlayingMode: ui.nowPlayingMode,
    };
    // 过一道 JSON：顺手把响应式代理摊平，跨进程序列化万无一失。
    return JSON.parse(JSON.stringify(state));
  }

  function push(): void {
    window.sakura.nowPlaying.pushState(snapshot());
  }

  function startBeat(): void {
    if (beat !== undefined) return;
    // 250ms 一拍：进度在弹出窗口里由本地时钟插值，这里只对表。
    beat = window.setInterval(push, 250);
  }

  function stopBeat(): void {
    if (beat === undefined) return;
    window.clearInterval(beat);
    beat = undefined;
  }

  /* ---- 打开入口互斥：弹出模式下「打开全屏歌词」一律去独立窗口 ---- */

  ui.openLyrics = (): void => {
    // 弹出模式（窗口开着、或只是被 X 关掉了）：封面点击永远是独立窗口。
    if (attached || ui.nowPlayingPoppedOut) {
      // 已开着就是叫到最前，关着就重建——反正不再叠覆盖层。
      void window.sakura.nowPlaying.open();
      return;
    }
    ui.lyricsOpen = true;
    // 两个浮层不同时开：队列会盖在歌词上，看着像没关掉。
    ui.queueOpen = false;
  };

  ui.toggleLyrics = (): void => {
    if (attached || ui.nowPlayingPoppedOut) {
      void window.sakura.nowPlaying.open();
      return;
    }
    if (ui.lyricsOpen) ui.closeLyrics();
    else ui.openLyrics();
  };

  /* ---- 弹出窗口的命令在这里落地：真实动作做完立刻回一拍快照 ---- */

  window.sakura.nowPlaying.onCommand((command) => {
    // 弹出窗口的点击是「用户意图」：和主窗口的播放条一样走 transport 分发，
    // 一起听占着席位时落到 room，否则落到 player（见 useTransport 的说明）。
    switch (command.type) {
      case 'toggle':
        transport.toggle();
        break;
      case 'play':
        transport.play();
        break;
      case 'pause':
        transport.pause();
        break;
      case 'next':
        transport.next();
        break;
      case 'prev':
        transport.prev();
        break;
      case 'seek':
        transport.seek(command.seconds);
        break;
      case 'setVolume':
        player.setVolume(command.value);
        break;
      case 'toggleMute':
        player.toggleMute();
        break;
      case 'cycleMode':
        if (room.seatActive) room.cycleMode();
        else player.cycleMode();
        break;
      case 'setQuality':
        void player.setQuality(command.quality as Quality);
        break;
      case 'setNowPlayingMode':
        ui.setNowPlayingMode(command.mode);
        break;
      case 'playAt':
        transport.playAt(command.index);
        break;
      case 'removeFromQueueAt':
        if (room.seatActive) room.removeAt(command.index);
        else player.removeFromQueueAt(command.index);
        break;
      case 'clearQueue':
        // 房间队列由服务端权威维护，没有「清空」这个操作。
        if (!room.seatActive) player.clearQueue();
        break;
      case 'popIn':
        // 缩回播放器：弹出模式结束，播放页回到主程序的覆盖层里。
        // 直接写状态、不走 openLyrics——这时独立窗口还没关完，会被重新叫回去。
        ui.nowPlayingPoppedOut = false;
        ui.lyricsOpen = true;
        ui.queueOpen = false;
        break;
      case 'navigate':
        void router.push(command.path);
        break;
    }
    push();
  });

  window.sakura.nowPlaying.onOpenChange((open) => {
    attached = open;
    if (open) {
      // 开窗就推一拍，弹出窗口的首帧不用等下个节拍。
      push();
      startBeat();
    } else {
      stopBeat();
    }
  });

  // 宿主重挂时（理论上只有一次）别丢现状：窗口可能已经开着。
  void window.sakura.nowPlaying.isOpen().then((open) => {
    attached = open;
    if (open) startBeat();
  });
}
