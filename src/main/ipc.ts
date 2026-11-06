import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { CACHE_KINDS, type CacheKind, type CacheStats } from '@shared/cache';
import type {
  AppInfo,
  DesktopConfig,
  DesktopConfigPatch,
  DesktopLyricState,
  PlatformCredentialState,
  PlatformKey,
  SaveServerInput,
  ServerProbeResult,
  TaskbarPreviewImage,
} from '@shared/ipc';
import { clearSessionCookie } from './auth/cookieVault';
import {
  clearAllPlatformCredentials,
  clearPlatformCredential,
  listLocalPlatforms,
  savePlatformCredential,
} from './auth/platformVault';
import { clearCache, getCacheStats, trimCache } from './cache/index';
import { queryAudioCacheState } from './cache/audio';
import { clearServer, getConfig, saveConfig, saveServer } from './config/store';
import { normalizeBaseUrl } from './config/url';
import { getLyricState, pushLyricState } from './lyric';
import { logTaskbarPreview, setTaskbarPreviewImage } from './windows/taskbarPreview';
import { probeServer } from './bff/gateway';

interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
  /** 配置写盘后调用：同步歌词窗口、刷新托盘、广播 lyric:prefs。 */
  onConfigChanged?: (config: DesktopConfig) => void;
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
    const {
      deviceName,
      closeToTray,
      audioCacheMb,
      coverCacheMb,
      lyricCacheDays,
      metaCacheDays,
      downloadDir,
      desktopLyric,
      lyricLocked,
      lyricFontSize,
      lyricColor,
      lyricShowTrans,
      taskbarPreview,
    } = patch ?? {};
    const next = saveConfig({
      deviceName,
      closeToTray,
      audioCacheMb,
      coverCacheMb,
      lyricCacheDays,
      metaCacheDays,
      downloadDir,
      desktopLyric,
      lyricLocked,
      lyricFontSize,
      lyricColor,
      lyricShowTrans,
      taskbarPreview,
    });
    // 额度调小后立刻按 LRU 压回去，设置页的占用统计也会随之下降。
    trimCache('audio');
    trimCache('cover');
    context.onConfigChanged?.(next);
    return next;
  });

  // 主窗口推播放快照 → 缓存一帧并转发给歌词窗口。
  ipcMain.on('lyric:push', (_event, state: DesktopLyricState): void => {
    if (!state || typeof state !== 'object') return;
    pushLyricState(state);
  });

  ipcMain.handle('lyric:get-state', (): DesktopLyricState | null => getLyricState());

  // 主窗口画好的任务栏预览卡片与按钮图标 → 主进程（仅 Windows 使用）。
  ipcMain.on('taskbar-preview:push', (_event, image: TaskbarPreviewImage): void => {
    if (!image || typeof image !== 'object') return;
    setTaskbarPreviewImage(image);
  });

  // 真机链路诊断：渲染端回报命令执行情况，和主进程写进同一份日志。
  ipcMain.on('taskbar-preview:ack', (_event, line: unknown): void => {
    if (typeof line === 'string') logTaskbarPreview(`RENDERER ${line}`);
  });

  ipcMain.handle('cache:stats', (): CacheStats => getCacheStats());

  ipcMain.handle('cache:clear', (_event, kind?: unknown): CacheStats => {
    if (kind === undefined) clearCache();
    else if (CACHE_KINDS.includes(kind as CacheKind)) clearCache(kind as CacheKind);
    return getCacheStats();
  });

  /** 渲染进程查询某首音频的本地缓存状态（磁盘实查，无副作用）。 */
  ipcMain.handle(
    'cache:audio-check',
    (_event, key: string): 'full' | 'partial' | null => queryAudioCacheState(key),
  );

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
}
