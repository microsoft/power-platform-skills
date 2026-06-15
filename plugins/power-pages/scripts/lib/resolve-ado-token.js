#!/usr/bin/env node

// Single source of truth for turning a caller's token inputs into a usable ADO
// bearer token. Removes the B4 foot-gun: get-ado-token.js --writeToFile writes a
// JSON envelope ({ token, tokenFile, tokenSha256 }), but the ADO helpers used to
// accept only a raw --token, so passing the envelope path failed with "Invalid
// character in header content".
//
// Resolution order (first match wins):
//   1. explicit token string        (e.g. --token <bearer>)
//   2. --tokenFile <path>           parse the file; if it's the JSON envelope,
//                                   extract `.token`; otherwise treat the file
//                                   content as a raw token.
//   3. ADO_TOKEN env var
//   4. error
//
// The raw token is never logged. Callers pass the resolved token straight into
// an Authorization header.
//
// API:
//   const { resolveAdoToken } = require('./resolve-ado-token');
//   const r = resolveAdoToken({ token, tokenFile, env: process.env });
//   if (!r.ok) { /* surface r.error */ } else { use r.token }

'use strict';

const fs = require('fs');

/**
 * @param {object} input
 * @param {string} [input.token]      Explicit raw token (highest priority).
 * @param {string} [input.tokenFile]  Path to a raw-token file OR the get-ado-token JSON envelope.
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
    // JSON envelope from get-ado-token.js --writeToFile?
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
           '(raw or the get-ado-token.js --writeToFile envelope), or set ADO_TOKEN.',
  };
}

module.exports = { resolveAdoToken };
