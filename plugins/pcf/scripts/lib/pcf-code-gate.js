'use strict';

const { blankLiterals, blankNonCodePreservingTemplateExpressions, commentRanges, expressionPosition } = require('./source-literals.js');

const BEST_PRACTICES = 'https://learn.microsoft.com/power-apps/developer/component-framework/code-components-best-practices';
const FEATURE_USAGE = 'https://learn.microsoft.com/power-apps/developer/component-framework/manifest-schema-reference/feature-usage';
const RECORD_ID_FAQ = 'https://learn.microsoft.com/power-apps/developer/component-framework/faq#how-can-i-access-the-record-id-or-table-name';
const GRID_CUSTOMIZER = 'https://learn.microsoft.com/power-apps/developer/component-framework/customize-editable-grid-control';

const WARNING_CODES = new Set([
  'PCF_CODE_HOST_DOM',
  'PCF_CODE_INNERHTML',
  'PCF_CODE_STORAGE',
  'PCF_CODE_DIRECT_API',
  'PCF_CODE_REFRESH_IN_UPDATEVIEW',
  'PCF_CODE_UNPARSEABLE',
  'PCF_FEATURE_UNUSED',
  'PCF_CODE_FIXED_ELEMENT_ID',
]);

const SOURCE_RULES = [
  {
    code: 'PCF_CODE_XRM',
    re: /\bXrm\s*\./g,
    message: () => `Heuristic diagnostic: Xrm is an unsupported API inside PCF source; use the framework context APIs instead. See ${BEST_PRACTICES}`,
  },
  {
    code: 'PCF_CODE_PARENT_WINDOW',
    re: /window\.(parent|top)\b|\bparent\.Xrm\b/g,
    message: () => `Heuristic diagnostic: parent window access is unsupported in PCF source; use context APIs such as context.client and context.webAPI instead. See ${BEST_PRACTICES}`,
  },
  {
    code: 'PCF_CODE_EVAL',
    re: /\beval\s*\(|\bnew\s+Function\s*\(/g,
    message: () => `Heuristic diagnostic: dynamic code execution is unsafe and unsupported; replace eval/new Function with typed functions or explicit dispatch. See ${BEST_PRACTICES}`,
  },
  {
    code: 'PCF_CODE_RAW_ASSIGN',
    re: /context\.parameters\.\w+\.raw\s*=(?!=)/g,
    message: () => `Heuristic diagnostic: assigning to context.parameters.<name>.raw is unsupported; store state and use notifyOutputChanged/getOutputs instead. See ${BEST_PRACTICES}`,
  },
  {
    code: 'PCF_CODE_HOST_DOM',
    re: /document\.(querySelector|querySelectorAll|getElementById|getElementsBy\w+)\s*\(|document\.body\b/g,
    message: () => `Heuristic diagnostic: querying the host document is unsupported; use the container passed to init/updateView and framework-provided context instead. See ${BEST_PRACTICES}`,
  },
  {
    code: 'PCF_CODE_INNERHTML',
    re: /\.innerHTML\s*=|dangerouslySetInnerHTML/g,
    message: () => `Heuristic diagnostic: raw HTML injection is unsafe; use textContent, DOM APIs, or normal React rendering instead. See ${BEST_PRACTICES}`,
  },
  {
    code: 'PCF_CODE_STORAGE',
    re: /\b(localStorage|sessionStorage)\b/g,
    message: () => `Heuristic diagnostic: browser storage is an unsupported persistence boundary for PCF controls; use bound properties, Dataverse APIs, or in-memory state instead. See ${BEST_PRACTICES}`,
  },
  {
    code: 'PCF_CODE_INTERNAL_CONTEXT',
    re: /context\.mode\.contextInfo\b|\(context\s+as\s+any\)\.page\b|context\.page\b|\(context\s+as\s+any\)\.factory\.fireEvent\s*\(/g,
    message: (match) => {
      if (match.includes('factory.fireEvent')) {
        return `Heuristic diagnostic: factory.fireEvent is an internal context API except in the documented grid-customizer bridge; move it to a marked customizerBridge.ts adapter or use public framework APIs. See ${GRID_CUSTOMIZER}`;
      }
      return `Heuristic diagnostic: current-record internals such as context.mode.contextInfo/context.page are unsupported; bind entityId/entityName input properties and handle a missing id as an unsaved record. See ${RECORD_ID_FAQ}`;
    },
    allow: (file, text, match) => match.includes('factory.fireEvent') && hasGridCustomizerMarker(file, text),
  },
];

function scanSource(file, text, { controlType, lex = blankNonCodePreservingTemplateExpressions } = {}) {
  const src = String(text || '');
  const lexed = lexSource(file, src, lex);
  if (lexed.finding) return [lexed.finding];
  const mask = lexed.mask;
  const findings = [];

  for (const rule of SOURCE_RULES) {
    addRegexFindings(findings, rule, file, src, mask);
  }

  if (controlType === 'virtual') {
    addRegexFindings(findings, {
      code: 'PCF_VIRTUAL_OWN_ROOT',
      re: /ReactDOM\.render\s*\(|createRoot\s*\(/g,
      message: () => `Heuristic diagnostic: virtual PCF controls must not create their own React root; let the platform render the React component instead. See ${BEST_PRACTICES}`,
    }, file, src, mask);
  }

  addDirectApiFindings(findings, file, src, mask);
  addRefreshInUpdateViewFindings(findings, file, src, mask);
  addFixedElementIdFindings(findings, file, src, mask);
  return findings;
}

const FIXED_ELEMENT_ID_JSX = new Set(['id', 'htmlFor', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']);
const FIXED_ELEMENT_ID_DOM = new Set(['id', 'for', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']);
const TEMPLATE_QUOTE = '\u0060';

function addFixedElementIdFindings(findings, file, src, mask) {
  // Two instances of one control on a form share a hard-coded id. The shapes this warning covers:
  //   <div id="popup" />
  //   <label htmlFor={'popup'} />
  //   <div id={`popup`} />                 unsubstituted template, still one shared id
  //   el.id = "popup";
  //   el.setAttribute("id", "popup");
  //   el.setAttribute('for', 'popup');
  //   React.createElement("ul", { id: "popup", "aria-controls": "popup" });
  // Derived values are not findings:
  //   <div id={`${this.instanceId}-list`} />
  //   <div id={popupId} />
  //   el.id = this.instanceId + "-list";
  // The match is taken from the code mask so the same text in a comment or string is ignored.
  scanJsxFixedIds(findings, file, src, mask);
  scanDomIdAssignments(findings, file, src, mask);
  scanSetAttributeIds(findings, file, src, mask);
  scanCreateElementIds(findings, file, src, mask);
}

function fixedElementIdMessage() {
  return `Heuristic diagnostic: a hard-coded element id is shared by every instance of this control, so two instances on one form collide; derive ids per instance, for example React useId or an instance counter. See ${BEST_PRACTICES}`;
}

function scanJsxFixedIds(findings, file, src, mask) {
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== '<' || src[i] !== '<' || !/[A-Za-z]/.test(src[i + 1] || '')) continue;
    const end = findJsxTagEnd(src, i + 1);
    if (end === -1) continue;
    scanJsxTagAttributes(findings, file, src, i, end);
    i = end - 1;
  }
}

function scanJsxTagAttributes(findings, file, src, tagStart, tagEnd) {
  let i = tagStart + 1;
  while (i < tagEnd && /[\w.]/.test(src[i])) i += 1;
  while (i < tagEnd) {
    while (i < tagEnd && /\s/.test(src[i])) i += 1;
    if (i >= tagEnd || src[i] === '/' || src[i] === '>') break;
    const nameStart = i;
    while (i < tagEnd && /[\w:-]/.test(src[i])) i += 1;
    const name = src.slice(nameStart, i);
    while (i < tagEnd && /\s/.test(src[i])) i += 1;
    // A '<' that is a TypeScript generic, such as Record<string, number>, is not a JSX tag.
    // Leaving i unchanged here loops forever on the comma.
    if (src[i] !== '=') {
      if (i === nameStart) i += 1;
      continue;
    }
    i += 1;
    while (i < tagEnd && /\s/.test(src[i])) i += 1;
    const value = readJsxAttributeValue(src, i);
    if (!value) break;
    if (FIXED_ELEMENT_ID_JSX.has(name) && value.literal) {
      findings.push(makeFinding('PCF_CODE_FIXED_ELEMENT_ID', fixedElementIdMessage(), file, lineOf(src, nameStart)));
    }
    i = value.end;
  }
}

function scanDomIdAssignments(findings, file, src, mask) {
  const re = /\.id(?![A-Za-z0-9_$])\s*=(?!=)/g;
  let match;
  while ((match = re.exec(mask)) !== null) {
    if (mask[match.index] === ' ') continue;
    const value = readAssignedLiteral(src, match.index + match[0].length);
    if (!value || !value.literal) continue;
    findings.push(makeFinding('PCF_CODE_FIXED_ELEMENT_ID', fixedElementIdMessage(), file, lineOf(src, match.index)));
  }
}

function scanSetAttributeIds(findings, file, src, mask) {
  const re = /\bsetAttribute\s*\(/g;
  let match;
  while ((match = re.exec(mask)) !== null) {
    if (mask[match.index] === ' ') continue;
    const open = src.indexOf('(', match.index);
    const args = readSetAttributeArgs(src, open);
    if (args.length < 2 || !args[0].literal || !FIXED_ELEMENT_ID_DOM.has(args[0].text) || !args[1].literal) continue;
    findings.push(makeFinding('PCF_CODE_FIXED_ELEMENT_ID', fixedElementIdMessage(), file, lineOf(src, match.index)));
  }
}

function scanCreateElementIds(findings, file, src, mask) {
  const calls = /\b(?:React\s*\.\s*createElement|createElement|h)\s*\(/g;
  let match;
  while ((match = calls.exec(mask)) !== null) {
    if (previousNonSpace(mask, match.index) === '.') continue;
    const open = mask.indexOf('(', match.index);
    const close = findMatchingParen(mask, open);
    if (close === -1) continue;
    const args = splitTopLevel(mask.slice(open + 1, close), ',');
    if (args.length < 2) continue;
    const start = open + 1 + args[1].start;
    const end = open + 1 + args[1].end;
    const props = unwrapExpression(withoutComments(src.slice(start, end)), mask.slice(start, end));
    if (props.mask[0] !== '{' || findMatchingBrace(props.mask, 0) !== props.mask.length - 1) continue;

    // Factory props have the raw shape createElement("ul", { id: "list", "aria-controls": "list" }).
    // Only inspect top-level props in argument two; nested style objects and child arguments are
    // not element IDs. A whole literal value warns, but "prefix-" + instanceId remains derived.
    const bodyStart = start + props.offset + 1;
    const rawBody = props.raw.slice(1, -1);
    const maskBody = props.mask.slice(1, -1);
    for (const range of splitTopLevel(maskBody, ',')) {
      const rawProperty = rawBody.slice(range.start, range.end);
      const maskProperty = maskBody.slice(range.start, range.end);
      const parts = splitTopLevel(maskProperty, ':');
      if (parts.length < 2) continue;
      const colon = parts[0].end;
      const rawKey = rawProperty.slice(0, colon).trim();
      const quotedKey = isQuote(rawKey[0]) ? readQuotedLiteral(rawKey, 0) : null;
      const key = quotedKey && quotedKey.literal && quotedKey.end === rawKey.length ? quotedKey.text : rawKey;
      if (!FIXED_ELEMENT_ID_JSX.has(key)) continue;
      const value = unwrapExpression(rawProperty.slice(colon + 1), maskProperty.slice(colon + 1));
      const quotedValue = isQuote(value.raw[0]) ? readQuotedLiteral(value.raw, 0) : null;
      if (!quotedValue || !quotedValue.literal || quotedValue.end !== value.raw.length) continue;
      const keyStart = rawProperty.search(/\S/);
      findings.push(makeFinding('PCF_CODE_FIXED_ELEMENT_ID', fixedElementIdMessage(), file, lineOf(src, bodyStart + range.start + keyStart)));
    }
  }
}

function readJsxAttributeValue(text, index) {
  if (isQuote(text[index])) return readQuotedLiteral(text, index);
  if (text[index] !== '{') return { end: index, literal: false };
  const close = findBraceSkippingStrings(text, index);
  if (close === -1) return null;
  const inner = text.slice(index + 1, close).trim();
  const quoted = isQuote(inner[0]) ? readQuotedLiteral(inner, 0) : null;
  return { end: close + 1, literal: Boolean(quoted && quoted.end === inner.length && quoted.literal) };
}

function readAssignedLiteral(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (!isQuote(text[i])) return null;
  return readQuotedLiteral(text, i);
}

function isQuote(ch) {
  return ch === '"' || ch === "'" || ch === TEMPLATE_QUOTE;
}

function readQuotedLiteral(text, index) {
  const quote = text[index];
  let i = index + 1;
  let hasSubstitution = false;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (quote === TEMPLATE_QUOTE && text[i] === '$' && text[i + 1] === '{') {
      hasSubstitution = true;
      const close = findBraceSkippingStrings(text, i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (text[i] === quote) {
      return { end: i + 1, literal: quote !== TEMPLATE_QUOTE || !hasSubstitution, text: text.slice(index + 1, i) };
    }
    i += 1;
  }
  return null;
}

function readSetAttributeArgs(text, openParen) {
  const args = [];
  let i = openParen + 1;
  while (i < text.length && text[i] !== ')' && args.length < 2) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (isQuote(text[i])) {
      const quoted = readQuotedLiteral(text, i);
      if (!quoted) break;
      args.push(quoted);
      i = quoted.end;
      continue;
    }
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) break;
      i += 1;
    }
    args.push({ end: i, literal: false, text: text.slice(start, i) });
  }
  return args;
}

function findJsxTagEnd(text, start) {
  let quote = null;
  let brace = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      brace += 1;
      continue;
    }
    if (ch === '}') {
      if (brace > 0) brace -= 1;
      continue;
    }
    if (ch === '>' && brace === 0) return i + 1;
  }
  return -1;
}

function findBraceSkippingStrings(text, open) {
  if (text[open] !== '{') return -1;
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function addRegexFindings(findings, rule, file, src, mask) {
  rule.re.lastIndex = 0;
  let match;
  while ((match = rule.re.exec(mask)) !== null) {
    if (rule.allow && rule.allow(file, src, match[0], match.index)) continue;
    findings.push(makeFinding(rule.code, rule.message(match[0]), file, lineOf(src, match.index)));
    if (match[0].length === 0) rule.re.lastIndex += 1;
  }
}

function addDirectApiFindings(findings, file, src, mask) {
  const ranges = stringLikeRanges(src, mask);
  const re = /\/api\/data\//g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const index = match.index;
    if (!inRanges(index, ranges)) continue;
    findings.push(makeFinding(
      'PCF_CODE_DIRECT_API',
      `Heuristic diagnostic: direct Dataverse /api/data/ URLs bypass PCF feature tracking; use context.webAPI and declare the WebAPI feature instead. See ${BEST_PRACTICES}`,
      file,
      lineOf(src, index),
    ));
  }
}

function addRefreshInUpdateViewFindings(findings, file, src, mask) {
  const updateView = /\bupdateView\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g;
  let match;
  while ((match = updateView.exec(mask)) !== null) {
    const open = mask.indexOf('{', match.index);
    const close = findMatchingBrace(mask, open);
    const bodyEnd = close === -1 ? mask.length : close;
    const body = mask.slice(open + 1, bodyEnd);
    const refresh = /\.refresh\s*\(/g;
    let refreshMatch;
    while ((refreshMatch = refresh.exec(body)) !== null) {
      findings.push(makeFinding(
        'PCF_CODE_REFRESH_IN_UPDATEVIEW',
        `Heuristic diagnostic: calling refresh from updateView can create render loops; move refresh to an explicit user action or guarded async workflow instead. See ${BEST_PRACTICES}`,
        file,
        lineOf(src, open + 1 + refreshMatch.index),
      ));
    }
    updateView.lastIndex = bodyEnd + 1;
  }
}

function featureCoherence(manifestModel, sources, hosts = [], { lex = blankNonCodePreservingTemplateExpressions } = {}) {
  const declared = new Set((manifestModel.features || []).map((feature) => feature.name).filter(Boolean));
  const used = new Set();
  const findings = [];
  const pages = hosts.includes('pages');

  for (const source of sources || []) {
    const file = source.file || '<source>';
    const text = String(source.text || '');
    const lexed = lexSource(file, text, lex);
    if (lexed.finding) {
      findings.push(lexed.finding);
      continue;
    }
    const mask = lexed.mask;

    collectNamespaceUse({ findings, declared, used, file, text, mask, namespace: 'webAPI', feature: 'WebAPI' });
    collectNamespaceUse({ findings, declared, used, file, text, mask, namespace: 'utils', feature: 'Utility' });
    collectDeviceUse({ findings, declared, used, file, text, mask });
    if (pages) addPagesApiFindings(findings, file, text, mask);
  }

  for (const feature of declared) {
    if (!used.has(feature)) {
      findings.push(makeFinding(
        'PCF_FEATURE_UNUSED',
        `Heuristic diagnostic: manifest declares feature '${feature}' but the scanned source does not use it; remove the unused feature or add the guarded code that needs it. See ${FEATURE_USAGE}`,
        '<manifest>',
        1,
      ));
    }
  }

  return findings;
}

function collectNamespaceUse({ findings, declared, used, file, text, mask, namespace, feature }) {
  const re = new RegExp(`\\bcontext\\.${namespace}\\b`, 'g');
  let match;
  while ((match = re.exec(mask)) !== null) {
    used.add(feature);
    if (!declared.has(feature)) {
      findings.push(makeFinding(
        'PCF_FEATURE_UNDECLARED',
        `Heuristic diagnostic: source uses context.${namespace}, but the manifest does not declare '${feature}'; declare the feature or remove the API call. See ${FEATURE_USAGE}`,
        file,
        lineOf(text, match.index),
      ));
    }
  }
}

function collectDeviceUse({ findings, declared, used, file, text, mask }) {
  const re = /\bcontext\.device(?:\?\.|\.)([A-Za-z_$][\w$]*)\b/g;
  let match;
  while ((match = re.exec(mask)) !== null) {
    const feature = `Device.${match[1]}`;
    used.add(feature);
    if (!declared.has(feature)) {
      findings.push(makeFinding(
        'PCF_FEATURE_UNDECLARED',
        `Heuristic diagnostic: source uses context.device.${match[1]}, but the manifest does not declare '${feature}'; declare the method feature or remove the API call. See ${FEATURE_USAGE}`,
        file,
        lineOf(text, match.index),
      ));
    }
  }
}

function addPagesApiFindings(findings, file, text, mask) {
  const calls = /\bcontext\.(device|utils)(?:\?\.|\.)([A-Za-z_$][\w$]*)(?:\?\.)?\s*\(/g;
  let match;
  while ((match = calls.exec(mask)) !== null) {
    const namespace = match[1];
    const method = match[2];
    if (hasMethodGuard(text, mask, namespace, method, match.index)) continue;
    findings.push(makeFinding(
      'PCF_PAGES_API',
      `Heuristic diagnostic: Pages may not provide context.${namespace}.${method}; guard the method with typeof context.${namespace}?.${method} === 'function' before calling it, or avoid the API for Pages hosts. See ${FEATURE_USAGE}`,
      file,
      lineOf(text, match.index),
    ));
  }
}

function gateSources({ manifestModel, sources, hosts = [] }) {
  const controlType = manifestModel && manifestModel.control ? manifestModel.control.controlType : undefined;
  const all = [];
  for (const source of sources || []) {
    all.push(...scanSource(source.file || '<source>', source.text || '', { controlType }));
  }
  all.push(...featureCoherence(manifestModel || { features: [] }, sources || [], hosts));
  const errors = all.filter((finding) => finding.severity === 'error');
  const warnings = all.filter((finding) => finding.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}

function makeFinding(code, message, file, line) {
  return {
    code,
    severity: WARNING_CODES.has(code) ? 'warning' : 'error',
    message,
    file,
    line,
  };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function findMatchingBrace(mask, open) {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < mask.length; i += 1) {
    if (mask[i] === '{') depth += 1;
    else if (mask[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lexSource(file, text, lex, opts) {
  try {
    return { mask: lex(text, opts), finding: null };
  } catch (err) {
    return {
      mask: '',
      finding: makeFinding(
        'PCF_CODE_UNPARSEABLE',
        `Heuristic diagnostic: source could not be parsed by the PCF source gate, which is an unsupported source shape for this check; use valid TypeScript/TSX or simplify the syntax so the gate can scan it. See ${BEST_PRACTICES}`,
        file,
        1,
      ),
    };
  }
}

function stringLikeRanges(src, mask) {
  const ranges = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if ((c === '"' || c === "'" || c === '`') && expressionPosition(mask, i)) {
      const quote = c;
      const start = i;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      ranges.push([start, i]);
      continue;
    }
    i += 1;
  }
  return ranges;
}

function hasGridCustomizerMarker(file, text) {
  const base = String(file || '').split(/[\\/]/).pop();
  if (base !== 'customizerBridge.ts' && base !== 'customizerBridge.tsx') return false;
  const comments = [];
  const mask = blankLiterals(text, { onComment: (start, end) => comments.push([start, end]) });
  const firstCode = mask.search(/\S/);
  const headerEnd = firstCode === -1 ? text.length : firstCode;
  return comments
    .filter(([, end]) => end <= headerEnd)
    .some(([start, end]) => text.slice(start, end).includes('pcf-extension-pattern: grid-customizer'));
}

function hasMethodGuard(text, mask, namespace, method, callIndex) {
  const start = Math.max(0, callIndex - 500);
  const ifHead = /\bif\s*\(/g;
  ifHead.lastIndex = start;
  let match;
  while ((match = ifHead.exec(mask)) !== null && match.index < callIndex) {
    const openParen = mask.indexOf('(', match.index);
    const closeParen = findMatchingParen(mask, openParen);
    if (closeParen === -1 || closeParen >= callIndex) continue;
    let openBrace = closeParen + 1;
    while (openBrace < mask.length && /\s/.test(mask[openBrace])) openBrace += 1;
    if (mask[openBrace] !== '{' || openBrace >= callIndex) continue;
    if (mask.slice(openBrace + 1, callIndex).includes('}')) continue;

    const rawCondition = withoutComments(text.slice(openParen + 1, closeParen));
    const maskCondition = mask.slice(openParen + 1, closeParen);
    // A positive substring is not a proof: !(ready && typeof X === "function") and
    // (typeof X === "function") === false both run where X may be absent. Prove the whole true
    // condition, keeping OR conservative and requiring a preceding namespace check for dotted X.
    if (maskCondition.includes('||')) continue;
    if (provePositiveCondition(rawCondition, maskCondition, namespace, method).methodSafe) return true;
  }
  return false;
}

function provePositiveCondition(raw, mask, namespace, method, namespaceSafe = false) {
  const expression = unwrapExpression(raw, mask);
  raw = expression.raw;
  mask = expression.mask;
  const unproven = { namespaceSafe, methodSafe: false };
  // Ternary and comma expressions bind more loosely than &&: "guard && ready ? ready : true"
  // and "(guard && ready), true" can be true without the guard. Optional chaining's ?. is not a
  // ternary separator. Unsupported leaves stay unproven rather than borrowing a nested match.
  if (splitTopLevel(mask, '?').length > 1 || splitTopLevel(mask, ',').length > 1) return unproven;
  const conjunction = splitTopLevel(mask, '&&');
  if (conjunction.length > 1) {
    let methodSafe = false;
    for (const range of conjunction) {
      const proof = provePositiveCondition(raw.slice(range.start, range.end), mask.slice(range.start, range.end), namespace, method, namespaceSafe);
      namespaceSafe = proof.namespaceSafe;
      methodSafe = methodSafe || proof.methodSafe;
    }
    return { namespaceSafe, methodSafe };
  }

  const namespacePath = `context\\.${escapeRegExp(namespace)}`;
  const optionalMethod = `${namespacePath}\\?\\.${escapeRegExp(method)}`;
  const dottedMethod = `${namespacePath}\\.${escapeRegExp(method)}`;
  const provesMethod = (reference) => new RegExp(`^(?:${reference}|typeof\\s+${reference}\\s*={2,3}\\s*(['"])function\\1)$`).test(raw);
  const methodSafe = provesMethod(optionalMethod) || (namespaceSafe && provesMethod(dottedMethod));
  const provesNamespace = new RegExp(`^(?:${namespacePath}|!!\\s*${namespacePath}|${namespacePath}\\s*!=\\s*null|${namespacePath}\\s*!==\\s*undefined)$`).test(raw);
  return { namespaceSafe: namespaceSafe || provesNamespace || methodSafe, methodSafe };
}

function previousNonSpace(text, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return '';
}

function withoutComments(text) {
  let code = text;
  for (const { start, end } of commentRanges(text).reverse()) {
    code = code.slice(0, start) + code.slice(start, end).replace(/[^\n\r]/g, ' ') + code.slice(end);
  }
  return code;
}

function unwrapExpression(raw, mask) {
  let offset = 0;
  while (true) {
    const start = raw.length - raw.trimStart().length;
    const end = raw.trimEnd().length;
    offset += start;
    raw = raw.slice(start, end);
    mask = mask.slice(start, end);
    if (mask[0] !== '(' || findMatchingParen(mask, 0) !== mask.length - 1) return { raw, mask, offset };
    raw = raw.slice(1, -1);
    mask = mask.slice(1, -1);
    offset += 1;
  }
}

function splitTopLevel(mask, separator) {
  const ranges = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if ('([{'.includes(mask[i])) depth += 1;
    else if (')]}'.includes(mask[i])) depth -= 1;
    else if (depth === 0 && mask.startsWith(separator, i)) {
      if (separator === '?' && mask[i + 1] === '.') continue;
      ranges.push({ start, end: i });
      i += separator.length - 1;
      start = i + 1;
    }
  }
  ranges.push({ start, end: mask.length });
  return ranges;
}

function findMatchingParen(mask, open) {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < mask.length; i += 1) {
    if (mask[i] === '(') depth += 1;
    else if (mask[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasCodeMatch(re, raw, mask) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    if (mask[match.index] !== ' ') return true;
  }
  return false;
}

function inRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  scanSource,
  featureCoherence,
  gateSources,
};
