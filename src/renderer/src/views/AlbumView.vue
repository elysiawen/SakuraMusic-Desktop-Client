<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import PageState from '@/components/common/PageState.vue';
import TrackList from '@/components/music/TrackList.vue';
import { musicApi } from '@/api';
import type { AlbumDetail, ArtistRef, Platform } from '@/api/types';
import { cachedImage } from '@/utils/cacheImage';
import { parsePlatform, platformName } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const platform = computed<Platform>(() => parsePlatform(route.params.platform));
const albumId = computed(() => String(route.params.id ?? ''));

const detail = ref<AlbumDetail | null>(null);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  if (!albumId.value) return;
  loading.value = true;
  error.value = '';
  try {
    detail.value = await musicApi.album(platform.value, albumId.value);
  } catch (caught) {
    detail.value = null;
    error.value = caught instanceof Error ? caught.message : '加载专辑失败';
  } finally {
    loading.value = false;
  }
}

watch([platform, albumId], load, { immediate: true });

function openArtist(artist: ArtistRef): void {
  if (!artist.id || !artist.platform) return;
  void router.push({ name: 'artist', params: { platform: artist.platform, id: artist.id } });
}
</script>

<template>
  <div class="detail-view">
    <PageState :loading="loading" :error="error" text="正在加载专辑…" @retry="load" />

    <template v-if="!loading && !error && detail">
      <header class="hero">
        <div class="cover">
          <img v-if="detail.album.cover" :src="cachedImage(detail.album.cover)" alt="" />
          <AppIcon v-else name="disc" :size="38" :stroke-width="1.3" />
        </div>

        <div class="hero-copy">
          <span class="chip">{{ platformName(detail.album.platform) }} · 专辑</span>
          <h1>{{ detail.album.name }}</h1>

          <p class="artists">
            <template v-for="(artist, at) in detail.album.artists" :key="`${artist.name}-${at}`">
              <button
                v-if="artist.id && artist.platform"
                type="button"
                class="artist-link"
                @click="openArtist(artist)"
              >
                {{ artist.name }}
              </button>
              <span v-else>{{ artist.name }}</span>
              <span v-if="at < detail.album.artists.length - 1" class="sep">/</span>
            </template>
          </p>

          <div class="meta">
            <span v-if="detail.album.releaseDate">发行 {{ detail.album.releaseDate }}</span>
            <span v-if="detail.album.trackCount !== undefined">{{ detail.album.trackCount }} 首</span>
            <span>{{ detail.items.length }} 首可播放</span>
          </div>
        </div>
      </header>

      <TrackList
        :tracks="detail.items"
        title="曲目"
        :show-cover="false"
        empty-text="这张专辑暂时没有可播放的曲目"
      />
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

.artists {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: 12px;
}

.artist-link {
  color: var(--text-muted);
  font-size: 12px;
  transition: color var(--dur) var(--ease);
}

.artist-link:hover {
  color: var(--accent);
}

.sep {
  color: var(--text-faint);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  color: var(--text-faint);
  font-size: 11px;
}
</style>
