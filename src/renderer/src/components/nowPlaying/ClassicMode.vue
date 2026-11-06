<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useUiStore } from '@/stores/ui';
import { formatTime, platformName } from '@/utils/format';
import { cachedImage } from '@/utils/cacheImage';
import { activeLineIndex, parseLyricResult, type LyricLine } from '@/utils/lyric';
import NowPlayingTopActions from './NowPlayingTopActions.vue';
import QualityPicker from '@/components/layout/QualityPicker.vue';

/**
 * 全屏歌词页（与 web 端的 `LyricOverlay` 同一套观感）。
 *
 * 右侧常驻面板去掉之后，歌词不再是「一小块侧栏」，而是盖住内容区的整页：
 * 左边封面与歌曲信息，右边大字号歌词，底部传输控制。
 *
 * 整页连标题栏一起接管：不再给顶栏让出 `--titlebar-h`，而是在页内重建一条同高的
 * 标题栏 —— 左边品牌区带一道竖线，右边「一起听 / 歌单 | 最小化 最大化 关闭」，
 * 窗口拖动与关闭都落在这条带子上。
 */
const player = usePlayerStore();
const room = useRoomStore();
const ui = useUiStore();

/** 双击标题栏最大化/还原（macOS 的红绿灯在左边，这条带不背这个习惯）。 */
function toggleMaximize(): void {
  if (window.sakura.platform === 'darwin') return;
  void window.sakura.windowControls.toggleMaximize();
}

const roomSeat = computed(() => room.seatActive);
const shownPlaying = computed(() => (roomSeat.value ? room.playing : player.playing));
const currentMode = computed(() => (roomSeat.value ? room.playback?.mode ?? 'order' : player.mode));

const modeIcon = computed(() => {
  if (currentMode.value === 'one') return 'repeat-one';
  if (currentMode.value === 'all') return 'repeat';
  if (currentMode.value === 'shuffle') return 'shuffle';
  return 'list';
});

const track = computed(() => player.current);
const cover = computed(() => cachedImage(track.value?.album.cover));
const title = computed(() => track.value?.title ?? '未在播放');
/** 歌手/专辑各自成链接：平台信息齐全才跳，和 web 端的判断一致。 */
const artists = computed(() => track.value?.artists ?? []);
const albumName = computed(() => track.value?.album.name ?? '');
const sourceText = computed(() => {
  const platform = player.activeSource?.platform;
  return platform ? platformName(platform) : '';
});
const lines = computed<LyricLine[]>(() => parseLyricResult(player.lyric).lines);
const activeIndex = computed(() => activeLineIndex(lines.value, player.currentTime));
const hasLyric = computed(() => lines.value.length > 0);

const containerRef = ref<HTMLElement | null>(null);
const lineRefs = ref<HTMLElement[]>([]);
/** 用户手动滚动后的一段时间内暂停自动跟随（毫秒时间戳）。 */
let manualScrollUntil = 0;

/** 距当前行越远越淡，形成聚焦式的层次。 */
function lineOpacity(index: number): number {
  const active = activeIndex.value;
  if (active < 0) return 0.62;
  const distance = Math.abs(index - active);
  if (distance === 0) return 1;
  if (distance === 1) return 0.46;
  if (distance === 2) return 0.3;
  if (distance === 3) return 0.2;
  return 0.12;
}

function setLineRef(index: number, element: Element | null): void {
  if (element instanceof HTMLElement) lineRefs.value[index] = element;
}

/** 当前行的逐字元素：逐字歌词活跃行的每个字一个 span，rAF 里逐帧写 --wp。 */
const wordEls: (HTMLElement | null)[] = [];
function setWordRef(lineIndex: number, wordIndex: number, element: Element | null): void {
  if (lineIndex !== activeIndex.value) return;
  wordEls[wordIndex] = element instanceof HTMLElement ? element : null;
}

/* 逐字擦除主循环：activeIndex 本身走 timeupdate（约 4Hz）够用，字内进度必须逐帧。 */
let rafId = 0;

function tick(): void {
  rafId = requestAnimationFrame(tick);
  if (!ui.lyricsOpen) return;
  const seconds = player.preciseTime();
  const index = activeLineIndex(lines.value, seconds);
  const line = index >= 0 ? lines.value[index] : undefined;
  if (!line?.words?.length) return;
  wordEls.length = line.words.length;
  for (let wi = 0; wi < line.words.length; wi += 1) {
    const element = wordEls[wi];
    const word = line.words[wi];
    if (!element || !word) continue;
    const progress =
      seconds >= word.end ? 1 : seconds <= word.start ? 0 : (seconds - word.start) / Math.max(0.01, word.end - word.start);
    element.style.setProperty('--wp', `${(progress * 100).toFixed(2)}%`);
  }
}

