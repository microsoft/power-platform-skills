const assert = require('node:assert/strict');
const test = require('node:test');

const { ALL_CHECKS, EXIT, STATE_CHECKS, UsageError, parseArgs } = require('../lib/a11y/args');

test('parseArgs applies defaults for a bare --url', () => {
  const opts = parseArgs(['--url', 'https://contoso.powerappsportals.com/#top']);
  assert.equal(opts.url.toString(), 'https://contoso.powerappsportals.com/');
  assert.deepEqual(opts.routes, ['/']);
  assert.equal(opts.mode, 'audit');
  assert.deepEqual(opts.viewports, ['desktop', 'mobile']);
  assert.deepEqual(opts.checks, [...ALL_CHECKS]);
  assert.equal(opts.bestPractice, true);
  assert.equal(opts.maxPages, 25);
  assert.equal(opts.crawl, false);
  assert.equal(opts.allowFormSubmit, false);
});

test('parseArgs parses lists, dedupes, and lowercases excludes', () => {
  const opts = parseArgs([
    '--url', 'http://localhost:5173', '--routes', '/, /about,/about', '--crawl', '--max-pages', '40',
    '--exclude', 'Admin,/Draft', '--viewports', 'mobile', '--checks', 'axe,keyboard,axe',
    '--no-best-practice', '--headed', '--timeout', '5000', '--output', 'out.json',
  ]);
  assert.deepEqual(opts.routes, ['/', '/about']);
  assert.equal(opts.crawl, true);
  assert.equal(opts.maxPages, 40);
  assert.deepEqual(opts.exclude, ['admin', '/draft']);
  assert.deepEqual(opts.viewports, ['mobile']);
  assert.deepEqual(opts.checks, ['axe', 'keyboard']);
  assert.equal(opts.bestPractice, false);
  assert.equal(opts.headed, true);
  assert.equal(opts.timeoutMs, 5000);
  assert.equal(opts.output, 'out.json');
});

test('parseArgs returns help without requiring --url', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

for (const [name, argv, pattern] of [
  ['missing url', [], /--url is required/],
  ['non-http url', ['--url', 'file:///c:/site/index.html'], /http or https/],
  ['invalid url', ['--url', 'not a url'], /not a valid URL/],
  ['route without slash', ['--url', 'http://x', '--routes', 'about'], /must start with "\/"/],
  ['protocol-relative route', ['--url', 'http://x', '--routes', '//example.com/x'], /protocol-relative/],
  ['backslash route', ['--url', 'http://x', '--routes', '/\\example.com/x'], /must not contain "\\"/],
  ['control-character route', ['--url', 'http://x', '--routes', '/\t/example.com'], /control characters/],
  ['value missing', ['--url'], /requires a value/],
  ['flag as value', ['--url', '--crawl'], /requires a value/],
  ['max-pages too high', ['--url', 'http://x', '--max-pages', '201'], /between 1 and 200/],
  ['max-pages not a number', ['--url', 'http://x', '--max-pages', '2.5'], /positive integer/],
  ['unknown viewport', ['--url', 'http://x', '--viewports', 'tablet'], /--viewports/],
  ['unknown check', ['--url', 'http://x', '--checks', 'axe,colour'], /unknown: colour/],
  ['unknown mode', ['--url', 'http://x', '--mode', 'fix'], /--mode/],
  ['unknown flag', ['--url', 'http://x', '--fast'], /Unknown argument: --fast/],
  ['snapshot-dir outside discover', ['--url', 'http://x', '--snapshot-dir', 'd'], /only valid with --mode discover/],
  ['states outside audit', ['--url', 'http://x', '--mode', 'discover', '--states', 's.json'], /only valid with --mode audit/],
  ['states with no state check', ['--url', 'http://x', '--states', 's.json', '--checks', 'reflow,zoom'], /--states needs --checks to include axe or keyboard/],
]) {
  test(`parseArgs rejects ${name}`, () => {
    assert.throws(() => parseArgs(argv), (err) => err instanceof UsageError && pattern.test(err.message));
  });
}

test('states run only the checks that keep the state open', () => {
  assert.deepEqual(STATE_CHECKS, ['axe', 'keyboard']);
  assert.ok(STATE_CHECKS.every((c) => ALL_CHECKS.includes(c)));
  assert.equal(parseArgs(['--url', 'http://x', '--states', 's.json', '--checks', 'keyboard']).statesFile, 's.json');
});

test('exit codes keep "could not audit" distinct from "found violations"', () => {
  assert.deepEqual(EXIT, { PASS: 0, VIOLATIONS: 1, USAGE: 2, LOAD_FAILURE: 3, MISSING_DEPS: 4 });
});
