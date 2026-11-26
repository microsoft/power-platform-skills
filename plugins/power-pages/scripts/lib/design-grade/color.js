'use strict';

// Parses Chrome's computed color strings: rgb(r, g, b), rgba(r, g, b, a), rgb(r g b / a), color(srgb r g b / a).
function parseColor(str) {
  if (!str) return null;
  let m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i);
  if (m) {
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = str.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/i);
  if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

function extractColors(str) {
  if (!str) return [];
  const out = [];
  const re = /(rgba?\([^)]*\)|color\(srgb[^)]*\))/gi;
  let m;
  while ((m = re.exec(str))) {
    const c = parseColor(m[1]);
    if (c) out.push(c);
  }
  return out;
}

function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function toLab({ r, g, b }) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { L: 116 * f(y) - 16, A: 500 * (f(x) - f(y)), B: 200 * (f(y) - f(z)) };
}

function deltaE(c1, c2) {
  const a = toLab(c1), b = toLab(c2);
  return Math.hypot(a.L - b.L, a.A - b.A, a.B - b.B);
}

function isChromatic(c) {
  const { s, l } = toHsl(c);
  return c.a >= 0.5 && s >= 0.15 && l > 0.08 && l < 0.95;
}

function isNearWhite(c) {
  return c && c.a >= 0.9 && c.r >= 240 && c.g >= 240 && c.b >= 240;
}

// Greedy clustering in a deterministic order (most-used first), so the result is stable.
function clusterColors(entries, threshold = 10) {
  const sorted = [...entries].sort((x, y) => y.count - x.count || x.key.localeCompare(y.key));
  const clusters = [];
  for (const e of sorted) {
    const hit = clusters.find((c) => deltaE(c.color, e.color) < threshold);
    if (hit) hit.count += e.count;
    else clusters.push({ color: e.color, key: e.key, count: e.count });
  }
  return clusters;
}

const toHex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

module.exports = { parseColor, extractColors, toHsl, deltaE, isChromatic, isNearWhite, clusterColors, toHex };
