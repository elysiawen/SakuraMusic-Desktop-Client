import type { LyricResult, Platform, Quality, UnifiedTrack } from '@/api/types';
import type { RoomMember } from '@/api/rooms';
import type { PlayMode, RepeatMode } from '@/stores/player';

/** 房间镜像：顶部「一起听」徽标和悬浮窗要的字段，别的房间状态弹出窗口用不上。 */
export interface NowPlayingRoomSnapshot {
  code: string | null;
  members: RoomMember[];
  /** 本机是否只是旁观（决定徽标显不显示「一起听」）。 */
  spectating: boolean;
  /** 已经推演到快照时刻的秒数：弹出窗口不重复做服务端时钟推算。 */
  togetherSeconds: number;
  togetherSessionSeconds: number;
}

/**
 * 主窗口 → 弹出式播放窗口的播放快照。
 *
 * 只含 JSON 可序列化字段；跨进程走 unknown 传递（见 @shared/ipc 的
 * NowPlayingApi），两端各自用这个形状收窄。
 */
export interface NowPlayingSnapshot {
  /** 整条队列与指针：弹出窗口的播放列表面板要能看、能点、能删。 */
  queue: UnifiedTrack[];
  index: number;
  /** activeSource 是 pickSource 的确定性结果，镜像 preferredPlatform 即可复现。 */
  preferredPlatform: Platform | null;
  lyric: LyricResult;
  lyricLoading: boolean;
  loading: boolean;
  playing: boolean;
  /** 快照时刻的播放位置；弹出窗口用本地时钟插值出逐帧进度。 */
  time: number;
  duration: number;
  mode: PlayMode;
  repeat: RepeatMode;
  shuffle: boolean;
  volume: number;
  muted: boolean;
  quality: Quality;
  actualQuality: Quality | null;
  usingDirect: boolean;
  usingShared: boolean;
  audioCache: 'full' | null;
  /** 当前播放页样式 id，弹出窗口内换样式要同步回主窗口。 */
  nowPlayingMode: string;
  /** 一起听房间：徽标与悬浮窗（两人对置、本次/累计时长）都从这份镜像取。 */
  room: NowPlayingRoomSnapshot;
}
