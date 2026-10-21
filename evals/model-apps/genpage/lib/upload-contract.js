'use strict';

const { isDeepStrictEqual } = require('node:util');
const { currentContract, workflowCalls, isUpload, isObject, resultObject, unassociatedCallProblems } = require('./workflow-evidence.js');
const { artifactText, artifactJson, commandInfo, isGuid, scriptRuns } = require('./evidence-utils.js');

const sameJson = (left, right) => isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
const switchOn = (value) => value === true || value === 'true';

// #673. Before an update, genpage-upload.js compares the deployed page with the base marker beside
// the code file and refuses with one of these codes. A refusal is a stop: it must come before the
// page backend writes anything. `--overwrite-deployed` skips the comparison, and the skill may pass it only
// after the user chose this answer verbatim. SKILL.md Phase 6, edit-flow.md Edit Phase 6 and
// verify-flow.md 7.5 record that answer as its own line, before the upload command:
//   Choice: Overwrite the deployed changes
//   Choice: Stop so I can merge
// A Choice line sets the pending answer. Each genpage-upload.js line consumes it and leaves
// none, so one approval cannot cover a later upload — including a second copy of the same
// command. indexOf would bind every later copy to the first occurrence. A mention of the words
// in an options list, a stop, or a choice logged after the command is not consent.
const DIVERGENCE_CODES = new Set(['no-base', 'deployed-changed', 'deployed-unreadable']);
const OVERWRITE_CHOICE_LINE = 'Choice: Overwrite the deployed changes';

function uploadChoiceLines(workflowLog) {
  const entries = [];
  let pending = null;
  for (const line of String(workflowLog || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Choice:')) {
      pending = trimmed;
      continue;
    }
    if (/\bgenpage-upload\.js\b/.test(line)) {
      entries.push({ line, choice: pending, used: false });
      pending = null;
    }
  }
  return entries;
}

function consumedChoice(entries, command) {
  if (typeof command !== 'string' || !command) return null;
  const match = entries.find((entry) => !entry.used && lineCarriesCommand(entry.line, command));
  if (!match) return null;
  match.used = true;
  return match.choice;
}

