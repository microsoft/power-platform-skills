'use strict';
// Keeps every access token a process obtained out of everything the plugin WRITES.
//
// THE EXPOSURE. A token reaches a script's output when something the process reads quotes it. A service that rejects a bearer token may repeat it in the diagnostic it answers with — whole, or by a part of it
// (https://www.rfc-editor.org/rfc/rfc7519#section-3), and spelled however its gateway wraps and escapes a long value. The SDK then quotes a failed part of a `$batch` answer into the error it raises, returns a refused read as
// a warning, and hands a successful answer's data on; and the scripts print that text, journal it and write it into files. The Dataverse HttpClient (lib/sdk-http-client.js) takes the token out of an answer that is not a
// success — where the text holds it literally — but a success is returned byte for byte: a change set the service refuses as a whole is answered HTTP 200 with the one part that failed, and the strict readers that prove from a
// `$batch` answer what a change set did count the bytes each part declares, so the answer cannot be rewritten (what they prove, and the page backend's retry that follows from it, would change). The answer is the caller's.
//
// WHY AT THE OUTPUT. The text has more roads out of the SDK than anyone can list — the message and stack of an error, an object it keeps beneath it (frozen, or with accessors that must not be run to look), a warning in a
// result, a reason, the data of an answer — and every one of them ends in the same few places: the two streams a script prints on and the files it writes. There the text is a string, nothing is walked and no getter is run;
// the SDK's errors, its warnings and the service's answers stay exactly what they were; and a path nobody thought of cannot miss the token. Every token the process OBTAINED is known (a token is noted where it is read from the Azure
// CLI, lib/dataverse-auth.js, and where a client sends it), and none of them is written.
//
// EVERY OUTPUT PATH, and what covers it:
//   - stdout and stderr: `process.stdout.write` and `process.stderr.write` are wrapped (guardStream) the moment the first token is obtained — never before, so a process that has no token is untouched. Every `console.*` call, every
//     script's result printer and warning printer, the build's progress lines, a library's own `console.warn` and the SDK bundle's end there. A text is cleaned as a STRING; bytes (a Buffer) are passed as they are: nothing in the
//     plugin writes bytes to a stream, and a test runner's own frames are bytes. `emitResult` (lib/dataverse-auth.js) also cleans its own text, so a result is clean where a caller has replaced the stream's `write`.
//   - what Node itself prints when an error ends the process (an uncaught exception, an unhandled rejection): it never passes through `process.stderr.write`, so a handler prints it, cleaned, when nothing else handles the error
//     (guardFatalErrors).
//   - the files the plugin writes: `writeFileSafe` and `appendFileSafe` (lib/safe-fs.js: the build's journal and status file, a download's spec and pages, a page's file and its deployed copy, the plan, the settings template),
//     `writeFileAtomic` (lib/apply-snapshot-store.js: the apply snapshot, the baseline `last-applied.json`, the page ownership and publish records) and the SDK's workspace storage — every file the bundle writes goes through its
//     `writeTextAtomic` (lib/maker-sdk.js wraps it: guardWorkspaceStorage). tests/output-token-writers.test.js lists every other write in the plugin and says why none of them can carry a token.
//   - not covered, by design: bytes (a Buffer given to a writer is written as it is); a token another process obtained (`pac` has its own); another encoding of a token (percent-encoding, base64 of a whole header, HTML
//     entities — nothing is known to quote a token in one, and a reader that guessed at them would blank ordinary text); a token written in two separate calls to `write` (no script writes a message in pieces).
//
// A TOKEN AS A TEXT SPELLS IT. A token is looked for as the text spells it, one character at a time: a character is itself, or a JSON escape of it (`\u0073` for `s`, in either case of hex; `\/` for `/`), and between two
// characters of the token there may be a fold — any white space, a line break and its indentation (the obsolete line folding of https://www.rfc-editor.org/rfc/rfc9112#section-5.2, a column a gateway wrapped), spelled as it
// is or as its JSON escape (`\r\n`), or the quote, plus sign and line break `util.inspect` prints between the pieces of a long string (`'abc\r\n' +` newline `' def'`). A run of backslashes before an escape is one escape: a
// body that was JSON inside JSON holds `\\u0073` and `\\r\\n`. The span from the token's first character to its last — the folds and escapes inside it included — becomes `<token>`, and the white space before and after it
// stays. In JSON text the span is always inside one string and never leaves half of an escape, so what was JSON is still JSON (the baseline and the journal are read back by the next run).
//
// COST. Every needle (the token, and each of its parts of 24 characters or more: needlesOf) is searched in ONE pass over the characters the text spells, as Knuth-Morris-Pratt does, in lockstep, so a text of any size takes time
// that grows with its size and a near miss of a long needle over and over costs no more than any other text (tests/output-redaction.test.js measures both). A text that holds no token comes back as the very string.
const { inspect } = require('node:util');

