'use strict';
// Unit tests for the SHARED eval arg parser. The runner-level tests in
// app-builder/tests/run-app-builder.test.js spawn a process and assert exit codes; these drive the
// function directly through its `fail` seam so every rejection path can be asserted cheaply and
// without process.exit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseEvalArgs, TIERS } = require('../lib/eval-args.js');

/** Collect the rejection instead of exiting, and stop parsing the way process.exit(2) would. */
function parse(argv) {
  const errors = [];
  const fail = (msg) => { errors.push(msg); throw new Error(`__fail__:${msg}`); };
  try {
    return { args: parseEvalArgs(argv, { printHelp() {}, fail }), errors };
  } catch (e) {
    if (!/^__fail__:/.test(e.message)) throw e;
    return { args: null, errors };
  }
}

test('eval-args: valid arguments parse', () => {
  const { args } = parse(['--fixtures', 'D:/x', '--eval', '3', '--tier', 'smoke']);
  assert.deepEqual(args, { fixtures: 'D:/x', eval: 3, tier: 'smoke' });
});

test('eval-args: absent flags stay null (the caller decides the default)', () => {
  const { args } = parse([]);
  assert.deepEqual(args, { fixtures: null, eval: null, tier: null });
});

test('eval-args: a trailing flag with no value is rejected, never silently defaulted', () => {
  // The original defect: `argv[++i]` is undefined, and undefined is falsy, so `--tier` alone
  // became "no tier filter" and the run reported PASS for every tier.
  for (const flag of ['--fixtures', '--eval', '--tier']) {
    const { args, errors } = parse([flag]);
    assert.equal(args, null, `${flag} alone must not parse`);
    assert.match(errors[0], new RegExp(`${flag}`), `${flag} must be named in the error`);
  }
});

test('eval-args: a value that is itself a flag is rejected', () => {
  const { args, errors } = parse(['--tier', '--eval', '1']);
  assert.equal(args, null);
  assert.match(errors[0], /--tier requires a value/);
});

test('eval-args: --eval accepts only a non-negative integer', () => {
  // parseInt('1.5', 10) === 1 silently graded the wrong fixture and reported PASS.
  for (const bad of ['1.5', 'abc', '', '-1', '1e3', ' 1']) {
    const { args } = parse(['--eval', bad]);
    assert.equal(args, null, `--eval ${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(parse(['--eval', '0']).args.eval, 0, 'zero is a legal fixture id');
  assert.equal(parse(['--eval', '12']).args.eval, 12);
});

test('eval-args: --tier accepts only a known tier and names the choices', () => {
  const { args, errors } = parse(['--tier', 'smoek']);
  assert.equal(args, null);
  for (const t of TIERS) assert.match(errors[0], new RegExp(t), `the error lists ${t}`);
  for (const t of TIERS) assert.equal(parse(['--tier', t]).args.tier, t);
});
