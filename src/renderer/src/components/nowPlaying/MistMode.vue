<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useUiStore } from '@/stores/ui';
import { formatTime, platformName } from '@/utils/format';
import { cachedImage } from '@/utils/cacheImage';
import { activeLineIndex, parseLyricResult, type LyricLine } from '@/utils/lyric';
import { extractPalette, type CoverPalette } from '@/utils/palette';
import NowPlayingTopActions from './NowPlayingTopActions.vue';
import QualityPicker from '@/components/layout/QualityPicker.vue';
import { NebbiaRuntime } from './nebbia/createNebbiaRuntime';
import { DEFAULT_NEBBIA_TUNING } from './nebbia/types';
import type { Line, Theme } from './nebbia/foliaTypes';

/**
 * 雾笺模式（移植自 Folia 的 Nebbia）：雨夜公交车的车窗，玻璃上结着雾，
 * 一只看不见的手把当前句歌词按笔顺一笔一画写在雾上；写好的字会挂水珠、
 * 慢慢被重新漫上来的雾盖掉。雨点跟着人声打在玻璃上，车身随节奏颠簸，
 * 两盏路灯跟着正在唱的字移动。曲终在玻璃上写出曲名和歌手。
 *
 * 渲染是 WebGL2（见 nebbia/ 目录，运行时只有这一个接入点）；WebGL2 不可用
 * 或上下文丢失时退回只显示当前这句文字。因为歌词画在 canvas 上，
 * 这个样式不支持「点击歌词跳转」，跳转走底部进度条。
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
const artists = computed(() => track.value?.artists ?? []);
const albumName = computed(() => track.value?.album.name ?? '');
const sourceText = computed(() => {
  const platform = player.activeSource?.platform;
  return platform ? platformName(platform) : '';
});
const lines = computed<LyricLine[]>(() => parseLyricResult(player.lyric).lines);
const hasLyric = computed(() => lines.value.length > 0);

/** 退回纯文字时的当前行（见 ImmersiveMode：activeIdx 只在 rAF 里用逐帧时钟更新）。 */
const activeIdx = ref(-1);

/* ------------------------------ 封面取色 ------------------------------ */

const palette = ref<CoverPalette | null>(null);
watch(
  cover,
  (url) => {
    if (!url) {
      palette.value = null;
      return;
    }
    void extractPalette(url).then((result) => {
      if (cover.value === url) palette.value = result;
    });
  },
  { immediate: true },
);

/* ------------------------------ 主题 ------------------------------ */

let accentCss = '';
let accent2Css = '';
let themeObserver: MutationObserver | null = null;

function readThemeColors(): void {
  const style = getComputedStyle(document.documentElement);
  accentCss = style.getPropertyValue('--accent').trim();
  accent2Css = style.getPropertyValue('--accent-2').trim();
}

/** 雾笺的夜景配色从主题色与封面色来（nebbiaPalette.ts）；夜里的天色用固定的深色。 */
function currentTheme(): Theme {
  return {
    accentColor: accentCss || '#f2a7c3',
    secondaryColor: accent2Css || undefined,
    primaryColor: palette.value?.primary,
    backgroundColor: '#05070a',
  };
}

/* ------------------------------ 人声能量（雨点强度） ------------------------------ */

let analyserNode: AnalyserNode | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;
let vocalFromBin = 4;
let vocalToBin = 40;
let vocalFallbackPhase = 0;

function attachVocalAnalyser(): void {
  analyserNode = player.attachAnalyser();
  if (analyserNode) {
    const binHz = analyserNode.context.sampleRate / 2 / analyserNode.frequencyBinCount;
    vocalFromBin = Math.max(1, Math.floor(300 / binHz));
    vocalToBin = Math.min(analyserNode.frequencyBinCount - 1, Math.ceil(3400 / binHz));
    freqData = new Uint8Array(analyserNode.frequencyBinCount);
  }
}

/** 每帧由运行时的 vocal.get() 调：有人声频段能量就给人声，没有就用缓慢的呼吸打底。 */
function sampleVocal(): number {
  if (analyserNode && freqData) {
    analyserNode.getByteFrequencyData(freqData);
    let sum = 0;
    for (let i = vocalFromBin; i <= vocalToBin; i++) sum += freqData[i] ?? 0;
    return Math.min(1, (sum / ((vocalToBin - vocalFromBin + 1) * 255)) * 2.2);
  }
  vocalFallbackPhase += 0.016;
  const playLevel = shownPlaying.value ? 1 : 0;
  return (Math.max(0, Math.sin(vocalFallbackPhase * 2.4)) ** 2 * 0.5 + 0.05) * playLevel;
}

