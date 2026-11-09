<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import {
  PREMIUM_QUALITIES,
  qualityLabel,
  qualityMenuLabel,
  type Quality,
  type UnifiedTrack,
} from '@/api/types';
import { QUALITY_ORDER } from '@/utils/track';
import { useToast } from '@/composables/useToast';
import { useTransport } from '@/composables/useTransport';
import { useLibraryStore } from '@/stores/library';
import { useOfflineStore } from '@/stores/offline';
import { usePlayerStore } from '@/stores/player';

/**
 * 曲目行共用的「更多」菜单。
 *
 * 由列表按视口坐标打开：点行尾的三点、或在曲目行上右键，都走这同一个菜单。
 * 「打开/关闭」由列表统一管理（见 TrackList），这里只负责摆位、二级菜单与动作。
 * 用 Teleport + fixed 定位，免得被列表容器的 overflow / z-index 裁掉。
 */
const props = defineProps<{
  track: UnifiedTrack;
  /** 期望的左上角（视口坐标）；内部按实测尺寸夹进视口。 */
  x: number;
  y: number;
  /** 本地歌单详情：额外给一项「从歌单移除」。 */
  removable?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  remove: [track: UnifiedTrack];
  /** 请求删除单曲的本地下载：确认框由父级（TrackList）持有。 */
  removeDownload: [track: UnifiedTrack];
}>();

const player = usePlayerStore();
const transport = useTransport();
const library = useLibraryStore();
const offline = useOfflineStore();
const toast = useToast();

const MARGIN = 8;
const SUBMENU_WIDTH = 210;
const SUBMENU_MAX_HEIGHT = 300;

const menuRef = ref<HTMLElement | null>(null);
/** 两个二级菜单共用一套展开状态，鼠标从一项挪到另一项时直接切换。 */
const activeSubmenu = ref<'playlist' | 'quality' | null>(null);
/** 第一帧先藏起来，量完再显示，免得菜单先在 (x, y) 闪一下再跳到夹好的位置。 */
const style = ref<Record<string, string>>({
  left: `${props.x}px`,
  top: `${props.y}px`,
  visibility: 'hidden',
});
/** 右侧放不下时子菜单往左翻，下方放不下时往上翻。 */
const flipX = ref(false);
const flipY = ref(false);

onMounted(async () => {
  await nextTick();
  place();
  // 歌单列表第一次用到时才拉，和原来的行内菜单一致。
  if (library.playlists.length === 0) void library.loadPlaylists().catch(() => undefined);
});

function place(): void {
  const rect = menuRef.value?.getBoundingClientRect();
  const width = rect?.width || 200;
  const height = rect?.height || 200;
  const left = Math.max(MARGIN, Math.min(props.x, window.innerWidth - width - MARGIN));
  const top = Math.max(MARGIN, Math.min(props.y, window.innerHeight - height - MARGIN));
  style.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    visibility: 'visible',
  };
  flipX.value = left + width + SUBMENU_WIDTH + MARGIN > window.innerWidth;
  flipY.value = top + height + SUBMENU_MAX_HEIGHT > window.innerHeight;
}

/** 二级菜单：hover 展开，留一点延时让鼠标能跨过主菜单与子菜单之间那点间隙。 */
let submenuTimer: number | undefined;

function openSubmenu(name: 'playlist' | 'quality'): void {
  if (submenuTimer !== undefined) {
    window.clearTimeout(submenuTimer);
    submenuTimer = undefined;
  }
  activeSubmenu.value = name;
}

function scheduleCloseSubmenu(): void {
  if (submenuTimer !== undefined) window.clearTimeout(submenuTimer);
  submenuTimer = window.setTimeout(() => {
    activeSubmenu.value = null;
    submenuTimer = undefined;
  }, 160);
}

onBeforeUnmount(() => {
  if (submenuTimer !== undefined) window.clearTimeout(submenuTimer);
});

function close(): void {
  emit('close');
}

function playNext(): void {
  transport.playNext(props.track);
  close();
}

async function toggleFavorite(): Promise<void> {
  const track = props.track;
  close();
  try {
    const next = await library.toggleFavorite(track);
    toast.success(next ? '已收藏' : '已取消收藏');
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '收藏失败');
  }
}

const downloadLabel = computed(() => {
  const key = props.track.key;
  if (offline.isDownloading(key)) {
    const percent = offline.percentOf(key);
    return percent > 0 ? `下载中… ${percent}%` : '下载中…';
  }
  return offline.has(key) ? '重新下载' : '下载到本地';
});

