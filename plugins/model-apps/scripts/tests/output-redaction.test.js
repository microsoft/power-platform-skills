'use strict';
// lib/output-redaction.js — the access tokens a process obtained, kept out of everything it writes.
//
// The matcher reads a text as it SPELLS a token (a character itself or a JSON escape of it, with folds between the characters), so these tests hold it against the spellings a service's diagnostic can take, against a plain
// reference that shares none of its code, and against the cost of a large text. The registry, the guard on a stream and the guard on the SDK's workspace storage are held here too; what reaches a process's descriptors and files
// is read from a real process in tests/output-token-boundary.test.js, which is where a guard that is a replaced `process.stdout.write` can be measured.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { spawnSync } = require('node:child_process');
const { redactTokens, needlesOf, guardStream, guardWorkspaceStorage, TOKEN_MARKER } = require('../lib/output-redaction.js');
const { scrub } = require('../lib/sdk-http-client.js');
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { PARTS, TOKEN, SECRETS } = require('./helpers/synthetic-token.js');
const { leaksIn } = require('./helpers/token-leaks.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const OTHER = ['otherHeaderPartNotARealCredentialAAA', 'otherPayloadPartNotARealCredentialBBB', 'otherSignaturePartNotARealCredentialC'].join('.');
const MARK = '<token>';
const unicode = (char, upper = false) => { const hex = char.charCodeAt(0).toString(16).padStart(4, '0'); return `\\u${upper ? hex.toUpperCase() : hex}`; };

// ── The matcher: a token as a text spells it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a token is taken out wherever the text has it, whole or by a part of 24 characters or more — exactly what the one scrubber does for a text that spells it plainly', () => {
  assert.equal(redactTokens(`Rejected bearer ${TOKEN} for this write`, [TOKEN]), `Rejected bearer ${MARK} for this write`);
  for (const part of PARTS) assert.equal(redactTokens(`the part ${part} is not valid`, [TOKEN]), `the part ${MARK} is not valid`, part);
  assert.equal(redactTokens(`${TOKEN} and ${TOKEN}`, [TOKEN]), `${MARK} and ${MARK}`);
  assert.equal(redactTokens(`a ${PARTS[0]}.${PARTS[2]} b`, [TOKEN]), `a ${MARK}.${MARK} b`);
  // A part shorter than 24 characters would be taken out of ordinary words, so it is left alone, as the scrubber leaves it.
  const short = 'aaa.bbb.ccc-and-a-longer-opaque-token-value';
  assert.equal(redactTokens('aaa and bbb and ccc', [short]), 'aaa and bbb and ccc');
  assert.equal(redactTokens(`bearer ${short}`, [short]), `bearer ${MARK}`);
  const texts = [`x ${TOKEN} y ${OTHER}`, `${PARTS[1]}${OTHER}`, `[${PARTS[0]}] (${OTHER.split('.')[2]})`, 'no secret here', ''];
  for (const text of texts) assert.equal(redactTokens(text, [TOKEN, OTHER]), [TOKEN, OTHER].reduce((out, token) => scrub(out, token), text), JSON.stringify(text));
});

test('a text that holds no token is the very string it was — whatever else it holds: line breaks, escapes, white space, quotes, a near miss', () => {
  // A near miss of the token spoils each of its parts (a part of 24 characters or more is taken out on its own, so one left whole would be).
  const nearMiss = PARTS.map((part) => `${part.slice(0, 12)}X${part.slice(13)}`).join('.');
  const texts = ['', 'plain', `line one\r\nline two \\u0073 \\/ \\n \\\\r ${nearMiss}`, ' \t\r\n ', PARTS[0].slice(0, 23), `${PARTS[0].slice(0, 23)}x${PARTS[0].slice(23)}`, [...PARTS[0]].reverse().join(''), "'a' +\n 'b' \"c\" `d`"];
  for (const text of texts) assert.equal(redactTokens(text, [TOKEN]), text, JSON.stringify(text));
  assert.equal(redactTokens('anything', []), 'anything', 'no token, nothing to take out');
  assert.equal(redactTokens(`bearer ${TOKEN}`, ['']), `bearer ${TOKEN}`, 'an empty token is no token');
  assert.equal(redactTokens(`bearer ${TOKEN}`, [undefined, null]), `bearer ${TOKEN}`);
  assert.equal(redactTokens(`bearer ${TOKEN}`, undefined), `bearer ${TOKEN}`);
  assert.equal(redactTokens(42, [TOKEN]), 42, 'what is not a text is returned as it is');
});

