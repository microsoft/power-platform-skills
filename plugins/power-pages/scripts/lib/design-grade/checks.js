'use strict';

// Pure, deterministic mapping: evidence.json → auto-detected issues.
// Every threshold lives here and is documented in references/catalog.json. No randomness, no I/O.

const { loadCatalog } = require('./catalog');
const { parseColor, extractColors, toHsl, isChromatic, isNearWhite, clusterColors, toHex } = require('./color');

const AXE_MAP = {
  'color-contrast': 'ACC-01',
  'image-alt': 'ACC-02', 'role-img-alt': 'ACC-02', 'svg-img-alt': 'ACC-02', 'input-image-alt': 'ACC-02', 'area-alt': 'ACC-02', 'object-alt': 'ACC-02',
  label: 'ACC-03', 'select-name': 'ACC-03', 'aria-input-field-name': 'ACC-03', 'aria-toggle-field-name': 'ACC-03', 'label-title-only': 'ACC-03',
  'link-name': 'ACC-04', 'button-name': 'ACC-04', 'aria-command-name': 'ACC-04',
  'heading-order': 'ACC-05', 'empty-heading': 'ACC-05',
  region: 'ACC-06', 'landmark-one-main': 'ACC-06', 'landmark-no-duplicate-main': 'ACC-06', 'landmark-unique': 'ACC-06',
  'landmark-banner-is-top-level': 'ACC-06', 'landmark-contentinfo-is-top-level': 'ACC-06', 'landmark-main-is-top-level': 'ACC-06', 'landmark-complementary-is-top-level': 'ACC-06',
  'html-has-lang': 'ACC-07', 'html-lang-valid': 'ACC-07', 'valid-lang': 'ACC-07', 'document-title': 'ACC-07',
  'target-size': 'ACC-10',
  'meta-viewport': 'ACC-12',
};