/** 让当前行落在容器约 36% 高度处，而不是生硬地居中。 */
function scrollToActive(index: number): void {
  const container = containerRef.value;
  const element = lineRefs.value[index];
  if (!container || !element) return;
  const top = element.offsetTop - container.clientHeight * 0.36 + element.clientHeight / 2;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function onUserScroll(): void {
  manualScrollUntil = Date.now() + 4000;
}

watch(activeIndex, (index) => {
  if (!ui.lyricsOpen || index < 0 || Date.now() < manualScrollUntil) return;
  void nextTick(() => scrollToActive(index));
});

// 打开或切歌时直接定位（不做平滑滚动，避免一次长距离动画）。
watch([() => ui.lyricsOpen, () => track.value?.key], async ([open]) => {
  if (!open) return;
  manualScrollUntil = 0;
  lineRefs.value = [];
  await nextTick();
  const container = containerRef.value;
  const element = lineRefs.value[activeIndex.value];
  if (container && element) {
    container.scrollTop = Math.max(0, element.offsetTop - container.clientHeight * 0.36);
  }
});

/* ------------------------------ 传输控制 ------------------------------ */

const seekDraft = ref<number | null>(null);
const shownTime = computed(() => seekDraft.value ?? player.currentTime);
const duration = computed(() => player.duration || 0);
const progressPercent = computed(() =>
  duration.value > 0 ? Math.min(100, (shownTime.value / duration.value) * 100) : 0,
);
const volumePercent = computed(() => (player.muted ? 0 : Math.round(player.volume * 100)));

function toggle(): void {
  if (roomSeat.value) room.toggle();
  else player.toggle();
}

function prev(): void {
  if (roomSeat.value) room.prev();
  else void player.prev();
}

function next(): void {
  if (roomSeat.value) room.next();
  else void player.next();
}

function cycleMode(): void {
  if (roomSeat.value) room.cycleMode();
  else player.cycleMode();
}

function seekTo(seconds: number): void {
  const value = Math.max(0, seconds);
  seekDraft.value = null;
  if (roomSeat.value) room.seek(value);
  else player.seek(value);
}

function onSeekInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) seekDraft.value = value;
}

function onSeekDone(): void {
  if (seekDraft.value !== null) seekTo(seekDraft.value);
}

function onVolumeInput(event: Event): void {
  player.setVolume(Number((event.target as HTMLInputElement).value) / 100);
}

/* ------------------------------ 键盘 ------------------------------ */

function onKeydown(event: KeyboardEvent): void {
  if (!ui.lyricsOpen) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }

  switch (event.key) {
    case 'Escape':
      ui.closeLyrics();
      break;
    // 打开它的快捷键同样能关掉，不用记两套。
    case 'KeyL':
      ui.closeLyrics();
      break;
    case 'KeyQ':
      ui.toggleQueue();
      break;
    case ' ':
      event.preventDefault();
      toggle();
      break;
    case 'ArrowRight':
      event.preventDefault();
      seekTo(player.currentTime + 5);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      seekTo(player.currentTime - 5);
      break;
    case 'ArrowUp':
      event.preventDefault();
      player.setVolume(Math.min(1, player.volume + 0.05));
      break;
    case 'ArrowDown':
      event.preventDefault();
      player.setVolume(Math.max(0, player.volume - 0.05));
      break;
    default:
      break;
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  rafId = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  cancelAnimationFrame(rafId);
});
</script>

