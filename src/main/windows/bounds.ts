import { screen, type BrowserWindow } from 'electron';
import type { WindowBounds } from '@shared/ipc';
import { getConfig, saveConfig } from '../config/store';

/**
 * 窗口几何的恢复与落盘。
 *
 * 只记「普通状态」的 bounds：最大化/全屏时窗口铺满屏幕，那时的尺寸不能
 * 当成用户调过的尺寸写回去，最大化状态另存一个布尔。显示器可能被拔掉或
 * 改分辨率，恢复时统一收敛回对应屏幕的工作区，避免窗口跑到屏幕外。
 */

type BoundsKey = 'mainWindowBounds' | 'nowPlayingBounds';

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RestoreOptions {
  key: BoundsKey;
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
}

const SAVE_DEBOUNCE_MS = 400;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** 计算这次创建窗口该用的几何参数；没存过就按默认尺寸在主屏居中。 */
export function restoreWindowBounds(options: RestoreOptions): Geometry {
  const { key, minWidth, minHeight, defaultWidth, defaultHeight } = options;
  const saved: WindowBounds | null = getConfig()[key];
  const primary = screen.getPrimaryDisplay().workArea;

  if (!saved) {
    const width = clamp(defaultWidth, minWidth, primary.width);
    const height = clamp(defaultHeight, minHeight, primary.height);
    return {
      x: Math.round(primary.x + (primary.width - width) / 2),
      y: Math.round(primary.y + (primary.height - height) / 2),
      width,
      height,
    };
  }

  // 按保存时所在的位置挑显示器；那块屏不在了会退回最近的一块。
  const area = screen.getDisplayMatching(saved).workArea;
  const width = clamp(saved.width, minWidth, area.width);
  const height = clamp(saved.height, minHeight, area.height);
  return {
    x: Math.round(clamp(saved.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(saved.y, area.y, area.y + area.height - height)),
    width,
    height,
  };
}

interface TrackOptions {
  /** 主窗口连「是否最大化」一起记；弹出窗口不记。 */
  trackMaximized?: boolean;
}

/** 挂 resize/move/close，把用户调过的尺寸防抖写进 config.json。 */
export function trackWindowBounds(
  window: BrowserWindow,
  key: BoundsKey,
  options: TrackOptions = {},
): void {
  let timer: NodeJS.Timeout | undefined;

  const write = (): void => {
    timer = undefined;
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) {
      return;
    }
    const { x, y, width, height } = window.getBounds();
    if (width <= 0 || height <= 0) return;
    const bounds: WindowBounds = { x, y, width, height };
    if (key === 'mainWindowBounds') saveConfig({ mainWindowBounds: bounds });
    else saveConfig({ nowPlayingBounds: bounds });
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, SAVE_DEBOUNCE_MS);
  };

  // 关窗（含收进托盘）时立刻落盘，别让最后一次拖动丢在防抖里。
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    write();
  };

  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('close', flush);
  window.on('closed', () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  });

  if (options.trackMaximized) {
    window.on('maximize', () => saveConfig({ mainWindowMaximized: true }));
    window.on('unmaximize', () => saveConfig({ mainWindowMaximized: false }));
  }
}
