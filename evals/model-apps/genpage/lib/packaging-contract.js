'use strict';

const { isDeepStrictEqual } = require('node:util');
const { APPMODULE_COMPONENT_TYPE } = require('../../../../plugins/model-apps/scripts/add-page-to-solution.js');
const { workflowCalls, isUpload, resultObject, unassociatedCallProblems } = require('./workflow-evidence.js');
const { artifactJson, commandInfo, fileName, isGuid } = require('./evidence-utils.js');
const { planSection } = require('./plan-evidence.js');

const isPackaging = (command) => /\badd-page-to-solution\.js\b/.test(command);
const csv = (value) => typeof value === 'string' ? [...new Set(value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))] : [];
const okResponse = (request) => Number.isInteger(request.response?.status) && request.response.status >= 200 && request.response.status < 300;

function packagingProblems(fixture) {
  const calls = workflowCalls(fixture);
  const packages = calls.filter((call) => isPackaging(call.command));
  const section = planSection(fixture.genpagePlan, 'Solution Packaging');
  const optedIn = /Package into solution:\s*true\b/i.test(section || '');
  if (!optedIn) return packages.length ? ['packaging ran without explicit plan opt-in'] : [];
  const contract = fixture.manifest?.packaging;
  if (!contract) return ['packaging has no deployed identity/attempt evidence'];
  const problems = unassociatedCallProblems(fixture);
  const pages = contract.pages || [];
  const pageIds = pages.map((page) => page.pageId?.toLowerCase());
  if (!isGuid(contract.appId) || !pages.length || pageIds.some((id) => !isGuid(id)) || new Set(pageIds).size !== pageIds.length) problems.push('deployed packaging app/pages need distinct valid GUID identities');
  const solution = /^\s*[-*]?\s*Solution:\s*(\S+)/m.exec(section)?.[1];
  if (solution !== contract.solution || !/^[A-Za-z][A-Za-z0-9_]*$/.test(solution || '')) problems.push('packaging solution does not match the approved unique name');
  const deployed = new Map();
  for (const call of calls.filter((entry) => isUpload(entry.command))) {
    const result = resultObject(call);
    const { flags } = commandInfo(call);
    if (result?.ok === true && flags['app-id'] === contract.appId) deployed.set(fileName(flags['code-file']), result.pageId);
  }
  if ([...deployed.keys()].sort().join('|') !== pages.map((page) => page.file).sort().join('|')) {
    problems.push('packaging declared page set omits an actual deployed upload');
  }
  for (const page of pages) {
    const deploy = calls.filter((call) => isUpload(call.command) && fileName(commandInfo(call).flags['code-file']) === page.file).at(-1);
    if (resultObject(deploy || {})?.ok !== true || resultObject(deploy || {}).pageId !== page.pageId
      || commandInfo(deploy || {}).flags['app-id'] !== contract.appId) problems.push(`${page.file}: explicit packaging id is not backed by its deployed result/app`);
  }
  const refs = [...new Set((contract.connectionReferences || []).map((name) => name.toLowerCase()))].sort();
  const boundRefs = [...new Set((contract.configs || []).flatMap((name) => (artifactJson(fixture, name).connectorBindings || []).map((binding) => binding.logicalName?.toLowerCase())))].sort();
  if (!isDeepStrictEqual(refs, boundRefs)) problems.push('packaging references must include exactly the deployed connector logical names');
  const solutionCall = calls.filter((call) => /\bprovision-solution\.js\b/.test(call.command)).at(-1);
  const resolvedSolution = resultObject(solutionCall || {});
  if (resolvedSolution?.ok !== true || resolvedSolution.uniqueName !== solution || resolvedSolution.solutionId !== contract.solutionId || !isGuid(contract.solutionId)) {
    problems.push('target solution identity is not backed by successful provision/discovery evidence');
  }
  const attempts = contract.attempts || [];
  if (!attempts.length || attempts.length !== packages.length || new Set(attempts.map((attempt) => attempt.event)).size !== attempts.length) problems.push('packaging evidence must account for every command/result attempt');
  for (const attempt of attempts) {
    const call = packages.find((entry) => entry.id === attempt.event);
    if (!call) { problems.push(`missing packaging result ${attempt.event}`); continue; }
    const { flags, positional, problems: flagProblems } = commandInfo(call);
    problems.push(...flagProblems);
    if (Object.keys(flags).some((flag) => !['page-ids', 'connection-refs'].includes(flag))) problems.push('packaging command has an unsupported flag');
    const script = positional.findIndex((token) => fileName(token) === 'add-page-to-solution.js');
    const args = positional.slice(script + 1);
    const [env, requestedSolution, appId] = args;
    if (script < 0 || args.length !== 3 || requestedSolution !== solution || !/^https:\/\//.test(env || '')) problems.push('packaging command omits or changes environment/solution/app arguments');
    const requestedPages = csv(flags['page-ids']);
    const malformed = !isGuid(appId) || requestedPages.some((id) => !isGuid(id));
    const requests = call.requests;
    const result = resultObject(call);
    if (!Array.isArray(requests)) { problems.push('packaging needs recorded request/write evidence'); continue; }
    if (malformed) {
      if (attempt.outcome !== 'refused' || result?.ok !== false || requests.length || !/GUID|identity/i.test(result?.error || '') || call.userMessage !== result.error) {
        problems.push('bad packaging identities must refuse before any read/write and surface the error');
      }
      continue;
    }
    if (appId !== contract.appId || [...requestedPages].sort().join('|') !== [...pageIds].sort().join('|')) problems.push('every deployed page id must be passed explicitly to packaging, never inferred from the app');
    if (csv(flags['connection-refs']).sort().join('|') !== refs.join('|')) problems.push('packaging command omits or changes a deployed connection reference');
    const posts = requests.filter((request) => request.method === 'POST');
    const firstPost = requests.findIndex((request) => request.method === 'POST');
    const types = new Map();
    const refIds = new Map();
    for (const [index, request] of requests.entries()) {
      if (request.method === 'GET') {
        if (firstPost !== -1 && index > firstPost) problems.push('component types/reference lookups must complete before the first write');
        const entity = /EntityDefinitions\(LogicalName='(uxagentproject|connectionreference)'\)/.exec(request.path);
        if (entity && okResponse(request)) {
          const type = Number(request.response.data?.ObjectTypeCode);
          if (!Number.isInteger(type) || type <= 0) problems.push('component type metadata is invalid');
          else types.set(entity[1], type);
        }
        const ref = /connectionreferencelogicalname eq '([^']+)'/.exec(request.path);
        if (ref && okResponse(request)) {
          const id = request.response.data?.value?.[0]?.connectionreferenceid;
          if (!isGuid(id)) problems.push('connection reference lookup returned no valid id');
          else refIds.set(ref[1].toLowerCase(), id);
        }
      } else if (request.method !== 'POST' || request.path !== 'AddSolutionComponent') problems.push('unexpected packaging write/request');
      if (!okResponse(request) && index !== requests.length - 1) problems.push('packaging continued after a failed preflight/component request');
    }
    const failure = requests.some((request) => !okResponse(request));
    if (posts.length && (!types.has('uxagentproject') || (refs.length && (!types.has('connectionreference') || refs.some((name) => !refIds.has(name)))))) {
      problems.push('packaging wrote before resolving all environment-specific component types/references');
    }
    const expected = [
      { type: 'appmodule', id: contract.appId, componentType: APPMODULE_COMPONENT_TYPE, required: true },
      ...requestedPages.map((id) => ({ type: 'uxagentproject', id, componentType: types.get('uxagentproject'), required: true })),
      ...refs.map((name) => ({ type: 'connectionreference', logicalName: name, id: refIds.get(name), componentType: types.get('connectionreference'), required: false })),
    ];
    const completed = [];
    for (const [index, request] of posts.entries()) {
      const entry = expected[index];
      const body = entry && { ComponentId: entry.id, ComponentType: entry.componentType, SolutionUniqueName: solution, AddRequiredComponents: entry.required };
      if (!entry || !isDeepStrictEqual(request.body, body)) problems.push('packaging must add the app before every explicit page/reference with correct solution/types/required flags');
      if (entry && okResponse(request)) completed.push(entry);
    }
    if (failure) {
      if (attempt.outcome !== 'failed' || result?.ok !== false || !result.error || call.userMessage !== result.error) problems.push('partial/preflight packaging failure was hidden or reported as success');
    } else if (attempt.outcome !== 'success' || result?.ok !== true || completed.length !== expected.length) problems.push('packaging omitted components or did not report complete success');
    if (result?.ok === true) {
      const added = expected.map(({ type, id, logicalName }) => ({ type, id, ...(logicalName && { logicalName }) }));
      if (!isDeepStrictEqual(result.added, added)) problems.push('packaging result added list differs from explicit requested components');
    }
    if (completed.length || attempt.readback) {
      const readback = calls.find((entry) => entry.id === attempt.readback);
      const readResult = resultObject(readback || {});
      if (!readback || calls.indexOf(readback) <= calls.indexOf(call) || !readback.command.includes(contract.solutionId) || readResult?.ok !== true || !Array.isArray(readResult.data?.value)) {
        problems.push('packaging needs a successful subsequent read-back from the same solution');
      } else {
        const key = (entry) => `${entry.id.toLowerCase()}:${entry.componentType}`;
        const wanted = completed.map(key).sort();
        const directIds = new Set(expected.map((entry) => entry.id).filter(isGuid).map((id) => id.toLowerCase()));
        if (readResult.data.value.some((entry) => !isGuid(entry.objectid) || !Number.isInteger(entry.componenttype) || entry.componenttype <= 0)) {
          problems.push('solution read-back contains malformed component identities/types');
        }
        // AddRequiredComponents also pulls sitemap/project-file dependencies; an existing solution
        // may contain unrelated rows too. Grade the explicit app/page/reference scope, not the whole
        // solution as though the packaging CLI had promised to empty it (SKILL.md Phase 6.7).
        const actual = readResult.data.value.filter((entry) => directIds.has(String(entry.objectid).toLowerCase()))
          .map((entry) => `${String(entry.objectid).toLowerCase()}:${entry.componenttype}`).sort();
        if (!isDeepStrictEqual(wanted, actual)) problems.push('solution read-back does not contain exactly the completed component writes');
      }
    }
  }
  return problems;
}

module.exports = { packagingProblems, isPackaging };
