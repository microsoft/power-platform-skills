'use strict';

const NUMERIC_TYPES = new Set(['number', 'integer', 'bigint', 'decimal', 'double', 'money', 'int']);

function fieldName(field) {
  return String(field?.logicalName || field?.name || '');
}

function semanticName(field) {
  return fieldName(field).toLocaleLowerCase('en-US').replace(/^[a-z][a-z0-9]*_/, '').replace(/[^a-z0-9]+/g, '');
}

function isNumeric(field) {
  return NUMERIC_TYPES.has(String(field?.type || field?.attributeType || '').toLocaleLowerCase('en-US'));
}

function arithmeticContract(table) {
  const fields = (table?.columns || table?.fields || []).filter(isNumeric);
  const quantities = fields.filter((field) => /(?:^|line)(?:qty|quantity)$|(?:qty|quantity)(?:ordered|selected|requested)?$/.test(semanticName(field)));
  const unitPrices = fields.filter((field) => /unitprice|priceperunit/.test(semanticName(field)));
  const totals = fields.filter((field) => /total|amount|subtotal/.test(semanticName(field)));
  if (quantities.length === 0 || unitPrices.length === 0 || totals.length === 0) return null;
  return {
    quantity: fieldName(quantities[0]),
    unitPrice: fieldName(unitPrices[0]),
    totals: totals.map(fieldName).filter((name) => name !== fieldName(unitPrices[0])),
  };
}

function expectedTotal(quantity, unitPrice) {
  return Number((Number(quantity) * Number(unitPrice)).toFixed(2));
}

function applyArithmeticContract(rows, contract) {
  if (!contract) return rows;
  for (const row of rows) {
    if (!Number.isFinite(row?.[contract.quantity]) || !Number.isFinite(row?.[contract.unitPrice])) continue;
    const expected = expectedTotal(row[contract.quantity], row[contract.unitPrice]);
    for (const total of contract.totals) row[total] = expected;
  }
  return rows;
}

module.exports = { NUMERIC_TYPES, applyArithmeticContract, arithmeticContract, expectedTotal, fieldName, isNumeric, semanticName };