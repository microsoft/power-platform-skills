'use strict';

const { isDeepStrictEqual } = require('node:util');
const { PARAMETER_KIND_BY_TYPE } = require('../../../../plugins/model-apps/scripts/list-custom-apis.js');
const { pageStructureProblems } = require('../../../../plugins/model-apps/scripts/lib/page-structure.js');
const { workflowCalls, isGeneration, isUpload, isMutation, resultObject, unassociatedCallProblems } = require('./workflow-evidence.js');
const { artifactText, artifactJson, commandInfo, fileName, isGuid, pathKey, gradeEvidence } = require('./evidence-utils.js');
const { planSection, parseMarkdownRows } = require('./plan-evidence.js');
const { actionCalls, literalString, objectFields, receiverIsDataApi, stringRecordMemberIsInput, escapeRe } = require('./source-evidence.js');
const {
  desiredBindings, sameBindings, uploadResultIdentityMatches, beforePageIdentityProblems, sameRecordedEnvironment,
} = require('./upload-contract.js');
// A page's actionBindings may also hold the reviewed built-in operations (WhoAmI, RetrieveVersion): the union layer owns their plan section, listing, gate and order, and this
// evaluator compares the WHOLE union — never the Custom API partition alone (action-binding-union.js).
const {
  BUILT_IN_OUTPUTS, isBuiltInBinding, partitionBindings, plannedBuiltIns, unionBindings, listedBuiltIns, unionOrderProblems, builtInGateProblems,
  clearConfirmationProblems, builtInRuntimeProblems,
} = require('./action-binding-union.js');

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
    if (isBuiltInBinding(row)) throw new Error(`${row.name} is a built-in Dataverse operation: it belongs in ## Dataverse Operations, not the Custom API table`);
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
  if (!entry || typeof entry.name !== 'string' || typeof entry.isFunction !== 'boolean'
    || typeof entry.displayName !== 'string' || !entry.displayName
    || !entry.parameterKinds || typeof entry.parameterKinds !== 'object' || Array.isArray(entry.parameterKinds)
    || Object.values(entry.parameterKinds).some((kind) => !KINDS.has(kind))) {
    throw new Error('discovered/bound API is missing its name, kind, display name or parameter kinds');
  }
  if (entry.bindingType && !['Global', 'Entity'].includes(entry.bindingType)) throw new Error('collection-bound API is not a supported record binding');
  if (entry.bindingType === 'Global' && entry.boundEntityLogicalName) throw new Error('global API incorrectly declares a bound entity');
  if (entry.boundEntityLogicalName !== undefined
    && (typeof entry.boundEntityLogicalName !== 'string' || !entry.boundEntityLogicalName)) {
    throw new Error('bound API has an unreadable bound entity');
  }
  return { name: entry.name, isFunction: entry.isFunction, displayName: entry.displayName, parameterKinds: entry.parameterKinds,
    ...(entry.boundEntityLogicalName && { boundEntityLogicalName: entry.boundEntityLogicalName }) };
}

function discoveredLookupParameters(entry) {
  const lookups = entry.lookupParameters;
  if (lookups === undefined) return {};
  if (!lookups || typeof lookups !== 'object' || Array.isArray(lookups)) {
    throw new Error(`${entry.name}: unreadable discovery-only lookup parameters`);
  }
  for (const [name, lookup] of Object.entries(lookups)) {
    if (!name || Object.hasOwn(entry.parameterKinds, name) || !lookup || typeof lookup !== 'object'
      || Array.isArray(lookup) || typeof lookup.isOptional !== 'boolean'
      || (lookup.logicalEntityName !== undefined && (typeof lookup.logicalEntityName !== 'string' || !lookup.logicalEntityName))) {
      throw new Error(`${entry.name}.${name}: unreadable discovery-only lookup metadata`);
    }
  }
  return lookups;
}

