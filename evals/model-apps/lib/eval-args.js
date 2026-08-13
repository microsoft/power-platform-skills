'use strict';
// Shared argument parsing for the model-apps eval runners (app-builder + genpage layers 1/2).
//
// Extracted because all three shipped a byte-identical `parseArgs` with the same defect class:
// `argv[++i]` is `undefined` for a trailing flag, and an undefined value is FALSY, so every
// runner treated a value-less `--tier`/`--fixtures` as "no filter" / "the built-in fixtures" and
// then reported PASS for a scope the caller never asked for. A silent wrong-scope PASS is worse
// than an error, because the operator believes a suite ran that did not.
//
// The three flags are identical across the runners; only the help text differs, so that stays
// with each runner.

/** Tiers an eval fixture can declare. A typo must be rejected here rather than matching nothing. */
const TIERS = ['smoke', 'full'];

/**
 * @param {string[]} argv                 - process.argv.slice(2)
 * @param {object}   opts
 * @param {() => void} [opts.printHelp]   - called for --help/-h before exiting 0
 * @param {(msg: string) => never} [opts.fail] - test seam; defaults to stderr + exit 2
 * @returns {{ fixtures: string|null, eval: number|null, tier: string|null }}
 */
function parseEvalArgs(argv, { printHelp, fail } = {}) {
  const die = fail || ((msg) => { console.error(`error: ${msg}`); process.exit(2); });
  const args = { fixtures: null, eval: null, tier: null };
  // A value that itself looks like a flag is the same mistake one keystroke earlier
  // (`--tier --eval 1` silently set tier="--eval"), so reject that too.
  const valueFor = (flag, i) => {
    const v = argv[i];
    if (v === undefined || /^--/.test(v)) die(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixtures') {
      args.fixtures = valueFor('--fixtures', ++i);
    } else if (a === '--eval') {
      const raw = valueFor('--eval', ++i);
      // parseInt('1.5', 10) === 1 and parseInt('abc', 10) === NaN, so the old parse silently
      // graded fixture 1 for `--eval 1.5`, and turned a typo into a misleading
      // "no fixtures matched the filter" that blames the fixtures rather than the argument.
      if (!/^\d+$/.test(raw)) die(`--eval requires a non-negative integer fixture id (got ${JSON.stringify(raw)})`);
      args.eval = parseInt(raw, 10);
    } else if (a === '--tier') {
      const raw = valueFor('--tier', ++i);
      if (!TIERS.includes(raw)) die(`--tier must be one of ${TIERS.join('|')} (got ${JSON.stringify(raw)})`);
      args.tier = raw;
    } else if (a === '--help' || a === '-h') {
      if (printHelp) printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

module.exports = { parseEvalArgs, TIERS };
