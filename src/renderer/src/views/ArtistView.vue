<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import PageState from '@/components/common/PageState.vue';
import TrackList from '@/components/music/TrackList.vue';
import { musicApi } from '@/api';
import type { ArtistDetail, Platform, UnifiedAlbum } from '@/api/types';
import { parsePlatform, platformName } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const platform = computed<Platform>(() => parsePlatform(route.params.platform));
const artistId = computed(() => String(route.params.id ?? ''));

const detail = ref<ArtistDetail | null>(null);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  if (!artistId.value) return;
  loading.value = true;
  error.value = '';
  try {
    detail.value = await musicApi.artist(platform.value, artistId.value);
  } catch (caught) {
    detail.value = null;
    error.value = caught instanceof Error ? caught.message : '加载歌手失败';
  } finally {
    loading.value = false;
  }
}

watch([platform, artistId], load, { immediate: true });

function openAlbum(album: UnifiedAlbum): void {
  const source = album.sources[0];
  if (!source) return;
  void router.push({ name: 'album', params: { platform: source.platform, id: source.id } });
}

</script>

<template>
  <div class="detail-view">
    <PageState :loading="loading" :error="error" text="正在加载歌手…" @retry="load" />

    <template v-if="!loading && !error && detail">
      <header class="hero">
        <div class="avatar">
          <img v-if="detail.artist.avatar" :src="detail.artist.avatar" alt="" />
          <AppIcon v-else name="users" :size="34" :stroke-width="1.3" />
        </div>
        <div class="hero-copy">
          <span class="chip">{{ platformName(detail.artist.platform) }} · 歌手</span>
          <h1>{{ detail.artist.name }}</h1>
          <p v-if="detail.artist.subtitle">{{ detail.artist.subtitle }}</p>
          <div class="meta">
            <span v-if="detail.artist.songCount !== undefined">{{ detail.artist.songCount }} 首歌曲</span>
            <span v-if="detail.artist.albumCount !== undefined">{{ detail.artist.albumCount }} 张专辑</span>
            <span>{{ detail.items.length }} 首可播放</span>
          </div>
        </div>
      </header>

      <TrackList
        :tracks="detail.items"
        title="热门歌曲"
        empty-text="这个歌手暂时没有可播放的曲目"
      />

      <section v-if="detail.albums.length > 0" class="albums">
        <header class="section-head">
          <h2>专辑</h2>
          <span class="faint">{{ detail.albums.length }} 张</span>
        </header>
        <div class="album-grid">
          <button
            v-for="album in detail.albums"
            :key="album.key"
            type="button"
            class="album-card"
            :disabled="album.sources.length === 0"
            @click="openAlbum(album)"
          >
            <span class="album-cover">
              <img v-if="album.cover" :src="album.cover" alt="" loading="lazy" />
              <AppIcon v-else name="disc" :size="22" :stroke-width="1.4" />
            </span>
            <strong :title="album.name">{{ album.name }}</strong>
            <small>{{ album.releaseDate ?? '发行时间未知' }}</small>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.detail-view {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  flex-direction: column;
  gap: 22px;
  animation: fade-up var(--dur-slow) var(--ease);
}

.hero {
  display: flex;
  align-items: center;
  gap: 22px;
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

.avatar {
  display: grid;
  width: 108px;
  height: 108px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-faint);
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.hero-copy h1 {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.hero-copy p {
  color: var(--text-muted);
  font-size: 12px;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 11px;
}

.albums {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 4px;
}

.section-head h2 {
  font-size: 15px;
  font-weight: 700;
}

.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
  gap: 14px;
}

.album-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 52%, transparent);
  text-align: left;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.album-card:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--surface);
  transform: translateY(-2px);
}

.album-card:disabled {
  cursor: default;
  opacity: 0.6;
}

.album-cover {
  display: grid;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  place-items: center;
  border-radius: var(--radius-md);
  background:
    radial-gradient(circle at 34% 28%, var(--accent-soft), transparent 62%),
    var(--surface);
  color: var(--text-faint);
}

.album-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.album-card strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.album-card small {
  color: var(--text-faint);
  font-size: 10px;
}
</style>
