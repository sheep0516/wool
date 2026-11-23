#!/usr/bin/env node
/**
 * 离线导出 —— 把整个站导出成「一堆纯 .html」，双击 index.html 就能看。
 *
 * 与 tools/build-static.js 的区别（那一个是给 GitHub Pages 用的）：
 *   · build-static：所有地址是站内绝对路径（/public/x.css、/kb/a/b/），
 *     必须挂在网站根目录下才正常 —— 用 file:// 直接打开会全部 404。
 *   · build-offline：把每个页面里的地址改写成「从本页出发的相对路径」，
 *     目录地址补成 index.html（file:// 下目录打不开），
 *     并把搜索索引内联成 JS（file:// 不允许 fetch 本地文件）。
 *     结果：不装 Node、不起服务器，双击就能读，拷给别人也能读（图片在外站，需联网）。
 *
 * 用法：
 *   node tools/build-offline.js --out "D:/某个文件夹"
 *   node tools/build-offline.js                  # 默认输出到项目下 offline/
 *
 * ⚠️ 只删除输出目录里「本脚本认识的」那几项（index.html / kb / search / public / …），
 *    目录里其它文件一律原样保留，不会误删你放进去的东西。
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.resolve(__dirname, '..');

/* ---------------- 参数 ---------------- */

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const OUT = path.resolve(argValue('--out') || path.join(ROOT, 'offline'));

if (OUT === ROOT || ROOT.startsWith(OUT + path.sep)) {
  console.error('  ✗ 输出目录不能是项目根目录或它的上级：' + OUT);
  process.exit(1);
}

// server.js 在 require 的那一刻读 PKB_BASE 定 basePath。
// 这里先按「根绝对路径」渲染，导出后统一改写 —— 只有一个改写点，
// 免得每层目录都去算一遍前缀。
process.env.PKB_BASE = '';

const S = require(path.join(ROOT, 'server.js'));
const {
  site,
  CONTENT_DIR,
  PUBLIC_DIR,
  VIEWS_DIR,
  loadLibrary,
  renderArticleHtml,
  viewData,
  plainTextOf
} = S;

/* ---------------- 工具 ---------------- */

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(absPath, content) {
  mkdirp(path.dirname(absPath));
  fs.writeFileSync(absPath, content, 'utf8');
}

function copyDir(src, dest) {
  mkdirp(dest);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 输出目录里属于本脚本产出的顶层项；清理时只动这些
const OWNED = ['index.html', '404.html', 'kb', 'search', 'public', 'search-index.json', 'search-index.js'];

function cleanOut() {
  if (!fs.existsSync(OUT)) {
    mkdirp(OUT);
    return [];
  }
  const entries = fs.readdirSync(OUT);
  const strangers = entries.filter((e) => !OWNED.includes(e));
  for (const e of entries) {
    if (OWNED.includes(e)) fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
  }
  return strangers;
}

/* ---------------- 地址改写：站内绝对路径 → 相对本页的相对路径 ---------------- */

function pathPrefix(fromDir) {
  const r = path.relative(fromDir, OUT).replace(/\\/g, '/');
  return r === '' ? '.' : r;
}

function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch (e) {
    return p;
  }
}

// 反过来：磁盘上的中文名要变回百分号编码写进 HTML —— 空格、#、? 这些字符
// 留着裸写会踩坑（# 会被当锚点、? 会被当查询串），逐段编码最稳。
function encodeRel(r) {
  return r
    .split('/')
    .map((seg) => (seg === '.' || seg === '..' ? seg : encodeURIComponent(seg)))
    .join('/');
}

// /kb/%E5%9B%BE.../ → 相对本页的 ../../kb/图标.../index.html
function toLocal(url, fromDir) {
  if (!url || url.charAt(0) !== '/' || url.charAt(1) === '/') return url;
  const m = /^([^?#]*)([?#][\s\S]*)?$/.exec(url);
  let p = m[1] || '/';
  const suffix = m[2] || '';
  if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]{2,5}$/i.test(p)) p += '/index.html';
  // 磁盘上存的是中文原名，URL 里是百分号编码 → 比路径前先解码
  const abs = path.join(OUT, decodePath(p));
  let r = path.relative(fromDir, abs).replace(/\\/g, '/');
  if (!r.startsWith('.')) r = './' + r;
  return encodeRel(r) + suffix;
}

