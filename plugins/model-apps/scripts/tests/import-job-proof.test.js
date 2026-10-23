'use strict';
// lib/import-job-proof.js — what the job of an import the platform REFUSED to start proves about whether that import applied anything.
//
// The platform answers an import that meets another import or a publish with HTTP 429 and 0x80071151, "Cannot start another [Import] because there is a previous [Import] running …". Measured on a
// Public-cloud environment, the refused send's `importjobs(<id>)` is then one of two things: it never exists (the refusal came at the first lock check), or it exists and is final by the time the answer
// arrives (two imports started together: the refusal came at the second check) — a finished row whose log says the import failed with that error, with the solution manifest and every component
// left unprocessed. Only the first row and the 404 prove that a second send cannot meet a first that applied something; the rest (a job still running, an import that failed AFTER it began, a log
// that is not what it should be) prove nothing and the import is not sent again. These tests hold the rule to the 347 states the measurement captured (helpers/import-job-logs.js makes a twin of
// each kind of state — made up, not copied) and to every clause of it, one at a time, so that a clause that is dropped or loosened fails here.
const test = require('node:test');
const assert = require('node:assert');
const {
  refusedBeforeAnyComponent, proveRefusedImport, MAX_JOB_LOG_CHARS, CONCURRENCY_ERRORCODE, PROOF_ABSENT, PROOF_LOG,
} = require('../lib/import-job-proof.js');
const { importLog, LOGS, jobRow, rootOf, CAPTURED_STATES, LOCK_ERRORCODE, REFUSAL_STATUS } = require('./helpers/import-job-logs.js');

const refused = (options) => LOGS.refused(options);
// `rootOf` gives the root a `processed="true"` of its own unless told another; a root with no mark at all is made by taking it out.
const withoutMark = (root) => { const copy = { ...root }; delete copy.processed; return copy; };
const verdictOf = (data, row) => refusedBeforeAnyComponent(jobRow(data, row));
const assertProven = (data, what, row) => assert.deepStrictEqual(verdictOf(data, row), { proven: true }, what);
const assertNot = (data, why, what, row) => {
  const verdict = verdictOf(data, row);
  assert.strictEqual(verdict.proven, false, `${what}: not proven`);
  assert.strictEqual(verdict.why, why, `${what}: ${verdict.reason}`);
  assert.strictEqual(typeof verdict.reason, 'string');
  return verdict;
};

test('the error code the rule looks for is 0x80071151 as the signed 32-bit integer the platform writes in a log, and a log is read up to 8 MiB', () => {
  assert.strictEqual(CONCURRENCY_ERRORCODE, '-2147020463');
  assert.strictEqual(CONCURRENCY_ERRORCODE, String(0x80071151 | 0));
  assert.strictEqual(LOCK_ERRORCODE, CONCURRENCY_ERRORCODE, 'the twins the tests are made of use the same code');
  assert.strictEqual(MAX_JOB_LOG_CHARS, 8 * 1024 * 1024);
});

// --- the 347 states ------------------------------------------------------------------------------------------------------------------------

test('the 347 job-row states the measurement captured: the rule accepts exactly the 8 final rows of refused imports and none of the other 339', () => {
  const tally = {};
  let states = 0;
  let proven = 0;
  for (const state of CAPTURED_STATES) {
    const row = jobRow(state.data(), { completed: state.completed });
    const verdict = refusedBeforeAnyComponent(row);
    assert.strictEqual(verdict.proven, state.group === 'refused-final', `${state.name}: ${JSON.stringify(verdict)}`);
    // The same verdict through the answer of the read (HTTP 200), which is what the script has in hand.
    assert.deepStrictEqual(proveRefusedImport({ status: 200, body: row }), verdict.proven ? { proven: true, proof: PROOF_LOG } : verdict, state.name);
    states += state.count;
    if (verdict.proven) proven += state.count;
    tally[state.group] = tally[state.group] || { states: 0, proven: 0 };
    tally[state.group].states += state.count;
    if (verdict.proven) tally[state.group].proven += state.count;
  }
  assert.deepStrictEqual({ states, proven, notProven: states - proven }, { states: 347, proven: 8, notProven: 339 });
  assert.deepStrictEqual(tally, {
    'running-or-early-success': { states: 308, proven: 0 },
    'success-final': { states: 17, proven: 0 },
    'refused-early': { states: 9, proven: 0 },
    'failed-after-start': { states: 5, proven: 0 },
    'refused-final': { states: 8, proven: 8 },
  });
});

