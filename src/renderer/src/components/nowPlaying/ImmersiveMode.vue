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

/**
 * 沉浸式全屏播放页（与经典的 `ClassicMode` 并存，顶栏样式菜单即时切换）。
 *
 * 三件事撑起「沉浸」：
 *  1. 流体渐变背景 —— 封面取色后的几个色块在低分辨率 canvas 上漂移，CSS 放大加模糊，
 *     低频能量（AnalyserNode）驱动它们随节拍呼吸；
 *  2. 底部镜像频谱 —— 同源 `/media` 音频没有跨域问题，直接取真实频谱；
 *     环境不支持 Web Audio 时退化为模拟节拍，画面不会死；
 *  3. 大字居中的歌词 —— 当前行超大字号，行内做「卡拉 OK」式扫光（按行时长推进），
 *     远近行按距离缩小淡出。
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

/**
 * 当前行下标只在自己手里更新（见 tick）：timeupdate 的 `player.currentTime` 约 4Hz，
 * 扫光与行切换都要逐帧时钟（`player.preciseTime()`），activeIdx 变了才喂给模板。
 */
const activeIdx = ref(-1);

/* ------------------------------ 滚动跟随 ------------------------------ */

const containerRef = ref<HTMLElement | null>(null);
const lineRefs = ref<HTMLElement[]>([]);
/** 用户手动滚动后的一段时间内暂停自动跟随（毫秒时间戳）。 */
let manualScrollUntil = 0;

/** 距当前行越远越淡；大字模式的落差比经典版更夸张，突出聚焦。 */
function lineOpacity(index: number): number {
  const active = activeIdx.value;
  if (active < 0) return 0.5;
  const distance = Math.abs(index - active);
  if (distance === 0) return 1;
  if (distance === 1) return 0.38;
  if (distance === 2) return 0.24;
  return 0.14;
}

function setLineRef(index: number, element: Element | null): void {
  if (element instanceof HTMLElement) lineRefs.value[index] = element;
}

/** 当前行的扫光元素：只有活跃行挂这个 ref，切行时 Vue 负责换新。 */
const sweepEl = ref<HTMLElement | null>(null);
function setSweepRef(index: number, element: Element | null): void {
  if (index !== activeIdx.value) return;
  sweepEl.value = element instanceof HTMLElement ? element : null;
}

/** 当前行的逐字元素：逐字歌词活跃行的每个字一个 span，rAF 里逐帧写 --wp。 */
const wordEls: (HTMLElement | null)[] = [];
function setWordRef(lineIndex: number, wordIndex: number, element: Element | null): void {
  if (lineIndex !== activeIdx.value) return;
  wordEls[wordIndex] = element instanceof HTMLElement ? element : null;
}

/** 让当前行落在容器约 38% 高度处。 */
function scrollToActive(index: number): void {
  const container = containerRef.value;
  const element = lineRefs.value[index];
  if (!container || !element) return;
  const top = element.offsetTop - container.clientHeight * 0.38 + element.clientHeight / 2;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function onUserScroll(): void {
  manualScrollUntil = Date.now() + 4000;
}

watch(activeIdx, (index) => {
  if (!ui.lyricsOpen || index < 0 || Date.now() < manualScrollUntil) return;
  void nextTick(() => scrollToActive(index));
});

// 打开或切歌时直接定位（不做平滑滚动，避免一次长距离动画）。
watch([() => ui.lyricsOpen, () => track.value?.key], async ([open]) => {
  if (!open) return;
  manualScrollUntil = 0;
  lineRefs.value = [];
  activeIdx.value = -1;
  await nextTick();
  activeIdx.value = activeLineIndex(lines.value, player.preciseTime());
  await nextTick();
  const container = containerRef.value;
  const element = lineRefs.value[activeIdx.value];
  if (container && element) {
    container.scrollTop = Math.max(0, element.offsetTop - container.clientHeight * 0.38);
  }
});

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
      // 等待期间又切歌了：结果作废，别用旧封面颜色染新封面。
      if (cover.value === url) palette.value = result;
    });
  },
  { immediate: true },
);

/* ------------------------------ 流体背景与频谱 ------------------------------ */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): Hsl | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match || !match[1]) return null;
  const value = Number.parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function parseHslString(input: string): Hsl | null {
  const match = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(input);
  if (!match) return null;
  return { h: Number(match[1]), s: Number(match[2]) / 100, l: Number(match[3]) / 100 };
}

