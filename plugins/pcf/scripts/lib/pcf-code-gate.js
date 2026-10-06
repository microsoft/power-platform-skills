'use strict';

const { blankLiterals, blankNonCodePreservingTemplateExpressions, commentRanges, expressionPosition } = require('./source-literals.js');

const BEST_PRACTICES = 'https://learn.microsoft.com/power-apps/developer/component-framework/code-components-best-practices';
const FEATURE_USAGE = 'https://learn.microsoft.com/power-apps/developer/component-framework/manifest-schema-reference/feature-usage';
const RECORD_ID_FAQ = 'https://learn.microsoft.com/power-apps/developer/component-framework/faq#how-can-i-access-the-record-id-or-table-name';
const GRID_CUSTOMIZER = 'https://learn.microsoft.com/power-apps/developer/component-framework/customize-editable-grid-control';

const IDENTIFIER = /[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*/uy;
const IDENTIFIER_CONTINUE = /[$_\u200c\u200d\p{ID_Continue}]/u;
const IDENTIFIER_ESCAPE = /\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/y;
const SOURCE_OPERATOR = /(?:>>>=|\*\*=|&&=|\|\|=|\?\?=|<<=|>>=|===|!==|=>|\?\.|\.\.\.|\+\+|--|==|!=|<=|>=|&&|\|\||\?\?|\*\*|[+\-*/%&|^]=)/y;
const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
const HEAD_MODIFIERS = new Set(['async', 'get', 'set', 'static', 'public', 'private', 'protected', 'readonly', 'abstract', 'override']);
const READ_FOLLOWERS = new Set(['(', ')', ']', '}', ',', ';', '?', ':', '!', '++', '--', '+', '-', '*', '/', '%', '**', '&', '|', '^', '<', '>', '<=', '>=', '==', '!=', '===', '!==', '&&', '||', '??', ...ASSIGNMENT_OPERATORS]);
const READ_PREFIX_WORDS = ['return', 'throw', 'yield', 'await', 'typeof', 'void', 'new', 'delete', 'case', 'else', 'in', 'instanceof', 'as', 'satisfies', 'let', 'const', 'var', 'function', 'class'];
const CONTEXT_NAME = /^_*(?:pcf)?(?:context|ctx)$/i;
const CONTEXT_NAMESPACES = new Set(['device', 'utils', 'webAPI']);
// ASI and postfix updates use all four ECMAScript line terminators, not just LF/CR:
// counter\u2028++context.device is a prefix update on the following line.
// https://tc39.es/ecma262/#sec-line-terminators
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

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

function scanSource(file, text, { controlType, lex = blankNonCodePreservingTemplateExpressions, indexer = indexSource } = {}) {
  const src = String(text || '');
  const lexed = lexSource(file, src, lex);
  if (lexed.finding) return [lexed.finding];
  const mask = lexed.mask;
  const findings = [];
  let index;
  const warn = () => {
    if (!findings.some((finding) => finding.code === 'PCF_CODE_UNPARSEABLE')) {
      findings.push(unparseableFinding(file));
    }
  };
  // An index failure must not suppress independent Xrm, direct-URL or element-id
  // diagnostics. Isolate each check so one unsupported source shape cannot abort a file.
  const check = (analyze) => { try { analyze(); } catch { warn(); } };
  check(() => { index = indexer(src, mask); });

  for (const rule of SOURCE_RULES) {
    check(() => addRegexFindings(findings, rule, file, src, mask));
  }

  if (controlType === 'virtual') {
    check(() => addRegexFindings(findings, {
      code: 'PCF_VIRTUAL_OWN_ROOT',
      re: /ReactDOM\.render\s*\(|createRoot\s*\(/g,
      message: () => `Heuristic diagnostic: virtual PCF controls must not create their own React root; let the platform render the React component instead. See ${BEST_PRACTICES}`,
    }, file, src, mask));
  }

  check(() => addDirectApiFindings(findings, file, src, mask));
  if (index) check(() => addRefreshInUpdateViewFindings(findings, file, src, mask, index));
  check(() => addFixedElementIdFindings(findings, file, src, mask));
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
  let tagEnds;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== '<' || src[i] !== '<' || !/[A-Za-z]/.test(src[i + 1] || '')) continue;
    tagEnds ||= indexJsxTagEnds(src);
    const end = tagEnds[i + 1];
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

function indexJsxTagEnds(text) {
  // a<a<a<... has no tag end. Cache every suffix, including failure, instead of
  // scanning to EOF for each '<'. Each query starts outside quotes/braces; jumping
  // balanced groups still finds a later <div> after an unrelated unmatched '{'.
  const ends = new Int32Array(text.length + 1).fill(-1);
  const braces = new Int32Array(text.length + 1).fill(-1);
  const escaped = new Uint8Array(text.length);
  let slashes = 0;
  for (let i = 0; i < text.length; i += 1) {
    escaped[i] = slashes % 2;
    slashes = text[i] === '\\' ? slashes + 1 : 0;
  }
  const quotes = new Map();
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (isQuote(ch)) {
      const close = quotes.get(ch) ?? -1;
      ends[i] = close < 0 ? -1 : ends[close + 1];
      braces[i] = close < 0 ? -1 : braces[close + 1];
      if (!escaped[i]) quotes.set(ch, i);
    } else if (ch === '{') {
      const close = braces[i + 1];
      ends[i] = close < 0 ? -1 : ends[close + 1];
      braces[i] = close < 0 ? -1 : braces[close + 1];
    } else {
      ends[i] = ch === '>' ? i + 1 : ends[i + 1];
      braces[i] = ch === '}' ? i : braces[i + 1];
    }
  }
  return ends;
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

function addRefreshInUpdateViewFindings(findings, file, src, mask, index) {
  const updateView = /\bupdateView\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g;
  let match;
  while ((match = updateView.exec(mask)) !== null) {
    const open = mask.indexOf('{', match.index);
    const close = index.delimiters.get(open) ?? -1;
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

function featureCoherence(manifestModel, sources, hosts = [], { lex = blankNonCodePreservingTemplateExpressions, indexer = indexSource } = {}) {
  const declared = new Set((manifestModel.features || []).map((feature) => feature.name).filter(Boolean));
  const used = new Set();
  const findings = [];
  const pages = hosts.includes('pages');

  for (const source of sources || []) {
    const file = source.file || '<source>';
    const text = String(source.text || '');
    const lexed = lexSource(file, text, lex);
    if (lexed.finding) findings.push(lexed.finding);
    const mask = lexed.finding ? text : lexed.mask;
    const fileUsed = new Set();
    const start = findings.length;
    const analyze = (index) => {
      collectNamespaceUse({ findings, declared, used: fileUsed, file, text, index, namespace: 'webAPI', feature: 'WebAPI' });
      collectNamespaceUse({ findings, declared, used: fileUsed, file, text, index, namespace: 'utils', feature: 'Utility' });
      collectDeviceUse({ findings, declared, used: fileUsed, file, text, index });
      if (pages) addPagesApiFindings(findings, file, text, index);
    };
    const fallback = () => analyze({ members: fallbackMembers(text, mask), failed: true });
    try {
      if (lexed.finding) {
        // A lexer failure leaves no blanked mask. Raw "// context.device.captureImage()"
        // or a string containing that call may be reported: conservative false positives
        // are preferable to silently authorizing an unparsed file's Pages API use.
        fallback();
      } else analyze(indexer(text, mask));
    } catch {
      // Keep only independent reference detection: no scopes or proof guesses
      // survive a failed analysis. scanSource owns the index-failure warning.
      findings.length = start;
      fileUsed.clear();
      fallback();
    }
    for (const feature of fileUsed) used.add(feature);
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

function collectNamespaceUse({ findings, declared, used, file, text, index, namespace, feature }) {
  for (const member of index.members) {
    if (member.namespace !== namespace) continue;
    used.add(feature);
    if (!declared.has(feature)) {
      findings.push(makeFinding(
        'PCF_FEATURE_UNDECLARED',
        `Heuristic diagnostic: source uses ${member.namespacePath}, but the manifest does not declare '${feature}'; declare the feature or remove the API call. See ${FEATURE_USAGE}`,
        file,
        lineOf(text, member.start),
      ));
    }
  }
}

function collectDeviceUse({ findings, declared, used, file, text, index }) {
  for (const member of index.members) {
    if (member.namespace !== 'device' || !member.method) continue;
    const feature = `Device.${member.method}`;
    used.add(feature);
    if (!declared.has(feature)) {
      findings.push(makeFinding(
        'PCF_FEATURE_UNDECLARED',
        `Heuristic diagnostic: source uses ${member.methodPath}, but the manifest does not declare '${feature}'; declare the method feature or remove the API call. See ${FEATURE_USAGE}`,
        file,
        lineOf(text, member.start),
      ));
    }
  }
}

function addPagesApiFindings(findings, file, text, index) {
  for (const member of index.members) {
    const { namespace, method } = member;
    if (!member.call || !method || !['device', 'utils'].includes(namespace)) continue;
    if (!index.failed && hasMethodGuard(index, member)) continue;
    const guardPath = member.names.slice(0, 2).join('.') + member.names.slice(2).map((name) => `?.${name}`).join('');
    findings.push(makeFinding(
      'PCF_PAGES_API',
      `Heuristic diagnostic: Pages may not provide ${member.methodPath}; ${index.failed ? 'the guard could not be analyzed, so this call is treated as unguarded; ' : ''}guard the call by placing it inside an if (typeof ${guardPath} === 'function') { ... } block (early-return guards and aliases are not recognized), or avoid the API for Pages hosts. See ${FEATURE_USAGE}`,
      file,
      lineOf(text, member.start),
    ));
  }
}

function gateSources({ manifestModel, sources, hosts = [] }, options = {}) {
  const controlType = manifestModel && manifestModel.control ? manifestModel.control.controlType : undefined;
  const { indexer = indexSource } = options;
  const indexes = new Map();
  // Both exports consume the same per-file index. Cache failures too, so feature
  // checks fail closed without retrying a broken analysis. Keep this cache local
  // to one gate invocation rather than retaining a project's source indefinitely.
  const sharedIndexer = (text, mask) => {
    if (!indexes.has(text)) indexes.set(text, new Map());
    const masks = indexes.get(text);
    if (!masks.has(mask)) {
      try { masks.set(mask, { index: indexer(text, mask), failed: false }); }
      catch (error) { masks.set(mask, { error, failed: true }); }
    }
    const analysis = masks.get(mask);
    if (analysis.failed) throw analysis.error;
    return analysis.index;
  };
  const sharedOptions = { ...options, indexer: sharedIndexer };
  const all = [];
  for (const source of sources || []) {
    for (const finding of scanSource(source.file || '<source>', source.text || '', { ...sharedOptions, controlType })) all.push(finding);
  }
  for (const finding of featureCoherence(manifestModel || { features: [] }, sources || [], hosts, sharedOptions)) all.push(finding);
  const errors = all.filter((finding) => finding.severity === 'error');
  // Standalone featureCoherence still reports lexer failures. The combined gate
  // presents only one analyzer warning per file without dropping any API findings.
  const unparseableFiles = new Set();
  const warnings = all.filter((finding) => {
    if (finding.severity !== 'warning') return false;
    if (finding.code !== 'PCF_CODE_UNPARSEABLE') return true;
    if (unparseableFiles.has(finding.file)) return false;
    unparseableFiles.add(finding.file);
    return true;
  });
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

// Thousands of API findings must not rescan the source for each diagnostic.
// Retain only the last text's line starts, bounding memory across multi-file gates.
let lineSource;
let lineStarts;
function lineOf(text, index) {
  if (lineSource !== text) {
    lineSource = text;
    lineStarts = [0];
    for (const match of text.matchAll(/[\n\r\u2028\u2029]/g)) {
      const { index: at } = match;
      if (text[at] === '\n' && text[at - 1] === '\r') continue;
      lineStarts.push(at + (text[at] === '\r' && text[at + 1] === '\n' ? 2 : 1));
    }
  }
  let lo = 0;
  let hi = lineStarts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineStarts[mid] <= index) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
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

function unparseableFinding(file) {
  return makeFinding('PCF_CODE_UNPARSEABLE',
    `Heuristic diagnostic: the PCF source gate could not finish analyzing this file; checks needing the analysis were skipped, and Pages API calls in the file are treated as unguarded. Use valid TypeScript/TSX or simplify the syntax. See ${BEST_PRACTICES}`,
    file, 1);
}

function lexSource(file, text, lex, opts) {
  try {
    return { mask: lex(text, opts), finding: null };
  } catch (err) {
    return {
      mask: '',
      finding: unparseableFinding(file),
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

function identifierAt(text, start) {
  // ECMAScript names are not \w words: $context, context2 and pi-prefixed if are
  // whole names, including astral letters and the permitted join controls.
  // https://tc39.es/ecma262/#sec-names-and-keywords
  let before = start - 1;
  if (before > 0 && /[\udc00-\udfff]/.test(text[before])) before -= 1;
  if (before >= 0 && IDENTIFIER_CONTINUE.test(String.fromCodePoint(text.codePointAt(before)))) return null;
  IDENTIFIER.lastIndex = start;
  const match = IDENTIFIER.exec(text);
  return match ? { value: match[0], start, end: IDENTIFIER.lastIndex } : null;
}

function tokenizeSource(mask) {
  const tokens = [];
  const delimiters = new Map();
  const stack = [];
  const closing = { ')': '(', ']': '[', '}': '{' };
  for (let start = 0; start < mask.length;) {
    if (/\s/.test(mask[start])) { start += 1; continue; }
    const identifier = sourceIdentifierAt(mask, start);
    let end = start + 1;
    let kind = 'punctuation';
    if (identifier) {
      end = identifier.end;
      kind = identifier.kind;
    } else if (mask[start] === '"' || mask[start] === "'") {
      const literal = readQuotedLiteral(mask, start);
      end = literal ? literal.end : mask.length;
      kind = 'string';
    } else if (/\d/.test(mask[start])) {
      while (end < mask.length && /[\d.]/.test(mask[end])) end += 1;
      kind = 'number';
    } else {
      SOURCE_OPERATOR.lastIndex = start;
      const operator = SOURCE_OPERATOR.exec(mask);
      if (operator) end = SOURCE_OPERATOR.lastIndex;
    }
    const value = mask.slice(start, end);
    const name = identifier?.name ?? null;
    const token = { value, name, start, end, kind, parent: stack.at(-1) ?? -1, match: -1 };
    const i = tokens.length;
    tokens.push(token);
    if (['(', '[', '{'].includes(token.value)) stack.push(i);
    else if (closing[token.value] && tokens[stack.at(-1)]?.value === closing[token.value]) {
      const open = stack.pop();
      token.match = open;
      tokens[open].match = i;
      delimiters.set(tokens[open].start, token.start);
      delimiters.set(token.start, tokens[open].start);
    }
    start = end;
  }
  // Angle matching is per delimiter level: <Pair<A, B>> can contain balanced
  // groups, while an unmatched a<a<a<... must return a cached failure in O(1).
  const angles = new Map();
  const levels = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.value === ';') levels.delete(token.parent);
    else if (token.value === '<' || token.value === '>') {
      angles.set(i, -1);
      if (!levels.has(token.parent)) levels.set(token.parent, []);
      const level = levels.get(token.parent);
      if (token.value === '<') level.push(i);
      else if (level.length) {
        const open = level.pop();
        angles.set(open, i);
        angles.set(i, open);
      }
    }
  }
  tokens.angles = angles;
  return { tokens, delimiters };
}

function unrecognizedIdentifierEnd(mask, start) {
  // "\u0063ontext" and "cont\u0065xt" can name context. Keep each escaped
  // identifier whole, but do not pretend the raw-name helper has recognized it.
  // These tokens become opaque binding/write sites, not guessed safe other names.
  let end = start;
  while (end < mask.length) {
    if (mask[end] === '\\') {
      IDENTIFIER_ESCAPE.lastIndex = end;
      if (!IDENTIFIER_ESCAPE.exec(mask)) return end + 1;
      end = IDENTIFIER_ESCAPE.lastIndex;
    } else {
      const point = String.fromCodePoint(mask.codePointAt(end));
      if (!IDENTIFIER_CONTINUE.test(point)) break;
      end += point.length;
    }
  }
  return end;
}

function tokenKeyword(tokens, i, word) {
  // The tokenizer uses the same identifier boundary for roots, members and keywords.
  // A member named if (obj . /* comment */ if) is never a statement head.
  return tokens[i]?.kind === 'identifier' && tokens[i].value === word
    && !['.', '?.'].includes(tokens[i - 1]?.value);
}

function trackedRoot(index, i) {
  const token = index.tokens[i];
  return token?.name && index.roots.has(token.name) && !['.', '?.'].includes(index.tokens[i - 1]?.value) ? token.name : null;
}

function decodeIdentifier(raw) {
  // Raw identifiers include cont\u0065xt and capture\u{49}mage. Decode only valid
  // Unicode escapes for reference detection; raw spelling still drives the guard
  // grammar and unknown binding/target barriers. Never evaluate source text.
  // https://tc39.es/ecma262/#sec-names-and-keywords
  let valid = true;
  const decoded = raw.replace(/\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/g, (escape) => {
    const point = Number.parseInt(escape.startsWith('\\u{') ? escape.slice(3, -1) : escape.slice(2), 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) { valid = false; return ''; }
    return String.fromCodePoint(point);
  });
  const identifier = valid && identifierAt(decoded, 0);
  return identifier && identifier.end === decoded.length ? decoded : null;
}

function sourceIdentifierAt(mask, start) {
  const identifier = identifierAt(mask, start);
  if (identifier && mask[identifier.end] !== '\\') return { ...identifier, name: identifier.value, kind: 'identifier' };
  if (!identifier && mask[start] !== '\\') return null;
  const end = unrecognizedIdentifierEnd(mask, identifier?.end ?? start);
  return { end, name: decodeIdentifier(mask.slice(start, end)), kind: 'unknown-identifier' };
}

function decodeStaticKey(raw) {
  if (!['"', "'"].includes(raw[0]) || raw.at(-1) !== raw[0]) return null;
  let value = '';
  const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };
  for (let i = 1; i < raw.length - 1; i += 1) {
    let ch = raw[i];
    if (ch === '\\') {
      ch = raw[++i];
      if (ch === '\r' || ch === '\n' || ch === '\u2028' || ch === '\u2029') {
        if (ch === '\r' && raw[i + 1] === '\n') i += 1;
        continue;
      }
      // Raw keys include "capture\u0049mage", "\x64evice" and a backslash followed
      // by a newline. Decode string escapes only; never evaluate source or templates.
      // https://tc39.es/ecma262/#sec-literals-string-literals
      if (ch === 'u' || ch === 'x') {
        const braced = ch === 'u' && raw[i + 1] === '{';
        const length = ch === 'u' ? 4 : 2;
        const end = braced ? raw.indexOf('}', i + 2) : i + 1 + length;
        const digits = raw.slice(i + (braced ? 2 : 1), end);
        if (end < 0 || !/^[0-9a-f]+$/i.test(digits) || (!braced && digits.length !== length)) return null;
        const point = Number.parseInt(digits, 16);
        if (point > 0x10ffff || end > raw.length - 1) return null;
        value += String.fromCodePoint(point);
        i = braced ? end : end - 1;
        continue;
      }
      if (!ch || (/\d/.test(ch) && (ch !== '0' || /\d/.test(raw[i + 1])))) return null;
      value += Object.hasOwn(simple, ch) ? simple[ch] : ch;
    } else {
      if (/[\n\r\u2028\u2029]/.test(ch)) return null;
      value += ch;
    }
  }
  const identifier = identifierAt(value, 0);
  return identifier && identifier.end === value.length ? value : null;
}

function indexedPath(index, start) {
  if (index.paths.has(start)) return index.paths.get(start);
  const { tokens, text } = index;
  const names = [tokens[start].name || tokens[start].value];
  let end = start + 1;
  let unknown = false;
  while (end < tokens.length) {
    // Postfix ! is erased ONLY in this detection view. != / !== are whole operator
    // tokens; a prefix ! is outside the path. The guard grammar still sees the raw !.
    let asserted = end;
    while (tokens[asserted]?.value === '!') asserted += 1;
    if (['.', '?.', '[', '('].includes(tokens[asserted]?.value)) end = asserted;
    let member = end;
    if (['.', '?.'].includes(tokens[member]?.value)) member += 1;
    else if (tokens[member]?.value !== '[') break;
    if (tokens[member]?.name && member !== end) {
      names.push(tokens[member].name);
      end = member + 1;
      continue;
    }
    if (tokens[member]?.value === '[' && tokens[member].match >= 0) {
      const close = tokens[member].match;
      const key = close === member + 2 && tokens[member + 1].kind === 'string'
        ? decodeStaticKey(text.slice(tokens[member + 1].start, tokens[member + 1].end)) : null;
      end = close + 1;
      if (!key) { unknown = true; break; }
      names.push(key);
      continue;
    }
    break;
  }
  const call = tokens[end]?.value === '(' || (tokens[end]?.value === '?.' && tokens[end + 1]?.value === '(');
  const path = { names, end, unknown, call, token: start, start: tokens[start].start };
  index.paths.set(start, path);
  return path;
}

function angleBoundary(tokens, start, direction) {
  if (tokens[start]?.value !== (direction === 1 ? '<' : '>')) return -1;
  return tokens.angles.get(start) ?? -1;
}

function typedHeadBody(tokens, close) {
  let i = close + 1;
  if (tokens[i]?.value !== ':') return tokens[i]?.value === '{' ? i : -1;
  let needsType = true;
  for (i += 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.value === '{' && !needsType) return i;
    if (['(', '[', '{', '<'].includes(token.value)) {
      const end = token.value === '<' ? angleBoundary(tokens, i, 1) : token.match;
      if (end < 0) return -1;
      i = end;
      needsType = false;
    } else if (['identifier', 'string', 'number'].includes(token.kind)) needsType = false;
    else if (['.', '|', '&', '?', ':'].includes(token.value)) needsType = true;
    else return -1;
  }
  return -1;
}

function arrowHead(tokens, arrow) {
  const beforeExpression = (i) => i < 0 || ['=', '(', '[', '{', ',', ':', ';', '=>'].includes(tokens[i].value)
    || ['return', 'yield', 'default'].some((word) => tokenKeyword(tokens, i, word));
  let start = arrow - 1;
  if (tokens[start]?.kind === 'identifier'
    && !(tokens[start - 1]?.value === ':' && tokens[start - 2]?.value === ')')
    && (beforeExpression(start - 1) || tokenKeyword(tokens, start - 1, 'async'))) {
    if (tokenKeyword(tokens, start - 1, 'async')) start -= 1;
    return beforeExpression(start - 1) ? start : -1;
  }
  for (let i = arrow - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token.value === ')' && token.match >= 0) {
      if (i === arrow - 1 || tokens[i + 1]?.value === ':') { start = token.match; break; }
      i = token.match;
    } else if (['}', ']'].includes(token.value) && token.match >= 0) i = token.match;
    else if (token.value === '>') {
      i = angleBoundary(tokens, i, -1);
      if (i < 0) return -1;
    } else if ([';', '=', '=>', ','].includes(token.value)) return -1;
    start = -1;
  }
  if (start < 0) return -1;
  if (tokens[start - 1]?.value === '>') {
    start = angleBoundary(tokens, start - 1, -1);
    if (start < 0) return -1;
  }
  if (tokenKeyword(tokens, start - 1, 'async')) start -= 1;
  return beforeExpression(start - 1) ? start : -1;
}

function canEndOperand(index, i) {
  const token = index.tokens[i];
  if (!token) return false;
  if (token.name) {
    return !['return', 'throw', 'yield', 'await', 'delete', 'typeof', 'void', 'new', 'else', 'do', 'case', 'in', 'of']
      .some((word) => tokenKeyword(index.tokens, i, word));
  }
  if (token.value === ')') return !index.controlCloses.has(i);
  if (token.value === '}') return index.containers.has(token.match);
  return ['string', 'number'].includes(token.kind) || token.value === ']' || token.value === '!';
}

function indexedExpressionEnd(index, start, stopAtComma = true) {
  const { tokens, mask } = index;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if ([';', ')', ']', '}'].includes(token.value) || (stopAtComma && token.value === ',')) return i;
    if (i > start && LINE_TERMINATOR.test(mask.slice(tokens[i - 1].end, token.start)) && canEndOperand(index, i - 1)
      && ((token.name && !['as', 'satisfies', 'in', 'instanceof'].some((word) => tokenKeyword(tokens, i, word)))
        || ['string', 'number'].includes(token.kind) || ['++', '--', '!', '~'].includes(token.value))) return i;
    if (['(', '[', '{'].includes(token.value) && token.match >= 0) i = token.match;
    else if (token.value === '<' && canEndOperand(index, i - 1)) {
      const close = angleBoundary(tokens, i, 1);
      if (close >= 0 && tokens[close + 1]?.value === '(') i = close;
    }
  }
  return tokens.length;
}

function indexedStatementEnd(index, start) {
  const { tokens } = index;
  // for(;;)for(;;)...consume(1) has input-sized statement depth. Complete child
  // statements with explicit frames, caching every end (including dangling else).
  const pending = [{ start, stage: 0 }];
  let end = tokens.length;
  while (pending.length) {
    const frame = pending.at(-1);
    const from = frame.start;
    if (index.statements.has(from)) {
      end = index.statements.get(from);
      pending.pop();
    } else if (frame.stage === 1 && tokenKeyword(tokens, from, 'if') && tokenKeyword(tokens, end, 'else')) {
      frame.stage = 2;
      pending.push({ start: end + 1, stage: 0 });
    } else if (frame.stage > 0) {
      index.statements.set(from, end);
      pending.pop();
    } else if (['if', 'for', 'while', 'with'].some((word) => tokenKeyword(tokens, from, word))
      && tokens[from + 1]?.value === '(' && tokens[from + 1].match >= 0) {
      frame.stage = 1;
      pending.push({ start: tokens[from + 1].match + 1, stage: 0 });
    } else {
      end = tokens[from]?.value === '{' && tokens[from].match >= 0
        ? tokens[from].match + 1 : indexedExpressionEnd(index, from, false);
      if (tokens[end]?.value === ';') end += 1;
      index.statements.set(from, end);
      pending.pop();
    }
  }
  return end;
}

function indexHeads(index) {
  const { tokens } = index;
  const heads = [];
  const bodies = new Map();
  const headTokens = new Set();
  const controls = [];
  const containers = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].value === '{' && (['=', '(', '[', ',', ':'].includes(tokens[i - 1]?.value) || tokenKeyword(tokens, i - 1, 'return'))) containers.add(i);
  }
  const inContainer = (i) => containers.has(tokens[i]?.parent);
  const inMethodPosition = (i) => {
    if (!inContainer(i)) return false;
    while (tokens[i - 1]?.value === '*' || (tokens[i - 1]?.kind === 'identifier' && HEAD_MODIFIERS.has(tokens[i - 1].value))) i -= 1;
    return ['{', '}', ',', ';'].includes(tokens[i - 1]?.value);
  };
  const addHead = (head) => {
    if (head.body < 0 || bodies.has(head.body)) return;
    heads.push(head);
    bodies.set(head.body, head);
    head.roots = new Set();
    for (let i = head.start; i < head.body; i += 1) {
      headTokens.add(i);
      if (index.roots.has(tokens[i].value) && tokens[i].kind === 'identifier') head.roots.add(tokens[i].value);
      if (tokens[i].kind === 'unknown-identifier') {
        for (const root of index.roots) head.roots.add(root);
        head.unknownBinding = true;
      }
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokenKeyword(tokens, i, 'function') && !inMethodPosition(i)) {
      let next = i + 1;
      if (tokens[next]?.value === '*') next += 1;
      const name = ['identifier', 'unknown-identifier'].includes(tokens[next]?.kind) ? next++ : -1;
      if (tokens[next]?.value === '<') {
        next = angleBoundary(tokens, next, 1);
        if (next < 0) continue;
        next += 1;
      }
      if (tokens[next]?.value !== '(' || tokens[next].match < 0) continue;
      const body = typedHeadBody(tokens, tokens[next].match);
      addHead({ kind: 'function', arrow: false, start: tokenKeyword(tokens, i - 1, 'async') ? i - 1 : i, keyword: i, name, parameters: next, body });
    } else if (tokenKeyword(tokens, i, 'class') && !inMethodPosition(i)) {
      let body = i + 1;
      const name = ['identifier', 'unknown-identifier'].includes(tokens[body]?.kind) ? body++ : -1;
      for (; body < tokens.length && tokens[body].value !== '{'; body += 1) {
        if ([';', '=', '=>'].includes(tokens[body].value)) { body = -1; break; }
        if (['(', '['].includes(tokens[body].value) && tokens[body].match >= 0) body = tokens[body].match;
        else if (tokens[body].value === '<') {
          body = angleBoundary(tokens, body, 1);
          if (body < 0) break;
        }
      }
      if (body >= 0 && tokens[body]?.value === '{') {
        containers.add(body);
        addHead({ kind: 'class', arrow: false, start: i, keyword: i, name, body });
      }
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].value === '=>') {
      const start = arrowHead(tokens, i);
      const body = i + 1;
      let parameters = start;
      if (tokenKeyword(tokens, parameters, 'async')) parameters += 1;
      if (tokens[parameters]?.value === '<') parameters = angleBoundary(tokens, parameters, 1) + 1;
      if (tokens[body]) addHead({ kind: start < 0 ? 'opaque' : 'function', arrow: true, start: start < 0 ? i : start,
        parameters: start < 0 ? -1 : parameters, body });
    } else if (!inMethodPosition(i) && ['if', 'for', 'while', 'switch', 'with', 'catch'].some((word) => tokenKeyword(tokens, i, word))) {
      const open = i + 1;
      const close = tokens[open]?.value === '(' ? tokens[open].match : -1;
      const body = close < 0 ? open : close + 1;
      if (tokenKeyword(tokens, i, 'catch') && tokens[body]?.value === '{') addHead({ kind: 'catch', arrow: false, start: i, parameters: close < 0 ? -1 : open, body });
      else if (close >= 0) {
        let targetEnd = -1;
        if (tokenKeyword(tokens, i, 'for')) {
          for (let j = open + 1; j < close; j += 1) {
            if (tokens[j].parent === open && ['of', 'in'].some((word) => tokenKeyword(tokens, j, word))) { targetEnd = j; break; }
          }
        }
        controls.push({ keyword: i, open, close, body, kind: tokens[i].value, targetEnd });
      }
    }
  }
  for (let open = 0; open < tokens.length; open += 1) {
    if (tokens[open].value !== '(' || tokens[open].match < 0 || !inContainer(open)) continue;
    const body = typedHeadBody(tokens, tokens[open].match);
    if (body < 0 || bodies.has(body)) continue;
    let name = open - 1;
    if (tokens[name]?.value === '>') {
      name = angleBoundary(tokens, name, -1) - 1;
      if (name < 0) continue;
    }
    let start = name;
    if (tokens[name]?.value === ']' && tokens[name].match >= 0) start = tokens[name].match;
    else if (!['identifier', 'string', 'number'].includes(tokens[name]?.kind)) continue;
    while (tokens[start - 1]?.value === '*' || (tokens[start - 1]?.kind === 'identifier' && HEAD_MODIFIERS.has(tokens[start - 1].value))) start -= 1;
    if (!['{', '}', ',', ';'].includes(tokens[start - 1]?.value)) continue;
    addHead({ kind: 'function', arrow: false, start, parameters: open, method: true, body });
  }
  return { heads, bodies, headTokens, controls, containers, controlCloses: new Set(controls.map((control) => control.close)) };
}

function indexScopes(index) {
  const { tokens, heads, bodies, controls, containers } = index;
  const scopes = [{ kind: 'program', start: 0, body: 0, end: index.mask.length, roots: new Set() }];
  const blockScopes = new Map();
  const controlBodies = new Set(controls.map((control) => control.body));
  for (const head of heads) {
    if (head.kind !== 'class') continue;
    // In class context extends (context = next, Base), the private class name is
    // already in scope in the heritage expression; this still belongs to the outer
    // receiver. Keep that name environment separate from the class body's this.
    // https://tc39.es/ecma262/#sec-runtime-semantics-classdefinitionevaluation
    head.headScope = { kind: 'class-head', start: tokens[head.start].start, body: tokens[head.start].start,
      end: tokens[head.body].start, roots: new Set() };
    scopes.push(head.headScope);
  }
  const makeScope = (head, body, end) => ({
    // Class heritage and computed method keys keep the containing this binding,
    // not the new class/method's this binding. Parameter defaults do belong
    // to the function scope, where actual parameter bindings can shadow the root.
    kind: head.kind, start: tokens[head.kind === 'class' ? body : head.method ? head.parameters : head.start].start,
    body: tokens[body].start, end,
    roots: head.roots, arrow: head.arrow, head,
  });
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].value !== '{' || index.patternContainers.has(i)) continue;
    const head = bodies.get(i);
    const end = tokens[i].match < 0 ? index.mask.length : tokens[tokens[i].match].end;
    const classStatic = tokenKeyword(tokens, i - 1, 'static') && bodies.get(tokens[i].parent)?.kind === 'class';
    const knownBlock = controlBodies.has(i) || ['{', '}', ';'].includes(tokens[i - 1]?.value)
      || ['else', 'try', 'finally', 'do'].some((word) => tokenKeyword(tokens, i - 1, word))
      || classStatic || i === 0;
    const scope = head ? makeScope(head, i, end) : {
      kind: classStatic ? 'static' : containers.has(i) ? 'object' : knownBlock ? 'block' : 'opaque',
      start: tokens[i].start, body: tokens[i].start, end, roots: new Set(),
    };
    if (tokens[i].match < 0) scope.kind = 'opaque';
    scopes.push(scope);
    blockScopes.set(i, scope);
    if (head) head.scope = scope;
  }
  for (const head of heads) {
    if (tokens[head.body]?.value === '{') continue;
    const end = indexedExpressionEnd(index, head.body);
    const scope = makeScope(head, head.body, tokens[end]?.start ?? index.mask.length);
    scopes.push(scope);
    head.scope = scope;
  }
  for (const control of controls) {
    if (control.kind !== 'for') continue;
    const end = indexedStatementEnd(index, control.body);
    const scope = { kind: 'loop', start: tokens[control.keyword].start, body: tokens[control.body]?.start ?? index.mask.length,
      end: tokens[end]?.start ?? index.mask.length, roots: new Set(), control };
    scopes.push(scope);
    control.scope = scope;
    for (let i = control.open + 1; i < control.close; i += 1) tokens[i].loop = control;
  }
  scopes.sort((a, b) => a.start - b.start || b.end - a.end);
  // A comment-only or JSX-text-only mask has no token events, but still needs the
  // program binding table. It must scan cleanly rather than throw during indexing.
  Object.assign(scopes[0], { id: 0, parent: null, declarations: new Map(), writes: new Map() });
  scopes[0].function = scopes[0];
  const active = [];
  let next = 0;
  for (const token of tokens) {
    while (active.length && active.at(-1).end <= token.start) active.pop();
    while (next < scopes.length && scopes[next].start <= token.start) {
      const scope = scopes[next++];
      while (active.length && active.at(-1).end <= scope.start) active.pop();
      scope.id = next - 1;
      scope.parent = active.at(-1) || null;
      scope.declarations = new Map();
      scope.writes = new Map();
      // A static block owns its var/function declarations; var context inside it
      // must not shadow or write context outside the class.
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes/Static_initialization_blocks
      scope.function = ['program', 'function', 'opaque', 'static'].includes(scope.kind) ? scope : scope.parent?.function;
      scope.parentFunction = scope.parent?.function;
      active.push(scope);
    }
    token.scope = active.at(-1) || scopes[0];
  }
  index.scopes = scopes;
  index.blockScopes = blockScopes;
}

