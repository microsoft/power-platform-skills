'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSIONS = new Set([
  '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx', '.vue', '.astro', '.html',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.git', 'dist', 'build', 'node_modules', '.output', 'coverage',
]);
const PHYSICAL_DIRECTIVE_RE =
  /bidi-physical:\s*(\S(?:.*\S)?)\s*;\s*verify=ltr,rtl\s*(?:\*\/)?\s*$/i;
const BLOCKING_PROPERTY_RE =
  /(?:^|[;{,"'])\s*['"]?(?:(?:margin|padding|border)-(?:left|right)(?:-(?:color|style|width))?|border-(?:top|bottom)-(?:left|right)-radius)['"]?\s*:/gi;
const BLOCKING_STYLE_OBJECT_PROPERTY_RE =
  /(?:^|[,{])\s*['"]?(?:(?:margin|padding|border)(?:Left|Right)(?:Color|Style|Width)?|border(?:Top|Bottom)(?:Left|Right)Radius)['"]?\s*:/g;
const BLOCKING_ALIGNMENT_RE =
  /(?:^|[;{,"'])\s*['"]?(?:text-align|textAlign|float|clear)['"]?\s*:\s*['"]?(?:left|right)['"]?\s*(?:[;,!}]|$)/gi;
const REVIEW_PROPERTY_RE = /(?:^|[;{,"'])\s*['"]?(?:left|right)['"]?\s*:/gi;
const VISUAL_ORDER_RE =
  /\b(?:flex-direction\s*:\s*(?:row|column)-reverse|order\s*:\s*-?\d+)/i;
const GEOMETRY_RE =
  /\b(?:translateX|transform-origin|linear-gradient\s*\([^)]*(?:left|right)|clip-path|mask(?:-image)?\s*:)/i;
const FIXED_TEXT_SIZE_RE =
  /^\s*(?:height|width|inline-size|block-size)\s*:\s*\d+(?:\.\d+)?(?:px|rem|em)\s*;/i;
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function collectSourceFiles(projectRoot) {
  const roots = ['src', 'public'].map((name) => path.join(projectRoot, name));
  for (const entry of ['index.html']) {
    const candidate = path.join(projectRoot, entry);
    if (fs.existsSync(candidate)) roots.push(candidate);
  }
  const files = [];
  for (const root of roots) walk(root, files);
  return files;
}

function walk(target, files) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SOURCE_EXTENSIONS.has(path.extname(target).toLowerCase())) files.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    walk(path.join(target, entry.name), files);
  }
}

function auditBidirectionalReadiness(projectRoot) {
  const findings = [];
  for (const filePath of collectSourceFiles(projectRoot)) {
    const relativePath = path.relative(projectRoot, filePath).replaceAll('\\', '/');
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    let pendingDirective = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const directiveMatch = trimmed.match(PHYSICAL_DIRECTIVE_RE);
      if (directiveMatch) {
        const reason = directiveMatch[1].trim();
        if (reason.length < 12 || /^(?:needed|intentional|required|exception)$/i.test(reason)) {
          findings.push(finding(
            relativePath,
            index + 1,
            'invalid-physical-exception',
            'error',
            'A bidi-physical directive requires a specific reason of at least 12 characters.'
          ));
          continue;
        }
        pendingDirective = {
          line: index + 1,
          reason,
        };
        continue;
      }
      if (/bidi-physical:/i.test(trimmed)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'invalid-physical-exception',
          'error',
          'Use "bidi-physical: <specific reason>; verify=ltr,rtl" immediately before one declaration.'
        ));
        continue;
      }

      if (!trimmed || trimmed.startsWith('//') ||
          (trimmed.startsWith('/*') && trimmed.endsWith('*/'))) {
        if (pendingDirective && !trimmed) {
          findings.push(finding(
            relativePath,
            pendingDirective.line,
            'unused-physical-exception',
            'error',
            'A bidi-physical directive must be adjacent to the declaration it exempts.'
          ));
          pendingDirective = null;
        }
        if (BIDI_CONTROL_RE.test(line)) {
          findings.push(unexpectedBidiControl(relativePath, index + 1));
        }
        continue;
      }

      const physicalMatches = collectPhysicalMatches(line);
      if (pendingDirective) {
        if (physicalMatches.length > 0) {
          // An exception is deliberately declaration-scoped. Minified CSS can
          // contain several declarations on one line, so consume exactly one
          // in source order instead of allowing it to hide the entire line or
          // a later, more severe declaration.
          physicalMatches.shift();
          pendingDirective = null;
        } else {
          findings.push(finding(
            relativePath,
            pendingDirective.line,
            'unused-physical-exception',
            'error',
            'A bidi-physical directive may exempt only the immediately following physical declaration.'
          ));
          pendingDirective = null;
        }
      }
      for (const physicalMatch of physicalMatches) {
        if (physicalMatch.severity === 'error') {
          findings.push(finding(
            relativePath,
            index + 1,
            'directional-physical-css',
            'error',
            `Use a logical CSS property, or add an adjacent validated bidi-physical exception: ${trimmed}`
          ));
        } else {
          findings.push(finding(
            relativePath,
            index + 1,
            'physical-inset-review',
            'review',
            `Confirm whether this is intentionally physical or should use an inline inset: ${trimmed}`
          ));
        }
      }

      if (VISUAL_ORDER_RE.test(line)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'visual-order-review',
          'review',
          'Confirm visual reversal does not diverge from DOM reading and focus order.'
        ));
      }
      if (GEOMETRY_RE.test(line)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'directional-geometry-review',
          'review',
          'Review this physical geometry, animation, gradient, clipping, or mask in both directions.'
        ));
      }
      if (FIXED_TEXT_SIZE_RE.test(line)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'fixed-content-size-review',
          'review',
          'Confirm translatable content can expand and wrap without clipping.'
        ));
      }
      if (BIDI_CONTROL_RE.test(line)) {
        findings.push(unexpectedBidiControl(relativePath, index + 1));
      }
    }

    if (pendingDirective) {
      findings.push(finding(
        relativePath,
        pendingDirective.line,
        'unused-physical-exception',
        'error',
        'A bidi-physical directive must be followed by a physical declaration.'
      ));
    }
  }

  return {
    projectRoot,
    summary: summarizeFindings(findings),
    findings,
  };
}

function finding(file, line, rule, severity, message) {
  return { file, line, rule, severity, message };
}

function collectPhysicalMatches(value) {
  const matches = [];
  for (const pattern of [
    BLOCKING_PROPERTY_RE,
    BLOCKING_STYLE_OBJECT_PROPERTY_RE,
    BLOCKING_ALIGNMENT_RE,
  ]) {
    for (const match of value.matchAll(pattern)) {
      matches.push({ index: match.index, severity: 'error' });
    }
  }
  for (const match of value.matchAll(REVIEW_PROPERTY_RE)) {
    matches.push({ index: match.index, severity: 'review' });
  }
  return matches.sort((left, right) => left.index - right.index);
}

function unexpectedBidiControl(file, line) {
  return finding(
    file,
    line,
    'unexpected-bidi-control',
    'error',
    'Source contains an invisible Unicode bidi control. Prefer semantic HTML isolation or document a reviewed source-code need.'
  );
}

function summarizeFindings(findings) {
  return findings.reduce(
    (summary, current) => {
      summary[current.severity] += 1;
      return summary;
    },
    { error: 0, review: 0 }
  );
}

module.exports = {
  auditBidirectionalReadiness,
  collectSourceFiles,
};
