'use strict';

// Adds source-location hints (file:line) to every issue in a grade. Reads the project, never runs it.

const fs = require('fs');
const path = require('path');

const EXT = /\.(tsx|jsx|ts|js|mjs|vue|astro|svelte|html|css|scss|sass|less)$/i;
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.design-grade', '.astro', '.angular', '.next', 'coverage', '.powerpages-site', '.vite', 'docs', 'tests', '__tests__', 'e2e']);

const THEME_PATTERNS = {
  color: /--color[\w-]*\s*:|:root\s*\{/,
  font: /font-family\s*:|--font[\w-]*\s*:|fonts\.googleapis\.com|@font-face/,
  spacing: /--(space|spacing|gap)[\w-]*\s*:|(^|[;{\s])(padding|gap|margin)\s*:/,
  radius: /--radius[\w-]*\s*:|border-radius\s*:/,
  shadow: /--shadow[\w-]*\s*:|box-shadow\s*:/,
  focus: /outline\s*:\s*(none|0)\b|:focus(-visible)?/,
  motion: /@keyframes|animation\s*:|prefers-reduced-motion|transition\s*:/,
  head: /<meta\s|<title>|<html[\s>]|<link\s+rel=/,
  typeScale: /--(text|fs|font-size)[\w-]*\s*:|(^|[;{\s])font-size\s*:/,
  lineHeight: /line-height\s*:/,
  measure: /(^|[;{])\s*max-width\s*:|max-w-/,
  overflow: /overflow(-x|-y)?\s*:\s*(hidden|clip)\b/,
};

const ISSUE_THEME = {
  'ACC-01': ['color'], 'CLR-01': ['color'], 'CLR-02': ['color'], 'AES-02': ['color'], 'AES-03': ['color'], 'J-09': ['color'], 'J-12': ['color'],
  'TYP-02': ['typeScale'], 'TYP-03': ['typeScale'], 'TYP-04': ['lineHeight'], 'TYP-05': ['measure'], 'TYP-06': ['font'], 'TYP-07': ['font'], 'TYP-09': ['font'], 'TYP-08': ['typeScale'], 'AES-01': ['font'], 'PRF-02': ['font'],
  'RES-05': ['typeScale'],
  'LAY-01': ['spacing'], 'LAY-02': ['radius'], 'LAY-03': ['shadow'], 'J-04': ['spacing'],
  'ACC-08': ['focus'], 'ACC-09': ['motion'], 'AES-04': ['motion'], 'INT-01': ['motion'],
  'RES-02': ['head'], 'RES-01': ['overflow'], 'RES-04': ['overflow'], 'ACC-07': ['head'], 'ACC-12': ['head'], 'CON-03': ['head'],
};

const isStyle = (f) => /\.(css|scss|sass|less)$/i.test(f.rel);

// Files whose name matches the route ("/students" → Students.tsx) are the most likely owners of an instance.
function routeFirst(hits, route) {
  const seg = (route || '').split('/').filter(Boolean).pop();
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = seg ? norm(seg) : 'home';
  const score = (h) => (norm(h.file.split('/').pop().replace(/\.\w+$/, '')).includes(key) || (!seg && /(^|\/)(home|index|app)\.\w+$/i.test(h.file)) ? 0 : 1);
  return [...hits].sort((a, b) => score(a) - score(b));
}

function walk(dir, out, depth = 0) {
  if (depth > 8 || out.length > 3000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') { if (IGNORE_DIRS.has(e.name) || e.isDirectory()) continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) walk(p, out, depth + 1); }
    else if (e.isFile() && EXT.test(e.name)) {
      try { if (fs.statSync(p).size < 1_000_000) out.push(p); } catch { /* skip */ }
    }
  }
}

function loadFiles(root) {
  const files = [];
  walk(root, files);
  return files
    .filter((f) => !/\.(min|bundle)\.js$/.test(f) && !/(^|[\\/])(vite|astro|angular|tsconfig|eslint|postcss|tailwind)\.config/.test(f))
    .map((f) => ({ rel: path.relative(root, f).split(path.sep).join('/'), lines: fs.readFileSync(f, 'utf8').split('\n') }));
}

function findLines(files, test, max = 3) {
  const hits = [];
  for (const f of files) {
    for (let i = 0; i < f.lines.length; i++) {
      if (test(f.lines[i])) { hits.push({ file: f.rel, line: i + 1, match: f.lines[i].trim().slice(0, 140) }); break; }
    }
    if (hits.length >= max) break;
  }
  return hits;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tokensFromSelector(sel) {
  const toks = [];
  for (const m of (sel || '').matchAll(/[#.]((?:\\.|[\w-])+)/g)) {
    const t = m[1].replace(/\\(.)/g, '$1');
    if (t.length >= 3 && !/^\d/.test(t)) toks.push(t);
  }
  return [...new Set(toks)];
}

function hintsForInstance(files, inst) {
  const quoted = (inst.detail || '').match(/"([^"]{6,})"/);
  if (quoted && /^(CON|J-11)/.test(inst._id || '')) {
    const needle = quoted[1].replace(/…$/, '').slice(0, 30).trim();
    const hit = findLines(files, (l) => l.includes(needle), 2);
    if (hit.length) return hit.map((h) => ({ ...h, reason: `text "${needle}"` }));
  }
  const toks = tokensFromSelector(inst.selector);
  let best = null;
  for (const t of toks) {
    const re = new RegExp(`(^|[^\\w-])${escapeRe(t)}([^\\w-]|$)`);
    const hits = findLines(files, (l) => re.test(l), 6);
    if (hits.length && (!best || hits.length < best.hits.length)) best = { t, hits };
  }
  if (best) return routeFirst(best.hits, inst.route).slice(0, 2).map((h) => ({ ...h, reason: `selector token "${best.t}"` }));
  if (quoted) {
    const needle = quoted[1].slice(0, 30).trim();
    const hit = findLines(files, (l) => l.includes(needle), 2);
    return hit.map((h) => ({ ...h, reason: `text "${needle}"` }));
  }
  return [];
}

// Clipping/overflow rules: rank `overflow: hidden|clip` rules by whether their CSS selector shares a token with the affected elements.
function overflowRules(files, issue) {
  const toks = new Set(issue.instances.flatMap((x) => [...tokensFromSelector(x.selector), ...((x.selector || '').match(/\b[a-z][a-z0-9-]{2,}\b/g) || [])]).map((t) => t.toLowerCase()));
  const hits = [];
  for (const f of files.filter(isStyle)) {
    f.lines.forEach((line, idx) => {
      if (!THEME_PATTERNS.overflow.test(line)) return;
      let sel = '';
      for (let j = idx; j >= 0 && j >= idx - 30; j--) if (f.lines[j].includes('{')) { sel = f.lines[j].split('{')[0].trim(); break; }
      const selToks = (sel.toLowerCase().match(/[a-z][a-z0-9_-]*/g) || []);
      const score = selToks.filter((t) => [...toks].some((k) => t === k || t.startsWith(`${k}-`) || t.endsWith(`-${k}`))).length;
      hits.push({ file: f.rel, line: idx + 1, match: `${sel} { ${line.trim()} }`.slice(0, 140), reason: score ? `overflow rule on a related selector` : 'overflow rule', score });
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line).filter((h, i) => h.score > 0 || i < 1).slice(0, 2);
}

function locate(grade, root) {
  const files = loadFiles(root);
  for (const issue of grade.issues) {
    const hints = [];
    const seen = new Set();
    const push = (h) => { const k = `${h.file}:${h.line}`; if (!seen.has(k) && hints.length < 5) { seen.add(k); hints.push(h); } };
    if (['RES-01', 'RES-04'].includes(issue.id)) overflowRules(files, issue).forEach(({ score, ...h }) => push(h));
    for (const kind of (ISSUE_THEME[issue.id] || []).filter((k) => k !== 'overflow')) {
      const ordered = kind === 'head' ? files.filter((f) => /\.html$/i.test(f.rel)) : files.filter(isStyle).concat(files.filter((f) => !isStyle(f)));
      findLines(ordered, (l) => THEME_PATTERNS[kind].test(l), 2).forEach((h) => push({ ...h, reason: `${kind} definition` }));
    }
    for (const inst of issue.instances.slice(0, 6)) hintsForInstance(files, { ...inst, _id: issue.id }).forEach(push);
    issue.sourceHints = hints;
  }
  grade.projectRoot = root;
  return grade;
}


module.exports = { locate, tokensFromSelector };
