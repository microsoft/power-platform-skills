'use strict';
// lib/sdk-failure-scrub.js — the access tokens a process sent, taken out of what an SDK raises, where it leaves the SDK.
//
// The HTTP client takes the token out of every answer that is not a success, and out of a transport failure's text. A SUCCESS is the caller's data, so it is returned byte for byte — and a change set the service
// refuses as a whole is a success (HTTP 200, with the one part that failed), which the SDK quotes into the error it raises. These tests hold the rule that closes it without touching the answer: the token is taken out
// of the text the SDK DECODED, wherever an error leaves it (its message, its stack, its properties, the body it kept), by matching the token as the text spells it — literally, folded onto several lines, or with a
// JSON escape left in it — and an error or a result that holds no token is the very object it was.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scrubSpelled, scrubFailure, guardSdkFailures } = require('../lib/sdk-failure-scrub.js');
const { createAzHttpClient, scrub, sentTokens, needlesOf, TOKEN_MARKER } = require('../lib/sdk-http-client.js');
const { leaksIn } = require('./helpers/token-leaks.js');

// A token the way Azure issues one — three base64url parts joined by dots — and synthetic: each part is at least 24 characters, so each is taken out on its own.
const PARTS = ['syntheticHeaderPartNotARealCredential', 'syntheticPayloadPartNotARealCredential', 'syntheticSignaturePartNotARealCredential'];
const TOKEN = PARTS.join('.');
const OTHER = ['otherHeaderPartNotARealCredentialAAA', 'otherPayloadPartNotARealCredentialBBB', 'otherSignaturePartNotARealCredentialC'].join('.');
const SECRETS = [TOKEN, ...PARTS];
const MARK = '<token>';

// ── The matcher: a token as the decoded text spells it ───────────────────────────────────────────────────────────────────────────────────────────────────

test('a token is taken out wherever the text has it, whole or by a part of 24 characters or more — exactly what the one scrubber does for a text that spells it plainly', () => {
  assert.equal(scrubSpelled(`Rejected bearer ${TOKEN} for this write`, [TOKEN]), `Rejected bearer ${MARK} for this write`);
  for (const part of PARTS) assert.equal(scrubSpelled(`the part ${part} is not valid`, [TOKEN]), `the part ${MARK} is not valid`, part);
  assert.equal(scrubSpelled(`${TOKEN} and ${TOKEN}`, [TOKEN]), `${MARK} and ${MARK}`);
  assert.equal(scrubSpelled(`a ${PARTS[0]}.${PARTS[2]} b`, [TOKEN]), `a ${MARK}.${MARK} b`);
  // A part shorter than 24 characters would be taken out of ordinary words, so it is left alone, as the scrubber leaves it.
  const short = 'aaa.bbb.ccc-and-a-longer-opaque-token-value';
  assert.equal(scrubSpelled('aaa and bbb and ccc', [short]), 'aaa and bbb and ccc');
  assert.equal(scrubSpelled(`bearer ${short}`, [short]), `bearer ${MARK}`);
  const texts = [`x ${TOKEN} y ${OTHER}`, `${PARTS[1]}${OTHER}`, `[${PARTS[0]}] (${OTHER.split('.')[2]})`, 'no secret here', ''];
  for (const text of texts) assert.equal(scrubSpelled(text, [TOKEN, OTHER]), [TOKEN, OTHER].reduce((out, token) => scrub(out, token), text), JSON.stringify(text));
});

test('a text that holds no token is the very string it was — whatever else it holds: line breaks, escapes, white space, a near miss', () => {
  // A near miss of the token spoils each of its parts (a part of 24 characters or more is taken out on its own, so one left whole would be).
  const nearMiss = PARTS.map((part) => `${part.slice(0, 12)}X${part.slice(13)}`).join('.');
  const texts = ['', 'plain', `line one\r\nline two \\u0073 \\/ \\n ${nearMiss}`, ' \t\r\n ', PARTS[0].slice(0, 23), `${PARTS[0].slice(0, 23)}x${PARTS[0].slice(23)}`, `${PARTS[0]}`.split('').reverse().join('')];
  for (const text of texts) assert.equal(scrubSpelled(text, [TOKEN]), text, JSON.stringify(text));
  assert.equal(scrubSpelled('anything', []), 'anything', 'no token, nothing to take out');
  assert.equal(scrubSpelled(`bearer ${TOKEN}`, ['']), `bearer ${TOKEN}`, 'an empty token is no token');
  assert.equal(scrubSpelled(`bearer ${TOKEN}`, [undefined, null]), `bearer ${TOKEN}`);
});

