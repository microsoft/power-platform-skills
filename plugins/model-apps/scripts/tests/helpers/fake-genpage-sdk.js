'use strict';
// A small in-memory stand-in for the SDK calls lib/genpage-sdk.js makes, for LOGIC tests of that module: what it does with each answer
// the SDK can give, including answers the stateful fake server (helpers/fake-genpage-server.js, which drives the REAL bundle) cannot
// produce on demand — a replayed create the SDK REPORTS as `ARTIFACT_ALREADY_EXISTS`, a `VERSION_CONFLICT`, a refusal from `updateElement`.
//
//   const sdk = new FakeSdk();
//   sdk.seedPage({ id, name, source, dataSources, conversation });      // the server's copy
//   sdk.script('push', { lose: connectionError(0, 'reset') }, 'commit');  // what the next pushes do, in order
//
// Scripts (`script(kind, ...behaviours)`), one behaviour per call of that kind, `'commit'` / the default once the list is spent:
//   push     'commit'                   the change set commits; { saved: true }
//            { lose: error }            it commits, and the ANSWER is lost: pushArtifact throws `error`
//            { drop: error }            it never reaches the server: pushArtifact throws `error`
//            { report: result }         pushArtifact answers `result` as it is (`{ saved: false, error }`)
//            (sdk, id) => …             full control: return the answer or throw
//   fetch    an Error                   fetchArtifact throws it;  (sdk, type, id) => artifact | undefined  to change the server first
//   publish  an Error / a result        publishArtifact throws it / answers it
//   list     an Error                   fetchArtifactList throws it
//   update   an Error                   updateElement / addElement throw it (the SDK refusing an edit before anything is written)
//
// A fetch hands back the SERVER'S copy and replaces the working copy with it (`overwrite`), a fetch without `overwrite` hands back
// the working copy when there is one — as the real SDK does. A push commits the working copy (and its pending turn).

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// The SDK's own error classes, from the bundle every script makes its SDK through: the backend tells a typed SdkError (what the SDK raises
// before it writes) from any other error (a filesystem error has a string `code` too), so a stand-in that threw plain objects would be
// answered as the "other" kind.
const { SdkError, ConnectionError } = require('../../lib/maker-sdk.js');

function sdkError(code, message, extra = {}) {
  return Object.assign(new SdkError(code, message), extra);
}
// The error the SDK's HTTP layer throws: `statusCode` 0 for a transport failure.
const connectionError = (statusCode, message) => new ConnectionError('https://contoso.crm.dynamics.com/api/data/v9.0/$batch', statusCode, message || `request failed (${statusCode})`);

