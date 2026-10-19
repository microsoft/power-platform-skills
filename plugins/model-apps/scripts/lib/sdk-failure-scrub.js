'use strict';
// The access tokens a process sent, taken out of what an SDK raises — where it leaves the SDK.
//
// THE EXPOSURE. A change set the service refuses as a whole is answered HTTP 200 with the one part that failed (the live shape, abridged):
//   HTTP/1.1 200 OK
//   --batchresponse_<id>
//   Content-Type: multipart/mixed; boundary=changesetresponse_<id>
//
//   --changesetresponse_<id>
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//
//   HTTP/1.1 403 Forbidden
//   Content-Type: application/json
//
//   {"error":{"code":"0x80040220","message":"Principal user rejected bearer <the token the request carried> for this write"}}
//   --changesetresponse_<id>--
//   --batchresponse_<id>--
// The SDK (`sendChangeSet`, which writes a flow's definition) reads that part and raises, for it, `ConnectionError("HTTP 403 from <url>: <message>")` with the part's body kept — parsed — as its `cause`. The scripts print the
// message, the build writes it to its journal, and a caller hands the error on. An authorization layer or a gateway that rejects a token may repeat it, whole or by a part (https://www.rfc-editor.org/rfc/rfc7519#section-3).
// See https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#batch-responses
//
// WHY NOT IN THE ANSWER. The HTTP client takes the token out of every answer that is not a success (lib/sdk-http-client.js), but this answer IS one, and a success is returned byte for byte: the strict readers that prove from
// a `$batch` answer what a change set did (completeBatchStatus, isBatchThrottled, batchRetryAfterMs, and through them the page backend's refusal proof and the retry that follows from it) count the bytes each part declares in its
// `Content-Length` and read its structure line by line. Rewriting the answer — to take the token out of a part found by its look, spelled however the service spelled it, with the same number of bytes — changed what those proved: a
// refusal read as unproven became proven, and a throttled page write went from two sends to six. So the answer is never touched, and the token is taken out of what the SDK made of it.
//
// WHY AT THE SDK FACTORY. Every error of the SDK leaves through a method of the instance a script holds, and every script makes its instance with the one factory (lib/maker-sdk.js; a test pins that no script requires the bundle
// itself). Behind it are the places an error can be printed or kept: more than three hundred reads of an error's message in sixty scripts and libraries, a hundred and fifty places that write to stderr, a hundred more to stdout,
// and the build's journal — a guard on those would have to be as wide as the plugin, and a path nobody thought of would miss it. At the factory it is one place, and it covers what the SDK does later as well.
//
// WHAT IS CLEANED. The text the SDK DECODED, in every place an error holds one: its message, its stack (an error's stack repeats its message, and prints with it), its own properties of any kind (a key too, as the plugin's answer
// scrubber does), the error beneath it (`cause`, an aggregate's `errors`) and the body it kept. A JSON escape the service used once is gone from that text (`\u0073` is `s`), so the token is read as it is. Two spellings survive
// the decoding, and a literal match alone would miss both:
//   - a token folded onto several lines — a gateway wraps a long header value; https://www.rfc-editor.org/rfc/rfc9112#section-5.2 calls it obsolete line folding, and a JSON string holds the break as the characters CR LF — which the
//     decoded text keeps as `abcdefgh\r\n ijklmnop\r\n …`;
//   - a body that is JSON inside JSON, whose escapes are escaped, so that the decoded text still holds `\u0073yntheticHeader…` or `\r\n` as text.
// So a token is matched as the text SPELLS it: white space between its characters is ignored (a fold, a wrapped column), and a JSON escape (`\uXXXX`, `\/`, and `\r` `\n` `\t` as the white space they spell) counts as the
// character it stands for. Other encodings (percent-encoding, base64 of the whole header) are not read: nothing is known to quote a token in them, and a reader that guessed at them would blank ordinary text.
//
// WHAT IS NOT. An answer — never touched (see above) — and the data a call returns: a text in a result is the caller's data, so only an Error found in a result is cleaned (a push that did not save carries its error in `error`, a
// failed publish in `publish.error`), and not a string the SDK made from one. A token this process did not send through a client of this plugin (lib/sdk-http-client.js remembers each one it sends) is not known to it.
const { scrub, needlesOf, sentTokens, TOKEN_MARKER } = require('./sdk-http-client.js');