const FOLDS = ['\r\n ', '\n ', '\r\n\t', '\n', '\r\n', '  \r\n   ', ' ', '\n\n'];

test('a token folded onto several lines — the obsolete line folding of RFC 9112 §5.2, or a column wrapped at any width — is taken out from its first character to its last', () => {
  for (const fold of FOLDS) {
    for (const width of [1, 8, 76]) {
      const folded = TOKEN.match(new RegExp(`.{1,${width}}`, 'g')).join(fold);
      assert.equal(scrubSpelled(`Rejected bearer ${folded} for this write`, [TOKEN]), `Rejected bearer ${MARK} for this write`, `${JSON.stringify(fold)} every ${width}`);
    }
  }
  // Each part of the token can be folded on its own, and a text can hold both the folded spelling and the plain one.
  const foldedPart = PARTS[1].match(/.{1,5}/g).join('\r\n ');
  assert.equal(scrubSpelled(`one ${foldedPart} two ${PARTS[0]} three`, [TOKEN]), `one ${MARK} two ${MARK} three`);
  // The line break before and after the token is not part of it.
  assert.equal(scrubSpelled(`before\r\n${TOKEN.match(/.{1,9}/g).join('\r\n ')}\r\nafter`, [TOKEN]), `before\r\n${MARK}\r\nafter`);
});

test('a JSON escape left in the decoded text — a body that was escaped twice — is read as the character it spells: \\u in either case, \\/ and the white space \\r \\n \\t', () => {
  const escape = (char, upper = false) => { const hex = char.charCodeAt(0).toString(16).padStart(4, '0'); return `\\u${upper ? hex.toUpperCase() : hex}`; };
  const initials = PARTS.map((part) => `${escape(part[0])}${part.slice(1)}`).join('.');
  assert.equal(scrubSpelled(`The supplied literal spelling was ${initials}`, [TOKEN]), `The supplied literal spelling was ${MARK}`);
  for (const upper of [false, true]) {
    const everyThird = [...TOKEN].map((char, i) => (i % 3 === 0 ? escape(char, upper) : char)).join('');
    assert.equal(scrubSpelled(`bearer ${everyThird}.`, [TOKEN]), `bearer ${MARK}.`, `upper ${upper}`);
  }
  const everyCharacter = [...TOKEN].map((char) => escape(char)).join('');
  assert.equal(scrubSpelled(everyCharacter, [TOKEN]), MARK);
  // A token that holds a slash (an opaque one can) may be written `\/`.
  const slashed = 'opaque/token/with/slashes/in/it/and-enough-characters';
  assert.equal(scrubSpelled(`bearer ${slashed.replace(/\//g, '\\/')}`, [slashed]), `bearer ${MARK}`);
  // The folds themselves can be escaped: a JSON body inside a JSON body folds with the characters `\r\n`, not with a line break.
  const escapedFolds = TOKEN.match(/.{1,8}/g).join('\\r\\n ');
  assert.equal(scrubSpelled(`bearer ${escapedFolds}`, [TOKEN]), `bearer ${MARK}`);
  // Folds and escapes in one spelling.
  const both = [...TOKEN].map((char, i) => (i % 5 === 0 ? escape(char) : char) + (i % 7 === 0 ? '\r\n ' : '')).join('');
  assert.equal(scrubSpelled(`bearer ${both} end`, [TOKEN]), `bearer ${MARK} end`);
  // A backslash that is not an escape of those is a backslash, and an incomplete \u is no character at all.
  assert.equal(scrubSpelled('C:\\path\\u12 and \\x', [TOKEN]), 'C:\\path\\u12 and \\x');
});

