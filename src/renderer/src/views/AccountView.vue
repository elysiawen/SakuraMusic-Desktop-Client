<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import BindDialog from '@/components/library/BindDialog.vue';
import type { Platform } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useLibraryStore } from '@/stores/library';
import { platformName } from '@/utils/format';

/**
 * 账户中心：只放「身份」相关的东西——Sakura 账号资料、第三方音乐账号、密码与删号。
 * 外观、音质、快捷键这类偏好留在「设置」，两边互不重叠（与 web 端同一套划分）。
 */
const auth = useAuthStore();
const library = useLibraryStore();
const toast = useToast();
const router = useRouter();

const PLATFORMS: Platform[] = ['netease', 'qq'];

const nickname = ref('');
const avatarUrl = ref('');
const savingProfile = ref(false);

const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const savingPassword = ref(false);

const deletePassword = ref('');
const deleting = ref(false);

const bindTarget = ref<Platform | null>(null);
const refreshing = ref<Platform | null>(null);

const displayName = computed(() => auth.user?.nickname || auth.user?.username || '未登录');
const initial = computed(() => displayName.value.trim().slice(0, 1).toUpperCase() || 'S');
const boundCount = computed(() => PLATFORMS.filter((platform) => library.isBound(platform)).length);

function credentialOf(platform: Platform) {
  return library.credentialFor(platform);
}

function resetProfileDraft(): void {
  nickname.value = auth.user?.nickname ?? '';
  avatarUrl.value = auth.user?.avatar ?? '';
}

onMounted(async () => {
  resetProfileDraft();
  await Promise.all([library.loadCredentials(), library.loadLocalBound()]).catch(() => undefined);
});

async function saveProfile(): Promise<void> {
  savingProfile.value = true;
  try {
    await auth.updateProfile({
      nickname: nickname.value.trim() || undefined,
      avatar: avatarUrl.value.trim() ? avatarUrl.value.trim() : null,
    });
    resetProfileDraft();
    toast.success('资料已更新');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingProfile.value = false;
  }
}

async function changePassword(): Promise<void> {
  if (newPassword.value !== confirmPassword.value) {
    toast.error('两次输入的新密码不一致');
    return;
  }
  savingPassword.value = true;
  try {
    await auth.changePassword(oldPassword.value, newPassword.value);
    toast.success('密码已更新，请重新登录');
    await router.replace({ name: 'login' });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '修改失败');
  } finally {
    savingPassword.value = false;
  }
}

async function deleteAccount(): Promise<void> {
  if (!deletePassword.value) return;
  deleting.value = true;
  try {
    await auth.deleteAccount(deletePassword.value);
    toast.success('账户已删除');
    await router.replace({ name: 'login' });
  } catch (error) {
    // 密码错了就留在原地，让用户重输。
    toast.error(error instanceof Error ? error.message : '删除失败');
  } finally {
    deleting.value = false;
  }
}

async function refresh(platform: Platform): Promise<void> {
  refreshing.value = platform;
  try {
    await library.refreshCredential(platform);
    toast.success(`${platformName(platform)}凭据已刷新`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '刷新失败');
  } finally {
    refreshing.value = null;
  }
}

async function unbind(platform: Platform): Promise<void> {
  try {
    await library.unbind(platform);
    toast.info(`已解绑${platformName(platform)}`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '解绑失败');
  }
}

