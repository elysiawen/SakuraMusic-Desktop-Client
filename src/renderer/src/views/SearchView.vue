<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import TrackList from '@/components/music/TrackList.vue';
import GridSkeleton from '@/components/skeleton/GridSkeleton.vue';
import TrackRowsSkeleton from '@/components/skeleton/TrackRowsSkeleton.vue';
import { musicApi } from '@/api';
import type {
  PlatformStatus,
  PlaylistSummary,
  SearchResult,
  SearchType,
  UnifiedAlbum,
  UnifiedArtist,
} from '@/api/types';
import { useToast } from '@/composables/useToast';
import { usePreferencesStore } from '@/stores/preferences';
import { cachedImage } from '@/utils/cacheImage';
import { platformName } from '@/utils/format';

const preferences = usePreferencesStore();
const toast = useToast();
const router = useRouter();

const TYPES: Array<{ id: SearchType; label: string }> = [
  { id: 'song', label: '歌曲' },
  { id: 'artist', label: '歌手' },
  { id: 'album', label: '专辑' },
  { id: 'playlist', label: '歌单' },
];

/**
 * 每页条数与 web 端一致（20）。
 *
 * 这个数必须和 web 对齐：网关是「取回各平台这一页 → 合并 → 按相关度排序」，
 * 取多少条会反过来影响排序（翻唱线索、双平台合并都只看这一批），
 * 所以 40 与 20 拿到的前十名可能完全不同。两端同页同量，排序才会一致。
 */
const PAGE_SIZE = 20;

const keyword = ref('');
const type = ref<SearchType>('song');
const page = ref(1);
const result = ref<SearchResult | null>(null);
const platforms = ref<PlatformStatus[]>([]);
const loading = ref(false);
const error = ref('');
const searched = ref('');

let debounceTimer: number | undefined;
let requestToken = 0;
/** 回车提交时跳过下面 watcher 的 380ms 去抖，立即发请求。 */
let submitPending = false;

const tracks = computed(() => result.value?.items ?? []);
const artists = computed(() => result.value?.artists ?? []);
const albums = computed(() => result.value?.albums ?? []);
const playlists = computed(() => result.value?.playlists ?? []);

const total = computed(() => {
  if (type.value === 'artist') return artists.value.length;
  if (type.value === 'album') return albums.value.length;
  if (type.value === 'playlist') return playlists.value.length;
  return tracks.value.length;
});

const hasResults = computed(() => total.value > 0);
const platformErrors = computed(() => platforms.value.filter((item) => !item.ok));

/**
 * 检索期间直接用骨架屏占住结果区：回车就有画面变化，不再是「静止几秒后突然出结果」。
 * 这里不做延迟显示——明确提交时用户需要立刻得到反馈。
 */
const skeletonVisible = computed(() => loading.value);

async function run(): Promise<void> {
  const value = keyword.value.trim();
  if (!value) {
    result.value = null;
    platforms.value = [];
    searched.value = '';
    error.value = '';
    page.value = 1;
    return;
  }

  const token = ++requestToken;
  loading.value = true;
  error.value = '';

  try {
    await preferences.ensureInitialized();
    const response = await musicApi.search(
      value,
      type.value,
      page.value,
      PAGE_SIZE,
      preferences.enabledParam('search'),
    );
    if (token !== requestToken) return;
    result.value = response;
    platforms.value = response.platforms;
    searched.value = response.keyword || value;
    page.value = Math.max(1, response.page || page.value);
  } catch (caught) {
    if (token !== requestToken) return;
    result.value = null;
    platforms.value = [];
    error.value = caught instanceof Error ? caught.message : '搜索失败';
    toast.error(error.value);
  } finally {
    if (token === requestToken) loading.value = false;
  }
}

/** 翻页：页码随后跟着请求走，返回后由响应里的 page 校正。 */
function goPage(next: number): void {
  if (next < 1) return;
  page.value = next;
  void run();
}

function chooseType(next: SearchType): void {
  if (next === type.value) return;
  type.value = next;
  result.value = null;
  page.value = 1;
  if (keyword.value.trim()) void run();
}

function openArtist(artist: UnifiedArtist): void {
  const source = artist.sources[0];
  if (!source) return;
  void router.push({ name: 'artist', params: { platform: source.platform, id: source.id } });
}

function openArtistOn(platform: string, id: string): void {
  void router.push({ name: 'artist', params: { platform, id } });
}

function openAlbum(album: UnifiedAlbum): void {
  const source = album.sources[0];
  if (!source) return;
  void router.push({ name: 'album', params: { platform: source.platform, id: source.id } });
}

function openAlbumOn(platform: string, id: string): void {
  void router.push({ name: 'album', params: { platform, id } });
}

