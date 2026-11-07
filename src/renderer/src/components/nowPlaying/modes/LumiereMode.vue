<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import RelayTag from '../shared/RelayTag.vue';
import TrackCover from '../shared/TrackCover.vue';
import { usePlayerStore } from '@/stores/player';
import { useUiStore } from '@/stores/ui';
import { formatTime } from '@/utils/format';
import TopActions from '../TopActions.vue';
import QualityPicker from '@/components/layout/QualityPicker.vue';
import { useTrack } from '../shared/useTrack';
import { useTransport } from '../shared/useTransport';
import { useHotkeys } from '../shared/useHotkeys';
import { useThemeAccent } from '../shared/useThemeAccent';
import { useCoverPalette } from '../shared/useCoverPalette';
import { useFallbackLyric } from '../shared/useFallbackLyric';
import { buildFoliaTheme, toFoliaLines } from '../shared/foliaLyricLines';
import {
  LumierePixiRuntime,
  type LumiereSongContext,
  type LumiereSongMetadata,
} from '../lumiere/createLumierePixiRuntime';
import { compileLumiereProgram } from '../lumiere/lumiereProgram';
import { loadLucideIcons } from '../folia/foliaLucide';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../folia/foliaFonts';
import { useLumiereTuningStore } from './lumiereTuningStore';
import type { AudioBands, LumiereTuning, MotionValue, Theme } from '../folia/foliaTypes';

/**
 * 绘光模式（移植自 Folia 的 Lumiere）：舞台追光式的歌词演出——光束扫过正在唱的
 * 句子，烟雾与浮尘在光里翻涌，辉光随音乐起伏；段落之间光位交接，曲终出片尾卡。
 *
 * 渲染是 Pixi.js v8 + WebGL（见 lumiere/ 与 pixi/ 目录，渲染代码与 folia 逐字一致，
 * 这里只是接入壳）；WebGL 不可用或启动失败时退回只显示当前这句文字。歌词画在
 * canvas 上，这个样式不支持「点击歌词跳转」，跳转走底部进度条。
 */
const player = usePlayerStore();
const ui = useUiStore();
const lumiereTuning = useLumiereTuningStore();

/** 运行时吃调参快照：别让它拎着 Vue 的响应式代理进渲染层。 */
function tuningSnapshot(): LumiereTuning {
  return JSON.parse(JSON.stringify(lumiereTuning.tuning)) as LumiereTuning;
}

const {
  shownPlaying,
  currentMode,
  modeIcon,
  track,
  cover,
  title,
  artists,
  albumName,
  sourceText,
  lines,
  hasLyric,
  toggleMaximize,
} = useTrack();

/* ------------------------------ 封面取色 ------------------------------ */

const palette = useCoverPalette(cover);

/* ------------------------------ 主题 ------------------------------ */

const { accentCss, accent2Css } = useThemeAccent();

/** 绘光的光色从主题色与封面色来；暗场底用固定的深色。 */
function currentTheme(): Theme {
  return buildFoliaTheme(accentCss.value, accent2Css.value, palette.value);
}

/* ------------------------------ 音频分频（光的强度随音乐起伏） ------------------------------ */

/*
 * 与 folia 的 usePlaybackVisualizerBridge 同一配方：频段取 getByteFrequencyData 的
 * 均值，再做 pow 压缩（0..255 量纲；lumiereAudio 的量纲判断按「见过 > 1」粘住）。
 * 没在出声时给 0..40 的缓慢呼吸。绘光实际只读 bass / treble / power，其余频段
 * 备着（AudioBands 是全的形状）。
 */
let analyserNode: AnalyserNode | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;

function attachAudioAnalyser(): void {
  analyserNode = player.attachAnalyser();
  if (analyserNode) freqData = new Uint8Array(analyserNode.frequencyBinCount);
}

/** 频段原始均值（0..255）；没有分析器时返回 NaN，调用方走呼吸兜底。 */
function bandMean(minHz: number, maxHz: number): number {
  if (!analyserNode || !freqData) return NaN;
  analyserNode.getByteFrequencyData(freqData);
  const binHz = analyserNode.context.sampleRate / 2 / analyserNode.frequencyBinCount;
  const from = Math.max(1, Math.floor(minHz / binHz));
  const to = Math.min(analyserNode.frequencyBinCount - 1, Math.floor(maxHz / binHz));
  if (to < from) return NaN;
  let sum = 0;
  for (let i = from; i <= to; i++) sum += freqData[i] ?? 0;
  return sum / (to - from + 1);
}

