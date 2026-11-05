import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo,
  DesktopApi,
  DesktopConfig,
  DesktopConfigPatch,
  PlatformCredentialState,
  PlatformKey,
  SaveServerInput,
  ServerProbeResult,
} from '@shared/ipc';

/**
 * 渲染进程唯一的特权入口。
 *
 * 这里只暴露最小必要的方法：配置、服务器探测、窗口控制、外链。
 * 会话 Cookie 与网关请求全部在主进程，渲染进程拿不到任何令牌。
 */

const api: DesktopApi = {
  platform: process.platform,

  getConfig: (): Promise<DesktopConfig> => ipcRenderer.invoke('config:get'),
  saveServer: (input: SaveServerInput): Promise<DesktopConfig> =>
    ipcRenderer.invoke('config:save-server', input),
  clearServer: (): Promise<DesktopConfig> => ipcRenderer.invoke('config:clear-server'),
  testServer: (input: SaveServerInput): Promise<ServerProbeResult> =>
    ipcRenderer.invoke('server:test', input),
  clearSession: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('auth:clear-session'),
  updateConfig: (patch: DesktopConfigPatch): Promise<DesktopConfig> =>
    ipcRenderer.invoke('config:update', patch),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:choose-directory'),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  showItemInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:show-item', path),

  platformCredentials: {
    list: (): Promise<PlatformCredentialState> => ipcRenderer.invoke('platform-cred:list'),
    save: (input: { platform: PlatformKey; cookie: string }): Promise<PlatformCredentialState> =>
      ipcRenderer.invoke('platform-cred:save', input),
    clear: (platform: PlatformKey): Promise<PlatformCredentialState> =>
      ipcRenderer.invoke('platform-cred:clear', platform),
    clearAll: (): Promise<PlatformCredentialState> => ipcRenderer.invoke('platform-cred:clear-all'),
  },

  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: boolean): void => callback(value);
      ipcRenderer.on('window:maximized', listener);
      return () => {
        ipcRenderer.removeListener('window:maximized', listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('sakura', api);