// The logged line must carry this exact command, not a longer one that merely starts with it: an
// upload with `--overwrite-deployed=false` is a different command from a later bare
// `--overwrite-deployed`, and must not lend that later upload its consent entry. Only a closing
// code span or whitespace may follow the command on its line.
function lineCarriesCommand(line, command) {
  for (let at = line.indexOf(command); at >= 0; at = line.indexOf(command, at + 1)) {
    if (/^[`\s]*$/.test(line.slice(at + command.length))) return true;
  }
  return false;
}

function bindingSet(value, idKey) {
  if (!Array.isArray(value)) throw new Error(`${idKey} bindings must be an array`);
  const names = value.map((entry) => entry?.[idKey]);
  if (names.some((name) => typeof name !== 'string' || !name.trim()) || new Set(names).size !== names.length) {
    throw new Error(`${idKey} bindings need unique non-empty names`);
  }
  return [...value].sort((a, b) => a[idKey].localeCompare(b[idKey]));
}

function desiredBindings(before, change, idKey) {
  bindingSet(before, idKey);
  if (change === undefined) return before;
  if (!isObject(change)) throw new Error(`invalid ${idKey} binding change`);
  if (change.clear === true) {
    if ((change.add || []).length || (change.remove || []).length) throw new Error(`clear ${idKey} cannot also add or remove bindings`);
    return [];
  }
  const rows = new Map(before.map((entry) => [entry[idKey], entry]));
  for (const name of change.remove || []) {
    if (!rows.delete(name)) throw new Error(`cannot remove unknown ${idKey} ${name}`);
  }
  for (const row of change.add || []) rows.set(row[idKey], row);
  return bindingSet([...rows.values()], idKey);
}

function sameBindings(left, right, idKey) {
  return sameJson(bindingSet(left, idKey), bindingSet(right, idKey));
}

function uploadResultIdentityMatches(flags, result) {
  return isGuid(result?.pageId) && result.appId === flags['app-id']
    && (!flags['page-id'] || result.pageId === flags['page-id']);
}

function pageIdentityProblems(event, flags, result, beforePage, afterPage, update) {
  const problems = [];
  if (afterPage.pageId !== result?.pageId || afterPage.appId !== result?.appId) {
    problems.push(`${event}: read-back identity differs from the upload result`);
  }
  if (update && (beforePage.pageId !== flags['page-id'] || beforePage.appId !== flags['app-id'])) {
    problems.push(`${event}: update does not target the downloaded page in its app`);
  }
  return problems;
}

function sameRecordedEnvironment(left, right) {
  try { return typeof left === 'string' && typeof right === 'string' && new URL(left).origin === new URL(right).origin; }
  catch { return false; }
}

// This is the identity slice of the upload contract, not the optional full upload assertion.
// A binding-preservation consumer must call it itself before treating a before blob as authority.
function beforePageIdentityProblems(fixture, row, call, beforeConfig, afterConfig) {
  const event = call.id;
  const { flags } = commandInfo(call);
  const result = resultObject(call);
  const problems = [];
  if (row.mode !== 'update' || !isGuid(flags['page-id'])) {
    problems.push(`${event}: before-config preservation requires an existing update page target`);
  }
  if (row.beforeConfig !== beforeConfig || row.afterConfig !== afterConfig) {
    problems.push(`${event}: before-config identity evidence is associated with another snapshot`);
  }
  if (result?.ok !== true || !uploadResultIdentityMatches(flags, result)) {
    problems.push(`${event}: upload result does not preserve the requested page/app identity`);
  }
  const beforePage = artifactJson(fixture, row.beforePage);
  const afterPage = artifactJson(fixture, row.afterPage);
  if (!isObject(beforePage) || !isObject(afterPage)) throw new Error(`${event}: before/after page identity evidence must be objects`);
  problems.push(...pageIdentityProblems(event, flags, result, beforePage, afterPage, true));
  const calls = workflowCalls(fixture);
  const earlier = calls.slice(0, calls.findIndex((entry) => entry.id === call.id));
  let recordedDownloads = 0;
  let matchingDownloads = 0;
  for (const download of earlier) {
    const runs = scriptRuns(download, 'genpage.js');
    if (!runs.some((run) => run.verb === 'download') || resultObject(download)?.ok !== true) continue;
    recordedDownloads += 1;
    if (runs.length !== 1) {
      problems.push(`${event}: ambiguous download context cannot establish before-page provenance`);
      continue;
    }
    const { flags: source } = commandInfo(download);
    const ids = typeof source['page-id'] === 'string' ? source['page-id'].split(',').map((id) => id.trim()) : [];
    if (!ids.includes(beforePage.pageId)) continue;
    matchingDownloads += 1;
    const downloaded = resultObject(download);
    const hasPages = Object.hasOwn(downloaded, 'pages');
    // Array.from also visits unreadable holes in direct object evidence; map would skip them.
    const returnedIds = Array.isArray(downloaded.pages)
      ? Array.from(downloaded.pages, (page) => isObject(page) ? page.pageId : undefined) : [];
    const establishesBeforePage = (values) => values.length > 0 && values.includes(beforePage.pageId)
      && values.every((id) => isGuid(id) && ids.includes(id));
    // Current downloads return pages: [{ pageId, ... }]. A present empty/malformed list
    // contradicts the download; only genuinely absent fields retain historical shorthand.
    // Validate a recorded scalar independently so neither shape can hide a contradiction.
    if ((hasPages && !establishesBeforePage(returnedIds))
      || (downloaded.pageId !== undefined && !establishesBeforePage([downloaded.pageId]))) {
      problems.push(`${event}: recorded download result does not establish the before-page identity`);
    }
    if (source.env !== undefined && !sameRecordedEnvironment(source.env, flags.env)) {
      problems.push(`${event}: before-page environment context differs from the upload target`);
    }
    if (source['app-id'] !== undefined && source['app-id'] !== flags['app-id']) {
      problems.push(`${event}: before-page app context differs from the upload target`);
    }
  }
  if (recordedDownloads && !matchingDownloads) {
    problems.push(`${event}: before-page identity has no matching recorded download provenance`);
  }
  return problems;
}

// The one update that is not an ordinary edit: `--page-id` naming a page that an earlier create of the SAME code file wrote and did not finish (its failure result carries the page's id;
// the publish or the placement it was asked for failed). genpage-upload.js completes it by naming it again, and then the update may carry `--add-to-sitemap` and, for a page created with no
// app, no `--app-id`. SKILL.md Phase 6, "A create that did not finish".
function completesUnfinishedCreate(call, flags, calls) {
  if (!flags['page-id']) return false;
  return calls.slice(0, calls.indexOf(call)).some((earlier) => {
    const { flags: before } = commandInfo(earlier);
    const result = resultObject(earlier);
    return !before['page-id'] && before['code-file'] === flags['code-file'] && result?.ok === false
      && String(result.pageId || '').toLowerCase() === String(flags['page-id']).toLowerCase();
  });
}

function uploadTransportProblems(fixture) {
  if (!currentContract(fixture)) return [];
  const problems = unassociatedCallProblems(fixture);
  const calls = workflowCalls(fixture).filter((entry) => isUpload(entry.command));
  const choiceLines = uploadChoiceLines(fixture.workflowLog);
  if (!calls.length) problems.push('no upload invocation recorded');
  for (const call of calls) {
    const { flags, problems: flagProblems } = commandInfo(call);
    problems.push(...flagProblems);
    if (!/\bgenpage-upload\.js\b/.test(call.command) || /\bpac(?:\.exe|\.cmd)?\s+model\s+genpage\s+upload\b/.test(call.command)) {
      problems.push('current uploads must use scripts/genpage-upload.js, never a raw `pac model genpage upload`');
    }
    for (const flag of ['name', 'prompt', 'agent-message']) {
      if (Object.hasOwn(flags, flag)) problems.push(`current upload uses inline --${flag} instead of file transport`);
    }
    for (const flag of ['prompt-file', 'agent-message-file', ...(!flags['page-id'] ? ['name-file'] : [])]) {
      if (typeof flags[flag] !== 'string' || !artifactText(fixture, flags[flag]).trim()) problems.push(`upload lacks a non-empty --${flag} artifact`);
    }
    const result = resultObject(call);
    if (!result || typeof result.ok !== 'boolean') problems.push('upload result is malformed or missing');
    const update = Boolean(flags['page-id']);
    const completing = completesUnfinishedCreate(call, flags, calls);
    const placement = switchOn(flags['add-to-sitemap']);
    // `--app-id` is optional for a CREATE (a page needs no app: the first page of a new app is created before the app exists), but whatever is given is a GUID.
    if (flags['app-id'] !== undefined && !isGuid(flags['app-id'])) problems.push('upload app-id is not a GUID');
    // An update proves its page is in the app it names, and a placement is an edit of an app: each needs --app-id (genpage-upload.js refuses without it).
    if (update && !completing && !isGuid(flags['app-id'])) problems.push('an update must name the app the page is placed in (--app-id)');
    if (placement && !isGuid(flags['app-id'])) problems.push('--add-to-sitemap needs --app-id: the page is added to that app\'s navigation');
    if (update && (!isGuid(flags['page-id']) || (placement && !completing))) problems.push('update must name a valid page id and omit sitemap placement');
    // A create that names an app places its page in it. One that names none (the first page of a new app, which apps.js create then builds the app around) has no app to place it in.
    if (!update && flags['app-id'] !== undefined && !placement) problems.push('a create that names an app must include --add-to-sitemap');
    if (result?.ok && !uploadResultIdentityMatches(flags, result)) {
      problems.push('upload result does not preserve the requested app/page identity');
    }
    // Every upload consumes its own log entry, overwriting or not, so an entry an earlier upload
    // used can never be reached by a later one.
    const consumed = consumedChoice(choiceLines, call.command);
    if (switchOn(flags['overwrite-deployed']) && consumed !== OVERWRITE_CHOICE_LINE) {
      problems.push('upload passes --overwrite-deployed without the explicit "Overwrite the deployed changes" choice in the workflow log');
    }
    // A divergence code is a refusal, whatever else the result claims. ok:true, a write, or
    // forwarded args on that code would grade a write that the code says did not happen.
    if (result && DIVERGENCE_CODES.has(result.code) && (result.ok !== false || call.writes !== 0 || call.forwarded !== undefined)) {
      problems.push(`a ${result.code} refusal must stop the update before the page backend writes`);
    }
    for (const [flag, idKey] of [['connectors', 'logicalName'], ['actions', 'name']]) {
      if (flags[flag]) {
        const bindings = artifactJson(fixture, flags[flag]);
        bindingSet(bindings, idKey);
        if (flag === 'connectors' && bindings.some((entry) => Object.keys(entry).some((key) => /^connectionid$/i.test(key)))) {
          problems.push('connector binding files must not contain environment-specific ConnectionId values');
        }
      }
    }
  }
  return problems;
}

function uploadProblems(fixture) {
  const problems = uploadTransportProblems(fixture);
  if (!currentContract(fixture)) return problems;
  const calls = workflowCalls(fixture).filter((call) => isUpload(call.command));
  const rows = fixture.manifest?.uploads;
  if (!rows) return problems;
  if (!Array.isArray(rows) || rows.length !== calls.length || new Set(rows.map((row) => row.event)).size !== rows.length) {
    return [...problems, 'upload evidence must cover every associated upload exactly once'];
  }
  for (const row of rows) {
    const call = calls.find((entry) => entry.id === row.event);
    if (!call) { problems.push(`missing upload result ${row.event}`); continue; }
    const { flags } = commandInfo(call);
    const result = resultObject(call);
    const update = row.mode === 'update';
    if (update !== Boolean(flags['page-id'])) problems.push(`${row.event}: create/update flags disagree with the approved operation`);
    for (const [field, fileFlag, approved] of [
      ['prompt', 'prompt-file', row.approvedPrompt],
      ['agentMessage', 'agent-message-file', row.approvedAgentMessage],
    ]) {
      const text = artifactText(fixture, flags[fileFlag]).replace(/^\uFEFF/, '');
      if (typeof approved !== 'string' || text !== approved) problems.push(`${row.event}: ${field} file rewrites approved text`);
      if (result?.ok && call.forwarded?.[field] !== text) problems.push(`${row.event}: ${field} forwarded to the page backend differs from exact file text`);
    }
    const changes = row.changes || {};
    const explicitName = update ? changes.name : row.approvedName;
    let suppliedName;
    if (flags['name-file']) suppliedName = artifactText(fixture, flags['name-file']).replace(/^\uFEFF/, '').replace(/(?:\r?\n)+$/, '');
    if (explicitName !== undefined && (suppliedName !== explicitName || typeof explicitName !== 'string')) problems.push(`${row.event}: name-file does not preserve the approved name`);
    if (update && explicitName === undefined && flags['name-file']) problems.push(`${row.event}: unrelated edit supplied an unapproved rename`);
    if (row.outcome === 'refused' && DIVERGENCE_CODES.has(result?.code)) {
      // Whether the page backend wrote is graded per call in uploadTransportProblems; a row adds what only the
      // approved operation knows: the comparison exists only for an update.
      if (!update) problems.push(`${row.event}: a ${result.code} refusal can only answer an update`);
      if (result.code === 'deployed-changed' && !(Number.isInteger(result.lines?.added) && Number.isInteger(result.lines?.removed))) {
        problems.push(`${row.event}: a deployed-changed refusal lacks its added/removed line summary`);
      }
      continue;
    }
    if (row.outcome === 'refused') {
      // Any other refusal is a stop that never reached the page backend: no write, nothing forwarded.
      if (result?.ok !== false || call.writes !== 0 || call.forwarded !== undefined) problems.push(`${row.event}: a refused upload must not reach the page backend`);
      continue;
    }
    if (result?.ok !== true || call.writes !== 1) problems.push(`${row.event}: expected successful upload is refused or has no single page write`);
    const afterConfig = artifactJson(fixture, row.afterConfig);
    const afterPage = artifactJson(fixture, row.afterPage);
    if (!isObject(afterConfig) || !isObject(afterPage)) throw new Error(`${row.event}: after config/page metadata must be objects`);
    const beforeConfig = update ? artifactJson(fixture, row.beforeConfig) : {};
    const beforePage = update ? artifactJson(fixture, row.beforePage) : {};
    if (!isObject(beforeConfig) || !isObject(beforePage)) throw new Error(`${row.event}: before config/page metadata must be objects`);
    problems.push(...pageIdentityProblems(row.event, flags, result, beforePage, afterPage, update));
    if (update && afterPage.navigationTitle !== beforePage.navigationTitle) problems.push(`${row.event}: rename changed the untouched sitemap title`);

    // The page backend stores a name exactly as it is given — a `"`, a `%` or a `$(…)` is only text — and an update that gives none keeps the page's own, so the backend is sent
    // nothing for it (`forwarded.name` is absent) rather than a re-sent copy.
    const expectedName = explicitName !== undefined ? explicitName : (update ? beforePage.name : undefined);
    if (call.forwarded?.name !== explicitName || afterPage.name !== expectedName) problems.push(`${row.event}: own page name was changed or escaped again without approved intent`);
    // A create that placed the page in an app titles its sub-area with the page's name; one that named no app has no sitemap entry to title.
    if (!update && flags['add-to-sitemap'] && afterPage.navigationTitle !== explicitName) problems.push(`${row.event}: create navigation title differs from the approved name`);

    const explicitModel = changes.model !== undefined ? changes.model : flags.model;
    if (changes.model !== undefined && flags.model !== changes.model) problems.push(`${row.event}: explicit model does not match the approved change`);
    if (update && changes.model === undefined && flags.model && flags.model !== beforeConfig.model) problems.push(`${row.event}: model changed without approved intent`);
    const expectedModel = explicitModel || (typeof beforeConfig.model === 'string' ? beforeConfig.model.trim() : '');
    if (call.forwarded?.model !== (explicitModel || undefined) || (afterConfig.model || '') !== expectedModel) problems.push(`${row.event}: model read-back/forwarding does not preserve omission or explicit intent`);

    const beforeSources = beforeConfig.dataSources || [];
    if (!Array.isArray(beforeSources)) throw new Error(`${row.event}: dataSources is not an array`);
    const clearSources = switchOn(flags['clear-data-sources']);
    if (clearSources && flags['data-sources']) problems.push(`${row.event}: clear-data-sources contradicts data-sources`);
    // An omitted --data-sources leaves the page's own list (nothing is forwarded); `--clear-data-sources` is the one way to empty it.
    const givenSources = typeof flags['data-sources'] === 'string' ? flags['data-sources'].split(',').map((source) => source.trim()) : clearSources ? [] : undefined;
    const expectedSources = changes.dataSources || beforeSources;
    const forwardedSources = call.forwarded?.dataSources;
    const forwardedAsGiven = givenSources === undefined ? forwardedSources === undefined : Array.isArray(forwardedSources) && sameJson(forwardedSources, givenSources);
    if (!sameJson(givenSources || beforeSources, expectedSources) || !sameJson(afterConfig.dataSources || [], expectedSources) || !forwardedAsGiven) {
      problems.push(`${row.event}: data-source bindings changed without explicit intent`);
    }

    for (const [kind, flag, field, idKey] of [
      ['connectors', 'connectors', 'connectorBindings', 'logicalName'],
      ['actions', 'actions', 'actionBindings', 'name'],
    ]) {
      const before = beforeConfig[field] || [];
      const desired = desiredBindings(before, changes[kind], idKey);
      if (changes[kind] === undefined) {
        if (flags[flag]) problems.push(`${row.event}: unchanged ${kind} must omit --${flag}`);
      } else {
        if (!flags[flag] || !sameBindings(artifactJson(fixture, flags[flag]), desired, idKey)) problems.push(`${row.event}: ${kind} full replacement drops untouched bindings or differs from approved add/remove/clear`);
      }
      if (!sameBindings(afterConfig[field] || [], desired, idKey)) problems.push(`${row.event}: ${kind} read-back loses preserved or intended bindings`);
    }
  }
  return problems;
}

// The two dedicated preservation assertions grade the recorded before/after snapshots in
// manifest.uploads. uploadProblems falls back to the transport verdict when a fixture records
// none (right for the common upload assertion), but here that let both assertions pass with
// their evidence deleted. So each requires a row for its own mode: a non-refused create, or an
// update.
function uploadPreservationProblems(fixture, mode) {
  const rows = fixture.manifest?.uploads;
  if (!currentContract(fixture) || !Array.isArray(rows) || !rows.some((row) => row && row.mode === mode && row.outcome !== 'refused')) {
    return [`no ${mode} upload preservation evidence (manifest.uploads) to grade`];
  }
  return uploadProblems(fixture);
}

module.exports = {
  uploadProblems, uploadPreservationProblems, uploadTransportProblems, desiredBindings, sameBindings,
  uploadResultIdentityMatches, pageIdentityProblems, beforePageIdentityProblems, sameRecordedEnvironment,
};
