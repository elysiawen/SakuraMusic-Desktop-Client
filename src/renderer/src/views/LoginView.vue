<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import SakuraPetals from '@/components/common/SakuraPetals.vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';

type AuthTab = 'login' | 'register';

const auth = useAuthStore();
const theme = useThemeStore();
const route = useRoute();
const router = useRouter();

const tab = ref<AuthTab>('login');
const username = ref('');
const password = ref('');
const nickname = ref('');
const showPassword = ref(false);
const submitting = ref(false);
const errorMessage = ref('');

const canSubmit = computed(
  () => username.value.trim().length >= 3 && password.value.length >= 8 && !submitting.value,
);

const headline = computed(() => (tab.value === 'login' ? '欢迎回来。' : '从这里开始。'));
const lede = computed(() =>
  tab.value === 'login'
    ? '登录后即可读取你在服务器上的歌单、收藏与设备状态。'
    : '注册一个账号，把两个平台的音乐收进同一个地方。',
);

function switchTab(next: AuthTab): void {
  tab.value = next;
  errorMessage.value = '';
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorMessage.value = '';

  try {
    if (tab.value === 'login') {
      await auth.login(username.value.trim(), password.value);
    } else {
      await auth.register(username.value.trim(), password.value, nickname.value.trim());
    }

    const target =
      typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
        ? route.query.redirect
        : '/';
    await router.replace(target);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作失败，请稍后重试';
  } finally {
    submitting.value = false;
  }
}

async function changeServer(): Promise<void> {
  await auth.changeServer();
  await router.replace({ name: 'onboarding' });
}
</script>

<template>
  <div class="auth-page">
    <SakuraPetals v-if="theme.petals" />

    <div class="auth-layout">
      <section class="brand-panel">
        <div class="brand-lockup">
          <span class="logo">
            <AppIcon name="sparkles" :size="20" :stroke-width="2" />
          </span>
          <span class="brand-name">Sakura Music</span>
        </div>

        <h1>{{ headline }}</h1>
        <p class="lede">{{ lede }}</p>

        <div class="quote-card">
          <AppIcon name="music" :size="18" />
          <p>“两个平台，一个播放器。搜索、播放、遥控与一起听，都在这一扇窗里。”</p>
        </div>

        <div class="brand-footer">
          <AppIcon name="server" :size="13" />
          <span class="server-label" :title="auth.serverLabel">{{ auth.serverLabel }}</span>
          <button type="button" class="change-server" @click="changeServer">更换</button>
        </div>
      </section>

      <section class="auth-card glass-strong">
        <div class="tabs" role="tablist" aria-label="登录或注册">
          <button
            type="button"
            role="tab"
            class="tab"
            :class="{ active: tab === 'login' }"
            :aria-selected="tab === 'login'"
            @click="switchTab('login')"
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            class="tab"
            :class="{ active: tab === 'register' }"
            :aria-selected="tab === 'register'"
            @click="switchTab('register')"
          >
            注册
          </button>
        </div>

        <form class="auth-form" @submit.prevent="submit">
          <div class="field">
            <label class="field-label" for="username">用户名</label>
            <input
              id="username"
              v-model="username"
              class="input"
              type="text"
              autocomplete="username"
              placeholder="3–24 位字母或数字"
              spellcheck="false"
              :disabled="submitting"
            />
          </div>

          <div v-if="tab === 'register'" class="field">
            <label class="field-label" for="nickname">昵称 <span class="optional">可选</span></label>
            <input
              id="nickname"
              v-model="nickname"
              class="input"
              type="text"
              autocomplete="nickname"
              placeholder="显示在设备与一起听里"
              maxlength="24"
              :disabled="submitting"
            />
          </div>

          <div class="field">
            <label class="field-label" for="password">密码</label>
            <div class="password-wrap">
              <input
                id="password"
                v-model="password"
                class="input"
                :type="showPassword ? 'text' : 'password'"
                :autocomplete="tab === 'login' ? 'current-password' : 'new-password'"
                placeholder="至少 8 位"
                :disabled="submitting"
              />
              <button
                type="button"
                class="password-toggle"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                @click="showPassword = !showPassword"
              >
                <AppIcon :name="showPassword ? 'eye' : 'lock'" :size="15" />
              </button>
            </div>
          </div>

          <div v-if="errorMessage" class="form-error">
            <AppIcon name="alert" :size="15" />
            <span>{{ errorMessage }}</span>
          </div>

          <button type="submit" class="btn btn-primary submit" :disabled="!canSubmit">
            <AppIcon v-if="!submitting" :name="tab === 'login' ? 'arrow-right' : 'plus'" :size="15" />
            <AppIcon v-else name="refresh" :size="15" class="spin" />
            {{ submitting ? '请稍候…' : tab === 'login' ? '登录' : '创建账号' }}
          </button>
        </form>

        <p class="switch-hint">
          <template v-if="tab === 'login'">
            还没有账号？
            <button type="button" @click="switchTab('register')">注册一个</button>
          </template>
          <template v-else>
            已经有账号？
            <button type="button" @click="switchTab('login')">直接登录</button>
          </template>
        </p>

        <footer class="card-footer">
          <AppIcon name="lock" :size="13" />
          <span>密码只发送到你自己的服务器，不会经过第三方。</span>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  position: relative;
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding: 44px;
}

