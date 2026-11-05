<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';
import PageState from '@/components/common/PageState.vue';
import PlaylistDialog from '@/components/library/PlaylistDialog.vue';
import TrackList from '@/components/music/TrackList.vue';
import { libraryApi } from '@/api/library';
import type { Playlist, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { cachedImage } from '@/utils/cacheImage';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const toast = useToast();

const playlistId = computed(() => String(route.params.id ?? ''));

const playlist = ref<Playlist | null>(null);
const items = ref<UnifiedTrack[]>([]);
const loading = ref(false);
const error = ref('');
/** 编辑信息 / 删除确认都走弹窗，和 web 端一致，不再用页内表单和「再点一次」。 */
const editOpen = ref(false);
const deleteOpen = ref(false);
const busy = ref(false);

const deleteMessage = computed(() => {
  const current = playlist.value;
  if (!current) return '';
  return `「${current.name}」以及里面的 ${current.trackCount} 首记录会一并移除，该操作不可恢复。`;
});

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

/** 弹窗保存成功后用返回值就地更新，不必为改个名字再拉一次详情。 */
function onSaved(input: { name: string; description: string }): void {
  if (playlist.value) playlist.value = { ...playlist.value, ...input };
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

/** 删除当前歌单；成功后回「音乐库」，避免停在一个已不存在的页面上。 */
async function confirmDelete(): Promise<void> {
  const current = playlist.value;
  if (!current) return;

  busy.value = true;
  try {
    await library.deletePlaylist(current.id);
    toast.success('歌单已删除');
    deleteOpen.value = false;
    void router.replace({ name: 'library' });
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '删除歌单失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="playlist-view">
    <PageState :loading="loading" :error="error" text="正在读取歌单…" @retry="load" />

    <template v-if="!loading && !error && playlist">
      <header class="hero">
        <div class="cover">
          <img v-if="playlist.cover" :src="cachedImage(playlist.cover)" alt="" />
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
            <button type="button" class="mini" @click="editOpen = true">编辑信息</button>
            <button type="button" class="mini danger" :disabled="busy" @click="deleteOpen = true">
              删除歌单
            </button>
          </div>
        </div>
      </header>

      <!-- 编辑信息与删除确认：与 web 端一样都是弹窗，页面里不再留表单 / 二次点击。 -->
      <PlaylistDialog
        :visible="editOpen"
        :playlist="playlist"
        @close="editOpen = false"
        @saved="onSaved"
      />
      <ConfirmDialog
        :visible="deleteOpen"
        title="删除歌单"
        :message="deleteMessage"
        confirm-label="删除"
        danger
        :busy="busy"
        @close="deleteOpen = false"
        @confirm="confirmDelete"
      />

      <TrackList
        :tracks="items"
        title="曲目"
        removable
        empty-text="这个歌单还是空的。在别的列表里右键曲目（或点行尾「…」），从「添加到歌单」加进来。"
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

.mini.danger {
  color: var(--danger);
}
</style>
