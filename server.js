/**
 * 羊毛设计稿 · 本地服务
 * ---------------------------------------------------------------
 * 直接读取 content/ 下的 Markdown 文件，不构建、不打包。
 * 你在编辑器里保存 .md，浏览器会自动刷新。
 *
 * 目录约定：
 *   content/<知识库>/_meta.md           知识库信息（frontmatter）
 *   content/<知识库>/<章节文件夹>/*.md   章节下的文章
 *   content/<知识库>/<章节文件夹>/assets 该章图片
 *
 * 启动：node server.js   （或双击 start.bat）
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const matter = require('gray-matter');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const chokidar = require('chokidar');

const ROOT = __dirname;
const CONTENT_DIR = path.join(ROOT, 'content');
const VIEWS_DIR = path.join(ROOT, 'views');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

/* basePath：站点被部署到子路径时用（GitHub Pages 项目页 = /wool）。
   本地运行传空串，所有地址保持原来的根路径写法，渲染结果与从前一致。 */
function normalizeBase(base) {
  const s = String(base == null ? '' : base).trim();
  if (!s || s === '/') return '';
  return '/' + s.replace(/^\/+|\/+$/g, '');
}
const BASE = normalizeBase(process.env.PKB_BASE);

const site = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
  } catch (e) {
    return { title: '羊毛设计稿', subtitle: '' };
  }
})();

/* =============================================================
 *  Markdown 渲染器
 * ============================================================= */

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false
});

md.use(require('markdown-it-task-lists'));

// 代码高亮：只负责把源码转成带 <span> 的 HTML（外层结构交给 fence 规则）
function highlightCode(str, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
    } catch (e) {
      /* 兜底：转义后原样输出 */
    }
  }
  return md.utils.escapeHtml(str);
}

// 代码块映射：容器 + 头部（左：语言；右：行数 + 复制按钮）+ 代码体
md.renderer.rules.fence = function (tokens, idx) {
  const token = tokens[idx];
  const info = String(token.info || '').trim();
  const lang = (info.split(/\s+/)[0] || '').toLowerCase();
  const code = String(token.content || '').replace(/\r\n?/g, '\n');
  const lineCount = code.replace(/\n$/, '').split('\n').length;
  const label = md.utils.escapeHtml(lang || '文本');

  return (
    '<div class="code-block">' +
    '<div class="code-head">' +
    '<span class="code-lang">' +
    label +
    '</span>' +
    '<div class="code-actions">' +
    '<span class="code-lines">' +
    lineCount +
    ' 行</span>' +
    '<button class="code-copy" type="button">复制</button>' +
    '</div>' +
    '</div>' +
    '<pre><code class="hljs' +
    (lang ? ' language-' + label : '') +
    '">' +
    highlightCode(code, lang) +
    '</code></pre>' +
    '</div>'
  );
};

// 给标题生成 id，并收集目录（TOC）
function slugifyHeading(text) {
  const s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .replace(/^-+|-+$/g, '');
  return s || 'section';
}

