'use strict';
// EVERY CODE THE BUNDLED SDK CAN REPORT, and what the skills do with it — so a new SDK code fails a named test at the uptake instead of
// reaching a maker unclassified.
//
// The skills decide three things from an SDK error's `code`, never from its words:
//   - whether the build runs again (lib/retry-policy.js, judgeFailure): a typed error is a refusal (rule 6) unless the failure it carries
//     as its `cause` is transient — EXCEPT a code that says a write was sent and its outcome is unknown (OUTCOME_UNKNOWN_CODES), which
//     is never run again, because a run again re-sends the write the SDK refused to re-send; and the codes that wrap a failure
//     (WRAPPED_SERVICE_CODES, CAUSE_WRAPPER_CODES), which are judged by what they wrap;
//   - whether a failed page push wrote nothing (lib/genpage-sdk.js, writeOutcome / PRE_WRITE_REFUSALS);
//   - which step a maker is told to take (lib/entity-provision.js, operatorRemedy).
// A code the SDK adds lands in the first rule's default — a refusal over a clean failure, run again over a transient one — which is
// right for most codes and WRONG for one that says a write's outcome is unknown. This uptake brought three new codes the skill could
// receive with no test failing; this file makes the next one fail here.
//
// HOW THE CODES ARE FOUND. The SDK publishes no list of its codes: `SdkError.code` is a free string, raised in many forms — the bundle,
// minified, shows `new X.SdkError("CODE", …)`, `super("CODE", …)` in a subclass, `X.FOO_CODE = "CODE"` constants, `{ code: "CODE" }` and
// `{ errorCode: "CODE" }` results by value, `warn("CODE", …)` warnings, `reasonCode: "CODE"` observations and issue kinds pushed onto a
// list. So the scan takes EVERY code-shaped string literal in the bundle (upper case, at least one underscore) and leaves out only the
// OCCURRENCES that are provably not a code — an enum's reverse mapping and a re-export's property name (isNonCodeOccurrence) — never a
// value because of how it is spelled: a literal is a code if any one of its occurrences is not one of those two.
// ITS LIMITS, which a reader must know before trusting a green run:
//   - a code that does not follow the convention — lower case, a digit first, one word with no underscore (`"FAILED"`) — is not seen;
//   - a code built at run time from pieces (`"FOO_" + kind`, a template) is not seen — none is today;
//   - a code that only ever arrives from the service (an OData `0x8004…` code) is not an SDK code and is the retry policy's own table;
//   - a literal that is not a code is listed (harmless: it is acknowledged once as `diagnostic`).
// Within the convention it over-collects rather than misses, which is the side a regression net must err on; the authoritative list is an
// SDK-side ask.
//
// THE FIXTURE (fixtures/sdk-error-codes.json) names every code the scan finds, with what the skills do with it:
//   connection                   CONNECTION_ERROR: the HTTP status it carries decides (429/502/503/504 run again; any other is final)
//   outcome-unknown              a write that may have committed; NEVER run again, whatever failure it carries (OUTCOME_UNKNOWN_CODES)
//   outcome-unknown-unresolved   OPEN DECISION, not a contract: a code whose words say an outcome is unknown that the retry policy today
//                                runs again when the failure it carries is a transient TRANSPORT failure (a business process flow's
//                                create rollback, deactivate and reactivate; a deactivate the gateway answers with a 5xx carries the
//                                SDK's own typed error as its cause instead, which is final). Whether a run again is safe is undecided: finding the flow by name is not proof it is
//                                this build's. Pinned as it is today so that the decision, either way, is a deliberate move of these
//                                codes — to `outcome-unknown` (and OUTCOME_UNKNOWN_CODES) or to `typed`.
//   wraps-failure                judged by the failure it wraps (WRAPPED_SERVICE_CODES, CAUSE_WRAPPER_CODES)
//   page-pre-write               a page push refused before it sent a write: writeOutcome says it wrote 'nothing' (PRE_WRITE_REFUSALS)
//   typed                        a refusal: final over a clean failure, run again over a transient one (the default)
//   diagnostic                   not an error the skills receive as a failure: a warning, an observation's reason, an issue kind
// Each category's behaviour is asserted below against the plugin's own policy with the bundle's own error classes.
//
// WHEN THIS FAILS: a code the bundle has and the fixture does not is NEW — decide, in this order: does its SDK message say a write may
// have committed (add it to OUTCOME_UNKNOWN_CODES in lib/retry-policy.js, category `outcome-unknown`)? does it wrap a failure? is it a page
// refusal raised before any write (PRE_WRITE_REFUSALS in lib/genpage-sdk.js)? does a maker need a step only a person can take
// (operatorRemedy in lib/entity-provision.js)? Then add it to the fixture with its category. A code the fixture has and the bundle does not
// was REMOVED or renamed: every branch of the plugin on it (the message lists the files) is now dead — move it to the new code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { judgeFailure } = require('../lib/retry-policy.js');
const { writeOutcome } = require('../lib/genpage-sdk.js');
const { SdkError, ConnectionError } = require('../lib/maker-sdk.js');

