'use strict';
// An EXPLICIT compiler refresh of one generative page: the reviewed source change that makes the SDK compile the page again.
//
// Why a source change, and why only on request. The SDK keeps a page's compiled output for as long as its source and data sources are the same (the vendored
// GenPageAdapter keeps `bag.output` for an unchanged source), so a page compiled before the SDK compiled with its current iterator setting keeps that older output on
// every unchanged update: the update writes nothing, and nothing is compiled. Nothing in the output proves which compiler made it — a helper name, or its absence, is not
// provenance, and a loop that looks "legacy" may be what the source asked for — so no heuristic can pick the pages that need it, and a refresh that ran on its own would
// rewrite pages nobody asked about. The refresh is a change of the page's SOURCE that a person reviews: one comment line appended to the canonical local source,
//   // model-apps compiler refresh: iterator-v1
// which the ordinary upload or build then writes as any other source change — the SDK compiles it with its current settings, and the ordinary runtime evidence records
// the compiled hash. What it never does: clear `bag.output`, write the compiled row, change the data sources for a moment, or add a comment only at deployment that the
// reviewed source does not hold. Preparing it writes nothing anywhere; it reads the page once, to check that the local source is the one deployed.
//
// What it refuses, with nothing changed (`outcome: 'nothing'`):
//   COMPILER_REFRESH_SOURCE_UNREADABLE  the page cannot be read, is not there, or has no source this tool can read (a raw-files page), or the local source is empty
//   COMPILER_REFRESH_BASE_MISMATCH      the local source is not the source the page holds (or not the expected base the caller gave): download and review first
//   COMPILER_REFRESH_PARSE_FAILED       the source does not parse, before or after the comment — a refresh is never the first to find a broken page
//   COMPILER_REFRESH_MARKER_UNPROVEN    the source already carries the marker, and no receipt proves the output compiled from it: that is unknown, not proof that it was
//                                       refreshed, and the answer is a NEW reviewed source revision, not the same marker again
// A page whose source carries the marker AND a receipt that proves its compiled output (readCompilerRefreshReceipt) needs nothing: `action: 'none'`.

const { sha256 } = require('./hash.js');

const MARKER = '// model-apps compiler refresh: iterator-v1';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, outcome: 'nothing', transient: false, ...extra });
}

// The marker counts only as a whole line of its own (surrounding blanks allowed): a string or a longer comment that holds the words is not it.
function hasMarker(source) {
  return String(source).split(/\r?\n/).some((line) => line.trim() === MARKER);
}

// What the caller's records prove about a source that carries the marker. `receipt` is the ordinary runtime evidence of a write the caller saw take effect:
// `{ sourceSha256, compiledSha256 }` — the hash of the source it wrote and of the compiled output the page held when it was published (genpage-sdk `runtimeSha256`).
//   absent    the source does not carry the marker
//   proven    it does, and the receipt is of THIS source and names a compiled output
//   unknown   it does, and there is no receipt, or one of another source, or one without a compiled hash: the marker alone says nothing about what was compiled
function readCompilerRefreshReceipt({ source, receipt } = {}) {
  if (typeof source !== 'string' || !hasMarker(source)) return Object.freeze({ state: 'absent' });
  const sourceSha256 = sha256(source);
  if (!receipt || typeof receipt !== 'object') return Object.freeze({ state: 'unknown', reason: 'no receipt of a write of this source', sourceSha256 });
  if (String(receipt.sourceSha256 || '').toLowerCase() !== sourceSha256) return Object.freeze({ state: 'unknown', reason: 'the receipt is of another source', sourceSha256 });
  if (!/^[0-9a-f]{64}$/i.test(String(receipt.compiledSha256 || ''))) return Object.freeze({ state: 'unknown', reason: 'the receipt names no compiled output', sourceSha256 });
  return Object.freeze({ state: 'proven', sourceSha256, compiledSha256: String(receipt.compiledSha256).toLowerCase() });
}

