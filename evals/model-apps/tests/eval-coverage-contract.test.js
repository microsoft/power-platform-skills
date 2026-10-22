'use strict';

// Cross-runner eval coverage contract.
//
// Every eval runner reports an assertion it has no check for as SKIP, and a SKIP never fails a run.
// So a new expectation in evals.json, a prompt nobody captured, or a check that skips on every
// fixture all leave CI green while verifying nothing. This contract turns each of those into an
// explicit, committed decision: eval-coverage-baseline.json records today's gaps, and every list in
// it is a ratchet. A new gap fails here until it is closed or recorded; a closed gap (a prompt now
// captured, an expectation now checked, a check that now grades) fails until its entry is removed.
//
// It also pins what the guides state (prompt, fixture and tier counts, the prompts with no fixture,
// the app-builder fixture table) to the registries, and the entity-log file name the genpage loader
// reads to the one the /genpage skill writes.
//
// It grades through the runners' own exports (gradeFixture, getExpectationCheck and the routing
// predicates), so it sees exactly what the runners report rather than a copy of their routing.
//
// Each rule is a pure function returning a list of problems; the last tests feed each one a broken
// input to prove it can fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EVALS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(EVALS_ROOT, '..', '..');
const GENPAGE = path.join(EVALS_ROOT, 'genpage');
const APP_BUILDER = path.join(EVALS_ROOT, 'app-builder');
const PLUGIN = path.join(REPO_ROOT, 'plugins', 'model-apps');

const layer1 = require('../genpage/run-layer-1.js');
const layer2 = require('../genpage/run-layer-2.js');
const appBuilder = require('../app-builder/run-app-builder.js');
const { WORKFLOW_ASSERTIONS } = require('../genpage/lib/assertions-layer-1.js');
const { ASSERTIONS: CODE_ASSERTIONS } = require('../genpage/lib/assertions-layer-2.js');
const { ASSERTIONS: STAGE_ASSERTIONS } = require('../app-builder/lib/assertions.js');
const genpageLoader = require('../genpage/lib/fixture-loader.js');
const appBuilderLoader = require('../app-builder/lib/fixture-loader.js');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readText = (file) => fs.readFileSync(file, 'utf8');

const genpageData = readJson(path.join(GENPAGE, 'evals.json'));
const appBuilderData = readJson(path.join(APP_BUILDER, 'evals.json'));
const baseline = readJson(path.join(__dirname, 'eval-coverage-baseline.json'));
const genpageFixtures = genpageLoader.loadFixtures(path.join(GENPAGE, 'fixtures'));
const appBuilderFixtures = appBuilderLoader.loadFixtures(path.join(APP_BUILDER, 'fixtures'));

const STATUSES = new Set(['deferred', 'manual']);
const pairKey = (...parts) => parts.map((p) => (p === null ? '' : String(p))).join('\u0000');
const hasGenpageCheck = (text) => Boolean(layer1.getExpectationCheck(text) || layer2.getExpectationCheck(text));
const sortedNumbers = (values) => [...values].sort((a, b) => a - b);
const report = (problems) => `\n  - ${problems.join('\n  - ')}`;

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

// Every registered prompt has a fixture or a recorded reason why not; every fixture has a prompt.
function uncapturedProblems({ evals, fixtureIds, uncaptured }) {
  const problems = [];
  const evalIds = new Set(evals.map((e) => e.id));
  for (const id of fixtureIds) {
    if (!evalIds.has(id)) problems.push(`a fixture is filed under eval ${id}, which evals.json does not define`);
  }
  const listed = new Set();
  for (const entry of uncaptured) {
    if (listed.has(entry.eval)) problems.push(`uncaptured lists eval ${entry.eval} twice`);
    listed.add(entry.eval);
    if (!evalIds.has(entry.eval)) problems.push(`uncaptured lists eval ${entry.eval}, which evals.json no longer defines — remove it`);
    else if (fixtureIds.has(entry.eval)) problems.push(`eval ${entry.eval} now has a fixture — remove it from uncaptured`);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`uncaptured eval ${entry.eval} needs a reason`);
  }
  for (const id of evalIds) {
    if (!fixtureIds.has(id) && !listed.has(id)) {
      problems.push(`eval ${id} has no fixture, so no runner grades it — capture one, or list it in uncaptured with a reason`);
    }
  }
  return problems;
}

