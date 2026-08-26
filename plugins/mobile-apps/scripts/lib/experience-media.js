'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 720;

// Stable, reviewed fixture sources. Screens never embed these URLs directly;
// the generated media manifest owns source provenance and cache identity.
const APPROVED_CDN_MEDIA = {
  travel: [
    'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1581553680321-4fffae59fccd?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1491637639811-60e2756cc1c7?auto=format&fit=crop&w=1200&q=84',
  ],
  beauty: [
    'https://images.unsplash.com/photo-1556228578-8c89e6adf883?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=1200&q=84',
  ],
  watch: [
    'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=1200&q=84',
  ],
  essentials: [
    'https://images.unsplash.com/photo-1523779105320-d1cd346ff52b?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=1200&q=84',
  ],
  food: [
    'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1506617420156-8e4536971650?auto=format&fit=crop&w=1200&q=84',
  ],
  wellness: [
    'https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1538805060514-97d9cc17730c?auto=format&fit=crop&w=1200&q=84',
  ],
  product: [
    'https://images.unsplash.com/photo-1523779105320-d1cd346ff52b?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=1200&q=84',
    'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=1200&q=84',
  ],
};

const PALETTES = {
  travel: { top: [221, 235, 236], bottom: [166, 204, 204], ink: [19, 54, 67], accent: [27, 126, 122], light: [242, 246, 241] },
  beauty: { top: [242, 225, 224], bottom: [213, 183, 197], ink: [75, 38, 57], accent: [178, 93, 126], light: [255, 244, 238] },
  watch: { top: [225, 226, 217], bottom: [179, 184, 169], ink: [28, 38, 42], accent: [150, 111, 54], light: [244, 240, 226] },
  food: { top: [239, 228, 200], bottom: [197, 202, 156], ink: [58, 62, 38], accent: [171, 93, 48], light: [253, 245, 218] },
  wellness: { top: [224, 235, 225], bottom: [171, 207, 189], ink: [30, 67, 54], accent: [68, 139, 110], light: [244, 249, 240] },
  product: { top: [226, 231, 237], bottom: [180, 195, 207], ink: [26, 50, 69], accent: [77, 118, 143], light: [246, 244, 236] },
};

let crcTable;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
  });
  return crcTable;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  const table = getCrcTable();
  for (const value of buffer) crc = table[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function blendPixel(pixels, width, height, x, y, color, alpha = 1) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return;
  const offset = (py * width + px) * 4;
  const sourceAlpha = Math.max(0, Math.min(1, alpha));
  const inverse = 1 - sourceAlpha;
  pixels[offset] = Math.round(color[0] * sourceAlpha + pixels[offset] * inverse);
  pixels[offset + 1] = Math.round(color[1] * sourceAlpha + pixels[offset + 1] * inverse);
  pixels[offset + 2] = Math.round(color[2] * sourceAlpha + pixels[offset + 2] * inverse);
  pixels[offset + 3] = 255;
}

function fillCircle(pixels, width, height, cx, cy, radius, color, alpha = 1) {
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  const radiusSquared = radius * radius;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (((x - cx) ** 2) + ((y - cy) ** 2) <= radiusSquared) {
        blendPixel(pixels, width, height, x, y, color, alpha);
      }
    }
  }
}

function fillRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, color, alpha = 1) {
  const right = x + rectWidth;
  const bottom = y + rectHeight;
  const safeRadius = Math.min(radius, rectWidth / 2, rectHeight / 2);
  for (let py = Math.floor(y); py < Math.ceil(bottom); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(right); px += 1) {
      const nearestX = Math.max(x + safeRadius, Math.min(px, right - safeRadius));
      const nearestY = Math.max(y + safeRadius, Math.min(py, bottom - safeRadius));
      if (((px - nearestX) ** 2) + ((py - nearestY) ** 2) <= safeRadius ** 2) {
        blendPixel(pixels, width, height, px, py, color, alpha);
      }
    }
  }
}

function strokeRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, thickness, color, alpha = 1) {
  fillRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, color, alpha);
  fillRoundedRect(
    pixels,
    width,
    height,
    x + thickness,
    y + thickness,
    rectWidth - (2 * thickness),
    rectHeight - (2 * thickness),
    Math.max(0, radius - thickness),
    [255, 255, 255],
    1,
  );
}

function drawLine(pixels, width, height, x1, y1, x2, y2, thickness, color, alpha = 1) {
  const distance = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
  for (let step = 0; step <= distance; step += Math.max(1, thickness / 3)) {
    const amount = step / distance;
    fillCircle(
      pixels,
      width,
      height,
      x1 + ((x2 - x1) * amount),
      y1 + ((y2 - y1) * amount),
      thickness / 2,
      color,
      alpha,
    );
  }
}

