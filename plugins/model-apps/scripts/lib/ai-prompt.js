'use strict';
// Pure helper: build a PromptSpec for a single entity's AI summary.
// No Dataverse / network access — operates entirely on the spec entity object.

// Column types preferred over Memo for summary columns.
const PREFERRED_TYPES = new Set([
  'Choice', 'MultiChoice', 'DateTime', 'Money', 'Integer',
  'Decimal', 'Double', 'Boolean', 'Text',
]);

// Column types that are never useful in a summary.
const EXCLUDED_TYPES = new Set(['File', 'Image', 'Lookup', 'AutoNumber']);

/**
 * Build a PromptSpec for one entity.
 * @param {object} entity - A spec.entities[] element.
 * @param {{ spec: object, override?: object }} opts
 * @returns {{ instruction: string, entityLogicalName: string, primaryKey: string, columns: {logical:string,display:string}[], outputFormat: 'text' }}
 */
function buildPromptSpec(entity, opts) {
  const override = (opts && opts.override) || null;

  const entityLogicalName = entity.schemaName.toLowerCase();
  const pkSchema = (entity.primaryAttribute && entity.primaryAttribute.schemaName)
    ? entity.primaryAttribute.schemaName
    : entity.schemaName + 'id';
  const primaryKey = pkSchema.toLowerCase();

  // Build columns list.
  let columns;
  if (override && Array.isArray(override.columns) && override.columns.length > 0) {
    // Use exactly the override columns in order, mapped from entity.columns.
    const colMap = new Map((entity.columns || []).map((c) => [c.schemaName.toLowerCase(), c]));
    columns = override.columns
      .map((s) => colMap.get(s.toLowerCase()))
      .filter(Boolean)
      .map((c) => ({ logical: c.schemaName.toLowerCase(), display: c.displayName || c.schemaName }));
  } else {
    // Auto-select: exclude PK, AutoNumber, File, Image, Lookup.
    const eligible = (entity.columns || []).filter((c) => {
      if (c.schemaName.toLowerCase() === primaryKey) return false;
      if (EXCLUDED_TYPES.has(c.type)) return false;
      return true;
    });

    // Separate preferred types from Memo.
    const preferred = eligible.filter((c) => PREFERRED_TYPES.has(c.type));
    const memos = eligible.filter((c) => c.type === 'Memo');

    // Combine: preferred first, then at most one Memo, cap at 6.
    const selected = [...preferred, ...memos.slice(0, 1)].slice(0, 6);
    columns = selected.map((c) => ({
      logical: c.schemaName.toLowerCase(),
      display: c.displayName || c.schemaName,
    }));
  }

  // Build instruction.
  let instruction;
  if (override && override.instruction && override.instruction.trim().length > 0) {
    instruction = override.instruction;
  } else {
    const recordType = entity.displayName || entity.schemaName;
    instruction = `Summarize this ${recordType} as a short paragraph highlighting the most important details and any recent activity.`;
  }

  return {
    instruction,
    entityLogicalName,
    primaryKey,
    columns,
    outputFormat: 'text',
  };
}

module.exports = { buildPromptSpec };
