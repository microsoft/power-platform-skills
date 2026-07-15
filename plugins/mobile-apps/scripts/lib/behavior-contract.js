'use strict';

const crypto = require('node:crypto');
const { buildArtifactNameMap } = require('./modernizer-paths.js');

const BEHAVIOR_COLLECTIONS = Object.freeze([
  ['actions', 'action'],
  ['visibility', 'visibility'],
  ['validations', 'validation'],
  ['derivations', 'derivation'],
]);

// These operations change durable/server/integration/device outcomes. They stay
// exact even when no other behavior reads their result.
const CORE_ACTION_INTENTS = new Set([
  'patch', 'update', 'updateIf', 'remove', 'removeIf', 'submitForm',
  'connectorCall', 'flowCall', 'aiCall',
  'saveData', 'loadData', 'clearOfflineData',
  'launch', 'download', 'downloadJson', 'print',
  'exitApp', 'showHostInfo',
]);

// These are safe candidates only when dependency closure proves they do not
// feed a core sink. Unknown intents never enter this allowlist.
const REGENERABLE_ACTION_INTENTS = new Set([
  'navigate', 'back', 'notify', 'refresh', 'confirm',
  'reset', 'resetForm', 'newForm', 'editForm', 'viewForm',
  'select', 'setFocus', 'setProperty', 'enable', 'disable',
  'requestHide', 'read', 'literal', 'projection', 'predicate-only',
  'dead-code-assignment', 'dead-code-comment', 'trace', 'diagnostic',
]);

const STATE_ACTION_INTENTS = new Set([
  'setVar', 'setContext', 'collect', 'clearCollect', 'clear',
]);

// A state write is a regenerable candidate only when its name itself signals
// transient presentation/query choreography. Business-looking or ambiguous
// state defaults to core; backward closure can only promote, never demote.
const UI_STATE_NAME_RE = /(?:^|_)(?:loading|loaded|busy|saving|submitting|spinner|show|hide|visible|open|closed|expanded|collapsed|modal|dialog|popup|toast|message|error|step|wizard|tab|filter|search|query|sort|page|focus|disabled|enabled|refresh|menu|navigation|suggestions?|options?|choices?|results?|display)(?:_|$)/i;

function isTransientUiStateName(value) {
  const normalized = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return UI_STATE_NAME_RE.test(normalized);
}

const PRESENTATION_KEYWORDS = new Set([
  'set', 'updatecontext', 'collect', 'clearcollect', 'clear',
  'true', 'false', 'blank', 'not', 'and', 'or',
  'if', 'coalesce', 'isblank', 'isempty', 'iserror', 'error',
]);

function hasExternalBusinessIdentifiers(identifiers, stateNames) {
  const allowedState = new Set(toArray(stateNames).map((name) => String(name).toLowerCase()));
  return toArray(identifiers).some((name) =>
    !allowedState.has(String(name).toLowerCase())
    && !PRESENTATION_KEYWORDS.has(String(name).toLowerCase()));
}

function isSimpleStringLiteral(value) {
  const text = String(value || '').trim();
  return /^"(?:[^"]|"")*"$/.test(text) || /^'(?:[^']|'')*'$/.test(text);
}

function isSimpleNavigationTarget(value) {
  return /^[A-Za-z_][A-Za-z0-9_ ]{0,199}$/.test(String(value || '').trim());
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean))];
}

function stableId(prefix, identity) {
  return `${prefix}-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)}`;
}

function orderedBehaviorEntries(behaviors) {
  const rows = [];
  let order = 0;
  for (const [collection, group] of BEHAVIOR_COLLECTIONS) {
    for (const entry of toArray(behaviors && behaviors[collection])) {
      rows.push({ entry, collection, group, order: order++ });
    }
  }
  return rows;
}

function sourceLedgerHash(behaviors) {
  return crypto.createHash('sha256').update(JSON.stringify({
    actions: toArray(behaviors && behaviors.actions),
    visibility: toArray(behaviors && behaviors.visibility),
    validations: toArray(behaviors && behaviors.validations),
    derivations: toArray(behaviors && behaviors.derivations),
    unmatchedFormulas: toArray(behaviors && behaviors.unmatchedFormulas),
  })).digest('hex');
}

