'use strict';
// Injectable wrapper around `pac model genpage upload/list` — the seam the build's pages phase uses
// to author/deploy generative pages. Page CONTENT only: uploads run WITHOUT --add-to-sitemap because
// the SDK owns the sitemap (it writes the GenPage subareas). Real impl spawns pac; tests inject `run`.
const { invocation, spawnProcess } = require('./process-runner.js');
const { dataverseRequest } = require('./dataverse-auth.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Build the spawn call for a `pac` call. `pac` is resolved to an absolute path on PATH, never from
// the project directory, and started without a shell: `pac.exe` (a dotnet-tool install) directly,
// with every argument passed as-is, and a `pac.cmd` shim through cmd.exe with each argument checked
// or refused (lib/process-runner.js explains the rules). Embedded newlines are collapsed to spaces on
// every arg — a DEFENSIVE net for any arg that still flows inline (e.g. a page --name), since a
// newline would end a batch shim's command line. It is not relied on for prompts: upload() passes
// prompt/agent-message via file precisely because collapsing THEIR newlines was lossy for multi-line
// transcripts.
// @returns {{file: string, args: string[], options: object}}
// @throws when pac is not on PATH, or an argument cannot reach a pac.cmd shim unchanged
const cleanPacArgs = (args) => args.map((a) => String(a).replace(/\r\n|[\r\n]/g, ' '));
function buildPacInvocation(args, deps = {}) {
  return invocation('pac', cleanPacArgs(args), deps);
}
function runPac(args) {
  // Asynchronous, and it NEVER rejects. It was spawnSync, which froze the whole process for the
  // length of every pac call — about five seconds for one `pac model genpage list` — so two
  // independent listings could not overlap even when a caller awaited them together (an update in
  // genpage-upload.js does). Every caller already awaits `run`, and branches on `status` without a
  // catch, so a child that cannot be started resolves as a failed result, as spawnSync's did.
  //
  // Output is collected as raw Buffers and decoded ONCE, when the child closes. Decoding each chunk
  // as it arrives corrupts a multibyte UTF-8 character that a pipe read happens to split, and pac
  // prints page names, which are user text; spawnSync's `encoding: 'utf8'` decoded the whole buffer,
  // so this keeps that behaviour. It also drops spawnSync's 1 MiB maxBuffer, past which the child
  // was killed and its output truncated.
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let settled = false;
    const finish = (status, launchError) => {
      if (settled) return;
      settled = true;
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        status: status == null ? 1 : status,
        stdout: Buffer.concat(out).toString('utf8'),
        // POSIX reports a missing pac as a spawn 'error' (ENOENT) with nothing on stderr; carry its
        // message so the diagnostic says why instead of "pac exited 1 with no output".
        stderr: stderr || (launchError ? String(launchError.message || launchError) : ''),
      });
    };
    let child;
    try {
      // Resolution and argument checks throw here too, and resolve as a failed result like a launch error.
      child = spawnProcess('pac', cleanPacArgs(args), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish(1, e);
      return;
    }
    // EMFILE/ENFILE leave the stdio pipes unset, hence the guards.
    if (child.stdout) child.stdout.on('data', (c) => out.push(c));
    if (child.stderr) child.stderr.on('data', (c) => err.push(c));
    // 'error' (the child could not be started) may or may not be followed by 'close'; `finish`
    // keeps whichever comes first. 'close' rather than 'exit': 'exit' fires as soon as pac itself
    // ends, while a process it started can still hold the pipes and write. 'close' waits for every
    // holder to let go, which is also when spawnSync returned (measured: a grandchild writing 1 s
    // after its parent exited was captured by spawnSync and 'close', and missed by 'exit').
    child.on('error', (e) => finish(1, e));
    child.on('close', (code) => finish(code));
  });
}

