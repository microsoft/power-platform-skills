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

function assertIssue(result, code, level) {
  const issue = result.issues.find((item) => item.code === code);
  assert.ok(issue, `${code} missing from ${issueCodes(result).join(', ')}`);
  assert.equal(issue.level, level);
  return issue;
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
  assertIssue(result, 'PCF_BIND_FACTOR_UNDECLARED', 'error');
});

test('verifyBinding checks factor completeness across all declared controls, then requested-client identity', () => {
  const formxml = `<form><tabs><tab><columns><column><sections><section><rows><row>
    <cell><control id="new_rating" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}" datafieldname="new_rating" uniqueid="{11111111-1111-4111-8111-111111111111}" /></cell>
  </row></rows></section></sections></column></columns></tab></tabs>
  <controlDescriptions>
    <controlDescription forControl="{11111111-1111-4111-8111-111111111111}">
      <customControl id="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" />
      <customControl formFactor="0" name="MscrmControls.Field.TextBox" />
      <customControl formFactor="1" name="MscrmControls.Field.TextBox" />
      <customControl formFactor="2" name="new_Contoso.Controls.StarRating"><parameters><value>new_rating</value></parameters></customControl>
    </controlDescription>
  </controlDescriptions></form>`;

  const webOnly = verifyBinding(formxml, {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    clients: ['web'],
    parameters: { value: { column: 'new_rating' } },
  });
  assert.equal(webOnly.ok, true);
  assert.equal(webOnly.status, 'bound');
  assert.deepEqual(webOnly.issues, []);

  const phoneRequested = verifyBinding(formxml, {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    clients: ['phone'],
  });
  assert.equal(phoneRequested.status, 'error');
  assertIssue(phoneRequested, 'PCF_BIND_CLIENT_MISSING', 'error');
  assert.equal(issueCodes(phoneRequested).includes('PCF_BIND_FACTOR_UNDECLARED'), false);
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

test('verifyBinding treats an empty normalized client list as unverifiable binding evidence', () => {
  const formxml = `<form><tabs><tab><columns><column><sections><section><rows><row>
    <cell><control id="new_rating" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}" datafieldname="new_rating" uniqueid="{11111111-1111-4111-8111-111111111111}" /></cell>
  </row></rows></section></sections></column></columns></tab></tabs>
  <controlDescriptions>
    <controlDescription forControl="{11111111-1111-4111-8111-111111111111}">
      <customControl id="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" />
      <customControl formFactor="0" name="MscrmControls.Field.TextBox" />
      <customControl formFactor="1" name="MscrmControls.Field.TextBox" />
      <customControl formFactor="2" name="new_Contoso.Controls.Other"><parameters><value>new_other</value></parameters></customControl>
    </controlDescription>
  </controlDescriptions></form>`;

  const result = verifyBinding(formxml, {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    clients: [' '],
    parameters: { value: { column: 'new_rating' } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assertIssue(result, 'PCF_BIND_CLIENTS_EMPTY', 'error');
  assertIssue(result, 'PCF_BIND_CLIENT_MISSING', 'error');
});

test('verifyBinding reports case-only forControl joins as info while still binding', () => {
  const result = verifyBinding(xml('forcontrol-case-mismatch.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'bound');
  assertIssue(result, 'PCF_BIND_FORCONTROL_CASE', 'info');
});

test('verifyBinding distinguishes missing descriptions, non-custom cells, and duplicate target cells', () => {
  const missingDescription = verifyBinding(xml('missing-description.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });
  assert.equal(missingDescription.status, 'not-bound');
  assertIssue(missingDescription, 'PCF_BIND_NO_DESCRIPTION', 'error');

  const defaultControl = verifyBinding(xml('default-control-only.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });
  assert.equal(defaultControl.status, 'not-bound');
  assertIssue(defaultControl, 'PCF_BIND_NOT_CUSTOM', 'error');
  assertIssue(defaultControl, 'PCF_BIND_NO_UNIQUEID', 'error');
  assertIssue(defaultControl, 'PCF_BIND_NO_DESCRIPTION', 'error');

  const duplicate = verifyBinding(xml('duplicate-column-cells.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });
  assert.equal(duplicate.status, 'ambiguous');
  assertIssue(duplicate, 'PCF_BIND_MULTIPLE_CELLS', 'error');
});

test('verifyBinding reports no-cell evidence from a roundtrip-derived fixture when the column is absent', () => {
  const result = verifyBinding(xml('no-requested-column-roundtrip-derived.xml'), {
    controlName: 'new_ContosoProbe.ContosoProbeA',
    column: 'new_missingrating',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-bound');
  assertIssue(result, 'PCF_BIND_NO_CELL', 'error');
});

test('verifyBinding reports requested client missing when phone uses a different control', () => {
  const result = verifyBinding(xml('phone-other-control-roundtrip-derived.xml'), {
    controlName: 'new_ContosoProbe.ContosoProbeA',
    column: 'new_contosoprobetext',
    clients: ['web', 'phone'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assertIssue(result, 'PCF_BIND_CLIENT_MISSING', 'error');
});

test('verifyBinding reports missing fallback from a roundtrip-derived fixture', () => {
  const result = verifyBinding(xml('no-fallback-roundtrip-derived.xml'), {
    controlName: 'new_ContosoProbe.ContosoProbeA',
    column: 'new_contosoprobetext',
    clients: ['web', 'phone', 'tablet'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'bound');
  assertIssue(result, 'PCF_BIND_NO_FALLBACK', 'warning');
});

test('verifyBinding reports parameter mismatches and static parameters without type as errors', () => {
  const mismatch = verifyBinding(xml('bound-all-clients.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    parameters: { value: { column: 'new_other' }, missing: { column: 'new_missing' } },
  });
  assert.equal(mismatch.status, 'error');
  assertIssue(mismatch, 'PCF_BIND_PARAM_MISSING', 'error');
  assertIssue(mismatch, 'PCF_BIND_PARAM_MISMATCH', 'error');

  const staticNoType = verifyBinding(xml('static-without-type.xml'), {
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
    parameters: { max: { static: '5' } },
  });
  assert.equal(staticNoType.status, 'error');
  assertIssue(staticNoType, 'PCF_BIND_STATIC_NO_TYPE', 'error');
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
  assertIssue(result, 'PCF_BIND_KIND_NOT_VERIFIED', 'info');
});

test('verifyBinding returns configuration-not-verified for grid customizer bindings until a real fixture exists', () => {
  const result = verifyBinding(xml('bound-all-clients.xml'), {
    kind: 'grid-customizer',
    controlName: 'new_Contoso.Controls.StarRating',
    column: 'new_rating',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'configuration-not-verified');
  assertIssue(result, 'PCF_BIND_KIND_NOT_VERIFIED', 'info');
});