test('every state that is not the final row of a refused import says WHY in the first clause of the rule it fails — a running import is "not finished", an import that applied the package "does not say it failed", one that failed after it began "another error"', () => {
  const why = (data, row) => verdictOf(data, row).why;
  assert.strictEqual(why(LOGS.running(), { completed: false }), 'unfinished');
  assert.strictEqual(why(LOGS.running(), { completed: true }), 'not-a-failure', 'a skeleton whose row is complete says nothing of failing');
  assert.strictEqual(why(LOGS.succeeded()), 'not-a-failure');
  assert.strictEqual(why(LOGS.unfinishedRoot()), 'not-a-failure', 'a row complete before its root has its verdict (completedon set, no succeeded, no errorcode)');
  assert.strictEqual(why(LOGS.unfinishedRoot({ manifest: 'true', components: 'true', finished: true })), 'not-a-failure');
  assert.strictEqual(why(LOGS.failedAfterStart()), 'other-error', 'an import that failed after it began failed with another error');
});

// --- every clause of the rule, one at a time --------------------------------------------------------------------------------------------

test('the rule accepts the final row of a refused import — and what it does not read does not matter: progress, solutionid, import context, the value of completedon, the root\'s own mark, the package\'s own checks, the size of the package', () => {
  assertProven(refused(), 'the row as measured');
  assertProven(refused({ tables: 1 }), 'a package of one table');
  assertProven(refused({ tables: 60 }), 'a package of sixty tables');
  assertProven(refused(), 'a first import of a solution that does not exist (a solutionid that names nothing)', { progress: 40, solutionid: '11111111-2222-3333-4444-555555555555', importcontext: 'ImportInstall' });
  assertProven(refused(), 'a running import passes through the same progress', { progress: 17.142857142857142, operationcontext: 'None' });
  assertProven(refused(), 'the value of completedon is not read: only that there is one', { completedon: '2001-02-03T04:05:06Z' });
  assertProven(importLog({ root: withoutMark(rootOf({ errorcode: LOCK_ERRORCODE, succeeded: 'failure', status: REFUSAL_STATUS })), manifest: 'false', components: 'false', handlers: 'true' }), 'the root\'s own `processed` is not read: it may be missing');
  assertProven(importLog({ root: rootOf({ errorcode: LOCK_ERRORCODE, succeeded: 'failure', status: REFUSAL_STATUS, processed: 'false' }), manifest: 'false', components: 'false', handlers: 'true' }), 'the root\'s own `processed` is not read: it may be false');
  assertProven(refused({ handlers: 'false' }), 'the package\'s own checks may be processed or not');
  assertProven(refused({ handlers: null }), 'and need not be there');
  assertProven(importLog({ root: rootOf({ errorcode: LOCK_ERRORCODE, succeeded: 'failure', status: undefined }), manifest: 'false', components: 'false', handlers: 'true' }), 'the root\'s words (status) are not read');
  assertProven(`\uFEFF<?xml version="1.0" encoding="utf-8"?>\n${refused()}\n`, 'a byte order mark and an XML declaration are no part of the document');
});

