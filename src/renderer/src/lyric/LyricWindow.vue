<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { DesktopConfig, DesktopLyricState } from '@shared/ipc';
import AppIcon from '@/components/common/AppIcon.vue';
import { activeLineIndex } from '@/utils/lyric';

/**
 * 桌面歌词窗口（独立 BrowserWindow，透明置顶）。
 *
 * 数据全靠主进程转发的一帧帧快照：拿到「位置 + 时间戳」后本地自走，
 * 不与主窗口保持高频同步。鼠标穿透（锁定）由主进程按配置直接作用于窗口。
 */

const state = ref<DesktopLyricState | null>(null);
const prefs = ref<DesktopConfig | null>(null);
/** rAF 驱动的当前时刻，用来从快照位置推出实时位置。 */
const now = ref(Date.now());

let raf = 0;
const offs: Array<() => void> = [];

const position = computed(() => {
  const snapshot = state.value;
  if (!snapshot) return 0;
  return snapshot.position + (snapshot.playing ? (now.value - snapshot.sentAt) / 1000 : 0);
});

const lines = computed(() => state.value?.lines ?? []);
const activeIndex = computed(() => activeLineIndex(lines.value, position.value));
const currentLine = computed(() =>
  activeIndex.value >= 0 ? lines.value[activeIndex.value] : undefined,
);

const hasTrack = computed(() => Boolean(state.value?.trackKey));
const showTrans = computed(() => prefs.value?.lyricShowTrans !== false);

const contentStyle = computed(() => ({
  fontSize: `${prefs.value?.lyricFontSize ?? 32}px`,
  color: prefs.value?.lyricColor ?? '#ffffff',
}));

/** 还没到第一句时拿标题顶上，纯音乐/无歌词时也显示标题。 */
const currentText = computed(() => {
  if (!hasTrack.value) return '';
  return currentLine.value?.text || `${state.value?.title ?? ''}`;
});
const currentTrans = computed(() =>
  showTrans.value ? currentLine.value?.trans : undefined,
);

function lock(): void {
  void window.sakura.updateConfig({ lyricLocked: true });
}

function close(): void {
  void window.sakura.updateConfig({ desktopLyric: false, lyricLocked: false });
}

function tick(): void {
  now.value = Date.now();
  raf = requestAnimationFrame(tick);
}

onMounted(async () => {
  try {
    state.value = await window.sakura.lyric.getState();
  } catch {
    state.value = null;
  }
  try {
    prefs.value = await window.sakura.getConfig();
  } catch {
    prefs.value = null;
  }
  offs.push(
    window.sakura.lyric.onState((snapshot) => {
      state.value = snapshot;
    }),
    window.sakura.lyric.onPrefs((config) => {
      prefs.value = config;
    }),
  );
  raf = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  for (const off of offs) off();
});
</script>

<template>
  <div class="lyric-window">
    <div class="stage" :style="contentStyle">
      <template v-if="hasTrack">
        <p class="line current">
          <span class="text">{{ currentText }}</span>
          <span v-if="currentTrans" class="trans">{{ currentTrans }}</span>
        </p>
      </template>
      <p v-else class="line placeholder">Sakura Music</p>
    </div>

    <div class="toolbar">
      <button type="button" title="锁定（鼠标穿透，托盘菜单可解锁）" @click="lock">
        <AppIcon name="lock" :size="13" />
      </button>
      <button type="button" title="关闭桌面歌词" @click="close">
        <AppIcon name="close" :size="13" />
      </button>
    </div>
  </div>
</template>

<style>
/* 歌词窗口整体透明：只让文字和悬停底板有颜色。 */
html,
body,
#app {
  margin: 0;
  background: transparent !important;
  overflow: hidden;
}
</style>

<style scoped>
.lyric-window {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  /* 整个窗口都是拖把手，锁定后由主进程改为鼠标穿透。 */
  -webkit-app-region: drag;
  user-select: none;
  cursor: move;
  transition: background 0.15s ease;
}

.lyric-window:hover {
  background: rgba(0, 0, 0, 0.32);
}

.stage {
  padding: 12px 32px 12px 28px;
  text-align: center;
  line-height: 1.45;
  font-weight: 600;
  /* 任何壁纸下都要看得清：深色描边 + 投影。 */
  text-shadow:
    0 0 6px rgba(0, 0, 0, 0.9),
    0 1px 2px rgba(0, 0, 0, 0.9),
    -1px 0 2px rgba(0, 0, 0, 0.6),
    1px 0 2px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}

.line {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line .trans {
  display: block;
  font-size: 0.62em;
  font-weight: 500;
  opacity: 0.85;
}

.line.placeholder {
  opacity: 0.45;
  font-weight: 500;
}

.toolbar {
  position: absolute;
  top: 6px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
  -webkit-app-region: no-drag;
}

.lyric-window:hover .toolbar {
  opacity: 1;
}

.toolbar button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  cursor: pointer;
}

.toolbar button:hover {
  background: rgba(255, 255, 255, 0.24);
}
</style>