<template>
  <Transition name="lyric">
    <div v-if="ui.lyricsOpen && track" class="lyric-overlay">
      <!-- 氛围层：专辑封面大尺度模糊 + 主题色蒙层 -->
      <div
        class="lyric-backdrop"
        :style="cover ? { backgroundImage: `url(${cover})` } : {}"
        aria-hidden="true"
      />
      <div class="lyric-scrim" aria-hidden="true" />

      <!-- 页内标题栏：整页盖住窗口，这条带子同时是拖动区 -->
      <header class="lyric-top drag" @dblclick="toggleMaximize">
        <!-- 顶栏内容（收起/徽标/弹出 + 右上角操作区）所有播放页样式共享，见 NowPlayingTopActions -->
        <NowPlayingTopActions />
      </header>

      <div class="lyric-content">
        <!-- 左侧：封面与歌曲信息 -->
        <aside class="lyric-aside">
          <button type="button" class="cover-stage" title="点击封面收起歌词" @click="ui.closeLyrics()">
            <span class="cover-art">
              <img v-if="cover" :src="cover" :alt="title" />
              <AppIcon v-else name="music" :size="54" :stroke-width="1.2" />
            </span>
          </button>

          <h1 class="lyric-title">{{ title }}</h1>
          <!-- 歌手与专辑都可点进详情页；歌词页盖着整窗，跳转时顺手收起来 -->
          <p class="lyric-meta">
            <template v-if="artists.length === 0">未知歌手</template>
            <template v-for="(artist, artistIndex) in artists" :key="`${artist.name}-${artistIndex}`">
              <RouterLink
                v-if="artist.id && artist.platform"
                class="lyric-link"
                :to="{ name: 'artist', params: { platform: artist.platform, id: artist.id } }"
                @click="ui.closeLyrics()"
              >
                {{ artist.name }}
              </RouterLink>
              <span v-else>{{ artist.name }}</span>
              <span v-if="artistIndex < artists.length - 1" class="lyric-sep">/</span>
            </template>

            <template v-if="albumName">
              <span class="lyric-sep">·</span>
              <RouterLink
                v-if="track?.album.id && track?.album.platform"
                class="lyric-link lyric-album"
                :to="{ name: 'album', params: { platform: track.album.platform, id: track.album.id } }"
                @click="ui.closeLyrics()"
              >
                {{ albumName }}
              </RouterLink>
              <span v-else class="lyric-album">{{ albumName }}</span>
            </template>
          </p>

          <div class="lyric-tags">
            <span v-if="sourceText" class="tag">{{ sourceText }}</span>
            <!-- 音质同样可换：这里的芯片在页面上半部分，面板往下弹 -->
            <QualityPicker placement="down" align="left" />
            <span v-if="player.audioCache === 'full'" class="tag cache">缓存</span>
            <span v-else-if="player.usingDirect" class="tag direct">直连</span>
            <span v-else-if="!player.loading && player.current" class="tag relay">中转</span>
          </div>
        </aside>

        <!-- 右侧：歌词 -->
        <section class="lyric-stage">
          <div
            ref="containerRef"
            class="lyric-scroll"
            @wheel="onUserScroll"
            @touchmove.passive="onUserScroll"
          >
            <template v-if="hasLyric">
              <p
                v-for="(line, index) in lines"
                :key="`${line.time}-${index}`"
                :ref="(element) => setLineRef(index, element as Element | null)"
                class="lyric-line"
                :class="{ 'is-active': index === activeIndex }"
                :style="{ opacity: lineOpacity(index) }"
                @click="seekTo(line.time)"
              >
                <span class="lyric-text"><template v-if="line.words?.length"><span
                  v-for="(word, wordIndex) in line.words"
                  :key="wordIndex"
                  :ref="(element) => setWordRef(index, wordIndex, element as Element | null)"
                  class="lyric-word"
                >{{ word.text }}</span></template><template v-else>{{ line.text || '♪' }}</template></span>
                <span v-if="line.trans" class="lyric-trans">{{ line.trans }}</span>
              </p>
            </template>

            <div v-else class="lyric-empty">
              <AppIcon name="music" :size="32" :stroke-width="1.4" />
              <strong>{{ player.lyricLoading ? '歌词加载中…' : '这首歌暂时没有可用歌词' }}</strong>
              <span v-if="(track.sources?.length ?? 0) > 1">试试在播放条上切换到另一个平台的音源</span>
            </div>
          </div>
        </section>
      </div>

      <footer class="lyric-controls">
        <div class="progress-row">
          <span class="time">{{ formatTime(shownTime) }}</span>
          <input
            class="range"
            type="range"
            min="0"
            :max="duration || 0"
            step="0.1"
            :value="shownTime"
            :style="{ '--fill': `${progressPercent}%` }"
            :disabled="duration <= 0"
            aria-label="播放进度"
            @input="onSeekInput"
            @change="onSeekDone"
            @pointerup="onSeekDone"
          />
          <span class="time">{{ formatTime(duration) }}</span>
        </div>

        <div class="transport">
          <button
            type="button"
            class="btn-icon transport-side"
            :class="{ 'is-active': currentMode !== 'order' }"
            :title="currentMode"
            @click="cycleMode"
          >
            <AppIcon :name="modeIcon" :size="18" />
          </button>

          <button type="button" class="btn-icon transport-skip" title="上一首" @click="prev">
            <AppIcon name="prev" :size="21" filled />
          </button>

          <button type="button" class="play-btn" :title="shownPlaying ? '暂停（空格）' : '播放（空格）'" @click="toggle">
            <AppIcon v-if="player.loading" name="refresh" :size="19" class="spin" />
            <AppIcon v-else-if="shownPlaying" name="pause" :size="19" filled />
            <AppIcon v-else name="play" :size="19" filled />
          </button>

          <button type="button" class="btn-icon transport-skip" title="下一首" @click="next">
            <AppIcon name="next" :size="21" filled />
          </button>

          <div class="volume">
            <button
              type="button"
              class="btn-icon transport-side"
              :class="{ 'is-active': player.muted || player.volume === 0 }"
              :title="player.muted ? '取消静音' : '静音'"
              @click="player.toggleMute()"
            >
              <AppIcon :name="player.muted || player.volume === 0 ? 'mute' : 'volume'" :size="19" />
            </button>
            <div class="volume-pop">
              <input
                class="range volume-range"
                type="range"
                min="0"
                max="100"
                step="1"
                :value="volumePercent"
                :style="{ '--fill': `${volumePercent}%` }"
                aria-label="音量"
                @input="onVolumeInput"
              />
              <span class="volume-value">{{ volumePercent }}</span>
            </div>
          </div>
        </div>

        <!-- 快捷键提示：关掉一次就记住，别一直占着视线 -->
        <div v-if="ui.lyricHints" class="lyric-hints">
          <span class="lyric-hints-text">
            空格 播放 / 暂停 · <kbd>←</kbd> <kbd>→</kbd> 快退 / 快进 · <kbd>↑</kbd> <kbd>↓</kbd>
            音量 · Esc 收起 · 点击歌词跳转
          </span>
          <button
            type="button"
            class="hints-close"
            title="不再显示（可在设置里重新打开）"
            aria-label="不再显示快捷键提示"
            @click="ui.setLyricHints(false)"
          >
            <AppIcon name="close" :size="11" />
          </button>
        </div>
      </footer>
    </div>
  </Transition>