function topLevelTokenRanges(tokens, start, end, separator) {
  const ranges = [];
  let from = start;
  for (let i = start; i < end; i += 1) {
    if (tokens[i].value === separator) { ranges.push([from, i]); from = i + 1; }
    else if (['(', '[', '{'].includes(tokens[i].value) && tokens[i].match >= 0) i = tokens[i].match;
  }
  ranges.push([from, end]);
  return ranges;
}

function patternTargetRanges(index, start, end) {
  // { context: item } binds item, but { current: context }, [context] and ...context
  // bind context. Defaults' RHS values are reads. This one classifier serves both
  // declarations and destructuring writes; function heads instead reject ANY root mention.
  const { tokens } = index;
  const pending = [[start, end]];
  const targets = [];
  while (pending.length) {
    let [from, to] = pending.pop();
    if (tokens[from]?.value === '...') from += 1;
    to = topLevelTokenRanges(tokens, from, to, '=')[0][1];
    const token = tokens[from];
    if (!token || from >= to) continue;
    if (['{', '['].includes(token.value) && token.match >= 0 && token.match < to) {
      index.patternContainers.add(from);
      for (const [entry, entryEnd] of topLevelTokenRanges(tokens, from + 1, token.match, ',')) {
        const colon = token.value === '{' ? topLevelTokenRanges(tokens, entry, entryEnd, ':')[0][1] : entryEnd;
        if (colon < entryEnd) {
          // In { context: item } the key is inert, but { [context.device = x]: item }
          // executes its computed key; those writes must remain visible to the proof.
          if (tokens[entry]?.value !== '[') {
            for (let i = entry; i < colon; i += 1) index.patternKeys.add(i);
          }
          pending.push([colon + 1, entryEnd]);
        } else pending.push([entry, entryEnd]);
      }
    } else targets.push([from, to]);
  }
  return targets;
}

