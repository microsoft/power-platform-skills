#!/usr/bin/env node

/**
 * PostToolUse hook: validate @fluentui/react-icons imports against the plugin's
 * verified icon allowlist. Automates the manual "Grep each icon name against
 * verified-icons.txt" step that genpage-page-builder does by hand
 * (agents/genpage-page-builder.md Step 2.5), so a hallucinated or wrong-variant
 * icon name is caught deterministically at write time instead of only when the
 * deployed page throws "X is not exported from @fluentui/react-icons" at runtime.
 *
 * Fires after Write / Edit / MultiEdit on TS/JS(X) files. Exit codes:
 *   0 = pass / not applicable (fail-OPEN — any doubt or internal error → allow)
 *   2 = block + corrective message on stderr (Claude Code convention)
 *
 * SCOPING — why this does not fire on every React file in the repo:
 * The verified list is an ALLOWLIST (must-be-in-list), not a denylist. Running an
 * allowlist check on arbitrary .tsx files would false-positive on any legitimate
 * Fluent icon this plugin's snapshot doesn't know about. So we only validate files
 * that are genpage output: the final file contains `export default GeneratedComponent`
 * (every genpage page ends with it — see references/rules.md), OR a sibling
 * `genpage-plan.md` sits in the same directory (the genpage working dir). Any other
 * file is ignored.
 *
 * The icons list (references/verified-icons.txt) is the same source page-builder
 * greps; it holds ~5000 UNSIZED names (Regular/Filled variants only), one per line,
 * with `#` comment lines. Because it is unsized-only, a sized import like
 * `Add24Regular` is naturally rejected too — matching the "unsized variants only"
 * rule (references/rules.md).
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VERIFIED_ICONS_PATH = path.join(PLUGIN_ROOT, 'references', 'verified-icons.txt');
const ICON_MODULE = '@fluentui/react-icons';

// Master kill-switch: MODEL_APPS_DISABLE_HOOKS=1 disables every model-apps hook
// (validators + telemetry emit) — an operator escape hatch if a hook ever
// misbehaves. Checked before any stdin/work so it is a clean no-op (exit 0).
if (process.env.MODEL_APPS_DISABLE_HOOKS === '1' || process.env.MODEL_APPS_DISABLE_HOOKS === 'true') {
  process.exit(0);
}

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function isWatchedFile(filePath) {
  return typeof filePath === 'string' && /\.(tsx|ts|jsx|js)$/i.test(filePath);
}

/**
 * In PostToolUse the file is already on disk, so the on-disk content is the
 * authoritative final state (catches imports added by an Edit that only touched a
 * fragment). Fall back to the tool_input content only if the read fails.
 */
function readFinalContent(toolName, toolInput, absPath) {
  if (absPath) {
    try {
      return fs.readFileSync(absPath, 'utf8');
    } catch {
      // fall through to tool_input
    }
  }
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (e && typeof e.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }
  return '';
}

function isGenpageFile(content, absPath) {
  // The canonical generated-page default export is `export default GeneratedComponent;`
  // (references/rules.md) — emitted by BOTH /genpage and /app-builder's generate-pages
  // phase, which reuses the same page-builder contract. Accept the inline
  // `function`/`class` forms too. The sibling marker check below is the primary,
  // reliable gate for real runs (the working dir always has one); this content marker
  // is a fallback for files written outside a recognized working dir.
  if (/export\s+default\s+(?:function\s+|class\s+)?GeneratedComponent\b/.test(content)) return true;
  if (absPath) {
    try {
      // A generated page always sits in an authoring working dir: genpage writes
      // genpage-plan.md; app-builder writes app-spec.json + model-app-plan.md.
      const dir = path.dirname(absPath);
      return ['genpage-plan.md', 'app-spec.json', 'model-app-plan.md']
        .some((marker) => fs.existsSync(path.join(dir, marker)));
    } catch {
      return false;
    }
  }
  return false;
}

function loadVerifiedIcons() {
  // Returns a Set of verified names, or null if the list can't be read (→ fail open).
  try {
    const raw = fs.readFileSync(VERIFIED_ICONS_PATH, 'utf8');
    const set = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const name = line.trim();
      if (!name || name.startsWith('#')) continue; // skip header/comment/blank lines
      set.add(name);
    }
    return set.size > 0 ? set : null;
  } catch {
    return null;
  }
}