</template>

<style scoped>
.lyric-overlay {
  position: fixed;
  /* 整窗接管（含标题栏）：拖动与窗口按钮由页内标题栏自己承担。 */
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

/* ------------------------------ 氛围背景 ------------------------------ */

.lyric-backdrop {
  position: absolute;
  inset: -14%;
  background-position: center;
  background-size: cover;
  filter: blur(64px) saturate(1.6);
  opacity: 0.5;
  transform: scale(1.18);
}

.lyric-scrim {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(
      80% 60% at 16% 4%,
      color-mix(in srgb, var(--accent) 24%, transparent),
      transparent 64%
    ),
    radial-gradient(
      70% 60% at 92% 96%,
      color-mix(in srgb, var(--accent) 16%, transparent),
      transparent 62%
    ),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--bg) 78%, transparent) 0%,
      color-mix(in srgb, var(--bg) 90%, transparent) 55%,
      color-mix(in srgb, var(--bg) 96%, transparent) 100%
    );
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* ------------------------------ 顶栏 ------------------------------ */

/*
 * 页内标题栏与主界面同高（`--titlebar-h`）：
 * 左侧从窗口边开始就是「收起 + 正在播放」，右侧收着页面操作与窗口按钮。
 */
.lyric-top {
  position: relative;
  z-index: 3;
  display: flex;
  height: var(--titlebar-h);
  flex: none;
  align-items: stretch;
}

/* ------------------------------ 主体 ------------------------------ */

/*
 * 封面与歌词整体居中，而不是各自贴着窗口左右边。
 *
 * 宽屏下若让两列直接吃满整个窗口，封面会飘到最左、歌词行又拉得过长，
 * 视线要来回扫。这里给内容一个上限宽度并居中：封面固定在左侧 340px 内，
 * 歌词吃掉剩下的部分，两块都落在视线中央。
 */
.lyric-content {
  position: relative;
  z-index: 1;
  display: grid;
  flex: 1;
  width: min(1160px, 100%);
  margin: 0 auto;
  grid-template-columns: minmax(240px, 340px) minmax(0, 1fr);
  gap: clamp(32px, 4vw, 72px);
  min-height: 0;
  padding: 0 clamp(24px, 4vw, 56px);
}

