<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import { useToast } from '@/composables/useToast';
// 品牌标识直接用应用图标（与安装包、任务栏图标同一份资源）。
import brandIcon from '../../../../../build/icon.png';

interface NavItem {
  name: string;
  label: string;
  icon: string;
  to?: string;
  badge?: string;
}

/**
 * 侧边栏只留「去哪听什么」的入口。
 *
 * 搜索页没有页内输入框了，搜索统一走顶栏，所以这里不再需要「搜索」；
 * 设备（遥控）挪到播放条上，和一起听一起放在「当前在放什么」的旁边。
 */
const navItems: NavItem[] = [
  { name: 'home', label: '发现', icon: 'home', to: '/' },
  { name: 'library', label: '音乐库', icon: 'library', to: '/library' },
  { name: 'together', label: '一起听', icon: 'users', to: '/together' },
];

const route = useRoute();
const router = useRouter();
const toast = useToast();

/** macOS 的红绿灯占着左上角，品牌行要给它让位。 */
const isMac = window.sakura.platform === 'darwin';

const activeName = computed(() => String(route.name ?? ''));

function go(item: NavItem): void {
  if (item.to) {
    void router.push(item.to);
    return;
  }
  // 兜底：没有 `to` 的项还没做，点一下给个明确说法（当前各项都已接入）。
  toast.info(`${item.label}即将接入`);
}
</script>

<template>
  <aside class="sidebar">
    <!--
      品牌行跟着侧边栏走，而不是单独占一条横贯窗口的标题栏：
      整窗只有「侧边栏 | 内容区」这一道竖线，顶部不再有横线切一刀。
    -->
    <div class="brand drag" :class="{ 'is-mac': isMac }">
      <img class="brand-mark" :src="brandIcon" alt="" draggable="false" />
      <span class="brand-name">Sakura Music</span>
    </div>

    <nav class="nav" aria-label="主导航">
      <button
        v-for="item in navItems"
        :key="item.name"
        type="button"
        class="nav-item"
        :class="{ active: activeName === item.name, upcoming: !item.to }"
        :aria-current="activeName === item.name ? 'page' : undefined"
        @click="go(item)"
      >
        <span class="nav-indicator" />
        <AppIcon :name="item.icon" :size="18" />
        <span class="nav-label">{{ item.label }}</span>
        <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  min-height: 0;
  /* 顶部不留内边距：品牌行自己撑满 --titlebar-h，与右侧顶栏同高。 */
  padding: 0 14px 16px;
  border-right: 1px solid var(--border);
  /* 明确的浅灰底：整窗只有左右分层，靠这道色差把两列分开（不靠顶栏横线）。 */
  background: var(--bg-soft);
}

/*
 * 品牌行：既显示 logo，也承担窗口拖动区（负 margin 让它铺满侧边栏整个宽度，
 * 否则左右各 12px 是真空的，拖不动窗口）。
 */
.brand {
  display: flex;
  height: var(--titlebar-h);
  flex: none;
  align-items: center;
  /* 图标缩小后收一点间距，品牌行的视觉重心不会散。 */
  gap: 10px;
  /*
   * 负 margin 铺满侧边栏整宽（拖动区）。
   * 上下不对称：上 16px 让 logo 离窗口顶边更远一点，下留 6px 收住，
   * 品牌块重心略低于右侧顶栏，和网易云那种「logo 稍微靠下」的观感一致。
   */
  margin: 0 -14px 14px;
  padding: 18px 18px 6px;
}

.brand.is-mac {
  padding-left: 88px;
}

/*
 * 品牌标识：直接显示应用图标，不再另加渐变底板。
 * 投影用 drop-shadow 而不是 box-shadow——前者跟着图片的 alpha 走，
 * 图标圆角外的透明区域不会被投成方块阴影。
 */
.brand-mark {
  width: 36px;
  height: 36px;
  flex: none;
  filter: drop-shadow(0 4px 9px rgba(15, 23, 42, 0.16));
  user-select: none;
}

.brand-name {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: -0.015em;
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  height: 42px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 620;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.nav-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.nav-item.active {
  background: var(--accent-soft);
  color: var(--text);
}

.nav-item.active :deep(svg) {
  color: var(--accent);
}

.nav-indicator {
  position: absolute;
  left: -12px;
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}

.nav-item.active .nav-indicator {
  opacity: 1;
}

.nav-label {
  flex: 1;
}

.nav-badge {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

.nav-item.upcoming {
  color: var(--text-faint);
}

.nav-item.upcoming .nav-badge {
  color: var(--text-faint);
}
</style>
