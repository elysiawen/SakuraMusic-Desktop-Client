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
/** 首个 WebGL 帧渲染出来之前为 true——这期间画布是黑的，用加载动画盖住。 */
const booting = ref(false);
/** 首帧已渲染：画布自身淡入+轻微拉远的入场由它驱动，避免「突然亮灯」。 */
const live = ref(false);
let runtime: NebbiaRuntime | null = null;

function destroyRuntime(): void {
  runtime?.destroy();
  runtime = null;
  booting.value = false;
  live.value = false;
}

function createRuntime(): void {
  const host = hostRef.value;
  if (!host) return;
  destroyRuntime();
  booting.value = true;
  live.value = false;
  try {
    runtime = new NebbiaRuntime(
      {
        host,
        seeThrough: false,
        scene: 'night',
        glass: 'rain',
        currentTime: { get: () => player.preciseTime() },
        vocal: { get: () => sampleVocal() },
        onFirstFrame: () => {
          booting.value = false;
          live.value = true;
        },
        onFailed: () => {
          booting.value = false;
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
  <Transition name="nebbia">
    <div v-if="ui.lyricsOpen && track" class="mist-overlay">
      <!-- 雾笺的画布由运行时挂进这个宿主（WebGL2；街景、雾、字全在里面） -->
      <div ref="hostRef" class="nebbia-host" :class="{ live }" aria-hidden="true" />
      <!-- 冷启动：着色器/笔顺数据加载期间画布是黑的，用呼吸水滴盖住，首帧渲染后淡出 -->
      <Transition name="boot">
        <div v-if="booting && !failed" class="nebbia-boot" aria-hidden="true">
          <span class="boot-mark">
            <AppIcon name="droplet" :size="24" />
          </span>
          <span class="boot-text">雾气凝结中</span>
        </div>
      </Transition>
      <!-- WebGL2 不可用时的兜底：只显示当前这句 -->
      <div v-if="failed" class="nebbia-fallback">{{ fallbackText }}</div>

      <!-- 页内标题栏：整页盖住窗口，这条带子同时是拖动区 -->
      <header class="mist-top drag" @dblclick="toggleMaximize">
        <!-- 顶栏内容（收起/徽标/弹出 + 右上角操作区）所有播放页样式共享，见 NowPlayingTopActions -->
        <NowPlayingTopActions />
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
            <span class="meta-tags-inner">
              <span v-if="sourceText" class="tag">{{ sourceText }}</span>
              <QualityPicker placement="down" align="right" />
              <span v-if="player.audioCache === 'full'" class="tag cache">缓存</span>
              <span v-else-if="player.usingDirect" class="tag direct">直连</span>
              <span v-else-if="!player.loading && player.current" class="tag relay">中转</span>
            </span>
          </span>
        </div>

        <!-- 悬停展开区：进度与按键收在这里，鼠标移上浮块才展开 -->
        <div class="chip-expand">
          <div class="chip-expand-inner">
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
                  <div class="volume-pop-inner">
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
          </div>
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

/*
 * 画布入场：首帧渲染前透明且略微放大；首帧一到，与加载层的淡出交叠，
 * 缓慢淡入并拉远到位——雨夜街景是「亮」出来的，不是跳出来的。
 */
.nebbia-host {
  position: absolute;
  inset: 0;
  opacity: 0;
  transform: scale(1.03);
  transition:
    opacity 0.9s ease 0.1s,
    transform 1.4s var(--ease) 0.1s;
}

.nebbia-host.live {
  opacity: 1;
  transform: none;
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

/* ------------------------------ 角落浮块控制区（玻璃拟态） ------------------------------ */

/*
 * 控制区缩成右下角的一小块浮板：雾笺的舞台是整块玻璃，整条横栏会把
 * 写字的低位区域和街景全挡住。信息布局不变，只是宽度收窄、行距收紧，
 * 标签放不下时换到第二行。
 */
.mist-controls {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  /*
   * 注意这里不能设 gap：折叠时展开区高度为 0 但仍占一个 flex 项，
   * gap 会让浮块底部凭空多出一截。与展开区的间距改由 .chip-expand 的
   * margin-top 提供，折叠时随之归零。
   */
  /*
   * 宽度跟随内容：折叠时贴着「封面+歌名+歌手」收缩，最长 420px；
   * 悬停展开时长到固定宽度容纳进度条与按键。interpolate-size 让
   * fit-content → 固定长度之间也能做过渡动画（不支持的旧内核只是瞬跳）。
   */
  width: fit-content;
  max-width: min(420px, calc(100% - 36px));
  interpolate-size: allow-keywords;
  transition: width 0.32s var(--ease);
  /* 顶部 margin 用 auto 把自己顶到底部，贴右下角 */
  margin: auto 18px 18px 0;
  align-self: flex-end;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 20px;
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
  justify-content: flex-start;
  gap: 9px;
}

/*
 * 悬停展开区：平时高度为 0，只留封面/歌名/歌手一行；
 * 鼠标移上（或键盘焦点进入）浮块时展开出标签、进度条与按键。
 * grid-template-rows 0fr→1fr 是高度自适应内容且可动画的写法。
 */
.chip-expand {
  display: grid;
  width: 100%;
  margin-top: 0;
  grid-template-rows: 0fr;
  opacity: 0;
  /* 收起时：淡出比高度收拢快一点，内容先隐去再合拢 */
  transition:
    grid-template-rows 0.32s var(--ease),
    margin-top 0.32s var(--ease),
    opacity 0.14s ease;
}

/*
 * 折叠时把展开区的宽度贡献清零——否则按钮行的固有宽度会撑开
 * fit-content 的浮块，「宽度跟随文字」就失效了。
 */
.mist-controls:not(:hover):not(:focus-within) .chip-expand {
  width: 0;
}

.mist-controls:hover,
.mist-controls:focus-within {
  /* 展开时放宽到固定的 420px，进度条和按键才有施展空间 */
  width: min(420px, calc(100% - 36px));
}

.mist-controls:hover .chip-expand,
.mist-controls:focus-within .chip-expand {
  margin-top: 8px;
  grid-template-rows: 1fr;
  opacity: 1;
  /*
   * 展开时：淡入再压晚半拍（0.12s 才开始）。缓动是强 ease-out，
   * 高度在前 40% 时间里已涨过大半，等内容淡入到可见时基本不再被裁切。
   */
  transition:
    grid-template-rows 0.32s var(--ease),
    margin-top 0.32s var(--ease),
    opacity 0.26s ease 0.12s;
}

.chip-expand-inner {
  display: flex;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  /*
   * 内容锚定在展开区底部：高度从 0 涨开时，内容像卷帘一样从 meta 行
   * 下方整体落出，裁切线固定在顶边——读起来是「下拉」，而不是被底边
   * 一刀切出来。
   */
  justify-content: flex-end;
  gap: 8px;
  overflow: hidden;
  transform: translateY(-6px);
  transition: transform 0.32s var(--ease);
}

.mist-controls:hover .chip-expand-inner,
.mist-controls:focus-within .chip-expand-inner {
  transform: translateY(0);
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
  max-width: 11em;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-sub {
  overflow: hidden;
  max-width: 11em;
  margin: 0;
  color: var(--text-muted);
  font-size: 11.5px;
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

/*
 * 标签组钉在 meta 行最右侧；折叠时收成 0 宽，悬停展开时与浮块的
 * 宽度动画用同一时长/缓动一起滑出——不能 display 硬切，否则它会在
 * 宽度动画中途突然挤进布局，看起来就是一卡。
 */
.meta-tags {
  display: grid;
  flex: none;
  margin-left: auto;
  grid-template-columns: 0fr;
  opacity: 0;
  transition:
    grid-template-columns 0.32s var(--ease),
    opacity 0.2s ease;
}

.mist-controls:hover .meta-tags,
.mist-controls:focus-within .meta-tags {
  grid-template-columns: 1fr;
  opacity: 1;
}

.meta-tags-inner {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
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
  min-width: 38px;
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
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
  width: 32px;
  height: 32px;
  color: var(--text);
}

.transport-skip:hover {
  color: var(--accent);
}

/* 播放键：雾玻璃上一颗擦亮的水珠——深底上白色最亮，焦点不会丢 */
.play-btn {
  display: grid;
  width: 44px;
  height: 44px;
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

/*
 * 音量条在按键行内向右展开：不再是浮层，而是音量按钮右侧的一段
 * 0fr→1fr 的行内容器。浮块右边缘钉在屏幕上，展开时整排按键自然左移。
 */
.volume-pop {
  display: grid;
  grid-template-columns: 0fr;
  opacity: 0;
  transition:
    grid-template-columns 0.25s var(--ease),
    opacity 0.2s ease;
}

.volume-pop-inner {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.volume:hover .volume-pop,
.volume-pop:hover {
  grid-template-columns: 1fr;
  opacity: 1;
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

/* ------------------------------ 冷启动加载动画 ------------------------------ */

/*
 * 首个 WebGL 帧渲染前盖住黑画布：一滴呼吸的水 + 两圈扩散涟漪。
 * 首帧一到即淡出（boot 过渡），不挡交互。
 */
.nebbia-boot {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: rgba(255, 255, 255, 0.72);
  pointer-events: none;
}

.boot-mark {
  position: relative;
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  animation: boot-breathe 1.8s var(--ease) infinite;
}

.boot-mark::before,
.boot-mark::after {
  position: absolute;
  inset: 0;
  border: 1px solid rgba(255, 255, 255, 0.32);
  border-radius: 50%;
  animation: boot-ripple 2.2s ease-out infinite;
  content: '';
}

.boot-mark::after {
  animation-delay: 1.1s;
}

.boot-text {
  font-size: 12px;
  letter-spacing: 0.3em;
  text-indent: 0.3em; /* letter-spacing 末位也占宽，补回视觉居中 */
  opacity: 0.65;
}

@keyframes boot-ripple {
  0% {
    opacity: 0;
    transform: scale(0.55);
  }
  25% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: scale(1.5);
  }
}

@keyframes boot-breathe {
  0%,
  100% {
    opacity: 0.65;
    transform: scale(0.96);
  }
  50% {
    opacity: 1;
    transform: scale(1.04);
  }
}

.boot-enter-active {
  transition: opacity 0.25s ease;
}

.boot-leave-active {
  transition: opacity 0.45s ease;
}

.boot-enter-from,
.boot-leave-to {
  opacity: 0;
}

/* ------------------------------ 过渡 ------------------------------ */

.nebbia-enter-active,
.nebbia-leave-active {
  transition:
    opacity 0.32s ease,
    transform 0.32s ease;
}

.nebbia-enter-from,
.nebbia-leave-to {
  opacity: 0;
  transform: scale(1.02);
}
</style>
