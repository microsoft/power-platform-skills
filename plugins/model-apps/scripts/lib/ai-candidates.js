'use strict';
// Pure helper: select which entities from an App Spec should have AI summaries generated.
// No Dataverse / network access — operates entirely on the spec object.

const D365_OWNED = new Set(['incident', 'lead', 'opportunity']);

const DESCRIPTIVE_TYPES = new Set([
  'Text', 'Memo', 'Choice', 'MultiChoice', 'Boolean', 'Money',
  'DateTime', 'Integer', 'BigInt', 'Decimal', 'Double',
]);

/**
 * Return entity schemaNames (original casing) that are candidates for AI summaries.
 * @param {object} spec - App Spec object
 * @returns {string[]}
 */
function selectSummaryTables(spec) {
  const entities = spec.entities || [];
  const summaries = (spec.ai && spec.ai.summaries) || {};
  const tableOverrides = summaries.tables || {};
  const defaultOff = summaries.default === 'off';

  // Build a case-insensitive lookup for override entries.
  // Map from lowercased key → { enabled, ... }
  const overrideMap = new Map();
  for (const [key, val] of Object.entries(tableOverrides)) {
    overrideMap.set(key.toLowerCase(), val);
  }

  const result = [];

  for (const entity of entities) {
    const schema = entity.schemaName;
    const schemaLc = schema.toLowerCase();

    // D365-owned — never included regardless of overrides.
    if (D365_OWNED.has(schemaLc)) continue;

    const override = overrideMap.get(schemaLc);

    // Explicit exclusion.
    if (override && override.enabled === false) continue;

    const hasDescriptive = (entity.columns || []).some((c) => DESCRIPTIVE_TYPES.has(c.type));

    // Explicit inclusion (enabled === true) bypasses the descriptive-columns filter.
    if (override && override.enabled === true) {
      result.push(schema);
      continue;
    }

    // When default is 'off', only explicit opt-ins (handled above) are included.
    if (defaultOff) continue;

    // Standard rule: must have at least one descriptive column.
    if (!hasDescriptive) continue;

    result.push(schema);
  }

  return result;
}

module.exports = { selectSummaryTables };
