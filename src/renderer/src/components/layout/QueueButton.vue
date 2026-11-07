<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { usePopoverDragGuard } from '@/composables/usePopoverDragGuard';
import { useUiStore } from '@/stores/ui';
import QueuePanel from './QueuePanel.vue';

/**
 * 播放队列按钮 + 浮层面板，自带「点击外部关闭」。
 *
 * 播放条（向上弹出）与全屏歌词顶栏（向下弹出）共用——两处各自写一遍关闭逻辑
 * 很容易只改一处，留下一个关不掉的浮层。
 */
const props = withDefaults(
  defineProps<{ placement?: 'up' | 'down'; size?: number; stageTone?: string }>(),
  { placement: 'up', size: 17, stageTone: undefined },
);

const ui = useUiStore();
/** 包裹按钮与面板，用来判断「这次点击是不是在浮层里面」。 */
const wrapRef = ref<HTMLElement | null>(null);

// 面板开着时标题栏不能当拖动区使，否则点它收不掉面板。
usePopoverDragGuard(() => ui.queueOpen);

function onDocumentPointerDown(event: PointerEvent): void {
  if (!ui.queueOpen) return;
  const wrap = wrapRef.value;
  if (wrap && event.target instanceof Node && wrap.contains(event.target)) return;
  ui.closeQueue();
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown));
</script>

<template>
  <div ref="wrapRef" class="queue-anchor">
    <button
      type="button"
      class="btn-icon"
      :class="{ 'is-active': ui.queueOpen }"
      :title="ui.queueOpen ? '收起播放队列' : '播放队列'"
      aria-label="播放队列"
      @click="ui.toggleQueue()"
    >
      <AppIcon name="queue" :size="props.size" />
    </button>
    <QueuePanel
      :open="ui.queueOpen"
      :placement="props.placement"
      :stage-tone="props.stageTone"
      @close="ui.closeQueue()"
    />
  </div>
</template>

<style scoped>
.queue-anchor {
  position: relative;
  display: flex;
  align-items: center;
}

/* 两个调用点都把按钮放在深色底上，选中态统一用强调色。 */
.queue-anchor :deep(.btn-icon.is-active) {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
