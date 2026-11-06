import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

/** 歌词页底部快捷键提示条的显示状态，关一次就记住。 */
const HINTS_STORAGE_KEY = 'sakura.desktop.lyric-hints';
/**
 * 全屏播放页样式 id，对应 `nowPlayingModes.ts` 注册表里的条目。
 * 这里只存字符串不校验：存档里留了已删除的样式 id 时，渲染层会回落到第一种。
 */
const MODE_STORAGE_KEY = 'sakura.desktop.now-playing-mode';
/**
 * 「弹出模式」是否开着：关掉独立窗口只是收面板，下次打开还是弹出；
 * 只有「缩回播放器」才清掉它。
 */
const POPPED_STORAGE_KEY = 'sakura.desktop.now-playing-popped';

function loadHintsVisible(): boolean {
  try {
    return localStorage.getItem(HINTS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function loadNowPlayingMode(): string {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) || 'classic';
  } catch {
    return 'classic';
  }
}

function loadNowPlayingPoppedOut(): boolean {
  try {
    return localStorage.getItem(POPPED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 桌面壳层的共享 UI 状态。
 *
 * 右侧那条常驻面板已经去掉：歌词改成与 web 端一致的全屏播放页（样式见 `nowPlaying/`），
 * 队列改成从播放条弹出的浮层面板（`QueuePanel.vue`）——所以这里不再有「页签」，
 * 只剩两个「开没开」的布尔值。
 */
export const useUiStore = defineStore('ui', () => {
  /** 全屏歌词覆盖层。 */
  const lyricsOpen = ref(false);
  /** 播放队列浮层（播放条右侧按钮 / 队列按钮打开）。 */
  const queueOpen = ref(false);
  /** 歌词页底部的快捷键提示条：默认显示，用户关掉后不再冒出来。 */
  const lyricHints = ref(loadHintsVisible());
  /** 全屏播放页样式 id（注册表见 `nowPlayingModes.ts`），样式菜单即时切换。 */
  const nowPlayingMode = ref(loadNowPlayingMode());
  /** 播放页是否处于「弹出模式」（见 POPPED_STORAGE_KEY 的注释）。 */
  const nowPlayingPoppedOut = ref(loadNowPlayingPoppedOut());

  watch(lyricHints, (visible) => {
    try {
      localStorage.setItem(HINTS_STORAGE_KEY, visible ? 'on' : 'off');
    } catch {
      // 隐私模式下写不进去：本次会话照样生效，只是记不住。
    }
  });

  watch(nowPlayingMode, (mode) => {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // 同上：存储不可用不影响当次切换。
    }
  });

  watch(nowPlayingPoppedOut, (popped) => {
    try {
      localStorage.setItem(POPPED_STORAGE_KEY, popped ? '1' : '0');
    } catch {
      // 同上：存储不可用不影响当次切换。
    }
  });

  function setLyricHints(visible: boolean): void {
    lyricHints.value = visible;
  }

  function setNowPlayingMode(mode: string): void {
    nowPlayingMode.value = mode;
  }

  function openLyrics(): void {
    lyricsOpen.value = true;
    // 两个浮层不同时开：队列会盖在歌词上，看着像没关掉。
    queueOpen.value = false;
  }

  function closeLyrics(): void {
    lyricsOpen.value = false;
  }

  function toggleLyrics(): void {
    if (lyricsOpen.value) closeLyrics();
    else openLyrics();
  }

  function toggleQueue(): void {
    queueOpen.value = !queueOpen.value;
  }

  function closeQueue(): void {
    queueOpen.value = false;
  }

  function focusGlobalSearch(): void {
    window.dispatchEvent(new CustomEvent('sakura:focus-search'));
  }

  return {
    lyricsOpen,
    queueOpen,
    lyricHints,
    nowPlayingMode,
    nowPlayingPoppedOut,
    setLyricHints,
    setNowPlayingMode,
    openLyrics,
    closeLyrics,
    toggleLyrics,
    toggleQueue,
    closeQueue,
    focusGlobalSearch,
  };
});
