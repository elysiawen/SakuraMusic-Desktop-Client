<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useLumiereTuningStore, LUMIERE_LIMITS, type LumiereNumberKey } from './lumiereTuningStore';
import type { LumiereRenderQuality, LumiereTuning } from '../folia/foliaTypes';

/**
 * 绘光的设置面板（样式菜单里绘光旁的设置按钮弹出这个）。
 * 内容归绘光自己管：分组、文案、滑块范围对应 folia 的 LumiereSettingsPanel；
 * 「分辨率与抗锯齿」一档桌面端没有（没有全局渲染挡位），不出现。
 *
 * 读写走 lumiereTuningStore（localStorage 持久化）；除「轨迹过渡」要重编
 * 词元程序外都由 LumiereMode 热更（setTuning）。
 */
const store = useLumiereTuningStore();
const tuning = computed(() => store.tuning);

function patch(partial: Partial<LumiereTuning>): void {
  store.patch(partial);
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const times = (value: number) => `×${value.toFixed(2).replace(/0$/, '')}`;
const count = (value: number) => String(Math.round(value));

interface SliderSpec {
  key: LumiereNumberKey;
  label: string;
  step: number;
  format: (value: number) => string;
}

const LIGHT_SLIDERS: SliderSpec[] = [
  { key: 'lightIntensity', label: '光强', step: 0.05, format: times },
  { key: 'audioResponse', label: '随音乐起伏', step: 0.05, format: times },
  { key: 'bloom', label: '辉光', step: 0.05, format: times },
  { key: 'textBloom', label: '文字辉光', step: 0.05, format: times },
];
const MOOD_SLIDERS: SliderSpec[] = [
  { key: 'darkField', label: '暗场', step: 0.05, format: percent },
  { key: 'fogDensity', label: '烟雾浓度', step: 0.05, format: times },
  { key: 'fogOctaves', label: '烟雾细节', step: 1, format: count },
  { key: 'moteAmount', label: '浮尘', step: 0.05, format: times },
];
const TEXT_SLIDERS: SliderSpec[] = [
  { key: 'unlitOpacity', label: '未唱字透明度', step: 0.01, format: percent },
  { key: 'decay', label: '崩解', step: 0.05, format: times },
  { key: 'echo', label: '余音', step: 0.05, format: times },
];

interface SwitchSpec {
  key: keyof LumiereTuning;
  label: string;
}

const MOOD_SWITCHES: SwitchSpec[] = [
  { key: 'frontBokeh', label: '前景光斑' },
  { key: 'lineArt', label: '线稿' },
  { key: 'overlayFrame', label: '画框' },
];
const TEXT_SWITCHES: SwitchSpec[] = [
  { key: 'textOnly', label: '只看文字' },
  { key: 'trails', label: '轨迹' },
  { key: 'hideTrails', label: '藏起轨迹' },
  { key: 'seamlessTransitions', label: '轨迹过渡' },
];
const THEME_SWITCHES: SwitchSpec[] = [
  { key: 'keywordColors', label: '关键词上色' },
  { key: 'themeIcons', label: '句尾小图标' },
];

const NEIGHBOR_OPTIONS = [
  { value: 1, label: '近邻' },
  { value: 2, label: '两邻' },
] as const;
const QUALITY_OPTIONS: { value: LumiereRenderQuality; label: string }[] = [
  { value: 'full', label: '满' },
  { value: 'balanced', label: '均衡' },
  { value: 'low', label: '省电' },
];
</script>

<template>
  <div class="nb-settings">
    <!-- 光 -->
    <section class="nb-group">
      <h3 class="nb-title">光</h3>
      <label v-for="spec in LIGHT_SLIDERS" :key="spec.key" class="nb-slider">
        <span class="nb-label">{{ spec.label }}</span>
        <input
          type="range"
          :min="LUMIERE_LIMITS[spec.key].min"
          :max="LUMIERE_LIMITS[spec.key].max"
          :step="spec.step"
          :value="tuning[spec.key]"
          @input="patch({ [spec.key]: Number(($event.target as HTMLInputElement).value) } as Partial<LumiereTuning>)"
        />
        <span class="nb-value">{{ spec.format(tuning[spec.key]) }}</span>
      </label>
    </section>

    <!-- 氛围 -->
    <section class="nb-group">
      <h3 class="nb-title">氛围</h3>
      <label v-for="spec in MOOD_SLIDERS" :key="spec.key" class="nb-slider">
        <span class="nb-label">{{ spec.label }}</span>
        <input
          type="range"
          :min="LUMIERE_LIMITS[spec.key].min"
          :max="LUMIERE_LIMITS[spec.key].max"
          :step="spec.step"
          :value="tuning[spec.key]"
          @input="patch({ [spec.key]: Number(($event.target as HTMLInputElement).value) } as Partial<LumiereTuning>)"
        />
        <span class="nb-value">{{ spec.format(tuning[spec.key]) }}</span>
      </label>
      <button
        v-for="spec in MOOD_SWITCHES"
        :key="spec.key"
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="!!tuning[spec.key]"
        @click="patch({ [spec.key]: !tuning[spec.key] } as Partial<LumiereTuning>)"
      >
        <span class="nb-label">{{ spec.label }}</span>
        <span class="nb-switch" :class="{ on: tuning[spec.key] }" />
      </button>
    </section>

    <!-- 文字 -->
    <section class="nb-group">
      <h3 class="nb-title">文字</h3>
      <button
        v-for="spec in TEXT_SWITCHES"
        :key="spec.key"
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="!!tuning[spec.key]"
        @click="patch({ [spec.key]: !tuning[spec.key] } as Partial<LumiereTuning>)"
      >
        <span class="nb-label">{{ spec.label }}</span>
        <span class="nb-switch" :class="{ on: tuning[spec.key] }" />
      </button>
      <label v-for="spec in TEXT_SLIDERS" :key="spec.key" class="nb-slider">
        <span class="nb-label">{{ spec.label }}</span>
        <input
          type="range"
          :min="LUMIERE_LIMITS[spec.key].min"
          :max="LUMIERE_LIMITS[spec.key].max"
          :step="spec.step"
          :value="tuning[spec.key]"
          @input="patch({ [spec.key]: Number(($event.target as HTMLInputElement).value) } as Partial<LumiereTuning>)"
        />
        <span class="nb-value">{{ spec.format(tuning[spec.key]) }}</span>
      </label>
      <div class="nb-row">
        <span class="nb-label">邻行</span>
        <div class="nb-seg">
          <button
            v-for="option in NEIGHBOR_OPTIONS"
            :key="option.value"
            type="button"
            class="nb-seg-item"
            :class="{ on: tuning.windowNeighbors === option.value }"
            @click="patch({ windowNeighbors: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </section>

    <!-- 主题 -->
    <section class="nb-group">
      <h3 class="nb-title">主题</h3>
      <label class="nb-slider">
        <span class="nb-label">主题色混入</span>
        <input
          type="range"
          :min="LUMIERE_LIMITS.themeColorMix.min"
          :max="LUMIERE_LIMITS.themeColorMix.max"
          step="0.05"
          :value="tuning.themeColorMix"
          @input="patch({ themeColorMix: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="nb-value">{{ percent(tuning.themeColorMix) }}</span>
      </label>
      <button
        v-for="spec in THEME_SWITCHES"
        :key="spec.key"
        type="button"
        class="nb-toggle"
        role="switch"
        :aria-checked="!!tuning[spec.key]"
        @click="patch({ [spec.key]: !tuning[spec.key] } as Partial<LumiereTuning>)"
      >
        <span class="nb-label">{{ spec.label }}</span>
        <span class="nb-switch" :class="{ on: tuning[spec.key] }" />
      </button>
    </section>

    <!-- 性能 -->
    <section class="nb-group">
      <h3 class="nb-title">性能</h3>
      <div class="nb-row">
        <span class="nb-label">画质</span>
        <div class="nb-seg">
          <button
            v-for="option in QUALITY_OPTIONS"
            :key="option.value"
            type="button"
            class="nb-seg-item"
            :class="{ on: tuning.renderQuality === option.value }"
            @click="patch({ renderQuality: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
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
/* 与 NebbiaSettings.vue 同一套排版（各样式自己的面板自带一份） */
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

.nb-seg-item:hover:not(.on) {
  color: var(--text);
}

.nb-seg-item.on {
  background: var(--accent);
  color: var(--accent-contrast);
}

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

.nb-toggle {
  display: flex;
  min-height: 28px;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
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
