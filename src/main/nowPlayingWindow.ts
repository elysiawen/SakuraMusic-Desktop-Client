import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
// 与主窗口同源的任务栏/窗口图标。
import appIcon from '../../build/icon.png?asset';
import { applyRoundedRegion, needsRoundedRegion } from './windows/rounded';

interface InitNowPlayingWindowOptions {
  bffUrl: string;
  secret: string;
  /** 主窗口句柄随重建而变，所以取函数。 */
  getMainWindow: () => BrowserWindow | null;
}

let entryUrl: string | null = null;
let bffUrl: string | null = null;
let getMainWindow: (() => BrowserWindow | null) | null = null;
let npWindow: BrowserWindow | null = null;
/** 最近一次播放快照：弹出窗口挂载晚于主窗口首拍时不丢。 */
let lastState: unknown = null;

export function initNowPlayingWindow(options: InitNowPlayingWindowOptions): void {
  bffUrl = options.bffUrl;
  getMainWindow = options.getMainWindow;
  // 与桌面歌词窗口同款入口约定：renderer 自己按 ?window= 分支挂载。
  entryUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}?window=nowplaying`
    : `${options.bffUrl}/?k=${encodeURIComponent(options.secret)}&window=nowplaying`;
}

function current(): BrowserWindow | null {
  return npWindow && !npWindow.isDestroyed() ? npWindow : null;
}

export function isNowPlayingOpen(): boolean {
  return current() !== null;
}

export function getNowPlayingState(): unknown {
  return lastState;
}

function notifyOpenChange(open: boolean): void {
  const main = getMainWindow?.() ?? null;
  if (main && !main.isDestroyed()) main.webContents.send('np:open-change', open);
}

/** 主窗口每个播放节拍推一次快照：缓存一份，再转给弹出窗口。 */
export function pushNowPlayingState(state: unknown): void {
  lastState = state;
  const window = current();
  if (window && !window.webContents.isLoading()) window.webContents.send('np:state', state);
}

/**
 * 打开独立播放窗口（只能有一个）：没有就建，有就叫到最前。
 * 与覆盖层互斥——开着时主窗口的「打开全屏歌词」会改走 focus。
 * `dark` 决定新窗口底色：雾笺/绘光/沉浸是夜色场景，用深色底，
 * 页面首帧渲染之前也不会闪一格白。
 */
export function openNowPlayingWindow(dark = false): void {
  if (!entryUrl) return;
  const existing = current();
  if (existing) {
    focusNowPlayingWindow();
    return;
  }

  const isMac = process.platform === 'darwin';
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: appIcon,
    backgroundColor: dark ? '#05070a' : '#ffffff',
    autoHideMenuBar: !isMac,
    ...(isMac
      ? {
          frame: true,
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 18, y: 16 },
        }
      : {
          frame: false,
          // 与主窗口一致的 DWM 圆角方案（见 windows/rounded）。
          roundedCorners: true,
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // 逐字歌词/雨点动画不能被最小化降频弄坏节拍。
      backgroundThrottling: false,
    },
  });
  npWindow = window;

  window.once('ready-to-show', () => {
    window.show();
  });
  if (needsRoundedRegion()) applyRoundedRegion(window);

  const sendMaximized = (value: boolean): void => {
    if (!window.isDestroyed()) window.webContents.send('window:maximized', value);
  };
  window.on('maximize', () => sendMaximized(true));
  window.on('unmaximize', () => sendMaximized(false));
  window.on('enter-full-screen', () => sendMaximized(true));
  window.on('leave-full-screen', () => sendMaximized(false));

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const allowed =
      !!bffUrl &&
      (url.startsWith(bffUrl) ||
        url.startsWith('http://localhost:5173') ||
        url.startsWith('http://127.0.0.1:5173'));
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  window.on('closed', () => {
    npWindow = null;
    // 让主窗口恢复「点封面开覆盖层」，并停掉快照推送。
    notifyOpenChange(false);
  });

  notifyOpenChange(true);
  void window.loadURL(entryUrl);
}

/** 把已开着的独立窗口叫到最前（不新建）。 */
export function focusNowPlayingWindow(): void {
  const window = current();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** 关掉独立窗口（主窗口随主进程退出关闭时一并带走）。 */
export function closeNowPlayingWindow(): void {
  current()?.close();
}
