import { defineAsyncComponent, type Component } from 'vue';
import ClassicMode from './modes/ClassicMode.vue';
import ImmersiveMode from './modes/ImmersiveMode.vue';
import ModeLoading from './ModeLoading.vue';

/**
 * 经典/沉浸体积很小（几十 KB），保持同步引入——打开播放页的那一帧就能渲染，
 * 不会先露出主界面。雾笺/绘光带着 WebGL 与 Pixi 运行时，按需加载：切换瞬间
 * 先用 ModeLoading 全屏盖住，等 chunk 到了再交接给真正的样式。
 */
const NebbiaMode = defineAsyncComponent({
  loader: () => import('./modes/NebbiaMode.vue'),
  loadingComponent: ModeLoading,
  delay: 0,
});
const NebbiaSettings = defineAsyncComponent(() => import('./modes/NebbiaSettings.vue'));
const LumiereMode = defineAsyncComponent({
  loader: () => import('./modes/LumiereMode.vue'),
  loadingComponent: ModeLoading,
  delay: 0,
});
const LumiereSettings = defineAsyncComponent(() => import('./modes/LumiereSettings.vue'));
const MachiMode = defineAsyncComponent({
  loader: () => import('./modes/MachiMode.vue'),
  loadingComponent: ModeLoading,
  delay: 0,
});
const MachiSettings = defineAsyncComponent(() => import('./modes/MachiSettings.vue'));

/**
 * 全屏播放页（Now Playing）的样式注册表。
 *
 * 加一种新样式 = 写一个组件 + 在这里登记一行。顶栏的样式菜单
 * （`ModePicker`）与 AppShell 的动态渲染都读这份表，不用再去别处接线；
 * 本地存档里留了已被删除的样式 id 也没关系，渲染层会回落到第一种。
 */
export interface NowPlayingModeDef {
  id: string;
  /** 菜单里显示的名字。 */
  name: string;
  /** 触发按钮与菜单项用的图标（AppIcon 的 name）。 */
  icon: string;
  /** 菜单项下面那行说明小字。 */
  hint: string;
  component: Component;
  /**
   * 这个样式有自己的调参时给出设置面板组件（内容归样式自己的文件写）；
   * 样式菜单里对应选项旁会出现一个设置按钮，点开弹出这块面板。
   */
  settings?: Component;
  /**
   * 整页是夜色场景的样式（雾笺/绘光）标 `dark`：AppShell 的播放页底色会跟着
   * 换成深色，浅色主题下切换样式时中间就不会透出一片白。
   */
  stageTone?: 'dark';
}

export const NOW_PLAYING_MODES: NowPlayingModeDef[] = [
  {
    id: 'classic',
    name: '经典',
    icon: 'disc',
    hint: '封面与歌词左右分栏',
    component: ClassicMode,
  },
  {
    id: 'immersive',
    name: '沉浸',
    icon: 'sparkles',
    hint: '大字居中 · 流体背景 · 实时频谱',
    component: ImmersiveMode,
    stageTone: 'dark',
  },
  {
    id: 'nebbia',
    name: '雾笺',
    icon: 'droplet',
    hint: '雨夜车窗 · 指尖按笔顺写歌词 · 雨点随歌声打窗',
    component: NebbiaMode,
    settings: NebbiaSettings,
    stageTone: 'dark',
  },
  {
    id: 'lumiere',
    name: '绘光',
    icon: 'sun',
    hint: '舞台追光 · 光束扫过歌词 · 烟雾与辉光随音乐起伏',
    component: LumiereMode,
    settings: LumiereSettings,
    stageTone: 'dark',
  },
  {
    id: 'machi',
    name: '町景',
    icon: 'city',
    hint: '深夜街角小景 · 歌词写在招牌屏上 · 霓虹随节拍呼吸',
    component: MachiMode,
    settings: MachiSettings,
    stageTone: 'dark',
  },
];

export const DEFAULT_NOW_PLAYING_MODE = NOW_PLAYING_MODES[0]?.id ?? 'classic';

/** 按 id 取样式定义；未知 id（比如旧存档）回落到第一种，保证永远有得渲染。 */
export function nowPlayingModeDef(id: string): NowPlayingModeDef {
  return (
    NOW_PLAYING_MODES.find((mode) => mode.id === id) ?? (NOW_PLAYING_MODES[0] as NowPlayingModeDef)
  );
}