md.core.ruler.push('kb_heading_ids', (state) => {
  const toc = [];
  const used = Object.create(null);
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type !== 'heading_open' || !/^h[1-6]$/.test(token.tag)) continue;
    const level = Number(token.tag[1]);
    const inline = state.tokens[i + 1];
    const text = inline ? inline.content.replace(/[*`]/g, '').trim() : '';
    let id = slugifyHeading(text);
    if (used[id]) {
      used[id] += 1;
      id = id + '-' + used[id];
    } else {
      used[id] = 1;
    }
    token.attrSet('id', id);
    if (level === 2 || level === 3) toc.push({ level, text, id });
  }
  state.env.toc = toc;
});

/* -------------------------------------------------------------
 *  注释映射（写法 2）：整行只有斜体
 *  `*这样写*` 独占一行时，markdown 渲染成 <p><em>…</em></p>。
 *  这里给这个段落打上 class="note"，样式层再把它映射成与 `>` 引用块
 *  完全一致的注释文本（14px / 1.5 / #888888，无边框无底色）。
 *  只认「整个段落就是一个 em」；行内夹杂别的内容（如 `前面 *重点* 后面`）
 *  以及 `**加粗**` 独占一行，都不处理。
 * ----------------------------------------------------------- */
function isWholeLineEm(children) {
  if (!children || !children.length) return false;
  // 忽略首尾的纯空白文本（markdown-it 可能留一个换行）
  let a = 0;
  let b = children.length - 1;
  while (a <= b && children[a].type === 'text' && !children[a].content.trim()) a++;
  while (b >= a && children[b].type === 'text' && !children[b].content.trim()) b--;
  if (a > b) return false;
  if (children[a].type !== 'em_open' || children[b].type !== 'em_close') return false;
  // 这个 em 必须一直包到最后，中途闭合就说明后面还有别的东西
  let depth = 0;
  for (let i = a; i <= b; i++) {
    const t = children[i].type;
    if (t === 'em_open') depth++;
    else if (t === 'em_close') {
      depth--;
      if (depth === 0 && i !== b) return false;
    }
  }
  return depth === 0;
}

md.core.ruler.push('kb_note_paragraph', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'paragraph_open') continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;
    if (isWholeLineEm(inline.children)) tokens[i].attrSet('class', 'note');
  }
});

// 把一个“未编码的路径”统一编码一次：先按 / 拆段，再逐段 encodeURIComponent。
function encodePathOnce(p) {
  let hash = '';
  const hi = p.indexOf('#');
  if (hi >= 0) {
    hash = p.slice(hi);
    p = p.slice(0, hi);
  }
  let query = '';
  const qi = p.indexOf('?');
  if (qi >= 0) {
    query = p.slice(qi);
    p = p.slice(0, qi);
  }
  return p.split('/').map(encodeURIComponent).join('/') + query + hash;
}

// 图片路径改写：把 md 里的 ./assets/x.png 指到 /media/<知识库>/<章节>/assets/x.png
// 注意：markdown-it 交给渲染器时 src 已经被编码过一次，这里要先解码再统一编码。
const defaultImageRule = md.renderer.rules.image;
md.renderer.rules.image = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const i = token.attrIndex('src');
  let isExternal = false;
  if (i >= 0) {
    const original = token.attrs[i][1];
    isExternal =
      /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(original) ||
      /^[a-z][a-z0-9+.-]*:/i.test(original);
    if (!isExternal) {
      token.attrs[i][1] = resolveMediaUrl(env.kbSlug, env.chapterDir, original);
    }
  }

  // 懒加载：文章里的图大多是往下滚才看到，先不下载。
  // 站内图（/media/...）和站外图都适用；md 里如果自己写了 loading 属性就不覆盖。
  if (token.attrIndex('loading') < 0) token.attrSet('loading', 'lazy');
  if (token.attrIndex('decoding') < 0) token.attrSet('decoding', 'async');

  if (defaultImageRule) return defaultImageRule(tokens, idx, options, env, self);
  return self.renderToken(tokens, idx, options);
};

/* =============================================================
 *  内容扫描
 * ============================================================= */

const naturalCompare = (a, b) =>
  a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });

const stripOrderPrefix = (name) =>
  name.replace(/^\d+\s*[-_.·、]?\s*/, '').trim() || name;

// 章节名去掉「第N章 / 第N部分」这类前缀，只留语义部分（页面上会重新编号）
const stripChapterPrefix = (name) => {
  const base = stripOrderPrefix(name);
  const short = base
    .replace(
      /^第\s*[0-9一二三四五六七八九十百]+\s*(?:章|部分|篇|节|讲|单元)\s*[·:：、.\-—]?\s*/,
      ''
    )
    .trim();
  return short || base;
};

// 把 md 里写的相对图片路径解析成 /media/<知识库>/<章节>/xxx 的地址
function resolveMediaUrl(kbSlug, chapterDir, src) {
  if (!src) return '';
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return src;
  }
  let raw = src;
  try {
    raw = decodeURIComponent(src);
  } catch (e) {
    /* 已经是干净路径 */
  }
  if (!raw.startsWith('/')) {
    const base = '/' + ['media', kbSlug, chapterDir].filter(Boolean).join('/');
    raw = base + '/' + raw;
  }
  return BASE + encodePathOnce(path.posix.normalize(raw).replace(/\\/g, '/'));
}

// 数量显示：1.2万 / 3.4k
function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// 知识库图标配色：按名字哈希从调色板里取一个，保证同一个库颜色稳定
const ICON_COLORS = [
  '#e5484d',
  '#2563eb',
  '#f59e0b',
  '#0d9488',
  '#7c3aed',
  '#db2777',
  '#16a34a',
  '#ea580c'
];

function colorFor(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) {
    h = (h * 31 + String(str).charCodeAt(i)) >>> 0;
  }
  return ICON_COLORS[h % ICON_COLORS.length];
}

function fmtDate(ms) {
  const d = new Date(ms);
  if (!ms || isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (e) {
    return [];
  }
}

/* -------------------------------------------------------------
 *  章节内容扫描（支持「章 → 小节 → …」任意深度）
 *
 *  约定：一个章节目录里
 *    · `xx.md`         → 这一章直属的文章
 *    · `NN-子目录/`    → 章内「小节」，里面的 .md 是小节下的文章（可继续嵌套）
 *  直属文章与小节**共用同一套序号**，所以
 *    01-矢量图和位图.md → 2.1、02-… → 2.2、03-… → 2.3、
 *    04-图标的设计规范/01-表意的准确.md → 2.4.1
 *  序号正好和正文里的「2.4.1 表意的准确」对得上。
 * ------------------------------------------------------------- */

// 列出「可当内容看的条目」：.md 文件 + 子目录，按名字自然排序（文件和目录混排）
function listChapterEntries(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && !d.name.startsWith('_'))
      .filter((d) => d.isDirectory() || (d.isFile() && /\.md$/i.test(d.name)))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => naturalCompare(a.name, b.name));
  } catch (e) {
    return [];
  }
}

// 递归收集一个目录下的内容块（文章 / 小节），空目录不进结果
function collectBlocks(absDir, relDir, kbSlug) {
  const items = [];
  for (const e of listChapterEntries(absDir)) {
    if (e.isDir) {
      const sub = collectBlocks(path.join(absDir, e.name), relDir + '/' + e.name, kbSlug);
      if (sub.length) {
        items.push({ kind: 'section', name: stripChapterPrefix(e.name), dir: relDir + '/' + e.name, blocks: sub });
      }
    } else {
      const a = parseArticle(kbSlug, relDir, e.name);
      if (a) items.push({ kind: 'article', article: a });
    }
  }
  // 编号：直属文章与子目录在同一个序列里占位
  return items.map((it, i) => {
    if (it.kind === 'article') {
      const article = it.article;
      article.nums = [i + 1];
      return { type: 'article', no: i + 1, nums: [i + 1], article };
    }
    const block = { type: 'section', no: i + 1, nums: [i + 1], name: it.name, dir: it.dir, blocks: it.blocks };
    setBlockNums(block.blocks, block.nums);
    return block;
  });
}

function setBlockNums(blocks, prefix) {
  blocks.forEach((b, i) => {
    b.no = i + 1;
    b.nums = prefix.concat(i + 1);
    if (b.type === 'section') setBlockNums(b.blocks, b.nums);
    else b.article.nums = b.nums;
  });
}

// 按显示顺序把所有文章摊平（用于上/下一篇、统计）
function flattenArticles(blocks, out) {
  out = out || [];
  blocks.forEach((b) => {
    if (b.type === 'article') out.push(b.article);
    else flattenArticles(b.blocks, out);
  });
  return out;
}

// 给块和文章打上「2.4.1」这种显示编号
function assignLabels(blocks, chapterNo) {
  blocks.forEach((b) => {
    b.label = chapterNo + '.' + b.nums.join('.');
    if (b.type === 'section') assignLabels(b.blocks, chapterNo);
    else b.article.num = b.label;
  });
}

// 供模板直出一个数组，避免在 EJS 里写递归：
//   [{ heading: null,          items: [直属文章…] },
//    { heading: {label,name},  items: [小节下的文章…] }, …]
function toRenderGroups(blocks, depth, out) {
  out = out || [];
  let pending = null;
  const flush = () => {
    if (pending) {
      out.push(pending);
      pending = null;
    }
  };
  for (const b of blocks) {
    if (b.type === 'article') {
      if (!pending) pending = { heading: null, depth, items: [] };
      pending.items.push(b.article);
    } else {
      flush();
      const direct = b.blocks.filter((x) => x.type === 'article').map((x) => x.article);
      out.push({ heading: { label: b.label, name: b.name }, depth, items: direct });
      toRenderGroups(
        b.blocks.filter((x) => x.type === 'section'),
        depth + 1,
        out
      );
    }
  }
  flush();
  return out;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function makeExcerpt(body, limit) {
  limit = limit || 104;
  const cleaned = String(body || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}.*$/gm, '')
    .replace(/^>.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\|.*$/gm, '');
  const paras = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  let pick = paras.find((p) => p.replace(/[*`_#>\-\s]/g, '').length >= 22) || paras[0] || '';
  pick = pick.replace(/[*`_]/g, '').trim();
  return pick.length > limit ? pick.slice(0, limit) + '…' : pick;
}

function parseArticle(kbSlug, chapterDir, fileName) {
  const full = path.join(CONTENT_DIR, kbSlug, chapterDir, fileName);
  let raw = '';
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (e) {
    return null;
  }
  const parsed = matter(raw);
  const data = parsed.data || {};
  const body = parsed.content || '';
  const h1Match = body.match(/^\s*#\s+(.+?)\s*$/m);
  const title =
    (data.title && String(data.title).trim()) ||
    (h1Match && h1Match[1].trim()) ||
    fileName.replace(/\.md$/i, '');

  const slug = fileName.replace(/\.md$/i, '');

  // 只统计正文配图数量（用于「配图数」指标）。
  // 卡片缩略图改用「章节.篇序」序号占位，不再截取正文里的图片。
  let imageCount = 0;
  const imgRe = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let imgMatch;
  while ((imgMatch = imgRe.exec(body)) !== null) {
    if (!resolveMediaUrl(kbSlug, chapterDir, imgMatch[1])) continue;
    imageCount += 1;
  }

  // 粗略字数（中文字 + 英文单词），用于显示阅读时长
  const plain = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*`_|!\[\]()\-]/g, ' ');
  const cjk = (plain.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (plain.match(/[A-Za-z0-9]+/g) || []).length;
  const words = cjk + latin;

  return {
    slug,
    file: fileName,
    // 这篇文件自己所在的目录（相对知识库根），可能是「章」也可能是更深的「小节」
    dir: chapterDir,
    title,
    excerpt: makeExcerpt(body),
    imageCount,
    words,
    minutes: Math.max(1, Math.round(words / 400)),
    mtime: (() => {
      try {
        return fs.statSync(full).mtimeMs;
      } catch (e) {
        return 0;
      }
    })(),
    order: data.order != null ? Number(data.order) : null,
    url: BASE + '/kb/' + encodeURIComponent(kbSlug) + '/' + encodeURIComponent(slug)
  };
}

function loadKnowledgeBase(kbDir) {
  const kbPath = path.join(CONTENT_DIR, kbDir);
  const metaRaw =
    readIfExists(path.join(kbPath, '_meta.md')) ||
    readIfExists(path.join(kbPath, '_index.md')) ||
    readIfExists(path.join(kbPath, '_meta.markdown'));
  let meta = {};
  if (metaRaw) meta = matter(metaRaw).data || {};

  const chapters = [];
  for (const chDir of listDirs(kbPath).sort(naturalCompare)) {
    // 章节可以再分子节（见上方 collectBlocks 注释），所以这里收的是「块」而不是平铺的文件
    const blocks = collectBlocks(path.join(kbPath, chDir), chDir, kbDir);
    const articles = flattenArticles(blocks);
    if (!articles.length) continue;
    chapters.push({
      dir: chDir,
      name: stripChapterPrefix(chDir),
      blocks,
      articles
    });
  }
  if (!chapters.length) return null;

  // 全库顺序串一遍，给每篇挂上 上一篇 / 下一篇、所属章节、以及「2.4.1」式的显示编号
  const flat = [];
  chapters.forEach((ch, ci) => {
    assignLabels(ch.blocks, ci + 1);
    ch.render = toRenderGroups(ch.blocks, 0);
    ch.articles.forEach((a) => {
      a.chapterName = ch.name;
      // 注意：a.chapterDir 是这篇文件自己所在的目录（可能比章节更深），别覆盖它 ——
      // 文章页读文件与解析配图路径都要用它。章节顶层目录单独存一份。
      a.chapterRoot = ch.dir;
      flat.push(a);
    });
  });
  flat.forEach((a, i) => {
    a.prev = i > 0 ? flat[i - 1] : null;
    a.next = i < flat.length - 1 ? flat[i + 1] : null;
    a.index = i + 1;
  });

  // 知识库根目录下的一级 .md（主要是 _meta.md）也算「动过这个库」：
  // 只改简介、没动正文时，同样应该顶上「最近更新」。
  const rootMtime = (() => {
    let m = 0;
    try {
      for (const f of fs.readdirSync(kbPath)) {
        if (!/\.md$/i.test(f)) continue;
        try {
          m = Math.max(m, fs.statSync(path.join(kbPath, f)).mtimeMs);
        } catch (e) {
          /* 忽略读不到的文件 */
        }
      }
    } catch (e) {
      /* 目录读不到就当作 0 */
    }
    return m;
  })();

  const updatedAt = flat.reduce((m, a) => Math.max(m, a.mtime || 0), rootMtime);
  const totalWords = flat.reduce((n, a) => n + (a.words || 0), 0);
  const totalImages = flat.reduce((n, a) => n + (a.imageCount || 0), 0);
  const totalMinutes = flat.reduce((n, a) => n + (a.minutes || 0), 0);
  const title = meta.title || stripOrderPrefix(kbDir);

  // 「知识库概述」正文 = 元信息里的简介 + _meta.md 正文（去掉给自己看的引用块备注）
  const metaBody = metaRaw ? String(matter(metaRaw).content || '') : '';
  const overviewSource = [
    meta.description || '',
    metaBody.replace(/^[ \t]*>.*$/gm, '').trim()
  ]
    .filter(Boolean)
    .join('\n\n');
  const overviewHtml = overviewSource
    ? md.render(overviewSource, { kbSlug: kbDir, chapterDir: '', toc: [] })
    : '';

  const first = flat[0] || null;

  return {
    slug: kbDir,
    title,
    description: meta.description || '',
    overviewHtml,
    category: meta.category || '未分类',
    cover: meta.cover || '',
    order: meta.order != null ? Number(meta.order) : 999,
    initial: title.trim().charAt(0) || '书',
    color: colorFor(kbDir),
    updatedAt,
    updatedDate: fmtDate(updatedAt),
    totalWords,
    totalWordsText: fmtCount(totalWords),
    totalImages,
    totalMinutes,
    firstArticle: first
      ? { url: first.url, title: first.title, chapterName: first.chapterName }
      : null,
    chapters,
    articles: flat,
    chapterCount: chapters.length,
    articleCount: flat.length,
    url: BASE + '/kb/' + encodeURIComponent(kbDir)
  };
}

// 分类锚点 id：顶栏的分类导航与主页分组共用同一个 id（见 views/partials/head.ejs）。
// 分类名是中文（"AI 学习" 这类），取不到 ASCII 就退化成 cat-c1 / cat-c2，保证一定有合法 id。
function categoryAnchor(name, n, used) {
  let base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'c' + n;
  let id = 'cat-' + base;
  let i = 2;
  while (used.has(id)) id = 'cat-' + base + '-' + i++;
  used.add(id);
  return id;
}

function loadLibrary() {
  const kbs = listDirs(CONTENT_DIR)
    .map(loadKnowledgeBase)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || naturalCompare(a.title, b.title));

  const groups = [];
  const index = new Map();
  const usedAnchors = new Set();
  for (const kb of kbs) {
    if (!index.has(kb.category)) {
      const group = {
        category: kb.category,
        // 顶栏分类导航跳转用的锚点（主页分组 section 上也有同一个 id）
        id: categoryAnchor(kb.category, groups.length + 1, usedAnchors),
        items: []
      };
      index.set(kb.category, group);
      groups.push(group);
    }
    index.get(kb.category).items.push(kb);
  }

  // 「特色知识库」轮播取用的 3 个：按最后更新时间（该库所有 .md 的 mtime 最大值）倒序。
  // 完全实时 —— 每次请求都重新读盘，改完文件刷新页面即换人，无需任何缓存或配置。
  // 次级排序用 order / 标题，保证同一批 mtime 相同时顺序稳定；
  // 没有文章的新库 updatedAt 为 0，自然排在最后。
  const featuredKbs = kbs
    .slice()
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        a.order - b.order ||
        naturalCompare(a.title, b.title)
    )
    .slice(0, 3);

  return {
    kbs,
    groups,
    featuredKbs,
    stats: {
      kbs: kbs.length,
      chapters: kbs.reduce((n, k) => n + k.chapterCount, 0),
      articles: kbs.reduce((n, k) => n + k.articleCount, 0),
      words: kbs.reduce((n, k) => n + k.totalWords, 0),
      updatedDate: fmtDate(
        kbs.reduce((m, k) => Math.max(m, k.updatedAt || 0), 0)
      )
    }
  };
}

function findKnowledgeBase(lib, slug) {
  return lib.kbs.find((k) => k.slug === slug) || null;
}

function findArticle(kb, slug) {
  for (const ch of kb.chapters) {
    const a = ch.articles.find((x) => x.slug === slug);
    if (a) return { article: a, chapter: ch };
  }
  return null;
}

/* =============================================================
 *  站内搜索
 *  实时扫描，不建索引 —— md 全文体积很小（几十到几百 KB），
 *  一次全站扫描和渲染一个页面差不多。内容多了再说。
 * ============================================================= */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
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

// 把 Markdown 压成便于检索和摘录的纯文本
function plainTextOf(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')      // 代码块整块去掉
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片（链接文字通常是空的或没意义）
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/[|*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 命中的词包成 <mark>，注意先做 HTML 转义，避免把内容当标签渲染
function highlightText(text, terms) {
  const safe = escapeHtml(text);
  if (!terms.length) return safe;
  const pattern = terms.map((t) => escapeRegExp(escapeHtml(t))).join('|');
  try {
    return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
  } catch (e) {
    return safe;
  }
}

// 取第一处命中位置前后的一小段做摘要
function makeSnippet(text, terms, fallback) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) {
    const plain = fallback || text.slice(0, 110);
    return plain.length > 110 ? plain.slice(0, 110) + '…' : plain;
  }
  const start = Math.max(0, at - 36);
  const end = Math.min(text.length, at + 78);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// 多个关键词之间是「且」的关系：都出现才算命中
function searchLibrary(query, lib) {
  const raw = String(query || '').trim();
  const terms = raw.split(/\s+/).filter(Boolean);
  if (!terms.length) return { query: '', terms: [], total: 0, groups: [] };

  const lowered = terms.map((t) => t.toLowerCase());
  const groups = [];
  let total = 0;

  for (const kb of lib.kbs) {
    const hits = [];

    for (const a of kb.articles) {
      const rawFile = readIfExists(path.join(CONTENT_DIR, kb.slug, a.dir, a.file));
      if (rawFile === null) continue;

      const body = plainTextOf(matter(rawFile).content || '');
      const lowerBody = body.toLowerCase();
      // 标题、章节名、知识库名都算「命中」
      const meta = (a.title + ' ' + a.chapterName + ' ' + kb.title).toLowerCase();

      const matchedAll = lowered.every((t) => meta.indexOf(t) !== -1 || lowerBody.indexOf(t) !== -1);
      if (!matchedAll) continue;

      const lowerTitle = a.title.toLowerCase();
      let score = 0;
      for (const t of lowered) {
        if (lowerTitle.indexOf(t) !== -1) score += 100;   // 标题命中权重高
        let from = 0;
        let n = 0;
        while ((from = lowerBody.indexOf(t, from)) !== -1) { n++; from += t.length; }
        score += n;                                        // 正文出现次数也计入
      }

      hits.push({
        title: a.title,
        titleHtml: highlightText(a.title, terms),
        url: a.url,
        chapterName: a.chapterName,
        num: a.num,
        snippetHtml: highlightText(makeSnippet(body, terms, a.excerpt), terms),
        score
      });
    }

    if (hits.length) {
      hits.sort((x, y) => y.score - x.score || naturalCompare(x.title, y.title));
      total += hits.length;
      groups.push({
        kb: { slug: kb.slug, title: kb.title, url: kb.url, color: kb.color, initial: kb.initial },
        hits
      });
    }
  }

  // 命中多的知识库排在前面
  groups.sort((a, b) => b.hits.length - a.hits.length);
  return { query: raw, terms, total, groups };
}

// —— 页面渲染（供本地路由与静态导出共用）——
//
// 每个函数只负责「算出模板要的数据」，不碰 res / 不写盘；
// 本地路由拿它 render 到响应，tools/build-static.js 拿它 render 成字符串写文件。
// 所有模板都会拿到 base，用来拼子路径部署时的绝对地址。

// 渲染一篇文章的正文 HTML（含图片路径改写、标题锚点、目录）
function renderArticleHtml(article) {
  const full = path.join(CONTENT_DIR, article.kbSlug, article.dir, article.file);
  const raw = readIfExists(full);
  if (raw == null) return null;
  const body = (matter(raw).content || '').replace(/^\s*#\s+.+?(\r?\n|$)/, '');
  const env = { kbSlug: article.kbSlug, chapterDir: article.dir, toc: [] };
  const html = md.render(body, env);
  return { html, toc: env.toc };
}

// 统一的模板数据入口：把 base 这类「每个页面都要」的变量补齐。
// 返回纯数据对象，本地路由直接交给 res.render，导出脚本自己渲染。
function viewData(name, data) {
  return Object.assign({ base: BASE, livereload: true }, data);
}

/* =============================================================
 *  服务
 * ============================================================= */

const app = express();
app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);

app.use(BASE + '/public', express.static(PUBLIC_DIR, { maxAge: 0 }));
// 本地运行时 base 为空串，静态路径保持 /public；同时挂一份根路径，
// 免得 basePath 非空时（本地用 PKB_BASE 预演子路径）静态资源取不到。
if (BASE) app.use('/public', express.static(PUBLIC_DIR, { maxAge: 0 }));

app.use(
  BASE + '/media',
  (req, res, next) => {
    if (/\.md$/i.test(req.path)) return res.status(404).end();
    next();
  },
  express.static(CONTENT_DIR, { maxAge: 0 })
);
if (BASE) {
  app.use(
    '/media',
    (req, res, next) => {
      if (/\.md$/i.test(req.path)) return res.status(404).end();
      next();
    },
    express.static(CONTENT_DIR, { maxAge: 0 })
  );
}

// —— 实时刷新通道（SSE）——
const liveClients = new Set();

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      /* 连接已断开 */
    }
  }, 25000);

  liveClients.add(res);
  req.on('close', () => {
    clearInterval(ping);
    liveClients.delete(res);
  });
});