test('completedon: a job that is not finished proves nothing — null, missing, empty, white space, or not text — whatever its log says', () => {
  for (const [what, completedon] of [['null', null], ['empty', ''], ['white space', '  \t'], ['a number', 1], ['an object', {}], ['a boolean', true]]) {
    assertNot(refused(), 'unfinished', what, { completedon });
  }
  const noKey = jobRow(refused());
  delete noKey.completedon;
  assert.strictEqual(refusedBeforeAnyComponent(noKey).why, 'unfinished', 'a row with no completedon at all');
  assert.match(refusedBeforeAnyComponent(noKey).reason, /not finished \(completedon is empty\)/);
});

test('data: a row with no log, or one that is not text, proves nothing', () => {
  for (const [what, data] of [['null', null], ['missing', undefined], ['empty', ''], ['a number', 42], ['an object', { importexportxml: {} }], ['a list', [refused()]]]) {
    assertNot(data, 'no-log', what);
  }
  for (const [what, row] of [['null', null], ['undefined', undefined], ['a string', refused()], ['a number', 7], ['a list', [jobRow(refused())]], ['a function', () => jobRow(refused())]]) {
    const verdict = refusedBeforeAnyComponent(row);
    assert.deepStrictEqual([verdict.proven, verdict.why], [false, 'no-log'], `a row that is ${what}`);
  }
});

test('the root: it must be importexportxml, say succeeded="failure" exactly, and carry the error code -2147020463 exactly — each of them, by itself, is required', () => {
  const data = refused();
  assertNot(data.replace(/importexportxml/g, 'importexport'), 'not-an-import-log', 'another root element');
  assertNot(data.replace(/importexportxml/g, 'x:importexportxml'), 'not-an-import-log', 'a root with a namespace prefix is another name');
  assertNot(data.replace(/importexportxml/g, 'ImportExportXml'), 'not-an-import-log', 'XML is case-sensitive');
  for (const [what, replacement] of [
    ['success', 'succeeded="success"'], ['an empty value', 'succeeded=""'], ['another case', 'succeeded="Failure"'], ['white space around it', 'succeeded=" failure "'], ['a word that contains it', 'succeeded="failure!"'],
    ['the attribute missing', ''], ['the attribute under another name', 'Succeeded="failure"'],
  ]) {
    assertNot(data.replace('succeeded="failure"', replacement), 'not-a-failure', `succeeded: ${what}`);
  }
  const failedOtherwise = (replacement) => data.replace(`errorcode="${CONCURRENCY_ERRORCODE}"`, replacement);
  const hex = assertNot(failedOtherwise('errorcode="-2147188685"'), 'other-error', 'an import that failed after it began');
  assert.match(hex.reason, /failed with error 0x80048033, not with 0x80071151/, 'the code is shown the way the platform spells codes');
  assert.match(assertNot(failedOtherwise('errorcode="0"'), 'other-error', 'zero').reason, /failed with error 0x0, not with 0x80071151/);
  for (const [what, replacement] of [
    ['the lock code spelled in hex', 'errorcode="0x80071151"'], ['with a fraction', 'errorcode="-2147020463.0"'], ['with white space', 'errorcode=" -2147020463"'], ['as an unsigned number', 'errorcode="2147946833"'],
    ['with a plus sign', 'errorcode="+2147020463"'], ['with another digit', 'errorcode="-2147020462"'], ['with a text', 'errorcode="none"'], ['empty', 'errorcode=""'], ['missing', ''],
  ]) {
    const verdict = assertNot(failedOtherwise(replacement), 'other-error', `errorcode: ${what}`);
    assert.ok(!/NaN|undefined|none/.test(verdict.reason), `${what}: ${verdict.reason}`);
  }
  // A text from the platform is never in the reason: only a number that is one.
  assert.doesNotMatch(assertNot(failedOtherwise('errorcode="a secret: kv-secret-value"'), 'other-error', 'a text').reason, /secret|kv-/);
});