const FOLDS = ['\r\n ', '\n ', '\r\n\t', '\n', '\r\n', '  \r\n   ', ' ', '\n\n', '\u00a0', '\u2028', '\\r\\n ', '\\n', '\\r\\n\\t', '\\\\r\\\\n ', '\\u000d\\u000a ', '\\u0020'];

test('a token folded onto several lines — the obsolete line folding of RFC 9112 §5.2, a column wrapped at any width, a fold a JSON body spells with escapes — is taken out from its first character to its last', () => {
  for (const fold of FOLDS) {
    for (const width of [1, 8, 76]) {
      const folded = TOKEN.match(new RegExp(`.{1,${width}}`, 'g')).join(fold);
      assert.equal(redactTokens(`Rejected bearer ${folded} for this write`, [TOKEN]), `Rejected bearer ${MARK} for this write`, `${JSON.stringify(fold)} every ${width}`);
    }
  }
  // Each part of the token can be folded on its own, and a text can hold both the folded spelling and the plain one.
  const foldedPart = PARTS[1].match(/.{1,5}/g).join('\r\n ');
  assert.equal(redactTokens(`one ${foldedPart} two ${PARTS[0]} three`, [TOKEN]), `one ${MARK} two ${MARK} three`);
  // The line break before and after the token is not part of it.
  assert.equal(redactTokens(`before\r\n${TOKEN.match(/.{1,9}/g).join('\r\n ')}\r\nafter`, [TOKEN]), `before\r\n${MARK}\r\nafter`);
});

