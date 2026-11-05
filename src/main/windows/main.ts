import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
// 窗口/任务栏图标与安装包图标同源，都取自 build/icon.png。
import appIcon from '../../../build/icon.png?asset';

interface CreateMainWindowOptions {
  bffUrl: string;
  secret: string;
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
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
      : { frame: false }),
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

  window.once('ready-to-show', () => {
    window.show();
  });

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
      url.startsWith(options.bffUrl) ||
      url.startsWith('http://localhost:5173') ||
      url.startsWith('http://127.0.0.1:5173');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadURL(`${options.bffUrl}/?k=${encodeURIComponent(options.secret)}`);
  }

  return window;
}
