<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { libraryApi } from '@/api/library';
import type { Playlist } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';

/**
 * 新建 / 编辑歌单信息，和 web 端一样共用一个弹窗：
 * 不传 `playlist` 是新建，传了就进入编辑模式（名称 + 描述一次改完）。
 */
const props = defineProps<{ visible: boolean; playlist?: Playlist | null }>();
const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'created', playlist: Playlist): void;
  (event: 'saved', input: { name: string; description: string }): void;
}>();

const toast = useToast();
const library = useLibraryStore();
const name = ref('');
const description = ref('');
const busy = ref(false);
const error = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

const isEdit = computed(() => !!props.playlist);

function close(): void {
  if (busy.value) return;
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (props.visible && event.key === 'Escape') close();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

/** 每次打开都从当前歌单重新取值，避免上次没保存的输入串到下一次。 */
watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    name.value = props.playlist?.name ?? '';
    description.value = props.playlist?.description ?? '';
    error.value = '';
    await nextTick();
    nameInput.value?.focus();
  },
);

async function submit(): Promise<void> {
  if (busy.value) return;
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = '给歌单起个名字吧';
    return;
  }

  busy.value = true;
  error.value = '';
  try {
    if (props.playlist) {
      const input = { name: trimmed, description: description.value.trim() };
      // store 会顺手把「我的音乐」列表里的名称同步掉；详情页再靠 saved 就地更新。
      await library.updatePlaylist(props.playlist.id, input);
      emit('saved', input);
      emit('close');
    } else {
      const result = await libraryApi.createPlaylist(trimmed, description.value.trim());
      toast.info(`已创建歌单「${result.playlist.name}」`);
      emit('created', result.playlist);
      emit('close');
      name.value = '';
      description.value = '';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : isEdit.value ? '保存失败' : '创建失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <!-- Teleport 到 body：页面容器有 fade-up 动画（transform），留在里面会让 fixed 遮罩跑偏。 -->
  <Teleport to="body">
    <div v-if="visible" class="overlay" @click.self="close">
      <div
        class="dialog glass-strong"
        role="dialog"
        aria-modal="true"
        :aria-label="isEdit ? '编辑歌单信息' : '新建歌单'"
      >
        <header class="dialog-head">
          <div>
            <p class="eyebrow">{{ isEdit ? '歌单信息' : '我的音乐' }}</p>
            <h2>{{ isEdit ? '编辑歌单信息' : '新建歌单' }}</h2>
          </div>
          <button type="button" class="btn-icon" aria-label="关闭" @click="close">
            <AppIcon name="close" :size="15" />
          </button>
        </header>

        <p class="desc">
          {{ isEdit ? '改个名字，顺手写两句简介。' : '给歌单起个名字，描述可以先空着。' }}
        </p>

        <form class="form" @submit.prevent="submit">
          <label class="field">
            <span>名称</span>
            <input
              ref="nameInput"
              v-model="name"
              type="text"
              maxlength="50"
              placeholder="比如：深夜通勤"
              :disabled="busy"
            />
          </label>

          <label class="field">
            <span>描述 <small>可选</small></span>
            <textarea
              v-model="description"
              rows="3"
              maxlength="200"
              placeholder="写点什么，方便以后想起这张歌单"
              :disabled="busy"
            />
          </label>

          <p v-if="error" class="error">{{ error }}</p>

          <div class="actions">
            <button type="button" class="mini" :disabled="busy" @click="close">取消</button>
            <button type="submit" class="mini primary" :disabled="busy || !name.trim()">
              {{ busy ? '保存中…' : isEdit ? '保存修改' : '创建歌单' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
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

.dialog-head .eyebrow {
  margin: 0 0 2px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.dialog-head h2 {
  font-size: 17px;
  font-weight: 700;
}

.desc {
  margin: -4px 0 2px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field > span {
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
}

.field small {
  color: var(--text-faint);
  font-weight: 500;
}

.field input,
.field textarea {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  outline: none;
  resize: vertical;
  transition: border-color var(--dur) var(--ease);
}

.field input:focus,
.field textarea:focus {
  border-color: var(--accent);
}

.field input::placeholder,
.field textarea::placeholder {
  color: var(--text-faint);
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 11.5px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 3px;
}

.mini {
  height: 32px;
  padding: 0 15px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.mini:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.mini.primary:hover:not(:disabled) {
  color: var(--accent-contrast);
  filter: brightness(1.06);
}

.mini:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
