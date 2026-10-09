#!/usr/bin/env node
/**
 * 静态导出 —— 把站点的每个页面渲染成真实的 .html，产出可直接托管的 dist/。
 *
 * 为什么需要它：本地站是「服务端实时渲染」（node server.js 每次请求现读 md、现拼 HTML），
 * 而 GitHub Pages 只能托管静态文件、跑不了 Node。这个脚本把 server.js 的渲染逻辑
 * 整套跑一遍，把结果落成文件，Pages 就能像访问普通网站一样访问它。
 *
 * 用法：
 *   node tools/build-static.js                   站点在根目录（配了自定义域名 / 用户页）
 *   node tools/build-static.js --base /wool      站点在子路径（项目页 github.io/<repo>/）
 *   node tools/build-static.js --out dist        指定输出目录
 *
 * ⚠️ --base 必须和「站点实际服务在哪」一致：
 *      配了自定义域名 → 站点在域名根目录 → base 传空
 *      默认项目页     → 站点在 /<仓库名>/ → base 传 /<仓库名>
 *    传错的后果：页面能打开，但所有 CSS/JS/图片 404 —— 只剩裸 HTML，毫无样式。
 *    线上由 .github/workflows/deploy.yml 读取 configure-pages 的 base_path 自动传入。
 *
 * 产出结构（--base /wool 为例）：
 *   dist/
 *     index.html                       首页
 *     search/index.html                搜索页（空壳，由 search.js 前端算）
 *     search-index.json                预生成的搜索索引
 *     kb/<库>/index.html               知识库概览
 *     kb/<库>/<文章>/index.html        每篇文章
 *     404.html
 *     public/**                        静态资源原样拷贝
 *     .nojekyll                        让 Pages 别用 Jekyll 处理（保留下划线目录）
 *
 * ⚠️ 与本地服务的关系：这个脚本不改动任何本地运行的东西。
 *    server.js 照常「改完即刷新」，本脚本只在你要发布时跑。
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

const rawBase = argValue('--base');
// 支持从环境变量读（Actions 里用 PKB_BASE），命令行优先
const BASE = normalizeBase(rawBase != null ? rawBase : process.env.PKB_BASE || '');
const OUT = path.resolve(ROOT, argValue('--out') || 'dist');

function normalizeBase(base) {
  const s = String(base == null ? '' : base).trim();
  if (!s || s === '/') return '';
  return '/' + s.replace(/^\/+|\/+$/g, '');
}

// 告诉 server.js 当前 basePath：必须在 require 之前设好
process.env.PKB_BASE = BASE;

const S = require(path.join(ROOT, 'server.js'));
const {
  site,
  CONTENT_DIR,
  PUBLIC_DIR,
  VIEWS_DIR,
  loadLibrary,
  renderArticleHtml,
  viewData,
  plainTextOf,
  searchLibrary
} = S;

/* ---------------- 工具 ---------------- */

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

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

// 用 EJS 把模板渲染成 HTML 字符串（与 express 的 res.render 同源）
function renderTemplate(name, data) {
  const file = path.join(VIEWS_DIR, name + '.ejs');
  const tpl = fs.readFileSync(file, 'utf8');
  return ejs.render(tpl, data, {
    filename: file,
    root: VIEWS_DIR,
    async: false
  });
}

/* ---------------- 开始 ---------------- */

const t0 = Date.now();
console.log('');
console.log('  静态导出');
console.log('  源目录：' + rel(ROOT));
console.log('  输出：  ' + rel(OUT));
console.log('  base：  ' + (BASE || '(根路径)'));
console.log('');

const lib = loadLibrary();
if (!lib.kbs.length) {
  console.error('  ✗ content/ 里没有可导出的知识库');
  process.exit(1);
}

rmrf(OUT);
mkdirp(OUT);

let pageCount = 0;

/* —— ① 静态资源 —— */
copyDir(PUBLIC_DIR, path.join(OUT, 'public'));

