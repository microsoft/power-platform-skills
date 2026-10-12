'use strict';
// Injectable wrapper around `pac model genpage upload/list` — the seam the build's pages phase uses
// to author/deploy generative pages. Page CONTENT only: uploads run WITHOUT --add-to-sitemap because
// the SDK owns the sitemap (it writes the GenPage subareas). Real impl spawns pac; tests inject `run`.
const { invocation, spawnProcess, killProcessTree } = require('./process-runner.js');
const { pacTimeoutMs, pacTimeoutAdvice, pacLongerTimeoutMs, PAC_TIMEOUT_ENV, commandArgOrPlaceholder } = require('./cli-failure.js');
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
const REAL_CLOCK = { setTimeout, clearTimeout };

// An error that must never be answered by trying again. The build re-runs a whole phase when a halt looks transient (isTransientHalt in build-model-app.js), and it decides that from
// the error's TEXT — which quotes the page's name (user text: "SQL Timeouts", "Concurrent Deletes") and pac's own diagnostic ("… try again later") — so such an error says so with
// `transient: false`, which that check reads on the error and on its cause. Every error that follows an upload that was SENT, unless what it did is known to be nothing, is one: the
// re-run would send it again — a second create, with the first one's page, if it landed, left beside the new one outside the app's navigation; or a second update.
function neverRetriedError(message, options) {
  return Object.assign(new Error(message, options), { transient: false });
}

// How many times a READ (a listing, a download) that keeps timing out is made: the first, and one retry. A call that stalls once usually answers the next time,
// but each try can cost the whole budget (3 min), so a third is not offered however many attempts an ordinary failure gets. An upload is never retried after a
// timeout: see makeGenpageCli for what each kind of call does with one, and why.
const TIMED_OUT_ATTEMPTS = 2;

// What a pac run reports when its caller ended it (`runPac`'s `signal`), in the failed result's stderr.
const PAC_ENDED = 'pac was ended: its answer is no longer needed';

