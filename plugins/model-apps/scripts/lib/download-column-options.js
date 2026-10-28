'use strict';

const { mapLimit } = require('./entity-provision.js');
const { odataLit } = require('./odata.js');
const { INTEGER_FORMATS } = require('./app-spec.js');

// These are the vendored SDK's create defaults, not Maker's defaults. A download leaves them
// implicit so an ordinary column does not acquire options its author never needed to write.
// The real-bundle round-trip tests compare the resulting definitions, including these defaults.
const DEFAULTS = {
  Text: { maxLength: 100, format: 'Text' },
  Memo: { maxLength: 2000 },
  Integer: { minValue: -2147483648, maxValue: 2147483647, integerFormat: 'None' },
  Decimal: { minValue: -1e11, maxValue: 1e11, precision: 2 },
  Double: { minValue: -1e11, maxValue: 1e11, precision: 2 },
  Money: { minValue: 0, maxValue: 1e9, precision: 2 },
  DateTime: { dateFormat: 'DateAndTime' },
  Boolean: { trueLabel: 'Yes', falseLabel: 'No' },
};

const TYPE_BY_NAME = {
  StringType: 'Text', MemoType: 'Memo', IntegerType: 'Integer', DecimalType: 'Decimal',
  DoubleType: 'Double', MoneyType: 'Money', DateTimeType: 'DateTime', BooleanType: 'Boolean',
};
const TYPE_BY_ATTRIBUTE = {
  String: 'Text', Memo: 'Memo', Integer: 'Integer', Decimal: 'Decimal', Double: 'Double',
  Money: 'Money', DateTime: 'DateTime', Boolean: 'Boolean',
};
const CASTS = [
  { type: 'Text', cast: 'String', select: 'LogicalName,MaxLength,FormatName,AutoNumberFormat' },
  { type: 'Memo', cast: 'Memo', select: 'LogicalName,MaxLength' },
  { type: 'Integer', cast: 'Integer', select: 'LogicalName,MinValue,MaxValue,Format' },
  { type: 'Decimal', cast: 'Decimal', select: 'LogicalName,MinValue,MaxValue,Precision' },
  { type: 'Double', cast: 'Double', select: 'LogicalName,MinValue,MaxValue,Precision' },
  { type: 'DateTime', cast: 'DateTime', select: 'LogicalName,Format' },
];

function columnType(attribute) {
  const name = attribute && ((attribute.AttributeTypeName && attribute.AttributeTypeName.Value) || attribute.attributeTypeName);
  const fallback = attribute && (attribute.attributeType || attribute.AttributeType);
  return Object.hasOwn(TYPE_BY_NAME, name) ? TYPE_BY_NAME[name]
    : Object.hasOwn(TYPE_BY_ATTRIBUTE, fallback) ? TYPE_BY_ATTRIBUTE[fallback] : undefined;
}

function logicalName(attribute) {
  return String((attribute && (attribute.logicalName || attribute.LogicalName)) || '').toLowerCase();
}

// A heterogeneous Attributes collection cannot select MaxLength, FormatName, MinValue, etc.:
//   .../Attributes/Microsoft.Dynamics.CRM.IntegerAttributeMetadata?$select=LogicalName,MinValue,MaxValue,Format
//   -> { "value": [{ "LogicalName": "contoso_minutes", "MinValue": 0, "MaxValue": 60, "Format": "Duration" }] }
// Read only types this table actually declares, never its audit columns or lookup/choice shadows.
// Money's detail rides on the existing base-currency read; Boolean labels already ride on the
// SDK's choices projection. BigInt's range is deliberately not read: the SDK cannot create it.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api
async function readColumnOptions(sdk, logical, attributes, concurrency) {
  const authored = (attributes || []).filter((a) => a && a.isCustomAttribute !== false && a.IsCustomAttribute !== false
    && !a.AttributeOf && !a.attributeOf && a.IsLogical !== true && a.isLogical !== true && a.IsBaseCurrency !== true);
  const present = new Set(authored.map(columnType).filter(Boolean));
  const results = await mapLimit(CASTS.filter((c) => present.has(c.type)), concurrency, async ({ type, cast, select }) => {
    try {
      const res = await sdk.dataverse.get(`/EntityDefinitions(LogicalName='${odataLit(logical)}')/Attributes/Microsoft.Dynamics.CRM.${cast}AttributeMetadata?$select=${select}`);
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
      if (!res.body || !Array.isArray(res.body.value)) throw new Error('the response carried no value[] array');
      return { type, rows: res.body.value };
    } catch (err) {
      return { type, failed: (err && err.message) ? String(err.message).slice(0, 200) : 'read failed' };
    }
  }, { firstInOrder: true });
  const rows = new Map();
  const failures = [];
  for (const r of results) {
    if (r.failed) { failures.push(`${r.type}: ${r.failed}`); continue; }
    const byName = new Map(r.rows.filter((a) => a && a.LogicalName).map((a) => [logicalName(a), a]));
    for (const attribute of authored.filter((a) => columnType(a) === r.type)) {
      const name = logicalName(attribute);
      const row = byName.get(name);
      if (!row) { failures.push(`${r.type} ${name}: its row was missing`); continue; }
      rows.set(name, row);
      const missing = [];
      columnOptionFields(row, r.type, missing);
      failures.push(...missing.map((detail) => `${r.type} ${name}: ${detail}`));
    }
  }
  for (const attribute of authored.filter((a) => ['Money', 'Boolean'].includes(columnType(a)))) {
    const type = columnType(attribute);
    const missing = [];
    columnOptionFields(attribute, type, missing);
    failures.push(...missing.map((detail) => `${type} ${logicalName(attribute)}: ${detail}`));
  }
  return { rows, failures };
}