const SCRIPTS = path.resolve(__dirname, '..');
const BUNDLE = path.join(SCRIPTS, 'vendor', 'cds-maker-sdk.cjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'sdk-error-codes.json');
const CATEGORIES = ['connection', 'outcome-unknown', 'outcome-unknown-unresolved', 'wraps-failure', 'page-pre-write', 'typed', 'diagnostic'];

const LITERAL = /["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g;
// The two OCCURRENCES of a code-shaped literal that are provably not a code, read from what stands right before it:
//   e[e.ONE_COLUMN=0]="ONE_COLUMN"                         a TypeScript enum's reverse mapping: the member's name
//   Object.defineProperty(t,"FOO_UNREADABLE_CODE",{…})     a re-export: the property's name (its VALUE is the code, a literal elsewhere)
// Only that occurrence is left out. The same text anywhere else — `new SdkError("ONE_COLUMN", …)`, a code that happens to end in
// `_CODE` — is a code, so no spelling can hide one.
function isNonCodeOccurrence(source, at, literal) {
  const before = source.slice(Math.max(0, at - 160), at);
  return new RegExp(`\\[[\\w$]+\\.${literal}=\\d+\\]=$`).test(before) || /\bdefineProperty\(\s*[\w$.]+\s*,\s*$/.test(before);
}
function codesIn(source) {
  const codes = new Set();
  for (const m of source.matchAll(LITERAL)) if (!isNonCodeOccurrence(source, m.index, m[1])) codes.add(m[1]);
  return codes;
}

// Where the plugin's own sources name a code (outside the bundle and the tests), so a removed code's message says what now branches on nothing.
function pluginMentions() {
  const mentions = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['vendor', '_vendor-build', 'node_modules', 'tests'].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith('.js')) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(LITERAL)) {
          if (!mentions.has(m[1])) mentions.set(m[1], new Set());
          mentions.get(m[1]).add(path.relative(SCRIPTS, full).replace(/\\/g, '/'));
        }
      }
    }
  };
  walk(SCRIPTS);
  return mentions;
}

// The difference between the bundle's codes and the fixture's, as the failure message a maintainer acts on.
function describeCodeDrift(bundleCodes, fixture, mentions) {
  const added = [...bundleCodes].filter((code) => !Object.prototype.hasOwnProperty.call(fixture, code)).sort();
  const removed = Object.keys(fixture).filter((code) => !bundleCodes.has(code)).sort();
  const lines = [];
  if (added.length) {
    lines.push(`The bundled SDK has ${added.length} code(s) fixtures/sdk-error-codes.json does not classify:`);
    for (const code of added) lines.push(`  ${code}${mentions.has(code) ? ` (named by ${[...mentions.get(code)].join(', ')})` : ''}`);
    lines.push('  For each: if its SDK message says a write may have committed, add it to OUTCOME_UNKNOWN_CODES (lib/retry-policy.js); if it is a page',
      '  refusal raised before any write, to PRE_WRITE_REFUSALS (lib/genpage-sdk.js); if a maker must act, give it a step (operatorRemedy,',
      '  lib/entity-provision.js). Then add it to the fixture with its category (see the header of this test).');
  }
  if (removed.length) {
    lines.push(`The bundled SDK no longer has ${removed.length} code(s) the fixture lists:`);
    for (const code of removed) lines.push(`  ${code}${mentions.has(code) ? ` — still named by ${[...mentions.get(code)].join(', ')}: those branches can no longer be taken` : ''}`);
    lines.push('  Find what the SDK raises instead, move the plugin\'s branches to it, and update the fixture.');
  }
  return lines.join('\n');
}

