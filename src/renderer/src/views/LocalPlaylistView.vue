<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import PageState from '@/components/common/PageState.vue';
import TrackList from '@/components/music/TrackList.vue';
import { libraryApi } from '@/api/library';
import type { Playlist, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const toast = useToast();

const playlistId = computed(() => String(route.params.id ?? ''));

const playlist = ref<Playlist | null>(null);
const items = ref<UnifiedTrack[]>([]);
const loading = ref(false);
const error = ref('');
const editing = ref(false);
const confirmingDelete = ref(false);
const nameDraft = ref('');
const descDraft = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  if (!playlistId.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await libraryApi.getPlaylist(playlistId.value);
    playlist.value = result.playlist;
    items.value = result.items;
  } catch (caught) {
    playlist.value = null;
    items.value = [];
    error.value = caught instanceof Error ? caught.message : '读取歌单失败';
  } finally {
    loading.value = false;
  }
}

watch(playlistId, load, { immediate: true });

function startEdit(): void {
  nameDraft.value = playlist.value?.name ?? '';
  descDraft.value = playlist.value?.description ?? '';
  editing.value = true;
}

async function saveEdit(): Promise<void> {
  const name = nameDraft.value.trim();
  if (!name) {
    toast.info('歌单名称不能为空');
    return;
  }

  busy.value = true;
  try {
    await library.updatePlaylist(playlistId.value, {
      name,
      description: descDraft.value.trim(),
    });
    if (playlist.value) {
      playlist.value = {
        ...playlist.value,
        name,
        description: descDraft.value.trim(),
      };
    }
    editing.value = false;
    toast.success('歌单已更新');
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '保存歌单失败');
  } finally {
    busy.value = false;
  }
}

async function removeTrack(track: UnifiedTrack): Promise<void> {
  try {
    await library.removeFromPlaylist(playlistId.value, track);
    items.value = items.value.filter((item) => item.key !== track.key);
    if (playlist.value) {
      playlist.value = { ...playlist.value, trackCount: Math.max(0, playlist.value.trackCount - 1) };
    }
    toast.info('已从歌单移除');
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '移除失败');
  }
}

async function removePlaylist(): Promise<void> {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }

  busy.value = true;
  try {
    await library.deletePlaylist(playlistId.value);
    toast.success('歌单已删除');
    void router.replace({ name: 'library' });
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '删除歌单失败');
    confirmingDelete.value = false;
  } finally {
    busy.value = false;
  }
}

function goBack(): void {
  if (window.history.length > 1) router.back();
  else void router.push({ name: 'library' });
}
</script>

<template>
  <div class="playlist-view">
    <button type="button" class="back" @click="goBack">
      <AppIcon name="prev" :size="13" />
      返回音乐库
    </button>

    <PageState :loading="loading" :error="error" text="正在读取歌单…" @retry="load" />

    <template v-if="!loading && !error && playlist">
      <header class="hero">
        <div class="cover">
          <img v-if="playlist.cover" :src="playlist.cover" alt="" />
          <AppIcon v-else name="list" :size="34" :stroke-width="1.3" />
        </div>

        <div class="hero-copy">
          <span class="chip">本地歌单</span>
          <h1>{{ playlist.name }}</h1>
          <p v-if="playlist.description" class="desc">{{ playlist.description }}</p>
          <div class="meta">
            <span>{{ playlist.trackCount }} 首</span>
            <span>更新于 {{ new Date(playlist.updatedAt).toLocaleDateString() }}</span>
          </div>

          <div class="actions">
            <button type="button" class="mini" @click="startEdit">重命名</button>
            <button
              type="button"
              class="mini danger"
              :disabled="busy"
              @click="removePlaylist"
            >
              {{ confirmingDelete ? '再点一次确认删除' : '删除歌单' }}
            </button>
            <button
              v-if="confirmingDelete"
              type="button"
              class="mini"
              @click="confirmingDelete = false"
            >
              取消
            </button>
          </div>
        </div>
      </header>

      <form v-if="editing" class="edit-form" @submit.prevent="saveEdit">
        <input v-model="nameDraft" class="edit-input" type="text" maxlength="60" placeholder="歌单名称" />
        <input
          v-model="descDraft"
          class="edit-input"
          type="text"
          maxlength="200"
          placeholder="描述（可选）"
        />
        <div class="edit-actions">
          <button type="submit" class="mini primary" :disabled="busy">保存</button>
          <button type="button" class="mini" @click="editing = false">取消</button>
        </div>
      </form>

      <TrackList
        :tracks="items"
        title="曲目"
        removable
        empty-text="这个歌单还是空的。在曲目行上点「…」可以加入歌单。"
        @remove="removeTrack"
      />
    </template>
  </div>
</template>

<style scoped>
.playlist-view {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  flex-direction: column;
  gap: 20px;
  animation: fade-up var(--dur-slow) var(--ease);
}

.back {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 11px;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.back:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.hero {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 24px 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(
      520px 220px at 6% 0%,
      color-mix(in srgb, var(--accent) 18%, transparent),
      transparent 72%
    ),
    linear-gradient(135deg, var(--surface-strong), color-mix(in srgb, var(--surface) 40%, transparent));
  box-shadow: var(--shadow-sm);
}

.cover {
  display: grid;
  width: 148px;
  height: 148px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: var(--text-faint);
  box-shadow: var(--shadow-md);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.hero-copy h1 {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.desc {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  color: var(--text-faint);
  font-size: 11px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 11px;
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
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.mini.danger {
  color: #e0453a;
}

.edit-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.edit-input {
  flex: 1;
  min-width: 160px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.edit-input:focus {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.edit-actions {
  display: flex;
  gap: 6px;
}
</style>
