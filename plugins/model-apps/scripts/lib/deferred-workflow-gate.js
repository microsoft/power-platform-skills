'use strict';
// The workflow effect gate of one build invocation, made before the managed binding store it reads exists.
//
// The plugin's HTTP client is made once per invocation (build-model-app.js makeSdk), before the build opens its managed
// binding store (sdk-build.js openBuildBindingGroups), and a client takes its `workflowEffectGate` only when it is made
// (lib/sdk-http-client.js createAzHttpClient). A declared business rule or process flow needs that client's every request
// screened by the gate of the store that holds its effects (lib/workflow-effect-context.js createWorkflowEffectGate), so
// the client is given this stand-in, and the build binds it to the store once the store is open:
//   - unbound, it passes every request untouched — except a write inside a workflow effect's context, which it refuses
//     unsent: an effect is only ever run against a bound gate, so a context here means the wiring is wrong, and sending
//     the write without its persisted record would lose the send-once guarantee;
//   - bound, it is exactly the store's gate.
// It is bound at most to ONE store: the invocation opens one store and hands that handle to every attempt, so a second,
// different store is a wiring fault and is refused rather than silently re-pointing the client.
// A build binds it only when the spec declares a business rule or process flow, or the store already holds a workflow
// effect (an earlier run's write whose outcome must still be screened), so every other build sends what it always sent.

const { MISMATCH, currentWorkflowEffect, createWorkflowEffectGate } = require('./workflow-effect-context.js');

function createDeferredWorkflowGate() {
  let store = null;
  let gate = null;
  return {
    screen(req) {
      if (gate) return gate.screen(req);
      const method = String((req && req.method) || 'GET').toUpperCase();
      const effect = currentWorkflowEffect();
      if (effect && method !== 'GET' && method !== 'HEAD') {
        throw Object.assign(new Error(`the ${effect.effect} of ${effect.family} "${effect.key}" was not sent: the build's workflow effect gate is not bound to its managed binding store`), { code: MISMATCH });
      }
      return null;
    },
    bind(next) {
      if (!next || typeof next.snapshot !== 'function') throw new TypeError('the workflow effect gate binds to a managed binding store');
      if (store === next) return;
      if (store) throw new Error('the workflow effect gate is already bound to another managed binding store');
      gate = createWorkflowEffectGate({ store: next });
      store = next;
    },
    boundTo(candidate) {
      return Boolean(store) && store === candidate;
    },
  };
}

module.exports = { createDeferredWorkflowGate };