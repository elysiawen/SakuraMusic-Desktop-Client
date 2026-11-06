import type { LyricResult, Platform, Quality, UnifiedTrack } from '@/api/types';
import type { PlayMode, RepeatMode } from '@/stores/player';

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
  audioCache: 'full' | 'partial' | null;
  /** 当前播放页样式 id，弹出窗口内换样式要同步回主窗口。 */
  nowPlayingMode: string;
}
