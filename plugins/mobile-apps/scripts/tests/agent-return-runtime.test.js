'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readExecutionMode,
  recordAgentDispatch,
  recordTransportFailure,
  resumeWaitingInteraction,
  writeExecutionMode,
  writeWaitingInteraction,
} = require('../lib/agent-return-runtime');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const BINDING = {
  hostId: 'copilot-cli',
  runtimeId: 'session-1',
  pluginVersion: '0.2.0',
};

test('execution mode cache is bound to host runtime and plugin version', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'mode.json');
  writeExecutionMode(file, BINDING, 'parallel-return', {
    nowIso: () => '2026-08-29T12:00:00.000Z',
  });
  const current = readExecutionMode(file, BINDING, {
    nowMs: () => Date.parse('2026-08-29T12:10:00.000Z'),
  });
  assert.deepEqual(current, {
    executionMode: 'parallel-return',
    cacheHit: true,
    reason: 'current',
    checkedAt: '2026-08-29T12:00:00.000Z',
  });
  assert.equal(readExecutionMode(file, {
    ...BINDING,
    pluginVersion: '0.3.0',
  }).reason, 'binding-changed');
});

test('execution mode cache expires after thirty minutes', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'mode.json');
  writeExecutionMode(file, BINDING, 'foreground-return', {
    nowIso: () => '2026-08-29T12:00:00.000Z',
  });
  const stale = readExecutionMode(file, BINDING, {
    nowMs: () => Date.parse('2026-08-29T12:31:00.000Z'),
  });
  assert.deepEqual(stale, { executionMode: null, cacheHit: false, reason: 'stale' });
});

test('foreground interaction state waits and resumes the same phase', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'interaction.json');
  const waiting = writeWaitingInteraction(file, {
    runId: 'run-current',
    phase: 'planning',
    revision: 3,
    pendingInteraction: {
      kind: 'clarification',
      sectionId: 'product-scope',
      question: 'Should archived assets remain searchable?',
      affectedDecisions: ['search-scope'],
    },
  }, { nowIso: () => '2026-08-29T12:00:00.000Z' });
  assert.equal(waiting.status, 'waiting_for_user');
  const resumed = resumeWaitingInteraction(file, 'Yes, for administrators.', {
    runId: 'run-current',
    nowIso: () => '2026-08-29T12:05:00.000Z',
  });
  assert.equal(resumed.status, 'ready_to_resume');
  assert.equal(resumed.runId, 'run-current');
  assert.equal(resumed.phase, 'planning');
  assert.equal(resumed.revision, 3);
  assert.equal(resumed.pendingInteraction, null);
  assert.equal(resumed.resolvedInteraction.answer, 'Yes, for administrators.');
});

test('interaction resume fails when no user response is pending', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'interaction.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, status: 'ready_to_resume' }));
  assert.throws(
    () => resumeWaitingInteraction(file, 'answer', { runId: 'run-current' }),
    /not waiting for a user/,
  );
});

test('interaction resume rejects state from another run', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'interaction.json');
  writeWaitingInteraction(file, {
    runId: 'run-original',
    phase: 'planning',
    pendingInteraction: {
      kind: 'approval',
      sectionId: 'consolidated-plan',
      question: 'Approve this plan?',
      affectedDecisions: ['plan'],
    },
  });
  assert.throws(
    () => resumeWaitingInteraction(file, 'Approve', { runId: 'run-fresh' }),
    /belongs to a different run/,
  );
});

test('dispatch ledger prevents ordinary duplicate planner invocation', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  const fingerprint = 'a'.repeat(64);
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'native-app-planner',
    workOrderId: 'planning:native',
    reason: 'initial',
    inputFingerprint: fingerprint,
  });
  assert.throws(() => recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'native-app-planner',
    workOrderId: 'planning:native',
    reason: 'initial',
    inputFingerprint: fingerprint,
  }), /initial dispatch already recorded/);
  assert.throws(() => recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'native-app-planner',
    workOrderId: 'planning:native',
    reason: 'approval',
    inputFingerprint: fingerprint,
  }), /unsupported dispatch reason: approval/);
});