function drawTravel(pixels, width, height, palette) {
  const x = width * 0.31;
  const y = height * 0.23;
  const w = width * 0.38;
  const h = height * 0.54;
  fillRoundedRect(pixels, width, height, x, y, w, h, 56, palette.ink, 0.96);
  fillRoundedRect(pixels, width, height, x + 24, y + 26, w - 48, h - 52, 38, palette.light, 1);
  strokeRoundedRect(pixels, width, height, x + (w * 0.29), y - 58, w * 0.42, 100, 32, 20, palette.ink, 1);
  fillRoundedRect(pixels, width, height, x + 56, y + (h * 0.55), w - 112, h * 0.24, 28, palette.accent, 0.96);
  drawLine(pixels, width, height, x + 72, y + (h * 0.19), x + w - 72, y + (h * 0.19), 16, palette.ink, 0.85);
}

function drawBeauty(pixels, width, height, palette) {
  fillCircle(pixels, width, height, width * 0.73, height * 0.27, height * 0.14, palette.light, 0.72);
  fillRoundedRect(pixels, width, height, width * 0.19, height * 0.36, width * 0.24, height * 0.40, 50, palette.ink, 0.96);
  fillRoundedRect(pixels, width, height, width * 0.22, height * 0.25, width * 0.18, height * 0.16, 28, palette.ink, 1);
  fillRoundedRect(pixels, width, height, width * 0.51, height * 0.27, width * 0.25, height * 0.49, 110, palette.light, 1);
  fillRoundedRect(pixels, width, height, width * 0.56, height * 0.19, width * 0.15, height * 0.15, 24, palette.accent, 1);
  fillRoundedRect(pixels, width, height, width * 0.245, height * 0.50, width * 0.13, height * 0.10, 16, palette.accent, 1);
  fillCircle(pixels, width, height, width * 0.635, height * 0.53, width * 0.065, palette.accent, 0.85);
}

function drawWatch(pixels, width, height, palette) {
  fillRoundedRect(pixels, width, height, width * 0.42, height * 0.08, width * 0.16, height * 0.84, 60, palette.ink, 0.96);
  fillCircle(pixels, width, height, width * 0.50, height * 0.50, height * 0.245, palette.ink, 1);
  fillCircle(pixels, width, height, width * 0.50, height * 0.50, height * 0.195, palette.light, 1);
  fillCircle(pixels, width, height, width * 0.50, height * 0.50, 14, palette.accent, 1);
  drawLine(pixels, width, height, width * 0.50, height * 0.50, width * 0.50, height * 0.37, 14, palette.ink, 1);
  drawLine(pixels, width, height, width * 0.50, height * 0.50, width * 0.61, height * 0.55, 14, palette.ink, 1);
}

function drawProduct(pixels, width, height, palette) {
  fillRoundedRect(pixels, width, height, width * 0.22, height * 0.27, width * 0.56, height * 0.49, 58, palette.ink, 0.96);
  fillRoundedRect(pixels, width, height, width * 0.26, height * 0.32, width * 0.48, height * 0.36, 38, palette.light, 1);
  fillRoundedRect(pixels, width, height, width * 0.39, height * 0.18, width * 0.22, height * 0.16, 30, palette.accent, 1);
  fillCircle(pixels, width, height, width * 0.50, height * 0.50, height * 0.105, palette.accent, 0.88);
}

function createExperiencePng({ family = 'product', seed = 'experience', width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
  const normalizedFamily = Object.prototype.hasOwnProperty.call(PALETTES, family) ? family : 'product';
  const palette = PALETTES[normalizedFamily];
  const pixels = Buffer.alloc(width * height * 4);
  const seedByte = crypto.createHash('sha256').update(String(seed)).digest()[0];
  for (let y = 0; y < height; y += 1) {
    const amount = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const grain = (((x * 17) + (y * 31) + seedByte) % 13) - 6;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(
          palette.top[channel] + ((palette.bottom[channel] - palette.top[channel]) * amount) + grain,
        )));
      }
      pixels[offset + 3] = 255;
    }
  }

  fillCircle(pixels, width, height, width * 0.16, height * 0.18, height * 0.24, palette.light, 0.28);
  fillCircle(pixels, width, height, width * 0.86, height * 0.78, height * 0.32, palette.accent, 0.16);
  if (normalizedFamily === 'travel') drawTravel(pixels, width, height, palette);
  else if (normalizedFamily === 'beauty') drawBeauty(pixels, width, height, palette);
  else if (normalizedFamily === 'watch') drawWatch(pixels, width, height, palette);
  else drawProduct(pixels, width, height, palette);

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    pixels.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function inspectPngBuffer(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) throw new Error('not a PNG image');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let ended = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > buffer.length) throw new Error('truncated PNG chunk');
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`invalid ${type} checksum`);
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    offset = crcOffset + 4;
    if (ended) break;
  }
  if (!width || !height || !idat.length || !ended) throw new Error('incomplete PNG image');
  if (bitDepth !== 8 || colorType !== 6) throw new Error('PNG must use 8-bit RGBA pixels');
  const decoded = zlib.inflateSync(Buffer.concat(idat));
  const expectedLength = (width * 4 + 1) * height;
  if (decoded.length !== expectedLength) throw new Error('PNG pixel data has an unexpected size');
  for (let y = 0; y < height; y += 1) {
    if (decoded[y * (width * 4 + 1)] > 4) throw new Error('PNG contains an invalid row filter');
  }
  return { mimeType: 'image/png', width, height, byteLength: buffer.length, decodable: true };
}

