'use strict';

// Provision-entities input validator — a pure, self-contained subset validator
// that validates the JSON input for the provision-entities CLI. The input is an
// App-Spec subset: { solution, entities, relationships, globalChoices?, sampleData? }.
// Entities carry FULL schema names (e.g. cr_candidate), not bare suffixes.

const { TYPE_MAP, normalizeLanguageCode, validateLabel, validateChoiceOptionLabels, isLocalizedLabelMap, rejectLocalizedGlobalChoice } = require('./app-spec.js');

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

  // An LCID supplied here must be validated at the SAME strictness as the `--language-code` flag and
  // the App Spec `languageCode` field. Without this the input-file path fails OPEN: resolveLanguageCode
  // maps anything non-conforming to null and silently falls through to the org default, so a typo like
  // "1O33" (capital O) produces `ok: true` with every label in the wrong language and nothing on stderr.
  // The other two entry points hard-error on the identical string; this gate keeps all three consistent
  // and runs before any SDK write.
  if (input.languageCode !== undefined && normalizeLanguageCode(input.languageCode) === null) {
    errors.push('languageCode must be a positive integer LCID');
  }

  // Entities validation
  if (!Array.isArray(input.entities)) {
    errors.push('entities must be an array');
    return { ok: false, errors };
  }

  const entityByLower = new Map();
  // Entity schema prefixes must match the solution's publisher prefix (Dataverse provisions custom
  // tables under that prefix — a mismatch like publisherPrefix "new" + entity "cr_x" provisions into
  // the wrong publisher context and confuses later phases).
  const publisherPrefix = input.solution && typeof input.solution.publisherPrefix === 'string' ? input.solution.publisherPrefix.trim().toLowerCase() : '';

  // Entity schemaName pattern: prefix_suffix — lowercase publisher prefix, underscore, then a
  // letter-led name that may itself contain underscores (junction/config tables like new_ticket_tag).
  const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9]+_[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;

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
      errors.push(`entity '${e.schemaName}': schemaName must match pattern prefix_suffix (e.g., cr_candidate or new_ticket_tag)`);
      continue;
    }

    if (publisherPrefix && !e.schemaName.toLowerCase().startsWith(`${publisherPrefix}_`)) {
      errors.push(`entity '${e.schemaName}': schemaName must start with the solution publisher prefix '${publisherPrefix}_'`);
    }

    entityByLower.set(e.schemaName.toLowerCase(), e);

    // Localized labels are validated HERE too, with the SHARED validator, not only in
    // `validateAppSpec`. This input is a documented App Spec subset and `provision-entities.js` is a
    // SEPARATE entry point whose only gate is this function — so without these lines a per-LCID label
    // with a language tag key, or a localized displayName with no pluralName, returned ok:true and
    // reached `createTable`, where the tag key throws mid-build and the missing plural is derived by
    // appending "s" to one language. The solution is provisioned BEFORE the data model, so the
    // failure would land after a write. Same reasoning as sharing ENTITY_KEYS: two entry points that
    // disagree about what a label IS teach the author two different rules for one field.
    validateLabel(e.displayName, `entity '${e.schemaName}': displayName`, errors, { baseLanguageCode: input.languageCode });
    validateLabel(e.pluralName, `entity '${e.schemaName}': pluralName`, errors, { baseLanguageCode: input.languageCode });
    if (isLocalizedLabelMap(e.displayName) && e.pluralName === undefined) {
      errors.push(`entity '${e.schemaName}': pluralName is required when displayName is a localized label — the plural cannot be derived by appending "s" in every language`);
    }
    if (e.primaryAttribute && typeof e.primaryAttribute === 'object') {
      validateLabel(e.primaryAttribute.displayName, `entity '${e.schemaName}': primaryAttribute.displayName`, errors, { baseLanguageCode: input.languageCode });
    }

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
        validateLabel(c.displayName, `entity '${e.schemaName}': column '${c.schemaName || ''}' displayName`, errors, { baseLanguageCode: input.languageCode });
        validateChoiceOptionLabels(c.options, `entity '${e.schemaName}': column '${c.schemaName || ''}'`, errors, { baseLanguageCode: input.languageCode });
      }
    }

    // `alternateKeys[].displayName` is a label too, and it reaches `createAlternateKey` from THIS
    // entry point. Omitting it here left `{"es-ES": "Clave"}` returning ok:true and throwing
    // "localized label key 'es-ES' is not an LCID" mid-provision — after the solution and tables are
    // already written. `validateAppSpec` has always covered it; the two gates must not disagree.
    if (Array.isArray(e.alternateKeys)) {
      e.alternateKeys.forEach((k, i) => {
        if (!k || typeof k !== 'object') return;
        validateLabel(k.displayName, `entity '${e.schemaName}': alternateKeys[${i}] displayName`, errors, { baseLanguageCode: input.languageCode });
      });
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
        // The lookup COLUMN's label, same reasoning as the alternate-key label above: it is passed
        // straight to `createRelationship` from this entry point, and a language-tag key throws
        // there rather than here.
        if (r.lookup && typeof r.lookup === 'object') {
          validateLabel(r.lookup.displayName, `OneToMany relationship (${r.lookup.schemaName || '?'}): lookup.displayName`, errors, { baseLanguageCode: input.languageCode });
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
        validateLabel(g.displayName, `globalChoice '${g.name || ''}': displayName`, errors, { baseLanguageCode: input.languageCode });
        validateChoiceOptionLabels(g.options, `globalChoice '${g.name || ''}'`, errors, { baseLanguageCode: input.languageCode });
        // Same rejection as validateAppSpec, from the same shared helper: Dataverse stores only the
        // base language for a global option set and reports nothing. Two entry points that disagree
        // about what a label IS is the whole reason these gates share their validators.
        rejectLocalizedGlobalChoice(g, `globalChoice '${g.name || ''}'`, errors);
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
