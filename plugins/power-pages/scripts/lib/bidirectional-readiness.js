'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCE_EXTENSIONS = new Set([
  '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx', '.vue', '.astro', '.html',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.git', 'dist', 'build', 'node_modules', '.output', 'coverage',
]);
const EXCEPTION_DIRECTIVE_RE =
  /bidi-(physical|fixed):\s*(\S(?:.*\S)?)\s*;\s*verify=ltr,rtl\s*(?:\*\/\}?|-->)?\s*$/i;
const BLOCKING_PROPERTY_RE =
  /(?:^|[;{,"'])\s*['"]?(?:(?:margin|padding|border)-(?:left|right)(?:-(?:color|style|width))?|border-(?:top|bottom)-(?:left|right)-radius)['"]?\s*:/gi;
const BLOCKING_STYLE_OBJECT_PROPERTY_RE =
  /(?:^|[,{])\s*['"]?(?:(?:margin|padding|border)(?:Left|Right)(?:Color|Style|Width)?|border(?:Top|Bottom)(?:Left|Right)Radius)['"]?\s*:/g;
const BLOCKING_ALIGNMENT_RE =
  /(?:^|[;{,"'])\s*['"]?(?:text-align|textAlign|float|clear)['"]?\s*:\s*['"]?(?:left|right)['"]?\s*(?:[;,!}]|$)/gi;
const REVIEW_PROPERTY_RE = /(?:^|[;{,"'])\s*['"]?(?:left|right)['"]?\s*:/gi;
const FIXED_DIRECTION_PROPERTY_RE =
  /(?:^|[;{,"'])\s*['"]?direction['"]?\s*:\s*['"]?(?:ltr|rtl)['"]?\s*(?:[;,!}]|$)/gi;
const FIXED_DIRECTION_ATTRIBUTE_RE =
  /(?:(?<![\w-])dir|:dir|\[(?:attr\.)?dir\])\s*=\s*(?:["'](?:ltr|rtl)["']|\{\s*["'](?:ltr|rtl)["']\s*\}|["']\s*["'](?:ltr|rtl)["']\s*["'])/gi;
const CLASS_ATTRIBUTE_PATTERNS = [
  {
    regex: /(?<![:\w\[])(?:class|className)\s*=\s*(["'`])((?:(?!\1).)*)\1/gi,
    valueGroup: 2,
  },
  {
    regex: /\bclassName\s*=\s*\{\s*(["'`])((?:(?!\1).)*)\1\s*\}/gi,
    valueGroup: 2,
  },
  {
    regex: /(?::class|\[class\])\s*=\s*(["'])\s*(["'`])((?:(?!\2).)*)\2\s*\1/gi,
    valueGroup: 3,
  },
];
const PHYSICAL_UTILITY_RE =
  /^-?(?:text-(?:left|right)|float-(?:left|right)|(?:m|p)[lr]-.+|(?:left|right)-.+|border-[lr](?:-.+)?|rounded-[lr](?:-.+)?)$/i;
const PHYSICAL_SHORTHAND_PROPERTY_RE =
  /(?:^|[;{,"'])\s*['"]?(margin|padding|border-radius|borderRadius)['"]?\s*:\s*/gi;
const UNICODE_BIDI_OVERRIDE_RE =
  /(?:^|[;{,"'])\s*['"]?(?:unicode-bidi|unicodeBidi)['"]?\s*:\s*['"]?(?:bidi-override|isolate-override|embed)['"]?\s*(?:[;,!}]|$)/i;
const VISUAL_ORDER_RE =
  /\b(?:flex-direction\s*:\s*(?:row|column)-reverse|order\s*:\s*-?\d+)/i;
const GEOMETRY_RE =
  /\b(?:scaleX\s*\(\s*-1\s*\)|transform-origin|background-position\s*:\s*(?:left|right)|linear-gradient\s*\([^)]*(?:left|right)|clip-path|mask(?:-image)?\s*:)/i;
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
    const source = fs.readFileSync(filePath, 'utf8');
    const lines = source.split(/\r?\n/);
    const directionalScrollLines = collectDirectionalScrollLines(
      stripCommentsFromSource(source)
    );
    const extension = path.extname(filePath).toLowerCase();
    const firstFindingIndex = findings.length;
    let pendingDirective = null;
    let markupState = createMarkupState();
    let styleObjectDepth = 0;
    let commentState = { blockEnd: null };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const directiveMatch = commentState.blockEnd
        ? null
        : trimmed.match(EXCEPTION_DIRECTIVE_RE);
      if (directiveMatch) {
        if (pendingDirective) {
          findings.push(unusedDirectiveFinding(relativePath, pendingDirective));
          pendingDirective = null;
        }
        const kind = directiveMatch[1].toLowerCase();
        const reason = directiveMatch[2].trim();
        if (reason.length < 12 || /^(?:needed|intentional|required|exception)$/i.test(reason)) {
          findings.push(finding(
            relativePath,
            index + 1,
            `invalid-${kind}-exception`,
            'error',
            `A bidi-${kind} directive requires a specific reason of at least 12 characters.`
          ));
          continue;
        }
        pendingDirective = {
          kind,
          line: index + 1,
          reason,
        };
        continue;
      }
      const malformedDirective = !commentState.blockEnd && isStandaloneComment(trimmed)
        ? trimmed.match(/bidi-(physical|fixed):/i)
        : null;
      if (malformedDirective) {
        if (pendingDirective) {
          findings.push(unusedDirectiveFinding(relativePath, pendingDirective));
          pendingDirective = null;
        }
        const kind = malformedDirective[1].toLowerCase();
        findings.push(finding(
          relativePath,
          index + 1,
          `invalid-${kind}-exception`,
          'error',
          `Use "bidi-${kind}: <specific reason>; verify=ltr,rtl" immediately before one ` +
          `${kind === 'physical' ? 'physical declaration or utility' : 'fixed-direction declaration or element'}.`
        ));
        continue;
      }

      const stripped = stripSourceComments(line, commentState);
      const scanLine = stripped.value;
      const scanTrimmed = scanLine.trim();
      commentState = stripped.state;
      if (!scanTrimmed) {
        if (pendingDirective) {
          findings.push(unusedDirectiveFinding(relativePath, pendingDirective));
          pendingDirective = null;
        }
        if (BIDI_CONTROL_RE.test(line)) {
          findings.push(unexpectedBidiControl(relativePath, index + 1));
        }
        continue;
      }

      const physicalMatches = collectPhysicalMatches(scanLine);
      const fixedDirectionMatches = collectFixedDirectionMatches(scanLine, {
        allowCssProperties:
          isCssFile(extension) || styleObjectDepth > 0 || isLikelyInlineStyle(scanLine),
        markupState,
      });
      const nextMarkupState = scanMarkupState(markupState, scanLine, scanLine.length);
      const nextStyleObjectDepth = updateStyleObjectDepth(styleObjectDepth, scanLine);
      if (pendingDirective) {
        const candidateMatches = pendingDirective.kind === 'physical'
          ? physicalMatches
          : fixedDirectionMatches;
        if (candidateMatches.length > 0) {
          // An exception is deliberately declaration-scoped. Minified CSS can
          // contain several declarations on one line, so consume exactly one
          // in source order instead of allowing it to hide the entire line or
          // a later, more severe declaration.
          candidateMatches.shift();
          pendingDirective = null;
        } else if (nextMarkupState.tagName) {
          // An annotation applies to the following element even when its literal
          // attributes are formatted across several lines.
        } else {
          findings.push(finding(
            relativePath,
            pendingDirective.line,
            `unused-${pendingDirective.kind}-exception`,
            'error',
            `A bidi-${pendingDirective.kind} directive may exempt only the immediately ` +
            `following ${pendingDirective.kind === 'physical' ? 'physical item' : 'fixed-direction item'}.`
          ));
          pendingDirective = null;
        }
      }
      for (const physicalMatch of physicalMatches) {
        findings.push(finding(
          relativePath,
          index + 1,
          physicalMatch.rule,
          physicalMatch.severity,
          physicalMatch.message(scanTrimmed)
        ));
      }
      for (const fixedDirectionMatch of fixedDirectionMatches) {
        findings.push(finding(
          relativePath,
          index + 1,
          fixedDirectionMatch.rule,
          'error',
          `Fixed ${fixedDirectionMatch.source} direction requires a specific adjacent ` +
          `bidi-fixed reason and LTR/RTL verification: ${scanTrimmed}`
        ));
      }
      if (UNICODE_BIDI_OVERRIDE_RE.test(scanLine)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'unicode-bidi-override',
          'error',
          `Avoid bidi overrides in generated source; use semantic isolation instead: ${scanTrimmed}`
        ));
      }

      if (VISUAL_ORDER_RE.test(scanLine)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'visual-order-review',
          'review',
          'Confirm visual reversal does not diverge from DOM reading and focus order.'
        ));
      }
      if (hasDirectionalGeometry(scanLine)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'directional-geometry-review',
          'review',
          'Review this physical geometry, animation, gradient, clipping, or mask in both directions.'
        ));
      }
      if (directionalScrollLines.has(index + 1)) {
        findings.push(finding(
          relativePath,
          index + 1,
          'directional-scroll-review',
          'review',
          'Review this physical horizontal scrolling assumption in both directions.'
        ));
      }
      if (FIXED_TEXT_SIZE_RE.test(scanLine)) {
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
      markupState = nextMarkupState;
      styleObjectDepth = nextStyleObjectDepth;
    }

    if (pendingDirective) {
      findings.push(finding(
        relativePath,
        pendingDirective.line,
        `unused-${pendingDirective.kind}-exception`,
        'error',
        `A bidi-${pendingDirective.kind} directive must be followed by an applicable item.`
      ));
    }
    attachFindingFingerprints(findings.slice(firstFindingIndex), lines);
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

function attachFindingFingerprints(fileFindings, lines) {
  const occurrences = new Map();
  for (const item of fileFindings) {
    const identity = `${item.line}\0${item.rule}\0${item.message}`;
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    const start = Math.max(0, item.line - 3);
    const end = Math.min(lines.length, item.line + 2);
    const context = lines.slice(start, end).join('\n');
    item.fingerprint = crypto.createHash('sha256')
      .update(`${identity}\0${occurrence}\0${context}`)
      .digest('hex');
  }
}

function collectPhysicalMatches(value) {
  const matches = [];
  for (const pattern of [
    BLOCKING_PROPERTY_RE,
    BLOCKING_STYLE_OBJECT_PROPERTY_RE,
    BLOCKING_ALIGNMENT_RE,
  ]) {
    for (const match of value.matchAll(pattern)) {
      matches.push({
        index: match.index,
        severity: 'error',
        rule: 'directional-physical-css',
        message: (trimmed) =>
          `Use a logical CSS property, or add an adjacent validated bidi-physical exception: ${trimmed}`,
      });
    }
  }
  for (const match of value.matchAll(REVIEW_PROPERTY_RE)) {
    matches.push({
      index: match.index,
      severity: 'review',
      rule: 'physical-inset-review',
      message: (trimmed) =>
        `Confirm whether this is intentionally physical or should use an inline inset: ${trimmed}`,
    });
  }
  matches.push(...collectPhysicalUtilityMatches(value));
  matches.push(...collectPhysicalShorthandMatches(value));
  return matches.sort((left, right) => left.index - right.index);
}

function collectFixedDirectionMatches(value, options = {}) {
  const matches = [];
  if (options.allowCssProperties) {
    for (const match of value.matchAll(FIXED_DIRECTION_PROPERTY_RE)) {
      matches.push({ index: match.index, rule: 'fixed-direction', source: 'CSS' });
    }
  }
  for (const match of value.matchAll(FIXED_DIRECTION_ATTRIBUTE_RE)) {
    if (!isInsideMarkupTag(value, match.index, options.markupState) ||
        isInsideHtmlRootTag(value, match.index, options.markupState)) {
      continue;
    }
    matches.push({ index: match.index, rule: 'fixed-direction', source: 'markup' });
  }
  return matches.sort((left, right) => left.index - right.index);
}

function collectPhysicalUtilityMatches(value) {
  const matches = [];
  for (const pattern of CLASS_ATTRIBUTE_PATTERNS) {
    for (const classMatch of value.matchAll(pattern.regex)) {
      const classValue = classMatch[pattern.valueGroup].replace(/^(['"])(.*)\1$/, '$2');
      for (const tokenMatch of classValue.matchAll(/\S+/g)) {
        const baseToken = tokenMatch[0].split(':').at(-1);
        if (!PHYSICAL_UTILITY_RE.test(baseToken)) continue;
        matches.push({
          index: classMatch.index + tokenMatch.index,
          severity: 'error',
          rule: 'directional-physical-utility',
          message: () =>
            `Use a logical utility instead of the physical class "${tokenMatch[0]}", ` +
            'or add an adjacent validated bidi-physical exception.',
        });
      }
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

function collectPhysicalShorthandMatches(value) {
  const matches = [];
  for (const match of value.matchAll(PHYSICAL_SHORTHAND_PROPERTY_RE)) {
    const property = match[1];
    const rawValue = readPropertyValue(value, match.index + match[0].length);
    const tokens = splitCssValues(rawValue).map((token) =>
      token.replace(/^[`'"]+|[`'",]+$/g, '')
    );
    const normalizedProperty = property === 'borderRadius' ? 'border-radius' : property;
    const isDirectionalSpacing =
      (normalizedProperty === 'margin' || normalizedProperty === 'padding') &&
      tokens.length === 4 &&
      tokens[1] !== tokens[3];
    const isDirectionalRadius =
      normalizedProperty === 'border-radius' && isDirectionalRadiusValue(rawValue);
    if (!isDirectionalSpacing && !isDirectionalRadius) continue;
    matches.push({
      index: match.index,
      severity: 'error',
      rule: 'directional-physical-shorthand',
      message: (trimmed) =>
        `Replace the asymmetric physical ${normalizedProperty} shorthand with logical ` +
        `properties, or add an adjacent validated bidi-physical exception: ${trimmed}`,
    });
  }
  return matches;
}

function readPropertyValue(value, start) {
  let index = start;
  while (/\s/.test(value[index] || '')) index += 1;
  const quote = value[index];
  if (quote === '"' || quote === "'" || quote === '`') {
    let result = '';
    for (index += 1; index < value.length; index += 1) {
      if (value[index] === quote && value[index - 1] !== '\\') break;
      result += value[index];
    }
    return result.trim();
  }

  let result = '';
  let depth = 0;
  for (; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[;,}]/.test(character)) break;
    result += character;
  }
  return result.trim();
}

function isDirectionalRadiusValue(value) {
  const sides = splitTopLevel(value, '/').map((side) => splitCssValues(side.trim()));
  if (sides.length > 2 || sides.some((side) => side.length < 1 || side.length > 4)) {
    return false;
  }
  return sides.some((side) => {
    const [topLeft, topRight, bottomRight, bottomLeft] = expandCornerValues(side);
    return topLeft !== topRight || bottomLeft !== bottomRight;
  });
}

function expandCornerValues(tokens) {
  if (tokens.length === 1) return [tokens[0], tokens[0], tokens[0], tokens[0]];
  if (tokens.length === 2) return [tokens[0], tokens[1], tokens[0], tokens[1]];
  if (tokens.length === 3) return [tokens[0], tokens[1], tokens[2], tokens[1]];
  return tokens;
}

function splitCssValues(value) {
  const tokens = [];
  let current = '';
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function isInsideMarkupTag(value, index, markupState) {
  return Boolean(scanMarkupState(markupState, value, index).tagName);
}

function isInsideHtmlRootTag(value, index, markupState) {
  return scanMarkupState(markupState, value, index).tagName === 'html';
}

function createMarkupState() {
  return {
    tagName: null,
    expressionDepth: 0,
    quote: null,
    escaped: false,
  };
}

function scanMarkupState(initialState, value, endIndex) {
  const state = initialState ? { ...initialState } : createMarkupState();

  for (let index = 0; index < endIndex; index += 1) {
    const character = value[index];
    if (!state.tagName) {
      if (character !== '<') continue;
      const match = value.slice(index).match(/^<([A-Za-z][\w.-]*)\b/);
      if (!match) continue;
      state.tagName = match[1].toLowerCase();
      state.expressionDepth = 0;
      state.quote = null;
      state.escaped = false;
      index += match[0].length - 1;
      continue;
    }
    if (state.quote) {
      if (state.escaped) {
        state.escaped = false;
      } else if (character === '\\') {
        state.escaped = true;
      } else if (character === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      state.quote = character;
    } else if (character === '{') {
      state.expressionDepth += 1;
    } else if (character === '}') {
      state.expressionDepth = Math.max(0, state.expressionDepth - 1);
    } else if (character === '>' && state.expressionDepth === 0) {
      state.tagName = null;
    }
  }
  return state;
}

function isCssFile(extension) {
  return extension === '.css' || extension === '.scss' || extension === '.less';
}

function isLikelyInlineStyle(value) {
  return /\b\w*(?:style|styles|sx|css)\w*\s*(?:=|:)/i.test(value);
}

function updateStyleObjectDepth(currentDepth, value) {
  let depth = currentDepth;
  let start = 0;
  if (depth === 0) {
    const styleObject = value.match(/\b\w*(?:style|styles|sx|css)\w*\s*(?:=|:)\s*\{/i);
    if (!styleObject) return 0;
    start = styleObject.index + styleObject[0].lastIndexOf('{');
  }
  for (const character of stripQuotedText(value.slice(start))) {
    if (character === '{') depth += 1;
    if (character === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function stripQuotedText(value) {
  let result = '';
  let quote = null;
  let escaped = false;
  for (const character of value) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      result += ' ';
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
      result += ' ';
    } else {
      result += character;
    }
  }
  return result;
}

function isStandaloneComment(value) {
  return value.startsWith('//') || value.startsWith('/*') || value.startsWith('<!--');
}

function stripSourceComments(value, initialState) {
  const state = { ...initialState };
  let result = '';
  let quote = null;
  let escaped = false;
  let hadComment = false;

  for (let index = 0; index < value.length; index += 1) {
    if (state.blockEnd) {
      const end = value.indexOf(state.blockEnd, index);
      hadComment = true;
      if (end < 0) {
        result += ' '.repeat(value.length - index);
        break;
      }
      result += ' '.repeat(end + state.blockEnd.length - index);
      index = end + state.blockEnd.length - 1;
      state.blockEnd = null;
      continue;
    }

    const character = value[index];
    if (quote) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      result += character;
      continue;
    }
    const startsLineComment =
      value.startsWith('//', index) &&
      (index === 0 || /[\s;{}]/.test(value[index - 1]));
    if (startsLineComment) {
      hadComment = true;
      result += ' '.repeat(value.length - index);
      break;
    }
    const blockEnd = value.startsWith('<!--', index)
      ? '-->'
      : value.startsWith('/*', index)
        ? '*/'
        : null;
    if (blockEnd) {
      hadComment = true;
      state.blockEnd = blockEnd;
      result += ' '.repeat(blockEnd === '-->' ? 4 : 2);
      index += blockEnd === '-->' ? 3 : 1;
      continue;
    }
    result += character;
  }
  return { value: result, state, hadComment };
}

function stripCommentsFromSource(source) {
  let state = { blockEnd: null };
  return source.split(/\r?\n/).map((line) => {
    const stripped = stripSourceComments(line, state);
    state = stripped.state;
    return stripped.value;
  }).join('\n');
}

function hasDirectionalGeometry(value) {
  if (GEOMETRY_RE.test(value)) return true;
  for (const pattern of [
    /\btranslateX\s*\(\s*([^)\s]+)/gi,
    /\btranslate(?:3d)?\s*\(\s*([^,\s)]+)/gi,
    /(?:^|[;{,"'])\s*['"]?translate['"]?\s*:\s*['"]?([^,\s;'"}]+)/gi,
  ]) {
    for (const match of value.matchAll(pattern)) {
      if (!isZeroCssValue(match[1])) return true;
    }
  }
  return false;
}

function collectDirectionalScrollLines(source) {
  const lines = new Set();
  for (const match of source.matchAll(/\.scrollLeft\b/g)) {
    lines.add(lineNumberAtOffset(source, match.index));
  }
  for (const match of source.matchAll(/\.(?:scroll|scrollTo|scrollBy)\s*\(/g)) {
    const openingParen = source.indexOf('(', match.index);
    const closingParen = findMatchingDelimiter(source, openingParen, '(', ')');
    if (closingParen < 0) continue;
    const argumentsText = source.slice(openingParen + 1, closingParen).trim();
    const isOptionsObject =
      argumentsText.startsWith('{') && /\bleft\s*:/.test(argumentsText);
    const isPositional = splitTopLevel(argumentsText, ',').length > 1;
    if (isOptionsObject || isPositional) {
      lines.add(lineNumberAtOffset(source, match.index));
    }
  }
  return lines;
}

function findMatchingDelimiter(value, start, opening, closing) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(value, delimiter) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (const character of value) {
    if (quote) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '(' || character === '[' || character === '{') {
      depth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
    } else if (character === delimiter && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function lineNumberAtOffset(value, offset) {
  return value.slice(0, offset).split('\n').length;
}

function isZeroCssValue(value) {
  return /^[-+]?0(?:\.0+)?(?:[a-z%]+)?$/i.test(value);
}

function unusedDirectiveFinding(file, directive) {
  return finding(
    file,
    directive.line,
    `unused-${directive.kind}-exception`,
    'error',
    `A bidi-${directive.kind} directive must be adjacent to the item it exempts.`
  );
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
