<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import TrackList from '@/components/music/TrackList.vue';
import TrackPageSkeleton from '@/components/skeleton/TrackPageSkeleton.vue';
import { musicApi } from '@/api';
import type { CollectionDetail, Platform, UnifiedTrack } from '@/api/types';
import { useDelayedLoading } from '@/composables/useDelayedLoading';
import { useToast } from '@/composables/useToast';
import { useTransport } from '@/composables/useTransport';
import { cachedImage } from '@/utils/cacheImage';
import { parsePlatform, platformName } from '@/utils/format';

const route = useRoute();

const platform = computed<Platform>(() => parsePlatform(route.params.platform));
const collectionId = computed(() => String(route.params.id ?? ''));
const isToplist = computed(() => route.name === 'toplist');

/**
 * 集合详情是分页接口：首屏只取 100 首，滚到列表底部附近再取下一页。
 * 网关单页上限 200，这里按每页 100；MAX_PAGES 是上游数据异常时的兜底。
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** 提前一屏预取，滚到底时下一页通常已经到了。 */
const PREFETCH_PX = 600;

const meta = ref<CollectionDetail | null>(null);
const items = ref<UnifiedTrack[]>([]);
const detail = computed(() => (meta.value ? { ...meta.value, items: items.value } : null));
const loading = ref(false);
const loadingMore = ref(false);
const playingAll = ref(false);
const error = ref('');
const moreError = ref('');
const hasMore = ref(false);
const skeletonVisible = useDelayedLoading(loading);
const toast = useToast();
const transport = useTransport();

/**
 * QQ 榜单的 trackCount 是「当页条数」，只有比已加载数大时才可能是真实总数；
 * 否则不宣称总数，避免出现「共 100 首」却还能继续往下加载。
 */
const announcedTotal = computed(() => {
  const total = meta.value?.trackCount ?? 0;
  return total > items.value.length ? total : 0;
});

/** 路由切换后丢弃旧响应；inFlight 合并滚动与点击同时触发的重复请求。 */
let loadSeq = 0;
let nextPage = 1;
let top = false;
let inFlight: Promise<void> | null = null;
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

function fetchPage(
  source: Platform,
  id: string,
  isTop: boolean,
  page: number,
): Promise<CollectionDetail> {
  return isTop
    ? musicApi.toplist(source, id, page, PAGE_SIZE)
    : musicApi.collection(source, id, page, PAGE_SIZE);
}

async function load(): Promise<void> {
  const id = collectionId.value;
  if (!id) return;
  const seq = ++loadSeq;
  top = isToplist.value;
  loading.value = true;
  loadingMore.value = false;
  playingAll.value = false;
  error.value = '';
  moreError.value = '';
  hasMore.value = false;
  meta.value = null;
  items.value = [];
  inFlight = null;
  nextPage = 1;
  try {
    const chunk = await fetchPage(platform.value, id, top, 1);
    if (seq !== loadSeq) return;
    meta.value = chunk;
    items.value = chunk.items;
    nextPage = 2;
    hasMore.value = chunk.items.length >= PAGE_SIZE && nextPage <= MAX_PAGES;
  } catch (caught) {
    if (seq !== loadSeq) return;
    error.value = caught instanceof Error ? caught.message : '加载失败';
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const current = meta.value;
  if (!current || !hasMore.value || moreError.value) return;
  if (inFlight) return inFlight;
  const seq = loadSeq;
  const page = nextPage;
  loadingMore.value = true;
  moreError.value = '';
  const task = (async (): Promise<void> => {
    try {
      const chunk = await fetchPage(current.platform, current.id, top, page);
      if (seq !== loadSeq) return;
      items.value = [...items.value, ...chunk.items];
      nextPage = page + 1;
      hasMore.value = chunk.items.length >= PAGE_SIZE && nextPage <= MAX_PAGES;
    } catch (caught) {
      if (seq !== loadSeq) return;
      moreError.value = caught instanceof Error ? caught.message : '加载失败';
    } finally {
      if (seq === loadSeq) loadingMore.value = false;
    }
  })();
  inFlight = task;
  try {
    await task;
  } finally {
    if (inFlight === task) inFlight = null;
  }
}

/** 「播放全部」是用户明确要整张歌单的意图：这时才补齐剩余页再入队。 */
async function playAll(): Promise<void> {
  if (playingAll.value || items.value.length === 0) return;
  const seq = loadSeq;
  playingAll.value = true;
  try {
    while (hasMore.value && seq === loadSeq) {
      moreError.value = '';
      await loadMore();
      if (moreError.value) break;
    }
    if (seq !== loadSeq) return;
    if (moreError.value) toast.error('剩余曲目加载失败，已播放当前已加载的曲目');
    transport.playList(items.value);
  } finally {
    if (seq === loadSeq) playingAll.value = false;
  }
}

function retryMore(): void {
  moreError.value = '';
  void loadMore();
}

watch(
  sentinel,
  (element) => {
    observer?.disconnect();
    observer = null;
    if (!element) return;
    // AppShell 的内容区才是滚动容器，用它当 root 才能正确判断「快到底了」。
    const root = document.querySelector('.app-content');
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { root, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` },
    );
    observer.observe(element);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => observer?.disconnect());

watch([platform, collectionId, isToplist], load, { immediate: true });
</script>

<template>
  <div class="detail-view">
    <ErrorState v-if="error" :message="error" @retry="load" />
    <TrackPageSkeleton v-else-if="skeletonVisible" :rows="8" :cover="148" />

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
            <span v-if="hasMore">
              已加载 {{ items.length }} 首<template v-if="announcedTotal"> / 共 {{ announcedTotal }} 首</template>
            </span>
            <span v-else>共 {{ items.length }} 首</span>
          </div>
        </div>
      </header>

      <div class="list-block">
        <div class="list-head">
          <span class="head-count">{{ isToplist ? '榜单曲目' : '歌单曲目' }} · {{ items.length }} 首</span>
          <button
            type="button"
            class="play-all"
            :disabled="playingAll || items.length === 0"
            @click="playAll"
          >
            <AppIcon name="play" :size="12" />
            {{ playingAll ? '正在准备…' : '播放全部' }}
          </button>
        </div>

        <TrackList
          :tracks="detail.items"
          :show-head="false"
          empty-text="这里暂时没有可播放的曲目"
        />
      </div>

      <div v-if="hasMore" ref="sentinel" class="load-more">
        <button v-if="moreError" type="button" class="retry-more" :title="moreError" @click="retryMore">
          加载失败，点击重试
        </button>
        <span v-else-if="loadingMore || playingAll">正在加载剩余曲目…</span>
        <span v-else>向下滚动加载更多</span>
      </div>
      <p v-else-if="items.length > 0" class="load-more">已加载全部 {{ items.length }} 首</p>
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

.list-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 4px;
  font-size: 11px;
}

.head-count {
  color: var(--text-faint);
}

.play-all {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
  transition: filter var(--dur) var(--ease);
}

.play-all:hover:not(:disabled) {
  filter: brightness(1.06);
}

.play-all:disabled {
  opacity: 0.6;
}

.load-more {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.retry-more {
  color: var(--accent);
  font-size: 11px;
}
</style>
