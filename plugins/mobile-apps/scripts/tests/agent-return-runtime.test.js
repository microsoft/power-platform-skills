'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readExecutionMode,
  recordAgentDispatch,
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
    nowIso: () => '2026-08-29T12:05:00.000Z',
  });
  assert.equal(resumed.status, 'ready_to_resume');
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
    () => resumeWaitingInteraction(file, 'answer'),
    /not waiting for a user/,
  );
});

test('dispatch ledger prevents ordinary duplicate planner invocation', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  const fingerprint = 'a'.repeat(64);
  recordAgentDispatch(file, {
    agent: 'native-app-planner',
    workOrderId: 'planning:native',
    reason: 'initial',
    inputFingerprint: fingerprint,
  });
  assert.throws(() => recordAgentDispatch(file, {
    agent: 'native-app-planner',
    workOrderId: 'planning:native',
    reason: 'initial',
    inputFingerprint: fingerprint,
  }), /initial dispatch already recorded/);
  assert.throws(() => recordAgentDispatch(file, {
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
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'initial', inputFingerprint: first,
  });
  recordAgentDispatch(file, {
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'transport_retry', inputFingerprint: first,
  });
  assert.throws(() => recordAgentDispatch(file, {
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'transport_retry', inputFingerprint: first,
  }), /transport_retry dispatch limit reached/);
  recordAgentDispatch(file, {
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'needs_context', inputFingerprint: revised,
  });
  recordAgentDispatch(file, {
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'targeted_repair', inputFingerprint: 'c'.repeat(64),
  });
  recordAgentDispatch(file, {
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'targeted_repair', inputFingerprint: 'd'.repeat(64),
  });
  assert.throws(() => recordAgentDispatch(file, {
    agent: 'screen-builder', workOrderId: 'screen:home', reason: 'targeted_repair', inputFingerprint: 'e'.repeat(64),
  }), /targeted_repair dispatch limit reached/);
});

test('transport retry rejects a changed work-order fingerprint', (context) => {
  const root = fixture(context);
  const file = path.join(root, '.tmp', 'dispatch.json');
  recordAgentDispatch(file, {
    agent: 'data-model-architect', workOrderId: 'planning:data-model', reason: 'initial', inputFingerprint: 'a'.repeat(64),
  });
  assert.throws(() => recordAgentDispatch(file, {
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
      agent: 'screen-builder',
      workOrderId,
      reason: 'initial',
      inputFingerprint: workOrderId === 'screen:home' ? 'a'.repeat(64) : 'b'.repeat(64),
    });
    recordAgentDispatch(file, {
      agent: 'screen-builder',
      workOrderId,
      reason: 'targeted_repair',
      inputFingerprint: workOrderId === 'screen:home' ? 'c'.repeat(64) : 'd'.repeat(64),
    });
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.dispatches.length, 4);
});