test('the text around a token is kept as it was — multi-byte characters, surrogate pairs, the escapes and white space beside it — and spellings that only touch stay two markers, as plain ones do', () => {
  const text = `Accès refusé 日本語 🧪 \\u00e9 ${TOKEN.match(/.{1,10}/g).join('\n ')} — fin \\/ 🧪`;
  assert.equal(scrubSpelled(text, [TOKEN]), `Accès refusé 日本語 🧪 \\u00e9 ${MARK} — fin \\/ 🧪`);
  assert.equal(scrubSpelled(`${TOKEN}${TOKEN}`, [TOKEN]), `${MARK}${MARK}`, 'plain spellings are each taken out, as the one scrubber takes them');
  const folded = TOKEN.match(/.{1,10}/g).join('\n ');
  assert.equal(scrubSpelled(`${folded}${folded}`, [TOKEN]), `${MARK}${MARK}`, 'and so are folded ones');
  assert.equal(scrubSpelled(`${TOKEN} ${TOKEN}`, [TOKEN]), `${MARK} ${MARK}`);
  assert.equal(scrubSpelled(`${TOKEN}\n${OTHER}`, [TOKEN, OTHER]), `${MARK}\n${MARK}`);
  // White space inside a token is ignored wherever it is: a column wrapped with a plain space is the token too.
  assert.equal(scrubSpelled(`bearer ${PARTS[0].slice(0, 23)} ${PARTS[0].slice(23)} end`, [TOKEN]), `bearer ${MARK} end`);
});

test('a token is found in a text of any size in time that grows with the text — a long text, and a text that is nearly the token over and over', () => {
  const filler = 'The platform answered with a diagnostic that says nothing about credentials.\r\n';
  const big = filler.repeat(30000);
  const middle = big.length / 2;
  const started = Date.now();
  assert.equal(scrubSpelled(`${big.slice(0, middle)}${TOKEN.match(/.{1,50}/g).join('\r\n ')}${big.slice(middle)}`, [TOKEN]), `${big.slice(0, middle)}${MARK}${big.slice(middle)}`);
  assert.equal(scrubSpelled(big, [TOKEN]), big);
  // The text that is the needle's first 2,999 characters over and over: a matcher that restarts at every character takes seconds on it.
  const needle = `${'a'.repeat(2999)}Z`;
  const nearly = 'a'.repeat(65536);
  assert.equal(scrubSpelled(nearly, [needle]), nearly);
  assert.equal(scrubSpelled(`${nearly}${needle}`, [needle]), `${nearly}${MARK}`);
  assert.ok(Date.now() - started < 15000, 'a linear scan: ~4 MB and a worst case for a restarting one finish in a moment');
});

