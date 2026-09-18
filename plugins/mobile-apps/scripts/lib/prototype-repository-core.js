'use strict';

// This module is copied verbatim into app-owned src/data/repositories. Keep it
// platform-neutral: both local and official-service adapters use this boundary.
class RepositoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.details = details;
  }
}

function recordObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RepositoryError('validation', 'Expected a record object');
}

function validateRecord(entity, record, { partial = false } = {}) {
  recordObject(record);
  const fields = new Map(entity.fields.map((field) => [field.id, field]));
  if (record.id !== undefined && (typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(record.id))) {
    throw new RepositoryError('validation', 'Record ID must be a bounded stable ID');
  }
  for (const key of Object.keys(record)) if (key !== 'id' && !fields.has(key)) {
    throw new RepositoryError('validation', `Unknown field ${entity.id}.${key}`);
  }
  for (const field of fields.values()) {
    const value = record[field.id];
    if (value === undefined && partial) continue;
    if (value === undefined || value === null || (field.type === 'text' && typeof value === 'string' && !value.trim())) {
      if (field.required) throw new RepositoryError('validation', `${field.label} is required`, { fieldId: field.id });
      continue;
    }
    let valid;
    switch (field.type) {
      case 'text': valid = typeof value === 'string' && value.length <= 100000; break;
      case 'number': valid = typeof value === 'number' && Number.isFinite(value); break;
      case 'boolean': valid = typeof value === 'boolean'; break;
      case 'datetime': valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); break;
      case 'choice': valid = field.options.some((option) => option.id === value); break;
      case 'lookup': valid = typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value); break;
      case 'photo': valid = !!value && typeof value === 'object' && value.status === 'ready'
        && typeof value.id === 'string' && typeof value.uri === 'string'
        && /^(file:\/\/|content:\/\/|https:\/\/)\S+$/.test(value.uri); break;
      default: valid = false;
    }
    if (!valid) throw new RepositoryError(field.type === 'photo' ? 'media-not-ready' : 'validation',
      `Invalid ${field.type} value for ${field.label}`, { fieldId: field.id });
  }
  return record;
}

function prepareWrite(entity, current, input, operation, assertRules) {
  recordObject(input);
  if (operation === 'update' && !current) throw new RepositoryError('not-found', 'Record no longer exists');
  if (current && input.id !== undefined && input.id !== current.id) throw new RepositoryError('validation', 'A record ID cannot change');
  // Undefined patch fields do not erase evidence or previously stored values.
  const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = { ...(current || {}), ...patch };
  for (const field of entity.fields) if (!field.required && result[field.id] === undefined) result[field.id] = null;
  validateRecord(entity, result);
  assertRules(entity.id, result, operation);
  return result;
}

function validateQuery(entity, query = {}) {
  recordObject(query);
  const allowed = ['where', 'orderBy', 'pageSize', 'cursor'];
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw new RepositoryError('query', 'Unsupported query option');
  const fields = new Map(entity.fields.map((field) => [field.id, field]));
  fields.set('id', { id: 'id', type: 'text' });
  const where = query.where || [];
  const orderBy = query.orderBy || [];
  const pageSize = query.pageSize ?? 50;
  if (!Array.isArray(where) || where.length > 20 || !Array.isArray(orderBy) || orderBy.length > 5
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RepositoryError('query', 'Query exceeds its bounds');
  for (const condition of where) {
    recordObject(condition);
    const field = fields.get(condition.fieldId);
    if (!field || field.type === 'photo' || !['equals', 'not-equals', 'in', 'contains', 'gte', 'lte'].includes(condition.operator)) {
      throw new RepositoryError('query', 'Unsupported query field or operator');
    }
    if (condition.operator === 'contains' && (field.type !== 'text' || typeof condition.value !== 'string')) throw new RepositoryError('query', 'contains requires text');
    if (['gte', 'lte'].includes(condition.operator) && !['number', 'datetime'].includes(field.type)) {
      throw new RepositoryError('query', 'Range queries require a number or datetime');
    }
    const values = condition.operator === 'in' ? condition.value : [condition.value];
    if (!Array.isArray(values) || !values.length || values.length > 50) throw new RepositoryError('query', 'Invalid filter values');
    for (const value of values) {
      if (value === undefined) throw new RepositoryError('query', 'Filter values must be explicit');
      if (field.id === 'id') {
        if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw new RepositoryError('query', 'Invalid ID filter');
      } else validateRecord({ id: entity.id, fields: [{ ...field, required: false }] }, { [field.id]: value });
    }
  }
  for (const order of orderBy) {
    if (!fields.has(order.fieldId) || ['photo', 'choice', 'lookup'].includes(fields.get(order.fieldId).type)
      || !['asc', 'desc'].includes(order.direction)) throw new RepositoryError('query', 'Invalid ordering');
  }
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 8192)) {
    throw new RepositoryError('query', 'Invalid cursor');
  }
  return { where, orderBy, pageSize, valueTypes: Object.fromEntries([...fields].map(([id, field]) => [id, field.type])), ...(query.cursor ? { cursor: query.cursor } : {}) };
}

function queryRows(rows, query) {
  const comparable = (fieldId, value) => query.valueTypes?.[fieldId] === 'datetime' && value !== null
    ? Date.parse(value) : value;
  const filtered = rows.filter((record) => query.where.every(({ fieldId, operator, value }) => {
    const actual = comparable(fieldId, record[fieldId] ?? null);
    if (operator === 'equals') return actual === comparable(fieldId, value);
    if (operator === 'not-equals') return actual !== comparable(fieldId, value);
    if (operator === 'in') return value.map((entry) => comparable(fieldId, entry)).includes(actual);
    if (operator === 'contains') return typeof actual === 'string' && actual.toLocaleLowerCase().includes(String(value).toLocaleLowerCase());
    if (operator === 'gte') return actual !== null && actual >= comparable(fieldId, value);
    return actual !== null && actual <= comparable(fieldId, value);
  }));
  const orders = [...query.orderBy];
  if (!orders.some((order) => order.fieldId === 'id')) orders.push({ fieldId: 'id', direction: 'asc' });
  filtered.sort((left, right) => {
    for (const { fieldId, direction } of orders) {
      const a = comparable(fieldId, left[fieldId] ?? null);
      const b = comparable(fieldId, right[fieldId] ?? null);
      const result = a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
      if (result) return direction === 'asc' ? result : -result;
    }
    return 0;
  });
  if (query.cursor && !/^(0|[1-9]\d{0,8})$/.test(query.cursor)) throw new RepositoryError('query', 'Invalid local cursor');
  const offset = Number(query.cursor || 0);
  const items = filtered.slice(offset, offset + query.pageSize);
  return { items, total: filtered.length, ...(offset + items.length < filtered.length ? { nextCursor: String(offset + items.length) } : {}) };
}

module.exports = { RepositoryError, validateRecord, prepareWrite, validateQuery, queryRows };