.lyric-aside {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding-bottom: 3vh;
}

.cover-stage {
  display: block;
  width: 100%;
  margin-bottom: 26px;
  border-radius: 24px;
  box-shadow:
    0 34px 60px -30px color-mix(in srgb, var(--accent) 60%, transparent),
    0 12px 30px -18px rgba(0, 0, 0, 0.35);
  transition:
    transform 0.3s ease,
    box-shadow 0.3s ease;
}

.cover-stage:hover {
  transform: translateY(-6px) scale(1.012);
}

.cover-art {
  display: grid;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 24px;
  background: var(--surface);
  color: var(--text-faint);
}

.cover-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.lyric-title {
  font-size: clamp(22px, 2.4vw, 30px);
  font-weight: 780;
  letter-spacing: -0.01em;
  line-height: 1.25;
}

.lyric-meta {
  margin: 0;
  color: var(--text-muted);
  font-size: 13.5px;
  font-weight: 600;
}

.lyric-sep {
  margin: 0 5px;
  color: var(--text-faint);
}

.lyric-album {
  color: var(--text-faint);
  font-size: 12.5px;
  font-weight: 500;
}

/* 可点的歌手 / 专辑：保持正文观感，悬停才亮起并加下划线 */
.lyric-link {
  color: inherit;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease);
}

.lyric-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.lyric-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
}

.tag {
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}

.tag.direct {
  border-color: color-mix(in srgb, var(--success) 38%, transparent);
  color: var(--success);
}

.tag.relay {
  border-color: color-mix(in srgb, var(--text-muted) 30%, transparent);
  color: var(--text-muted);
}

