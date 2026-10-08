/* 文章页：滚动时高亮目录当前项。
   注意：目录有两份 —— 右侧固定的 .toc-side，和窄屏底部抽屉 .toc-float 里的那份，
   两份用同一套 heading id。所以必须「按 id 把两边一起点亮」，
   不能只点亮某一个 <a>（那样只有 DOM 里靠前的那一份会亮）。 */
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc-list a'));
  if (!links.length) return;

  function idOf(link) {
    return decodeURIComponent(link.getAttribute('href').slice(1));
  }

  // 去重：同一 id 可能对应两份目录里的两个 <a>，正文节点只取一次
  var entries = [];
  links.forEach(function (link) {
    var id = idOf(link);
    var el = document.getElementById(id);
    if (!el) return;
    var seen = false;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) { seen = true; break; }
    }
    if (!seen) entries.push({ id: id, el: el });
  });

  if (!entries.length) return;

  var ticking = false;

  function update() {
    ticking = false;
    var line = 120; // 距顶部多少像素内算“当前”
    var current = entries[0];

    for (var i = 0; i < entries.length; i++) {
      if (entries[i].el.getBoundingClientRect().top <= line) {
        current = entries[i];
      } else {
        break;
      }
    }

    links.forEach(function (l) {
      l.classList.toggle('is-active', idOf(l) === current.id);
    });
  }

  function onScroll() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(update);
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
})();
