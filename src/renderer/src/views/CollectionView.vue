<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import PageState from '@/components/common/PageState.vue';
import TrackList from '@/components/music/TrackList.vue';
import { musicApi } from '@/api';
import type { CollectionDetail, Platform } from '@/api/types';
import { cachedImage } from '@/utils/cacheImage';
import { parsePlatform, platformName } from '@/utils/format';

const route = useRoute();

const platform = computed<Platform>(() => parsePlatform(route.params.platform));
const collectionId = computed(() => String(route.params.id ?? ''));
const isToplist = computed(() => route.name === 'toplist');

const detail = ref<CollectionDetail | null>(null);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  if (!collectionId.value) return;
  loading.value = true;
  error.value = '';
  try {
    detail.value = isToplist.value
      ? await musicApi.toplist(platform.value, collectionId.value)
      : await musicApi.collection(platform.value, collectionId.value);
  } catch (caught) {
    detail.value = null;
    error.value = caught instanceof Error ? caught.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

watch([platform, collectionId, isToplist], load, { immediate: true });
</script>

<template>
  <div class="detail-view">
    <PageState
      :loading="loading"
      :error="error"
      :text="isToplist ? '正在加载榜单…' : '正在加载歌单…'"
      @retry="load"
    />

    <template v-if="!loading && !error && detail">
      <header class="hero">
        <div class="cover">
          <img v-if="detail.cover" :src="cachedImage(detail.cover)" alt="" />
          <AppIcon v-else name="list" :size="34" :stroke-width="1.3" />
        </div>

        <div class="hero-copy">
          <span class="chip">{{ platformName(detail.platform) }} · {{ isToplist ? '榜单' : '歌单' }}</span>
          <h1>{{ detail.title }}</h1>
          <p v-if="detail.description" class="desc">{{ detail.description }}</p>
          <div class="meta">
            <span v-if="detail.trackCount !== undefined">{{ detail.trackCount }} 首</span>
            <span>{{ detail.items.length }} 首可播放</span>
          </div>
        </div>
      </header>

      <TrackList
        :tracks="detail.items"
        :title="isToplist ? '榜单曲目' : '歌单曲目'"
        empty-text="这里暂时没有可播放的曲目"
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

.desc {
  display: -webkit-box;
  overflow: hidden;
  max-width: 620px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  color: var(--text-faint);
  font-size: 11px;
}
</style>
