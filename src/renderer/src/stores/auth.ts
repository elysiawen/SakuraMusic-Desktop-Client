import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { DesktopConfig } from '@shared/ipc';
import { apiRequest } from '@/api/client';
import type { AuthMeResponse, SakuraUser, UserStats } from '@/api/types';

/**
 * 账户状态。
 *
 * 初始化顺序：读主进程配置 → 有服务器就请求 `/api/auth/me`。
 * 网关在未登录时对 `/me` 返回 200 + `user: null`，所以这里不需要把 401 当探针。
 */
export const useAuthStore = defineStore('auth', () => {
  const config = ref<DesktopConfig | null>(null);
  const user = ref<SakuraUser | null>(null);
  const stats = ref<UserStats | null>(null);
  const ready = ref(false);
  const busy = ref(false);
  const errorMessage = ref('');

  let initPromise: Promise<void> | null = null;

  const hasServer = computed(() => Boolean(config.value?.baseUrl));
  const isAuthenticated = computed(() => Boolean(user.value));
  const isAdmin = computed(() => user.value?.role === 'admin');
  const serverLabel = computed(() => config.value?.baseUrl || '未配置服务器');

  async function loadMe(): Promise<void> {
    if (!config.value?.baseUrl) {
      user.value = null;
      stats.value = null;
      return;
    }
    const me = await apiRequest<AuthMeResponse>('/api/auth/me');
    user.value = me.user;
    stats.value = me.stats;
  }

  function initialize(): Promise<void> {
    if (ready.value) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        config.value = await window.sakura.getConfig();
        if (config.value.baseUrl) {
          try {
            await loadMe();
          } catch (error) {
            errorMessage.value = error instanceof Error ? error.message : '读取登录状态失败';
          }
        }
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '读取桌面配置失败';
      } finally {
        ready.value = true;
      }
    })();

    return initPromise;
  }

  async function saveServer(baseUrl: string, allowInvalidCert: boolean): Promise<void> {
    busy.value = true;
    errorMessage.value = '';
    try {
      config.value = await window.sakura.saveServer({ baseUrl, allowInvalidCert });
      user.value = null;
      stats.value = null;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '保存服务器地址失败';
      throw error;
    } finally {
      busy.value = false;
    }
  }

  async function changeServer(): Promise<void> {
    config.value = await window.sakura.clearServer();
    user.value = null;
    stats.value = null;
  }

  async function login(username: string, password: string): Promise<void> {
    busy.value = true;
    errorMessage.value = '';
    try {
      await apiRequest<{ user: SakuraUser }>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      await loadMe();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '登录失败';
      throw error;
    } finally {
      busy.value = false;
    }
  }

  async function register(username: string, password: string, nickname: string): Promise<void> {
    busy.value = true;
    errorMessage.value = '';
    try {
      await apiRequest<{ user: SakuraUser }>('/api/auth/register', {
        method: 'POST',
        body: { username, password, nickname: nickname || undefined },
      });
      await loadMe();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '注册失败';
      throw error;
    } finally {
      busy.value = false;
    }
  }

  /** 退出 / 改密 / 删号共用：清空内存里的身份，并让主进程丢掉本机会话。 */
  async function dropSession(): Promise<void> {
    user.value = null;
    stats.value = null;
    await window.sakura.clearSession().catch(() => undefined);
  }

  async function logout(): Promise<void> {
    busy.value = true;
    try {
      await apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    } catch {
      // 网络失败也要清掉本地登录态，否则界面会一直停在“已登录”。
    } finally {
      busy.value = false;
    }
    await dropSession();
  }

  /** 改昵称/头像。头像传 null 表示清空，回到渐变色首字母。 */
  async function updateProfile(input: { nickname?: string; avatar?: string | null }): Promise<void> {
    const result = await apiRequest<{ user: SakuraUser }>('/api/auth/profile', {
      method: 'PATCH',
      body: input,
    });
    user.value = result.user;
  }

  /** 改密码：服务端会吊销所有会话，本地跟着回登录页。 */
  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await apiRequest<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: { oldPassword, newPassword },
    });
    await dropSession();
  }

  /** 删号：密码是最后一道确认，成功后本地同样清空登录态。 */
  async function deleteAccount(password: string): Promise<void> {
    await apiRequest<{ ok: boolean }>('/api/auth/account', { method: 'DELETE', body: { password } });
    await dropSession();
  }

  async function refreshMe(): Promise<void> {
    await loadMe();
  }

  function markSignedOut(): void {
    user.value = null;
    stats.value = null;
  }

  function clearError(): void {
    errorMessage.value = '';
  }

  return {
    config,
    user,
    stats,
    ready,
    busy,
    errorMessage,
    hasServer,
    isAuthenticated,
    isAdmin,
    serverLabel,
    initialize,
    saveServer,
    changeServer,
    login,
    register,
    logout,
    updateProfile,
    changePassword,
    deleteAccount,
    refreshMe,
    markSignedOut,
    clearError,
  };
});
