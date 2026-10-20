'use strict';
// Keeps every access token a process obtained out of everything the plugin WRITES.
//
// THE THREAT. A service that rejects or fails a request may repeat the bearer token it was sent in the diagnostic it answers with — whole, or by a part of it (https://www.rfc-editor.org/rfc/rfc7519#section-3) — and
// spelled however the text was made on its way: PLAIN; FOLDED (a gateway wraps a long value onto several lines, a column is wrapped at any width, a console prints a long string in pieces joined by `' +`, a console
// that prints in colours puts its codes between the pieces); or ESCAPED (a JSON body escapes a character as `\u0073` or a line break as `\r\n`, a body that was JSON inside JSON doubles every backslash, util.inspect
// escapes a control character as `\x0b`, and a literal backslash can stand right before a part of the token). A token the process obtained must not reach anything the plugin writes in any of those spellings. The
// service is NOT assumed to be an adversary that has the token and crafts text to defeat the reader (it would not need to: it has the token); a text that tries is refused, not guessed at (see COST).
//
// THE EXPOSURE. A token reaches a script's output when something the process reads quotes it. The SDK quotes a failed part of a `$batch` answer into the error it raises, returns a refused read as a warning, and hands a
// successful answer's data on; and the scripts print that text, journal it and write it into files. The Dataverse HttpClient (lib/sdk-http-client.js) takes the token out of an answer that is not a success — where the text
// holds it literally — but a success is returned byte for byte: a change set the service refuses as a whole is answered HTTP 200 with the one part that failed, and the strict readers that prove from a `$batch` answer what
// a change set did count the bytes each part declares, so the answer cannot be rewritten (what they prove, and the page backend's retry that follows from it, would change). The answer is the caller's.
//
// WHY AT THE OUTPUT. The text has more roads out of the SDK than anyone can list — the message and stack of an error, an object it keeps beneath it (frozen, or with accessors that must not be run to look), a warning in a
// result, a reason, the data of an answer — and every one of them ends in the same few places: the two streams a script prints on and the files it writes. There the text is a string, nothing is walked and no getter is run;
// the SDK's errors, its warnings and the service's answers stay exactly what they were; and a path nobody thought of cannot miss the token. Every token the process OBTAINED is known (a token is noted where it is read from the Azure
// CLI, lib/dataverse-auth.js, and where a client sends it), and none of them is written. The text is read AFTER a formatter made it (an error printed by `console.error` is formatted inside the console, from objects that
// must not be walked), so the reader reads what every formatter in the plugin adds between two characters of a string — white space, the joins and colour codes of util.inspect, escapes — as a fold (see below).
//
// EVERY OUTPUT PATH (sink), and what covers it:
//   - stdout and stderr: `process.stdout.write` and `process.stderr.write` are wrapped (guardStream) the moment the first token is obtained — never before, so a process that has no token is untouched. Every `console.*` call
//     (in colours too), every script's result printer and warning printer, the build's progress lines, a library's own `console.warn` and the SDK bundle's end there. A text is cleaned as a STRING; bytes (a Buffer) are passed
//     as they are: nothing in the plugin writes bytes to a stream, and a test runner's own frames are bytes. `emitResult` (lib/dataverse-auth.js) also cleans its own text, so a result is clean where a caller has replaced the
//     stream's `write`. The writes a `process.exit` follows at once are made blocking first (makeWritesBlocking), so that what is written there is whole when the process ends — not only clean.
//   - what Node itself prints when an error ends the process (an uncaught exception, an unhandled rejection): it never passes through `process.stderr.write`, so a handler prints it, cleaned, when nothing else handles the error
//     (guardFatalErrors).
//   - the files the plugin writes: `writeFileSafe` and `appendFileSafe` (lib/safe-fs.js: the build's journal and status file, a download's spec and pages, a page's file and its deployed copy, the plan, the settings template),
//     `writeFileAtomic` (lib/apply-snapshot-store.js: the apply snapshot, the baseline `last-applied.json`, the page ownership and publish records) and the SDK's workspace storage — every file the bundle writes goes through its
//     `writeTextAtomic` (lib/maker-sdk.js wraps it: guardWorkspaceStorage). tests/output-token-writers.test.js lists every other write in the plugin and says why none of them can carry a token.
//   - in the pcf plugin (which carries a copy of this module): its streams and its fatal errors as above (its scripts note their tokens through the same lib/dataverse-auth.js), the receipt `pcf-push.js` writes
//     (`pcf-receipt.json`) and the SDK workspace `makePcfSdk` makes; pcf's tests/pcf-push-token.test.js lists every other write of pcf and says why none of them can carry a token.
//   - not covered, by design: bytes (a Buffer given to a writer is written as it is); a token another process obtained (`pac` has its own); another encoding of a token (percent-encoding, base64 of a whole header, HTML
//     entities — nothing is known to quote a token in one, and a reader that guessed at them would blank ordinary text); a token written in two separate calls to `write` (no script writes a message in pieces); a token a
//     formatter CUT SHORT (util.inspect prints at most 10,000 characters of a string, and the end of a part cut off there is not the part); a raw control character other than white space and ESC between two of its characters.
//
// A TOKEN AS A TEXT SPELLS IT. A token is looked for as the text spells it, one character at a time: a character is itself, or an escape of it (`\u0073` for `s`, in either case of hex; `\x73`; `\/` for `/`), and between
// two characters of the token there may be a fold — any white space, a line break and its indentation (the obsolete line folding of https://www.rfc-editor.org/rfc/rfc9112#section-5.2, a column a gateway wrapped), spelled as
// it is or as its escape (`\r\n`, `\t`, `\b`), the quote, plus sign and line break `util.inspect` prints between the pieces of a long string (`'abc\r\n' +` newline `' def'`), a terminal colour code (`\u001b[32m`, also
// among the quote, plus sign and line break), or a STRAY backslash. A run of backslashes before an escape is one escape: a body that was JSON inside JSON holds `\\u0073` and `\\r\\n`. Nothing in a text says whether a
// backslash before a letter is an escape or a literal backslash (`\n` is a line break, or a backslash and the first `n` of a signature), so an escape that can be both is read BOTH ways, and a token found either way is
// the token. The span from the token's first character to its last — the folds and escapes inside it included, an escape always whole — becomes `<token>`, and the white space before and after it stays. In JSON text the
// span is always inside one string and never leaves half of an escape, so what was JSON is still JSON (the baseline and the journal are read back by the next run).
//
// COST. Every needle (the token, and each of its parts of 24 characters or more: needlesOf) is searched in ONE pass over the characters the text spells, as Knuth-Morris-Pratt does, in lockstep, so a text of any size takes time
// that grows with its size and a near miss of a long needle over and over costs no more than any other text; an escape read the other way starts a reading that is followed next to the pass, and at most MAX_READINGS of them
// per needle are alive at once — a real token keeps one or two — so no text makes the search backtrack or grow faster than the text. A text that would need more is not guessed at: the search fails, and every caller fails
// closed (tests/output-redaction.test.js measures all of it). A text that holds no token comes back as the very string.
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