function broadcast(reason) {
  for (const client of liveClients) {
    try {
      client.write('data: ' + (reason || 'reload') + '\n\n');
    } catch (e) {
      liveClients.delete(client);
    }
  }
}

// —— 页面 ——

app.get('/', (req, res) => {
  res.render('home', viewData('home', {
    site,
    page: 'home',
    lib: loadLibrary(),
    pageTitle: site.title
  }));
});

// —— 站内搜索 ——
// 用普通 GET 表单提交，不依赖 JS；没带 q 时就是一张空搜索页
app.get('/search', (req, res) => {
  const lib = loadLibrary();
  const result = searchLibrary(req.query.q, lib);
  res.render('search', viewData('search', {
    site,
    page: 'search',
    lib,
    pageTitle: result.query ? '搜索「' + result.query + '」' : '搜索',
    query: result.query,
    total: result.total,
    groups: result.groups
  }));
});

app.get('/kb/:kb', (req, res) => {
  const lib = loadLibrary();
  const kb = findKnowledgeBase(lib, req.params.kb);
  if (!kb) return render404(res, '找不到这个知识库');
  res.render('kb', viewData('kb', {
    site,
    page: 'kb',
    lib,
    kb,
    pageTitle: kb.title + ' · ' + site.title
  }));
});

