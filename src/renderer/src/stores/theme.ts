import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

/**
 * 主题：明暗模式 × 六套配色。
 *
 * 与 web 端共用同一套品牌语义，但桌面端的**默认值是浅色（白底）**——
 * 之前默认「跟随系统」，系统是深色时一打开就是黑的，不符合这里的默认观感。
 *
 * 所有变量写到 `<html data-theme data-palette>`，样式层只认这两个属性。
 */

export type ThemeMode = 'system' | 'light' | 'dark';

export const PALETTES = [
  { id: 'sakura', name: '樱花', accent: '#ff7aa2', accent2: '#ffb3c7' },
  { id: 'matcha', name: '抹茶', accent: '#6fc47a', accent2: '#b7e4a8' },
  { id: 'deep', name: '深海', accent: '#5b8cff', accent2: '#8fb6ff' },
  { id: 'wisteria', name: '紫藤', accent: '#a78bfa', accent2: '#c4b5fd' },
  { id: 'sunset', name: '晚霞', accent: '#ff9a62', accent2: '#ffc48a' },
  { id: 'ink', name: '水墨', accent: '#9aa7bd', accent2: '#cbd5e1' },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];

interface StoredTheme {
  mode?: ThemeMode;
  palette?: PaletteId;
  petals?: boolean;
}

const STORAGE_KEY = 'sakura.desktop.theme';

function loadStored(): StoredTheme {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as StoredTheme;
  } catch {
    return {};
  }
}

function isMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isPalette(value: unknown): value is PaletteId {
  return PALETTES.some((item) => item.id === value);
}

export const useThemeStore = defineStore('theme', () => {
  const stored = loadStored();
  /** 缺省浅色：新装用户打开就是白底，想要深色自己去选。 */
  const mode = ref<ThemeMode>(isMode(stored.mode) ? stored.mode : 'light');
  const palette = ref<PaletteId>(isPalette(stored.palette) ? stored.palette : 'deep');
  const petals = ref(stored.petals !== false);

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const systemDark = ref(media.matches);

  const resolvedMode = computed<'light' | 'dark'>(() =>
    mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value,
  );

  const paletteInfo = computed(
    () => PALETTES.find((item) => item.id === palette.value) ?? PALETTES[2],
  );

  let initialized = false;

  function apply(): void {
    const root = document.documentElement;
    root.dataset.theme = resolvedMode.value;
    root.dataset.palette = palette.value;
    // 原生控件（滚动条、输入框、下拉）按这个值决定深浅。
    root.style.colorScheme = resolvedMode.value;
  }

  function persist(): void {
    const value: StoredTheme = {
      mode: mode.value,
      palette: palette.value,
      petals: petals.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function init(): void {
    if (initialized) return;
    initialized = true;

    media.addEventListener('change', (event) => {
      systemDark.value = event.matches;
    });

    watch(
      [palette, resolvedMode],
      () => {
        apply();
        persist();
      },
      { immediate: true },
    );

    watch(petals, persist);
  }

  function setMode(next: ThemeMode): void {
    mode.value = next;
  }

  function setPalette(next: PaletteId): void {
    palette.value = next;
  }

  function togglePetals(): void {
    petals.value = !petals.value;
  }

  return {
    mode,
    palette,
    petals,
    resolvedMode,
    paletteInfo,
    init,
    setMode,
    setPalette,
    togglePetals,
  };
});