/** folia 的压缩曲线：pow(均值/255, boost) * 255。 */
function processBand(value: number, boost: number): number {
  return Math.pow(value / 255, boost) * 255;
}

/** 静默时的呼吸底（folia：(sin(t/2s)+1)*20）。 */
function breath(): number {
  return (Math.sin(Date.now() / 2000) + 1) * 20;
}

function readBand(minHz: number, maxHz: number, boost: number): () => number {
  return () => {
    const mean = bandMean(minHz, maxHz);
    return Number.isNaN(mean) ? breath() : processBand(mean, boost);
  };
}

function readAudioPower(): number {
  const bass = bandMean(20, 150);
  const lowMid = bandMean(150, 400);
  if (Number.isNaN(bass) || Number.isNaN(lowMid)) return breath();
  return processBand((bass + lowMid) / 2, 3);
}

/** 运行时每帧通过 get() 现读；变化订阅我们用不到（on 给个空实现）。 */
function makeValue(get: () => number): MotionValue<number> {
  return { get, on: () => () => {} };
}

const currentTimeValue = makeValue(() => player.preciseTime());
const audioPowerValue = makeValue(readAudioPower);
const audioBands: AudioBands = {
  bass: makeValue(readBand(20, 150, 1.8)),
  lowMid: makeValue(readBand(150, 400, 2)),
  mid: makeValue(readBand(400, 1200, 2)),
  vocal: makeValue(readBand(1000, 3500, 1.5)),
  treble: makeValue(readBand(3500, 12000, 2)),
};

/* ------------------------------ 歌词 → 绘光的程序 ------------------------------ */

const seed = computed(() => track.value?.key ?? 'lumiere');

/**
 * 整首歌的演出程序：段落、镜头、光位都在这里编译（纯函数，同样输入逐字段相同）。
 * 没有歌词时编译成只有间奏镜头的纯音乐程序，光照常跑，不造虚拟歌词行。
 * 轨迹过渡（seamlessTransitions）改变编译结果：切换时程序重编，走同曲替换交给
 * 运行时（swapSong → commitSong 清场景缓存），不重建 WebGL。
 */
const program = computed(() =>
  compileLumiereProgram(toFoliaLines(lines.value), seed.value, {}, {
    duration: player.duration > 0 ? player.duration : undefined,
    seamless: lumiereTuning.tuning.seamlessTransitions,
  }),
);

/** 一首歌的全部输入；seed 变了才是真正的换歌，其余字段变（主题、歌词晚到）走同曲替换。 */
function buildSongContext(): LumiereSongContext {
  return { seed: seed.value, program: program.value, theme: currentTheme() };
}

const metadata = computed<LumiereSongMetadata>(() => ({
  title: track.value?.title ?? null,
  artist: artists.value.map((artist) => artist.name).join('/') || null,
  album: track.value?.album.name ?? null,
}));

/* ------------------------------ 绘光运行时 ------------------------------ */

const hostRef = ref<HTMLDivElement | null>(null);
const failed = ref(false);
/** Pixi 首个渲染帧出来之前为 true——这期间画布还没挂上，用加载动画盖住。 */
const booting = ref(false);
/** 首帧已渲染：画布自身淡入+轻微拉远的入场由它驱动，避免「突然亮灯」。 */
const live = ref(false);
let runtime: LumierePixiRuntime | null = null;
let createAbort: AbortController | null = null;

/** 换歌交接是异步的（先离屏建新歌当前段落的场景再切），期间又来了新歌就排队，只留最新。 */
let pendingSong: LumiereSongContext | null = null;
let swapBusy = false;

function pushSong(song: LumiereSongContext): void {
  pendingSong = song;
  void drainSong();
}

async function drainSong(): Promise<void> {
  const instance = runtime;
  if (!instance || swapBusy) return;
  swapBusy = true;
  try {
    while (pendingSong) {
      const next = pendingSong;
      pendingSong = null;
      // 场景里的主题图标线稿只画已加载的图标：换歌前先加载好（sakura 是空实现，留着对齐上游）。
      await loadLucideIcons(next.theme.lyricsIcons ?? []);
      await instance.swapSong(next);
      if (instance !== runtime) return; // 交接期间运行时被重建了，剩下的歌由新运行时读最新的
    }
  } catch (error) {
    console.warn('[Lumiere] 绘光换歌交接失败', error);
  } finally {
    swapBusy = false;
  }
}