/** 下载菜单按曲目自身的平台显示档位名（QQ 侧叫 HQ / SQ / 臻品…）。 */
const platform = computed(() => props.track.sources[0]?.platform);

/** 默认那一档：设置里固定了就用固定值，否则跟着播放音质走。 */
const defaultQuality = computed(() => offline.resolveDownloadQuality(player.quality));
const defaultQualityLabel = computed(() => qualityLabel(defaultQuality.value, platform.value));

/** 只列这首歌真有的档位；不知道有哪些档时列全档，并把当前默认档也带上。 */
const qualityOptions = computed(() => {
  const available = props.track.qualities;
  const listed = available?.length
    ? QUALITY_ORDER.filter((item) => available.includes(item))
    : QUALITY_ORDER;
  const values = QUALITY_ORDER.filter(
    (item) => listed.includes(item) || item === defaultQuality.value,
  );
  return values.map((value) => ({
    value,
    label: qualityMenuLabel(value, platform.value),
    hint: hintOf(value),
    isDefault: value === defaultQuality.value,
  }));
});

/** 体积 · 会员标记；平台没给体积就只标会员档。 */
function hintOf(quality: Quality): string {
  const bytes = props.track.qualitySizes?.[quality];
  const parts: string[] = [];
  if (bytes) parts.push(`${(bytes / 1024 / 1024).toFixed(1)}M`);
  if (PREMIUM_QUALITIES.includes(quality)) parts.push('需会员');
  return parts.join(' · ');
}

/** 不传档位 = 按默认设置一键下载；传了就是这首歌临时指定。 */
async function download(quality?: Quality): Promise<void> {
  const track = props.track;
  close();
  const requested = quality ?? defaultQuality.value;
  try {
    const result = await offline.download(track, requested);
    const actual = (result.actualQuality || requested) as Quality;
    const label = qualityLabel(actual, platform.value);
    const degraded = Boolean(result.actualQuality && result.actualQuality !== requested);
    toast.success(
      degraded
        ? `「${track.title}」已按${label}下载（平台没有${qualityLabel(requested, platform.value)}，已自动降级）`
        : `「${track.title}」已按${label}下载到本地`,
    );
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '下载失败');
  }
}

/**
 * 「删除本地下载」只发请求，真正删除等父级确认后再做。
 *
 * 确认框不能挂在这个菜单里：菜单点一下就关、组件随即被 v-if 卸载，弹窗会一起消失；
 * 列表还有「点外部收菜单」的逻辑，会把点确认框当成一次外部点击。
 */
function askRemoveDownload(): void {
  emit('removeDownload', props.track);
  close();
}

function removeFromPlaylist(): void {
  emit('remove', props.track);
  close();
}

async function addToPlaylist(id: string, name: string): Promise<void> {
  const track = props.track;
  close();
  try {
    const added = await library.addToPlaylist(id, track);
    toast.success(added ? `已加入「${name}」` : `「${name}」里已经有这首了`);
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '加入歌单失败');
  }
}
</script>