test('a literal match is not enough for the decoded text — the one scrubber leaves a folded token and a double-escaped one in it, which is why the guard reads the spelling', () => {
  const folded = `Rejected bearer ${TOKEN.match(/.{1,8}/g).join('\r\n ')}`;
  const escaped = `The supplied literal spelling was ${PARTS.map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, '0')}${part.slice(1)}`).join('.')}`;
  for (const text of [folded, escaped]) {
    assert.ok(leaksIn(scrub(text, TOKEN), SECRETS).length > 0, 'the plain scrubber takes out nothing: the token can still be read out of what it returns');
    assert.deepEqual(leaksIn(scrubSpelled(text, [TOKEN]), SECRETS), []);
  }
});

// The matcher against a plain reference: the text normalized into a view (white space dropped, escapes decoded, every character remembering where it came from) and searched with indexOf. The two share no code.
function reference(text, tokens) {
  const needles = [...new Set(tokens.filter(Boolean).flatMap((token) => needlesOf(token)))].filter((needle) => !/[ \t\r\n\\]/.test(needle));
  const view = [];
  const from = [];
  const to = [];
  for (let i = 0; i < text.length;) {
    let code = text.charCodeAt(i);
    let width = 1;
    if (code === 0x5c) {
      const next = text[i + 1];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { code = parseInt(text.slice(i + 2, i + 6), 16); width = 6; }
      else if (next === '/') { code = 0x2f; width = 2; }
      else if (next === 'r' || next === 'n' || next === 't') { code = 0x20; width = 2; }
    }
    const start = i;
    i += width;
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    view.push(String.fromCharCode(code));
    from.push(start);
    to.push(i);
  }
  const haystack = view.join('');
  const spans = [];
  for (const needle of needles) for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) spans.push([from[at], to[at + needle.length - 1]]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  let out = '';
  let at = 0;
  for (const [start, end] of merged) { out += text.slice(at, start) + MARK; at = end; }
  out += text.slice(at);
  return tokens.reduce((current, token) => (token ? scrub(current, token) : current), out);
}

// A small seeded generator, so a failure names a case that can be run again.
function generator(seed) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n) => Math.floor(next() * n), pick: (list) => list[Math.floor(next() * list.length)] };
}

test('the matcher agrees with a plain reference over a few thousand random texts: tokens spelled with folds and escapes, near misses, noise, and two tokens at once', () => {
  const NOISE = ['a', 'Z', '0', '9', '.', '-', '_', '/', ' ', '\n', '\r\n', '\t', '\\', 'u', '0073', '\\u0041', '\\/', '\\n', 'é', '日', '🧪', '<token>', 'Bearer ', '"', '{', '}'];
  const GAPS = ['', '', '', ' ', '\n', '\r\n ', '\t', '\\r\\n', '\\n ', '\n\n', '   '];
  const tokens = [TOKEN, OTHER, 'aaa.bbb.ccc-and-a-longer-opaque-token-value'];
  for (let seed = 1; seed <= 2500; seed += 1) {
    const random = generator(seed);
    let text = '';
    for (let piece = 0; piece < 1 + random.int(6); piece += 1) {
      const roll = random.next();
      if (roll < 0.45) {
        const token = random.pick(tokens);
        const chars = [...(random.next() < 0.3 ? token.split('.')[random.int(3)] : token)];
        if (random.next() < 0.2) chars[random.int(chars.length)] = 'Q';
        const gapRate = random.next() * 0.5;
        const escapeRate = random.next() * 0.3;
        text += chars.map((char) => {
          const spelled = random.next() < escapeRate ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')[random.next() < 0.5 ? 'toUpperCase' : 'toLowerCase']()}` : (char === '/' && random.next() < 0.5 ? '\\/' : char);
          return spelled + (random.next() < gapRate ? random.pick(GAPS) : '');
        }).join('');
      } else {
        for (let i = 0; i < 1 + random.int(8); i += 1) text += random.pick(NOISE);
      }
    }
    assert.equal(scrubSpelled(text, tokens), reference(text, tokens), `seed ${seed}: ${JSON.stringify(text)}`);
  }
});

// ── The walk: an error, and everything it holds ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The SDK's ConnectionError, as the bundle builds it: the message names the status and the address and quotes the body; `cause` is NOT enumerable and not writable (the body, or the transport's own error).
function connectionError(quoted, cause) {
  const error = new Error(`HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.2/workflows(1): ${quoted}`);
  error.name = 'ConnectionError';
  error.code = 'CONNECTION_ERROR';
  error.statusCode = 403;
  error.url = 'https://contoso.crm.dynamics.com/api/data/v9.2/workflows(1)';
  Object.defineProperty(error, 'cause', { value: cause, enumerable: false, writable: false, configurable: true });
  return error;
}

