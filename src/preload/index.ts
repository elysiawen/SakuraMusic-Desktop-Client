import { contextBridge, ipcRenderer } from 'electron';
import type { CacheKind, CacheStats } from '@shared/cache';
import type {
  AppInfo,
  DesktopApi,
  DesktopConfig,
  DesktopConfigPatch,
  DesktopLyricState,
  NowPlayingCommand,
  TaskbarPreviewCommand,
  TaskbarPreviewImage,
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

  cache: {
    stats: (): Promise<CacheStats> => ipcRenderer.invoke('cache:stats'),
    clear: (kind?: CacheKind): Promise<CacheStats> => ipcRenderer.invoke('cache:clear', kind),
    audioCheck: (key: string) =>
      ipcRenderer.invoke('cache:audio-check', key) as Promise<'full' | 'partial' | null>,
  },

  lyric: {
    pushState: (state: DesktopLyricState): void => {
      ipcRenderer.send('lyric:push', state);
    },
    getState: (): Promise<DesktopLyricState | null> => ipcRenderer.invoke('lyric:get-state'),
    onState: (callback: (state: DesktopLyricState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DesktopLyricState): void =>
        callback(state);
      ipcRenderer.on('lyric:state', listener);
      return () => {
        ipcRenderer.removeListener('lyric:state', listener);
      };
    },
    onPrefs: (callback: (config: DesktopConfig) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, config: DesktopConfig): void =>
        callback(config);
      ipcRenderer.on('lyric:prefs', listener);
      return () => {
        ipcRenderer.removeListener('lyric:prefs', listener);
      };
    },
  },

  nowPlaying: {
    open: (dark = false): Promise<void> => ipcRenderer.invoke('np:open', dark),
    isOpen: (): Promise<boolean> => ipcRenderer.invoke('np:is-open'),
    focus: (): Promise<void> => ipcRenderer.invoke('np:focus'),
    closeWindow: (): Promise<void> => ipcRenderer.invoke('np:close'),
    pushState: (state: unknown): void => {
      ipcRenderer.send('np:push', state);
    },
    getState: (): Promise<unknown> => ipcRenderer.invoke('np:get-state'),
    onState: (callback: (state: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown): void =>
        callback(state);
      ipcRenderer.on('np:state', listener);
      return () => {
        ipcRenderer.removeListener('np:state', listener);
      };
    },
    sendCommand: (command: NowPlayingCommand): void => {
      ipcRenderer.send('np:command', command);
    },
    onCommand: (callback: (command: NowPlayingCommand) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: NowPlayingCommand): void =>
        callback(command);
      ipcRenderer.on('np:command', listener);
      return () => {
        ipcRenderer.removeListener('np:command', listener);
      };
    },
    onOpenChange: (callback: (open: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open);
      ipcRenderer.on('np:open-change', listener);
      return () => {
        ipcRenderer.removeListener('np:open-change', listener);
      };
    },
  },

  taskbarPreview: {
    push: (image: TaskbarPreviewImage): void => {
      ipcRenderer.send('taskbar-preview:push', image);
    },
    onCommand: (callback: (command: TaskbarPreviewCommand) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        command: TaskbarPreviewCommand,
      ): void => callback(command);
      ipcRenderer.on('taskbar-preview:command', listener);
      return () => {
        ipcRenderer.removeListener('taskbar-preview:command', listener);
      };
    },
    ack: (line: string): void => {
      ipcRenderer.send('taskbar-preview:ack', line);
    },
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

  state: {
    load: (): Record<string, string> => {
      try {
        const value: unknown = ipcRenderer.sendSync('state:load');
        return value && typeof value === 'object'
          ? (value as Record<string, string>)
          : {};
      } catch {
        return {};
      }
    },
    save: (data: Record<string, string>): void => {
      try {
        ipcRenderer.sendSync('state:save', data);
      } catch {
        // 万一某个 Electron 版本的 sandbox preload 不开放同步 IPC，
        // 退化为单向发送；退出前那次就不保证送达了。
        ipcRenderer.send('state:save', data);
      }
    },
    saveSoon: (data: Record<string, string>): void => {
      ipcRenderer.send('state:save', data);
    },
  },
};

contextBridge.exposeInMainWorld('sakura', api);
