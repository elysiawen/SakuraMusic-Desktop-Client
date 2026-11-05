<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { credentialApi } from '@/api/library';
import type { AccountProfile, BindStatus, Platform, QqLoginType } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { cachedImage } from '@/utils/cacheImage';
import { platformName } from '@/utils/format';

const props = defineProps<{ platform: Platform }>();
const emit = defineEmits<{ close: []; bound: [mode: 'server' | 'local'] }>();

const toast = useToast();

type Step = 'loading' | 'scan' | 'choose' | 'saving';

const POLL_INTERVAL_MS = 2000;
const QQ_TYPES: Array<{ id: QqLoginType; label: string }> = [
  { id: 'qq', label: '手机 QQ' },
  { id: 'wx', label: '微信' },
  { id: 'mobile', label: 'QQ 音乐' },
];

const step = ref<Step>('loading');
const qrImage = ref('');
const identifier = ref('');
const loginType = ref<QqLoginType>('qq');
const status = ref<BindStatus>('waiting');
const message = ref('');
const ticket = ref('');
const profile = ref<AccountProfile | null>(null);
const savingMode = ref<'server' | 'local' | null>(null);

let timer: number | undefined;
let alive = true;

const isQq = computed(() => props.platform === 'qq');

const statusText = computed(() => {
  switch (status.value) {
    case 'scanned':
      return '已扫码，请在手机上确认登录';
    case 'expired':
      return '二维码已过期，换一张再试';
    case 'refused':
      return '你取消了这次登录';
    case 'error':
      return message.value || '扫码失败，请重试';
    default:
      return step.value === 'loading' ? '正在获取二维码…' : '用手机扫码登录';
  }
});

const failed = computed(
  () => status.value === 'expired' || status.value === 'refused' || status.value === 'error',
);

function stopPolling(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
}

function schedulePoll(): void {
  stopPolling();
  timer = window.setTimeout(() => {
    void poll();
  }, POLL_INTERVAL_MS);
}

async function releaseSession(): Promise<void> {
  const current = identifier.value;
  if (!current) return;
  identifier.value = '';
  const type: string = isQq.value ? loginType.value : 'pc';
  await credentialApi.releaseBind(type, current).catch(() => undefined);
}

async function poll(): Promise<void> {
  if (!alive || !identifier.value) return;

  try {
    const result = await credentialApi.pollBind(
      props.platform,
      identifier.value,
      isQq.value ? loginType.value : undefined,
    );
    if (!alive) return;

    status.value = result.status;
    message.value = result.message ?? '';

    if (result.status === 'success' && result.ticket) {
      ticket.value = result.ticket;
      profile.value = result.profile ?? null;
      step.value = 'choose';
      return;
    }
    if (result.status === 'expired' || result.status === 'refused' || result.status === 'error') {
      return;
    }
    schedulePoll();
  } catch (caught) {
    if (!alive) return;
    status.value = 'error';
    message.value = caught instanceof Error ? caught.message : '轮询扫码状态失败';
  }
}

async function start(): Promise<void> {
  await releaseSession();
  stopPolling();

  step.value = 'loading';
  status.value = 'waiting';
  message.value = '';
  ticket.value = '';
  profile.value = null;
  qrImage.value = '';

  try {
    const result = await credentialApi.startBind(
      props.platform,
      isQq.value ? loginType.value : undefined,
    );
    if (!alive) return;
    qrImage.value = result.qrImage;
    identifier.value = result.identifier;
    loginType.value = result.loginType === 'pc' ? 'qq' : result.loginType;
    step.value = 'scan';
    schedulePoll();
  } catch (caught) {
    if (!alive) return;
    status.value = 'error';
    message.value = caught instanceof Error ? caught.message : '二维码获取失败';
  }
}

function switchType(next: QqLoginType): void {
  if (next === loginType.value) return;
  loginType.value = next;
  void start();
}

async function commit(mode: 'server' | 'local'): Promise<void> {
  if (!ticket.value) return;
  savingMode.value = mode;
  step.value = 'saving';

  try {
    const result = await credentialApi.commitBind(ticket.value, mode);

    /*
     * 「仅本机」时凭据只回给前端这一次，必须立刻交给主进程保险库：
     * 之后由主进程在转发网关请求时注入，渲染进程不再持有它。
     */
    if (mode === 'local' && result.credential?.cookie) {
      await window.sakura.platformCredentials.save({
        platform: props.platform,
        cookie: result.credential.cookie,
      });
    }

    toast.success(mode === 'server' ? '凭据已加密保存到服务器' : '凭据只留在本机，服务器不留痕');
    emit('bound', result.mode);
    emit('close');
  } catch (caught) {
    const text = caught instanceof Error ? caught.message : '保存绑定失败';
    toast.error(text);
    step.value = 'choose';
    savingMode.value = null;
  }
}

