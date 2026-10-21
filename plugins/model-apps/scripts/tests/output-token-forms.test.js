'use strict';
// lib/output-redaction.js — what is taken out besides a token a text spells whole: the BYTES a stream is given (a Buffer, a Uint8Array, a string the stream decodes), the token's OTHER SPELLINGS (base64 at each of the three
// byte alignments, standard and URL-safe; percent-encoded and HTML where that differs from the token), a token a formatter CUT SHORT (util.inspect's `... N more characters`, an ellipsis, the end of a text), and a token
// written in two PIECES (the end of one write, the start of the next). Each is held where it matters — at a real process's descriptors (`script` below runs one as a script runs: the token read from the Azure CLI, which
// notes it and guards both streams) and at the functions — and so is what must not move: a text or bytes that hold no token are the very ones given, a framed message keeps its length, ordinary base64, URLs and HTML stay
// as they are, JSON stays JSON, a piece shorter than the floor is left as it was written (the residual, pinned here), and every new path costs time that grows with the text. tests/output-redaction.test.js holds the
// reader itself; tests/output-token-boundary.test.js what the plugin's own scripts write.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const util = require('node:util');
const { spawnSync } = require('node:child_process');
const redaction = require('../lib/output-redaction.js');
const { redactTokens, guardStream } = redaction;
const { PARTS, TOKEN } = require('./helpers/synthetic-token.js');

const MARK = '<token>';
const FLOOR = 24;
const OTHER = ['otherHeaderPartNotARealCredentialAAA', 'otherPayloadPartNotARealCredentialBBB', 'otherSignaturePartNotARealCredentialC'].join('.');
// An opaque token in standard base64 with the characters a URL and HTML spell differently from the token.
const SPECIAL = 'opaque+Token/With=Signs&And<Marks>"Quoted"-0123456789';
const SCRIPTS = path.resolve(__dirname, '..');

// Every run of FLOOR characters of a secret: what must not be left of it (a shorter piece is below the floor a piece is taken out at — the residual these tests pin where it is meant to stay).
const windowsOf = (secret) => Array.from({ length: Math.max(0, secret.length - FLOOR + 1) }, (_, i) => secret.slice(i, i + FLOOR));
const piecesIn = (text, secrets) => [...new Set(secrets.flatMap(windowsOf))].filter((window) => text.includes(window));
// What a piece of the token is once written: taken out when it is FLOOR characters or more (as a text, the marker; as bytes, as many `*`), as it was written when it is shorter.
const keptAs = (piece, mark) => (piece.length >= FLOOR ? mark(piece) : piece);
const stars = (piece) => '*'.repeat(piece.length);

// The base64 of a token as it stands inside a longer value, found by trying rather than by the module's arithmetic: the characters that stay the same whatever bytes stand before and after the token.
function base64Of(token, alphabet) {
  const spellings = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const zeros = Buffer.concat([Buffer.alloc(offset, 0x00), Buffer.from(token), Buffer.alloc(3, 0x00)]).toString(alphabet);
    const ones = Buffer.concat([Buffer.alloc(offset, 0xff), Buffer.from(token), Buffer.alloc(3, 0xff)]).toString(alphabet);
    let from = 0;
    while (zeros[from] !== ones[from]) from += 1;
    let to = from;
    while (to < zeros.length && zeros[to] === ones[to]) to += 1;
    spellings.push(zeros.slice(from, to));
  }
  return spellings;
}
const BASE64 = [...base64Of(TOKEN, 'base64'), ...base64Of(TOKEN, 'base64url')];

// A small seeded generator, so that a failure names a case that can be run again.
function generator(seed) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n) => Math.floor(next() * n), pick: (list) => list[Math.floor(next() * list.length)] };
}