// A binding a page already holds, as an evaluator compares it: a built-in entry is carried as the page holds it — a legacy one with no isFunction
// included — so it is never held to the Custom API projection.
const projectExisting = (entry) => (isBuiltInBinding(entry) ? entry : projectBinding(entry));

// The update stages whose before-config is provably the page they update: the upload names an existing page and returns it, and either the
// scenario's upload row ties the before-page snapshot to that upload, or an earlier stage of this lifecycle produced that exact read-back for
// the same page and app. Only these stages' existing bindings count as kept; any other "existing" binding is a claim, not evidence. Returns
// each stage's before-config bindings, the verified stages, and the identity problems of the others.
function beforeConfigEvidence(fixture, stages, calls) {
  const beforeByStage = new Map();
  const verifiedBefore = new Set();
  const producedConfigs = new Map();
  const problems = [];
  for (const stage of stages) {
    const uploads = calls.filter((entry) => entry.id === stage.upload && isUpload(entry.command));
    const call = uploads.length === 1 ? uploads[0] : null;
    const flags = call ? commandInfo(call).flags : {};
    const result = call ? resultObject(call) : null;
    if (stage.beforeConfig) {
      const config = artifactJson(fixture, stage.beforeConfig);
      const before = config.actionBindings === undefined ? [] : config.actionBindings;
      desiredBindings(before, undefined, 'name');
      for (const binding of before) projectExisting(binding);
      beforeByStage.set(stage, before);
      const identityProblems = [];
      if (!call || !flags['page-id'] || result?.ok !== true || !uploadResultIdentityMatches(flags, result)) {
        identityProblems.push(`${stage.id}: before-config preservation requires an unambiguous existing update target`);
      }
      const rows = fixture.manifest?.uploads;
      if (rows !== undefined) {
        const associated = Array.isArray(rows) ? rows.filter((row) => row.event === stage.upload) : [];
        if (associated.length !== 1) {
          identityProblems.push(`${stage.id}: before-page identity evidence has no unique upload association`);
        } else if (call) {
          identityProblems.push(...beforePageIdentityProblems(fixture, associated[0], call, stage.beforeConfig, stage.afterConfig));
        }
      } else {
        // A prior successful lifecycle stage can associate its exact read-back snapshot with its
        // result identity. A first-stage arbitrary artifact path cannot establish page ownership.
        const prior = producedConfigs.get(pathKey(stage.beforeConfig));
        if (!prior || prior.pageId !== flags['page-id'] || prior.appId !== flags['app-id']) {
          identityProblems.push(`${stage.id}: before-config lacks same-page/app identity provenance`);
        } else if (prior.env !== undefined && !sameRecordedEnvironment(prior.env, flags.env)) {
          identityProblems.push(`${stage.id}: before-config environment differs from the update target`);
        }
      }
      problems.push(...identityProblems);
      if (!identityProblems.length) verifiedBefore.add(stage);
    }
    if (call && result?.ok === true && uploadResultIdentityMatches(flags, result)) {
      producedConfigs.set(pathKey(stage.afterConfig), { pageId: result.pageId, appId: result.appId, env: flags.env });
    }
  }
  return { beforeByStage, verifiedBefore, problems };
}

