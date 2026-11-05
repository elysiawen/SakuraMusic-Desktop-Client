import type { Component } from 'vue';
import ImmersiveMode from './ImmersiveMode.vue';
import ClassicMode from './ClassicMode.vue';
import MistMode from './MistMode.vue';

/**
 * 全屏播放页（Now Playing）的样式注册表。
 *
 * 加一种新样式 = 写一个组件 + 在这里登记一行。顶栏的样式菜单
 * （`NowPlayingModePicker`）与 AppShell 的动态渲染都读这份表，不用再去别处接线；
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
}

export const NOW_PLAYING_MODES: NowPlayingModeDef[] = [
  {
    id: 'classic',
    name: '经典',
    icon: 'list',
    hint: '封面与歌词左右分栏',
    component: ClassicMode,
  },
  {
    id: 'immersive',
    name: '沉浸',
    icon: 'sparkles',
    hint: '大字居中 · 流体背景 · 实时频谱',
    component: ImmersiveMode,
  },
  {
    id: 'mist',
    name: '雾笺',
    icon: 'droplet',
    hint: '雨夜车窗 · 指尖按笔顺写歌词 · 雨点随歌声打窗',
    component: MistMode,
  },
];

export const DEFAULT_NOW_PLAYING_MODE = NOW_PLAYING_MODES[0]?.id ?? 'classic';

/** 按 id 取样式定义；未知 id（比如旧存档）回落到第一种，保证永远有得渲染。 */
export function nowPlayingModeDef(id: string): NowPlayingModeDef {
  return (
    NOW_PLAYING_MODES.find((mode) => mode.id === id) ?? (NOW_PLAYING_MODES[0] as NowPlayingModeDef)
  );
}