function close(): void {
  void releaseSession();
  stopPolling();
  emit('close');
}

onMounted(() => {
  void start();
});

onBeforeUnmount(() => {
  alive = false;
  stopPolling();
  void releaseSession();
});
</script>

<template>
  <div class="overlay" @click.self="close">
    <div class="dialog glass-strong" role="dialog" aria-modal="true" :aria-label="`绑定${platformName(platform)}`">
      <header class="dialog-head">
        <div>
          <p class="eyebrow">扫码绑定</p>
          <h2>{{ platformName(platform) }}</h2>
        </div>
        <button type="button" class="btn-icon" aria-label="关闭" @click="close">
          <AppIcon name="close" :size="15" />
        </button>
      </header>

      <div v-if="isQq && step !== 'choose'" class="type-row">
        <button
          v-for="item in QQ_TYPES"
          :key="item.id"
          type="button"
          class="type-button"
          :class="{ active: loginType === item.id }"
          @click="switchType(item.id)"
        >
          {{ item.label }}
        </button>
      </div>

      <template v-if="step === 'loading' || step === 'scan'">
        <div class="qr-frame">
          <span v-if="step === 'loading'" class="spinner" />
          <img v-else-if="qrImage" :src="qrImage" alt="登录二维码" />
        </div>

        <p class="status" :class="{ warn: failed }">{{ statusText }}</p>

        <button v-if="failed" type="button" class="refresh" @click="start">
          <AppIcon name="refresh" :size="13" />
          换一张二维码
        </button>
        <p v-else class="hint">二维码有效期约两分钟；绑定只用于读取该账号的歌单与收藏。</p>
      </template>

      <template v-else-if="step === 'choose'">
        <div class="profile">
          <span class="avatar">
            <img v-if="profile?.avatar" :src="cachedImage(profile.avatar)" alt="" />
            <AppIcon v-else name="users" :size="20" />
          </span>
          <div>
            <strong>{{ profile?.nickname ?? '已登录' }}</strong>
            <small>扫码成功，选择凭据保存位置</small>
          </div>
        </div>

        <div class="mode-list">
          <button type="button" class="mode-card" @click="commit('server')">
            <span class="mode-icon"><AppIcon name="server" :size="16" /></span>
            <span class="mode-copy">
              <strong>保存到服务器</strong>
              <small>加密存库，换设备也能直接用；多人共用一个服务器时各自独立。</small>
            </span>
          </button>

          <button type="button" class="mode-card" @click="commit('local')">
            <span class="mode-icon"><AppIcon name="lock" :size="16" /></span>
            <span class="mode-copy">
              <strong>仅本机</strong>
              <small>凭据只在主进程内存里，服务器不留痕；关闭客户端后需要重新扫码。</small>
            </span>
          </button>
        </div>
      </template>

      <div v-else class="saving">
        <span class="spinner" />
        <p>正在保存凭据…</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(6px);
}

.dialog {
  display: flex;
  width: min(380px, 100%);
  max-height: calc(100vh - 80px);
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  overflow-y: auto;
  border-radius: var(--radius-xl);
  animation: fade-up var(--dur) var(--ease);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dialog-head h2 {
  margin-top: 3px;
  font-size: 16px;
  font-weight: 750;
}

.type-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.type-button {
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.type-button:hover {
  color: var(--text-muted);
}

.type-button.active {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.qr-frame {
  display: grid;
  width: 188px;
  height: 188px;
  margin: 0 auto;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: #fff;
  overflow: hidden;
}

.qr-frame img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.status {
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.status.warn {
  color: #e0453a;
}

.hint {
  text-align: center;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.6;
}

.refresh {
  display: inline-flex;
  align-self: center;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  font-size: 11px;
}

.refresh:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.profile {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.avatar {
  display: grid;
  width: 42px;
  height: 42px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-hover);
  color: var(--text-faint);
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile strong {
  display: block;
  font-size: 13px;
  font-weight: 700;
}

.profile small {
  color: var(--text-faint);
  font-size: 10px;
}

.mode-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mode-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  text-align: left;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}

.mode-card:hover {
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
  background: var(--accent-soft);
}

.mode-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  color: var(--accent);
}

.mode-copy strong {
  display: block;
  font-size: 12px;
  font-weight: 700;
}

.mode-copy small {
  display: block;
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.6;
}

.saving {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 0;
  color: var(--text-muted);
  font-size: 12px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