// A needle the reader cannot read: it holds white space, which the reader skips, a backslash, which it reads as the start of an escape, or an ESC, which it reads as the start of a terminal colour code. Such a token is
// searched for literally (see redactWith).
function unreadable(needle) {
  for (let i = 0; i < needle.length; i += 1) {
    const unit = needle.charCodeAt(i);
    if (unit === 0x5c || unit === 0x1b || isSpace(unit)) return true;
  }
  return false;
}

const hexValue = (unit) => (unit >= 0x30 && unit <= 0x39 ? unit - 0x30 : unit >= 0x41 && unit <= 0x46 ? unit - 0x37 : unit >= 0x61 && unit <= 0x66 ? unit - 0x57 : -1);

// What the reader makes of one item: -1 nothing (a fold), a character's code, or DUAL — an escape that is read two ways, because nothing in a text says whether its backslash is an escape or a literal backslash: as the
// escape (`primaryCode`: the character it stands for, or -1 for one that is white space or a control character) and as the letters after the backslashes (`literalFrom` up to the item's end: `n`, `u0073`, `x41`).
// Variables and not part of a result: this runs for every character of a text that may be megabytes long, and an object for each would be most of its cost.
const DUAL = -2;
let spelledWidth = 1;
let primaryCode = -1;
let literalFrom = 0;

