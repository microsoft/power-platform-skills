#!/usr/bin/env node

// Single source of truth for turning a caller's token inputs into a usable ADO
// bearer token. The pure `resolveAdoToken` handles explicit inputs; the
// composed `resolveAdoTokenOrAcquire` adds the in-process self-acquire fallback
// (see below) so ADO helpers never need a token on disk or on the command line.
//
// NOTE: ADO tokens are NEVER persisted by this plugin (a token file under the
// project tree would be a source-control leak). The `--tokenFile` path below
// exists only for back-compat / CI: if a caller supplies a file, it may be a
// raw token OR a legacy JSON envelope ({ token, ... }) — we read it, we never
// write it.
//
// Resolution order (first match wins):
//   1. explicit token string        (e.g. --token <bearer>)
//   2. --tokenFile <path>           parse the file; if it's a JSON envelope,
//                                   extract `.token`; otherwise treat the file
//                                   content as a raw token.
//   3. ADO_TOKEN env var
//   4. error  (resolveAdoToken) / in-process acquire (resolveAdoTokenOrAcquire)
//
// The raw token is never logged. Callers pass the resolved token straight into
// an Authorization header.
//
// `resolveAdoToken` is PURE (no shell, no network) so it stays trivially
// testable. The credential-minting fallback lives in `resolveAdoTokenOrAcquire`
// below — keeping the two separate means the pure resolver can be unit-tested
// without ever shelling out to `az`.
//
// API:
//   const { resolveAdoToken } = require('./resolve-ado-token');
//   const r = resolveAdoToken({ token, tokenFile, env: process.env });
//   if (!r.ok) { /* surface r.error */ } else { use r.token }

'use strict';

const fs = require('fs');
const { acquireAdoToken } = require('./acquire-ado-token');

/**
 * @param {object} input
 * @param {string} [input.token]      Explicit raw token (highest priority).
 * @param {string} [input.tokenFile]  Path to a raw-token file OR a legacy JSON token envelope.
 * @param {object} [input.env]        Environment (defaults to process.env); reads ADO_TOKEN.
 * @param {(p: string) => string} [input._readFileImpl]  DI for file read (tests).
 * @returns {{ ok: true, token: string, source: string } | { ok: false, error: string }}
 */
function resolveAdoToken({ token, tokenFile, env = process.env, _readFileImpl } = {}) {
  // 1) explicit token
  if (typeof token === 'string' && token.trim()) {
    return { ok: true, token: token.trim(), source: 'token' };
  }

  // 2) tokenFile (raw or JSON envelope)
  if (typeof tokenFile === 'string' && tokenFile.trim()) {
    const read = typeof _readFileImpl === 'function' ? _readFileImpl : (p) => fs.readFileSync(p, 'utf8');
    let raw;
    try {
      raw = read(tokenFile);
    } catch (e) {
      return { ok: false, error: `Could not read --tokenFile '${tokenFile}': ${e.message}` };
    }
    const trimmed = String(raw).trim();
    if (!trimmed) {
      return { ok: false, error: `--tokenFile '${tokenFile}' is empty.` };
    }
    // Legacy JSON token envelope ({ token, ... })?
    if (trimmed.startsWith('{')) {
      let parsed;
      try { parsed = JSON.parse(trimmed); }
      catch (e) { return { ok: false, error: `--tokenFile '${tokenFile}' looks like JSON but failed to parse: ${e.message}` }; }
      if (parsed && typeof parsed.token === 'string' && parsed.token.trim()) {
        return { ok: true, token: parsed.token.trim(), source: 'tokenFile:json' };
      }
      return { ok: false, error: `--tokenFile '${tokenFile}' is a JSON envelope but has no non-empty "token" field.` };
    }
    // Raw token file.
    return { ok: true, token: trimmed, source: 'tokenFile:raw' };
  }

  // 3) ADO_TOKEN env var
  const envToken = env && typeof env.ADO_TOKEN === 'string' ? env.ADO_TOKEN.trim() : '';
  if (envToken) {
    return { ok: true, token: envToken, source: 'env:ADO_TOKEN' };
  }

  // 4) nothing
  return {
    ok: false,
    error: 'No ADO token provided. Pass --token <bearer>, --tokenFile <path> ' +
           '(raw token or a JSON token envelope), or set ADO_TOKEN.',
  };
}

module.exports = { resolveAdoToken, resolveAdoTokenOrAcquire };

/**
 * The production token resolver used by every ADO REST helper.
 *
 * Tries the explicit/env inputs first (via the pure `resolveAdoToken`); if none
 * is supplied, mints an ADO-scoped Entra token IN-PROCESS via
 * `acquire-ado-token.js` and returns it for immediate in-memory use. The minted
 * token is never written to disk, never printed, and never placed on a command
 * line — closing the credential-leak class of bug where a token file under the
 * project tree could be committed to source control.
 *
 * Resolution order:
 *   1. --token / --tokenFile / ADO_TOKEN   (delegated to resolveAdoToken)
 *   2. in-process `az account get-access-token`  (acquireAdoToken)
 *   3. error (actionable `az login` hint)
 *
 * Locked-down environments (e.g. CI that must forbid interactive credential
 * minting) can set `POWERPAGES_NO_ADO_ACQUIRE=1` to disable step 2; the helper
 * then behaves exactly like the pure `resolveAdoToken`.
 *
 * @param {object} input
 * @param {string}  [input.token]       Explicit raw token (highest priority).
 * @param {string}  [input.tokenFile]   Path to a raw-token file OR a JSON envelope.
 * @param {object}  [input.env]         Environment (defaults to process.env).
 * @param {Function} [input._readFileImpl] DI for file read (tests).
 * @param {Function} [input._acquireImpl]  DI for the in-process acquire (tests).
 * @returns {{ ok: true, token: string, source: string } | { ok: false, error: string }}
 */
function resolveAdoTokenOrAcquire({ token, tokenFile, env = process.env, _readFileImpl, _acquireImpl } = {}) {
  const resolved = resolveAdoToken({ token, tokenFile, env, _readFileImpl });
  if (resolved.ok) return resolved;

  // Kill switch for locked-down / non-interactive environments.
  const acquireDisabled = env && String(env.POWERPAGES_NO_ADO_ACQUIRE || '').trim() === '1';
  if (acquireDisabled) return resolved;

  const acquire = typeof _acquireImpl === 'function' ? _acquireImpl : acquireAdoToken;
  const acq = acquire();
  if (acq && acq.ok && typeof acq.token === 'string' && acq.token.trim()) {
    return { ok: true, token: acq.token.trim(), source: acq.source || 'az:acquire' };
  }
  return { ok: false, error: (acq && acq.error) || resolved.error };
}
