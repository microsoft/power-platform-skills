'use strict';
// Injectable wrapper around `pac model genpage upload/list` — the seam the build's pages phase uses
// to author/deploy generative pages. Page CONTENT only: uploads run WITHOUT --add-to-sitemap because
// the SDK owns the sitemap (it writes the GenPage subareas). Real impl spawns pac; tests inject `run`.
const { spawnSync } = require('node:child_process');

// Quote an arg for a Windows/POSIX shell command line (needed because pac resolves as pac.cmd on
// Windows, which requires shell:true — and shell:true does not quote an args array). Embedded
// newlines terminate the command line (pac then sees a truncated command and dumps its help), so
// collapse them to spaces first — downloaded page prompts are multi-line ("Conversation with N
// prompts:\r\n1. …\r\n2. …") and would otherwise break the upload on an edit-rebuild.
function quoteArg(a) {
  const s = String(a).replace(/\r\n|[\r\n]/g, ' ');
  return /[\s"'&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Build the spawnSync invocation for a `pac` call, per platform. Windows: pac resolves as pac.cmd,
// which requires a shell; shell:true ignores an args array, so pass a single cmd-quoted command
// line ("" escapes an embedded quote). POSIX: spawn pac directly with the args array (no shell) so
// embedded quotes and other shell metacharacters in prompts round-trip verbatim instead of being
// mangled by cmd-style quoting. Embedded newlines are collapsed to spaces on every arg first (they
// truncate the command line on Windows and confuse pac's parsing) — downloaded page prompts are
// multi-line and would otherwise break the upload on an edit-rebuild.
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
function parsePageId(out) {
  const m = /Page ID:\s*([0-9a-fA-F-]{36})/.exec(String(out || ''));
  return m ? m[1] : null;
}

// Parse `pac model genpage list` output. The layout is a page-name line followed by an indented
// "Page ID: <guid>" line (and a Description line), e.g.:
//   Overview
//     Page ID: 5d29d8ce-...
// So the name is the last non-metadata line seen before a "Page ID:" line.
function parseList(out) {
  const pages = [];
  let lastName = null;
  for (const raw of String(out || '').split('\n')) {
    const line = raw.trim();
    const idm = /Page ID:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(line);
    if (idm) { pages.push({ pageId: idm[1], name: lastName || undefined }); lastName = null; continue; }
    if (line && !/^(Description|Connected|Retrieving|Found|Page ID)\b/i.test(line) && !/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(line)) lastName = line;
  }
  return pages;
}

// Extract the summary count pac prints on `pac model genpage list`, e.g.
//   "Found 3 generated page(s):"  → 3
//   "Found 0 generated page(s):"  → 0
// Returns the integer, or null when the summary line is absent (unknown format). parseList skips
// the "Found …" line as metadata; this reads its N so classifyListOutput can prove the listing is
// COMPLETE (parsed page count == summary N).
function parseListCount(stdout) {
  const m = /found\s+(\d+)\s+(?:generated\s+)?page/i.exec(String(stdout || ''));
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
  // Explicit empty: "Found 0 generated page(s)" OR a "no pages" variant phrase
  if (count === 0 || /\bno\s+(?:generated\s+)?pages?\b/i.test(s)) return { kind: 'empty', pages: [] };
  const pages = parseList(s);
  // A complete, authoritative listing: at least one page, every page has a name, count matches
  const allNamed = pages.length > 0 && pages.every((p) => p.name && String(p.name).trim());
  if (allNamed && count !== null && count === pages.length) return { kind: 'pages', pages };
  return { kind: 'unrecognized', pages: [] };
}

function makeGenpageCli(env, deps = {}) {
  const run = deps.run || runPac;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = deps.attempts || 3; // pac genpage upload/list flake intermittently (transient help-dump exits)
  const lastLine = (r) => String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';

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
        lastErr = lastLine(r);
      }
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return { ok: false, pages: [], error: `pac genpage list failed after ${attempts} attempt(s): ${lastErr}` };
  }

  return {
    // Create (no pageId) or update (with pageId) a page's content. Returns { pageId }. Retries transient
    // pac failures. On an UNCERTAIN CREATE (non-zero, or zero-exit with no Page ID) re-enumerates
    // FAIL-CLOSED before deciding to retry: a blind 2nd CREATE could duplicate a page the first attempt
    // already created server-side (design §9, C3). Enumeration failure → THROW (no blind retry).
    async upload({ appId, pageId, codeFile, name, prompt, agentMessage, dataSources }) {
      const once = async (pid) => {
        const args = ['model', 'genpage', 'upload', '--environment', env, '--app-id', appId, '--code-file', codeFile];
        if (pid) args.push('--page-id', pid);
        if (name) args.push('--name', name);
        // pac requires BOTH --prompt and --agent-message for a new page.
        args.push('--prompt', prompt && String(prompt).trim() ? String(prompt) : `Generative page ${name || ''}`.trim());
        args.push('--agent-message', agentMessage && String(agentMessage).trim() ? String(agentMessage) : 'Authored by app-builder');
        if (dataSources && dataSources.length) args.push('--data-sources', dataSources.join(','));
        return run(args);
      };
      let pid = pageId;
      let lastErr = '';
      for (let i = 0; i < attempts; i += 1) {
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
                `pac genpage upload for '${name}': UPDATE returned an unexpected Page ID (got ${id}, expected ${pid}) — refusing to persist a mismatched update`
              );
            }
            return { pageId: id };
          }
          lastErr = `returned no Page ID: ${lastLine(r)}`;
        } else {
          lastErr = lastLine(r);
        }
        // Uncertain outcome: non-zero OR zero-without-Page-ID on a CREATE (pid not yet set).
        // Re-enumerate FAIL-CLOSED before any retry to prevent a blind duplicate (design §9, C3):
        //  - enumeration failure           → THROW immediately (can't verify; risk of duplicate)
        //  - exactly one same-named match  → adopt its pid (CREATE landed; retry as UPDATE in place)
        //  - multiple same-named matches   → THROW (ambiguous; refuse to add another)
        //  - zero matches                  → CREATE did NOT land; safe to retry a CREATE
        if (!pid && name) {
          const listed = await enumeratePages(appId);
          if (!listed.ok) {
            throw new Error(
              `pac genpage upload for '${name}' had an uncertain result and page enumeration failed — refusing to retry (would risk a duplicate): ${listed.error}`
            );
          }
          const matches = listed.pages.filter((p) => p.name === name);
          if (matches.length > 1) {
            throw new Error(
              `pac genpage upload for '${name}': multiple live pages already share this name — refusing to create another (ambiguous)`
            );
          }
          if (matches.length === 1) pid = matches[0].pageId; // adopt: the create landed; next iteration UPDATEs
          // if matches.length === 0: pid stays undefined; next iteration retries the CREATE safely
        }
        if (i < attempts - 1) await sleep(500 * (i + 1));
      }
      throw new Error(`pac genpage upload failed for '${name}' after ${attempts} attempt(s): ${lastErr}`);
    },
    list({ appId }) {
      return listPages(appId);
    },
    enumerate({ appId }) {
      return enumeratePages(appId);
    },
    // Download every page of the app into `outputDir/<pageId>/{page.tsx,page.js,config.json,prompt.txt}`.
    async download({ appId, outputDir }) {
      const r = await run(['model', 'genpage', 'download', '--environment', env, '--app-id', appId, '--output-directory', outputDir]);
      if (r.status !== 0) throw new Error(`pac genpage download failed: ${lastLine(r)}`);
      return true;
    },
  };
}

module.exports = { makeGenpageCli, parsePageId, parseList, parseListCount, classifyListOutput, quoteArg, buildPacInvocation, runPac };