// The custom-api gate decides new Custom API authoring: a create whose plan has Custom API rows or whose --actions file holds one, and a stage
// that adds or replaces a Custom API row. A lifecycle stage whose before-config is verified (beforeConfigEvidence) and whose change adds or
// replaces none — an unrelated edit, a removal (which the builder defers while the flag is OFF), a clear, or a built-in change — authors no
// Custom API row: it keeps the rows the page already has. This returns the calls such a stage COVERS: the generations and uploads after the
// previous stage's upload, up to and including its own. Covering is not attribution — a call inside that span may be the stage's own or an
// unrelated one, and the grader cannot tell them apart — so a covered call is never passed for the gate (customApiGateVerdict), which needs
// this only when the plan has Custom API rows. Anything unreadable covers nothing.
function keepingStageCoverage(fixture, calls) {
  const stages = fixture.manifest?.customApi?.stages;
  const covered = new Set();
  if (!Array.isArray(stages) || !stages.length) return covered;
  let verified;
  try { verified = beforeConfigEvidence(fixture, stages, calls).verifiedBefore; } catch { return covered; }
  let previous = -1;
  for (const stage of stages) {
    const upload = calls.findIndex((call) => call.id === stage.upload && isUpload(call.command));
    if (upload === -1) continue;
    const authorsCustomApi = !stage.beforeConfig || (stage.change?.add || []).some((row) => !isBuiltInBinding(row));
    if (!authorsCustomApi && verified.has(stage)) {
      for (let index = previous + 1; index <= upload; index += 1) {
        if (isGeneration(calls[index].command) || isUpload(calls[index].command)) covered.add(index);
      }
    }
    previous = upload;
  }
  return covered;
}

const GATE_HALT = 'disabled or unreadable Custom API gate must halt before generation or upload';
// The one reason every rule that grades the gate gives when it cannot score a run (gradeWithGate).
const CUSTOM_API_GATE_UNSCORED = 'custom-api OFF: a preserving stage\'s generation or upload cannot be attributed to that stage, so a page kept while the gate is OFF is not graded';

// Whether a recorded bindings list holds a Custom API row: anything but a reviewed built-in (WhoAmI, RetrieveVersion — isBuiltInBinding, which
// knows a legacy built-in entry by its name too). A list that cannot be read — a missing or unparseable file, or anything but an array — counts
// as holding one: no evidence, no pass.
function holdsCustomApiRow(read) {
  let list;
  try { list = read(); } catch { return true; }
  return !Array.isArray(list) || list.some((entry) => !isBuiltInBinding(entry));
}
// A recorded upload's --actions file — the list the upload gives the page; an upload with no --actions file binds nothing.
function actionsHoldCustomApi(fixture, call) {
  const file = commandInfo(call).flags.actions;
  return file !== undefined && holdsCustomApiRow(() => artifactJson(fixture, file));
}
// A stage config's bindings, read as beforeConfigEvidence reads them: a config with no actionBindings holds none.
function configBindings(fixture, file) {
  const config = artifactJson(fixture, file);
  return config.actionBindings === undefined ? [] : config.actionBindings;
}

// Whether the recorded lifecycle carries a Custom API row, whatever the plan's Custom API table says: in a recorded upload's --actions file, or in
// a lifecycle stage's before- or after-config (manifest.customApi.stages). Only an --actions file writes a page's bindings, and the configs show the
// rows a page holds, so these are the places a recorded run can carry one. Anything unreadable — a file, a stage with no after-config, stages
// that are not a list, evidence that cannot be scanned — counts as carrying one.
function carriesCustomApi(fixture, calls) {
  try {
    if ((calls || workflowCalls(fixture)).some((call) => isUpload(call.command) && actionsHoldCustomApi(fixture, call))) return true;
    const stages = fixture.manifest?.customApi?.stages;
    if (stages === undefined) return false;
    if (!Array.isArray(stages)) return true;
    return stages.some((stage) => !stage || typeof stage !== 'object'
      || (stage.beforeConfig !== undefined && holdsCustomApiRow(() => configBindings(fixture, stage.beforeConfig)))
      || holdsCustomApiRow(() => configBindings(fixture, stage.afterConfig)));
  } catch {
    return true;
  }
}

