import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
// 窗口/任务栏图标与安装包图标同源，都取自 build/icon.png。
import appIcon from '../../../build/icon.png?asset';
import { APP_ENTRY, APP_ORIGIN } from '../protocol';
import { getConfig } from '../config/store';
import { restoreWindowBounds, trackWindowBounds } from './bounds';
import { applyRoundedRegion, needsRoundedRegion } from './rounded';

/** 页面地址固定，不再需要按 dev/release 传 bffUrl 与 secret。 */
export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const bounds = restoreWindowBounds({
    key: 'mainWindowBounds',
    minWidth: 1080,
    minHeight: 700,
    defaultWidth: 1440,
    defaultHeight: 900,
  });
  const restoreMaximized = getConfig().mainWindowMaximized;

  const window = new BrowserWindow({
    ...bounds,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    // 开发态（未打包）时窗口和任务栏也用品牌图标，打包后由安装包资源接管。
    icon: appIcon,
    // 与界面一致的白底：窗口先显示、页面还没挂载时不会闪一下深色。
    backgroundColor: '#ffffff',
    autoHideMenuBar: !isMac,
    ...(isMac
      ? {
          frame: true,
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 18, y: 16 },
        }
      : {
          frame: false,
          /*
           * 圆角：Win11 走 DWM（roundedCorners）；Win10 没有这套接口，
           * 用 SetWindowRgn 裁（见 ./rounded）——动画都能保住，
           * transparent 窗口那条路会把 DWM 动画全弄丢，不走。
           */
          roundedCorners: true,
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // 一起听/跟随靠 200ms 本地节拍，窗口最小化时不能被 Chromium 降频。
      backgroundThrottling: false,
    },
  });

  trackWindowBounds(window, 'mainWindowBounds', { trackMaximized: true });

  window.once('ready-to-show', () => {
    // 先还原最大化再 show，避免闪一帧普通尺寸。
    if (restoreMaximized) window.maximize();
    window.show();
  });

  // Windows 10：SetWindowRgn 裁圆角（Win11 已由 DWM 画好，不用管）。
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
    // 站内导航（含 hash 路由）留在应用里，外链一律交给系统浏览器。
    const allowed =
      url.startsWith(APP_ORIGIN) ||
      url.startsWith('http://localhost:5173') ||
      url.startsWith('http://127.0.0.1:5173');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  void window.loadURL(APP_ENTRY);

  return window;
}
