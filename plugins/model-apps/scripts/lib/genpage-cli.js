'use strict';
// Injectable wrapper around `pac model genpage upload/list` — the seam the build's pages phase uses
// to author/deploy generative pages. Page CONTENT only: uploads run WITHOUT --add-to-sitemap because
// the SDK owns the sitemap (it writes the GenPage subareas). Real impl spawns pac; tests inject `run`.
const { spawnSync } = require('node:child_process');

function runPac(args) {
  const r = spawnSync('pac', args, { encoding: 'utf8', shell: true });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Extract the "Page ID: <guid>" pac prints on a successful upload.
function parsePageId(out) {
  const m = /Page ID:\s*([0-9a-fA-F-]{36})/.exec(String(out || ''));
  return m ? m[1] : null;
}

// Best-effort parse of `pac model genpage list` — pull each GUID and the surrounding label. The
// exact tabular format is pac-version-specific; this tolerantly maps guid -> name for name-matching.
function parseList(out) {
  const pages = [];
  for (const line of String(out || '').split('\n')) {
    const m = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(line);
    if (!m) continue;
    const name = line.replace(m[1], '').replace(/\s{2,}/g, ' ').trim();
    pages.push({ pageId: m[1], name: name || undefined });
  }
  return pages;
}

function makeGenpageCli(env, deps = {}) {
  const run = deps.run || runPac;
  const lastLine = (r) => String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  return {
    // Create (no pageId) or update (with pageId) a page's content. Returns { pageId }.
    async upload({ appId, pageId, codeFile, name, prompt, agentMessage, dataSources }) {
      const args = ['model', 'genpage', 'upload', '--environment', env, '--app-id', appId, '--code-file', codeFile];
      if (pageId) args.push('--page-id', pageId);
      if (name) args.push('--name', name);
      // pac requires BOTH --prompt and --agent-message for a new page.
      args.push('--prompt', prompt && String(prompt).trim() ? String(prompt) : `Generative page ${name || ''}`.trim());
      args.push('--agent-message', agentMessage && String(agentMessage).trim() ? String(agentMessage) : 'Authored by model-app-maker');
      if (dataSources && dataSources.length) args.push('--data-sources', dataSources.join(','));
      const r = await run(args);
      if (r.status !== 0) throw new Error(`pac genpage upload failed for '${name}': ${lastLine(r)}`);
      const id = parsePageId(r.stdout);
      if (!id) throw new Error(`pac genpage upload for '${name}' returned no Page ID: ${lastLine(r)}`);
      return { pageId: id };
    },
    // List the pages already in the app (parsed from its sitemap by pac). Returns [{ pageId, name }].
    async list({ appId }) {
      const r = await run(['model', 'genpage', 'list', '--environment', env, '--app-id', appId]);
      return r.status === 0 ? parseList(r.stdout) : [];
    },
  };
}

module.exports = { makeGenpageCli, parsePageId, parseList, runPac };
