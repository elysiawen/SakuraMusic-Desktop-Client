<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
// 品牌标识与侧边栏、安装包、任务栏同源。
import brandIcon from '../../../../../build/icon.png';
import { useThemeStore, type ThemeMode } from '@/stores/theme';

/**
 * 登录 / 连接服务器这类 bare 路由的顶栏。
 *
 * 这两页不经过 AppShell，而 Windows 下主窗口是 frame:false、没有系统标题栏：
 * 少了这条带子就既拖不动窗口，也没有最小化与关闭。这里只留未登录也用得上的东西
 * （品牌、外观切换、窗口按钮），搜索 / 账户 / 设置等入口等登录后再由主壳提供。
 */
defineProps<{ label: string }>();

const isMac = window.sakura.platform === 'darwin';
const theme = useThemeStore();

const modes: Array<{ value: ThemeMode; label: string; icon: string }> = [
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'system', label: '跟随系统', icon: 'monitor' },
];

/** 登录页进不了设置，明暗模式就在这条顶栏上直接轮换。 */
const currentMode = computed(() => modes.find((item) => item.value === theme.mode) ?? modes[0]);

function cycleMode(): void {
  const at = modes.findIndex((item) => item.value === theme.mode);
  const next = modes[(at + 1) % modes.length] ?? modes[0];
  if (next) theme.setMode(next.value);
}

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

onMounted(() => {
  if (isMac) return;
  void window.sakura.windowControls.isMaximized().then((value) => {
    maximized.value = value;
  });
  unsubscribeMaximized = window.sakura.windowControls.onMaximizedChange((value) => {
    maximized.value = value;
  });
});

onBeforeUnmount(() => unsubscribeMaximized?.());
</script>

<template>
  <header class="bare-titlebar drag" :class="{ 'is-mac': isMac }" @dblclick="toggleMaximize">
    <!-- 品牌区也留在拖动区里：整条顶栏按住就能挪窗口，只有右侧按钮不参与。 -->
    <div class="bare-brand">
      <img class="brand-mark" :src="brandIcon" alt="" draggable="false" />
      <span class="brand-text">Sakura Music</span>
      <span class="brand-divider" aria-hidden="true" />
      <span class="page-label">{{ label }}</span>
    </div>

    <div class="bare-actions no-drag" @dblclick.stop>
      <button
        class="btn-icon"
        type="button"
        :title="`外观：${currentMode?.label ?? ''}（点击切换）`"
        :aria-label="`外观：${currentMode?.label ?? ''}`"
        @click="cycleMode"
      >
        <AppIcon :name="currentMode?.icon ?? 'sun'" :size="16" />
      </button>

      <div v-if="!isMac" class="window-controls">
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
    </div>
  </header>
</template>

<style scoped>
.bare-titlebar {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: var(--z-chrome);
  display: flex;
  height: var(--titlebar-h);
  align-items: center;
  gap: 12px;
  padding: 0 14px 0 22px;
}

/* macOS 用系统红绿灯：顶栏整体从左上角让开，别把拖动区压在原生按钮上。 */
.bare-titlebar.is-mac {
  left: 78px;
  padding-left: 10px;
}

.bare-brand {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

/* 直接显示应用图标，不套渐变底板（与侧边栏一致）；投影跟着 alpha 走。 */
.brand-mark {
  width: 26px;
  height: 26px;
  flex: none;
  filter: drop-shadow(0 4px 9px rgba(15, 23, 42, 0.16));
  user-select: none;
}

.brand-text {
  color: var(--text);
  font-size: 13px;
  font-weight: 750;
  white-space: nowrap;
}

.brand-divider {
  width: 1px;
  height: 14px;
  flex: none;
  background: var(--border-strong);
}

.page-label {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bare-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 1px;
  margin-right: -2px;
  margin-left: 8px;
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

@media (max-width: 620px) {
  .brand-divider,
  .page-label {
    display: none;
  }
}
</style>