function columnOptionFields(attribute, type, omitted = []) {
  const a = attribute || {};
  const fields = {};
  const defaults = DEFAULTS[type] || {};
  const keep = (key, value) => {
    if (value !== undefined && value !== null && value !== defaults[key]) fields[key] = value;
  };
  if (type === 'Text' || type === 'Memo') {
    const length = a.MaxLength !== undefined ? a.MaxLength : a.maxLength;
    if (Number.isInteger(length) && length > 0) keep('maxLength', length);
    else omitted.push('maxLength was missing or not a positive whole number');
  }
  if (type === 'Text') {
    const format = a.FormatName && a.FormatName.Value;
    if (typeof a.AutoNumberFormat === 'string' && a.AutoNumberFormat.trim()) {
      // AutoNumber is a StringAttributeMetadata with AutoNumberFormat, not a distinct API type.
      // Its length/format cannot be authored through columnOptions, so do not pretend otherwise.
      return { type: 'AutoNumber', autoNumberFormat: a.AutoNumberFormat };
    }
    if (typeof format === 'string' && format.trim()) keep('format', format);
    else omitted.push('format was missing or not a format name');
    if (a.AutoNumberFormat === undefined || (a.AutoNumberFormat !== null && typeof a.AutoNumberFormat !== 'string')) {
      omitted.push('autoNumberFormat was missing or malformed');
    }
  }
  if (['Integer', 'Decimal', 'Double', 'Money'].includes(type)) {
    for (const [key, raw] of [['minValue', 'MinValue'], ['maxValue', 'MaxValue']]) {
      if (typeof a[raw] === 'number' && Number.isFinite(a[raw]) && (type !== 'Integer' || Number.isInteger(a[raw]))) keep(key, a[raw]);
      else omitted.push(`${key} was missing or not a finite ${type === 'Integer' ? 'whole ' : ''}number`);
    }
  }
  // Money PrecisionSource selects column (0), organization pricing (1) or transaction currency
  // (2). The SDK always creates 2, so carrying Precision alone for 0/1 would silently change
  // what controls the column. Source 2 keeps numeric metadata, not a promise that the target's
  // currencies have the same effective precision.
  // See: https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.metadata.moneyattributemetadata.precisionsource
  if (type === 'Money' && a.PrecisionSource !== 2) {
    const source = a.PrecisionSource === 0 ? 'PrecisionSource 0 (column precision) is unsupported'
      : a.PrecisionSource === 1 ? 'PrecisionSource 1 (organization pricing precision) is unsupported'
        : 'PrecisionSource was missing, malformed or unknown';
    omitted.push(`${source}; the build always creates PrecisionSource 2 (transaction currency), so precision was omitted. Check and configure the required precision source in Power Apps on the target`);
  } else if (['Decimal', 'Double', 'Money'].includes(type)) {
    if (Number.isInteger(a.Precision) && a.Precision >= 0) keep('precision', a.Precision);
    else omitted.push('precision was missing or not a non-negative whole number');
  }
  if (type === 'Integer') {
    if (INTEGER_FORMATS.includes(a.Format)) keep('integerFormat', a.Format);
    else omitted.push('integerFormat was missing or is not supported by the build');
  }
  if (type === 'DateTime') {
    if (['DateOnly', 'DateAndTime'].includes(a.Format)) keep('dateFormat', a.Format);
    else omitted.push('dateFormat was missing or is not supported by the build');
  }
  if (type === 'Boolean') {
    for (const [key, value] of [['trueLabel', 1], ['falseLabel', 0]]) {
      const option = (Array.isArray(a.choices) ? a.choices : []).find((o) => o && o.value === value);
      if (option && typeof option.label === 'string' && option.label.trim()) keep(key, option.label);
      else omitted.push(`${key} could not be read`);
    }
  }
  return fields;
}

function primaryColumnOptionFields(attribute) {
  const length = attribute && (attribute.MaxLength !== undefined ? attribute.MaxLength : attribute.maxLength);
  const format = attribute && attribute.AutoNumberFormat;
  return {
    // A primary length must stay explicit even at 100: some environments ignore the create's
    // length, and the post-create correction runs only when primaryAttribute.maxLength is present.
    ...(Number.isInteger(length) && length > 0 ? { maxLength: length } : {}),
    ...(typeof format === 'string' && format.trim() ? { autoNumberFormat: format } : {}),
  };
}

module.exports = { readColumnOptions, columnOptionFields, primaryColumnOptionFields };
