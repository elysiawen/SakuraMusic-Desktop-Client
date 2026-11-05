/** 产品名与稳定标识：主进程、打包配置、窗口标题共用。 */
export const APP_NAME = 'Sakura Music';
export const APP_ID = 'com.sakura.music.desktop';

/** 开发模式下本地 BFF 的固定端口（Vite 代理要提前知道它）。 */
export const DEV_BFF_PORT = 3210;

/** 网关请求体上限，与网关自身的 2MB 保持一致。 */
export const MAX_API_BODY = 2 * 1024 * 1024;

export const PLATFORMS = ['netease', 'qq'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
};

export function isPlatform(value: unknown): value is Platform {
  return value === 'netease' || value === 'qq';
}
