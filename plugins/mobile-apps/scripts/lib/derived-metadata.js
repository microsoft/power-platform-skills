'use strict';

function normalizedSourceType(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function normalizeOptions(options) {
  return (options || [])
    .map((option) => ({
      value: Number(option.value ?? option.Value),
      label: String(option.label ?? option.Label ?? '').trim(),
    }))
    .sort((left, right) => left.value - right.value);
}

function validateOptions(options, label, requireBooleanPair = false) {
  if (!Array.isArray(options) || options.length === 0) {
    return [`${label} choice options must be a non-empty array`];
  }
  const normalized = normalizeOptions(options);
  const reasons = [];
  const values = new Set();
  for (const option of normalized) {
    if (!Number.isInteger(option.value)) {
      reasons.push(`${label} choice value must be a finite integer`);
    } else if (values.has(option.value)) {
      reasons.push(`${label} choice value ${option.value} is duplicated`);
    }
    values.add(option.value);
    if (!option.label) reasons.push(`${label} choice value ${option.value} has no label`);
  }
  if (requireBooleanPair && (normalized.length !== 2 || !values.has(0) || !values.has(1))) {
    reasons.push(`${label} Boolean options must define exactly values 0 and 1`);
  }
  return reasons;
}

function compareOptions(expectedOptions, actualOptions, requireBooleanPair = false) {
  const reasons = [];
  reasons.push(...validateOptions(expectedOptions, 'expected', requireBooleanPair));
  reasons.push(...validateOptions(actualOptions, 'live', requireBooleanPair));
  if (reasons.length > 0) return reasons;

  const normalizedExpected = normalizeOptions(expectedOptions);
  const actualByValue = new Map(normalizeOptions(actualOptions).map((option) => [option.value, option]));
  for (const expected of normalizedExpected) {
    const actual = actualByValue.get(expected.value);
    if (!actual) {
      reasons.push(`missing choice value ${expected.value}`);
    } else if (expected.label && actual.label !== expected.label) {
      reasons.push(
        `choice value ${expected.value} label mismatch: expected "${expected.label}", got "${actual.label}"`,
      );
    }
  }
  return reasons;
}

function compareDerivedColumn(expected, actual) {
  const reasons = [];
  for (const field of ['table', 'logicalName', 'kind', 'type', 'sourceType']) {
    if (!Object.prototype.hasOwnProperty.call(expected, field) || expected[field] === '') {
      reasons.push(`expected metadata ${field} is missing`);
    }
  }
  if (expected.kind === 'lookup' && !expected.lookupTarget) {
    reasons.push('expected lookupTarget is missing');
  }
  if (
    (expected.kind === 'choice' || expected.kind === 'boolean')
    && (!Array.isArray(expected.options) || expected.options.length === 0)
  ) {
    reasons.push('expected choice options must be a non-empty array');
  }
  if (expected.kind === 'computed' && !Object.prototype.hasOwnProperty.call(expected, 'sourceTypeMask')) {
    reasons.push('expected computed metadata sourceTypeMask is missing');
  }
  if (reasons.length > 0) return { compatible: false, reasons };
  if (!actual) return { compatible: false, reasons: ['column metadata missing'] };

  if (typeof actual.type !== 'string' || !actual.type) {
    reasons.push('live metadata type is missing or malformed');
  }
  if (!Object.prototype.hasOwnProperty.call(actual, 'sourceType')) {
    reasons.push('live metadata sourceType is missing');
  } else if (
    actual.sourceType !== null
    && actual.sourceType !== undefined
    && !Number.isFinite(Number(actual.sourceType))
  ) {
    reasons.push('live metadata sourceType is malformed');
  }
  if (expected.type && actual.type !== expected.type) {
    reasons.push(`type mismatch: expected ${expected.type}, got ${actual.type || '<missing>'}`);
  }

  const expectedSourceType = normalizedSourceType(expected.sourceType);
  const actualSourceType = normalizedSourceType(actual.sourceType);
  if (actualSourceType !== expectedSourceType) {
    reasons.push(`source type mismatch: expected ${expectedSourceType}, got ${actualSourceType}`);
  }

  if (expected.kind === 'lookup') {
    const targets = actual.lookupTargets;
    if (!Array.isArray(targets)) {
      reasons.push('live lookupTargets must be an array');
      return { compatible: false, reasons };
    }
    if (targets.length !== 1 || targets[0] !== expected.lookupTarget) {
      reasons.push(
        `lookup target mismatch: expected ${expected.lookupTarget || '<missing>'}, `
        + `got ${targets.join(', ') || '<none>'}`,
      );
    }
  }

  if (expected.kind === 'choice' || expected.kind === 'boolean') {
    if (!Array.isArray(actual.options)) {
      reasons.push('live choice options must be an array');
    } else {
      reasons.push(...compareOptions(expected.options, actual.options, expected.kind === 'boolean'));
    }
  }

  if (expected.kind === 'computed') {
    if (!Object.prototype.hasOwnProperty.call(actual, 'sourceTypeMask')) {
      reasons.push('live computed metadata sourceTypeMask is missing');
    } else if (!Number.isInteger(Number(actual.sourceTypeMask))) {
      reasons.push('live computed metadata sourceTypeMask is malformed');
    } else {
      const expectedMask = Number(expected.sourceTypeMask);
      const actualMask = Number(actual.sourceTypeMask);
      if (!Number.isInteger(expectedMask)) {
        reasons.push('expected computed metadata sourceTypeMask is malformed');
      } else if ((actualMask & 32) !== 0) {
        reasons.push('live computed metadata SourceTypeMask contains the Invalid bit');
      } else if (actualMask !== expectedMask) {
        reasons.push(`source type mask mismatch: expected ${expectedMask}, got ${actualMask}`);
      }
    }
    if (!expected.formulaDefinition) {
      reasons.push('expected computed metadata must include an exact FormulaDefinition');
    } else if (!actual.formulaDefinition) {
      reasons.push('live computed metadata did not return FormulaDefinition');
    } else if (actual.formulaDefinition.trim() !== expected.formulaDefinition.trim()) {
      reasons.push('FormulaDefinition mismatch');
    }
  }

  return { compatible: reasons.length === 0, reasons };
}

function compareDerivedMetadata(expectedColumns, actualColumns) {
  const actualByKey = new Map();
  const duplicateKeys = new Set();
  for (const column of actualColumns || []) {
    const key = `${column.table}:${column.logicalName}`;
    if (actualByKey.has(key)) duplicateKeys.add(key);
    actualByKey.set(key, column);
  }
  return (expectedColumns || []).map((expected) => {
    const key = `${expected.table}:${expected.logicalName}`;
    if (duplicateKeys.has(key)) {
      return {
        table: expected.table,
        logicalName: expected.logicalName,
        compatible: false,
        reasons: ['duplicate live metadata rows'],
      };
    }
    return {
      table: expected.table,
      logicalName: expected.logicalName,
      ...compareDerivedColumn(expected, actualByKey.get(key)),
    };
  });
}

module.exports = {
  compareDerivedColumn,
  compareDerivedMetadata,
  compareOptions,
  normalizeOptions,
  normalizedSourceType,
  validateOptions,
};