// A script of our own in a REAL process, run from the plugin's scripts folder; its descriptors come back as bytes. `NOTE` is what a script does before it writes anything: it reads the token from the Azure CLI, which notes
// it and puts the guards on both streams.
const NOTE = `require('./lib/dataverse-auth.js').getAuthToken('https://contoso.crm.dynamics.com', { exec: () => ${JSON.stringify(`${TOKEN}\n`)} });`;
function script(source, env = {}) {
  const run = spawnSync(process.execPath, ['-e', source], { cwd: SCRIPTS, env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  assert.equal(run.status, 0, run.stderr.toString());
  return run;
}

// A message framed the way a test runner frames what it reports: four bytes that say how many follow, and then those bytes.
function framed(text) {
  const payload = Buffer.from(text);
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

// ── Bytes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('BYTES a script writes reach the descriptor without the token — a Buffer, a Uint8Array, a string the stream decodes (base64, hex), a framed message — each hit masked with as many `*` as it has bytes; bytes with no token are the very object given', () => {
  const run = script(`
    const fs = require('node:fs');
    const seen = [];
    const beneath = process.stdout.write;
    process.stdout.write = function recorder(chunk, ...rest) { seen.push(chunk); return beneath.call(this, chunk, ...rest); };
    ${NOTE}
    const plain = Buffer.from('bytes with no token in them\\n');
    const returned = process.stdout.write(plain);
    const same = seen[0] === plain;
    process.stdout.write(Buffer.from('a buffer ${TOKEN}\\n'));
    process.stdout.write(new Uint8Array(Buffer.from('an array ${PARTS[2]}\\n')));
    process.stdout.write(Buffer.from('decoded ${TOKEN}\\n').toString('base64'), 'base64');
    process.stdout.write(Buffer.from('decoded ${PARTS[0]}\\n').toString('hex'), 'hex');
    const payload = Buffer.from(JSON.stringify({ test: 'a test', error: 'bearer ${TOKEN}' }));
    const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
    process.stdout.write(frame, () => fs.writeSync(2, JSON.stringify({ same, returned: typeof returned, wrapped: process.stdout.write.name, frameIntact: frame.includes('${TOKEN}') })));
  `);
  const frame = framed(JSON.stringify({ test: 'a test', error: `bearer ${stars(TOKEN)}` }));
  const expected = Buffer.concat([
    Buffer.from('bytes with no token in them\n'),
    Buffer.from(`a buffer ${stars(TOKEN)}\n`),
    Buffer.from(`an array ${stars(PARTS[2])}\n`),
    Buffer.from(`decoded ${stars(TOKEN)}\n`),
    Buffer.from(`decoded ${stars(PARTS[0])}\n`),
    frame,
  ]);
  const written = run.stdout.toString('latin1');
  assert.deepEqual(piecesIn(written, [TOKEN]), [], 'no piece of the token reached stdout as bytes');
  assert.equal(written, expected.toString('latin1'), 'every hit is masked byte for byte, and nothing else changed');
  const frameAt = run.stdout.length - frame.length;
  assert.equal(run.stdout.readUInt32BE(frameAt), frame.length - 4, 'the frame still says how many bytes follow it');
  assert.deepEqual(JSON.parse(run.stdout.subarray(frameAt + 4).toString()), { test: 'a test', error: `bearer ${stars(TOKEN)}` });
  assert.deepEqual(JSON.parse(run.stderr.toString()), { same: true, returned: 'boolean', wrapped: 'writeWithoutTokens', frameIntact: true },
    'bytes with no token are the very object given; write returns what it returned and calls the callback; the caller\'s own bytes are not written into — a COPY is masked');
});

test('maskTokenBytes: the very bytes given when they hold no token (a Buffer, a Uint8Array, empty); a copy of the same length with each hit masked when they do — the token, a part, a spelling, a framed message', () => {
  const { maskTokenBytes } = redaction;
  const plain = Buffer.from('no token in these bytes');
  assert.equal(maskTokenBytes(plain, [TOKEN]), plain);
  const array = new Uint8Array([1, 2, 3, 0xff]);
  assert.equal(maskTokenBytes(array, [TOKEN]), array);
  const empty = Buffer.alloc(0);
  assert.equal(maskTokenBytes(empty, [TOKEN]), empty);
  const noTokens = Buffer.from(`bearer ${TOKEN}`);
  assert.equal(maskTokenBytes(noTokens, []), noTokens, 'no token, nothing to mask');
  assert.equal(maskTokenBytes('a text', [TOKEN]), 'a text', 'what is not bytes is returned as it is');
  const given = Buffer.from(`a ${TOKEN} b ${PARTS[1]} c ${BASE64[1]} d`);
  const copy = Buffer.from(given);
  const masked = maskTokenBytes(given, [TOKEN]);
  assert.notEqual(masked, given);
  assert.deepEqual(given, copy, 'the bytes given are not written into');
  assert.equal(masked.length, given.length);
  assert.equal(masked.toString(), `a ${'*'.repeat(TOKEN.length)} b ${'*'.repeat(PARTS[1].length)} c ${'*'.repeat(BASE64[1].length)} d`);
  const frame = framed(JSON.stringify({ diagnostic: `Rejected bearer ${TOKEN}` }));
  const maskedFrame = maskTokenBytes(frame, [TOKEN]);
  assert.equal(maskedFrame.length, frame.length);
  assert.equal(maskedFrame.readUInt32BE(0), frame.length - 4);
  assert.deepEqual(JSON.parse(maskedFrame.subarray(4).toString()), { diagnostic: `Rejected bearer ${'*'.repeat(TOKEN.length)}` });
  // A Uint8Array that is not a Buffer comes back as bytes too, and a multi-byte character beside the token is left whole.
  const wide = new Uint8Array(Buffer.from(`日本語 ${TOKEN} 🧪`));
  assert.equal(Buffer.from(maskTokenBytes(wide, [TOKEN])).toString(), `日本語 ${'*'.repeat(TOKEN.length)} 🧪`);
});

test('a guarded stream hands bytes to the write beneath it with everything else as it was — the encoding, the callback, the receiver and what write returns — and masks only where the token is', () => {
  const { maskTokenBytes } = redaction;
  const chunks = [];
  const calls = [];
  const stream = { write(chunk, ...rest) { chunks.push(chunk); calls.push([this, rest]); return 'returned'; } };
  guardStream(stream, (chunk) => (typeof chunk === 'string' ? redactTokens(chunk, [TOKEN], { edges: true }) : maskTokenBytes(chunk, [TOKEN], { edges: true })));
  const done = () => {};
  const clean = Buffer.from('clean bytes');
  assert.equal(stream.write(clean, 'utf8', done), 'returned');
  assert.equal(chunks[0], clean, 'the very Buffer');
  assert.deepEqual(calls[0], [stream, ['utf8', done]]);
  assert.equal(stream.write(Buffer.from(`x ${TOKEN}`), done), 'returned');
  assert.equal(chunks[1].toString(), `x ${'*'.repeat(TOKEN.length)}`);
  assert.deepEqual(calls[1], [stream, [done]]);
  const hex = Buffer.from(`clean ${PARTS[0].slice(0, FLOOR - 1)}`).toString('hex');
  stream.write(hex, 'hex', done);
  assert.equal(chunks[2], hex, 'a string the stream decodes is the very string when its bytes hold no token');
  assert.deepEqual(calls[2][1], ['hex', done], 'with its encoding');
  stream.write(Buffer.from(`y ${TOKEN}`).toString('base64'), 'base64', done);
  assert.equal(Buffer.isBuffer(chunks[3]) && chunks[3].toString(), `y ${'*'.repeat(TOKEN.length)}`, 'its bytes, masked, in its place');
  assert.deepEqual(calls[3][1], ['base64', done], 'and the encoding argument as it was given: a stream ignores it for bytes');
  assert.equal(stream.write(new Uint16Array([1, 2])) && chunks[4] instanceof Uint16Array, true, 'what is neither text nor bytes is passed on for the stream to refuse, as it always was');
});

// ── Other spellings of a known token ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the token in BASE64 — standard or URL-safe, at each of the three byte alignments, inside a longer value, folded onto lines as MIME folds it, in JSON with an escaped slash — is taken out; what is left of the value holds no piece of it', () => {
  for (const alphabet of ['base64', 'base64url']) {
    for (const before of ['', 'B', 'Be', 'Bearer ', 'Authorization: Bearer ']) {
      for (const after of ['', 'x', '\r\n', ' and the rest of the header']) {
        const encoded = Buffer.from(`${before}${TOKEN}${after}`).toString(alphabet);
        for (const written of [encoded, encoded.match(/.{1,76}/g).join('\r\n'), JSON.stringify({ blob: encoded }).replace(/\//g, '\\/')]) {
          const cleaned = redactTokens(`blob ${written} end`, [TOKEN]);
          assert.deepEqual(piecesIn(cleaned, BASE64), [], `${alphabet} of ${JSON.stringify(before)} + token + ${JSON.stringify(after)}: ${cleaned}`);
          assert.ok(cleaned.includes(MARK));
        }
      }
    }
  }
  // JSON that held it is JSON still.
  const json = JSON.stringify({ header: Buffer.from(`Bearer ${TOKEN}`).toString('base64'), ok: false });
  assert.equal(JSON.parse(redactTokens(json, [TOKEN])).ok, false);
});

test('a token PERCENT-ENCODED (upper- or lower-case hex) or spelled with HTML ENTITIES is taken out where that spelling differs from the token', () => {
  const upper = encodeURIComponent(SPECIAL);
  const lower = upper.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  const html = SPECIAL.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  for (const spelled of [upper, lower, html]) {
    assert.notEqual(spelled, SPECIAL);
    assert.equal(redactTokens(`https://contoso.example/cb?access_token=${spelled}&state=1`, [SPECIAL]), `https://contoso.example/cb?access_token=${MARK}&state=1`, spelled);
    assert.equal(redactTokens(`<input value="${spelled}">`, [SPECIAL]), `<input value="${MARK}">`, spelled);
    assert.deepEqual(JSON.parse(redactTokens(JSON.stringify({ url: `a=${spelled}` }), [SPECIAL])), { url: `a=${MARK}` });
  }
  assert.equal(redactTokens(`plain ${SPECIAL} end`, [SPECIAL]), `plain ${MARK} end`, 'and the token as it is, as before');
});

test('spellingsOf is the list of the other spellings taken out: base64 of the token, standard and URL-safe, at each alignment; percent and HTML spellings only where they differ — a JWT has none; nothing shorter than the floor', () => {
  const { spellingsOf } = redaction;
  const jwt = spellingsOf(TOKEN);
  assert.deepEqual([...jwt].sort(), [...new Set(BASE64)].sort(), 'what is spelled the same whatever stands around the token, at each of the three alignments, in both alphabets — and nothing else: a JWT is base64url and dots');
  assert.ok(jwt.every((spelling) => spelling.length >= FLOOR));
  const special = spellingsOf(SPECIAL);
  const upper = encodeURIComponent(SPECIAL);
  for (const spelling of [upper, upper.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()), SPECIAL.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')]) {
    assert.ok(special.includes(spelling), spelling);
  }
  assert.ok(!special.includes(SPECIAL), 'the token itself is a needle already');
  assert.deepEqual(spellingsOf('short-but-a-token'), [], 'a token whose spellings are all shorter than the floor has none');
  assert.deepEqual(spellingsOf(''), []);
  assert.deepEqual(spellingsOf(undefined), []);
  assert.deepEqual(redaction.needlesOf(TOKEN), [TOKEN, PARTS[2], PARTS[1], PARTS[0]], 'and the list the Dataverse client scrubs with is what it was');
});

// ── A token a formatter cut short ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A string util.inspect cuts after `kept` characters of the token: it prints the first 10,000 characters of a string (https://nodejs.org/api/util.html#utilinspectobject-options, `maxStringLength`).
const cutAfter = (lead, kept) => `${lead}${'x'.repeat(10000 - lead.length - kept)}${TOKEN}`;

test('a token util.inspect CUT SHORT — in a property, in colours, in the last of several pieces, between double quotes, in JSON — loses the piece it printed when that piece is 24 characters or more; the count after it stays', () => {
  for (const kept of [FLOOR, 30, PARTS[0].length + 1 + 30, TOKEN.length - 1]) {
    const printings = [
      util.inspect({ body: cutAfter('', kept) }),
      util.inspect({ body: cutAfter('', kept) }, { colors: true }),
      util.inspect({ error: { body: cutAfter('line one\n', kept) } }),
      util.inspect({ body: cutAfter("it's ", kept) }),
      util.inspect([cutAfter('', kept)], { breakLength: Infinity }),
    ];
    for (const printed of printings) {
      assert.equal(printed.split(TOKEN.slice(0, kept)).length, 2, 'the printed text holds the piece once');
      assert.match(printed, /\.\.\. \d+ more characters?/);
      const cleaned = redactTokens(printed, [TOKEN]);
      assert.equal(cleaned, printed.replace(TOKEN.slice(0, kept), MARK), `${kept} characters kept: ${JSON.stringify(cleaned.slice(-120))}`);
      // In JSON too, which is JSON still. (Not the printing in colours: JSON spells its codes as `\u001b[39m`, which the reader reads as characters, between the pieces of a token as after a cut.)
      if (!printed.includes('\u001b')) assert.equal(JSON.parse(redactTokens(JSON.stringify({ log: printed }), [TOKEN])).log, cleaned);
    }
  }
  // Below the floor the piece is left: it would be taken out of ordinary words.
  for (const kept of [10, FLOOR - 1]) {
    const printed = util.inspect({ body: cutAfter('', kept) });
    assert.equal(redactTokens(printed, [TOKEN]), printed);
  }
});

test('a token cut to a length by hand — an ellipsis after it, `...` or `…`, as the plugin\'s own reasons cut a platform message — loses the piece before the ellipsis when it is 24 characters or more', () => {
  const reason = `HTTP 400: Principal user rejected bearer ${TOKEN} for this write`;
  const at = reason.indexOf(TOKEN);
  for (const kept of [FLOOR, 50, TOKEN.length - 3]) {
    for (const ellipsis of ['...', '…']) {
      const brief = `${reason.slice(0, at + kept)}${ellipsis}`;
      assert.equal(redactTokens(brief, [TOKEN]), `${reason.slice(0, at)}${MARK}${ellipsis}`, `${kept} ${ellipsis}`);
      assert.deepEqual(JSON.parse(redactTokens(JSON.stringify({ error: brief, code: 1 }), [TOKEN])), { error: `${reason.slice(0, at)}${MARK}${ellipsis}`, code: 1 });
    }
  }
  const short = `${reason.slice(0, at + FLOOR - 1)}...`;
  assert.equal(redactTokens(short, [TOKEN]), short, 'below the floor the piece is left');
});

test('REAL PROCESS: a script that prints an error whose body the console cuts inside the token — plainly, in colours, with %o — writes no piece of 24 characters of it; the count of what was cut stays', () => {
  for (const env of [{}, { FORCE_COLOR: '1' }]) {
    const run = script(`
      ${NOTE}
      const error = new Error('the request failed');
      error.body = ${JSON.stringify(cutAfter('', 30))};
      console.error(error);
      console.error({ answer: { body: ${JSON.stringify(cutAfter('Rejected bearer ', PARTS[0].length + 1 + 30))} } });
      console.log('%o', ${JSON.stringify(cutAfter('', FLOOR))});
    `, env);
    const written = `${run.stdout.toString()}${run.stderr.toString()}`;
    assert.deepEqual(piecesIn(written, [TOKEN]), [], `${JSON.stringify(env)}: no piece of the token`);
    assert.equal((written.match(/more characters/g) || []).length, 3, 'each cut is still said');
    assert.equal((written.match(/<token>/g) || []).length, 3);
  }
});

// ── A token written in two pieces ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Where a write is split, in the token: inside the first part, at its end, after the dot, in the middle, and at the edges of the floor on either side.
const SPLITS = [1, 10, FLOOR - 1, FLOOR, 30, PARTS[0].length, PARTS[0].length + 1, 60, TOKEN.length - FLOOR, TOKEN.length - FLOOR + 1, TOKEN.length - 1];

test('REAL PROCESS: a token written in two PIECES — the end of one write, the start of the next, on stdout as text and on stderr as bytes, with a line break between them too — loses each piece of 24 characters or more; a shorter one is left as it was written, and nothing is held back', () => {
  const run = script(`
    ${NOTE}
    for (const split of ${JSON.stringify(SPLITS)}) {
      process.stdout.write('[' + split + '] bearer ' + ${JSON.stringify(TOKEN)}.slice(0, split));
      process.stdout.write(${JSON.stringify(TOKEN)}.slice(split) + ' end\\n');
      process.stderr.write(Buffer.from('[' + split + '] bearer ' + ${JSON.stringify(TOKEN)}.slice(0, split)));
      process.stderr.write(Buffer.from(${JSON.stringify(TOKEN)}.slice(split) + ' end\\n'));
    }
    process.stdout.write(${JSON.stringify(TOKEN)}.slice(0, 40) + '\\n');
    process.stdout.write('  ' + ${JSON.stringify(TOKEN)}.slice(40) + '\\n');
    process.stdout.write('{"error":"bearer ' + ${JSON.stringify(TOKEN)}.slice(0, 50));
    process.stdout.write(${JSON.stringify(TOKEN)}.slice(50) + '","ok":false}\\n');
  `);
  const textLines = SPLITS.map((split) => `[${split}] bearer ${keptAs(TOKEN.slice(0, split), () => MARK)}${keptAs(TOKEN.slice(split), () => MARK)} end`);
  const byteLines = SPLITS.map((split) => `[${split}] bearer ${keptAs(TOKEN.slice(0, split), stars)}${keptAs(TOKEN.slice(split), stars)} end`);
  const stdout = run.stdout.toString();
  const stderr = run.stderr.toString();
  assert.deepEqual(piecesIn(`${stdout}${stderr}`, [TOKEN]), [], 'no piece of 24 characters of the token reached either descriptor');
  assert.equal(stdout, `${[...textLines, MARK, `  ${MARK}`, `{"error":"bearer ${MARK}${MARK}","ok":false}`].join('\n')}\n`);
  assert.equal(stderr, `${byteLines.join('\n')}\n`);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()), { error: `bearer ${MARK}${MARK}`, ok: false }, 'the two halves of a JSON line are JSON together');
});

