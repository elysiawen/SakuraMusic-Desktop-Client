<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useNebbiaTuningStore } from './nebbiaTuningStore';
import {
  NEBBIA_APPEAR_STYLES,
  NEBBIA_FADE_STYLES,
  NEBBIA_GLASS,
  NEBBIA_LAYOUTS,
  NEBBIA_LIMITS,
  NEBBIA_RAIN,
  NEBBIA_SCENERY,
  type NebbiaAppearStyle,
  type NebbiaFadeStyle,
  type NebbiaGlass,
  type NebbiaLayout,
  type NebbiaNumberKey,
  type NebbiaRain,
  type NebbiaSceneryPart,
  type NebbiaTuning,
} from '../nebbia/types';

/**
 * 雾笺的设置面板（样式菜单里雾笺旁的设置按钮弹出这个）。
 * 内容归雾笺自己管：分组、文案、滑块范围都来自 nebbia/types.ts 的
 * NEBBIA_LIMITS 与开关常量，和 folia 的 NebbiaSettingsPanel 一一对应；
 * 桌面端没有「共用背景」与渲染挡位，这两样不出现。
 *
 * 读写走 tuningStore（localStorage 持久化）；窗外场景和玻璃换了要重编
 * 着色器，由 NebbiaMode 监听后重建运行时，其余项 setTuning 热更。
 */
const store = useNebbiaTuningStore();
const tuning = computed(() => store.tuning);

function patch(partial: Partial<NebbiaTuning>): void {
  store.patch(partial);
}

/* ------------------------------ 文案 ------------------------------ */

const BEHIND_OPTIONS = [
  { value: 'night', label: '雨夜街景' },
  { value: 'aquarium', label: '梦海流萤' },
] as const;

const GLASS_LABELS: Record<NebbiaGlass, string> = {
  rain: '雨窗',
  dew: '凝露',
  snow: '雪窗',
};
const RAIN_LABELS: Record<NebbiaRain, string> = {
  slant: '斜落',
  straight: '直落',
  off: '不下',
};
const APPEAR_LABELS: Record<NebbiaAppearStyle, string> = {
  write: '一笔一画写',
  fade: '从雾里透出',
  breath: '先哈气再写',
};
const FADE_LABELS: Record<NebbiaFadeStyle, string> = {
  fog: '慢慢起雾',
  fingers: '手指搓掉',
};
const LAYOUT_LABELS: Record<NebbiaLayout, string> = {
  ribbon: '横条',
  lines2: '两行错落',
  lines3: '三行错落',
  cross: '十字',
  pillar: '竖柱',
  header: '刊头',
  badge: '徽章',
  columns: '竖排几列',
  orbit: '环绕',
};
const SCENERY_LABELS: Record<NebbiaSceneryPart, string> = {
  spot: '聚光灯',
  buildings: '楼群',
  lights: '霓虹光斑',
  cars: '车灯',
  road: '湿路倒影',
};

/* ------------------------------ 滑块规格 ------------------------------ */

const percent = (value: number) => `${Math.round(value * 100)}%`;
const times = (value: number) => `×${value.toFixed(2).replace(/0$/, '')}`;
const seconds = (value: number) => `${value.toFixed(1)}s`;
const count = (value: number) => String(Math.round(value));

interface SliderSpec {
  key: NebbiaNumberKey;
  label: string;
  step: number;
  format: (value: number) => string;
}

