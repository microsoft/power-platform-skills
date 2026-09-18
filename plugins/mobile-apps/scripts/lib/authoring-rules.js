'use strict';

const { id, object, text, enumeration } = require('./authoring-protocol');

const OPERATORS = ['equals', 'not-equals', 'in'];
const SAVE_OPERATIONS = ['create', 'update'];

function scalar(value, label) {
  if (value === null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= 1000)) return value;
  throw new Error(`${label} must be a bounded scalar`);
}

function uniqueEntries(entries, label) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array`);
  const result = new Map();
  for (const entry of entries) {
    object(entry, label);
    const entryId = id(entry.id, `${label}.id`);
    if (result.has(entryId)) throw new Error(`Duplicate ${label} ID: ${entryId}`);
    result.set(entryId, entry);
  }
  return result;
}

function validateRules(domain, contract) {
  object(domain, 'domain');
  object(contract, 'rules');
  if (contract.schemaVersion !== 1 || !Array.isArray(contract.rules) || contract.rules.length > 100) {
    throw new Error('Rules require schemaVersion 1 and at most 100 bounded rules');
  }
  const entities = uniqueEntries(domain.entities, 'entity');
  const actions = uniqueEntries(domain.actions || [], 'action');
  const ruleIds = new Set();
  const rules = contract.rules.map((rule) => {
    object(rule, 'rule');
    for (const key of Object.keys(rule)) {
      if (!['id', 'entityId', 'actionId', 'when', 'require'].includes(key)) {
        throw new Error(`Unsupported rule operation: ${key}`);
      }
    }
    const ruleId = id(rule.id, 'rule.id');
    if (ruleIds.has(ruleId)) throw new Error(`Duplicate rule ID: ${ruleId}`);
    ruleIds.add(ruleId);
    const entityId = id(rule.entityId, 'rule.entityId');
    const entity = entities.get(entityId);
    const action = actions.get(id(rule.actionId, 'rule.actionId'));
    if (!entity || !action || action.entityId !== entityId) {
      throw new Error(`Rule ${ruleId} must reference an existing entity and its registered action`);
    }
    if (!['save', ...SAVE_OPERATIONS].includes(action.operation)) {
      throw new Error(`Rule ${ruleId} must be attached to a create/update/save action`);
    }
    const fields = uniqueEntries(entity.fields, 'field');
    const when = object(rule.when, 'rule.when');
    const required = object(rule.require, 'rule.require');
    const conditionField = fields.get(id(when.fieldId, 'when.fieldId'));
    const requiredField = fields.get(id(required.fieldId, 'require.fieldId'));
    if (!conditionField || !requiredField) throw new Error(`Rule ${ruleId} references an unknown field`);
    if (!['text', 'number', 'boolean', 'datetime', 'choice', 'lookup'].includes(conditionField.type)) {
      throw new Error(`Rule ${ruleId} requires a scalar condition field`);
    }
    const operator = enumeration(when.operator, OPERATORS, 'when.operator');
    const values = operator === 'in' ? when.value : [when.value];
    if (!Array.isArray(values) || !values.length || values.length > 30) {
      throw new Error('An in-condition requires 1-30 values');
    }
    values.forEach((value) => {
      scalar(value, 'when.value');
      if (value !== null && conditionField.type === 'number' && typeof value !== 'number') {
        throw new Error('A number condition requires numeric values');
      }
      if (value !== null && conditionField.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error('A boolean condition requires boolean values');
      }
      if (value !== null && ['text', 'datetime', 'lookup', 'choice'].includes(conditionField.type)
        && typeof value !== 'string') {
        throw new Error('A text/choice/lookup condition requires string values');
      }
      if (value !== null && conditionField.type === 'choice'
        && !(conditionField.options || []).some((option) => option.id === value)) {
        throw new Error(`Unknown choice ID in rule ${ruleId}`);
      }
    });
    return {
      id: ruleId,
      entityId,
      actionId: action.id,
      when: { fieldId: conditionField.id, operator, value: operator === 'in' ? [...values] : values[0] },
      require: { fieldId: requiredField.id, message: text(required.message, 'require.message', 500) },
    };
  });
  return { schemaVersion: 1, rules };
}

function compileRules(domain, contract) {
  const validated = validateRules(domain, contract);
  return validated.rules.map((rule) => {
    const entity = domain.entities.find((entry) => entry.id === rule.entityId);
    const action = domain.actions.find((entry) => entry.id === rule.actionId);
    return {
      ...rule,
      operations: action.operation === 'save' ? SAVE_OPERATIONS : [action.operation],
      fieldType: entity.fields.find((entry) => entry.id === rule.require.fieldId).type,
    };
  });
}

function hasRequiredValue(value, fieldType) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => hasRequiredValue(entry, fieldType));
  }
  if (fieldType === 'photo') {
    // Capture cancellation/pending uploads must not satisfy a photo rule. Adapters
    // retain an existing ready reference until a replacement is actually stored.
    return !!value && typeof value === 'object' && value.status === 'ready'
      && typeof value.uri === 'string' && /^(file:\/\/|https:\/\/|content:\/\/)\S+$/.test(value.uri);
  }
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return false;
}

function evaluateRules(rules, entityId, record, operation) {
  const issues = [];
  for (const rule of rules) {
    if (rule.entityId !== entityId || !rule.operations.includes(operation)) continue;
    const actual = record[rule.when.fieldId];
    if (actual === undefined) continue;
    const matches = rule.when.operator === 'in'
      ? rule.when.value.includes(actual)
      : rule.when.operator === 'equals' ? actual === rule.when.value : actual !== rule.when.value;
    if (matches && !hasRequiredValue(record[rule.require.fieldId], rule.fieldType)) {
      issues.push({ ruleId: rule.id, actionId: rule.actionId, fieldId: rule.require.fieldId, message: rule.require.message });
    }
  }
  return issues;
}

function validateEntityRules(domain, contract, entityId, record, operation) {
  object(record, 'record');
  enumeration(operation, SAVE_OPERATIONS, 'save operation');
  return evaluateRules(compileRules(domain, contract), entityId, record, operation);
}

function generateRulesRuntime(domain, contract) {
  const compiled = compileRules(domain, contract);
  return `export interface RuleIssue {
  ruleId: string;
  actionId: string;
  fieldId: string;
  message: string;
}

