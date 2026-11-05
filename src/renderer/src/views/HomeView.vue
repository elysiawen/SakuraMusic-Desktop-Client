<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import PageState from '@/components/common/PageState.vue';
import type {
  DiscoverSection,
  Platform,
  PlaylistSummary,
  UnifiedTrack,
} from '@/api/types';
import { useTransport } from '@/composables/useTransport';
import { useHomeStore } from '@/stores/home';
import { usePlayerStore } from '@/stores/player';
import { cachedImage } from '@/utils/cacheImage';
import { platformName } from '@/utils/format';
import { isTrack } from '@/utils/track';

interface FeedSection {
  key: string;
  title: string;
  subtitle?: string;
  platform: Platform;
  kind: DiscoverSection['kind'];
  tracks: UnifiedTrack[];
  collections: PlaylistSummary[];
}

const player = usePlayerStore();
const transport = useTransport();
const home = useHomeStore();
const router = useRouter();

// 推荐流缓存在 store 里：进出主页不重新请求，只有点「刷新」才强拉。
const { feed, loading, error } = storeToRefs(home);

const sections = computed<FeedSection[]>(() =>
  (feed.value?.sections ?? []).map((section) => ({
    key: section.key,
    title: section.title,
    subtitle: section.subtitle,
    platform: section.platform,
    kind: section.kind,
    tracks: section.items.filter(isTrack),
    collections: section.items.filter((item): item is PlaylistSummary => !isTrack(item)),
  })),
);

const feedErrors = computed(() => feed.value?.errors ?? []);

/** 跟 web 端一致：歌曲类板块走横向轨道，歌单/榜单走卡片网格，不要混在一起平铺。 */
const trackSections = computed(() =>
  sections.value.filter((section) => section.kind === 'tracks' && section.tracks.length > 0),
);
const collectionSections = computed(() =>
  sections.value.filter((section) => section.kind !== 'tracks' && section.collections.length > 0),
);
const isEmpty = computed(
  () =>
    !loading.value &&
    !error.value &&
    trackSections.value.length === 0 &&
    collectionSections.value.length === 0,
);

const kindLabel: Record<DiscoverSection['kind'], string> = {
  tracks: '推荐歌曲',
  playlists: '歌单',
  toplists: '榜单',
};

/** 手动刷新：强制重拉推荐流。 */
function refresh(): void {
  void home.load(true);
}

function artistNames(track: UnifiedTrack): string {
  return track.artists.map((artist) => artist.name).join(' / ') || '未知歌手';
}

function playAt(section: FeedSection, at: number): void {
  const track = section.tracks[at];
  if (!track) return;
  transport.playTrack(track, section.tracks);
}

function playSection(section: FeedSection): void {
  transport.playList(section.tracks);
}

function openCollection(section: FeedSection, item: PlaylistSummary): void {
  void router.push({
    name: section.kind === 'toplists' ? 'toplist' : 'collection',
    params: { platform: item.platform, id: item.id },
  });
}

function goSearch(): void {
  void router.push({ name: 'search' });
}

onMounted(async () => {
  // 已拉过就直接复用缓存，返回主页不再重拉。
  await home.load();
});
</script>