// The gate's verdict on a run: its problems, and how many calls it could not attribute. The gate grades a workflow that bears Custom API rows —
// its plan's Custom API table has rows, or its recorded lifecycle carries one (carriesCustomApi): an empty table is no permission. In such a
// workflow a generation or upload made while the latest gate is not enabled — disabled, unreadable or never probed — is never passed:
//   - a create (an upload without --page-id) whose --actions file holds a Custom API row, or cannot be read, is a problem whatever the plan says;
//   - with Custom API rows in the plan, every other create is a problem too (a create can never keep a page's rows), and so is a call no verified
//     keeping stage covers (keepingStageCoverage): new authoring as far as the evidence shows;
//   - any other call is UNATTRIBUTED: it may be a keeping stage's own, or not, and the grader cannot prove which — neither a pass nor a problem.
//     Under an empty plan table that is every call but such a create, with no keeping stage required: a run that planned no Custom API declares
//     none. A workflow whose only rows are the built-ins (WhoAmI, RetrieveVersion) is outside the gate, which decides only Custom API authoring.
// Why unscored rather than attributed: two ways to tie such a call to its stage have failed. Refusing every call after an OFF gate graded a
// correct kept page (an unrelated edit, or a removal the builder defers) as forbidden authoring; exempting every call the stage covers let an
// unrelated create beside it borrow the stage's proof. Matching calls to a stage by page id, source or time would be a third guess of the same
// kind, so the rules that grade the gate leave such a run unscored instead (gradeWithGate). Everything else the gate checks is unchanged.
function customApiGateVerdict(fixture) {
  const bindings = planBindings(fixture);
  const calls = workflowCalls(fixture);
  const problems = unassociatedCallProblems(fixture);
  const inScope = bindings.length > 0 || carriesCustomApi(fixture, calls);
  const covered = keepingStageCoverage(fixture, calls);
  let unattributed = 0;
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
    } else if (inScope && (isGeneration(call.command) || isUpload(call.command))) {
      if (latest !== 'enabled') {
        const creates = isUpload(call.command) && !commandInfo(call).flags['page-id'];
        if (creates && actionsHoldCustomApi(fixture, call)) problems.push(GATE_HALT);
        else if (bindings.length && (creates || !covered.has(index))) problems.push(GATE_HALT);
        else unattributed += 1;
      } else if (bindings.length && gateIndex <= discoveryIndex) problems.push('Custom API generation must re-probe the feature gate after planning discovery');
    }
  }
  if (bindings.length && !calls.some((call) => isGate(call.command))) problems.push('Custom API table has no applicable feature gate');
  if (fixture.manifest?.expectedOutcome === 'refused') {
    if (latest === 'enabled' || !bindings.length || (fixture.files || []).length || calls.some((call) => isGeneration(call.command) || isMutation(call))) {
      problems.push('Custom API refusal must have a blocked gate and zero generation or mutations');
    }
    if (!/\bhalt(?:ed)?\b|\bneeds_input\b/i.test(fixture.workflowLog || '')) problems.push('Custom API gate refusal did not surface a halt');
  }
  return { problems, unattributed };
}

// The gate's problems alone, for the callers that grade only problems: customApiProblems, and an expected refusal (workflow-evidence.js
// refusalProblems), where any generation or upload is itself a refusal problem, so an unattributed call can never leave it unscored.
function customApiGateProblems(fixture) {
  return customApiGateVerdict(fixture).problems;
}

// A rule that grades the gate, in the framework's { status, reason } (evidence-utils.js gradeEvidence): any problem fails it, exactly as before;
// with none, a call the gate could not attribute leaves it unscored — `skip`, counted apart from passes by the runners — rather than passed.
// This wraps the existing problem lists instead of changing their shape, so every other caller of them is untouched.
function gradeWithGate(check, fixture) {
  const graded = gradeEvidence(check, fixture);
  if (graded.status !== 'pass') return graded;
  let unattributed;
  try { ({ unattributed } = customApiGateVerdict(fixture)); } catch (error) { return { status: 'fail', reason: error.message }; }
  return unattributed ? { status: 'skip', reason: CUSTOM_API_GATE_UNSCORED } : graded;
}
// The Phase 4.6 workflow rule, and the Phase 5 rule of both layers.
const gradeCustomApiGate = (fixture) => gradeWithGate(customApiGateProblems, fixture);
const gradeCustomApi = (fixture) => gradeWithGate(customApiProblems, fixture);

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
  return false;
}

