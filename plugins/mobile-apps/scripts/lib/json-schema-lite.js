'use strict';

function pointerEscape(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function resolveRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Only local schema references are supported: ${reference}`);
  return reference.slice(2).split('/').reduce((value, segment) => value?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
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
      const branchErrors = currentSchema.oneOf.map((candidate) => validateJsonSchema(current, candidate, { rootSchema }));
      const matches = branchErrors.filter((candidate) => candidate.length === 0).length;
      if (matches !== 1) errors.push(`${currentPath}: must match exactly one schema alternative`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(currentSchema, 'const') && stableValue(current) !== stableValue(currentSchema.const)) {
      errors.push(`${currentPath}: must equal ${JSON.stringify(currentSchema.const)}`);
      return;
    }
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.some((candidate) => stableValue(candidate) === stableValue(current))) {
      errors.push(`${currentPath}: must be one of ${currentSchema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}`);
      return;
    }
    if (currentSchema.type) {
      const allowed = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
      const actual = valueType(current);
      const numberMatches = actual === 'integer' && allowed.includes('number');
      if (!allowed.includes(actual) && !numberMatches) {
        errors.push(`${currentPath}: expected ${allowed.join('|')}, received ${actual}`);
        return;
      }
    }
    if (typeof current === 'string') {
      if (Number.isInteger(currentSchema.minLength) && current.length < currentSchema.minLength) errors.push(`${currentPath}: must contain at least ${currentSchema.minLength} characters`);
      if (currentSchema.pattern && !(new RegExp(currentSchema.pattern).test(current))) errors.push(`${currentPath}: does not match ${currentSchema.pattern}`);
    }
    if (typeof current === 'number') {
      if (typeof currentSchema.minimum === 'number' && current < currentSchema.minimum) errors.push(`${currentPath}: must be at least ${currentSchema.minimum}`);
      if (typeof currentSchema.maximum === 'number' && current > currentSchema.maximum) errors.push(`${currentPath}: must be at most ${currentSchema.maximum}`);
    }
    if (Array.isArray(current)) {
      if (Number.isInteger(currentSchema.minItems) && current.length < currentSchema.minItems) errors.push(`${currentPath}: must contain at least ${currentSchema.minItems} items`);
      if (Number.isInteger(currentSchema.maxItems) && current.length > currentSchema.maxItems) errors.push(`${currentPath}: must contain at most ${currentSchema.maxItems} items`);
      if (currentSchema.uniqueItems === true) {
        const values = current.map(stableValue);
        if (new Set(values).size !== values.length) errors.push(`${currentPath}: items must be unique`);
      }
      if (currentSchema.items) current.forEach((item, index) => visit(item, currentSchema.items, `${currentPath}/${index}`));
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const keys = Object.keys(current);
      if (Number.isInteger(currentSchema.minProperties) && keys.length < currentSchema.minProperties) errors.push(`${currentPath}: must contain at least ${currentSchema.minProperties} properties`);
      for (const required of currentSchema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(current, required)) errors.push(`${currentPath}/${pointerEscape(required)}: is required`);
      }
      const properties = currentSchema.properties || {};
      for (const [key, child] of Object.entries(current)) {
        const childPath = `${currentPath}/${pointerEscape(key)}`;
        if (properties[key]) visit(child, properties[key], childPath);
        else if (currentSchema.additionalProperties === false) errors.push(`${childPath}: unknown property`);
        else if (currentSchema.additionalProperties && typeof currentSchema.additionalProperties === 'object') visit(child, currentSchema.additionalProperties, childPath);
      }
    }
  }

  visit(value, schema, options.path || '');
  return errors;
}

module.exports = { resolveRef, stableValue, validateJsonSchema };
