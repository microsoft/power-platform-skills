'use strict';

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'required',
  'properties',
  'const',
  'enum',
  'pattern',
  'minLength',
  'minimum',
  'minProperties',
  'additionalProperties',
  'minItems',
  'items',
  'oneOf',
]);

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = valueType(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'object') return actual === 'object';
  return actual === expected;
}

function printable(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function validateSchemaDefinition(schema, at = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${at} must be a schema object`);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) throw new Error(`${at} uses unsupported JSON Schema keyword: ${keyword}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) {
      if (!['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'].includes(type)) throw new Error(`${at}.type is unsupported: ${type}`);
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((value) => typeof value !== 'string'))) {
    throw new Error(`${at}.required must be a string array`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new Error(`${at}.properties must be an object`);
    for (const [name, child] of Object.entries(schema.properties)) validateSchemaDefinition(child, `${at}.properties.${name}`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    validateSchemaDefinition(schema.additionalProperties, `${at}.additionalProperties`);
  }
  if (schema.items !== undefined) validateSchemaDefinition(schema.items, `${at}.items`);
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) throw new Error(`${at}.oneOf must be a non-empty array`);
    schema.oneOf.forEach((child, index) => validateSchemaDefinition(child, `${at}.oneOf[${index}]`));
  }
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern);
    } catch (error) {
      throw new Error(`${at}.pattern is invalid: ${error.message}`);
    }
  }
  return schema;
}

function validateNode(schema, value, at, errors) {
  if (schema.oneOf) {
    const outcomes = schema.oneOf.map((candidate) => {
      const candidateErrors = [];
      validateNode(candidate, value, at, candidateErrors);
      return candidateErrors;
    });
    const matches = outcomes.filter((candidateErrors) => candidateErrors.length === 0);
    if (matches.length !== 1) errors.push(`${at} must match exactly one oneOf branch (matched ${matches.length})`);
    return;
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) errors.push(`${at} must equal ${printable(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(value, candidate))) errors.push(`${at} must be one of ${schema.enum.map(printable).join(', ')}`);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${at} must be ${types.join(' or ')}, got ${valueType(value)}`);
      return;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} must have at least ${schema.minLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${at} must match ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at} must contain at least ${schema.minItems} items`);
    if (schema.items) value.forEach((entry, index) => validateNode(schema.items, entry, `${at}[${index}]`, errors));
    return;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${at} must contain at least ${schema.minProperties} properties`);
    for (const name of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) errors.push(`${at}.${name} is required`);
    }
    for (const [name, child] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, name)) validateNode(child, value[name], `${at}.${name}`, errors);
    }
    if (schema.additionalProperties !== undefined) {
      for (const name of keys) {
        if (Object.prototype.hasOwnProperty.call(schema.properties || {}, name)) continue;
        if (schema.additionalProperties === false) errors.push(`${at}.${name} is not allowed`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateNode(schema.additionalProperties, value[name], `${at}.${name}`, errors);
      }
    }
  }
}

function validateJsonSchema(schema, value, label = 'value') {
  validateSchemaDefinition(schema);
  const errors = [];
  validateNode(schema, value, label, errors);
  return errors;
}

module.exports = {
  SUPPORTED_KEYWORDS,
  validateJsonSchema,
  validateSchemaDefinition,
};