const WRITING_SLIDERS: SliderSpec[] = [
  { key: 'strokeWidth', label: '笔画粗细', step: 0.005, format: percent },
  { key: 'writeSpeed', label: '书写速度', step: 0.05, format: times },
  { key: 'jitter', label: '手写歪斜', step: 0.05, format: times },
  { key: 'warp', label: '手写变形', step: 0.05, format: times },
  { key: 'doodle', label: '句尾小画', step: 0.05, format: percent },
  { key: 'mist', label: '雾气浓度', step: 0.01, format: percent },
  { key: 'hold', label: '写完保持', step: 0.1, format: seconds },
  { key: 'refog', label: '重新起雾', step: 0.5, format: seconds },
];
const WINDOW_SLIDERS: SliderSpec[] = [
  { key: 'busSpeed', label: '车速', step: 0.05, format: times },
  { key: 'neon', label: '霓虹亮度', step: 0.05, format: times },
  { key: 'bump', label: '车身颠簸', step: 0.05, format: times },
  { key: 'spot', label: '聚光灯', step: 0.05, format: times },
  { key: 'spotX', label: '聚光灯位置', step: 0.01, format: percent },
];
const AQUA_SLIDERS: SliderSpec[] = [
  { key: 'jellies', label: '水母数量', step: 1, format: count },
  { key: 'jellySize', label: '水母大小', step: 0.05, format: times },
  { key: 'bubbles', label: '气泡多少', step: 0.05, format: percent },
];
const GLASS_SLIDERS: Record<NebbiaGlass, SliderSpec[]> = {
  rain: [
    { key: 'rainHit', label: '雨点打窗', step: 0.05, format: times },
    { key: 'rainBig', label: '大雨点', step: 0.05, format: times },
  ],
  dew: [
    { key: 'dew', label: '冷凝水珠', step: 0.05, format: times },
    { key: 'dewSize', label: '水珠大小', step: 0.05, format: times },
    { key: 'dewGlint', label: '水珠高光', step: 0.05, format: times },
  ],
  snow: [
    { key: 'snow', label: '落雪多少', step: 0.05, format: times },
    { key: 'snowSize', label: '雪花大小', step: 0.05, format: times },
    { key: 'snowMelt', label: '化雪速度', step: 0.05, format: times },
  ],
};

const aquarium = computed(() => tuning.value.behind === 'aquarium');
/** 水族箱里没有车身颠簸；雪窗的街景窗外不下雨。 */
const windowSliders = computed(() =>
  aquarium.value ? WINDOW_SLIDERS.filter((spec) => spec.key !== 'bump') : WINDOW_SLIDERS,
);
/**
 * 街景的雨只画在聚光灯的光柱里：雪窗没有雨，聚光灯关着或强度为 0 时也看不出变化，
 * 这几种情况「窗外的雨」就不可选。水族箱的细气泡不看聚光灯。
 */
const rainDisabled = computed(
  () =>
    !aquarium.value
    && (tuning.value.glass === 'snow'
      || !tuning.value.scenery.includes('spot')
      || tuning.value.spot <= 0),
);

/* ------------------------------ 开关组 ------------------------------ */

type ChoiceField = 'appear' | 'fade' | 'layouts';

/** 开关组点开/关掉一项，按 choices 的顺序排；最后一项关不掉。 */
function toggleChoice(field: ChoiceField, choices: readonly string[], item: string): void {
  const on = tuning.value[field] as string[];
  if (on.length === 1 && on[0] === item) return;
  const next = choices.filter((choice) => (choice === item ? !on.includes(choice) : on.includes(choice)));
  patch({ [field]: next } as Partial<NebbiaTuning>);
}

/** 窗外元素随便全关，不和开关组一样留一项。 */
function toggleScenery(part: NebbiaSceneryPart): void {
  const on = tuning.value.scenery;
  patch({ scenery: NEBBIA_SCENERY.filter((choice) => (choice === part ? !on.includes(choice) : on.includes(choice))) });
}
</script>