test('dispatch ledger bounds transport context clarification and repair retries', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  const first = 'a'.repeat(64);
  const revised = 'b'.repeat(64);
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'initial', inputFingerprint: first,
  });
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'transport_retry', inputFingerprint: first,
  });
  assert.throws(() => recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'transport_retry', inputFingerprint: first,
  }), /transport_retry dispatch limit reached/);
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'needs_context', inputFingerprint: revised,
  });
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'targeted_repair', inputFingerprint: 'c'.repeat(64),
  });
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'targeted_repair', inputFingerprint: 'd'.repeat(64),
  });
  assert.throws(() => recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'targeted_repair', inputFingerprint: 'e'.repeat(64),
  }), /targeted_repair dispatch limit reached/);
});

test('transport retry rejects a changed work-order fingerprint', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'data-model-architect', workOrderId: 'planning:data-model', reason: 'initial', inputFingerprint: 'a'.repeat(64),
  });
  assert.throws(() => recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'data-model-architect',
    workOrderId: 'planning:data-model',
    reason: 'transport_retry',
    inputFingerprint: 'b'.repeat(64),
  }), /byte-identical sealed work order/);
});

test('independent screen work orders have independent retry budgets', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  for (const workOrderId of ['screen:home', 'screen:details']) {
    recordAgentDispatch(file, {
      runId: 'run-current',
      agent: 'screen-builder',
      workOrderId,
      reason: 'initial',
      inputFingerprint: workOrderId === 'screen:home' ? 'a'.repeat(64) : 'b'.repeat(64),
    });
    recordAgentDispatch(file, {
      runId: 'run-current',
      agent: 'screen-builder',
      workOrderId,
      reason: 'targeted_repair',
      inputFingerprint: workOrderId === 'screen:home' ? 'c'.repeat(64) : 'd'.repeat(64),
    });
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.dispatches.length, 4);
});

test('fresh runs permit new initial dispatches and keep retry budgets isolated', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  const dispatch = (runId, reason) => recordAgentDispatch(file, {
    runId,
    agent: 'native-app-planner',
    workOrderId: 'planning:native',
    reason,
    inputFingerprint: 'a'.repeat(64),
  });

  dispatch('run-failed', 'initial');
  dispatch('run-fresh', 'initial');
  dispatch('run-failed', 'transport_retry');
  dispatch('run-fresh', 'transport_retry');

  assert.throws(
    () => dispatch('run-fresh', 'transport_retry'),
    /transport_retry dispatch limit reached/,
  );
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    state.dispatches.map((entry) => entry.runId),
    ['run-failed', 'run-fresh', 'run-failed', 'run-fresh'],
  );
});

test('two malformed responses move only that work order to foreground-return', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  const fingerprint = 'a'.repeat(64);
  for (const workOrderId of ['screen:home', 'screen:details']) {
    recordAgentDispatch(file, {
      runId: 'run-current',
      agent: 'screen-builder',
      workOrderId,
      reason: 'initial',
      inputFingerprint: fingerprint,
    });
  }

  const first = recordTransportFailure(file, {
    runId: 'run-current',
    agent: 'screen-builder',
    workOrderId: 'screen:home',
    inputFingerprint: fingerprint,
  });
  assert.equal(first.nextAction, 'transport_retry');
  assert.equal(first.executionMode, 'parallel-return');
  recordAgentDispatch(file, {
    runId: 'run-current',
    agent: 'screen-builder',
    workOrderId: 'screen:home',
    reason: 'transport_retry',
    inputFingerprint: fingerprint,
  });
  const second = recordTransportFailure(file, {
    runId: 'run-current',
    agent: 'screen-builder',
    workOrderId: 'screen:home',
    inputFingerprint: fingerprint,
  });
  assert.equal(second.nextAction, 'foreground_return');
  assert.equal(second.executionMode, 'foreground-return');

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    state.transportFailures.map((entry) => entry.workOrderId),
    ['screen:home', 'screen:home'],
  );
  assert.equal(
    state.transportFailures.some((entry) => entry.workOrderId === 'screen:details'),
    false,
  );
});