function stripPowerFxLiteralsAndComments(value) {
  const text = String(value || '');
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inBlockComment = false;
  let inLineComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; out += '\n'; }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1; }
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (ch === "'") { inSingle = true; out += ' '; continue; }
    if (ch === '"') { inDouble = true; out += ' '; continue; }
    out += ch;
  }
  return out;
}

function identifiersIn(value) {
  const text = stripPowerFxLiteralsAndComments(value);
  return unique(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).map((name) => name.toLowerCase());
}

function stateWritesFor(entry) {
  if (!entry || typeof entry !== 'object') return [];
  switch (entry.intent) {
    case 'setVar':
      return entry.name ? [String(entry.name)] : [];
    case 'setContext':
      return entry.context && typeof entry.context === 'object' && !Array.isArray(entry.context)
        ? Object.keys(entry.context)
        : [];
    case 'collect':
    case 'clearCollect':
    case 'clear':
      return entry.collection ? [String(entry.collection)] : [];
    default:
      // Local collection mutation remains stateful, while Dataverse/table
      // names do not use the canonical col_/var_ prefixes.
      if (['patch', 'update', 'updateIf', 'remove', 'removeIf'].includes(entry.intent)
          && /^(?:col_|var_)/i.test(String(entry.source || ''))) {
        return [String(entry.source)];
      }
      return [];
  }
}

function behaviorReadText(entry, group) {
  if (!entry || typeof entry !== 'object') return '';
  if (group !== 'action') return String(entry.formula || entry.expression || '');
  const values = [
    entry.sourceStatement,
    entry.expression,
    entry.baseRecord,
    entry.from,
    entry.target,
    entry.message,
    entry.value,
    entry.fields,
    entry.context,
    entry.args,
  ];
  for (const frame of toArray(entry.controlFlow)) {
    values.push(
      frame.condition,
      frame.expression,
      frame.match,
      frame.bindingsExpression,
      frame.bindings,
      frame.source
    );
  }
  return values.map((value) => typeof value === 'string' ? value : JSON.stringify(value || '')).join('\n');
}

function directClassification(group, entry, writes, reads, identifiers) {
  if (group === 'visibility') {
    const formula = String(entry && entry.formula || '');
    const securitySensitive = /\b(?:User|Office365Users|role|permission|authorize|admin|owner|createdby|modifiedby|email|tenant)\b/i.test(formula);
    if (!securitySensitive
        && reads.length > 0
        && reads.every(isTransientUiStateName)
        && !hasExternalBusinessIdentifiers(identifiers, reads)) {
      return { tier: 'candidate', reasonCodes: ['TRANSIENT_PRESENTATION_RULE_CANDIDATE'] };
    }
    return { tier: 'core', reasonCodes: ['DECLARATIVE_RULE'] };
  }
  if (group !== 'action') {
    return { tier: 'core', reasonCodes: ['DECLARATIVE_RULE'] };
  }
  const intent = String(entry && entry.intent || 'unknown');
  if (CORE_ACTION_INTENTS.has(intent)) {
    return { tier: 'core', reasonCodes: ['LOAD_BEARING_SIDE_EFFECT'] };
  }
  if (STATE_ACTION_INTENTS.has(intent)) {
    if (writes.length > 0
        && writes.every(isTransientUiStateName)
        && reads.every(isTransientUiStateName)
        && !hasExternalBusinessIdentifiers(identifiers, [...writes, ...reads])) {
      return { tier: 'candidate', reasonCodes: ['TRANSIENT_UI_STATE_CANDIDATE'] };
    }
    return { tier: 'core', reasonCodes: ['AMBIGUOUS_STATE_WRITE'] };
  }
  if (REGENERABLE_ACTION_INTENTS.has(intent)) {
    if (intent === 'navigate'
        && (!isSimpleNavigationTarget(entry.target)
          || (entry.context && typeof entry.context === 'object' && Object.keys(entry.context).length > 0))) {
      return { tier: 'core', reasonCodes: ['NAVIGATION_DATA_CONTRACT'] };
    }
    if (['notify', 'confirm'].includes(intent)
        && entry.message != null
        && !isSimpleStringLiteral(entry.message)) {
      return { tier: 'core', reasonCodes: ['DYNAMIC_USER_OUTCOME'] };
    }
    if (intent === 'refresh' && !isSimpleNavigationTarget(entry.source)) {
      return { tier: 'core', reasonCodes: ['DYNAMIC_DATA_TARGET'] };
    }
    if (['reset', 'select', 'setFocus', 'enable', 'disable'].includes(intent)
        && !isSimpleNavigationTarget(entry.target)) {
      return { tier: 'core', reasonCodes: ['DYNAMIC_CONTROL_TARGET'] };
    }
    if (['resetForm', 'newForm', 'editForm', 'viewForm'].includes(intent)
        && !isSimpleNavigationTarget(entry.form || entry.target)) {
      return { tier: 'core', reasonCodes: ['DYNAMIC_FORM_TARGET'] };
    }
    if (intent === 'setProperty'
        && !/^(?:true|false|Blank\(\)|-?\d+(?:\.\d+)?)$/i.test(String(entry.value || '').trim())
        && !isSimpleStringLiteral(entry.value)) {
      return { tier: 'core', reasonCodes: ['DYNAMIC_CONTROL_VALUE'] };
    }
    if (reads.some((name) => !isTransientUiStateName(name))) {
      return { tier: 'core', reasonCodes: ['BUSINESS_STATE_CONSUMER'] };
    }
    return { tier: 'candidate', reasonCodes: ['UI_PLUMBING_CANDIDATE'] };
  }
  return { tier: 'core', reasonCodes: ['UNKNOWN_OR_UNSAFE_TO_REGENERATE'] };
}

