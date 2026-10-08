#!/usr/bin/env node
/**
 * 内容体检 —— 扫 content/ 下所有 Markdown，把「静默失败」的地方找出来。
 *
 * 现在这四类问题在页面上都是悄悄跳过、不会报错的：
 *   1) 引用了但文件不存在的本地图片  → 页面上一张破图 / 一片空白
 *   2) 失效的站内链接                → 点进去是 404
 *   3) 孤儿图片                      → 躺在 assets/ 里，没有任何文章引用
 *   4) 知识库缺 _meta.md             → 整个知识库不会出现在首页
 *
 * 用法：node tools/check-content.js     （或双击根目录的 check.bat）
 * 退出码：全部通过 = 0；发现问题 = 1（方便以后接进自动化）。
 *
 * ⚠️ 下面两处是 server.js 的「副本」，改 server.js 时记得一起改：
 *    - slugifyHeading()  —— 标题转锚点 id（右侧目录 / 页内跳转靠它）
 *    - URL 规则          —— 文章地址是扁平的 /kb/<库>/<文件名>，不带小节目录
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const PUBLIC = path.join(ROOT, 'public');

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'];

/* ---------------- 与 server.js 保持一致的判定 ---------------- */

function slugifyHeading(text) {
  const s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .replace(/^-+|-+$/g, '');
  return s || 'section';
}

function isExternal(u) {
  return /^[a-z][a-z0-9+.-]*:/i.test(u) || /^\/\//.test(u);
}

function decodeOnce(u) {
  try {
    return decodeURIComponent(u);
  } catch (e) {
    return u; // 已经是干净路径
  }
}

/* ---------------- 小工具 ---------------- */

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function isImageFile(p) {
  return IMAGE_EXT.includes(path.extname(p).toLowerCase());
}

/* 把 md 里写的目标解析成绝对路径；返回 null 表示「不是本地文件」（站外 / 站点路由） */
function toAbsPath(target, mdDir) {
  const clean = target.split('#')[0].split('?')[0];
  if (!clean || isExternal(clean)) return null;
  if (clean.startsWith('/media/')) {
    return path.join(CONTENT, decodeOnce(clean.slice('/media/'.length)));
  }
  if (clean.startsWith('/public/')) {
    return path.join(PUBLIC, decodeOnce(clean.slice('/public/'.length)));
  }
  if (clean.startsWith('/')) return null; // 站点路由，不是文件
  return path.resolve(mdDir, decodeOnce(clean));
}

/* 先把代码块和行内代码挖掉，再找图片 / 链接。
   必须这么做：像「怎么写 Markdown」这种文章里，示例本身长得就是
   ![](图片地址) 和 `[点这里](网址)`，但它们渲染出来只是文字，不是链接。
   markdown-it 也是这么处理的，不挖掉就会误报。 */
