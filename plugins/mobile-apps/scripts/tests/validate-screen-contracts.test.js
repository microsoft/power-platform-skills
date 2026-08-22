'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validate } = require('../validate-screen-contracts');
const script = path.resolve(__dirname, '..', 'validate-screen-contracts.js');

function spec(number, name, route, file, extra = '', {
  archetype = 'Tab-root',
  data = 'local state',
} = {}) {
  return `
#### Screen ${number} - ${name} (\`${route}\`)

**Domain layout decisions:** Domain fields lead. The current action is prominent. The layout is not generic CRUD.

- **Archetype:** ${archetype}
- **Purpose:** Show ${name}.
- **Route:** \`${route}\`
- **File:** \`${file}\`
- **Presentation:** \`default\`
- **Data:** ${data}
- **Navigation:** tab root
- **Navigation intent:** \`navigate\`
- **State delta:** domain-specific empty state
- **Key user actions:** review content
- **Idempotency guards:** navigation uses \`isNavigating\`
${extra}
`;
}

function validPlan() {
  return `
# Test Plan

## Screens

### Navigation Pattern

Tabs

### Screen Map

| Screen | Route | File | Presentation | Archetype | Purpose | Data | Native | Source |
|---|---|---|---|---|---|---|---|---|
| Home | \`/(app)/home\` | \`app/(app)/home.tsx\` | default | Tab-root | Home | local | - | new |
| Item detail | \`/(app)/items/[id]\` | \`app/(app)/items/[id].tsx\` | default | Detail | Item | \`ItemService.getById(id)\` | - | new |
| Profile | \`/(app)/profile\` | \`app/(app)/profile.tsx\` | default | Tab-root | Profile | auth | - | new |

### Navigation Contracts

| Route | Path params | Query params (union across all senders) | Intent | Returns to caller |
|---|---|---|---|---|
| \`/(app)/home\` | - | - | \`navigate\` | tab root |
| \`/(app)/items/[id]\` | \`id: string\` | - | \`push\` | back |
| \`/(app)/profile\` | - | - | \`navigate\` | tab root |

### Shared Conventions

Shared defaults.

### Per-Screen Specs
${spec(1, 'Home', '/(app)/home', 'app/(app)/home.tsx')}
${spec(2, 'Item detail', '/(app)/items/[id]', 'app/(app)/items/[id].tsx', '', {
    archetype: 'Detail',
    data: 'ItemService.getById(id)',
  })}
${spec(3, 'Profile', '/(app)/profile', 'app/(app)/profile.tsx', `
- **Profile content:** app context and preferences
- **Sign-out affordance:** visible Button using useAuth().signOut with confirm
`)}

## Approvals
`;
}

function makeBuiltProject(t, plan = validPlan()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-contracts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'native-app-plan.md': plan,
    'app/(app)/home.tsx': 'export default function Home() { return null; }\n',
    'app/(app)/items/[id].tsx': `import { useLocalSearchParams } from 'expo-router';
import { ItemService } from '@/generated';
export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  void ItemService.getById(id);
  return null;
}
`,
    'app/(app)/profile.tsx': 'export default function Profile() { return null; }\n',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return root;
}

test('accepts a complete screen map, navigation contract, and spec set', () => {
  const result = validate(validPlan());
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.summary, {
    mapRows: 3,
    signedInScreens: 3,
    specs: 3,
    navigationContracts: 3,
  });
});

test('parses GFM escaped pipes without shifting navigation intent cells', () => {
  const plan = validPlan().replace(
    '| `/(app)/items/[id]` | `id: string` | - | `push` | back |',
    '| `/(app)/items/[id]` | `id: string \\| string[]` | - | `push` | back |',
  );
  const errors = [];
  const table = require('../validate-screen-contracts').parseTable(plan, '### Navigation Contracts', errors);
  const itemRow = table.rows.find((row) => row[0] === '/(app)/items/[id]');

  assert.deepEqual(errors, []);
  assert.equal(itemRow[1], 'id: string | string[]');
  assert.equal(itemRow[3], 'push');
  assert.equal(validate(plan).valid, true, validate(plan).errors.join('\n'));
});

test('accepts planner-style per-screen headings and derives routes from fields', () => {
  const plan = validPlan().replace(
    /^#### Screen \d+ - (.+?) \(`[^`]+`\)$/gm,
    '#### $1',
  );
  const result = validate(plan);

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.summary.specs, 3);
});

test('CLI validates built routes, declared service imports, and parameter reads', (t) => {
  const root = makeBuiltProject(t);
  const result = spawnSync(process.execPath, [script, path.join(root, 'native-app-plan.md')], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /validate-screen-contracts: PASS/);
});

test('built validation follows app-local hook and barrel imports', (t) => {
  const root = makeBuiltProject(t);
  fs.writeFileSync(
    path.join(root, 'app/(app)/items/[id].tsx'),
    `import { useLocalSearchParams } from 'expo-router';
import { useItem } from '@/hooks';
export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useItem(id);
  return null;
}
`,
  );
  fs.mkdirSync(path.join(root, 'src/hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/hooks/index.ts'), "export { useItem } from './useItem';\n");
  fs.writeFileSync(
    path.join(root, 'src/hooks/useItem.ts'),
    `import { ItemService } from '@/generated';
export function useItem(id) { return ItemService.getById(id); }
`,
  );

  const result = validate(validPlan(), { projectRoot: root });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('built validation compares declared and imported service names case-insensitively', (t) => {
  const plan = validPlan().replaceAll('ItemService', 'itemService');
  const root = makeBuiltProject(t, plan);
  const result = validate(plan, { projectRoot: root });

  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('built validation fails for missing files, service imports, and parameter reads', (t) => {
  const root = makeBuiltProject(t);
  fs.rmSync(path.join(root, 'app/(app)/home.tsx'));
  fs.writeFileSync(
    path.join(root, 'app/(app)/items/[id].tsx'),
    'export default function ItemDetail() { return null; }\n',
  );

  const result = validate(validPlan(), { projectRoot: root });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes('missing built file app/(app)/home.tsx')), true);
  assert.equal(result.errors.some((error) => error.includes('declares ItemService') && error.includes('does not import it directly or through a local dependency')), true);
  assert.equal(result.errors.some((error) => error.includes('does not read it with useLocalSearchParams')), true);
});

test('fails when a Screen Map file normalizes to a different route', () => {
  const plan = validPlan().replace(
    'app/(app)/home.tsx\` | default',
    'app/(app)/dashboard.tsx\` | default',
  );
  const result = validate(plan);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes('normalizes to /(app)/dashboard')), true);
});

test('fails closed when Profile or required spec fields are missing', () => {
  const plan = validPlan()
    .replace(/\| Profile \|[^\n]+\n/, '')
    .replace(/\| `\/\(app\)\/profile`[^\n]+\n/, '')
    .replace(/#### Screen 2[\s\S]+?(?=\n## Approvals)/, '')
    .replace('- **State delta:** domain-specific empty state\n', '');
  const result = validate(plan);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes('missing **State delta:**')), true);
  assert.equal(result.errors.includes('missing required Profile screen at /(app)/profile'), true);
});