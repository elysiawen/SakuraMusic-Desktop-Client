import { app, BrowserWindow, dialog, Menu, Tray } from 'electron';
import { join } from 'node:path';
import { APP_ID, APP_NAME } from '@shared/constants';
import type { DesktopConfig, DesktopConfigPatch } from '@shared/ipc';
// 托盘图标与窗口/安装包图标同源。
import appIcon from '../../build/icon.png?asset';
import { startBff, type BffHandle } from './bff/server';
import { cleanupTempFiles } from './cache/index';
import { getConfig, saveConfig } from './config/store';
import { closeDatabase, initDatabase } from './db';
import { closeDesktopLyric, syncDesktopLyric } from './lyric';
import { pruneMissingFiles } from './offline/store';
import { installMenu } from './menu';
import { registerIpc } from './ipc';
import { closeNowPlayingWindow, initNowPlayingWindow } from './nowPlayingWindow';
import { registerAppProtocol, registerAppScheme } from './protocol';
import { createMainWindow } from './windows/main';
import {
  disposeTaskbarPreview,
  initTaskbarPreview,
  logTaskbarPreview,
  syncTaskbarPreview,
} from './windows/taskbarPreview';

// 必须在 app.whenReady() 之前：把 sakura:// 声明成标准、安全、可流式的 scheme，
// 页面才有固定 origin（dev / release 一致），localStorage 不再随端口漂移。
registerAppScheme();

// 一起听/房间镜像需要不经过用户手势也能起播。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName(APP_NAME);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let bff: BffHandle | null = null;
  let quitting = false;

  const showMainWindow = (): void => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  app.on('second-instance', () => {
    showMainWindow();
  });

  /** 配置变了之后的统一收尾：同步歌词窗口、刷新托盘、广播给所有窗口。 */
  const applyConfigChanged = (config: DesktopConfig): void => {
    syncDesktopLyric(config);
    syncTaskbarPreview(config);
    refreshTray();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('lyric:prefs', config);
    }
  };

  const applyPatch = (patch: DesktopConfigPatch): void => {
    applyConfigChanged(saveConfig(patch));
  };

  function refreshTray(): void {
    if (!tray) return;
    const config = getConfig();
    const taskbarPreviewItem: Electron.MenuItemConstructorOptions = {
      label: '任务栏预览',
      type: 'checkbox',
      checked: config.taskbarPreview,
      click: (item) => applyPatch({ taskbarPreview: item.checked }),
    };
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: showMainWindow },
        { type: 'separator' },
        {
          label: '桌面歌词',
          type: 'checkbox',
          checked: config.desktopLyric,
          click: (item) => applyPatch({ desktopLyric: item.checked }),
        },
        {
          // 锁定后鼠标穿透，这是穿透状态下唯一的解锁入口之一。
          label: '锁定歌词',
          type: 'checkbox',
          enabled: config.desktopLyric,
          checked: config.lyricLocked,
          click: (item) => applyPatch({ lyricLocked: item.checked }),
        },
        ...(process.platform === 'win32' ? [taskbarPreviewItem] : []),
        { type: 'separator' },
        {
          label: '退出',
          // before-quit 会置 quitting 并关闭 BFF，这里只触发退出流程。
          click: () => app.quit(),
        },
      ]),
    );
  }

  const ensureTray = (): void => {
    // macOS 遵循平台习惯：关窗不退出，靠 Dock/activate 重开，不做托盘。
    if (tray || process.platform === 'darwin') return;
    tray = new Tray(appIcon);
    tray.setToolTip(APP_NAME);
    refreshTray();
    tray.on('click', showMainWindow);
  };

  const openMainWindow = (): void => {
    if (!bff) return;
    mainWindow = createMainWindow();
    // 任务栏缩略图预览：仅 Windows 生效，非 Windows 内部直接返回。
    initTaskbarPreview(mainWindow, {
      enabled: getConfig().taskbarPreview,
      onCommand: (command) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          logTaskbarPreview(`SEND ${command}`);
          mainWindow.webContents.send('taskbar-preview:command', command);
        } else {
          logTaskbarPreview(`SEND skipped ${command}`);
        }
      },
    });
    mainWindow.on('close', (event) => {
      // 「关闭窗口时收进托盘」：拦截关闭，只隐藏窗口，播放/下载不中断。
      if (quitting || process.platform === 'darwin') return;
      if (!getConfig().closeToTray) return;
      event.preventDefault();
      mainWindow?.hide();
    });
    mainWindow.on('closed', () => {
      disposeTaskbarPreview();
      mainWindow = null;
      // 不收托盘的模式下关窗即退出：把歌词窗口与弹出播放窗口一起带走，
      // window-all-closed 才会触发。
      if (!quitting && !getConfig().closeToTray) {
        closeDesktopLyric();
        closeNowPlayingWindow();
      }
    });
    ensureTray();
  };

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    // dev 时协议层把静态请求转发给 Vite，生产时直接读 out/renderer；
    // 页面本身两边都从 sakura://app 加载，不再有 origin / CSP 差异。
    const devServerUrl = process.env.ELECTRON_RENDERER_URL?.replace(/\/+$/, '') ?? null;
    // 本地数据库：离线索引与 meta 响应缓存都在这里。必须赶在 BFF 起来
    // 之前初始化，否则首个 /api 或 /offline 请求会拿到未初始化的连接。
    try {
      initDatabase(app.getPath('userData'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox('Sakura Music 启动失败', `本地数据库无法初始化：${message}`);
      app.quit();
      return;
    }

    // 只删上次异常退出留下的 .part/.tmp，不参与窗口创建：放到下一个 tick，
    // 别让封面缓存目录的 readdirSync 挡住冷启动关键路径。
    setImmediate(cleanupTempFiles);
    // 用户可能手动删过下载文件：后台分批校验一次，不挡首屏。
    setImmediate(pruneMissingFiles);
    installMenu();
    registerIpc({ getMainWindow: () => mainWindow, onConfigChanged: applyConfigChanged });

    try {
      bff = await startBff({ dev: devServerUrl !== null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        'Sakura Music 启动失败',
        `本地服务无法启动：${message}\n\n` +
          (message.includes('EADDRINUSE')
            ? '端口被占用，通常说明已有一个 Sakura Music 实例在运行。请先关闭它再试。'
            : '请重启应用；若问题持续，请查看日志。'),
      );
      app.quit();
      return;
    }

    // 协议 handler 必须先注册，窗口 loadURL 才会命中。
    registerAppProtocol({
      rendererRoot: join(__dirname, '../renderer'),
      devServerUrl,
      bffUrl: bff.url,
      secret: bff.secret,
    });

    openMainWindow();

    // 桌面歌词：跟上次开关状态恢复；主窗口收进托盘后歌词继续显示。
    syncDesktopLyric(getConfig());

    // 弹出式播放窗口：点封面/弹出按钮时建，全生命周期惰性。
    initNowPlayingWindow({ getMainWindow: () => mainWindow });

    app.on('activate', () => {
      // 歌词窗口不算数：Dock 点一下要把主窗口找回来。
      if (!mainWindow) openMainWindow();
    });
  });

  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    // 先停本地服务再收数据库，避免退出途中的请求打到已关闭的连接。
    if (bff) void bff.close().finally(closeDatabase);
    else closeDatabase();
  });

  // 兜底：任何退出路径都要释放 SQLite 句柄并 checkpoint WAL。
  app.on('will-quit', closeDatabase);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