// What takes the place of a token, or of a part of one, in a text.
const TOKEN_MARKER = '<token>';
// Not the token alone: what an error or a gateway repeats of a bearer token is often one part of it. A token is `header.payload.signature` (three base64url parts joined by dots;
// https://www.rfc-editor.org/rfc/rfc7519#section-3), so each part long enough to be distinctive is taken out too.
const MIN_TOKEN_PART_LENGTH = 24;
// What is kept as a token: the floor of the Dataverse client's own scrubbing. A shorter value is a test's, and would be taken out of ordinary words.
const MIN_TOKEN_LENGTH = 16;

// The texts of one token that are taken out of a message: the token itself and each of its parts that is long enough to be distinctive, the longest first, once each.
function needlesOf(token) {
  const needles = new Set([token]);
  for (const part of token.split('.')) if (part.length >= MIN_TOKEN_PART_LENGTH) needles.add(part);
  return [...needles].sort((a, b) => b.length - a.length);
}

// ---- Reading a text as it spells a token ----------------------------------------------------------------------------------------------------------------------------------------------------------

// White space as a regular expression's `\s` reads it: a fold can be made of any of it, and the plugin's own tests normalize a text with that class.
function isSpace(unit) {
  return unit === 0x20 || (unit >= 0x09 && unit <= 0x0d) || unit === 0xa0 || unit === 0x1680 || (unit >= 0x2000 && unit <= 0x200a)
    || unit === 0x2028 || unit === 0x2029 || unit === 0x202f || unit === 0x205f || unit === 0x3000 || unit === 0xfeff;
}

// A needle the reader cannot read: it holds white space, which the reader skips, or a backslash, which it reads as the start of an escape. Such a token is searched for literally (see redactWith).
function unreadable(needle) {
  for (let i = 0; i < needle.length; i += 1) {
    const unit = needle.charCodeAt(i);
    if (unit === 0x5c || isSpace(unit)) return true;
  }
  return false;
}

const hexValue = (unit) => (unit >= 0x30 && unit <= 0x39 ? unit - 0x30 : unit >= 0x41 && unit <= 0x46 ? unit - 0x37 : unit >= 0x61 && unit <= 0x66 ? unit - 0x57 : -1);

// How many UTF-16 units the item just read took. A variable and not part of the result: this runs for every character of a text that may be megabytes long, and an object for each would be most of its cost.
let spelledWidth = 1;

// The item at `at` is a character of the token's alphabet, or is skipped (-1), or breaks a token (any other code). A run of backslashes before one of the letters of a JSON escape is ONE escape, whatever the run's length
// (JSON inside JSON doubles every backslash):
//   plain character                         `s`                  → 's'          width 1
//   white space                             ` ` TAB CR LF …      → skipped      width 1
//   JSON unicode escape, either case        `\u0073` `\\u0073`   → 's'          width 6 and up (a white space it spells is skipped)
//   JSON solidus escape                     `\/`                 → '/'          width 2 and up
//   JSON escape of white space              `\r` `\n` `\t` `\f`  → skipped      width 2 and up
//   any other backslash, or a `\u` with no four hex digits after it — the whole run, as ONE break         width of the run
// https://www.rfc-editor.org/rfc/rfc8259#section-7 lists the escapes of a JSON string. A run read as one break (and not one backslash at a time) is what keeps a long run of backslashes from being read again at each of
// them: the reader stays linear.
function readEscape(text, at) {
  let end = at + 1;
  while (text.charCodeAt(end) === 0x5c) end += 1;
  const run = end - at;
  const letter = text.charCodeAt(end);
  if (letter === 0x75) {
    const a = hexValue(text.charCodeAt(end + 1));
    const b = hexValue(text.charCodeAt(end + 2));
    const c = hexValue(text.charCodeAt(end + 3));
    const d = hexValue(text.charCodeAt(end + 4));
    if ((a | b | c | d) >= 0) {
      const decoded = (a << 12) | (b << 8) | (c << 4) | d;
      spelledWidth = run + 5;
      return isSpace(decoded) ? -1 : decoded;
    }
  } else if (letter === 0x2f) {
    spelledWidth = run + 1;
    return 0x2f;
  } else if (letter === 0x72 || letter === 0x6e || letter === 0x74 || letter === 0x66) {
    spelledWidth = run + 1;
    return -1;
  }
  spelledWidth = run;
  return 0x5c;
}

