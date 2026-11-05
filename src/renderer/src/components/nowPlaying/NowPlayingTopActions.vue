<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import { useUiStore } from '@/stores/ui';
import NowPlayingModePicker from './NowPlayingModePicker.vue';
import QueueButton from '@/components/layout/QueueButton.vue';

/**
 * 全屏播放页顶栏的右侧操作区：所有播放页样式共享，唯一的一份。
 *
 * 播放页样式的约定是「一个文件自治整个页面」——背景、歌词排版、底部播放条
 * 都归样式自己发挥；唯独右上角这条（样式菜单 / 一起听 / 队列 / 窗口按钮）
 * 保持统一，新样式直接放 `<NowPlayingTopActions />`，不要自己重写。
 *
 * 窗口按钮只在 Windows/Linux 出现（macOS 的红绿灯在左边，由系统画）。
 */
const ui = useUiStore();
const router = useRouter();

const isMac = window.sakura.platform === 'darwin';
const maximized = ref(false);
let unsubscribeMaximized: (() => void) | null = null;

function minimize(): void {
  void window.sakura.windowControls.minimize();
}

async function toggleMaximize(): Promise<void> {
  if (isMac) return;
  maximized.value = await window.sakura.windowControls.toggleMaximize();
}

function close(): void {
  void window.sakura.windowControls.close();
}

function openTogether(): void {
  ui.closeLyrics();
  void router.push('/together');
}

onMounted(() => {
  if (!isMac) {
    void window.sakura.windowControls.isMaximized().then((value) => {
      maximized.value = value;
    });
    unsubscribeMaximized = window.sakura.windowControls.onMaximizedChange((value) => {
      maximized.value = value;
    });
  }
});

onBeforeUnmount(() => {
  unsubscribeMaximized?.();
});
</script>

<template>
  <div class="lyric-top-actions no-drag" @dblclick.stop>
    <!-- 样式菜单：注册表里有多少种播放页样式，这里就列多少种 -->
    <NowPlayingModePicker />
    <button type="button" class="btn-icon" title="一起听" @click="openTogether">
      <AppIcon name="users" :size="18" />
    </button>
    <!-- 队列：这里在页面顶部，面板必须向下弹 -->
    <QueueButton placement="down" :size="18" />

    <template v-if="!isMac">
      <span class="action-divider" aria-hidden="true" />
      <div class="window-controls">
        <button class="window-button" type="button" aria-label="最小化" @click="minimize">
          <AppIcon name="minimize" :size="15" />
        </button>
        <button
          class="window-button"
          type="button"
          :aria-label="maximized ? '还原' : '最大化'"
          @click="toggleMaximize"
        >
          <AppIcon :name="maximized ? 'restore' : 'maximize'" :size="13" />
        </button>
        <button class="window-button is-close" type="button" aria-label="关闭" @click="close">
          <AppIcon name="close" :size="15" />
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lyric-top-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 页面操作与窗口按钮之间的一道竖线 */
.action-divider {
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: var(--border-strong);
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 1px;
  margin-right: -2px;
}

.window-button {
  display: grid;
  width: 36px;
  height: 30px;
  place-items: center;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.window-button:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.window-button.is-close:hover {
  background: #e5484d;
  color: #fff;
}
</style>