function existingRecordId(value, prefix, call) {
  if (literalString(value) !== null) return false;
  return (/^[\w$]+$/.test(value) && parameterMatches(value, 'Guid', prefix))
    || Boolean(call && stringRecordMemberIsInput(call.mask, call.scopes, value, call.start));
}

function lookupParameterProblems(parameters, lookups, operation, prefix, call) {
  const problems = [];
  for (const [name, lookup] of Object.entries(lookups)) {
    if (!parameters.has(name)) {
      if (!lookup.isOptional) problems.push(`${operation}.${name}: required discovered lookup input is missing`);
      continue;
    }
    let fields;
    try { fields = objectFields(parameters.get(name)); }
    catch { problems.push(`${operation}.${name}: lookup must be the structural { entityName, id } object`); continue; }
    const entity = literalString(fields.get('entityName') || '');
    if (fields.size !== 2 || !entity || !fields.has('id')) {
      problems.push(`${operation}.${name}: lookup must have exactly entityName and id`);
    } else if (lookup.logicalEntityName && entity !== lookup.logicalEntityName) {
      problems.push(`${operation}.${name}: lookup table disagrees with discovery`);
    }
    if (!existingRecordId(fields.get('id') || '', prefix, call)) {
      problems.push(`${operation}.${name}: lookup id must come from string-typed existing page input, never an invented or numeric id`);
    }
  }
  return problems;
}

