#!/usr/bin/env node

/**
 * PreToolUse guardrail for Write / Edit / MultiEdit.
 *
 * Path safety — reject writes whose absolute path escapes the current working
 * directory. Stops a runaway sub-agent (for example a helper repairing a PCF
 * project) from clobbering ~/.bashrc, /etc/*, sibling repos, etc. The PCF
 * authoring flow works inside a project directory created under the cwd, so
 * every legitimate write stays under it.
 *
 * SCOPING (global-install safety): this plugin's hooks are installed globally, so
 * this guard must NOT constrain writes in unrelated projects. It therefore only
 * enforces during an active pcf authoring session — detected by a session
 * marker (`pcf-intent.json` or `pcf-plan.md`)
 * at or one level under the cwd. With no marker present the hook is a clean no-op
 * (exit 0), so a globally-installed pcf plugin never blocks ordinary
 * out-of-cwd writes.
 *
 * This intentionally does NOT scan content for secrets. Per repo convention,
 * secret handling is done via agent instructions in SKILL.md (no fixed regex can
 * cover every credential shape); this guard is strictly about write location.
 *
 * NON-BLOCKING by design = exit 1 (Claude Code shows the stderr message to the
 * USER and lets the write proceed; only exit 2 would block). We deliberately do
 * NOT hard-block: the skill may legitimately run from an unusual cwd or a temp
 * dir, so a false positive must never stop the user's write — it only flags a
 * possibly-runaway out-of-cwd write for the user to notice.
 *
 * Silence: set PCF_SKIP_WRITE_GUARD=1 (this guard) or
 * PCF_DISABLE_HOOKS=1 (all pcf hooks).
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const SKIP = process.env.PCF_SKIP_WRITE_GUARD === '1' || process.env.PCF_SKIP_WRITE_GUARD === 'true';

// Master kill-switch: PCF_DISABLE_HOOKS=1 disables every pcf hook
// (validators) — an operator escape hatch if a hook ever
// misbehaves. Checked before any stdin/work so it is a clean no-op (exit 0).
if (process.env.PCF_DISABLE_HOOKS === '1' || process.env.PCF_DISABLE_HOOKS === 'true') {
  process.exit(0);
}

const { readUtf8Stream } = require('../scripts/lib/utf8-stream.js');

function debug(msg) {
  if (DEBUG) process.stderr.write(`[write-safety] ${msg}\n`);
}

// Non-blocking warning. Exit 1 (not 2) so Claude Code shows this on stderr to the
// USER and still lets the write through — the guard flags, it does not block.
function warn(userMsg) {
  process.stderr.write(`[pcf] ${userMsg}\n`);
  process.exit(1);
}

/**
 * The cwd is the project root for any skill invocation. Any Write/Edit must stay
 * under it. Exceptions: $TMPDIR scratch and the host's own ~/.claude/ state dir
 * (EnterPlanMode persists plan files there before the orchestrator sees them —
 * blocking those would break plan-mode UX).
 */
function isWithin(child, parent) {
  // Windows paths are case-insensitive, so compare case-folded there — otherwise a
  // target that differs only by drive-letter/segment casing (e.g. `d:\proj\x` vs a
  // `D:\proj\x` cwd) is wrongly rejected. The `path.sep` boundary stops `/foobar`
  // from matching a `/foo` parent. (Symlink/junction escape is NOT resolved here:
  // realpath needs the target to exist, but PreToolUse fires before the write; a
  // lexical check matches the mobile-apps/power-pages guardrails.)
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p + path.sep);
}

function isPathSafe(targetPath, cwd) {
  if (!targetPath || typeof targetPath !== 'string') return true; // not our concern
  const abs = path.resolve(cwd, targetPath);

  if (isWithin(abs, path.resolve(cwd))) return true;
  if (isWithin(abs, path.resolve(os.tmpdir()))) return true;

  const home = os.homedir();
  if (home && isWithin(abs, path.resolve(home, '.claude'))) return true;

  return false;
}

/**
 * True when the cwd looks like an active pcf authoring run: a session marker
 * file sits at the cwd or in one of its immediate child directories. The skill
 * creates its working directory as a direct child of cwd and writes a marker
 * into it, so the marker is at either `<cwd>/<marker>` (host started inside the
 * working dir) or `<cwd>/<workdir>/<marker>` (host started at the project root):
 *   - pcf -> pcf-intent.json / pcf-plan.md
 *
 * Shallow, bounded, and
 * fail-open: any error → false (treat as "not a pcf session" and do NOT warn),
 * because a hook must never interfere with unrelated work.
 */
const SESSION_MARKERS = ['pcf-intent.json', 'pcf-plan.md'];

function isPcfSession(cwd) {
  try {
    if (SESSION_MARKERS.some((m) => fs.existsSync(path.join(cwd, m)))) return true;
    let scanned = 0;
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
      if (++scanned > 1000) break; // bound syscalls on very large project roots
      if (SESSION_MARKERS.some((m) => fs.existsSync(path.join(cwd, entry.name, m)))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Extract the target path(s) from a tool_input regardless of Write/Edit/MultiEdit
 * shape. All three carry a single `file_path`; MultiEdit's per-edit entries share it.
 */
function extractWritePaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const fp = toolInput.file_path || toolInput.filePath;
  if (typeof fp === 'string' && fp) return [fp];
  return [];
}

readUtf8Stream(process.stdin).then((inputData) => {
  if (SKIP) {
    debug('PCF_SKIP_WRITE_GUARD=1 — bypassing');
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(inputData);
  } catch (err) {
    debug(`stdin parse failed: ${err.message}`);
    process.exit(0); // never block on hook-side bugs
  }

  const toolName = input.tool_name || input.toolName || '';
  const toolInput = input.tool_input || input.toolInput || {};
  const cwd = input.cwd || process.cwd();

  if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    process.exit(0);
  }

  // Global-install safety: only enforce during an active pcf authoring session,
  // so a globally-installed pcf plugin never blocks writes in unrelated projects.
  if (!isPcfSession(cwd)) {
    debug('no pcf-intent.json / pcf-plan.md at/under cwd — not a pcf session, allowing');
    process.exit(0);
  }

  for (const p of extractWritePaths(toolName, toolInput)) {
    if (!isPathSafe(p, cwd)) {
      warn(
        `Heads up: a pcf ${toolName} targeted "${p}", which is outside your project folder ` +
        `(${cwd}). Allowing it, but flagging in case a sub-agent went off-track. ` +
        `Silence with PCF_SKIP_WRITE_GUARD=1 or PCF_DISABLE_HOOKS=1.`
      );
    }
  }

  debug(`OK ${toolName} ${extractWritePaths(toolName, toolInput).join(',')}`);
  process.exit(0);
}).catch((err) => {
  debug(`stdin read failed: ${err.message}`);
  process.exit(0);
});
