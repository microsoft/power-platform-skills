'use strict';

const {
  parseXml,
  childElements,
  findAll,
  attr,
  textOf,
} = require('./xml-lite.js');

const CUSTOM_CONTROL_CLASSID = '{F9A8A302-114E-466A-B582-6771B2AE0D92}';
const FORMXML_CLIENT_FACTORS = Object.freeze({ phone: '0', tablet: '1', web: '2' });
const CLIENT_BY_FACTOR = Object.freeze(Object.fromEntries(Object.entries(FORMXML_CLIENT_FACTORS).map(([name, factor]) => [factor, name])));
const ALL_FACTORS = Object.freeze(Object.values(FORMXML_CLIENT_FACTORS));

function parseFormXml(formxml) {
  return parseXml(formxml);
}

function findCells(formRoot, { column, controlId } = {}) {
  return findAll(formRoot, (node) => {
    if (!node || node.name !== 'cell') return false;
    const control = firstControl(node);
    if (!control) return false;
    if (column && attr(control, 'datafieldname') !== column) return false;
    if (controlId && attr(control, 'id') !== controlId) return false;
    return !!(column || controlId);
  }).map((cell) => {
    const control = firstControl(cell);
    return { cell, control, uniqueid: attr(control, 'uniqueid') || null };
  });
}

function describeCell(formRoot, cell) {
  const control = cell && cell.control ? cell.control : firstControl(cell && cell.name === 'cell' ? cell : null);
  const uniqueid = control ? (attr(control, 'uniqueid') || null) : null;
  const classid = control ? (attr(control, 'classid') || null) : null;
  // Designer-authored FormXML keys the sibling description by the cell control's uniqueid:
  //   <cell><control id="new_rating" classid="{F9A8...}" datafieldname="new_rating"
  //     uniqueid="{36F1...}" /></cell>
  //   <controlDescriptions>
  //     <controlDescription forControl="{36F1...}">
  //       <customControl id="{4273...}">...</customControl>
  //       <customControl formFactor="2" name="new_Contoso.Controls.StarRating">...</customControl>
  //     </controlDescription>
  //   </controlDescriptions>
  // The first customControl has `id` but no `name`; that is the fallback/replaced control, not the
  // PCF control. GUID joins compare case-insensitively because the platform round-trips that way.
  const description = uniqueid ? findDescription(formRoot, uniqueid) : null;
  const entries = description
    ? childElements(description.element, 'customControl').map((entry) => ({
      name: attr(entry, 'name'),
      id: attr(entry, 'id'),
      formFactor: attr(entry, 'formFactor'),
      parameters: parseParameters(firstChild(entry, 'parameters')),
    }))
    : [];

  return {
    uniqueid,
    classid,
    isCustomControlCell: sameGuid(classid, CUSTOM_CONTROL_CLASSID),
    entries,
    forControlExact: !!(description && description.exact),
  };
}

function verifyBinding(formxml, expected) {
  const expect = expected || {};
  const kind = expect.kind || 'field';
  const formRoot = parseFormXml(formxml);
  const cells = findCells(formRoot, { column: expect.column, controlId: expect.controlId });
  const issues = [];

  if (cells.length === 0) {
    issues.push(finding('PCF_BIND_NO_CELL', 'error', 'No form cell matched the requested column or control id.'));
    return result(false, 'not-bound', cells, issues);
  }
  if (cells.length > 1) {
    issues.push(finding('PCF_BIND_MULTIPLE_CELLS', 'error', 'More than one form cell matched the requested target; specify --control-id to disambiguate.'));
    return result(false, 'ambiguous', cells, issues);
  }

  const described = describeCell(formRoot, cells[0]);
  const outCells = [{ ...cells[0], description: described }];

  if (kind === 'dataset-subgrid' || kind === 'grid-customizer') {
    issues.push(finding(
      'PCF_BIND_KIND_NOT_VERIFIED',
      'info',
      `${kind} bindings need a real designer-produced fixture before this verifier can prove their configuration.`,
    ));
    return result(false, 'configuration-not-verified', outCells, issues);
  }

  if (!described.isCustomControlCell) {
    issues.push(finding('PCF_BIND_NOT_CUSTOM', 'error', 'The matched cell is not marked as a custom-control cell.'));
  }
  if (!described.uniqueid) {
    issues.push(finding('PCF_BIND_NO_UNIQUEID', 'error', 'The matched cell has no uniqueid, so no controlDescription can be joined to it.'));
  }
  if (described.entries.length === 0) {
    issues.push(finding('PCF_BIND_NO_DESCRIPTION', 'error', 'No controlDescription matched the cell uniqueid.'));
  }
  if (described.entries.length > 0 && !described.forControlExact) {
    issues.push(finding('PCF_BIND_FORCONTROL_CASE', 'info', 'The controlDescription forControl matched the cell uniqueid only case-insensitively.'));
  }

  const controlEntries = described.entries.filter((entry) => entry.name === expect.controlName);
  const entriesByFactor = new Map(controlEntries.map((entry) => [entry.formFactor, entry]));
  const declaredFactors = new Set(described.entries.map((entry) => entry.formFactor).filter(Boolean));
  if (described.entries.length > 0) {
    const fallback = described.entries.some((entry) => entry.id && !entry.name);
    if (!fallback) {
      issues.push(finding('PCF_BIND_NO_FALLBACK', 'warning', 'The controlDescription has no fallback customControl entry with id and no name.'));
    }

    for (const factor of ALL_FACTORS) {
      // Dataverse's completeness rule is about declaring a customControl entry for each formFactor,
      // not about every factor using the requested PCF. A normal maker choice is web = PCF while
      // phone/tablet stay on the default control; identity is checked only for requested clients.
      if (!declaredFactors.has(factor)) {
        issues.push(finding(
          'PCF_BIND_FACTOR_UNDECLARED',
          'error',
          `The binding does not declare formFactor="${factor}" (${CLIENT_BY_FACTOR[factor]}). Dataverse rejects incomplete factor declarations.`,
        ));
      }
    }
  }

  const clients = normalizeClients(expect.clients);
  if (described.entries.length > 0) {
    for (const client of clients) {
      const factor = FORMXML_CLIENT_FACTORS[client];
      const entry = entriesByFactor.get(factor);
      if (!entry) {
        issues.push(finding('PCF_BIND_CLIENT_MISSING', 'error', `The requested ${client} client does not use ${expect.controlName}.`));
      }
    }
  }

  for (const entry of controlEntries) {
    for (const [name, actual] of Object.entries(entry.parameters)) {
      if (actual && actual.static && !actual.type) {
        issues.push(finding('PCF_BIND_STATIC_NO_TYPE', 'error', `Static parameter '${name}' is missing its Dataverse type.`));
      }
    }
  }

  const parameterExpectations = expect.parameters || {};
  for (const client of clients) {
    const entry = entriesByFactor.get(FORMXML_CLIENT_FACTORS[client]);
    if (!entry) continue;
    compareParameters(entry, parameterExpectations, issues);
  }

  const hasError = issues.some((issue) => issue.level === 'error');
  if (hasError) return result(false, described.entries.length ? 'error' : 'not-bound', outCells, dedupeIssues(issues));
  return result(true, 'bound', outCells, dedupeIssues(issues));
}