/* —— ② 首页 —— */
writeFile(
  path.join(OUT, 'index.html'),
  renderTemplate('home', viewData('home', {
    site,
    page: 'home',
    lib,
    pageTitle: site.title,
    livereload: false
  }))
);
pageCount++;

/* —— ③ 每个知识库概览 + 每篇文章 —— */
for (const kb of lib.kbs) {
  const kbDir = path.join(OUT, 'kb', kb.slug);

  writeFile(
    path.join(kbDir, 'index.html'),
    renderTemplate('kb', viewData('kb', {
      site,
      page: 'kb',
      lib,
      kb,
      pageTitle: kb.title + ' · ' + site.title,
      livereload: false
    }))
  );
  pageCount++;

  for (const article of kb.articles) {
    const rendered = renderArticleHtml({
      kbSlug: kb.slug,
      dir: article.dir,
      file: article.file
    });
    if (!rendered) {
      console.warn('  ⚠ 跳过读不到的文章：' + kb.slug + '/' + article.file);
      continue;
    }

    // 文章地址是扁平的 /kb/<库>/<文件名>，导出成 <文件名>/index.html，
    // 这样 Pages 上访问 /wool/kb/<库>/<文件名>/ 与原地址完全对应。
    const pageDir = path.join(kbDir, article.slug);
    writeFile(
      path.join(pageDir, 'index.html'),
      renderTemplate('article', viewData('article', {
        site,
        page: 'article',
        lib,
        kb,
        chapter: { name: article.chapterName, dir: article.chapterRoot },
        article,
        html: rendered.html,
        toc: rendered.toc,
        pageTitle: article.title + ' · ' + kb.title,
        livereload: false
      }))
    );
    pageCount++;
  }
}

/* —— ④ 搜索页（空壳 + 前端脚本） —— */
writeFile(
  path.join(OUT, 'search', 'index.html'),
  renderTemplate('search', viewData('search', {
    site,
    page: 'search',
    lib,
    pageTitle: '搜索',
    query: '',
    total: 0,
    groups: [],
    static: true,
    livereload: false
  }))
);
pageCount++;

/* —— ⑤ 搜索索引 —— */
// 每篇文章一条：标题 / 章节 / 编号 / 摘要 / 正文纯文本。
// 结构与本地 searchLibrary 用的一致，前端 search.js 照同一套打分算。
const indexEntries = [];
for (const kb of lib.kbs) {
  for (const article of kb.articles) {
    const full = path.join(CONTENT_DIR, kb.slug, article.dir, article.file);
    let body = '';
    try {
      body = plainTextOf(
        require('gray-matter')(fs.readFileSync(full, 'utf8')).content || ''
      );
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
const indexJson = JSON.stringify(indexEntries);
writeFile(path.join(OUT, 'search-index.json'), indexJson);

/* —— ⑥ 404 页 —— */
writeFile(
  path.join(OUT, '404.html'),
  renderTemplate('404', viewData('404', {
    site,
    page: '404',
    lib,
    pageTitle: '页面不存在',
    message: '这个地址下没有内容',
    livereload: false
  }))
);

/* —— ⑦ .nojekyll —— */
// GitHub Pages 默认会用 Jekyll 处理站点，会忽略下划线开头的文件/目录。
// 我们没有需要 Jekyll 的东西，放一个空文件让它彻底跳过。
writeFile(path.join(OUT, '.nojekyll'), '');

/* —— 完成 —— */

const size = (function du(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return n;
})(OUT);

const fmt = (n) =>
  n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

console.log('  ✓ 页面 ' + pageCount + ' 个');
console.log('  ✓ 搜索索引 ' + indexEntries.length + ' 条（' + fmt(Buffer.byteLength(indexJson)) + '）');
console.log('  ✓ 总体积 ' + fmt(size));
console.log('  ✓ 用时 ' + (Date.now() - t0) + ' ms');
console.log('');
console.log('  输出目录：' + OUT);
console.log('');