// Extract the "Page ID: <guid>" pac prints on a successful upload.
// A page id is DURABLE IDENTITY — it is stored in the manifest and drives every later update — so
// only a complete, canonical GUID is accepted.
//
// The old pattern was `[0-9a-fA-F-]{36}`, which is 36 characters from an alphabet that includes
// `-`. It therefore accepted a row of dashes, any mis-grouped hex, and — worst — an OVERLONG token,
// because it matched the first 36 characters and silently discarded the rest, turning a malformed
// id into a plausible one. MEASURED on the merged code: all three of
//   'Page ID: ------------------------------------'
//   'Page ID: 111111112222333344445555555555555555'
//   'Page ID: 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35f'  (37 chars -> truncated to 36)
// were accepted as identity.
//
// The group structure (8-4-4-4-12) is enforced, and the trailing boundary rejects any contiguous
// IDENTIFIER character so a too-long token is REFUSED rather than trimmed. Restricting the boundary
// to the GUID alphabet was not enough: `6e0c28a2-cdbf-41ec-9186-d10fd5de6e35oops` has a non-hex
// character next, so the lookahead passed and the id was accepted with the suffix silently dropped.
// The boundary must be Unicode-aware: a suffix such as `東京` is still a continuing identifier
// token even though JavaScript `\w` is ASCII-only. A following `.` or `,` or `)` genuinely ends the
// token (pac prints the id inside prose), while any Unicode letter/number/mark, underscore or hyphen
// means the token continues. Returning null is the safe outcome: the caller treats a zero exit with
// no parsable id as an UNCERTAIN create and reconciles by env-wide id diff.
const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
// A value that IS a GUID and nothing else — what may go into a Dataverse key segment, `uxagentprojects(<id>)`.
const GUID_ONLY_RE = new RegExp(`^${GUID_RE.source}$`);
// pac stores every ASCII `"` in a page name as `\"` — in the page's row and in a navigation title it writes (live-measured:
// `Say "hi" now` became `Say \"hi\" now` in both) — and changes nothing else. This is the inverse: the name pac was given.
// Sent back as the name, it makes pac store the same value again; a name read back and re-sent as it is would gain a
// backslash on every upload.
function unescapePacName(name) {
  return String(name).replace(/\\"/g, '"');
}
// The end of a GUID token, for a RegExp built with the 'u' flag. Shared by both parsers below.
const GUID_END = '(?![\\p{L}\\p{N}\\p{M}_-])';
function parsePageId(out) {
  const m = new RegExp('Page ID:\\s*(' + GUID_RE.source + ')' + GUID_END, 'u').exec(String(out || ''));
  return m ? m[1] : null;
}

// Parse `pac model genpage list` output. The real layout is a FIXED-WIDTH TABLE: a header row
// "Page ID<pad>Name<pad>Published" followed by one row per page, each starting with the 36-char GUID:
//   Connected as user@contoso.com
//   Retrieving generated pages...
//   Found 1 generated page(s):
//
//   Page ID                              Name     Published
//   13ecbc57-a3a4-4132-b0a2-a6c6b12691e8 Overview -
//
// Column boundaries are derived from the header's "Name"/"Published" offsets so a Name containing spaces
// (e.g. "Order Detail") is not split on whitespace. A data row is matched by a leading 36-char GUID that
// ENDS there, by the same Unicode-aware rule as parsePageId: `<guid>東京` or `<guid>_x` is a longer token,
// not a page id plus a name, so the row is skipped and the count check below fails the listing closed.
// An ASCII `\b` accepted those, because JavaScript counts `東` as a non-word character.
// Returns [{ pageId, name }]. NOTE (live-confirmed): pac lists only pages reachable from the app SITEMAP —
// a headless nav-target page (declared in pages[] but not an appShell subarea) is NOT returned here.
// With --app-id, `name` is the page's SITEMAP TITLE, not the page record's own name (measured: after an
// update renamed the page with --name, the app-scoped listing still showed the subarea title), so a
// listed name is never evidence of what the page itself is called.
function parseList(out) {
  const rowRe = new RegExp('^\\s*(' + GUID_RE.source + ')' + GUID_END, 'u');
  const lines = String(out || '').split('\n');
  // Locate the header row to find the Name (and Published) column offsets. pac auto-sizes columns to the
  // longest value, so the offsets must be read from THIS output, not hard-coded.
  let nameCol = -1;
  let pubCol = -1;
  for (const raw of lines) {
    if (raw.indexOf('Page ID') >= 0 && /\bName\b/.test(raw)) {
      nameCol = raw.indexOf('Name');
      pubCol = raw.indexOf('Published'); // -1 when absent
      break;
    }
  }
  const pages = [];
  for (const raw of lines) {
    const m = rowRe.exec(raw);
    if (!m) continue;
    const pageId = m[1];
    let name;
    if (nameCol >= 0) {
      // Fixed-width slice from the Name column to the Published column (or end of line).
      const end = pubCol > nameCol ? pubCol : raw.length;
      name = raw.slice(nameCol, end).trim() || undefined;
    } else {
      // No header parsed (unexpected) — fall back to the token(s) after the GUID, dropping a trailing
      // single-token published flag. Single-word names only in this degraded path.
      const rest = raw.slice(m.index + m[0].length).trim().split(/\s{2,}/);
      name = (rest[0] || '').trim() || undefined;
    }
    pages.push({ pageId, name });
  }
  return pages;
}

// Extract the summary count pac prints on `pac model genpage list`, e.g.
//   "Found 3 generated page(s):"  → 3
//   "Found 0 generated page(s):"  → 0
// Returns the integer, or null when the summary line is absent (unknown format). parseList skips
// the "Found …" line as metadata; this reads its N so classifyListOutput can prove the listing is
// COMPLETE (parsed page count == summary N).
//
// Matched as a STANDALONE, COMPLETE line, not anywhere in the output. Scanning the whole text let a
// page NAME supply the summary: pac prints names in a fixed-width table, so a page called
//   "Found 1 generated page"
// made a listing with NO real summary line read as authoritative — and an authoritative-looking
// but TRUNCATED listing is exactly what drives a duplicate CREATE.
//
// Anchoring the START was still not enough: with the line-end unconstrained, a row whose name began
// with the summary text — "Found 1 generated pagex", "Found 1 generated page(s) extra" — was accepted
// just the same. The WHOLE line must be the summary grammar, so trailing content disqualifies it.
// Every live-captured listing uses the exact form "Found N generated page(s):"; the small
// tolerances here (optional "generated", "page"/"pages"/"page(s)", optional colon) cover plausible
// pac wording drift without admitting arbitrary suffixes. Anything outside that returns null, which
// classifyListOutput reports as 'unrecognized' — a failure, never "empty".
function parseListCount(stdout) {
  const m = /^[^\S\r\n]*found[^\S\r\n]+(\d+)[^\S\r\n]+(?:generated[^\S\r\n]+)?pages?(?:\(s\))?[^\S\r\n]*:?[^\S\r\n]*$/im
    .exec(String(stdout || ''));
  return m ? Number(m[1]) : null;
}

// Classify a ZERO-EXIT `pac model genpage list` stdout (design §9, I2). A zero exit alone is NOT proof
// of a valid listing: a changed format, a blank result, a help banner (pac dumps usage on a flag error
// yet exits 0 on some builds), a TRUNCATED listing (fewer Page IDs than the summary count), or an UNNAMED
// page would all mis-read as pages/empty and drive duplicate creation or a blind reconcile. Fail-closed:
//
//   'pages'        — >=1 "Page ID" parsed, EVERY page has a name, AND the parsed count == the summary
//                    "Found N page(s)" count (a COMPLETE, authoritative listing).
//   'empty'        — an EXPLICIT no-pages / "Found 0" marker (only then is [] trustworthy).
//   'unrecognized' — anything else → the caller treats it as FAILURE, never as "empty".
//
// Confirm the exact "Found N generated page(s)" + no-pages phrasing against a live pac run before
// relying on a new format; any unmatched zero-exit output is (correctly) fail-closed 'unrecognized'.
function classifyListOutput(stdout) {
  const s = String(stdout || '');
  const count = parseListCount(s);
  const pages = parseList(s);
  // EMPTY requires NO positive page evidence. Match the "no pages" phrase ONLY when zero page rows parsed
  // AND there is no positive summary count. The phrase is tested against the WHOLE stdout, which includes
  // page NAMES and DESCRIPTIONS — so a page literally named "No Pages" or described "…when there are no
  // pages to display" must NOT force an app WITH live pages to read as empty. That was a fail-OPEN: a false
  // 'empty' makes reconcile see zero live pages → a duplicate CREATE on build and a silent page-drop on
  // download. An explicit "Found 0" is trustworthy only when no row was actually parsed (else it is a
  // contradictory/truncated listing → fail-closed 'unrecognized').
  if (count === 0) return pages.length === 0 ? { kind: 'empty', pages: [] } : { kind: 'unrecognized', pages: [] };
  // Older pac builds have printed a no-pages marker as its own line. Treat only that complete,
  // trimmed line as authoritative:
  //   No generated pages found.
  //   No pages found
  // A warning such as "no pages could be retrieved" means the service failed to enumerate, not
  // that the app is empty, so it must fail closed.
  if (count === null && pages.length === 0 && /^[^\S\r\n]*no[^\S\r\n]+(?:generated[^\S\r\n]+)?pages[^\S\r\n]+found\.?[^\S\r\n]*$/im.test(s)) {
    return { kind: 'empty', pages: [] };
  }
  const seenIds = new Set();
  const hasDuplicateIds = pages.some((p) => {
    const key = String(p.pageId || '').toLowerCase();
    if (seenIds.has(key)) return true;
    seenIds.add(key);
    return false;
  });
  if (hasDuplicateIds) return { kind: 'unrecognized', pages: [] };
  // A complete, authoritative listing: at least one DISTINCT page, every page has a name, count matches
  const allNamed = pages.length > 0 && pages.every((p) => p.name && String(p.name).trim());
  if (allNamed && count !== null && count === pages.length) return { kind: 'pages', pages };
  return { kind: 'unrecognized', pages: [] };
}

function makeGenpageCli(env, deps = {}) {
  const run = deps.run || runPac;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = deps.attempts || 3; // pac genpage upload/list flake intermittently (transient help-dump exits)
  // The DIAGNOSTIC pac actually produced, not merely its last line.
  //
  // MEASURED shape of a real failure (`pac model genpage download` with no --app-id):
  //   Microsoft PowerPlatform CLI
  //   Version: 0.1.0-dev (.NET 10.0.12)
  //   Online documentation: https://aka.ms/PowerPlatformCLI
  //   Feedback, Suggestions, Issues: https://github.com/...
  //
  //   Error: A required argument --app-id is missing.
  //
  //   Usage: pac model genpage download [--environment] --app-id [--page-id] [--output-directory]
  //     --environment    Specifies the target Dataverse. ...
  //     --output-directory  Directory to save pulled pages. ... (alias: -o)
  //
  // pac prints a banner, then the error, then a full help dump — so the LAST non-empty line is a
  // flag description and the real cause is in the middle. Reporting that line told the caller
  // nothing and actively hid the answer.
  //
  // Preference order: explicit `Error:` lines, else any line that is not banner/usage/flag-help,
  // else any non-banner line even if flag-SHAPED, else the last few lines so an unrecognized format
  // still says SOMETHING.
  //
  // That third step matters: `FLAG_HELP_RE` exists to drop the help dump, but pac can print the ONLY
  // diagnostic in the same indented shape — e.g. `  --output-directory does not exist: C:\missing`.
  // Dropping it left just the four banner lines, which say nothing at all. Falling back to the LAST
  // lines rather than the first, for the same reason: the banner is always first.
  const BANNER_RE = /^(?:Microsoft PowerPlatform CLI|Version:|Online documentation:|Feedback, Suggestions, Issues:|Usage:|Connected as)/i;
  const FLAG_HELP_RE = /^\s+-{1,2}\S/; // an indented "  --flag   description" row from the help dump
  const pacDiagnostic = (r) => {
    const raw = `${String(r && r.stderr || '')}\n${String(r && r.stdout || '')}`;
    const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (!lines.length) return `pac exited ${r && r.status}` + ' with no output';
    const errors = lines.filter((l) => /^\s*Error:/i.test(l));
    const notBanner = lines.filter((l) => !BANNER_RE.test(l.trim()));
    const picked = errors.length ? errors.slice(0, 4)
      : (notBanner.filter((l) => !FLAG_HELP_RE.test(l)).slice(0, 4).length
        ? notBanner.filter((l) => !FLAG_HELP_RE.test(l)).slice(0, 4)
        : (notBanner.length ? notBanner.slice(0, 4) : lines.slice(-4)));
    return picked.map((l) => l.trim()).join(' | ');
  };

  // A failure pac will produce again for the SAME inputs, however many times it is asked. Retrying
  // one cannot help: it burns the caller's time and buries the real message under "after 3
  // attempt(s)".
  //
  // Every pattern carries ARGUMENT or FILE context, deliberately. Bare phrases like "does not exist"
  // and "could not be found" were too loose — a transient service message such as
  //   "The resource does not exist yet; please retry."
  // matched them and cost a retry that would have succeeded. A lost retry fails a build; a needless
  // retry costs about a second, so the asymmetry decides the trade: match only what is unambiguous.
  //
  // The rich forms are MEASURED from a real pac build, e.g. a missing --code-file:
  //   Error: The value passed to '--code-file' is invalid. The file 'D:\nope\absent.tsx' could not be found.
  const DETERMINISTIC_RE = new RegExp([
    'required argument', 'unknown argument', 'unrecognized (?:command|option)',
    'not a valid command', 'parse failed on', 'was it quote wrapped',
    'no such file', 'file not found',
    "the value passed to '[^']*' is invalid",
    "the file '[^']*' could not be found",
  ].join('|'), 'i');
  const isDeterministic = (text) => DETERMINISTIC_RE.test(String(text || ''));


  // List the pages already in the app (parsed from its sitemap by pac). Returns [{ pageId, name }].
  async function listPages(appId) {
    const r = await run(['model', 'genpage', 'list', '--environment', env, '--app-id', appId]);
    return r.status === 0 ? parseList(r.stdout) : [];
  }

  // Fail-closed page enumeration (design §9, I2). Retries up to `attempts` times (pac genpage list
  // flakes with transient help-dump exits on some PAC CLI builds). Returns:
  //   { ok: true, pages, empty: true }  — app genuinely has no pages ("Found 0" or no-pages phrase)
  //   { ok: true, pages: [...] }        — COMPLETE listing: count matches, all pages named
  //   { ok: false, pages: [], error }   — persistent non-zero exit OR a persistent zero-exit
  //                                       UNRECOGNIZED/INCOMPLETE output (count mismatch, blank,
  //                                       help banner, unnamed page) — never masquerade as empty.
  // Callers that drive a create decision MUST check ok before trusting pages:[] as "truly empty".
  async function enumeratePages(appId, options = {}) {
    let lastErr = '';
    for (let i = 0; i < attempts; i += 1) {
      const args = ['model', 'genpage', 'list', '--environment', env, '--app-id', appId];
      if (options && options.includeUnpublished === true) args.push('--include-unpublished');
      const r = await run(args);
      if (r.status === 0) {
        const c = classifyListOutput(r.stdout);
        if (c.kind !== 'unrecognized') return { ok: true, pages: c.pages, empty: c.kind === 'empty' };
        // Zero-exit but unrecognized/incomplete listing — treat as a retryable failure so transient
        // help-dump exits don't look like empty apps. Fail-closed: never return ok:true for this.
        lastErr = 'unrecognized/incomplete `pac genpage list` output (zero exit, no valid page listing or a count mismatch) — refusing to treat as empty';
      } else {
        lastErr = pacDiagnostic(r);
      }
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return { ok: false, pages: [], error: `pac genpage list failed after ${attempts} attempt(s): ${lastErr}` };
  }

  // Env-WIDE EXISTENCE enumeration (NO --app-id): returns the set of ALL generative-page ids that exist
  // in the environment, regardless of which app they belong to or whether they are in any sitemap.
  // `--include-unpublished` ensures a just-created draft counts before it has been finalized into a
  // sitemap, so uncertain results can report their candidates and receipted build creates remain
  // discoverable before placement. Enumeration itself grants no ownership or update authority.
  // Reuses classifyListOutput (fail-closed): an unrecognized/incomplete listing NEVER
  // masquerades as an empty environment. `ids` are lower-cased for case-insensitive set membership.
  async function enumerateEnv() {
    let lastErr = '';
    for (let i = 0; i < attempts; i += 1) {
      const r = await run(['model', 'genpage', 'list', '--environment', env, '--include-unpublished']);
      if (r.status === 0) {
        const c = classifyListOutput(r.stdout);
        if (c.kind !== 'unrecognized') {
          const pages = c.pages || [];
          return { ok: true, ids: pages.map((p) => String(p.pageId).toLowerCase()), pages };
        }
        lastErr = 'unrecognized/incomplete env-wide `pac genpage list` output (zero exit, no valid listing or a count mismatch) — refusing to treat as empty';
      } else {
        lastErr = pacDiagnostic(r);
      }
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return { ok: false, ids: [], error: `pac genpage list (env-wide) failed after ${attempts} attempt(s): ${lastErr}` };
  }

  async function readPageRow(pageId, select) {
    if (!GUID_ONLY_RE.test(String(pageId || ''))) throw new Error(`'${pageId}' is not a page id`);
    const request = deps.request || dataverseRequest;
    const res = await request(env, 'GET', `uxagentprojects(${pageId})?$select=${select}`);
    if (!res || !Number.isInteger(res.status) || res.status < 200 || res.status >= 300) {
      throw new Error(`reading page ${pageId}'s ${select === 'name' ? 'name' : 'creation details'} returned HTTP ${res && res.status}`);
    }
    return res.data;
  }

  return {
    // Create (no pageId) or update (with pageId) a page's content. Returns { pageId }. Retries transient
    // pac failures. On an UNCERTAIN CREATE (non-zero, or zero-exit with no Page ID) resolves via a
    // STRICT ENV-WIDE before/after id diff: the env-wide id set
    // is snapshotted BEFORE the first CREATE so the diff reveals exactly which id appeared.
    //   newIds.length >= 1 → report stored details and stop; only the user can confirm ownership
    //   newIds.length === 0 → CREATE did NOT land → safe to retry
    // Names and dates describe candidates, never establish identity. Read failures also stop,
    // with the candidate id retained in the diagnostic. No uncertain result changes the command to UPDATE.
    async upload({ appId, pageId, codeFile, compiledCodeFile, name, prompt, agentMessage, dataSources,
      addToSitemap, model, connectors, actions }) {
      // pac REQUIRES both a prompt and an agent-message for a new page. Resolve the effective text
      // (preserving the historical defaults) ONCE, then hand both to pac BY FILE via --prompt-file /
      // --agent-message-file rather than inline --prompt / --agent-message. A downloaded page prompt is
      // a multi-line conversation transcript ("Conversation with N prompts:\r\n1. …\r\n2. …"); passed
      // inline it hits the newline-collapsing in buildPacInvocation (a defensive guard so a stray
      // newline can't truncate a Windows batch shim's command line) and silently loses every line break on
      // an edit-rebuild. A file round-trips the text verbatim. See `pac model genpage upload --help`.
      const promptText = prompt && String(prompt).trim() ? String(prompt) : `Generative page ${name || ''}`.trim();
      // The default applies only when NO agent message was supplied. An explicitly EMPTY one (a
      // zero-byte --agent-message-file) used to be replaced by this fallback, so the deployed page
      // carried provenance the caller never wrote — the same fabrication the empty-prompt check
      // already refuses. `undefined` means "not supplied"; a supplied empty string is the caller's
      // problem to fix, and is rejected by genpage-upload.js before reaching here.
      const agentMessageText = agentMessage === undefined || agentMessage === null
        ? 'Authored by app-builder'
        : String(agentMessage);
      // Write both files ONCE, before the retry loop, into a unique temp dir. mkdtempSync's random
      // suffix keeps concurrent uploads from colliding on a fixed filename. UTF-8 because prompts carry
      // non-ASCII (pac reads these back as UTF-8). The try/finally guarantees the dir is removed on
      // EVERY exit below — the success return, the retry-exhaustion throw, and the mid-loop throws.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-upload-'));
      const promptFile = path.join(tmpDir, 'prompt.txt');
      const agentMessageFile = path.join(tmpDir, 'agent-message.txt');
      try {
        fs.writeFileSync(promptFile, promptText, 'utf8');
        fs.writeFileSync(agentMessageFile, agentMessageText, 'utf8');
        const once = async (pid) => {
          const args = ['model', 'genpage', 'upload', '--environment', env, '--app-id', appId, '--code-file', codeFile];
          if (pid) args.push('--page-id', pid);
          // Optional pre-compiled JavaScript. When omitted, pac auto-transpiles the TypeScript (the
          // live-verified path the plugin uses today) — so only add the flag when the caller supplies one.
          if (compiledCodeFile) args.push('--compiled-code-file', compiledCodeFile);
          if (name) args.push('--name', name);
          // pac requires BOTH for a new page; delivered by file (see above) so a multi-line
          // prompt/agent-message round-trips intact instead of being newline-collapsed.
          args.push('--prompt-file', promptFile);
          args.push('--agent-message-file', agentMessageFile);
          // Accept an ARRAY (how the build passes it) or a CSV STRING (how a CLI caller does).
          // `dataSources.join` on a string would throw, and a bare `.length` check passes for both,
          // so the shape has to be normalized rather than assumed.
          const ds = Array.isArray(dataSources) ? dataSources.join(',') : String(dataSources || '');
          if (ds) args.push('--data-sources', ds);
          // OPT-IN extras, for the standalone /genpage skill (#589). They default to absent because
          // /app-builder must NOT send them: `--add-to-sitemap` in particular is deliberately omitted
          // there, since the SDK owns the sitemap and writes the GenPage subareas itself — letting pac
          // add one too would produce a duplicate subarea. Unlike the prompt these are short,
          // caller-controlled values (a model id, file paths, a bare switch), so they are safe inline.
          if (model) args.push('--model', model);
          if (connectors) args.push('--connectors', connectors);
          if (actions) args.push('--actions', actions);
          // Only ever on a CREATE. pac rejects the combination, and the skills' own rule is
          // "use --page-id, omit --add-to-sitemap" — enforcing it here keeps every caller honest
          // instead of repeating the rule in prose at each call site.
          if (addToSitemap && !pid) args.push('--add-to-sitemap');
          return run(args);
        };
        const pid = pageId;
        let lastErr = '';
        // Snapshot taken once (lazily on the first CREATE attempt) so the before/after diff is anchored
        // to the exact env state before this operation. Fail-closed: if we can't snapshot, we can't
        // safely attribute a later uncertain result — halt to prevent a blind duplicate.
        let beforeIds = null;
        for (let i = 0; i < attempts; i += 1) {
          if (!pid && beforeIds === null) {
            const before = await enumerateEnv();
            if (!before.ok) {
              throw new Error(
                `pac genpage upload for '${name || '(unnamed)'}': cannot snapshot the environment before create (${before.error}) — refusing to create (would risk a duplicate)`
              );
            }
            beforeIds = new Set(before.ids);
          }
          const r = await once(pid);
          if (r.status === 0) {
            const id = parsePageId(r.stdout);
            if (id) {
              // When performing an explicitly requested UPDATE, the returned Page ID MUST equal
              // the pid we used. A mismatch
              // means pac silently operated on a different page — halt rather than let a wrong record persist.
              // Case-insensitive: PAC can normalize GUID casing across writes.
              if (pid && id.toLowerCase() !== pid.toLowerCase()) {
                throw new Error(
                  `pac genpage upload for '${name || '(unnamed)'}': UPDATE returned an unexpected Page ID (got ${id}, expected ${pid}) — refusing to persist a mismatched update`
                );
              }
              return { pageId: id };
            }
            lastErr = `returned no Page ID: ${pacDiagnostic(r)}`;
          } else {
            lastErr = pacDiagnostic(r);
          }
          // Uncertain CREATE: no caller pid and result was non-zero or zero-without-Page-ID.
          // The env-wide diff discovers candidates, not ownership. A concurrent create can have
          // the same name and date, so even a single candidate cannot authorize an automatic UPDATE.
          if (!pid) {
            const after = await enumerateEnv();
            if (!after.ok) {
              throw new Error(
                `pac genpage upload for '${name || '(unnamed)'}' had an uncertain result and env enumeration failed — refusing to retry (would risk a duplicate): ${after.error}`
              );
            }
            const newIds = after.ids.filter((id) => !beforeIds.has(id));
            if (newIds.length > 0) {
              const details = [];
              let readFailure;
              for (const candidate of newIds) {
                try {
                  // uxagentprojects(<id>)?$select=name,createdon, e.g.
                  // { "name": "Contoso Overview", "createdon": "2026-01-01T00:00:00Z" }.
                  // These fields are diagnostic data only, not permission to update the row.
                  const row = await readPageRow(candidate, 'name,createdon');
                  const storedName = row && typeof row.name === 'string' ? JSON.stringify(unescapePacName(row.name)) : '[unreadable]';
                  const createdon = row && typeof row.createdon === 'string' ? JSON.stringify(row.createdon) : '[unreadable]';
                  details.push(`${candidate}: stored name ${storedName}, createdon ${createdon}`);
                } catch (e) {
                  readFailure = readFailure || e;
                  details.push(`${candidate}: stored name [unreadable], createdon [unreadable]; read failed (${(e && e.message) || e})`);
                }
              }
              throw new Error(`pac genpage upload for '${name || '(unnamed)'}' had an uncertain create (ambiguous ownership). Candidates: ${details.join('; ')}. Refusing to adopt or update any candidate. If it is yours, re-run the upload as an update with ${newIds.map((id) => `--page-id ${id}`).join(' or ')}; otherwise leave it and re-run the create.`, readFailure ? { cause: readFailure } : undefined);
            } else {
              // CREATE did NOT land → safe to retry (pid stays undefined; beforeIds unchanged)
            }
          }
          // A DETERMINISTIC failure will repeat for the same inputs, so retrying it only burns the
          // caller's time and buries the real message under "after 3 attempt(s)". Break out and
          // report it immediately.
          //
          // The next attempt always uses the same explicit id (or remains CREATE); recovery
          // never changes command identity, so deterministic failures must stop in both modes.
          if (isDeterministic(lastErr)) break;
          if (i < attempts - 1) await sleep(500 * (i + 1));
        }
        throw new Error(`pac genpage upload failed for '${name || '(unnamed)'}': ${lastErr}`);
      } finally {
        // Best-effort cleanup on EVERY exit path (success return, retry-exhaustion throw, mid-loop
        // throws). A cleanup failure (e.g. a transient Windows file lock) must NEVER mask the upload's
        // own error, so swallow it. force:true also ignores an already-removed dir.
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      }
    },
    list({ appId }) {
      return listPages(appId);
    },
    // Env-wide, INCLUDING unpublished pages — the only listing that can answer "does this page id
    // exist at all", since an app-scoped list is derived from the sitemap and so misses a page that
    // was created but never placed. Exposed so the standalone CLI can verify an update target
    // without reimplementing pac listing, retry and output classification.
    enumerateEnvironment() {
      return enumerateEnv();
    },
    enumerate({ appId }) {
      return enumeratePages(appId);
    },
    enumeratePages(appId, options) {
      return enumeratePages(appId, options);
    },
    enumerateEnv() {
      return enumerateEnv();
    },
    // Download page CONTENT into `outputDir/<pageId>/{page.tsx,page.js,config.json,prompt.txt}`. With
    // `pageIds` (non-empty) pull exactly those pages via `--page-id <comma>` — the sitemap's id set,
    // so download is headless-free and fetches only real app content. Omit `pageIds` to download all
    // app pages (back-compat for any legacy caller that does not provide the sitemap id set).
    async download({ appId, outputDir, pageIds }) {
      const args = ['model', 'genpage', 'download', '--environment', env, '--app-id', appId, '--output-directory', outputDir];
      if (pageIds && pageIds.length) args.push('--page-id', pageIds.join(','));
      const r = await run(args);
      if (r.status !== 0) throw new Error(`pac genpage download failed: ${pacDiagnostic(r)}`);
      return true;
    },
    // The page's current display name, from its Dataverse row (`uxagentproject.name`). An update without
    // `--name` renames the page to its navigation title, so a caller that wants to keep the name must read
    // it and send it. pac's app-scoped listing shows the navigation title instead, and its env-wide listing
    // prints the name trimmed, in a fixed-width table — so the row itself is read, through Dataverse (the
    // az token). The row cannot be written there: a PATCH of `name` answers 204 and changes nothing
    // (live-measured), so pac's `--name` is the only way to set it.
    async pageName(pageId) {
      const row = await readPageRow(pageId, 'name');
      return row && typeof row.name === 'string' ? row.name : null;
    },
    // Why pac, as installed here, cannot be handed `value` as an argument — null when it can. A `pac.cmd` shim
    // (Windows) cannot receive a double quote or `%` unchanged, and the runner refuses such a value rather than
    // let cmd.exe rewrite it. Checked without starting anything, so a caller can decide BEFORE an upload
    // whether a value it chose on the user's behalf — a page's current name — can be sent at all.
    argumentRefusal(value) {
      try {
        buildPacInvocation(['--name', value], deps.pacInvocation);
        return null;
      } catch (e) {
        return e && e.code === 'EARGUMENT' ? e.message : null;
      }
    },
  };
}

// A provenance value the caller SUPPLIED but left blank. `undefined`/`null` mean "not supplied", and
// the wrapper's defaults then apply legitimately. A present-but-blank value is different: the caller
// asked for THAT text, so substituting generated provenance deploys words nobody wrote. Whitespace-,
// newline- and BOM-only files are the realistic ways an empty value arrives.
function suppliedButBlank(value) {
  return value !== undefined && value !== null && !String(value).trim();
}
module.exports = { makeGenpageCli, suppliedButBlank, unescapePacName, parsePageId, parseList, parseListCount, classifyListOutput, buildPacInvocation, runPac };