test('a token written in pieces at the function: the end of a text that begins a needle and the start of one that ends it, each of 24 characters or more, with folds and escapes in them; a piece from the middle of a part, and the start read through an escape\'s letters, are the residual', () => {
  const edges = { edges: true };
  for (const split of SPLITS) {
    const head = TOKEN.slice(0, split);
    const tail = TOKEN.slice(split);
    assert.equal(redactTokens(`bearer ${head}`, [TOKEN], edges), `bearer ${keptAs(head, () => MARK)}`, `the end of a write, ${split}`);
    assert.equal(redactTokens(`${tail} end`, [TOKEN], edges), `${keptAs(tail, () => MARK)} end`, `the start of a write, ${split}`);
    assert.equal(maskTokenBytesText(`bearer ${head}`), `bearer ${keptAs(head, stars)}`, `bytes, the end, ${split}`);
    assert.equal(maskTokenBytesText(`${tail} end`), `${keptAs(tail, stars)} end`, `bytes, the start, ${split}`);
  }
  // Read as any text is read: folded, escaped, in colours, with white space before the start and after the end.
  const folded = (piece) => piece.match(/.{1,7}/g).join('\\r\\n ');
  assert.equal(redactTokens(`bearer ${folded(TOKEN.slice(0, 50))}\n`, [TOKEN], edges), `bearer ${MARK}\n`);
  assert.equal(redactTokens(`  \u001b[32m${folded(TOKEN.slice(50))}\u001b[39m end`, [TOKEN], edges), `  \u001b[32m${MARK}\u001b[39m end`);
  assert.equal(redactTokens(`\\u0073${TOKEN.slice(1, 40)}`, [TOKEN], edges), MARK);
  // Only with `edges`: a whole text a caller hands over (a file, a test's text) is read as it always was.
  assert.equal(redactTokens(`bearer ${TOKEN.slice(0, 30)}`, [TOKEN]), `bearer ${TOKEN.slice(0, 30)}`);
  assert.equal(redactTokens(`${TOKEN.slice(90)} end`, [TOKEN]), `${TOKEN.slice(90)} end`);
  // The residual: a piece from the middle of a part is neither the start nor the end of a needle (a token written in three pieces or more); and the start of a write is read on its first reading, so a letter that a
  // literal backslash before it makes an escape (`\n` and then the rest of the token) is read as the escape — that one character is left, the rest is taken out.
  const middle = TOKEN.slice(PARTS[0].length + 3, PARTS[0].length + 33);
  assert.equal(redactTokens(middle, [TOKEN], edges), middle);
  const fromN = TOKEN.slice(PARTS[0].length + 3);
  assert.equal(fromN[0], 'n');
  assert.equal(redactTokens(`\\${fromN} end`, [TOKEN], edges), `\\n${MARK} end`);
  // JSON written in two pieces is JSON again when they are put together.
  const document = JSON.stringify({ error: `Rejected bearer ${TOKEN}`, ok: false });
  const at = document.indexOf(TOKEN) + 45;
  assert.deepEqual(JSON.parse(redactTokens(document.slice(0, at), [TOKEN], edges) + redactTokens(document.slice(at), [TOKEN], edges)), { error: `Rejected bearer ${MARK}${MARK}`, ok: false });
});

