'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'verify-ios-push', 'SKILL.md');
const EVAL_PATH = path.join(
  PLUGIN_ROOT,
  'skills',
  'verify-ios-push',
  'evals',
  'evals.json',
);

test('verify-ios-push evals cover the approved physical-device matrix', () => {
  const document = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  assert.strictEqual(document.skill_name, 'verify-ios-push');
  assert.deepStrictEqual(
    document.evals.map(({ coverage }) => coverage),
    [
      'simulator-rejected',
      'wrong-or-stale-build',
      'missing-topic-subscription',
      'foreground-only',
      'background-delivery',
      'cold-start-deep-link',
      'topic-transition-and-opt-out',
      'full-physical-success',
      'manual-auth-downstream',
      'unsupported-custom-endpoint',
    ],
  );
  assert.deepStrictEqual(
    document.evals.map(({ id }) => id),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  for (const evaluation of document.evals) {
    assert.ok(evaluation.prompt.trim(), `${evaluation.coverage} needs a prompt`);
    assert.ok(
      evaluation.expected_output.trim(),
      `${evaluation.coverage} needs expected output`,
    );
    assert.deepStrictEqual(evaluation.files, []);
  }
});

test('verify-ios-push is public, FlowAgent-readback based, and cannot reauthor flows', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /^name: verify-ios-push$/m);
  assert.match(skill, /^user-invocable: true$/m);
  for (const tool of [
    'mcp__flowagent__get_flow',
    'mcp__flowagent__search_operations',
    'mcp__flowagent__get_operation_details',
    'mcp__flowagent__invoke_operation',
    'mcp__flowagent__run_flow',
    'mcp__flowagent__get_run_history',
    'mcp__flowagent__get_run_details',
    'mcp__flowagent__get_run_actions',
  ]) {
    assert.match(skill, new RegExp(tool));
  }
  for (const mutationTool of [
    'mcp__flowagent__create_flow',
    'mcp__flowagent__update_flow',
    'mcp__flowagent__edit_flow',
    'mcp__flowagent__publish_flow',
    'mcp__flowagent__delete_flow',
  ]) {
    assert.doesNotMatch(skill, new RegExp(mutationTool));
  }
  assert.doesNotMatch(skill, /mcp__flowagent__get_past_trigger_inputs/);
  assert.doesNotMatch(skill, /mcp__flowagent__list_flows/);
  assert.match(
    skill,
    /does\s+not configure APNs, build an IPA, author or repair a\s+flow/,
  );
  assert.match(skill, /both published and read back as `Started`/);
  assert.match(skill, /Reuse the live-send gates from `\/create-push-notification-flow`/);
});

test('verify-ios-push rejects non-device proof and requires every physical case', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /Reject and stop for a simulator, Expo Go, a browser\/web preview/);
  assert.match(skill, /Treat the IPA as stale if any bundled app input changed/);
  assert.match(skill, /### A\. Permission UX: decline, deny, and grant/);
  assert.match(skill, /### B\. Signed out `allUsers`, foreground/);
  assert.match(skill, /### C\. Signed out `allUsers`, background/);
  assert.match(skill, /### D\. Terminated\/cold-start tap and validated deep link/);
  assert.match(skill, /### E\. Sign in and switch to user-topic delivery/);
  assert.match(skill, /### F\. Sign out and return to `allUsers`/);
  assert.match(skill, /### G\. Opt out/);
  assert.match(skill, /### H\. Token refresh\/re-registration recovery/);
  assert.match(skill, /Keep APNs as `pending physical verification`/);
  assert.match(
    skill,
    /Mark APNs physical verification complete only when A-H\s+all pass/,
  );
});

test('verify-ios-push records only privacy-safe correlated evidence', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /producer run -> outbox row/);
  assert.match(skill, /bounded Provider Message ID/);
  assert.match(skill, /Never request, read, display, copy, compare, or persist an FCM registration\s+token/);
  assert.match(skill, /safe case label -> producer run -> outbox row ID -> sender run/);
  assert.match(skill, /recording only topic category `user`/);
  assert.doesNotMatch(skill, /Entra OIDs may be compared/);
  assert.doesNotMatch(skill, /GUID-shaped lowercase target/);
  assert.doesNotMatch(skill, /empty Target OID/);
  assert.doesNotMatch(skill, /<lowercase-oid>/);
  assert.match(skill, /Do not store OIDs, raw recipient target\/topic fields/);
  assert.match(skill, /validate-mobile-files\.js/);
  assert.match(skill, /--file memory-bank\.md/);
});
