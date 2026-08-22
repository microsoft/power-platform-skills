'use strict';

function parseColor(value) {
  const match = String(value || '').match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i);
  if (!match) return null;
  return {
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function composite(foreground, background) {
  if (foreground.alpha >= 1) return foreground;
  return {
    red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
    green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
    blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
    alpha: 1,
  };
}

function luminance(color) {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function run(snapshot) {
  const failures = [];
  for (const element of snapshot.elements) {
    if (!element.visible || (!element.harnessIcon && !element.text.trim())) continue;
    const rawForeground = parseColor(element.style.color);
    const background = parseColor(element.style.backgroundColor);
    if (!rawForeground || !background) {
      failures.push(`${element.testId || element.tag} has an unparseable computed text colour`);
      continue;
    }
    const foreground = composite(rawForeground, background);
    const ratio = contrastRatio(foreground, background);
    const fontSize = Number.parseFloat(element.style.fontSize) || 0;
    const fontWeight = Number.parseInt(element.style.fontWeight, 10) || 400;
    const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const threshold = element.harnessIcon ? 3 : large ? 3 : 4.5;
    if (ratio + 0.01 < threshold) {
      const identity = element.harnessIcon
        ? `icon ${element.harnessIcon}`
        : element.testId || element.tag;
      failures.push(`${identity} ${JSON.stringify(element.text)} contrast ${ratio.toFixed(2)}:1 is below ${threshold}:1`);
    }
  }
  return { pass: failures.length === 0, failures };
}

module.exports = { contrastRatio, luminance, parseColor, run };