<template>
  <div
    ref="menuRef"
    class="track-more-menu popover"
    :style="style"
    @contextmenu.prevent
  >
    <button type="button" class="menu-item" @click.stop="playNext">
      <AppIcon name="next" :size="13" />
      下一首播放
    </button>

    <button type="button" class="menu-item" @click.stop="toggleFavorite">
      <AppIcon name="heart" :size="13" :filled="library.isFavorite(track)" />
      {{ library.isFavorite(track) ? '取消收藏' : '收藏' }}
    </button>

    <!--
      下载：点左侧按默认音质直接下，hover / 点箭头展开二级菜单为这一首临时选音质。
      两个二级菜单共用 activeSubmenu，不会同时展开。
    -->
    <div
      class="menu-item has-submenu"
      :class="{ 'is-open': activeSubmenu === 'quality' }"
      @mouseenter="openSubmenu('quality')"
      @mouseleave="scheduleCloseSubmenu"
      @click.stop="openSubmenu('quality')"
    >
      <button
        type="button"
        class="menu-action"
        :disabled="offline.isDownloading(track.key)"
        @click.stop="download()"
      >
        <AppIcon name="download" :size="13" />
        <span class="menu-name">{{ downloadLabel }}</span>
      </button>
      <button
        type="button"
        class="submenu-toggle"
        :disabled="offline.isDownloading(track.key)"
        aria-label="选择下载音质"
      >
        <AppIcon name="chevron-right" :size="12" />
      </button>

      <div
        class="submenu popover quality-submenu"
        :class="{ 'flip-x': flipX, 'flip-y': flipY }"
        @mouseenter="openSubmenu('quality')"
        @mouseleave="scheduleCloseSubmenu"
      >
        <p class="submenu-title">选择下载音质</p>
        <button
          v-for="option in qualityOptions"
          :key="option.value"
          type="button"
          class="menu-item quality-option"
          :class="{ 'is-default': option.isDefault }"
          :disabled="offline.isDownloading(track.key)"
          @click.stop="download(option.value)"
        >
          <span class="menu-name">{{ option.label }}</span>
          <small v-if="option.hint" class="quality-hint">{{ option.hint }}</small>
          <AppIcon v-if="option.isDefault" name="check" :size="12" />
        </button>
        <p class="menu-note">默认：{{ defaultQualityLabel }}。平台没有所选档位时会自动降级。</p>
      </div>
    </div>

    <button
      v-if="offline.has(track.key)"
      type="button"
      class="menu-item danger"
      @click.stop="askRemoveDownload"
    >
      <AppIcon name="close" :size="13" />
      删除本地下载
    </button>

    <button
      v-if="removable"
      type="button"
      class="menu-item danger"
      @click.stop="removeFromPlaylist"
    >
      <AppIcon name="close" :size="13" />
      从歌单移除
    </button>

    <!--
      二级菜单：歌单不再平铺在一级里。hover 展开，点一下也能展开（触屏/触控板）。
      翻边方向由 place() 按视口算好。
    -->
    <div
      class="menu-item has-submenu"
      :class="{ 'is-open': activeSubmenu === 'playlist' }"
      @mouseenter="openSubmenu('playlist')"
      @mouseleave="scheduleCloseSubmenu"
      @click.stop="openSubmenu('playlist')"
    >
      <AppIcon name="list" :size="13" />
      <span class="menu-name">添加到歌单</span>
      <AppIcon name="chevron-right" :size="12" class="submenu-caret" />

      <div
        class="submenu popover"
        :class="{ 'flip-x': flipX, 'flip-y': flipY }"
        @mouseenter="openSubmenu('playlist')"
        @mouseleave="scheduleCloseSubmenu"
      >
        <p v-if="library.playlists.length === 0" class="menu-empty">还没有本地歌单</p>
        <button
          v-for="item in library.playlists"
          :key="item.id"
          type="button"
          class="menu-item"
          @click.stop="addToPlaylist(item.id, item.name)"
        >
          <AppIcon name="plus" :size="13" />
          <span class="menu-name">{{ item.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.track-more-menu {
  position: fixed;
  z-index: var(--z-overlay);
  display: flex;
  width: 200px;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
}

.menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 11px;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.menu-item:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.menu-item:disabled {
  opacity: 0.55;
  cursor: default;
}

.menu-item.danger {
  color: #e0453a;
}

.menu-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-empty {
  padding: 8px 9px;
  color: var(--text-faint);
  font-size: 10px;
}

/* 一级里的「下载」拆成「直接下载」+「展开音质」两块，避免多一次弹窗。 */
.menu-action,
.submenu-toggle {
  background: transparent;
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
}

.menu-action {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 7px;
  text-align: left;
}

.submenu-toggle {
  display: grid;
  width: 18px;
  flex: none;
  place-items: center;
  color: var(--text-faint);
}

.menu-action:disabled,
.submenu-toggle:disabled {
  opacity: 0.55;
  cursor: default;
}

/* ---------------- 二级：添加到歌单 / 下载音质 ---------------- */
.has-submenu {
  position: relative;
  cursor: pointer;
}

.submenu-caret {
  margin-left: auto;
  color: var(--text-faint);
}

.submenu {
  /* 展开由 is-open 控制：hover/点击都走同一套，鼠标跨过间隙时有延时兜着。 */
  display: none;
  position: absolute;
  top: -6px;
  left: calc(100% + 6px);
  z-index: 1;
  width: 190px;
  max-height: 240px;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  overflow-y: auto;
}

.has-submenu.is-open > .submenu {
  display: flex;
}

.submenu.flip-x {
  right: calc(100% + 6px);
  left: auto;
}

.submenu.flip-y {
  top: auto;
  bottom: -6px;
}

.quality-submenu {
  width: 210px;
  max-height: 300px;
}

.submenu-title {
  padding: 3px 9px 5px;
  color: var(--text-faint);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.quality-option {
  gap: 6px;
}

.quality-option.is-default {
  color: var(--accent);
}

.quality-hint {
  margin-left: auto;
  flex: none;
  color: var(--text-faint);
  font-size: 9px;
}

.menu-note {
  margin-top: 4px;
  padding: 7px 9px 2px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 9.5px;
  line-height: 1.5;
}
</style>
