'use strict';

// Runs inside the page via page.evaluate — must be fully self-contained (no closures over module scope).
// Collects raw, deterministic metrics. All interpretation happens in checks.js.
function measurePage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE', 'BR']);
  const LIMIT = 50000;

  const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
  const px = (v) => parseFloat(v) || 0;

  function cssPath(el) {
    const parts = [];
    let e = el;
    for (let i = 0; e && e.nodeType === 1 && i < 4; i++) {
      let p = e.tagName.toLowerCase();
      if (e.id && !/^\d|[:]/.test(e.id)) {
        parts.unshift(p + '#' + CSS.escape(e.id));
        break;
      }
      const cls = [...e.classList].filter((c) => !/^(css|sc|jsx|svelte|astro|ng|v|data)-[\w-]{4,}$/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = e.parentElement;
      if (parent) {
        const sib = [...parent.children].filter((s) => s.tagName === e.tagName);
        if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`;
      }
      parts.unshift(p);
      if (p === 'body') break;
      e = parent;
    }
    return parts.join(' > ');
  }

  const styleCache = new Map();
  const cs = (el) => {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  };

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function effectiveOpacity(el) {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(cs(e).opacity);
    return o;
  }

  function directText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  }

  function textRect(el) {
    let rect = null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      rect = rect
        ? { left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top), right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return rect;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const SAMPLE = 'the quick brown fox jumps over the lazy dog';
  function avgCharWidth(s) {
    ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return ctx.measureText(SAMPLE).width / SAMPLE.length || px(s.fontSize) * 0.5;
  }

  const primaryFamily = (ff) => (ff || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

  // Walk the light DOM plus every open shadow root, in document order.
  const deep = [];
  let shadowRoots = 0;
  (function collect(root) {
    for (const el of root.querySelectorAll('*')) {
      deep.push(el);
      if (el.shadowRoot) { shadowRoots++; collect(el.shadowRoot); }
    }
  })(document.body);
  const allRaw = deep.filter((el) => !SKIP.has(el.tagName) && !el.closest('svg *'));
  const truncated = allRaw.length > LIMIT;
  const all = allRaw.slice(0, LIMIT);
  const visible = all.filter(isVisible);
  const docRight = Math.max(doc.scrollWidth, vw);

  // ---------- Text blocks ----------
  const textBlocks = [];
  const blockEls = [];
  const visibleTextParts = [];
  const CLIP_RE = /hidden|clip/;
  // Text partly cut off by an overflow-hidden ancestor. Fully hidden text (e.g. inactive carousel slides) is intentional and ignored.
  function clippedByAncestor(el, tr) {
    if (!tr) return false;
    for (let e = el.parentElement, depth = 0; e && e !== document.body && depth < 4; e = e.parentElement, depth++) {
      const s = cs(e);
      const clipX = CLIP_RE.test(s.overflowX), clipY = CLIP_RE.test(s.overflowY);
      if (!clipX && !clipY) continue;
      if (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none')) return false;
      const r = e.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      const box = { left: r.left + e.clientLeft, top: r.top + e.clientTop, right: r.left + e.clientLeft + e.clientWidth, bottom: r.top + e.clientTop + e.clientHeight };
      const intersects = tr.right > box.left && tr.left < box.right && tr.bottom > box.top && tr.top < box.bottom;
      if (!intersects) return false;
      const overX = clipX && (tr.right > box.right + 2 || tr.left < box.left - 2);
      const overY = clipY && (tr.bottom > box.bottom + 2 || tr.top < box.top - 2);
      return overX || overY;
    }
    return false;
  }
  for (const el of visible) {
    const text = directText(el);
    if (!text) continue;
    visibleTextParts.push(text);
    if (el.closest('[aria-hidden="true"]')) continue;
    const s = cs(el);
    const r = el.getBoundingClientRect();
    if (r.right <= 0 || r.left >= docRight) continue;
    const fontSize = px(s.fontSize);
    const lh = s.lineHeight === 'normal' ? fontSize * 1.2 : px(s.lineHeight);
    const contentWidth = el.clientWidth ? el.clientWidth - px(s.paddingLeft) - px(s.paddingRight) : r.width;
    const fullText = (el.innerText || text).replace(/\s+/g, ' ').trim();
    const tRect = textRect(el);
    blockEls.push(el);
    textBlocks.push({
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 80),
      textLength: fullText.length,
      fontSize: round(fontSize),
      lineHeightRatio: round(lh / fontSize, 2),
      lineHeightNormal: s.lineHeight === 'normal',
      lines: Math.round(r.height / lh),
      fontFamily: primaryFamily(s.fontFamily),
      fontFamilyStack: s.fontFamily,
      fontWeight: s.fontWeight,
      color: s.color,
      charsPerLine: Math.round(contentWidth / avgCharWidth(s)),
      aboveFold: r.top < vh,
      opacity: round(effectiveOpacity(el), 2),
      rect: tRect,
      inNav: !!el.closest('header, nav, [role="navigation"], [role="banner"]'),
      inFooter: !!el.closest('footer, [role="contentinfo"]'),
      isHeading: /^H[1-6]$/.test(el.tagName) || !!el.closest('h1,h2,h3,h4,h5,h6'),
      clipped: (() => {
        const ox = s.overflowX, oy = s.overflowY;
        const hides = /hidden|clip/.test(ox) || /hidden|clip/.test(oy);
        if (r.width <= 2 || r.height <= 2) return false;
        if (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none')) return false;
        if (hides && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) return true;
        return clippedByAncestor(el, tRect);
      })(),
    });
  }

  // ---------- Overlaps between unrelated text ----------
  const overlapIdx = textBlocks.map((b, i) => i).filter((i) => textBlocks[i].rect && textBlocks[i].opacity >= 0.5 && textBlocks[i].text.length >= 2).slice(0, 2000);
  const overlaps = [];
  for (let x = 0; x < overlapIdx.length && overlaps.length < 20; x++) {
    for (let y = x + 1; y < overlapIdx.length && overlaps.length < 20; y++) {
      const a = textBlocks[overlapIdx[x]], b = textBlocks[overlapIdx[y]];
      const ea = blockEls[overlapIdx[x]], eb = blockEls[overlapIdx[y]];
      if (ea.contains(eb) || eb.contains(ea)) continue;
      const ix = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const iy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (ix <= 0 || iy <= 0) continue;
      const inter = ix * iy;
      const areaA = (a.rect.right - a.rect.left) * (a.rect.bottom - a.rect.top);
      const areaB = (b.rect.right - b.rect.left) * (b.rect.bottom - b.rect.top);
      if (inter >= 50 && inter / Math.min(areaA, areaB) >= 0.3) {
        overlaps.push({ a: a.selector, b: b.selector, aText: a.text.slice(0, 40), bText: b.text.slice(0, 40), ratio: round(inter / Math.min(areaA, areaB), 2), aboveFold: Math.min(a.rect.top, b.rect.top) < vh });
      }
    }
  }

  // ---------- Horizontal overflow ----------
  const overflowers = [];
  if (doc.scrollWidth > vw + 1) {
    const clippedByAncestor = (el) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const s = cs(e);
        if (/hidden|clip|auto|scroll/.test(s.overflowX)) return true;
      }
      return false;
    };
    const offenders = visible.filter((el) => {
      const s = cs(el);
      if (s.position === 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.right > vw + 1 && !clippedByAncestor(el);
    });
    const set = new Set(offenders);
    for (const el of offenders) {
      if (el.parentElement && set.has(el.parentElement) && el.parentElement.getBoundingClientRect().right >= el.getBoundingClientRect().right - 1) continue;
      overflowers.push({ selector: cssPath(el), right: Math.round(el.getBoundingClientRect().right), width: Math.round(el.getBoundingClientRect().width) });
      if (overflowers.length >= 10) break;
    }
  }

  // ---------- Headings ----------
  const headings = all.filter((el) => /^H[1-6]$/.test(el.tagName)).filter(isVisible).map((h) => ({
    level: +h.tagName[1],
    text: (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    fontSize: round(px(cs(h).fontSize)),
    fontFamily: primaryFamily(cs(h).fontFamily),
    selector: cssPath(h),
  }));

  // ---------- Fonts ----------
  const fontFaces = [];
  if (document.fonts) document.fonts.forEach((f) => fontFaces.push({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status, weight: f.weight, style: f.style }));
  const fontAvailability = {};
  const families = [...new Set(textBlocks.map((t) => t.fontFamily).concat(headings.map((h) => h.fontFamily)))];
  for (const fam of families) {
    const probe = (generic) => {
      ctx.font = `48px ${generic}`;
      const base = ctx.measureText('mmmmmmmmmmlliWWWQ@#').width;
      ctx.font = `48px "${fam}", ${generic}`;
      return ctx.measureText('mmmmmmmmmmlliWWWQ@#').width !== base;
    };
    fontAvailability[fam] = probe('monospace') || probe('serif') || probe('sans-serif');
  }

  // Same rule as the plugin's capture-design-review.js: a heading weight outside every loaded face of its family is faked by the browser.
  const toWeight = (v) => ({ normal: 400, bold: 700 }[v] || Number(v));
  const loadedFaces = fontFaces.filter((f) => f.status === 'loaded');
  const syntheticWeights = [];
  for (const h of headings) {
    const el = all.find((e) => /^H[1-6]$/.test(e.tagName) && cssPath(e) === h.selector);
    if (!el) continue;
    const weight = toWeight(cs(el).fontWeight);
    const famFaces = loadedFaces.filter((f) => f.family === h.fontFamily);
    const covered = famFaces.some((f) => { const [lo, hi = lo] = String(f.weight).split(/\s+/).map(toWeight); return weight >= lo && weight <= hi; });
    if (famFaces.length && !covered) syntheticWeights.push({ selector: h.selector, family: h.fontFamily, weight, level: h.level });
  }
  const googleFontLinks = [...document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"]')].map((l) => l.href);
  const fontDisplay = [];
  const rootTokens = { colorTokens: 0, totalTokens: 0 };
  const walkRules = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules && !(rule instanceof CSSStyleRule)) { walkRules(rule.cssRules); continue; }
      if (rule instanceof CSSFontFaceRule) fontDisplay.push({ family: rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim(), display: rule.style.getPropertyValue('font-display') || 'auto', href: rule.parentStyleSheet && rule.parentStyleSheet.href });
      if (rule instanceof CSSStyleRule) {
        if (/(^|,|\s)(:root|html)(\s|,|$|\[|:)/.test(rule.selectorText)) {
          for (const prop of rule.style) {
            if (!prop.startsWith('--')) continue;
            rootTokens.totalTokens++;
            const v = rule.style.getPropertyValue(prop).trim();
            if (v && (CSS.supports('color', v) || /^(oklch|oklab|hsl|rgb|lab|lch|#)/i.test(v) || /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(v))) rootTokens.colorTokens++;
          }
        }
        if (rule.cssRules && rule.cssRules.length) walkRules(rule.cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walkRules(sheet.cssRules); } catch (_) { /* cross-origin sheet */ }
  }
  const utilityColorClasses = new Set();
  for (const el of all) for (const c of el.classList) if (/^(bg|text|border|from|to|via)-[a-z]+-\d{2,3}$/.test(c)) utilityColorClasses.add(c);

  // ---------- Colors, spacing, radii, shadows, motion ----------
  const colors = {};
  const addColor = (c, w = 1) => { if (c) colors[c] = (colors[c] || 0) + w; };
  const spacing = {};
  const radii = {};
  const shadows = {};
  let transitionEls = 0, animationEls = 0;
  const gradients = [];
  let bgImageEls = 0;
  for (const el of visible) {
    const s = cs(el);
    const r = el.getBoundingClientRect();
    if (directText(el)) addColor(s.color);
    const bg = s.backgroundColor;
    if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) addColor(bg);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (px(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none') addColor(s[`border${side}Color`]);
    }
    for (const prop of ['marginTop', 'marginBottom', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
      const v = px(s[prop]);
      if (v > 0 && v <= 400) { const k = String(Math.round(Math.abs(v) * 2) / 2); spacing[k] = (spacing[k] || 0) + 1; }
    }
    for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius']) {
      const v = s[corner];
      if (v && v !== '0px') {
        const k = v.includes('%') ? v : px(v) >= 999 ? 'pill' : String(Math.round(px(v)));
        radii[k] = (radii[k] || 0) + 1;
      }
    }
    if (s.boxShadow && s.boxShadow !== 'none') shadows[s.boxShadow] = (shadows[s.boxShadow] || 0) + 1;
    if (s.transitionDuration.split(',').some((d) => parseFloat(d) > 0)) transitionEls++;
    if (s.animationName !== 'none' && s.animationDuration.split(',').some((d) => parseFloat(d) > 0)) animationEls++;
    if (s.backgroundImage && s.backgroundImage !== 'none') {
      const area = r.width * r.height;
      if (area >= vw * vh * 0.05) bgImageEls++;
      if (s.backgroundImage.includes('gradient')) {
        const visTop = Math.max(0, r.top), visBottom = Math.min(vh, r.bottom);
        const foldArea = Math.max(0, visBottom - visTop) * Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
        if (foldArea >= vw * vh * 0.15) gradients.push({ selector: cssPath(el), value: s.backgroundImage.slice(0, 400), foldCoverage: round(foldArea / (vw * vh), 2) });
      }
    }
  }

  const effectiveBg = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const b = cs(e).backgroundColor;
      if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b;
    }
    return 'rgb(255, 255, 255)';
  };
  const pageBg = effectiveBg(document.body);
  const bands = visible.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height >= 200 && r.width >= vw * 0.9;
  });
  const bandBgs = {};
  for (const el of bands) { const b = effectiveBg(el); bandBgs[b] = (bandBgs[b] || 0) + 1; }

  // ---------- Images ----------
  const images = all.filter((el) => el.tagName === 'IMG').filter(isVisible).map((img) => {
    const r = img.getBoundingClientRect();
    const s = cs(img);
    return {
      selector: cssPath(img),
      src: (img.currentSrc || img.src || '').slice(0, 300),
      alt: img.getAttribute('alt'),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: round(r.width),
      renderedHeight: round(r.height),
      objectFit: s.objectFit,
      aboveFold: r.top < vh,
    };
  });

  // ---------- Links ----------
  const links = all.filter((el) => el.tagName === 'A').filter(isVisible).map((a) => ({
    selector: cssPath(a),
    href: a.getAttribute('href'),
    absHref: a.href || '',
    text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    inNav: !!a.closest('header, nav, [role="navigation"], [role="banner"]'),
  }));

  // ---------- Fixed / sticky top bars ----------
  const fixedBars = visible.filter((el) => {
    const s = cs(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') return false;
    const r = el.getBoundingClientRect();
    return r.top <= 1 && r.width >= vw * 0.9;
  }).map((el) => ({ selector: cssPath(el), height: Math.round(el.getBoundingClientRect().height), position: cs(el).position }));

  // ---------- Empty sections ----------
  const MEDIA = 'img,svg,video,canvas,iframe,picture,object,embed';
  const emptySections = visible.filter((el) => {
    if (!/^(SECTION|ARTICLE|ASIDE|DIV)$/.test(el.tagName)) return false;
    if (el.tagName === 'DIV' && !(el.parentElement && /^(MAIN|BODY)$/.test(el.parentElement.tagName))) return false;
    const r = el.getBoundingClientRect();
    if (r.height < 200 || r.width < vw * 0.5) return false;
    if ((el.innerText || '').trim()) return false;
    if (el.querySelector(MEDIA)) return false;
    if (cs(el).backgroundImage !== 'none') return false;
    if ([...el.querySelectorAll('*')].some((c) => getComputedStyle(c).backgroundImage !== 'none')) return false;
    return true;
  }).slice(0, 10).map((el) => ({ selector: cssPath(el), height: Math.round(el.getBoundingClientRect().height) }));

  const meta = (name) => { const m = document.querySelector(`meta[name="${name}"]`); return m ? m.getAttribute('content') : null; };

  return {
    viewport: { width: vw, height: vh },
    document: {
      title: document.title,
      lang: doc.getAttribute('lang'),
      metaViewport: meta('viewport'),
      metaDescription: meta('description'),
      hasFavicon: !!document.querySelector('link[rel~="icon"]'),
      scrollWidth: doc.scrollWidth,
      scrollHeight: doc.scrollHeight,
      visibleText: visibleTextParts.join('\n').slice(0, 200000),
    },
    coverage: { elements: allRaw.length, measured: all.length, truncated, shadowRoots, iframes: deep.filter((el) => el.tagName === 'IFRAME').length },
    textBlocks: textBlocks.map(({ rect, ...rest }) => rest),
    overlaps,
    overflowers,
    headings,
    fonts: { faces: fontFaces, availability: fontAvailability, googleFontLinks, fontDisplay, syntheticWeights },
    tokens: { ...rootTokens, utilityColorClasses: utilityColorClasses.size },
    colors,
    spacing,
    radii,
    shadows,
    motion: { transitionEls, animationEls },
    backgrounds: { pageBg, bandBgs, bandCount: bands.length, bgImageEls, gradients: gradients.slice(0, 10) },
    images,
    links,
    fixedBars,
    emptySections,
  };
}

module.exports = { measurePage };