<template>
  <div class="home">
    <div v-if="feedErrors.length > 0" class="platform-notes">
      <span v-for="item in feedErrors" :key="`${item.platform}-${item.section}`" class="note">
        <AppIcon name="alert" :size="12" />
        {{ platformName(item.platform) }}「{{ item.section }}」没取到：{{ item.message }}
      </span>
    </div>

    <PageState :loading="loading" :error="error" text="正在向两个平台要推荐…" @retry="refresh" />

    <section v-if="isEmpty" class="empty-feed">
      <span class="empty-disc"><AppIcon name="music" :size="26" :stroke-width="1.3" /></span>
      <h2>还没有推荐内容</h2>
      <p>可能是账号还没绑定平台，或者两个平台这次都没有返回。可以先去搜索页听点什么。</p>
      <button type="button" class="hero-button" @click="goSearch">去搜索</button>
    </section>

    <template v-if="!loading && !error">
      <!-- 歌曲类板块（每日推荐、私人 FM 等）走横向轨道，避免几十张卡把整页铺满 -->
      <section v-for="section in trackSections" :key="section.key" class="section">
        <header class="section-head">
          <div>
            <p class="eyebrow">{{ platformName(section.platform) }} · {{ kindLabel[section.kind] }}</p>
            <h2>{{ section.title }}</h2>
            <p v-if="section.subtitle" class="subtitle">{{ section.subtitle }}</p>
          </div>
          <button type="button" class="play-all" @click="playSection(section)">
            <AppIcon name="play" :size="12" />
            播放全部
          </button>
        </header>

        <div class="rail">
          <button
            v-for="(track, at) in section.tracks"
            :key="track.key"
            type="button"
            class="track-card rail-card"
            :class="{ active: player.current?.key === track.key }"
            :title="`播放 ${track.title}`"
            @click="playAt(section, at)"
          >
            <span class="card-cover">
              <img v-if="track.album.cover" :src="cachedImage(track.album.cover)" alt="" loading="lazy" />
              <AppIcon v-else name="music" :size="22" :stroke-width="1.4" />
              <span class="play-badge"><AppIcon name="play" :size="11" /></span>
            </span>
            <strong :title="track.title">{{ track.title }}</strong>
            <small :title="artistNames(track)">{{ artistNames(track) }}</small>
          </button>
        </div>
      </section>

      <!-- 歌单 / 榜单：卡片网格 -->
      <section v-for="section in collectionSections" :key="section.key" class="section">
        <header class="section-head">
          <div>
            <p class="eyebrow">{{ platformName(section.platform) }} · {{ kindLabel[section.kind] }}</p>
            <h2>{{ section.title }}</h2>
            <p v-if="section.subtitle" class="subtitle">{{ section.subtitle }}</p>
          </div>
        </header>

        <div class="collection-grid">
          <button
            v-for="item in section.collections"
            :key="`${item.platform}-${item.id}`"
            type="button"
            class="collection-card"
            @click="openCollection(section, item)"
          >
            <span class="card-cover">
              <img v-if="item.cover" :src="cachedImage(item.cover)" alt="" loading="lazy" />
              <AppIcon v-else name="list" :size="20" :stroke-width="1.4" />
            </span>
            <strong :title="item.title">{{ item.title }}</strong>
            <small>
              {{ item.trackCount !== undefined ? `${item.trackCount} 首` : platformName(item.platform) }}
            </small>
          </button>
        </div>
      </section>
    </template>

  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 26px;
  max-width: 1180px;
  margin: 0 auto;
  animation: fade-up var(--dur-slow) var(--ease);
}

.hero-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 16px;
  border-radius: var(--radius-pill);
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast);
  font-size: 12px;
  font-weight: 650;
  box-shadow: 0 8px 20px color-mix(in srgb, var(--accent) 24%, transparent);
  transition: filter var(--dur) var(--ease);
}

.hero-button:hover {
  filter: brightness(1.05);
}

.platform-notes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, #e0453a 30%, transparent);
  border-radius: var(--radius-pill);
  color: #e0453a;
  font-size: 10px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px;
}

.section-head h2 {
  margin-top: 3px;
  font-size: 17px;
  font-weight: 750;
  letter-spacing: -0.01em;
}

.subtitle {
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 11px;
}

.play-all {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 13px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
  transition: filter var(--dur) var(--ease);
}

.play-all:hover {
  filter: brightness(1.06);
}

.rail {
  display: flex;
  gap: 14px;
  padding: 2px 4px 10px;
  overflow-x: auto;
  scrollbar-width: thin;
  scroll-snap-type: x proximity;
}

.rail-card {
  flex: 0 0 168px;
  scroll-snap-align: start;
}

.collection-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
  gap: 14px;
}

.track-card,
.collection-card {
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

.track-card:hover,
.collection-card:hover {
  border-color: var(--border-strong);
  background: var(--surface);
  transform: translateY(-2px);
}

.track-card.active {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: var(--accent-soft);
}

.card-cover {
  position: relative;
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

.card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.play-badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  opacity: 0;
  transform: translateY(4px);
  backdrop-filter: blur(8px);
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.track-card:hover .play-badge,
.track-card.active .play-badge {
  opacity: 1;
  transform: translateY(0);
}

.track-card strong,
.collection-card strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-card.active strong {
  color: var(--accent);
}

.track-card small,
.collection-card small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-feed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 20px;
  text-align: center;
}

.empty-disc {
  display: grid;
  width: 74px;
  height: 74px;
  margin-bottom: 8px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background:
    radial-gradient(circle at 34% 28%, var(--accent-soft), transparent 62%),
    var(--surface);
  color: var(--text-faint);
}

.empty-feed h2 {
  font-size: 15px;
  font-weight: 700;
}

.empty-feed p {
  max-width: 400px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

</style>