app.get('/kb/:kb/:article', (req, res) => {
  const lib = loadLibrary();
  const kb = findKnowledgeBase(lib, req.params.kb);
  if (!kb) return render404(res, '找不到这个知识库');
  const found = findArticle(kb, req.params.article);
  if (!found) return render404(res, '找不到这篇文章');

  const rendered = renderArticleHtml({
    kbSlug: kb.slug,
    dir: found.article.dir,
    file: found.article.file
  });
  if (!rendered) return render404(res, '文章文件读取失败');

  res.render('article', viewData('article', {
    site,
    page: 'article',
    lib,
    kb,
    chapter: found.chapter,
    article: found.article,
    html: rendered.html,
    toc: rendered.toc,
    pageTitle: found.article.title + ' · ' + kb.title
  }));
});

function render404(res, message) {
  res.status(404).render('404', viewData('404', {
    site,
    page: '404',
    lib: loadLibrary(),
    pageTitle: '页面不存在',
    message
  }));
}

app.use((req, res) => render404(res, '这个地址下没有内容'));

/* =============================================================
 *  对外导出（供 tools/build-static.js 复用渲染逻辑）
 * ============================================================= */

module.exports = {
  app,
  site,
  BASE,
  ROOT,
  CONTENT_DIR,
  VIEWS_DIR,
  PUBLIC_DIR,
  loadLibrary,
  loadKnowledgeBase,
  findKnowledgeBase,
  findArticle,
  parseArticle,
  searchLibrary,
  renderArticleHtml,
  viewData,
  escapeHtml,
  highlightText,
  plainTextOf,
  naturalCompare
};

