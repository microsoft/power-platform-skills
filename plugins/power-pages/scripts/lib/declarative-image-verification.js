const dns = require('node:dns').promises;
const https = require('node:https');
const { BlockList, isIP } = require('node:net');
const { inspectAssetBuffer, DEFAULT_MAX_BYTES } = require('./declarative-asset-preparation');
const { planHash, validateCustomizationPlan } = require('./customize-declarative-site-plan');

const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 3;
const CONCURRENCY = 3;
const IMAGE_TYPES = new Set([
  'image/png', 'image/apng', 'image/jpeg', 'image/webp', 'image/gif',
  'image/avif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon',
]);
const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) privateAddresses.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  privateAddresses.addSubnet(address, prefix, 'ipv6');
}

function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !privateAddresses.check(address, 'ipv4') :
    family === 6 && globalV6.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6');
}

function imageUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\\\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Image checks require an absolute HTTPS URL without whitespace or backslashes.');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Image checks require HTTPS without credentials.');
  }
  return url;
}

function externalImageUrls(plan) {
  return [...new Set(plan.assets.filter((asset) => asset.delivery === 'external-url')
    .map((asset) => asset.externalUrl))];
}

function withinDeadline(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Image check timed out.')), Math.max(1, milliseconds));
    }),
  ]).finally(() => clearTimeout(timer));
}

async function resolvePublicHost(url, resolve, remaining) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] :
    await withinDeadline(resolve(hostname, { all: true, verbatim: true }), remaining);
  // Checking every DNS answer and pinning the chosen address into the HTTPS
  // lookup prevents public names/redirects from reaching private services or
  // rebinding after validation. Never forward auth, cookies or referrers.
  // Address classifications: https://www.iana.org/assignments/iana-ipv4-special-registry/
  // and https://www.iana.org/assignments/iana-ipv6-special-registry/
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error('Image URL must resolve only to public Internet addresses.');
  }
  return addresses[0];
}