test('a JSON escape in the text — \\u in either case, \\/, the white space \\r \\n \\t \\f, any number of backslashes before it — is read as the character it spells', () => {
  const initials = PARTS.map((part) => `${unicode(part[0])}${part.slice(1)}`).join('.');
  assert.equal(redactTokens(`The supplied literal spelling was ${initials}`, [TOKEN]), `The supplied literal spelling was ${MARK}`);
  for (const upper of [false, true]) {
    const everyThird = [...TOKEN].map((char, i) => (i % 3 === 0 ? unicode(char, upper) : char)).join('');
    assert.equal(redactTokens(`bearer ${everyThird}.`, [TOKEN]), `bearer ${MARK}.`, `upper ${upper}`);
  }
  assert.equal(redactTokens([...TOKEN].map((char) => unicode(char)).join(''), [TOKEN]), MARK);
  // A token that holds a slash (an opaque one can) may be written `\/`.
  const slashed = 'opaque/token/with/slashes/in/it/and-enough-characters';
  assert.equal(redactTokens(`bearer ${slashed.replace(/\//g, '\\/')}`, [slashed]), `bearer ${MARK}`);
  // JSON inside JSON doubles every backslash, and so on: a run of backslashes before an escape letter is one escape.
  for (const backslashes of ['\\', '\\\\', '\\\\\\\\', '\\\\\\']) {
    const nested = [...TOKEN].map((char, i) => (i % 4 === 0 ? `${backslashes}u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char) + (i % 9 === 0 ? `${backslashes}r${backslashes}n ` : '')).join('');
    assert.equal(redactTokens(`bearer ${nested} end`, [TOKEN]), `bearer ${MARK} end`, `${backslashes.length} backslash(es)`);
  }
  // Folds and escapes in one spelling.
  const both = [...TOKEN].map((char, i) => (i % 5 === 0 ? unicode(char) : char) + (i % 7 === 0 ? '\r\n ' : '')).join('');
  assert.equal(redactTokens(`bearer ${both} end`, [TOKEN]), `bearer ${MARK} end`);
  // A backslash that is not an escape of those is a backslash, and an incomplete \u is no character at all.
  assert.equal(redactTokens('C:\\path\\u12 and \\x', [TOKEN]), 'C:\\path\\u12 and \\x');
  assert.equal(redactTokens(`${PARTS[0].slice(0, 10)}\\x${PARTS[0].slice(10)}`, [TOKEN]), `${PARTS[0].slice(0, 10)}\\x${PARTS[0].slice(10)}`, 'a backslash inside a token breaks it: it is not the token');
});

test('a long string printed the way util.inspect prints it — the pieces joined by a quote, a plus sign and a line break — is the token too', () => {
  const folded = TOKEN.match(/.{1,8}/g).join('\r\n ');
  for (const [subject, cut] of [[{ error: { message: `Rejected bearer ${folded}` } }, true], [new Error(`top ${folded}`), false], [[`bearer ${folded}`], true], [`bearer ${folded}`, true]]) {
    const printed = util.inspect(subject, { depth: 6 });
    // An Error's own message is part of its stack, which is printed as it is; a string held by anything else is cut after each line break.
    assert.equal(/' \+\n/.test(printed), cut, `inspect ${cut ? 'cut' : 'did not cut'} the string: ${printed}`);
    assert.deepEqual(leaksIn(redactTokens(printed, [TOKEN]), SECRETS), [], printed);
    assert.ok(redactTokens(printed, [TOKEN]).includes(MARK));
  }
  // The same with the other quotes, and only exactly so: a quote that is followed by something else is a quote.
  for (const quote of ["'", '"', '`']) assert.equal(redactTokens(`a ${PARTS[0].slice(0, 20)}${quote} +\n  ${quote}${PARTS[0].slice(20)} b`, [TOKEN]), `a ${MARK} b`, quote);
  assert.equal(redactTokens(`${PARTS[0].slice(0, 20)}' + 'x${PARTS[0].slice(20)}`, [TOKEN]), `${PARTS[0].slice(0, 20)}' + 'x${PARTS[0].slice(20)}`, 'a plus sign with no line break after it joins nothing');
  assert.equal(redactTokens(`${PARTS[0].slice(0, 20)}'\n'${PARTS[0].slice(20)}`, [TOKEN]), `${PARTS[0].slice(0, 20)}'\n'${PARTS[0].slice(20)}`, 'and neither does a line break with no plus sign');
  // A token that itself holds a quote reads it as a character.
  const quoted = "it's-an-opaque-token-with-a-quote-in-it";
  assert.equal(redactTokens(`bearer ${quoted} end`, [quoted]), `bearer ${MARK} end`);
  assert.equal(redactTokens(`bearer it's-an-opaque-token-with-a-quote-in-it' +\n 'x end`, [quoted]), `bearer ${MARK}' +\n 'x end`);
});

test('the text around a token is kept as it was — multi-byte characters, surrogate pairs, the escapes and white space beside it — and spellings that only touch stay two markers, as plain ones do', () => {
  const text = `Accès refusé 日本語 🧪 \\u00e9 ${TOKEN.match(/.{1,10}/g).join('\n ')} — fin \\/ 🧪`;
  assert.equal(redactTokens(text, [TOKEN]), `Accès refusé 日本語 🧪 \\u00e9 ${MARK} — fin \\/ 🧪`);
  assert.equal(redactTokens(`${TOKEN}${TOKEN}`, [TOKEN]), `${MARK}${MARK}`, 'plain spellings are each taken out, as the one scrubber takes them');
  const folded = TOKEN.match(/.{1,10}/g).join('\n ');
  assert.equal(redactTokens(`${folded}${folded}`, [TOKEN]), `${MARK}${MARK}`, 'and so are folded ones');
  assert.equal(redactTokens(`${TOKEN} ${TOKEN}`, [TOKEN]), `${MARK} ${MARK}`);
  assert.equal(redactTokens(`${TOKEN}\n${OTHER}`, [TOKEN, OTHER]), `${MARK}\n${MARK}`);
  // White space inside a token is ignored wherever it is: a column wrapped with a plain space is the token too.
  assert.equal(redactTokens(`bearer ${PARTS[0].slice(0, 23)} ${PARTS[0].slice(23)} end`, [TOKEN]), `bearer ${MARK} end`);
  // A token that has white space of its own is looked for literally, as the one scrubber looks for it.
  assert.equal(redactTokens('bearer opaque token with spaces in it end', ['opaque token with spaces in it']), `bearer ${MARK} end`);
  assert.equal(redactTokens('bearer opaque\\token\\with\\backslashes\\in it end', ['opaque\\token\\with\\backslashes\\in it']), `bearer ${MARK} end`);
});

// ── JSON stays JSON ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A small seeded generator, so a failure names a case that can be run again.
function generator(seed) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n) => Math.floor(next() * n), pick: (list) => list[Math.floor(next() * list.length)] };
}

