'use strict';
// A generative page's publish the customization lock refused (#848), through the whole build — the REAL vendored SDK, the plugin's own HTTP
// client and the stateful fake Dataverse the lifecycle tests share (helpers/fake-lifecycle-org.js, helpers/lifecycle-harness.js).
//
// The lock is held by another customization — a solution import, another publish — and Dataverse refuses the page's PublishXml with
//
//   HTTP 429  Retry-After: 40
//   { "error": { "code": "0x80071151", "message": "Cannot start the requested operation [Publish] because there is another [Import] running at this moment." } }
//
// A page's publish is NOT one the build waits longer for (lib/retry-policy.js, reconciledPublish): its next run reads the page by id and compares the
// source, but not the compiled runtime the service publishes (lib/genpage-sdk.js, planEdits), so a longer wait would give an import more time to
// replace a compiled row the next run would publish unseen. It keeps the ordinary wait of 2.27.0 — about 3 s, whatever the Retry-After — and the
// cases pin that, and what the next run does, over the wire, by a timestamped ledger of every request and the build's waits:
//   * nothing changed while the build waited: the page is read by id after the wait, NOT written, and published exactly once more — and the
//     environment publishes the content the build wrote;
//   * the saved page changed while the build waited (another workspace's draft): the page is read by id after the wait, written by id, and only then
//     published — and the environment publishes the spec's content, not the other.
// Only this test's own page's publish is refused, in front of the fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');

const PAGE_TSX = 'src/pages/page.tsx';
const LOCK = { code: '0x80071151', message: 'Cannot start the requested operation [Publish] because there is another [Import] running at this moment.' };
const THEIRS = "import * as React from 'react';\nexport default function KitchenPage() { return <div>Imported over the build</div>; }\n";

function lockSpec() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoLockWait', displayName: 'Contoso Lock Wait', publisherPrefix: 'contoso' },
    app: { name: 'Lock Wait', uniqueName: 'contoso_lockwait' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', pluralName: 'Items', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [{ key: 'overview', name: 'Overview', purpose: 'A page over items.', dataSources: ['contoso_item'], source: { kind: 'tsx', codeFile: 'KitchenPage.tsx' } }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }, { page: 'overview', title: 'Overview' }] }] }] },
  };
}

// A page's publish names it in the ParameterXml, e.g.
//   <importexportxml><uxagentprojects><uxagentproject>{2b857bb3-fc46-4be3-987a-0d002c6ea843}</uxagentproject></uxagentprojects></importexportxml>
// (braces and case vary with the sender), so the id is the first GUID inside a <uxagentproject> element.
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const pageIdOf = (xml) => { const m = /<uxagentproject>([\s\S]*?)<\/uxagentproject>/i.exec(String(xml || '')); const id = m && GUID.exec(m[1]); return id ? id[0].toLowerCase() : null; };
const isPagePublish = (r) => r.method === 'POST' && /\/PublishXml$/.test(r.url) && !!pageIdOf(r.body && r.body.ParameterXml);
// A write of the page's own rows: a request to `uxagentprojects(…)`/`uxagentprojectfiles(…)`, or a `$batch` whose parts change one, e.g.
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.2/uxagentprojectfiles(5f0c…)/content HTTP/1.1
const isPageWrite = (r) => r.method !== 'GET' && !/\/PublishXml$/.test(r.url)
  && (/uxagentproject/i.test(r.url) && !/\$batch$/.test(r.url) || (/\$batch$/.test(r.url) && /\b(?:PATCH|PUT|POST|DELETE)\s+[^\r\n]*uxagentproject/i.test(String(r.body))));
// A read of the page by its id: a GET that names it (the project row, or its file rows filtered by it).
const isPageRead = (r, id) => r.method === 'GET' && /uxagentproject/i.test(r.url) && decodeURIComponent(r.url).toLowerCase().includes(id);