const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const URL = 'https://contoso.crm.dynamics.com/api/data/v9.2/contoso_tasks';
// The bundle attaches the failure an error wraps as its `cause`, not enumerably (its attachCause): so is it here.
const over = (error, cause) => Object.defineProperty(error, 'cause', { value: cause, enumerable: false, configurable: true });
const unavailable = () => new ConnectionError(URL, 503, 'Service Unavailable');
const reset = () => new ConnectionError(URL, 0, 'Request failed: read ECONNRESET');
const badRequest = () => new ConnectionError(URL, 400, 'Bad Request');

test('SDK codes: every code the bundled SDK can report is classified in fixtures/sdk-error-codes.json, and nothing more', () => {
  const codes = codesIn(fs.readFileSync(BUNDLE, 'utf8'));
  const drift = describeCodeDrift(codes, fixture(), pluginMentions());
  assert.equal(drift, '', drift);
});

test('SDK codes: the fixture uses only the known categories and is sorted, one code per line', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
  const codes = fixture();
  const unknown = Object.entries(codes).filter(([, category]) => !CATEGORIES.includes(category)).map(([code, category]) => `${code}: ${category}`);
  assert.deepEqual(unknown, [], 'every category is one this test asserts');
  assert.deepEqual(Object.keys(codes), Object.keys(codes).sort(), 'the fixture is sorted, so a diff shows exactly the codes that moved');
  assert.equal(text, `${JSON.stringify(codes, null, 2)}\n`, 'the fixture is written as JSON.stringify(…, null, 2)');
});

test('SDK codes: each category holds in the plugin\'s retry policy and page outcome, over the bundle\'s own error classes', () => {
  const failures = [];
  const expect = (code, what, actual, wanted) => { if (actual !== wanted) failures.push(`${code}: ${what} is ${actual}, expected ${wanted}`); };
  for (const [code, category] of Object.entries(fixture())) {
    const make = () => new SdkError(code, `the SDK refused (${code})`);
    switch (category) {
      case 'connection':
        expect(code, 'a 503 is never run again', judgeFailure(unavailable()).never, false);
        expect(code, 'a 400 is never run again', judgeFailure(badRequest()).never, true);
        break;
      case 'outcome-unknown':
        for (const cause of [unavailable(), reset()]) expect(code, `over ${cause.message}, never run again`, judgeFailure(over(make(), cause)).never, true);
        expect(code, 'alone, never run again', judgeFailure(make()).never, true);
        break;
      case 'outcome-unknown-unresolved':
      case 'typed':
      case 'page-pre-write':
        expect(code, 'alone, never run again', judgeFailure(make()).never, true);
        for (const cause of [unavailable(), reset()]) expect(code, `over ${cause.message}, never run again`, judgeFailure(over(make(), cause)).never, false);
        expect(code, 'over a 400, never run again', judgeFailure(over(make(), badRequest())).never, true);
        if (category === 'page-pre-write') expect(code, 'a page push it refuses wrote', writeOutcome(make()), 'nothing');
        break;
      case 'wraps-failure':
        if (code === 'WEB_RESOURCE_UNVERIFIED') {
          // A web resource whose published content could not be confirmed: with no failure behind it, a run again writes it again by id.
          expect(code, 'alone, never run again', judgeFailure(make()).never, false);
          expect(code, 'over a 400, never run again', judgeFailure(over(make(), badRequest())).never, true);
        } else if (code === 'ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED') {
          // The SDK's own sentence around the publish it could not make (lib/retry-policy.js, WRAPPER_SENTENCE): what it embeds decides.
          const wrapped = (inner) => new SdkError(code, `enrichDefaultViews: 2 view(s) on 'contoso_task' were saved but the publish FAILED, so none of them is live (${inner}). Re-publish the entity to make them visible; the saves themselves are unaffected.`);
          expect(code, 'around a 503, never run again', judgeFailure(wrapped('HTTP 503 from https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml: Service Unavailable')).never, false);
          expect(code, 'around a 400, never run again', judgeFailure(wrapped('HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml: Bad Request')).never, true);
        } else {
          failures.push(`${code}: a wrapper this test does not know how to exercise — add its case`);
        }
        break;
      case 'diagnostic':
        break;
      default:
        failures.push(`${code}: unknown category ${category}`);
    }
  }
  assert.deepEqual(failures, [], `The plugin's handling of these codes is not what fixtures/sdk-error-codes.json says:\n${failures.join('\n')}`);
});