function patternTargets(index, start, end) {
  return patternTargetRanges(index, start, end)
    .filter(([from]) => ['identifier', 'unknown-identifier'].includes(index.tokens[from].kind))
    .map(([from]) => from);
}

function indexPatterns(index) {
  const { tokens } = index;
  // Binding braces are not executable blocks. Only their default RHS expressions
  // run, e.g. const { image = context.device.captureImage() } = {} in the outer guard.
  for (const head of index.heads) {
    head.parameterTargets = [];
    const open = head.parameters;
    if (open === undefined) continue;
    const close = tokens[open]?.value === '(' ? tokens[open].match : open + 1;
    if (open < 0 || close < 0) continue;
    const from = tokens[open]?.value === '(' ? open + 1 : open;
    for (const [start, end] of topLevelTokenRanges(tokens, from, close, ',')) {
      for (const target of patternTargets(index, start, end)) head.parameterTargets.push(target);
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (['let', 'const', 'var'].some((word) => tokenKeyword(tokens, i, word))) {
      const open = i + 1;
      if (['{', '['].includes(tokens[open]?.value) && tokens[open].match >= 0) patternTargets(index, open, tokens[open].match + 1);
    } else if (tokens[i].value === '=' && ['}', ']'].includes(tokens[i - 1]?.value) && tokens[i - 1].match >= 0) {
      patternTargets(index, tokens[i - 1].match, i);
    }
  }
}

function addDeclaration(scope, root, position) {
  if (root === 'this' || !scope) return;
  if (!scope.declarations.has(root)) scope.declarations.set(root, []);
  scope.declarations.get(root).push(position);
}

function indexRootRoles(index) {
  const { tokens, mask } = index;
  for (let i = 0; i < tokens.length; i += 1) {
    const root = trackedRoot(index, i);
    if (!root) continue;
    if (index.patternKeys.has(i)) continue;
    const token = tokens[i];
    const path = indexedPath(index, i);
    const next = tokens[path.end];
    const previous = tokens[i - 1];
    const classSlot = token.scope.kind === 'class' && (['{', '}', ';'].includes(previous?.value)
      || ['public', 'private', 'protected', 'static', 'readonly', 'declare', 'abstract', 'override', 'accessor'].some((word) => tokenKeyword(tokens, i - 1, word)));
    const memberName = path.names.length === 1 && ((token.scope.kind === 'object' && next?.value === ':')
      || (classSlot && ['=', ':', ';', '?', '!'].includes(next?.value)));
    if (memberName) { index.rootRoles.set(i, 'member'); continue; }
    const unknownPrefix = previous?.kind === 'identifier'
      && !LINE_TERMINATOR.test(mask.slice(previous.end, token.start))
      && !READ_PREFIX_WORDS.some((word) => tokenKeyword(tokens, i - 1, word))
      && !(token.loop && tokenKeyword(tokens, i - 1, 'of'));
    const knownSuffix = !next || READ_FOLLOWERS.has(next.value)
      || ['as', 'satisfies', 'in', 'instanceof'].some((word) => tokenKeyword(tokens, path.end, word))
      || (token.loop && tokenKeyword(tokens, path.end, 'of'))
      || (next.value === '?.' && tokens[path.end + 1]?.value === '(')
      || LINE_TERMINATOR.test(mask.slice(tokens[path.end - 1].end, next.start));
    // Reads are positively classified, not the default. "await using context = x"
    // is an unfamiliar binding head, so conservatively shadow its entire block,
    // including calls before that declaration; an unknown operator expires later proofs.
    if (unknownPrefix && root !== 'this') addDeclaration(token.scope, root, token.start);
    index.rootRoles.set(i, unknownPrefix || !knownSuffix ? 'unknown' : 'read');
  }
}

function indexDeclarations(index) {
  const { tokens } = index;
  for (const head of index.heads) {
    for (const target of head.parameterTargets) {
      const roots = tokens[target].kind === 'unknown-identifier' ? index.roots : [tokens[target].value];
      for (const root of roots) if (index.roots.has(root)) addDeclaration(head.scope, root, tokens[target].start);
    }
  }
  const namedHeads = new Map(index.heads.filter((head) => head.keyword !== undefined).map((head) => [head.keyword, head]));
  for (let i = 0; i < tokens.length; i += 1) {
    if (!['class', 'function'].some((word) => tokenKeyword(tokens, i, word))) continue;
    let name = i + 1;
    if (tokens[name]?.value === '*') name += 1;
    if (!['identifier', 'unknown-identifier'].includes(tokens[name]?.kind)) continue;
    const head = namedHeads.get(i);
    const unknownName = tokens[name].kind === 'unknown-identifier' || (tokens[i].value === 'class' && head?.unknownBinding);
    if (!index.roots.has(tokens[name].value) && !unknownName) continue;
    const previous = tokens[(head?.start ?? i) - 1]?.value;
    // Only a recognized expression position makes a named function/class private to
    // that expression. An unfamiliar declaration head (decorators, overloads, etc.)
    // must not hide a hoisted or lexical root binding from an earlier call.
    const previousIndex = (head?.start ?? i) - 1;
    const declaration = !['=', '(', '[', ',', ':', '?', '=>', '||', '&&', '??'].includes(previous)
      && !['return', 'yield', 'new'].some((word) => tokenKeyword(tokens, previousIndex, word));
    const owner = declaration
      ? tokens[i].value === 'function' ? head?.scope?.parentFunction || tokens[i].scope.function : head?.scope?.parent || tokens[i].scope
      : head?.scope;
    for (const root of unknownName ? index.roots : [tokens[name].value]) {
      addDeclaration(owner || tokens[i].scope, root, tokens[i].start);
      if (head?.headScope) {
        addDeclaration(head.headScope, root, tokens[i].start);
        if (owner !== head.scope) addDeclaration(head.scope, root, tokens[i].start);
      }
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (!['let', 'const', 'var'].some((word) => tokenKeyword(tokens, i, word))) continue;
    const owner = tokens[i].value === 'var' ? tokens[i].scope.function : tokens[i].loop?.scope || tokens[i].scope;
    let from = i + 1;
    while (from < tokens.length) {
      const pattern = tokens[from];
      if (!pattern || (!['{', '['].includes(pattern.value) && !['identifier', 'unknown-identifier'].includes(pattern.kind))) break;
      const end = ['{', '['].includes(pattern.value) ? pattern.match + 1 : from + 1;
      if (end <= from) break;
      for (const target of patternTargets(index, from, end)) {
        for (const root of tokens[target].kind === 'unknown-identifier' ? index.roots : [tokens[target].value]) {
          if (index.roots.has(root)) addDeclaration(owner, root, tokens[i].start);
        }
      }
      let next = end;
      // A type annotation and an initializer belong to this declarator, not to the next
      // statement. Balanced groups are skipped, and ASI "let context\ncontext.device..."
      // needs no semicolon to establish the binding.
      if (tokens[next]?.value === ':') {
        for (next += 1; next < tokens.length; next += 1) {
          if (['=', ',', ';', ')', '}'].includes(tokens[next].value)) break;
          if (['(', '[', '{', '<'].includes(tokens[next].value)) {
            const close = tokens[next].value === '<' ? angleBoundary(tokens, next, 1) : tokens[next].match;
            if (close < 0) break;
            next = close;
          }
        }
      }
      if (tokens[next]?.value === '=') next = indexedExpressionEnd(index, next + 1);
      if (tokens[next]?.value !== ',') break;
      from = next + 1;
    }
  }
  indexRootRoles(index);
  for (const scope of index.scopes) {
    scope.bindings = new Map();
    for (const positions of scope.declarations.values()) positions.sort((a, b) => a - b);
  }
}

function bindingFor(scope, root) {
  // function f0(p0) {...} function f1(p1) {...} introduces many unrelated roots.
  // Copying all roots into every scope is quadratic. Resolve only actual proof/write
  // uses, memoizing each visited scope so deep callback chains are walked once per root.
  const pending = [];
  let binding;
  for (let owner = scope; owner; owner = owner.parent) {
    if (owner.bindings.has(root)) { binding = owner.bindings.get(root); break; }
    pending.push(owner);
    if (!owner.parent || owner.declarations.has(root) || owner.kind === 'opaque'
      || (root === 'this' && (owner.kind === 'class' || (owner.kind === 'function' && !owner.arrow)))) {
      binding = owner.id;
      break;
    }
  }
  for (const owner of pending) owner.bindings.set(root, binding);
  return binding;
}

function addIndexedWrite(index, tokenIndex, path, uncertain = false) {
  const token = index.tokens[tokenIndex];
  if (index.patternKeys.has(tokenIndex) || index.rootRoles.get(tokenIndex) === 'member') return;
  const root = path.names[0];
  // context.device[key] may replace any child, but captureImage[key] does not
  // replace captureImage itself. Keep child-only expiry distinct from a prefix write.
  const key = `${bindingFor(token.scope, root)}:${uncertain ? root : path.names.join('.')}${path.computed && !uncertain ? '.*' : ''}`;
  // Writes are lexical and keyed by the actual binding, not the callback that
  // contains them: () => { context = next } expires later outer/sibling calls too,
  // while (context) => { context = next } writes only its shadowing parameter.
  const writes = index.writes;
  if (!writes.has(key)) writes.set(key, []);
  writes.get(key).push(token.start);
}

function indexedOperandStart(index, end) {
  const { tokens } = index;
  let start = end;
  while (start >= 0) {
    if (tokens[start].value === '!') { start -= 1; continue; }
    if ([')', ']', '}'].includes(tokens[start].value) && tokens[start].match >= 0) start = tokens[start].match;
    if (['.', '?.'].includes(tokens[start - 1]?.value)) { start -= 2; continue; }
    if (['(', '['].includes(tokens[start]?.value) && canEndOperand(index, start - 1)) { start -= 1; continue; }
    break;
  }
  return Math.max(0, start);
}

function indexedOperandEnd(index, start) {
  return indexedWritePath(index, start).end;
}

function indexedWritePath(index, start) {
  // cache[context.device].get(context).pending writes cache, not the key/argument
  // reads. Only leading dot members identify a protected path; computed members
  // can replace any child, and a call result is opaque rather than the root itself.
  // Jump indexed groups so their internal expressions are classified separately.
  const { tokens } = index;
  const token = tokens[start];
  const names = token?.name ? [token.name] : [];
  let recognized = token?.kind === 'identifier';
  let end = start + 1;
  let computed = false;
  let call = false;
  let lastCall = false;
  if (['(', '[', '{'].includes(token?.value) && token.match >= 0) end = token.match + 1;
  while (end < tokens.length) {
    if (tokens[end].value === '!') { end += 1; continue; }
    const access = tokens[end].value;
    let member = end;
    if (['.', '?.'].includes(access)) member += 1;
    if (member !== end && ['identifier', 'unknown-identifier'].includes(tokens[member]?.kind)) {
      if (tokens[member].kind !== 'identifier') recognized = false;
      if (!computed && !call) names.push(tokens[member].name || tokens[member].value);
      end = member + 1;
      lastCall = false;
    } else if (access !== '.' && ['[', '('].includes(tokens[member]?.value)) {
      const group = tokens[member];
      if (group.match < 0) { recognized = false; end = member + 1; break; }
      if (group.value === '[') computed = true;
      else call = true;
      lastCall = group.value === '(';
      end = group.match + 1;
    } else {
      if (member !== end) { recognized = false; end = member; }
      break;
    }
  }
  return { names, end, computed, call, recognized: recognized && !lastCall };
}

function indexWriteTarget(index, start, end) {
  const { tokens } = index;
  if (start >= end) return;
  if (['let', 'const', 'var'].some((word) => tokenKeyword(tokens, start, word))) start += 1;
  const targets = ['{', '['].includes(tokens[start]?.value) && tokens[start].match === end - 1
    ? patternTargetRanges(index, start, end) : [[start, end]];
  for (const [from, to] of targets) {
    const path = indexedWritePath(index, from);
    if (path.end === to && path.recognized) {
      if (!path.call && trackedRoot(index, from)) addIndexedWrite(index, from, path);
      continue;
    }
    // (context).device and (a, context).device are unfamiliar targets. Expire only
    // tracked roots actually inside them, not unrelated guards elsewhere in the file.
    for (let i = from; i < to; i += 1) {
      const root = trackedRoot(index, i);
      if (root) addIndexedWrite(index, i, { names: [root] }, true);
    }
  }
}

function indexWrites(index) {
  const { tokens } = index;
  for (const control of index.controls) {
    if (control.kind === 'for' && control.targetEnd >= 0) indexWriteTarget(index, control.open + 1, control.targetEnd);
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (ASSIGNMENT_OPERATORS.has(token.value) && i > 0) indexWriteTarget(index, indexedOperandStart(index, i - 1), i);
    else if (tokenKeyword(tokens, i, 'delete')) indexWriteTarget(index, i + 1, indexedOperandEnd(index, i + 1));
    else if (['++', '--'].includes(token.value)) {
      const postfix = canEndOperand(index, i - 1) && !LINE_TERMINATOR.test(index.mask.slice(tokens[i - 1].end, token.start));
      if (postfix) indexWriteTarget(index, indexedOperandStart(index, i - 1), i);
      else indexWriteTarget(index, i + 1, indexedOperandEnd(index, i + 1));
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!trackedRoot(index, i) || index.patternKeys.has(i)) continue;
    const path = indexedPath(index, i);
    if (index.rootRoles.get(i) === 'unknown') addIndexedWrite(index, i, path, true);
  }
  for (const positions of index.writes.values()) positions.sort((a, b) => a - b);
}

function indexSource(text, mask) {
  // One offset-preserving token/delimiter pass feeds every scope, binding and write
  // lookup. In particular, 2500 nested run(() => { ... }) blocks are not rebalanced
  // for each Pages call. This is a conservative index, not a JavaScript parser:
  // only recognized heads keep a binding; an opaque body creates a proof barrier.
  const index = { ...tokenizeSource(mask), text, mask, paths: new Map(), patternKeys: new Set(), patternContainers: new Set(),
    rootRoles: new Map(), statements: new Map(), writes: new Map() };
  index.members = indexedMembers(index);
  index.roots = new Set(['context', 'this', ...index.members.map((member) => member.names[0])]);
  Object.assign(index, indexHeads(index));
  indexPatterns(index);
  indexScopes(index);
  indexDeclarations(index);
  indexWrites(index);
  index.members = indexedMembers(index);
  const methods = new Map(index.members.filter((member) => member.call && ['device', 'utils'].includes(member.namespace))
    .map((member) => [member.names.join('.'), member.names]));
  for (const control of index.controls) {
    if (control.kind !== 'if' || index.tokens[control.body]?.value !== '{' || index.tokens[control.body].match < 0) continue;
    const scope = index.blockScopes.get(control.body);
    if (!scope) continue;
    const start = index.tokens[control.open].end;
    const end = index.tokens[control.close].start;
    const raw = withoutComments(text.slice(start, end));
    const proofs = new Set();
    const candidates = new Set();
    for (let i = control.open + 1; i < control.close; i += 1) {
      const path = index.paths.get(i);
      if (path && methods.has(path.names.join('.'))) candidates.add(path.names.join('.'));
    }
    for (const key of candidates) {
      if (provePositiveCondition(raw, mask.slice(start, end), methods.get(key), index.delimiters, start)) proofs.add(key);
    }
    const owner = index.tokens[control.keyword].scope;
    scope.guard = { start: index.tokens[control.keyword].start, proofs, owner };
  }
  return index;
}

function indexedMembers(index) {
  const members = [];
  for (let i = 0; i < index.tokens.length; i += 1) {
    if (!index.tokens[i].name || ['.', '?.'].includes(index.tokens[i - 1]?.value)
      || index.rootRoles?.get(i) === 'member') continue;
    const path = indexedPath(index, i);
    const member = contextMember(path);
    if (member) members.push(member);
  }
  return members;
}

function contextMember(path) {
  // Only the name immediately before the namespace matters: props.context.device
  // and this._ctx.utils count, but this.state.device and helpers.utils do not.
  const namespaceIndex = path.names.findIndex((name, i) => i > 0 && CONTEXT_NAMESPACES.has(name) && CONTEXT_NAME.test(path.names[i - 1]));
  if (namespaceIndex < 0) return null;
  return { ...path, namespace: path.names[namespaceIndex], method: path.names[namespaceIndex + 1],
    namespacePath: path.names.slice(0, namespaceIndex + 1).join('.'),
    methodPath: path.names.slice(0, namespaceIndex + 2).join('.'),
    call: path.call && !path.unknown && path.names.length === namespaceIndex + 2 };
}

function skipSourceSpace(mask, start) {
  while (start < mask.length && /\s/.test(mask[start])) start += 1;
  return start;
}

function fallbackMembers(text, mask) {
  // This independent linear regex detector runs only after an index failure.
  // Read each reference once, advancing past consumed members, on the blanked mask:
  //   props.context?.device["captureImage"]!!()
  // Quoted static keys are decoded from the original offsets, never evaluated.
  // No delimiter, scope, declaration or guard analysis is retried here.
  const roots = new RegExp(`${IDENTIFIER.source}|\\\\`, 'gu');
  const members = [];
  let match;
  while ((match = roots.exec(mask)) !== null) {
    const root = sourceIdentifierAt(mask, match.index);
    if (!root) continue;
    roots.lastIndex = root.end;
    if (!root.name || previousNonSpace(mask, match.index) === '.') continue;
    const names = [root.name];
    let end = root.end;
    let unknown = false;
    while (end < mask.length) {
      let next = skipSourceSpace(mask, end);
      let asserted = next;
      while (mask[asserted] === '!') asserted = skipSourceSpace(mask, asserted + 1);
      if (['.', '[', '('].includes(mask[asserted]) || mask.startsWith('?.', asserted)) next = asserted;
      let member = next;
      if (mask.startsWith('?.', member)) member = skipSourceSpace(mask, member + 2);
      else if (mask[member] === '.') member = skipSourceSpace(mask, member + 1);
      else if (mask[member] !== '[') { end = next; break; }
      if (mask[member] === '[') {
        const keyStart = skipSourceSpace(mask, member + 1);
        const quoted = ['"', "'"].includes(mask[keyStart]) ? readQuotedLiteral(mask, keyStart) : null;
        const close = quoted && skipSourceSpace(mask, quoted.end);
        if (!quoted || mask[close] !== ']') { unknown = true; end = member; break; }
        const key = decodeStaticKey(text.slice(keyStart, quoted.end));
        end = close + 1;
        if (!key) { unknown = true; break; }
        names.push(key);
      } else {
        const name = member !== next && sourceIdentifierAt(mask, member);
        if (!name?.name) { end = next; break; }
        names.push(name.name);
        end = name.end;
      }
    }
    const call = mask[end] === '(' || (mask.startsWith('?.', end) && mask[skipSourceSpace(mask, end + 2)] === '(');
    const member = contextMember({ names, start: match.index, unknown, call });
    if (member) members.push(member);
    roots.lastIndex = Math.max(roots.lastIndex, end);
  }
  return members;
}

function firstAtOrAfter(positions, start) {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  return positions[lo];
}

function indexedProofChanged(index, guard, member) {
  const root = member.names[0];
  const callScope = index.tokens[member.token].scope;
  const binding = bindingFor(guard.owner, root);
  if (bindingFor(callScope, root) !== binding) return true;
  // A root mentioned anywhere in a nested function head still blocks an inherited
  // proof, but is not itself a new binding: function f(x = (context = next)) writes
  // the outer context. Separate that proof barrier from real parameter shadowing.
  for (let scope = callScope; scope !== guard.owner; scope = scope.parent) {
    if (!scope || scope.roots.has(root)) return true;
  }
  const declarations = index.scopes[binding].declarations.get(root) || [];
  if (firstAtOrAfter(declarations, guard.start) !== undefined) return true;
  for (let length = 1; length <= member.names.length; length += 1) {
    const key = `${binding}:${member.names.slice(0, length).join('.')}`;
    const positions = index.writes.get(key);
    if (positions && firstAtOrAfter(positions, guard.start) < member.start) return true;
    const children = length < member.names.length && index.writes.get(`${key}.*`);
    if (children && firstAtOrAfter(children, guard.start) < member.start) return true;
  }
  return false;
}

function hasMethodGuard(index, member) {
  const key = member.names.join('.');
  for (let scope = index.tokens[member.token].scope; scope; scope = scope.parent) {
    if (scope.guard?.proofs.has(key) && !indexedProofChanged(index, scope.guard, member)) return true;
  }
  return false;
}

function provePositiveCondition(raw, mask, methodPath, delimiters, base) {
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
  // props.context and this._ctx are context receivers just like the context
  // parameter. Assume that receiver path is present, but still require a proof or
  // optional access for device/utils and the exact method being guarded.
  const namespace = methodPath.findIndex((name, i) => i > 0 && CONTEXT_NAMESPACES.has(name) && CONTEXT_NAME.test(methodPath[i - 1]));
  for (let length = 1; length <= namespace; length += 1) state.proven.add(methodPath.slice(0, length).join('.'));
  return proveGuardConjunction(raw, blankLiterals(raw), methodPath, state, delimiters, base) && state.methodSafe;
}

function proveGuardConjunction(raw, mask, methodPath, state, delimiters, base) {
  // ready && (ready && (...method proof...)) has input-sized depth too. Keep
  // offset ranges on a stack and jump indexed delimiters, preserving left-to-right
  // proof order without repeated slicing, balancing or recursive calls.
  const pending = [{ start: 0, end: raw.length }];
  while (pending.length) {
    const range = pending.pop();
    const { start, end } = unwrapRange(raw, mask, range.start, range.end, delimiters, base);
    const operands = [];
    let from = start;
    for (let i = start; i < end; i += 1) {
      if ('([{'.includes(mask[i])) {
        const close = delimiters.get(base + i);
        if (close === undefined || close >= base + end) return false;
        i = close - base;
      } else if (mask[i] === ',' || ')]}'.includes(mask[i])) return false;
      else if (mask.startsWith('&&', i)) {
        operands.push({ start: from, end: i });
        i += 1;
        from = i + 1;
      }
    }
    operands.push({ start: from, end });
    if (operands.length > 1) {
      for (let i = operands.length - 1; i >= 0; i -= 1) pending.push(operands[i]);
    } else if (!proveGuardOperand(raw.slice(start, end), methodPath, state)) return false;
  }
  return true;
}

function proveGuardOperand(raw, methodPath, state) {
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
  const text = raw.trim();
  const names = [];
  const optional = [];
  for (let start = 0; start < text.length;) {
    const identifier = identifierAt(text, start);
    if (!identifier) return null;
    names.push(identifier.value);
    start = identifier.end;
    while (/\s/.test(text[start] || '') && start < text.length) start += 1;
    if (start === text.length) return { names, optional };
    if (text.startsWith('?.', start)) { optional.push(true); start += 2; }
    else if (text[start] === '.') { optional.push(false); start += 1; }
    else return null;
    while (/\s/.test(text[start] || '') && start < text.length) start += 1;
  }
  return null;
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
    code = code.slice(0, start) + code.slice(start, end).replace(/[^\n\r\u2028\u2029]/g, ' ') + code.slice(end);
  }
  return code;
}

function unwrapRange(raw, mask, start, end, delimiters, base = 0) {
  while (true) {
    while (start < end && /\s/.test(raw[start])) start += 1;
    while (end > start && /\s/.test(raw[end - 1])) end -= 1;
    if (mask[start] !== '(' || delimiters.get(base + start) !== base + end - 1) return { start, end };
    start += 1;
    end -= 1;
  }
}

function unwrapExpression(raw, mask) {
  const delimiters = new Map();
  const pending = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '(') pending.push(i);
    else if (mask[i] === ')' && pending.length) delimiters.set(pending.pop(), i);
  }
  const { start, end } = unwrapRange(raw, mask, 0, raw.length, delimiters);
  return { raw: raw.slice(start, end), mask: mask.slice(start, end), offset: start };
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
