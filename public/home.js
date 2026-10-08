/* 主页：回到顶部按钮 */
(function () {
  var btn = document.getElementById('floatTop');
  if (!btn) return;

  function sync() {
    if (window.scrollY > 420) {
      btn.classList.add('is-visible');
    } else {
      btn.classList.remove('is-visible');
    }
  }

  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  window.addEventListener('scroll', sync, { passive: true });
  sync();
})();

/* 主页：特色知识库轮播 —— 最近更新的 3 个，4 秒交叉淡入，没有切换按钮。
   哪 3 个由 server.js 按 mtime 算（featuredKbs），这里只管轮。 */
(function () {
  var stage = document.getElementById('featuredStage');
  if (!stage) return;

  var items = Array.prototype.slice.call(stage.querySelectorAll('.hero-featured'));
  if (items.length < 2) return;

  // 系统开启「减少动态效果」时保持静止，只显示最新的第一张
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce && reduce.matches) return;

  var INTERVAL = 4000;
  var current = 0;
  var timer = null;

  function show(i) {
    if (i === current) return;
    items[current].classList.remove('is-active');
    items[current].setAttribute('aria-hidden', 'true');
    items[current].setAttribute('tabindex', '-1');
    current = i;
    items[current].classList.add('is-active');
    items[current].removeAttribute('aria-hidden');
    items[current].removeAttribute('tabindex');
  }

  function start() {
    if (timer) return;
    timer = window.setInterval(function () {
      show((current + 1) % items.length);
    }, INTERVAL);
  }

  function stop() {
    if (!timer) return;
    window.clearInterval(timer);
    timer = null;
  }

  // 悬停、键盘聚焦、标签页切到后台都暂停，回到前台接着轮
  stage.addEventListener('mouseenter', stop);
  stage.addEventListener('mouseleave', start);
  stage.addEventListener('focusin', stop);
  stage.addEventListener('focusout', start);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  start();
})();

/* 主页：顶栏的知识库分类导航 —— 点击平滑滚到对应分组。
   原生跳转是瞬移，页面一长会丢失「我从哪来」的位置感。
   只拦主页上确实存在的那个锚点；在搜索页等其它页面点，分组节点不在，
   直接放行走浏览器原生跳转（照样能回到主页并定位）。
   系统开启「减少动态效果」时整段不生效，交回原生跳转。 */
(function () {
  var nav = document.querySelector('.site-nav');
  if (!nav) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce && reduce.matches) return;

  nav.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="/#"]') : null;
    if (!a) return;
    var id = a.getAttribute('href').slice(2);
    var el = id ? document.getElementById(id) : null;
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (history.replaceState) history.replaceState(null, '', '/#' + id);
  });
})();