function nativeIntentFor(entry, group) {
  if (group === 'visibility') return entry.property === 'DisplayMode' ? 'native-control-state' : 'native-visibility-state';
  const intent = String(entry && entry.intent || 'unknown');
  switch (intent) {
    case 'navigate': return 'native-navigation';
    case 'back':
    case 'requestHide': return 'dismiss-current-surface';
    case 'notify': return 'native-feedback';
    case 'refresh': return 'query-refresh';
    case 'confirm': return 'native-confirmation';
    case 'resetForm':
    case 'newForm':
    case 'editForm':
    case 'viewForm': return 'native-form-mode';
    case 'reset': return 'clear-transient-input';
    case 'select':
    case 'setFocus': return 'native-focus-or-selection';
    case 'setProperty':
    case 'enable':
    case 'disable': return 'native-control-state';
    case 'setVar':
    case 'setContext': return 'transient-ui-state';
    case 'collect':
    case 'clearCollect':
    case 'clear': return 'native-query-or-list-state';
    case 'trace':
    case 'diagnostic': return 'native-diagnostic';
    case 'dead-code-assignment':
    case 'dead-code-comment':
    case 'literal':
    case 'projection':
    case 'predicate-only':
    case 'read': return 'discard-no-side-effect';
    default: return 'native-ui-intent';
  }
}

function guidanceFor(nativeIntent) {
  return ({
    'native-navigation': 'Navigate with the approved Expo Router contract; preserve destination and route context keys, not Canvas navigation plumbing.',
    'dismiss-current-surface': 'Dismiss or return using the native navigation surface.',
    'native-feedback': 'Present concise native success/error/notice feedback at the owning action boundary.',
    'query-refresh': 'Invalidate or refetch the named query after the owning operation.',
    'native-confirmation': 'Use an accessible native confirmation surface before the guarded action.',
    'native-form-mode': 'Represent the source form-mode transition through native form state and route intent.',
    'clear-transient-input': 'Clear only the owning transient input/form state.',
    'native-focus-or-selection': 'Use native focus/selection affordances rather than Canvas Select plumbing.',
    'native-control-state': 'Derive enabled/disabled/control state from native state instead of mutating Canvas properties.',
    'native-visibility-state': 'Derive presentation visibility from native component/action state rather than recreating a Canvas visibility flag.',
    'transient-ui-state': 'Replace the disconnected Canvas flag with native pending/loading/visibility state owned by the relevant action or component.',
    'native-query-or-list-state': 'Use a screen-scoped query/list model instead of recreating the disconnected Canvas collection choreography.',
    'native-diagnostic': 'Route diagnostic information to development logs without exposing technical copy in the UI.',
    'discard-no-side-effect': 'No native operation is required; retain this disposition only for deterministic source accounting.',
    'native-ui-intent': 'Regenerate the source presentation behavior using the approved native screen contract.',
  })[nativeIntent];
}