test('the solution manifest: there must be one, and EVERY one must be processed="false" exactly', () => {
  const data = refused();
  const manifest = 'LocalizedName="Contoso solution" processed="false"';
  assert.ok(data.includes(manifest));
  assertNot(data.replace(manifest, 'LocalizedName="Contoso solution" processed="true"'), 'manifest-processed', 'processed');
  for (const [what, replacement] of [['no mark', 'LocalizedName="Contoso solution"'], ['another case', 'LocalizedName="Contoso solution" processed="False"'], ['a number', 'LocalizedName="Contoso solution" processed="0"'], ['empty', 'LocalizedName="Contoso solution" processed=""']]) {
    assertNot(data.replace(manifest, replacement), 'manifest-unmarked', `solutionManifest: ${what}`);
  }
  assertNot(data.replace(/<solutionManifests>.*<\/solutionManifests>/, ''), 'no-manifest', 'no solutionManifests');
  assertNot(data.replace(/<solutionManifests>.*<\/solutionManifests>/, '<solutionManifests />'), 'no-manifest', 'an empty list');
  // A second manifest that was processed, beside the one that was not.
  assertNot(data.replace('</solutionManifests>', '<solutionManifest languagecode="1033" processed="true" /></solutionManifests>'), 'manifest-processed', 'one of two');
  assertNot(data.replace('</solutionManifests>', '<solutionManifest languagecode="1033" /></solutionManifests>'), 'manifest-unmarked', 'one of two, with no mark');
  assertProven(data.replace('</solutionManifests>', '<solutionManifest languagecode="1033" processed="false" /></solutionManifests>'), 'two manifests, both unprocessed');
  // The manifest as a node of another name is not one.
  assertNot(data.replace(/solutionManifest\b/g, 'SolutionManifest'), 'no-manifest', 'XML is case-sensitive');
});

test('the components: NO element but the root and the package\'s own checks may be processed — any element, whatever its name, with any value of `processed` but "false"', () => {
  // Every kind of component the log has, and one it has never been seen to have, processed.
  for (const name of ['entity', 'savedQuery', 'formXml', 'entityRibbon', 'rootComponent', 'dependency', 'workflowAndStepActivation', 'entityCustomResources', 'hierarchyrule', 'CustomControlDefaultConfig', 'savedQueryVisualization', 'entityrelationship', 'webResource', 'aNameNobodyHasSeen']) {
    assertNot(refused({ extra: `<${name} id="x" processed="true"></${name}>` }), 'component-processed', `${name} processed`);
    assertNot(refused({ extra: `<${name} processed="true" />` }), 'component-processed', `${name} processed, self-closing`);
    assertProven(refused({ extra: `<${name} id="x" processed="false"></${name}>` }), `${name} unprocessed`);
    assertProven(refused({ extra: `<${name} id="x"></${name}>` }), `${name} with no mark`);
  }
  assertNot(refused({ components: 'true' }), 'component-processed', 'all of them');
  for (const [what, value] of [['another case', 'True'], ['a number', '1'], ['empty', ''], ['a word', 'yes'], ['with white space', ' true'], ['a word that contains it', 'false-ish']]) {
    assertNot(refused({ extra: `<entity id="x" processed="${value}" />` }), 'component-unmarked', `a mark that is ${what}`);
  }
  // The only exemptions are by name: a node that looks like a check, and is not one, is a component. The package's own checks may be processed under any parent; a nested importexportxml is no root.
  assertNot(refused({ extra: '<importexportxml processed="true" />' }), 'component-processed', 'an importexportxml that is not the root');
  assertNot(refused({ extra: '<upgradeHandlers><UpgradeHandler processed="true" /></upgradeHandlers>' }), 'component-processed', 'another case of upgradeHandler');
  assertNot(refused({ extra: '<skuHandlers><skuHandler processed="true" /></skuHandlers>' }), 'component-processed', 'a check that is not one of the two');
  assertProven(refused({ extra: '<upgradeHandler processed="true"><result result="success" errorcode="0" errortext="" /></upgradeHandler><validateHandler processed="true" />' }), 'one more of each check');
});

