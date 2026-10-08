/**
 * 知识库页交互：
 *   1) 阅读进度（localStorage，本地记录，不上传）
 *   2) 侧栏收起 / 展开
 *   3) 章节目录折叠
 */
(function () {
  var shell = document.getElementById('kbShell');
  if (!shell) return;

  var kbSlug = shell.getAttribute('data-kb') || '';
  var current = shell.getAttribute('data-article') || '';
  var READ_KEY = 'kb:read:' + kbSlug;
  var SIDE_KEY = 'kb:side:collapsed';
  var GROUP_KEY = 'kb:groups:' + kbSlug;

  /* 窄屏断点：≤ 这个宽度时侧栏从「左侧占位栏」变成 fixed 的全屏浮层
     （见 style.css 的 @media (max-width: 960px)），展开会盖住正文。
     ⚠️ 这个数值在三处必须一致：views/partials/head.ejs 的内联脚本、下面
     读取 data-side-init 的兜底、以及点遮罩收起那段。 */
  var NARROW = 960;

  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      /* 隐私模式下写不了，忽略 */
    }
  }

  /* ---------------- 阅读进度 ---------------- */

  var read = [];
  try {
    var parsed = JSON.parse(lsGet(READ_KEY, '[]'));
    if (Array.isArray(parsed)) read = parsed;
  } catch (e) {
    read = [];
  }

  if (current && read.indexOf(current) === -1) {
    read.push(current);
    lsSet(READ_KEY, JSON.stringify(read));
  }

  var readSet = Object.create(null);
  read.forEach(function (s) {
    readSet[s] = true;
  });

  var links = [].slice.call(shell.querySelectorAll('.side-link[data-nav-slug]'));
  var total = links.length;
  var done = 0;

  links.forEach(function (a) {
    var slug = a.getAttribute('data-nav-slug');
    if (readSet[slug]) done++;
    if (current && slug === current) a.classList.add('is-current');
  });

  var pct = total ? Math.round((done / total) * 100) : 0;

  var barIn = document.getElementById('kbPbarIn');
  var barBox = document.getElementById('kbPbar');
  var barText = document.getElementById('kbPbarText');
  var pctTop = document.getElementById('kbPctTop');

  if (barIn) barIn.style.width = pct + '%';
  if (barBox) barBox.setAttribute('aria-valuenow', String(pct));
  if (barText) barText.textContent = '已读 ' + done + '/' + total + ' · ' + pct + '%';
  if (pctTop) pctTop.textContent = String(pct);

  /* ---------------- 窄屏浮动「目录 / 进度」抽屉 ---------------- */
  /* ≤1000px 时右侧本篇目录被隐藏、侧栏收起后进度条也看不到，
     这里把它们并进底部抽屉。宽屏下整个 .toc-float 是 display:none，
     按钮点不到，这段逻辑等于空跑。 */

  var floatBox = document.getElementById('tocFloat');
  if (floatBox) {
    // 进度与侧栏那根条同源（都是整个知识库的已读比例）
    var floatPct = document.getElementById('tocFloatPct');
    var floatBarIn = document.getElementById('tocFloatBarIn');
    var floatProgress = document.getElementById('tocFloatProgress');
    if (floatPct) floatPct.textContent = pct + '%';
    if (floatBarIn) floatBarIn.style.width = pct + '%';
    if (floatProgress) floatProgress.textContent = '已读 ' + done + '/' + total + ' · ' + pct + '%';

    var floatBtn = document.getElementById('tocFloatBtn');
    var floatScrim = document.getElementById('tocFloatScrim');
    var floatPanel = document.getElementById('tocFloatPanel');

    function setFloatOpen(open) {
      floatBox.classList.toggle('is-open', open);
      if (floatBtn) floatBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (floatPanel) floatPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    if (floatBtn) {
      floatBtn.addEventListener('click', function () {
        setFloatOpen(!floatBox.classList.contains('is-open'));
      });
    }
    if (floatScrim) {
      floatScrim.addEventListener('click', function () {
        setFloatOpen(false);
      });
    }
    // 点了目录项（跳到某个小节）就把抽屉收掉
    if (floatPanel) {
      floatPanel.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
        if (a) setFloatOpen(false);
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setFloatOpen(false);
    });
  }

  /* ---------------- 章节目录折叠 ---------------- */

  var groupState = {};
  try {
    var gs = JSON.parse(lsGet(GROUP_KEY, '{}'));
    if (gs && typeof gs === 'object') groupState = gs;
  } catch (e) {
    groupState = {};
  }

  var groups = [].slice.call(shell.querySelectorAll('.side-group'));

  function setGroup(group, open) {
    group.classList.toggle('is-open', open);
    var head = group.querySelector('.side-group-head');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  groups.forEach(function (group, i) {
    var key = String(i);
    if (Object.prototype.hasOwnProperty.call(groupState, key)) {
      setGroup(group, !!groupState[key]);
    }
    var head = group.querySelector('.side-group-head');
    if (!head) return;
    head.addEventListener('click', function () {
      var open = !group.classList.contains('is-open');
      setGroup(group, open);
      groupState[key] = open;
      lsSet(GROUP_KEY, JSON.stringify(groupState));
    });
  });

  // 当前文章所在的章节始终展开
  var currentLink = shell.querySelector('.side-link.is-current');
  if (currentLink) {
    var parentGroup = currentLink.closest ? currentLink.closest('.side-group') : null;
    if (parentGroup) setGroup(parentGroup, true);
  }

  /* ---------------- 每章已读统计 ---------------- */

  [].slice.call(document.querySelectorAll('[data-chapter-meta]')).forEach(function (el) {
    var gi = el.getAttribute('data-chapter-meta');
    var items = shell.querySelectorAll('.side-link[data-group-index="' + gi + '"]');
    var n = 0;
    [].forEach.call(items, function (a) {
      if (readSet[a.getAttribute('data-nav-slug')]) n++;
    });
    el.textContent = '已读 ' + n + '/' + items.length;
  });

  [].slice.call(document.querySelectorAll('.art-card[data-article-slug]')).forEach(function (card) {
    if (readSet[card.getAttribute('data-article-slug')]) card.classList.add('is-read');
  });

  /* ---------------- 侧栏收起 / 展开 ---------------- */

  var doneBtn = document.getElementById('sideToggle');
  var openBtn = document.getElementById('sideReopen');
  var groupsEl = document.getElementById('kbGroups');

  function applyCollapsed(v) {
    shell.classList.toggle('is-collapsed', v);
    // 同步 head 里内联脚本打的首帧标记（见 views/partials/head.ejs）：
    // 展开时必须摘掉，否则 html.side-collapsed 会把侧栏又压回收起态。
    document.documentElement.classList.toggle('side-collapsed', v);
  }

  function setCollapsed(v) {
    applyCollapsed(v);
    // 窄屏的收起 / 展开是「跟着视口走」的临时状态，不写盘：
    // 一旦记住 '0'，下次窄屏进来侧栏就是展开的浮层，会直接盖住正文。
    if (window.innerWidth > NARROW) lsSet(SIDE_KEY, v ? '1' : '0');
  }

  // 初始状态由 head 里的内联脚本判定（首帧前），结论挂在 <html data-side-init> 上，
  // 这里只读结论；读不到才自己兜底。两处不再各判一遍 localStorage + 宽度。
  var initFlag = document.documentElement.getAttribute('data-side-init');
  var initialCollapsed;
  if (initFlag === '1') {
    initialCollapsed = true;
  } else if (initFlag === '0') {
    initialCollapsed = false;
  } else {
    // 兜底规则与 head.ejs 内联脚本一致：窄屏一律收起，宽屏才看记忆值
    var storedSide = lsGet(SIDE_KEY, null);
    initialCollapsed = window.innerWidth <= NARROW ? true : storedSide === '1';
  }

  // 这里只「应用」不「写回」：窄屏的自动收起是默认行为，不该被记成用户的显式选择。
  applyCollapsed(initialCollapsed);

  if (doneBtn) {
    doneBtn.addEventListener('click', function () {
      setCollapsed(true);
    });
  }
  if (openBtn) {
    openBtn.addEventListener('click', function () {
      setCollapsed(false);
    });
  }

  // 窄屏下点遮罩收起目录
  shell.addEventListener('click', function (e) {
    if (e.target !== shell) return;
    if (window.innerWidth <= NARROW && !shell.classList.contains('is-collapsed')) {
      setCollapsed(true);
    }
  });

  /* ---------------- 把当前文章滚进视野 ---------------- */
  /* 滚动容器是章节列表本身（顶部信息固定不滚动），所以偏移量按列表区域算 */

  if (currentLink && groupsEl) {
    var r = currentLink.getBoundingClientRect();
    var sr = groupsEl.getBoundingClientRect();
    if (r.top < sr.top + 24 || r.bottom > sr.bottom - 24) {
      groupsEl.scrollTop = Math.max(0, groupsEl.scrollTop + (r.top - sr.top) - 24);
    }
  }
})();