// A long string as `util.inspect` prints it — `console.error(error)` prints the body an error keeps that way — is cut after each line break and the pieces are joined as source code joins them:
//   message: 'Rejected bearer abcdefgh\r\n' +
//     ' ijklmnop\r\n' +
//     ' qrstuvwx'
// The closing quote, the plus sign, the line break and the same quote again stand where the string has no character, so they are skipped like a fold. Anything else after a quote is the quote, a character of its own.
function readContinuation(text, at, quote) {
  let i = at + 1;
  while (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x09) i += 1;
  if (text.charCodeAt(i) !== 0x2b) return quote;
  i += 1;
  while (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x09) i += 1;
  if (text.charCodeAt(i) === 0x0d) i += 1;
  if (text.charCodeAt(i) !== 0x0a) return quote;
  i += 1;
  while (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x09) i += 1;
  if (text.charCodeAt(i) !== quote) return quote;
  spelledWidth = i + 1 - at;
  return -1;
}

// `skip` says what an ASCII character is to the reader: 0 a character like any other, 1 white space, 2 a quote that may begin a continuation (it is 0 where a needle holds that character).
function readSpelled(text, at, skip) {
  const unit = text.charCodeAt(at);
  spelledWidth = 1;
  if (unit === 0x5c) return readEscape(text, at);
  if (unit < 128) {
    const kind = skip[unit];
    if (kind === 0) return unit;
    return kind === 1 ? -1 : readContinuation(text, at, unit);
  }
  return isSpace(unit) ? -1 : unit;
}

// The longest proper prefix of `needle.slice(0, i + 1)` that is also its suffix, for each i: where a search for the needle goes on after a mismatch, so that it never reads a character twice
// (https://en.wikipedia.org/wiki/Knuth%E2%80%93Morris%E2%80%93Pratt_algorithm).
function failureTable(needle) {
  const table = new Int32Array(needle.length);
  for (let i = 1, k = 0; i < needle.length; i += 1) {
    while (k > 0 && needle.charCodeAt(i) !== needle.charCodeAt(k)) k = table[k - 1];
    if (needle.charCodeAt(i) === needle.charCodeAt(k)) k += 1;
    table[i] = k;
  }
  return table;
}

// Everything the search needs of a set of tokens, made once and not for each text: the needles it can read and each one's failure table, the first character of each (a text is only looked at closely where one could start,
// or where a needle is already being matched), what the reader skips, and the tokens that still need a literal search for a needle of their own that the reader cannot read.
function prepare(tokens) {
  const live = [...new Set(tokens.filter((token) => typeof token === 'string' && token !== ''))];
  if (live.length === 0) return null;
  const needles = [...new Set(live.flatMap(needlesOf))].filter((needle) => !unreadable(needle));
  const skip = new Uint8Array(128);
  for (const unit of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) skip[unit] = 1;
  for (const unit of [0x22, 0x27, 0x60]) skip[unit] = 2;
  const firstUnits = new Uint8Array(65536);
  for (const needle of needles) {
    firstUnits[needle.charCodeAt(0)] = 1;
    for (let i = 0; i < needle.length; i += 1) {
      const unit = needle.charCodeAt(i);
      if (unit < 128) skip[unit] = 0;
    }
  }
  return {
    needles,
    tables: needles.map(failureTable),
    longest: needles.reduce((length, needle) => Math.max(length, needle.length), 0),
    firstUnits,
    skip,
    literal: live.filter((token) => needlesOf(token).some(unreadable)),
    // The search's working memory, kept with what it is made for: a stream is written in many small pieces, and an array of the longest needle's length made for each would cost more than the search. The search
    // never calls out and never starts another, so one set at a time is all there is.
    starts: new Int32Array(needles.reduce((length, needle) => Math.max(length, needle.length), 1)),
    states: new Int32Array(needles.length),
  };
}