/**
 * Extract the named specifiers imported from `@fluentui/react-icons`.
 * Handles: `import { A, B as C } from '@fluentui/react-icons'` and the
 * `import type { ... }` form. Only the local-source name before `as` matters —
 * that's the icon export being referenced.
 *
 * Only real, top-level import statements are matched: `/* ... *\/` block comments
 * are stripped first, and the pattern is anchored to the start of a line so a
 * commented-out example (`// import { Foo } from '@fluentui/react-icons'`) or an
 * indented occurrence inside prose is ignored. This is fail-open: if stripping
 * ever drops a genuine import, we under-report (miss a bad icon) rather than
 * wrongly block a legitimate write.
 *
 * Example matched block:
 *   import { AddRegular, DeleteRegular as Trash } from "@fluentui/react-icons";
 *   → ["AddRegular", "DeleteRegular"]
 */
function extractIconImports(content) {
  const names = [];
  // Strip comments before matching so a comment inside a multi-line import block
  // can't defeat validation two ways: (a) a `//` line leaves the next specifier
  // starting with `//…` so it fails the identifier test and is silently skipped,
  // and (b) a `}` inside a `//` comment prematurely ends the `[^}]+` capture and
  // the whole import fails to match — both fail OPEN (a bad icon slips through).
  // The `(?<!:)` lookbehind on the line-comment strip preserves `https://` URLs.
  const code = content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<!:)\/\/[^\n]*/g, '');
  const escapedModule = ICON_MODULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    "^[ \\t]*import\\s+(?:type\\s+)?\\{([^}]+)\\}\\s*from\\s*['\"]" + escapedModule + "['\"]",
    'gm'
  );
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const raw of m[1].split(',')) {
      const spec = raw.trim();
      if (!spec) continue;
      const local = spec.split(/\s+as\s+/)[0].trim();
      // Skip anything that isn't a bare identifier (defensive against odd syntax).
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
    }
  }
  return names;
}

function buildBlockMessage(relPath, invalid) {
  const lines = [];
  // User-facing summary — short, no jargon. States what happened (a block); the
  // auto-fix only occurs when an agent is driving, so it is phrased as a
  // conditional expectation — a user editing manually gets an actionable note
  // rather than a promise the hook can't keep.
  lines.push(
    `[model-apps] The write was blocked: it imported ${invalid.length} icon name(s) that aren't in the verified @fluentui/react-icons list (listed below). If an agent is generating this page, it will switch to verified icons and retry. If you're editing by hand, replace them with verified names from references/verified-icons.txt.`
  );
  lines.push('');
  // Model-facing block.
  lines.push(`For the agent: BLOCKED — unverified @fluentui/react-icons imports in ${relPath}:`);
  for (const name of invalid) {
    lines.push(`  - ${name}`);
  }
  lines.push('');
  lines.push(
    'Every icon imported from "@fluentui/react-icons" must be an UNSIZED name that exists verbatim in ' +
      'references/verified-icons.txt (e.g. `AddRegular`, `DeleteFilled`) — never a sized variant like ' +
      '`Add24Regular`, and never a guessed name. Grep the closest verified name ' +
      '(`Grep pattern: "^<IconName>$" path: references/verified-icons.txt`), replace each invalid ' +
      'import + its JSX usage, and re-issue the Write/Edit. Do not import icons from any other library.'
  );
  return lines.join('\n');
}

let inputData = '';
process.stdin.on('data', (chunk) => {
  inputData += chunk;
});
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(inputData || '{}');
  } catch {
    process.exit(0); // can't parse → don't block
  }

  const toolName = input.tool_name || input.toolName;
  const toolInput = input.tool_input || input.toolInput || {};
  if (!isWriteTool(toolName)) process.exit(0);

  const filePath = toolInput.file_path || toolInput.filePath;
  if (!isWatchedFile(filePath)) process.exit(0);

  const cwd = input.cwd || process.cwd();
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

  const content = readFinalContent(toolName, toolInput, absPath);
  if (!content) process.exit(0);

  // Only validate genpage-generated pages (see SCOPING note above).
  if (!isGenpageFile(content, absPath)) process.exit(0);

  const imported = extractIconImports(content);
  if (imported.length === 0) process.exit(0);

  const verified = loadVerifiedIcons();
  if (!verified) process.exit(0); // can't load the allowlist → fail open

  // De-dupe while preserving order for a stable message.
  const seen = new Set();
  const invalid = [];
  for (const name of imported) {
    if (verified.has(name) || seen.has(name)) continue;
    seen.add(name);
    invalid.push(name);
  }
  if (invalid.length === 0) process.exit(0);

  const relPath = path.relative(cwd, absPath) || absPath;
  process.stderr.write(buildBlockMessage(relPath, invalid) + '\n');
  process.exit(2);
});