// The item at `at` that begins with a backslash. A RUN of backslashes and what follows it is ONE item, whatever the run's length (JSON inside JSON doubles every backslash), and it is always read whole, so that a match
// never leaves half of an escape behind:
//   `\u0073` `\\u0073` (either case of hex)     → 's', or the letters `u0073`               width of the run + 5   (a white space it spells is nothing)
//   `\x73` (how util.inspect escapes a control)  → 's', or the letters `x73`                 width of the run + 3
//   `\/`                                         → '/'                                       width of the run + 1
//   `\n` `\r` `\t` `\f` `\b` `\v`                → nothing (a line break, a control), or the letter itself   width of the run + 1
//   any other backslash run, before anything else or at the end of the text — a STRAY backslash between two characters of a token: nothing, a fold, width of the run (what follows is read on its own)
// https://www.rfc-editor.org/rfc/rfc8259#section-7 lists the escapes of a JSON string; util.inspect adds `\x..` and `\v` for a JavaScript string. A run read as one item (and not one backslash at a time) is what keeps a
// long run of backslashes from being read again at each of them: the reader stays linear.
function readEscape(text, at) {
  let end = at + 1;
  while (text.charCodeAt(end) === 0x5c) end += 1;
  const run = end - at;
  const letter = text.charCodeAt(end);
  const digits = letter === 0x75 ? 4 : letter === 0x78 ? 2 : 0;
  if (digits > 0) {
    let decoded = 0;
    for (let i = 1; i <= digits && decoded >= 0; i += 1) {
      const value = hexValue(text.charCodeAt(end + i));
      decoded = value < 0 ? -1 : (decoded << 4) | value;
    }
    if (decoded >= 0) {
      spelledWidth = run + 1 + digits;
      primaryCode = isSpace(decoded) ? -1 : decoded;
      literalFrom = end;
      return DUAL;
    }
  } else if (letter === 0x2f) {
    spelledWidth = run + 1;
    return 0x2f;
  } else if (letter === 0x6e || letter === 0x72 || letter === 0x74 || letter === 0x66 || letter === 0x62 || letter === 0x76) {
    spelledWidth = run + 1;
    primaryCode = -1;
    literalFrom = end;
    return DUAL;
  }
  spelledWidth = run;
  return -1;
}

// The most parameter bytes a terminal colour code is read with: util.inspect writes two or three (`\u001b[32m`); a longer one is no code anybody prints, and a bound keeps the reader from scanning on.
const MAX_CODE_PARAMETERS = 32;

// Where the terminal code that begins at `at` (an ESC) ends, or -1 for an ESC that does not begin one: ESC, `[`, up to MAX_CODE_PARAMETERS parameter and intermediate bytes (0x20-0x3f), and one final byte (0x40-0x7e) —
// a control sequence of ECMA-48 (https://ecma-international.org/publications-and-standards/standards/ecma-48/, section 5.4), the shape of every colour code (`\u001b[32m`, `\u001b[1;31m`, `\u001b[39m`).
function codeEnd(text, at) {
  if (text.charCodeAt(at + 1) !== 0x5b) return -1;
  const limit = at + 2 + MAX_CODE_PARAMETERS;
  for (let i = at + 2; i <= limit; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0x40 && unit <= 0x7e) return i + 1;
    if (!(unit >= 0x20 && unit <= 0x3f)) return -1;
  }
  return -1;
}

// What may stand between the quote, the plus sign and the line break that join the pieces of a long string: spaces, tabs and — on a console that prints in colours — the codes that end one piece's colour and begin the next's.
function skipJoin(text, at) {
  let i = at;
  for (;;) {
    const unit = text.charCodeAt(i);
    if (unit === 0x20 || unit === 0x09) {
      i += 1;
      continue;
    }
    const end = unit === 0x1b ? codeEnd(text, i) : -1;
    if (end < 0) return i;
    i = end;
  }
}

