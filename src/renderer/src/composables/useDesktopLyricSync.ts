import { watch } from 'vue';
import type { DesktopLyricState } from '@shared/ipc';
import { usePlayerStore } from '@/stores/player';
import { activeLineIndex, parseLyric, type LyricLine } from '@/utils/lyric';

/**
 * 主窗口 → 桌面歌词窗口的播放状态同步。
 *
 * 歌词窗口拿到一帧快照后自己按时间戳往前走，所以这里只在「必须校准」时推：
 * 切歌、歌词加载完、播放/暂停、当前行变化、拖动进度（漂移 > 1.5s），
 * 外加播放中每 8s 一次的心跳纠偏。IPC 流量约等于每秒 0-1 条小消息。
 */
export function useDesktopLyricSync(): void {
  const player = usePlayerStore();

  let lines: LyricLine[] = [];
  let lastIndex = -2;
  let lastPosition = 0;
  let lastPushedAt = 0;

  function push(): void {
    const track = player.current;
    const snapshot: DesktopLyricState = {
      trackKey: track?.key ?? null,
      title: track?.title ?? '',
      artist: track?.artists.map((artist) => artist.name).join(' / ') ?? '',
      playing: player.playing,
      position: player.currentTime,
      sentAt: Date.now(),
      lines,
    };
    window.sakura.lyric.pushState(snapshot);
    lastPosition = snapshot.position;
    lastPushedAt = snapshot.sentAt;
    lastIndex = activeLineIndex(lines, snapshot.position);
  }

  watch(
    () => player.current?.key ?? null,
    () => {
      // 切歌瞬间旧歌词还没卸掉，先清空，避免新歌配旧词闪一帧。
      lines = [];
      push();
    },
  );

  watch(
    () => player.lyric,
    (lyric) => {
      lines = parseLyric(lyric.lrc, lyric.trans, lyric.roma);
      push();
    },
  );

  watch(
    () => player.playing,
    () => {
      if (player.current) push();
    },
  );

  watch(
    () => player.currentTime,
    (time) => {
      if (!player.current) return;
      const index = activeLineIndex(lines, time);
      const drift = Math.abs(time - (lastPosition + (Date.now() - lastPushedAt) / 1000));
      const stale = player.playing && Date.now() - lastPushedAt > 8000;
      if (index !== lastIndex || drift > 1.5 || stale) push();
    },
  );
}
