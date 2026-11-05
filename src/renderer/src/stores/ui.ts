import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

/** 歌词页底部快捷键提示条的显示状态，关一次就记住。 */
const HINTS_STORAGE_KEY = 'sakura.desktop.lyric-hints';

function loadHintsVisible(): boolean {
  try {
    return localStorage.getItem(HINTS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * 桌面壳层的共享 UI 状态。
 *
 * 右侧那条常驻面板已经去掉：歌词改成与 web 端一致的全屏覆盖层（`LyricOverlay.vue`），
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

  watch(lyricHints, (visible) => {
    try {
      localStorage.setItem(HINTS_STORAGE_KEY, visible ? 'on' : 'off');
    } catch {
      // 隐私模式下写不进去：本次会话照样生效，只是记不住。
    }
  });

  function setLyricHints(visible: boolean): void {
    lyricHints.value = visible;
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
    setLyricHints,
    openLyrics,
    closeLyrics,
    toggleLyrics,
    toggleQueue,
    closeQueue,
    focusGlobalSearch,
  };
});
