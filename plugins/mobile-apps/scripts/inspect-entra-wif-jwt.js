#!/usr/bin/env node

'use strict';

// Locally inspects the non-secret claims needed to configure Google WIF. This is
// intentionally a decoder, not a verifier: token acquisition and the later Google STS
// exchange prove authenticity, while this helper keeps the raw bearer token off argv,
// stdout, stderr, files, and third-party JWT inspection sites.

const MAX_TOKEN_BYTES = 64 * 1024;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  const error = new Error(message);
  error.safe = true;
  throw error;
}

function requiredString(payload, claim) {
  const value = payload[claim];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`JWT payload must contain a non-empty string ${claim} claim.`);
  }
  return value;
}

function optionalString(payload, claim) {
  const value = payload[claim];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`JWT ${claim} claim must be a non-empty string when present.`);
  }
  return value;
}

function googleProviderIssuer(issuer) {
  let url;
  try {
    url = new URL(issuer);
  } catch {
    fail('JWT iss claim must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('JWT iss claim must be a plain HTTPS issuer URL.');
  }

  // Dogfooding proved that an Entra v1 JWT reports:
  //   iss=https://sts.windows.net/<tenant-id>/
  // while Google's successfully configured OIDC provider requires:
  //   https://sts.windows.net/<tenant-id>
  // Preserve the authority and tenant exactly; only remove the terminal slash.
  if (url.hostname.toLowerCase() === 'sts.windows.net') {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1 || !GUID_RE.test(segments[0])) {
      fail('JWT sts.windows.net issuer must contain exactly one tenant GUID.');
    }
    return `https://sts.windows.net/${segments[0]}`;
  }

  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}

function inspectToken(token) {
  if (typeof token !== 'string' || token.trim() === '') fail('Expected a JWT on stdin.');
  const compact = token.trim();
  const parts = compact.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    fail('Input is not a three-segment JWT.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    fail('JWT payload is not valid base64url-encoded JSON.');
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    fail('JWT payload must be a JSON object.');
  }

  const iss = requiredString(payload, 'iss');
  const aud = requiredString(payload, 'aud');
  const appid = optionalString(payload, 'appid');
  const azp = optionalString(payload, 'azp');
  if (!appid && !azp) fail('JWT payload must contain appid or azp.');

  const result = {
    iss,
    aud,
    selectedAppClaim: appid ? 'appid' : 'azp',
    googleProviderIssuer: googleProviderIssuer(iss),
  };
  if (appid) result.appid = appid;
  if (azp) result.azp = azp;
  return result;
}

async function readStdin(stream) {
  let input = '';
  for await (const chunk of stream) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_TOKEN_BYTES) {
      fail(`JWT input exceeds ${MAX_TOKEN_BYTES} bytes.`);
    }
  }
  return input;
}

async function main(argv = process.argv.slice(2), stdin = process.stdin) {
  if (argv.length !== 0) fail('This helper accepts the JWT only on stdin; argv is not allowed.');
  const token = await readStdin(stdin);
  process.stdout.write(`${JSON.stringify(inspectToken(token), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    // All diagnostics are fixed or claim-name-only messages. Never interpolate input,
    // decoded values, parser excerpts, or upstream exceptions that could contain JWTs.
    process.stderr.write(`Error: ${error.safe ? error.message : 'Unable to inspect JWT.'}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  googleProviderIssuer,
  inspectToken,
  main,
  readStdin,
};