/* ------------------------------ 歌词 → 雾笺的行 ------------------------------ */

/**
 * 雾笺按字的书写节奏吃 word 级时间轴：上游给了逐字歌词（YRC/QRC）就照真实节奏写；
 * 只有按行 LRC 的歌 words 为空，由 graphemeTiming 按行时长均摊。
 * 行结束优先用逐字数据自带的行尾，否则取下一行开始（封顶 8 秒，免得长间奏里字写得太慢），
 * 最后一行给 4 秒。
 */
function toFoliaLines(source: LyricLine[]): Line[] {
  return source.map((line, index) => {
    const next = source[index + 1]?.time;
    const fallbackEnd =
      next === undefined ? line.time + 4 : Math.max(line.time, Math.min(next, line.time + 8));
    return {
      fullText: line.text,
      startTime: line.time,
      endTime: line.end ?? fallbackEnd,
      words: (line.words ?? []).map((word) => ({
        text: word.text,
        startTime: word.start,
        endTime: word.end,
      })),
    };
  });
}

const song = computed(() => ({
  lines: toFoliaLines(lines.value),
  seed: track.value?.key ?? 'nebbia',
  title: track.value?.title ?? null,
  artist: artists.value.map((artist) => artist.name).join('/') || null,
}));

/* ------------------------------ 雾笺运行时 ------------------------------ */

const hostRef = ref<HTMLElement | null>(null);
const failed = ref(false);
let runtime: NebbiaRuntime | null = null;

function destroyRuntime(): void {
  runtime?.destroy();
  runtime = null;
}

function createRuntime(): void {
  const host = hostRef.value;
  if (!host) return;
  destroyRuntime();
  try {
    runtime = new NebbiaRuntime(
      {
        host,
        seeThrough: false,
        scene: 'night',
        glass: 'rain',
        currentTime: { get: () => player.preciseTime() },
        vocal: { get: () => sampleVocal() },
        onFirstFrame: () => {},
        onFailed: () => {
          failed.value = true;
        },
        // 上下文丢了又回来：整个运行时重建（纹理、着色器都要重来）
        onRestored: () => createRuntime(),
      },
      currentTheme(),
      DEFAULT_NEBBIA_TUNING,
      1,
    );
    runtime.setSong(song.value);
    runtime.setPlayback(!shownPlaying.value, false);
    failed.value = false;
  } catch (error) {
    console.warn('[Nebbia] 雾笺启动失败，退回纯文字', error);
    runtime = null;
    failed.value = true;
  }
}

watch(song, (value) => runtime?.setSong(value));
watch(shownPlaying, (playing) => runtime?.setPlayback(!playing, false));

// 覆盖层是 v-if 挂载的：打开时等 DOM 出来再起运行时，关上就销毁（不然画布挂在被移除的旧宿主上）
watch(
  () => ui.lyricsOpen && !!track.value,
  async (open) => {
    if (open) {
      await nextTick();
      createRuntime();
    } else {
      destroyRuntime();
    }
  },
  { immediate: true },
);
// 暂停时循环停着，拖动进度要手动补一帧
watch(
  () => player.currentTime,
  () => {
    if (!shownPlaying.value) runtime?.requestFrame();
  },
);
// 封面取色或主题色变了：夜景配色跟着换
watch([palette, () => accentCss, () => accent2Css], () => {
  runtime?.setTheme(currentTheme());
});

const fallbackText = computed(() => {
  if (!hasLyric.value) return track.value ? '♪' : '';
  const index = activeIdx.value;
  return index >= 0 ? (lines.value[index]?.text ?? '') : '';
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

/* ------------------------------ 生命周期 ------------------------------ */

let rafId = 0;

function tick(): void {
  rafId = requestAnimationFrame(tick);
  // 只给退回纯文字的兜底用；雾笺自己的时钟在运行时的循环里
  if (failed.value && ui.lyricsOpen) {
    activeIdx.value = activeLineIndex(lines.value, player.preciseTime());
  }
}

watch(hasLyric, () => runtime?.setSong(song.value));

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  attachVocalAnalyser();
  readThemeColors();
  themeObserver = new MutationObserver(() => {
    readThemeColors();
    runtime?.setTheme(currentTheme());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-palette'],
  });
  rafId = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  cancelAnimationFrame(rafId);
  themeObserver?.disconnect();
  destroyRuntime();
});
</script>

