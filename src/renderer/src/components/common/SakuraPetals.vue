<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useThemeStore } from '@/stores/theme';

/**
 * 樱花飘落背景。
 *
 * 用 canvas 而不是几十个 DOM：桌面窗口长时间常驻，DOM 动画会持续触发布局。
 * 花瓣数量压到 22，并在「减少动态效果」或设置里关闭时直接不启动。
 */
interface Petal {
  x: number;
  y: number;
  size: number;
  speed: number;
  drift: number;
  rotation: number;
  spin: number;
  alpha: number;
}

const theme = useThemeStore();
const canvas = ref<HTMLCanvasElement | null>(null);

let ctx: CanvasRenderingContext2D | null = null;
let frame = 0;
let width = 0;
let height = 0;
let petals: Petal[] = [];
let accent = '#ff9ab5';
let last = 0;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function makePetal(randomY = true): Petal {
  return {
    x: Math.random() * width,
    y: randomY ? Math.random() * height : -12,
    size: 3.5 + Math.random() * 5,
    speed: 8 + Math.random() * 18,
    drift: -8 + Math.random() * 16,
    rotation: Math.random() * Math.PI * 2,
    spin: -0.6 + Math.random() * 1.2,
    alpha: 0.16 + Math.random() * 0.3,
  };
}

function resize(): void {
  const element = canvas.value;
  if (!element) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  element.width = Math.floor(width * dpr);
  element.height = Math.floor(height * dpr);
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  ctx = element.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  petals = Array.from({ length: 22 }, () => makePetal(true));
}

function draw(timestamp: number): void {
  if (!ctx) return;
  const delta = last ? Math.min((timestamp - last) / 1000, 0.05) : 0.016;
  last = timestamp;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = accent;

  for (const petal of petals) {
    petal.y += petal.speed * delta;
    petal.x += petal.drift * delta;
    petal.rotation += petal.spin * delta;

    if (petal.y > height + 16) {
      Object.assign(petal, makePetal(false));
    }
    if (petal.x < -20) petal.x = width + 10;
    if (petal.x > width + 20) petal.x = -10;

    ctx.save();
    ctx.translate(petal.x, petal.y);
    ctx.rotate(petal.rotation);
    ctx.globalAlpha = petal.alpha;
    ctx.beginPath();
    ctx.ellipse(0, 0, petal.size, petal.size * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  frame = window.requestAnimationFrame(draw);
}

function start(): void {
  if (frame || reducedMotion) return;
  last = 0;
  frame = window.requestAnimationFrame(draw);
}

function stop(): void {
  if (!frame) return;
  window.cancelAnimationFrame(frame);
  frame = 0;
  ctx?.clearRect(0, 0, width, height);
}

watch(
  () => theme.petals,
  (enabled) => (enabled ? start() : stop()),
);

watch(
  () => theme.palette,
  () => {
    accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff9ab5';
  },
  { immediate: true },
);

onMounted(() => {
  resize();
  window.addEventListener('resize', resize);
  if (theme.petals) start();
});

onBeforeUnmount(() => {
  stop();
  window.removeEventListener('resize', resize);
});
</script>

<template>
  <canvas ref="canvas" class="petals" aria-hidden="true" />
</template>

<style scoped>
.petals {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.85;
}
</style>