/* =============================================================
 *  文件监听 → 通知浏览器刷新
 *  以下（监听 + 启动服务）只在「直接 node server.js」时执行；
 *  被 tools/build-static.js require 时整段跳过，不会占用端口。
 * ============================================================= */

function startServer() {

const RESTART_CODE = 7;                        // 交给 start.bat 识别的「请重启我」退出码
const SUPERVISED = process.env.PKB_SUPERVISED === '1';

let reloadTimer = null;
function scheduleReload(reason) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast(reason), 120);
}

// 内容、模板、样式：浏览器重新拉一次页面就够了
// （EJS 每次请求都重新渲染，静态资源 maxAge 为 0，不用重启进程）
const watchedDirs = [];
if (fs.existsSync(CONTENT_DIR)) watchedDirs.push([CONTENT_DIR, 'reload']);
if (fs.existsSync(VIEWS_DIR)) watchedDirs.push([VIEWS_DIR, 'reload']);
if (fs.existsSync(PUBLIC_DIR)) watchedDirs.push([PUBLIC_DIR, 'reload']);

for (const [dir, reason] of watchedDirs) {
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    ignored: /(^|[\/\\])\../,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 }
  });
  watcher.on('all', (event, file) => {
    console.log('  文件变化：' + event + '  ' + path.relative(ROOT, file));
    scheduleReload(reason);
  });
}

