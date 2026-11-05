<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import type { Playlist } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';

/**
 * 新建歌单弹窗：名称 + 描述两个字段，与 web 端同一套表单。
 *
 * 之前音乐库里是一条内联输入框，只能填名字；描述要进歌单页再补，
 * 干脆照 web 做成弹窗，建完就直接进歌单页往里加歌。
 */
const props = withDefaults(defineProps<{ visible: boolean; defaultName?: string }>(), {
  defaultName: '',
});

const emit = defineEmits<{ close: []; created: [playlist: Playlist] }>();

const library = useLibraryStore();
const toast = useToast();

const name = ref('');
const description = ref('');
const submitting = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    name.value = props.defaultName;
    description.value = '';
    submitting.value = false;
    await nextTick();
    nameInput.value?.focus();
    nameInput.value?.select();
  },
);

async function submit(): Promise<void> {
  const value = name.value.trim();
  if (!value || submitting.value) return;
  submitting.value = true;
  try {
    const playlist = await library.createPlaylist(value, description.value.trim() || undefined);
    toast.success(`已创建「${playlist.name}」`);
    emit('created', playlist);
    emit('close');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建歌单失败');
  } finally {
    submitting.value = false;
  }
}

/** 焦点可能不在弹窗内，Esc 统一在窗口上监听。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.visible) emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div v-if="visible" class="overlay" @click.self="emit('close')">
    <div class="dialog glass-strong" role="dialog" aria-modal="true" aria-label="新建歌单">
      <header class="dialog-head">
        <div>
          <p class="eyebrow">新建歌单</p>
          <h2>整理你喜欢的歌</h2>
        </div>
        <button type="button" class="btn-icon" aria-label="关闭" @click="emit('close')">
          <AppIcon name="close" :size="15" />
        </button>
      </header>

      <label class="field">
        <span class="field-label">歌单名称</span>
        <input
          ref="nameInput"
          v-model="name"
          class="input"
          maxlength="60"
          placeholder="给歌单起个名字（1-60 字）"
          @keyup.enter="submit"
        />
      </label>

      <label class="field">
        <span class="field-label">描述（可选）</span>
        <textarea
          v-model="description"
          class="textarea"
          rows="5"
          maxlength="200"
          placeholder="写点什么，之后可以在歌单页看到"
        />
        <span class="counter">{{ description.length }} / 200</span>
      </label>

      <footer class="dialog-foot">
        <button type="button" class="mini" @click="emit('close')">取消</button>
        <button
          type="button"
          class="mini primary"
          :disabled="!name.trim() || submitting"
          @click="submit"
        >
          {{ submitting ? '创建中…' : '创建' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(6px);
}

.dialog {
  display: flex;
  width: min(420px, 100%);
  max-height: calc(100vh - 80px);
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  overflow-y: auto;
  border-radius: var(--radius-xl);
  animation: fade-up var(--dur) var(--ease);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dialog-head h2 {
  margin-top: 3px;
  font-size: 16px;
  font-weight: 750;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  line-height: 1.7;
  outline: none;
  resize: vertical;
}

.textarea:focus {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.counter {
  align-self: flex-end;
  color: var(--text-faint);
  font-size: 10.5px;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.mini {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 4px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.mini:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini:disabled {
  opacity: 0.55;
  cursor: default;
}

.mini.primary {
  border-color: transparent;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast);
}
</style>
