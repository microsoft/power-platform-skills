'use strict';
// A stand-in for the page backend (lib/genpage-sdk.js `makeGenpageSdk`) for tests of its CALLERS — download, verify, the build's pages
// phase, the standalone upload. It answers what the real backend answers, from pages held in memory, so a caller test says what it
// protects (a name read from the environment, a page created under a minted id, a read that fails) and not how a page is stored.
// The backend itself is tested in genpage-sdk*.test.js, against a stand-in SDK and against the real bundle.
//
//   const genpage = fakeGenpage({ pages: [{ pageId, name, source, dataSources, model, prompt }] });
//   genpage.calls              every call, in order: { method, args }
//   genpage.of('create')       the calls of one method
//   genpage.pages              the pages now in the environment (lower-cased id -> page), as `read` returns them
//
// Options:
//   pages           the pages the environment holds: { pageId, name, source, dataSources, model, prompt | conversation, connectorBindings,
//                   actionBindings, raw }. `raw: true` is a page the SDK holds as raw files — `read` and `update` refuse it.
//   enumerateError  a string: `enumerateEnv` answers { ok: false, error } instead of listing
//   readErrors      { [id]: Error }: `read` of that page throws it
//   newId           (args) => the id `create` mints; default a counter, 00000000-0000-4000-8000-0000000000NN. `create` takes the id in `args.pageId` instead
//                   when it is given (a resumed create), and awaits `args.beforeSend(id, { name, sourceSha256 })` before it sends
//   onCreate        (args) => void | result | throw: called by `create` once the id is known and `beforeSend` has run; a returned object is merged into the answer
//   onUpdate        (id, args) => void | result | throw: the same for `update`
//   appPages        { [appId]: [{ pageId, name }] } | (appId, options) => { ok, pages, … }: what `enumeratePages` answers
//   placement       (appId, options) => result | throw: what `placeInApp` answers; default an app edit that added every page asked for
//   removal         (appId, pageId, options) => result | throw: what `removeFromApp` answers; default a removal of one entry that left one
//   deletion        (id) => result | throw: what `delete` answers; default the page removed from `pages` and reported as deleted (`fileRows`, from the page, default 4)
//   types           a string, or (dataSources, options) => string | throw: what `runtimeTypes` answers; default `// types of <tables>`
//   language        what `baseLanguage` answers (default 1033); `languageError`: an Error it throws instead
//   left            the folders `dispose` answers it could not remove, as the real backend's `{ left }` (default none)
//   `describe` answers from `pages`: a page with `raw: true` is not editable and its tables are not known (`null`)
const DEFAULT_SOURCE = 'export default function Page() { return null; }\n';
const { sha256 } = require('../../lib/hash.js');