function compareParameters(entry, expected, issues) {
  for (const [name, wanted] of Object.entries(expected)) {
    const actual = entry.parameters[name];
    if (!actual) {
      issues.push(finding('PCF_BIND_PARAM_MISSING', 'error', `Parameter '${name}' is missing for formFactor="${entry.formFactor}".`));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(wanted, 'column')) {
      if (actual.static || actual.value !== wanted.column) {
        issues.push(finding('PCF_BIND_PARAM_MISMATCH', 'error', `Parameter '${name}' is not bound to column '${wanted.column}' for formFactor="${entry.formFactor}".`));
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(wanted, 'static')) {
      if (!actual.static || actual.value !== String(wanted.static) || (wanted.type && actual.type !== wanted.type)) {
        issues.push(finding('PCF_BIND_PARAM_MISMATCH', 'error', `Parameter '${name}' does not match the expected static value for formFactor="${entry.formFactor}".`));
      }
    }
  }
}

function parseParameters(parametersEl) {
  const parameters = {};
  if (!parametersEl) return parameters;

  for (const child of childElements(parametersEl)) {
    if (child.name === 'data-set') {
      const datasets = parameters['data-set'] || [];
      datasets.push(parseDataSet(child));
      parameters['data-set'] = datasets;
      continue;
    }
    parameters[child.name] = {
      static: attr(child, 'static') === 'true',
      type: attr(child, 'type'),
      value: textOf(child),
    };
  }
  return parameters;
}

function parseDataSet(dataSetEl) {
  // Dataset parameters are nested, unlike field parameters:
  //   <parameters>
  //     <data-set name="records">
  //       <property-set name="email"><column>emailaddress1</column></property-set>
  //     </data-set>
  //   </parameters>
  // Preserve that shape so a future real dataset fixture can be verified without changing callers.
  const dataSet = { name: attr(dataSetEl, 'name') };
  for (const child of childElements(dataSetEl)) {
    if (child.name === 'property-set') {
      const propertySets = dataSet['property-set'] || [];
      propertySets.push(parsePropertySet(child));
      dataSet['property-set'] = propertySets;
    } else {
      dataSet[child.name] = textOf(child);
    }
  }
  return dataSet;
}

function parsePropertySet(propertySetEl) {
  const propertySet = { name: attr(propertySetEl, 'name') };
  for (const child of childElements(propertySetEl)) {
    propertySet[child.name] = textOf(child);
  }
  return propertySet;
}

function findDescription(formRoot, uniqueid) {
  const descriptions = findAll(formRoot, (node) => node.name === 'controlDescription');
  let insensitive = null;
  for (const description of descriptions) {
    const forControl = attr(description, 'forControl');
    if (forControl === uniqueid) return { element: description, exact: true };
    if (!insensitive && sameGuid(forControl, uniqueid)) insensitive = { element: description, exact: false };
  }
  return insensitive;
}

function firstControl(cell) {
  if (!cell) return null;
  return childElements(cell, 'control')[0] || null;
}

function firstChild(el, name) {
  return childElements(el, name)[0] || null;
}

function normalizeClients(clients) {
  const raw = Array.isArray(clients) && clients.length ? clients : ['web'];
  return [...new Set(raw.map((client) => String(client).trim()).filter(Boolean))];
}

function sameGuid(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function finding(code, level, message) {
  return { code, level, message };
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = `${issue.code}\0${issue.level}\0${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function result(ok, status, cells, issues) {
  return { ok, status, cells, issues };
}

module.exports = {
  CUSTOM_CONTROL_CLASSID,
  FORMXML_CLIENT_FACTORS,
  parseFormXml,
  findCells,
  describeCell,
  verifyBinding,
};
