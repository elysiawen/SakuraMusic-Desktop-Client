import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { DesktopConfig, DesktopLyricState } from '@shared/ipc';
import { saveConfig } from './config/store';
import { APP_ENTRY } from './protocol';

/**
 * 桌面歌词窗口：无边框透明置顶条。
 *
 * 状态走向是单向的：主窗口把「歌词行 + 位置 + 时间戳」推给主进程，
 * 这里缓存一帧并转发给歌词窗口，歌词窗口本地按时间戳自走，
 * 只有换行 / 拖动进度 / 暂停恢复时才会有新快照，IPC 流量很小。
 */

const WIDTH = 920;
/** 够放「大号字 + 译文 + 下一句」，字号调大时文字不会被窗口裁掉。 */
const HEIGHT = 200;

let lyricWindow: BrowserWindow | null = null;
let lastState: DesktopLyricState | null = null;

/** 所有窗口共用固定 origin；副窗口靠 ?window= 决定挂哪个根组件。 */
const entryUrl = `${APP_ENTRY}?window=lyric`;

export function getLyricState(): DesktopLyricState | null {
  return lastState;
}

export function pushLyricState(state: DesktopLyricState): void {
  lastState = state;
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('lyric:state', state);
  }
}

export function closeDesktopLyric(): void {
  lyricWindow?.close();
}

function defaultPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height - HEIGHT - 56),
  };
}

/** 按配置保证歌词窗口「该有就有、该没就没」，并套用锁定（鼠标穿透）状态。 */
export function syncDesktopLyric(config: DesktopConfig): void {
  if (!config.desktopLyric) {
    const win = lyricWindow;
    lyricWindow = null;
    win?.close();
    return;
  }

  if (!lyricWindow || lyricWindow.isDestroyed()) {
    const pos =
      config.lyricX !== null && config.lyricY !== null
        ? { x: config.lyricX, y: config.lyricY }
        : defaultPosition();

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      // 歌词条不需要键盘焦点，避免抢走正在打游戏/打字的窗口焦点。
      focusable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    lyricWindow = win;

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.on('closed', () => {
      if (lyricWindow === win) lyricWindow = null;
    });

    // 拖动落点后记住位置，下次启动原地出现。
    let moveTimer: NodeJS.Timeout | undefined;
    win.on('move', () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const [x, y] = win.getPosition();
        saveConfig({ lyricX: x, lyricY: y });
      }, 500);
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    void win.loadURL(entryUrl);
  }

  lyricWindow.setIgnoreMouseEvents(config.lyricLocked);
}