// The VALUE of a JSON string, as the SDK holds it, with the token in it spelled in one of the ways a diagnostic spells it: whole, a part, folded, with `\uXXXX` left in the decoded text (a body that was JSON inside JSON), and with
// both. The file or the stream then holds what JSON.stringify makes of it — `\r\n` for a fold, `\\u0073` for the left-over escape.
function spelledValue(random) {
  const NOISE = ['a', ' ', '"', '\\', '\\\\', '/', 'u0041', '\n', '\r\n', '\t', 'é', '日', '🧪', "'", ' +\n', '{', ']', ',', ':'];
  const GAPS = ['', '', '', ' ', '\n', '\r\n ', '\t', '\\r\\n', '\\n ', '   '];
  const token = random.pick([TOKEN, OTHER, PARTS[1]]);
  const gapRate = random.next() * 0.5;
  const escapeRate = random.next() * 0.4;
  const spelled = [...token].map((char) => (random.next() < escapeRate ? unicode(char, random.next() < 0.5) : char) + (random.next() < gapRate ? random.pick(GAPS) : '')).join('');
  let around = '';
  for (let i = 0; i < random.int(6); i += 1) around += random.pick(NOISE);
  return `${around}${spelled}${random.pick(NOISE)}`;
}

test('JSON written with a token in it is still JSON when the token is taken out — in a string, in a key, nested, pretty-printed, and JSON inside JSON — and the value no longer holds the token', () => {
  const tokens = [TOKEN, OTHER];
  for (let seed = 1; seed <= 600; seed += 1) {
    const random = generator(seed);
    const document = { list: [spelledValue(random), { [spelledValue(random)]: spelledValue(random), n: 1 }], plain: spelledValue(random), done: true };
    document.inner = JSON.stringify({ message: spelledValue(random), deeper: JSON.stringify({ message: spelledValue(random) }) });
    for (const indent of [undefined, 2]) {
      const written = JSON.stringify(document, null, indent);
      const cleaned = redactTokens(written, tokens);
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(cleaned); }, `seed ${seed}, indent ${indent}: ${cleaned}`);
      assert.deepEqual(leaksIn(cleaned, [TOKEN, ...PARTS]), [], `seed ${seed}: ${cleaned}`);
      assert.equal(Object.keys(parsed).length, 4, 'the document keeps its shape');
      assert.equal(parsed.done, true);
    }
  }
});

