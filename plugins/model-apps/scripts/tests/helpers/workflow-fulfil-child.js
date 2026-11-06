'use strict';
// A second OS process for the declared-workflow tests (rule-settlement, bpf-settlement): it opens the binding store a
// first process uses and records, as another run of the same attempt would after a read, that the attempt's unsent
// state change `token` is already made on its row (store fulfillEffect), so the first process meets that fact while it
// is about to send the same change.
//   node workflow-fulfil-child.js < input.json
//   input: { dir, origin, app, solution, token, observed: { observedState, observedVersion } }
// Answers { pid, state } as JSON on stdout.
const fs = require('node:fs');
const { openManagedBindings } = require('../../lib/managed-bindings.js');

const { dir, origin, app, solution, token, observed } = JSON.parse(fs.readFileSync(0, 'utf8'));
const store = openManagedBindings({ workspaceDir: dir, environment: origin, appUniqueName: app, solutionUniqueName: solution });
const record = store.fulfillEffect(token, observed);
process.stdout.write(JSON.stringify({ pid: process.pid, state: record.state }));