<template>
  <Transition name="mist">
    <div v-if="ui.lyricsOpen && track" class="mist-overlay">
      <!-- 雾笺的画布由运行时挂进这个宿主（WebGL2；街景、雾、字全在里面） -->
      <div ref="hostRef" class="nebbia-host" aria-hidden="true" />
      <!-- WebGL2 不可用时的兜底：只显示当前这句 -->
      <div v-if="failed" class="nebbia-fallback">{{ fallbackText }}</div>

      <!-- 页内标题栏：整页盖住窗口，这条带子同时是拖动区 -->
      <header class="mist-top drag" @dblclick="toggleMaximize">
        <div class="mist-topbar">
          <div class="mist-top-left no-drag" @dblclick.stop>
            <button type="button" class="btn-icon" title="收起（Esc）" @click="ui.closeLyrics()">
              <AppIcon name="chevron-down" :size="20" />
            </button>
            <span class="mist-badge">
              <span class="eq" :class="{ 'is-playing': shownPlaying }" aria-hidden="true">
                <i /><i /><i />
              </span>
              {{ roomSeat ? '一起听中' : '正在播放' }}
            </span>
          </div>

          <!-- 右上角操作区：所有播放页样式共享同一份，见 NowPlayingTopActions -->
          <NowPlayingTopActions />
        </div>
      </header>

      <!-- 中部留给雾笺：歌词由运行时「写」在玻璃上，没有 DOM 歌词 -->

      <footer class="mist-controls">
        <!-- 歌曲信息收进底部：玻璃的舞台不压字 -->
        <div class="mist-meta">
          <span class="meta-cover">
            <img v-if="cover" :src="cover" :alt="title" />
            <AppIcon v-else name="music" :size="16" :stroke-width="1.4" />
          </span>
          <h1 class="meta-title">{{ title }}</h1>
          <p class="meta-sub">
            <template v-if="artists.length === 0">未知歌手</template>
            <template v-for="(artist, artistIndex) in artists" :key="`${artist.name}-${artistIndex}`">
              <RouterLink
                v-if="artist.id && artist.platform"
                class="meta-link"
                :to="{ name: 'artist', params: { platform: artist.platform, id: artist.id } }"
                @click="ui.closeLyrics()"
              >
                {{ artist.name }}
              </RouterLink>
              <span v-else>{{ artist.name }}</span>
              <span v-if="artistIndex < artists.length - 1" class="meta-sep">/</span>
            </template>
            <template v-if="albumName">
              <span class="meta-sep">·</span>
              <RouterLink
                v-if="track?.album.id && track?.album.platform"
                class="meta-link"
                :to="{ name: 'album', params: { platform: track.album.platform, id: track.album.id } }"
                @click="ui.closeLyrics()"
              >
                {{ albumName }}
              </RouterLink>
              <span v-else>{{ albumName }}</span>
            </template>
          </p>
          <span class="meta-tags">
            <span v-if="sourceText" class="tag">{{ sourceText }}</span>
            <QualityPicker placement="down" align="left" />
            <span v-if="player.usingDirect" class="tag direct">直连</span>
          </span>
        </div>

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

        <div v-if="ui.lyricHints" class="mist-hints">
          <span class="mist-hints-text">
            空格 播放 / 暂停 · <kbd>←</kbd> <kbd>→</kbd> 快退 / 快进 · <kbd>↑</kbd> <kbd>↓</kbd>
            音量 · Esc 收起
          </span>
          <button
            type="button"
            class="hints-close"
            title="不再显示"
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
.mist-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 雾笺固定深夜氛围：雨夜街景画在深天上，雾是深色的夜里车窗 */
  --bg: #05070a;
  --text: #f2f3f7;
  --text-muted: rgba(242, 243, 247, 0.64);
  --text-faint: rgba(242, 243, 247, 0.42);
  --border: rgba(255, 255, 255, 0.14);
  --border-strong: rgba(255, 255, 255, 0.24);
  --surface: rgba(255, 255, 255, 0.08);
  --surface-hover: rgba(255, 255, 255, 0.12);
  --surface-strong: rgba(20, 23, 33, 0.82);
  color: var(--text);
  background: var(--bg);
}

/* ------------------------------ 雾笺宿主与兜底 ------------------------------ */

.nebbia-host {
  position: absolute;
  inset: 0;
}

.nebbia-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 10vw;
  font-size: clamp(1.8rem, 4.6vw, 4.4rem);
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: center;
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.55);
}

/* ------------------------------ 顶栏 ------------------------------ */

.mist-top {
  position: relative;
  z-index: 3;
  display: flex;
  height: var(--titlebar-h);
  flex: none;
  align-items: stretch;
}

.mist-topbar {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 16px;
}

