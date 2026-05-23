const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../list-table-columns');

test('parseArgs picks up --table', () => {
  const args = parseArgs(['--table', 'faq_article']);
  assert.equal(args.table, 'faq_article');
});

test('parseArgs picks up --envUrl', () => {
  const args = parseArgs(['--table', 'faq_article', '--envUrl', 'https://org.crm.dynamics.com']);
  assert.equal(args.envUrl, 'https://org.crm.dynamics.com');
});

test('parseArgs accepts flags in either order', () => {
  const args = parseArgs(['--envUrl', 'https://org.crm.dynamics.com', '--table', 'faq_article']);
  assert.equal(args.table, 'faq_article');
  assert.equal(args.envUrl, 'https://org.crm.dynamics.com');
});

test('parseArgs leaves missing flags undefined (no defaults)', () => {
  // Defaults belong in main() so the test surface stays the same regardless of whether
  // we change the env-url fallback behavior. parseArgs is intentionally dumb.
  const args = parseArgs([]);
  assert.equal(args.table, undefined);
  assert.equal(args.envUrl, undefined);
});
