#!/usr/bin/env node

// Resolves the custom Dataverse tables a Power Pages site ACTUALLY references,
// so ALM table discovery stops scooping up every table that merely shares the
// publisher prefix (the `new_` / default-publisher over-count bug).
//
// SME-confirmed source of truth: "We rely on Table permissions from the site.
// If a table is used in the site that means there will be permissions for it."
// So the site's table permissions (+ the datamodel manifest) are the complete
// list of tables the site uses — no need to also scan forms/lists.
//
// Two steps, kept separate so the Dataverse query (custom-unmanaged tables) can
// be supplied by the caller (estimate-solution-size.js / discover-site-components.js):
//   1. collectReferencedEntityNames({ projectRoot, datamodelManifestPath })
//        -> the set of entity logical names the site references (local read).
//   2. scopeCustomTables(referencedNames, customUnmanagedTables)
//        -> the caller's custom-unmanaged table list, intersected with that set.
//
// Intersecting with custom-UNMANAGED tables drops standard tables (contact,
// annotation) and managed template tables — leaving exactly the tables the
// user's solution would own.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadTablePermissions } = require('./powerpages-config');

/**
 * Collects the entity logical names referenced by the site's table permissions
 * and its datamodel manifest (both local reads; no Dataverse).
 *
 * @param {object} opts
 * @param {string} [opts.projectRoot] - site project root (contains .powerpages-site/)
 * @param {string} [opts.datamodelManifestPath] - explicit manifest path (defaults to
 *        `<projectRoot>/.datamodel-manifest.json`)
 * @returns {{ names: Set<string>, available: boolean, sources: { tablePermissions: number, manifest: number } }}
 *          `names` are lowercased. `available` is false only when neither a
 *          `.powerpages-site/table-permissions/` directory nor a manifest was found.
 */
function collectReferencedEntityNames({ projectRoot, datamodelManifestPath } = {}) {
  const names = new Set();
  const sources = { tablePermissions: 0, manifest: 0 };
  let sawTablePermissionsDir = false;
  let sawManifest = false;

  // 1. Table permissions — `entitylogicalname` per `*.tablepermission.yml`.
  if (projectRoot) {
    const dir = path.join(projectRoot, '.powerpages-site', 'table-permissions');
    if (fs.existsSync(dir)) {
      sawTablePermissionsDir = true;
      // Count the permission FILES present — `sources.tablePermissions` must mean
      // "the site has table-permission files" (a reliable site-referenced signal,
      // consumed by `tableCountScope`), NOT "we parsed at least one record". A
      // temporarily-malformed file must not make a real site look manifest-only.
      try {
        sources.tablePermissions = fs.readdirSync(dir)
          .filter((f) => /\.tablepermission\.yml$/i.test(f)).length;
      } catch { /* keep 0 */ }
      let records = [];
      try { records = loadTablePermissions(dir); } catch { records = []; }
      for (const r of records) {
        const name = r && r.entitylogicalname;          // NOT entityname (that's the display label)
        if (typeof name === 'string' && name.trim()) {
          names.add(name.trim().toLowerCase());
        }
      }
    }
  }

  // 2. Datamodel manifest — tables created for this site by setup-datamodel.
  const manifestPath = datamodelManifestPath ||
    (projectRoot ? path.join(projectRoot, '.datamodel-manifest.json') : null);
  if (manifestPath && fs.existsSync(manifestPath)) {
    sawManifest = true;
    try {
      const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entries = man.entities || man.tables || [];
      for (const e of entries) {
        const name = e && (e.logicalName || e.LogicalName || e.name);
        if (typeof name === 'string' && name.trim()) {
          names.add(name.trim().toLowerCase());
          sources.manifest += 1;
        }
      }
    } catch {
      // Malformed manifest — ignore its contents but still count it as a signal.
    }
  }

  return { names, available: sawTablePermissionsDir || sawManifest, sources };
}

/**
 * Intersects the caller's custom-unmanaged table list with the referenced-name
 * set. Returns the tables the site actually uses (and that the user's solution
 * would own).
 *
 * @param {Set<string>} referencedNames - lowercased logical names (from collectReferencedEntityNames)
 * @param {{ logicalName: string }[]} customUnmanagedTables
 * @returns {{ logicalName: string }[]}
 */
function scopeCustomTables(referencedNames, customUnmanagedTables) {
  if (!referencedNames || referencedNames.size === 0) return [];
  return (customUnmanagedTables || []).filter(
    (t) => t && typeof t.logicalName === 'string' && referencedNames.has(t.logicalName.toLowerCase()),
  );
}

module.exports = { collectReferencedEntityNames, scopeCustomTables };