// `authoredBuiltIns`: the names of the built-in operations this stage adds or replaces. Only those are held to the catalogue's contract — a Function
// with no input and no target, its outputs the catalogue's. Every other entry keeps the contract it declares: a Custom API, and a built-in the page
// already held, a legacy or contradictory one included — an unrelated edit is no permission to reinterpret a preserved call (download and rebuild
// warn about such an entry instead). A legacy entry may omit `isFunction`, which the runtime enforces only when it is a real boolean, so an omitted
// kind constrains neither method; omitted `parameterKinds` declare no input.
function runtimeProblems(code, bindings, declaredOutputs, lookupMetadata, authoredBuiltIns = new Set()) {
  const problems = pageStructureProblems(code);
  const calls = actionCalls(code);
  const known = new Map(bindings.map((binding) => [binding.name, binding]));
  const used = new Set();
  for (const call of calls) {
    const name = literalString(call.fields.get('name') || '');
    const binding = known.get(name);
    if (!binding) { problems.push(`runtime calls unbound or undiscovered Custom API ${name || '(dynamic name)'}`); continue; }
    used.add(name);
    const canonical = authoredBuiltIns.has(name);
    const kinds = canonical ? {} : (binding.parameterKinds || {});
    const isFunction = canonical ? true : binding.isFunction;
    const isAction = typeof isFunction === 'boolean' ? !isFunction : call.method === 'executeAction';
    if (typeof isFunction === 'boolean' && call.method !== (isFunction ? 'executeFunction' : 'executeAction')) problems.push(`${name}: runtime method disagrees with discovered Action/Function kind`);
    const prefix = code.slice(call.scope.start, call.start);
    const prefixMask = call.mask.slice(call.scope.start, call.start);
    const post = code.slice(call.end + 1, call.scope.end);
    const postMask = call.mask.slice(call.end + 1, call.scope.end);
    if (!receiverIsDataApi(call.mask, call.scopes, call.receiver, call.start)) {
      problems.push(`${name}: ${call.method} is called on ${call.receiver || 'an expression'}, which is not the page's dataApi prop`);
    }
    // The presence check must test the same object the call uses; a check on another object proves nothing.
    const receiverPattern = call.receiver ? call.receiver.split('.').map(escapeRe).join('\\s*\\??\\.\\s*') : '(?!)';
    const presence = new RegExp(`\\btypeof\\s+${receiverPattern}\\s*\\??\\.\\s*${call.method}\\s*!==?\\s*(['"])`);
    const match = presence.exec(prefixMask);
    if (!match || !/^['"]function['"]/.test(prefix.slice(match.index + match[0].length - 1))) problems.push(`${name}: method is not presence-checked on the same receiver in its helper before the call`);
    const parameters = call.fields.has('parameters') ? objectFields(call.fields.get('parameters')) : new Map();
    // Sparse declared kinds do not enumerate lookup inputs. Use discovery-only metadata to allow
    // their names and enforce required lookups without persisting structural kinds in the binding.
    const lookups = lookupMetadata.get(name) || {};
    const allowed = new Set([...Object.keys(kinds), ...Object.keys(lookups)]);
    if ([...parameters.keys()].some((parameter) => !allowed.has(parameter))
      || Object.keys(kinds).some((parameter) => !parameters.has(parameter))) {
      problems.push(`${name}: runtime parameter names differ from the declared kinds and discovered lookups`);
    }
    for (const [parameter, kind] of Object.entries(kinds)) {
      if (!parameterMatches(parameters.get(parameter) || '', kind, prefix)) problems.push(`${name}.${parameter}: runtime value does not match ${kind}`);
    }
    problems.push(...lookupParameterProblems(parameters, lookups, name, prefix, call));
    if (binding.boundEntityLogicalName && !canonical) {
      if (!call.fields.has('boundTo')) problems.push(`${name}: entity-bound operation omits boundTo`);
      else {
        const bound = objectFields(call.fields.get('boundTo'));
        if (literalString(bound.get('entityName') || '') !== binding.boundEntityLogicalName) problems.push(`${name}: boundTo uses the wrong entity`);
        const id = bound.get('id') || '';
        if (!existingRecordId(id, prefix)) {
          problems.push(`${name}: bound record id must come from string-typed existing page input, never a hard-coded GUID or numeric value`);
        }
      }
    } else if (call.fields.has('boundTo')) problems.push(`${name}: global operation must omit boundTo`);

    const result = call.resultName;
    // `res.ok !== true` is the stricter spelling of the same refusal (a built-in call's pattern uses it), so it is accepted beside `!res.ok`; the failure must still return before outputs are read.
    const ok = new RegExp(`\\bif\\s*\\(\\s*(?:!\\s*${result}\\.ok|${result}\\.ok\\s*===?\\s*false|${result}\\.ok\\s*!==?\\s*true)\\s*\\)\\s*\\{[^}]*\\breturn\\b[^}]*\\}`);
    const okMatch = ok.exec(postMask);
    const outputsAt = postMask.search(new RegExp(`\\b${result}\\.outputs\\b`));
    if (!okMatch || outputsAt < 0 || okMatch.index + okMatch[0].length > outputsAt) problems.push(`${name}: response.ok must refuse before outputs are read`);
    if (!new RegExp(`\\b${result}\\.error\\??\\.message\\b`).test(postMask) || new RegExp(`\\b${result}\\.(?:value|body)\\b|\\.error\\??\\.(?:stack|detail|details)\\b`).test(postMask)) {
      problems.push(`${name}: outputs/error handling must use outputs and sanitized error.message only`);
    }
    const outputs = [...postMask.matchAll(new RegExp(`\\b${result}\\.outputs(?:\\?\\.)?\\.?([A-Za-z_$][\\w$]*)`, 'g'))].map((entry) => entry[1]);
    // A built-in's response is the catalogue's; a preserved one is read against what the scenario declares for it, when it declares anything.
    const catalogue = Object.hasOwn(BUILT_IN_OUTPUTS, name) ? BUILT_IN_OUTPUTS[name] : undefined;
    const readable = canonical ? catalogue : (declaredOutputs?.[name] ?? catalogue);
    if (!Array.isArray(readable) || outputs.some((output) => !readable.includes(output))) problems.push(`${name}: runtime reads an undeclared output`);
    if (isAction) {
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

// The builder's own account of a removal it did not perform while `custom-api` was OFF (genpage-customapi-builder.md, Step 1), one line of the
// workflow log:
//   Custom API removal not performed (custom-api disabled): cnt_ApproveOrder, cnt_RejectOrder
// It must name exactly the Custom APIs this removal left in place — a report that names fewer, or more, does not say what happened.
function deferredRemovalProblems(workflowLog, deferred, label) {
  const want = [...deferred].sort().join(',');
  const reported = String(workflowLog || '').split(/\r?\n/).some((line) => {
    const report = /Custom API removal not performed \(custom-api disabled\):\s*(.+?)\s*$/.exec(line);
    return Boolean(report) && report[1].split(/\s*,\s*/).filter(Boolean).sort().join(',') === want;
  });
  return reported ? [] : [`${label}: custom-api was off, so ${deferred.join(', ')} stayed — the log must say so: Custom API removal not performed (custom-api disabled): ${deferred.join(', ')}`];
}

function customApiProblems(fixture) {
  const problems = customApiGateProblems(fixture);
  if (fixture.manifest?.expectedOutcome === 'refused') return problems;
  const contract = fixture.manifest?.customApi;
  if (!contract?.stages?.length) return [...problems, 'Custom API lifecycle has no source/config stages'];
  // The whole desired array: the plan's Custom API rows, then its built-in operation rows (none when the plan has no `## Dataverse Operations` section).
  const declared = unionBindings(planBindings(fixture), plannedBuiltIns(fixture.genpagePlan) || []);
  const calls = workflowCalls(fixture);
  const discovered = new Map();
  const lookupMetadata = new Map();
  for (const call of calls.filter((entry) => /\blist-custom-apis\.js\b/.test(entry.command))) {
    const result = resultObject(call);
    if (result?.ok !== true || !Array.isArray(result.customApis)) problems.push('Custom API discovery failed or returned unreadable metadata');
    else for (const entry of result.customApis) {
      discovered.set(entry.name, projectBinding(entry));
      lookupMetadata.set(entry.name, discoveredLookupParameters(entry));
    }
  }
  // A built-in row's fresh evidence is the catalogue listing, projected exactly as the builder must project it (toActionBinding).
  const listed = listedBuiltIns(calls);
  problems.push(...listed.problems);
  for (const [name, row] of listed.offered) discovered.set(name, row);
  const project = projectExisting;
  const authoring = contract.stages
    .filter((stage) => (stage.beforeConfig ? (stage.change?.add || []).some(isBuiltInBinding) : partitionBindings(declared).builtIns.length > 0))
    .map((stage) => stage.upload);
  problems.push(...builtInGateProblems(calls, authoring));
  const { beforeByStage, verifiedBefore, problems: identityProblems } = beforeConfigEvidence(fixture, contract.stages, calls);
  problems.push(...identityProblems);
  const beforeBindings = [...verifiedBefore].flatMap((stage) => beforeByStage.get(stage));
  for (const binding of declared) {
    const fresh = isDeepStrictEqual(discovered.get(binding.name), binding);
    const existing = beforeBindings.some((before) => isDeepStrictEqual(project(before), binding));
    if (!fresh && !existing) problems.push(`${binding.name}: plan kind, bound entity or parameter kinds do not match discovery or unchanged before-config evidence`);
  }
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
    const before = stage.beforeConfig ? beforeByStage.get(stage) : declared;
    // With the custom-api gate OFF at this upload the builder removes no Custom API row (genpage-customapi-builder.md, Step 1): a removal of a
    // Custom API name waits for the flag — the row stays, and the log says which removals were not performed. A built-in row named in the same
    // removal still goes (no flag decides a built-in removal), and a clear — the maker's own request for an empty array — is never deferred.
    let gate = null;
    for (let index = uploadIndex - 1; index >= 0 && gate === null; index -= 1) if (isGate(calls[index].command)) gate = gateValue(calls[index]) || 'unreadable';
    const deferred = stage.beforeConfig && gate !== 'enabled' ? (stage.change?.remove || []).filter((name) => !isBuiltInBinding({ name })) : [];
    const change = deferred.length ? { ...stage.change, remove: stage.change.remove.filter((name) => !deferred.includes(name)) } : stage.change;
    const desired = stage.beforeConfig ? desiredBindings(before, change, 'name') : declared;
    const unchanged = deferred.length > 0 && sameBindings(desired, before, 'name');
    if (deferred.length) problems.push(...deferredRemovalProblems(fixture.workflowLog, deferred, stage.id));
    if (stage.beforeConfig && stage.change?.clear === true) {
      problems.push(...clearConfirmationProblems({
        workflowLog: fixture.workflowLog, uploads: calls.filter((entry) => isUpload(entry.command)), call, pageId: flags['page-id'], before, label: stage.id,
      }));
    }
    if (stage.beforeConfig && stage.change === undefined && flags.actions) problems.push(`${stage.id}: unchanged APIs must omit --actions`);
    if (unchanged && flags.actions) problems.push(`${stage.id}: a removal the custom-api flag deferred changes nothing — omit --actions`);
    if (!stage.beforeConfig || (stage.change !== undefined && !unchanged)) {
      if (!flags.actions || pathKey(flags.actions) !== pathKey(stage.actions) || !sameBindings(artifactJson(fixture, flags.actions), desired, 'name')) {
        problems.push(`${stage.id}: actions file must be the full desired bare array, including explicit [] to clear`);
      } else if (authoring.includes(stage.upload)) {
        problems.push(...unionOrderProblems(artifactJson(fixture, flags.actions), stage.id));
      }
    }
    const after = artifactJson(fixture, stage.afterConfig).actionBindings;
    if (!sameBindings(after, desired, 'name')) problems.push(`${stage.id}: API config read-back loses preservation or explicit-clear intent`);
    const authoredNames = new Set((stage.change?.add || []).map((binding) => binding.name));
    for (const binding of desired) {
      const projected = project(binding);
      const fresh = isDeepStrictEqual(discovered.get(binding.name), projected);
      // Only an exact unchanged stage-before entry has preservation provenance. An explicit
      // addition/replacement still needs eligible discovery, even when its name already existed.
      const preserved = verifiedBefore.has(stage) && !authoredNames.has(binding.name)
        && before.some((entry) => isDeepStrictEqual(entry, binding));
      if (!fresh && !preserved) problems.push(`${binding.name}: actions file differs from discovered metadata or unchanged before-config evidence`);
    }
    const code = artifactText(fixture, stage.source);
    const write = calls.slice(0, uploadIndex).filter((entry) => /^Write\s+/.test(entry.command) && fileName(entry.command.slice(6)) === stage.target).at(-1);
    if (!write || artifactText(fixture, write.artifact) !== code) problems.push(`${stage.id}: uploaded API source is not the actual preceding generated snapshot`);
    // The built-ins this stage authors are held to the catalogue's call contract and the generated pattern; a preserved call is kept as it was written.
    const authoredBuiltIns = !authoring.includes(stage.upload) ? []
      : (stage.beforeConfig ? (stage.change?.add || []).filter(isBuiltInBinding) : partitionBindings(desired).builtIns).map((binding) => binding.name);
    problems.push(...runtimeProblems(code, desired, contract.outputs, lookupMetadata, new Set(authoredBuiltIns)));
    if (authoredBuiltIns.length) problems.push(...builtInRuntimeProblems(code, authoredBuiltIns));
  }
  const last = contract.stages.at(-1);
  if (artifactText(fixture, last.target) !== artifactText(fixture, last.source)) problems.push('final API TSX differs from the final lifecycle stage');
  return problems;
}

module.exports = {
  customApiProblems, customApiGateProblems, customApiGateVerdict, gradeCustomApi, gradeCustomApiGate, carriesCustomApi, CUSTOM_API_GATE_UNSCORED,
};
