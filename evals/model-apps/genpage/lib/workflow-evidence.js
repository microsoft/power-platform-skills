'use strict';

const { parsePacConnectionList } = require('../../../../plugins/model-apps/scripts/list-connections.js');
const { commandInfo } = require('./evidence-utils.js');
const { planSection } = require('./plan-evidence.js');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const currentContract = (fixture) => (fixture.contractVersion || fixture.manifest?.contractVersion || 1) >= 2;
const isUpload = (command) => /\bgenpage-upload\.js\b|\bpac(?:\.exe|\.cmd)?\s+model\s+genpage\s+upload\b/i.test(command);
const isAuth = (command) => /\bcheck-auth\.js\b/.test(command);
const isDiscovery = (command) => /\blist-connections\.js\b/.test(command);
const isMutation = (command) => isUpload(command)
  || /\b(?:provision-entities|create-table|add-column|create-relationship|create-record|create-connection-reference|add-page-to-solution|provision-solution)\.js\b/.test(command)
  || /\bpac(?:\.exe|\.cmd)?\s+model\s+create\b|\b(?:create-connection|auth-switch)\b/.test(command)
  || /\b(?:Task|Dispatched)\s+genpage-entity-builder\b|\bgenpage-entity-builder\s+invoked\b/i.test(command);
const isGeneration = (command) => /\b(?:Task|Write|Edit|Generate)\b[^\n]*(?:genpage-page-builder|\.tsx\b)/i.test(command);

function resultObject(call) {
  if (isObject(call.result)) return call.result;
  if (typeof call.result !== 'string') return null;
  try {
    const value = JSON.parse(call.result);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function historicalResult(text) {
  // Captures use `node check-auth.js -> ok: true`, `Result: ok=false, blocker=whoami_403`,
  // or an abbreviated `{ ok: true, ... }`. Read the FIRST attached result only, never an
  // arbitrary later `ok:true` in the log. JSON-looking but broken results must not fall
  // back to a substring match. These summaries are compatibility evidence, not current JSON.
  const match = /(?:^\s*[-*]?\s*Result:\s*|(?:\u2192|->)\s*(?:returned\s*)?)([^\n]*)/im.exec(text);
  const raw = match ? match[1].trim().replace(/^`|`$/g, '') : '';
  if (/^\{\s*"/.test(raw) || /^\[/.test(raw)) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  const abbreviated = /^\{\s*ok:\s*(true|false)\s*,\s*\.\.\.\s*\}$/.exec(raw);
  if (abbreviated) return { ok: abbreviated[1] === 'true' };
  const ok = /^ok\s*[:=]\s*(true|false)\b/i.exec(raw);
  if (ok) {
    const blocker = /\bblocker\s*[:=]\s*['"]?([a-z_]+)/i.exec(raw);
    const identities = /\bidentitiesMatch\s*[:=]\s*(true|false)\b/i.exec(raw);
    return {
      ok: ok[1].toLowerCase() === 'true',
      ...(blocker && { blocker: blocker[1] }),
      ...(identities && { identitiesMatch: identities[1].toLowerCase() === 'true' }),
    };
  }
  const connections = /^(\d+)\s+connections?\s+found\b/i.exec(raw);
  if (connections) return { ok: true, connectionsFound: Number(connections[1]) };
  return null;
}

function workflowCalls(fixture) {
  if (Array.isArray(fixture.events)) return fixture.events;
  const lines = String(fixture.workflowLog || '').split(/\r?\n/);
  const calls = [];
  let active = null;
  for (const line of lines) {
    const command = /\b(?:node(?:\.exe)?\s+|pac(?:\.exe|\.cmd)?\s+|npx(?:\.cmd)?\s+|Task\s+genpage-|Dispatched\s+genpage-|genpage-entity-builder\s+invoked\b)/i.exec(line);
    if (command && !/^\s*#/.test(line) && !/\bnot\s+(?:run|invoked)\b|\bSKIPPED\b/i.test(line)) {
      if (active) calls.push({ ...active, result: historicalResult(active.text) });
      active = { id: `log-${calls.length + 1}`, command: line.slice(command.index), text: line, historical: true };
    } else if (active) {
      // A heading ends the result block, even if its next phase contains no command.
      if (/^\s*#/.test(line)) {
        calls.push({ ...active, result: historicalResult(active.text) });
        active = null;
      } else {
        active.text += '\n' + line;
      }
    }
  }
  if (active) calls.push({ ...active, result: historicalResult(active.text) });
  return calls;
}

function unassociatedCallProblems(fixture) {
  if (!currentContract(fixture) || !Array.isArray(fixture.events)) return [];
  const operation = (command) => /\bpac(?:\.exe|\.cmd)?\s+model\s+genpage\s+upload\b/.test(command)
    ? 'raw-pac-upload' : command.match(/\b([\w-]+)\.js\b/)?.[1]
      || command.match(/\b(?:create-connection|auth-switch|genpage-entity-builder)\b/)?.[0] || command;
  const risky = (call) => isAuth(call.command) || isDiscovery(call.command) || isMutation(call.command) || isGeneration(call.command);
  const counts = (calls) => {
    const map = new Map();
    for (const call of calls.filter(risky)) {
      const key = operation(call.command);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };
  const logged = counts(workflowCalls({ workflowLog: fixture.workflowLog }));
  const recorded = counts(fixture.events);
  return [...logged].filter(([key, count]) => count > (recorded.get(key) || 0))
    .map(([key]) => `${key}: logged command has no associated result event`);
}

function authGateProblems(fixture, { required = false } = {}) {
  const calls = workflowCalls(fixture);
  const gates = calls.filter((call) => isAuth(call.command));
  const problems = unassociatedCallProblems(fixture);
  if (gates.length === 0) return required ? [...problems, 'check-auth.js not invoked'] : problems;
  const strict = currentContract(fixture);
  let latest = null;
  let timeoutAttempts = 0;
  const normalizedEnv = (value) => typeof value === 'string' ? value.trim().replace(/\/+$/, '').toLowerCase() : null;
  const plannedEnv = /^\s*[-*]?\s*URL:\s*(https:\/\/\S+)/m.exec(planSection(fixture.genpagePlan, 'Environment') || '')?.[1];
  for (const call of calls) {
    if (isAuth(call.command)) {
      const result = resultObject(call);
      latest = { call, result };
      if (!result || typeof result.ok !== 'boolean') {
        problems.push(`${call.id || 'check-auth'}: malformed or missing auth result`);
        continue;
      }
      if (strict && !/--require-pac\b/.test(call.command)) problems.push('genpage auth gate is missing --require-pac');
      if (strict && (typeof result.message !== 'string' || !result.message.trim()
        || !Array.isArray(result.warnings) || result.warnings.some((warning) => typeof warning !== 'string'))) {
        problems.push('auth result has malformed message/warnings fields');
      }
      if (result.ok) {
        if (result.blocker != null || (strict && (result.blocker !== null || result.whoAmI?.ok !== true))) {
          problems.push('auth ok:true contradicts its blocker or WhoAmI result');
        }
        if (strict && typeof result.identitiesMatch !== 'boolean') problems.push('auth result omits identitiesMatch');
        if (strict && (typeof result.envUrl !== 'string' || !/^https:\/\/[^/\s]+\/?$/.test(result.envUrl))) problems.push('successful auth result omits its environment URL');
        const requestedEnv = commandInfo(call).flags.env;
        if (strict && ((typeof requestedEnv === 'string' && /^https:\/\//.test(requestedEnv) && normalizedEnv(requestedEnv) !== normalizedEnv(result.envUrl))
          || (plannedEnv && normalizedEnv(plannedEnv) !== normalizedEnv(result.envUrl)))) {
          problems.push('successful auth gate belongs to a different command/plan environment');
        }
        if (strict && result.identitiesMatch === false && call.userMessage !== result.message) {
          problems.push('warning-only identity mismatch was not surfaced verbatim');
        }
        timeoutAttempts = 0;
      } else {
        if (strict && (typeof result.blocker !== 'string' || !result.blocker || typeof result.message !== 'string' || !result.message)) {
          problems.push('failed auth result omits its blocker or advice');
        }
        if (strict && call.userMessage !== result.message) problems.push('auth failure advice was not surfaced verbatim');
        if (/^(az|pac)_timeout$/.test(result.blocker || '')) {
          timeoutAttempts += 1;
          if (timeoutAttempts > 2) problems.push('auth timeout retried more than once');
          if (strict && (!/did not answer|timed? out|too slow|timeout/i.test(result.message || '')
            || /\bis (?:not installed|signed out|not logged in)\b/i.test(result.message || ''))) {
            problems.push(`${result.blocker} was misreported as absent or signed out`);
          }
        } else {
          timeoutAttempts = 0;
        }
      }
    } else if (isMutation(call.command)) {
      if (!latest || latest.result?.ok !== true || latest.result.blocker != null) {
        problems.push(`${call.command}: mutation attempted without the latest successful auth gate`);
      } else if (strict) {
        // A successful WhoAmI for one environment does not authorize a write to another.
        // Only visible literal URLs are compared; evaluating shell variables would execute evidence.
        const info = commandInfo(call);
        const env = info.flags.env || info.positional.find((value) => /^https:\/\//.test(value));
        if (typeof env === 'string' && /^https:\/\//.test(env) && normalizedEnv(env) !== normalizedEnv(latest.result.envUrl)) {
          problems.push('mutation environment differs from the latest successful auth gate');
        }
      }
    }
  }
  if (latest?.result?.ok === false && strict) {
    if (!/\bhalt(?:ed)?\b|\bstop(?:ped)?\b|\bneeds_input\b/i.test(fixture.workflowLog || '')) {
      problems.push('final failed auth gate did not halt the workflow');
    }
    if (/^(az|pac)_timeout$/.test(latest.result.blocker || '')) {
      if (timeoutAttempts !== 2) problems.push('final auth timeout lacks the one bounded retry');
      if (latest.result.blocker === 'az_timeout' && !/POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS/.test(latest.result.message || '')) {
        problems.push('final Azure CLI timeout omits the configurable budget advice');
      }
    }
  }
  return problems;
}

function discoveryProblems(fixture, { required = false, needsBinding = false } = {}) {
  const calls = workflowCalls(fixture);
  let latest = null;
  const strict = currentContract(fixture);
  const problems = unassociatedCallProblems(fixture);
  for (const call of calls) {
    if (isDiscovery(call.command)) {
      const result = resultObject(call);
      latest = { call, result };
      if (!result || typeof result.ok !== 'boolean') {
        problems.push('connection discovery returned malformed or missing results');
        continue;
      }
      if (result.ok && strict && (!Array.isArray(result.connections) || !Array.isArray(result.connectionReferences))) {
        problems.push('successful discovery must include connections and connectionReferences arrays');
      }
      if (typeof call.rawOutput === 'string') {
        try {
          const rows = parsePacConnectionList(call.rawOutput);
          if (result.ok && Array.isArray(result.connections) && rows.length !== result.connections.length) {
            problems.push('discovery result does not match the recorded PAC rows');
          }
        } catch (error) {
          if (result.ok) problems.push(`unreadable connection listing was treated as success: ${error.message}`);
        }
      }
      if (!result.ok && strict && call.userMessage !== (result.message || result.error)) {
        problems.push('failed discovery error was not surfaced verbatim');
      }
      if (Array.isArray(result.connections)) {
        let sawUnready = false;
        for (const row of result.connections) {
          if (!isObject(row) || !row.connectionId || !row.connectorId) problems.push('discovery contains an unusable connection row');
          if (row.readyToBind === false) sawUnready = true;
          if (row.readyToBind === true && sawUnready) problems.push('ready-to-bind connections must be offered first');
        }
      }
    } else if (latest && latest.result?.ok !== true
      && (isUpload(call.command) || /\b(?:create-connection|auth-switch)\b|\bcreate-connection-reference\.js\b/.test(call.command))) {
      problems.push('failed discovery must never create a connection or reference, switch auth, or upload');
    }
  }
  if (!latest) return required ? [...problems, 'list-connections.js not invoked'] : problems;
  if (needsBinding && latest.result?.ok !== true) problems.push('a planned binding cannot be derived from failed discovery');
  if (strict && latest.result?.ok === false && !/\bneeds_input\b/i.test(fixture.workflowLog || '')) {
    problems.push('failed discovery must return needs_input rather than claim no connections');
  }
  return problems;
}

function refusalProblems(fixture) {
  if (fixture.manifest?.expectedOutcome !== 'refused') return ['fixture does not declare an expected refusal'];
  const stage = fixture.manifest.refusal?.stage;
  const calls = workflowCalls(fixture);
  const problems = [];
  if ((fixture.files || []).length || calls.some((call) => isGeneration(call.command) || isMutation(call.command))) {
    problems.push('refused workflow generated a page or attempted a mutation');
  }
  if (stage === 'custom-api') {
    // Loaded only while scoring this refusal to keep the shared evidence primitives independent
    // of the API lifecycle module (which itself consumes those primitives).
    const { customApiGateProblems } = require('./custom-api-contract.js');
    return problems.concat(customApiGateProblems(fixture));
  }
  const predicate = stage === 'auth' ? isAuth : stage === 'discovery' ? isDiscovery : null;
  if (!predicate) return [...problems, `unsupported refusal stage: ${stage}`];
  const gate = calls.filter((call) => predicate(call.command)).at(-1);
  if (resultObject(gate || {})?.ok !== false) problems.push('refusal has no associated failed gate');
  return problems.concat(stage === 'auth' ? authGateProblems(fixture, { required: true }) : discoveryProblems(fixture, { required: true }));
}

module.exports = {
  currentContract, isObject, isUpload, isAuth, isDiscovery, isMutation, isGeneration,
  resultObject, workflowCalls, authGateProblems, discoveryProblems, refusalProblems,
  unassociatedCallProblems,
};