// --- a document that is read as XML, not searched ---------------------------------------------------------------------------------------

test('the log is read as ONE well-formed XML document and nothing else: what is only text that looks like the rule\'s attributes — in a comment, a CDATA section, a value, character data — is never the attribute', () => {
  // A comment, a processing instruction and character data that spell the proof, over a root that has no verdict.
  const bare = importLog({ root: rootOf({ errorcode: undefined, succeeded: undefined, status: undefined }), manifest: 'false', components: 'false', handlers: 'true' });
  assertNot(bare, 'not-a-failure', 'no verdict');
  assertNot(bare.replace('<solutionManifests>', '<!-- succeeded="failure" errorcode="-2147020463" --><solutionManifests>'), 'not-a-failure', 'the verdict in a comment');
  assertNot(bare.replace('<solutionManifests>', '<?x succeeded="failure" errorcode="-2147020463"?><solutionManifests>'), 'not-a-failure', 'the verdict in a processing instruction');
  assertNot(bare.replace('<solutionManifests>', '<![CDATA[ succeeded="failure" errorcode="-2147020463" ]]><solutionManifests>'), 'not-a-failure', 'the verdict in a CDATA section');
  assertNot(bare.replace('<solutionManifests>', 'succeeded="failure" errorcode="-2147020463"<solutionManifests>'), 'not-a-failure', 'the verdict in character data');
  // Another attribute whose VALUE spells the proof: it is that attribute's value, not a second attribute.
  assertNot(refused().replace('succeeded="failure"', 'succeeded="success" Note=\'succeeded="failure" errorcode="-2147020463"\''), 'not-a-failure', 'the verdict in the value of a note');
  // A processed component that a search by pattern misses and a reader does not: a ">" is allowed in a value, and a tag does not end there.
  assertNot(refused({ extra: '<entity id="a>b" processed="true"></entity>' }), 'component-processed', 'processed after a ">" in a value');
  assertNot(refused({ extra: '<entity Description="an &lt;b&gt;escaped&lt;/b&gt; note" processed="true" />' }), 'component-processed', 'processed after an escaped markup in a value');
  assertNot(refused().replace('processed="false">', 'Note="a>b" processed="true">'), 'manifest-processed', 'a processed manifest after a ">" in a value');
  assertNot(refused({ extra: '<entity\nprocessed="true"\n/>' }), 'component-processed', 'processed on a line of its own');
  assertNot(refused({ extra: '<entity id=\'x\' processed=\'true\'/>' }), 'component-processed', 'processed in single quotes');
  assertNot(refused({ extra: '<entity id = "x"  processed = "true" />' }), 'component-processed', 'processed with white space around the equals sign');
  assertNot(refused({ extra: '<entity processed="&#116;rue" />' }), 'component-processed', 'processed="true" written with a character reference');
  assertNot(refused().replace('succeeded="failure"', 'succeeded="&#115;uccess"'), 'not-a-failure', 'succeeded written with a character reference');
  // What is only text is not an element: a processed component inside a CDATA section or a comment is data.
  assertProven(refused({ extra: '<![CDATA[<entity processed="true" />]]><!-- <entity processed="true" /> -->' }), 'markup in a CDATA section and a comment is text');
  // The attributes may come in any order, in either quote style.
  assertProven(refused().replace('errorcode="-2147020463" succeeded="failure"', 'succeeded=\'failure\'   errorcode = \'-2147020463\''), 'any order, either quote');
});