// Runs `pac <args>` and waits at most `timeoutMs` for it. When the time is up the whole process tree is ended (killTree: `pac.cmd` → cmd.exe → pac.exe is
// three processes on Windows, and ending the shim alone would leave the stalled one running) and the result says so — `status: null, timedOut: true,
// timeoutMs, command` — which no exit code is, so a caller can tell a stalled call from a failed one. Output printed before the stall is kept.
// `spawn`, `killTree` and `clock` are seams for the tests; a call with no budget gets the read one, so no pac call is ever unbounded.
//
// `signal` (an AbortSignal) ends the run too: pac AND everything it started are killed — through the same `killTree` as a timeout — and the result is a failed one
// marked `ended: true` with no output, since a half-read listing must never be parsed. A caller that ended a run is not waiting for it, which is not what
// a stall is: `ended` is for the caller to treat as it treats `timedOut` wherever a re-send could do harm. A signal that has already aborted starts nothing.
function runPac(args, { timeoutMs = pacTimeoutMs('list'), spawn = spawnProcess, killTree = killProcessTree, clock = REAL_CLOCK, signal } = {}) {
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
    let timer = null;
    // Settles ONCE, whichever of the child's 'close', its 'error', the deadline and the caller's signal comes first: a child that is killed at the deadline or on
    // the signal still closes, and that close must not resolve the call a second time or turn the timeout into an exit code.
    // `how` is 'timedOut' (the deadline passed) or 'ended' (the caller's signal ended the run), otherwise null.
    const finish = (status, launchError, how = null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        status: how === 'timedOut' ? null : (status == null ? 1 : status),
        stdout: how === 'ended' ? '' : Buffer.concat(out).toString('utf8'),
        // POSIX reports a missing pac as a spawn 'error' (ENOENT) with nothing on stderr; carry its
        // message so the diagnostic says why instead of "pac exited 1 with no output".
        stderr: stderr || (launchError ? String(launchError.message || launchError) : ''),
        ...(how === 'timedOut' ? { timedOut: true, timeoutMs, command: ['pac', ...args.slice(0, 3)].join(' ') } : {}),
        ...(how === 'ended' ? { ended: true } : {}),
      });
    };
    if (signal && signal.aborted) {
      finish(1, new Error(PAC_ENDED), 'ended');
      return;
    }
    let child;
    try {
      // Resolution and argument checks throw here too, and resolve as a failed result like a launch error.
      child = spawn('pac', cleanPacArgs(args), { stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (timeoutMs > 0) {
      timer = clock.setTimeout(() => {
        // End the tree first, so pac is gone before the caller acts on the result — the retry of a read, or the check an upload's message sends the user to, must not race the call it gave up on.
        try { killTree(child); } catch { /* the call is reported as stalled either way */ }
        finish(null, null, 'timedOut');
        // A process that outlived the kill (or one the kill missed) holds these pipes open, and a pipe nobody has finished reading keeps this process alive
        // at exit: release them, and the child's own handle, now that the result is out.
        for (const stream of [child.stdout, child.stderr]) {
          try { if (stream) stream.destroy(); } catch { /* already closed */ }
        }
        if (typeof child.unref === 'function') child.unref();
      }, timeoutMs);
      // The child's handle keeps the loop alive while pac runs; the deadline must not be what keeps a process running once it does not.
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    if (signal) {
      // Settled here rather than at 'close': a caller that stopped waiting must not wait for the pipes of a process that
      // is on its way out. On Windows taskkill has finished by the time killTree returns; elsewhere the signal is sent.
      const end = () => {
        try { killTree(child); } catch { /* the run is reported as ended either way */ }
        finish(1, new Error(PAC_ENDED), 'ended');
      };
      signal.addEventListener('abort', end, { once: true });
      child.on('close', () => signal.removeEventListener('abort', end));
    }
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
  // The pac runs this client has in flight, one controller each, so that `abort()` can end them: pac has no timeout of its
  // own, and a verify pass that stopped needing its answers must not leave it running.
  const inFlight = new Set();
  // Bumped by abort(); see runForCall.
  let abortEpoch = 0;
  // Forwards a call's own options (its time budget: `budget(kind)`) beside the controller that lets abort() end the run.
  const startRun = deps.run || ((args, options = {}) => {
    const controller = new AbortController();
    inFlight.add(controller);
    const call = runPac(args, { ...options, signal: controller.signal });
    const forget = () => inFlight.delete(controller);
    call.then(forget, forget);
    return call;
  });
  // The `run` that ONE call of this client — an enumeration, an upload, a download — starts its pac runs with. abort() ends the
  // runs in flight, but a call that is PAUSED between two attempts (a listing that failed once waits before it asks again) has
  // none in flight: when the pause ends, its next attempt would start a pac that nothing ever ends. So a call remembers how many
  // aborts there had been when it began, and once there has been another, every run it asks for answers `ended` — what a run
  // ended in flight answers — without starting anything. No retry loop needs a check of its own that way, and one added later is
  // covered by making its runs with this. A call that begins after the abort is an ordinary one: the client stays usable.
  const runForCall = () => {
    const epoch = abortEpoch;
    return (...callArgs) => (abortEpoch === epoch
      ? startRun(...callArgs)
      : Promise.resolve({ status: 1, stdout: '', stderr: PAC_ENDED, ended: true }));
  };
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = deps.attempts || 3; // pac genpage upload/list flake intermittently (transient help-dump exits)
  // The budget of ONE pac call of this kind (lib/cli-failure.js pacTimeoutMs: 3 min to list or download, 10 min to upload, or
  // POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS), read when the call is made. `run` ends a call that runs out of it and answers `{ status: null, timedOut: true }`.
  //
  // What each kind of call does about a timeout follows from what it can have done to the environment before it was stopped. pac's `genpage upload` is a
  // SEQUENCE (pac 2.12.2): it writes the page's files in one batch, then makes two requests that record the prompt and the agent message in the page's
  // conversation history, then prints `Page ID: <id>`, then publishes the page and registers its tables. A call that is stopped has therefore done anything from
  // nothing to all but the last step, and nothing outside says which: a stall with no CPU and no network is most likely a long server call, such as the publish,
  // with everything before it already written.
  //   list, download   read only, so a second attempt costs nothing but time: retried ONCE (TIMED_OUT_ATTEMPTS), however many attempts an ordinary failure gets.
  //   upload, UPDATE   NOT retried, though it names a page that exists. A second send goes to the same page id and is still not harmless. If the first had written
  //                    the page and stalled in the publish, the second records the prompt and the agent message AGAIN (the two requests carry no client id to
  //                    dedupe on, and a later download's prompt.txt then holds the duplicate). And it goes out minutes after the caller's own checks —
  //                    genpage-upload.js compares the page with its base marker once, before it calls upload() — so it can overwrite a change the maker saved in
  //                    between. The call is reported as timed out and as one that MAY HAVE LANDED, and a re-run goes back through the caller's own guards. What the
  //                    message sends the reader to look at depends on the caller (upload()'s `caller`): see lookFirst there.
  //                    An update that FAILS is not sent again either, for the same reason: a non-zero exit, or an exit 0 with no Page ID, can come anywhere in that
  //                    sequence — in the publish, after everything else is written. Only a failure pac reports for its own arguments or input files (isDeterministic),
  //                    with no Page ID printed, is an ordinary one: pac checks those before it sends anything, so nothing can have landed.
  //   upload, CREATE   an UNCERTAIN create, and never run again: it may have created the page, may be creating it, or may never have started. A Page ID pac had
  //                    already printed names the page it created, whether it then stalled or failed; otherwise the env-wide id diff reports any page that is already
  //                    visible; and a page that is not visible YET proves nothing, because a second create is exactly how a duplicate is made. Each error that ends
  //                    such a create carries `transient: false` (neverRetriedError), so the build's own re-run of a halt it takes for transient never sends it again.
  //   a run that was ENDED (`ended`: abort(), see runForCall) says as little as one that timed out, so an upload it ends is never sent again either: an UPDATE fails with
  //                    `transient: false` and the advice to look at the page first, and a CREATE is judged like one that stalled. A listing or a download that was ended is just reported.
  const processEnv = deps.processEnv || process.env;
  const budget = (kind) => ({ timeoutMs: pacTimeoutMs(kind, processEnv) });
  // A pac run that stops without an answer: it ran out of its budget (`timedOut`) or its caller ended it (`ended`). Neither says what the call did before it stopped.
  const unanswered = (r) => !!(r && (r.timedOut || r.ended));
  // How a stopped upload is told. pacTimeoutAdvice, which a stopped READ gets, ends in "retry" — not what to say about an upload.
  const stoppedAfter = (r) => (r.ended ? 'was ended before it answered' : `timed out after ${Math.round((r.timeoutMs || 0) / 1000)} s and was stopped`);
  // A message's command is one the user — or the agent — pastes, and a path can hold a space ("C:\Users\Dev User\...") or, from an untrusted checkout, shell syntax:
  // keep it ONE argument that no shell reads anything in, or write a placeholder and name the path as data (lib/cli-failure.js commandArg).
  const argOrPlaceholder = commandArgOrPlaceholder;
  const allowLonger = (r) => {
    // A run that was ended did not run out of time, so a longer budget would not have changed it.
    if (r.ended) return '';
    const longer = pacLongerTimeoutMs(r.timeoutMs || pacTimeoutMs('upload', processEnv));
    return longer === null ? '' : ` ${PAC_TIMEOUT_ENV}=${longer} allows a slow upload longer.`;
  };
  // The way on from a page that a stopped create left behind. pac makes the page, then publishes it, and only when asked adds it to the app's navigation, so a
  // create stopped part way leaves a page that EXISTS and is not in the app's navigation. genpage-upload.js refuses to UPDATE such a page (it is not in the app's
  // navigation, and no base marker records it), the build cannot bind it (an id nothing proves is this app's is `unproven-manifest-id`), and a second create would
  // make a duplicate. So the page is placed first: `pac model genpage add` attaches an existing page to an app's sitemap without uploading it again, and its
  // `--page-id` is then a page the app's navigation proves — which the build binds from the App Spec's `pageId`.
  const finishPage = (id, appId) => `add page ${id} to the app's navigation — in Maker, or with \`pac model genpage add --environment ${env} --app-id ${appId} --page-id ${id} --publish\` — `
    + `and then re-run the upload as an update with --page-id ${id} (a build: set that page's pageId to ${id} in the App Spec); or delete page ${id} and re-run the create`;
  // What to do about a create that may have made a page nothing has shown yet — one that stalled, or whose result could not be checked: look for the page before anything is created
  // again. It is the way on whenever the page's id is not known, because a second create is how a duplicate is made.
  const lookForThePage = (appId) => `Wait a few minutes, then run \`pac model genpage list --environment ${env} --include-unpublished\`: if a new page with this name appears and it is yours, ${finishPage('<its id>', appId)}; `
    + 'if none appears, re-run the create.';
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
    // A call that ran out of time has no exit code and may have printed nothing: say it was stopped, and how to allow it longer.
    if (r && r.timedOut) return pacTimeoutAdvice(r.command || 'pac', r.timeoutMs || pacTimeoutMs('list', processEnv));
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
    const run = runForCall();
    const r = await run(['model', 'genpage', 'list', '--environment', env, '--app-id', appId], budget('list'));
    return r.status === 0 ? parseList(r.stdout) : [];
  }

  // Fail-closed page enumeration (design §9, I2). Retries up to `attempts` times (pac genpage list
  // flakes with transient help-dump exits on some PAC CLI builds), but a listing that times out is
  // tried twice at most. Returns:
  //   { ok: true, pages, empty: true }  — app genuinely has no pages ("Found 0" or no-pages phrase)
  //   { ok: true, pages: [...] }        — COMPLETE listing: count matches, all pages named
  //   { ok: false, pages: [], error }   — persistent non-zero exit OR a persistent zero-exit
  //                                       UNRECOGNIZED/INCOMPLETE output (count mismatch, blank,
  //                                       help banner, unnamed page) OR a call that kept timing out
  //                                       — never masquerade as empty.
  // Callers that drive a create decision MUST check ok before trusting pages:[] as "truly empty".
  async function enumeratePages(appId, options = {}) {
    const run = runForCall();
    let lastErr = '';
    let tried = 0;
    let timedOut = 0;
    for (let i = 0; i < attempts; i += 1) {
      const args = ['model', 'genpage', 'list', '--environment', env, '--app-id', appId];
      if (options && options.includeUnpublished === true) args.push('--include-unpublished');
      const r = await run(args, budget('list'));
      tried += 1;
      // A run the caller ended is not a flake to retry: nobody is waiting for the answer any more.
      if (r.ended) return { ok: false, pages: [], error: `pac genpage list was ended: ${r.stderr}` };
      if (r.status === 0) {
        const c = classifyListOutput(r.stdout);
        if (c.kind !== 'unrecognized') return { ok: true, pages: c.pages, empty: c.kind === 'empty' };
        // Zero-exit but unrecognized/incomplete listing — treat as a retryable failure so transient
        // help-dump exits don't look like empty apps. Fail-closed: never return ok:true for this.
        lastErr = 'unrecognized/incomplete `pac genpage list` output (zero exit, no valid page listing or a count mismatch) — refusing to treat as empty';
      } else {
        lastErr = pacDiagnostic(r);
      }
      if (r.timedOut && (timedOut += 1) >= TIMED_OUT_ATTEMPTS) break;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return { ok: false, pages: [], error: `pac genpage list failed after ${tried} attempt(s): ${lastErr}` };
  }

  // Env-WIDE EXISTENCE enumeration (NO --app-id): returns the set of ALL generative-page ids that exist
  // in the environment, regardless of which app they belong to or whether they are in any sitemap.
  // `--include-unpublished` ensures a just-created draft counts before it has been finalized into a
  // sitemap, so uncertain results can report their candidates and receipted build creates remain
  // discoverable before placement. Enumeration itself grants no ownership or update authority.
  // Reuses classifyListOutput (fail-closed): an unrecognized/incomplete listing NEVER
  // masquerades as an empty environment. `ids` are lower-cased for case-insensitive set membership.
  // `run` is the one a caller already inside a call of this client (upload, below) makes its runs with; a listing of its own
  // makes its own.
  async function enumerateEnv(run = runForCall()) {
    let lastErr = '';
    let tried = 0;
    let timedOut = 0;
    for (let i = 0; i < attempts; i += 1) {
      const r = await run(['model', 'genpage', 'list', '--environment', env, '--include-unpublished'], budget('list'));
      tried += 1;
      // A run the caller ended is not a flake to retry: nobody is waiting for the answer any more.
      if (r.ended) return { ok: false, ids: [], error: `pac genpage list (env-wide) was ended: ${r.stderr}` };
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
      if (r.timedOut && (timedOut += 1) >= TIMED_OUT_ATTEMPTS) break;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return { ok: false, ids: [], error: `pac genpage list (env-wide) failed after ${tried} attempt(s): ${lastErr}` };
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
    // Create (no pageId) or update (with pageId) a page's content. Returns { pageId }. Retries a CREATE
    // that failed outright and left nothing behind — never an UPDATE that pac may have started (any failure but a refusal of its arguments), and never anything that
    // TIMED OUT (the policy at the top of makeGenpageCli). On an UNCERTAIN CREATE (non-zero, or zero-exit with no Page ID) resolves via a
    // STRICT ENV-WIDE before/after id diff: the env-wide id set
    // is snapshotted BEFORE the first CREATE so the diff reveals exactly which id appeared.
    //   a Page ID pac printed → that page was created, whether the call then stalled or failed: report it and stop (a create is never run again)
    //   newIds.length >= 1 → report stored details and stop; only the user can confirm ownership
    //   newIds.length === 0 → the failed CREATE did NOT land → safe to retry (not after a timeout: the service may still be creating the page)
    // Names and dates describe candidates, never establish identity. Read failures also stop,
    // with the candidate id retained in the diagnostic. No uncertain result changes the command to UPDATE.
    // `caller` is 'build' when the App Spec build (lib/sdk-build.js) is the one uploading, and anything else for the standalone upload script: it only changes the advice
    // given for an UPDATE that timed out or failed (lookFirst, below), never what is sent or when. `sourceFile` is the file the caller knows the page as when `codeFile` is a copy of it — the
    // upload script sends pac a copy of the bytes it checked, removed once pac answers — and is the file that advice names; pac only ever reads `codeFile`.
    async upload({ appId, pageId, codeFile, sourceFile, compiledCodeFile, name, prompt, agentMessage, dataSources,
      addToSitemap, model, connectors, actions, caller }) {
      // Every pac run of this upload — its snapshots and listings included — is made with the one `run`, so an abort() that lands
      // while the upload pauses between attempts starts nothing more (see runForCall).
      const run = runForCall();
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
          return run(args, budget('upload'));
        };
        const pid = pageId;
        let lastErr = '';
        // Snapshot taken once (lazily on the first CREATE attempt) so the before/after diff is anchored
        // to the exact env state before this operation. Fail-closed: if we can't snapshot, we can't
        // safely attribute a later uncertain result — halt to prevent a blind duplicate.
        let beforeIds = null;
        const label = name || '(unnamed)';
        // What to look at before anything is sent again, for an UPDATE that MAY HAVE LANDED (one that timed out, or failed). What is deployed decides what happens next, and
        // which look works depends on who is asking:
        //   the upload script   compares the page with the base marker it keeps beside the code file, and a re-run goes back through that comparison — the
        //                       file it names is `sourceFile`, the one the marker belongs to, not the copy pac read;
        //   the build           keeps no base marker, so `genpage-base.js check` could only say "unknown" about what is deployed, and its `--file` would be
        //                       the staging copy the build deletes when it ends (every page is sent from one) — the advised command would fail on a missing file. It is
        //                       told to read the deployed page with the download it already uses (the `pac model genpage download` that verify-model-app.js and
        //                       download-model-app.js run), and that running the build again sends this page once more to the same id, with what that costs.
        // `how` names the send that stopped: 'stalled' or 'failed'.
        const lookFirst = (id, how) => {
          if (caller === 'build') {
            return `First see what is deployed: pac model genpage download --environment ${env} --app-id ${appId} --page-id ${id} --output-directory <folder>, then read the page.tsx in the folder under <folder> that is named for the page id `
              + '(pac writes the id in its own letter case, so look for it without regard to case; a page that links to another shows that page\'s id where its source in the app folder has a PAGEREF_ name). '
              + `Then run the build again: it sends this page once more, to the same page id, so nothing new is created — but if the ${how} send did land, the page's history now records its prompt a second time, `
              + 'and anything saved to the page in Maker since is replaced by the app folder\'s version. Look first if either matters.';
          }
          const file = argOrPlaceholder(sourceFile || codeFile, '<file>');
          return `First see what is deployed: node scripts/genpage-base.js check --env ${env} --app-id ${appId} --page-id ${id} --file ${file.arg} ("contentSame": true means the update landed; "deployed": "unchanged" means it did not). `
            + (file.note ? `${file.note} ` : '')
            + 'Then re-run the upload: its own checks decide whether it may go ahead.';
        };
        for (let i = 0; i < attempts; i += 1) {
          if (!pid && beforeIds === null) {
            const before = await enumerateEnv(run);
            if (!before.ok) {
              throw new Error(
                `pac genpage upload for '${name || '(unnamed)'}': cannot snapshot the environment before create (${before.error}) — refusing to create (would risk a duplicate)`
              );
            }
            beforeIds = new Set(before.ids);
          }
          const r = await once(pid);
          // An UPDATE that timed out is not sent again, and is not told as an ordinary failure: it may have landed (the policy at the top of makeGenpageCli). What
          // is deployed decides what happens next, so the message sends the reader to look (lookFirst).
          if (r.timedOut && pid) {
            throw neverRetriedError(
              `pac genpage upload for '${label}' ${stoppedAfter(r)} — the UPDATE of page ${pid} MAY HAVE LANDED: `
              + (parsePageId(r.stdout)
                ? 'pac had printed the Page ID, which it does once the page and its messages are written, so the stall came while it was publishing. '
                : 'pac writes the page, then records the prompt and the agent message, then publishes, so the stall can have come after any of those with nothing reported. ')
              + 'It was NOT sent again: a second send can record the prompt twice, and would overwrite a change made to the page since. '
              + `${lookFirst(pid, 'stalled')}${allowLonger(r)}`
            );
          }
          if (r.status === 0) {
            const id = parsePageId(r.stdout);
            if (id) {
              // When performing an explicitly requested UPDATE, the returned Page ID MUST equal
              // the pid we used. A mismatch
              // means pac silently operated on a different page — halt rather than let a wrong record persist.
              // Case-insensitive: PAC can normalize GUID casing across writes.
              // `transient: false`: the send did something, so the build's own re-run of a halt it takes for transient (the page's name is in the text) must not repeat it.
              if (pid && id.toLowerCase() !== pid.toLowerCase()) {
                throw neverRetriedError(
                  `pac genpage upload for '${name || '(unnamed)'}': UPDATE returned an unexpected Page ID (got ${id}, expected ${pid}) — refusing to persist a mismatched update`
                );
              }
              return { pageId: id };
            }
            lastErr = `returned no Page ID: ${pacDiagnostic(r)}`;
          } else {
            lastErr = pacDiagnostic(r);
          }
          // Uncertain CREATE: no caller pid and result was non-zero, zero-without-Page-ID, or TIMED OUT.
          // The env-wide diff discovers candidates, not ownership. A concurrent create can have
          // the same name and date, so even a single candidate cannot authorize an automatic UPDATE.
          if (!pid) {
            // A create that printed the Page ID has created that page, whether it then stalled or failed: pac prints the id once the page and its messages are written, before it
            // publishes and before it adds the page to the app's navigation. Nothing needs listing to know the page exists — and a listing need not show it yet — and running the
            // create again would make a second one. (A create that printed it and exited 0 has returned above; a malformed id is not one: parsePageId.)
            const created = parsePageId(r.stdout);
            if (created) {
              throw neverRetriedError(
                r.timedOut
                  ? `pac genpage upload for '${label}' ${stoppedAfter(r)} after it had CREATED the page as ${created} (pac prints the Page ID once the page is written) — `
                    + 'it stalled before the page was published, and before it was added to the app\'s navigation if that was asked for. '
                    + `The create was NOT run again: a second create would make a duplicate page. To finish it, ${finishPage(created, appId)}.${allowLonger(r)}`
                  : `pac genpage upload for '${label}' failed after it had CREATED the page as ${created} (pac prints the Page ID once the page is written) — `
                    + `it stopped before the page was published, or before it was added to the app's navigation if that was asked for (${lastErr}). `
                    + `The create was NOT run again: a second create would make a duplicate page. To finish it, ${finishPage(created, appId)}.`
              );
            }
            const after = await enumerateEnv(run);
            if (!after.ok) {
              throw neverRetriedError(
                `pac genpage upload for '${name || '(unnamed)'}' ${unanswered(r) ? `${stoppedAfter(r)}, and ` : ''}had an uncertain result and env enumeration failed — refusing to retry (would risk a duplicate): ${String(after.error).replace(/[.\s]+$/, '')}. `
                + `The create may have made a page. ${lookForThePage(appId)}${r.timedOut ? allowLonger(r) : ''}`
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
              // Whatever stopped the create — a stall or a failure — pac makes the page, publishes it, and only when asked adds it to the app's navigation, so a candidate it
              // left is most likely NOT in the app's navigation: an update of it is refused (not in the app's navigation, no base marker), and `finishPage` is the way on. A
              // failure after pac printed `Page ID` is the same state as a stall after it: the page is written, and the publish or the placement did not finish.
              const way = `If one is yours, ${finishPage(newIds.length === 1 ? newIds[0] : '<its id>', appId)}; otherwise leave them and re-run the create.`;
              throw neverRetriedError(`pac genpage upload for '${name || '(unnamed)'}' ${r.timedOut ? 'timed out and was stopped, and ' : (r.ended ? 'was ended before it answered, and ' : '')}had an uncertain create (ambiguous ownership). Candidates: ${details.join('; ')}. Refusing to adopt or update any candidate. ${way}`, readFailure ? { cause: readFailure } : undefined);
            }
            // A create that TIMED OUT, or was ENDED, is never run again, even with nothing in the diff: the request may still be in flight on the service, and the page not
            // visible YET. Re-running it is how a duplicate is made.
            if (unanswered(r)) {
              throw neverRetriedError(
                `pac genpage upload for '${label}' ${stoppedAfter(r)} — an UNCERTAIN create: `
                + 'no new page is visible in the environment yet, but the service may still be creating it. Refusing to re-run the create (a second create would risk a duplicate page). '
                + `${lookForThePage(appId)}${allowLonger(r)}`
              );
            }
            // Only a CREATE that failed outright reaches here (one that timed out or was ended has thrown above), and it left nothing behind → did NOT land → safe to retry (pid stays undefined; beforeIds unchanged)
          }
          // A DETERMINISTIC failure will repeat for the same inputs, so retrying it only burns the
          // caller's time and buries the real message under "after 3 attempt(s)". Break out and
          // report it immediately.
          //
          // The next attempt always uses the same explicit id (or remains CREATE); recovery
          // never changes command identity, so deterministic failures must stop in both modes.
          //
          // A run that was ENDED (abort()) is no flake either: nobody is waiting for the answer, and every attempt after it answers
          // "ended" at once, so pausing for them would only delay the failure. (A CREATE that was ended has already been judged above, like one
          // that timed out, so what reaches here is an UPDATE.) What it did before it was ended is unknown, as it is after a timeout, so it is
          // never sent again — not by this loop, and not by the build's own re-run of a halt it takes for transient (`transient: false`).
          if (r.ended) {
            throw neverRetriedError(
              `pac genpage upload failed for '${name || '(unnamed)'}': ${lastErr}`
              + (pid ? ` — the UPDATE of page ${pid} may have landed before it was ended, and it was NOT sent again: look at the page before running it again` : '')
            );
          }
          // An UPDATE that FAILED is not sent again either — not by this loop, and not by the build's own re-run (`transient: false`) — unless pac refused its arguments or
          // input files (isDeterministic, on a non-zero exit, with no Page ID printed), which it checks before it sends anything. Any other failure, a non-zero exit or an exit 0
          // with no Page ID, can come after pac wrote the page and recorded the prompt and the agent message — in the publish — so a second send would record them again and
          // can overwrite a change saved in between, as after a stall (the policy at the top of makeGenpageCli). A Page ID pac printed proves that much was written whatever its
          // error says: after it, pac's only step is the publish, whose error carries the server's own text, and that text can read like a refused file. Only a CREATE that
          // failed outright and left nothing behind reaches the retry below.
          if (pid && (r.status === 0 || parsePageId(r.stdout) || !isDeterministic(lastErr))) {
            throw neverRetriedError(
              `pac genpage upload for '${label}' failed (${lastErr}) — the UPDATE of page ${pid} MAY HAVE LANDED: `
              + (parsePageId(r.stdout)
                ? 'pac had printed the Page ID, which it does once the page and its messages are written, so the failure came while it was publishing. '
                : 'pac writes the page, then records the prompt and the agent message, then publishes, so the failure can have come after any of those. ')
              + 'It was NOT sent again: a second send can record the prompt twice, and would overwrite a change made to the page since. '
              + lookFirst(pid, 'failed')
            );
          }
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
    // Ends every pac run this client started that has not finished, with the whole process tree of each (see runPac), and
    // keeps every call that is still going — one paused between two attempts, say — from starting another (see runForCall).
    // A call that begins afterwards is not affected: the client stays usable.
    abort() {
      abortEpoch += 1;
      for (const controller of [...inFlight]) controller.abort();
    },
    // Download page CONTENT into `outputDir/<pageId>/{page.tsx,page.js,config.json,prompt.txt}`. With
    // `pageIds` (non-empty) pull exactly those pages via `--page-id <comma>` — the sitemap's id set,
    // so download is headless-free and fetches only real app content. Omit `pageIds` to download all
    // app pages (back-compat for any legacy caller that does not provide the sitemap id set).
    async download({ appId, outputDir, pageIds }) {
      // A single run today; a retry added here must make its runs with this `run`, which starts none once abort() has come.
      const run = runForCall();
      const args = ['model', 'genpage', 'download', '--environment', env, '--app-id', appId, '--output-directory', outputDir];
      if (pageIds && pageIds.length) args.push('--page-id', pageIds.join(','));
      // Read only, so a call that times out is simply made again (once); any other failure is reported at once, as it always was.
      let r;
      for (let i = 0; i < TIMED_OUT_ATTEMPTS; i += 1) {
        r = await run(args, budget('download'));
        if (!r.timedOut) break;
        if (i < TIMED_OUT_ATTEMPTS - 1) await sleep(500 * (i + 1));
      }
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