function stripCode(body) {
  return body
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/* 正文里所有标题的锚点 id（跳过代码块里的 # ） */function headingIds(body) {
  const ids = new Set();
  const used = Object.create(null);
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const text = m[2].replace(/[*`]/g, '').trim();
    let id = slugifyHeading(text);
    if (used[id]) {
      used[id] += 1;
      id = id + '-' + used[id];
    } else {
      used[id] = 1;
    }
    ids.add(id);
  }
  return ids;
}

/* ---------------- 建立知识库索引 ---------------- */

if (!fs.existsSync(CONTENT)) {
  console.log('【错误】没找到 content/ 目录：' + CONTENT);
  process.exit(1);
}

const kbIndex = new Map();
let kbDirs = [];
try {
  kbDirs = fs
    .readdirSync(CONTENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
} catch (e) {
  console.log('【错误】读不了 content/ 目录：' + e.message);
  process.exit(1);
}

for (const kb of kbDirs) {
  const dir = path.join(CONTENT, kb);
  const metaFile = path.join(dir, '_meta.md');
  const hasMeta = fs.existsSync(metaFile);
  let category = '未分类';
  if (hasMeta) {
    try {
      const data = matter(fs.readFileSync(metaFile, 'utf8')).data || {};
      if (data.category) category = String(data.category).trim();
    } catch (e) {
      /* frontmatter 坏了，按未分类算 */
    }
  }
  const articles = new Set();
  for (const f of walk(dir)) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    if (path.basename(f) === '_meta.md') continue;
    articles.add(path.basename(f).replace(/\.md$/i, ''));
  }
  kbIndex.set(kb, { hasMeta, category, articles, dir });
}

/* 首页顶栏的分类锚点（与 server.js 的 categoryAnchor 同一套算法） */
const catAnchors = new Set();
{
  const used = new Set();
  const seen = [];
  for (const info of kbIndex.values()) {
    if (!seen.includes(info.category)) seen.push(info.category);
  }
  seen.forEach((c, i) => {
    let base = String(c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base) base = 'c' + (i + 1);
    let id = 'cat-' + base;
    let n = 2;
    while (used.has(id)) id = 'cat-' + base + '-' + n++;
    used.add(id);
    catAnchors.add(id);
  });
}

/* ---------------- 开始扫描 ---------------- */

const IMG_MD = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const IMG_HTML = /<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
const LINK_MD = /(?<!!)\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const LINK_HTML = /<a\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi;

const mdFiles = walk(CONTENT).filter((f) => f.toLowerCase().endsWith('.md'));
const missingImages = []; // { file, asWritten, expectAbs }
const brokenLinks = []; // { file, href, reason }
const missingMeta = [];
const externalByFile = []; // 站外配图（不报错，只是提示）
const referenced = new Set(); // 被引用到的图片绝对路径（用于查孤儿）
const stats = {
  files: mdFiles.length,
  images: 0,
  links: 0,
  externalImages: 0,
  externalLinks: 0,
  anchors: 0
};

for (const file of mdFiles) {
  const shown = rel(file);
  const mdDir = path.dirname(file);
  let body = '';
  try {
    body = matter(fs.readFileSync(file, 'utf8')).content || '';
  } catch (e) {
    brokenLinks.push({ file: shown, href: '(文件读不了)', reason: e.message });
    continue;
  }

  const heads = headingIds(body);
  // 只有它用来找图片 / 链接：代码里的示例不算
  const scan = stripCode(body);

  /* —— 图片 —— */
  const imgTargets = [];
  let m;
  IMG_MD.lastIndex = 0;
  while ((m = IMG_MD.exec(scan)) !== null) imgTargets.push(m[1]);
  IMG_HTML.lastIndex = 0;
  while ((m = IMG_HTML.exec(scan)) !== null) imgTargets.push(m[1]);

  let externalImagesHere = 0;
  for (const src of imgTargets) {
    stats.images++;
    if (isExternal(src)) {
      stats.externalImages++;
      externalImagesHere++;
      continue;
    }
    const abs = toAbsPath(src, mdDir);
    if (!abs) {
      missingImages.push({
        file: shown,
        asWritten: src,
        expectAbs: '（不是 /media/、/public/，也不是相对路径）'
      });
      continue;
    }
    referenced.add(path.resolve(abs));
    if (!fs.existsSync(abs)) {
      missingImages.push({ file: shown, asWritten: src, expectAbs: rel(abs) });
    }
  }

  /* —— 链接 —— */
  const hrefs = [];
  LINK_MD.lastIndex = 0;
  while ((m = LINK_MD.exec(scan)) !== null) hrefs.push(m[1]);
  LINK_HTML.lastIndex = 0;
  while ((m = LINK_HTML.exec(scan)) !== null) hrefs.push(m[1]);

  const reasons = new Map(); // href -> reason（同一文件里同一个链接只报一次）
  for (const href of hrefs) {
    if (!href) continue;
    stats.links++;
    if (isExternal(href)) {
      stats.externalLinks++;
      continue;
    }

    let reason = null;

    if (href.startsWith('#')) {
      /* 页内锚点：标题必须真的存在 */
      stats.anchors++;
      const id = decodeOnce(href.slice(1));
      if (id && !heads.has(id)) reason = '本页没有这个标题锚点（' + id + '）';
    } else if (href.startsWith('/#')) {
      stats.anchors++;
      const id = href.slice(2);
      if (!catAnchors.has(id)) reason = '主页没有这个分类锚点（' + id + '）';
    } else if (/^\/search(\?|#|$)/.test(href) || href === '/') {
      /* 站内固定页面，一定存在 */
    } else if (href.startsWith('/kb/')) {
      const parts = href.split('#')[0].split('?')[0].split('/').filter(Boolean);
      const kb = decodeOnce(parts[1] || '');
      const info = kbIndex.get(kb);
      if (!info) {
        reason = '没有这个知识库（content/' + kb + '/）';
      } else if (parts.length === 2) {
        /* /kb/<库> —— 概览页，存在 */
      } else if (parts.length === 3) {
        const slug = decodeOnce(parts[2]);
        if (!info.articles.has(slug)) reason = '这个知识库里没有这篇文章（' + slug + '）';
      } else {
        reason = '地址层级不对，文章地址是扁平的 /kb/<知识库>/<文件名>';
      }
    } else if (href.startsWith('/media/') || href.startsWith('/public/')) {
      const abs = toAbsPath(href, mdDir);
      if (abs) {
        referenced.add(path.resolve(abs));
        if (!fs.existsSync(abs)) reason = '文件不存在（' + rel(abs) + '）';
      }
    } else if (href.startsWith('/')) {
      reason = '不是本站已知的路由（只有 / 、/search 、/kb/... 、/media/... 、/public/...）';
    } else {
      /* 相对链接：当成本地文件校验 */
      const abs = toAbsPath(href, mdDir);
      if (abs && !fs.existsSync(abs)) reason = '文件不存在（' + rel(abs) + '）';
    }

    if (reason && !reasons.has(href)) reasons.set(href, reason);
  }
  for (const [href, reason] of reasons) {
    brokenLinks.push({ file: shown, href, reason });
  }

  if (externalImagesHere) externalByFile.push({ file: shown, n: externalImagesHere });
}

/* —— 孤儿图片：content/ 里躺着但没人引用 —— */
const orphans = [];
for (const f of walk(CONTENT)) {
  if (!isImageFile(f)) continue;
  if (!referenced.has(path.resolve(f))) orphans.push(rel(f));
}
orphans.sort();

/* —— 缺 _meta.md —— */
for (const [kb, info] of kbIndex) {
  if (!info.hasMeta) missingMeta.push('content/' + kb + '/');
}

/* ---------------- 输出 ---------------- */

const out = [];
const say = (s) => out.push(s);

say('');
say('内容体检 · ' + CONTENT);
say('');

if (missingImages.length) {
  say('【缺失图片】' + missingImages.length + ' 处 —— 页面上是破图或空白');
  for (const it of missingImages) {
    say('  ' + it.file);
    say('      引用：' + it.asWritten);
    say('      应为：' + it.expectAbs);
  }
  say('');
}

if (brokenLinks.length) {
  say('【失效链接】' + brokenLinks.length + ' 处 —— 点进去是 404');
  for (const it of brokenLinks) {
    say('  ' + it.file);
    say('      ' + it.href + '   → ' + it.reason);
  }
  say('');
}

if (missingMeta.length) {
  say('【缺少 _meta.md】' + missingMeta.length + ' 个知识库 —— 不会出现在首页');
  for (const d of missingMeta) say('  ' + d);
  say('');
}

if (orphans.length) {
  say('【孤儿图片】' + orphans.length + ' 个 —— 没有任何文章引用，可考虑删除');
  for (const o of orphans) say('  ' + o);
  say('');
}

if (externalByFile.length) {
  say('【提示·站外配图】' + stats.externalImages + ' 张（不影响本地打开，但断网或对方站点挂掉就会裂）');
  for (const it of externalByFile) say('  ' + it.file + '   ' + it.n + ' 张');
  say('  想彻底本地化：把图下载到该章 assets/ 下，再把地址改成 ./assets/<文件名>。');
  say('');
}

const trouble = missingImages.length + brokenLinks.length + missingMeta.length;

if (trouble === 0) {
  say('【结论】没发现问题。');
} else {
  say('【结论】共发现 ' + trouble + ' 处问题（见上）。');
}
say(
  '扫描：' +
    stats.files +
    ' 个 Markdown · ' +
    stats.images +
    ' 个图片引用（其中站外 ' +
    stats.externalImages +
    '）· ' +
    stats.links +
    ' 个链接（其中站外 ' +
    stats.externalLinks +
    '、页内锚点 ' +
    stats.anchors +
    '）'
);
say('');

console.log(out.join('\n'));
process.exitCode = trouble === 0 ? 0 : 1;
