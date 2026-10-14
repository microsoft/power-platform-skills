'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateNamespace,
  validateControlName,
  validatePublisherPrefix,
  validateSolutionUniqueName,
  validateVersion,
  orgControlName,
  parseOrgControlName,
  bumpPatch,
} = require('../lib/pcf-names.js');

test('validateNamespace accepts dotted identifiers and rejects invalid dot segments', () => {
  assert.equal(validateNamespace('Contoso.Controls'), null);

  assert.match(validateNamespace('.Contoso'), /must not start or end with '\.'.*Allowed: letters, digits, and '\.' with non-empty segments that do not start with a digit/i);
  assert.match(validateNamespace('Contoso..X'), /must not contain empty segments.*Allowed: letters, digits, and '\.' with non-empty segments that do not start with a digit/i);
  assert.match(validateNamespace('Contoso.1x'), /segment "1x" must not start with a digit.*Allowed: letters, digits, and '\.' with non-empty segments that do not start with a digit/i);
});

test('validateNamespace rejects namespace plus control names longer than the PAC limit', () => {
  const namespace = 'Contoso.Controls.FeatureArea.SuperLongNamespaceSegment';
  const controlName = 'StarRatingControlNameThatExceedsLimit';

  assert.equal(namespace.length + controlName.length, 91);
  assert.match(validateNamespace(namespace, controlName), /Additional safeguard: pac pcf init rejects namespace plus control name values longer than 75 characters at run time.*Allowed: namespace plus control name must be at most 75 characters/i);
});

test('validateNamespace accepts exactly 75 characters and rejects 76 for namespace plus control name', () => {
  const namespace = 'A'.repeat(65);
  const exactName = 'B'.repeat(10);
  const tooLongName = 'B'.repeat(11);

  assert.equal(namespace.length + exactName.length, 75);
  assert.equal(namespace.length + tooLongName.length, 76);
  assert.equal(validateNamespace(namespace, exactName), null);
  assert.match(validateNamespace(namespace, tooLongName), /Additional safeguard: pac pcf init rejects namespace plus control name values longer than 75 characters at run time.*Allowed: namespace plus control name must be at most 75 characters/i);
});

test('validateControlName accepts PAC constructors and rejects invalid or reserved names', () => {
  assert.equal(validateControlName('StarRating'), null);

  assert.match(validateControlName('1Star'), /must start with a letter.*Allowed: letters and digits, starting with a letter/i);
  assert.match(validateControlName('class'), /Additional safeguard: pac pcf init rejects JavaScript reserved word control names at run time.*Allowed: letters and digits, starting with a letter, and not a JavaScript reserved word/i);
});

test('validatePublisherPrefix enforces publisher prefix shape and reserved mscrm prefix', () => {
  assert.equal(validatePublisherPrefix('ab'), null);

  assert.match(validatePublisherPrefix('a'), /must be 2 to 8 characters.*Allowed: letters and digits, starting with a letter/i);
  assert.match(validatePublisherPrefix('mscrmx'), /must not start with "mscrm".*Allowed: letters and digits, starting with a letter, not starting with "mscrm", and 2 to 8 characters/i);
  assert.match(validatePublisherPrefix('abcdefghi'), /must be 2 to 8 characters.*Allowed: letters and digits, starting with a letter/i);
});

test('validateSolutionUniqueName enforces Dataverse solution unique-name shape', () => {
  assert.equal(validateSolutionUniqueName('Contoso_Solution01'), null);
  assert.equal(validateSolutionUniqueName('_ContosoSolution'), null);

  assert.match(validateSolutionUniqueName('Contoso Solution'), /letters, digits, and underscores/i);
  assert.match(validateSolutionUniqueName('Contoso&Solution'), /letters, digits, and underscores/i);
  assert.match(validateSolutionUniqueName('Contoso"Solution'), /letters, digits, and underscores/i);
  assert.match(validateSolutionUniqueName('1Contoso'), /start with a letter or underscore/i);
  assert.match(validateSolutionUniqueName('A'.repeat(66)), /at most 65 characters/i);
});

test('validateVersion accepts semantic three-part numeric versions', () => {
  assert.equal(validateVersion('1.2.9'), null);
  assert.match(validateVersion('1.2'), /must be three dot-separated numeric parts.*Allowed: digits in x.y.z format/i);
});

test('orgControlName composes and parseOrgControlName round-trips the org control name', () => {
  const orgName = orgControlName('contoso', 'Contoso.Controls', 'StarRating');

  assert.equal(orgName, 'contoso_Contoso.Controls.StarRating');
  assert.deepEqual(parseOrgControlName(orgName), {
    prefix: 'contoso',
    namespace: 'Contoso.Controls',
    constructor: 'StarRating',
  });
});

test('parseOrgControlName returns null when separators cannot identify all parts', () => {
  assert.equal(parseOrgControlName('contosoContoso.Controls.StarRating'), null);
  assert.equal(parseOrgControlName('contoso_ContosoControlsStarRating'), null);
  assert.equal(parseOrgControlName('_Contoso.Controls.StarRating'), null);
  assert.equal(parseOrgControlName('contoso_.StarRating'), null);
  assert.equal(parseOrgControlName('contoso_Contoso.Controls.'), null);
});

test('bumpPatch increments the patch component', () => {
  assert.equal(bumpPatch('1.2.9'), '1.2.10');
});