// The bytes of a text, masked as a stream masks them, read back as text.
function maskTokenBytesText(text) {
  return Buffer.from(redaction.maskTokenBytes(Buffer.from(text), [TOKEN], { edges: true })).toString();
}

// ── Exactness: a prefix or a suffix spelled every way the reader reads a text ──────────────────────────────────────────────────────────────────────────

const unicode = (char, upper) => { const hex = char.charCodeAt(0).toString(16).padStart(4, '0'); return `\\u${upper ? hex.toUpperCase() : hex}`; };
// What may stand between two characters of a token (white space, a JSON line break, JSON inside JSON, a stray backslash, a colour code, util.inspect's join of two pieces), and what may stand after its last one or
// before its first: the folds that spell no character, which a span does not take with it.
const INNER = ['', '', '', ' ', '\n', '\r\n ', '\t', '\\r\\n', '\\n ', '\\\\r\\\\n ', '\\u000a', '\u001b[32m', "' +\n  '", '\\'];
const OUTER = ['', ' ', '\n', '\r\n  ', '\t', '\u001b[39m'];
const CUTS = ["'... 9876 more characters", "'\u001b[39m... 1 more character", '"... 12 more characters', '`... 3 more characters', '...', '…'];

// `chars` spelled with folds from `gaps` between them and a \u escape for some; with `strays`, a stray backslash before some of them too. The first is always the character itself or its \u escape: what a reader reads first.
function spell(random, chars, gaps, strays) {
  return [...chars].map((char, i) => {
    let spelled = random.next() < 0.25 ? unicode(char, random.next() < 0.5) : char;
    if (strays && i > 0 && random.next() < 0.1) spelled = `\\${spelled}`;
    return (i > 0 ? random.pick(gaps) : '') + spelled;
  }).join('');
}