test('a log that is not exactly one well-formed XML document proves nothing — and says so — whatever it contains: unclosed or mismatched tags, a second root, text outside the root, a duplicate attribute, an entity that is not predefined, a DOCTYPE', () => {
  const data = refused();
  const cases = [
    ['an unclosed root', data.replace(/<\/importexportxml>$/, '')],
    ['a mismatched end tag', data.replace('</entities>', '</entity>')],
    ['a second root', `${data}<importexportxml />`],
    ['text after the root', `${data} succeeded="failure"`],
    ['text before the root', `x${data}`],
    ['a duplicate succeeded', data.replace('succeeded="failure"', 'succeeded="failure" succeeded="failure"')],
    ['a duplicate errorcode that disagrees', data.replace(`errorcode="${CONCURRENCY_ERRORCODE}"`, `errorcode="${CONCURRENCY_ERRORCODE}" errorcode="-1"`)],
    ['a duplicate processed on a manifest', data.replace('processed="false">', 'processed="false" processed="false">')],
    ['an unquoted value', data.replace('succeeded="failure"', 'succeeded=failure')],
    ['a "<" in a value', data.replace('succeeded="failure"', 'succeeded="fail<ure"')],
    ['an entity that is not predefined', data.replace('Contoso solution', '&nbsp;')],
    ['a DOCTYPE with an entity', `<!DOCTYPE importexportxml [<!ENTITY processed "true">]>${data}`],
    ['a DOCTYPE with no entity', `<!DOCTYPE importexportxml>${data}`],
    ['not XML at all', 'The import failed.'],
    ['JSON', JSON.stringify({ succeeded: 'failure', errorcode: -2147020463 })],
    ['a tag that is never closed', '<importexportxml succeeded="failure"'],
    ['white space only', ' \n\t '],
    ['a control character', data.replace('Contoso solution', 'Contoso\u0001solution')],
    ['a declaration of another version', `<?xml version="1.1"?>${data}`],
  ];
  for (const [what, text] of cases) {
    const verdict = assertNot(text, 'log-unreadable', what);
    assert.match(verdict.reason, /not an XML document this script can read/, what);
  }
});

test('the size of a log is bounded: a log longer than 8 MiB is not read, one of exactly 8 MiB is', () => {
  const log = refused();
  const exactly = `${log}${' '.repeat(MAX_JOB_LOG_CHARS - log.length)}`;
  assert.strictEqual(exactly.length, MAX_JOB_LOG_CHARS);
  assertProven(exactly, 'exactly the limit');
  const verdict = assertNot(`${exactly} `, 'log-too-large', 'one more character');
  assert.match(verdict.reason, /longer than 8 MiB/);
  assertNot(' '.repeat(MAX_JOB_LOG_CHARS + 1), 'log-too-large', 'white space past the limit is no reason to read it');
});

test('the rule never throws and never proves on what it cannot make sense of — not a row, not text, a cyclic or a hostile value', () => {
  const hostile = [
    undefined, null, 0, 1, '', 'x', true, [], {}, Symbol('s'), () => {}, new Date(), /x/, new Map(), Object.create(null),
    { completedon: 'x', data: Symbol('d') }, { completedon: 'x', get data() { throw new Error('a getter that throws'); } }, { get completedon() { throw new Error('boom'); }, data: refused() },
  ];
  const cyclic = { completedon: 'x' };
  cyclic.data = cyclic;
  hostile.push(cyclic);
  for (const value of hostile) {
    let verdict;
    assert.doesNotThrow(() => { verdict = refusedBeforeAnyComponent(value); }, String(typeof value));
    assert.strictEqual(verdict.proven, false, String(typeof value));
    assert.strictEqual(typeof verdict.why, 'string');
  }
});

// --- the answer of the read ---------------------------------------------------------------------------------------------------------------

