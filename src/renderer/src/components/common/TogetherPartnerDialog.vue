<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { roomApi, type TogetherPartnerDetail } from '@/api/rooms';
import AppIcon from '@/components/common/AppIcon.vue';
import { cachedImage } from '@/utils/cacheImage';
import { avatarGradient, formatSessionTime, formatTogetherDuration } from '@/utils/format';

/**
 * 「和某位好友的一起听记录」弹窗：每次一起听的日期与时长。
 *
 * 由账户中心点伙伴那一行打开。明细可能不可用（服务端那张表可以随时被删），
 * 这时要说清「只有累计可用」，而不是显示成"一次都没听过"。
 */
const props = defineProps<{
  visible: boolean;
  partnerId: string | null;
  /** 兜底标题：明细还没回来时先用列表里的昵称。 */
  partnerName: string;
}>();

const emit = defineEmits<{ (event: 'close'): void }>();

const detail = ref<TogetherPartnerDetail | null>(null);
const loading = ref(false);
const error = ref('');

watch(
  () => [props.visible, props.partnerId] as const,
  async ([visible, partnerId]) => {
    if (!visible || !partnerId) return;
    loading.value = true;
    error.value = '';
    detail.value = null;
    try {
      detail.value = await roomApi.partnerDetail(partnerId);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '记录加载失败';
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/** 服务端最多返回 200 条：被截断时补一句说明，别让人以为只听过这么几次。 */
const truncated = computed(() => {
  const current = detail.value;
  if (!current?.sessions || current.sessionCount === null) return false;
  return current.sessions.length < current.sessionCount;
});

function onKeydown(event: KeyboardEvent): void {
  if (props.visible && event.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="overlay" @click.self="emit('close')">
      <div class="dialog glass-strong" role="dialog" aria-modal="true" aria-label="一起听记录">
        <header class="dialog-head">
          <div>
            <p class="eyebrow">一起听记录</p>
            <h2>{{ detail?.partner.nickname || partnerName }}</h2>
          </div>
          <button type="button" class="btn-icon" aria-label="关闭" @click="emit('close')">
            <AppIcon name="close" :size="15" />
          </button>
        </header>

        <p v-if="loading" class="hint">正在读取…</p>
        <p v-else-if="error" class="hint">{{ error }}</p>

        <template v-else-if="detail">
          <div class="partner">
            <span
              class="partner-avatar"
              :style="{ background: avatarGradient(detail.partner.nickname || detail.partner.userId) }"
            >
              <img v-if="detail.partner.avatar" :src="cachedImage(detail.partner.avatar)" alt="" />
              <template v-else>{{ (detail.partner.nickname || '友').slice(0, 1) }}</template>
            </span>
            <div class="partner-copy">
              <strong>{{ detail.partner.nickname }}</strong>
              <span>
                一起听过 {{ formatTogetherDuration(detail.totalSeconds) }}
                <template v-if="detail.sessionCount !== null"> · {{ detail.sessionCount }} 次</template>
              </span>
            </div>
          </div>

          <!-- 明细表被删掉的情况：说明清楚，不假装"没听过"。 -->
          <p v-if="detail.sessions === null" class="hint">
            这里只有累计时长可用：每一次的明细已经不再记录了。
          </p>
          <template v-else>
            <p v-if="detail.sessions.length === 0" class="hint">还没有一起听过的记录。</p>
            <ul v-else class="session-list">
              <li
                v-for="(item, index) in detail.sessions"
                :key="`${item.startedAt}-${index}`"
                class="session-row"
              >
                <span class="session-time">{{ formatSessionTime(item.startedAt) }}</span>
                <strong class="session-duration">{{ formatTogetherDuration(item.seconds) }}</strong>
              </li>
            </ul>
            <p v-if="truncated" class="session-more">仅显示最近 {{ detail.sessions.length }} 次</p>
          </template>
        </template>
      </div>
    </div>
  </Teleport>
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
  width: min(420px, 100%);
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border-radius: var(--radius-xl);
  animation: fade-up var(--dur) var(--ease);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dialog-head .eyebrow {
  margin: 0 0 2px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.dialog-head h2 {
  font-size: 17px;
  font-weight: 700;
}

.btn-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.btn-icon:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.hint {
  margin: 0;
  padding: 12px 0;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.7;
  text-align: center;
}

.partner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0 6px;
}

.partner-avatar {
  display: grid;
  width: 44px;
  height: 44px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border-radius: 14px;
  color: #fff;
  font-size: 17px;
  font-weight: 700;
}

.partner-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.partner-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.partner-copy strong {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.partner-copy span {
  color: var(--text-faint);
  font-size: 11px;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.session-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
}

.session-row:hover {
  background: var(--surface-hover);
}

.session-time {
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.session-duration {
  flex: none;
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.session-more {
  margin: 4px 0 0;
  color: var(--text-faint);
  font-size: 10.5px;
  text-align: center;
}
</style>
