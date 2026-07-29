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
// uniqueName must start with a letter, then letters, digits, or underscores
// (no hyphens, no spaces). Returns lower-case in API responses regardless of
// what you submit.
//
// Output: { "ok": true, "solutionId": "...", "uniqueName": "...", "publisherUniqueName": "...", "publisherPrefix": "..." }

const { parseArgs, emitResult } = require('./lib/dataverse-auth');
const { createAzHttpClient } = require('./lib/sdk-http-client');
const { odataLit } = require('./lib/odata.js');

/**
 * Finds the publisher to use for the solution:
 * - If publisherUniqueName is provided, looks up by uniquename
 * - Otherwise, resolves the environment's default publisher via the **Default solution's**
 *   publisher (the organization record does not expose a usable default-publisher value on
 *   every API version)
 * @param {object} sdk - SDK client with queryRecords
 * @param {string|null} publisherUniqueName - Explicit publisher uniquename or null for default
 * @returns {Promise<{publisherid: string, uniquename: string, customizationprefix: string}|null>}
 */
async function findPublisher(sdk, publisherUniqueName) {
  // Explicit publisher requested → resolve by uniquename.
  if (publisherUniqueName) {
    const rows = await sdk.queryRecords('publisher', {
      select: ['publisherid', 'uniquename', 'customizationprefix'],
      filter: `uniquename eq '${odataLit(publisherUniqueName)}'`,
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
        filter: `publisherid eq ${defaultPublisherId}`,
        top: 1,
      });
      if (pubRows && pubRows.length > 0) {
        return pubRows[0];
      }
    }
  } catch {
    // Fall through to the broad fallback below if the Default-solution probe fails.
  }

  // Last-resort fallback — any non-readonly publisher. Used only if the Default-solution
  // publisher probe above didn't return anything (rare).
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

  // Validate uniqueName (letters, digits, underscores; must start with a letter)
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(uniqueName)) {
    return {
      ok: false,
      error: `uniqueName "${uniqueName}" must start with a letter and contain only letters, digits, and underscores (no spaces or hyphens)`,
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
      description: description || `${friendlyName} (created by Power Platform model-apps)`,
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

  const sdkTempDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'provision-solution-'));

  let result;
  let error;
  try {
    const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
    const httpClient = createAzHttpClient(envUrl);
    const sdk = createMakerSdk({
      workspacePath: sdkTempDir, // unused workspace (no metadata persistence needed)
      instanceUrl: envUrl,
      httpClient,
    });
    // initWorkspace() is INSIDE the try so the finally below always removes the temp workspace, even
    // if SDK construction or init itself throws (otherwise a failed constructor leaked sdkTempDir).
    // Consistent with teardown-model-app's fail-safe pattern; harmless for the Dataverse-only ops here.
    sdk.initWorkspace();
    result = await runProvisionSolution(
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
  } catch (e) {
    error = e;
  } finally {
    // emitResult() calls process.exit(), so remove the temp workspace BEFORE emitting.
    try {
      require('fs').rmSync(sdkTempDir, { recursive: true, force: true });
    } catch {
      // Preserve the primary provisioning error. Temp cleanup is best-effort because Windows can keep
      // a transient handle open after SDK initialization, and masking the real Dataverse/SDK failure
      // would make the script harder to recover.
    }
  }

  if (error) emitResult(false, error);
  else if (result.ok) emitResult(true, result);
  else emitResult(false, new Error(result.error));
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { runProvisionSolution, findPublisher, odataEscape: odataLit };