// A per-eval expectation neither runner routes is dropped without even a SKIP line.
function unroutedProblems(evals, { isPhaseExpectation, isPhase5Expectation }) {
  return evals.flatMap((ev) => ev.expectations
    .filter((text) => !isPhaseExpectation(text) && !isPhase5Expectation(text))
    .map((text) => `eval ${ev.id}: neither runner routes "${text}", so it is dropped without even a SKIP — start it with its "Phase N" or "Edit Phase N"`));
}

// A common assertion with no check is a SKIP on every fixture of the corpus.
function unregisteredCommonProblems(data, { workflow, code }) {
  return [
    ...data.common_workflow_assertions.filter((text) => !workflow.has(text))
      .map((text) => `common workflow assertion has no check in WORKFLOW_ASSERTIONS: "${text}"`),
    ...data.common_code_assertions.filter((text) => !code.has(text))
      .map((text) => `common code assertion has no check in ASSERTIONS: "${text}"`),
  ];
}

// Every per-eval expectation is checked, or recorded as deferred or manual.
function unscoredProblems({ evals, hasCheck, unscored }) {
  const problems = [];
  const expectations = new Map();
  for (const ev of evals) for (const text of ev.expectations) expectations.set(pairKey(ev.id, text), { id: ev.id, text });
  const listed = new Set();
  for (const entry of unscored) {
    const key = pairKey(entry.eval, entry.text);
    const label = `eval ${entry.eval} "${entry.text}"`;
    if (listed.has(key)) problems.push(`unscored lists ${label} twice`);
    listed.add(key);
    if (!STATUSES.has(entry.status)) problems.push(`unscored ${label}: status must be "deferred" or "manual", got ${JSON.stringify(entry.status)}`);
    if (!expectations.has(key)) problems.push(`unscored ${label} is no longer in evals.json — remove it`);
    else if (hasCheck(entry.text)) problems.push(`${label} now has a check — remove it from unscored`);
  }
  for (const [key, { id, text }] of expectations) {
    if (!hasCheck(text) && !listed.has(key)) {
      problems.push(`eval ${id}: no check is registered for "${text}", so it only ever reports SKIP — register one, or list it in unscored as deferred or manual`);
    }
  }
  return problems;
}

// Every registered check grades at least one fixture, or is recorded with the reason it cannot yet.
// `observed` maps pairKey(runner, eval|null, text) to { runner, eval, text, statuses, reasons }.
function neverGradedProblems({ observed, neverGraded }) {
  const problems = [];
  const onlySkips = (seen) => seen.statuses.size === 1 && seen.statuses.has('skip');
  const describe = (e) => `${e.runner} ${e.eval === null ? 'common assertion' : `eval ${e.eval}`} "${e.text}"`;
  const listed = new Set();
  for (const entry of neverGraded) {
    const key = pairKey(entry.runner, entry.eval, entry.text);
    if (listed.has(key)) problems.push(`neverGraded lists ${describe(entry)} twice`);
    listed.add(key);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`neverGraded ${describe(entry)} needs a reason`);
    const seen = observed.get(key);
    if (!seen) problems.push(`neverGraded ${describe(entry)} no longer runs on any fixture — remove it`);
    else if (!onlySkips(seen)) problems.push(`${describe(entry)} now grades a fixture — remove it from neverGraded`);
  }
  for (const [key, seen] of observed) {
    if (onlySkips(seen) && !listed.has(key)) {
      problems.push(`${describe(seen)} returns SKIP on every fixture it runs on (${[...seen.reasons].join('; ')}), so it verifies nothing — make it grade a fixture, or list it in neverGraded with that reason`);
    }
  }
  return problems;
}

