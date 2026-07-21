#!/usr/bin/env node

/**
 * PostToolUse hook: forbid non-Ionicons icon imports in TS/TSX files.
 *
 * Fires after Write / Edit / MultiEdit. Reads the tool_input from stdin,
 * scans the resulting file content (or applied edit content) for forbidden
 * icon-library imports, and exits with code 2 + a corrective message on
 * stderr to block the call and force the agent to fix it.
 *
 * Allowed icon library: `@expo/vector-icons` (Ionicons family only).
 *
 * Forbidden imports (any of these triggers the block):
 *   - lucide-react-native
 *   - lucide-react
 *   - @tamagui/lucide-icons
 *   - react-native-vector-icons (any sub-path)
 *   - @expo/vector-icons families other than Ionicons
 *     (Feather, MaterialIcons, FontAwesome, FontAwesome5, AntDesign, Entypo,
 *      MaterialCommunityIcons, Octicons, Foundation, EvilIcons, Zocial, SimpleLineIcons,
 *      Fontisto)
 *
 * Exit codes:
 *   0 = pass (no forbidden imports, or not a TS/TSX file, or not a write tool)
 *   2 = block + show stderr to the model (Claude Code convention)
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_HINT =
  'Use ONLY `import { Ionicons } from "@expo/vector-icons"`. Ionicons has ~1300 icons; pick the closest name. Never switch icon libraries.';

// Each entry: { pattern: RegExp, label: string }
// Patterns match the import source (the string after `from`).
const FORBIDDEN_IMPORTS = [
  { pattern: /^lucide-react-native$/, label: 'lucide-react-native' },
  { pattern: /^lucide-react$/, label: 'lucide-react' },
  { pattern: /^@tamagui\/lucide-icons$/, label: '@tamagui/lucide-icons' },
  { pattern: /^react-native-vector-icons(\/.*)?$/, label: 'react-native-vector-icons' },
];

const FORBIDDEN_EXPO_FAMILIES = new Set([
  'Feather',
  'MaterialIcons',
  'MaterialCommunityIcons',
  'FontAwesome',
  'FontAwesome5',
  'FontAwesome6',
  'AntDesign',
  'Entypo',
  'Octicons',
  'Foundation',
  'EvilIcons',
  'Zocial',
  'SimpleLineIcons',
  'Fontisto',
]);

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string') return false;
  return /\.(tsx|ts|jsx|js)$/i.test(filePath);
}

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

/**
 * Extract content to scan from the tool_input.
 * - Write: tool_input.content
 * - Edit: tool_input.new_string
 * - MultiEdit: concat tool_input.edits[].new_string
 * Falls back to reading the file from disk if the tool already applied.
 */
function extractContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') {
    return toolInput.content;
  }
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') {
    return toolInput.new_string;
  }
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (e && typeof e.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }
  // Fallback: read from disk (tool has already executed in PostToolUse)
  const fp = toolInput.file_path || toolInput.filePath;
  if (typeof fp === 'string' && fs.existsSync(fp)) {
    try {
      return fs.readFileSync(fp, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Find all import sources in the content. Matches:
 *   import X from 'src'
 *   import { X } from "src"
 *   import * as X from 'src'
 *   import 'src'
 *   require('src')
 * Returns an array of { source, named: string[] } objects (named only for the
 * named-imports form, used to detect forbidden @expo/vector-icons families).
 */
function parseImports(content) {
  const results = [];

  // Named-imports form: import { A, B as C } from 'source'
  const namedRe = /import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = namedRe.exec(content)) !== null) {
    const named = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    results.push({ source: m[2], named });
  }

  // Default / namespace / side-effect form: import X from 'source' / import 'source'
  const otherRe = /import\s+(?:[\w*\s,{}]+\s+from\s+)?['"]([^'"]+)['"]/g;
  while ((m = otherRe.exec(content)) !== null) {
    if (!results.some((r) => r.source === m[1])) {
      results.push({ source: m[1], named: [] });
    }
  }

  // require('source')
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(content)) !== null) {
    if (!results.some((r) => r.source === m[1])) {
      results.push({ source: m[1], named: [] });
    }
  }

  return results;
}

function findViolations(content) {
  const imports = parseImports(content);
  const violations = [];

  for (const { source, named } of imports) {
    for (const { pattern, label } of FORBIDDEN_IMPORTS) {
      if (pattern.test(source)) {
        violations.push({
          source,
          reason: `Forbidden icon library: \`${label}\``,
        });
      }
    }

    if (source === '@expo/vector-icons') {
      const badFamilies = named.filter((n) => FORBIDDEN_EXPO_FAMILIES.has(n));
      for (const fam of badFamilies) {
        violations.push({
          source,
          reason: `Forbidden \`@expo/vector-icons\` family: \`${fam}\``,
        });
      }
    }
  }

  return violations;
}

function buildBlockMessage(filePath, violations) {
  const rel = path.relative(process.cwd(), filePath) || filePath;
  const lines = [];
  // User-facing summary — short, no jargon.
  lines.push(
    `[mobile-app] A screen used an icon library this plugin doesn't support. The write was blocked; Claude will switch to Ionicons and retry — no action needed from you.`
  );
  lines.push('');
  // Model-facing block from here on.
  lines.push(`For Claude: BLOCKED: forbidden icon imports in ${rel}`);
  lines.push('');
  for (const v of violations) {
    lines.push(`  - ${v.reason} (imported from "${v.source}")`);
  }
  lines.push('');
  lines.push(ALLOWED_HINT);
  lines.push('');
  lines.push('Required fix:');
  lines.push("  import { Ionicons } from '@expo/vector-icons';");
  lines.push('  // ...');
  lines.push('  <Ionicons name="add" size={20} color={theme.color12?.val} />');
  lines.push('');
  lines.push(
    'Re-issue the Write/Edit with the import + JSX corrected. Do NOT install or import any other icon package.'
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

  if (!isWriteTool(toolName)) {
    process.exit(0);
  }

  const filePath = toolInput.file_path || toolInput.filePath;
  if (!isWatchedFile(filePath)) {
    process.exit(0);
  }

  const content = extractContent(toolName, toolInput);
  if (!content) {
    process.exit(0);
  }

  const violations = findViolations(content);
  if (violations.length === 0) {
    process.exit(0);
  }

  process.stderr.write(buildBlockMessage(filePath, violations) + '\n');
  process.exit(2);
});
