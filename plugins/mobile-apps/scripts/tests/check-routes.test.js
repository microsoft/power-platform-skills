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

test('resolves aliased search params and navigation through a local helper', (t) => {
  const root = makeProject(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, jsx: 'react-jsx' },
    }),
    'app/index.tsx': `
      import { goToIncident } from '@/navigation/incidents';
      export default function Index() {
        return <Button onPress={() => goToIncident('123', 'open')} />;
      }
    `,
    'app/incidents/[id].tsx': `
      import { useLocalSearchParams as useParams } from 'expo-router';
      interface DetailParams { id: string; filter?: string }
      export default function Detail() {
        useParams<DetailParams>();
        return null;
      }
    `,
    'src/navigation/incidents.ts': `
      import { router } from 'expo-router';
      export function goToIncident(id: string, filter: string) {
        router.navigate({ pathname: \`/incidents/\${id}\`, params: { filter } });
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.deepEqual(output.unknowns, []);
});

test('resolves a local router hook that returns useRouter', (t) => {
  const root = makeProject(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, jsx: 'react-jsx' },
    }),
    'app/index.tsx': `
      import { useAppRouter } from '@/navigation/useAppRouter';
      export default function Index() {
        const router = useAppRouter();
        router.navigate({ pathname: '/detail', params: { filter: 'open' } });
        return null;
      }
    `,
    'app/detail.tsx': `
      import { useLocalSearchParams } from 'expo-router';
      export default function Detail() {
        useLocalSearchParams<{ filter?: string }>();
        return null;
      }
    `,
    'src/navigation/useAppRouter.ts': `
      import { useRouter } from 'expo-router';
      export function useAppRouter() {
        return useRouter();
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.deepEqual(output.unknowns, []);
  assert.equal(output.stats.senders, 1);
});

test('reports an opaque router hook receiver as unknown', (t) => {
  const root = makeProject(t, {
    'node_modules/@acme/navigation/index.d.ts': `
      export declare function useExternalRouter(): { push(route: string): void };
    `,
    'app/index.tsx': `
      import { useExternalRouter } from '@acme/navigation';
      export default function Index() {
        const router = useExternalRouter();
        router.push('/detail');
        return null;
      }
    `,
    'app/detail.tsx': 'export default function Detail() { return null; }',
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.ok(output.unknowns.some((unknown) => unknown.kind === 'navigation-receiver-unresolved'));
});

test('analyzes known route alternatives and reports partially unresolved targets', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      declare const condition: boolean;
      declare const dynamicRoute: string;
      export default function Index() {
        router.push({
          pathname: condition ? '/detail' : dynamicRoute,
          params: { filter: 'open' },
        });
        return null;
      }
    `,
    'app/detail.tsx': `
      import { useLocalSearchParams } from 'expo-router';
      export default function Detail() {
        useLocalSearchParams<{ filter?: string }>();
        return null;
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.ok(output.unknowns.some((unknown) => unknown.kind === 'navigation-target-unresolved'));
  assert.equal(output.stats.senders, 1);
});

test('does not guess through an unresolved top-level route-object spread', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      declare const dynamicTarget: object;
      export default function Index() {
        router.push({
          pathname: '/detail',
          params: { filter: 'open' },
          ...dynamicTarget,
        });
        return null;
      }
    `,
    'app/detail.tsx': 'export default function Detail() { return null; }',
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.ok(output.unknowns.some((unknown) => unknown.kind === 'navigation-target-unresolved'));
  assert.equal(output.stats.senders, 0);
});

test('uses later explicit route properties after an unresolved spread', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      declare const dynamicTarget: object;
      export default function Index() {
        router.push({
          ...dynamicTarget,
          pathname: '/detail',
          params: { filter: 'open' },
        });
        return null;
      }
    `,
    'app/detail.tsx': 'export default function Detail() { return null; }',
  });

  const result = run(root);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.findings[0].kind, 'no-declaration');
  assert.deepEqual(output.findings[0].receivedParams, { filter: 'query' });
  assert.deepEqual(output.unknowns, []);
  assert.equal(output.stats.senders, 1);
});