// The loader reads the entity log under the name the skill writes, and evals.json asks for that name.
function entityLogNameProblems({ docs, loaderName, legacyName, evalTexts }) {
  const problems = [];
  const LOG_NAME = /[A-Za-z0-9_-]*entity-creation-log\.md/g;
  const named = new Set(docs.flatMap(({ text }) => [...text.matchAll(LOG_NAME)].map((m) => m[0])));
  if (named.size !== 1 || !named.has(loaderName)) {
    problems.push(`the /genpage skill names the entity log ${JSON.stringify([...named])}, but the eval loader reads "${loaderName}"`);
  }
  if (legacyName === loaderName) problems.push('the legacy entity-log alias must differ from the current name');
  for (const text of evalTexts) {
    for (const m of text.matchAll(LOG_NAME)) {
      if (m[0] !== loaderName) problems.push(`evals.json asks for "${m[0]}" instead of "${loaderName}": "${text}"`);
    }
  }
  return problems;
}

// `**none**` is how a guide says the list is empty (every prompt captured); the regexes need a token
// there, since `**` directly followed by `**` would read as bold markup rather than an empty list.
function parseIdList(text) {
  if (/^\s*none\s*$/i.test(text)) return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean).flatMap((part) => {
    const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part);
    if (!range) return [Number(part)];
    const out = [];
    for (let n = Number(range[1]); n <= Number(range[2]); n += 1) out.push(n);
    return out;
  });
}

// What the genpage corpus actually holds, computed from evals.json and the fixture loader.
function genpageCorpusFacts(data, fixtures) {
  const fixtureIds = new Set(fixtures.map((f) => f.id));
  const tierOf = new Map(data.evals.map((e) => [e.id, e.tier]));
  const tiers = {};
  for (const tier of ['smoke', 'full', 'stress']) {
    tiers[tier] = {
      ids: sortedNumbers(data.evals.filter((e) => e.tier === tier).map((e) => e.id)),
      fixtures: fixtures.filter((f) => tierOf.get(f.id) === tier).length,
    };
  }
  return {
    workflowCount: data.common_workflow_assertions.length,
    codeCount: data.common_code_assertions.length,
    promptCount: data.evals.length,
    fixtureDirs: fixtures.length,
    tsxFiles: fixtures.reduce((n, f) => n + f.files.length, 0),
    representedIds: fixtureIds.size,
    missingIds: sortedNumbers(data.evals.filter((e) => !fixtureIds.has(e.id)).map((e) => e.id)),
    tiers,
  };
}

// The figures genpage/EVAL_GUIDE.md states. A sentence that cannot be found is itself a problem:
// rewording one must update this contract, never silently drop the check.
function genpageGuideProblems(guide, facts) {
  const problems = [];
  const expect = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) problems.push(`EVAL_GUIDE.md ${label}: says ${JSON.stringify(actual)}, actual ${JSON.stringify(wanted)}`);
  };
  const find = (label, re) => {
    const m = re.exec(guide);
    if (!m) problems.push(`EVAL_GUIDE.md: could not find ${label} — update the guide or this contract`);
    return m;
  };
  let m = find('the common_workflow_assertions count', /`common_workflow_assertions`:\s*\*\*(\d+)\*\*/);
  if (m) expect('common_workflow_assertions count', Number(m[1]), facts.workflowCount);
  m = find('the common_code_assertions count', /`common_code_assertions`:\s*\*\*(\d+)\*\*/);
  if (m) expect('common_code_assertions count', Number(m[1]), facts.codeCount);
  m = find('the prompt definition count', /`evals`:\s*\*\*(\d+)\*\*\s+prompt definitions/);
  if (m) expect('prompt definition count', Number(m[1]), facts.promptCount);
  m = find('the corpus sentence', /\*\*(\d+) fixture directories \/ (\d+) top-level TSX files\*\*,\s+representing (\d+) prompt IDs\.\s+IDs \*\*(none|[\d,\s]+)\*\* have no fixture/);
  if (m) {
    expect('fixture directory count', Number(m[1]), facts.fixtureDirs);
    expect('top-level TSX count', Number(m[2]), facts.tsxFiles);
    expect('represented prompt IDs', Number(m[3]), facts.representedIds);
    expect('prompt IDs with no fixture', parseIdList(m[4]), facts.missingIds);
  }
  for (const tier of ['smoke', 'full', 'stress']) {
    const row = find(`the ${tier} row of the tier table`, new RegExp(`^\\|\\s*\`${tier}\`\\s*\\|\\s*(\\d+)\\s*\\|[^|\\r\\n]*\\|\\s*([^|\\r\\n]+?)\\s*\\|\\s*$`, 'm'));
    if (row) {
      expect(`${tier} tier count`, Number(row[1]), facts.tiers[tier].ids.length);
      expect(`${tier} tier eval IDs`, sortedNumbers(parseIdList(row[2])), facts.tiers[tier].ids);
    }
    const filter = find(`the --tier ${tier} example`, new RegExp(`run-layer-1\\.js --tier ${tier}\\s+#\\s*(\\d+) stored fixtures?[^,\\r\\n]*,\\s*(\\d+) prompt definitions?`));
    if (filter) {
      expect(`--tier ${tier} stored fixtures`, Number(filter[1]), facts.tiers[tier].fixtures);
      expect(`--tier ${tier} prompt definitions`, Number(filter[2]), facts.tiers[tier].ids.length);
    }
  }
  return problems;
}

