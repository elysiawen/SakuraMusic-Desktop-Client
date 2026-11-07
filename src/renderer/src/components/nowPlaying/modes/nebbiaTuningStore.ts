import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  DEFAULT_NEBBIA_TUNING,
  NEBBIA_APPEAR_STYLES,
  NEBBIA_FADE_STYLES,
  NEBBIA_GLASS,
  NEBBIA_LAYOUTS,
  NEBBIA_LIMITS,
  NEBBIA_RAIN,
  NEBBIA_SCENERY,
  type NebbiaNumberKey,
  type NebbiaTuning,
} from '../nebbia/types';

/**
 * 雾笺的调参存档（NebbiaMode 的设置面板读写这份）。
 * 桌面端没有 folia 的全局渲染挡位和「共用背景」，`render` 固定默认、
 * 窗外只留街景和水族箱；其余项与 folia 的 NebbiaTuning 一致。
 */

const STORAGE_KEY = 'sakura.desktop.nebbia-tuning';

/** 桌面端开放的窗外场景（folia 还有「共用背景」，这里没有）。 */
const SAKURA_BEHIND = ['night', 'aquarium'] as const;

function pickEnum<T extends string>(choices: readonly T[], value: unknown, fallback: T): T {
  return (choices as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

/** 开关组（至少留一项）：存档里被改坏或全关了时回落默认。 */
function pickList<T extends string>(choices: readonly T[], value: unknown, fallback: T[]): T[] {
  if (!Array.isArray(value)) return fallback;
  const out = choices.filter((choice) => value.includes(choice));
  return out.length ? out : fallback;
}

/** 窗外元素可以全关，不和开关组一样兜底。 */
function pickScenery(value: unknown): NebbiaTuning['scenery'] {
  if (!Array.isArray(value)) return [...DEFAULT_NEBBIA_TUNING.scenery];
  return NEBBIA_SCENERY.filter((part) => value.includes(part));
}

function pickNumber(key: NebbiaNumberKey, value: unknown): number {
  const { min, max } = NEBBIA_LIMITS[key];
  const fallback = DEFAULT_NEBBIA_TUNING[key];
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, num));
}

/** 读存档：每项单独校验/夹取，坏一份不拖累别的项。 */
function sanitize(raw: unknown): NebbiaTuning {
  const source = (raw ?? {}) as Record<string, unknown>;
  const tuning = { ...DEFAULT_NEBBIA_TUNING };
  tuning.appear = pickList(NEBBIA_APPEAR_STYLES, source.appear, [...DEFAULT_NEBBIA_TUNING.appear]);
  tuning.fade = pickList(NEBBIA_FADE_STYLES, source.fade, [...DEFAULT_NEBBIA_TUNING.fade]);
  tuning.layouts = pickList(NEBBIA_LAYOUTS, source.layouts, [...DEFAULT_NEBBIA_TUNING.layouts]);
  tuning.behind = pickEnum(SAKURA_BEHIND, source.behind, 'night');
  tuning.glass = pickEnum(NEBBIA_GLASS, source.glass, DEFAULT_NEBBIA_TUNING.glass);
  tuning.scenery = pickScenery(source.scenery);
  tuning.rain = pickEnum(NEBBIA_RAIN, source.rain, DEFAULT_NEBBIA_TUNING.rain);
  tuning.credits = typeof source.credits === 'boolean' ? source.credits : DEFAULT_NEBBIA_TUNING.credits;
  for (const key of Object.keys(NEBBIA_LIMITS) as NebbiaNumberKey[]) {
    tuning[key] = pickNumber(key, source[key]);
  }
  return tuning;
}

function load(): NebbiaTuning {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) return sanitize(JSON.parse(text));
  } catch {
    // 存档坏了就当没存过
  }
  return sanitize(undefined);
}

export const useNebbiaTuningStore = defineStore('nebbia-tuning', () => {
  const tuning = ref<NebbiaTuning>(load());

  watch(
    tuning,
    (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // 存储不可用：本次会话照样生效，只是记不住
      }
    },
    { deep: true },
  );

  /** 整块替换式打补丁：引用变化让 NebbiaMode 的 watcher 一次到位。 */
  function patch(partial: Partial<NebbiaTuning>): void {
    tuning.value = { ...tuning.value, ...partial };
  }

  function reset(): void {
    tuning.value = { ...DEFAULT_NEBBIA_TUNING };
  }

  return { tuning, patch, reset };
});
