'use strict';

const { blankLiterals, expressionPosition } = require('./source-literals.js');

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

function scanSource(file, text, { controlType, lex = blankLiterals } = {}) {
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
  return findings;
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

function featureCoherence(manifestModel, sources, hosts = [], { lex = blankLiterals } = {}) {
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
  const escapedNamespace = escapeRegExp(namespace);
  const escapedMethod = escapeRegExp(method);
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

    const rawCondition = text.slice(openParen + 1, closeParen);
    const maskCondition = mask.slice(openParen + 1, closeParen);
    const optionalMethodGuard = new RegExp(`typeof\\s+context\\.${escapedNamespace}\\?\\.${escapedMethod}\\s*={2,3}\\s*['"]function['"]`, 'g');
    if (hasCodeMatch(optionalMethodGuard, rawCondition, maskCondition)) return true;

    const namespaceCheck = new RegExp(`\\bcontext\\.${escapedNamespace}\\b(?![?.])`, 'g');
    const dottedMethodGuard = new RegExp(`typeof\\s+context\\.${escapedNamespace}\\.${escapedMethod}\\s*={2,3}\\s*['"]function['"]`, 'g');
    if (hasCodeMatch(namespaceCheck, rawCondition, maskCondition) && hasCodeMatch(dottedMethodGuard, rawCondition, maskCondition)) return true;
  }
  return false;
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
