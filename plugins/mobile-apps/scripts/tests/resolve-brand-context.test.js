'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveBrandContext } = require('../resolve-brand-context');

test('infers a clearly named app brand without claiming verified brand guidance', () => {
  const context = resolveBrandContext({ brief: 'Build a Chanel-branded shopping app for curated accessories.' });
  assert.equal(context.brandRole, 'app-brand');
  assert.equal(context.brandSource, 'inferred');
  assert.equal(context.organizations[0].name, 'Chanel');
  assert.equal(context.inferredPalette.intent, 'luxury-neutral black/ivory');
  assert.match(context.inferredPalette.note, /official brand guidelines were not verified/);
});

test('keeps product brands out of the host app palette decision', () => {
  const context = resolveBrandContext({ brief: 'Sell Chanel products in my Flight Shop for passengers.' });
  assert.equal(context.brandRole, 'unknown');
  assert.equal(context.brandSource, 'none');
  assert.deepEqual(context.organizations, [{
    name: 'Chanel',
    role: 'product-brand',
    evidence: ['brand named as product data'],
    confidence: 'high',
  }]);
  assert.equal(context.inferredPalette, null);
});

test('does not mistake lowercase product nouns for organizations', () => {
  const context = resolveBrandContext({ brief: 'Sell travel products and beauty items in a passenger shop.' });
  assert.equal(context.brandRole, 'unknown');
  assert.equal(context.brandSource, 'none');
  assert.deepEqual(context.organizations, []);
});

test('records protected-mark caution for inferred organization-aligned direction', () => {
  const context = resolveBrandContext({ brief: 'Build a Red Cross volunteer app for coordinating local shifts.' });
  assert.equal(context.brandRole, 'app-brand');
  assert.equal(context.brandSource, 'inferred');
  assert.match(context.inferredPalette.intent, /restrained red\/white/);
  assert.match(context.inferredPalette.note, /protected emblems/);
});

test('explicit and supplied inputs take priority over inference', () => {
  const explicit = resolveBrandContext({ brief: 'Build a volunteer app.', explicitBrand: 'Contoso' });
  assert.equal(explicit.brandRole, 'app-brand');
  assert.equal(explicit.brandSource, 'explicit');
  const supplied = resolveBrandContext({ brief: 'Sell Chanel products.', suppliedBrand: true });
  assert.equal(supplied.brandSource, 'supplied');
  assert.equal(supplied.confidence, 'high');
});