test('a prefix of a needle spelled with folds, escapes, stray backslashes and colour codes, cut by util.inspect, an ellipsis or the end of a write, is taken out from its first character to its last — and only that: the folds after it and the cut stay', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = generator(seed);
    const length = FLOOR + random.int(TOKEN.length - FLOOR);
    const prefix = spell(random, TOKEN.slice(0, length), INNER, true);
    const after = random.pick(OUTER);
    const before = 'Rejected bearer ';
    if (random.next() < 0.5) {
      const cut = random.pick(CUTS);
      const text = `${before}${prefix}${after}${cut} and on`;
      assert.equal(redactTokens(text, [TOKEN]), `${before}${MARK}${after}${cut} and on`, `seed ${seed}: ${JSON.stringify(text)}`);
    } else {
      const text = `${before}${prefix}${after}`;
      assert.equal(redactTokens(text, [TOKEN], { edges: true }), `${before}${MARK}${after}`, `seed ${seed}: ${JSON.stringify(text)}`);
    }
  }
});

test('a suffix of a needle at the start of a write, spelled with folds, escapes and colour codes, is taken out from its first character to its last; the folds before it and the text after it stay', () => {
  // No stray backslash here: the start of a write is read on its first reading, so a stray one before a letter that begins an escape is the residual pinned above.
  const gaps = INNER.filter((gap) => gap !== '\\');
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = generator(seed);
    const from = 1 + random.int(TOKEN.length - FLOOR);
    const lead = random.pick(OUTER);
    const after = random.pick(OUTER);
    const text = `${lead}${spell(random, TOKEN.slice(from), gaps, false)}${after} for this write`;
    assert.equal(redactTokens(text, [TOKEN], { edges: true }), `${lead}${MARK}${after} for this write`, `seed ${seed}: ${JSON.stringify(text)}`);
  }
});