function destroyRuntime(): void {
  createAbort?.abort();
  createAbort = null;
  pendingSong = null;
  runtime?.destroy();
  runtime = null;
  booting.value = false;
  live.value = false;
}

async function createRuntime(): Promise<void> {
  const host = hostRef.value;
  if (!host) return;
  destroyRuntime();
  booting.value = true;
  live.value = false;
  const controller = new AbortController();
  createAbort = controller;
  try {
    const theme = currentTheme();
    await loadLucideIcons(theme.lyricsIcons ?? []);
    const instance = await LumierePixiRuntime.create({
      host,
      song: buildSongContext(),
      tuning: tuningSnapshot(),
      currentTime: currentTimeValue,
      audioPower: audioPowerValue,
      audioBands,
      staticMode: false,
      showText: true,
      paused: !shownPlaying.value,
      metadata: metadata.value,
      // 桌面端没有 folia 的全局渲染挡位：分辨率倍数 1、抗锯齿关（folia 的默认）
      renderScale: 1,
      antialias: false,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      instance.destroy();
      return;
    }
    runtime = instance;
    booting.value = false;
    live.value = true;
    failed.value = false;
  } catch (error) {
    if (controller.signal.aborted) return;
    console.warn('[Lumiere] 绘光启动失败，退回纯文字', error);
    runtime = null;
    booting.value = false;
    failed.value = true;
  }
}

// 程序（歌词/种子/时长/轨迹过渡）或主题色/封面取色变了：同一首歌走同曲替换，换歌走交接
watch([program, palette, accentCss, accent2Css], () => pushSong(buildSongContext()));
watch(shownPlaying, (playing) => runtime?.setPaused(!playing));
watch(metadata, (value) => runtime?.setSongMetadata(value));

// 调参改了：每帧现读的字段立刻生效，烘焙进场景的字段运行时内部防抖重建；
// 轨迹过渡属于编译参数，走上面的程序重编 + 同曲替换，不在 setTuning 里管。
watch(
  () => lumiereTuning.tuning,
  () => {
    runtime?.setTuning(tuningSnapshot());
  },
  { deep: true },
);

// 覆盖层常驻在 AppShell 的舞台里：关闭时舞台还在淡出，先停渲染、保留画布；
// 重开直接复用运行时，不重建 Pixi（否则又会顿一下）。
watch(
  () => ui.lyricsOpen && !!track.value,
  async (open) => {
    if (!open) {
      runtime?.setPaused(true);
      return;
    }
    await nextTick();
    if (runtime) {
      runtime.setPaused(!shownPlaying.value);
      return;
    }
    void createRuntime();
  },
  { immediate: true },
);
// 暂停时 ticker 停着，拖动进度要手动补一帧
watch(
  () => player.currentTime,
  () => {
    if (!shownPlaying.value) runtime?.renderOnce();
  },
);

const fallbackStyle = computed(() => ({
  color: palette.value?.primary || '#e8ecf4',
  fontFamily: resolveThemeFontStack(currentTheme()),
  fontWeight: resolveThemeFontWeight(currentTheme(), 500),
}));

const { fallbackText } = useFallbackLyric({
  lines,
  hasLyric,
  hasTrack: computed(() => !!track.value),
  failed,
});

/* ------------------------------ 传输控制 ------------------------------ */

const {
  shownTime,
  duration,
  progressPercent,
  volumePercent,
  toggle,
  prev,
  next,
  cycleMode,
  seekTo,
  onSeekInput,
  onSeekDone,
  onVolumeInput,
} = useTransport();

useHotkeys({ toggle, seekTo });

onMounted(() => {
  attachAudioAnalyser();
});

onBeforeUnmount(() => {
  destroyRuntime();
});
</script>

<template>
  <div class="lume-overlay now-playing-dark">
      <!-- 绘光的画布由运行时挂进这个宿主（Pixi/WebGL；光场、烟雾、字全在里面） -->
      <div
        ref="hostRef"
        class="lumiere-host"
        :class="{ live }"
        aria-hidden="true"
      />
      <!-- 冷启动：WebGL 上下文与着色器链接期间画布还没挂上，用呼吸光点盖住，首帧渲染后淡出 -->
      <Transition name="boot">
        <div v-if="booting && !failed" class="lumiere-boot" aria-hidden="true">
          <span class="boot-mark">
            <AppIcon name="sun" :size="24" />
          </span>
          <span class="boot-text">正在布光</span>
        </div>
      </Transition>
      <!-- WebGL 不可用时的兜底：只显示当前这句 -->
      <div v-if="failed" class="lumiere-fallback" :style="fallbackStyle">{{ fallbackText }}</div>

      <!-- 页内标题栏：整页盖住窗口，这条带子同时是拖动区 -->
      <header class="lume-top drag" @dblclick="toggleMaximize">
        <!-- 顶栏内容（收起/徽标/弹出 + 右上角操作区）所有播放页样式共享，见 TopActions -->
        <TopActions />
      </header>

      <!-- 中部留给绘光：歌词由运行时画在光里，没有 DOM 歌词 -->

      <footer class="lume-controls">
        <!-- 歌曲信息收进底部：光的舞台不压字 -->
        <div class="lume-meta">
          <span class="meta-cover">
            <TrackCover :cover="cover" :title="title" />
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
              <QualityPicker placement="down" align="right" stage-tone="dark" />
              <RelayTag />
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

            <div v-if="ui.lyricHints" class="lume-hints">
              <span class="lume-hints-text">
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
</template>

<style scoped>
.lume-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 绘光固定深夜氛围：暗场压在深底上，光束与烟雾在里面亮起来 */
  --bg: #05070a;
  --surface-strong: rgba(20, 23, 33, 0.82);
}

