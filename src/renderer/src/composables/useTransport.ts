import type { Platform, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { usePlayerStore, type PlayMode } from '@/stores/player';
import { useRoomStore } from '@/stores/room';

/**
 * 播放传输控制的统一入口（与 Web 端同名同职责）。
 *
 * 一起听是**服务端权威**：房间里的点歌、换歌单、加队列、播放/暂停、切歌、拖进度、
 * 改播放模式都必须上报房间，由服务端改完广播回来，两端再一起镜像。
 *
 * 只动本机播放器会被 250ms 一次的镜像循环立刻拽回房间当前曲目 —— 用户看到的是
 * 「新歌加载一下，又无声无息跳回刚刚那首」，很容易被误认成「VIP 歌被跳过 / 共享没生效」。
 * 所以这些「用户意图」一律经过这里分发：占着席位时走 room store，否则走 player store。
 *
 * 判据用 `room.seatActive`：同一账号的第二台设备虽然在房间里，但属于旁观，
 * 播放不在这台机器上，那台就该用自己的播放器，不该去改房间状态。
 *
 * 反过来，镜像循环、恢复个人现场、远程控制指令落地这类「应用已有状态」的地方，
 * 必须直接用 player store 的原始方法，不能经过这里，否则会变成「上报操作」自我循环。
 */
export function useTransport() {
  const player = usePlayerStore();
  const room = useRoomStore();
  const toast = useToast();

  return {
    toggle: (): void => {
      if (room.seatActive) room.toggle();
      else player.toggle();
    },
    play: (): void => {
      if (room.seatActive) void room.act('play');
      else player.play();
    },
    pause: (): void => {
      if (room.seatActive) void room.act('pause');
      else player.pause();
    },
    next: (): void => {
      if (room.seatActive) room.next();
      else void player.next();
    },
    prev: (): void => {
      if (room.seatActive) room.prev();
      else void player.prev();
    },
    seek: (seconds: number): void => {
      if (room.seatActive) room.seek(seconds);
      else player.seek(seconds);
    },
    /** 队列面板点某一首：房间里由服务端决定，两端一起跳。 */
    playAt: (index: number): void => {
      if (room.seatActive) room.playAt(index);
      else void player.playAt(index);
    },
    /** 播放整个列表：房间里 = 整体替换房间队列，否则替换本机队列。 */
    playList: (list: UnifiedTrack[], startIndex = 0): void => {
      if (list.length === 0) return;
      if (room.seatActive) void room.act('setQueue', { queue: list, index: startIndex });
      else void player.playQueue(list, startIndex);
    },
    /**
     * 开始私人电台：本机占着「一起听」席位时互斥；旁观设备（同账号另一台在放）
     * 的播放器归自己用，不受影响。首页已取回的那批会整批入队，点开时不额外请求。
     */
    startRadio: async (platform: Platform, initialTracks: UnifiedTrack[] = []): Promise<void> => {
      if (room.seatActive) {
        toast.error('本机正在「一起听」中，请先退出再使用私人电台');
        return;
      }
      await player.startRadio(platform, initialTracks);
    },
    /** 播放单曲：房间里 = 点歌并播放（服务端把它加入房间队列并跳过去）。 */
    playTrack: (track: UnifiedTrack, list?: UnifiedTrack[]): void => {
      if (room.seatActive) void room.act('playNow', { track });
      else void player.playTrack(track, list);
    },
    /**
     * 「下一首播放」/「加入队列」。
     *
     * 房间的 action 里没有「插到下一首」这个语义，只有追加到队尾的 `add`，
     * 所以房间里降级成「加入一起听队列」——至少歌会进共享队列，而不是改一下本机
     * 就被镜像抹掉。跟 Web 端 `addToQueue` 的处理一致。
     */
    enqueue: (track: UnifiedTrack): void => {
      if (room.seatActive) void room.act('add', { track });
      else player.enqueue(track);
    },
    /** 「下一首播放」：房间外插到当前曲目之后，房间内退化为入队。 */
    playNext: (track: UnifiedTrack): void => {
      if (room.seatActive) void room.act('add', { track });
      else player.playNext(track);
    },
    /** 播放模式是房间共享状态：只改本机的话，播完往哪走两端会岔开。 */
    setPlayMode: (mode: PlayMode): void => {
      if (room.seatActive) void room.act('setMode', { mode });
      else player.setMode(mode);
    },
  };
}
