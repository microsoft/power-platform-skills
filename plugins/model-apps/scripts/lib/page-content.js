'use strict';
// A page's content as a page write takes it — the source as text, the table list, the bindings — normalized as the write normalizes it, and hashed as ONE value
// (contentFingerprint); and the error every page write raises (genpageError). Moved out of lib/genpage-sdk.js unchanged, so that a caller that prepares a page
// without deploying it (lib/prepare-genpage.js) hashes it exactly as create and update do, and without the file system genpage-sdk.js needs for its workspace:
// this module requires nothing but the hash (lib/hash.js).
const { sha256 } = require('./hash.js');

// An error that must never be answered by trying again. The build re-runs a whole phase when a failure looks transient (isTransientHalt in build-model-app.js, by the rule of lib/retry-policy.js), and an error that says
// `transient: false` — on itself or anywhere along its causes — is never run again, whatever its text quotes (the page's name is the maker's: "SQL Timeouts", "Concurrent Deletes"). So every error a page write raises says
// so. A write that failed for a known reason would only fail again, and one whose outcome is not
// known must not be sent by a re-run that does not know it: a create would mint a second page beside the first one if it landed,
// and an update could record its turn twice. The one write that is NOT final is a throttle that outlasted every wait (throttledError): nothing was written, and the service's load is not the maker's to fix.
function genpageError(message, props = {}) {
  const { cause, ...rest } = props;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { transient: false }, rest);
}

// The page's source as TEXT — the one place bytes become text, and it runs ONCE. The caller that reads a file calls this on the bytes it
// read, and then every check (the Griffel gate, the PAGEREF resolution), every hash and the write itself use that text unchanged:
// text is never normalized again, so what was checked and hashed is what the SDK stores, whatever the file started with.
//   - bytes (a Uint8Array): one leading UTF-8 byte order mark is dropped (the maker stores none; pac's download wrote one, so a file
//     saved from a download has it), and bytes that are not valid UTF-8 are refused — the SDK writes a page's rows in one atomic
//     change set, whose body is UTF-8 text, and a decode that replaced a bad byte would send a page nobody checked. Anything else is
//     kept as it is, line endings included (pac appended a CRLF; the SDK adds nothing).
//   - text (a string): already canonical — returned exactly as given. A second BOM at its start is page content, not an encoding
//     marker, and the BOM-strip that ran on its bytes must not run again on it: a file that starts with two of them would lose both.
// create() and update() take either, through this function, so a caller that hands them the bytes is normalized once there instead.
function sourceText(source) {
  if (typeof source === 'string') {
    // A string with a lone surrogate cannot be encoded as UTF-8 without replacing it.
    if (typeof source.isWellFormed === 'function' && !source.isWellFormed()) {
      throw genpageError('the page source is not valid text (it holds an unpaired surrogate), so it cannot be stored as UTF-8', { code: 'GENPAGE_SOURCE_NOT_UTF8' });
    }
    return source;
  }
  if (source instanceof Uint8Array) {
    try {
      // `fatal` refuses a bad sequence instead of replacing it with U+FFFD; the decoder drops one leading BOM itself (`ignoreBOM` is false).
      return new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch {
      throw genpageError('the page source is not valid UTF-8 — a page is stored as UTF-8 text, and sending it with bytes replaced would deploy something other than what was checked. Save the file as UTF-8 and run it again.', { code: 'GENPAGE_SOURCE_NOT_UTF8' });
    }
  }
  throw genpageError('the page source must be text or the bytes of a file', { code: 'GENPAGE_SOURCE_INVALID' });
}

// A table list as the SDK wants it: an array of logical names. A caller may hand the CSV it was typed as (`account,contact`); names
// are trimmed and lower-cased — a logical name is always lower case, and the SDK looks the table up by it.
function dataSourcesOf(value) {
  if (value === undefined || value === null) return undefined;
  // A blank CSV is "not given", the way a flag the caller did not pass is; an explicit empty ARRAY is the instruction to clear.
  if (typeof value === 'string' && !value.trim()) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

// `config.json` carries a binding as a bare JSON array (what the maker portal and pac both write); anything else would be merged into
// the existing value by an element update rather than replace it, so it is refused.
function bindingOf(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw genpageError(`${label} must be a JSON array`, { code: 'GENPAGE_BINDING_INVALID' });
  return value;
}

// The content a caller asks a page to hold, as ONE hash: the fields planEdits compares — the source, and the name, data sources, model and bindings the caller gave — after the same
// normalization the write uses, so the same content hashes the same whether `create` or `update` was given it. A field left `undefined` is the page's own and is not part of it. The
// caller that keeps this hash with a publish it saw take effect (the build does, in its workspace: lib/page-publish-records.js) hands it back as `publishedFingerprint`, and an update
// that finds the page already holding this content publishes it only if that hash is not the content's. The prefix is the definition's version: a later definition makes every earlier
// hash unequal, and an unequal hash costs one publish, nothing worse.
function contentFingerprint(fields) {
  const content = {};
  for (const key of ['source', 'name', 'dataSources', 'model', 'connectorBindings', 'actionBindings']) if (fields[key] !== undefined) content[key] = fields[key];
  return sha256(`genpage-content/1\n${JSON.stringify(content)}`);
}

// The content fields of a page as `update` takes them from its arguments, normalized as the write normalizes them, so what is compared, hashed and checked afterwards is what is written. A field the caller leaves
// out (`undefined`) is the page's own. `publishedDiffers` takes its arguments through this too, so the `fingerprint` it answers is the one `update` answers for the same arguments.
function contentFieldsOf(args) {
  return {
    source: sourceText(args.source),
    name: args.name === undefined || args.name === null || !String(args.name).trim() ? undefined : String(args.name),
    dataSources: dataSourcesOf(args.dataSources),
    model: args.model ? String(args.model) : undefined,
    connectorBindings: bindingOf(args.connectorBindings, 'connectorBindings'),
    actionBindings: bindingOf(args.actionBindings, 'actionBindings'),
  };
}

module.exports = { genpageError, sourceText, dataSourcesOf, bindingOf, contentFingerprint, contentFieldsOf };
