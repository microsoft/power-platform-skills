'use strict';
// A STATEFUL fake of the Dataverse tables behind a generative page — `uxagentprojects`, `uxagentprojectfiles` (with its
// `filecontent` File column) and `agentconversationmessages` — for tests that run the REAL vendored SDK bundle against it.
// It is a port of the fake the SDK's own tests drive, encoding what was measured on a live org rather than what would be
// convenient:
//
//   - a page is a DRAFT until published, and a draft is invisible (404) without `MSCRM.IncludeUnpublished`; a PUBLISHED page
//     is served without the header as `PublishXml` last snapshotted it;
//   - an update needs `If-Match: *`: none answers 412 (duplicate detection), a real etag 400 — fresh or stale;
//   - every successful write ROTATES the row's etag, and a content upload rotates its file row's; so does a publish, for the
//     project and every row, synchronously and with no byte changed;
//   - deleting a project cascades to its files but NOT to its conversation messages;
//   - a `$batch` change set is ATOMIC: one failing operation rolls every other back, and the response carries only the failing
//     part.
//
// The change set is parsed the way the server parses it — MIME parts, the embedded request line, headers and body, with the
// CRLF before each delimiter belonging to the delimiter — so a rendering defect in the SDK (a body gaining a line break, a
// header in the wrong place) shows up as wrong data, not as a pass. A raw `$batch` request, as the SDK renders it (abridged):
//
//   --batch_<id>
//   Content-Type: multipart/mixed;boundary=changeset_<id>
//
//   --changeset_<id>
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//
//   POST https://contoso.crm.dynamics.com/api/data/v9.0/uxagentprojects HTTP/1.1
//   Content-Type: application/json;type=entry
//   MSCRM.VersioningChangeset: uxagentproject_<id>
//   MSCRM.IncludeUnpublished: true
//
//   {"name":"Overview","uxagentprojectid":"<id>"}
//   --changeset_<id>--
//   --batch_<id>--
//
// Fault injection for the unknown-outcome tests: `failOn` answers a status instead of executing a request, and `afterCommit`
// may throw to model a LOST RESPONSE (the server keeps the change set, the client sees a transport error). `failBatch` answers an HTTP status
// (a 429) for a whole `$batch` request, and `strandBatch` + `landStranded()` model a request that is still IN FLIGHT when the client gives up on
// it: the client sees a timeout, and the change set commits later — after the client has read for it, and perhaps beside its resend.
const INSTANCE = 'https://contoso.crm.dynamics.com';
const API = `${INSTANCE}/api/data/v9.0`;
const GUID = '([0-9a-fA-F-]{36})';

const json = (status, body, headers = {}) => ({ status, headers, body });

// Two contents are the same when both are absent or hold the same bytes.
const sameBytes = (a, b) => (a === undefined || b === undefined ? a === b : Buffer.from(a).equals(Buffer.from(b)));

const PAGE_ENTITY_SETS = { uxagentproject: 'uxagentprojects', uxagentprojectfile: 'uxagentprojectfiles', agentconversationmessage: 'agentconversationmessages' };

// A table a page's data sources can name, for `serveTable`: what `EntityDefinitions` answers for `account`, trimmed to the columns the tests use.
const ACCOUNT_TABLE = {
  logicalName: 'account', schemaName: 'Account', displayName: 'Account', entitySetName: 'accounts', primaryNameAttribute: 'name', primaryIdAttribute: 'accountid', isCustomEntity: false,
  attributes: [
    { logicalName: 'accountid', displayName: 'Account', attributeType: 'Uniqueidentifier', attributeTypeName: 'UniqueidentifierType', isCustomAttribute: false, isValidForUpdate: false, isValidForRead: true },
    { logicalName: 'name', displayName: 'Account Name', attributeType: 'String', attributeTypeName: 'StringType', isCustomAttribute: false, isValidForUpdate: true, isValidForRead: true, maxLength: 160 },
    { logicalName: 'accountcategorycode', displayName: 'Category', attributeType: 'Picklist', attributeTypeName: 'PicklistType', isCustomAttribute: false, isValidForUpdate: true, isValidForRead: true, choices: [{ value: 1, label: 'Preferred Customer' }, { value: 2, label: 'Standard' }] },
  ],
};

// What the server answers a `$batch` with, shaped like a live answer: it does NOT echo the request's change-set boundary (it
// announces its own `changesetresponse_<guid>` in a nested Content-Type), and it DOES echo the request's Content-IDs.
function batchEnvelope(parts) {
  const outer = 'batchresponse_00000000-0000-0000-0000-000000000001';
  const inner = 'changesetresponse_00000000-0000-0000-0000-000000000002';
  const rendered = parts.map((part) => [
    `--${inner}`,
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    `Content-ID: ${part.contentId}`,
    '',
    `HTTP/1.1 ${part.status} ${part.status === 204 ? 'No Content' : 'Failed'}`,
    'OData-Version: 4.0',
    '',
    '',
  ].join('\r\n'));
  return `--${outer}\r\nContent-Type: multipart/mixed; boundary=${inner}\r\n\r\n${rendered.join('')}--${inner}--\r\n--${outer}--\r\n`;
}

