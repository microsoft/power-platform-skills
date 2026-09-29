'use strict';
// Injectable wrapper around `pac model genpage upload/list` — the seam the build's pages phase uses
// to author/deploy generative pages. Page CONTENT only: uploads run WITHOUT --add-to-sitemap because
// the SDK owns the sitemap (it writes the GenPage subareas). Real impl spawns pac; tests inject `run`.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Quote an arg for a Windows/POSIX shell command line (needed because pac resolves as pac.cmd on
// Windows, which requires shell:true — and shell:true does not quote an args array). Embedded
// newlines terminate the Windows command line (pac then sees a truncated command and dumps its
// help), so collapse them to spaces first. This is now purely a DEFENSIVE net for whatever args
// still flow inline — e.g. a page --name; it is NOT how multi-line prompts survive. upload() passes
// the prompt and agent-message to pac BY FILE (--prompt-file/--agent-message-file) precisely because
// collapsing THEIR newlines was lossy (a downloaded prompt is a multi-line conversation transcript).
function quoteArg(a) {
  const s = String(a).replace(/\r\n|[\r\n]/g, ' ');
  const q = s.replace(/"/g, '""').replace(/%/g, '"^%"');
  // cmd.exe expands %VAR% even inside double quotes; break out of the quoted segment and caret-escape
  // each percent so prompts/names containing environment-variable syntax round-trip literally.
  if (!/[\s"'&|<>^()%]/.test(s)) return s;
  // A run of backslashes immediately before the closing quote must be DOUBLED. Windows command-line
  // parsing treats `\"` as an escaped quote, so a directory argument ending in a separator —
  //   --output-directory "C:\Users\Power User\download\"
  // — escaped its own closing quote and swallowed the following flags into the path. MEASURED via a
  // real cmd.exe parse:
  //   ["--output-directory", "C:\\Users\\Power User\\download\" --app-id after"]
  // Only the trailing run matters: an interior `\` is literal to the parser, so escaping those would
  // corrupt every ordinary Windows path.
  // See: https://learn.microsoft.com/cpp/cpp/main-function-command-line-args#parsing-c-command-line-arguments
  const trailingSlashesDoubled = q.replace(/(\\+)$/, (m) => m + m);
  return `"${trailingSlashesDoubled}"`;
}

// Build the spawnSync invocation for a `pac` call, per platform. Windows: pac resolves as pac.cmd,
// which requires a shell; shell:true ignores an args array, so pass a single cmd-quoted command
// line ("" escapes an embedded quote). POSIX: spawn pac directly with the args array (no shell) so
// embedded quotes and other shell metacharacters round-trip verbatim instead of being mangled by
// cmd-style quoting. Embedded newlines are still collapsed to spaces on every arg — a DEFENSIVE net
// for any arg that still flows inline (e.g. a page --name), since a newline truncates the Windows
// command line. It is no longer relied on for prompts: upload() passes prompt/agent-message via file
// precisely because collapsing THEIR newlines was lossy for multi-line transcripts.
function buildPacInvocation(args, platform = process.platform) {
  const clean = args.map((a) => String(a).replace(/\r\n|[\r\n]/g, ' '));
  if (platform === 'win32') {
    return { command: 'pac ' + clean.map(quoteArg).join(' '), args: undefined, options: { encoding: 'utf8', shell: true } };
  }
  return { command: 'pac', args: clean, options: { encoding: 'utf8' } };
}

function runPac(args) {
  const inv = buildPacInvocation(args);
  const r = inv.args ? spawnSync(inv.command, inv.args, inv.options) : spawnSync(inv.command, inv.options);
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
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
// `[\w-]` is the right class — a following `.` or `,` or `)` genuinely ends the token (pac prints the
// id inside prose), while any letter, digit, underscore or hyphen means the token continues.
// Returning null is the safe outcome: the caller treats a zero exit with no parsable id as an
// UNCERTAIN create and reconciles by env-wide id diff.
const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
function parsePageId(out) {
  const m = new RegExp('Page ID:\\s*(' + GUID_RE.source + ')(?![\\w-])').exec(String(out || ''));
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
// (e.g. "Order Detail") is not split on whitespace. A data row is matched by a leading 36-char GUID.
// Returns [{ pageId, name }]. NOTE (live-confirmed): pac lists only pages reachable from the app SITEMAP —
// a headless nav-target page (declared in pages[] but not an appShell subarea) is NOT returned here.
function parseList(out) {
  const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  const rowRe = new RegExp(`^\\s*(${GUID})\\b`);
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
  if (count === null && pages.length === 0 && /\bno\s+(?:generated\s+)?pages?\b/i.test(s)) return { kind: 'empty', pages: [] };
  // A complete, authoritative listing: at least one page, every page has a name, count matches
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
  async function enumeratePages(appId) {
    let lastErr = '';
    for (let i = 0; i < attempts; i += 1) {
      const r = await run(['model', 'genpage', 'list', '--environment', env, '--app-id', appId]);
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
  // sitemap — this is what makes uncertain-CREATE recovery crash-safe (C2): a page created+manifested
  // but not yet sitemap-finalized still appears here and is reused on a second run instead of being
  // created again. Reuses classifyListOutput (fail-closed): an unrecognized/incomplete listing NEVER
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

  return {
    // Create (no pageId) or update (with pageId) a page's content. Returns { pageId }. Retries transient
    // pac failures. On an UNCERTAIN CREATE (non-zero, or zero-exit with no Page ID) resolves via a
    // STRICT ENV-WIDE before/after id diff (C2 — addenda overrides the plan here): the env-wide id set
    // is snapshotted BEFORE the first CREATE so the diff reveals exactly which id appeared.
    //   newIds.length === 1 → adopt that id (UPDATE it; I7 guard verifies returned id)
    //   newIds.length === 0 → CREATE did NOT land → safe to retry
    //   newIds.length > 1   → THROW (ambiguous; concurrent creates or noise — never guess)
    // NO name matching anywhere in recovery (names are unreliable — app-scoped list misses
    // pre-sitemap pages; env-wide names drift with sitemap titles). Any enumerateEnv failure → THROW.
    async upload({ appId, pageId, codeFile, compiledCodeFile, name, prompt, agentMessage, dataSources,
      addToSitemap, model, connectors, actions }) {
      // pac REQUIRES both a prompt and an agent-message for a new page. Resolve the effective text
      // (preserving the historical defaults) ONCE, then hand both to pac BY FILE via --prompt-file /
      // --agent-message-file rather than inline --prompt / --agent-message. A downloaded page prompt is
      // a multi-line conversation transcript ("Conversation with N prompts:\r\n1. …\r\n2. …"); passed
      // inline it hits the newline-collapsing in quoteArg/buildPacInvocation (a defensive guard so a
      // stray newline can't truncate the Windows command line) and silently loses every line break on
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
        let pid = pageId;
        let lastErr = '';
        // Set when a CREATE asked for sitemap placement but recovery adopted an existing page id,
        // turning the retry into an UPDATE — which cannot carry --add-to-sitemap. The page then
        // exists but is UNPLACED, and reporting plain success would hide that.
        let sitemapPending = false;
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
          const pidBeforeAttempt = pid;
          const r = await once(pid);
          if (r.status === 0) {
            const id = parsePageId(r.stdout);
            if (id) {
              // I7 guard: when performing an UPDATE (pid is set — whether caller-provided or adopted after
              // uncertain-CREATE reconciliation), the returned Page ID MUST equal the pid we used. A mismatch
              // means pac silently operated on a different page — halt rather than let a wrong record persist.
              // Case-insensitive: PAC can normalize GUID casing across writes.
              if (pid && id.toLowerCase() !== pid.toLowerCase()) {
                throw new Error(
                  `pac genpage upload for '${name || '(unnamed)'}': UPDATE returned an unexpected Page ID (got ${id}, expected ${pid}) — refusing to persist a mismatched update`
                );
              }
              return sitemapPending ? { pageId: id, sitemapPending: true } : { pageId: id };
            }
            lastErr = `returned no Page ID: ${pacDiagnostic(r)}`;
          } else {
            lastErr = pacDiagnostic(r);
          }
          // Uncertain CREATE: no caller pid and result was non-zero or zero-without-Page-ID.
          // Strict env-wide before/after id diff — never use name matching (names drift; app-scoped
          // lists miss pre-sitemap pages; a page's list "Name" is its sitemap title, not its identity).
          if (!pid) {
            const after = await enumerateEnv();
            if (!after.ok) {
              throw new Error(
                `pac genpage upload for '${name || '(unnamed)'}' had an uncertain result and env enumeration failed — refusing to retry (would risk a duplicate): ${after.error}`
              );
            }
            const newIds = after.ids.filter((id) => !beforeIds.has(id));
            if (newIds.length === 1) {
              pid = newIds[0]; // CREATE landed → adopt; I7 guard verifies returned id on the UPDATE
              // The adopted retry runs as an UPDATE, so `--add-to-sitemap` is no longer emitted.
              // Record that the placement the caller asked for did not happen rather than letting
              // a successful-looking result imply a page that is actually unreachable from the nav.
              if (addToSitemap) sitemapPending = true;
            } else if (newIds.length === 0) {
              // CREATE did NOT land → safe to retry (pid stays undefined; beforeIds unchanged)
            } else {
              throw new Error(
                `pac genpage upload for '${name || '(unnamed)'}': ${newIds.length} new pages appeared after an uncertain create — cannot attribute (ambiguous)`
              );
            }
          }
          // A DETERMINISTIC failure will repeat for the same inputs, so retrying it only burns the
          // caller's time and buries the real message under "after 3 attempt(s)". Break out and
          // report it immediately.
          //
          // The test is "will the NEXT attempt run the SAME command?", not "is this a create?".
          // Keying on `!pid` got that wrong in one direction: an ordinary update — where the caller
          // supplied `pageId`, so `pid` is truthy from the very first attempt — sat through all three
          // attempts on a fault that could never resolve itself. The case the guard must NOT break is
          // narrower than "pid is set": it is the single attempt in which an uncertain create was
          // just ADOPTED, because the retry then becomes an update by id and the previous command's
          // argument fault says nothing about it. Comparing `pid` across the attempt identifies
          // exactly that transition.
          const commandChanged = pid !== pidBeforeAttempt;
          if (!commandChanged && isDeterministic(lastErr)) break;
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
  };
}

// A provenance value the caller SUPPLIED but left blank. `undefined`/`null` mean "not supplied", and
// the wrapper's defaults then apply legitimately. A present-but-blank value is different: the caller
// asked for THAT text, so substituting generated provenance deploys words nobody wrote. Whitespace-,
// newline- and BOM-only files are the realistic ways an empty value arrives.
function suppliedButBlank(value) {
  return value !== undefined && value !== null && !String(value).trim();
}
module.exports = { makeGenpageCli, suppliedButBlank, parsePageId, parseList, parseListCount, classifyListOutput, quoteArg, buildPacInvocation, runPac };
