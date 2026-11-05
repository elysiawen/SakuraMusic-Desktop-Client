/**
 * 主进程与渲染进程之间的契约。
 *
 * 这里只放「跨进程传输」的类型，不放业务实体：业务实体在 renderer/api/types.ts。
 */

export interface DesktopConfig {
  /** 网关根地址，形如 `http://127.0.0.1:8787`；首次启动为空。 */
  baseUrl: string;
  /** 允许不受信任的 TLS 证书（自签名）。按服务器显式开启。 */
  allowInvalidCert: boolean;
  /** 本机设备标识，持久化后不变。 */
  deviceId: string;
  /** 设备展示名，默认「主机名 · 平台」。 */
  deviceName: string;
  /** 关闭主窗口时是否收进托盘（M6 接入托盘后生效）。 */
  closeToTray: boolean;
  /** 音频缓存上限（MB）。 */
  cacheLimitMb: number;
  /** 离线下载目录。 */
  downloadDir: string;
}

export interface HealthPayload {
  ok: boolean;
  time: string;
  upstreams: {
    netease: string;
    qq: string;
  };
}

export interface ServerCertificateInfo {
  subject: string;
  issuer: string;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
}

export type ProbeErrorCode =
  | 'invalid_url'
  | 'network'
  | 'certificate'
  | 'timeout'
  | 'http'
  | 'not_sakura';

export interface ServerProbeResult {
  ok: boolean;
  baseUrl?: string;
  status?: number;
  health?: HealthPayload;
  error?: string;
  code?: ProbeErrorCode;
  certificate?: ServerCertificateInfo;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  node: string;
}

export interface SaveServerInput {
  baseUrl: string;
  allowInvalidCert: boolean;
}

/** 桌面偏好的可改字段；服务器地址走 `saveServer`，不在这里。 */
export interface DesktopConfigPatch {
  deviceName?: string;
  closeToTray?: boolean;
  cacheLimitMb?: number;
  downloadDir?: string;
}

/** 「仅本机」平台凭据：由主进程加密保存，并在转发网关请求时注入。 */
export type PlatformKey = 'netease' | 'qq';

export interface PlatformCredentialState {
  /** 本机存着凭据的平台；空数组表示都用服务器上的。 */
  platforms: PlatformKey[];
}

export interface PlatformCredentialApi {
  list: () => Promise<PlatformCredentialState>;
  save: (input: { platform: PlatformKey; cookie: string }) => Promise<PlatformCredentialState>;
  clear: (platform: PlatformKey) => Promise<PlatformCredentialState>;
  clearAll: () => Promise<PlatformCredentialState>;
}

export interface WindowControlsApi {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /** 返回取消订阅函数。 */
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
}

export interface DesktopApi {
  /** `darwin` / `win32` / `linux`，用于标题栏与快捷键差异。 */
  platform: string;
  getConfig: () => Promise<DesktopConfig>;
  saveServer: (input: SaveServerInput) => Promise<DesktopConfig>;
  clearServer: () => Promise<DesktopConfig>;
  testServer: (input: SaveServerInput) => Promise<ServerProbeResult>;
  clearSession: () => Promise<{ ok: boolean }>;
  updateConfig: (patch: DesktopConfigPatch) => Promise<DesktopConfig>;
  chooseDirectory: () => Promise<string | null>;
  getAppInfo: () => Promise<AppInfo>;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;
  platformCredentials: PlatformCredentialApi;
  windowControls: WindowControlsApi;
}
