<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import QueueButton from '@/components/layout/QueueButton.vue';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useUiStore } from '@/stores/ui';
import ModePicker from './ModePicker.vue';
import { nowPlayingModeDef } from './nowPlayingModes';

/**
 * 全屏播放页的顶栏内容：左边「收起 + 播放状态徽标 + 弹出」，右边「样式菜单 /
 * 队列 / 窗口按钮」。所有播放页样式共享，唯一的一份。
 *
 * 播放页样式的约定是「一个文件自治整个页面」——背景、歌词排版、底部播放条
 * 都归样式自己发挥；唯独顶栏这条保持统一，新样式把 `<TopActions />`
 * 放进自己的 `<header class="... drag">` 就行，不要自己重写。样式自己的额外
 * 动作走 `#extra` 插槽，统一排在样式菜单左边。
 *
 * 根元素刻意不带 `no-drag`：两侧操作区之间的留白仍是窗口拖动区，标题栏上的
 * 双击最大化也照常；两个操作区各自 `no-drag` 并拦下双击，免得点按钮触发最大化。
 *
 * 窗口按钮只在 Windows/Linux 出现（macOS 的红绿灯在左边，由系统画）。
 */
const ui = useUiStore();
const player = usePlayerStore();
const room = useRoomStore();

const isMac = window.sakura.platform === 'darwin';
/** 弹出式播放窗口里不显示播放列表以外的页面动作。 */
const isPopOut = new URLSearchParams(window.location.search).get('window') === 'nowplaying';
const maximized = ref(false);
let unsubscribeMaximized: (() => void) | null = null;

/** 徽标文案的状态口径与各模式的播放按钮一致：占着一起听席位就看房间的状态。 */
const roomSeat = computed(() => room.seatActive);
const shownPlaying = computed(() => (roomSeat.value ? room.playing : player.playing));

/**
 * 收起按钮，覆盖层与弹出窗口共用（行为按窗口区分）：
 * 覆盖层里 =「收起歌词（Esc）」，关掉覆盖层而已；
 * 弹出窗口里 =「缩回播放器」——弹出模式结束，播放页回到主程序的覆盖层里。
 * 只关窗口（X / Esc）不算数：下次打开还是弹出。
 */
function collapse(): void {
  if (!isPopOut) {
    ui.closeLyrics();
    return;
  }
  // 缩回播放器：先告诉主窗口收摊（清弹出模式、开覆盖层），再关掉自己。
  window.sakura.nowPlaying.sendCommand({ type: 'popIn' });
  void window.sakura.nowPlaying.closeWindow();
}

/** 弹出为独立窗口：播放页全局只有一份，弹出后主窗口里的覆盖层随即收起。 */
async function popOut(): Promise<void> {
  // 先记住弹出模式：此后封面点击 / L 一律去独立窗口，不再叠覆盖层。
  ui.nowPlayingPoppedOut = true;
  await window.sakura.nowPlaying.open(nowPlayingModeDef(ui.nowPlayingMode).stageTone === 'dark');
  ui.closeLyrics();
}

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
  <!-- 根元素是标题栏的拖动区，两簇按钮各自 no-drag 接管点按 -->
  <div class="np-topbar">
    <div class="np-top-left no-drag" @dblclick.stop>
      <button
        type="button"
        class="btn-icon"
        :title="isPopOut ? '缩回播放器' : '收起歌词（Esc）'"
        @click="collapse"
      >
        <AppIcon :name="isPopOut ? 'pop-in' : 'chevron-down'" :size="isPopOut ? 18 : 20" />
      </button>
      <span class="np-badge">
        <span class="eq" :class="{ 'is-playing': shownPlaying }" aria-hidden="true">
          <i /><i /><i />
        </span>
        {{ roomSeat ? '一起听中' : shownPlaying ? '播放中' : '暂停' }}
      </span>
      <button
        v-if="!isPopOut"
        type="button"
        class="btn-icon"
        title="弹出为独立窗口"
        @click="popOut"
      >
        <AppIcon name="external" :size="18" />
      </button>
    </div>

    <div class="np-top-actions no-drag" @dblclick.stop>
      <!-- 样式自己的动作（如町景的取景）：排在样式菜单左边，以后有多余按钮就往这里加 -->
      <slot name="extra" />
      <!-- 样式菜单：注册表里有多少种播放页样式，这里就列多少种 -->
      <ModePicker />
      <!-- 队列：这里在页面顶部，面板必须向下弹（弹出窗口里也保留） -->
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
  </div>
</template>

<style scoped>
/* 整条顶栏内容铺满标题栏：两侧收着按钮，中间留白归拖动区。 */
.np-topbar {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 16px;
}

.np-top-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 播放状态徽标：常驻的「播放中 / 暂停 / 一起听中」小胶囊，带一个跳动的均衡器。 */
.np-badge {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 6px 14px 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-strong) 72%, transparent);
  backdrop-filter: blur(var(--glass-blur));
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.eq {
  display: inline-flex;
  height: 12px;
  align-items: flex-end;
  gap: 2.5px;
}

.eq i {
  width: 2.5px;
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
  transition: height 0.2s ease;
}

.eq.is-playing i {
  animation: eq-bounce 900ms ease-in-out infinite alternate;
}

.eq.is-playing i:nth-child(2) {
  animation-delay: 180ms;
}

.eq.is-playing i:nth-child(3) {
  animation-delay: 360ms;
}

@keyframes eq-bounce {
  from {
    height: 3px;
  }
  to {
    height: 12px;
  }
}

.np-top-actions {
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
