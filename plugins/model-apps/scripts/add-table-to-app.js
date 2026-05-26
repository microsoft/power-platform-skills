#!/usr/bin/env node

// Adds a Dataverse entity (table) to a model-driven app's components list so
// it appears in the app designer's "Add a table" picker and so subsequent
// pages can reference it without manual addition.
//
// Background: `pac model genpage upload --data-sources <entities>` tells the
// uploaded page which entities to bind, but does NOT register those entities
// as app components on the underlying appmodule. As a result, makers opening
// the app in the designer see "the app contains no tables" even when an
// uploaded page references several. This script closes that gap.
//
// Usage:
//   node add-table-to-app.js <envUrl> <appId> <entityLogicalName>
//
// Arguments:
//   <envUrl>             Dataverse env URL, e.g. https://org.crm.dynamics.com
//   <appId>              appmodule GUID (from `pac model create` / `pac model list`)
//   <entityLogicalName>  e.g. "account", "cr_ticket"
//
// Idempotent: if the entity is already an app component, the script returns
// `{ ok: true, action: "skipped" }`. Safe to call on every upload.
//
// Output (added):   { "ok": true, "action": "added",   "appComponentId": "<guid>", "metadataId": "<guid>" }
// Output (skipped): { "ok": true, "action": "skipped", "appComponentId": "<guid>", "metadataId": "<guid>" }
//
// Exit codes: 0 on success (added or skipped), 1 on error.

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');

async function getEntityMetadataId(envUrl, logicalName) {
  const res = await dataverseRequest(
    envUrl,
    'GET',
    `EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')?$select=MetadataId`,
  );
  ensureOk(res, `Resolve entity '${logicalName}'`);
  if (!res.data?.MetadataId) {
    throw new Error(`Entity '${logicalName}' returned no MetadataId`);
  }
  return res.data.MetadataId;
}

async function findExistingComponent(envUrl, appId, metadataId) {
  // appmodulecomponent rows for componenttype=1 (Entity) carry the entity's
  // MetadataId in objectid. The lookup column to appmodule is
  // _appmoduleidunique_value (the navigation property is appmoduleidunique).
  const filter =
    `_appmoduleidunique_value eq ${appId}` +
    ` and componenttype eq 1` +
    ` and objectid eq ${metadataId}`;
  const res = await dataverseRequest(
    envUrl,
    'GET',
    `appmodulecomponents?$filter=${encodeURIComponent(filter)}&$select=appmodulecomponentid&$top=1`,
  );
  ensureOk(res, 'Query existing app components');
  return res.data?.value?.[0]?.appmodulecomponentid ?? null;
}

async function addComponent(envUrl, appId, metadataId) {
  const body = {
    'appmoduleidunique@odata.bind': `/appmodules(${appId})`,
    componenttype: 1, // Entity
    objectid: metadataId,
  };
  const res = await dataverseRequest(envUrl, 'POST', 'appmodulecomponents', body, {
    includeHeaders: true,
  });
  ensureOk(res, `Add entity ${metadataId} to app ${appId}`);
  // The POST returns the created record (or its header); extract the id.
  const loc =
    res.headers?.['odata-entityid'] ||
    res.headers?.['OData-EntityId'] ||
    res.headers?.location;
  const m = loc ? String(loc).match(/\(([0-9a-f-]{36})\)/i) : null;
  return m ? m[1] : null;
}

async function main() {
  const { positional } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    process.stderr.write(
      'Usage: node add-table-to-app.js <envUrl> <appId> <entityLogicalName>\n',
    );
    process.exit(1);
  }
  const [envUrl, appId, entityLogicalName] = positional;

  if (!/^[0-9a-f-]{36}$/i.test(appId)) {
    emitResult(false, new Error(`appId must be a GUID, got "${appId}"`));
    return;
  }
  if (!/^[a-z][a-z0-9_]+$/.test(entityLogicalName)) {
    emitResult(
      false,
      new Error(
        `entityLogicalName must be a Dataverse logical name (lowercase letters/digits/underscore, starting with a letter). Got "${entityLogicalName}".`,
      ),
    );
    return;
  }

  try {
    const metadataId = await getEntityMetadataId(envUrl, entityLogicalName);
    const existing = await findExistingComponent(envUrl, appId, metadataId);
    if (existing) {
      emitResult(true, {
        ok: true,
        action: 'skipped',
        reason: 'entity already an app component',
        appComponentId: existing,
        metadataId,
        entityLogicalName,
      });
      return;
    }
    const appComponentId = await addComponent(envUrl, appId, metadataId);
    emitResult(true, {
      ok: true,
      action: 'added',
      appComponentId,
      metadataId,
      entityLogicalName,
    });
  } catch (e) {
    emitResult(false, e);
  }
}

main();
