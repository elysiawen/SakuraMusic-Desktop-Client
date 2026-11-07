<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { usePopoverDragGuard } from '@/composables/usePopoverDragGuard';
import { useUiStore } from '@/stores/ui';
import { NOW_PLAYING_MODES, nowPlayingModeDef, type NowPlayingModeDef } from './nowPlayingModes';

/**
 * 全屏播放页样式选择器：注册表里的所有样式在顶栏直接点选。
 *
 * 弹层模式与 `QualityPicker` 一致：Teleport 到 body + fixed 摆位
 * （顶栏的层叠上下文压不住），外部点击 / Esc 收起，滚动只重新贴位。
 * Esc 在捕获阶段拦下，免得连整个播放页一起被关掉。
 */
const ui = useUiStore();

const open = ref(false);
/** 正在给哪个样式开设置弹窗（注册表里挂了 settings 的样式才有）。 */
const settingsMode = ref<NowPlayingModeDef | null>(null);
const wrapRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

// 菜单或设置弹窗开着时标题栏不能当拖动区使，否则点它收不掉菜单。
usePopoverDragGuard(() => open.value || settingsMode.value !== null);

/** 菜单宽度：摆位和样式里都用它；有样式带设置按钮时放宽一点容下齿轮。 */
const MENU_WIDTH = NOW_PLAYING_MODES.some((mode) => mode.settings) ? 236 : 208;
const MENU_GAP = 8;

const menuStyle = ref<Record<string, string>>({});
const current = computed(() => nowPlayingModeDef(ui.nowPlayingMode));

function placeMenu(): void {
  const trigger = wrapRef.value?.querySelector<HTMLElement>('button');
  if (!trigger) return;

  const anchor = trigger.getBoundingClientRect();
  const gutter = 8;
  const width = Math.min(MENU_WIDTH, window.innerWidth - gutter * 2);
  const left = Math.max(
    gutter,
    Math.min(anchor.right - width, window.innerWidth - width - gutter),
  );
  menuStyle.value = {
    left: `${left}px`,
    width: `${width}px`,
    top: `${anchor.bottom + MENU_GAP}px`,
  };
}

function toggle(): void {
  open.value = !open.value;
  if (open.value) placeMenu();
}

function select(id: string): void {
  open.value = false;
  if (id !== ui.nowPlayingMode) ui.setNowPlayingMode(id);
}

/** 选项旁的设置按钮：收起菜单，弹出那个样式自己的设置面板。 */
function openSettings(mode: NowPlayingModeDef): void {
  open.value = false;
  settingsMode.value = mode;
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (wrapRef.value?.contains(target)) return;
  if (menuRef.value?.contains(target)) return;
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // 设置弹窗在最上面：Esc 先收它，别把播放页一起关掉
  if (settingsMode.value) {
    event.stopImmediatePropagation();
    settingsMode.value = null;
    return;
  }
  if (!open.value) return;
  event.stopImmediatePropagation();
  open.value = false;
}

/**
 * 任何滚动都只重新贴位、不收起：歌词换行时列表自己就在滚，一滚就收的话
 * 这个面板根本没法用。触发按钮在顶栏（fixed），重新贴位等于原地不动。
 */
function onViewportScroll(): void {
  if (open.value) placeMenu();
}