function parsePointer(pointer) {
  return String(pointer).split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

class FakeSdk {
  constructor(options = {}) {
    this.pages = new Map();
    this.apps = new Map();
    this.local = new Map();
    this.calls = [];
    this.scripts = { push: [], fetch: [], publish: [], list: [], update: [] };
    this.records = options.records || {};
    this.createError = null;
    this.onGet = options.onGet || (async () => ({ status: 404, body: null }));
    this.dataverse = { get: async (url) => { this.calls.push({ name: 'dataverse.get', args: [url] }); return this.onGet(url); } };
  }

  seedPage(page) {
    this.pages.set(page.id, clone({ dataSources: [], conversation: [], ...page }));
    return this;
  }

  seedApp(app) {
    this.apps.set(app.id, clone(app));
    return this;
  }

  script(kind, ...behaviours) {
    this.scripts[kind].push(...behaviours);
    return this;
  }

  next(kind) {
    return this.scripts[kind].shift();
  }

  of(name) {
    return this.calls.filter((c) => c.name === name);
  }

  count(name) {
    return this.of(name).length;
  }

  storeOf(type) {
    return type === 'app' ? this.apps : this.pages;
  }

  async fetchArtifactList(type) {
    this.calls.push({ name: 'fetchArtifactList', args: [type] });
    const behaviour = this.next('list');
    if (behaviour instanceof Error) throw behaviour;
    return [...this.storeOf(type).values()].map((a) => ({ type, id: a.id, name: a.name, isDirty: false }));
  }

  async fetchArtifact(type, id, options) {
    this.calls.push({ name: 'fetchArtifact', args: [type, id, options] });
    const behaviour = this.next('fetch');
    if (behaviour instanceof Error) throw behaviour;
    if (typeof behaviour === 'function') {
      const answer = await behaviour(this, type, id);
      if (answer !== undefined) return answer;
    }
    const key = `${type}:${id}`;
    if (this.local.has(key) && !(options && options.overwrite)) return clone(this.local.get(key));
    const server = this.storeOf(type).get(id);
    if (!server) throw connectionError(404, `${type} ${id} was not found`);
    this.local.set(key, clone(server));
    return clone(server);
  }

  async createArtifact(type, definition) {
    this.calls.push({ name: 'createArtifact', args: [type, clone(definition)] });
    if (this.createError) throw this.createError;
    const art = { dataSources: [], conversation: [], ...clone(definition) };
    art.pendingTurn = art.newTurn;
    delete art.newTurn;
    art.isNew = true;
    this.local.set(`${type}:${definition.id}`, art);
    return clone(art);
  }

  workingCopy(type, id) {
    const art = this.local.get(`${type}:${id}`);
    if (!art) throw sdkError('ARTIFACT_NOT_FOUND', `no working copy of ${type} ${id}`);
    return art;
  }

  async updateElement(type, id, pointer, value) {
    this.calls.push({ name: 'updateElement', args: [type, id, pointer, clone(value)] });
    const refusal = this.next('update');
    if (refusal instanceof Error) throw refusal;
    const parts = parsePointer(pointer);
    let node = this.workingCopy(type, id);
    for (const part of parts.slice(0, -1)) node = node[part];
    node[parts[parts.length - 1]] = clone(value);
  }

  async addElement(type, id, pointer, value) {
    this.calls.push({ name: 'addElement', args: [type, id, pointer, clone(value)] });
    const refusal = this.next('update');
    if (refusal instanceof Error) throw refusal;
    const art = this.workingCopy(type, id);
    let node = art;
    for (const part of parsePointer(pointer || '')) node = node[part];
    if (pointer === '' && value && value.newTurn) {
      art.pendingTurn = clone(value.newTurn);
      const { newTurn, ...rest } = value;
      Object.assign(art, clone(rest));
      return;
    }
    if (Array.isArray(node)) node.push(clone(value));
    else Object.assign(node, clone(value));
  }

  commit(type, id) {
    const store = this.storeOf(type);
    const art = clone(this.workingCopy(type, id));
    const before = store.get(id);
    const turn = art.pendingTurn;
    delete art.pendingTurn;
    delete art.isNew;
    if (type === 'genPage') {
      art.conversation = [...((before && before.conversation) || [])];
      if (turn) {
        art.conversation.push({ sender: 'user', message: turn.prompt });
        if (turn.agentMessage) art.conversation.push({ sender: 'agent', message: turn.agentMessage });
      }
      if (art.firstPrompt === undefined && turn) art.firstPrompt = turn.prompt;
    }
    store.set(id, art);
    const working = this.workingCopy(type, id);
    working.isNew = false;
    working.pendingTurn = undefined;
    working.conversation = clone(art.conversation);
  }

  async pushArtifact(type, id) {
    this.calls.push({ name: 'pushArtifact', args: [type, id] });
    const behaviour = this.next('push') || 'commit';
    if (typeof behaviour === 'function') return behaviour(this, id);
    if (behaviour.drop) throw behaviour.drop;
    if (behaviour.report) return behaviour.report;
    if (behaviour === 'commit' || behaviour.lose) {
      // A change set that creates a page the server already holds is a replay: it is reported, not applied.
      if (this.workingCopy(type, id).isNew && this.storeOf(type).has(id) && !behaviour.lose) {
        return { type, id, saved: false, error: sdkError('ARTIFACT_ALREADY_EXISTS', `${type} ${id} already exists`) };
      }
      this.commit(type, id);
      if (behaviour.lose) throw behaviour.lose;
      return { type, id, saved: true, warnings: [] };
    }
    throw new Error(`unknown push behaviour ${JSON.stringify(behaviour)}`);
  }

  async publishArtifact(type, id, options) {
    this.calls.push({ name: 'publishArtifact', args: [type, id, options] });
    const behaviour = this.next('publish');
    if (behaviour instanceof Error) throw behaviour;
    if (behaviour !== undefined) return behaviour;
    return { type, id, shipped: true, publish: { kind: 'verified' } };
  }

  async queryRecords(entity, options) {
    this.calls.push({ name: 'queryRecords', args: [entity, options] });
    const source = this.records[entity];
    if (typeof source === 'function') return source(options);
    return source || [];
  }
}

module.exports = { FakeSdk, sdkError, connectionError, clone };
