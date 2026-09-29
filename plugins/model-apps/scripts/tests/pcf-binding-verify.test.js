'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CUSTOM_CONTROL_CLASSID,
  FORMXML_CLIENT_FACTORS,
  parseFormXml,
  findCells,
  describeCell,
  verifyBinding,
} = require('../lib/pcf-binding-verify.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'pcf-formxml');

function xml(name) {
  return fs.readFileSync(path.join(fixtureDir, name), 'utf8');
}

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

test('exports the single custom-control class id and semantic FormXML client factors', () => {
  assert.equal(CUSTOM_CONTROL_CLASSID, '{F9A8A302-114E-466A-B582-6771B2AE0D92}');
  assert.deepEqual(FORMXML_CLIENT_FACTORS, Object.freeze({ phone: '0', tablet: '1', web: '2' }));
});

test('findCells locates candidate cells by column or control id', () => {
  const form = parseFormXml(xml('bound-all-clients.xml'));

  assert.equal(findCells(form, { column: 'new_rating' }).length, 1);
  assert.equal(findCells(form, { controlId: 'new_rating' }).length, 1);
  assert.equal(findCells(form, { column: 'new_missing' }).length, 0);
});

test('describeCell parses fallback, form-factor entries, flat parameters, and exact forControl evidence', () => {
  const form = parseFormXml(xml('field-bound-roundtrip.xml'));
  const [cell] = findCells(form, { column: 'new_contosoprobetext' });

  const described = describeCell(form, cell);

  assert.equal(described.uniqueid, '{36F1D7E1-F372-421F-A11F-0EC7117E3EDE}');
  assert.equal(described.classid, CUSTOM_CONTROL_CLASSID);
  assert.equal(described.isCustomControlCell, true);
  assert.equal(described.forControlExact, true);
  assert.ok(described.entries.some((entry) => entry.id === '{4273EDBD-AC1D-40d3-9FB2-095C621B552D}' && !entry.name));
  assert.deepEqual(
    described.entries.filter((entry) => entry.name === 'new_ContosoProbe.ContosoProbeA').map((entry) => entry.formFactor).sort(),
    ['0', '1', '2'],
  );
  assert.deepEqual(described.entries.find((entry) => entry.formFactor === '2').parameters.sampleProperty, {
    static: false,
    type: undefined,
    value: 'new_contosoprobetext',
  });
});

test('verifyBinding reports a real round-tripped field binding as bound only for proved clients', () => {
  const result = verifyBinding(xml('field-bound-roundtrip.xml'), {
    controlName: 'new_ContosoProbe.ContosoProbeA',
    column: 'new_contosoprobetext',
    clients: ['web', 'phone', 'tablet'],
    parameters: { sampleProperty: { column: 'new_contosoprobetext' } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'bound');
  assert.deepEqual(result.issues, []);
});

test('verifyBinding treats undeclared FormXML client factors as errors even when web is bound', () => {
  const result = verifyBinding(xml('bound-web-only.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.ok(issueCodes(result).includes('PCF_BIND_FACTOR_UNDECLARED'));
  assert.equal(result.issues.find((issue) => issue.code === 'PCF_BIND_FACTOR_UNDECLARED').level, 'error');
});

test('verifyBinding verifies all requested clients and static parameter shape', () => {
  const result = verifyBinding(xml('bound-all-clients.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    clients: ['web', 'phone', 'tablet'],
    parameters: {
      value: { column: 'new_rating' },
      max: { static: '5', type: 'Whole.None' },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'bound');
  assert.deepEqual(result.issues, []);
});

test('verifyBinding reports case-only forControl joins as info while still binding', () => {
  const result = verifyBinding(xml('forcontrol-case-mismatch.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'bound');
  assert.deepEqual(result.issues.map((issue) => [issue.code, issue.level]), [['PCF_BIND_FORCONTROL_CASE', 'info']]);
});

test('verifyBinding distinguishes missing descriptions, non-custom cells, and duplicate target cells', () => {
  assert.deepEqual(issueCodes(verifyBinding(xml('missing-description.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  })), ['PCF_BIND_NO_DESCRIPTION']);

  assert.deepEqual(issueCodes(verifyBinding(xml('default-control-only.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  })), ['PCF_BIND_NOT_CUSTOM', 'PCF_BIND_NO_UNIQUEID', 'PCF_BIND_NO_DESCRIPTION']);

  const duplicate = verifyBinding(xml('duplicate-column-cells.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });
  assert.equal(duplicate.status, 'ambiguous');
  assert.deepEqual(issueCodes(duplicate), ['PCF_BIND_MULTIPLE_CELLS']);
});

test('verifyBinding reports parameter mismatches and static parameters without type as errors', () => {
  const mismatch = verifyBinding(xml('bound-all-clients.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    parameters: { value: { column: 'new_other' }, missing: { column: 'new_missing' } },
  });
  assert.equal(mismatch.status, 'error');
  assert.ok(issueCodes(mismatch).includes('PCF_BIND_PARAM_MISSING'));
  assert.ok(issueCodes(mismatch).includes('PCF_BIND_PARAM_MISMATCH'));

  const staticNoType = verifyBinding(xml('static-without-type.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    parameters: { max: { static: '5' } },
  });
  assert.equal(staticNoType.status, 'error');
  assert.ok(issueCodes(staticNoType).includes('PCF_BIND_STATIC_NO_TYPE'));
});

test('verifyBinding preserves data-set nesting but returns configuration-not-verified without a real dataset fixture', () => {
  const form = parseFormXml(xml('subgrid-dataset-bound.xml'));
  const [cell] = findCells(form, { controlId: 'Contacts' });
  const described = describeCell(form, cell);
  assert.deepEqual(described.entries.find((entry) => entry.formFactor === '2').parameters['data-set'], [{
    name: 'records',
    'property-set': [{ name: 'email', column: 'emailaddress1' }],
  }]);

  const result = verifyBinding(xml('subgrid-dataset-bound.xml'), {
    kind: 'dataset-subgrid',
    controlName: 'new_Contoso.Controls.ContactDataset',
    controlId: 'Contacts',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'configuration-not-verified');
  assert.ok(issueCodes(result).includes('PCF_BIND_KIND_NOT_VERIFIED'));
});

test('verifyBinding returns configuration-not-verified for grid customizer bindings until a real fixture exists', () => {
  const result = verifyBinding(xml('bound-all-clients.xml'), {
    kind: 'grid-customizer',
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'configuration-not-verified');
  assert.ok(issueCodes(result).includes('PCF_BIND_KIND_NOT_VERIFIED'));
});