// What takes the place of a structure that is too deep or too large to walk, as the answer scrubber's (lib/sdk-http-client.js scrubAnswer) does: it is replaced rather than left with a token in it.
const TOO_DEEP = '<too deeply nested to scrub>';
const TOO_LARGE = '<too large to scrub>';
// An error holds a handful of objects, and a real answer is nested a few levels deep. These stop a structure that is not one from stalling the exit of a script that is already failing.
const MAX_WALK_DEPTH = 100;
const MAX_WALK_NODES = 100000;
// How far into a RESULT to look for an Error, and how much of it to read: a result holds its errors at the top (`error`), one level down (`publish.error`) or in a list of such (`results[i].error`), and a list of a hundred
// thousand rows is read through in a few milliseconds. A result of more than a million values is not read to its end.
const MAX_RESULT_DEPTH = 8;
const MAX_RESULT_STEPS = 1000000;

const liveTokens = (tokens) => (Array.isArray(tokens) ? tokens : []).filter((token) => typeof token === 'string' && token !== '');
// A needle the matcher can read: it holds neither white space (which the matcher skips) nor a backslash (which it reads as the start of an escape).
const UNREADABLE = /[ \t\r\n\\]/;

// Everything the matcher needs of a set of tokens, made once for a walk and not for each text of it: the needles it can read, each one's failure table, and the tokens that still need the one scrubber's literal search for a
// needle of their own that it cannot. The last set is kept, because an SDK call hands over its result with the same tokens as the call before it.
let lastPrepared = null;
function prepare(tokens) {
  const live = liveTokens(tokens);
  if (live.length === 0) return null;
  const key = live.join('\n');
  if (lastPrepared && lastPrepared.key === key) return lastPrepared;
  const needles = [...new Set(live.flatMap(needlesOf))].filter((needle) => !UNREADABLE.test(needle));
  lastPrepared = {
    key,
    needles,
    tables: needles.map(failureTable),
    longest: needles.reduce((length, needle) => Math.max(length, needle.length), 0),
    literal: live.filter((token) => needlesOf(token).some((needle) => UNREADABLE.test(needle))),
  };
  return lastPrepared;
}

// ---- A token as a text spells it --------------------------------------------------------------------------------------------------------------------------------------------------------------------