// Every needle searched for in ONE pass over the items the text spells, in time that grows with the text: a search that starts again at every character takes seconds on a text that is a needle's first thousand
// characters over and over. A needle's state is how many of its first characters the last items spell. A match runs from where the first of its characters is spelled to where its last ends — the folds and escapes between
// them are inside it, and the white space before and after is not. `starts` remembers where each of the last items began, in a ring as long as the longest needle, which is all a match can reach back over; an item that
// cannot start a match while no needle is being matched is counted and not stored, because no match will ever ask for its start. The spans of all the needles are then merged where they overlap (a token and its parts do)
// and each merged span is replaced by one marker; two spans that only touch stay two, as two tokens written one after the other are two.
function takeOutSpelled(text, prepared) {
  const { needles, tables, longest, firstUnits, skip, starts, states } = prepared;
  const count = needles.length;
  states.fill(0);
  const spans = [];
  let read = 0;
  let matching = false;
  for (let at = 0; at < text.length;) {
    const begin = at;
    const code = readSpelled(text, at, skip);
    at += spelledWidth;
    if (code === -1) continue;
    if (!matching && firstUnits[code] === 0) {
      read += 1;
      continue;
    }
    starts[read % longest] = begin;
    matching = false;
    for (let n = 0; n < count; n += 1) {
      const needle = needles[n];
      const table = tables[n];
      let state = states[n];
      while (state > 0 && needle.charCodeAt(state) !== code) state = table[state - 1];
      if (needle.charCodeAt(state) === code) state += 1;
      if (state === needle.length) {
        spans.push([starts[(read - state + 1) % longest], at]);
        state = table[state - 1];
      }
      states[n] = state;
      if (state > 0) matching = true;
    }
    read += 1;
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let kept = 0;
  let [from, to] = spans[0];
  for (let i = 1; i <= spans.length; i += 1) {
    const span = spans[i];
    if (span !== undefined && span[0] < to) {
      to = Math.max(to, span[1]);
      continue;
    }
    out += text.slice(kept, from) + TOKEN_MARKER;
    kept = to;
    if (span !== undefined) [from, to] = span;
  }
  return out + text.slice(kept);
}

// `text` with the tokens `prepared` stands for taken out: what the reader finds, and then — only for a token that has a needle the reader cannot read (white space or a backslash in it) — a literal search, as the Dataverse
// client's scrubber does it. The reader first, so that a token spelled in one piece is one marker: a literal search first would take out the parts of a token whose dots are inside a fold, and leave `<token>.<token>`
// where the reader finds the whole.
function redactWith(prepared, text) {
  let out = text;
  if (prepared.needles.length > 0) out = takeOutSpelled(out, prepared);
  for (const token of prepared.literal) out = needlesOf(token).reduce((current, needle) => current.split(needle).join(TOKEN_MARKER), out);
  return out;
}

/**
 * `text` with every token in `tokens` taken out of it — whole, and by each of its parts of 24 characters or more — wherever the text spells it: plainly, with a fold in it, with a JSON escape in it, or printed over several
 * lines the way `util.inspect` prints a long string. A text that holds none is returned as the same string.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {string}
 */
function redactTokens(text, tokens) {
  const prepared = prepare(Array.isArray(tokens) ? tokens : []);
  return prepared === null || typeof text !== 'string' || text === '' ? text : redactWith(prepared, text);
}

// ---- The tokens this process obtained -------------------------------------------------------------------------------------------------------------------------------------------------------------

const obtained = new Set();
// Bumped when a token joins, so that what is prepared from the set is made again only then.
let version = 0;
let preparedFor = { version: -1, prepared: null };

/**
 * Notes an access token this process obtained or sent, once, and — the first time — puts the guards on what the process writes (installOutputGuard). Called where a token is read from the Azure CLI and where a client sends
 * one, so a token is known from the moment it exists, and before any text that could repeat it can be written. A value shorter than 16 characters is no access token and is ignored.
 * @param {unknown} token
 */
function noteToken(token) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || obtained.has(token)) return;
  obtained.add(token);
  version += 1;
  installOutputGuard();
}

/** Every access token this process has obtained, once each, the first obtained first. */
function obtainedTokens() {
  return [...obtained];
}

/**
 * `text` with every token this process has obtained taken out of it. Anything that is not a string — bytes, a number — is returned as it is, and so is a text when no token has been obtained yet.
 * @template T
 * @param {T} text
 * @returns {T}
 */
function redactOutput(text) {
  if (typeof text !== 'string' || obtained.size === 0 || text === '') return text;
  if (preparedFor.version !== version) preparedFor = { version, prepared: prepare([...obtained]) };
  return redactWith(preparedFor.prepared, text);
}

// ---- The streams, an error that ends the process, and the SDK's workspace --------------------------------------------------------------------------------------------------------------------------

// Put on the function that wraps a stream's `write`, so that a stream is wrapped once however many times it is asked.
const GUARDED = Symbol.for('power-platform-skills.output-redaction.guarded');
// What is written where a text could not be cleaned (the cleaning itself failed): not the text, which may hold the token — a failure here is rare enough to be loud.
const WITHHELD = '[output withheld: it could not be checked for an access token]\n';
// A string given with one of these encodings is not text (`write('6162', 'hex')`), so it is not read as text.
const BINARY_ENCODINGS = /^(?:hex|base64|base64url)$/i;