test('an error is cleaned where it stands — the same object, its message, its stack, its properties and the body it kept — and keeps its class, its code, its status and what it keeps in a symbol', () => {
  const kept = Symbol.for('cds-maker-sdk.partialWriteTokens');
  const body = { error: { code: '0x80040220', message: `Rejected bearer ${TOKEN}`, details: [`list ${PARTS[1]}`, { note: PARTS[2] }] }, [TOKEN]: 'echoed header', fine: 'untouched' };
  const error = connectionError(`Rejected bearer ${TOKEN}`, body);
  error[kept] = { memberEtags: { a: 'W/"1"' }, note: `symbol ${TOKEN}` };
  error.detail = `detail ${TOKEN.match(/.{1,12}/g).join('\r\n ')}`;
  const before = Object.getOwnPropertyDescriptor(error, 'cause');
  const out = scrubFailure(error, [TOKEN]);
  assert.equal(out, error, 'the very error');
  assert.deepEqual(leaksIn(error, SECRETS), [], 'nothing it holds spells the token');
  assert.equal(error.message, `HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.2/workflows(1): Rejected bearer ${MARK}`);
  assert.equal(error.stack.split('\n')[0].endsWith(`: ${error.message}`), true, 'the stack says what the message says: the first line of an error\'s stack is its name and its message');
  assert.deepEqual([error.name, error.code, error.statusCode, error.url], ['ConnectionError', 'CONNECTION_ERROR', 403, 'https://contoso.crm.dynamics.com/api/data/v9.2/workflows(1)']);
  assert.equal(error.detail, `detail ${MARK}`);
  assert.equal(error.cause, body, 'the body it kept is the same object');
  assert.deepEqual(body, { error: { code: '0x80040220', message: `Rejected bearer ${MARK}`, details: [`list ${MARK}`, { note: MARK }] }, [MARK]: 'echoed header', fine: 'untouched' });
  assert.deepEqual(error[kept], { memberEtags: { a: 'W/"1"' }, note: `symbol ${MARK}` });
  const after = Object.getOwnPropertyDescriptor(error, 'cause');
  assert.deepEqual([after.enumerable, after.writable, after.configurable], [before.enumerable, before.writable, before.configurable], 'the property is as the SDK made it: hidden and read-only');
});

test('a body the SDK kept as text, and the error beneath it — a transport\'s own, or the one a wrapper kept — are cleaned too, to any depth the chain goes', () => {
  const transport = new Error(`Request failed: socket hang up while sending ${TOKEN}`);
  transport.code = 'ECONNRESET';
  const wrapped = connectionError(`Rejected ${PARTS[0]}`, transport);
  const outer = new Error(`the build stopped: ${wrapped.message}`, { cause: wrapped });
  const text = connectionError(`plain ${TOKEN}`, `the body was ${TOKEN.match(/.{1,6}/g).join('\n')}`);
  scrubFailure(outer, [TOKEN]);
  scrubFailure(text, [TOKEN]);
  assert.deepEqual([leaksIn(outer, SECRETS), leaksIn(text, SECRETS)], [[], []]);
  assert.equal(outer.cause, wrapped);
  assert.equal(wrapped.cause, transport);
  assert.equal(transport.code, 'ECONNRESET', 'Node\'s own code is what it was');
  assert.equal(text.cause, `the body was ${MARK}`, 'a cause that is text is replaced by the clean text, as read-only as it was');
  assert.equal(Object.getOwnPropertyDescriptor(text, 'cause').writable, false);
  const aggregate = new AggregateError([new Error(`one ${TOKEN}`), connectionError(`two ${TOKEN}`)], `many ${TOKEN}`);
  scrubFailure(aggregate, [TOKEN]);
  assert.deepEqual(leaksIn(aggregate, SECRETS), []);
});

test('what is thrown that is not an error is cleaned as it is: text comes back clean, an object is cleaned where it stands, anything else is returned as it is', () => {
  assert.equal(scrubFailure(`bearer ${TOKEN}`, [TOKEN]), `bearer ${MARK}`);
  const plain = { message: `bearer ${TOKEN}`, list: [TOKEN] };
  assert.equal(scrubFailure(plain, [TOKEN]), plain);
  assert.deepEqual(plain, { message: `bearer ${MARK}`, list: [MARK] });
  for (const value of [undefined, null, 42, true, Buffer.from(TOKEN)]) assert.equal(scrubFailure(value, [TOKEN]), value);
  assert.equal(Buffer.from(TOKEN).toString(), TOKEN, 'bytes are bytes: not decoded into something else');
});

test('an error that holds no token is returned untouched — and with no token to look for, nothing is read at all: not a getter, not a property', () => {
  const error = connectionError('plain', { error: { message: 'plain' } });
  const snapshot = JSON.stringify([error.message, error.stack, error.cause]);
  assert.equal(scrubFailure(error, [TOKEN]), error);
  assert.equal(JSON.stringify([error.message, error.stack, error.cause]), snapshot);
  const trap = new Error('trap');
  Object.defineProperty(trap, 'lazy', { get() { throw new Error('a getter was read'); }, enumerable: true });
  assert.equal(scrubFailure(trap, []), trap, 'no token: no walk');
  assert.equal(scrubFailure(trap, [TOKEN]), trap, 'and with one, a getter is still never run');
});