function openPlaylist(item: PlaylistSummary): void {
  void router.push({ name: 'collection', params: { platform: item.platform, id: item.id } });
}

/**
 * 顶栏搜索框送进来的关键词（回车或点搜索图标）。
 *
 * 明确提交不做去抖：立刻发请求并同步把 loading 置起来；
 * `keyword` 的 watcher 只负责同步页码，不再排队第二次请求。
 */
function applyKeyword(event: Event): void {
  const value = (event as CustomEvent<{ keyword?: string }>).detail?.keyword?.trim();
  if (!value) return;

  if (debounceTimer !== undefined) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }

  if (value === keyword.value) {
    void run();
    return;
  }

  submitPending = true;
  page.value = 1;
  keyword.value = value;
  void run();
}

/** 换关键词一律回到第一页：否则会带着旧页码去搜一个新词。 */
watch(keyword, () => {
  page.value = 1;
  if (submitPending) {
    // 回车已经直接搜过了，这里只同步页码，不再排队第二次请求。
    submitPending = false;
    return;
  }
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    void run();
  }, 380);
});

onMounted(() => {
  window.addEventListener('sakura:search', applyKeyword);
});

onBeforeUnmount(() => {
  window.removeEventListener('sakura:search', applyKeyword);
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="search-view">
    <!-- 页内不放搜索框了：搜索统一从顶栏输入，这里只负责分类型看结果 -->
    <div class="type-bar">
      <nav class="type-tabs" role="tablist" aria-label="搜索类型">
        <button
          v-for="item in TYPES"
          :key="item.id"
          type="button"
          role="tab"
          class="type-tab"
          :class="{ active: type === item.id }"
          :aria-selected="type === item.id"
          @click="chooseType(item.id)"
        >
          {{ item.label }}
        </button>
      </nav>
      <!-- 请求可能很快，也可能要等上游：立刻给一个「在搜」的信号，别让界面看起来卡住 -->
      <span v-if="loading" class="searching">
        <AppIcon name="refresh" :size="11" class="spin" />
        正在搜索{{ searched ? `「${searched}」` : '' }}…
      </span>
    </div>

    <ErrorState v-if="error" :message="error" @retry="run" />

    <div v-else-if="skeletonVisible" class="skeleton">
      <TrackRowsSkeleton v-if="type === 'song'" :rows="10" head />
      <GridSkeleton v-else :count="8" :round="type === 'artist'" :pad="10" />
    </div>

    <section v-else-if="!searched" class="state">
      <span class="state-disc"><AppIcon name="search" :size="26" :stroke-width="1.3" /></span>
      <h2>想听点什么</h2>
      <p>在窗口顶部的搜索框输入歌名、歌手或专辑，结果会按两个平台聚合到这里。</p>
    </section>

    <section v-else-if="!hasResults" class="state">
      <span class="state-disc"><AppIcon name="music" :size="26" :stroke-width="1.3" /></span>
      <h2>没有找到结果</h2>
      <p>
        换个关键词试试。
        <template v-if="platformErrors.length > 0">
          另外 {{ platformErrors.map((item) => platformName(item.platform)).join('、') }} 这次没能检索成功。
        </template>
      </p>
    </section>

    <!-- 与其它列表共用同一套曲目行：更多菜单、收藏、右键操作都不再另写一份。 -->
    <div v-else-if="type === 'song'" class="results">
      <TrackList :tracks="tracks" title="搜索结果" />
    </div>

    <div v-else-if="type === 'artist'" class="card-grid">
      <button
        v-for="artist in artists"
        :key="artist.key"
        type="button"
        class="search-card"
        :disabled="artist.sources.length === 0"
        @click="openArtist(artist)"
      >
        <span class="card-cover round">
          <img v-if="artist.avatar" :src="cachedImage(artist.avatar)" alt="" loading="lazy" />
          <AppIcon v-else name="users" :size="24" :stroke-width="1.4" />
        </span>
        <strong :title="artist.name">{{ artist.name }}</strong>
        <small>{{ artist.subtitle ?? `${artist.songCount ?? 0} 首歌曲` }}</small>
        <span class="source-chips">
          <button
            v-for="source in artist.sources"
            :key="source.platform"
            type="button"
            class="source-chip"
            :class="`chip-${source.platform}`"
            :title="`进入${platformName(source.platform)}的歌手主页`"
            @click.stop="openArtistOn(source.platform, source.id)"
          >{{ platformName(source.platform) }}</button>
        </span>
      </button>
    </div>

    <div v-else-if="type === 'album'" class="card-grid">
      <button
        v-for="album in albums"
        :key="album.key"
        type="button"
        class="search-card"
        :disabled="album.sources.length === 0"
        @click="openAlbum(album)"
      >
        <span class="card-cover">
          <img v-if="album.cover" :src="cachedImage(album.cover)" alt="" loading="lazy" />
          <AppIcon v-else name="disc" :size="22" :stroke-width="1.4" />
        </span>
        <strong :title="album.name">{{ album.name }}</strong>
        <small>{{ album.artists.map((artist) => artist.name).join(' / ') || '未知歌手' }}</small>
        <span class="source-chips">
          <button
            v-for="source in album.sources"
            :key="source.platform"
            type="button"
            class="source-chip"
            :class="`chip-${source.platform}`"
            :title="`进入${platformName(source.platform)}的专辑页`"
            @click.stop="openAlbumOn(source.platform, source.id)"
          >{{ platformName(source.platform) }}</button>
        </span>
      </button>
    </div>

    <div v-else class="card-grid">
      <button
        v-for="item in playlists"
        :key="`${item.platform}-${item.id}`"
        type="button"
        class="search-card"
        @click="openPlaylist(item)"
      >
        <span class="card-cover">
          <img v-if="item.cover" :src="cachedImage(item.cover)" alt="" loading="lazy" />
          <AppIcon v-else name="list" :size="22" :stroke-width="1.4" />
        </span>
        <strong :title="item.title">{{ item.title }}</strong>
        <small>
          {{ item.trackCount !== undefined ? `${item.trackCount} 首` : platformName(item.platform) }}
        </small>
      </button>
    </div>

    <!-- 分页：与 web 端相同的「每页 20 条」，两边拿到的顺序才一致 -->
    <div v-if="searched && hasResults" class="pager">
      <button type="button" class="pager-btn" :disabled="page <= 1 || loading" @click="goPage(page - 1)">
        <AppIcon name="chevron-left" :size="13" />
        上一页
      </button>
      <span class="pager-label">第 {{ page }} 页</span>
      <button
        type="button"
        class="pager-btn"
        :disabled="total < PAGE_SIZE || loading"
        @click="goPage(page + 1)"
      >
        下一页
        <AppIcon name="chevron-right" :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  flex-direction: column;
  gap: 22px;
  animation: fade-up var(--dur-slow) var(--ease);
}

.type-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.searching {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-right: 4px;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.type-tabs {
  display: inline-flex;
  align-self: flex-start;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg) 40%, var(--surface));
}

