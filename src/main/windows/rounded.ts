import { release } from 'node:os';
import type { BrowserWindow } from 'electron';

/**
 * Windows 10 的圆角：SetWindowRgn（QQ 音乐 / 网易云同款）。
 *
 * Windows 10 没有 DWMWA_WINDOW_CORNER_PREFERENCE（Win11 才有，见窗口创建处的
 * `roundedCorners`），而 transparent 窗口会把 DWM 动画（最小化/最大化/关闭）全部弄丢。
 * 剩下的路就是给不透明窗口裁一个圆角区域：窗口仍然由 DWM 管理，动画都在，
 * 只是形状被裁成圆角矩形 —— 这正是那批原生音乐客户端的做法。
 *
 * 区域坐标跟着窗口尺寸走，所以每次 resize 都要重裁；最大化铺平屏幕时恢复直角。
 * 任何一步失败（比如 koffi 没编出来）都只是退回直角，不影响窗口本身。
 */

/** 圆角半径（px），与 Win11 默认的 8px 看齐。 */
const RADIUS = 8;

interface RgnApi {
  createRoundRectRgn(x1: number, y1: number, x2: number, y2: number, w: number, h: number): unknown;
  setWindowRgn(hwnd: unknown, rgn: unknown, redraw: boolean): number;
  decodeHwnd(handle: Buffer): unknown;
}

/** 只在 Windows 10（build < 22000）上需要这套补丁。 */
export function needsRoundedRegion(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(release().split('.')[2] ?? 0);
  return build > 0 && build < 22000;
}

function loadRgnApi(): RgnApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi');
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    return {
      createRoundRectRgn: gdi32.func('CreateRoundRectRgn', 'void*', [
        'int',
        'int',
        'int',
        'int',
        'int',
        'int',
      ]),
      setWindowRgn: user32.func('SetWindowRgn', 'int', ['void*', 'void*', 'bool']),
      decodeHwnd: (handle) => koffi.decode(handle, 'void*'),
    };
  } catch {
    return null;
  }
}

/**
 * 给窗口挂上圆角区域，并跟随尺寸/最大化状态维护。
 * 返回是否成功挂上（失败就是直角，不需要调用方兜底）。
 */
export function applyRoundedRegion(window: BrowserWindow): boolean {
  const api = loadRgnApi();
  if (!api) return false;

  /** 当前已裁区域的尺寸；null 表示没有区域（直角，不裁内容）。 */
  let regionSize: { width: number; height: number } | null = null;

  const clearRegion = (): void => {
    if (window.isDestroyed()) return;
    if (regionSize === null) return;
    try {
      api.setWindowRgn(api.decodeHwnd(window.getNativeWindowHandle()), null, true);
    } catch {
      // 忽略：裁不上只是圆角没了，不影响窗口本身。
    }
    regionSize = null;
  };

  const apply = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) {
      clearRegion();
      return;
    }
    const [width, height] = window.getSize();
    if (width <= 0 || height <= 0) return;
    // 尺寸没变就别再调 SetWindowRgn：那会再触发一次 resize，形成空转。
    if (regionSize && regionSize.width === width && regionSize.height === height) return;

    // 右/下边要 +1：CreateRoundRectRgn 的矩形是左闭右开，不 +1 会吃掉一行像素。
    const rgn = api.createRoundRectRgn(0, 0, width + 1, height + 1, RADIUS * 2, RADIUS * 2);
    if (rgn) {
      api.setWindowRgn(api.decodeHwnd(window.getNativeWindowHandle()), rgn, true);
      regionSize = { width, height };
    }
    // SetWindowRgn 成功后区域归系统所有，这里不能再 DeleteObject。
  };

  /*
   * 拖动边框时不能让旧区域留在窗口上：窗口已经变大，区域还是旧尺寸，
   * 右侧/底部内容会被裁掉，看起来一跳一跳。所以一开始拖就先撤掉圆角，
   * 松手停下后再按最终尺寸裁回去。
   *
   * 所有原生调用都放到定时器里，绝不在 resize 回调中同步执行——
   * 那样会在 Windows 的 WM_SIZE 处理里再次改窗口区域，重入直接把主进程带崩。
   */
  let clearTimer: NodeJS.Timeout | null = null;
  let settleTimer: NodeJS.Timeout | null = null;

  const scheduleClear = (): void => {
    if (regionSize === null || clearTimer) return;
    clearTimer = setTimeout(() => {
      clearTimer = null;
      clearRegion();
    }, 0);
  };

  const scheduleApply = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      try {
        apply();
      } catch {
        // 区域没裁上只是圆角变直角。
      }
    }, 60);
  };

  window.on('resize', () => {
    if (window.isDestroyed()) return;
    // 自己调 SetWindowRgn 也会触发 resize：此时尺寸和区域一致，直接忽略。
    const [width, height] = window.getSize();
    if (regionSize && regionSize.width === width && regionSize.height === height) return;
    scheduleClear();
    scheduleApply();
  });

  // 最大化/全屏时恢复直角；这几条也走定时器，避免在系统事件里同步改区域。
  window.on('maximize', scheduleClear);
  window.on('unmaximize', scheduleApply);
  window.on('enter-full-screen', scheduleClear);
  window.on('leave-full-screen', scheduleApply);
  window.once('ready-to-show', scheduleApply);

  window.on('closed', () => {
    if (clearTimer) clearTimeout(clearTimer);
    if (settleTimer) clearTimeout(settleTimer);
    clearTimer = null;
    settleTimer = null;
  });

  return true;
}