function safeControlFlowFrames(frames) {
  return toArray(frames).map((frame) => ({
    id: frame && frame.id || null,
    kind: frame && frame.kind || null,
    role: frame && frame.role || null,
    branchIndex: Number.isInteger(frame && frame.branchIndex) ? frame.branchIndex : null,
    caseIndex: Number.isInteger(frame && frame.caseIndex) ? frame.caseIndex : null,
    clauseIndex: Number.isInteger(frame && frame.clauseIndex) ? frame.clauseIndex : null,
  }));
}

function coreEntryForShard(entry, group) {
  const copy = JSON.parse(JSON.stringify(entry));
  if (group === 'action') {
    // `sourceFormula` is the complete event handler and is repeated on every
    // normalized leaf in the global ledger. Builders need the exact leaf
    // statement, payload, order, and control-flow frames—not N copies of the
    // same giant handler. The lossless formula remains in behaviors.json.
    delete copy.sourceFormula;
  }
  return copy;
}

function intentDataFor(entry, reads, writes) {
  const intent = String(entry && entry.intent || 'unknown');
  const data = {};
  if (entry.property) data.property = entry.property;
  if (writes.length) data.stateKeys = writes;
  if (reads.length) data.stateReads = reads;
  if (intent === 'navigate') {
    data.target = entry.target || null;
    data.contextKeys = entry.context && typeof entry.context === 'object' ? Object.keys(entry.context).sort() : [];
  }
  if (intent === 'refresh') data.source = entry.source || null;
  if (intent === 'notify') data.feedbackType = entry.type || null;
  if (['resetForm', 'newForm', 'editForm', 'viewForm'].includes(intent)) data.form = entry.form || null;
  if (['reset', 'select', 'setFocus', 'setProperty', 'enable', 'disable'].includes(intent)) data.target = entry.target || null;
  if (['collect', 'clearCollect', 'clear'].includes(intent)) data.collection = entry.collection || null;
  return data;
}