function readResponse(url, address, { request, remaining, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
      response?.destroy();
      req?.destroy();
    };
    // A wall-clock deadline also stops trickle responses; a socket idle timeout
    // alone can be kept alive forever. No image bytes are written to disk.
    const timer = setTimeout(() => finish(new Error('Image check timed out.')), Math.max(1, remaining));
    try {
      req = request(url, {
        method: 'GET',
        agent: false,
        lookup: (_hostname, options, callback) => options.all
          ? callback(null, [address]) : callback(null, address.address, address.family),
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
          'Accept-Encoding': 'identity',
          'User-Agent': 'power-platform-skills-image-verification',
        },
      }, (res) => {
        response = res;
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('Image response ended before completion.')));
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          finish(null, { redirect: response.headers.location });
          return;
        }
        if (response.statusCode !== 200) {
          finish(new Error(`Image URL returned HTTP ${response.statusCode || 'unknown'}.`));
          return;
        }
        const mimeType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!IMAGE_TYPES.has(mimeType)) {
          finish(new Error(`Expected a supported image response, received ${mimeType || 'no Content-Type'}.`));
          return;
        }
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          finish(new Error(`Unexpected image Content-Encoding ${encoding}; choose a directly readable image URL.`));
          return;
        }
        if (Number(response.headers['content-length']) > maxBytes) {
          finish(new Error(`Image exceeds the ${maxBytes}-byte check limit; choose a smaller CDN variant.`));
          return;
        }
        const chunks = [];
        let sizeBytes = 0;
        response.on('data', (chunk) => {
          sizeBytes += chunk.length;
          if (sizeBytes > maxBytes) {
            finish(new Error(`Image exceeds the ${maxBytes}-byte check limit; choose a smaller CDN variant.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(null, { buffer: Buffer.concat(chunks), mimeType }));
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
    }
  });
}

function inspectHostedImage(buffer, mimeType) {
  if (!buffer.length) throw new Error('Image response is empty.');
  const extension = {
    'image/png': '.png', 'image/apng': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  }[mimeType];
  if (extension) {
    inspectAssetBuffer(buffer, `image${extension}`, mimeType === 'image/apng' ? 'image/png' : mimeType);
    return;
  }
  // Verify content signatures, not just a possibly incorrect Content-Type.
  // This is an HTTP/content check, not a full browser decoder or rendering proof.
  // SVG-as-image does not inherit the stricter SVG Web File import policy:
  // https://www.w3.org/TR/SVG2/conform.html#secure-static-mode
  if (mimeType === 'image/svg+xml') {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim()
      .replace(/^<\?xml[^>]*>\s*/i, '').replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
    if (/^<svg(?:\s|>)/i.test(text) && /(?:<\/svg\s*>|\/>)\s*$/i.test(text)) return;
  } else if (mimeType === 'image/gif') {
    if (buffer.length >= 14 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) &&
        buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0 && buffer.at(-1) === 0x3b) return;
  } else if (mimeType === 'image/avif') {
    // ISO BMFF ftyp: size, "ftyp", major brand, minor version, compatible brands.
    const size = buffer.length >= 16 ? buffer.readUInt32BE(0) : 0;
    if (size >= 16 && size <= buffer.length && buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brands = [buffer.toString('ascii', 8, 12)];
      for (let offset = 16; offset + 4 <= size; offset += 4) brands.push(buffer.toString('ascii', offset, offset + 4));
      if (brands.some((brand) => ['avif', 'avis'].includes(brand))) return;
    }
  } else if (['image/x-icon', 'image/vnd.microsoft.icon'].includes(mimeType)) {
    if (buffer.length >= 22 && buffer.readUInt32LE(0) === 0x00010000 && buffer.readUInt16LE(4) > 0) return;
  }
  throw new Error(`Response content is not a recognizable ${mimeType} image.`);
}

async function checkImage(value, options = {}) {
  const { request = https.request, resolve = dns.lookup, timeoutMs = TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Image check timeout and byte limit must be positive integers.');
  }
  const deadline = Date.now() + timeoutMs;
  let url = imageUrl(value);
  for (let redirects = 0; ; redirects += 1) {
    const address = await resolvePublicHost(url, resolve, deadline - Date.now());
    if (Date.now() >= deadline) throw new Error('Image check timed out.');
    const result = await readResponse(url, address, { request, remaining: deadline - Date.now(), maxBytes });
    if (Object.hasOwn(result, 'redirect')) {
      if (!result.redirect) throw new Error('Image redirect has no Location header.');
      if (redirects >= MAX_REDIRECTS) throw new Error('Image check exceeded the redirect limit.');
      url = imageUrl(new URL(result.redirect, url).href);
      continue;
    }
    inspectHostedImage(result.buffer, result.mimeType);
    return {
      url: value, finalUrl: url.href, statusCode: 200,
      mimeType: result.mimeType, sizeBytes: result.buffer.length, checkedAt: new Date().toISOString(),
    };
  }
}

async function verifyPlanImages(plan, { check = checkImage } = {}) {
  validateCustomizationPlan(plan);
  const urls = externalImageUrls(plan);
  const images = new Array(urls.length);
  const failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next++;
      try { images[index] = await check(urls[index]); }
      catch (error) { failures.push({ url: urls[index], error: error.message }); }
    }
  }));
  if (failures.length) {
    throw new Error(`Image verification failed:\n${failures.map((failure) => {
      const names = plan.assets.filter((asset) => asset.externalUrl === failure.url).map((asset) => asset.name).join(', ');
      return `- ${names}: ${failure.error} Source: ${failure.url}`;
    }).join('\n')}\nChoose a working direct image URL from the source page and regenerate the review. Do not approve or import a failed image.`);
  }
  const report = { schemaVersion: 1, planHash: planHash(plan), images };
  validateImageChecks(plan, report);
  return report;
}

function validateImageChecks(plan, report) {
  const urls = externalImageUrls(plan);
  if (!report || report.schemaVersion !== 1 || report.planHash !== planHash(plan) ||
      !Array.isArray(report.images) || report.images.length !== urls.length) {
    throw new Error('Missing or stale image checks. Render a fresh review to verify this exact plan before approval.');
  }
  const checked = new Set();
  for (const image of report.images) {
    if (!image || !urls.includes(image.url) || checked.has(image.url) || image.statusCode !== 200 ||
        !IMAGE_TYPES.has(image.mimeType) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 ||
        typeof image.checkedAt !== 'string' || !Number.isFinite(Date.parse(image.checkedAt))) {
      throw new Error('Image checks contain missing, failed or invalid results. Render a fresh review before approval.');
    }
    imageUrl(image.finalUrl);
    checked.add(image.url);
  }
  return report;
}

module.exports = {
  checkImage, externalImageUrls, inspectHostedImage, isPublicAddress,
  validateImageChecks, verifyPlanImages,
};