// ── The matcher against a plain reference ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The text normalized into a view — white space dropped, escapes decoded, a continuation dropped, every character remembering where it came from — and searched with indexOf. It shares no code with the module.
function reference(text, tokens) {
  const needles = [...new Set(tokens.filter(Boolean).flatMap((token) => needlesOf(token)))].filter((needle) => !/[\s\\]/.test(needle));
  const alphabet = new Set(needles.join(''));
  const view = [];
  const from = [];
  const to = [];
  for (let i = 0; i < text.length;) {
    const start = i;
    let char = text[i];
    let width = 1;
    if (char === '\\') {
      let end = i;
      while (text[end] === '\\') end += 1;
      const letter = text[end];
      const hex = text.slice(end + 1, end + 5);
      if (letter === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) { char = String.fromCharCode(parseInt(hex, 16)); width = end + 5 - i; }
      else if (letter === '/') { char = '/'; width = end + 1 - i; }
      else if (letter !== undefined && 'rntf'.includes(letter)) { char = ' '; width = end + 1 - i; }
      else width = end - i;
    } else if ("\"'`".includes(char) && !alphabet.has(char)) {
      const continuation = new RegExp(`^${char}[ \\t]*\\+[ \\t]*\\r?\\n[ \\t]*${char}`).exec(text.slice(i));
      if (continuation) { char = ' '; width = continuation[0].length; }
    }
    i += width;
    if (/\s/.test(char)) continue;
    view.push(char);
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
  return tokens.filter((token) => token && needlesOf(token).some((needle) => /[\s\\]/.test(needle))).reduce((current, token) => scrub(current, token), out);
}

test('the matcher agrees with a plain reference over a few thousand random texts: tokens spelled with folds, escapes and continuations, near misses, noise, and three tokens at once', () => {
  const NOISE = ['a', 'Z', '0', '9', '.', '-', '_', '/', ' ', '\n', '\r\n', '\t', '\\', '\\\\', 'u', '0073', '\\u0041', '\\/', '\\n', '\\\\r', 'é', '日', '🧪', '<token>', 'Bearer ', '"', "'", "' +\n '", '{', '}', '\u00a0'];
  const GAPS = ['', '', '', ' ', '\n', '\r\n ', '\t', '\\r\\n', '\\n ', '\n\n', '   ', "' +\n  '", '\\\\r\\\\n ', '\\u000a'];
  const tokens = [TOKEN, OTHER, 'aaa.bbb.ccc-and-a-longer-opaque-token-value'];
  for (let seed = 1; seed <= 3000; seed += 1) {
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
          const spelled = random.next() < escapeRate ? `${random.next() < 0.3 ? '\\\\' : ''}${unicode(char, random.next() < 0.5)}` : (char === '/' && random.next() < 0.5 ? '\\/' : char);
          return spelled + (random.next() < gapRate ? random.pick(GAPS) : '');
        }).join('');
      } else {
        for (let i = 0; i < 1 + random.int(8); i += 1) text += random.pick(NOISE);
      }
    }
    assert.equal(redactTokens(text, tokens), reference(text, tokens), `seed ${seed}: ${JSON.stringify(text)}`);
  }
});

// ── Cost ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a token is found in a text of any size in time that grows with the text — a long text, a text that is nearly the token over and over, a long run of backslashes, and a text full of tokens', (t) => {
  const filler = 'The platform answered with a diagnostic that says nothing about credentials.\r\n';
  const big = filler.repeat(30000);
  const middle = big.length / 2;
  const started = Date.now();
  assert.equal(redactTokens(`${big.slice(0, middle)}${TOKEN.match(/.{1,50}/g).join('\r\n ')}${big.slice(middle)}`, [TOKEN]), `${big.slice(0, middle)}${MARK}${big.slice(middle)}`);
  assert.equal(redactTokens(big, [TOKEN]), big);
  // The text that is the needle's first 2,999 characters over and over: a matcher that restarts at every character takes seconds on it.
  const needle = `${'a'.repeat(2999)}Z`;
  const nearly = 'a'.repeat(65536);
  assert.equal(redactTokens(nearly, [needle]), nearly);
  assert.equal(redactTokens(`${nearly}${needle}`, [needle]), `${nearly}${MARK}`);
  // A run of backslashes is read once, as one item, and not again from each of them.
  const slashes = '\\'.repeat(2000000);
  assert.equal(redactTokens(`${slashes}${TOKEN}${slashes}`, [TOKEN]), `${slashes}${MARK}${slashes}`);
  assert.equal(redactTokens(`${slashes}n${slashes}u00${slashes}`, [TOKEN]), `${slashes}n${slashes}u00${slashes}`);
  // Fifty thousand tokens in one text.
  assert.equal(redactTokens(`${TOKEN}\n`.repeat(50000), [TOKEN]), `${MARK}\n`.repeat(50000));
  t.diagnostic(`${Date.now() - started} ms for all of the above`);
  assert.ok(Date.now() - started < 20000, 'a linear scan: tens of megabytes and the worst case of a restarting one finish in a moment');
});