function buildBehaviorArtifacts(behaviors, screens, generatedAt = '1970-01-01T00:00:00.000Z', controlIntentCoverage = null) {
  const rows = orderedBehaviorEntries(behaviors);
  const rowById = new Map(rows.map((row) => [row.entry.behaviorId, row]));
  const writesById = new Map();
  const writersByKey = new Map();
  const canonicalStateName = new Map();

  for (const row of rows) {
    const writes = unique(stateWritesFor(row.entry));
    writesById.set(row.entry.behaviorId, writes);
    for (const name of writes) {
      const key = name.toLowerCase();
      if (!canonicalStateName.has(key)) canonicalStateName.set(key, name);
      if (!writersByKey.has(key)) writersByKey.set(key, []);
      writersByKey.get(key).push(row.entry.behaviorId);
    }
  }

  const nodes = new Map();
  for (const row of rows) {
    const behaviorId = row.entry.behaviorId;
    const writes = writesById.get(behaviorId) || [];
    const identifierReads = identifiersIn(behaviorReadText(row.entry, row.group));
    const reads = unique(identifierReads
      .filter((name) => writersByKey.has(name))
      .map((name) => canonicalStateName.get(name) || name)
      .filter((name) => !writes.some((written) => written.toLowerCase() === name.toLowerCase())));
    const dependsOn = unique(reads.flatMap((name) => writersByKey.get(name.toLowerCase()) || []).filter((id) => id !== behaviorId));
    const direct = directClassification(row.group, row.entry, writes, reads, identifierReads);
    nodes.set(behaviorId, {
      behaviorId,
      collection: row.collection,
      group: row.group,
      screen: row.entry.screen,
      control: row.entry.control || null,
      controlPath: row.entry.controlPath || row.entry.control || null,
      event: row.entry.event || null,
      property: row.entry.property || null,
      intent: row.entry.intent || row.entry.kind || row.group,
      order: row.order,
      tier: direct.tier,
      reasonCodes: [...direct.reasonCodes],
      stateReads: reads,
      stateWrites: writes,
      dependsOn,
      coreConsumers: [],
      intentHintId: null,
      shardFile: null,
    });
  }

  // Unclassified formulas are core review sinks. Promote every state writer
  // they read, because dropping an upstream writer would change unknown logic.
  const unmatchedStateReads = new Set();
  for (const unmatched of toArray(behaviors && behaviors.unmatchedFormulas)) {
    const text = [unmatched.sourceStatement, unmatched.formula, unmatched.raw, unmatched.sourceFormula].filter(Boolean).join('\n');
    for (const name of identifiersIn(text)) if (writersByKey.has(name)) unmatchedStateReads.add(name);
  }

  const coreQueue = [];
  for (const node of nodes.values()) if (node.tier === 'core') coreQueue.push(node.behaviorId);
  for (const stateKey of unmatchedStateReads) {
    for (const writerId of writersByKey.get(stateKey) || []) {
      const writer = nodes.get(writerId);
      if (writer && writer.tier !== 'core') {
        writer.tier = 'core';
        writer.reasonCodes.push('DEPENDENCY_OF_UNMATCHED_FORMULA');
        coreQueue.push(writerId);
      }
    }
  }

  // Backward closure from every load-bearing sink. This is intentionally
  // monotonic: uncertain/cyclic state can be promoted to core but never
  // demoted to a hint.
  for (let index = 0; index < coreQueue.length; index += 1) {
    const consumerId = coreQueue[index];
    const consumer = nodes.get(consumerId);
    if (!consumer) continue;
    for (const dependencyId of consumer.dependsOn) {
      const dependency = nodes.get(dependencyId);
      if (!dependency) continue;
      if (!dependency.coreConsumers.includes(consumerId)) dependency.coreConsumers.push(consumerId);
      if (dependency.tier !== 'core') {
        dependency.tier = 'core';
        dependency.reasonCodes.push('DEPENDENCY_OF_CORE');
        coreQueue.push(dependencyId);
      }
    }
  }

  // Propagate final core consumers transitively for explainability.
  for (const coreNode of [...nodes.values()].filter((node) => node.tier === 'core')) {
    const seen = new Set();
    const stack = [...coreNode.dependsOn];
    while (stack.length) {
      const dependencyId = stack.pop();
      if (seen.has(dependencyId)) continue;
      seen.add(dependencyId);
      const dependency = nodes.get(dependencyId);
      if (!dependency) continue;
      if (!dependency.coreConsumers.includes(coreNode.behaviorId)) dependency.coreConsumers.push(coreNode.behaviorId);
      stack.push(...dependency.dependsOn);
    }
  }

  for (const node of nodes.values()) {
    if (node.tier === 'candidate') {
      node.tier = 'regenerable';
      node.reasonCodes.push('DISCONNECTED_UI_PLUMBING');
    }
    node.reasonCodes = unique(node.reasonCodes);
    node.dependsOn.sort();
    node.coreConsumers.sort();
  }

  const screenNames = unique([
    'App',
    ...toArray(screens).map((screen) => screen && screen.name),
    ...rows.map((row) => row.entry.screen),
    ...toArray(behaviors && behaviors.unmatchedFormulas).map((entry) => entry && entry.screen),
  ]);
  const artifactNames = buildArtifactNameMap(screenNames, 'Screen');
  const shardFileByScreen = new Map(screenNames.map((screen) => [screen, `behavior-shards/${artifactNames.get(screen)}.json`]));
  const screenByName = new Map(toArray(screens).map((screen) => [screen && screen.name, screen]));
  const controlIntentsByScreen = new Map();
  for (const row of toArray(controlIntentCoverage && controlIntentCoverage.rows)) {
    if (!controlIntentsByScreen.has(row.screen)) controlIntentsByScreen.set(row.screen, []);
    controlIntentsByScreen.get(row.screen).push(row);
  }
  for (const node of nodes.values()) node.shardFile = shardFileByScreen.get(node.screen) || null;

  const actionsByHandler = new Map();
  for (const row of rows.filter((item) => item.group === 'action')) {
    const key = JSON.stringify([row.entry.screen, row.entry.controlPath || row.entry.control, row.entry.event]);
    if (!actionsByHandler.has(key)) actionsByHandler.set(key, []);
    actionsByHandler.get(key).push(row.entry.behaviorId);
  }
  for (const ids of actionsByHandler.values()) ids.sort((a, b) => nodes.get(a).order - nodes.get(b).order);

  const intentHints = [];
  for (const node of [...nodes.values()].sort((a, b) => a.order - b.order)) {
    if (node.tier !== 'regenerable') continue;
    const row = rowById.get(node.behaviorId);
    if (!row) throw new Error(`Internal behavior-contract error: source row missing for ${node.behaviorId}`);
    const nativeIntent = nativeIntentFor(row.entry, row.group);
    const hintId = stableId('ih', [node.behaviorId, nativeIntent]);
    node.intentHintId = hintId;
    const handlerKey = JSON.stringify([node.screen, node.controlPath, node.event]);
    const handlerIds = actionsByHandler.get(handlerKey) || [];
    const handlerIndex = handlerIds.indexOf(node.behaviorId);
    const before = handlerIds.slice(handlerIndex + 1).find((id) => nodes.get(id)?.tier === 'core') || null;
    const after = [...handlerIds.slice(0, Math.max(0, handlerIndex))].reverse().find((id) => nodes.get(id)?.tier === 'core') || null;
    intentHints.push({
      hintId,
      screen: node.screen,
      control: node.control,
      controlPath: node.controlPath,
      event: node.event,
      nativeIntent,
      guidance: guidanceFor(nativeIntent),
      sourceBehaviorIds: [node.behaviorId],
      placement: {
        afterCoreBehaviorId: after,
        beforeCoreBehaviorId: before,
      },
      controlFlow: safeControlFlowFrames(row.entry.controlFlow),
      data: intentDataFor(row.entry, node.stateReads, node.stateWrites),
    });
  }

  const hintsByScreen = new Map();
  for (const hint of intentHints) {
    if (!hintsByScreen.has(hint.screen)) hintsByScreen.set(hint.screen, []);
    hintsByScreen.get(hint.screen).push(hint);
  }

  const shards = new Map();
  const shardIndex = [];
  for (const screen of screenNames) {
    const shard = {
      $schema: 'behavior-shard-v1',
      generatedAt,
      screen,
      sourceLedger: 'behaviors.json',
      behaviorContract: 'behavior-contract.json',
      screenIntent: (() => {
        const source = screenByName.get(screen);
        if (!source) return screen === 'App' ? { kind: 'app-bootstrap' } : null;
        return {
          route: source.route || null,
          file: source.file || null,
          presentation: source.presentation || null,
          archetype: source.archetype || null,
          layoutKind: source.layoutKind || null,
          purpose: source.purpose || source.userStory || null,
          dataverseTablesUsed: toArray(source.dataverseTablesUsed),
          connectorsUsed: toArray(source.connectorsUsed),
          incomingParams: toArray(source.incomingParams),
          outgoingNavigation: toArray(source.outgoingNavigation),
        };
      })(),
      stats: {
        totalSourceBehaviors: 0,
        coreBehaviors: 0,
        regenerableBehaviors: 0,
        intentHints: 0,
        unmatchedFormulas: 0,
        controlIntents: 0,
      },
      actions: [],
      visibility: [],
      validations: [],
      derivations: [],
      intentHints: toArray(hintsByScreen.get(screen)),
      controlIntents: toArray(controlIntentsByScreen.get(screen)),
      unmatchedFormulas: toArray(behaviors && behaviors.unmatchedFormulas).filter((entry) => entry.screen === screen),
    };
    for (const row of rows.filter((item) => item.entry.screen === screen)) {
      const node = nodes.get(row.entry.behaviorId);
      shard.stats.totalSourceBehaviors += 1;
      if (node.tier === 'core') {
        shard[row.collection].push(coreEntryForShard(row.entry, row.group));
        shard.stats.coreBehaviors += 1;
      } else {
        shard.stats.regenerableBehaviors += 1;
      }
    }
    shard.stats.intentHints = shard.intentHints.length;
    shard.stats.unmatchedFormulas = shard.unmatchedFormulas.length;
    shard.stats.controlIntents = shard.controlIntents.length;
    const file = shardFileByScreen.get(screen);
    shards.set(file, shard);
    shardIndex.push({ screen, file, stats: { ...shard.stats } });
  }

  const classifications = [...nodes.values()].sort((a, b) => a.order - b.order).map((node) => ({
    ...node,
    order: undefined,
  }));
  // JSON serialization drops undefined, but remove explicitly for callers that
  // compare in-memory objects before serialization.
  for (const row of classifications) delete row.order;

  const stats = {
    totalBehaviors: classifications.length,
    coreBehaviors: classifications.filter((row) => row.tier === 'core').length,
    regenerableBehaviors: classifications.filter((row) => row.tier === 'regenerable').length,
    intentHints: intentHints.length,
    unmatchedFormulas: toArray(behaviors && behaviors.unmatchedFormulas).length,
    shards: shardIndex.length,
    dependencyEdges: classifications.reduce((sum, row) => sum + row.dependsOn.length, 0),
    stateKeys: writersByKey.size,
  };

  const contract = {
    $schema: 'behavior-contract-v1',
    generatedAt,
    rule: 'Keep exact load-bearing behavior through conservative backward dependency closure. Replace only disconnected Canvas UI plumbing with structured native intent hints. Ambiguity defaults to core.',
    sourceLedger: {
      file: 'behaviors.json',
      schema: behaviors && behaviors.$schema || 'behaviors-v1',
      sha256: sourceLedgerHash(behaviors),
    },
    stats,
    classifications,
    intentHints,
    shards: shardIndex,
    appShard: shardFileByScreen.get('App'),
  };
  return { contract, shards };
}