function genpageReadmeProblems(readme, facts) {
  const problems = [];
  const counts = /\*\*(\d+) fixtures, (\d+) top-level TSX files and (\d+) represented\s+prompt IDs\*\*/.exec(readme);
  if (!counts) problems.push('fixtures/README.md: could not find the fixture count sentence — update the README or this contract');
  else {
    const said = counts.slice(1, 4).map(Number);
    const actual = [facts.fixtureDirs, facts.tsxFiles, facts.representedIds];
    if (JSON.stringify(said) !== JSON.stringify(actual)) problems.push(`fixtures/README.md counts: says ${JSON.stringify(said)}, actual ${JSON.stringify(actual)}`);
  }
  const missing = /Registered prompts with no fixture:\s*\*\*(none|[\d,\s]+)\*\*/.exec(readme);
  if (!missing) problems.push('fixtures/README.md: could not find the prompts with no fixture — update the README or this contract');
  else if (JSON.stringify(parseIdList(missing[1])) !== JSON.stringify(facts.missingIds)) {
    problems.push(`fixtures/README.md prompts with no fixture: says ${missing[1].trim()}, actual ${facts.missingIds.join(', ')}`);
  }
  return problems;
}

// Every app-builder fixture has exactly one row in the guide's fixture table, and nothing else does.
function appBuilderGuideProblems(guide, dirNames) {
  const rows = [...guide.matchAll(/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[2]);
  const problems = [];
  for (const dir of dirNames) {
    const n = rows.filter((r) => r === dir).length;
    if (n !== 1) problems.push(`app-builder EVAL_GUIDE.md fixture table lists \`${dir}\` ${n} times, expected once`);
  }
  for (const row of rows) if (!dirNames.includes(row)) problems.push(`app-builder EVAL_GUIDE.md fixture table lists \`${row}\`, which is not a fixture`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Observations: what the runners actually report, per (runner, eval, text)
// ---------------------------------------------------------------------------------------------

function observe(observed, runner, evalId, text, result) {
  const key = pairKey(runner, evalId, text);
  if (!observed.has(key)) observed.set(key, { runner, eval: evalId, text, statuses: new Set(), reasons: new Set() });
  const seen = observed.get(key);
  seen.statuses.add(result.status);
  if (result.status === 'skip') seen.reasons.add(result.reason);
}

// Registered checks only: an unregistered text is unscoredProblems' or unregisteredCommonProblems' concern.
function observeGenpage() {
  const observed = new Map();
  const evalById = new Map(genpageData.evals.map((e) => [e.id, e]));
  const runners = [
    ['layer-1', layer1, WORKFLOW_ASSERTIONS],
    ['layer-2', layer2, CODE_ASSERTIONS],
  ];
  for (const fix of genpageFixtures) {
    for (const [name, runner, common] of runners) {
      for (const { kind, text, result } of runner.gradeFixture(fix, evalById.get(fix.id), genpageData)) {
        if (kind === 'common' && common.has(text)) observe(observed, name, null, text, result);
        if (kind === 'expectation' && runner.getExpectationCheck(text)) observe(observed, name, fix.id, text, result);
      }
    }
  }
  return observed;
}

async function observeAppBuilder() {
  const observed = new Map();
  const evalById = new Map(appBuilderData.evals.map((e) => [e.id, e]));
  for (const fix of appBuilderFixtures) {
    const { results } = await appBuilder.gradeFixture(fix, evalById.get(fix.id), appBuilderData);
    for (const { kind, text, result } of results) {
      if (kind === 'gate' || !STAGE_ASSERTIONS.has(text)) continue;
      observe(observed, 'app-builder', kind === 'common' ? null : fix.id, text, result);
    }
  }
  return observed;
}

function genpageSkillDocs() {
  const dirs = [path.join(PLUGIN, 'skills', 'genpage'), path.join(PLUGIN, 'agents')];
  const docs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && (!full.includes(`${path.sep}agents${path.sep}`) || entry.name.startsWith('genpage-'))) {
        docs.push({ file: path.relative(REPO_ROOT, full), text: readText(full) });
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return docs;
}

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

test('every genpage prompt has a fixture or a recorded reason, and every fixture a prompt', () => {
  const problems = uncapturedProblems({
    evals: genpageData.evals,
    fixtureIds: new Set(genpageFixtures.map((f) => f.id)),
    uncaptured: baseline.genpage.uncaptured,
  });
  const historical = Object.keys(readJson(path.join(GENPAGE, 'fixtures', 'contracts.json')));
  const dirs = new Set(genpageFixtures.map((f) => f.dirName));
  for (const dir of historical) if (!dirs.has(dir)) problems.push(`fixtures/contracts.json labels "${dir}", which is not a fixture`);
  assert.deepEqual(problems, [], report(problems));
});

test('every genpage expectation is routed, and every common assertion has a check', () => {
  const problems = [
    ...unroutedProblems(genpageData.evals, { isPhaseExpectation: layer1.isPhaseExpectation, isPhase5Expectation: layer2.isPhase5Expectation }),
    ...unregisteredCommonProblems(genpageData, { workflow: WORKFLOW_ASSERTIONS, code: CODE_ASSERTIONS }),
  ];
  assert.deepEqual(problems, [], report(problems));
});

test('every genpage expectation is checked, or recorded as deferred or manual', () => {
  const problems = unscoredProblems({ evals: genpageData.evals, hasCheck: hasGenpageCheck, unscored: baseline.genpage.unscored });
  assert.deepEqual(problems, [], report(problems));
});

test('every registered check grades a fixture, or is recorded with the reason it cannot yet', async () => {
  const problems = [
    ...neverGradedProblems({ observed: observeGenpage(), neverGraded: baseline.genpage.neverGraded }),
    ...neverGradedProblems({ observed: await observeAppBuilder(), neverGraded: baseline.appBuilder.neverGraded }),
  ];
  assert.deepEqual(problems, [], report(problems));
});

test('the eval loader reads the entity log under the name the /genpage skill writes', () => {
  const docs = genpageSkillDocs();
  assert.ok(docs.length > 0, 'found the /genpage skill and agent docs');
  const problems = entityLogNameProblems({
    docs,
    loaderName: genpageLoader.ENTITY_CREATION_LOG,
    legacyName: genpageLoader.LEGACY_ENTITY_CREATION_LOG,
    evalTexts: [...genpageData.common_workflow_assertions, ...genpageData.common_code_assertions, ...genpageData.evals.flatMap((e) => e.expectations)],
  });
  assert.deepEqual(problems, [], report(problems));
});

test('the eval guides state the corpus as it is', () => {
  const facts = genpageCorpusFacts(genpageData, genpageFixtures);
  const problems = [
    ...genpageGuideProblems(readText(path.join(GENPAGE, 'EVAL_GUIDE.md')), facts),
    ...genpageReadmeProblems(readText(path.join(GENPAGE, 'fixtures', 'README.md')), facts),
    ...appBuilderGuideProblems(readText(path.join(APP_BUILDER, 'EVAL_GUIDE.md')), appBuilderFixtures.map((f) => f.dirName)),
  ];
  assert.deepEqual(problems, [], report(problems));
});

// ---------------------------------------------------------------------------------------------
// Negative controls: each rule reports the drift it exists to catch
// ---------------------------------------------------------------------------------------------

test('negative controls: prompt, routing and registration drift is reported', () => {
  const fixtureIds = new Set(genpageFixtures.map((f) => f.id));
  const uncaptured = baseline.genpage.uncaptured;
  // A synthetic prompt with no fixture, so these controls keep working when every real prompt is
  // captured and the baseline's uncaptured list is empty.
  const evalsPlus = [...genpageData.evals, { id: 9997, tier: 'full', prompt: 'x', expectations: [] }];
  const first = { eval: 9997, reason: 'not captured yet' };
  assert.match(uncapturedProblems({ evals: evalsPlus, fixtureIds, uncaptured }).join('\n'), /eval 9997 has no fixture/);
  assert.match(uncapturedProblems({ evals: evalsPlus, fixtureIds: new Set([...fixtureIds, first.eval]), uncaptured: [...uncaptured, first] }).join('\n'), /now has a fixture/);
  assert.match(uncapturedProblems({ evals: genpageData.evals, fixtureIds, uncaptured: [...uncaptured, { eval: 9999, reason: 'x' }] }).join('\n'), /no longer defines/);
  assert.match(uncapturedProblems({ evals: evalsPlus, fixtureIds, uncaptured: [...uncaptured, { ...first, reason: ' ' }] }).join('\n'), /needs a reason/);
  assert.match(uncapturedProblems({ evals: genpageData.evals, fixtureIds: new Set([...fixtureIds, 9998]), uncaptured }).join('\n'), /eval 9998, which evals.json does not define/);

  const evals = structuredClone(genpageData.evals);
  evals[0].expectations.push('Verify: a requirement written without its phase');
  assert.match(unroutedProblems(evals, { isPhaseExpectation: layer1.isPhaseExpectation, isPhase5Expectation: layer2.isPhase5Expectation }).join('\n'), /neither runner routes "Verify: a requirement/);

  const data = structuredClone(genpageData);
  data.common_workflow_assertions.push('An unregistered common workflow assertion');
  data.common_code_assertions.push('An unregistered common code assertion');
  const common = unregisteredCommonProblems(data, { workflow: WORKFLOW_ASSERTIONS, code: CODE_ASSERTIONS });
  assert.equal(common.length, 2, report(common));
});

test('negative controls: expectation and grading drift is reported', () => {
  const unscored = baseline.genpage.unscored;
  const evals = structuredClone(genpageData.evals);
  evals[0].expectations.push('Phase 1 (Planner): a new requirement nobody checks');
  assert.match(unscoredProblems({ evals, hasCheck: hasGenpageCheck, unscored }).join('\n'), /no check is registered for "Phase 1 \(Planner\): a new requirement/);
  const [first] = unscored;
  assert.match(unscoredProblems({ evals: genpageData.evals, hasCheck: (t) => t === first.text || hasGenpageCheck(t), unscored }).join('\n'), /now has a check/);
  assert.match(unscoredProblems({ evals: genpageData.evals, hasCheck: hasGenpageCheck, unscored: [{ ...first, status: 'later' }, ...unscored.slice(1)] }).join('\n'), /status must be/);
  assert.match(unscoredProblems({ evals: genpageData.evals, hasCheck: hasGenpageCheck, unscored: [...unscored, { eval: first.eval, status: 'deferred', text: 'Phase 1: gone' }] }).join('\n'), /no longer in evals.json/);
  assert.match(unscoredProblems({ evals: genpageData.evals, hasCheck: hasGenpageCheck, unscored: [...unscored, first] }).join('\n'), /twice/);

  const observed = observeGenpage();
  const neverGraded = baseline.genpage.neverGraded;
  assert.ok(neverGraded.length > 0, 'the controls below need a recorded entry');
  const entry = neverGraded[0];
  const key = pairKey(entry.runner, entry.eval, entry.text);
  const graded = new Map(observed);
  graded.set(key, { ...observed.get(key), statuses: new Set(['skip', 'pass']) });
  assert.match(neverGradedProblems({ observed: graded, neverGraded }).join('\n'), /now grades a fixture/);
  const gone = new Map(observed);
  gone.delete(key);
  assert.match(neverGradedProblems({ observed: gone, neverGraded }).join('\n'), /no longer runs on any fixture/);
  const skipping = new Map(observed);
  skipping.set(pairKey('layer-2', 1, 'Phase 5: a new placeholder'), { runner: 'layer-2', eval: 1, text: 'Phase 5: a new placeholder', statuses: new Set(['skip']), reasons: new Set(['needs AST analysis']) });
  assert.match(neverGradedProblems({ observed: skipping, neverGraded }).join('\n'), /returns SKIP on every fixture it runs on \(needs AST analysis\)/);
  assert.match(neverGradedProblems({ observed, neverGraded: [{ ...entry, reason: '' }, ...neverGraded.slice(1)] }).join('\n'), /needs a reason/);
});

test('negative controls: entity-log and guide drift is reported', () => {
  const current = genpageLoader.ENTITY_CREATION_LOG;
  const legacy = genpageLoader.LEGACY_ENTITY_CREATION_LOG;
  const docs = [{ file: 'SKILL.md', text: `writes ${current}` }];
  assert.deepEqual(entityLogNameProblems({ docs, loaderName: current, legacyName: legacy, evalTexts: [`reads ${current}`] }), []);
  assert.match(entityLogNameProblems({ docs: [{ file: 'SKILL.md', text: 'writes renamed-entity-creation-log.md' }], loaderName: current, legacyName: legacy, evalTexts: [] }).join('\n'), /eval loader reads/);
  assert.match(entityLogNameProblems({ docs, loaderName: current, legacyName: legacy, evalTexts: [`reads ${legacy}`] }).join('\n'), /evals.json asks for "entity-creation-log.md"/);
  assert.match(entityLogNameProblems({ docs, loaderName: current, legacyName: current, evalTexts: [] }).join('\n'), /must differ/);

  const facts = genpageCorpusFacts(genpageData, genpageFixtures);
  const guide = readText(path.join(GENPAGE, 'EVAL_GUIDE.md'));
  assert.match(genpageGuideProblems(guide.replace(/(`evals`:\s*\*\*)\d+/, '$1999'), facts).join('\n'), /prompt definition count: says 999/);
  assert.match(genpageGuideProblems(guide.replace(/^\|\s*`stress`.*$/m, ''), facts).join('\n'), /could not find the stress row/);
  assert.match(genpageGuideProblems(guide, { ...facts, missingIds: [...facts.missingIds, 999] }).join('\n'), /prompt IDs with no fixture/);
  assert.match(genpageGuideProblems(guide, { ...facts, tiers: { ...facts.tiers, full: { ...facts.tiers.full, fixtures: facts.tiers.full.fixtures + 1 } } }).join('\n'), /--tier full stored fixtures/);
  const readme = readText(path.join(GENPAGE, 'fixtures', 'README.md'));
  assert.match(genpageReadmeProblems(readme, { ...facts, tsxFiles: facts.tsxFiles + 1 }).join('\n'), /counts: says/);
  assert.match(genpageReadmeProblems(readme, { ...facts, missingIds: [...facts.missingIds, 999] }).join('\n'), /prompts with no fixture: says/);

  const appGuide = readText(path.join(APP_BUILDER, 'EVAL_GUIDE.md'));
  const dirs = appBuilderFixtures.map((f) => f.dirName);
  assert.match(appBuilderGuideProblems(appGuide, [...dirs, '99-unlisted']).join('\n'), /lists `99-unlisted` 0 times/);
  assert.match(appBuilderGuideProblems(appGuide, dirs.slice(1)).join('\n'), new RegExp(`lists \`${dirs[0]}\`, which is not a fixture`));
  assert.deepEqual(parseIdList('4, 5, 18–21, 7-8'), [4, 5, 18, 19, 20, 21, 7, 8]);
});
