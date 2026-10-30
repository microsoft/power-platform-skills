'use strict';
// THE PUBLICATION RULES OF THE BUNDLED SDK THAT THE SKILLS ARE BUILT ON, pinned at its boundary.
//
// What a maker sees in a model-driven app is what was PUBLISHED, and each skill decides its own publishes from what the SDK publishes
// by itself and what it leaves to its caller. If a new SDK starts (or stops) publishing inside a push, a skill either publishes
// something the maker did not ask to go live — a page's half-made draft, an app's navigation before its pages exist — or leaves a change
// saved and never live. These are the rules the skills rely on, each asserted on the requests the SDK sends to the stateful fake
// environment (helpers/fake-lifecycle-org.js) through the plugin's own HTTP client:
//
//   - a generative page push — create or update — publishes NOTHING. The page backend (lib/genpage-sdk.js) publishes the page itself
//     after it has checked what was written (`publish`, `publishArtifact('genPage', id, { verify: true })`), and the build publishes the
//     app after the page is in its navigation; a push that published would put an unchecked draft live.
//   - publishArtifact('genPage') sends exactly one PublishXml, naming the page, and the published copy is then what was pushed.
//   - an app update publishes nothing unless it asks to (`published: true`), and a create publishes unless it asks not to
//     (`published: false`, sdk-opt-ins.test.js): the build creates every app published and publishes an existing app in its own envelope
//     (lifecycle-trail-golden-real-bundle.test.js pins where).
//
// A failure names the request the SDK sent that it did not send before (or the one it no longer sends). It is an SDK behaviour change
// the skills must answer: adjust the skill's own publishes, and write the release-note line a maker can observe.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { seedForeignWork, FOREIGN } = require('./helpers/lifecycle-harness.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');

const PAGE_ID = '33333333-0000-4000-8000-000000000001';
const SOURCE = "import * as React from 'react';\nexport default function WidgetPage() { return <div>Widgets</div>; }\n";
const EDITED = "import * as React from 'react';\nexport default function WidgetPage() { return <div>Widgets, edited</div>; }\n";

async function environment() {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const client = createAzHttpClient(org.origin, { getToken: () => 'sdk-publication-token-0123456789', request: org.request, sleep: async () => {} });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('sdk-publication-')), instanceUrl: org.origin, httpClient: client });
  await sdk.initWorkspace();
  // What a call sent: every request, and its publishes (what each PublishXml names).
  const sentBy = async (fn) => {
    const mark = org.mark();
    const value = await fn();
    const sent = org.since(mark);
    const publishes = sent.filter((r) => r.path === '/PublishXml').map((r) => String(r.body.ParameterXml));
    return { value, sent, publishes, writes: org.writeNames(mark) };
  };
  return { org, sdk, sentBy };
}

test('publication: a generative page push publishes nothing, create or update; publishArtifact publishes it once, and only then is it live', async () => {
  const { org, sdk, sentBy } = await environment();
  await sdk.createArtifact('genPage', { id: PAGE_ID, name: 'Widget Page', source: SOURCE, dataSources: ['fabrikam_widget'], newTurn: { prompt: 'A page of widgets', agentMessage: 'Done.' } });
  const created = await sentBy(() => sdk.pushArtifact('genPage', PAGE_ID));
  assert.equal(created.value && created.value.saved, true, `the page was created: ${JSON.stringify(created.value && created.value.error && created.value.error.message)}`);
  assert.ok(created.writes.some((w) => w.startsWith('POST uxagentprojects')), `the push wrote the page: ${created.writes.join(', ')}`);
  assert.deepEqual(created.publishes, [], 'a page create publishes nothing');
  assert.equal(org.pageServer.publishedPages.has(PAGE_ID), false, 'and the page is not live');

  const published = await sentBy(() => sdk.publishArtifact('genPage', PAGE_ID, { verify: true }));
  assert.equal(published.publishes.length, 1, 'publishArtifact sends one publish');
  assert.match(published.publishes[0], new RegExp(`<uxagentproject>\\{?${PAGE_ID}\\}?</uxagentproject>`, 'i'), 'naming the page');
  assert.deepEqual(published.writes.filter((w) => w !== 'POST PublishXml'), [], 'and writes nothing else');
  assert.equal(published.value.publish.kind, 'verified', `the published copy is what was pushed: ${JSON.stringify(published.value.publish)}`);

  await sdk.updateElement('genPage', PAGE_ID, '/source', EDITED);
  await sdk.addElement('genPage', PAGE_ID, '', { newTurn: { prompt: 'Say edited', agentMessage: 'Done.' } });
  const updated = await sentBy(() => sdk.pushArtifact('genPage', PAGE_ID));
  assert.equal(updated.value && updated.value.saved, true, 'the page was updated');
  assert.ok(updated.writes.length > 0, 'the update wrote the page');
  assert.deepEqual(updated.publishes, [], 'a page update publishes nothing: the live page is still the one published before');
});

test('publication: an app update publishes nothing unless it asks to; with `published: true` it publishes the app once', async () => {
  const { sdk, sentBy } = await environment();
  await sdk.fetchArtifact('app', FOREIGN.app, { overwrite: true });
  await sdk.updateElement('app', FOREIGN.app, '/description', 'Widgets, described.');
  const plain = await sentBy(() => sdk.pushArtifact('app', FOREIGN.app));
  assert.equal(plain.value && plain.value.saved, true, `the app was updated: ${JSON.stringify(plain.value && plain.value.error && plain.value.error.message)}`);
  assert.ok(plain.writes.some((w) => w.startsWith('PATCH appmodules')), `the push wrote the app: ${plain.writes.join(', ')}`);
  assert.deepEqual(plain.publishes, [], 'an app update publishes nothing by itself');

  await sdk.updateElement('app', FOREIGN.app, '/description', 'Widgets, described again.');
  // A fetched app carries no `published` member, so the request is added, as a caller adds any member a copy lacks.
  await sdk.addElement('app', FOREIGN.app, '', { published: true });
  const asked = await sentBy(() => sdk.pushArtifact('app', FOREIGN.app));
  assert.equal(asked.value && asked.value.saved, true, 'the app was updated again');
  assert.equal(asked.publishes.length, 1, `an update that asks to be published publishes once: ${asked.writes.join(', ')}`);
  assert.match(asked.publishes[0], new RegExp(`<appmodule>\\{?${FOREIGN.app}\\}?</appmodule>`, 'i'), 'naming the app');
});