// One build of lockSpec in which the page's first publish is refused by the lock; `duringWait(org, pageId)` runs inside the build's wait.
async function lockedBuild(duringWait) {
  const org = createLifecycleOrg();
  const send = org.request;
  const ledger = [];
  let refused = 0;
  let intended = null;
  org.request = async (request) => {
    let body;
    try { body = JSON.parse(request.body); } catch { body = request.body; }
    const entry = { at: ledger.length, method: request.method, url: request.url, body };
    if (isPagePublish(entry) && refused === 0) {
      refused += 1;
      // What the build saved and was about to publish: what the environment must end up publishing.
      intended = org.pageServer.rowText(pageIdOf(body.ParameterXml), PAGE_TSX);
      ledger.push({ ...entry, status: 429 });
      return { statusCode: 429, headers: { 'Retry-After': '40', 'content-type': 'application/json' }, body: JSON.stringify({ error: LOCK }) };
    }
    const answer = await send(request);
    ledger.push({ ...entry, status: answer.statusCode });
    return answer;
  };
  const harness = createLifecycleHarness(org, makeTempDir('lock-page-'));
  const sleeps = [];
  const { result, log } = await harness.build(lockSpec(), {
    sleep: async (ms) => {
      sleeps.push(ms);
      ledger.push({ at: ledger.length, sleep: ms });
      const refusedPublish = ledger.find((r) => r.status === 429);
      if (duringWait) duringWait(org, pageIdOf(refusedPublish.body.ParameterXml));
    },
  });
  const refusal = ledger.findIndex((r) => r.status === 429);
  const pageId = pageIdOf(ledger[refusal].body.ParameterXml);
  const wait = ledger.findIndex((r) => r.sleep !== undefined);
  const after = ledger.slice(wait + 1);
  const publishedRow = (org.pageServer.publishedPages.get(pageId) || { files: [] }).files.find((f) => f.filename === PAGE_TSX);
  return {
    org, result, log, ledger, sleeps, refused, intended, pageId, refusal, wait,
    // Every publish of the page after the wait, and where in the ledger the first read of it by id, and its writes, fall.
    publishesAfter: after.flatMap((r, i) => (isPagePublish(r) && pageIdOf(r.body.ParameterXml) === pageId ? [i] : [])),
    firstRead: after.findIndex((r) => isPageRead(r, pageId)),
    writesAfter: after.flatMap((r, i) => (isPageWrite(r) ? [i] : [])),
    writesBetween: ledger.slice(refusal + 1, wait).filter(isPageWrite).length,
    published: publishedRow && publishedRow.content ? Buffer.from(publishedRow.content).toString('utf8') : undefined,
  };
}

test('a page publish the lock refused keeps the ordinary wait of about 3 s; after it the page is read back by id, found unchanged, and published exactly once more — never written blind', async () => {
  const out = await lockedBuild();
  assert.strictEqual(out.result.ok, true, out.log.join('\n'));
  assert.strictEqual(out.refused, 1);
  assert.strictEqual(out.sleeps.length, 1, 'one wait, before the one run again');
  assert.ok(out.sleeps[0] >= 3000 && out.sleeps[0] < 4000, `the ordinary first wait of about 3 s, as in 2.27.0 — not the lock's 30 s, nor the Retry-After of 40 s: ${out.sleeps}`);
  assert.ok(!out.log.some((l) => /another customization/.test(l)), out.log.join('\n'));
  assert.strictEqual(out.writesBetween, 0, 'nothing written to the page between the refusal and the wait');
  assert.strictEqual(out.publishesAfter.length, 1, 'exactly one publish of the page after the wait');
  assert.ok(out.firstRead >= 0 && out.firstRead < out.publishesAfter[0], `the page is read by id after the wait (${out.firstRead}) and before it is published (${out.publishesAfter[0]})`);
  assert.deepStrictEqual(out.writesAfter.filter((i) => i < out.publishesAfter[0]), [], 'what the service holds is what the spec asks for: nothing is written again');
  assert.ok(out.intended && out.intended.includes('Kitchen'), `the saved page: ${out.intended}`);
  assert.strictEqual(out.published, out.intended, 'the environment publishes what the build saved');
  assert.deepStrictEqual(out.org.unexpected, []);
});

test('a page publish the lock refused, ordinary wait: when the saved page changes during it, the next run reads it by id, writes it again by id, and only then publishes it', async () => {
  const out = await lockedBuild((org, pageId) => org.pageServer.otherWorkspaceDraft(pageId, PAGE_TSX, THEIRS));
  assert.strictEqual(out.result.ok, true, out.log.join('\n'));
  assert.strictEqual(out.refused, 1);
  assert.strictEqual(out.sleeps.length, 1);
  assert.ok(out.sleeps[0] >= 3000 && out.sleeps[0] < 4000, `the ordinary wait: ${out.sleeps}`);
  assert.strictEqual(out.publishesAfter.length, 1, 'exactly one publish of the page after the wait');
  const publish = out.publishesAfter[0];
  assert.ok(out.firstRead >= 0 && out.firstRead < publish, `read by id after the wait (${out.firstRead}), before the publish (${publish})`);
  const rewrite = out.writesAfter.find((i) => i > out.firstRead && i < publish);
  assert.ok(rewrite !== undefined, `the page is written again between the read (${out.firstRead}) and the publish (${publish}): writes at ${out.writesAfter}`);
  assert.notStrictEqual(out.intended, THEIRS);
  assert.strictEqual(out.published, out.intended, 'the environment publishes the spec\'s page, not what replaced it during the wait');
  assert.deepStrictEqual(out.org.unexpected, []);
});
