import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type {
  AppInfo,
  DesktopConfig,
  DesktopConfigPatch,
  PlatformCredentialState,
  PlatformKey,
  SaveServerInput,
  ServerProbeResult,
} from '@shared/ipc';
import { clearSessionCookie } from './auth/cookieVault';
import {
  clearAllPlatformCredentials,
  clearPlatformCredential,
  listLocalPlatforms,
  savePlatformCredential,
} from './auth/platformVault';
import { clearServer, getConfig, saveConfig, saveServer } from './config/store';
import { normalizeBaseUrl } from './config/url';
import { probeServer } from './bff/gateway';

interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

export function registerIpc(context: IpcContext): void {
  ipcMain.handle('config:get', (): DesktopConfig => getConfig());

  ipcMain.handle(
    'config:save-server',
    (_event, input: SaveServerInput): DesktopConfig => {
      const previous = getConfig();
      const next = saveServer({
        baseUrl: normalizeBaseUrl(input?.baseUrl ?? ''),
        allowInvalidCert: input?.allowInvalidCert === true,
      });
      // 换了服务器就等于换了账号体系：旧会话令牌与本机平台凭据都不能带过去。
      if (next.baseUrl !== previous.baseUrl) {
        clearSessionCookie();
        clearAllPlatformCredentials();
      }
      return next;
    },
  );

  ipcMain.handle('config:clear-server', (): DesktopConfig => {
    clearSessionCookie();
    return clearServer();
  });

  ipcMain.handle('config:update', (_event, patch: DesktopConfigPatch): DesktopConfig => {
    // 只允许改偏好字段；服务器地址必须走 saveServer，避免绕过换服务器时的清理逻辑。
    const { deviceName, closeToTray, cacheLimitMb, downloadDir } = patch ?? {};
    return saveConfig({ deviceName, closeToTray, cacheLimitMb, downloadDir });
  });

  ipcMain.handle('dialog:choose-directory', async (event): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory'],
    };
    const window = windowOf(event);
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    'server:test',
    (_event, input: SaveServerInput): Promise<ServerProbeResult> =>
      probeServer(input?.baseUrl ?? '', input?.allowInvalidCert === true),
  );

  ipcMain.handle('auth:clear-session', (): { ok: boolean } => {
    clearSessionCookie();
    // 退出登录时一并清掉「仅本机」的平台凭据，避免下一个登录的账号继承它。
    clearAllPlatformCredentials();
    return { ok: true };
  });

  const credentialState = (): PlatformCredentialState => ({ platforms: listLocalPlatforms() });

  ipcMain.handle('platform-cred:list', credentialState);

  ipcMain.handle(
    'platform-cred:save',
    (_event, input: { platform?: string; cookie?: string }): PlatformCredentialState => {
      if (input?.platform === 'netease' || input?.platform === 'qq') {
        savePlatformCredential(input.platform, String(input.cookie ?? ''));
      }
      return credentialState();
    },
  );

  ipcMain.handle('platform-cred:clear', (_event, platform: PlatformKey): PlatformCredentialState => {
    if (platform === 'netease' || platform === 'qq') clearPlatformCredential(platform);
    return credentialState();
  });

  ipcMain.handle('platform-cred:clear-all', (): PlatformCredentialState => {
    clearAllPlatformCredentials();
    return credentialState();
  });

  ipcMain.handle('app:info', (): AppInfo => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
    };
  });

  ipcMain.handle('window:minimize', (event): void => {
    windowOf(event)?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', (event): boolean => {
    const window = windowOf(event);
    if (!window) return false;
    if (window.isMaximized()) {
      window.unmaximize();
      return false;
    }
    window.maximize();
    return true;
  });

  ipcMain.handle('window:close', (event): void => {
    windowOf(event)?.close();
  });

  ipcMain.handle('window:is-maximized', (event): boolean => {
    return windowOf(event)?.isMaximized() ?? false;
  });

  ipcMain.handle('shell:open-external', async (_event, url: string): Promise<void> => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle('shell:show-item', (_event, path: string): void => {
    if (path) shell.showItemInFolder(path);
  });

  // 保留主窗口引用，避免将来托盘/深链接需要时再改 IPC 注册顺序。
  void context;
}
