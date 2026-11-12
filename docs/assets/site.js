/* 站点交互
   1. 首页面板示意的选项卡切换
   2. 版本号自动跟随 raw main.js 的 @version
   3. 教程页：缺失截图自动降级为占位框
   4. 教程页：视频文件存在则渲染播放器，否则保留占位
   5. 教程页：目录滚动高亮
*/
(function () {
  'use strict';

  /* ---------- 1. 面板示意 ---------- */
  var panel = document.getElementById('panel');
  if (panel) {
    var tabs = panel.querySelectorAll('.pt');
    var views = panel.querySelectorAll('[data-view]');
    var order = ['learn', 'review', 'discuss', 'log', 'set'];
    var idx = 0;
    var touched = false;

    var activate = function (name) {
      Array.prototype.forEach.call(tabs, function (t) {
        var on = t.dataset.tab === name;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      Array.prototype.forEach.call(views, function (v) {
        v.classList.toggle('hidden', v.dataset.view !== name);
      });
    };

    Array.prototype.forEach.call(tabs, function (t) {
      t.addEventListener('click', function () { activate(t.dataset.tab); });
    });

    panel.addEventListener('pointerdown', function () { touched = true; });

    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInterval(function () {
        if (touched || document.hidden) return;
        idx = (idx + 1) % order.length;
        activate(order[idx]);
      }, 3800);
    }
  }

  /* ---------- 2. 版本号 ---------- */
  var versionNodes = document.querySelectorAll('[data-version]');
  if (versionNodes.length) {
    fetch('https://raw.githubusercontent.com/weiy02/ChinaMOOC-Auto/main/main.js', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function (txt) {
        var m = txt.match(/@version\s+([\d.]+)/);
        if (!m) return;
        Array.prototype.forEach.call(versionNodes, function (n) { n.textContent = m[1]; });
      })
      .catch(function () { /* 拿不到就用页面里写死的版本 */ });
  }

  /* ---------- 3. 截图缺失降级 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('img[data-shot]'), function (img) {
    var figure = img.closest ? img.closest('.shot') : null;
    if (!figure) return;
    var markMissing = function () { figure.classList.add('missing'); };
    img.addEventListener('error', markMissing);
    /* 缓存命中的失败图不会再触发 error */
    if (img.complete && img.naturalWidth === 0) markMissing();
  });

  /* ---------- 4. 视频位 ---------- */
  var shell = document.querySelector('.video-shell[data-video]');
  if (shell) {
    /* 换成 B 站视频：删掉 data-video，改成 data-bvid="BV号" */
    if (shell.dataset.bvid) {
      var iframe = document.createElement('iframe');
      iframe.src = '//player.bilibili.com/player.html?bvid=' + shell.dataset.bvid + '&autoplay=0&high_quality=1';
      iframe.allowFullscreen = true;
      iframe.setAttribute('scrolling', 'no');
      iframe.setAttribute('frameborder', '0');
      iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
      var ph0 = shell.querySelector('.video-ph');
      if (ph0) ph0.remove();
      shell.appendChild(iframe);
      return;
    }

    var video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    if (shell.dataset.poster) video.poster = shell.dataset.poster;
    video.src = shell.dataset.video;

    video.addEventListener('loadedmetadata', function () {
      var ph = shell.querySelector('.video-ph');
      if (ph) ph.remove();
    });
    /* 文件还没放进去：保留占位框，不吵人 */
    video.addEventListener('error', function () {
      if (video.parentNode) video.remove();
    });
    shell.appendChild(video);
  }

  /* ---------- 5. 目录滚动高亮 ---------- */
  var tocLinks = document.querySelectorAll('.toc a[href^="#"]');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var map = {};
    Array.prototype.forEach.call(tocLinks, function (a) {
      map[a.getAttribute('href').slice(1)] = a;
    });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        Array.prototype.forEach.call(tocLinks, function (a) { a.style.color = ''; });
        var link = map[e.target.id];
        if (link) link.style.color = 'var(--accent)';
      });
    }, { rootMargin: '-84px 0px -70% 0px', threshold: 0 });

    Array.prototype.forEach.call(document.querySelectorAll('.doc-sec[id]'), function (sec) {
      spy.observe(sec);
    });
  }
  /* ---------- 6. 安装量徽章：从 shields 取数，用自己的胶囊样式渲染 ---------- */
  var statNodes = document.querySelectorAll('[data-stat]');
  if (statNodes.length) {
    var STAT_SRC = {
      'gf-total': 'https://img.shields.io/greasyfork/dt/595205.svg',
      'gf-daily': 'https://img.shields.io/greasyfork/dd/595205.svg',
      'sc-total': 'https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fscriptcat.org%2Fapi%2Fv2%2Fscripts%2F8833&query=%24.data.total_install&label=installs',
      'sc-daily': 'https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fscriptcat.org%2Fapi%2Fv2%2Fscripts%2F8833&query=%24.data.today_install&label=today&color=orange',
      'gh-stars': 'https://img.shields.io/github/stars/weiy02/ChinaMOOC-Auto.svg'
    };
    var CACHE_KEY = 'mooc-stats-v1';
    var TTL = 10 * 60 * 1000;

    var paint = function (data) {
      Array.prototype.forEach.call(statNodes, function (n) {
        var v = data[n.dataset.stat];
        if (v) n.textContent = v;
      });
    };

    var cached = null;
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        var box = JSON.parse(raw);
        if (box && Date.now() - box.t < TTL && box.d) cached = box.d;
      }
    } catch (e) { /* 隐私模式忽略 */ }

    if (cached) {
      paint(cached);
    } else {
      var jobs = Object.keys(STAT_SRC).map(function (key) {
        return fetch(STAT_SRC[key], { cache: 'no-cache' })
          .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
          .then(function (svg) {
            /* shields 的 SVG 里正文在最后一个 <text> 节点 */
            var texts = svg.match(/>([^<>]+)<\/text>/g) || [];
            for (var i = texts.length - 1; i >= 0; i--) {
              var val = texts[i].replace(/^>|<\/text>$/g, '').trim();
              if (val) return [key, val];
            }
            return null;
          })
          .catch(function () { return null; });
      });

      Promise.all(jobs).then(function (pairs) {
        var data = {};
        pairs.forEach(function (p) { if (p) data[p[0]] = p[1]; });
        if (!Object.keys(data).length) return;
        paint(data);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), d: data }));
        } catch (e) { /* 存不下就算了 */ }
      });
    }
  }
})();