// ── The list of what is taken out of a token ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('needlesOf is the one list of what is taken out of a token: the token and each dot-separated part of 24 characters or more, longest first, once each', () => {
  assert.deepEqual(needlesOf(TOKEN), [TOKEN, PARTS[2], PARTS[1], PARTS[0]]);
  assert.deepEqual(needlesOf('aaa.bbb.ccc-and-a-longer-opaque-token-value'), ['aaa.bbb.ccc-and-a-longer-opaque-token-value', 'ccc-and-a-longer-opaque-token-value']);
  assert.deepEqual(needlesOf('opaque-token-without-any-dot-in-it'), ['opaque-token-without-any-dot-in-it']);
  assert.deepEqual(needlesOf(`${PARTS[0]}.${PARTS[0]}`), [`${PARTS[0]}.${PARTS[0]}`, PARTS[0]]);
  assert.equal(TOKEN_MARKER, MARK);
});

// ── The registry, in a process of its own: it is process-wide, and noting a token guards the streams ───────────────────────────────────────────────────────────

const SCRIPTS = path.resolve(__dirname, '..');
function inChild(source, env = {}) {
  const run = spawnSync(process.execPath, ['-e', source], { cwd: SCRIPTS, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', ...env } });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

test('a token is noted once, the first time installs the guards, and a value shorter than 16 characters is no token', () => {
  const run = inChild(`
    const writeBefore = [process.stdout.write, process.stderr.write];
    const listenersBefore = process.listenerCount('uncaughtException');
    const r = require('./lib/output-redaction.js');
    const states = [];
    states.push(r.redactOutput('bearer ${TOKEN}'));
    r.noteToken('short-token'); r.noteToken(42); r.noteToken(undefined);
    states.push(r.obtainedTokens().length, process.stdout.write === writeBefore[0], process.listenerCount('uncaughtException') === listenersBefore);
    r.noteToken('${TOKEN}'); r.noteToken('${TOKEN}'); r.noteToken('${OTHER}');
    const after = [process.stdout.write !== writeBefore[0], process.stderr.write !== writeBefore[1], process.listenerCount('uncaughtException') === listenersBefore + 1];
    r.noteToken('${TOKEN}');
    require('node:fs').writeSync(1, JSON.stringify({ states, tokens: r.obtainedTokens().length, after, wrappedOnce: process.stdout.write.name, cleaned: r.redactOutput('bearer ${TOKEN} and ${OTHER}'), bytes: r.redactOutput(Buffer.from('${TOKEN}')).toString(), number: r.redactOutput(7) }));
  `);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.states, ['bearer ' + TOKEN, 0, true, true], 'before a token is noted: nothing is cleaned, nothing is guarded, no listener is added');
  assert.equal(out.tokens, 2, 'two different tokens, each once');
  assert.deepEqual(out.after, [true, true, true], 'after the first: both streams are guarded and the process gets one handler for an error that ends it');
  assert.equal(out.wrappedOnce, 'writeWithoutTokens');
  assert.equal(out.cleaned, `bearer ${MARK} and ${MARK}`);
  assert.equal(out.bytes, TOKEN, 'bytes are passed as they are');
  assert.equal(out.number, 7);
});

test('a process that never notes a token is untouched: no stream is wrapped, no listener is added — loading the plugin\'s auth and client modules does not note one', () => {
  const run = inChild(`
    const before = [process.stdout.write, process.stderr.write, process.listenerCount('uncaughtException')];
    require('./lib/dataverse-auth.js'); require('./lib/sdk-http-client.js'); require('./lib/maker-sdk.js'); require('./lib/safe-fs.js');
    const { getAuthToken } = require('./lib/dataverse-auth.js');
    const missing = getAuthToken('https://contoso.crm.dynamics.com', { exec: () => { throw new Error('az is not here'); } });
    const r = require('./lib/output-redaction.js');
    require('node:fs').writeSync(1, JSON.stringify({ same: process.stdout.write === before[0] && process.stderr.write === before[1], listeners: process.listenerCount('uncaughtException') === before[2], missing, tokens: r.obtainedTokens().length }));
  `);
  assert.deepEqual(JSON.parse(run.stdout), { same: true, listeners: true, missing: null, tokens: 0 });
});

test('a token read from the Azure CLI — synchronously or not — and a token a client sends are noted; one that is not a token is not', async () => {
  const run = inChild(`
    (async () => {
      const auth = require('./lib/dataverse-auth.js');
      const r = require('./lib/output-redaction.js');
      const { createAzHttpClient } = require('./lib/sdk-http-client.js');
      const seen = [];
      const url = 'https://contoso.crm.dynamics.com';
      seen.push(auth.getAuthToken(url, { exec: () => '${TOKEN}\\n' }) === '${TOKEN}', r.obtainedTokens().length);
      seen.push(await auth.getPowerAppsTokenAsync({ execFile: (cmd, args, options, done) => { done(null, '${OTHER}\\n'); return {}; } }) === '${OTHER}', r.obtainedTokens().length);
      const client = createAzHttpClient(url, { getToken: () => 'sent-by-a-client-and-long-enough', request: async () => ({ statusCode: 200, headers: {}, body: '{}' }) });
      await client.get(url + '/api/data/v9.2/WhoAmI');
      seen.push(r.obtainedTokens().includes('sent-by-a-client-and-long-enough'));
      await auth.dataverseRequest(url, 'GET', 'WhoAmI', null, { getToken: () => 'sent-by-dataverse-request-long', request: async () => ({ statusCode: 200, body: '{}' }) });
      seen.push(r.obtainedTokens().includes('sent-by-dataverse-request-long'));
      await client.get(url + '/api/data/v9.2/WhoAmI');
      auth.getAuthToken(url, { exec: () => 'short' });
      seen.push(r.obtainedTokens().length);
      require('node:fs').writeSync(1, JSON.stringify(seen));
    })();
  `);
  assert.deepEqual(JSON.parse(run.stdout), [true, 1, true, 2, true, true, 4], 'both reads from the Azure CLI, and both clients, note what they sent; a short value is no token');
});

// ── The error that ends the process ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the handler for an error that ends the process is added only when nothing else handles one, and leaves the decision to a handler that is added after it', () => {
  const { guardFatalErrors } = require('../lib/output-redaction.js');
  const other = () => {};
  process.on('uncaughtException', other);
  try {
    const before = process.listenerCount('uncaughtException');
    assert.equal(guardFatalErrors(), false, 'a process that already has a handler (a test runner has one) keeps it alone');
    assert.equal(process.listenerCount('uncaughtException'), before);
  } finally {
    process.off('uncaughtException', other);
  }
  const run = inChild(`
    require('./lib/output-redaction.js').noteToken('${TOKEN}');
    process.on('uncaughtException', (error) => { process.stdout.write('the host handled: ' + error.message + '\\n'); });
    setTimeout(() => { throw new Error('bearer ${TOKEN}'); }, 1);
    setTimeout(() => process.stdout.write('and the process went on\\n'), 50);
  `);
  assert.equal(run.stdout, `the host handled: bearer ${MARK}\nand the process went on\n`, 'the host\'s handler ran, its text was cleaned by the guard on stdout, and the process was not ended by the guard');
  assert.equal(run.stderr, '', 'and the guard printed nothing');
});