.tag.cache {
  border-color: color-mix(in srgb, #6fa0ff 36%, transparent);
  color: #6fa0ff;
}

/* 音质芯片跟这一排 tag 同一种观感（它本身是通用组件，播放条上用更紧凑的那套）。 */
.lyric-tags :deep(.quality-trigger) {
  height: auto;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: 11px;
}

/* ------------------------------ 歌词 ------------------------------ */

.lyric-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/*
 * 上下留出大段空白，当前行才能停在视觉中部；只靠 mask 淡出边界，
 * 不叠实色渐变，否则会在模糊背景上显出一条横向色带。
 */
.lyric-scroll {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 32vh 4px 32vh 2px;
  overscroll-behavior: contain;
  scrollbar-width: none;
  mask-image: linear-gradient(
    180deg,
    transparent 0%,
    rgba(0, 0, 0, 0.2) 7%,
    rgba(0, 0, 0, 0.62) 17%,
    #000 30%,
    #000 70%,
    rgba(0, 0, 0, 0.62) 83%,
    rgba(0, 0, 0, 0.2) 93%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    180deg,
    transparent 0%,
    rgba(0, 0, 0, 0.2) 7%,
    rgba(0, 0, 0, 0.62) 17%,
    #000 30%,
    #000 70%,
    rgba(0, 0, 0, 0.62) 83%,
    rgba(0, 0, 0, 0.2) 93%,
    transparent 100%
  );
}

.lyric-scroll::-webkit-scrollbar {
  display: none;
}

.lyric-line {
  margin: 0;
  padding: 9px 0;
  color: var(--text);
  font-size: clamp(19px, 1.9vw, 27px);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.4;
  cursor: pointer;
  transform-origin: left center;
  transition:
    opacity 0.45s ease,
    color 0.3s ease,
    transform 0.3s ease;
}

.lyric-line:hover .lyric-text {
  color: var(--accent);
}

.lyric-text {
  display: block;
  transition: color 0.25s ease;
}

.lyric-trans {
  display: block;
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 0.58em;
  font-weight: 600;
}

.lyric-line.is-active {
  color: var(--accent);
  transform: scale(1.045);
}

.lyric-line.is-active .lyric-text {
  text-shadow: 0 0 26px color-mix(in srgb, var(--accent) 40%, transparent);
}

/*
 * 逐字擦除（上游给了 YRC/QRC 时）：每个字的 --wp 由 rAF 逐帧写入（0%→100%），
 * 唱到的字按自身时间轴擦亮成主题色，没唱到的压成半透白。
 */
.lyric-line.is-active .lyric-word {
  --wp: 0%;
  background-image: linear-gradient(
    100deg,
    var(--accent) calc(var(--wp) - 6%),
    color-mix(in srgb, var(--text) 42%, transparent) calc(var(--wp) + 10%)
  );
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

/* hover 变主题色那条规则对逐字行不适用：背景裁剪的文字得保持透明底色。 */
.lyric-line.is-active:hover .lyric-word {
  color: transparent;
}

.lyric-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 6vh;
  color: var(--text-muted);
  text-align: center;
}

.lyric-empty strong {
  font-size: 15px;
}

.lyric-empty span {
  color: var(--text-faint);
  font-size: 12.5px;
}

/* ------------------------------ 底部控制 ------------------------------ */

.lyric-controls {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 0 8vw 22px;
}

.progress-row {
  display: flex;
  width: min(720px, 100%);
  align-items: center;
  gap: 12px;
}

.time {
  min-width: 46px;
  color: var(--text-faint);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.transport-side {
  color: var(--text-muted);
}

.transport-side:hover {
  color: var(--text);
}

.transport-side.is-active {
  color: var(--accent);
}

.transport-skip {
  width: 38px;
  height: 38px;
  color: var(--text);
}

.transport-skip:hover {
  color: var(--accent);
}

.play-btn {
  display: grid;
  width: 54px;
  height: 40px;
  place-items: center;
  border-radius: 999px;
  color: var(--accent-contrast);
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  box-shadow: 0 12px 26px -14px color-mix(in srgb, var(--accent) 90%, transparent);
  transition:
    transform 0.18s ease,
    filter 0.18s ease;
}

.play-btn:hover {
  transform: scale(1.045);
  filter: saturate(1.08);
}

.play-btn:active {
  transform: scale(0.97);
}

/* 进度与音量共用同一条滑杆外观 */
.range {
  flex: 1;
  height: 6px;
  appearance: none;
  border-radius: 999px;
  background-image:
    linear-gradient(90deg, var(--accent), var(--accent-2)),
    linear-gradient(var(--border-strong), var(--border-strong));
  background-repeat: no-repeat;
  background-size:
    var(--fill) 100%,
    100% 100%;
  cursor: pointer;
  outline: none;
}

.range:disabled {
  cursor: default;
  opacity: 0.5;
}

.range::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  appearance: none;
  border-radius: 999px;
  background: #fff;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.28),
    0 0 0 3px color-mix(in srgb, var(--accent) 32%, transparent);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.range:hover::-webkit-slider-thumb,
.range:active::-webkit-slider-thumb {
  opacity: 1;
  transform: none;
}

/* ------------------------------ 音量 ------------------------------ */

.volume {
  position: relative;
  display: flex;
  align-items: center;
}

.volume-pop {
  position: absolute;
  bottom: calc(100% + 14px);
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-strong);
  backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--shadow-lg);
  opacity: 0;
  visibility: hidden;
  transform: translate(-50%, 8px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    visibility 0.2s;
}

.volume-pop::after {
  position: absolute;
  right: 0;
  bottom: -14px;
  left: 0;
  height: 14px;
  content: '';
}

.volume:hover .volume-pop,
.volume-pop:hover {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
}

.volume-range {
  width: 104px;
  flex: none;
}

.volume-value {
  min-width: 20px;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.lyric-hints {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.lyric-hints-text {
  line-height: 1.5;
}

.hints-close {
  display: grid;
  width: 18px;
  height: 18px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: var(--text-faint);
  opacity: 0.7;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    opacity var(--dur-fast) var(--ease);
}

.hints-close:hover {
  background: var(--surface-hover);
  color: var(--text);
  opacity: 1;
}

.lyric-hints kbd {
  display: inline-block;
  padding: 1px 6px;
  margin: 0 1px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-strong);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 650;
}

/* ------------------------------ 过渡 ------------------------------ */

.lyric-enter-active,
.lyric-leave-active {
  transition:
    opacity 0.28s ease,
    transform 0.28s ease;
}

.lyric-enter-from,
.lyric-leave-to {
  opacity: 0;
  transform: translateY(22px) scale(0.99);
}

/* 窄窗口：单列，封面收小、歌词居中 */
@media (max-width: 900px) {
  .lyric-backdrop {
    filter: blur(28px) saturate(1.4);
  }


  .lyric-content {
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    padding: 0 6vw;
  }


  .lyric-aside {
    align-items: center;
    justify-content: flex-start;
    padding-bottom: 0;
    text-align: center;
  }

  .cover-stage {
    width: min(38vh, 46vw, 200px);
    margin-bottom: 16px;
  }

  .lyric-tags {
    justify-content: center;
  }

  .lyric-line {
    text-align: center;
    transform-origin: center;
  }
}
</style>
