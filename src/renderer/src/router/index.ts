import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import AppShell from '@/views/AppShell.vue';

/**
 * 用 hash 路由：桌面端不需要服务端重写规则，打包后的静态托管也少一条回退分支。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/views/OnboardingView.vue'),
      meta: { public: true, bare: true },
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, bare: true },
    },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', name: 'home', component: () => import('@/views/HomeView.vue') },
        {
          path: 'favorites',
          name: 'favorites',
          component: () => import('@/views/FavoritesView.vue'),
        },
        {
          path: 'history',
          name: 'history',
          component: () => import('@/views/HistoryView.vue'),
        },
        {
          path: 'downloads',
          name: 'downloads',
          component: () => import('@/views/DownloadsView.vue'),
        },
        {
          path: 'search',
          name: 'search',
          component: () => import('@/views/SearchView.vue'),
        },
        {
          path: 'artist/:platform/:id',
          name: 'artist',
          component: () => import('@/views/ArtistView.vue'),
        },
        {
          path: 'album/:platform/:id',
          name: 'album',
          component: () => import('@/views/AlbumView.vue'),
        },
        {
          path: 'collection/:platform/:id',
          name: 'collection',
          component: () => import('@/views/CollectionView.vue'),
        },
        {
          path: 'toplist/:platform/:id',
          name: 'toplist',
          component: () => import('@/views/CollectionView.vue'),
        },
        {
          path: 'library',
          name: 'library',
          component: () => import('@/views/LibraryView.vue'),
        },
        {
          path: 'library/playlist/:id',
          name: 'playlist',
          component: () => import('@/views/LocalPlaylistView.vue'),
        },
        {
          path: 'together',
          name: 'together',
          component: () => import('@/views/TogetherView.vue'),
        },
        {
          path: 'devices',
          name: 'devices',
          component: () => import('@/views/DevicesView.vue'),
        },
        {
          path: 'account',
          name: 'account',
          component: () => import('@/views/AccountView.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/views/SettingsView.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.initialize();

  if (!auth.hasServer) {
    return to.name === 'onboarding' ? true : { name: 'onboarding' };
  }

  if (to.name === 'onboarding') {
    return auth.isAuthenticated ? { name: 'home' } : { name: 'login' };
  }

  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }

  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'home' };
  }

  return true;
});
