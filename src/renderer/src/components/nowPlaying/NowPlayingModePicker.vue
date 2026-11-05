<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useUiStore } from '@/stores/ui';
import { NOW_PLAYING_MODES, nowPlayingModeDef } from './nowPlayingModes';

/**
 * 全屏播放页样式选择器：注册表里的所有样式在顶栏直接点选。
 *
 * 弹层模式与 `QualityPicker` 一致：Teleport 到 body + fixed 摆位
 * （顶栏的层叠上下文压不住），外部点击 / Esc / 滚动即收起。
 * Esc 在捕获阶段拦下，免得连整个播放页一起被关掉。
 */
const ui = useUiStore();

const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

/** 与样式里的 `width: 208px` 保持一致（摆位要用）。 */
const MENU_WIDTH = 208;
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

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (wrapRef.value?.contains(target)) return;
  if (menuRef.value?.contains(target)) return;
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return;
  event.stopImmediatePropagation();
  open.value = false;
}

function onViewportScroll(event: Event): void {
  if (!open.value) return;
  if (event.target instanceof Node && menuRef.value?.contains(event.target)) return;
  open.value = false;
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
      <button
        v-for="mode in NOW_PLAYING_MODES"
        :key="mode.id"
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
  width: 208px;
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

.mode-option {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  color: var(--text);
  text-align: left;
  transition: background var(--dur-fast) var(--ease);
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
</style>