function rewriteHtml(html, pageRel) {
  const fromDir = path.dirname(path.join(OUT, pageRel));
  let out = html.replace(/(\s(?:href|src|action)=")(\/[^"]*)(")/gi, (m, pre, u, post) =>
    pre + toLocal(u, fromDir) + post
  );
  out = out.replace(/(\ssrcset=")([^"]*)(")/gi, (m, pre, val, post) => {
    const parts = val.split(',').map((part) => {
      const bits = part.trim().split(/\s+/);
      bits[0] = toLocal(bits[0], fromDir);
      return bits.join(' ');
    });
    return pre + parts.join(', ') + post;
  });
  out = out.replace(/url\((['"]?)(\/[^'")]*)\1\)/gi, (m, q, u) => 'url(' + q + toLocal(u, fromDir) + q + ')');
  return out;
}

// 搜索引擎页：把内联配置改成离线形态（相对 base、内联索引、补 index.html）
function patchSearchPage(html, pageRel) {
  const prefix = pathPrefix(path.dirname(path.join(OUT, pageRel)));
  let out = html.replace(/(window\.__SEARCH__\s*=\s*\{)/, '$1\n    offline: true,');
  out = out.replace(/(\bbase\s*:\s*)"[^"]*"/, '$1' + JSON.stringify(prefix));
  out = out.replace(/(\bindex\s*:\s*)"[^"]*"/, '$1' + JSON.stringify(prefix + '/search-index.json'));
  out = out.replace(
    /(<script src="[^"]*\/public\/search\.js"><\/script>)/,
    '<script src="' + prefix + '/search-index.js"></script>\n$1'
  );
  return out;
}

function renderTemplate(name, data) {
  const file = path.join(VIEWS_DIR, name + '.ejs');
  const tpl = fs.readFileSync(file, 'utf8');
  return ejs.render(tpl, data, { filename: file, root: VIEWS_DIR, async: false });
}

/* ---------------- 开始 ---------------- */

const t0 = Date.now();
console.log('');
console.log('  离线导出（纯 HTML，双击即看）');
console.log('  源目录：' + ROOT);
console.log('  输出：  ' + OUT);
console.log('');

const lib = loadLibrary();
if (!lib.kbs.length) {
  console.error('  ✗ content/ 里没有可导出的知识库');
  process.exit(1);
}

const strangers = cleanOut();
if (strangers.length) {
  console.log('  ⚠ 目录里还有不属于本脚本的内容，已原样保留：' + strangers.join('、'));
  console.log('');
}

const pages = []; // { rel, html }
let articleCount = 0;

pages.push({
  rel: 'index.html',
  html: renderTemplate('home', viewData('home', {
    site, page: 'home', lib, pageTitle: site.title, livereload: false
  }))
});

for (const kb of lib.kbs) {
  pages.push({
    rel: 'kb/' + kb.slug + '/index.html',
    html: renderTemplate('kb', viewData('kb', {
      site, page: 'kb', lib, kb,
      pageTitle: kb.title + ' · ' + site.title, livereload: false
    }))
  });

  for (const article of kb.articles) {
    const rendered = renderArticleHtml({ kbSlug: kb.slug, dir: article.dir, file: article.file });
    if (!rendered) {
      console.warn('  ⚠ 跳过读不到的文章：' + kb.slug + '/' + article.file);
      continue;
    }
    pages.push({
      rel: 'kb/' + kb.slug + '/' + article.slug + '/index.html',
      html: renderTemplate('article', viewData('article', {
        site, page: 'article', lib, kb,
        chapter: { name: article.chapterName, dir: article.chapterRoot },
        article, html: rendered.html, toc: rendered.toc,
        pageTitle: article.title + ' · ' + kb.title, livereload: false
      }))
    });
    articleCount++;
  }
}

pages.push({
  rel: 'search/index.html',
  html: renderTemplate('search', viewData('search', {
    site, page: 'search', lib, pageTitle: '搜索',
    query: '', total: 0, groups: [], static: true, livereload: false
  }))
});

pages.push({
  rel: '404.html',
  html: renderTemplate('404', viewData('404', {
    site, page: '404', lib, pageTitle: '页面不存在',
    message: '这个地址下没有内容', livereload: false
  }))
});

/* —— 搜索索引 —— */
const indexEntries = [];
for (const kb of lib.kbs) {
  for (const article of kb.articles) {
    const full = path.join(CONTENT_DIR, kb.slug, article.dir, article.file);
    let body = '';
    try {
      body = plainTextOf(require('gray-matter')(fs.readFileSync(full, 'utf8')).content || '');
    } catch (e) {
      body = '';
    }
    indexEntries.push({
      kb: kb.slug,
      kbTitle: kb.title,
      kbColor: kb.color,
      kbInitial: kb.initial,
      url: article.url,
      title: article.title,
      chapter: article.chapterName,
      num: article.num,
      excerpt: article.excerpt,
      text: body
    });
  }
}

/* —— 写盘 —— */
const searchDir = path.join(OUT, 'search');
for (const page of pages) {
  let html = rewriteHtml(page.html, page.rel);
  if (page.rel === 'search/index.html') html = patchSearchPage(html, page.rel);
  writeFile(path.join(OUT, page.rel), html);
}

// 索引里的文章地址也要改成本页相对的（搜索页在 search/ 下）
const indexForJson = indexEntries.map((e) =>
  Object.assign({}, e, { url: toLocal(e.url, searchDir) })
);
const indexJson = JSON.stringify(indexForJson);
writeFile(path.join(OUT, 'search-index.json'), indexJson);
writeFile(
  path.join(OUT, 'search-index.js'),
  '/* 离线版搜索索引：由 tools/build-offline.js 生成。\n' +
  '   file:// 下浏览器不允许 fetch 本地 json，所以把同一份数据写成 JS 内联。 */\n' +
  'window.__PKB_SEARCH_INDEX__ = ' + indexJson + ';\n'
);

copyDir(PUBLIC_DIR, path.join(OUT, 'public'));

/* —— 自检：每个页面里的站内链接是否都指向真实存在的文件 —— */
const broken = [];
let linkCount = 0;

function checkUrl(pageAbs, u) {
  if (!u || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(u)) return;
  linkCount++;
  const bare = decodePath(u.split('#')[0].split('?')[0]);
  if (!bare) return;
  const abs = path.resolve(path.dirname(pageAbs), bare);
  if (!fs.existsSync(abs)) {
    broken.push(path.relative(OUT, pageAbs).replace(/\\/g, '/') + ' → ' + u);
  }
}

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.html$/i.test(e.name)) continue;
    const html = fs.readFileSync(p, 'utf8');
    let m;
    // href / src / action：值一律读到引号为止（文件名里可能有空格）
    const attrRe = /\s(href|src|action)="([^"]*)"/gi;
    while ((m = attrRe.exec(html))) checkUrl(p, m[2]);
    // srcset：逗号分隔，每段是「地址 描述符」
    const srcsetRe = /\ssrcset="([^"]*)"/gi;
    while ((m = srcsetRe.exec(html))) {
      m[1].split(',').forEach((part) => checkUrl(p, part.trim().split(/\s+/)[0]));
    }
    // 行内样式里的 url(...)
    const urlRe = /url\(\s*['"]?([^'")]+)/gi;
    while ((m = urlRe.exec(html))) checkUrl(p, m[1]);
  }
})(OUT);

/* —— 汇总 —— */
const size = (function du(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return n;
})(OUT);

const fmt = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');

console.log('  ✓ 页面 ' + pages.length + ' 个（知识库 ' + lib.kbs.length + ' 个 · 文章 ' + articleCount + ' 篇）');
console.log('  ✓ 搜索索引 ' + indexEntries.length + ' 条（json + 内联 js 各一份）');
console.log('  ✓ 站内链接 ' + linkCount + ' 条，失效 ' + broken.length + ' 条');
broken.slice(0, 10).forEach((b) => console.log('      ✗ ' + b));
console.log('  ✓ 总体积 ' + fmt(size));
console.log('  ✓ 用时 ' + (Date.now() - t0) + ' ms');
console.log('');
console.log('  打开：' + path.join(OUT, 'index.html'));
console.log('');