/** 主题色（--accent / --accent-2）：封面取色失败时的兜底，也是色块组合的一部分。 */
let accentHsl: Hsl = { h: 330, s: 0.8, l: 0.68 };
let accent2Hsl: Hsl = { h: 340, s: 0.9, l: 0.8 };
/*
 * 沉浸模式固定深色氛围（不随明暗主题走）：流体色块用 lighter 加法混合，
 * 浅色底上叠加任何颜色都会糊成白，只有深底才撑得起发光感。
 * 文字/边框等变量在 .immersive-overlay 上局部覆盖，这里只定画布底色。
 */
const bgBase = '#0a0a12';
let themeObserver: MutationObserver | null = null;

function readThemeColors(): void {
  const style = getComputedStyle(document.documentElement);
  const accent = hexToHsl(style.getPropertyValue('--accent'));
  const accent2 = hexToHsl(style.getPropertyValue('--accent-2'));
  if (accent) accentHsl = accent;
  if (accent2) accent2Hsl = accent2;
}

/** 四个色块的锚点与漂移参数；颜色从「封面主/辅 + 主题双拼」里轮取。 */
const BLOB_PRESETS = [
  { ax: 0.2, ay: 0.28, dx: 0.1, dy: 0.15, sx: 0.11, sy: 0.09, phase: 0, size: 0.46, ci: 0 },
  { ax: 0.8, ay: 0.22, dx: 0.12, dy: 0.1, sx: 0.08, sy: 0.12, phase: 2.1, size: 0.38, ci: 1 },
  { ax: 0.52, ay: 0.88, dx: 0.15, dy: 0.08, sx: 0.1, sy: 0.07, phase: 4.2, size: 0.52, ci: 2 },
  { ax: 0.9, ay: 0.74, dx: 0.09, dy: 0.13, sx: 0.13, sy: 0.1, phase: 1.2, size: 0.34, ci: 3 },
  { ax: 0.1, ay: 0.82, dx: 0.08, dy: 0.12, sx: 0.07, sy: 0.11, phase: 5.3, size: 0.36, ci: 1 },
];

function blobColors(): Hsl[] {
  const primary = palette.value ? parseHslString(palette.value.primary) : null;
  const secondary = palette.value ? parseHslString(palette.value.secondary) : null;
  // 封面本身接近灰白：取不出颜色时借主题色的色相，背景不至于一潭死水。
  if (primary && primary.s < 0.16) {
    primary.h = accentHsl.h;
    primary.s = 0.42;
  }
  if (secondary && secondary.s < 0.16) {
    secondary.h = accent2Hsl.h;
    secondary.s = 0.46;
  }
  const colors: Hsl[] = [];
  colors.push(primary ?? accentHsl, secondary ?? accent2Hsl, accentHsl, accent2Hsl);
  return colors;
}

/*
 * 流体画布内部分辨率固定 160x90：色块本来就是大模糊圆，低分辨率画完由 CSS
 * 拉伸 + blur 收尾，比全分辨率绘制省一个数量级的像素。
 */
const FLUID_W = 160;
const FLUID_H = 90;
const fluidRef = ref<HTMLCanvasElement | null>(null);
let fluidCtx: CanvasRenderingContext2D | null = null;

