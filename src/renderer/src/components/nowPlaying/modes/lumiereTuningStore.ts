import { defineStore } from 'pinia';
import {
  DEFAULT_LUMIERE_TUNING,
  type LumiereRenderQuality,
  type LumiereTuning,
} from '../folia/foliaTypes';

/**
 * 绘光的调参存档：localStorage 持久化，字段与 folia 的 LumiereTuning 一致
 * （folia 那边走 defineVisualizerTuning + 设置中心，sakura 简化成单档存储）。
 * 读取时逐项校验/夹取，坏存档不拖垮渲染。
 *
 * render（分辨率/抗锯齿）不在内：桌面端没有 folia 的全局渲染挡位，恒用默认。
 */

const STORAGE_KEY = 'lumiere_tuning';

type LumiereNumberKey = {
  // number extends … 这层把 windowNeighbors（1 | 2 字面量）排除掉——它走下面的专项校验
  [K in keyof LumiereTuning]: LumiereTuning[K] extends number
    ? number extends LumiereTuning[K]
      ? K
      : never
    : never;
}[keyof LumiereTuning];

type LumiereBoolKey = {
  [K in keyof LumiereTuning]: LumiereTuning[K] extends boolean ? K : never;
}[keyof LumiereTuning];

/** 数值项的范围（来自 folia 的 LumiereSettingsPanel）。 */
const LUMIERE_LIMITS: Record<LumiereNumberKey, { min: number; max: number }> = {
  lightIntensity: { min: 0.3, max: 2 },
  audioResponse: { min: 0, max: 2 },
  bloom: { min: 0, max: 2 },
  textBloom: { min: 0, max: 2 },
  darkField: { min: 0, max: 1 },
  fogDensity: { min: 0, max: 2 },
  fogOctaves: { min: 2, max: 6 },
  moteAmount: { min: 0, max: 2 },
  unlitOpacity: { min: 0.05, max: 0.6 },
  decay: { min: 0, max: 2 },
  echo: { min: 0, max: 2 },
  themeColorMix: { min: 0, max: 1 },
};

const BOOL_KEYS: LumiereBoolKey[] = [
  'lineArt',
  'frontBokeh',
  'trails',
  'hideTrails',
  'seamlessTransitions',
  'overlayFrame',
  'textOnly',
  'keywordColors',
  'themeIcons',
];

const QUALITIES: LumiereRenderQuality[] = ['full', 'balanced', 'low'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 逐项校验；不认识的键丢弃，坏值回默认。 */
function sanitize(raw: unknown): LumiereTuning {
  const tuning = { ...DEFAULT_LUMIERE_TUNING };
  if (!raw || typeof raw !== 'object') return tuning;
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(LUMIERE_LIMITS) as LumiereNumberKey[]) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = LUMIERE_LIMITS[key];
    tuning[key] = key === 'fogOctaves' ? Math.round(clamp(value, min, max)) : clamp(value, min, max);
  }
  for (const key of BOOL_KEYS) {
    const value = input[key];
    if (typeof value === 'boolean') tuning[key] = value;
  }
  const neighbors = input.windowNeighbors;
  if (neighbors === 1 || neighbors === 2) tuning.windowNeighbors = neighbors;
  const quality = input.renderQuality;
  if (typeof quality === 'string' && (QUALITIES as string[]).includes(quality)) {
    tuning.renderQuality = quality as LumiereRenderQuality;
  }
  return tuning;
}

function load(): LumiereTuning {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_LUMIERE_TUNING };
  }
}

export const useLumiereTuningStore = defineStore('lumiereTuning', {
  state: () => ({
    tuning: load(),
  }),
  actions: {
    patch(partial: Partial<LumiereTuning>): void {
      this.tuning = sanitize({ ...this.tuning, ...partial });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tuning));
    },
    reset(): void {
      this.tuning = { ...DEFAULT_LUMIERE_TUNING };
      localStorage.removeItem(STORAGE_KEY);
    },
  },
});

export { LUMIERE_LIMITS, QUALITIES as LUMIERE_QUALITIES };
export type { LumiereNumberKey, LumiereBoolKey };