// A long string as `util.inspect` prints it — `console.error(error)` prints the body an error keeps that way — is cut after each line break and the pieces are joined as source code joins them; on a console that prints in
// colours (a terminal, or FORCE_COLOR=1) each piece is wrapped in its own colour codes:
//   message: 'Rejected bearer abcdefgh\r\n' +                         message: \u001b[32m'Rejected bearer abcdefgh\r\n'\u001b[39m +
//     ' ijklmnop\r\n' +                                                 \u001b[32m' ijklmnop\r\n'\u001b[39m +
//     ' qrstuvwx'                                                       \u001b[32m' qrstuvwx'\u001b[39m
// The closing quote, the codes, the plus sign, the line break, the indentation and the same quote again stand where the string has no character, so they are skipped like a fold. Anything else after a quote is the quote, a
// character of its own.
function readContinuation(text, at, quote) {
  let i = skipJoin(text, at + 1);
  if (text.charCodeAt(i) !== 0x2b) return quote;
  i = skipJoin(text, i + 1);
  if (text.charCodeAt(i) === 0x0d) i += 1;
  if (text.charCodeAt(i) !== 0x0a) return quote;
  i = skipJoin(text, i + 1);
  if (text.charCodeAt(i) !== quote) return quote;
  spelledWidth = i + 1 - at;
  return -1;
}