.type-tab {
  height: 26px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 650;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.type-tab:hover {
  color: var(--text-muted);
}

.type-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
  gap: 14px;
  padding-bottom: 24px;
}

/* ---------------- 分页 ---------------- */

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 2px 0 18px;
}

.pager-btn {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 4px;
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

.pager-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.pager-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.pager-label {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.search-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 44%, transparent);
  text-align: left;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.search-card:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--surface);
  transform: translateY(-2px);
}

.search-card:disabled {
  cursor: default;
  opacity: 0.6;
}

.card-cover {
  display: grid;
  width: 100%;
  aspect-ratio: 1;
  margin-bottom: 4px;
  overflow: hidden;
  place-items: center;
  border-radius: var(--radius-md);
  background:
    radial-gradient(circle at 34% 28%, var(--accent-soft), transparent 62%),
    var(--surface);
  color: var(--text-faint);
}

.card-cover.round {
  border-radius: 50%;
}

.card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.search-card strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-card small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 歌手 / 专辑卡片底部的平台胶囊 —— 红底白字 = 网易云，绿底白字 = QQ 音乐。
   比小圆点直观：一眼就知道这个卡片有哪几个平台、各自叫什么。 */
.source-chips {
  display: inline-flex;
  flex: none;
  gap: 4px;
  align-self: flex-end;
  margin-top: auto;
  padding-top: 4px;
}

.source-chip {
  height: 18px;
  padding: 0 7px;
  border: 0;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 650;
  line-height: 18px;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease),
    filter var(--dur-fast) var(--ease);
}

.source-chip:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px color-mix(in srgb, var(--bg) 65%, transparent);
  filter: brightness(1.08);
}

.source-chip.chip-netease {
  background: #e0413f;
  color: #fff;
}

.source-chip.chip-qq {
  background: #3cc77f;
  color: #fff;
}

/* 曲目行由 TrackList 统一渲染，这里只给分页留白。 */
.results {
  padding: 0 0 24px;
}

.skeleton {
  padding: 0 0 24px;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 64px 20px;
  text-align: center;
}

.state-disc {
  display: grid;
  width: 74px;
  height: 74px;
  margin-bottom: 16px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background:
    radial-gradient(circle at 34% 28%, var(--accent-soft), transparent 62%),
    var(--surface);
  color: var(--text-faint);
}

.state h2 {
  font-size: 15px;
  font-weight: 700;
}

.state p {
  max-width: 380px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

</style>