test('proveRefusedImport: a 404 is proof whatever its body says; a 200 is proof only through its row; any other answer — or none — proves nothing, and says which', () => {
  for (const body of [undefined, null, '', 'Not Found', { error: { code: '0x80040217', message: 'importjob With Id = x Does Not Exist' } }, { error: { code: 'something else' } }, []]) {
    assert.deepStrictEqual(proveRefusedImport({ status: 404, body }), { proven: true, proof: PROOF_ABSENT }, JSON.stringify(body));
  }
  assert.deepStrictEqual(proveRefusedImport({ status: 200, body: jobRow(refused()) }), { proven: true, proof: PROOF_LOG });
  const notProof = proveRefusedImport({ status: 200, body: jobRow(LOGS.failedAfterStart()) });
  assert.deepStrictEqual([notProof.proven, notProof.why], [false, 'other-error']);
  assert.deepStrictEqual(proveRefusedImport({ status: 200 }), { proven: false, why: 'no-log', reason: 'its import job has no log to read' });
  for (const status of [201, 204, 301, 400, 401, 403, 405, 408, 409, 412, 429, 500, 502, 503, 504]) {
    const verdict = proveRefusedImport({ status, body: jobRow(refused()) });
    assert.deepStrictEqual(verdict, { proven: false, why: 'unreadable', reason: `the read of its import job answered HTTP ${status}, which is neither the job nor a 404` }, String(status));
  }
  for (const answer of [null, undefined, 0, 'x', {}, { status: 'ok' }, { status: NaN }, { status: 200.5 }, { body: jobRow(refused()) }]) {
    const verdict = proveRefusedImport(answer);
    assert.deepStrictEqual([verdict.proven, verdict.why], [false, 'no-answer'], JSON.stringify(answer));
  }
});

test('the words that say why a job is no proof are fixed text and numbers — nothing the platform wrote is in them', () => {
  const secret = 'kv-secret-value-0123456789';
  const text = (data, row) => verdictOf(data, row).reason;
  assert.strictEqual(text(LOGS.running(), { completed: false }), 'its import job is not finished (completedon is empty)');
  assert.strictEqual(text(null), 'its import job has no log to read');
  assert.strictEqual(text('<importexportxml'), 'the log of its import job is not an XML document this script can read');
  assert.strictEqual(text('<other />'), 'the log of its import job is not an importexportxml document');
  assert.strictEqual(text(LOGS.succeeded()), 'the log of its import job does not say that the import failed');
  assert.strictEqual(text(LOGS.failedAfterStart()), 'the log of its import job says the import failed with error 0x80048033, not with 0x80071151');
  assert.strictEqual(text(refused().replace(`errorcode="${CONCURRENCY_ERRORCODE}"`, '')), 'the log of its import job does not give the error code the import failed with');
  assert.strictEqual(text(refused().replace(`errorcode="${CONCURRENCY_ERRORCODE}"`, 'errorcode="7.5"')), 'the log of its import job gives an error code this script does not recognise');
  assert.strictEqual(text(refused().replace(/<solutionManifests>.*<\/solutionManifests>/, '')), 'the log of its import job has no solution manifest');
  assert.strictEqual(text(refused({ manifest: 'true' })), 'the log of its import job shows that the import began to apply the package (its solution manifest is processed)');
  assert.strictEqual(text(refused({ manifest: undefined })), 'the log of its import job does not say that its solution manifest was left unprocessed');
  assert.strictEqual(text(refused({ components: 'true' })), 'the log of its import job shows that the import began to apply components of the package');
  assert.strictEqual(text(refused({ extra: '<entity processed="maybe" />' })), 'the log of its import job marks a component in a way this script does not recognise');
  // What the platform wrote — the status of the root, an error text, a name — is never carried into a reason.
  for (const [what, data] of [
    ['the status', LOGS.failedAfterStart().replace('The import failed.', secret)],
    ['an error code', refused().replace(`errorcode="${CONCURRENCY_ERRORCODE}"`, `errorcode="${secret}"`)],
    ['a mark', refused({ extra: `<entity processed="${secret}" />` })],
    ['a name', refused({ extra: `<${'x'}${secret.replace(/[^a-z]/g, '')} processed="true" />` })],
  ]) assert.ok(!verdictOf(data).reason.includes(secret) && !verdictOf(data).reason.includes('kvsecretvalue'), what);
});
