import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { APP_ID, APP_NAME } from '@shared/constants';
import { startBff, type BffHandle } from './bff/server';
import { installMenu } from './menu';
import { registerIpc } from './ipc';
import { createMainWindow } from './windows/main';

// 一起听/房间镜像需要不经过用户手势也能起播。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName(APP_NAME);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let bff: BffHandle | null = null;
  let quitting = false;

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  const openMainWindow = (): void => {
    if (!bff) return;
    mainWindow = createMainWindow({ bffUrl: bff.url, secret: bff.secret });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  };

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    installMenu();
    registerIpc({ getMainWindow: () => mainWindow });

    try {
      bff = await startBff({
        // 只有 electron-vite dev 会注入 ELECTRON_RENDERER_URL；其余情况（预览、打包）
        // 都由 BFF 自己托管 out/renderer，避免“已构建却打开空白页”。
        dev: Boolean(process.env.ELECTRON_RENDERER_URL),
        rendererRoot: join(__dirname, '../renderer'),
      });
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

    openMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    void bff?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
