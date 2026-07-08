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

  return {
    // Create (no pageId) or update (with pageId) a page's content. Returns { pageId }. Retries transient
    // pac failures; before retrying a CREATE it re-resolves the page by name so a retry UPDATES in place
    // (a partial first attempt that pushed the page never yields a duplicate).
    async upload({ appId, pageId, codeFile, name, prompt, agentMessage, dataSources }) {
      const once = async (pid) => {
        const args = ['model', 'genpage', 'upload', '--environment', env, '--app-id', appId, '--code-file', codeFile];
        if (pid) args.push('--page-id', pid);
        if (name) args.push('--name', name);
        // pac requires BOTH --prompt and --agent-message for a new page.
        args.push('--prompt', prompt && String(prompt).trim() ? String(prompt) : `Generative page ${name || ''}`.trim());
        args.push('--agent-message', agentMessage && String(agentMessage).trim() ? String(agentMessage) : 'Authored by model-app-maker');
        if (dataSources && dataSources.length) args.push('--data-sources', dataSources.join(','));
        return run(args);
      };
      let pid = pageId;
      let lastErr = '';
      for (let i = 0; i < attempts; i += 1) {
        const r = await once(pid);
        if (r.status === 0) {
          const id = parsePageId(r.stdout);
          if (id) return { pageId: id };
          lastErr = `returned no Page ID: ${lastLine(r)}`;
        } else {
          lastErr = lastLine(r);
        }
        // Before a retry, if this was a CREATE, resolve the page by name so the retry updates in place.
        if (!pid && name) {
          try { const found = (await listPages(appId)).find((p) => p.name === name); if (found) pid = found.pageId; } catch { /* keep create path */ }
        }
        if (i < attempts - 1) await sleep(500 * (i + 1));
      }
      throw new Error(`pac genpage upload failed for '${name}' after ${attempts} attempt(s): ${lastErr}`);
    },
    list({ appId }) {
      return listPages(appId);
    },
    // Download every page of the app into `outputDir/<pageId>/{page.tsx,page.js,config.json,prompt.txt}`.
    async download({ appId, outputDir }) {
      const r = await run(['model', 'genpage', 'download', '--environment', env, '--app-id', appId, '--output-directory', outputDir]);
      if (r.status !== 0) throw new Error(`pac genpage download failed: ${lastLine(r)}`);
      return true;
    },
  };
}

module.exports = { makeGenpageCli, parsePageId, parseList, quoteArg, buildPacInvocation, runPac };