.auth-layout {
  position: relative;
  z-index: 1;
  display: grid;
  width: 100%;
  max-width: 1040px;
  grid-template-columns: minmax(0, 1fr) 430px;
  gap: 68px;
  align-items: center;
  animation: fade-up var(--dur-slow) var(--ease);
}

.brand-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.brand-lockup {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast);
  box-shadow: 0 12px 28px color-mix(in srgb, var(--accent) 30%, transparent);
}

.brand-name {
  font-size: 16px;
  font-weight: 800;
}

/* 里程碑小标签已去掉，原来靠它撑开的那段留白挪到标题上。 */
.brand-panel h1 {
  margin-top: 40px;
  font-size: clamp(38px, 4.8vw, 56px);
  font-weight: 850;
  letter-spacing: -0.04em;
  line-height: 1.06;
}

.lede {
  max-width: 420px;
  margin-top: 16px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.8;
}

.quote-card {
  display: flex;
  gap: 12px;
  max-width: 420px;
  margin-top: 38px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: color-mix(in srgb, var(--surface) 42%, transparent);
  color: var(--accent);
}

.quote-card p {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.brand-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 420px;
  margin-top: 40px;
  color: var(--text-faint);
  font-size: 10px;
}

.server-label {
  overflow: hidden;
  max-width: 260px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-server {
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
}

.change-server:hover {
  text-decoration: underline;
}

.auth-card {
  padding: 26px;
  border-radius: var(--radius-xl);
}

.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.tab {
  height: 34px;
  border-radius: 7px;
  color: var(--text-faint);
  font-size: 12px;
  font-weight: 700;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.tab.active {
  background: var(--surface-strong);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 22px;
}

.optional {
  color: var(--text-faint);
  font-weight: 500;
}

.password-wrap {
  position: relative;
}

.password-wrap .input {
  padding-right: 42px;
}

.password-toggle {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: var(--radius-xs);
  color: var(--text-faint);
}

.password-toggle:hover {
  background: var(--surface-hover);
  color: var(--text-muted);
}

.form-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
}

.submit {
  width: 100%;
  height: 42px;
  margin-top: 4px;
}

.switch-hint {
  margin-top: 16px;
  color: var(--text-faint);
  font-size: 11px;
  text-align: center;
}

.switch-hint button {
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}

.switch-hint button:hover {
  text-decoration: underline;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 10px;
}

@media (max-width: 960px) {
  .auth-layout {
    grid-template-columns: 1fr;
    max-width: 440px;
    gap: 28px;
  }

  .brand-panel {
    display: none;
  }
}
</style>
