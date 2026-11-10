// 启动加载层的首帧配置。放在外部文件里，CSP 才能保持严格的 script-src 'self'：
// 以前这段是 index.html 的内联脚本，生产包带 CSP 时会被直接拦掉。
(function () {
  // 副窗口（桌面歌词 / 弹出播放页）不显示加载层。
  if (new URLSearchParams(location.search).get('window')) {
    document.documentElement.setAttribute('data-boot-hidden', '1');
  }
  try {
    var t = JSON.parse(localStorage.getItem('sakura.desktop.theme') || '{}');
    var dark =
      t.mode === 'dark' ||
      (t.mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.setAttribute('data-boot-dark', '1');
    var accents = {
      sakura: '#ff7aa2',
      matcha: '#6fc47a',
      deep: '#5b8cff',
      wisteria: '#a78bfa',
      sunset: '#ff9a62',
      ink: '#9aa7bd',
    };
    document.documentElement.style.setProperty('--boot-accent', accents[t.palette] || '#5b8cff');
  } catch (e) {
    /* 存储不可用就用默认配色 */
  }
})();