.mist-top-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mist-badge {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 6px 14px 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-strong) 72%, transparent);
  backdrop-filter: blur(var(--glass-blur));
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.eq {
  display: inline-flex;
  height: 12px;
  align-items: flex-end;
  gap: 2.5px;
}

.eq i {
  width: 2.5px;
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
  transition: height 0.2s ease;
}

.eq.is-playing i {
  animation: eq-bounce 900ms ease-in-out infinite alternate;
}

.eq.is-playing i:nth-child(2) {
  animation-delay: 180ms;
}

.eq.is-playing i:nth-child(3) {
  animation-delay: 360ms;
}

@keyframes eq-bounce {
  from {
    height: 3px;
  }
  to {
    height: 12px;
  }
}

/* ------------------------------ 底部控制（玻璃拟态） ------------------------------ */

.mist-controls {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: min(760px, calc(100% - 48px));
  margin: 0 auto 20px;
  padding: 14px 22px 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 26px;
  /*
   * 雾面玻璃板：不是深色卡片，而是一层半透的白磨砂——
   * 像雾气上被薄薄擦开的一块，底下的雾与光斑还能透上来。
   * 顶部 inset 高光是玻璃上沿凝结的那道亮边。
   */
  background: linear-gradient(180deg, rgba(226, 233, 243, 0.1), rgba(226, 233, 243, 0.055));
  backdrop-filter: blur(26px) saturate(1.1);
  box-shadow:
    0 24px 48px -24px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.mist-meta {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.meta-cover {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text-faint);
}

.meta-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.meta-title {
  overflow: hidden;
  max-width: 32vw;
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-sub {
  overflow: hidden;
  max-width: 30vw;
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-sep {
  margin: 0 5px;
  color: var(--text-faint);
}

.meta-link {
  color: inherit;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease);
}

.meta-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.meta-tags {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
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

.meta-tags :deep(.quality-trigger) {
  height: auto;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: 11px;
}

.progress-row {
  display: flex;
  width: 100%;
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

/* 播放键：雾玻璃上一颗擦亮的水珠——深底上白色最亮，焦点不会丢 */
.play-btn {
  display: grid;
  width: 52px;
  height: 52px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.94);
  background: radial-gradient(
    circle at 32% 26%,
    rgba(255, 255, 255, 0.32),
    rgba(255, 255, 255, 0.1) 58%,
    rgba(255, 255, 255, 0.05)
  );
  box-shadow:
    0 10px 24px -10px rgba(0, 0, 0, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
  transition:
    transform 0.18s ease,
    background 0.18s ease;
}

.play-btn:hover {
  transform: scale(1.06);
  background: radial-gradient(
    circle at 32% 26%,
    rgba(255, 255, 255, 0.42),
    rgba(255, 255, 255, 0.16) 58%,
    rgba(255, 255, 255, 0.08)
  );
}

.play-btn:active {
  transform: scale(0.96);
}

/*
 * 进度条/音量条 = 玻璃上的一道水痕：
 * 轨道是没擦的薄雾（半透白），填充是「擦开的水痕」——竖向渐变，顶部更亮，
 * 模拟水痕上沿的反光；thumb 是一粒常显的小水珠（拖动时略放大）。
 */
.range {
  flex: 1;
  height: 10px;
  appearance: none;
  border-radius: 999px;
  background-color: rgba(255, 255, 255, 0.13);
  background-image: linear-gradient(
    180deg,
    rgba(246, 249, 253, 0.95),
    rgba(230, 237, 246, 0.5)
  );
  background-repeat: no-repeat;
  background-size: var(--fill) 100%;
  cursor: pointer;
  outline: none;
  transition: height 0.18s ease;
}

.range:disabled {
  cursor: default;
  opacity: 0.5;
}

.range::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  appearance: none;
  border-radius: 50%;
  background: radial-gradient(
    circle at 34% 28%,
    #ffffff 0%,
    rgba(238, 243, 250, 0.92) 45%,
    rgba(208, 219, 234, 0.78) 100%
  );
  box-shadow:
    0 1px 6px rgba(0, 0, 0, 0.35),
    0 0 10px rgba(255, 255, 255, 0.35);
  transition: transform 0.15s ease;
}

.range:active::-webkit-slider-thumb {
  transform: scale(1.2);
}

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

.mist-hints {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.mist-hints kbd {
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

/* ------------------------------ 过渡 ------------------------------ */

.mist-enter-active,
.mist-leave-active {
  transition:
    opacity 0.32s ease,
    transform 0.32s ease;
}

.mist-enter-from,
.mist-leave-to {
  opacity: 0;
  transform: scale(1.02);
}
</style>