test('a structure that points back to itself, or goes deeper than a real answer does, or cannot be written, does not stop the walk', () => {
  const cyclic = { note: TOKEN };
  cyclic.self = cyclic;
  cyclic.list = [cyclic, { again: cyclic, text: PARTS[0] }];
  const error = connectionError(`bearer ${TOKEN}`, cyclic);
  scrubFailure(error, [TOKEN]);
  assert.equal(cyclic.note, MARK);
  assert.equal(cyclic.self, cyclic);
  assert.equal(cyclic.list[1].text, MARK);

  let deep = { leaf: TOKEN };
  for (let i = 0; i < 400; i += 1) deep = { next: deep };
  const tooDeep = connectionError('deep', deep);
  scrubFailure(tooDeep, [TOKEN]);
  assert.deepEqual(leaksIn(tooDeep, SECRETS), [], 'what is too deep to walk is replaced, never left with a token in it');

  const frozen = connectionError(`bearer ${TOKEN}`, { body: TOKEN });
  Object.defineProperty(frozen, 'message', { value: frozen.message, writable: false, configurable: false });
  Object.freeze(frozen.cause);
  assert.doesNotThrow(() => scrubFailure(frozen, [TOKEN]));
  assert.equal(frozen.url.includes(TOKEN), false);
  assert.equal(frozen.stack.includes(TOKEN), false, 'what can be written is: the stack is');
});

// ── The boundary: an SDK whose every method hands its errors over clean ───────────────────────────────────────────────────────────────────────────────────