// The guard of the guard: the scan sees a code in each form the bundle raises one, leaves enum names and constant names out, and the
// drift message names a new and a removed code with the plugin files that name it — so the check can never pass because it sees nothing.
test('SDK codes (meta): the scan finds a code in every form the bundle raises one, and the drift message names what moved', () => {
  const codes = codesIn(fs.readFileSync(BUNDLE, 'utf8'));
  for (const code of [
    'VERSION_CONFLICT', // super("VERSION_CONFLICT", …) in a subclass
    'APP_UPDATE_OUTCOME_UNKNOWN', // new X.SdkError("APP_UPDATE_OUTCOME_UNKNOWN", …)
    'COMMAND_IMMUTABLE_COLUMN_CHANGED', // a constant: X.COMMAND_IMMUTABLE_COLUMN_CHANGED_CODE = "COMMAND_IMMUTABLE_COLUMN_CHANGED"
    'ARTIFACT_ALREADY_EXISTS', // a push result by value: { code: "ARTIFACT_ALREADY_EXISTS", … }
    'PREVIEW_APP_PIN_GUARD_NOT_EVALUATED', // a warning: warn("PREVIEW_APP_PIN_GUARD_NOT_EVALUATED", …)
  ]) assert.ok(codes.has(code), `the scan finds ${code}`);
  assert.equal(codes.has('TWO_COLUMN'), false, 'an enum member name is not a code');
  assert.equal(codes.has('COMMAND_IMMUTABLE_COLUMN_CHANGED_CODE'), false, 'a constant\'s name is not a code');
  // Negative controls: only an OCCURRENCE that is provably not a code is left out — never a value because of how it is spelled.
  assert.deepEqual([...codesIn('throw new SdkError("INVALID_ERROR_CODE", "bad")')], ['INVALID_ERROR_CODE'], 'a code that ends in _CODE is a code');
  assert.deepEqual([...codesIn('e[e.TWO_COLUMN=1]="TWO_COLUMN";throw new SdkError("TWO_COLUMN", "bad")')], ['TWO_COLUMN'], 'a code that is also an enum member name is a code');
  assert.deepEqual([...codesIn('(function(e){e[e.ONE_COLUMN=0]="ONE_COLUMN"})(x)')], [], 'an enum reverse mapping alone is not');
  assert.deepEqual([...codesIn('Object.defineProperty(t,"FOO_UNREADABLE_CODE",{enumerable:!0,get:function(){return r.FOO_UNREADABLE_CODE}});r.FOO_UNREADABLE_CODE="FOO_UNREADABLE"')], ['FOO_UNREADABLE'], 'an export\'s property name is not a code; the constant\'s value is');
  const mentions = new Map([['OLD_CODE', new Set(['lib/sdk-build.js'])]]);
  const drift = describeCodeDrift(new Set(['KEPT', 'NEW_CODE']), { KEPT: 'typed', OLD_CODE: 'typed' }, mentions);
  assert.match(drift, /does not classify:\n {2}NEW_CODE\n/);
  assert.match(drift, /no longer has 1 code\(s\)[^\n]*\n {2}OLD_CODE — still named by lib\/sdk-build\.js/);
  assert.equal(describeCodeDrift(new Set(['KEPT']), { KEPT: 'typed' }, mentions), '');
});