async function onBound(mode: 'server' | 'local'): Promise<void> {
  const platform = bindTarget.value;
  bindTarget.value = null;
  if (!platform) return;
  await Promise.all([library.loadCredentials(), library.loadLocalBound()]).catch(() => undefined);
  toast.success(`${platformName(platform)}已绑定（${mode === 'server' ? '服务器' : '仅本机'}）`);
}

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <div class="account-view">
    <header class="head">
      <div>
        <p class="eyebrow">账户中心</p>
        <h1>账号与绑定</h1>
        <p class="head-desc">
          Sakura 账号资料、第三方音乐账号与安全设置；外观、音质这类偏好仍在「设置」里。
        </p>
      </div>
      <span class="chip">{{ auth.serverLabel }}</span>
    </header>

    <!-- 账号资料 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="user" :size="14" /></span>
          <div>
            <h2>账号资料</h2>
            <p>昵称和头像会显示在一起听、设备列表与歌单创建者上。</p>
          </div>
        </div>
      </header>

      <div class="panel">
        <div class="profile">
          <span class="avatar">
            <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
            <template v-else>{{ initial }}</template>
          </span>

          <div class="identity">
            <strong>{{ displayName }}</strong>
            <span class="username">@{{ auth.user?.username ?? '—' }}</span>
            <span v-if="auth.stats" class="stats">
              <span><b>{{ auth.stats.favorites }}</b> 收藏</span>
              <span><b>{{ auth.stats.playlists }}</b> 歌单</span>
              <span><b>{{ auth.stats.history }}</b> 历史</span>
            </span>
          </div>

          <button type="button" class="mini" :disabled="auth.busy" @click="logout">
            <AppIcon name="logout" :size="12" />
            退出登录
          </button>
        </div>

        <div class="form-grid">
          <label class="field">
            <span class="field-label">用户名（不可修改）</span>
            <input class="text-input" :value="auth.user?.username ?? ''" disabled />
          </label>

          <label class="field">
            <span class="field-label">昵称</span>
            <input v-model="nickname" class="text-input" maxlength="32" placeholder="展示用的名字" />
          </label>

          <label class="field span-2">
            <span class="field-label">头像图片地址</span>
            <input v-model="avatarUrl" class="text-input" placeholder="https://...（留空使用渐变头像）" spellcheck="false" />
          </label>
        </div>

        <div class="panel-foot">
          <span class="foot-note">头像留空时使用渐变底色 + 昵称首字</span>
          <button type="button" class="mini primary" :disabled="savingProfile" @click="saveProfile">
            <AppIcon name="check" :size="12" />
            {{ savingProfile ? '保存中…' : '保存资料' }}
          </button>
        </div>
      </div>
    </section>

    <!-- 第三方音乐账号 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="link" :size="14" /></span>
          <div>
            <h2>第三方音乐账号</h2>
            <p>扫码后选择凭据保存在服务器还是仅本机；仅本机的凭据不会离开这台设备。</p>
          </div>
        </div>
        <span class="faint">已绑定 {{ boundCount }} / {{ PLATFORMS.length }}</span>
      </header>

      <div class="panel">
        <article v-for="platform in PLATFORMS" :key="platform" class="platform">
          <span class="platform-avatar">
            <img
              v-if="credentialOf(platform)?.profile?.avatar"
              :src="credentialOf(platform)?.profile?.avatar"
              alt=""
            />
            <AppIcon v-else :name="platform === 'netease' ? 'music' : 'disc'" :size="19" />
          </span>

          <div class="row-copy">
            <strong>{{ platformName(platform) }}</strong>
            <small v-if="library.isLocalOnly(platform)">已绑定 · 仅本机凭据</small>
            <small v-else-if="credentialOf(platform)">
              {{ credentialOf(platform)?.profile?.nickname || '已绑定' }}
              <template v-if="credentialOf(platform)?.profile?.vip"> · 会员</template>
            </small>
            <small v-else>未绑定 · 绑定后可读取平台歌单与收藏</small>
          </div>

          <div class="platform-actions">
            <template v-if="library.isBound(platform)">
              <button
                type="button"
                class="mini"
                :disabled="refreshing === platform"
                @click="refresh(platform)"
              >
                <AppIcon name="refresh" :size="12" :class="{ spin: refreshing === platform }" />
                刷新
              </button>
              <button type="button" class="mini danger" @click="unbind(platform)">解绑</button>
            </template>
            <button v-else type="button" class="mini primary" @click="bindTarget = platform">
              <AppIcon name="qr" :size="12" />
              扫码绑定
            </button>
          </div>
        </article>
      </div>
    </section>

    <!-- 修改密码 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="lock" :size="14" /></span>
          <div>
            <h2>修改密码</h2>
            <p>改完所有设备都要重新登录。</p>
          </div>
        </div>
      </header>

      <div class="panel">
        <div class="form-grid three">
          <label class="field">
            <span class="field-label">当前密码</span>
            <input
              v-model="oldPassword"
              class="text-input"
              type="password"
              autocomplete="current-password"
            />
          </label>
          <label class="field">
            <span class="field-label">新密码</span>
            <input
              v-model="newPassword"
              class="text-input"
              type="password"
              autocomplete="new-password"
            />
          </label>
          <label class="field">
            <span class="field-label">确认新密码</span>
            <input
              v-model="confirmPassword"
              class="text-input"
              type="password"
              autocomplete="new-password"
            />
          </label>
        </div>

        <div class="panel-foot">
          <span class="foot-note">修改后需要用新密码重新登录所有设备</span>
          <button
            type="button"
            class="mini primary"
            :disabled="savingPassword || !oldPassword || !newPassword"
            @click="changePassword"
          >
            {{ savingPassword ? '提交中…' : '修改密码' }}
          </button>
        </div>
      </div>
    </section>

    <!-- 危险操作 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon is-danger"><AppIcon name="alert" :size="14" /></span>
          <div>
            <h2>危险操作</h2>
            <p>不可恢复，请确认后再继续。</p>
          </div>
        </div>
      </header>

      <div class="panel is-danger">
        <div class="row">
          <div class="row-copy">
            <strong>删除账户</strong>
            <small>
              会永久清除歌单、收藏、播放历史、第三方账号绑定与一起听记录，需要输入密码确认。
            </small>
          </div>
          <div class="inline">
            <input
              v-model="deletePassword"
              class="text-input"
              type="password"
              placeholder="登录密码"
              autocomplete="current-password"
              @keyup.enter="deleteAccount"
            />
            <button
              type="button"
              class="mini danger"
              :disabled="deleting || !deletePassword"
              @click="deleteAccount"
            >
              {{ deleting ? '删除中…' : '删除账户' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <BindDialog v-if="bindTarget" :platform="bindTarget" @close="bindTarget = null" @bound="onBound" />
  </div>
</template>

<style scoped>
.account-view {
  display: flex;
  max-width: 940px;
  margin: 0 auto;
  flex-direction: column;
  gap: 22px;
  animation: fade-up var(--dur-slow) var(--ease);
}

/* ---------------- 顶部 ---------------- */

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  padding: 24px 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(
      520px 220px at 6% 0%,
      color-mix(in srgb, var(--accent) 18%, transparent),
      transparent 72%
    ),
    linear-gradient(135deg, var(--surface-strong), color-mix(in srgb, var(--surface) 40%, transparent));
  box-shadow: var(--shadow-sm);
}

.head h1 {
  margin-top: 4px;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.head-desc {
  max-width: 560px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

/* ---------------- 分组：标题在外，卡片只装内容 ---------------- */

.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  padding: 0 4px;
}

.section-title {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.section-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  color: var(--text-muted);
}

.section-icon.is-danger {
  border-color: color-mix(in srgb, #e0453a 30%, var(--border));
  color: #e0453a;
}

.section-head h2 {
  font-size: 15px;
  font-weight: 750;
  letter-spacing: -0.01em;
}

.section-head p {
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.6;
}

.panel {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 46%, transparent);
  box-shadow: var(--shadow-sm);
}

.panel.is-danger {
  border-color: color-mix(in srgb, #e0453a 28%, var(--border));
  background: color-mix(in srgb, #e0453a 3%, transparent);
}

.faint {
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 500;
}

/* ---------------- 账号资料 ---------------- */

.profile {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px;
}

.avatar {
  display: grid;
  width: 64px;
  height: 64px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border-radius: 20px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast);
  font-size: 24px;
  font-weight: 800;
  box-shadow: 0 14px 28px -18px color-mix(in srgb, var(--accent) 90%, transparent);
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.identity {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.identity > strong {
  overflow: hidden;
  font-size: 15px;
  font-weight: 750;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.username {
  color: var(--text-faint);
  font-size: 11px;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}

.stats span {
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 9.5px;
  font-weight: 600;
}

.stats b {
  color: var(--text-muted);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* ---------------- 表单 ---------------- */

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 16px;
  padding: 4px 18px 18px;
}

.form-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.field.span-2 {
  grid-column: 1 / -1;
}

.field-label {
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 650;
}

.text-input {
  width: 100%;
  height: 32px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
  transition: border-color var(--dur) var(--ease);
}

.text-input:focus {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.text-input:disabled {
  color: var(--text-faint);
  background: color-mix(in srgb, var(--surface-hover) 60%, transparent);
}

.panel-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  background: color-mix(in srgb, var(--surface) 30%, transparent);
}

.foot-note {
  color: var(--text-faint);
  font-size: 10px;
}

/* ---------------- 第三方账号 ---------------- */

.platform {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  transition: background var(--dur) var(--ease);
}

.platform + .platform {
  border-top: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
}

.platform:hover {
  background: color-mix(in srgb, var(--surface) 34%, transparent);
}

.platform-avatar {
  display: grid;
  width: 42px;
  height: 42px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface-hover);
  color: var(--text-muted);
}

.platform-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.row-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.row-copy strong {
  font-size: 12.5px;
  font-weight: 700;
}

.row-copy small {
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.6;
}

.platform-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

/* ---------------- 危险操作 ---------------- */

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
}

.inline {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
}

.inline .text-input {
  width: 190px;
}

/* ---------------- 按钮 ---------------- */

.mini {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 4px;
  padding: 0 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.mini:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini:disabled {
  opacity: 0.55;
  cursor: default;
}

.mini.primary {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.mini.primary:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  color: var(--accent);
}

.mini.danger {
  border-color: color-mix(in srgb, #e0453a 26%, var(--border));
  color: #e0453a;
}

.mini.danger:hover:not(:disabled) {
  border-color: color-mix(in srgb, #e0453a 50%, transparent);
  color: #e0453a;
}

/* ---------------- 窄窗口 ---------------- */

@media (max-width: 760px) {
  .form-grid,
  .form-grid.three {
    grid-template-columns: minmax(0, 1fr);
  }

  .profile {
    flex-wrap: wrap;
  }

  .identity {
    flex-basis: 100%;
    order: 3;
  }

  .inline {
    width: 100%;
  }

  .inline .text-input {
    flex: 1;
    width: auto;
  }
}
</style>
