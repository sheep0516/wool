/* 静态站的站内搜索 —— 本地（node server.js）用不到这个文件。
 *
 * 本地是服务端实时扫 md 算结果；静态站没有后端，改成：
 *   页面加载 → 读 search-index.json → 拿 URL 上的 ?q= → 在前端算 → 渲染进 #searchResults
 *
 * 打分与高亮规则**刻意和 server.js 的 searchLibrary() 保持一致**：
 *   · 多个关键词是「且」（每个词都要在标题/章节名/库名或正文里出现）
 *   · 标题命中 ×100，正文按出现次数累加
 *   · 先 HTML 转义，再插 <mark>（顺序不能反，否则内容里的尖括号会被当标签）
 * 改 server.js 的搜索算法时，这里要同步改。
 */
(function () {
  var cfg = window.__SEARCH__;
  if (!cfg) return;

  var box = document.getElementById('searchResults');
  var stat = document.getElementById('searchStat');
  if (!box) return;

  var base = cfg.base || '';

  /* ---------------- 与 server.js 同源的纯函数 ---------------- */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      if (c === '&') return '&amp;';
      if (c === '<') return '&lt;';
      if (c === '>') return '&gt;';
      if (c === '"') return '&quot;';
      return '&#39;';
    });
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 命中词包 <mark>：先转义整段文本，再插标记，避免把内容当 HTML 渲染
  function highlightText(text, terms) {
    var safe = escapeHtml(text);
    if (!terms.length) return safe;
    var pattern = terms.map(function (t) {
      return escapeRegExp(escapeHtml(t));
    }).join('|');
    try {
      return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) {
      return safe;
    }
  }

  function makeSnippet(text, terms, fallback) {
    var lower = text.toLowerCase();
    var at = -1;
    for (var i = 0; i < terms.length; i++) {
      var p = lower.indexOf(terms[i].toLowerCase());
      if (p !== -1 && (at === -1 || p < at)) at = p;
    }
    if (at === -1) {
      var plain = fallback || text.slice(0, 110);
      return plain.length > 110 ? plain.slice(0, 110) + '…' : plain;
    }
    var start = Math.max(0, at - 36);
    var end = Math.min(text.length, at + 78);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }

  function naturalCompare(a, b) {
    try {
      return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    } catch (e) {
      return String(a) < String(b) ? -1 : 1;
    }
  }

  /* ---------------- 搜索主逻辑（对应 server.js searchLibrary） ---------------- */

  function search(query, entries) {
    var raw = String(query || '').trim();
    var terms = raw.split(/\s+/).filter(Boolean);
    if (!terms.length) return { query: '', terms: [], total: 0, groups: [] };

    var lowered = terms.map(function (t) { return t.toLowerCase(); });
    var groups = [];
    var total = 0;

    // 按知识库分组：索引是扁平的，这里按 kb slug 归并
    var order = [];
    var byKb = {};
    entries.forEach(function (a) {
      if (!byKb[a.kb]) {
        byKb[a.kb] = { kb: { slug: a.kb, title: a.kbTitle, color: a.kbColor, initial: a.kbInitial, url: base + '/kb/' + encodeURIComponent(a.kb) }, hits: [] };
        order.push(a.kb);
      }
    });

    entries.forEach(function (a) {
      var body = (a.text || '').toLowerCase();
      var meta = (a.title + ' ' + a.chapter + ' ' + a.kbTitle).toLowerCase();

      var matchedAll = lowered.every(function (t) {
        return meta.indexOf(t) !== -1 || body.indexOf(t) !== -1;
      });
      if (!matchedAll) return;

      var lowerTitle = a.title.toLowerCase();
      var score = 0;
      lowered.forEach(function (t) {
        if (lowerTitle.indexOf(t) !== -1) score += 100;
        var from = 0, n = 0;
        while ((from = body.indexOf(t, from)) !== -1) { n++; from += t.length; }
        score += n;
      });

      byKb[a.kb].hits.push({
        title: a.title,
        titleHtml: highlightText(a.title, terms),
        url: a.url,
        chapterName: a.chapter,
        num: a.num,
        snippetHtml: highlightText(makeSnippet(a.text || '', terms, a.excerpt), terms),
        score: score
      });
    });

    order.forEach(function (slug) {
      var g = byKb[slug];
      if (!g.hits.length) return;
      g.hits.sort(function (x, y) {
        return y.score - x.score || naturalCompare(x.title, y.title);
      });
      total += g.hits.length;
      groups.push(g);
    });

    groups.sort(function (a, b) { return b.hits.length - a.hits.length; });
    return { query: raw, terms: terms, total: total, groups: groups };
  }

  /* ---------------- 渲染（结构对应 search.ejs 的服务端分支） ---------------- */

  function renderStat(result) {
    if (!stat) return;
    if (!result.query) { stat.hidden = true; stat.innerHTML = ''; return; }
    stat.hidden = false;
    if (result.total) {
      var extra = result.groups.length > 1
        ? '，分布在 ' + result.groups.length + ' 个知识库' : '';
      stat.innerHTML = '「<strong>' + escapeHtml(result.query) + '</strong>」共找到 <strong>'
        + result.total + '</strong> 篇' + extra;
    } else {
      stat.innerHTML = '没有找到和「<strong>' + escapeHtml(result.query) + '</strong>」相关的内容';
    }
  }

  function renderEmpty(query) {
    if (!query) {
      return '<div class="search-empty"><p>输入关键词开始搜索。</p>'
        + '<p class="muted">标题命中的结果会排在前面，正文里的命中位置会摘出来并高亮。</p></div>';
    }
    return '<div class="search-empty"><p>换个说法试试：</p>'
      + '<p class="muted">关键词之间是「都要出现」的关系，拆得太细容易搜不到 —— 少写几个词命中率更高；也可以试试更短的词根。</p></div>';
  }

  function render(result) {
    if (!result.total) {
      box.innerHTML = renderEmpty(result.query);
      return;
    }

    var html = '';
    result.groups.forEach(function (g) {
      html += '<section class="search-group">';
      html += '<h2 class="search-group-title">'
        + '<span class="search-group-icon" style="background:' + escapeHtml(g.kb.color) + '">'
        + escapeHtml(g.kb.initial) + '</span>'
        + '<a href="' + escapeHtml(g.kb.url) + '">' + escapeHtml(g.kb.title) + '</a>'
        + '<span class="search-group-count">' + g.hits.length + ' 篇</span>'
        + '</h2>';
      html += '<ul class="search-list">';
      g.hits.forEach(function (h) {
        html += '<li class="search-item">'
          + '<a class="search-item-title" href="' + escapeHtml(h.url) + '">' + h.titleHtml + '</a>'
          + '<p class="search-item-snippet">' + h.snippetHtml + '</p>'
          + '<span class="search-item-path">' + escapeHtml(g.kb.title)
          + (h.chapterName ? ' · ' + escapeHtml(h.chapterName) : '')
          + (h.num ? ' · ' + escapeHtml(h.num) : '')
          + '</span></li>';
      });
      html += '</ul></section>';
    });
    box.innerHTML = html;
  }

  /* ---------------- 入口 ---------------- */

  function run(query, entries) {
    var result = search(query, entries);
    renderStat(result);
    render(result);
    var input = document.querySelector('.search-input');
    if (input && input.value !== result.query) input.value = result.query;
  }

  // 提交表单时不必重新加载：拦下来，改 URL 的 ?q=，就地算
  var form = document.querySelector('.search-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.querySelector('.search-input');
      var q = input ? input.value.trim() : '';
      var url = base + '/search/' + (q ? '?q=' + encodeURIComponent(q) : '');
      if (history.pushState) history.pushState(null, '', url);
      if (loaded) run(q, loaded);
    });
  }

  var loaded = null;

  // 查询词只从 URL 的 ?q= 读（静态站没有后端，页面里带不了初始查询词）
  function queryFromUrl() {
    var m = /[?&]q=([^&]*)/.exec(window.location.search);
    if (!m) return '';
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch (e) {
      return m[1];
    }
  }

  fetch(cfg.index, { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('索引读取失败 ' + r.status);
      return r.json();
    })
    .then(function (entries) {
      loaded = entries;
      run(queryFromUrl(), entries);
    })
    .catch(function (err) {
      box.innerHTML = '<div class="search-empty"><p>搜索索引加载失败。</p>'
        + '<p class="muted">' + escapeHtml(err.message) + '</p></div>';
    });

  // 浏览器前进 / 后退时同步结果
  window.addEventListener('popstate', function () {
    if (loaded) run(queryFromUrl(), loaded);
  });
})();
