#!/usr/bin/env node

// Creates a Dataverse solution via the SDK.
// Solutions are containers for tables, columns, relationships, model-driven apps,
// and other customizations. Every new component lands in exactly one solution.
//
// Usage:
//   node provision-solution.js <envUrl> <uniqueName> <friendlyName>
//     [--description <text>]
//     [--version 1.0.0.0]
//     [--publisher <uniqueName>]    (default: env's Default Publisher)
//
// uniqueName must be alphanumeric (camelCase or PascalCase), starting with a letter.
// No hyphens, no spaces, no underscores at the start. Returns lower-case in API
// responses regardless of what you submit.
//
// Output: { "ok": true, "solutionId": "...", "uniqueName": "...", "publisherUniqueName": "...", "publisherPrefix": "..." }

const { parseArgs, emitResult } = require('./lib/dataverse-auth');
const { createAzHttpClient } = require('./lib/sdk-http-client');

/**
 * Escapes single quotes for OData filters (RFC 4627 / OData convention: double single quotes).
 * @param {string} str
 * @returns {string}
 */
function odataEscape(str) {
  return String(str).replace(/'/g, "''");
}

/**
 * Finds the publisher to use for the solution:
 * - If publisherUniqueName is provided, looks up by uniquename
 * - Otherwise, resolves the environment's default publisher via the organization record
 * @param {object} sdk - SDK client with queryRecords
 * @param {string|null} publisherUniqueName - Explicit publisher uniquename or null for default
 * @returns {Promise<{publisherid: string, uniquename: string, customizationprefix: string}|null>}
 */
async function findPublisher(sdk, publisherUniqueName) {
  // Explicit publisher requested → resolve by uniquename.
  if (publisherUniqueName) {
    const rows = await sdk.queryRecords('publisher', {
      select: ['publisherid', 'uniquename', 'customizationprefix'],
      filter: `uniquename eq '${odataEscape(publisherUniqueName)}'`,
      top: 1,
    });
    return rows && rows.length > 0 ? rows[0] : null;
  }

  // No publisher specified → resolve the env's default publisher via the
  // **Default solution's** publisher. This is authoritative and portable: the
  // `Default` solution always exists and its publisher IS the environment's
  // default publisher. (The organization record does NOT expose a usable
  // `_defaultpublisherid_value` in every API version — it 400s on some envs —
  // so we resolve through the Default solution instead.)
  try {
    const solRows = await sdk.queryRecords('solution', {
      select: ['_publisherid_value'],
      filter: "uniquename eq 'Default'",
      top: 1,
    });
    const defaultPublisherId = solRows && solRows.length > 0 ? solRows[0]._publisherid_value : null;
    if (defaultPublisherId) {
      const pubRows = await sdk.queryRecords('publisher', {
        select: ['publisherid', 'uniquename', 'customizationprefix'],
        filter: `publisherid eq '${odataEscape(defaultPublisherId)}'`,
        top: 1,
      });
      if (pubRows && pubRows.length > 0) {
        return pubRows[0];
      }
    }
  } catch {
    // Fall through to the broad fallback below if the Default-solution probe fails.
  }

  // Last-resort fallback — any non-readonly publisher. Used only if the
  // authoritative organization lookup above didn't return anything (rare).
  const fallbackRows = await sdk.queryRecords('publisher', {
    select: ['publisherid', 'uniquename', 'customizationprefix'],
    filter: 'isreadonly eq false',
    top: 1,
  });
  return fallbackRows && fallbackRows.length > 0 ? fallbackRows[0] : null;
}

/**
 * Core logic for provisioning a solution. Exported for testability.
 * @param {object} args - { envUrl, uniqueName, friendlyName, description?, version?, publisherUniqueName? }
 * @param {object} deps - { sdk } — dependency injection for tests
 * @returns {Promise<{ok: boolean, solutionId?: string, uniqueName?: string, friendlyName?: string, publisherUniqueName?: string, publisherPrefix?: string, error?: string}>}
 */
async function runProvisionSolution(args, deps) {
  const { envUrl, uniqueName, friendlyName, description, version, publisherUniqueName } = args;
  const { sdk } = deps;

  // Validate uniqueName (alphanumeric, start with letter, no spaces/hyphens)
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(uniqueName)) {
    return {
      ok: false,
      error: `uniqueName "${uniqueName}" must be alphanumeric (start with a letter, no spaces or hyphens)`,
    };
  }

  try {
    // Resolve publisher
    const publisher = await findPublisher(sdk, publisherUniqueName || null);
    if (!publisher) {
      const msg = publisherUniqueName
        ? `No publisher '${publisherUniqueName}' found. Specify a valid --publisher.`
        : 'No publisher found in this environment. Specify --publisher <uniqueName>.';
      return { ok: false, error: msg };
    }

    // Create solution via SDK
    const result = await sdk.createSolution({
      uniqueName,
      friendlyName,
      description: description || `${friendlyName} (created by /genpage)`,
      version: version || '1.0.0.0',
      publisherId: publisher.publisherid,
    });

    return {
      ok: true,
      solutionId: result.id,
      uniqueName,
      friendlyName,
      publisherUniqueName: publisher.uniquename,
      publisherPrefix: publisher.customizationprefix,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    process.stderr.write(
      'Usage: node provision-solution.js <envUrl> <uniqueName> <friendlyName> [--description <text>] [--version 1.0.0.0] [--publisher <uniqueName>]\n'
    );
    process.exit(1);
  }
  const [envUrl, uniqueName, friendlyName] = positional;

  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(envUrl);
  const sdkTempDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'provision-solution-'));
  const sdk = createMakerSdk({
    workspacePath: sdkTempDir, // unused workspace (no metadata persistence needed)
    instanceUrl: envUrl,
    httpClient,
  });

  try {
    const result = await runProvisionSolution(
      {
        envUrl,
        uniqueName,
        friendlyName,
        description: flags.description,
        version: flags.version,
        publisherUniqueName: flags.publisher,
      },
      { sdk }
    );

    if (result.ok) {
      emitResult(true, result);
    } else {
      emitResult(false, new Error(result.error));
    }
  } catch (e) {
    emitResult(false, e);
  } finally {
    require('fs').rmSync(sdkTempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main();
}

module.exports = { runProvisionSolution, findPublisher, odataEscape };