// The character the text spells at offset `at`, in `spelledCode` (a UTF-16 unit, or -1 for white space), and how many units of the text spell it, in `spelledWidth`. Two variables and not a result: this runs for every character of a
// text that may be megabytes long, and an array or an object for each would be most of its cost.
//   plain character                      `s`            → 's'                 width 1
//   white space                          ` ` TAB CR LF  → -1                  width 1
//   JSON unicode escape, either case     `\u0073`       → 's'                 width 6
//   JSON solidus escape                  `\/`           → '/'                 width 2
//   JSON escape of white space           `\r` `\n` `\t` → -1                  width 2
//   any other backslash                  `\x`, `\u12 `  → '\'                 width 1   (it is what it is: the next character is read on its own)
// https://www.rfc-editor.org/rfc/rfc8259#section-7 lists the escapes of a JSON string.
let spelledCode = 0;
let spelledWidth = 1;
const hexValue = (unit) => (unit >= 0x30 && unit <= 0x39 ? unit - 0x30 : unit >= 0x41 && unit <= 0x46 ? unit - 0x37 : unit >= 0x61 && unit <= 0x66 ? unit - 0x57 : -1);
const isWhiteSpace = (unit) => unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d;
function readSpelled(text, at) {
  const unit = text.charCodeAt(at);
  spelledWidth = 1;
  if (unit !== 0x5c) {
    spelledCode = isWhiteSpace(unit) ? -1 : unit;
    return;
  }
  spelledCode = unit;
  const next = text.charCodeAt(at + 1);
  if (next === 0x75) {
    const a = hexValue(text.charCodeAt(at + 2));
    const b = hexValue(text.charCodeAt(at + 3));
    const c = hexValue(text.charCodeAt(at + 4));
    const d = hexValue(text.charCodeAt(at + 5));
    if ((a | b | c | d) >= 0) {
      const decoded = (a << 12) | (b << 8) | (c << 4) | d;
      spelledCode = isWhiteSpace(decoded) ? -1 : decoded;
      spelledWidth = 6;
    }
  } else if (next === 0x2f) {
    spelledCode = 0x2f;
    spelledWidth = 2;
  } else if (next === 0x72 || next === 0x6e || next === 0x74) {
    spelledCode = -1;
    spelledWidth = 2;
  }
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

// Every needle searched for in ONE pass over the characters `text` spells, in time that grows with the text: a search that starts again at every character takes seconds on a text that is a needle's first thousand characters
// over and over. A needle's state is how many of its first characters the last ones read spell. A match is where the first of its characters is spelled to where its last is — the folds and escapes between them are inside it, and the
// white space before and after is not. `starts` remembers where each of the last characters began, in a ring as long as the longest needle, which is all a match can reach back over.
// The spans of all the needles are then merged where they overlap (a token and its parts do) and each merged span is replaced by one marker; two spans that only touch stay two, as the one scrubber leaves two tokens written
// one after the other.
function takeOutSpelled(text, { needles, tables, longest }) {
  const starts = new Int32Array(longest);
  const states = new Int32Array(needles.length);
  const spans = [];
  let read = 0;
  for (let at = 0; at < text.length;) {
    readSpelled(text, at);
    const code = spelledCode;
    const end = at + spelledWidth;
    if (code !== -1) {
      starts[read % longest] = at;
      for (let n = 0; n < needles.length; n += 1) {
        const needle = needles[n];
        let state = states[n];
        while (state > 0 && needle.charCodeAt(state) !== code) state = tables[n][state - 1];
        if (needle.charCodeAt(state) === code) state += 1;
        if (state === needle.length) {
          spans.push([starts[(read - needle.length + 1) % longest], end]);
          state = tables[n][state - 1];
        }
        states[n] = state;
      }
      read += 1;
    }
    at = end;
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

// `text` with the tokens `prepared` stands for taken out: what the matcher reads, and then — only for a token that has a needle the matcher cannot read (one with white space or a backslash in it) — the one scrubber's literal search.
// The matcher first, so that a token spelled in one piece is one marker: a plain scrub first would take out the parts of a token whose dots are inside a fold, and leave `<token>.<token>` where the matcher finds the whole.
function scrubWith(prepared, text) {
  let out = String(text);
  if (out === '') return out;
  if (prepared.needles.length > 0) out = takeOutSpelled(out, prepared);
  for (const token of prepared.literal) out = scrub(out, token);
  return out;
}

/**
 * `text` with every token in `tokens` taken out of it — whole, and by each of its parts of 24 characters or more (the Dataverse client's own rule: `needlesOf`) — wherever the text spells it, plainly as the client's scrubber
 * finds it or with white space between its characters (a line fold) or a JSON escape in it. A text that holds none is returned as the same string.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {string}
 */
function scrubSpelled(text, tokens) {
  const prepared = prepare(tokens);
  return prepared === null ? String(text) : scrubWith(prepared, text);
}

// ---- An error, and everything it holds ----------------------------------------------------------------------------------------------------------------------------------------------------------

// A plain object — a parsed JSON body — is the only kind whose keys are cleaned: an answer scrubber cleans a key (a service can echo a header as a key), and moving a property is safe on a body, never on an error or a class.
const isPlainObject = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// The walk of one error, with the tokens `prepared` stands for. See scrubFailure.
function cleanFailure(thrown, prepared) {
  const seen = new Set();
  let budget = MAX_WALK_NODES;

  const clean = (value, depth) => {
    if (typeof value === 'string') return scrubWith(prepared, value);
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    // Bytes are bytes: a Buffer is not decoded into a text to be searched, as the client's own scrubbing leaves one that holds no token.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (depth >= MAX_WALK_DEPTH) return TOO_DEEP;
    if (budget <= 0) return TOO_LARGE;
    seen.add(value);
    budget -= 1;
    cleanProperties(value, depth);
    return value;
  };

  const cleanProperties = (holder, depth) => {
    const renamed = [];
    try {
      const plain = !Array.isArray(holder) && isPlainObject(holder);
      for (const key of Reflect.ownKeys(holder)) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(holder, key);
          if (!descriptor) continue;
          if ('value' in descriptor) {
            const cleaned = clean(descriptor.value, depth + 1);
            // defineProperty with the descriptor it had, so the property is as it was made: `cause` is hidden and read-only on the SDK's ConnectionError, and assigning to it would throw.
            if (cleaned !== descriptor.value) Object.defineProperty(holder, key, { ...descriptor, value: cleaned });
          } else if (key === 'stack' && holder instanceof Error) {
            const stack = holder.stack;
            const cleaned = typeof stack === 'string' ? scrubWith(prepared, stack) : stack;
            if (cleaned !== stack) holder.stack = cleaned;
          }
          if (plain && typeof key === 'string') {
            const cleanKey = scrubWith(prepared, key);
            if (cleanKey !== key) renamed.push([key, cleanKey]);
          }
        } catch {
          // A property that cannot be read or written (frozen, a proxy that refuses) is left as it is; the rest of what the error holds is still cleaned.
        }
      }
      for (const [key, to] of renamed) {
        try {
          // Written under the clean name first, so that a property that cannot be moved is not lost as well.
          Object.defineProperty(holder, to, Object.getOwnPropertyDescriptor(holder, key));
          delete holder[key];
        } catch {
          // as above
        }
      }
    } catch {
      // An object that cannot even list its own keys (a proxy that refuses) is left as it is.
    }
  };

  return clean(thrown, 0);
}

/**
 * `thrown` — what an SDK raised, or an Error it returned in a result — with every token in `tokens` taken out of everything it holds, IN PLACE: the same object comes back, still of its class, with its code and its status and what the
 * SDK keeps in a symbol, so that a caller that tells one failure from another still can. A text comes back as the clean text, and anything that is neither (a number, bytes, a function) is returned as it is.
 *
 * What it reads: own properties of every kind — the non-enumerable ones (`message`, `cause`) and the symbol-keyed ones too — by their descriptors, so a getter is never run; an Error's `stack`, which a recent engine makes an
 * accessor (it is read and written as one). A property keeps its attributes: the SDK's `cause` is read-only and hidden, and stays so. One that cannot be written (a frozen error) is left, and the rest is still cleaned.
 * @param {unknown} thrown
 * @param {string[]} tokens
 * @returns {unknown} `thrown`, or the clean text when it was one
 */
function scrubFailure(thrown, tokens) {
  const prepared = prepare(tokens);
  return prepared === null ? thrown : cleanFailure(thrown, prepared);
}

// The Errors that sit in a result — the failure of a push that did not save, of a publish, of a component a solution fetch skipped — each cleaned as an error is. Nothing else in a result is touched or even read for its text: it is the
// caller's data. Only arrays and plain objects are looked into, breadth first, so the errors near the top are found before a long list is read through; a result is plain data, so its values are read as they are.
// A result the walk cannot read is returned as it is: a call that succeeded never fails because of this.
function scrubErrorsIn(result, tokens) {
  if (result === null || typeof result !== 'object' || liveTokens(tokens).length === 0) return result;
  try {
    const seen = new Set();
    const queue = [[result, 0]];
    let steps = 0;
    for (let head = 0; head < queue.length && steps < MAX_RESULT_STEPS; head += 1) {
      const [node, depth] = queue[head];
      if (seen.has(node)) continue;
      seen.add(node);
      if (node instanceof Error) {
        cleanFailure(node, prepare(tokens));
        continue;
      }
      if (depth >= MAX_RESULT_DEPTH) continue;
      const children = Array.isArray(node) ? node : isPlainObject(node) ? Object.keys(node).map((key) => node[key]) : [];
      steps += children.length + 1;
      for (const child of children) if (child !== null && typeof child === 'object') queue.push([child, depth + 1]);
    }
  } catch {
    // as above
  }
  return result;
}

// ---- The SDK, as a script holds it ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * `sdk` seen through a guard: every method hands over what it raises, and every Error in what it returns, with the access tokens this process sent taken out (`scrubFailure`, `scrubErrorsIn`), and is otherwise the method: the same
 * arguments, the same promise's outcome, the same result object. The guard is a Proxy over the SDK, so it is the SDK to everything that holds it — `instanceof`, its members and their identity, a method replaced for a test.
 *
 * A method runs with the SDK itself as its receiver, not the guard: what it reads of its own state (the bundle's class keeps some behind TypeScript's `private`, another SDK's may use `#fields`) is the SDK's, and a call the SDK
 * makes to its own method is not guarded — so what the SDK decides on an error of its own (a re-send on a deadlock, a read of a version after a conflict) is decided on the error as it was, and only an error that LEAVES it is cleaned.
 * @param {object} sdk
 * @param {() => string[]} [tokens] the tokens to take out, asked when an error is handed over and not before: a token may be sent during the call. Default: every token a client of this process has sent.
 */
function guardSdkFailures(sdk, tokens = sentTokens) {
  if (sdk === null || (typeof sdk !== 'object' && typeof sdk !== 'function')) return sdk;
  // A method is the same function each time it is read, as it is without the guard, so a caller that compares two reads, or a Map keyed by one, still works.
  const guarded = new Map();
  const guard = (method) => {
    const twin = function guardedSdkMethod(...args) {
      let out;
      try {
        out = Reflect.apply(method, sdk, args);
      } catch (error) {
        throw scrubFailure(error, tokens());
      }
      if (out !== null && (typeof out === 'object' || typeof out === 'function') && typeof out.then === 'function') {
        return Promise.resolve(out).then((value) => scrubErrorsIn(value, tokens()), (error) => { throw scrubFailure(error, tokens()); });
      }
      return scrubErrorsIn(out, tokens());
    };
    Object.defineProperty(twin, 'name', { value: method.name, configurable: true });
    Object.defineProperty(twin, 'length', { value: method.length, configurable: true });
    return twin;
  };
  return new Proxy(sdk, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function' || typeof key !== 'string' || key === 'constructor' || value === Object.prototype[key]) return value;
      // A Proxy may not answer another value for a member the object holds read-only and fixed (a TypeError), so such a member is returned as it is.
      const own = Object.getOwnPropertyDescriptor(target, key);
      if (own && own.configurable === false && own.writable === false) return value;
      if (!guarded.has(value)) guarded.set(value, guard(value));
      return guarded.get(value);
    },
  });
}

module.exports = { scrubSpelled, scrubFailure, scrubErrorsIn, guardSdkFailures };