function onResize(): void {
  if (open.value) open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('scroll', onViewportScroll, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('scroll', onViewportScroll, true);
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div ref="wrapRef" class="mode-picker">
    <button
      type="button"
      class="btn-icon"
      :class="{ 'is-lit': open }"
      :title="`播放页样式：${current.name}（点击更换）`"
      @click="toggle"
    >
      <AppIcon :name="current.icon" :size="18" />
    </button>
  </div>

  <Teleport to="body">
    <div v-if="open" ref="menuRef" class="mode-menu popover" :style="menuStyle">
      <div v-for="mode in NOW_PLAYING_MODES" :key="mode.id" class="mode-row">
        <button
          type="button"
          class="mode-option"
          :class="{ 'is-active': mode.id === ui.nowPlayingMode }"
          @click="select(mode.id)"
        >
          <AppIcon :name="mode.icon" :size="15" class="mode-icon" />
          <span class="mode-copy">
            <strong>{{ mode.name }}</strong>
            <small>{{ mode.hint }}</small>
          </span>
          <AppIcon v-if="mode.id === ui.nowPlayingMode" name="check" :size="13" :stroke-width="2.6" />
        </button>
        <!-- 这个样式有自己的设置时才出现：点开它自己的设置面板 -->
        <button
          v-if="mode.settings"
          type="button"
          class="mode-gear"
          :title="`${mode.name}设置`"
          @click="openSettings(mode)"
        >
          <AppIcon name="settings" :size="14" />
        </button>
      </div>
    </div>
  </Teleport>

  <!-- 样式设置弹窗：外壳只是窗框，内容组件由各样式自己的文件提供 -->
  <Teleport to="body">
    <div v-if="settingsMode" class="mode-settings-overlay" @click.self="settingsMode = null">
      <div
        class="mode-settings"
        role="dialog"
        aria-modal="true"
        :aria-label="`${settingsMode.name}设置`"
      >
        <header class="mode-settings-head">
          <div>
            <p class="eyebrow">播放页样式</p>
            <h2>{{ settingsMode.name }}设置</h2>
          </div>
          <div class="mode-settings-side">
            <!-- 恢复默认的落点：各样式设置面板 Teleport 到这里，排在关闭按钮左边 -->
            <div class="mode-settings-actions"></div>
            <button type="button" class="btn-icon" aria-label="关闭" @click="settingsMode = null">
              <AppIcon name="close" :size="15" />
            </button>
          </div>
        </header>
        <div class="mode-settings-body">
          <component :is="settingsMode.settings" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mode-picker {
  display: flex;
  flex: none;
  align-items: center;
}

.mode-picker .is-lit {
  color: var(--accent);
}

/* 固定定位：位置由 placeMenu 按触发按钮的屏幕坐标算好。 */
.mode-menu {
  position: fixed;
  z-index: var(--z-overlay);
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  transform-origin: top center;
  animation: mode-pop var(--dur) var(--ease);
}

@keyframes mode-pop {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.mode-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.mode-option {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  color: var(--text);
  text-align: left;
  transition: background var(--dur-fast) var(--ease);
}

.mode-gear {
  display: grid;
  width: 26px;
  height: 26px;
  flex: none;
  place-items: center;
  border-radius: var(--radius-xs);
  color: var(--text-faint);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.mode-gear:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.mode-option:hover {
  background: var(--surface-hover);
}

.mode-option.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.mode-icon {
  flex: none;
  color: var(--text-faint);
}

.mode-option.is-active .mode-icon {
  color: var(--accent);
}

.mode-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}

.mode-copy strong {
  font-size: 12px;
  font-weight: 650;
}

.mode-copy small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ------------------------------ 样式设置弹窗（通用窗框） ------------------------------ */

.mode-settings-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(6px);
}

.mode-settings {
  display: flex;
  width: min(400px, 100%);
  max-height: min(560px, calc(100vh - 48px));
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  /* 遮罩层已经做过一次 backdrop blur，这里不再叠加，避免霓虹背景透出杂色。 */
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
  animation: fade-up var(--dur) var(--ease);
}

.mode-settings-head {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.mode-settings-head .eyebrow {
  margin: 0 0 2px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.mode-settings-head h2 {
  font-size: 16px;
  font-weight: 700;
}

.mode-settings-side {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.mode-settings-actions {
  display: flex;
  align-items: center;
}

/* 没有样式投来「恢复默认」时不留空档 */
.mode-settings-actions:empty {
  display: none;
}

.mode-settings-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
}
</style>
