'use strict';
// A second OS process for the declared-workflow tests (rule-settlement, bpf-settlement): it opens the store a first
// process left with a pending attempt, over a wire rebuilt from that process's rows, and settles the same declaration
// again, so a recovery is proved across a real process boundary rather than by a fresh handle in the same process.
// A maker changes the row's body either before this process reads it (`before-read`) or when its activation PATCH
// arrives (`at-activation`); the outcome is written as JSON to `output`.
//   node workflow-resume-child.js <input.json>
//   input: { family: 'rule' | 'bpf', declaration, dir, when, rows: [[id, row], …], output, app, solution }
const fs = require('node:fs');
const path = require('node:path');
const { createWorkflowWire, ORIGIN } = require('./workflow-wire.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../vendor/cds-maker-sdk.cjs');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');
const { openManagedBindings } = require('../../lib/managed-bindings.js');
const { createWorkflowEffectGate } = require('../../lib/workflow-effect-context.js');
const { createPublicationBarrier } = require('../../lib/publication-barrier.js');
const { createIntentCatalog } = require('../../lib/creates-catalog.js');
const { BuildHalt } = require('../../lib/entity-provision.js');
const { RETRY } = require('../../lib/retry-policy.js');
const { settleDeclaredRule } = require('../../lib/rule-settlement.js');
const { settleDeclaredBpf } = require('../../lib/bpf-settlement.js');

// The maker's edit of the stored body: the rule's description, or the field of the flow's first step (name → fax).
function edit(family, row) {
  if (family === 'rule') row.description = 'Changed by a maker';
  else {
    const next = row.xaml.replace(/(<mcwb:Control.DataFieldName><InArgument[^>]*><Literal[^>]*Value=")name(")/, '$1fax$2');
    if (next === row.xaml) throw new Error('the flow has no step to change');
    row.xaml = next;
  }
  row.version += 1;
}

(async () => {
  const { family, declaration, dir, when, rows, output, app, solution } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const wire = createWorkflowWire();
  for (const [id, row] of rows) wire.rows.set(id, row);
  const row = [...wire.rows.values()][0];
  let ifMatch = null;
  let changed = false;
  let versionAfterMaker = null;
  const change = () => { changed = true; edit(family, row); versionAfterMaker = row.version; };
  if (when === 'before-read') change();
  wire.script((e) => {
    if (changed || e.method !== 'PATCH' || !e.body || e.body.statecode !== 1) return false;
    ifMatch = e.headers['If-Match'] || e.headers['if-match'] || null;
    change();
    return false;
  }, { statusCode: 500 });

  const barrier = createPublicationBarrier();
  const store = openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: app, solutionUniqueName: solution, barrier });
  const workflowEffectGate = createWorkflowEffectGate({ store });
  const httpClient = createAzHttpClient(ORIGIN, { getToken: () => 'x'.repeat(40), request: wire.request, sleep: async () => {}, workflowEffectGate });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(path.join(dir, 'sdk')), instanceUrl: ORIGIN, httpClient });
  await sdk.initWorkspace();
  const key = `${declaration.entity}/${declaration.name}`;
  const catalog = createIntentCatalog([{ catalogKind: family === 'rule' ? 'businessRule' : 'bpf', key, scope: { kind: 'table', solution, table: declaration.entity }, declaration }]);
  const halt = (phase, label, code, { cause } = {}) => new BuildHalt(`${label}: ${code}`, { phase, code, recoverable: false, retry: RETRY.NEVER, cause });
  const common = { sdk, store, barrier, httpClient, catalog, halt, instanceUrl: ORIGIN };
  const from = wire.log.length;
  let code = null;
  try {
    if (family === 'rule') await settleDeclaredRule({ rule: declaration, ...common });
    else await settleDeclaredBpf({ flow: declaration, ...common, ensureMembership: async () => {} });
  } catch (err) {
    code = err.code || null;
  }
  fs.writeFileSync(output, JSON.stringify({
    pid: process.pid, changed, ifMatch, versionAfterMaker,
    finalVersion: row.version, finalState: row.statecode, code,
    writes: wire.lines(from).filter((l) => !l.startsWith('GET')),
    token: (store.readGroup(family, key).pending || {}).token || null,
  }));
})().catch((err) => { console.error(err); process.exitCode = 1; });