function inspectExperienceImage(filePath) {
  return inspectPngBuffer(fs.readFileSync(filePath));
}

function semanticMediaFamily(...values) {
  const semantic = values.flat().map((value) => String(value || '')).join(' ').toLowerCase();
  if (/\b(?:beauty|skin(?:care)?|cosmetic|makeup|serum|lotion|cream|balm|fragrance|perfume)\b/.test(semantic)) return 'beauty';
  if (/\b(?:watch(?:es)?|timepiece|chronograph|wristwatch|clock)\b/.test(semantic)) return 'watch';
  if (/\b(?:travel|luggage|suitcase|backpack|passport|organizer|adapter|journey|cabin|flight)\b|accessor/.test(semantic)) return 'travel';
  if (/\b(?:food|grocery|pantry|meal|drink|coffee|snack)\b/.test(semantic)) return 'food';
  if (/\b(?:health|wellness|fitness|exercise|meditation|yoga)\b/.test(semantic)) return 'wellness';
  return 'product';
}

function stableCandidateIndex(selector, length) {
  if (!length) return 0;
  if (Number.isInteger(selector)) return ((selector % length) + length) % length;
  const digest = crypto.createHash('sha256').update(String(selector ?? '')).digest();
  return digest.readUInt32BE(0) % length;
}

function approvedMediaUrl(family, selector = 0) {
  const normalizedFamily = Object.prototype.hasOwnProperty.call(APPROVED_CDN_MEDIA, family) ? family : 'product';
  const candidates = APPROVED_CDN_MEDIA[normalizedFamily];
  return candidates[stableCandidateIndex(selector, candidates.length)];
}

function assetFileName(assetKey) {
  const semanticPath = String(assetKey || '')
    .replace(/^asset:\/\/experience\//, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
  const withExtension = semanticPath.toLowerCase().endsWith('.png') ? semanticPath : `${semanticPath}.png`;
  return withExtension || 'experience-product.png';
}

function materializeExperienceAssets(projectRoot, manifest) {
  const root = path.resolve(projectRoot);
  const files = [];
  const assets = manifest.assets || {};
  const records = manifest.media?.records || {};
  for (const [assetKey, recipe] of Object.entries(assets)) {
    const relativePath = `assets/experience/${assetFileName(assetKey)}`;
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe experience asset path: ${relativePath}`);
    const png = createExperiencePng({ family: recipe.family, seed: `${assetKey}:${recipe.label || ''}` });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, png);
    const inspected = inspectPngBuffer(png);
    Object.assign(recipe, {
      kind: 'bundled-raster',
      source: 'generated-local',
      localPath: relativePath,
      mimeType: inspected.mimeType,
      width: inspected.width,
      height: inspected.height,
      byteLength: inspected.byteLength,
      sha256: crypto.createHash('sha256').update(png).digest('hex'),
      materialized: true,
    });
    files.push(relativePath);
  }

  let resolvedRecords = 0;
  for (const record of Object.values(records)) {
    const asset = assets[record.imageAssetKey];
    if (!asset?.materialized) continue;
    Object.assign(record, {
      imageLocalPath: asset.localPath,
      imageWidth: asset.width,
      imageHeight: asset.height,
      imageByteLength: asset.byteLength,
      imageSha256: asset.sha256,
    });
    resolvedRecords += 1;
  }
  manifest.media = {
    ...(manifest.media || {}),
    coverage: {
      expectedRecords: Object.keys(records).length,
      resolvedRecords,
    },
  };
  return { manifest, files };
}

module.exports = {
  APPROVED_CDN_MEDIA,
  approvedMediaUrl,
  createExperiencePng,
  inspectExperienceImage,
  inspectPngBuffer,
  materializeExperienceAssets,
  semanticMediaFamily,
};