<template>
  <div class="nb-settings">
    <!-- 窗外：街景还是水族箱；这一组的说法和可调项都跟着它变 -->
    <section class="nb-group">
      <h3 class="nb-title">窗外</h3>
      <div class="nb-row">
        <span class="nb-label">场景</span>
        <div class="nb-seg">
          <button
            v-for="option in BEHIND_OPTIONS"
            :key="option.value"
            type="button"
            class="nb-seg-item"
            :class="{ on: tuning.behind === option.value }"
            @click="patch({ behind: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <label v-for="spec in aquarium ? AQUA_SLIDERS : []" :key="spec.key" class="nb-slider">
        <span class="nb-label">{{ spec.label }}</span>
        <input
          type="range"
          :min="NEBBIA_LIMITS[spec.key].min"
          :max="NEBBIA_LIMITS[spec.key].max"
          :step="spec.step"
          :value="tuning[spec.key]"
          @input="patch({ [spec.key]: Number(($event.target as HTMLInputElement).value) } as Partial<NebbiaTuning>)"
        />
        <span class="nb-value">{{ spec.format(tuning[spec.key]) }}</span>
      </label>
      <button
        v-for="part in NEBBIA_SCENERY"
        :key="part"
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="tuning.scenery.includes(part)"
        @click="toggleScenery(part)"
      >
        <span class="nb-label">{{ SCENERY_LABELS[part] }}</span>
        <span class="nb-switch" :class="{ on: tuning.scenery.includes(part) }" />
      </button>
      <div class="nb-row">
        <span class="nb-label">{{ aquarium ? '气泡流' : '窗外的雨' }}</span>
        <div class="nb-seg" :class="{ disabled: rainDisabled }">
          <button
            v-for="option in NEBBIA_RAIN"
            :key="option"
            type="button"
            class="nb-seg-item"
            :class="{ on: tuning.rain === option }"
            :disabled="rainDisabled"
            @click="patch({ rain: option })"
          >
            {{ RAIN_LABELS[option] }}
          </button>
        </div>
      </div>
    </section>

    <!-- 玻璃：雨窗、凝露还是雪窗；换了要重编着色器（NebbiaMode 重建运行时） -->
    <section class="nb-group">
      <h3 class="nb-title">玻璃</h3>
      <div class="nb-row">
        <span class="nb-label">玻璃上的水</span>
        <div class="nb-seg">
          <button
            v-for="option in NEBBIA_GLASS"
            :key="option"
            type="button"
            class="nb-seg-item"
            :class="{ on: tuning.glass === option }"
            @click="patch({ glass: option })"
          >
            {{ GLASS_LABELS[option] }}
          </button>
        </div>
      </div>
      <label v-for="spec in GLASS_SLIDERS[tuning.glass]" :key="spec.key" class="nb-slider">
        <span class="nb-label">{{ spec.label }}</span>
        <input
          type="range"
          :min="NEBBIA_LIMITS[spec.key].min"
          :max="NEBBIA_LIMITS[spec.key].max"
          :step="spec.step"
          :value="tuning[spec.key]"
          @input="patch({ [spec.key]: Number(($event.target as HTMLInputElement).value) } as Partial<NebbiaTuning>)"
        />
        <span class="nb-value">{{ spec.format(tuning[spec.key]) }}</span>
      </label>
    </section>

    <!-- 雾上写字 -->
    <section class="nb-group">
      <h3 class="nb-title">雾上写字</h3>
      <label v-for="spec in WRITING_SLIDERS" :key="spec.key" class="nb-slider">
        <span class="nb-label">{{ spec.label }}</span>
        <input
          type="range"
          :min="NEBBIA_LIMITS[spec.key].min"
          :max="NEBBIA_LIMITS[spec.key].max"
          :step="spec.step"
          :value="tuning[spec.key]"
          @input="patch({ [spec.key]: Number(($event.target as HTMLInputElement).value) } as Partial<NebbiaTuning>)"
        />
        <span class="nb-value">{{ spec.format(tuning[spec.key]) }}</span>
      </label>
      <button
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="tuning.credits"
        @click="patch({ credits: !tuning.credits })"
      >
        <span class="nb-label">曲终写出曲名和歌手</span>
        <span class="nb-switch" :class="{ on: tuning.credits }" />
      </button>
    </section>

    <!-- 字怎么出现 / 怎么消失 / 一句怎么构图：每种一个开关，至少留一种 -->
    <section class="nb-group">
      <h3 class="nb-title">出现方式</h3>
      <button
        v-for="item in NEBBIA_APPEAR_STYLES"
        :key="item"
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="tuning.appear.includes(item)"
        :disabled="tuning.appear.length === 1 && tuning.appear[0] === item"
        @click="toggleChoice('appear', NEBBIA_APPEAR_STYLES, item)"
      >
        <span class="nb-label">{{ APPEAR_LABELS[item] }}</span>
        <span class="nb-switch" :class="{ on: tuning.appear.includes(item) }" />
      </button>
    </section>
    <section class="nb-group">
      <h3 class="nb-title">消失方式</h3>
      <button
        v-for="item in NEBBIA_FADE_STYLES"
        :key="item"
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="tuning.fade.includes(item)"
        :disabled="tuning.fade.length === 1 && tuning.fade[0] === item"
        @click="toggleChoice('fade', NEBBIA_FADE_STYLES, item)"
      >
        <span class="nb-label">{{ FADE_LABELS[item] }}</span>
        <span class="nb-switch" :class="{ on: tuning.fade.includes(item) }" />
      </button>
    </section>
    <section class="nb-group">
      <h3 class="nb-title">构图</h3>
      <button
        v-for="item in NEBBIA_LAYOUTS"
        :key="item"
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="tuning.layouts.includes(item)"
        :disabled="tuning.layouts.length === 1 && tuning.layouts[0] === item"
        @click="toggleChoice('layouts', NEBBIA_LAYOUTS, item)"
      >
        <span class="nb-label">{{ LAYOUT_LABELS[item] }}</span>
        <span class="nb-switch" :class="{ on: tuning.layouts.includes(item) }" />
      </button>
    </section>

    <!-- 窗外动效 -->
    <section class="nb-group">
      <h3 class="nb-title">{{ aquarium ? '水族箱' : '街景' }}动效</h3>
      <label v-for="spec in windowSliders" :key="spec.key" class="nb-slider">
        <span class="nb-label">{{ spec.label }}</span>
        <input
          type="range"
          :min="NEBBIA_LIMITS[spec.key].min"
          :max="NEBBIA_LIMITS[spec.key].max"
          :step="spec.step"
          :value="tuning[spec.key]"
          @input="patch({ [spec.key]: Number(($event.target as HTMLInputElement).value) } as Partial<NebbiaTuning>)"
        />
        <span class="nb-value">{{ spec.format(tuning[spec.key]) }}</span>
      </label>
    </section>

    <!-- 恢复默认挂在弹窗头部、关闭按钮的左边（弹窗壳预留了 .mode-settings-actions） -->
    <!-- defer：目标在同一个渲染树里、比本体晚挂载，等应用挂完再投进去 -->
    <Teleport defer to=".mode-settings-actions">
      <button type="button" class="nb-reset" @click="store.reset()">
        <AppIcon name="refresh" :size="13" />
        恢复默认
      </button>
    </Teleport>
  </div>
