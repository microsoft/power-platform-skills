'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateScreenContracts } = require('../validate-screen-contracts');

function makeProject(t, { route = '/(app)/home', file = 'app/(app)/(tabs)/home.tsx', service = 'Cr_productService' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-contracts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const screenPath = path.join(root, file);
  fs.mkdirSync(path.dirname(screenPath), { recursive: true });
  fs.writeFileSync(screenPath, 'export default function Home() { return null; }\n');
  fs.mkdirSync(path.join(root, 'src/generated/services'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src/generated/services/dataSourcesInfo.ts'),
    "export { Cr_productService } from './Cr_productService';\n",
  );
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), `
## Screens

### Screen Map

| Screen | Route | File |
|---|---|---|
| Home | \`${route}\` | \`${file}\` |

### Per-Screen Specs

#### Home (\`${route}\`)

- **Archetype:** Tab-root
- **Purpose:** Show products.
- **Route:** \`${route}\`
- **File:** \`${file}\`
- **Presentation:** default
- **Data:** \`${service}.getAll({ top: 12 })\`
- **Native capabilities:** none
- **Navigation:** product pushes detail
- **State delta:** empty offers browse
- **Key user actions:** browse
- **Idempotency guards:** navigation lock
`);
  return root;
}

test('accepts a complete screen contract through an Expo route group', (t) => {
  const root = makeProject(t);
  const result = validateScreenContracts(path.join(root, 'native-app-plan.md'));
  assert.deepEqual(result.issues, []);
});

test('reports a missing planned screen file', (t) => {
  const root = makeProject(t);
  fs.rmSync(path.join(root, 'app/(app)/(tabs)/home.tsx'));
  const result = validateScreenContracts(path.join(root, 'native-app-plan.md'));
  assert.ok(result.issues.some((issue) => issue.rule === 'missing-screen-file'));
});

test('reports route and physical file drift', (t) => {
  const root = makeProject(t, { route: '/(app)/discover' });
  const result = validateScreenContracts(path.join(root, 'native-app-plan.md'));
  assert.ok(result.issues.some((issue) => issue.rule === 'route-file-drift'));
});

test('reports generated service references that are not exported', (t) => {
  const root = makeProject(t, { service: 'Cr_missingService' });
  const result = validateScreenContracts(path.join(root, 'native-app-plan.md'));
  assert.ok(result.issues.some((issue) => issue.rule === 'unknown-generated-service'));
});