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
const { blankNonCodePreservingTemplateExpressions, commentRanges } = require('../scripts/lib/source-literals.js');

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
  // `function`/`class` forms too. This content marker is the PRIMARY gate for
  // app-builder pages; the sibling-marker check below is a fallback for files written
  // outside a recognized working dir.
  if (/export\s+default\s+(?:function\s+|class\s+)?GeneratedComponent\b/.test(content)) return true;
  if (absPath) {
    try {
      // Sibling working-dir markers. These are deliberately PLUGIN-SPECIFIC filenames:
      // this hook BLOCKS the write (exit 2) and the plugin installs globally, so a
      // generic name would false-positive and block a legitimate write in an unrelated
      // repo. app-builder's `app-spec.json` is intentionally NOT listed for that reason
      // (it is common enough to collide) — its generated pages always carry the
      // `export default GeneratedComponent` marker above, so nothing is lost. The
      // non-blocking write-safety guard does accept app-spec.json, since a false
      // positive there only prints a warning.
      const dir = path.dirname(absPath);
      return ['genpage-plan.md', 'model-app-plan.md']
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
  //
  // And only an `import` in CODE counts, as in extractUnsupportedIconImports: an import line quoted in a
  // help template or a string is data, and blocking a write over it broke that contract. So the match runs
  // on a copy with every comment the lexer finds blanked to spaces — offsets kept, so the code mask lines up
  // (and a `//` inside a string is no comment) — and a match whose `import` is not code is skipped. Should
  // the lexer throw, the older comment-stripped match runs instead, which treats every such line as real.
  let codeMask = null;
  let code = null;
  try {
    codeMask = blankNonCodePreservingTemplateExpressions(content);
    code = blankComments(content);
  } catch { codeMask = null; }
  // The `(?<!:)` lookbehind on the fallback's line-comment strip preserves `https://` URLs.
  if (!codeMask) code = stripCommentsForImports(content);
  const escapedModule = ICON_MODULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    "(?<![\\w$.])import\\s+(?:type\\s+)?(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]+)\\}\\s*from\\s*['\"]" + escapedModule + "['\"]",
    'g'
  );
  let m;
  while ((m = re.exec(code)) !== null) {
    if (codeMask && !codeMask.startsWith('import', code.indexOf('import', m.index))) continue;
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

function stripCommentsForImports(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<!:)\/\/[^\n]*/g, '');
}

// `content` with each comment the lexer finds turned into spaces, newlines kept, so every offset is
// unchanged. Unlike stripCommentsForImports, a `//` inside a string or JSX text is left alone.
function blankComments(content) {
  const out = content.split('');
  for (const { start, end } of commentRanges(content)) {
    for (let k = start; k < end; k += 1) if (out[k] !== '\n') out[k] = ' ';
  }
  return out.join('');
}

/**
 * Detect @fluentui/react-icons import shapes this hook cannot verify safely.
 *
 * Raw forms that bypass named-specifier validation:
 *   import * as Icons from "@fluentui/react-icons";
 *   import Icons from "@fluentui/react-icons";
 *   const Icons = require("@fluentui/react-icons");
 *
 * Rejecting them is intentionally safer than parsing every namespace member access in TSX:
 * the verified-icons.txt source of truth lists named exports, and named imports make the exact
 * export names visible at the import boundary where this dependency-free hook can validate them.
 */
function extractUnsupportedIconImports(content) {
  const escapedModule = ICON_MODULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unsupported = [];
  // The require and dynamic-import forms are matched ANYWHERE in the code, not only as a declaration:
  //   React.createElement(require("@fluentui/react-icons").TotallyMadeUpIconRegular)
  //   const Icons = await import("@fluentui/react-icons");
  // both reach an icon by member access, which no named-specifier check ever sees.
  const patterns = [
    // Static imports need code-token boundaries, not line starts: generated files often put
    // `import React ...; import * as Icons ...` on one line. Combined clauses are unsupported too
    // (`import DefaultIcon, * as Icons ...`, `import DefaultIcon, { AddRegular } ...`) because the
    // default/namespace binding can still reach unchecked member names even when named imports exist.
    { kind: 'namespace import', keyword: 'import', re: new RegExp("(?<![\\w$.])import\\s+(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\*\\s+as\\s+[A-Za-z_$][\\w$]*\\s+from\\s*['\"]" + escapedModule + "['\"]", 'g') },
    { kind: 'default import', keyword: 'import', re: new RegExp("(?<![\\w$.])import\\s+[A-Za-z_$][\\w$]*(?:\\s*,\\s*(?:\\{[^}]*\\}|\\*\\s+as\\s+[A-Za-z_$][\\w$]*))?\\s+from\\s*['\"]" + escapedModule + "['\"]", 'g') },
    // Loader forms are blocked as soon as the first argument is the icon module; a trailing comma or
    // dynamic-import options object still loads the same unchecked namespace.
    { kind: 'CommonJS require', keyword: 'require', re: new RegExp("\\brequire\\s*\\(\\s*['\"`]" + escapedModule + "['\"`]", 'g') },
    { kind: 'dynamic import()', keyword: 'import', re: new RegExp("\\bimport\\s*\\(\\s*['\"`]" + escapedModule + "['\"`]", 'g') },
  ];
  // Only a keyword in CODE is an import. The plugin's TSX lexer blanks comments, strings, template
  // text and JSX text but keeps code inside `${…}`, so an import merely quoted in a help string, a
  // template or a comment does not block a write. The patterns run on a copy with every comment
  // turned into spaces of the same length: a comment BETWEEN an import's tokens —
  //   import * as /* every icon */ Icons from "@fluentui/react-icons";
  //   import Icons // all of them
  //     from "@fluentui/react-icons";
  // — must not break the match, and the offsets must still line up with the code mask. Should the
  // lexer ever throw, fall back to the older comment-stripped match: a write wrongly blocked is
  // better than an unverified icon let through.
  let codeMask = null;
  let haystack = null;
  try {
    codeMask = blankNonCodePreservingTemplateExpressions(content);
    haystack = blankComments(content);
  } catch { codeMask = null; }
  if (!codeMask) haystack = stripCommentsForImports(content);
  for (const { kind, keyword, re } of patterns) {
    for (const m of haystack.matchAll(re)) {
      const at = haystack.indexOf(keyword, m.index);
      if (!codeMask || codeMask.startsWith(keyword, at)) { unsupported.push(kind); break; }
    }
  }
  return unsupported;
}

function buildUnsupportedImportMessage(relPath, unsupported) {
  const unique = [...new Set(unsupported)];
  return [
    `[model-apps] The write was blocked: ${ICON_MODULE} must use named imports so each icon export can be checked against references/verified-icons.txt.`,
    '',
    `For the agent: BLOCKED — unsupported ${ICON_MODULE} import form(s) in ${relPath}:`,
    ...unique.map((kind) => `  - ${kind}`),
    '',
    'Rewrite the import as named unsized exports, for example `import { AddRegular } from "@fluentui/react-icons";`, then verify every imported name exists verbatim in references/verified-icons.txt.',
  ].join('\n');
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

  const relPath = path.relative(cwd, absPath) || absPath;
  const unsupported = extractUnsupportedIconImports(content);
  if (unsupported.length > 0) {
    process.stderr.write(buildUnsupportedImportMessage(relPath, unsupported) + '\n');
    process.exit(2);
  }

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

  process.stderr.write(buildBlockMessage(relPath, invalid) + '\n');
  process.exit(2);
});
