#!/usr/bin/env node

// Single source of truth for minting an Azure DevOps-scoped Microsoft Entra
// bearer token IN-PROCESS, for immediate in-memory use.
//
// SECURITY MODEL (why this module exists):
//   The token is a live credential. It MUST NOT be persisted to any
//   locally-accessible artifact — not a file under the project tree, not an OS
//   temp file, not stdout (which is captured in session/event logs), and not a
//   command-line argument (which is visible in process listings and shell
//   history). This helper acquires the token, hands it back to the calling
//   process, and that caller uses it directly in an Authorization header. The
//   token never leaves the process boundary as an artifact.
//
//   This is the durable fix for the credential-leak class of bug: customers
//   keep their project (including docs/inner-loop/) in source control, so any
//   token written under the tree risks being committed. By never writing the
//   token at all, that entire risk disappears regardless of .gitignore state.
//
// Azure DevOps accepts Entra OAuth bearer tokens for its REST APIs. The ADO
// Entra application has a tenant-invariant resource id:
//   499b84ac-1321-427f-aa17-267ca6975798
// This GUID is identical in every tenant and is the documented resource
// identifier for ADO API access. See:
//   https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/entra
//
// API (library — no token ever goes to stdout):
//   const { acquireAdoToken } = require('./acquire-ado-token');
//   const r = acquireAdoToken();        // sync
//   if (!r.ok) { /* surface r.error (actionable `az login` hint) */ }
//   else { useImmediately(r.token); }   // r.token, r.tenantId, r.expiresOn
//
// Synchronous by design: every ADO helper resolves its token synchronously
// (resolve-ado-token.js), so this stays sync (execSync) to slot in without
// forcing those call sites async.

'use strict';

const { execSync } = require('child_process');

// Tenant-invariant ADO Entra resource id (same in every tenant).
const ADO_ENTRA_RESOURCE_GUID = '499b84ac-1321-427f-aa17-267ca6975798';

/**
 * Mints an ADO-scoped Entra token via `az account get-access-token`.
 *
 * The token is returned for immediate in-memory use only. This function never
 * writes the token anywhere and never prints it.
 *
 * @param {object} [opts]
 * @param {(cmd: string, options: object) => (string|Buffer)} [opts._execImpl]
 *        DI hook for child_process.execSync (tests). Receives the full `az`
 *        command and must return the raw stdout (JSON) or throw like execSync.
 * @returns {{ ok: true, token: string, tenantId: string|null, expiresOn: string|null, source: string }
 *          | { ok: false, error: string }}
 */
function acquireAdoToken({ _execImpl } = {}) {
  const exec = _execImpl || execSync;
  const cmd =
    `az account get-access-token --resource ${ADO_ENTRA_RESOURCE_GUID} ` +
    `--query "{token:accessToken, expiresOn:expiresOn, tenantId:tenant}" -o json`;

  let raw;
  try {
    raw = exec(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  } catch (e) {
    const stderr = (e && e.stderr && e.stderr.toString()) || '';
    const detail = stderr.trim() || (e && e.message) || 'unknown';
    return {
      ok: false,
      error:
        "az CLI not authenticated or not installed. Run 'az login' first. " +
        `Detail: ${detail}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : (raw || '').toString());
  } catch (e) {
    return { ok: false, error: 'az returned non-JSON output: ' + (e && e.message) };
  }
  if (!parsed || !parsed.token) {
    return { ok: false, error: 'az returned no accessToken field. Run "az login" and retry.' };
  }

  return {
    ok: true,
    token: String(parsed.token),
    tenantId: parsed.tenantId ? String(parsed.tenantId) : null,
    expiresOn: parsed.expiresOn ? String(parsed.expiresOn) : null,
    source: 'az:acquire',
  };
}

module.exports = { acquireAdoToken, ADO_ENTRA_RESOURCE_GUID };
