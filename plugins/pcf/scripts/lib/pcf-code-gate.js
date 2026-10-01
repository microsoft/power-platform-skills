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
    const memberMask = normalizeFeatureMembers(text, mask);

    collectNamespaceUse({ findings, declared, used, file, text, mask: memberMask, namespace: 'webAPI', feature: 'WebAPI' });
    collectNamespaceUse({ findings, declared, used, file, text, mask: memberMask, namespace: 'utils', feature: 'Utility' });
    collectDeviceUse({ findings, declared, used, file, text, mask: memberMask });
    if (pages) addPagesApiFindings(findings, file, text, mask, memberMask);
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

function normalizeFeatureMembers(text, mask) {
  // Match context?.["device"] . captureImage?.() as context.device.captureImage().
  // Only literal identifier keys are restored from raw text; comments/strings stay masked.
  // Padding keeps call offsets in the original source. This view is ONLY for detection:
  // optional calls still require the same explicit guard, and its optional-link proof uses
  // the untouched mask rather than assuming unsupported Pages methods are always absent.
  const raw = withoutComments(text);
  const members = /\bcontext(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|\s*(?:\?\.\s*)?\[\s*(?:"[A-Za-z_$][\w$]*"|'[A-Za-z_$][\w$]*')\s*\])+(?:\s*\?\.(?=\s*\())?/g;
  let normalized = '';
  let end = 0;
  let match;
  while ((match = members.exec(raw)) !== null) {
    if (mask[match.index] !== 'c') continue;
    const path = match[0]
      .replace(/\s*(?:\?\.\s*)?\[\s*(['"])([A-Za-z_$][\w$]*)\1\s*\]/g, '.$2')
      .replace(/\?\./g, '.')
      .replace(/\s/g, '')
      .replace(/\.$/, '');
    normalized += mask.slice(end, match.index) + path.padEnd(match[0].length);
    end = match.index + match[0].length;
  }
  return normalized + mask.slice(end);
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
  const re = /\bcontext\.device\.([A-Za-z_$][\w$]*)\b/g;
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

function addPagesApiFindings(findings, file, text, mask, memberMask) {
  const calls = /\bcontext\.(device|utils)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = calls.exec(memberMask)) !== null) {
    const namespace = match[1];
    const method = match[2];
    if (hasMethodGuard(text, mask, namespace, method, match.index, memberMask)) continue;
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

function hasMethodGuard(text, mask, namespace, method, callIndex, memberMask) {
  const start = Math.max(0, callIndex - 500);
  const ifHead = /\bif\s*\(/g;
  ifHead.lastIndex = start;
  let match;
  while ((match = ifHead.exec(mask)) !== null && match.index < callIndex) {
    if (!isGuardKeyword(mask, match.index, 'if')) continue;
    const openParen = mask.indexOf('(', match.index);
    const closeParen = findMatchingParen(mask, openParen);
    if (closeParen === -1 || closeParen >= callIndex) continue;
    let openBrace = closeParen + 1;
    while (openBrace < mask.length && /\s/.test(mask[openBrace])) openBrace += 1;
    if (mask[openBrace] !== '{' || openBrace >= callIndex) continue;
    const closeBrace = findMatchingBrace(mask, openBrace);
    if (closeBrace === -1 || closeBrace <= callIndex) continue;

    const rawCondition = withoutComments(text.slice(openParen + 1, closeParen));
    const maskCondition = mask.slice(openParen + 1, closeParen);
    if (provePositiveCondition(rawCondition, maskCondition, namespace, method)
      && !guardProofChanged(mask, memberMask, openBrace, closeBrace, callIndex, ['context', namespace, method])) return true;
  }
  return false;
}

function isGuardKeyword(mask, index, word) {
  // obj.if(...), obj?.if(...) and $if(...) are calls, not statement guards.
  // Comments are already blanked, so inspect the previous significant token too.
  return mask.slice(index, index + word.length) === word
    && !/[A-Za-z0-9_$]/.test(mask[index - 1] || '')
    && !/[A-Za-z0-9_$]/.test(mask[index + word.length] || '')
    && previousNonSpace(mask, index) !== '.';
}

function guardProofChanged(mask, memberMask, open, close, callIndex, methodPath) {
  // A capability is static across a captured handler, not across a different binding:
  //   button.onclick = () => context.device.captureImage()          same context
  //   contexts.forEach(({ context }) => context.device.captureImage())  new context
  // Inspect the whole lexical scope for hoisted var / let/const shadowing, but only
  // preceding writes for reassignment. Balanced blocks keep an unrelated nested block
  // or destructured event parameter from ending the outer guard prematurely.
  const functions = guardFunctionScopes(mask, open + 1, close);
  const shadows = functions
    .filter((scope) => guardBindingsContain(scope.parameters, methodPath[0]))
    .map((scope) => ({ start: scope.start, end: scope.end }));
  const declarations = /\b(let|const|var)\s+/g;
  declarations.lastIndex = open + 1;
  let match;
  while ((match = declarations.exec(mask)) !== null && match.index < close) {
    const start = match.index + match[0].length;
    const end = guardExpressionEnd(mask, start, close, false);
    const declaration = mask.slice(start, end).replace(/\s+(?:of|in)\s+[\s\S]*$/, '');
    if (!guardBindingsContain(declaration, methodPath[0])) continue;
    if (match[1] === 'var') {
      const owner = functions.filter((scope) => scope.body < match.index && match.index < scope.end)
        .sort((a, b) => b.body - a.body)[0];
      // A var in the guarded block itself reuses its function's existing root; only
      // a nested function's var creates a new binding, including before its declaration.
      if (owner) shadows.push({ start: owner.body, end: owner.end });
    } else {
      shadows.push(enclosingGuardBlock(mask, open, close, match.index));
    }
  }
  if (shadows.some((range) => callIndex >= range.start && callIndex < range.end)) return true;

  // Destructuring writes such as ({ context } = next) and [context] = next replace
  // the same root as context = next. Property keys ({ context: item }) do not.
  for (let i = open + 1; i < callIndex; i += 1) {
    if (mask[i] !== '{' && mask[i] !== '[') continue;
    const end = guardMatchingDelimiter(mask, i, mask[i], mask[i] === '{' ? '}' : ']', 1);
    if (end === -1 || !/^\s*=(?![=>])/.test(mask.slice(end + 1, callIndex))) continue;
    if (guardPatternContains(memberMask.slice(i, end + 1), (target) => {
      const path = parseGuardPath(target);
      return path && path.names.length <= methodPath.length && path.names.every((name, index) => name === methodPath[index]);
    })
      && !shadows.some((range) => i >= range.start && i < range.end)) return true;
  }
  const writes = /\b(delete\s+)?(context(?:\.[A-Za-z_$][\w$]*)*)(?:\s*((?:\*\*|>>>|<<|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?![=>])))?/g;
  writes.lastIndex = open + 1;
  while ((match = writes.exec(memberMask)) !== null && match.index < callIndex) {
    if (!match[1] && !match[3]) continue;
    if (previousNonSpace(memberMask, match.index + (match[1] || '').length) === '.') continue;
    const path = match[2].split('.');
    if (path.length > methodPath.length || !path.every((name, index) => name === methodPath[index])) continue;
    // Writes to a callback's own context do not mutate the root captured by a sibling.
    if (shadows.some((range) => match.index >= range.start && match.index < range.end)) continue;
    return true;
  }
  return false;
}

function guardFunctionScopes(mask, start, end) {
  const scopes = [];
  const heads = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  heads.lastIndex = start;
  let match;
  while ((match = heads.exec(mask)) !== null && match.index < end) {
    if (['if', 'else', 'for', 'while', 'switch', 'catch', 'with'].includes(match[1])
      && isGuardKeyword(mask, match.index, match[1])) continue;
    const open = mask.indexOf('(', match.index);
    const close = findMatchingParen(mask, open);
    if (close === -1 || close >= end) continue;
    const bodyHead = /^\s*(?::\s*[^={;]+)?\s*\{/.exec(mask.slice(close + 1, end));
    if (!bodyHead) continue;
    const body = close + 1 + bodyHead[0].lastIndexOf('{');
    const bodyEnd = findMatchingBrace(mask, body);
    if (bodyEnd !== -1 && bodyEnd <= end) scopes.push({ start: open, parameters: mask.slice(open + 1, close), body, end: bodyEnd });
  }

  const arrows = /=>/g;
  arrows.lastIndex = start;
  while ((match = arrows.exec(mask)) !== null && match.index < end) {
    let last = match.index - 1;
    while (last >= start && /\s/.test(mask[last])) last -= 1;
    // A TS return annotation puts : void / : Promise<void> between ')' and '=>'.
    // Step over that type only; an unparenthesized arrow parameter stays a name.
    if (mask[last] !== ')') {
      const returnType = /\)\s*:\s*[A-Za-z_$][\w$.[\]<>, |&?]*$/.exec(mask.slice(start, last + 1));
      if (returnType) last = start + returnType.index;
    }
    let parameters;
    let parameterStart;
    if (mask[last] === ')') {
      const open = guardMatchingDelimiter(mask, last, ')', '(', -1);
      if (open < start) continue;
      parameters = mask.slice(open + 1, last);
      parameterStart = open;
    } else {
      const parameter = /[A-Za-z_$][\w$]*$/.exec(mask.slice(start, last + 1));
      if (!parameter) continue;
      parameters = parameter[0];
      parameterStart = start + parameter.index;
    }
    let body = match.index + 2;
    while (body < end && /\s/.test(mask[body])) body += 1;
    const bodyEnd = mask[body] === '{' ? findMatchingBrace(mask, body) : guardExpressionEnd(mask, body, end, true);
    if (bodyEnd !== -1 && bodyEnd <= end) scopes.push({ start: parameterStart, parameters, body, end: bodyEnd });
  }
  return scopes;
}

function guardBindingsContain(mask, root) {
  return splitTopLevel(mask, ',').some((range) => guardBindingContains(mask.slice(range.start, range.end), root));
}

function guardBindingContains(mask, root) {
  return guardPatternContains(mask, (binding) => {
    binding = binding.replace(/^(?:(?:public|private|protected|readonly)\s+)+/, '');
    const identifier = /^([A-Za-z_$][\w$]*)(?:\s*\?)?(?:\s*:[\s\S]+)?\s*$/.exec(binding);
    return Boolean(identifier && identifier[1] === root);
  });
}

function guardPatternContains(mask, matchesTarget) {
  // Binding patterns differ from references: { context: item } binds item, whereas
  // { current: context }, [context] and ...context bind context. A default's RHS
  // (item = context) is a reference, and a simple parameter's :Type is not a binding.
  let binding = mask.slice(0, splitTopLevel(mask, '=')[0].end).trim().replace(/^\.\.\.\s*/, '');
  if (binding[0] === '{' || binding[0] === '[') {
    const close = guardMatchingDelimiter(binding, 0, binding[0], binding[0] === '{' ? '}' : ']', 1);
    if (close === -1) return false;
    const body = binding.slice(1, close);
    return splitTopLevel(body, ',').some((range) => {
      let entry = body.slice(range.start, range.end);
      const parts = splitTopLevel(entry, ':');
      if (binding[0] === '{' && parts.length > 1) entry = entry.slice(parts[1].start);
      return guardPatternContains(entry, matchesTarget);
    });
  }
  return matchesTarget(binding);
}

function enclosingGuardBlock(mask, open, close, index) {
  let range = { start: open, end: close };
  for (let i = open + 1; i < index; i += 1) {
    if (mask[i] !== '{') continue;
    const end = findMatchingBrace(mask, i);
    if (end > index) range = { start: i, end };
  }
  return range;
}

function guardExpressionEnd(mask, start, end, stopAtComma) {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const ch = mask[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || (stopAtComma && ch === ','))) return i;
  }
  return end;
}

function guardMatchingDelimiter(mask, start, opening, closing, direction) {
  let depth = 0;
  for (let i = start; i >= 0 && i < mask.length; i += direction) {
    if (mask[i] === opening) depth += 1;
    else if (mask[i] === closing) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function provePositiveCondition(raw, mask, namespace, method) {
  // Only a whole positive conjunction proves the method. Raw examples:
  //   context.device && typeof context.device.captureImage === "function"
  //   !!context.device?.captureImage && !busy
  // A later optional proof cannot rescue an earlier unsafe dereference or arbitrary operand.
  // The executable mask catches side effects even in template substitutions; the structural
  // mask blanks entire literals so their text, brackets and && cannot split the conjunction.
  const assignment = /(?<![=!<>])=(?!=)|(?:\*\*|>>>|<<|>>|&&|\|\||\?\?|[+\-*/%&|^])=/;
  if (mask.includes('=>') || assignment.test(mask) || /\?(?!\.)|!\s*\(/.test(mask)
    || mask.includes('||') || mask.includes('??')) return false;
  const state = { proven: new Set(), methodSafe: false };
  return proveGuardConjunction(raw, blankLiterals(raw), ['context', namespace, method], state) && state.methodSafe;
}

function proveGuardConjunction(raw, mask, methodPath, state) {
  const expression = unwrapExpression(raw, mask);
  raw = expression.raw;
  mask = expression.mask;
  if (splitTopLevel(mask, ',').length > 1) return false;
  const conjunction = splitTopLevel(mask, '&&');
  if (conjunction.length > 1) {
    for (const range of conjunction) {
      if (!proveGuardConjunction(raw.slice(range.start, range.end), mask.slice(range.start, range.end), methodPath, state)) return false;
    }
    return true;
  }

  const typeofLeft = /^typeof\s+(.+?)\s*={2,3}\s*(['"])function\2$/.exec(raw);
  const typeofRight = /^(['"])function\1\s*={2,3}\s*typeof\s+(.+)$/.exec(raw);
  const typeofPath = typeofLeft ? typeofLeft[1] : typeofRight ? typeofRight[2] : null;
  const path = parseGuardPath(typeofPath || raw.replace(/^!!\s*/, ''));
  if (path && path.names.join('.') === methodPath.join('.')) {
    if (!safeGuardLinks(path, state.proven)) return false;
    proveGuardPrefixes(path, state.proven);
    state.methodSafe = true;
    return true;
  }
  if (typeofPath) return false;
  if (path && isGuardPrefix(path, methodPath)) {
    if (!safeGuardLinks(path, state.proven)) return false;
    proveGuardPrefixes(path, state.proven);
    return true;
  }

  // X != null excludes BOTH null and undefined, preserving existing safe namespace guards.
  // X !== undefined does not exclude null, so it must not authorize a dotted method access.
  const nonNull = /^(.+?)\s*!=\s*null$/.exec(raw);
  const prefix = nonNull && parseGuardPath(nonNull[1]);
  if (prefix && isGuardPrefix(prefix, methodPath)) {
    if (!safeGuardLinks(prefix, state.proven)) return false;
    proveGuardPrefixes(prefix, state.proven);
    return true;
  }
  return isNeutralGuardOperand(raw, methodPath, state.proven);
}

function parseGuardPath(raw) {
  if (!/^[A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)*$/.test(raw.trim())) return null;
  const parts = raw.trim().split(/\s*(\?\.|\.)\s*/);
  return {
    names: parts.filter((_, index) => index % 2 === 0),
    optional: parts.filter((_, index) => index % 2 !== 0).map((link) => link === '?.'),
  };
}

function isGuardPrefix(path, methodPath) {
  return path.names.length < methodPath.length && path.names.every((name, index) => name === methodPath[index]);
}

function safeGuardLinks(path, proven) {
  // The context parameter and unrelated identifier roots are assumed present. Each deeper
  // object (for example context.device) needs ?. at its access or an earlier positive proof.
  return path.optional.every((optional, index) => optional || index === 0 || proven.has(path.names.slice(0, index + 1).join('.')));
}

function proveGuardPrefixes(path, proven) {
  for (let length = 1; length <= path.names.length; length += 1) proven.add(path.names.slice(0, length).join('.'));
}

function isNeutralGuardOperand(raw, methodPath, proven) {
  const neutralPath = (value) => {
    const path = parseGuardPath(value);
    if (!path) return false;
    const objectPath = methodPath.slice(0, -1);
    const mentionsObject = objectPath.every((name, index) => path.names[index] === name);
    return !mentionsObject && safeGuardLinks(path, proven);
  };
  // !busy is an existing safe neutral: it neither negates the method proof nor touches its
  // object. Calls, computed paths, arbitrary operators and parenthesized negation stay rejected.
  if (neutralPath(raw.replace(/^!{1,2}\s*/, ''))) return true;
  const comparison = /^(.+?)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)$/.exec(raw);
  if (!comparison) return false;
  const left = comparison[1].trim();
  const right = comparison[3].trim();
  const leftLiteral = isGuardLiteral(left);
  const rightLiteral = isGuardLiteral(right);
  return (leftLiteral || rightLiteral) && (leftLiteral || neutralPath(left)) && (rightLiteral || neutralPath(right));
}

function isGuardLiteral(raw) {
  if (/^(?:true|false|null|undefined|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(raw)) return true;
  const quoted = isQuote(raw[0]) ? readQuotedLiteral(raw, 0) : null;
  return Boolean(quoted && quoted.literal && quoted.end === raw.length);
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

module.exports = {
  scanSource,
  featureCoherence,
  gateSources,
};
