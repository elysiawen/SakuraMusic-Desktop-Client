<template>
  <!-- 模式组件按需加载期间的占位：盖住主界面，避免切换样式时闪回列表页 -->
  <div class="mode-loading" aria-hidden="true" />
</template>

<style scoped>
.mode-loading {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: #05070a;
}
</style>