/* ------------------------------ 绘光宿主与兜底 ------------------------------ */

/*
 * 画布入场：首帧渲染前透明且略微放大；首帧一到，与加载层的淡出交叠，
 * 缓慢淡入并拉远到位——光是「亮」起来的，不是跳出来的。
 */
.lumiere-host {
  position: absolute;
  inset: 0;
  opacity: 0;
}

.lumiere-host.live {
  opacity: 1;
}

.lumiere-fallback {
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

.lume-top {
  position: relative;
  z-index: 3;
  display: flex;
  height: var(--titlebar-h);
  flex: none;
  align-items: stretch;
}

/* ------------------------------ 角落浮块控制区（玻璃拟态） ------------------------------ */

/*
 * 控制区缩成右下角的一小块浮板：绘光的舞台是整个光场，整条横栏会把
 * 低位的歌词与烟雾全挡住。信息布局不变，只是宽度收窄、行距收紧。
 */
.lume-controls {
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
  /* 半透白磨砂浮板：底下的光与烟雾还能透上来；顶部 inset 高光是上沿的亮边 */
  background: linear-gradient(180deg, rgba(226, 233, 243, 0.1), rgba(226, 233, 243, 0.055));
  backdrop-filter: blur(26px) saturate(1.1);
  box-shadow:
    0 24px 48px -24px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.lume-meta {
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
.lume-controls:not(:hover):not(:focus-within) .chip-expand {
  width: 0;
}

.lume-controls:hover,
.lume-controls:focus-within {
  /* 展开时放宽到固定的 420px，进度条和按键才有施展空间 */
  width: min(420px, calc(100% - 36px));
}

.lume-controls:hover .chip-expand,
.lume-controls:focus-within .chip-expand {
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

.lume-controls:hover .chip-expand-inner,
.lume-controls:focus-within .chip-expand-inner {
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

.lume-controls:hover .meta-tags,
.lume-controls:focus-within .meta-tags {
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

/* 播放键：暗场上一颗最亮的光斑，焦点不会丢 */
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
 * 进度条/音量条 = 暗场上的一道光痕：
 * 轨道是半透白，填充是竖向渐变的光痕（顶部更亮，模拟上沿反光）；
 * thumb 是一粒常显的小光珠（拖动时略放大）。
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

.lume-hints {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.lume-hints kbd {
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
 * 首个渲染帧出来前盖住黑画布：一点呼吸的光 + 两圈扩散光晕。
 * 首帧一到即淡出（boot 过渡），不挡交互。
 */
.lumiere-boot {
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

/* 展开/收起由 AppShell 的舞台统一负责，这里只剩启动层的淡出 */
</style>
