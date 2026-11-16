import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pairedInputIdentity, snapshotPlugin } from '../revisions.mjs';
import { compareRevisions, parseArgs } from '../run.mjs';
import { loadSuites, repoRoot } from '../suites.mjs';

const require = createRequire(import.meta.url);
const { hashFile, hashTree } = require('../../../scripts/lib/eval-evidence.js');
async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-revision-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('snapshot reads exact committed bytes, not dirty working files, and rejects option-like refs', async t => {
  const root = await workspace(t);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  await mkdir(path.join(root, 'plugins/power-pages/skills/test'), { recursive: true });
  const source = path.join(root, 'plugins/power-pages/skills/test/SKILL.md');
  await writeFile(source, 'first\r\nsecond\n');
  git(['-c', 'core.autocrlf=false', 'add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=nonexistent-hooks', 'commit', '--quiet', '-m', 'fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  await writeFile(source, 'dirty content');
  assert.equal(await snapshotPlugin(root, 'HEAD', path.join(root, 'snapshot')), commit);
  assert.equal(await readFile(path.join(root, 'snapshot/skills/test/SKILL.md'), 'utf8'), 'first\r\nsecond\n');
  assert.equal(git(['rev-parse', 'HEAD']), commit);
  await assert.rejects(() => snapshotPlugin(root, '--help', path.join(root, 'bad')), /Invalid source/);
});

test('input identity changes on prompts, fixtures or settings but not on source revision', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'input.json'), '{"amount":2}');
  const suite = {
    suiteDir: root,
    stimuli: [{ name: 'case', prompt: 'Calculate', environment: { files: [{ src: 'input.json', dest: 'inputs/value.json' }] } }],
  };
  const settings = { model: 'test-model', reasoningEffort: 'medium' };
  const initial = await pairedInputIdentity(suite, settings);
  assert.notEqual(await pairedInputIdentity(suite, { ...settings, reasoningEffort: 'high' }), initial);
  suite.stimuli[0].prompt = 'Different prompt';
  assert.notEqual(await pairedInputIdentity(suite, settings), initial);
  suite.stimuli[0].prompt = 'Calculate';
  await writeFile(path.join(root, 'input.json'), '{"amount":3}');
  assert.notEqual(await pairedInputIdentity(suite, settings), initial);
});

test('compare CLI requires explicit revisions and preserves existing run mode', () => {
  assert.throws(() => parseArgs(['compare', '--model', 'test-model', '--judge-model', 'test-judge']), /requires --before/);
  assert.throws(() => parseArgs(['run', '--model', 'test-model', '--judge-model', 'test-judge', '--before', 'HEAD']), /require compare/);
  const options = parseArgs(['compare', '--skill', 'add-server-logic', '--before', 'HEAD', '--after', 'HEAD',
    '--model', 'test-model', '--judge-model', 'test-judge', '--out', 'evals/reports/test']);
  assert.equal(options.runs, 1);
});

test('revision pairs keep source provenance, original controls, errors and unknown usage distinct', async t => {
  const root = await workspace(t);
  const invocations = [];
  const options = {
    before: 'HEAD', after: 'HEAD', skill: 'add-server-logic', case: 'validated-sum-endpoint',
    model: 'test-model', judgeModel: 'test-judge', runs: 1, out: path.join(root, 'comparison'),
  };
  const { comparison } = await compareRevisions(options, {
    evaluate: async options => {
      invocations.push(options);
      const [suite] = await loadSuites({ skill: options.skill, sourcePluginRoot: options.sourcePluginRoot });
      return { summary: {
        pluginHash: hashTree(options.sourcePluginRoot), runtimeHash: hashTree(path.join(repoRoot, 'evals/runtime')),
        suites: [{
          suiteHash: hashTree(suite.suiteDir), skillHash: hashFile(suite.skill.path),
          results: ['baseline', 'skilled'].map(variant => ({
            name: options.case, kind: 'capability', variant, trial: 0,
            status: invocations.length === 1 ? 'passed' : variant === 'skilled' ? 'failed' : 'error',
            tokens: invocations.length === 1 ? 100 : null, durationMs: 30,
          })),
        }],
      } };
    },
  });
  assert.equal(invocations.length, 2);
  assert.notEqual(invocations[0].sourcePluginRoot, invocations[1].sourcePluginRoot);
  assert.match(comparison.arms[0].commit, /^[a-f0-9]{40}$/);
  assert.equal(comparison.arms[0].pairedInputHash, comparison.arms[1].pairedInputHash);
  assert.ok(comparison.arms[0].mainFileBytes > 0);
  assert.equal(comparison.pairs.find(pair => pair.variant === 'skilled').regression, true);
  assert.equal(comparison.pairs[0].tokenDelta, null);
  assert.equal(comparison.complete, false);
  assert.equal(comparison.behavior.before.passRate, 1);
  assert.equal(comparison.behavior.after.passRate, 0);
  assert.equal(JSON.stringify(comparison).includes(root), false);
  await assert.rejects(() => readFile(path.join(invocations[0].sourcePluginRoot, 'AGENTS.md')), /ENOENT/);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.out, 'comparison.json'), 'utf8')), comparison);
});

test('invalid case fails before any inference', async t => {
  const root = await workspace(t);
  await assert.rejects(() => compareRevisions({
    before: 'HEAD', after: 'HEAD', skill: 'add-server-logic', case: 'does-not-exist',
    model: 'test-model', judgeModel: 'test-judge', out: path.join(root, 'invalid'),
  }, { evaluate: () => { throw new Error('inference must not run'); } }), /Unknown case/);
});

test('a source edit during execution invalidates comparison instead of attesting stale hashes', async t => {
  const root = await workspace(t);
  const out = path.join(root, 'changed');
  await assert.rejects(() => compareRevisions({
    before: 'HEAD', after: 'HEAD', skill: 'add-server-logic', case: 'validated-sum-endpoint',
    model: 'test-model', judgeModel: 'test-judge', out,
  }, {
    evaluate: async options => {
      const [suite] = await loadSuites({ skill: options.skill, sourcePluginRoot: options.sourcePluginRoot });
      const summary = {
        pluginHash: hashTree(options.sourcePluginRoot), runtimeHash: hashTree(path.join(repoRoot, 'evals/runtime')),
        suites: [{ suiteHash: hashTree(suite.suiteDir), skillHash: hashFile(suite.skill.path), results: [] }],
      };
      await writeFile(suite.skill.path, 'changed after hashes were captured');
      return { summary };
    },
  }), /Source changed/);
  assert.equal(JSON.parse(await readFile(path.join(out, 'comparison.json'), 'utf8')).complete, false);
});