// ── A guard on a stream ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const fakeStream = () => {
  const stream = { chunks: [], writes: [], write(chunk, ...rest) { this.chunks.push(chunk); this.writes.push(rest); return 'returned'; } };
  return stream;
};
const redactToken = (text) => redactTokens(text, [TOKEN]);

test('a guarded stream is given the text with the token taken out — and everything else as it was: the encoding, the callback, what write returns, the receiver', () => {
  const stream = fakeStream();
  assert.equal(guardStream(stream, redactToken), true);
  const done = () => {};
  assert.equal(stream.write(`bearer ${TOKEN}\n`, 'utf8', done), 'returned');
  assert.deepEqual(stream.chunks, [`bearer ${MARK}\n`]);
  assert.deepEqual(stream.writes, [['utf8', done]]);
  stream.write('no token\n');
  assert.deepEqual(stream.chunks, [`bearer ${MARK}\n`, 'no token\n']);
  assert.equal(stream.write.name, 'writeWithoutTokens');
});

test('a guarded stream passes bytes and text that is not text as they are, and says so when it is already guarded or is no stream', () => {
  const stream = fakeStream();
  assert.equal(guardStream(stream, redactToken), true);
  const bytes = Buffer.from(`bearer ${TOKEN}`);
  stream.write(bytes);
  stream.write(new Uint8Array([1, 2, 3]));
  stream.write(Buffer.from(TOKEN).toString('hex'), 'hex');
  stream.write(Buffer.from(TOKEN).toString('base64'), 'base64');
  stream.write(`bearer ${TOKEN}`, 'latin1');
  assert.equal(stream.chunks[0], bytes, 'a Buffer is the very Buffer: a test runner\'s frames are bytes');
  assert.deepEqual([...stream.chunks[1]], [1, 2, 3]);
  assert.equal(stream.chunks[2], Buffer.from(TOKEN).toString('hex'));
  assert.equal(stream.chunks[3], Buffer.from(TOKEN).toString('base64'));
  assert.equal(stream.chunks[4], `bearer ${MARK}`, 'a text in another text encoding is a text');
  assert.equal(guardStream(stream, redactToken), false, 'wrapped once');
  assert.equal(guardStream({}, redactToken), false);
  assert.equal(guardStream(null, redactToken), false);
  assert.equal(guardStream({ write: 3 }, redactToken), false);
});