// ── What must not move ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ordinary text and data are the very string they were — base64 of other bytes, of another token, folded; URLs and HTML; ellipses; util.inspect cutting a string that holds no token — read whole or as a write', () => {
  const random = generator(7);
  const noise = Buffer.from(Array.from({ length: 300000 }, () => random.int(256)));
  const texts = [
    noise.toString('base64'), noise.toString('base64url'), noise.toString('base64').match(/.{1,76}/g).join('\r\n'),
    Buffer.from(`Bearer ${OTHER}`).toString('base64'), Buffer.from(`Bearer ${OTHER}`).toString('base64url'),
    'https://contoso.example/a%20b?x=%2F%2B%3D&y=caf%C3%A9 — &amp; &lt;b&gt; &quot;q&quot; &#39;',
    `Waiting for the platform... done. Loading… ${PARTS[0].slice(0, FLOOR - 1)}... ${PARTS[0].slice(1)}... ${TOKEN.slice(PARTS[0].length + 3, PARTS[0].length + 33)}…`,
    util.inspect({ body: 'x'.repeat(20000) }), util.inspect({ body: 'x'.repeat(20000) }, { colors: true }), util.inspect('it\'s'.repeat(5000)),
    JSON.stringify({ list: [1, 2, 3], text: 'nothing to see... here…' }, null, 2),
  ];
  for (const text of texts) {
    assert.equal(redactTokens(text, [TOKEN, SPECIAL]), text);
    assert.equal(redactTokens(text, [TOKEN, SPECIAL], { edges: true }), text);
  }
  const bytes = Buffer.from(texts.join('\n'));
  assert.equal(redaction.maskTokenBytes(bytes, [TOKEN, SPECIAL], { edges: true }), bytes);
  assert.equal(redaction.maskTokenBytes(noise, [TOKEN, SPECIAL], { edges: true }), noise);
});

