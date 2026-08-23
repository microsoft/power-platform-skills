'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', 'check-routes.js');

function makeProject(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function run(projectRoot) {
  return spawnSync(process.execPath, [script, '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

test('does not require useLocalSearchParams when navigation sends zero params', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { useRouter } from 'expo-router';
      export default function Index() {
        const router = useRouter();
        return <Button onPress={() => router.push('/home')} />;
      }
    `,
    'app/home.tsx': 'export default function Home() { return null; }',
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).findings, []);
});

test('reports a route file that conflicts with its same-name child folder', (t) => {
  const root = makeProject(t, {
    'app/incidents/[id].tsx': 'export default function Detail() { return null; }',
    'app/incidents/[id]/review.tsx': 'export default function Review() { return null; }',
  });

  const result = run(root);
  assert.equal(result.status, 1);
  const findings = JSON.parse(result.stdout).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'file-folder-route-collision');
  assert.equal(findings[0].route, '/incidents/[id]');
});