</template>

<style scoped>
.nb-settings {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.nb-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nb-title {
  margin: 0 0 4px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.nb-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

/* 分段选择 */
.nb-row {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.nb-seg {
  display: flex;
  flex: none;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  gap: 2px;
}

.nb-seg.disabled {
  opacity: 0.45;
}

.nb-seg-item {
  padding: 4px 10px;
  border-radius: calc(var(--radius-sm) - 2px);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.nb-seg-item:hover:not(:disabled):not(.on) {
  color: var(--text);
}

.nb-seg-item.on {
  background: var(--accent);
  color: var(--accent-contrast);
}

/* 滑块行 */
.nb-slider {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 12px;
}

.nb-slider .nb-label {
  width: 64px;
  flex: none;
}

.nb-slider input[type='range'] {
  flex: 1;
  height: 4px;
  appearance: none;
  border-radius: 999px;
  background: var(--surface-hover);
  cursor: pointer;
  outline: none;
}

.nb-slider input[type='range']::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  appearance: none;
  border-radius: 50%;
  background: var(--accent);
  transition: transform 0.15s ease;
}

.nb-slider input[type='range']:active::-webkit-slider-thumb {
  transform: scale(1.2);
}

.nb-value {
  width: 44px;
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* 开关行 */
.nb-toggle {
  display: flex;
  min-height: 28px;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
}

.nb-toggle:disabled {
  opacity: 0.45;
}

.nb-switch {
  position: relative;
  width: 30px;
  height: 17px;
  flex: none;
  border-radius: 999px;
  background: var(--surface-hover);
  transition: background var(--dur-fast) var(--ease);
}

.nb-switch::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--text-muted);
  content: '';
  transition:
    transform var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}

.nb-switch.on {
  background: var(--accent);
}

.nb-switch.on::after {
  background: var(--accent-contrast);
  transform: translateX(13px);
}

/* 恢复默认（按钮本身挂在弹窗头部，见模板里的 Teleport） */
.nb-reset {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.nb-reset:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
</style>
