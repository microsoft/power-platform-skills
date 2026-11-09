'use strict';
// A `node --require` preload for END-TO-END runs of scripts/genpage.js. It gives the plugin's REAL az-token HttpClient factory a stateful fake of the page tables
// (helpers/fake-genpage-server.js) and, when asked, of one app's navigation laid over it (`appTransport`) — no token is read and no network is used — so a real child
// process runs the real script, the real page backend, the real bundle and the real `emitResult`, and the test sees what the process printed, wrote and sent.
//
// The fake comes from the environment variable FAKE_GENPAGE, a JSON object:
//   pages      [{ id, name, source, config, prompt, agentMessage }]   seeded with FakeGenPageServer.seedPage (the four rows the maker lays out, and a turn)
//   tables     [<metadata>]                                         more tables to serve, in the SDK's EntityMetadata shape (`account` is always served)
//   languages  { base, provisioned, available }                     what the org's language reads answer (default 1033 only)
//   app        true | { publishFailures, published: [id], savedOnly: [id], views: [id] }
//                                                                    one app (APP_ID) with its navigation: it names the page APP_EXISTING_PAGE_ID, `published` more pages in
//                                                                    both layers and `savedOnly` more in the saved one alone; `views` are view ids its components already hold
//   refuse     { status }                                           every request is answered that
// When FAKE_GENPAGE_LOG names a file, what the run did is written there, as JSON, as the process exits:
//   { requests: [{ method, path }], writes: [...], published: [page id], pages: [{ id, name }], messages: <n>, app: { xml, publishedXml, views, publishAttempts } | null,
//     workspaces: [{ dir, exists }] }
// `workspaces` are the throwaway folders the process made (`fs.mkdtempSync`) and whether each still existed AT EXIT: the script must have removed what it made before it
// reports, because reporting ends the process.
const fs = require('node:fs');
const path = require('node:path');
const client = require(path.resolve(__dirname, '..', '..', 'lib', 'sdk-http-client.js'));
const { FakeGenPageServer, ACCOUNT_TABLE, appTransport } = require('./fake-genpage-server.js');

const made = [];
const mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = (...args) => { const dir = mkdtempSync(...args); made.push(dir); return dir; };

const options = JSON.parse(process.env.FAKE_GENPAGE || '{}');
const server = new FakeGenPageServer();
server.serveTable(ACCOUNT_TABLE);
for (const table of options.tables || []) server.serveTable(table);
if (options.languages) Object.assign(server.languages, options.languages);
for (const { id, ...page } of options.pages || []) server.seedPage(id, page);
if (options.refuse) server.failOn = () => options.refuse.status;

const app = options.app ? appTransport(server, options.app === true ? {} : { publishFailures: options.app.publishFailures || 0 }) : null;
if (app && options.app !== true) {
  const entry = (id) => `<SubArea Id="s_${id}" GenPageId="${id}"><Titles><Title LCID="1033" Title="Page ${id.slice(0, 4)}"/></Titles></SubArea>`;
  const into = (xml, ids) => xml.replace('</Group>', `${ids.map(entry).join('')}</Group>`);
  app.state.publishedXml = into(app.state.publishedXml, options.app.published || []);
  app.state.xml = into(into(app.state.xml, options.app.published || []), options.app.savedOnly || []);
  for (const view of options.app.views || []) app.state.views.add(view);
}

const http = app ? app.http : server.http();
// The script and the backend take `createAzHttpClient` from this module when they first need a client, which is after this preload, so replacing the export here is what they receive.
client.createAzHttpClient = () => http;

if (process.env.FAKE_GENPAGE_LOG) {
  process.on('exit', () => {
    fs.writeFileSync(process.env.FAKE_GENPAGE_LOG, JSON.stringify({
      requests: server.requests.map(({ method, path: p }) => ({ method, path: p })),
      writes: server.writes(),
      published: server.published,
      pages: [...server.state.projects.values()].map((p) => ({ id: p.id, name: p.name })),
      messages: server.state.messages.size,
      app: app ? { xml: app.state.xml, publishedXml: app.state.publishedXml, views: [...app.state.views], publishAttempts: app.state.publishAttempts } : null,
      workspaces: made.map((dir) => ({ dir, exists: fs.existsSync(dir) })),
    }));
  });
}
