<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ServerProbeResult } from '@shared/ipc';
import AppIcon from '@/components/common/AppIcon.vue';
import SakuraPetals from '@/components/common/SakuraPetals.vue';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';

const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();
const toast = useToast();

const baseUrl = ref('');
const allowInvalidCert = ref(false);
const testing = ref(false);
const saving = ref(false);
const result = ref<ServerProbeResult | null>(null);
const errorMessage = ref('');

const canContinue = computed(() => Boolean(baseUrl.value.trim()) && !testing.value && !saving.value);

onMounted(async () => {
  if (!auth.ready) await auth.initialize();
  baseUrl.value = auth.config?.baseUrl ?? '';
  allowInvalidCert.value = auth.config?.allowInvalidCert ?? false;
});

async function testConnection(): Promise<void> {
  testing.value = true;
  result.value = null;
  errorMessage.value = '';
  try {
    result.value = await window.sakura.testServer({
      baseUrl: baseUrl.value,
      allowInvalidCert: allowInvalidCert.value,
    });
    if (result.value.ok) {
      toast.success('服务器连接成功');
    } else if (result.value.code !== 'certificate') {
      errorMessage.value = result.value.error ?? '连接失败';
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '连接失败';
  } finally {
    testing.value = false;
  }
}

async function continueNext(): Promise<void> {
  if (!result.value?.ok) {
    await testConnection();
    if (!result.value?.ok) return;
  }

  saving.value = true;
  errorMessage.value = '';
  try {
    await auth.saveServer(baseUrl.value, allowInvalidCert.value);
    toast.success('服务器已保存');
    await router.replace({ name: 'login' });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存失败';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="onboarding">
    <SakuraPetals v-if="theme.petals" />

    <div class="layout">
      <section class="brand-panel">
        <div class="brand-lockup">
          <span class="logo">
            <AppIcon name="sparkles" :size="20" :stroke-width="2" />
          </span>
          <span class="brand-name">Sakura Music</span>
          <span class="brand-tag">桌面版</span>
        </div>

        <h1>两个平台，<br /><em>一个播放器。</em></h1>
        <p class="lede">
          网易云与 QQ 音乐聚合到一起。桌面端负责直连 CDN、系统媒体控制与本地缓存，
          你的服务器只做聚合与调度。
        </p>

        <ul class="feature-list">
          <li>
            <span class="feature-icon"><AppIcon name="search" :size="17" /></span>
            <div>
              <strong>聚合搜索</strong>
              <small>一次搜完两个平台，翻唱自动靠后，同曲自动去重。</small>
            </div>
          </li>
          <li>
            <span class="feature-icon"><AppIcon name="monitor" :size="17" /></span>
            <div>
              <strong>多设备遥控</strong>
              <small>SSE 实时同步，可以把桌面端当作主控台。</small>
            </div>
          </li>
          <li>
            <span class="feature-icon"><AppIcon name="users" :size="17" /></span>
            <div>
              <strong>一起听</strong>
              <small>双人房间、席位与会员共享，进度精确到同一秒。</small>
            </div>
          </li>
        </ul>

        <div class="brand-footer">
          <span>Electron 38</span>
          <span class="dot" />
          <span>Windows · macOS · Linux</span>
        </div>
      </section>

      <section class="setup-card glass-strong">
        <header class="card-head">
          <p class="eyebrow">开始之前</p>
          <h2>连接你的服务器</h2>
          <p>填写已运行的 Sakura Music 网关地址。地址会保存在本机，之后可在设置里修改。</p>
        </header>

        <form class="setup-form" @submit.prevent="continueNext">
          <div class="field">
            <label class="field-label" for="server-url">服务器地址</label>
            <input
              id="server-url"
              v-model="baseUrl"
              class="input"
              type="text"
              placeholder="http://192.168.1.10:8787"
              autocomplete="url"
              spellcheck="false"
              :disabled="saving"
            />
            <small class="hint">默认端口 8787；可以填域名、内网 IP 或带路径的反向代理地址。</small>
          </div>

          <label class="check-row">
            <input v-model="allowInvalidCert" type="checkbox" :disabled="saving" />
            <span>
              <strong>允许自签名证书</strong>
              <small>仅在你确认这是自己的服务器时开启。</small>
            </span>
          </label>

          <div class="actions">
            <button
              type="button"
              class="btn"
              :disabled="testing || saving || !baseUrl.trim()"
              @click="testConnection"
            >
              <AppIcon :name="testing ? 'refresh' : 'wifi'" :size="15" :class="{ spin: testing }" />
              {{ testing ? '连接中…' : '测试连接' }}
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!canContinue">
              <AppIcon v-if="!saving" name="arrow-right" :size="15" />
              <AppIcon v-else name="refresh" :size="15" class="spin" />
              {{ saving ? '保存中…' : '继续' }}
            </button>
          </div>
        </form>

        <div v-if="result?.ok" class="result success">
          <span class="result-icon"><AppIcon name="check" :size="17" /></span>
          <div>
            <strong>连接成功</strong>
            <p>网关已响应，可以继续登录。</p>
            <div class="upstreams">
              <span>
                <i class="dot" />
                网易云 {{ result.health?.upstreams.netease }}
              </span>
              <span>
                <i class="dot" />
                QQ 音乐 {{ result.health?.upstreams.qq }}
              </span>
            </div>
          </div>
        </div>

        <div v-else-if="result?.code === 'certificate'" class="result warning">
          <span class="result-icon"><AppIcon name="shield" :size="17" /></span>
          <div>
            <strong>证书不受信任</strong>
            <p>确认这是你自己的服务器后，勾选「允许自签名证书」并重新测试。</p>
            <dl v-if="result.certificate" class="cert">
              <div>
                <dt>主题</dt>
                <dd>{{ result.certificate.subject }}</dd>
              </div>
              <div>
                <dt>颁发者</dt>
                <dd>{{ result.certificate.issuer }}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd class="fingerprint">{{ result.certificate.fingerprint256 }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div v-else-if="errorMessage" class="result error">
          <span class="result-icon"><AppIcon name="alert" :size="17" /></span>
          <div>
            <strong>连接失败</strong>
            <p>{{ errorMessage }}</p>
          </div>
        </div>

        <footer class="card-footer">
          <AppIcon name="lock" :size="13" />
          <span>登录态只保存在本机系统安全存储中，渲染进程拿不到令牌。</span>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.onboarding {
  position: relative;
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding: 44px;
}

.layout {
  position: relative;
  z-index: 1;
  display: grid;
  width: 100%;
  max-width: 1080px;
  grid-template-columns: minmax(0, 1fr) 460px;
  gap: 64px;
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
  letter-spacing: -0.01em;
}

.brand-tag {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

/* 里程碑小标签已去掉，原来靠它撑开的那段留白挪到标题上。 */
.brand-panel h1 {
  margin-top: 40px;
  font-size: clamp(36px, 4.6vw, 54px);
  font-weight: 850;
  letter-spacing: -0.04em;
  line-height: 1.08;
}

.brand-panel h1 em {
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-style: normal;
}

.lede {
  max-width: 460px;
  margin-top: 18px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.8;
}

.feature-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 34px 0 0;
  padding: 0;
  list-style: none;
}

.feature-list li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.feature-icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  color: var(--accent);
}

.feature-list strong {
  display: block;
  font-size: 13px;
  font-weight: 700;
}

.feature-list small {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.brand-footer {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 48px;
  color: var(--text-faint);
  font-size: 10px;
}

.dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
}

.setup-card {
  padding: 28px;
  border-radius: var(--radius-xl);
}

.card-head h2 {
  margin-top: 4px;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.card-head p:last-child {
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.setup-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 24px;
}

.hint {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
}

.check-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  cursor: pointer;
}

.check-row input {
  width: 16px;
  height: 16px;
  margin-top: 2px;
  accent-color: var(--accent);
}

.check-row strong {
  display: block;
  font-size: 12px;
  font-weight: 700;
}

.check-row small {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
}

.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.result {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  margin-top: 18px;
  padding: 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.result-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border-radius: 8px;
}

.result strong {
  display: block;
  font-size: 12px;
  font-weight: 750;
}

.result p {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.result.success .result-icon {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
}

.result.warning .result-icon {
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
}

.result.error .result-icon {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}

.upstreams {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 8px;
  color: var(--text-faint);
  font-size: 10px;
}

.upstreams span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.upstreams .dot {
  background: var(--success);
}

.cert {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 10px 0 0;
}

.cert div {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr);
  gap: 8px;
}

.cert dt {
  color: var(--text-faint);
  font-size: 10px;
}

.cert dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 22px;
  padding-top: 15px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.5;
}

@media (max-width: 980px) {
  .layout {
    grid-template-columns: 1fr;
    max-width: 520px;
  }

  .brand-panel {
    display: none;
  }
}
</style>
