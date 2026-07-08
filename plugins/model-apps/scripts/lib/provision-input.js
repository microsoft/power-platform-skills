'use strict';

// Provision-entities input validator — a pure, self-contained subset validator
// that validates the JSON input for the provision-entities CLI. The input is an
// App-Spec subset: { solution, entities, relationships, globalChoices?, sampleData? }.
// Entities carry FULL schema names (e.g. cr_candidate), not bare suffixes.

const { TYPE_MAP } = require('./app-spec.js');

// Validates provision-entities input. Returns { ok, errors }.
function validateProvisionInput(input) {
  const errors = [];

  // Basic structure validation
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['input is not an object'] };
  }

  // Solution validation
  if (!input.solution || typeof input.solution !== 'object') {
    errors.push('solution is required and must be an object');
  } else {
    if (!input.solution.uniqueName || typeof input.solution.uniqueName !== 'string' || !input.solution.uniqueName.trim()) {
      errors.push('solution.uniqueName is required and must be a non-empty string');
    }
    if (!input.solution.publisherPrefix || typeof input.solution.publisherPrefix !== 'string' || !input.solution.publisherPrefix.trim()) {
      errors.push('solution.publisherPrefix is required and must be a non-empty string');
    }
  }

  // Entities validation
  if (!Array.isArray(input.entities)) {
    errors.push('entities must be an array');
    return { ok: false, errors };
  }

  const entityNames = new Set();
  const entityByLower = new Map();

  // Entity schemaName pattern: prefix_suffix (lowercase prefix, underscore, then a letter-led suffix)
  const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9]+_[A-Za-z][A-Za-z0-9]+$/;

  for (const e of input.entities) {
    if (!e || typeof e !== 'object') {
      errors.push('each entity must be an object');
      continue;
    }

    // Validate schemaName
    if (!e.schemaName || typeof e.schemaName !== 'string') {
      errors.push('entity.schemaName is required and must be a string');
      continue;
    }

    if (!SCHEMA_NAME_PATTERN.test(e.schemaName)) {
      errors.push(`entity '${e.schemaName}': schemaName must match pattern prefix_suffix (e.g., cr_candidate)`);
      continue;
    }

    entityNames.add(e.schemaName);
    entityByLower.set(e.schemaName.toLowerCase(), e);

    // Validate primaryAttribute
    if (!e.primaryAttribute || typeof e.primaryAttribute !== 'object') {
      errors.push(`entity '${e.schemaName}': primaryAttribute is required and must be an object`);
    } else if (!e.primaryAttribute.schemaName || typeof e.primaryAttribute.schemaName !== 'string') {
      errors.push(`entity '${e.schemaName}': primaryAttribute.schemaName is required and must be a string`);
    }

    // Validate columns
    if (Array.isArray(e.columns)) {
      for (const c of e.columns) {
        if (!c || typeof c !== 'object') {
          errors.push(`entity '${e.schemaName}': each column must be an object`);
          continue;
        }

        if (!c.schemaName || typeof c.schemaName !== 'string') {
          errors.push(`entity '${e.schemaName}': column.schemaName is required and must be a string`);
        }

        if (c.type && !TYPE_MAP[c.type]) {
          errors.push(`entity '${e.schemaName}': column '${c.schemaName || ''}' has unknown type '${c.type}'`);
        }

        // Validate Choice/MultiChoice columns
        if ((c.type === 'Choice' || c.type === 'MultiChoice') && !(Array.isArray(c.options) && c.options.length) && !c.globalChoice) {
          errors.push(`entity '${e.schemaName}': column '${c.schemaName}' (${c.type}) needs options[] or a globalChoice reference`);
        }
      }
    }
  }

  // Relationships validation
  if (!Array.isArray(input.relationships)) {
    errors.push('relationships must be an array');
  } else {
    for (const r of input.relationships) {
      if (!r || typeof r !== 'object') {
        errors.push('each relationship must be an object');
        continue;
      }

      // Reject unknown relationship types up front — otherwise a typo'd/unsupported type would pass
      // validation silently and fail later in provisioning with a much less actionable error.
      if (r.type !== 'OneToMany' && r.type !== 'ManyToMany') {
        errors.push(`relationship: type must be 'OneToMany' or 'ManyToMany' (got ${r.type === undefined ? 'undefined' : `'${r.type}'`})`);
        continue;
      }

      // Validate OneToMany relationships
      if (r.type === 'OneToMany') {
        if (!r.referenced || typeof r.referenced !== 'string') {
          errors.push('OneToMany relationship: referenced entity is required');
        } else if (!entityByLower.has(r.referenced.toLowerCase())) {
          errors.push(`OneToMany relationship: referenced entity '${r.referenced}' not found in entities[]`);
        }

        if (!r.referencing || typeof r.referencing !== 'string') {
          errors.push('OneToMany relationship: referencing entity is required');
        } else if (!entityByLower.has(r.referencing.toLowerCase())) {
          errors.push(`OneToMany relationship: referencing entity '${r.referencing}' not found in entities[]`);
        }

        if (!r.lookup || typeof r.lookup !== 'object') {
          errors.push('OneToMany relationship: lookup object is required');
        } else if (!r.lookup.schemaName || typeof r.lookup.schemaName !== 'string') {
          errors.push('OneToMany relationship: lookup.schemaName is required');
        }
      }

      // Validate ManyToMany relationships
      if (r.type === 'ManyToMany') {
        if (!r.entity1 || typeof r.entity1 !== 'string') {
          errors.push('ManyToMany relationship: entity1 is required');
        } else if (!entityByLower.has(r.entity1.toLowerCase())) {
          errors.push(`ManyToMany relationship: entity1 '${r.entity1}' not found in entities[]`);
        }

        if (!r.entity2 || typeof r.entity2 !== 'string') {
          errors.push('ManyToMany relationship: entity2 is required');
        } else if (!entityByLower.has(r.entity2.toLowerCase())) {
          errors.push(`ManyToMany relationship: entity2 '${r.entity2}' not found in entities[]`);
        }
      }
    }
  }

  // Global choices validation (optional)
  if (input.globalChoices !== undefined) {
    if (!Array.isArray(input.globalChoices)) {
      errors.push('globalChoices must be an array when provided');
    } else {
      for (const g of input.globalChoices) {
        if (!g || typeof g !== 'object') {
          errors.push('each globalChoice must be an object');
          continue;
        }

        if (!g.name || typeof g.name !== 'string') {
          errors.push('globalChoice.name is required and must be a string');
        }

        if (!Array.isArray(g.options) || g.options.length === 0) {
          errors.push(`globalChoice '${g.name || ''}': options must be a non-empty array`);
        }
      }
    }
  }

  // Sample data validation (optional)
  if (input.sampleData !== undefined) {
    if (typeof input.sampleData !== 'object' || input.sampleData === null || Array.isArray(input.sampleData)) {
      errors.push('sampleData must be an object keyed by entity schemaName when provided');
    } else {
      for (const [entityKey, records] of Object.entries(input.sampleData)) {
        if (!entityByLower.has(entityKey.toLowerCase())) {
          errors.push(`sampleData: entity key '${entityKey}' not found in entities[]`);
        }

        if (!Array.isArray(records)) {
          errors.push(`sampleData['${entityKey}']: value must be an array of records`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateProvisionInput };
