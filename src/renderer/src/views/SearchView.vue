<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
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
import { usePlayerStore } from '@/stores/player';
import { usePreferencesStore } from '@/stores/preferences';
import { formatTime, platformName } from '@/utils/format';
import { trackQualityLabel } from '@/utils/track';

const player = usePlayerStore();
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

function playAt(at: number): void {
  void player.playQueue(tracks.value, at);
}

function openArtist(artist: UnifiedArtist): void {
  const source = artist.sources[0];
  if (!source) return;
  void router.push({ name: 'artist', params: { platform: source.platform, id: source.id } });
}

function openAlbum(album: UnifiedAlbum): void {
  const source = album.sources[0];
  if (!source) return;
  void router.push({ name: 'album', params: { platform: source.platform, id: source.id } });
}

function openPlaylist(item: PlaylistSummary): void {
  void router.push({ name: 'collection', params: { platform: item.platform, id: item.id } });
}

/**
 * 顶栏搜索框送进来的关键词。
 *
 * 只赋值、不直接 `run()`：`keyword` 的 watcher 会去抖后搜索，这里再发一次就是两个请求。
 * 关键词没变时 watcher 不触发，才需要手动搜一次（回车重复提交同一个词）。
 */
function applyKeyword(event: Event): void {
  const value = (event as CustomEvent<{ keyword?: string }>).detail?.keyword?.trim();
  if (!value) return;
  if (value === keyword.value) {
    void run();
    return;
  }
  keyword.value = value;
}

/** 换关键词一律回到第一页：否则会带着旧页码去搜一个新词。 */
watch(keyword, () => {
  page.value = 1;
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

    <p v-if="error" class="notice warn">{{ error }}</p>

    <section v-if="loading && !hasResults" class="state">
      <span class="spinner" />
      <p>正在向两个平台取结果…</p>
    </section>

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

    <ul v-else-if="type === 'song'" class="results">
      <li
        v-for="(track, at) in tracks"
        :key="track.key"
        class="row"
        :class="{ active: player.current?.key === track.key }"
      >
        <!-- 歌手、专辑要做成链接，所以行本身改成 role=button 的 div（按钮里不能嵌链接） -->
        <div
          class="row-main"
          role="button"
          tabindex="0"
          :title="`播放 ${track.title}`"
          @click="playAt(at)"
          @keydown.enter.self="playAt(at)"
          @keydown.space.self.prevent="playAt(at)"
        >
          <span class="row-index">
            <AppIcon
              v-if="player.current?.key === track.key && player.playing"
              name="volume"
              :size="13"
            />
            <template v-else>{{ at + 1 }}</template>
          </span>

          <span class="row-cover">
            <img v-if="track.album.cover" :src="track.album.cover" alt="" loading="lazy" />
            <AppIcon v-else name="music" :size="15" :stroke-width="1.5" />
          </span>

          <span class="row-meta">
            <!-- VIP 紧贴歌名，它说的是「这首歌要不要会员」，而不是平台/音质那一类信息 -->
            <span class="row-title">
              <strong>{{ track.title }}</strong>
              <span v-if="track.vip" class="tag vip">VIP</span>
            </span>
            <small class="row-artists">
              <template v-if="track.artists.length === 0">未知歌手</template>
              <template v-for="(artist, artistIndex) in track.artists" :key="`${artist.name}-${artistIndex}`">
                <RouterLink
                  v-if="artist.id && artist.platform"
                  class="row-link"
                  :to="{ name: 'artist', params: { platform: artist.platform, id: artist.id } }"
                  @click.stop
                >
                  {{ artist.name }}
                </RouterLink>
                <span v-else>{{ artist.name }}</span>
                <span v-if="artistIndex < track.artists.length - 1"> / </span>
              </template>
            </small>
          </span>

          <RouterLink
            v-if="track.album.id && track.album.platform"
            class="row-album row-link"
            :to="{ name: 'album', params: { platform: track.album.platform, id: track.album.id } }"
            :title="track.album.name"
            @click.stop
          >
            {{ track.album.name }}
          </RouterLink>
          <span v-else class="row-album">{{ track.album.name }}</span>

          <span class="row-tags">
            <span v-for="source in track.sources" :key="`${source.platform}-${source.id}`" class="tag">
              {{ platformName(source.platform) }}
            </span>
            <span v-if="trackQualityLabel(track)" class="tag">{{ trackQualityLabel(track) }}</span>
          </span>

          <span class="row-time">{{ formatTime(track.durationMs / 1000) }}</span>
        </div>
      </li>
    </ul>

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
          <img v-if="artist.avatar" :src="artist.avatar" alt="" loading="lazy" />
          <AppIcon v-else name="users" :size="24" :stroke-width="1.4" />
        </span>
        <strong :title="artist.name">{{ artist.name }}</strong>
        <small>{{ artist.subtitle ?? `${artist.songCount ?? 0} 首歌曲` }}</small>
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
          <img v-if="album.cover" :src="album.cover" alt="" loading="lazy" />
          <AppIcon v-else name="disc" :size="22" :stroke-width="1.4" />
        </span>
        <strong :title="album.name">{{ album.name }}</strong>
        <small>{{ album.artists.map((artist) => artist.name).join(' / ') || '未知歌手' }}</small>
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
          <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
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

/* 清掉 ul 默认的缩进，结果列表才和上方的类型切换左对齐。 */
.results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0 0 24px;
  list-style: none;
}

.row {
  border-radius: var(--radius-sm);
  transition: background var(--dur) var(--ease);
}

.row:hover {
  background: var(--surface-hover);
}

.row.active {
  background: var(--accent-soft);
}

/* 标签列定宽，否则标签数量不同的行会把专辑列顶得参差不齐。 */
.row-main {
  display: grid;
  width: 100%;
  grid-template-columns: 28px 40px minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 112px) 42px;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  text-align: left;
}

.row-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.row.active .row-index {
  color: var(--accent);
}

.row-cover {
  display: grid;
  width: 40px;
  height: 40px;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--surface);
  color: var(--text-faint);
}

.row-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.row-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  line-height: 1.4;
}

/* 歌名行：标题占据剩余宽度并截断，VIP 徽标定宽跟在后面 */
.row-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.row-title .tag {
  flex: none;
}

.row-meta strong {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.active .row-meta strong {
  color: var(--accent);
}

.row-meta small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 歌手 / 专辑链接：平时与正文同色，悬停才亮起并加下划线 */
.row-link {
  color: inherit;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease);
}

.row-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.row-album {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-tags {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  overflow: hidden;
}

.tag {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 650;
  white-space: nowrap;
}

.tag.vip {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}

.row-time {
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.notice {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.notice.warn {
  border-color: color-mix(in srgb, #e0453a 35%, transparent);
  color: #e0453a;
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

.spinner {
  width: 26px;
  height: 26px;
  margin-bottom: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1080px) {
  .row-main {
    grid-template-columns: 24px 40px minmax(0, 1fr) minmax(0, 108px) 42px;
  }

  .row-album {
    display: none;
  }
}
</style>
