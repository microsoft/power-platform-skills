'use strict';

const { isDeepStrictEqual } = require('node:util');
const { PARAMETER_KIND_BY_TYPE } = require('../../../../plugins/model-apps/scripts/list-custom-apis.js');
const { pageStructureProblems } = require('../../../../plugins/model-apps/scripts/lib/page-structure.js');
const { workflowCalls, isGeneration, isUpload, isMutation, resultObject, unassociatedCallProblems } = require('./workflow-evidence.js');
const { artifactText, artifactJson, commandInfo, fileName, isGuid, pathKey } = require('./evidence-utils.js');
const { planSection, parseMarkdownRows } = require('./plan-evidence.js');
const { actionCalls, literalString, objectFields } = require('./source-evidence.js');
const { desiredBindings, sameBindings } = require('./upload-contract.js');

const KINDS = new Set(Object.values(PARAMETER_KIND_BY_TYPE));
const isGate = (command) => /\bfeature-flags\.js\b[^\n]*\bcustom-api\b/.test(command);
const gateValue = (call) => {
  const raw = typeof call.result === 'string' ? call.result.trim() : '';
  if (raw === 'enabled' || raw === 'disabled') return raw;
  return call.historical ? /(?:\u2192|->|Result:)\s*(enabled|disabled)\b/.exec(call.text || '')?.[1] || null : null;
};

function planBindings(fixture) {
  const body = planSection(fixture.genpagePlan, 'Custom API Bindings');
  if (body === 'No custom API bindings.') return [];
  if (!body) throw new Error('Custom API Bindings section is missing or unreadable, not a no-bindings sentinel');
  const rows = parseMarkdownRows(body, ['Name', 'Kind', 'Bound Entity', 'Display Name', 'Parameters (name: kind)']);
  if (!rows.length) throw new Error('Custom API Bindings must be a populated table or the exact no-bindings sentinel');
  return rows.map((row) => {
    if (!['Action', 'Function'].includes(row.kind)) throw new Error(`invalid API kind for ${row.name}`);
    const parameterKinds = {};
    for (const parameter of row['parameters (name: kind)'].split(',').filter((value) => value.trim())) {
      const match = /^\s*([\w]+)\s*:\s*([A-Za-z]+)\s*$/.exec(parameter);
      if (!match || !KINDS.has(match[2]) || Object.hasOwn(parameterKinds, match[1])) throw new Error(`unreadable parameter kinds for ${row.name}`);
      parameterKinds[match[1]] = match[2];
    }
    return {
      name: row.name, isFunction: row.kind === 'Function', displayName: row['display name'], parameterKinds,
      ...(row['bound entity'] !== '(Global)' && { boundEntityLogicalName: row['bound entity'] }),
    };
  });
}

function projectBinding(entry) {
  if (!entry || typeof entry.name !== 'string' || typeof entry.isFunction !== 'boolean' || !entry.displayName
    || !entry.parameterKinds || Object.values(entry.parameterKinds).some((kind) => !KINDS.has(kind))) {
    throw new Error('discovered/bound API is missing its name, kind, display name or parameter kinds');
  }
  if (entry.bindingType && !['Global', 'Entity'].includes(entry.bindingType)) throw new Error('collection-bound API is not a supported record binding');
  if (entry.bindingType === 'Global' && entry.boundEntityLogicalName) throw new Error('global API incorrectly declares a bound entity');
  return { name: entry.name, isFunction: entry.isFunction, displayName: entry.displayName, parameterKinds: entry.parameterKinds,
    ...(entry.boundEntityLogicalName && { boundEntityLogicalName: entry.boundEntityLogicalName }) };
}

function customApiGateProblems(fixture) {
  const bindings = planBindings(fixture);
  const calls = workflowCalls(fixture);
  const problems = unassociatedCallProblems(fixture);
  let latest = null;
  let gateIndex = -1;
  let discoveryIndex = -1;
  for (const [index, call] of calls.entries()) {
    if (isGate(call.command)) {
      latest = gateValue(call);
      gateIndex = index;
    } else if (/\blist-custom-apis\.js\b/.test(call.command)) {
      if (latest !== 'enabled') problems.push('Custom API discovery ran before an enabled feature gate');
      discoveryIndex = index;
    } else if (bindings.length && (isGeneration(call.command) || isUpload(call.command))) {
      if (latest !== 'enabled') problems.push('disabled or unreadable Custom API gate must halt before generation or upload');
      else if (gateIndex <= discoveryIndex) problems.push('Custom API generation must re-probe the feature gate after planning discovery');
    }
  }
  if (bindings.length && !calls.some((call) => isGate(call.command))) problems.push('Custom API table has no applicable feature gate');
  if (fixture.manifest?.expectedOutcome === 'refused') {
    if (latest === 'enabled' || !bindings.length || (fixture.files || []).length || calls.some((call) => isGeneration(call.command) || isMutation(call.command))) {
      problems.push('Custom API refusal must have a blocked gate and zero generation or mutations');
    }
    if (!/\bhalt(?:ed)?\b|\bneeds_input\b/i.test(fixture.workflowLog || '')) problems.push('Custom API gate refusal did not surface a halt');
  }
  return problems;
}