function fakeGenpage(options = {}) {
  const calls = [];
  const pages = new Map();
  let minted = 0;

  const toPage = (p) => ({
    id: String(p.pageId || p.id),
    name: p.name === undefined ? 'Page' : p.name,
    source: p.raw ? undefined : (p.source === undefined ? DEFAULT_SOURCE : p.source),
    dataSources: p.dataSources === undefined ? [] : p.dataSources,
    model: p.model,
    connectorBindings: p.connectorBindings,
    actionBindings: p.actionBindings,
    firstPrompt: p.prompt === undefined ? (p.firstPrompt) : p.prompt,
    conversation: p.conversation || (p.prompt === undefined ? [] : [{ sender: 'user', message: p.prompt }]),
    ...(p.fileRows === undefined ? {} : { fileRows: p.fileRows }),
    raw: Boolean(p.raw),
  });
  for (const p of options.pages || []) pages.set(String(p.pageId || p.id).toLowerCase(), toPage(p));

  const record = (method, args) => calls.push({ method, args });
  const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, transient: false }, extra);
  const found = (id) => pages.get(String(id).toLowerCase());

  const backend = {
    calls,
    pages,
    of: (method) => calls.filter((c) => c.method === method),
    disposed: 0,
    disposeArgs: [],

    async enumerateEnv() {
      record('enumerateEnv', []);
      if (options.enumerateError) return { ok: false, ids: [], error: options.enumerateError };
      const list = [...pages.values()];
      return { ok: true, ids: list.map((p) => p.id.toLowerCase()), pages: list.map((p) => ({ pageId: p.id, name: p.name })) };
    },

    async enumeratePages(appId, opts) {
      record('enumeratePages', [appId, opts]);
      const source = options.appPages;
      if (typeof source === 'function') return source(appId, opts);
      const list = (source && source[appId]) || [];
      return { ok: true, pages: list, empty: list.length === 0 };
    },

    async read(id) {
      record('read', [id]);
      if (options.readErrors && options.readErrors[String(id).toLowerCase()]) throw options.readErrors[String(id).toLowerCase()];
      const page = found(id);
      if (!page) throw fail('GENPAGE_NOT_FOUND', `page ${id} does not exist in this environment`);
      if (page.raw) throw fail('GENPAGE_NO_SOURCE', `page ${id} (${JSON.stringify(page.name)}) has no source this tool can read: it is held as raw files`);
      return { ...page };
    },

    async create(args) {
      record('create', [args]);
      // As the backend does: the id is known (given, or minted) before anything is sent, and handed to `beforeSend` first with what is about to be sent under it — a caller that has to
      // remember the id records it there.
      const pageId = args.pageId ? String(args.pageId).toLowerCase() : String(options.newId ? options.newId(args) : `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`).toLowerCase();
      const name = args.name === undefined || args.name === null || !String(args.name).trim() ? 'Generative page' : String(args.name);
      const text = typeof args.source === 'string' ? args.source : Buffer.from(args.source).toString('utf8').replace(/^\uFEFF/, '');
      if (typeof args.beforeSend === 'function') {
        try { await args.beforeSend(pageId, { name, sourceSha256: sha256(text) }); } catch (error) { throw fail(error && error.code, `generative page was not created (nothing was written): ${error && error.message}`, { outcome: 'nothing' }); }
      }
      const extra = (options.onCreate && await options.onCreate(args)) || {};
      pages.set(pageId, toPage({
        pageId, name, source: text, dataSources: Array.isArray(args.dataSources) ? args.dataSources : (args.dataSources ? String(args.dataSources).split(',') : []),
        model: args.model, prompt: args.prompt, connectorBindings: args.connectorBindings, actionBindings: args.actionBindings,
      }));
      return { pageId, name, publish: { kind: 'verified', detail: '' }, warnings: [], ...extra };
    },

    async update(id, args) {
      record('update', [id, args]);
      const extra = (options.onUpdate && await options.onUpdate(id, args)) || {};
      const page = found(id);
      if (!page) throw fail('GENPAGE_NOT_FOUND', `page ${id} does not exist in this environment — nothing was changed`, { outcome: 'nothing', pageId: id });
      if (page.raw) throw fail('GENPAGE_NO_SOURCE', `page ${id} has no source this tool can edit`, { outcome: 'nothing', pageId: id });
      const text = typeof args.source === 'string' ? args.source : Buffer.from(args.source).toString('utf8').replace(/^\uFEFF/, '');
      const unchanged = text === page.source;
      page.source = text;
      if (args.name) page.name = args.name;
      if (args.dataSources !== undefined) page.dataSources = Array.isArray(args.dataSources) ? args.dataSources : String(args.dataSources).split(',');
      if (args.model) page.model = args.model;
      return { pageId: String(id).toLowerCase(), ...(unchanged ? { unchanged: true } : {}), publish: { kind: 'verified', detail: '' }, warnings: [], ...extra };
    },

    async placeInApp(appId, opts) {
      record('placeInApp', [appId, opts]);
      if (options.placement) return options.placement(appId, opts);
      const added = ((opts && opts.pages) || []).map((p) => String(p.pageId));
      return { added, alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: added.length > 0 };
    },

    async describe(id) {
      record('describe', [id]);
      const page = found(id);
      if (!page) throw fail('GENPAGE_NOT_FOUND', `page ${id} does not exist in this environment`);
      return {
        pageId: page.id.toLowerCase(),
        name: page.name,
        editable: !page.raw,
        dataSources: page.raw ? null : [...page.dataSources],
        fileRows: page.fileRows === undefined ? 4 : page.fileRows,
        conversationMessages: page.conversation.length,
      };
    },

    async baseLanguage() {
      record('baseLanguage', []);
      if (options.languageError) throw options.languageError;
      return options.language === undefined ? 1033 : options.language;
    },

    async removeFromApp(appId, pageId, opts) {
      record('removeFromApp', [appId, pageId, opts]);
      if (options.removal) return options.removal(appId, pageId, opts);
      return { removed: [{ area: 'Main', group: 'Pages', count: 1 }], wasInNavigation: true, appEdited: true, published: true, entriesLeft: 1, provedPublished: true, warnings: [] };
    },

    async delete(id) {
      record('delete', [id]);
      if (options.deletion) return options.deletion(id);
      const page = found(id);
      if (!page) throw fail('GENPAGE_NOT_FOUND', `page ${id} does not exist in this environment`);
      pages.delete(String(id).toLowerCase());
      return { pageId: page.id.toLowerCase(), name: page.name, deleted: true, fileRows: page.fileRows === undefined ? 4 : page.fileRows, conversationMessages: page.conversation.length, historyRemoved: true, verified: true, warnings: [] };
    },

    async runtimeTypes(dataSources, opts) {
      record('runtimeTypes', [dataSources, opts]);
      if (typeof options.types === 'function') return options.types(dataSources, opts);
      return options.types === undefined ? `// types of ${dataSources.join(',')}\n` : options.types;
    },

    dispose(opts) {
      backend.disposed += 1;
      backend.disposeArgs.push(opts);
      // What the real backend answers: the folders it could not remove, each still holding page source.
      return { left: options.left || [] };
    },
  };
  return backend;
}

module.exports = { fakeGenpage, DEFAULT_SOURCE };
