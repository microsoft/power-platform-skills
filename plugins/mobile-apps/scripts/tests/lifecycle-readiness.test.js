'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateLifecycleReadiness } = require('../validate-lifecycle-readiness');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stable = (value) => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  : JSON.stringify(value);

function project(context, dataMode = 'prototype', nativeVisualEvidence = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-lifecycle-ready-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mobile-app'), { recursive: true });
  const domain = Buffer.from('{"mode":"prototype-domain"}\n');
  const enrichment = Buffer.from('{"contextMode":"none"}\n');
  const journey = Buffer.from('{"journeyId":"primary-job"}\n');
  const navigation = Buffer.from('{"model":"stack"}\n');
  const navigationShell = Buffer.from('{"model":"stack","shellFingerprint":"abc"}\n');
  const visualCompositionIntent = { compositionFamily: 'next-action-workflow', maxFeatureViewportShare: 0.38 };
  const pack = { schemaVersion: 2, revision: 'a'.repeat(64) };
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), domain);
  fs.writeFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), enrichment);
  fs.writeFileSync(path.join(root, '.tmp', 'workflow-journey-contract.json'), journey);
  fs.writeFileSync(path.join(root, '.tmp', 'navigation-contract.json'), navigation);
  fs.writeFileSync(path.join(root, '.mobile-app', 'navigation-shell.json'), navigationShell);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), JSON.stringify({ visualCompositionIntent }));
  fs.writeFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), JSON.stringify(pack));
  fs.writeFileSync(path.join(root, '.mobile-app', 'state.json'), JSON.stringify({
    schemaVersion: 2,
    dataMode,
    lastDomainModelHash: hash(domain),
    lastContextEnrichmentHash: hash(enrichment),
    lastWorkflowJourneyHash: hash(journey),
    lastNavigationContractHash: hash(navigation),
    lastNavigationShellHash: hash(navigationShell),
    lastVisualCompositionHash: hash(stable(visualCompositionIntent)),
    lastValidation: {
      status: 'passed',
      qualityStatus: dataMode === 'dataverse' ? 'runtime-validated' : 'statically-validated',
      buildPackRevision: pack.revision,
      nativeVisualEvidence,
    },
  }));
  return root;
}

test('preview and debug consume a current statically validated lifecycle', (context) => {
  const root = project(context);
  assert.equal(validateLifecycleReadiness(root, 'preview').valid, true);
  assert.equal(validateLifecycleReadiness(root, 'debug').valid, true);
});

test('deploy requires Dataverse runtime validation', (context) => {
  const prototypeRoot = project(context);
  assert.match(validateLifecycleReadiness(prototypeRoot, 'deploy').errors.join('\n'), /dataMode dataverse/);
  const realRoot = project(context, 'dataverse', { status: 'passed', manifest: '.tmp/experience-visual-review.json' });
  assert.equal(validateLifecycleReadiness(realRoot, 'deploy').valid, true);
});

test('prototype readiness rejects a native-evidence completion claim', (context) => {
  const root = project(context, 'prototype', { status: 'passed' });
  assert.match(validateLifecycleReadiness(root, 'preview').errors.join('\n'), /must not contain native visual evidence/);
});

test('stale Context, Journey, Navigation, or Visual Composition hashes block consumers', (context) => {
  const root = project(context);
  fs.appendFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), '\n');
  assert.match(validateLifecycleReadiness(root, 'preview').errors.join('\n'), /Context Enrichment hash is stale/);

  const journeyRoot = project(context);
  fs.appendFileSync(path.join(journeyRoot, '.tmp', 'workflow-journey-contract.json'), '\n');
  assert.match(validateLifecycleReadiness(journeyRoot, 'preview').errors.join('\n'), /Workflow Journey hash is stale/);

  const navigationRoot = project(context);
  fs.appendFileSync(path.join(navigationRoot, '.tmp', 'navigation-contract.json'), '\n');
  assert.match(validateLifecycleReadiness(navigationRoot, 'preview').errors.join('\n'), /Navigation Contract hash is stale/);

  const shellRoot = project(context);
  fs.appendFileSync(path.join(shellRoot, '.mobile-app', 'navigation-shell.json'), '\n');
  assert.match(validateLifecycleReadiness(shellRoot, 'preview').errors.join('\n'), /Navigation Shell hash is stale/);
});