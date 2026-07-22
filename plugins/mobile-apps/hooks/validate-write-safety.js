#!/usr/bin/env node

/**
 * PreToolUse guardrail for Write / Edit / MultiEdit.
 *
 * Two checks, both hard-fail (exit 2 = block tool call, message goes to model):
 *
 *   1. Path safety — reject writes whose absolute path escapes the current
 *      working directory. Stops a runaway sub-agent from clobbering ~/.bashrc,
 *      /etc/*, sibling repos, etc. AGENTS.md rule #4 mentioned this; nothing
 *      enforced it.
 *
 *   2. Secrets sanitizer — reject writes whose content contains likely
 *      secrets (client_secret, password, bearer tokens, AAD GUIDs paired with
 *      the words "tenant"/"client"/"secret"). Targets the planner accidentally
 *      pasting connection strings into memory-bank.md or native-app-plan.md.
 *
 * Both checks are conservative — they err on the side of blocking. False
 * positives are recoverable (the model sees the rejection reason and can
 * reword); silent secret leakage is not.
 *
 * Bypass: set CODE_APPS_NATIVE_SKIP_WRITE_GUARD=1 in the environment. Use
 * sparingly — usually means the guardrail itself needs adjusting.
 */

const path = require('path');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const SKIP = process.env.CODE_APPS_NATIVE_SKIP_WRITE_GUARD === '1';

function debug(msg) {
  if (DEBUG) process.stderr.write(`[write-safety] ${msg}\n`);
}

function reject(userMsg, modelMsg) {
  // First block: user-facing summary in plain English. Short, no jargon.
  process.stderr.write(`[mobile-app] ${userMsg} Claude will revise and retry — no action needed from you.\n\n`);
  // Second block: prescriptive instruction for Claude. Kept verbose on purpose.
  process.stderr.write(`For Claude: ${modelMsg}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Secret patterns. Tuned to fire on real keys, not on the literal *word*
// "password" in prose. Each pattern matches a key=value or "key": "value"
// shape with a non-trivial value.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  // client_secret: "abc123..." or client_secret=abc123
  { name: 'client_secret', re: /client[_-]?secret['"\s:=]+['"]?[A-Za-z0-9_~.\-]{16,}/i },
  // password: "..."   (skip placeholders like "<your-password>", "***", "TODO")
  { name: 'password', re: /password['"\s:=]+['"][^<*A-Z\s][^"\n]{7,}['"]/i },
  // Bearer eyJ... (JWT) or Bearer <40+ chars>
  { name: 'bearer_token', re: /bearer\s+[A-Za-z0-9_\-.=]{20,}/i },
  // AKIA... AWS key, ghp_... GitHub token, sk-... OpenAI key
  { name: 'access_key', re: /\b(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})\b/ },
  // ConnectionString=... with AccountKey or SharedAccessKey
  { name: 'connection_string', re: /(AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{20,}/ },
  // tenant + GUID + client + GUID + secret pattern in close proximity
  { name: 'aad_credentials', re: /tenant[_-]?id[^\n]{0,80}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\s\S]{0,200}client[_-]?secret/i },
];

function scanForSecrets(content) {
  if (!content || typeof content !== 'string') return null;
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path safety. The cwd is the project root for any skill invocation. Any
// Write/Edit must stay under it.
//
// Exception: PostToolUse-style scratch files under $TMPDIR are allowed —
// the scaffold step uses `mktemp -d` for the GHE clone.
// ---------------------------------------------------------------------------
function isPathSafe(targetPath, cwd) {
  if (!targetPath || typeof targetPath !== 'string') return true; // not our concern
  const abs = path.resolve(cwd, targetPath);
  const normalizedCwd = path.resolve(cwd);

  if (abs === normalizedCwd) return true;
  if (abs.startsWith(normalizedCwd + path.sep)) return true;

  // Allow tmpdir scratch
  const tmp = require('os').tmpdir();
  if (abs.startsWith(path.resolve(tmp) + path.sep)) return true;

  // Allow Claude Code's own state dir (~/.claude/). EnterPlanMode persists
  // its plan file under ~/.claude/plans/<random>.md before the orchestrator
  // ever sees it; that is a host-owned path, not a skill-initiated write.
  // Blocking it forces the orchestrator to drop plan-mode UX entirely. Allow.
  const home = require('os').homedir();
  if (home && abs.startsWith(path.resolve(home, '.claude') + path.sep)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Extract { paths[], contents[] } from a tool_input regardless of whether the
// caller used Write, Edit, or MultiEdit shape.
// ---------------------------------------------------------------------------
function extractWriteTargets(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return { paths: [], contents: [] };

  const paths = [];
  const contents = [];

  if (toolName === 'Write') {
    if (toolInput.file_path) paths.push(toolInput.file_path);
    if (typeof toolInput.content === 'string') contents.push(toolInput.content);
  } else if (toolName === 'Edit') {
    if (toolInput.file_path) paths.push(toolInput.file_path);
    if (typeof toolInput.new_string === 'string') contents.push(toolInput.new_string);
  } else if (toolName === 'MultiEdit') {
    if (toolInput.file_path) paths.push(toolInput.file_path);
    if (Array.isArray(toolInput.edits)) {
      for (const e of toolInput.edits) {
        if (typeof e?.new_string === 'string') contents.push(e.new_string);
      }
    }
  }

  return { paths, contents };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let inputData = '';
process.stdin.on('data', (c) => { inputData += c; });
process.stdin.on('end', () => {
  if (SKIP) {
    debug('CODE_APPS_NATIVE_SKIP_WRITE_GUARD=1 — bypassing');
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

  const { paths, contents } = extractWriteTargets(toolName, toolInput);

  for (const p of paths) {
    if (!isPathSafe(p, cwd)) {
      reject(
        `A skill tried to write outside your project folder (${path.basename(cwd)}). The write was blocked for safety.`,
        `${toolName} target "${p}" is outside the project root (${cwd}). ` +
        `Skills must not write outside their working directory. ` +
        `If this is intentional, ask the user to run the command from the correct cwd, ` +
        `or set CODE_APPS_NATIVE_SKIP_WRITE_GUARD=1 (not recommended).`
      );
    }
  }

  for (const c of contents) {
    const hit = scanForSecrets(c);
    if (hit) {
      reject(
        `A skill almost wrote what looks like a secret (${hit}) into a project file. The write was blocked.`,
        `${toolName} content matches the "${hit}" secret pattern. ` +
        `Never write credentials, tokens, or connection strings into project files ` +
        `(memory-bank.md, native-app-plan.md, source code, etc.). ` +
        `Use placeholders like "<your-client-secret>" and instruct the user to set ` +
        `the real value in their environment or .env file.`
      );
    }
  }

  debug(`OK ${toolName} ${paths.join(',')}`);
  process.exit(0);
});