function drawFluid(t: number): void {
  const ctx = fluidCtx;
  if (!ctx) return;
  const colors = blobColors();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = bgBase;
  ctx.fillRect(0, 0, FLUID_W, FLUID_H);
  ctx.globalCompositeOperation = 'lighter';
  for (const blob of BLOB_PRESETS) {
    const color = colors[blob.ci % colors.length];
    if (!color) continue;
    const x = (blob.ax + Math.sin(t * blob.sx + blob.phase) * blob.dx) * FLUID_W;
    const y = (blob.ay + Math.cos(t * blob.sy + blob.phase * 1.7) * blob.dy) * FLUID_H;
    const radius = blob.size * (1 + bassSmooth * 0.55) * FLUID_W * 0.5;
    const alpha = 0.5 + bassSmooth * 0.28;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, radius));
    gradient.addColorStop(
      0,
      `hsla(${Math.round(color.h)}, ${Math.round(color.s * 100)}%, ${Math.round(color.l * 100)}%, ${alpha.toFixed(3)})`,
    );
    gradient.addColorStop(1, `hsla(${Math.round(color.h)}, ${Math.round(color.s * 100)}%, 50%, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ------------------------------ 频谱 ------------------------------ */

const SPECTRUM_BARS = 56; // 单侧柱数，画面左右镜像展开
const spectrumRef = ref<HTMLCanvasElement | null>(null);
let spectrumCtx: CanvasRenderingContext2D | null = null;
let spectrumRO: ResizeObserver | null = null;

let analyserNode: AnalyserNode | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;
/** 平滑后的柱高（0..1）与低频能量，逐帧 lerp 逼近真实值，画面才不抖。 */
const bars = new Float32Array(SPECTRUM_BARS);
let bassSmooth = 0;
/** 播放状态平滑系数：暂停时模拟节拍与频谱都缓缓归零，不是急停。 */
let playLevel = 0;

function sampleAudio(t: number): void {
  playLevel += ((shownPlaying.value ? 1 : 0) - playLevel) * 0.08;

  let bassRaw = 0;
  if (analyserNode) {
    if (!freqData) freqData = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(freqData);
    let sum = 0;
    for (let i = 2; i < 14; i++) sum += freqData[i] ?? 0;
    bassRaw = sum / (12 * 255);
  } else {
    // 模拟节拍兜底：双正弦叠出近似鼓点的脉冲，播放时才起伏。
    bassRaw = (Math.max(0, Math.sin(t * 2.4)) ** 2 * 0.72 + 0.06) * playLevel + 0.06;
  }
  bassSmooth += (bassRaw - bassSmooth) * 0.25;

  for (let i = 0; i < SPECTRUM_BARS; i++) {
    let value: number;
    if (analyserNode && freqData) {
      // 指数映射取 bin：低频柱距疏、高频密，视觉重心压在低频。
      const idx = Math.min(
        freqData.length - 1,
        Math.floor(Math.pow(i / SPECTRUM_BARS, 1.7) * 170) + 2,
      );
      value = (freqData[idx] ?? 0) / 255;
    } else {
      const wobble = 0.6 + 0.4 * Math.sin(t * 1.7 + i * 0.55);
      value = Math.max(0, (0.62 - (i / SPECTRUM_BARS) * 0.5) * (0.25 + bassRaw) * wobble * playLevel);
    }
    bars[i] = (bars[i] ?? 0) + (value - (bars[i] ?? 0)) * 0.35;
  }
}

function drawSpectrum(): void {
  const canvas = spectrumRef.value;
  const ctx = spectrumCtx;
  if (!canvas || !ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  const colors = blobColors();
  const from = colors[0] ?? accentHsl;
  const to = colors[1] ?? accent2Hsl;
  const gradient = ctx.createLinearGradient(0, 0, w, 0);
  gradient.addColorStop(0, `hsla(${from.h}, ${from.s * 100}%, ${from.l * 100}%, 0.9)`);
  gradient.addColorStop(0.5, `hsla(${to.h}, ${to.s * 100}%, ${to.l * 100}%, 0.95)`);
  gradient.addColorStop(1, `hsla(${from.h}, ${from.s * 100}%, ${from.l * 100}%, 0.9)`);
  ctx.fillStyle = gradient;

  const total = SPECTRUM_BARS * 2;
  const barWidth = w / total;
  const centerX = w / 2;
  const maxH = h * 0.92;
  const cap = Math.min(barWidth * 0.72, 3);
  for (let i = 0; i < SPECTRUM_BARS; i++) {
    const value = bars[i] ?? 0;
    if (value < 0.01) continue;
    const barH = Math.max(cap * 2, value * maxH);
    const y = h - barH;
    for (const x of [centerX + i * barWidth, centerX - (i + 1) * barWidth]) {
      ctx.beginPath();
      ctx.roundRect(x + barWidth * 0.14, y, barWidth * 0.72, barH, cap);
      ctx.fill();
    }
  }
}

/* ------------------------------ 扫光与主循环 ------------------------------ */

let rafId = 0;

function tick(now: number): void {
  rafId = requestAnimationFrame(tick);
  const t = now / 1000;

  const seconds = player.preciseTime();
  const index = activeLineIndex(lines.value, seconds);
  if (index !== activeIdx.value) activeIdx.value = index;

  sampleAudio(t);
  drawFluid(t);
  drawSpectrum();

  // 行内扫光/逐字擦除：直接写 CSS 变量，不走响应式（60fps 的 Vue 重渲染太贵）。
  const line = index >= 0 ? lines.value[index] : undefined;
  if (line?.words?.length) {
    // 逐字：唱到的字按自身时间轴擦亮，整行扫光让位（模板里已不挂 is-sweeping）
    wordEls.length = line.words.length;
    for (let wi = 0; wi < line.words.length; wi += 1) {
      const element = wordEls[wi];
      const word = line.words[wi];
      if (!element || !word) continue;
      const progress =
        seconds >= word.end ? 1 : seconds <= word.start ? 0 : (seconds - word.start) / Math.max(0.01, word.end - word.start);
      element.style.setProperty('--wp', `${(progress * 100).toFixed(2)}%`);
    }
  } else {
    const element = sweepEl.value;
    if (element && line) {
      const nextLine = lines.value[index + 1];
      const span = nextLine ? Math.max(0.4, nextLine.time - line.time) : 3;
      const progress = Math.min(1, Math.max(0, (seconds - line.time) / span));
      element.style.setProperty('--sweep', `${(progress * 100).toFixed(2)}%`);
    }
  }
}

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
  analyserNode = player.attachAnalyser();
  readThemeColors();
  // 主题切换只改 documentElement 上的 data 属性（配色 palette / 明暗 theme），跟着重读一次颜色就够。
  themeObserver = new MutationObserver(readThemeColors);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-palette'],
  });

  const fluid = fluidRef.value;
  if (fluid) fluidCtx = fluid.getContext('2d');

  const spectrum = spectrumRef.value;
  if (spectrum) {
    spectrumCtx = spectrum.getContext('2d');
    spectrumRO = new ResizeObserver(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      spectrum.width = Math.round(spectrum.clientWidth * dpr);
      spectrum.height = Math.round(spectrum.clientHeight * dpr);
    });
    spectrumRO.observe(spectrum);
  }

  rafId = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  cancelAnimationFrame(rafId);
  themeObserver?.disconnect();
  spectrumRO?.disconnect();
});
</script>

<template>
  <Transition name="immersive">
    <div v-if="ui.lyricsOpen && track" class="immersive-overlay">
      <!-- 流体渐变：低分辨率 canvas 漂移色块，CSS 拉伸 + 模糊收尾 -->
      <canvas ref="fluidRef" class="fluid-canvas" :width="FLUID_W" :height="FLUID_H" aria-hidden="true" />
      <div class="immersive-scrim" aria-hidden="true" />
      <!-- 底部镜像频谱 -->
      <canvas ref="spectrumRef" class="spectrum-canvas" aria-hidden="true" />

      <!-- 页内标题栏：整页盖住窗口，这条带子同时是拖动区 -->
      <header class="immersive-top drag" @dblclick="toggleMaximize">
        <div class="immersive-topbar">
          <div class="immersive-top-left no-drag" @dblclick.stop>
            <button type="button" class="btn-icon" title="收起歌词（Esc）" @click="ui.closeLyrics()">
              <AppIcon name="chevron-down" :size="20" />
            </button>
            <span class="immersive-badge">
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

      <!-- 歌曲信息：封面收小，与标题歌手压成一行，把舞台让给歌词 -->
      <div class="track-meta">
        <button type="button" class="meta-cover" title="点击封面收起歌词" @click="ui.closeLyrics()">
          <img v-if="cover" :src="cover" :alt="title" />
          <AppIcon v-else name="music" :size="26" :stroke-width="1.2" />
        </button>
        <div class="meta-text">
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
        </div>
        <div class="meta-tags">
          <span v-if="sourceText" class="tag">{{ sourceText }}</span>
          <QualityPicker placement="down" align="left" />
          <span v-if="player.audioCache === 'full'" class="tag cache">缓存</span>
          <span v-else-if="player.usingDirect" class="tag direct">直连</span>
          <span v-else-if="!player.loading && player.current" class="tag relay">中转</span>
        </div>
      </div>

      <!-- 歌词主舞台：大字居中 -->
      <section class="stage">
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
              :class="{ 'is-active': index === activeIdx }"
              :style="{ opacity: lineOpacity(index) }"
              @click="seekTo(line.time)"
            >
              <span
                :ref="(element) => setSweepRef(index, element as Element | null)"
                class="lyric-text"
                :class="{ 'is-sweeping': index === activeIdx && !line.words?.length }"
              ><template v-if="line.words?.length"><span
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

      <footer class="immersive-controls">
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
.immersive-overlay {
  position: fixed;
  /* 整窗接管（含标题栏）：拖动与窗口按钮由页内标题栏自己承担。 */
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /*
   * 沉浸模式自成一派深色：不随明暗主题切换（流体/频谱/辉光都要深底），
   * 但 accent 保留主题色，六套配色的性格依然在。
   * 这些变量只在本页作用域内覆盖，外面（含 Teleport 出去的菜单）不受影响。
   */
  --bg: #0a0a12;
  --text: #f2f3f7;
  --text-muted: rgba(242, 243, 247, 0.64);
  --text-faint: rgba(242, 243, 247, 0.42);
  --border: rgba(255, 255, 255, 0.14);
  --border-strong: rgba(255, 255, 255, 0.24);
  --surface: rgba(255, 255, 255, 0.08);
  --surface-hover: rgba(255, 255, 255, 0.12);
  --surface-strong: rgba(24, 26, 36, 0.86);
  /*
   * color 必须在覆盖后的作用域里重解析一次：body 上的 color 是 :root 变量
   * 算好的具体值，直接继承下来还是浅色主题的深色字，上面的覆盖就白做了。
   */
  color: var(--text);
  background: var(--bg);
}

/* ------------------------------ 背景层 ------------------------------ */

.fluid-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* 低分辨率色块拉伸铺满，模糊交给 CSS，省像素又柔和。 */
  filter: blur(34px) saturate(1.35);
  transform: scale(1.06);
}

/* 压暗与 vignette：保证大字歌词在任何封面配色下都可读。 */
.immersive-scrim {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 90% at 50% 42%, transparent 40%, rgba(0, 0, 0, 0.38) 100%),
    linear-gradient(180deg, rgba(0, 0, 0, 0.32) 0%, transparent 18%, transparent 72%, rgba(0, 0, 0, 0.5) 100%);
}

.spectrum-canvas {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 190px;
  opacity: 0.85;
  mask-image: linear-gradient(180deg, transparent, #000 55%);
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 55%);
}

/* ------------------------------ 顶栏 ------------------------------ */

.immersive-top {
  position: relative;
  z-index: 3;
  display: flex;
  height: var(--titlebar-h);
  flex: none;
  align-items: stretch;
}

.immersive-topbar {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 16px;
}

.immersive-top-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.immersive-badge {
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

/* ------------------------------ 歌曲信息行 ------------------------------ */

.track-meta {
  position: relative;
  z-index: 1;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-width: 0;
  padding: 2px 24px 0;
}

.meta-cover {
  display: grid;
  width: 54px;
  height: 54px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text-faint);
  box-shadow: 0 14px 30px -16px rgba(0, 0, 0, 0.55);
  transition: transform 0.25s ease;
}

.meta-cover:hover {
  transform: scale(1.05);
}

.meta-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.meta-text {
  min-width: 0;
  text-align: left;
}

.meta-title {
  overflow: hidden;
  max-width: 46vw;
  font-size: 17px;
  font-weight: 760;
  letter-spacing: -0.01em;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-sub {
  overflow: hidden;
  max-width: 46vw;
  margin: 1px 0 0;
  color: var(--text-muted);
  font-size: 12.5px;
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

/* ------------------------------ 歌词主舞台 ------------------------------ */

.stage {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
}

.lyric-scroll {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 30vh 8vw 34vh;
  overscroll-behavior: contain;
  scrollbar-width: none;
  text-align: center;
  mask-image: linear-gradient(
    180deg,
    transparent 0%,
    rgba(0, 0, 0, 0.35) 9%,
    #000 24%,
    #000 72%,
    rgba(0, 0, 0, 0.35) 88%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    180deg,
    transparent 0%,
    rgba(0, 0, 0, 0.35) 9%,
    #000 24%,
    #000 72%,
    rgba(0, 0, 0, 0.35) 88%,
    transparent 100%
  );
}

.lyric-scroll::-webkit-scrollbar {
  display: none;
}

.lyric-line {
  margin: 0;
  padding: 13px 0;
  color: var(--text);
  font-size: clamp(19px, 1.75vw, 25px);
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.42;
  cursor: pointer;
  transition:
    opacity 0.45s ease,
    font-size 0.45s var(--ease),
    filter 0.45s ease;
}

/* 当前行：超大字号 + 主题色辉光（drop-shadow 才能叠在 background-clip 文字上）。 */
.lyric-line.is-active {
  font-size: clamp(30px, 3.5vw, 46px);
  font-weight: 800;
  filter: drop-shadow(0 0 22px color-mix(in srgb, var(--accent) 42%, transparent));
}

.lyric-text {
  display: block;
  transition: color 0.25s ease;
}

.lyric-line:hover .lyric-text {
  color: var(--accent);
}

/*
 * 行内扫光：--sweep 由 rAF 逐帧写入（0%→100%），已唱部分是实色，
 * 未唱部分压成半透，中间留一段过渡带模拟「唱到哪亮到哪」。
 */
.lyric-text.is-sweeping {
  --sweep: 0%;
  background-image: linear-gradient(
    100deg,
    var(--text) calc(var(--sweep) - 10%),
    color-mix(in srgb, var(--text) 34%, transparent) calc(var(--sweep) + 14%)
  );
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

.lyric-line.is-active:hover .lyric-text {
  color: transparent;
}

/*
 * 逐字擦除（上游给了 YRC/QRC 时）：每个字的 --wp 由 rAF 逐帧写入（0%→100%），
 * 已唱部分实色、未唱部分半透，过渡带收窄到字内，「唱到哪个字亮哪个字」。
 */
.lyric-line.is-active .lyric-word {
  --wp: 0%;
  background-image: linear-gradient(
    100deg,
    var(--text) calc(var(--wp) - 8%),
    color-mix(in srgb, var(--text) 34%, transparent) calc(var(--wp) + 12%)
  );
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

.lyric-line.is-active:hover .lyric-word {
  color: transparent;
}

.lyric-trans {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 0.5em;
  font-weight: 600;
}

.lyric-line.is-active .lyric-trans {
  color: color-mix(in srgb, var(--text) 62%, transparent);
}

.lyric-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 10vh;
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

/*
 * 控制条 = 右下角一张玻璃卡片（与雾笺浮块同一材质）：进度条在上、
 * 按键居中、快捷键提示以发丝线分隔收尾。空闲时半透并微微下沉，
 * 把舞台让给大字歌词；悬停或焦点进入即浮起恢复。
 */
.immersive-controls {
  position: absolute;
  right: 22px;
  bottom: 22px;
  z-index: 3;
  display: flex;
  width: 320px;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 14px 16px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 16px);
  background: var(--surface-strong);
  box-shadow: var(--shadow-lg);
  opacity: 0.55;
  transform: translateY(4px);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.25);
  transition:
    opacity 0.35s ease,
    transform 0.35s var(--ease);
}

.immersive-controls:hover,
.immersive-controls:focus-within {
  opacity: 1;
  transform: none;
}

.progress-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
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
  width: 100%;
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

.range {
  flex: 1;
  height: 4px;
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
  transition: height 0.18s ease;
}

/* 进度条平时 4px 细线，悬停整行时加粗到 6px，配合 thumb 浮现 */
.progress-row:hover .range {
  height: 6px;
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

.volume {
  display: flex;
  align-items: center;
}

/*
 * 音量条在按键行内向右展开（与雾笺同一套）：不再是浮层，而是音量按钮
 * 右侧的一段 0fr→1fr 行内容器，展开时整排按键自然左移。
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
.volume:focus-within .volume-pop,
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

.lyric-hints {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 0;
  padding-top: 8px;
  border-top: 1px solid var(--border);
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

.immersive-enter-active,
.immersive-leave-active {
  transition:
    opacity 0.32s ease,
    transform 0.32s ease;
}

.immersive-enter-from,
.immersive-leave-to {
  opacity: 0;
  transform: scale(1.02);
}

/* 窄窗口：信息行与歌词都收窄居中 */
@media (max-width: 720px) {
  .meta-title,
  .meta-sub {
    max-width: 60vw;
  }

  .lyric-scroll {
    padding-right: 6vw;
    padding-left: 6vw;
  }
}
</style>
