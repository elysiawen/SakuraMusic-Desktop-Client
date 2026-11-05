<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import ToastHost from '@/components/common/ToastHost.vue';
import { useDesktopLyricSync } from '@/composables/useDesktopLyricSync';
import { useTaskbarPreview } from '@/composables/useTaskbarPreview';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

// 桌面歌词窗口的播放状态来源：只挂 watchers，随应用生命周期存在。
useDesktopLyricSync();
// Windows 任务栏缩略图预览：卡片素材与缩略图按钮命令，非 Windows 内部直接返回。
useTaskbarPreview();

/**
 * 会话过期统一在 API 客户端里派发事件，这里只负责收尾：
 * 清掉用户态并跳登录，避免每个页面各写一遍。
 */
function onAuthExpired(): void {
  auth.markSignedOut();
  const current = router.currentRoute.value;
  if (current.name !== 'login') {
    void router.replace({ name: 'login', query: { redirect: current.fullPath } });
  }
}

onMounted(() => window.addEventListener('sakura:auth-expired', onAuthExpired));
onBeforeUnmount(() => window.removeEventListener('sakura:auth-expired', onAuthExpired));
</script>

<template>
  <RouterView />
  <ToastHost />
</template>