// `skip` says what an ASCII character is to the reader: 0 a character like any other, 1 white space, 2 a quote that may begin a continuation (it is 0 where a needle holds that character), 3 an ESC — a terminal code, or a
// lone ESC, is a fold: a console that prints in colours puts codes between the pieces of a string, and a colourful log line can put one anywhere.
function readSpelled(text, at, skip) {
  const unit = text.charCodeAt(at);
  spelledWidth = 1;
  if (unit === 0x5c) return readEscape(text, at);
  if (unit < 128) {
    const kind = skip[unit];
    if (kind === 0) return unit;
    if (kind === 1) return -1;
    if (kind === 3) {
      const end = codeEnd(text, at);
      if (end > 0) spelledWidth = end - at;
      return -1;
    }
    return readContinuation(text, at, unit);
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

// How many readings of ONE needle that took an escape's letters (and not the escape) the search follows at once. A random token keeps one or two alive on any text, and a needle that is one letter over and over keeps
// one per letter; more than this needs a text made to match the needle almost everywhere — i.e. made by someone who has the token. The bound keeps the cost linear on any text: past it the search does not guess which
// reading to drop (a dropped one could be the token), it fails, and every caller fails closed (a stream writes WITHHELD, a file is not written).
const MAX_READINGS = 128;
const TOO_MANY_READINGS = 'output-redaction: a text holds too many ways to read a token for it to be checked';

// Everything the search needs of a set of tokens, made once and not for each text: the needles it can read and each one's failure table, the first character of each (a text is only looked at closely where one could start,
// or where a needle is already being matched), what the reader skips, and the tokens that still need a literal search for a needle of their own that the reader cannot read.
function prepare(tokens) {
  const live = [...new Set(tokens.filter((token) => typeof token === 'string' && token !== ''))];
  if (live.length === 0) return null;
  const needles = [...new Set(live.flatMap(needlesOf))].filter((needle) => !unreadable(needle));
  const skip = new Uint8Array(128);
  for (const unit of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) skip[unit] = 1;
  for (const unit of [0x22, 0x27, 0x60]) skip[unit] = 2;
  skip[0x1b] = 3;
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
    // For each needle, the readings that took an escape's letters: how far each is (`states`) and where it began (`begins`), with a second pair the next set is made in, and `slot` — for a state, 1 + its index in the next
    // set — so that two readings that have come equally far are kept once, with the earlier beginning (whatever the later one would find, the earlier one finds with a span that holds it).
    readings: needles.map((needle) => ({
      count: 0,
      states: new Int32Array(MAX_READINGS),
      begins: new Int32Array(MAX_READINGS),
      nextCount: 0,
      nextStates: new Int32Array(MAX_READINGS),
      nextBegins: new Int32Array(MAX_READINGS),
      slot: new Int32Array(needle.length + 1),
    })),
  };
}

// Puts a reading that has come `state` characters into the needle, begun at `begin`, into the next set of `readings`.
function keepReading(readings, state, begin) {
  const index = readings.slot[state] - 1;
  if (index >= 0) {
    if (begin < readings.nextBegins[index]) readings.nextBegins[index] = begin;
    return;
  }
  if (readings.nextCount === MAX_READINGS) {
    for (let i = 0; i < readings.nextCount; i += 1) readings.slot[readings.nextStates[i]] = 0;
    throw new RangeError(TOO_MANY_READINGS);
  }
  readings.nextStates[readings.nextCount] = state;
  readings.nextBegins[readings.nextCount] = begin;
  readings.nextCount += 1;
  readings.slot[state] = readings.nextCount;
}

// A reading that has come `state` characters into `needle`, begun at `begin`, read on through the letters `text[from, end)` of one escape: it ends there (a letter that is not the needle's next character), is a match
// (the span reaches to the end of the escape, so that no half of it is left), or goes on in the next set.
function readLetters(text, from, end, needle, readings, state, begin, spans) {
  let at = state;
  for (let j = from; j < end; j += 1) {
    if (needle.charCodeAt(at) !== text.charCodeAt(j)) return;
    at += 1;
    if (at === needle.length) {
      spans.push([begin, end]);
      return;
    }
  }
  keepReading(readings, at, begin);
}

// An escape that is read two ways (DUAL), spanning `[begin, end)`. For each needle the next set of readings is made of: every reading already followed, taking the escape as the character it stands for (or as nothing) AND
// as its letters; every alignment the main search follows (its state, and each shorter one that is also alive: the failure table's chain), taking the letters; and a new reading beginning at any of the letters. The main
// search then takes the escape's first reading itself. Returns whether any reading is alive.
function forkReadings(text, begin, end, prepared, read, spans) {
  const { needles, tables, longest, starts, states, readings: all } = prepared;
  const primary = primaryCode;
  const from = literalFrom;
  let alive = false;
  for (let n = 0; n < needles.length; n += 1) {
    const needle = needles[n];
    const readings = all[n];
    readings.nextCount = 0;
    for (let i = 0; i < readings.count; i += 1) {
      const state = readings.states[i];
      const began = readings.begins[i];
      if (primary === -1) keepReading(readings, state, began);
      else if (needle.charCodeAt(state) === primary) {
        if (state + 1 === needle.length) spans.push([began, end]);
        else keepReading(readings, state + 1, began);
      }
      readLetters(text, from, end, needle, readings, state, began, spans);
    }
    for (let state = states[n]; state > 0; state = tables[n][state - 1]) readLetters(text, from, end, needle, readings, state, starts[(read - state) % longest], spans);
    const first = needle.charCodeAt(0);
    for (let j = from; j < end; j += 1) if (text.charCodeAt(j) === first) readLetters(text, j, end, needle, readings, 0, begin, spans);
    for (let i = 0; i < readings.nextCount; i += 1) readings.slot[readings.nextStates[i]] = 0;
    [readings.states, readings.nextStates] = [readings.nextStates, readings.states];
    [readings.begins, readings.nextBegins] = [readings.nextBegins, readings.begins];
    readings.count = readings.nextCount;
    if (readings.count > 0 || states[n] > 0) alive = true;
  }
  return alive;
}

// Every needle searched for in ONE pass over the items the text spells, in time that grows with the text: a search that starts again at every character takes seconds on a text that is a needle's first thousand
// characters over and over. A needle's state is how many of its first characters the last items spell — on the escapes' first readings (as the character an escape stands for, or nothing), as Knuth-Morris-Pratt does it.
// An escape that can also be its letters (a literal backslash before an `n`) starts readings that the search follows next to it, a bounded set (forkReadings). A match runs from where the first of its characters is
// spelled to where its last ends — the folds and escapes between them are inside it, and the white space before and after is not. `starts` remembers where each of the last items began, in a ring as long as the longest
// needle, which is all a match can reach back over; an item that cannot start a match while no needle is being matched is counted and not stored, because no match will ever ask for its start. The spans of all the
// needles are then merged where they overlap (a token and its parts do) and each merged span is replaced by one marker; two spans that only touch stay two, as two tokens written one after the other are two.
function takeOutSpelled(text, prepared) {
  const { needles, tables, longest, firstUnits, skip, starts, states, readings: all } = prepared;
  const count = needles.length;
  states.fill(0);
  for (const readings of all) readings.count = 0;
  const spans = [];
  let read = 0;
  let matching = false;
  for (let at = 0; at < text.length;) {
    const begin = at;
    let code = readSpelled(text, at, skip);
    at += spelledWidth;
    if (code === -1) continue;
    let forked = false;
    if (code === DUAL) {
      code = primaryCode;
      let letterStarts = false;
      for (let j = literalFrom; j < at && !letterStarts; j += 1) letterStarts = firstUnits[text.charCodeAt(j)] === 1;
      if (matching || letterStarts) {
        matching = forkReadings(text, begin, at, prepared, read, spans);
        forked = true;
      }
      if (code === -1) continue;
    }
    if (!matching && firstUnits[code] === 0) {
      read += 1;
      continue;
    }
    starts[read % longest] = begin;
    matching = false;
    for (let n = 0; n < count; n += 1) {
      const needle = needles[n];
      const readings = all[n];
      if (!forked && readings.count > 0) {
        let kept = 0;
        for (let i = 0; i < readings.count; i += 1) {
          const state = readings.states[i];
          if (needle.charCodeAt(state) !== code) continue;
          if (state + 1 === needle.length) {
            spans.push([readings.begins[i], at]);
            continue;
          }
          readings.states[kept] = state + 1;
          readings.begins[kept] = readings.begins[i];
          kept += 1;
        }
        readings.count = kept;
      }
      if (readings.count > 0) matching = true;
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

// `text` with the tokens `prepared` stands for taken out: what the reader finds, and then — only for a token that has a needle the reader cannot read (white space, a backslash or an ESC in it) — a literal search, as the Dataverse
// client's scrubber does it. The reader first, so that a token spelled in one piece is one marker: a literal search first would take out the parts of a token whose dots are inside a fold, and leave `<token>.<token>`
// where the reader finds the whole.
function redactWith(prepared, text) {
  let out = text;
  if (prepared.needles.length > 0) out = takeOutSpelled(out, prepared);
  for (const token of prepared.literal) out = needlesOf(token).reduce((current, needle) => current.split(needle).join(TOKEN_MARKER), out);
  return out;
}

/**
 * `text` with every token in `tokens` taken out of it — whole, and by each of its parts of 24 characters or more — wherever the text spells it: plainly, with a fold in it, with an escape in it (or a stray backslash), or
 * printed over several lines the way `util.inspect` prints a long string, in colours or not. A text that holds none is returned as the same string. Throws a RangeError for a text that holds too many ways to read a token
 * to be checked (MAX_READINGS): a caller must then not write the text.
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
 * `text` with every token this process has obtained taken out of it. Anything that is not a string — bytes, a number — is returned as it is, and so is a text when no token has been obtained yet. Throws as `redactTokens`
 * does for a text that cannot be checked; every caller then fails closed (the guard on a stream writes a notice instead of the text, a file writer writes nothing and reports the failure).
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

/**
 * Makes the writes to each of `streams` blocking from here on: a `write` returns when the stream has taken the whole text. For the last writes of a process — the ones a `process.exit` follows at once (`emitResult` in
 * lib/dataverse-auth.js, the printer of an error that ends the process below, a script's own result printer). Nothing else about the stream changes: the text still goes through its `write`, the guard above included.
 * Each plugin's tests list every exit of its code that is not protected by this, with the bound that makes it safe (tests/exit-writes-inventory.test.js in model-apps, tests/pcf-exit-writes-inventory.test.js in pcf).
 *
 * WHY. Node writes to a pipe asynchronously on Linux and macOS, and synchronously on Windows (https://nodejs.org/api/process.html#a-note-on-process-io). What the pipe does not take at once — more than its buffer holds,
 * 64 KiB on Linux — is queued, and `process.exit` ends the process without waiting for the queue (https://nodejs.org/api/process.html#processexitcode). An agent reads a script's result through a pipe, so a large
 * result reached it cut short: on the Linux and macOS CI jobs the 3.5 MB result of tests/output-token-boundary.test.js ended mid-string (for example "Unterminated string in JSON at position 146176").
 * A blocking handle is what Node itself gives a terminal (`tty.WriteStream` calls `setBlocking(true)`) and, on Windows, a pipe on stdout or stderr (`net.Socket`: "Make stdout and stderr blocking on Windows"); libuv then
 * completes every write synchronously (uv_stream_set_blocking: https://docs.libuv.org/en/v1.x/stream.html). tests/result-whole-before-exit.test.js gives a script the kind of pipe Linux and macOS give it, on every
 * platform: without this, a 3.5 MB result arrived in part on Windows too; with it, whole.
 *
 * SAFE because it is done at the end: the process exits right after, so no other work waits behind a blocking write. A reader that is reading takes the text; one that has stopped reading now holds the script at its last
 * write — as a pipe on Windows always has — instead of receiving a result cut short. On POSIX the flag belongs to the pipe's open file description, which every process holding that end shares, and Node puts it back as
 * it found it when the process exits (ResetStdio, src/node.cc). A write queued BEFORE this call (only when the reader has left more than a pipe's buffer unread, with no turn of the event loop since) stays queued, and the
 * writes after it wait behind it in the stream's own buffer: Node has no synchronous flush of a queued write. That is why this is called before the last writes, not just before `process.exit`.
 *
 * A stream with no such handle — a file (written synchronously already), a worker's stdout, a test's stand-in — is left as it is, and so is a handle that answers with an error code (a terminal on Windows answers EINVAL:
 * libuv blocks only a pipe there). Never throws: the text is written either way.
 * @param {...?{ _handle?: ?{ setBlocking?: Function } }} streams
 */
function makeWritesBlocking(...streams) {
  for (const stream of streams) {
    try {
      const handle = stream && stream._handle;
      if (handle && typeof handle.setBlocking === 'function') handle.setBlocking(true);
    } catch {
      // A handle that throws (a closed or foreign one): the text goes out as it always did.
    }
  }
}

// Node prints an error that ends the process (an exception nothing caught, a promise rejected and never handled) from its own code, and not through `process.stderr.write`, so the wrapper on the stream does not see it
// (measured on Node 20 and 22: a replaced `write` is never called). With a listener the default — print, exit with status 1 — is replaced by this one, which prints the same error, cleaned, and exits with the same status.
// Only when nothing else handles the error: a test runner has its own listener, and a host that added one after this one has taken the decision over. `breakLength: Infinity` keeps `inspect` from cutting a long string
// into pieces joined with `+`, which is the one thing that could make a cleaned text differ from the text a person reads. The write is made blocking first (makeWritesBlocking): this handler exits right after it, so a
// long error (an answer the SDK quoted into it) would otherwise reach a pipe on Linux and macOS cut short.
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
    makeWritesBlocking(process.stderr);
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
 * through nothing else, so this is every file the SDK writes. Everything else is the storage's own and runs ON the storage: a method is called with the storage as `this` and an accessor is read from it, because a
 * storage may keep its state in `#private` fields, which only the object they were made for can read (a wrapper that is merely a child of the storage would be `this` instead, and fail). The wrapper is a Proxy over an
 * empty child of the storage — not over the storage itself, whose own frozen members would bind what a Proxy may answer — so the SDK still finds the folder (`pathFor`, `getRoot`) and an `instanceof` still holds; a value
 * set through it is set on the storage.
 * @template T
 * @param {T} storage
 * @param {(text: string) => string} [redact]
 * @returns {T}
 */
function guardWorkspaceStorage(storage, redact = redactOutput) {
  if (storage === null || typeof storage !== 'object' || typeof storage.writeTextAtomic !== 'function') return storage;
  const writeTextAtomic = function writeTextAtomicWithoutTokens(key, text, ...rest) {
    return storage.writeTextAtomic(key, typeof text === 'string' ? redact(text) : text, ...rest);
  };
  // One function per member, so that a member read twice is the same function, as it is on the storage.
  const onStorage = new Map();
  return new Proxy(Object.create(storage), {
    get(target, key) {
      if (key === 'writeTextAtomic') return writeTextAtomic;
      const value = Reflect.get(storage, key, storage);
      if (typeof value !== 'function' || key === 'constructor') return value;
      if (!onStorage.has(value)) onStorage.set(value, function onTheStorage(...args) { return value.apply(storage, args); });
      return onStorage.get(value);
    },
    set(target, key, value) {
      return Reflect.set(storage, key, value, storage);
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
  makeWritesBlocking,
  guardFatalErrors,
  installOutputGuard,
  guardWorkspaceStorage,
};