const ICON_FONT = /icon|awesome|material symbols|glyph|fontello|ionicons/i;
const SYSTEM_FONTS = new Set(['arial', 'helvetica', 'helvetica neue', 'times', 'times new roman', 'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'courier', 'courier new', 'segoe ui', 'segoe ui variable', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'sf pro text', 'sf pro display', 'menlo', 'monaco', 'consolas', 'apple color emoji', 'segoe ui emoji', 'noto color emoji', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'emoji', 'math']);
const DEFAULT_FONTS = new Set(['inter', 'roboto', 'open sans', 'lato', 'arial', 'helvetica', 'helvetica neue', 'segoe ui', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif', 'sans-serif', 'serif', 'times', 'times new roman']);
const PLACEHOLDER_IMG_HOSTS = /(^|\.)(placehold\.co|placeholder\.com|via\.placeholder\.com|picsum\.photos|dummyimage\.com|placekitten\.com|fakeimg\.pl|loremflickr\.com|placeimg\.com|placehold\.it)$/i;

const GARBAGE_PATTERNS = [
  { re: /\blorem ipsum\b/i, label: 'lorem ipsum' },
  { re: /\bdolor sit amet\b/i, label: 'lorem ipsum' },
  { re: /(^|[\s:(])undefined(?=$|[\s.,)])/, label: 'undefined' },
  { re: /(^|[\s:($])NaN(?=$|[\s.,)%])/, label: 'NaN' },
  { re: /(^|[\s:(])null(?=$|[\s.,)])/, label: 'null' },
  { re: /\[object Object\]/, label: '[object Object]' },
  { re: /\{\{[^}]{0,60}\}\}/, label: 'unrendered {{ }} template' },
  { re: /\$\{[^}]{0,60}\}/, label: 'unrendered ${ } template' },
  { re: /__[A-Z][A-Z0-9_]{2,}__/, label: 'scaffold __TOKEN__' },
];
const SCAFFOLD_PATTERNS = [
  { re: /Waiting for your input/i, label: 'create-site waiting screen' },
  { re: /Please check your terminal to respond/i, label: 'create-site waiting screen' },
  { re: /(^|\n)\s*Initializing\.\.\.\s*($|\n)/, label: 'create-site loading screen' },
  { re: /\bVite \+ (React|Vue|TS|Svelte|Preact)\b/i, label: 'framework starter' },
  { re: /\bEdit (src\/)?App\.(tsx|jsx|vue|svelte)\b/i, label: 'framework starter' },
  { re: /\bYour Company\b/, label: 'generic placeholder' },
  { re: /\b(Company|Site|Brand) Name\b/, label: 'generic placeholder' },
  { re: /\bWelcome to (your|my) (new )?(site|website)\b/i, label: 'generic placeholder' },
  { re: /\bAcme (Inc|Corp|Co)\b/i, label: 'generic placeholder' },
];
const SCAFFOLD_TITLES = /^(React App|Vite App|Vite \+ \w+|Astro|Angular|My App|Document|Untitled)$/i;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const lc = (s) => (s || '').toLowerCase();

// When an auto-detected issue fails its critical gate (mirrors gateWhen in catalog.json).
const GATE_WHEN = {
  'ACC-01': (f) => !!f.gateHit,
  'ACC-03': () => true,
  'ACC-08': () => true,
  'RES-01': (f) => f.viewports.includes('mobile'),
  'RES-02': () => true,
  'RES-03': (f) => f.viewports.includes('mobile'),
  'RES-04': (f) => f.viewports.includes('mobile'),
  'TYP-07': () => true,
  'TYP-09': () => true,
};

function makeIssue(id, route, fields) {
  const cat = loadCatalog().byId.get(id);
  if (!cat) throw new Error(`Unknown catalog id ${id}`);
  const f = { ...fields, viewports: fields.viewports || [] };
  const gate = cat.gate && GATE_WHEN[id] && GATE_WHEN[id](f) ? cat.gate : null;
  return {
    id,
    variant: fields.variant || null,
    dimension: cat.dimension,
    detection: 'auto',
    gate,
    severity: gate ? 'major' : fields.severity || cat.severity,
    title: fields.title || cat.title,
    route,
    viewports: fields.viewports || [],
    aboveFold: !!fields.aboveFold,
    summary: fields.summary,
    instances: (fields.instances || []).slice(0, 10),
    instanceCount: fields.instanceCount != null ? fields.instanceCount : (fields.instances || []).length,
    metrics: fields.metrics || {},
  };
}

function snippet(text, idx, len = 60) {
  const s = Math.max(0, idx - 25);
  return text.slice(s, s + len).replace(/\s+/g, ' ').trim();
}

function paragraphBlocks(vp) {
  return (vp.textBlocks || []).filter((b) => b.textLength >= 40 && !b.isHeading && !b.inNav);
}

function dominant(entries) {
  const totals = new Map();
  for (const [key, w] of entries) totals.set(key, (totals.get(key) || 0) + w);
  let best = null, bestW = -1;
  for (const [k, w] of [...totals.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) if (w > bestW) { best = k; bestW = w; }
  return best;
}

function profileFor(page) {
  const d = page.viewports.desktop;
  if (!d || d.error) return null;
  const paras = paragraphBlocks(d);
  const bodySize = dominant(paras.map((b) => [b.fontSize, b.textLength]));
  const bodyFont = dominant(paras.map((b) => [b.fontFamily, b.textLength]));
  const h1s = (d.headings || []).filter((h) => h.level === 1);
  const topHeading = h1s.length ? h1s.reduce((a, b) => (b.fontSize > a.fontSize ? b : a)) : (d.headings || []).reduce((a, b) => (!a || b.fontSize > a.fontSize ? b : a), null);
  return {
    bodySize,
    bodyFont,
    headingFont: topHeading ? topHeading.fontFamily : null,
    h1Size: h1s.length ? Math.max(...h1s.map((h) => h.fontSize)) : null,
    h1Count: h1s.length,
    typeRatio: h1s.length && bodySize ? round(Math.max(...h1s.map((h) => h.fontSize)) / bodySize) : null,
  };
}

function axeChecks(page) {
  const issues = [];
  const merged = new Map();
  for (const vpName of ['desktop', 'mobile']) {
    const list = page.axe && page.axe[vpName];
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const isWcag = (v.tags || []).some((t) => /^wcag2/.test(t));
      if (!AXE_MAP[v.id] && !isWcag) continue;
      let m = merged.get(v.id);
      if (!m) { m = { ...v, nodes: [], targets: new Set(), viewports: [], nodeCount: 0 }; merged.set(v.id, m); }
      m.viewports.push(vpName);
      m.nodeCount = Math.max(m.nodeCount, v.nodeCount || v.nodes.length);
      for (const n of v.nodes) {
        // The plugin's axe returns target as an array of selectors; key and display it as one string.
        const t = Array.isArray(n.target) ? n.target.join(' ') : n.target;
        if (!m.targets.has(t)) { m.targets.add(t); m.nodes.push({ ...n, target: t }); }
      }
      const order = ['minor', 'moderate', 'serious', 'critical'];
      if (order.indexOf(v.impact) > order.indexOf(m.impact)) m.impact = v.impact;
    }
  }
  const grouped = new Map();
  for (const v of [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = AXE_MAP[v.id] || 'ACC-11';
    if (!grouped.has(id)) grouped.set(id, { id, variant: null, rules: [] });
    grouped.get(id).rules.push(v);
  }
  for (const g of grouped.values()) {
    const nodes = g.rules.flatMap((r) => r.nodes.map((n) => ({ ...n, rule: r.id })));
    const nodeCount = g.rules.reduce((a, r) => a + r.nodeCount, 0);
    const viewports = [...new Set(g.rules.flatMap((r) => r.viewports))];
    let severity;
    let gateHit = false;
    if (g.id === 'ACC-01') {
      const ratios = nodes.map((n) => n.contrastRatio).filter((x) => typeof x === 'number');
      gateHit = ratios.length > 0 && Math.min(...ratios) < 2.5;
    } else if (g.id === 'ACC-10') {
      severity = nodeCount >= 5 ? 'major' : 'minor';
    } else if (g.id === 'ACC-11') {
      severity = g.rules.some((r) => ['critical', 'serious'].includes(r.impact)) ? 'major' : 'minor';
    }
    const instances = nodes.map((n) => ({
      selector: n.target,
      detail: n.rule === 'color-contrast' && n.contrastRatio ? `contrast ${n.contrastRatio}:1 (${n.fgColor} on ${n.bgColor}, ${n.fontSize})` : `${n.rule}: ${n.html}`,
    }));
    issues.push(makeIssue(g.id, page.route, {
      variant: g.variant,
      severity,
      gateHit,
      viewports,
      summary: `${nodeCount} element(s) fail axe rule(s) ${g.rules.map((r) => r.id).join(', ')}.`,
      instances,
      instanceCount: nodeCount,
      metrics: { rules: g.rules.map((r) => ({ id: r.id, impact: r.impact, helpUrl: r.helpUrl })) },
    }));
  }
  return issues;
}

function checkPage(page, ctx) {
  const issues = [];
  const add = (id, f) => issues.push(makeIssue(id, page.route, f));
  const vps = page.viewports || {};
  const d = vps.desktop && !vps.desktop.error ? vps.desktop : null;
  const m = vps.mobile && !vps.mobile.error ? vps.mobile : null;
  const okVps = Object.entries(vps).filter(([, v]) => v && !v.error);
  if (!d) return issues;
  const profile = profileFor(page);

  issues.push(...axeChecks(page));

  // ACC-08 focus visibility
  if (page.focus && !page.focus.error && page.focus.invisible && page.focus.invisible.length) {
    add('ACC-08', {
      viewports: ['desktop'],
      aboveFold: true,
      summary: `${page.focus.invisible.length} of the first ${page.focus.sampled} tab stops show no visible focus indicator.`,
      instances: page.focus.invisible.map((x) => ({ selector: x.selector, detail: `no visual change on focus${x.label ? ` ("${x.label}")` : ''}` })),
      instanceCount: page.focus.invisible.length,
    });
  }

  // ACC-09 reduced motion
  if (Array.isArray(page.reducedMotion) && page.reducedMotion.length) {
    const infinite = page.reducedMotion.some((a) => a.infinite);
    add('ACC-09', {
      severity: infinite ? 'major' : 'minor',
      viewports: ['desktop'],
      summary: `${page.reducedMotion.length} animation(s) still run with prefers-reduced-motion: reduce${infinite ? ', including infinite loops' : ''}.`,
      instances: page.reducedMotion.map((a) => ({ selector: a.selector, detail: `animation ${a.animation}${a.infinite ? ' (infinite)' : ''}` })),
      instanceCount: page.reducedMotion.length,
    });
  }

  // RES-01 horizontal overflow
  const overflowVps = ['mobile', 'tablet'].filter((n) => vps[n] && !vps[n].error && vps[n].document.scrollWidth > vps[n].viewport.width + 1);
  if (overflowVps.length) {
    const inst = overflowVps.flatMap((n) => vps[n].overflowers.map((o) => ({ selector: o.selector, detail: `${n}: extends to x=${o.right}px (viewport ${vps[n].viewport.width}px)` })));
    add('RES-01', {
      viewports: overflowVps,
      aboveFold: true,
      summary: overflowVps.map((n) => `${n}: page is ${vps[n].document.scrollWidth}px wide in a ${vps[n].viewport.width}px viewport`).join('; ') + '.',
      instances: inst,
      metrics: Object.fromEntries(overflowVps.map((n) => [n, vps[n].document.scrollWidth])),
    });
  }

  // RES-02 viewport meta
  const mv = lc(d.document.metaViewport);
  if (!mv.includes('width=device-width')) {
    add('RES-02', { viewports: ['mobile'], aboveFold: true, summary: d.document.metaViewport ? `Viewport meta is "${d.document.metaViewport}".` : 'No viewport meta tag.' });
  }

  // RES-03 overlaps
  const ov = okVps.flatMap(([n, v]) => (v.overlaps || []).map((o) => ({ ...o, vp: n })));
  if (ov.length) {
    add('RES-03', {
      viewports: [...new Set(ov.map((o) => o.vp))],
      aboveFold: ov.some((o) => o.aboveFold),
      summary: `${ov.length} pair(s) of text elements overlap.`,
      instances: ov.map((o) => ({ selector: `${o.a}  ×  ${o.b}`, detail: `${o.vp}: "${o.aText}" overlaps "${o.bText}" (${Math.round(o.ratio * 100)}%)` })),
    });
  }

  // RES-04 clipped text
  const clipped = okVps.flatMap(([n, v]) => v.textBlocks.filter((b) => b.clipped).map((b) => ({ ...b, vp: n })));
  if (clipped.length) {
    add('RES-04', {
      viewports: [...new Set(clipped.map((b) => b.vp))],
      aboveFold: clipped.some((b) => b.aboveFold),
      summary: `${clipped.length} text element(s) are cut off by their container.`,
      instances: clipped.map((b) => ({ selector: b.selector, detail: `${b.vp}: "${b.text.slice(0, 40)}"` })),
    });
  }

  // RES-05 small text on mobile
  if (m) {
    const small = paragraphBlocks(m).filter((b) => b.fontSize < 14 && !b.inFooter);
    if (small.length) {
      add('RES-05', {
        viewports: ['mobile'],
        aboveFold: small.some((b) => b.aboveFold),
        summary: `${small.length} paragraph(s) render below 14px on mobile (smallest ${Math.min(...small.map((b) => b.fontSize))}px).`,
        instances: small.map((b) => ({ selector: b.selector, detail: `${b.fontSize}px: "${b.text.slice(0, 40)}"` })),
      });
    }
    // RES-06 fixed header height
    const tall = (m.fixedBars || []).filter((b) => b.height > m.viewport.height * 0.2);
    if (tall.length) {
      add('RES-06', {
        viewports: ['mobile'],
        aboveFold: true,
        summary: `A ${tall[0].position} header occupies ${Math.round((tall[0].height / m.viewport.height) * 100)}% of the mobile viewport.`,
        instances: tall.map((b) => ({ selector: b.selector, detail: `${b.height}px tall (${b.position})` })),
      });
    }
  }

  // INT-01 hover feedback
  if (page.hover && !page.hover.error && page.hover.sampled >= 2 && page.hover.noFeedback.length >= page.hover.sampled / 2) {
    add('INT-01', {
      viewports: ['desktop'],
      summary: `${page.hover.noFeedback.length} of ${page.hover.sampled} sampled buttons show no hover change.`,
      instances: page.hover.noFeedback.map((s) => ({ selector: s, detail: 'no visual change on hover' })),
    });
  }

  // INT-02 dead links
  // Evidence may carry a precomputed `dead` flag (for example when hrefs are redacted); otherwise it is derived from href.
  const dead = (d.links || []).filter((l) => (typeof l.dead === 'boolean' ? l.dead : l.href !== null && (l.href.trim() === '' || l.href.trim() === '#' || /^javascript:/i.test(l.href.trim()))));
  if (dead.length) {
    const nav = dead.some((l) => l.inNav);
    add('INT-02', {
      severity: nav ? 'major' : 'minor',
      viewports: ['desktop'],
      aboveFold: nav,
      summary: `${dead.length} link(s) go nowhere${nav ? ', including navigation links' : ''}.`,
      instances: dead.map((l) => ({ selector: l.selector, detail: `href="${l.href}" "${l.text}"${l.inNav ? ' (nav)' : ''}` })),
    });
  }

  // INT-03 runtime errors
  const errs = [...new Map((page.errors || []).map((e) => [e.message, e])).values()];
  if (errs.length) {
    add('INT-03', { viewports: ['desktop'], summary: `${errs.length} runtime error(s) during load.`, instances: errs.map((e) => ({ selector: e.type, detail: e.message })) });
  }

  // INT-04 failed non-image requests
  const envFailed = new Set(page.envNetworkFailures || []);
  const failed = (page.failedRequests || []).filter((r) => r.type !== 'image' && !/favicon\.ico/i.test(r.url) && !/ERR_ABORTED/i.test(r.reason || '') && !envFailed.has(r.url));
  const failedUnique = [...new Map(failed.map((r) => [r.url, r])).values()];
  if (failedUnique.length) {
    add('INT-04', { viewports: ['desktop'], summary: `${failedUnique.length} resource request(s) failed.`, instances: failedUnique.map((r) => ({ selector: r.type, detail: `${r.status} ${r.url}` })) });
  }

  // TYP-01 h1 count
  if (profile.h1Count === 0) add('TYP-01', { viewports: ['desktop'], aboveFold: true, summary: 'The page has no visible h1.' });
  else if (profile.h1Count > 1) {
    add('TYP-01', {
      variant: 'multiple', severity: 'minor', title: 'More than one H1 on the page', viewports: ['desktop'],
      summary: `The page has ${profile.h1Count} visible h1 elements.`,
      instances: d.headings.filter((h) => h.level === 1).map((h) => ({ selector: h.selector, detail: `"${h.text}"` })),
    });
  }

  // TYP-02 type scale
  if (profile.typeRatio != null && profile.typeRatio < 2.0) {
    add('TYP-02', {
      severity: profile.typeRatio < 1.6 ? 'major' : 'minor',
      viewports: ['desktop'],
      aboveFold: true,
      summary: `h1 is ${profile.h1Size}px vs ${profile.bodySize}px body text (ratio ${profile.typeRatio}; aim for 2.5–3.5).`,
      metrics: { h1Size: profile.h1Size, bodySize: profile.bodySize, ratio: profile.typeRatio },
    });
  }

  // TYP-03 body size desktop
  if (profile.bodySize && profile.bodySize < 16) {
    add('TYP-03', { viewports: ['desktop'], summary: `Dominant body text size is ${profile.bodySize}px.`, metrics: { bodySize: profile.bodySize } });
  }

  // TYP-04 line height
  const multi = paragraphBlocks(d).filter((b) => b.textLength >= 80 && b.lines >= 2);
  const cramped = multi.filter((b) => b.lineHeightRatio < 1.3);
  const loose = multi.filter((b) => b.lineHeightRatio > 2.0);
  if (cramped.length) {
    add('TYP-04', { viewports: ['desktop'], summary: `${cramped.length} paragraph(s) have line-height below 1.3.`, instances: cramped.map((b) => ({ selector: b.selector, detail: `line-height ${b.lineHeightRatio}${b.lineHeightNormal ? ' (normal)' : ''}` })) });
  }
  if (loose.length) {
    add('TYP-04', { variant: 'loose', severity: 'minor', title: 'Line height too loose', viewports: ['desktop'], summary: `${loose.length} paragraph(s) have line-height above 2.0.`, instances: loose.map((b) => ({ selector: b.selector, detail: `line-height ${b.lineHeightRatio}` })) });
  }

  // TYP-05 line length
  const long = paragraphBlocks(d).filter((b) => b.textLength >= 150 && b.lines >= 2 && b.charsPerLine > 90);
  if (long.length) {
    add('TYP-05', { viewports: ['desktop'], summary: `${long.length} paragraph(s) run about ${Math.max(...long.map((b) => b.charsPerLine))} characters per line.`, instances: long.map((b) => ({ selector: b.selector, detail: `~${b.charsPerLine} chars/line` })) });
  }

  // TYP-06 font families
  const famWeights = {};
  for (const b of d.textBlocks) if (!ICON_FONT.test(b.fontFamily)) famWeights[b.fontFamily] = (famWeights[b.fontFamily] || 0) + b.text.length;
  const fams = Object.entries(famWeights).filter(([, w]) => w >= 20).map(([f]) => f).sort();
  if (fams.length > 3) add('TYP-06', { viewports: ['desktop'], summary: `${fams.length} font families render text: ${fams.join(', ')}.`, metrics: { families: fams } });

  // TYP-07 fonts not loaded
  const faceErrors = (d.fonts.faces || []).filter((f) => f.status === 'error');
  const unavailable = Object.entries(d.fonts.availability || {}).filter(([fam, ok]) => !ok && fam && !SYSTEM_FONTS.has(lc(fam)) && !ICON_FONT.test(fam)).map(([f]) => f);
  const fontSourceEnvFailed = [...envFailed].some((u) => /fonts\.(googleapis|gstatic)\.com|\.(woff2?|ttf|otf)(\?|$)|font/i.test(u));
  if ((faceErrors.length || unavailable.length) && !fontSourceEnvFailed) {
    const inst = [...new Set(faceErrors.map((f) => f.family))].map((f) => ({ selector: `@font-face ${f}`, detail: 'font file failed to load' }))
      .concat(unavailable.sort().map((f) => ({ selector: `font-family: ${f}`, detail: 'declared but not available; text falls back to another font' })));
    add('TYP-07', { viewports: ['desktop'], aboveFold: true, summary: `${inst.length} declared font(s) are not rendering.`, instances: inst });
  }

  // TYP-09 faked heading weights
  const synth = [...new Map((d.fonts.syntheticWeights || []).map((x) => [`${x.family}|${x.weight}`, x])).values()];
  if (synth.length) {
    add('TYP-09', { viewports: ['desktop'], aboveFold: true, summary: `${synth.length} heading style(s) use a weight their font does not ship: ${synth.map((x) => `${x.family} ${x.weight}`).join(', ')}.`, instances: synth.map((x) => ({ selector: x.selector, detail: `h${x.level}: ${x.family} at ${x.weight}` })) });
  }

  // TYP-08 font-size sprawl
  const sizes = [...new Set(d.textBlocks.map((b) => Math.round(b.fontSize * 2) / 2))].sort((a, b) => a - b);
  if (sizes.length > 10) add('TYP-08', { viewports: ['desktop'], summary: `${sizes.length} distinct font sizes: ${sizes.join(', ')}px.`, metrics: { sizes } });

  // CLR-01 palette sprawl
  const entries = Object.entries(d.colors || {}).map(([k, count]) => ({ key: k, count, color: parseColor(k) })).filter((e) => e.color && isChromatic(e.color));
  const clusters = clusterColors(entries);
  if (clusters.length > 10) add('CLR-01', { viewports: ['desktop'], summary: `${clusters.length} distinct chromatic colors in use.`, metrics: { colors: clusters.map((c) => toHex(c.color)) } });

  // CLR-02 color tokens
  if ((d.tokens.colorTokens || 0) === 0 && (d.tokens.utilityColorClasses || 0) < 10) {
    add('CLR-02', { viewports: ['desktop'], summary: 'No color custom properties on :root/html, and no utility color system detected.' });
  }

  // LAY-01 spacing scale
  const spacingVals = Object.keys(d.spacing || {}).map(Number).filter((v) => v <= 160).sort((a, b) => a - b);
  const offGrid = spacingVals.filter((v) => v > 2 && v % 4 !== 0);
  if (spacingVals.length && (offGrid.length / spacingVals.length > 0.3 || spacingVals.length > 24)) {
    add('LAY-01', { viewports: ['desktop'], summary: `${spacingVals.length} distinct spacing values; ${offGrid.length} are off the 4px grid (${offGrid.slice(0, 12).join(', ')}${offGrid.length > 12 ? ', …' : ''}).`, metrics: { values: spacingVals, offGrid } });
  }

  // LAY-02 radii
  const radii = Object.keys(d.radii || {}).sort();
  if (radii.length > 6) add('LAY-02', { viewports: ['desktop'], summary: `${radii.length} distinct corner radii: ${radii.join(', ')}.`, metrics: { radii } });

  // LAY-03 shadows
  const shadows = Object.keys(d.shadows || {}).sort();
  if (shadows.length > 6) add('LAY-03', { viewports: ['desktop'], summary: `${shadows.length} distinct box-shadows.`, metrics: { shadows: shadows.slice(0, 12) } });

  // CON-01 / CON-02 text scans
  const text = `${d.document.title || ''}\n${d.document.visibleText != null ? d.document.visibleText : d.document.bodyText || ''}`;
  const scan = (patterns) => {
    const hits = [];
    for (const p of patterns) {
      const mm = p.re.exec(text);
      if (mm) hits.push({ selector: p.label, detail: `"${snippet(text, mm.index)}"` });
    }
    return [...new Map(hits.map((h) => [h.detail, h])).values()];
  };
  const garbage = scan(GARBAGE_PATTERNS);
  if (garbage.length) add('CON-01', { viewports: ['desktop'], aboveFold: true, summary: `Placeholder or garbage text is visible (${[...new Set(garbage.map((g) => g.selector))].join(', ')}).`, instances: garbage });
  const scaffold = scan(SCAFFOLD_PATTERNS);
  if (SCAFFOLD_TITLES.test((d.document.title || '').trim())) scaffold.push({ selector: '<title>', detail: `"${d.document.title}"` });
  if (scaffold.length) add('CON-02', { viewports: ['desktop'], aboveFold: true, summary: `Scaffold or template leftovers are visible (${[...new Set(scaffold.map((g) => g.selector))].join(', ')}).`, instances: scaffold });

  // CON-03 meta description / favicon
  const missing = [];
  if (!(d.document.metaDescription || '').trim()) missing.push({ selector: '<meta name="description">', detail: 'missing or empty' });
  if (!d.document.hasFavicon) missing.push({ selector: '<link rel="icon">', detail: 'missing' });
  if (missing.length) add('CON-03', { viewports: ['desktop'], summary: `Missing: ${missing.map((x) => x.selector).join(', ')}.`, instances: missing });

  // CON-04 empty sections
  const empties = okVps.flatMap(([n, v]) => (v.emptySections || []).map((e) => ({ ...e, vp: n })));
  if (empties.length) {
    const uniq = [...new Map(empties.map((e) => [e.selector, e])).values()];
    add('CON-04', { viewports: [...new Set(empties.map((e) => e.vp))], summary: `${uniq.length} visible block(s) are empty.`, instances: uniq.map((e) => ({ selector: e.selector, detail: `${e.vp}: ${e.height}px tall, no content` })) });
  }

  // IMG-* — group by src across viewports
  const imgs = new Map();
  for (const [n, v] of okVps) {
    for (const im of v.images || []) {
      if (!im.src) continue;
      const g = imgs.get(im.src) || { ...im, vps: [], maxRendered: 0, aboveFold: false };
      g.vps.push(n);
      g.maxRendered = Math.max(g.maxRendered, im.renderedWidth);
      g.aboveFold = g.aboveFold || im.aboveFold;
      g.distorted = g.distorted || (() => {
        if (im.objectFit !== 'fill' || !im.naturalWidth || !im.naturalHeight || im.renderedWidth < 20 || im.renderedHeight < 20) return false;
        return Math.abs((im.renderedWidth / im.renderedHeight) / (im.naturalWidth / im.naturalHeight) - 1) > 0.05;
      })();
      g.broken = g.broken || (im.complete && im.naturalWidth === 0);
      imgs.set(im.src, g);
    }
  }
  const isSvg = (src) => /\.svg(\?|#|$)|^data:image\/svg/i.test(src);
  const failedImgs = new Set((page.failedRequests || []).filter((r) => r.type === 'image').map((r) => r.url));
  const imgList = [...imgs.values()].sort((a, b) => a.src.localeCompare(b.src));
  const broken = imgList.filter((g) => (g.broken || failedImgs.has(g.src)) && !envFailed.has(g.src));
  if (broken.length) {
    add('IMG-01', { viewports: [...new Set(broken.flatMap((g) => g.vps))], aboveFold: broken.some((g) => g.aboveFold), summary: `${broken.length} image(s) failed to load.`, instances: broken.map((g) => ({ selector: g.selector, detail: g.src })) });
  }
  const distorted = imgList.filter((g) => g.distorted && !isSvg(g.src));
  if (distorted.length) add('IMG-02', { viewports: [...new Set(distorted.flatMap((g) => g.vps))], aboveFold: distorted.some((g) => g.aboveFold), summary: `${distorted.length} image(s) are stretched or squashed.`, instances: distorted.map((g) => ({ selector: g.selector, detail: `natural ${g.naturalWidth}×${g.naturalHeight}, rendered ${g.renderedWidth}×${g.renderedHeight}` })) });
  const upscaled = imgList.filter((g) => !g.broken && !isSvg(g.src) && g.naturalWidth > 0 && g.maxRendered >= 150 && g.naturalWidth < g.maxRendered);
  if (upscaled.length) add('IMG-03', { viewports: [...new Set(upscaled.flatMap((g) => g.vps))], aboveFold: upscaled.some((g) => g.aboveFold), summary: `${upscaled.length} image(s) are rendered larger than their source.`, instances: upscaled.map((g) => ({ selector: g.selector, detail: `source ${g.naturalWidth}px wide, rendered up to ${g.maxRendered}px` })) });
  const ph = imgList.filter((g) => { try { return PLACEHOLDER_IMG_HOSTS.test(new URL(g.src).hostname); } catch { return false; } });
  if (ph.length) add('IMG-04', { viewports: [...new Set(ph.flatMap((g) => g.vps))], aboveFold: ph.some((g) => g.aboveFold), summary: `${ph.length} image(s) come from placeholder services.`, instances: ph.map((g) => ({ selector: g.selector, detail: g.src })) });
  const oversized = imgList.filter((g) => !isSvg(g.src) && g.maxRendered >= 50 && g.naturalWidth > 4 * g.maxRendered);
  if (oversized.length) add('IMG-05', { viewports: [...new Set(oversized.flatMap((g) => g.vps))], summary: `${oversized.length} image(s) are far larger than displayed.`, instances: oversized.map((g) => ({ selector: g.selector, detail: `source ${g.naturalWidth}px wide, rendered at most ${g.maxRendered}px` })) });

  // PRF-01 CLS
  if (typeof page.cls === 'number' && page.cls > 0.1) add('PRF-01', { severity: page.cls > 0.25 ? 'major' : 'minor', viewports: ['desktop'], summary: `Cumulative Layout Shift is ${page.cls}.`, metrics: { cls: page.cls } });

  // PRF-02 font-display
  // A link is a URL string, or { href, hasDisplay } when display= was resolved before the URL was redacted.
  const badLinks = (d.fonts.googleFontLinks || []).filter((h) => (typeof h === 'string' ? !/display=(swap|optional|fallback)/.test(h) : !h.hasDisplay)).map((h) => (typeof h === 'string' ? h : h.href));
  const badFaces = (d.fonts.fontDisplay || []).filter((f) => /^(auto|block)$/.test(f.display));
  if (badLinks.length || badFaces.length) {
    add('PRF-02', { viewports: ['desktop'], summary: `${badLinks.length + badFaces.length} font source(s) may block text rendering.`, instances: badLinks.map((h) => ({ selector: '<link> Google Fonts', detail: h })).concat([...new Map(badFaces.map((f) => [f.family, f])).values()].map((f) => ({ selector: `@font-face ${f.family}`, detail: `font-display: ${f.display}` }))) });
  }

  // PRF-03 page weight excluding scripts and API calls
  const byType = page.pageWeightByType || {};
  const nonScript = Object.entries(byType).filter(([t]) => !['script', 'xhr', 'fetch', 'websocket', 'eventsource'].includes(t)).reduce((a, [, b]) => a + b, 0);
  if (nonScript > 4 * 1024 * 1024) add('PRF-03', { viewports: ['desktop'], summary: `Images, fonts, CSS, and documents total ${(nonScript / 1048576).toFixed(1)} MB.`, metrics: { bytes: nonScript, byType } });

  // AES-01 default fonts
  const headBanned = profile.headingFont && DEFAULT_FONTS.has(lc(profile.headingFont));
  const bodyBanned = profile.bodyFont && DEFAULT_FONTS.has(lc(profile.bodyFont));
  if (headBanned || bodyBanned) {
    add('AES-01', {
      severity: headBanned && bodyBanned ? 'major' : 'minor',
      viewports: ['desktop'],
      aboveFold: true,
      summary: `${headBanned ? `Headings use ${profile.headingFont}` : ''}${headBanned && bodyBanned ? '; ' : ''}${bodyBanned ? `Body uses ${profile.bodyFont}` : ''}.`,
      metrics: { headingFont: profile.headingFont, bodyFont: profile.bodyFont },
    });
  }

  // AES-02 purple gradient on white
  const pageBg = parseColor(d.backgrounds.pageBg);
  if (isNearWhite(pageBg)) {
    const purple = (d.backgrounds.gradients || []).filter((g) => extractColors(g.value).filter((c) => { const h = toHsl(c); return c.a >= 0.3 && h.h >= 245 && h.h <= 295 && h.s >= 0.3; }).length >= 2);
    if (purple.length) add('AES-02', { viewports: ['desktop'], aboveFold: true, summary: 'A large purple/violet gradient sits on a white page.', instances: purple.map((g) => ({ selector: g.selector, detail: `${Math.round(g.foldCoverage * 100)}% of first viewport` })) });
  }

  // AES-03 flat backgrounds
  const bandColors = Object.keys(d.backgrounds.bandBgs || {});
  if ((d.backgrounds.bgImageEls || 0) === 0 && new Set(bandColors.concat([d.backgrounds.pageBg])).size <= 1) {
    add('AES-03', { viewports: ['desktop'], summary: `Every large section uses the same solid background (${d.backgrounds.pageBg}) with no gradient, image, or pattern.` });
  }

  // AES-04 no motion
  if ((d.motion.transitionEls || 0) === 0 && (d.motion.animationEls || 0) === 0) {
    add('AES-04', { viewports: ['desktop'], summary: 'No element defines a transition or animation.' });
  }

  return issues;
}

function runChecks(evidence) {
  const issues = [];
  const profiles = {};
  for (const page of evidence.pages) {
    issues.push(...checkPage(page, { evidence }));
    profiles[page.route] = profileFor(page);
  }
  return { issues, profiles };
}

module.exports = { runChecks, checkPage, profileFor, AXE_MAP };
