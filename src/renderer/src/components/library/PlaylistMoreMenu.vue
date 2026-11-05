<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import type { Playlist } from '@/api/types';

/**
 * 侧边栏歌单的「更多」菜单。
 *
 * 和曲目行一致：点行尾三点或右键都能开同一个菜单。这里自己管摆位与外部关闭，
 * 侧栏只负责记状态、执行动作。Teleport + fixed 免得被侧栏的 overflow 裁掉。
 */
const props = defineProps<{
  playlist: Playlist;
  /** 期望的左上角（视口坐标）；内部按实测尺寸夹进视口。 */
  x: number;
  y: number;
}>();

const emit = defineEmits<{
  close: [];
  open: [playlist: Playlist];
  edit: [playlist: Playlist];
  delete: [playlist: Playlist];
}>();

const MARGIN = 8;
const menuRef = ref<HTMLElement | null>(null);
/** 第一帧先藏起来，量完尺寸再显示，免得菜单先在 (x, y) 闪一下再跳到夹好的位置。 */
const style = ref<Record<string, string>>({
  left: `${props.x}px`,
  top: `${props.y}px`,
  visibility: 'hidden',
});

function place(): void {
  const rect = menuRef.value?.getBoundingClientRect();
  const width = rect?.width || 170;
  const height = rect?.height || 140;
  const left = Math.max(MARGIN, Math.min(props.x, window.innerWidth - width - MARGIN));
  const top = Math.max(MARGIN, Math.min(props.y, window.innerHeight - height - MARGIN));
  style.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    visibility: 'visible',
  };
}

function close(): void {
  emit('close');
}

function onOpen(): void {
  emit('open', props.playlist);
  close();
}

function onEdit(): void {
  emit('edit', props.playlist);
  close();
}

function onDelete(): void {
  emit('delete', props.playlist);
  close();
}

/** 菜单外按下 / Esc / 页面滚动 / 缩放都收起，菜单内部的交互不算。 */
function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest('.playlist-more-menu, .playlist-more-trigger')) {
    return;
  }
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // 捕获阶段拦下，别让全屏歌词页跟着一起关掉。
  event.stopImmediatePropagation();
  close();
}

function onViewportChange(event: Event): void {
  const target = event.target;
  if (target instanceof Element && target.closest('.playlist-more-menu')) return;
  close();
}

onMounted(async () => {
  document.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeydown, true);
  document.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
  await nextTick();
  place();
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  window.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="playlist-more-menu popover"
      :style="style"
      @contextmenu.prevent
    >
      <button type="button" class="menu-item" @click.stop="onOpen">
        <AppIcon name="list" :size="13" />打开歌单
      </button>
      <button type="button" class="menu-item" @click.stop="onEdit">
        <AppIcon name="edit" :size="13" />编辑信息
      </button>

      <div class="menu-divider" />

      <button type="button" class="menu-item danger" @click.stop="onDelete">
        <AppIcon name="close" :size="13" />删除歌单
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.playlist-more-menu {
  position: fixed;
  z-index: var(--z-overlay);
  display: flex;
  width: 170px;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
}

.menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 11px;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.menu-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.menu-item.danger {
  color: #e0453a;
}

.menu-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
</style>
