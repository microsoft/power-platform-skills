#!/usr/bin/env node

// Creates a Dataverse solution via Web API.
// Solutions are containers for tables, columns, relationships, model-driven apps,
// and other customizations. Every new component lands in exactly one solution.
//
// Usage:
//   node create-solution.js <envUrl> <uniqueName> <friendlyName>
//     [--description <text>]
//     [--version 1.0.0.0]
//     [--publisher <uniqueName>]    (default: env's Default Publisher)
//
// uniqueName must be alphanumeric (camelCase or PascalCase), starting with a letter.
// No hyphens, no spaces, no underscores at the start. Returns lower-case in API
// responses regardless of what you submit.
//
// Output: { "ok": true, "solutionId": "...", "uniqueName": "...", "publisherUniqueName": "...", "publisherPrefix": "..." }

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');

async function findPublisher(envUrl, uniqueName) {
  // Explicit publisher requested → resolve by uniquename.
  if (uniqueName) {
    const res = await dataverseRequest(
      envUrl,
      'GET',
      `publishers?$select=publisherid,uniquename,customizationprefix&$filter=uniquename eq '${uniqueName.replace(/'/g, "''")}'&$top=1`,
    );
    ensureOk(res, `Lookup publisher '${uniqueName}'`);
    return res.data?.value?.[0] || null;
  }

  // No publisher specified → resolve the env's default publisher via the
  // organization record (authoritative; doesn't depend on friendly-name format
  // or env hostname). The organization table has exactly one row.
  try {
    const orgRes = await dataverseRequest(
      envUrl,
      'GET',
      "organizations?$select=_defaultpublisherid_value&$top=1",
    );
    const defaultPublisherId = orgRes.data?.value?.[0]?._defaultpublisherid_value;
    if (defaultPublisherId) {
      const pubRes = await dataverseRequest(
        envUrl,
        'GET',
        `publishers(${defaultPublisherId})?$select=publisherid,uniquename,customizationprefix`,
      );
      if (pubRes.status === 200 && pubRes.data?.publisherid) {
        return {
          publisherid: pubRes.data.publisherid,
          uniquename: pubRes.data.uniquename,
          customizationprefix: pubRes.data.customizationprefix,
        };
      }
    }
  } catch {
    // Fall through to the broad fallback below if the organization probe fails.
  }

  // Last-resort fallback — any non-readonly publisher. Used only if the
  // authoritative organization lookup above didn't return anything (rare).
  const fb = await dataverseRequest(
    envUrl,
    'GET',
    "publishers?$select=publisherid,uniquename,customizationprefix&$filter=isreadonly eq false&$top=1",
  );
  return fb.data?.value?.[0] || null;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    process.stderr.write(
      'Usage: node create-solution.js <envUrl> <uniqueName> <friendlyName> [--description <text>] [--version 1.0.0.0] [--publisher <uniqueName>]\n'
    );
    process.exit(1);
  }
  const [envUrl, uniqueName, friendlyName] = positional;

  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(uniqueName)) {
    emitResult(false, new Error(`uniqueName "${uniqueName}" must be alphanumeric (start with a letter, no spaces or hyphens)`));
    return;
  }

  try {
    const publisher = await findPublisher(envUrl, flags.publisher);
    if (!publisher) {
      emitResult(false, new Error('No publisher found in this environment. Specify --publisher <uniqueName>.'));
      return;
    }

    const body = {
      uniquename: uniqueName,
      friendlyname: friendlyName,
      description: flags.description || `${friendlyName} (created by /genpage)`,
      version: flags.version || '1.0.0.0',
      'publisherid@odata.bind': `/publishers(${publisher.publisherid})`,
    };

    const res = await dataverseRequest(envUrl, 'POST', 'solutions', body, { includeHeaders: true });
    ensureOk(res, `Create solution ${uniqueName}`);

    const entityUrl = res.headers && (res.headers['odata-entityid'] || res.headers['OData-EntityId']);
    let solutionId = null;
    if (entityUrl) {
      const m = String(entityUrl).match(/\(([0-9a-f-]{36})\)/i);
      if (m) solutionId = m[1];
    }

    emitResult(true, {
      ok: true,
      solutionId,
      uniqueName,
      friendlyName,
      publisherUniqueName: publisher.uniquename,
      publisherPrefix: publisher.customizationprefix,
    });
  } catch (e) {
    emitResult(false, e);
  }
}

main();
