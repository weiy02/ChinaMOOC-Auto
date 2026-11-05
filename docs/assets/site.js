/* 站点交互：面板示意切换 + 版本号自动同步 */
(function () {
  'use strict';

  /* ---------- 面板示意：选项卡切换 ---------- */
  var tabs = document.querySelectorAll('.pt');
  var views = document.querySelectorAll('[data-view]');

  function activate(name) {
    tabs.forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    views.forEach(function (v) {
      v.classList.toggle('hidden', v.dataset.view !== name);
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { activate(t.dataset.tab); });
  });

  /* 自动轮播一下，让人知道能点（用户一旦手动点过就停） */
  var order = ['learn', 'review', 'discuss', 'log', 'set'];
  var idx = 0;
  var touched = false;
  document.getElementById('panel')?.addEventListener('pointerdown', function () { touched = true; });

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (tabs.length && !reduce) {
    setInterval(function () {
      if (touched || document.hidden) return;
      idx = (idx + 1) % order.length;
      activate(order[idx]);
    }, 3800);
  }

  /* ---------- 版本号：读 raw main.js 的 @version，失败则保留静态值 ---------- */
  var RAW = 'https://raw.githubusercontent.com/weiy02/ChinaMOOC-Auto/main/main.js';
  var nodes = document.querySelectorAll('[data-version]');
  if (!nodes.length) return;

  fetch(RAW, { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
    .then(function (txt) {
      var m = txt.match(/@version\s+([\d.]+)/);
      if (!m) return;
      nodes.forEach(function (n) { n.textContent = m[1]; });
    })
    .catch(function () { /* 拿不到就用页面里写死的版本，不打扰使用者 */ });
})();
