'use strict';

// Dependency-free JSON Schema (draft-07 subset) validator.
//
// The plugin ships as a marketplace-installed folder with no `npm install` step, so a real
// validator (ajv) is not available at runtime. This implements only the keywords the bundled
// contract schemas actually use, and reports every violation as a JSON-Pointer-prefixed string
// so callers can surface all problems in one pass instead of failing on the first one.
//
// Supported: $ref (local only), oneOf, const, enum, type, minLength, maxLength, pattern,
// minimum, maximum, minItems, maxItems, uniqueItems, items, required, properties,
// additionalProperties (false | schema), minProperties, maxProperties, propertyNames.enum.
//
// Deliberately unsupported: if/then/else, allOf, anyOf, remote $ref, format. Conditional
// contract rules live in the rule modules as plain JavaScript, where the failure message can
// explain the product reason rather than a schema path.

// JSON Pointer escaping per RFC 6901 section 3: '~' -> '~0' and '/' -> '~1'.
// See: https://datatracker.ietf.org/doc/html/rfc6901#section-3
function pointerEscape(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  // draft-07 treats an integral number as both "number" and "integer"; report the narrower
  // type so `type: "integer"` schemas match, and widen back when the schema asks for "number".
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function resolveRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) {
    throw new Error(`Only local schema references are supported: ${reference}`);
  }
  return reference
    .slice(2)
    .split('/')
    .reduce((value, segment) => value?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
}

/**
 * Deterministic, key-sorted serialization used for equality checks (enum/const) and, via
 * canonicalJson in product-experience-contracts.js, for contract revision hashing. Two objects
 * that differ only in key insertion order must produce the same string.
 */
function stableValue(value) {
  if (Array.isArray(value)) {
    // Match JSON.stringify: unsupported array values serialize as null rather than creating a
    // hash-only representation that cannot survive a write/read round trip.
    return `[${value.map((item) => stableValue(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = stableValue(value[key]);
      // Match JSON.stringify: undefined/function/symbol object properties are omitted.
      if (serialized !== undefined) entries.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateJsonSchema(value, schema, options = {}) {
  const rootSchema = options.rootSchema || schema;
  const errors = [];

  function visit(current, currentSchema, currentPath) {
    if (!currentSchema || Object.keys(currentSchema).length === 0) return;

    if (currentSchema.$ref) {
      const resolved = resolveRef(rootSchema, currentSchema.$ref);
      if (!resolved) {
        errors.push(`${currentPath}: unresolved schema reference ${currentSchema.$ref}`);
        return;
      }
      visit(current, resolved, currentPath);
      return;
    }

    if (Array.isArray(currentSchema.oneOf)) {
      const matches = currentSchema.oneOf.filter(
        (candidate) => validateJsonSchema(current, candidate, { rootSchema }).length === 0,
      ).length;
      if (matches !== 1) errors.push(`${currentPath}: must match exactly one schema alternative`);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(currentSchema, 'const')
      && stableValue(current) !== stableValue(currentSchema.const)) {
      errors.push(`${currentPath}: must equal ${JSON.stringify(currentSchema.const)}`);
      return;
    }

    if (Array.isArray(currentSchema.enum)
      && !currentSchema.enum.some((candidate) => stableValue(candidate) === stableValue(current))) {
      errors.push(`${currentPath}: must be one of ${currentSchema.enum.map((c) => JSON.stringify(c)).join(', ')}`);
      return;
    }

    if (currentSchema.type) {
      const allowed = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
      const actual = valueType(current);
      const integerCountsAsNumber = actual === 'integer' && allowed.includes('number');
      if (!allowed.includes(actual) && !integerCountsAsNumber) {
        errors.push(`${currentPath}: expected ${allowed.join('|')}, received ${actual}`);
        return;
      }
    }

    if (typeof current === 'string') {
      if (Number.isInteger(currentSchema.minLength) && current.length < currentSchema.minLength) {
        errors.push(`${currentPath}: must contain at least ${currentSchema.minLength} characters`);
      }
      if (Number.isInteger(currentSchema.maxLength) && current.length > currentSchema.maxLength) {
        errors.push(`${currentPath}: must contain at most ${currentSchema.maxLength} characters`);
      }
      // Patterns come only from the bundled schema files in this repo, never from user input,
      // so building a RegExp from them cannot be an injection vector.
      if (currentSchema.pattern && !new RegExp(currentSchema.pattern).test(current)) {
        errors.push(`${currentPath}: does not match ${currentSchema.pattern}`);
      }
    }

    if (typeof current === 'number') {
      if (typeof currentSchema.minimum === 'number' && current < currentSchema.minimum) {
        errors.push(`${currentPath}: must be at least ${currentSchema.minimum}`);
      }
      if (typeof currentSchema.maximum === 'number' && current > currentSchema.maximum) {
        errors.push(`${currentPath}: must be at most ${currentSchema.maximum}`);
      }
    }

    if (Array.isArray(current)) {
      if (Number.isInteger(currentSchema.minItems) && current.length < currentSchema.minItems) {
        errors.push(`${currentPath}: must contain at least ${currentSchema.minItems} items`);
      }
      if (Number.isInteger(currentSchema.maxItems) && current.length > currentSchema.maxItems) {
        errors.push(`${currentPath}: must contain at most ${currentSchema.maxItems} items`);
      }
      if (currentSchema.uniqueItems === true) {
        const serialized = current.map(stableValue);
        if (new Set(serialized).size !== serialized.length) errors.push(`${currentPath}: items must be unique`);
      }
      if (currentSchema.items) {
        current.forEach((item, index) => visit(item, currentSchema.items, `${currentPath}/${index}`));
      }
    }

    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const keys = Object.keys(current);
      if (Number.isInteger(currentSchema.minProperties) && keys.length < currentSchema.minProperties) {
        errors.push(`${currentPath}: must contain at least ${currentSchema.minProperties} properties`);
      }
      if (Number.isInteger(currentSchema.maxProperties) && keys.length > currentSchema.maxProperties) {
        errors.push(`${currentPath}: must contain at most ${currentSchema.maxProperties} properties`);
      }
      for (const required of currentSchema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(current, required)) {
          errors.push(`${currentPath}/${pointerEscape(required)}: is required`);
        }
      }
      const allowedNames = currentSchema.propertyNames?.enum;
      const properties = currentSchema.properties || {};
      for (const [key, child] of Object.entries(current)) {
        const childPath = `${currentPath}/${pointerEscape(key)}`;
        if (Array.isArray(allowedNames) && !allowedNames.includes(key)) {
          errors.push(`${childPath}: property name must be one of ${allowedNames.join(', ')}`);
        }
        if (properties[key]) visit(child, properties[key], childPath);
        else if (currentSchema.additionalProperties === false) errors.push(`${childPath}: unknown property`);
        else if (currentSchema.additionalProperties && typeof currentSchema.additionalProperties === 'object') {
          visit(child, currentSchema.additionalProperties, childPath);
        }
      }
    }
  }

  visit(value, schema, options.path || '');
  return errors;
}

module.exports = { pointerEscape, resolveRef, stableValue, validateJsonSchema };
