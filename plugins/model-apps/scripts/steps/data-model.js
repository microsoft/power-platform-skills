const { columnTypeMap, relationshipSchemaName } = require('../lib/app-spec.js');

// --- 1. Data model: solution + tables + columns + relationships (via dv-* scripts).
async function dataModel(spec, opts, deps, result) {
  const env = opts.env;
  const sol = spec.solution;
  deps.step(`solution ${sol.uniqueName}`);
  // Resolve the publisher whose customization prefix matches the spec, so the
  // entity/column schema names (e.g. new_project) are accepted. Falls back to the
  // env's default publisher if none is found.
  let publisherUnique = null;
  try {
    const pubRes = await deps.dv(
      'GET',
      `publishers?$select=uniquename&$filter=customizationprefix eq '${sol.publisherPrefix}'`
    );
    const pubs = (pubRes && pubRes.data && pubRes.data.value) || [];
    publisherUnique = pubs[0] && pubs[0].uniquename;
  } catch (e) {
    /* fall back to the env's default publisher */
  }
  const solArgs = [env, sol.uniqueName, sol.displayName || sol.uniqueName];
  if (publisherUnique) {
    solArgs.push('--publisher', publisherUnique);
  }
  deps.runScript('create-solution.js', solArgs);

  result.created.entities = {};
  for (const e of spec.entities) {
    deps.step(`table ${e.schemaName} ("${e.displayName}")`);
    const t = deps.runScript('create-table.js', [
      env,
      e.schemaName,
      e.displayName,
      e.pluralName || e.displayName + 's',
      '--primary-name',
      e.primaryAttribute.displayName,
      '--primary-name-logical',
      e.primaryAttribute.schemaName,
      '--solution',
      sol.uniqueName,
    ]);
    result.created.entities[e.schemaName] = {
      logicalName: (t.logicalName || e.schemaName).toLowerCase(),
      metadataId: t.metadataId,
    };
    for (const c of e.columns || []) {
      const map = columnTypeMap(c.type || 'Text');
      if (!map.dv) {
        deps.log(`skip column ${c.schemaName} (type ${c.type} not via add-column)`);
        continue;
      }
      deps.step(`column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`);
      const args = [env, e.schemaName.toLowerCase(), c.schemaName, c.displayName || c.schemaName, map.dv, '--solution', sol.uniqueName];
      if (c.type === 'Choice') {
        args.push('--options', JSON.stringify((c.options || []).map((label, i) => ({ value: 100000000 + i, label }))));
      }
      deps.runScript('add-column.js', args);
    }
  }

  for (const rel of spec.relationships || []) {
    if (rel.type !== 'OneToMany') {
      deps.log(`skip relationship type ${rel.type}`);
      continue;
    }
    deps.step(`relationship ${rel.referenced}->${rel.referencing}`);
    deps.runScript('create-relationship.js', [
      '1n',
      env,
      relationshipSchemaName(rel), // relationship schema name — MUST differ from the lookup name
      rel.referenced.toLowerCase(),
      rel.referencing.toLowerCase(),
      rel.lookup.schemaName, // the lookup attribute created on the referencing table
      rel.lookup.displayName,
      '--solution',
      sol.uniqueName,
    ]);
  }
}

module.exports = { dataModel };
