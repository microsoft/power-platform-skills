// Downloads a third-party file that the plugin runs - today only the axe-core script the
// accessibility audit injects into pages - and refuses it unless its bytes match a hash
// committed in this repository. A versioned CDN URL is still mutable input (a compromised
// CDN or account can change what it serves), so the committed hash is the integrity record
// the runtime-dependency rule in AGENTS.md requires.
//
// The hash uses the Subresource Integrity format, `<algorithm>-<base64 digest>`, so it can be
// checked against the value a CDN publishes. See: https://www.w3.org/TR/SRI/#integrity-metadata

const crypto = require('node:crypto');
const https = require('node:https');

const SUPPORTED_ALGORITHMS = new Set(['sha256', 'sha384', 'sha512']);
const DEFAULT_TIMEOUT_MS = 30000;

function parseIntegrity(integrity) {
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity || ''));
  if (!match || !SUPPORTED_ALGORITHMS.has(match[1])) {
    throw new Error(`Unsupported integrity value: ${integrity}`);
  }
  return { algorithm: match[1], digest: match[2] };
}

function integrityOf(buffer, algorithm) {
  return `${algorithm}-${crypto.createHash(algorithm).update(buffer).digest('base64')}`;
}

function matchesIntegrity(buffer, integrity) {
  const { algorithm } = parseIntegrity(integrity);
  return integrityOf(buffer, algorithm) === integrity;
}

// Fetches `url` over HTTPS into memory, following no redirects (a moved asset should fail
// loudly rather than be fetched from wherever it now points), and rejects a body larger than
// `maxBytes` or one whose hash differs from `integrity`.
function downloadPinned({ url, integrity, maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS, httpsImpl = https }) {
  parseIntegrity(integrity);
  if (new URL(url).protocol !== 'https:') {
    return Promise.reject(new Error(`Refusing to download ${url}: only https is allowed.`));
  }
  return new Promise((resolve, reject) => {
    const req = httpsImpl.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} failed with ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      res.on('data', (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > maxBytes) {
          tooLarge = true;
          reject(new Error(`GET ${url} exceeded ${maxBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (tooLarge) return;
        const body = Buffer.concat(chunks);
        if (!matchesIntegrity(body, integrity)) {
          reject(new Error(`${url} does not match its pinned ${parseIntegrity(integrity).algorithm} hash; refusing to run it.`));
          return;
        }
        resolve(body);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

module.exports = {
  downloadPinned,
  integrityOf,
  matchesIntegrity,
  parseIntegrity,
};