// ── Cost ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('every new path costs time that grows with what it reads — bytes of any size and a needle\'s start over and over, many cuts, many small writes, the spellings in a large text — and the bound on readings still fails closed on a cut', (t) => {
  const started = Date.now();
  const { maskTokenBytes } = redaction;
  const filler = 'The platform answered with a diagnostic that says nothing about credentials.\r\n';
  // Twenty megabytes of bytes with the token in the middle; bytes that are a needle's first 2,999 characters over and over.
  const big = Buffer.from(filler.repeat(260000));
  const middle = Buffer.concat([big.subarray(0, big.length / 2), Buffer.from(TOKEN), big.subarray(big.length / 2)]);
  const masked = maskTokenBytes(middle, [TOKEN], { edges: true });
  assert.equal(masked.length, middle.length);
  assert.equal(masked.indexOf(TOKEN), -1);
  assert.equal(maskTokenBytes(big, [TOKEN], { edges: true }), big);
  const needle = `${'a'.repeat(2999)}Z`;
  const nearly = Buffer.alloc(4 * 1024 * 1024, 'a');
  assert.equal(maskTokenBytes(nearly, [needle]), nearly);
  assert.equal(maskTokenBytes(Buffer.concat([Buffer.from('Z'), nearly, Buffer.from('Z')]), [needle], { edges: true }).toString('latin1').endsWith(`${'*'.repeat(3000)}`), true);
  // A text of a hundred thousand cuts, each after a piece of the token; and a hundred thousand quotes and ellipses while a needle is being read.
  const cuts = `x ${TOKEN.slice(0, 30)}'... 5 more characters\n`.repeat(100000);
  assert.equal(redactTokens(cuts, [TOKEN]), `x ${MARK}'... 5 more characters\n`.repeat(100000));
  const quotes = `${TOKEN.slice(0, 30)}${"'.".repeat(200000)}`;
  assert.equal(redactTokens(quotes, [TOKEN]), quotes);
  // Cuts while the most readings a real text keeps are alive: escapes that may each be the next letter of a needle that is one letter over and over, then a cut — twenty thousand times.
  const letters = `${'n'.repeat(60)}Z`;
  const readings = `${'\\n'.repeat(60)}'... 1 more character `.repeat(20000);
  assert.equal(redactTokens(readings, [letters]), `${MARK}'... 1 more character `.repeat(20000));
  // A hundred thousand small writes, each the start of a needle, and a hundred thousand ordinary lines, through a stream guarded as a script's are (the tokens the process obtained, prepared once); and a large text with
  // each spelling in it.
  const writes = script(`
    ${NOTE}
    const fs = require('node:fs');
    const chunks = [];
    const fake = { write(chunk) { chunks.push(chunk); return true; } };
    require('./lib/output-redaction.js').guardStream(fake);
    const started = Date.now();
    for (let i = 0; i < 100000; i += 1) fake.write(${JSON.stringify(TOKEN.slice(0, 30))});
    for (let i = 0; i < 100000; i += 1) fake.write('progress: step ' + i + ' of 100000 done\\n');
    const ms = Date.now() - started;
    fs.writeSync(2, JSON.stringify({ ms, marked: chunks.slice(0, 100000).every((chunk) => chunk === '<token>'), lines: chunks.slice(100000).every((chunk, i) => chunk === 'progress: step ' + i + ' of 100000 done\\n') }));
  `);
  const measured = JSON.parse(writes.stderr.toString());
  assert.deepEqual({ marked: measured.marked, lines: measured.lines }, { marked: true, lines: true });
  t.diagnostic(`${measured.ms} ms for 200,000 small writes`);
  const spelled = `${filler.repeat(15000)}${BASE64.join(' ')}${filler.repeat(15000)}`;
  assert.equal(redactTokens(spelled, [TOKEN], { edges: true }), `${filler.repeat(15000)}${BASE64.map(() => MARK).join(' ')}${filler.repeat(15000)}`);
  t.diagnostic(`${Date.now() - started} ms for all of the above`);
  assert.ok(Date.now() - started < 30000, 'linear: tens of megabytes and the worst cases finish in a moment');
  // Past its bound of readings the search fails rather than guess — at a cut and at the end of a write too — and a guarded stream writes a notice, not the text.
  const crafted = `${'\\n'.repeat(400)}'... 5 more characters`;
  const longNeedle = `${'n'.repeat(300)}Z`;
  assert.throws(() => redactTokens(crafted, [longNeedle], { edges: true }), (error) => error instanceof RangeError);
  const guarded = [];
  const failing = { write(chunk) { guarded.push(chunk); return true; } };
  guardStream(failing, (chunk) => redactTokens(chunk, [longNeedle], { edges: true }));
  failing.write(`${'\\n'.repeat(400)}`);
  assert.match(guarded[0], /^\[output withheld/);
});

// ── An escape split between two writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A JSON line whose token has an escape in it — `\/` (the token holds a `/`, as a standard-base64 one does), `\u0073` (a character JSON may escape), a literal `\\` (a stray backslash between two characters of the
// token), the `\r\n` of a fold — written in two pieces split at every place in and around the escape. Each piece of the token is 24 characters or more, so each is taken out; the escape is kept whole wherever it was cut.
const SPLIT_ESCAPES = [
  { name: '\\/', token: `${'A'.repeat(24)}/${'B'.repeat(27)}`, spelled: `${'A'.repeat(24)}\\/${'B'.repeat(27)}` },
  { name: '\\u0073', token: `${'A'.repeat(24)}s${'B'.repeat(27)}`, spelled: `${'A'.repeat(24)}\\u0073${'B'.repeat(27)}` },
  { name: '\\\\', token: `${'A'.repeat(24)}${'B'.repeat(27)}`, spelled: `${'A'.repeat(24)}\\\\${'B'.repeat(27)}` },
  { name: '\\r\\n', token: `${'A'.repeat(24)}${'B'.repeat(27)}`, spelled: `${'A'.repeat(24)}\\r\\n${'B'.repeat(27)}` },
];
const splitLines = () => SPLIT_ESCAPES.flatMap(({ name, token, spelled }) => {
  const line = `{"error":"bearer ${spelled}","ok":false}\n`;
  const escapeAt = line.indexOf('\\');
  const escapeEnd = line.lastIndexOf('\\') + (name === '\\u0073' ? 6 : 2);
  const cases = [];
  for (let split = escapeAt - 1; split <= escapeEnd + 1; split += 1) cases.push({ name, token, split, first: line.slice(0, split), second: line.slice(split) });
  return cases;
});