test('a guard that cannot clean a text writes a notice and not the text; the guard sits where the stream\'s own write was, so a caller that wraps it wraps it whole', () => {
  const stream = fakeStream();
  guardStream(stream, () => { throw new Error('the matcher failed'); });
  stream.write(`bearer ${TOKEN}`);
  assert.equal(stream.chunks.length, 1);
  assert.match(stream.chunks[0], /^\[output withheld/);
  assert.ok(!stream.chunks[0].includes(TOKEN));
  // A caller that swaps `write` swaps the guard, and one that wraps it keeps it.
  const wrapped = fakeStream();
  guardStream(wrapped, redactToken);
  const guarded = wrapped.write;
  wrapped.write = function wrapper(chunk, ...rest) { return guarded.call(this, `<${chunk}>`, ...rest); };
  wrapped.write(`bearer ${TOKEN}`);
  assert.deepEqual(wrapped.chunks, [`<bearer ${MARK}>`]);
});

// ── A guard on the SDK's workspace ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a guarded workspace storage writes every text with the token taken out, and is the storage in everything else — its folder, its paths, its class, its other methods', async () => {
  const dir = makeTempDir('workspace-guard-');
  const storage = bundle.createNodeWorkspaceStorage(dir);
  const guarded = guardWorkspaceStorage(storage, redactToken);
  assert.notEqual(guarded, storage);
  await guarded.writeTextAtomic(['forms', 'one.json'], JSON.stringify({ label: `Rejected bearer ${TOKEN.match(/.{1,8}/g).join('\r\n ')}`, [TOKEN]: 1 }));
  const written = fs.readFileSync(path.join(dir, 'forms', 'one.json'), 'utf8');
  assert.deepEqual(leaksIn(written, SECRETS), []);
  assert.deepEqual(JSON.parse(written), { label: `Rejected bearer ${MARK}`, [MARK]: 1 });
  assert.equal(await guarded.readText(['forms', 'one.json']), written, 'what is read is what is on disk');
  assert.equal(await guarded.exists(['forms', 'one.json']), true);
  assert.equal(guarded.getRoot(), dir);
  assert.equal(guarded.pathFor(['forms', 'one.json']), path.join(dir, 'forms', 'one.json'));
  assert.ok(guarded instanceof bundle.NodeFileSystemStorage, 'the SDK\'s own look for a file-system storage still finds one');
  await guarded.writeTextAtomic(['forms', 'two.json'], '{"plain":true}');
  assert.equal(fs.readFileSync(path.join(dir, 'forms', 'two.json'), 'utf8'), '{"plain":true}', 'a text that holds no token is written as it is');
  await guarded.deleteFile(['forms', 'two.json']);
  assert.equal(fs.existsSync(path.join(dir, 'forms', 'two.json')), false);
  for (const value of [null, undefined, 'storage', {}, { writeTextAtomic: 3 }]) assert.equal(guardWorkspaceStorage(value, redactToken), value, 'what is no storage is returned as it is');
});