/**
 * Makes `stream.write` take the tokens out of every string it is given. The wrapper is the stream's own `write` property, put where the original was: whatever replaces it later replaces it whole, and a caller that wraps it
 * (`const write = stream.write; stream.write = …`) wraps it with the guard inside. Bytes are passed on as they are. Returns false for a stream that is already guarded or has no `write`.
 * @param {{ write: Function }} stream
 * @param {(text: string) => string} [redact]
 * @returns {boolean}
 */
function guardStream(stream, redact = redactOutput) {
  if (!stream || typeof stream.write !== 'function' || stream.write[GUARDED]) return false;
  const write = stream.write;
  const guarded = function writeWithoutTokens(chunk, ...rest) {
    let given = chunk;
    if (typeof chunk === 'string' && !(typeof rest[0] === 'string' && BINARY_ENCODINGS.test(rest[0]))) {
      try {
        given = redact(chunk);
      } catch {
        given = WITHHELD;
      }
    }
    return write.call(this, given, ...rest);
  };
  guarded[GUARDED] = true;
  stream.write = guarded;
  return true;
}

// Node prints an error that ends the process (an exception nothing caught, a promise rejected and never handled) from its own code, and not through `process.stderr.write`, so the wrapper on the stream does not see it
// (measured on Node 20 and 22: a replaced `write` is never called). With a listener the default — print, exit with status 1 — is replaced by this one, which prints the same error, cleaned, and exits with the same status.
// Only when nothing else handles the error: a test runner has its own listener, and a host that added one after this one has taken the decision over. `breakLength: Infinity` keeps `inspect` from cutting a long string
// into pieces joined with `+`, which is the one thing that could make a cleaned text differ from the text a person reads.
function guardFatalErrors() {
  if (process.listenerCount('uncaughtException') > 0) return false;
  process.on('uncaughtException', function fatalWithoutTokens(error, origin) {
    if (process.listenerCount('uncaughtException') > 1) return;
    let text;
    try {
      text = inspect(error, { breakLength: Infinity, depth: 10 });
    } catch {
      text = 'an error that could not be printed';
    }
    try {
      process.stderr.write(`${redactOutput(`${origin === 'unhandledRejection' ? 'Uncaught (in promise) ' : 'Uncaught '}${text}`)}\n`);
    } catch {
      // The stream is gone: there is nobody to tell.
    }
    process.exit(1);
  });
  return true;
}

let installed = false;
/**
 * Puts the guards on this process: stdout, stderr and the error that ends the process. Called by `noteToken` the first time a token is noted — not at load, so that a process that never has a token is untouched —
 * and harmless to call again. It never throws: a token has already been obtained, and failing here would fail the read that obtained it.
 */
function installOutputGuard() {
  if (installed) return;
  installed = true;
  for (const attempt of [() => guardStream(process.stdout), () => guardStream(process.stderr), guardFatalErrors]) {
    try {
      attempt();
    } catch {
      // A host with no usable stream: the rest is still guarded.
    }
  }
}

/**
 * `storage` (an SDK WorkspaceStorage) with the tokens taken out of every text it is asked to write. The SDK writes each file of its workspace — an artifact, its metadata, the manifest — through `writeTextAtomic(key, text)`, and
 * through nothing else, so this is every file the SDK writes. Everything else is the storage's own: the wrapper has it for a prototype, so the SDK still finds the folder (`pathFor`, `getRoot`) and an `instanceof` still holds.
 * @template T
 * @param {T} storage
 * @param {(text: string) => string} [redact]
 * @returns {T}
 */
function guardWorkspaceStorage(storage, redact = redactOutput) {
  if (storage === null || typeof storage !== 'object' || typeof storage.writeTextAtomic !== 'function') return storage;
  return Object.create(storage, {
    writeTextAtomic: {
      value: function writeTextAtomicWithoutTokens(key, text, ...rest) {
        return storage.writeTextAtomic(key, typeof text === 'string' ? redact(text) : text, ...rest);
      },
      writable: true,
      configurable: true,
      enumerable: true,
    },
  });
}

module.exports = {
  TOKEN_MARKER,
  needlesOf,
  noteToken,
  obtainedTokens,
  redactTokens,
  redactOutput,
  guardStream,
  guardFatalErrors,
  installOutputGuard,
  guardWorkspaceStorage,
};