if (watchedDirs.length) {
  console.log(
    '  已开始监听 ' +
      watchedDirs.map(([d]) => path.relative(ROOT, d) + '/').join('、') +
      '（改动即刷新网页）'
  );
}
if (!fs.existsSync(CONTENT_DIR)) {
  console.log('  ⚠ 没找到 content/ 目录，请先创建并放入你的 Markdown 笔记');
}

// server.js 自己的改动没法靠「刷新网页」生效，必须重启进程。
// 由 start.bat 托管时（它会设 PKB_SUPERVISED=1 并在退出码为 7 时重跑）自动重启；
// 直接 node server.js 启动时没人接得住，只在页面上提示一下。
{
  const selfWatcher = chokidar.watch(__filename, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });
  selfWatcher.on('change', () => {
    if (!SUPERVISED) {
      console.log('');
      console.log('  ⚠ server.js 已改动，但当前不是由 start.bat 启动的，无法自动重启。');
      console.log('    请停掉服务后重新运行 start.bat。');
      broadcast('server-changed');
      return;
    }
    console.log('  server.js 已改动，正在自动重启…');
    broadcast('restart');
    // 先让浏览器收到消息，再断开长连接 —— 否则 server.close() 会一直等 SSE 连接
    setTimeout(() => {
      for (const client of liveClients) {
        try {
          client.end();
        } catch (e) {
          /* 连接已经断了 */
        }
      }
      liveClients.clear();
      server.close(() => process.exit(RESTART_CODE));
      setTimeout(() => process.exit(RESTART_CODE), 600); // 兜底强退
    }, 300);
  });
}

