<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { formatTime } from '@/utils/format';

/**
 * 播放队列浮层。
 *
 * 右侧常驻面板去掉之后，队列需要一个新家：交给播放条上的按钮弹出来，
 * 和 web 端一样（`QueueButton` + `QueuePanel`）。
 *
 * 房间里 `player.queue` 已经被镜像成房间队列（见 `stores/room.ts`），所以照读即可；
 * 只是「放哪首、删哪首」要按房间语义提交给服务端。
 */
const props = withDefaults(defineProps<{ open: boolean; placement?: 'up' | 'down' }>(), {
  placement: 'up',
});
const emit = defineEmits<{ (event: 'close'): void }>();

const player = usePlayerStore();
const room = useRoomStore();
const listRef = ref<HTMLElement | null>(null);

const queue = computed(() => player.queue);

/** 打开时把当前播放项滚到可视区中间。 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    const container = listRef.value;
    const current = container?.querySelector<HTMLElement>('.queue-row.is-current');
    if (container && current) {
      container.scrollTop = Math.max(0, current.offsetTop - container.clientHeight / 2);
    }
  },
);

function playAt(position: number): void {
  if (room.seatActive) room.playAt(position);
  else void player.playAt(position);
}

function removeAt(position: number): void {
  if (room.seatActive) room.removeAt(position);
  else player.removeFromQueueAt(position);
}
</script>

<template>
  <Transition name="queue">
    <div v-if="open" class="queue-panel popover" :class="`is-${props.placement}`">
      <header class="queue-head">
        <div class="queue-head-copy">
          <strong>{{ room.seatActive ? '一起听队列' : '播放队列' }}</strong>
          <span class="muted">
            {{ queue.length }} 首
            <template v-if="player.current"> · 正在播放第 {{ player.index + 1 }} 首</template>
            <template v-if="room.seatActive"> · 双方共享</template>
          </span>
        </div>
        <div class="queue-head-actions">
          <!-- 房间队列由服务端权威维护，没有「清空」这个操作。 -->
          <button
            v-if="!room.seatActive"
            type="button"
            class="queue-text-btn"
            :disabled="queue.length === 0"
            @click="player.clearQueue()"
          >
            清空
          </button>
          <button type="button" class="btn-icon" title="关闭" @click="emit('close')">
            <AppIcon name="close" :size="16" />
          </button>
        </div>
      </header>

      <p v-if="room.seatActive" class="muted queue-room-hint">
        队列由房间共享：切歌、选歌、移除都会同步给对方。
      </p>

      <div ref="listRef" class="queue-list">
        <p v-if="queue.length === 0" class="muted queue-empty">队列是空的，去挑几首歌吧</p>

        <div
          v-for="(item, position) in queue"
          :key="`${item.key}-${position}`"
          class="queue-row"
          :class="{ 'is-current': position === player.index }"
          @click="playAt(position)"
        >
          <span class="queue-index">
            <AppIcon
              v-if="position === player.index && player.playing"
              name="volume"
              :size="14"
            />
            <template v-else>{{ position + 1 }}</template>
          </span>

          <span class="queue-cover">
            <img v-if="item.album.cover" :src="item.album.cover" alt="" />
            <AppIcon v-else name="music" :size="15" />
          </span>

          <div class="queue-copy">
            <div class="queue-title">
              <span class="truncate" :title="item.title">{{ item.title }}</span>
              <span v-if="item.vip" class="tag vip">VIP</span>
            </div>
            <span class="muted truncate" :title="item.album.name">
              {{ item.artists.map((artist) => artist.name).join(' / ') || item.album.name }}
            </span>
          </div>

          <span class="muted queue-duration">{{ formatTime(item.durationMs / 1000) }}</span>

          <button
            type="button"
            class="btn-icon queue-remove"
            title="从队列移除"
            @click.stop="removeAt(position)"
          >
            <AppIcon name="close" :size="14" />
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * 边框、圆角、背景、投影统一由 .popover 提供（见 styles/base.css）。
 * 那里是实心底：播放条自己带 backdrop-filter，子级面板的模糊会被吃掉，
 * 若再叠一层半透明，深色模式下就能清楚看到后面的封面。
 */
.queue-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 12px);
  z-index: 40;
  display: flex;
  width: min(390px, calc(100vw - 40px));
  max-height: min(58vh, 540px);
  flex-direction: column;
  padding: 14px 14px 8px;
}

/* 顶部锚点（全屏歌词的顶栏）向下弹，否则会顶出屏幕。 */
.queue-panel.is-down {
  top: calc(100% + 12px);
  bottom: auto;
}

.queue-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.queue-head-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.queue-head-copy strong {
  font-size: 13.5px;
  font-weight: 700;
}

.queue-head-copy .muted {
  font-size: 11.5px;
}

.queue-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.queue-text-btn {
  height: 26px;
  padding: 0 9px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
}

.queue-text-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.queue-text-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.queue-room-hint {
  margin: 8px 2px 0;
  font-size: 11.5px;
  line-height: 1.6;
}

.queue-list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 4px;
}

.queue-empty {
  padding: 26px 0;
  text-align: center;
  font-size: 12.5px;
}

.queue-row {
  display: grid;
  grid-template-columns: 22px 36px minmax(0, 1fr) auto 28px;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.16s ease;
}

.queue-row:hover {
  background: var(--surface-hover);
}

.queue-row.is-current {
  background: linear-gradient(135deg, var(--accent-soft), var(--accent-softer));
}

.queue-row.is-current .queue-index {
  color: var(--accent);
}

.queue-index {
  color: var(--text-faint);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.queue-cover {
  display: grid;
  width: 36px;
  height: 36px;
  overflow: hidden;
  place-items: center;
  border-radius: 9px;
  background: var(--surface);
  color: var(--text-faint);
}

.queue-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.queue-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.queue-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.queue-title .truncate {
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-copy .muted {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag.vip {
  flex: none;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: var(--radius-xs);
  color: var(--accent);
  font-size: 9px;
  font-weight: 650;
}

.queue-duration {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.queue-remove {
  width: 26px;
  height: 26px;
  opacity: 0;
  transition: opacity 0.16s ease;
}

.queue-row:hover .queue-remove {
  opacity: 1;
}

.queue-enter-active,
.queue-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.queue-enter-from,
.queue-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