function parameterMatches(value, kind, prefix) {
  const literal = literalString(value);
  const identifier = /^[\w$]+$/.test(value) ? value : null;
  const annotation = identifier ? new RegExp(`\\b${identifier}\\s*:\\s*(string\\[\\]|string|number|boolean|Date)\\b`).exec(prefix)?.[1] : null;
  if (kind === 'String') return literal !== null || annotation === 'string';
  if (kind === 'Guid') return literal !== null ? isGuid(literal) : annotation === 'string';
  if (['Integer', 'Decimal', 'Float', 'Money', 'Picklist'].includes(kind)) return /^-?\d+(?:\.\d+)?$/.test(value) || annotation === 'number';
  if (kind === 'Boolean') return /^(true|false)$/.test(value) || annotation === 'boolean';
  if (kind === 'DateTime') return annotation === 'Date' || (literal !== null && /^\d{4}-\d\d-\d\dT/.test(literal));
  if (kind === 'StringArray') return annotation === 'string[]';
  return value.trim().startsWith('{') || (kind === 'EntityCollection' && value.trim().startsWith('['));
}

function runtimeProblems(code, bindings, declaredOutputs) {
  const problems = pageStructureProblems(code);
  const calls = actionCalls(code);
  const known = new Map(bindings.map((binding) => [binding.name, binding]));
  const used = new Set();
  for (const call of calls) {
    const name = literalString(call.fields.get('name') || '');
    const binding = known.get(name);
    if (!binding) { problems.push(`runtime calls unbound or undiscovered Custom API ${name || '(dynamic name)'}`); continue; }
    used.add(name);
    if (call.method !== (binding.isFunction ? 'executeFunction' : 'executeAction')) problems.push(`${name}: runtime method disagrees with discovered Action/Function kind`);
    const prefix = code.slice(call.scope.start, call.start);
    const prefixMask = call.mask.slice(call.scope.start, call.start);
    const post = code.slice(call.end + 1, call.scope.end);
    const postMask = call.mask.slice(call.end + 1, call.scope.end);
    const presence = new RegExp(`\\btypeof\\s+[\\w$.?]+\\.${call.method}\\s*!==?\\s*(['"])`);
    const match = presence.exec(prefixMask);
    if (!match || !/^['"]function['"]/.test(prefix.slice(match.index + match[0].length - 1))) problems.push(`${name}: method is not presence-checked in its helper before the call`);
    const parameters = call.fields.has('parameters') ? objectFields(call.fields.get('parameters')) : new Map();
    if ([...parameters.keys()].sort().join('|') !== Object.keys(binding.parameterKinds).sort().join('|')) problems.push(`${name}: runtime parameter names differ from the declared kinds`);
    for (const [parameter, kind] of Object.entries(binding.parameterKinds)) {
      if (!parameterMatches(parameters.get(parameter) || '', kind, prefix)) problems.push(`${name}.${parameter}: runtime value does not match ${kind}`);
    }
    if (binding.boundEntityLogicalName) {
      if (!call.fields.has('boundTo')) problems.push(`${name}: entity-bound operation omits boundTo`);
      else {
        const bound = objectFields(call.fields.get('boundTo'));
        if (literalString(bound.get('entityName') || '') !== binding.boundEntityLogicalName) problems.push(`${name}: boundTo uses the wrong entity`);
        const id = bound.get('id') || '';
        if (literalString(id) !== null || !/^[\w$.]+$/.test(id) || !parameterMatches(id, 'Guid', prefix)) {
          problems.push(`${name}: bound record id must come from string-typed existing page input, never a hard-coded GUID or numeric value`);
        }
      }
    } else if (call.fields.has('boundTo')) problems.push(`${name}: global operation must omit boundTo`);

    const result = call.resultName;
    const ok = new RegExp(`\\bif\\s*\\(\\s*(?:!\\s*${result}\\.ok|${result}\\.ok\\s*===?\\s*false)\\s*\\)\\s*\\{[^}]*\\breturn\\b[^}]*\\}`);
    const okMatch = ok.exec(postMask);
    const outputsAt = postMask.search(new RegExp(`\\b${result}\\.outputs\\b`));
    if (!okMatch || outputsAt < 0 || okMatch.index + okMatch[0].length > outputsAt) problems.push(`${name}: response.ok must refuse before outputs are read`);
    if (!new RegExp(`\\b${result}\\.error\\??\\.message\\b`).test(postMask) || new RegExp(`\\b${result}\\.(?:value|body)\\b|\\.error\\??\\.(?:stack|detail|details)\\b`).test(postMask)) {
      problems.push(`${name}: outputs/error handling must use outputs and sanitized error.message only`);
    }
    const outputs = [...postMask.matchAll(new RegExp(`\\b${result}\\.outputs(?:\\?\\.)?\\.?([A-Za-z_$][\\w$]*)`, 'g'))].map((entry) => entry[1]);
    if (!Array.isArray(declaredOutputs?.[name]) || outputs.some((output) => !declaredOutputs[name].includes(output))) problems.push(`${name}: runtime reads an undeclared output`);
    if (!binding.isFunction) {
      if (!/\bif\s*\(\s*(?:pending\.current|isSubmitting)(?:\s*\|\|[^)]*)?\)\s*(?:return\b|\{\s*return\b)/.test(prefixMask)
        || !/\bpending\.current\s*=\s*true\b|\bsetIsSubmitting\s*\(\s*true\s*\)/.test(prefixMask)
        || !/\bfinally\b[\s\S]*(?:pending\.current\s*=\s*false\b|setIsSubmitting\s*\(\s*false\s*\))/.test(postMask)) {
        problems.push(`${name}: mutating action lacks a helper-scoped double-submit latch and reset`);
      }
      if (!new RegExp(`\\bif\\s*\\(\\s*${result}\\.indeterminate\\s*\\)\\s*\\{[^}]*\\breturn\\b`).test(postMask)) problems.push(`${name}: indeterminate action is not stopped before retry`);
      if (/\bsetTimeout\b|\bsetInterval\b|\bwhile\s*\(|\bfor\s*\(/.test(postMask) || new RegExp(`\\b${call.scope.name}\\s*\\(`).test(postMask)) problems.push(`${name}: action may auto-retry after dispatch`);
    }
  }
  for (const name of known.keys()) if (!used.has(name)) problems.push(`${name}: selected binding has no runtime call in this lifecycle stage`);
  return problems;
}

function customApiProblems(fixture) {
  const problems = customApiGateProblems(fixture);
  if (fixture.manifest?.expectedOutcome === 'refused') return problems;
  const contract = fixture.manifest?.customApi;
  if (!contract?.stages?.length) return [...problems, 'Custom API lifecycle has no source/config stages'];
  const declared = planBindings(fixture);
  const calls = workflowCalls(fixture);
  const discovered = new Map();
  for (const call of calls.filter((entry) => /\blist-custom-apis\.js\b/.test(entry.command))) {
    const result = resultObject(call);
    if (result?.ok !== true || !Array.isArray(result.customApis)) problems.push('Custom API discovery failed or returned unreadable metadata');
    else for (const entry of result.customApis) discovered.set(entry.name, projectBinding(entry));
  }
  for (const binding of declared) if (!isDeepStrictEqual(discovered.get(binding.name), binding)) problems.push(`${binding.name}: plan kind, bound entity or parameter kinds do not match discovery`);
  let previousId = null;
  for (const stage of contract.stages) {
    const uploadIndex = calls.findIndex((call) => call.id === stage.upload);
    const call = calls[uploadIndex];
    if (!call || !isUpload(call.command)) { problems.push(`${stage.id}: missing associated API upload`); continue; }
    const { flags } = commandInfo(call);
    const result = resultObject(call);
    if (fileName(flags['code-file']) !== stage.target || result?.ok !== true) problems.push(`${stage.id}: upload target/result does not match the generated API page`);
    if (previousId && (flags['page-id'] !== previousId || result.pageId !== previousId)) problems.push(`${stage.id}: update changes the API page's identity`);
    previousId = result?.pageId;
    const before = stage.beforeConfig ? artifactJson(fixture, stage.beforeConfig).actionBindings || [] : declared;
    const desired = stage.beforeConfig ? desiredBindings(before, stage.change, 'name') : declared;
    if (stage.beforeConfig && stage.change === undefined && flags.actions) problems.push(`${stage.id}: unchanged APIs must omit --actions`);
    if (!stage.beforeConfig || stage.change !== undefined) {
      if (!flags.actions || pathKey(flags.actions) !== pathKey(stage.actions) || !sameBindings(artifactJson(fixture, flags.actions), desired, 'name')) {
        problems.push(`${stage.id}: actions file must be the full desired bare array, including explicit [] to clear`);
      }
    }
    const after = artifactJson(fixture, stage.afterConfig).actionBindings;
    if (!sameBindings(after, desired, 'name')) problems.push(`${stage.id}: API config read-back loses preservation or explicit-clear intent`);
    for (const binding of desired) {
      const projected = projectBinding(binding);
      if (!isDeepStrictEqual(discovered.get(binding.name), projected)) problems.push(`${binding.name}: actions file differs from discovered metadata`);
    }
    const code = artifactText(fixture, stage.source);
    const write = calls.slice(0, uploadIndex).filter((entry) => /^Write\s+/.test(entry.command) && fileName(entry.command.slice(6)) === stage.target).at(-1);
    if (!write || artifactText(fixture, write.artifact) !== code) problems.push(`${stage.id}: uploaded API source is not the actual preceding generated snapshot`);
    problems.push(...runtimeProblems(code, desired, contract.outputs));
  }
  const last = contract.stages.at(-1);
  if (artifactText(fixture, last.target) !== artifactText(fixture, last.source)) problems.push('final API TSX differs from the final lifecycle stage');
  return problems;
}

module.exports = { customApiProblems, customApiGateProblems };