// The parse errors of a page source, as the TypeScript parser reports them for a .tsx file. Only syntax is checked — not types: a refresh does not judge a page
// it does not change, it only refuses to be the change that breaks (or follows) a source that does not parse. `parseDiagnostics` is the parser's own list on a
// SourceFile (it is what `getSyntacticDiagnostics` answers for a file of its own), read without a Program so no other file is needed.
function parseErrors(ts, text) {
  const file = ts.createSourceFile('page.tsx', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  return (file.parseDiagnostics || []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

// The local source with the marker appended as a line of its own, in the file's own line ending; a source that does not end with one gets one first.
function withMarker(source) {
  const eol = /\r\n/.test(source) ? '\r\n' : '\n';
  return `${source}${source === '' || /\r?\n$/.test(source) ? '' : eol}${MARKER}${eol}`;
}

// prepareCompilerRefresh({ pageId, localSource, expectedBaseSha256?, receipt? }, { genpage, typescript? }) -> frozen
//   { pageId, action: 'refresh', marker, baseSha256, proposedSource, proposedSha256, diff, writes: 0 }   the reviewed change to make
//   { pageId, action: 'none', reason, baseSha256, writes: 0 }                                          the marker is there and a receipt proves its output
// `genpage` is the page backend (lib/genpage-sdk.js); only its `read` is called. `typescript` is the compiler provider the SDK compiles with (default: the vendored one,
// loaded only when needed). `expectedBaseSha256`, when given, is the hash of the source the caller reviewed against: the page must still hold it.
async function prepareCompilerRefresh(input = {}, deps = {}) {
  const pageId = String(input.pageId || '');
  if (!GUID_RE.test(pageId)) throw refusal('COMPILER_REFRESH_SOURCE_UNREADABLE', `'${input.pageId}' is not a page id. Nothing was changed.`);
  const id = pageId.toLowerCase();
  const local = input.localSource;
  if (typeof local !== 'string' || !local.trim()) throw refusal('COMPILER_REFRESH_SOURCE_UNREADABLE', `there is no local source for page ${id} to refresh. Nothing was changed.`, { pageId: id });
  if (!deps.genpage || typeof deps.genpage.read !== 'function') throw new TypeError('prepareCompilerRefresh needs deps.genpage (the page backend) to read the page');

  let page;
  try {
    page = await deps.genpage.read(id);
  } catch (error) {
    throw refusal('COMPILER_REFRESH_SOURCE_UNREADABLE', `page ${id} could not be read as a page with a source (${error && error.message}), so no refresh can be prepared. Nothing was changed.`, { pageId: id, cause: error, sourceCode: error && error.code });
  }
  const deployed = page.source;
  const baseSha256 = sha256(deployed);
  if (input.expectedBaseSha256 !== undefined && String(input.expectedBaseSha256).toLowerCase() !== baseSha256) {
    throw refusal('COMPILER_REFRESH_BASE_MISMATCH', `page ${id} no longer holds the source the refresh was reviewed against (expected ${input.expectedBaseSha256}, found ${baseSha256}). Nothing was changed; download the page and review again.`, { pageId: id, baseSha256 });
  }
  if (deployed !== local) {
    throw refusal('COMPILER_REFRESH_BASE_MISMATCH', `the local source is not the source page ${id} holds (local ${sha256(local)}, deployed ${baseSha256}). Nothing was changed; download the page, or upload the local change first, then prepare the refresh.`, { pageId: id, baseSha256 });
  }

  if (hasMarker(local)) {
    const proof = readCompilerRefreshReceipt({ source: local, receipt: input.receipt });
    if (proof.state === 'proven') {
      return Object.freeze({ pageId: id, action: 'none', reason: 'the source already carries the refresh marker, and a receipt proves the output compiled from it', baseSha256, compiledSha256: proof.compiledSha256, writes: 0 });
    }
    throw refusal('COMPILER_REFRESH_MARKER_UNPROVEN', `page ${id}'s source already carries "${MARKER}", but ${proof.reason}, so whether its output was compiled again is not known. Nothing was changed; make a new reviewed source revision to have the page compiled again.`, { pageId: id, baseSha256 });
  }

  const ts = deps.typescript ? (typeof deps.typescript === 'function' ? deps.typescript() : deps.typescript) : require('./typescript-compiler.js').loadVendoredTypeScript();
  const before = parseErrors(ts, local);
  if (before.length) throw refusal('COMPILER_REFRESH_PARSE_FAILED', `page ${id}'s source does not parse (${before[0]}), so no refresh is prepared for it. Nothing was changed.`, { pageId: id, parseErrors: before });
  const proposedSource = withMarker(local);
  const after = parseErrors(ts, proposedSource);
  if (after.length) throw refusal('COMPILER_REFRESH_PARSE_FAILED', `page ${id}'s source would not parse with the refresh comment appended (${after[0]}) — it may end inside a comment or a string. Nothing was changed.`, { pageId: id, parseErrors: after });

  const lastLine = local.replace(/\r?\n$/, '').split(/\r?\n/).pop();
  const diff = [
    `--- page ${id} (deployed, sha256 ${baseSha256})`,
    `+++ page ${id} (compiler refresh proposal)`,
    '@@ appended at the end of the source @@',
    ` ${lastLine}`,
    `+${MARKER}`,
  ].join('\n');
  return Object.freeze({ pageId: id, action: 'refresh', marker: MARKER, baseSha256, proposedSource, proposedSha256: sha256(proposedSource), diff, writes: 0 });
}

module.exports = { prepareCompilerRefresh, readCompilerRefreshReceipt, COMPILER_REFRESH_MARKER: MARKER };
