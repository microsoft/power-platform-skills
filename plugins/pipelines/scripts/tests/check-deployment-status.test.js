const test = require('node:test');
const assert = require('node:assert/strict');

const { STAGE_RUN_STATUS, TERMINAL_STATUSES } = require('../lib/pipeline-helpers');

// Replicate STOP_STATUSES from check-deployment-status.js
const STOP_STATUSES = {
  validation: [...TERMINAL_STATUSES, STAGE_RUN_STATUS.VALIDATION_SUCCEEDED],
  deployment: TERMINAL_STATUSES
};

// --- STOP_STATUSES validation mode ---

test('validation STOP_STATUSES includes all terminal statuses', () => {
  for (const s of TERMINAL_STATUSES) {
    assert.ok(STOP_STATUSES.validation.includes(s), `Missing terminal status ${s}`);
  }
});

test('validation STOP_STATUSES includes VALIDATION_SUCCEEDED', () => {
  assert.ok(STOP_STATUSES.validation.includes(STAGE_RUN_STATUS.VALIDATION_SUCCEEDED));
});

// --- STOP_STATUSES deployment mode ---

test('deployment STOP_STATUSES does NOT include VALIDATION_SUCCEEDED', () => {
  assert.ok(!STOP_STATUSES.deployment.includes(STAGE_RUN_STATUS.VALIDATION_SUCCEEDED));
});

test('deployment STOP_STATUSES includes Succeeded, Failed, Canceled', () => {
  assert.ok(STOP_STATUSES.deployment.includes(STAGE_RUN_STATUS.SUCCEEDED));
  assert.ok(STOP_STATUSES.deployment.includes(STAGE_RUN_STATUS.FAILED));
  assert.ok(STOP_STATUSES.deployment.includes(STAGE_RUN_STATUS.CANCELED));
});