function attachWorkflowRefs(artifacts, workflowPlan) {
  const workflows = toArray(workflowPlan && workflowPlan.workflows);
  let totalRefs = 0;
  for (const shardRow of toArray(artifacts && artifacts.contract && artifacts.contract.shards)) {
    const shard = artifacts.shards.get(shardRow.file);
    if (!shard) throw new Error(`Internal behavior-contract error: shard missing for ${shardRow.file}`);
    shard.workflowRefs = workflows
      .filter((workflow) => workflow.source?.screen === shard.screen)
      .map((workflow) => ({
        workflowId: workflow.workflowId,
        coreBehaviorIds: toArray(workflow.source?.coreBehaviorIds),
        regenerableBehaviorIds: toArray(workflow.source?.regenerableBehaviorIds),
        intentHintIds: toArray(workflow.proposal?.intentHintIds),
        target: {
          importPath: workflow.proposal?.target?.importPath || null,
          exportName: workflow.proposal?.target?.exportName || null,
          callSiteFile: workflow.proposal?.target?.callSiteFile || null,
        },
      }));
    shard.stats.workflows = shard.workflowRefs.length;
    shardRow.stats.workflows = shard.workflowRefs.length;
    totalRefs += shard.workflowRefs.length;
  }
  artifacts.contract.stats.workflowRefs = totalRefs;
  return artifacts;
}

module.exports = {
  BEHAVIOR_COLLECTIONS,
  CORE_ACTION_INTENTS,
  REGENERABLE_ACTION_INTENTS,
  STATE_ACTION_INTENTS,
  attachWorkflowRefs,
  buildBehaviorArtifacts,
  orderedBehaviorEntries,
  sourceLedgerHash,
};