type Scalar = string | number | boolean | null;
type SaveOperation = 'create' | 'update';
interface CompiledRule {
  id: string;
  entityId: string;
  actionId: string;
  operations: SaveOperation[];
  fieldType: string;
  when: { fieldId: string; operator: 'equals' | 'not-equals' | 'in'; value: Scalar | Scalar[] };
  require: { fieldId: string; message: string };
}

const rules: CompiledRule[] = ${JSON.stringify(compiled, null, 2)};

function hasRequiredValue(value: unknown, fieldType: string): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every((entry) => hasRequiredValue(entry, fieldType));
  if (fieldType === 'photo') {
    return !!value && typeof value === 'object' && 'status' in value && value.status === 'ready'
      && 'uri' in value && typeof value.uri === 'string' && /^(file:\\/\\/|https:\\/\\/|content:\\/\\/)\\S+$/.test(value.uri);
  }
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return false;
}

export function validateEntityRules(entityId: string, record: Readonly<Record<string, unknown>>, operation: SaveOperation): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const rule of rules) {
    if (rule.entityId !== entityId || !rule.operations.includes(operation)) continue;
    const actual = record[rule.when.fieldId];
    if (actual === undefined) continue;
    const expected = rule.when.value;
    const matches = rule.when.operator === 'in'
      ? Array.isArray(expected) && expected.some((entry) => entry === actual)
      : rule.when.operator === 'equals' ? actual === expected : actual !== expected;
    if (matches && !hasRequiredValue(record[rule.require.fieldId], rule.fieldType)) {
      issues.push({ ruleId: rule.id, actionId: rule.actionId, fieldId: rule.require.fieldId, message: rule.require.message });
    }
  }
  return issues;
}

export class RuleValidationError extends Error {
  constructor(public readonly issues: RuleIssue[]) {
    super(issues.map((issue) => issue.message).join('\\n'));
    this.name = 'RuleValidationError';
  }
}

export function assertEntityRules(entityId: string, record: Readonly<Record<string, unknown>>, operation: SaveOperation): void {
  const issues = validateEntityRules(entityId, record, operation);
  if (issues.length) throw new RuleValidationError(issues);
}
`;
}

module.exports = { validateRules, compileRules, validateEntityRules, generateRulesRuntime, hasRequiredValue };
