'use strict';

const { blankNonCodePreservingTemplateExpressions } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');

function groupEnd(mask, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < mask.length; i += 1) {
    if (pairs[mask[i]]) stack.push(pairs[mask[i]]);
    else if (/[)}\]]/.test(mask[i])) {
      if (stack.pop() !== mask[i]) throw new Error('unbalanced source evidence');
      if (!stack.length) return i;
    }
  }
  throw new Error('truncated source evidence');
}

function literalString(text) {
  const value = text.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch { return null; }
  }
  const match = /^'((?:\\.|[^'\\])*)'$/.exec(value);
  if (!match) return null;
  // The scorer accepts literal ASCII request names/values and ordinary quote/backslash escapes.
  // Unsupported expressions fail closed; no page source is ever evaluated to discover a value.
  if (/\\[^\\']/.test(match[1])) return null;
  return match[1].replace(/\\(['\\])/g, '$1');
}

function objectFields(text) {
  const source = text.trim();
  const mask = blankNonCodePreservingTemplateExpressions(source);
  if (mask[0] !== '{' || groupEnd(mask, 0) !== mask.length - 1) throw new Error('request must be one literal object');
  const fields = new Map();
  let i = 1;
  while (i < mask.length - 1) {
    while (/[\s,]/.test(mask[i])) i++;
    if (i >= mask.length - 1) break;
    let name;
    if (/["']/.test(mask[i])) {
      const quote = mask[i];
      const end = mask.indexOf(quote, i + 1);
      name = literalString(source.slice(i, end + 1));
      i = end + 1;
    } else {
      const key = /^[A-Za-z_$][\w$]*/.exec(mask.slice(i));
      if (!key) throw new Error('computed, spread or dynamic request properties are not gradeable');
      name = key[0];
      i += name.length;
    }
    while (/\s/.test(mask[i])) i++;
    if (!name || mask[i++] !== ':') throw new Error('request properties require literal names and values');
    while (/\s/.test(mask[i])) i++;
    const start = i;
    while (i < mask.length - 1 && mask[i] !== ',') {
      if (/[({[]/.test(mask[i])) i = groupEnd(mask, i) + 1;
      else i++;
    }
    if (fields.has(name)) throw new Error(`duplicate request property ${name}`);
    fields.set(name, source.slice(start, i).trim());
  }
  return fields;
}

function actionCalls(code) {
  const mask = blankNonCodePreservingTemplateExpressions(code);
  const scopes = [];
  for (const match of mask.matchAll(/\b(?:async\s+)?function\s+([\w$]+)\s*\(/g)) {
    const paramsEnd = groupEnd(mask, match.index + match[0].length - 1);
    const body = mask.indexOf('{', paramsEnd);
    if (body !== -1) scopes.push({ name: match[1], start: match.index, body, end: groupEnd(mask, body) });
  }
  const calls = [];
  for (const match of mask.matchAll(/\.\s*(executeAction|executeFunction)\s*(?:\?\.\s*)?\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = groupEnd(mask, open);
    const scope = scopes.filter((entry) => entry.body < match.index && entry.end > end).sort((a, b) => b.body - a.body)[0];
    if (!scope) throw new Error('Custom API calls require a gradeable named helper scope');
    const assignment = /\b(?:const|let)\s+([\w$]+)\s*=\s*await\s+[\w$.?]+\s*$/.exec(mask.slice(scope.body, match.index));
    if (!assignment) throw new Error('Custom API call has no associated awaited result');
    calls.push({ method: match[1], start: match.index, end, scope, resultName: assignment[1], fields: objectFields(code.slice(open + 1, end)), mask });
  }
  return calls;
}

module.exports = { groupEnd, literalString, objectFields, actionCalls };
