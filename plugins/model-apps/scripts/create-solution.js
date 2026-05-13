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
// uniqueName must be alphanumeric, no spaces, kebab-or-camel case. Lower-case in
// API responses regardless of what you submit.
//
// Output: { "ok": true, "solutionId": "...", "uniqueName": "...", "publisherUniqueName": "...", "publisherPrefix": "..." }

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');

async function findPublisher(envUrl, uniqueName) {
  const filter = uniqueName
    ? `uniquename eq '${uniqueName.replace(/'/g, "''")}'`
    : `friendlyname eq 'Default Publisher for ${envUrl.replace(/^https:\/\//, '').split('.')[0]}'`;
  const res = await dataverseRequest(
    envUrl,
    'GET',
    `publishers?$select=publisherid,uniquename,customizationprefix&$filter=${encodeURIComponent(filter)}&$top=1`
  );
  ensureOk(res, `Lookup publisher${uniqueName ? ` '${uniqueName}'` : ' (env default)'}`);
  const p = res.data?.value?.[0];
  if (!p) {
    // Fallback: any non-readonly publisher (broad, used only when env-default lookup misses)
    const fb = await dataverseRequest(
      envUrl,
      'GET',
      "publishers?$select=publisherid,uniquename,customizationprefix&$filter=isreadonly eq false&$top=1"
    );
    return fb.data?.value?.[0] || null;
  }
  return p;
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
