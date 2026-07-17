#!/usr/bin/env node

/**
 * PreToolUse guardrail for Write / Edit / MultiEdit.
 *
 * Path safety — reject writes whose absolute path escapes the current working
 * directory. Stops a runaway sub-agent (e.g. a parallel genpage page-builder)
 * from clobbering ~/.bashrc, /etc/*, sibling repos, etc. genpage always works
 * inside a working directory created under the cwd (SKILL Phase 0), so every
 * legitimate write stays under it.
 *
 * This intentionally does NOT scan content for secrets. Per repo convention,
 * secret handling is done via agent instructions in SKILL.md (no fixed regex can
 * cover every credential shape); this guard is strictly about write location.
 *
 * Hard-fail = exit 2 (blocks the tool call; the message on stderr goes to the
 * model, which reissues the write to a safe path). Conservative on purpose: a
 * false positive is recoverable (the model sees the reason and retries); a
 * runaway cross-repo write is not.
 *
 * Bypass: set MODEL_APPS_SKIP_WRITE_GUARD=1. Use sparingly — usually means the
 * guard itself needs adjusting.
 */

const path = require('path');
const os = require('os');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const SKIP = process.env.MODEL_APPS_SKIP_WRITE_GUARD === '1' || process.env.MODEL_APPS_SKIP_WRITE_GUARD === 'true';

// Master kill-switch: MODEL_APPS_DISABLE_HOOKS=1 disables every model-apps hook
// (validators + telemetry emit) — an operator escape hatch if a hook ever
// misbehaves. Checked before any stdin/work so it is a clean no-op (exit 0).
if (process.env.MODEL_APPS_DISABLE_HOOKS === '1' || process.env.MODEL_APPS_DISABLE_HOOKS === 'true') {
  process.exit(0);
}

function debug(msg) {
  if (DEBUG) process.stderr.write(`[write-safety] ${msg}\n`);
}

function reject(userMsg, modelMsg) {
  // First block: user-facing summary in plain English.
  process.stderr.write(`[model-apps] ${userMsg} The agent will revise and retry — no action needed from you.\n\n`);
  // Second block: prescriptive instruction for the model.
  process.stderr.write(`For the agent: ${modelMsg}\n`);
  process.exit(2);
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
 * Extract the target path(s) from a tool_input regardless of Write/Edit/MultiEdit
 * shape. All three carry a single `file_path`; MultiEdit's per-edit entries share it.
 */
function extractWritePaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const fp = toolInput.file_path || toolInput.filePath;
  if (typeof fp === 'string' && fp) return [fp];
  return [];
}

let inputData = '';
process.stdin.on('data', (c) => { inputData += c; });
process.stdin.on('end', () => {
  if (SKIP) {
    debug('MODEL_APPS_SKIP_WRITE_GUARD=1 — bypassing');
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

  for (const p of extractWritePaths(toolName, toolInput)) {
    if (!isPathSafe(p, cwd)) {
      reject(
        `A skill tried to write outside your project folder (${path.basename(cwd)}). The write was blocked for safety.`,
        `${toolName} target "${p}" is outside the project root (${cwd}). ` +
        `Skills must not write outside their working directory. ` +
        `Re-issue the write to a path under the project root, or ask the user to run from the correct cwd. ` +
        `If this is genuinely intentional, set MODEL_APPS_SKIP_WRITE_GUARD=1 (not recommended).`
      );
    }
  }

  debug(`OK ${toolName} ${extractWritePaths(toolName, toolInput).join(',')}`);
  process.exit(0);
});