/* =============================================================
 *  启动
 * ============================================================= */

const server = app.listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  console.log('');
  console.log('  ' + site.title + ' 已启动');
  console.log('  ' + url);
  console.log('  改 Markdown / 模板 / 样式，网页都会自动刷新。');
  if (SUPERVISED) {
    console.log('  改 server.js 会自动重启服务（由 start.bat 托管）。');
  } else {
    console.log('  （用 start.bat 启动时，改 server.js 也能自动重启）');
  }
  console.log('  关掉这个黑窗口就等于停止服务（按 Ctrl + C 也可以停止）。');
  console.log('');

  if (process.platform === 'win32' && !process.env.NO_OPEN) {
    exec('start "" "' + url + '"', () => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const url = 'http://localhost:' + PORT;
    console.log('');
    console.log('  端口 ' + PORT + ' 已经被占用。');
    console.log('  可能已经有一个「' + site.title + '」在运行了，我直接帮你打开浏览器。');
    console.log('  如果不是同一个服务，请先关掉占用端口的程序，');
    console.log('  或者换个端口启动：set PORT=3001 && node server.js');
    console.log('');
    if (process.platform === 'win32' && !process.env.NO_OPEN) {
      exec('start "" "' + url + '"', () => {});
    }
    setTimeout(() => process.exit(0), 600);
    return;
  }
  throw err;
});

} // end startServer()

if (require.main === module) startServer();