test('REAL PROCESS: an escape split between two writes — `\\/`, `\\u0073`, `\\\\`, `\\r\\n`, cut at every place in and around it — is kept whole: the JSON the writes make together is JSON still, and no piece of 24 characters of the token is left; on stdout as text, on stderr as bytes', () => {
  const cases = splitLines();
  const failures = [];
  for (const token of [...new Set(cases.map((one) => one.token))]) {
    const own = cases.filter((one) => one.token === token);
    const run = script(`
      require('./lib/dataverse-auth.js').getAuthToken('https://contoso.crm.dynamics.com', { exec: () => ${JSON.stringify(`${token}\n`)} });
      for (const { first, second } of ${JSON.stringify(own)}) {
        process.stdout.write(first); process.stdout.write(second);
        process.stderr.write(Buffer.from(first)); process.stderr.write(Buffer.from(second));
      }
    `);
    for (const [where, written] of [['stdout', run.stdout.toString()], ['stderr', run.stderr.toString()]]) {
      const lines = written.split('\n').slice(0, -1);
      own.forEach(({ name, split, first }, i) => {
        const line = lines[i];
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { failures.push(`${where} ${name} split ${split}: not JSON: ${line}`); return; }
        if (parsed.ok !== false) failures.push(`${where} ${name} split ${split}: the document changed: ${line}`);
        // Bytes are read literally (no escape is read in them), so a token they spell with an escape is the documented residual — except where each write holds its piece as it is: the cut right after the backslash
        // of `\/`, which once made the two writes no JSON.
        const literal = where === 'stdout' || (name === '\\/' && first.endsWith('\\'));
        const left = literal ? piecesIn(line, [token, 'A'.repeat(24), 'B'.repeat(27)]) : [];
        if (left.length > 0) failures.push(`${where} ${name} split ${split}: a piece of the token is left: ${line}`);
      });
    }
  }
  assert.deepEqual(failures, []);
});

test('a JSON `\\/` cut after its backslash, at the functions: a write that ends inside `\\/` and the next that finishes it — each piece taken out, the escape whole, and two writes with no token in them as they were', () => {
  const token = SPLIT_ESCAPES[0].token;
  const chunks = [];
  const stream = { write(chunk) { chunks.push(chunk); return true; } };
  guardStream(stream, (chunk, options) => (typeof chunk === 'string' ? redactTokens(chunk, [token], { edges: true, ...options }) : redaction.maskTokenBytes(chunk, [token], { edges: true, ...options })));
  stream.write(`{"error":"${'A'.repeat(24)}\\`);
  stream.write(`/${'B'.repeat(27)}"}`);
  assert.deepEqual(JSON.parse(chunks.join('')), { error: `${MARK}/${MARK}` });
  chunks.length = 0;
  stream.write(Buffer.from(`{"error":"${'A'.repeat(24)}\\`));
  stream.write(Buffer.from(`/${'B'.repeat(27)}"}`));
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { error: `${'*'.repeat(24)}/${'*'.repeat(27)}` });
  // Writes with no token in them — a path that ends with a backslash, and the next write — are what they were.
  chunks.length = 0;
  stream.write('C:\\work\\');
  stream.write('/next line\n');
  assert.deepEqual(chunks, ['C:\\work\\', '/next line\n']);
});
test('JSON written in pieces cut anywhere — inside escapes of every kind, inside the token, around it — is JSON again when the guarded pieces are put together, as text and as bytes, and the rest of the document is as it was', () => {
  const token = SPLIT_ESCAPES[0].token;
  const NOISE = ['plain', ' ', '\n', '\r\n', '\t', '"', '\\', '/', 'é', '日本', '🧪', '\u0001', 'u0041', '\\n', 'x', '...', '…'];
  const guardedWith = (chunks) => {
    const stream = { write(chunk) { chunks.push(chunk); return true; } };
    guardStream(stream, (chunk, options) => (typeof chunk === 'string' ? redactTokens(chunk, [token], { edges: true, ...options }) : redaction.maskTokenBytes(chunk, [token], { edges: true, ...options })));
    return stream;
  };
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = generator(seed);
    let note = '';
    for (let i = 0; i < 1 + random.int(8); i += 1) note += random.pick(NOISE);
    // The token spelled as JSON may spell it: `/` as `\/` or `\u002f`, a character as its \u escape.
    const spelled = [...token].map((char) => (char === '/' ? random.pick(['/', '\\/', '\\u002f', '\\u002F']) : random.next() < 0.15 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char)).join('');
    const document = `{"note":${JSON.stringify(note)},"error":"Rejected bearer ${spelled} here","ok":false}`;
    assert.equal(JSON.parse(document).error, `Rejected bearer ${token} here`, 'the document spells the token');
    const cuts = [...new Set(Array.from({ length: 1 + random.int(3) }, () => 1 + random.int(document.length - 1)))].sort((a, b) => a - b);
    const pieces = [0, ...cuts].map((at, i, all) => document.slice(at, all[i + 1]));
    const text = [];
    const asText = guardedWith(text);
    for (const piece of pieces) asText.write(piece);
    const bytes = [];
    const asBytes = guardedWith(bytes);
    for (const piece of pieces) asBytes.write(Buffer.from(piece));
    for (const [how, joined] of [['text', text.join('')], ['bytes', Buffer.concat(bytes).toString()]]) {
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(joined); }, `seed ${seed}, ${how}, cut at ${cuts}: ${joined}`);
      assert.deepEqual([parsed.note, parsed.ok], [note, false], `seed ${seed}, ${how}: the rest of the document is as it was`);
    }
  }
});