function cloneState(state) {
  return {
    projects: new Map([...state.projects].map(([k, v]) => [k, { ...v }])),
    files: new Map([...state.files].map(([k, v]) => [k, { ...v }])),
    messages: new Map([...state.messages].map(([k, v]) => [k, { ...v }])),
  };
}

// SQL Server's `uniqueidentifier` order, which is how Dataverse returns rows that tie on the sort key: the LAST group is
// compared first (measured), then the fourth, then the rest.
function sqlGuidOrder(a, b) {
  const groups = (id) => id.toLowerCase().split('-').reverse();
  const [x, y] = [groups(a), groups(b)];
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

class FakeGenPageServer {
  constructor() {
    this.state = { projects: new Map(), files: new Map(), messages: new Map() };
    this.requests = [];
    // Every raw `$batch` body received.
    this.batches = [];
    // Every page id a `PublishXml` published.
    this.published = [];
    // When true, `PublishXml` still rotates every token but leaves the PUBLISHED projection alone: one that has not caught up.
    this.holdPublishedProjection = false;
    // As `PublishXml` last snapshotted each page: what a read WITHOUT `MSCRM.IncludeUnpublished` is served (measured). A later
    // edit changes the draft, not this.
    this.publishedPages = new Map();
    // Fault injection: `(method, path, batched, headers) => status | undefined`, a status to answer instead of executing.
    this.failOn = undefined;
    // Corrupt what a content upload STORES — for example append the stray CRLF pac's batch writer adds.
    this.mangleContent = undefined;
    // Called after every executed request, for example to simulate a concurrent writer.
    this.afterRequest = undefined;
    // Called once a `$batch` change set has COMMITTED. Throw from it to model a lost response.
    this.afterCommit = undefined;
    // Called when a `$batch` ARRIVES, before it is executed. Throw to model a request that never reached the server.
    this.beforeBatch = undefined;
    // `(n) => status | { status, headers } | undefined`: answer an HTTP status for the whole of `$batch` request number n (1-based) instead of executing it —
    // a throttle (429) or a gateway answer, with the headers the answer carries (`{ 'retry-after': '7' }`) when it is given as an object. Nothing is written: the request was refused.
    this.failBatch = undefined;
    // `(n) => boolean`: STRAND `$batch` request number n. The client is told it failed — a transport timeout, as the plugin's client
    // reports one — but the request is not lost: it is held, and COMMITS when `landStranded()` is called, as a request still in flight
    // in a gateway does. This is what makes "the first send is still in flight when it is read for, and lands after" expressible.
    this.strandBatch = undefined;
    this.stranded = [];
    // The org's languages, as the SDK's `getEnvironmentLanguages` reads them — the base language, then the provisioned and the available ones (`this.languages`).
    this.languages = { base: 1033, provisioned: [1033], available: [1033] };
    this.tables = new Map();
    this.clock = 0;
    this.seq = 0;
    this.version = 0;
    this.batchStamp = undefined;
  }

  // --- seeding -------------------------------------------------------------------------------------------------------

  // Serve `EntityDefinitions` for a table, in the raw Web API shape the SDK parses (see entityDefinitions below).
  serveTable(metadata) {
    this.tables.set(metadata.logicalName, metadata);
  }

  seedProject(id, name) {
    this.state.projects.set(id, { id, name, etag: this.nextEtag(), version: this.nextVersion() });
  }

  seedFile(projectId, id, filename, filetype, content) {
    this.state.files.set(id, {
      id, projectId, filename, filetype, etag: this.nextEtag(), version: this.nextVersion(),
      ...(content === undefined ? {} : { content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content }),
    });
  }

  seedMessage(regarding, message, sender = 200000000, id = this.nextId()) {
    this.state.messages.set(id, { id, regarding, message, sender, context: '{}', createdon: this.now(), version: this.nextVersion() });
    return id;
  }

  // A page laid out as the maker portal does: four rows (source, compiled output, config.json, firstPrompt.json) and a turn.
  // `compiled` is stored as the Output row WITHOUT being compiled here — a test of retention wants bytes it chose.
  seedPage(id, { name = 'Seeded page', source = 'export default function Page() { return null; }\n', compiled = '"use strict";\n', config = { dataSources: [], model: '' }, prompt = 'Seeded', agentMessage = 'Done' } = {}) {
    this.seedProject(id, name);
    const rows = [
      ['src/pages/page.tsx', 200000000, source],
      ['src/pages/page.compiled', 200000001, compiled],
      ['config.json', 200000000, JSON.stringify(config)],
      ['firstPrompt.json', 200000000, JSON.stringify({ userMessage: prompt, agentMessage })],
    ];
    rows.forEach(([filename, filetype, content], i) => this.seedFile(id, `f0000000-0000-4000-8000-${String(this.seq + 1 + i).padStart(12, '0')}`, filename, filetype, content));
    this.seedMessage(id, prompt, 200000000);
    this.seedMessage(id, agentMessage, 200000001);
  }

  // --- reading state ---------------------------------------------------------------------------------------------------

  fileText(id) {
    const content = this.state.files.get(id) && this.state.files.get(id).content;
    return content ? Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('utf8') : undefined;
  }

  filesOf(projectId) {
    return [...this.state.files.values()].filter((f) => f.projectId === projectId);
  }

  // The text of one row of a page, by its name (`src/pages/page.tsx`).
  rowText(projectId, filename) {
    const row = this.filesOf(projectId).find((f) => f.filename === filename);
    return row ? this.fileText(row.id) : undefined;
  }

  messagesOf(projectId) {
    return [...this.state.messages.values()].filter((m) => m.regarding === projectId);
  }

  // Every request that CHANGED something, as `METHOD path` (batched ones flagged).
  writes() {
    return this.requests
      .filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/$batch'))
      .map((r) => `${r.batched ? '[batch] ' : ''}${r.method} ${r.path}`);
  }

  // The raw transport — what `createMakerSdk({ httpClient })` takes. Reads return file content as bytes, as the plugin's own
  // client does (lib/sdk-http-client.js `get` for a `$value` URL).
  http(transport = {}) {
    return {
      get: (url, o) => this.receive('GET', url, undefined, o, false, transport),
      post: (url, b, o) => this.receive('POST', url, b, o, false, transport),
      patch: (url, b, o) => this.receive('PATCH', url, b, o, false, transport),
      delete: (url, o) => this.receive('DELETE', url, undefined, o, false, transport),
      ...(transport.atomic === false ? {} : { postRaw: (url, body) => this.receiveBatch(url, body) }),
      ...(transport.binary === false ? {} : { patchRaw: (url, body, o) => this.receive('PATCH', url, body, o, false, transport) }),
    };
  }

  // --- another workspace -----------------------------------------------------------------------------------------------

  // What a PublishXml does to one page. MEASURED: it rotates the project's token and EVERY row's — synchronously — and changes no bytes (a push after a publish sees exactly what it would on a real org).
  // The `versionnumber` of a file row, read with a plain GET, is a separate measure: a publish moves the version of each file row whose content changed since the last publish, and an unchanged row keeps
  // its own (a draft-only write of a file's content already moved it, `execute`; publishing that draft moves it again). The page's own row is modelled the same way: a write to it (a rename) moves its version, and
  // publishing that draft moves it again; a publish with nothing written to the row leaves it (an ASSUMPTION about the service for the row, the measured one for the files).
  publishProject(state, id) {
    this.published.push(id);
    const project = state.projects.get(id);
    if (project) project.etag = this.nextEtag();
    const previous = (this.publishedPages.get(id) || {}).files || [];
    for (const file of state.files.values()) {
      if (file.projectId !== id) continue;
      file.etag = this.nextEtag();
      if (this.holdPublishedProjection) continue;
      // A row written as a draft since the last publish moves again when that draft is published (measured), even when it was written with the very bytes it had.
      const before = previous.find((p) => p.id === file.id);
      if (file.draft || !(before && before.filename === file.filename && sameBytes(before.content, file.content))) file.version = this.nextVersion();
      file.draft = false;
    }
    if (project && !this.holdPublishedProjection) {
      if (project.draft) project.version = this.nextVersion();
      project.draft = false;
      this.publishedPages.set(id, {
        project: { ...project },
        files: [...state.files.values()].filter((f) => f.projectId === id).map((f) => ({ ...f, ...(f.content ? { content: f.content.slice() } : {}) })),
      });
    }
  }

  // A writer outside the workspace under test — another maker, another machine — writing a page's file as a DRAFT (no publish) and publishing it. `text` replaces the content of the row named `filename`.
  otherWorkspaceDraft(pageId, filename, text) {
    const file = this.filesOf(pageId).find((f) => f.filename === filename);
    file.content = Buffer.from(text, 'utf8');
    file.etag = this.nextEtag();
    file.version = this.nextVersion();
    file.draft = true;
  }

  otherWorkspacePublishes(pageId) {
    this.publishProject(this.state, pageId);
  }

  // --- the server --------------------------------------------------------------------------------------------------------

  nextEtag() { this.seq += 1; return this.seq; }

  nextId() { this.seq += 1; return `c0000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`; }

  now() { this.clock += 1; return `2026-09-23T17:00:${String(this.clock % 60).padStart(2, '0')}Z`; }

  // A row's `createdon`. MEASURED: every row one change set writes carries the SAME second — ten turns in one `$batch` all read
  // back `createdon` 00:37:29Z — so inside a change set this is one shared stamp.
  stamp() { return this.batchStamp || this.now(); }

  nextVersion() { this.version += 1; return this.version; }

  receive(method, url, body, options, batched, transport) {
    const path = url.startsWith(API) ? decodeURI(url.slice(API.length)) : url;
    const request = { method, path, headers: { ...((options && options.headers) || {}) }, body, batched };
    this.requests.push(request);
    const injected = this.failOn ? this.failOn(method, path, batched, request.headers) : undefined;
    const response = injected !== undefined ? json(injected, { error: { message: 'injected' } }) : this.execute(this.state, request, transport);
    if (this.afterRequest) this.afterRequest(request);
    return Promise.resolve(response);
  }

  receiveBatch(url, body) {
    // A fault hook that throws models a transport that failed: the plugin's client rejects (lib/sdk-http-client.js, `Request
    // failed: …`), it never throws synchronously.
    try {
      return this.receiveBatchNow(url, body);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  receiveBatchNow(url, body) {
    this.batches.push(body);
    this.requests.push({ method: 'POST', path: '/$batch', headers: {}, body, batched: false });
    if (this.beforeBatch) this.beforeBatch(body);
    const refused = this.failBatch ? this.failBatch(this.batches.length) : undefined;
    if (refused !== undefined) return Promise.resolve(typeof refused === 'object' ? json(refused.status, { error: { message: 'injected' } }, refused.headers || {}) : json(refused, { error: { message: 'injected' } }));
    if (this.strandBatch && this.strandBatch(this.batches.length)) {
      this.stranded.push(body);
      return Promise.reject(new Error('Request failed: connect ETIMEDOUT'));
    }
    return this.runBatch(body, true);
  }

  // The stranded `$batch` requests reach the server now: each is executed as it would have been, against the state as it is NOW.
  landStranded() {
    return Promise.all(this.stranded.splice(0).map((body) => this.runBatch(body, false)));
  }

  // Execute one `$batch` body. `answered` is false for a stranded request that lands late: nobody is waiting for its response.
  runBatch(body, answered) {
    const boundary = (/Content-Type:\s*multipart\/mixed;\s*boundary=(\S+)/i.exec(body) || [])[1];
    if (!boundary) return Promise.resolve(json(400, { error: { message: 'no change set' } }));
    const parts = body.split(`--${boundary}`).slice(1);
    const staged = cloneState(this.state);
    const statuses = [];
    this.batchStamp = this.now();
    try {
      for (const part of parts) {
        if (part.startsWith('--')) break;
        const mimeEnd = part.indexOf('\r\n\r\n');
        const contentId = (/^Content-ID:\s*(\S+)/im.exec(part.slice(0, mimeEnd)) || [])[1] || '?';
        const http = part.slice(mimeEnd + 4);
        const headEnd = http.indexOf('\r\n\r\n');
        const head = http.slice(0, headEnd).split('\r\n');
        // RFC 2046: the CRLF before the next delimiter belongs to the delimiter, not the body.
        const rawBody = http.slice(headEnd + 4).replace(/\r\n$/, '');
        const [method, target] = head[0].split(' ');
        const headers = {};
        for (const line of head.slice(1)) {
          const colon = line.indexOf(':');
          headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
        const path = target.startsWith(API) ? decodeURI(target.slice(API.length)) : target;
        const contentType = headers['Content-Type'] || '';
        const opBody = rawBody === '' ? undefined : contentType.startsWith('application/json') ? JSON.parse(rawBody) : Buffer.from(rawBody, 'utf8');
        const request = { method, path, headers, body: opBody, batched: true };
        this.requests.push(request);
        const injected = this.failOn ? this.failOn(method, path, true, headers) : undefined;
        const response = injected !== undefined ? json(injected) : this.execute(staged, request, {});
        if (this.afterRequest) this.afterRequest(request);
        if (response.status < 200 || response.status >= 300) {
          // Rolled back: nothing is committed, and only the failing part is reported.
          return Promise.resolve(json(200, batchEnvelope([{ contentId, status: response.status }])));
        }
        statuses.push({ contentId, status: response.status });
      }
    } finally {
      this.batchStamp = undefined;
    }
    this.state = staged;
    // A response that is lost is a response somebody was waiting for; a stranded request that lands late had none to lose.
    if (answered && this.afterCommit) this.afterCommit();
    return Promise.resolve(json(200, batchEnvelope(statuses)));
  }

  execute(state, request, transport) {
    const { method, path, headers, body } = request;
    const unpublishedVisible = headers['MSCRM.IncludeUnpublished'] === 'true';
    const ifMatch = headers['If-Match'];
    const updateGate = () => (ifMatch === undefined
      ? json(412, { error: { code: '0x80040333', message: 'A record with matching key values already exists.' } })
      : ifMatch !== '*' ? json(400, { error: { code: '0x80040216', message: 'The retrieval of version numbers failed.' } }) : undefined);
    if (method === 'GET') {
      const entityDefinition = /^\/EntityDefinitions\(LogicalName='([^']+)'\)/.exec(path);
      if (entityDefinition) return this.entityDefinitions(entityDefinition[1], path.slice(entityDefinition[0].length).split('?')[0]);
      if (path === '/organizations?$select=languagecode') return json(200, { value: [{ languagecode: this.languages.base }] });
      if (path === '/RetrieveProvisionedLanguages()') return json(200, { RetrieveProvisionedLanguages: this.languages.provisioned });
      if (path === '/RetrieveAvailableLanguages()') return json(200, { LocaleIds: this.languages.available });
      // A draft is invisible without the header; a PUBLISHED page is served as it was last published.
      const projectRead = new RegExp(`^/uxagentprojects\\(${GUID}\\)`).exec(path);
      if (projectRead) {
        const id = projectRead[1].toLowerCase();
        const project = unpublishedVisible ? state.projects.get(id) : (this.publishedPages.get(id) || {}).project;
        return project
          ? json(200, { uxagentprojectid: project.id, name: project.name, '@odata.etag': `W/"${project.etag}"` }, { ETag: `W/"${project.etag}"` })
          : json(404, { error: { message: 'Does Not Exist' } });
      }
      if (/^\/uxagentprojects\?/.test(path)) {
        // `$filter=uxagentprojectid eq <id> or …` narrows the list to those pages, as a read of their versions asks. A plain read is the published layer — the rows as the last publish left them — each with the version the row has
        // NOW, as the files' are (below); a read that unpublished rows are visible to answers the draft.
        const wanted = [...path.matchAll(new RegExp(`uxagentprojectid eq ${GUID}`, 'g'))].map((m) => m[1].toLowerCase());
        const rows = unpublishedVisible
          ? [...state.projects.values()]
          : [...this.publishedPages.values()].map((p) => ({ ...p.project, version: state.projects.has(p.project.id) ? state.projects.get(p.project.id).version : p.project.version }));
        return json(200, { value: rows.filter((p) => !wanted.length || wanted.includes(p.id)).map((p) => ({ uxagentprojectid: p.id, name: p.name, versionnumber: p.version, '@odata.etag': `W/"${p.etag}"` })) });
      }
      const contentRead = new RegExp(`^/uxagentprojectfiles\\(${GUID}\\)/filecontent/\\$value`).exec(path);
      if (contentRead) {
        const fileId = contentRead[1].toLowerCase();
        const file = unpublishedVisible ? state.files.get(fileId) : [...this.publishedPages.values()].flatMap((p) => p.files).find((f) => f.id === fileId);
        if (!file || !file.content) return json(404, { error: { message: 'No file attachment found' } });
        return json(200, transport && transport.stringBodies
          ? Buffer.from(file.content.buffer, file.content.byteOffset, file.content.byteLength).toString('utf8')
          : Buffer.from(file.content));
      }
      const filesRead = /^\/uxagentprojectfiles\?/.test(path) ? [...path.matchAll(new RegExp(`_uxagentprojectid_value eq ${GUID}`, 'g'))].map((m) => m[1].toLowerCase()) : [];
      if (filesRead.length) {
        // Every row carries its project and its `versionnumber`. A plain read is the published layer: the rows as the last publish left them, each with the version the row has NOW (MEASURED: a draft-only
        // write of a file's content moves its versionnumber in the plain read too, and a publish moves the version of each row whose content changed since the last one — `publishProject`).
        const projects = new Set(filesRead);
        const files = unpublishedVisible
          ? [...state.files.values()].filter((f) => projects.has(f.projectId))
          : [...projects].flatMap((id) => ((this.publishedPages.get(id) || {}).files || []).map((f) => ({ ...f, projectId: id, version: state.files.has(f.id) ? state.files.get(f.id).version : f.version })));
        return json(200, { value: files.map((f) => ({ uxagentprojectfileid: f.id, filename: f.filename, filetype: f.filetype, versionnumber: f.version, _uxagentprojectid_value: f.projectId, '@odata.etag': `W/"${f.etag}"` })) });
      }
      const messagesRead = new RegExp(`^/agentconversationmessages\\?.*_regardingobjectid_value eq ${GUID}`).exec(path);
      if (messagesRead) {
        const regarding = messagesRead[1].toLowerCase();
        // Ordered EXACTLY as asked. `createdon` has one-second precision and every turn of one change set shares it; ties then
        // come back in PRIMARY-KEY order — SQL `uniqueidentifier` order, which compares the LAST group first (both measured).
        // Unless the request breaks ties by `versionnumber` (commit order), that is what this fake returns too.
        const tiebreak = /(\$|%24)orderby=[^&]*versionnumber(%20| )asc/i.test(path);
        const inOrder = [...state.messages.values()].filter((x) => x.regarding === regarding)
          .sort((a, b) => a.createdon.localeCompare(b.createdon) || (tiebreak ? a.version - b.version : sqlGuidOrder(a.id, b.id)));
        return json(200, { value: inOrder.map((x) => ({ agentconversationmessageid: x.id, message: x.message, messagesender: x.sender, createdon: x.createdon })) });
      }
      // By primary key — `agentconversationmessageid eq <id> or …` — as a retried push looks its turn up.
      if (/^\/agentconversationmessages\?.*agentconversationmessageid eq /.test(path)) {
        const wanted = new Set((path.match(/agentconversationmessageid eq ([0-9a-fA-F-]{36})/g) || []).map((m) => m.slice(-36).toLowerCase()));
        return json(200, { value: [...state.messages.values()].filter((x) => wanted.has(x.id)).map((x) => ({ agentconversationmessageid: x.id, message: x.message, messagesender: x.sender, _regardingobjectid_value: x.regarding })) });
      }
      return json(404, { error: { message: `no route for GET ${path}` } });
    }

    const record = body || {};
    if (method === 'POST' && path === '/PublishXml') {
      // An exec loop rather than `matchAll`, to keep one idiom with the SDK's own copy of this fake.
      const targets = /<uxagentproject>([^<]+)<\/uxagentproject>/g;
      const xml = String(record.ParameterXml || '');
      for (let match = targets.exec(xml); match !== null; match = targets.exec(xml)) this.publishProject(state, match[1].toLowerCase());
      return json(204);
    }
    if (method === 'POST' && path === '/uxagentprojects') {
      const id = String(record.uxagentprojectid || this.nextId()).toLowerCase();
      if (state.projects.has(id)) return json(412, { error: { code: '0x80040237', message: 'A record with matching key values already exists.' } });
      state.projects.set(id, { id, name: String(record.name === undefined ? '' : record.name), etag: this.nextEtag(), version: this.nextVersion(), draft: true });
      return json(204, undefined, { 'OData-EntityId': `${API}/uxagentprojects(${id})` });
    }
    if (method === 'POST' && path === '/uxagentprojectfiles') {
      const id = String(record.uxagentprojectfileid || this.nextId()).toLowerCase();
      const bind = ((/\(([^)]+)\)/.exec(String(record['uxagentprojectid@odata.bind'] || '')) || [])[1] || '').toLowerCase();
      if (!state.projects.has(bind)) return json(400, { error: { message: `project ${bind} does not exist` } });
      if (state.files.has(id)) return json(412, { error: { code: '0x80040237', message: 'A record with matching key values already exists.' } });
      state.files.set(id, { id, projectId: bind, filename: String(record.filename), filetype: Number(record.filetype), etag: this.nextEtag(), version: this.nextVersion(), draft: true });
      return json(204, undefined, { 'OData-EntityId': `${API}/uxagentprojectfiles(${id})` });
    }
    if (method === 'POST' && path === '/agentconversationmessages') {
      const regarding = ((/\(([^)]+)\)/.exec(String(record['RegardingObjectId_uxagentproject@odata.bind'] || '')) || [])[1] || '').toLowerCase();
      if (!state.projects.has(regarding)) return json(400, { error: { message: `page ${regarding} does not exist` } });
      // A client-minted primary key is honoured, and a replay of it refused — measured on the real entity.
      const id = String(record.agentconversationmessageid || this.nextId()).toLowerCase();
      if (state.messages.has(id)) return json(412, { error: { code: '0x80040237', message: 'A record with matching key values already exists.' } });
      state.messages.set(id, { id, regarding, message: String(record.message), sender: Number(record.messagesender), context: String(record.messagecontext), createdon: this.stamp(), version: this.nextVersion() });
      return json(204, undefined, { 'OData-EntityId': `${API}/agentconversationmessages(${id})` });
    }
    const contentWrite = new RegExp(`^/uxagentprojectfiles\\(${GUID}\\)/filecontent$`).exec(path);
    if (contentWrite && method === 'PATCH') {
      const file = state.files.get(contentWrite[1].toLowerCase());
      if (!file) return json(404, { error: { message: 'Does Not Exist' } });
      // The content endpoint ignores If-Match (measured: a stale token was accepted). A BRAND check, not `instanceof`.
      const bytes = ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice() : Buffer.from(String(body === undefined ? '' : body), 'utf8');
      file.content = this.mangleContent ? this.mangleContent(bytes) : bytes;
      file.contentName = headers['x-ms-file-name'];
      file.etag = this.nextEtag();
      // MEASURED: a draft-only write of a file's content moves its versionnumber — in the plain (published-layer) read as well as in the unpublished one.
      file.version = this.nextVersion();
      file.draft = true;
      return json(204);
    }
    const fileRow = new RegExp(`^/uxagentprojectfiles\\(${GUID}\\)$`).exec(path);
    if (fileRow) {
      const file = state.files.get(fileRow[1].toLowerCase());
      if (!file) return json(404, { error: { message: 'Does Not Exist' } });
      const gate = updateGate();
      if (gate) return gate;
      if (method === 'DELETE') { state.files.delete(file.id); return json(204); }
      if (method === 'PATCH') {
        file.filename = String(record.filename === undefined ? file.filename : record.filename);
        file.filetype = Number(record.filetype === undefined ? file.filetype : record.filetype);
        file.etag = this.nextEtag();
        file.version = this.nextVersion();
        file.draft = true;
        return json(204);
      }
    }
    const projectRow = new RegExp(`^/uxagentprojects\\(${GUID}\\)$`).exec(path);
    if (projectRow) {
      const project = state.projects.get(projectRow[1].toLowerCase());
      if (!project) return json(404, { error: { message: 'Does Not Exist' } });
      if (method === 'DELETE') {
        state.projects.delete(project.id);
        this.publishedPages.delete(project.id);
        for (const file of [...state.files.values()]) if (file.projectId === project.id) state.files.delete(file.id);
        return json(204);
      }
      const gate = updateGate();
      if (gate) return gate;
      project.name = String(record.name === undefined ? project.name : record.name);
      project.etag = this.nextEtag();
      // A write to the row moves its versionnumber — in the plain read as well as in the unpublished one, as a draft-only write of a file's content does — and the draft it leaves moves it again when it is published.
      project.version = this.nextVersion();
      project.draft = true;
      return json(204);
    }
    const messageRow = new RegExp(`^/agentconversationmessages\\(${GUID}\\)$`).exec(path);
    if (messageRow && method === 'DELETE') {
      return state.messages.delete(messageRow[1].toLowerCase()) ? json(204) : json(404, { error: { message: 'Does Not Exist' } });
    }
    return json(405, { error: { message: `no route for ${method} ${path}` } });
  }

  // `EntityDefinitions(LogicalName='…')[/sub]` in the raw Web API shape the SDK's metadata reader parses. `table` is the SDK's
  // own `EntityMetadata` ({ logicalName, schemaName, entitySetName, primaryNameAttribute, primaryIdAttribute, attributes: [{
  // logicalName, attributeType, attributeTypeName, choices?, maxLength?, targets? }] }).
  entityDefinitions(logicalName, sub) {
    // The page tables' own entity sets, for a read of the rows the SDK resolves through `EntityDefinitions` (`queryRecords('uxagentprojectfile', …)`).
    if (sub === '' && !this.tables.has(logicalName) && PAGE_ENTITY_SETS[logicalName]) return json(200, { LogicalName: logicalName, EntitySetName: PAGE_ENTITY_SETS[logicalName] });
    const table = this.tables.get(logicalName);
    if (!table) return json(404, { error: { message: `Could not find entity ${logicalName}` } });
    const label = (text) => ({ UserLocalizedLabel: text === undefined ? null : { Label: text } });
    const option = (choice) => ({ Value: choice.value, Label: label(choice.label), InvariantName: choice.invariantName === undefined ? null : choice.invariantName, Color: choice.color === undefined ? null : choice.color });
    if (sub === '') {
      return json(200, {
        LogicalName: table.logicalName,
        SchemaName: table.schemaName,
        DisplayName: label(table.displayName),
        Description: label(table.description),
        EntitySetName: table.entitySetName,
        IsCustomEntity: table.isCustomEntity,
        PrimaryNameAttribute: table.primaryNameAttribute,
        PrimaryIdAttribute: table.primaryIdAttribute,
        PrimaryImageAttribute: table.primaryImageAttribute === undefined ? null : table.primaryImageAttribute,
        Attributes: table.attributes.map((a) => ({
          LogicalName: a.logicalName,
          DisplayName: label(a.displayName),
          Description: label(a.description),
          AttributeType: a.attributeType,
          AttributeTypeName: { Value: a.attributeTypeName },
          IsCustomAttribute: a.isCustomAttribute,
          IsValidForUpdate: a.isValidForUpdate === undefined ? null : a.isValidForUpdate,
          IsValidForRead: a.isValidForRead === undefined ? null : a.isValidForRead,
          AttributeOf: a.attributeOf === undefined ? null : a.attributeOf,
        })),
      });
    }
    const cast = (/^\/Attributes\/Microsoft\.Dynamics\.CRM\.(\w+)$/.exec(sub) || [])[1];
    if (!cast) return json(200, { value: [] }); // relationships
    const typeName = `${cast.replace(/AttributeMetadata$/, '')}Type`;
    const of = table.attributes.filter((a) => (cast === 'LookupAttributeMetadata' ? a.targets !== undefined : a.attributeTypeName === typeName));
    switch (cast) {
      case 'StringAttributeMetadata':
        return json(200, { value: of.map((a) => ({ LogicalName: a.logicalName, MaxLength: a.maxLength })) });
      case 'LookupAttributeMetadata':
        return json(200, { value: of.map((a) => ({ LogicalName: a.logicalName, Targets: a.targets })) });
      case 'BooleanAttributeMetadata':
        return json(200, { value: of.map((a) => ({ LogicalName: a.logicalName, OptionSet: { FalseOption: option((a.choices || [])[0]), TrueOption: option((a.choices || [])[1]) } })) });
      default:
        return json(200, { value: of.map((a) => ({ LogicalName: a.logicalName, OptionSet: { Options: (a.choices || []).map(option) } })) });
    }
  }
}

// An app's published and saved navigation behind the same transport — what the REAL bundle's app reads and writes need to find, laid over a page server (above),
// so a test can run a page placement end to end: the app's row, its sitemap and the component rows that name it, the default public view of `account`, and the
// two layers an app has — the SAVED one (what an edit changes) and the PUBLISHED one (what runs, and what `PublishXml` copies the saved one to). `publishFailures`
// is how many `PublishXml` calls for the app answer 503 before one succeeds: a placement whose navigation was SAVED and whose publish did not finish.
//
//   const { http, state } = appTransport(server, { publishFailures: 1 });
//   state.xml / state.publishedXml   the saved and the published sitemap XML (a page is in the app that runs only when publishedXml names it)
//   state.publishAttempts            `PublishXml` calls made for the app
//   state.writes                     the sitemap, app-row and component writes, in order: { kind: 'sitemap' | 'app' | 'components', body }
//   state.views                      the view ids now in the app's components
// The shapes are the raw Web API ones the SDK parses, as the SDK's own fake answers them: a row set is `{ value: [...] }`, a single row is the row, and every
// answer carries the etag the SDK echoes back as `If-Match`.
const APP_ID = '22222222-2222-4222-8222-222222222222';
const APP_LAYER_ID = '33333333-3333-4333-8333-333333333333';
const APP_SITEMAP_ID = '44444444-4444-4444-8444-444444444444';
const APP_EXISTING_PAGE_ID = '55555555-5555-4555-8555-555555555555';
const APP_VIEW_ID = '66666666-6666-4666-8666-666666666666';

function appTransport(server, { publishFailures = 0, appId = APP_ID, existingPageId = APP_EXISTING_PAGE_ID } = {}) {
  const pageHttp = server.http();
  const initial = `<SiteMap><Area Id="a"><Titles><Title LCID="1033" Title="Main"/></Titles><Group Id="g"><Titles><Title LCID="1033" Title="Pages"/></Titles><SubArea Id="old" GenPageId="${existingPageId}"><Titles><Title LCID="1033" Title="Existing"/></Titles></SubArea></Group></Area></SiteMap>`;
  const state = { xml: initial, publishedXml: initial, version: 1, publishAttempts: 0, failures: publishFailures, views: new Set(), writes: [] };
  const reply = (body, status = 200) => ({ status, headers: { ETag: `W/"${state.version}"` }, body });
  const mapRow = (xml) => ({ sitemapid: APP_SITEMAP_ID, sitemapname: 'Review', sitemapnameunique: 'contoso_review', sitemapxml: xml, '@odata.etag': `W/"${state.version}"` });
  const appRow = () => ({
    appmoduleid: appId, appmoduleidunique: APP_LAYER_ID, name: 'Review', uniquename: 'contoso_review', description: '',
    // 0 = published, 1 = a saved layer that is not: the signal the SDK reads to know an unpublished edit exists.
    componentstate: state.xml === state.publishedXml ? 0 : 1,
    '@odata.etag': `W/"${state.version}"`,
  });
  const http = {
    ...pageHttp,
    get: async (url, options) => {
      const parsed = new URL(url);
      const route = parsed.pathname.replace(/^\/api\/data\/v[0-9.]+/, '');
      const entity = /\/EntityDefinitions\(LogicalName='([^']+)'\)/.exec(route);
      if (entity && ['appmodule', 'appmodulecomponent', 'sitemap', 'savedquery'].includes(entity[1])) {
        const sets = { appmodule: 'appmodules', appmodulecomponent: 'appmodulecomponents', sitemap: 'sitemaps', savedquery: 'savedqueries' };
        return reply({ LogicalName: entity[1], EntitySetName: sets[entity[1]] });
      }
      if (/^\/appmodulecomponents\b/.test(route)) {
        // componenttype 26 = savedquery (a view), 1 = entity, 62 = sitemap.
        const filter = parsed.searchParams.get('$filter') || '';
        const rows = filter.includes('componenttype eq 26')
          ? [...state.views].map((objectid) => ({ objectid, componenttype: 26 }))
          : filter.includes('componenttype eq 1') ? [] : [{ objectid: APP_SITEMAP_ID, componenttype: 62 }];
        return reply({ value: rows });
      }
      if (/^\/appmodules\b/.test(route)) return reply(route === `/appmodules(${appId})` ? appRow() : { value: [appRow()] });
      if (/^\/sitemaps\b/.test(route)) {
        // The saved layer is read through RetrieveUnpublished…; without it the PUBLISHED one.
        const row = mapRow(/RetrieveUnpublished/.test(route) ? state.xml : state.publishedXml);
        return reply(route === `/sitemaps(${APP_SITEMAP_ID})` ? row : { value: [row] });
      }
      if (/^\/savedqueries\b/.test(route)) return reply({ value: [{ savedqueryid: APP_VIEW_ID, isdefault: true, querytype: 0, returnedtypecode: 'account' }] });
      // The app push checks that every page its navigation names exists (drafts included), by one RetrieveUnpublishedMultiple over their ids.
      if (/^\/uxagentprojects\/.*RetrieveUnpublishedMultiple/.test(route)) {
        const filter = parsed.searchParams.get('$filter') || '';
        return reply({ value: [...server.state.projects.values()].filter((p) => !filter || filter.includes(p.id)).map((p) => ({ uxagentprojectid: p.id, name: p.name })) });
      }
      return pageHttp.get(url, options);
    },
    post: async (url, body, options) => {
      if (url.endsWith('/PublishXml') && /<appmodules>/.test(body.ParameterXml || '')) {
        state.publishAttempts += 1;
        if (state.failures > 0) { state.failures -= 1; return reply({ error: { message: 'PublishXml unavailable' } }, 503); }
        state.publishedXml = state.xml;
        return reply({}, 204);
      }
      if (url.endsWith('/AddAppComponents')) {
        state.writes.push({ kind: 'components', body });
        for (const component of body.Components || []) if (component.savedqueryid) state.views.add(component.savedqueryid.toLowerCase());
        return reply({}, 204);
      }
      return pageHttp.post(url, body, options);
    },
    patch: async (url, body, options) => {
      if (/\/sitemaps\(/.test(url)) {
        state.writes.push({ kind: 'sitemap', body });
        state.xml = body.sitemapxml;
        state.version += 1;
        return reply({ sitemapid: APP_SITEMAP_ID, '@odata.etag': `W/"${state.version}"` });
      }
      if (/\/appmodules\(/.test(url)) {
        state.writes.push({ kind: 'app', body });
        return reply({}, 204);
      }
      return pageHttp.patch(url, body, options);
    },
  };
  return { http, state };
}

module.exports = { FakeGenPageServer, INSTANCE, API, ACCOUNT_TABLE, batchEnvelope, appTransport, APP_ID, APP_EXISTING_PAGE_ID, APP_VIEW_ID };