// An SDK in the shape of the bundle's: a class whose methods are async, or return at once, with state of its own that only its own methods may read, and a raw Dataverse client among its members.
class FakeSdk {
  #calls = 0;
  constructor(failure) {
    this.failure = failure;
    this.dataverse = { get: async () => ({ status: 200, body: 'raw client' }) };
  }
  async rejects() { this.#calls += 1; throw this.failure(); }
  throwsNow() { throw this.failure(); }
  async resolvesWithErrors() { return { saved: false, error: this.failure(), results: [{ publish: { kind: 'failed', error: this.failure() } }], fine: { n: 1 } }; }
  async resolvesClean() { return { saved: true, list: [1, 2, { a: 3 }] }; }
  returnsNow() { return { immediate: true }; }
  returnsText() { return `bearer ${TOKEN}`; }
  calls() { return this.#calls; }
  self() { return this; }
  async inner() { throw this.failure(); }
  async outer() {
    try { await this.inner(); return { sawToken: false }; } catch (error) { return { sawToken: error.message.includes(TOKEN) }; }
  }
  thenable() { return { then: (resolve) => resolve({ error: this.failure() }) }; }
}

const failing = () => connectionError(`Rejected bearer ${TOKEN}`, { error: { message: TOKEN } });

test('an SDK made over the guard rejects with the very error it raised, clean — and the error keeps its class, its code and its status', async () => {
  const raw = new FakeSdk(failing);
  const sdk = guardSdkFailures(raw, () => [TOKEN]);
  const error = await sdk.rejects().then(() => null, (e) => e);
  assert.ok(error instanceof Error);
  assert.deepEqual(leaksIn(error, SECRETS), []);
  assert.deepEqual([error.name, error.code, error.statusCode], ['ConnectionError', 'CONNECTION_ERROR', 403]);
  assert.match(error.message, /Rejected bearer <token>$/);
  assert.equal(raw.calls(), 1, 'the method ran once, on the SDK itself');
  const sync = (() => { try { sdk.throwsNow(); } catch (e) { return e; } return null; })();
  assert.ok(sync);
  assert.deepEqual(leaksIn(sync, SECRETS), [], 'a method that throws before it returns is guarded as one that rejects');
});

test('the errors an SDK returns in a result — a push that did not save, a publish that failed, one entry of a list — are cleaned where they stand, and the result is the very object it was', async () => {
  const sdk = guardSdkFailures(new FakeSdk(failing), () => [TOKEN]);
  const result = await sdk.resolvesWithErrors();
  assert.deepEqual(leaksIn(result, SECRETS), []);
  assert.equal(result.saved, false);
  assert.deepEqual(result.fine, { n: 1 });
  assert.match(result.results[0].publish.error.message, /Rejected bearer <token>$/);
  const clean = await sdk.resolvesClean();
  assert.deepEqual(clean, { saved: true, list: [1, 2, { a: 3 }] });
  const thenable = await sdk.thenable();
  assert.deepEqual(leaksIn(thenable, SECRETS), [], 'a thenable that is not a promise is awaited as one');
  assert.deepEqual(sdk.returnsNow(), { immediate: true });
  assert.equal(sdk.returnsText(), `bearer ${TOKEN}`, 'a text a method returns is its data: it is never rewritten, only an error is');
});

test('an Error is found in a result however long the list beside it is — a hundred thousand rows are read through, none of them touched, and the failure of the component a fetch skipped is cleaned', async () => {
  const rows = Array.from({ length: 100000 }, (_, i) => ({ id: i, name: `row ${i}`, note: `bearer ${TOKEN}` }));
  const raw = new FakeSdk(failing);
  raw.resolvesLong = async () => ({ summaries: rows, skipped: [{ componentId: 'a', reason: 'failed', error: failing() }] });
  const sdk = guardSdkFailures(raw, () => [TOKEN]);
  const started = Date.now();
  const result = await sdk.resolvesLong();
  assert.deepEqual(leaksIn(result.skipped, SECRETS), []);
  assert.equal(result.summaries, rows);
  assert.equal(rows[99999].note, `bearer ${TOKEN}`, 'a text in a result is its data: the rows are exactly what they were');
  assert.ok(Date.now() - started < 15000, 'and reading them through takes a moment, not a build');
});

test('the guard is a transparent view of the SDK: the same members, the same identity, methods that run on the SDK itself — and a call the SDK makes to itself is not guarded', async () => {
  const raw = new FakeSdk(failing);
  const sdk = guardSdkFailures(raw, () => [TOKEN]);
  assert.ok(sdk instanceof FakeSdk);
  assert.equal(sdk.dataverse, raw.dataverse, 'a member that is no method is the member');
  assert.equal(sdk.rejects, sdk.rejects, 'and a method is the same function each time it is read');
  assert.deepEqual(Object.keys(sdk), Object.keys(raw));
  assert.equal(sdk.self(), raw, 'a method runs with the SDK as its receiver, not the guard: it reads its own private state');
  assert.equal(typeof sdk.then, 'undefined', 'the guard is not a thenable');
  assert.equal(await sdk, sdk);
  const seen = await sdk.outer();
  assert.equal(seen.sawToken, true, 'what the SDK does with its own error, inside itself, is decided on the error as it was');
  const replaced = async () => 'replaced';
  sdk.rejects = replaced;
  assert.equal(await sdk.rejects(), 'replaced', 'a member can be replaced through the guard, as a test replaces one');
  assert.equal(raw.rejects, replaced);
  const frozenMethod = () => 'frozen';
  Object.defineProperty(raw, 'fixed', { value: frozenMethod, writable: false, configurable: false });
  assert.equal(sdk.fixed, frozenMethod, 'a member the object itself holds read-only is returned as it is: the proxy may not answer another value for it');
  assert.equal(sdk.constructor, FakeSdk);
  assert.equal(sdk.hasOwnProperty('dataverse'), true);
});

test('with no token to look for the guard reads nothing: an error and a result are what the SDK made', async () => {
  const error = failing();
  const sdk = guardSdkFailures(new FakeSdk(() => error), () => []);
  assert.equal(await sdk.rejects().then(() => null, (e) => e), error);
  assert.match(error.message, new RegExp(TOKEN), 'it was not touched');
  const result = await sdk.resolvesWithErrors();
  assert.equal(result.error, error);
  const registryEmpty = guardSdkFailures(new FakeSdk(() => error));
  assert.equal(await registryEmpty.rejects().then(() => null, (e) => e), error, 'the default is every token a client of this process sent: none yet, in this file');
});

test('what the guard is given that is no object is returned as it is', () => {
  for (const value of [null, undefined, 3, 'text', true]) assert.equal(guardSdkFailures(value, () => [TOKEN]), value);
});

test('every SDK a production script makes comes from the factory that applies the guard — none constructs the bundle\'s class itself, and none takes the bundle\'s own factory from the wiring', () => {
  const { scriptsMatching } = require('./helpers/production-scripts.js');
  assert.deepEqual(scriptsMatching(/new\s+MakerSdk\s*\(/), [], 'a MakerSdk made by hand is the SDK without the guard');
  assert.deepEqual(scriptsMatching(/withVendoredCompiler\s*\(/), ['lib/maker-sdk.js'], 'the plain wiring is the factory\'s own, and a test\'s seam');
  const maker = fs.readFileSync(path.join(__dirname, '..', 'lib', 'maker-sdk.js'), 'utf8');
  assert.match(maker, /guardSdkFailures\(createWired\(options\)\)/, 'and the factory hands out the SDK through the guard');
});

// ── The tokens a process sent ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('every token a client sends is remembered for the guard — the one a 401 replaced as well as the one that replaced it, and one client\'s as well as another\'s — and a value too short to be a token is not', async () => {
  const origin = 'https://contoso.crm.dynamics.com';
  const first = 'registryFirstTokenForTheGuardNotARealCredential.payload.signature';
  const second = 'registrySecondTokenForTheGuardNotARealCredential.payload.signature';
  const third = 'registryThirdTokenOfAnotherClientNotARealCredential.payload.signature';
  const reads = [];
  const answers = [{ statusCode: 401, headers: {}, body: '{}' }, { statusCode: 200, headers: {}, body: '{}' }];
  const client = createAzHttpClient(origin, {
    getToken: (_origin, options) => { reads.push(options); return reads.length === 1 ? first : second; },
    sleep: async () => {},
    request: async () => answers.shift(),
  });
  assert.equal(sentTokens().includes(first), false, 'nothing is sent yet, so nothing is remembered');
  await client.get(`${origin}/api/data/v9.2/WhoAmI`);
  assert.deepEqual([first, second].filter((token) => sentTokens().includes(token)), [first, second]);
  const other = createAzHttpClient(origin, { getToken: () => third, request: async () => ({ statusCode: 200, headers: {}, body: '{}' }) });
  await other.get(`${origin}/api/data/v9.2/WhoAmI`);
  assert.ok(sentTokens().includes(third));
  assert.equal(new Set(sentTokens()).size, sentTokens().length, 'once each');
  const short = createAzHttpClient(origin, { getToken: () => 'short-token', request: async () => ({ statusCode: 200, headers: {}, body: '{}' }) });
  await short.get(`${origin}/api/data/v9.2/WhoAmI`);
  assert.equal(sentTokens().includes('short-token'), false, 'the floor the client\'s own scrubbing has: a value shorter than 16 characters is no access token');
  // The guard's default is this list.
  const fake = new FakeSdk(() => connectionError(`Rejected bearer ${first}`, { error: { message: second } }));
  const error = await guardSdkFailures(fake).rejects().then(() => null, (e) => e);
  assert.deepEqual(leaksIn(error, [first, second]), []);
});

test('the needles of a token are the token and each of its parts of 24 characters or more, the longest first, once each — the one list the scrubber and the guard both use', () => {
  assert.deepEqual(needlesOf(TOKEN), [TOKEN, PARTS[2], PARTS[1], PARTS[0]]);
  assert.deepEqual(needlesOf('aaa.bbb.ccc-and-a-longer-opaque-token-value'), ['aaa.bbb.ccc-and-a-longer-opaque-token-value', 'ccc-and-a-longer-opaque-token-value']);
  assert.deepEqual(needlesOf('opaque-token-without-any-dot-in-it'), ['opaque-token-without-any-dot-in-it']);
  assert.deepEqual(needlesOf(`${PARTS[0]}.${PARTS[0]}`), [`${PARTS[0]}.${PARTS[0]}`, PARTS[0]]);
  assert.equal(TOKEN_MARKER, MARK);
  // The guard reads the list and the marker from the client's module and defines neither a second time.
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-failure-scrub.js'), 'utf8');
  assert.match(source, /require\('\.\/sdk-http-client\.js'\)/);
  assert.doesNotMatch(source, /MIN_TOKEN_PART_LENGTH|split\('\.'\)|'<token>'/);
});
