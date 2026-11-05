import { computed, ref, type ComputedRef } from 'vue';
import type { DesktopConfig } from '@shared/ipc';

/**
 * 桌面歌词开关状态（主窗口侧）。
 *
 * 开关可能从三处改：播放条按钮、设置页、托盘菜单/歌词窗口按钮，
 * 所以以主进程的 `lyric:prefs` 广播为准，本地只是它的镜像。
 */
const config = ref<DesktopConfig | null>(null);
let initialized = false;

export function useDesktopLyric(): {
  enabled: ComputedRef<boolean>;
  toggle: () => Promise<void>;
} {
  if (!initialized) {
    initialized = true;
    void window.sakura
      .getConfig()
      .then((value) => {
        config.value = value;
      })
      .catch(() => undefined);
    window.sakura.lyric.onPrefs((value) => {
      config.value = value;
    });
  }

  const enabled = computed(() => config.value?.desktopLyric === true);

  async function toggle(): Promise<void> {
    // 重新打开时顺手解除锁定，免得窗口出现在奇怪状态。
    config.value = await window.sakura.updateConfig({
      desktopLyric: !enabled.value,
      lyricLocked: false,
    });
  }

  return { enabled, toggle };
}
