import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { normalizeMachiTuning } from '../machi/machiTuning';
import { DEFAULT_MACHI_TUNING, type MachiTuning } from '../machi/types';

/**
 * 町景的调参存档（MachiMode 的设置面板与取景控制条读写这份）。
 * 读存档时整块走 normalizeMachiTuning：缺的字段补默认、坏的值回落、数值夹进范围。
 */

const STORAGE_KEY = 'sakura.desktop.machi-tuning';

function load(): MachiTuning {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) return normalizeMachiTuning(JSON.parse(text));
  } catch {
    // 存档坏了就当没存过
  }
  return normalizeMachiTuning(undefined);
}

export const useMachiTuningStore = defineStore('machi-tuning', () => {
  const tuning = ref<MachiTuning>(load());

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

  /** 整块替换式打补丁：引用变化让 MachiMode 的 watcher 一次到位。 */
  function patch(partial: Partial<MachiTuning>): void {
    tuning.value = normalizeMachiTuning({ ...tuning.value, ...partial });
  }

  function reset(): void {
    tuning.value = { ...DEFAULT_MACHI_TUNING, views: JSON.parse(JSON.stringify(DEFAULT_MACHI_TUNING.views)) };
  }

  return { tuning, patch, reset };
});