test('reports params sent through a local helper but missing at the destination', (t) => {
  const root = makeProject(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, jsx: 'react-jsx' },
    }),
    'app/index.tsx': `
      import { goToIncident } from '@/navigation/incidents';
      export default function Index() {
        goToIncident('123', 'open');
        return null;
      }
    `,
    'app/incidents/[id].tsx': `
      import { useLocalSearchParams } from 'expo-router';
      export default function Detail() {
        useLocalSearchParams<{ id: string }>();
        return null;
      }
    `,
    'src/navigation/incidents.ts': `
      import { router } from 'expo-router';
      export function goToIncident(id: string, filter: string) {
        router.navigate({ pathname: \`/incidents/\${id}\`, params: { filter } });
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.findings[0].kind, 'missing-params');
  assert.deepEqual(output.findings[0].missingParams, { filter: 'query' });
});

test('prefers a static route over a dynamic sibling', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      export default function Index() {
        router.push({ pathname: '/incidents/new', params: { draftId: 'draft-1' } });
        return null;
      }
    `,
    'app/incidents/new.tsx': `
      import { useLocalSearchParams } from 'expo-router';
      export default function NewIncident() {
        useLocalSearchParams<{ draftId?: string }>();
        return null;
      }
    `,
    'app/incidents/[id].tsx': `
      import { useLocalSearchParams } from 'expo-router';
      export default function Incident() {
        useLocalSearchParams<{ id: string }>();
        return null;
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).findings, []);
});

test('reports an unresolved typed params contract as unknown', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      export default function Index() {
        router.push({ pathname: '/detail', params: { filter: 'open' } });
        return null;
      }
    `,
    'app/detail.tsx': `
      import { useLocalSearchParams } from 'expo-router';
      interface DetailParams { filter?: string }
      export default function Detail() {
        useLocalSearchParams<Partial<DetailParams>>();
        return null;
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.equal(output.unknowns[0].kind, 'params-type-unresolved');
});

test('requires route param hooks to resolve to Expo Router', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      export default function Index() {
        router.push({ pathname: '/detail', params: { filter: 'open' } });
        return null;
      }
    `,
    'app/detail.tsx': `
      function useLocalSearchParams<T>() { return {} as T; }
      export default function Detail() {
        useLocalSearchParams<{ filter?: string }>();
        return null;
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.findings[0].kind, 'no-declaration');
});

test('accepts a local params hook that wraps the Expo Router hook', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      export default function Index() {
        router.push({ pathname: '/detail', params: { filter: 'open' } });
        return null;
      }
    `,
    'app/detail.tsx': `
      import { useLocalSearchParams } from 'expo-router';
      function useAppParams<T>() { return useLocalSearchParams<T>(); }
      export default function Detail() {
        useAppParams<{ filter?: string }>();
        return null;
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.deepEqual(output.unknowns, []);
});

test('does not use behavioral regex when TypeScript is unavailable', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { useRouter } from 'expo-router';
      export default function Index() {
        const router = useRouter();
        router.push({ pathname: '/detail', params: { missing: 'value' } });
        return null;
      }
    `,
    'app/detail.tsx': 'export default function Detail() { return null; }',
  });

  const result = spawnSync(process.execPath, [script, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MOBILE_AST_DISABLE_TYPESCRIPT: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.equal(output.unknowns[0].kind, 'semantic-analysis-unavailable');
});

test('ignores push methods on objects that do not resolve to a router API', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      const routerQueue = { push(value: string) { return value; } };
      export default function Index() {
        routerQueue.push('/detail?missing=value');
        return null;
      }
    `,
    'app/detail.tsx': 'export default function Detail() { return null; }',
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.deepEqual(output.unknowns, []);
});

test('reports unresolved spread params as unknown', (t) => {
  const root = makeProject(t, {
    'app/index.tsx': `
      import { router } from 'expo-router';
      declare const filters: Record<string, string>;
      const target = { pathname: '/detail', params: { known: 'yes', ...filters } };
      export default function Index() {
        router.push(target);
        return null;
      }
    `,
    'app/detail.tsx': `
      import { useLocalSearchParams } from 'expo-router';
      export default function Detail() {
        useLocalSearchParams<{ known?: string }>();
        return null;
      }
    `,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, []);
  assert.ok(output.unknowns.some((unknown) => unknown.kind === 'sender-params-unresolved'));
});
