'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const astScript = path.resolve(__dirname, '..', 'validate-mobile-ast.js');
const dispatcherScript = path.resolve(__dirname, '..', 'validate-mobile-files.js');

function makeProject(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-ast-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaults = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        jsx: 'react-jsx',
        paths: { '@/*': ['src/*'] },
      },
    }),
  };
  for (const [relativePath, content] of Object.entries({ ...defaults, ...files })) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function runAst(projectRoot, targets, env = {}) {
  return spawnSync(
    process.execPath,
    [
      astScript,
      '--project-root',
      projectRoot,
      '--report',
      ...targets.flatMap((target) => ['--file', path.join(projectRoot, target)]),
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}

function runAstCheck(projectRoot, targets, env = {}) {
  return spawnSync(
    process.execPath,
    [
      astScript,
      '--project-root',
      projectRoot,
      ...targets.flatMap((target) => ['--file', path.join(projectRoot, target)]),
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}

function report(result) {
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}

function issuesFor(result, relativeFile) {
  return report(result).issues.filter((issue) => issue.file === relativeFile);
}

test('accepts safe-area ownership in aliased shared components and route layouts', (t) => {
  const root = makeProject(t, {
    'app/_layout.tsx': `
      import { Slot } from 'expo-router';
      import { SafeAreaView } from 'react-native-safe-area-context';
      export default function Layout() {
        return <SafeAreaView><Slot /></SafeAreaView>;
      }
    `,
    'app/home.tsx': `
      import { View } from 'react-native';
      export default function Home() { return <View />; }
    `,
    'app/detail.tsx': `
      import { Frame } from '@/components';
      import { LoadingState as Busy } from '@/components/LoadingState';
      export default function Detail({ loading }: { loading: boolean }) {
        if (loading) return <Busy />;
        return <Frame />;
      }
    `,
    'src/components/index.ts': `
      export { ScreenFrame as Frame } from './ScreenFrame';
    `,
    'src/components/ScreenFrame.tsx': `
      import { SafeAreaView as InsetView } from 'react-native-safe-area-context';
      export function ScreenFrame() { return <InsetView />; }
    `,
    'src/components/LoadingState.tsx': `
      import * as SafeArea from 'react-native-safe-area-context';
      export function LoadingState() { return <SafeArea.SafeAreaView />; }
    `,
  });

  const result = runAst(root, ['app/home.tsx', 'app/detail.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(report(result).issues, []);
});

test('rejects provider-only and fake edges safe-area evidence', (t) => {
  const root = makeProject(t, {
    'node_modules/react-native-safe-area-context/index.d.ts': `
      export declare function SafeAreaProvider(props: object): unknown;
    `,
    'node_modules/react-native/index.d.ts': `
      export declare function ScrollView(props: object): unknown;
    `,
    'app/provider-only.tsx': `
      import { SafeAreaProvider } from 'react-native-safe-area-context';
      import { ScrollView } from 'react-native';
      export default function ProviderOnly() {
        return <SafeAreaProvider><ScrollView /></SafeAreaProvider>;
      }
    `,
    'app/fake-edges.tsx': `
      import { ScrollView } from 'react-native';
      function Frame(props: { edges: string[] }) { return <ScrollView />; }
      export default function FakeEdges() { return <Frame edges={['top', 'bottom']} />; }
    `,
  });

  const result = runAst(root, ['app/provider-only.tsx', 'app/fake-edges.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  for (const file of ['app/provider-only.tsx', 'app/fake-edges.tsx']) {
    assert.ok(issuesFor(result, file).some((issue) => issue.rule === 'missing-safe-area-chrome'));
  }
});

test('does not treat React Native core SafeAreaView as cross-platform ownership', (t) => {
  const root = makeProject(t, {
    'app/core-safe-area.tsx': `
      import { SafeAreaView, Text } from 'react-native';
      export default function CoreSafeArea() {
        return <SafeAreaView><Text>Android is not protected</Text></SafeAreaView>;
      }
    `,
  });

  const result = runAst(root, ['app/core-safe-area.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(issuesFor(result, 'app/core-safe-area.tsx').some(
    (issue) => issue.rule === 'missing-safe-area-chrome' && issue.status === 'fail',
  ));
});

test('does not credit a layout SafeAreaView that is only a sibling of the outlet', (t) => {
  const root = makeProject(t, {
    'app/_layout.tsx': `
      import { Slot } from 'expo-router';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { YStack } from 'tamagui';
      export default function Layout() {
        return <YStack><SafeAreaView /><Slot /></YStack>;
      }
    `,
    'app/home.tsx': `
      import { View } from 'react-native';
      export default function Home() { return <View />; }
    `,
  });

  const result = runAst(root, ['app/home.tsx']);
  assert.equal(result.status, 0);
  assert.ok(issuesFor(result, 'app/home.tsx').some(
    (issue) => issue.rule === 'missing-safe-area-chrome' && issue.status === 'fail',
  ));
});

test('accepts root safe-area ownership across a nested route layout', (t) => {
  const root = makeProject(t, {
    'app/_layout.tsx': `
      import { Slot } from 'expo-router';
      import { SafeAreaView } from 'react-native-safe-area-context';
      export default function RootLayout() {
        return <SafeAreaView edges={['top', 'bottom']}><Slot /></SafeAreaView>;
      }
    `,
    'app/(app)/_layout.tsx': `
      import { Stack } from 'expo-router';
      export default function AppLayout() { return <Stack />; }
    `,
    'app/(app)/home.tsx': `
      import { View } from 'react-native';
      export default function Home() { return <View />; }
    `,
  });

  const result = runAst(root, ['app/(app)/home.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(!issuesFor(result, 'app/(app)/home.tsx').some(
    (issue) => issue.rule === 'missing-safe-area-chrome',
  ));
});

test('inspects local submit-lock hooks instead of trusting their names', (t) => {
  const root = makeProject(t, {
    'app/safe.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useSubmitLock } from '@/hooks/submit';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function Safe() {
        const { runLocked } = useSubmitLock();
        const submit = () => runLocked(() => IncidentsService.create({ title: 'Safe' }));
        return <SafeAreaView />;
      }
    `,
    'app/unsafe.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useSubmitLock } from '@/hooks/naive';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function Unsafe() {
        const { runLocked } = useSubmitLock();
        const submit = () => runLocked(() => IncidentsService.create({ title: 'Unsafe' }));
        return <SafeAreaView />;
      }
    `,
    'src/hooks/submit.ts': `
      export function useSubmitLock() {
        let busy = false;
        async function runLocked(work: () => Promise<unknown>) {
          if (busy) return;
          busy = true;
          try { await work(); } finally { busy = false; }
        }
        return { runLocked };
      }
    `,
    'src/hooks/naive.ts': `
      export function useSubmitLock() {
        return { runLocked: (work: () => Promise<unknown>) => work() };
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const safe = runAst(root, ['app/safe.tsx']);
  assert.equal(safe.status, 0, safe.stderr);
  assert.ok(!issuesFor(safe, 'app/safe.tsx').some((issue) => issue.rule === 'submit-lock'));

  const unsafe = runAst(root, ['app/unsafe.tsx']);
  assert.equal(unsafe.status, 0, `${unsafe.stderr}\n${unsafe.stdout}`);
  assert.ok(issuesFor(unsafe, 'app/unsafe.tsx').some((issue) => issue.rule === 'submit-lock'));
});

test('ties submit-lock evidence to the generated-service save it protects', (t) => {
  const root = makeProject(t, {
    'app/mixed.tsx': `
      import React from 'react';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function Mixed() {
        const [saving, setSaving] = React.useState(false);
        async function guardedSave() {
          if (saving) return;
          setSaving(true);
          try { await IncidentsService.create({ title: 'Protected' }); }
          finally { setSaving(false); }
        }
        async function unguardedSave() {
          await IncidentsService.update('1', { title: 'Unprotected' });
        }
        return <SafeAreaView />;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = {
        create: async (payload: object) => payload,
        update: async (id: string, payload: object) => ({ id, payload }),
      };
    `,
  });

  const result = runAst(root, ['app/mixed.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const locks = issuesFor(result, 'app/mixed.tsx').filter((issue) => issue.rule === 'submit-lock');
  assert.equal(locks.length, 1);
  assert.equal(locks[0].status, 'fail');
});

test('accepts a direct guard-acquire-save-finally-release flow', (t) => {
  const root = makeProject(t, {
    'app/direct-lock.tsx': `
      import React from 'react';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function DirectLock() {
        const [saving, setSaving] = React.useState(false);
        async function submit() {
          if (saving) return;
          setSaving(true);
          try { await IncidentsService.create({ title: 'Protected' }); }
          finally { setSaving(false); }
        }
        return <SafeAreaView />;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/direct-lock.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(!issuesFor(result, 'app/direct-lock.tsx').some((issue) => issue.rule === 'submit-lock'));
});

test('rejects a lock wrapper that invokes the save callback after releasing the lock', (t) => {
  const root = makeProject(t, {
    'app/late-callback.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useSubmitLock } from '@/hooks/lateLock';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function LateCallback() {
        const { runLocked } = useSubmitLock();
        const submit = () => runLocked(() => IncidentsService.create({ title: 'Too late' }));
        return <SafeAreaView />;
      }
    `,
    'src/hooks/lateLock.ts': `
      export function useSubmitLock() {
        let busy = false;
        async function runLocked(work: () => Promise<unknown>) {
          if (busy) return;
          busy = true;
          try { await Promise.resolve(); } finally { busy = false; }
          await work();
        }
        return { runLocked };
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/late-callback.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(issuesFor(result, 'app/late-callback.tsx').some(
    (issue) => issue.rule === 'submit-lock' && issue.status === 'fail',
  ));
});

test('requires the save callback argument itself to be protected by a lock wrapper', (t) => {
  const root = makeProject(t, {
    'app/wrong-callback.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useSubmitLock } from '@/hooks/wrongCallback';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function WrongCallback() {
        const { runLocked } = useSubmitLock();
        const submit = () => runLocked(
          () => Promise.resolve(),
          () => IncidentsService.create({ title: 'Unprotected callback' }),
        );
        return <SafeAreaView />;
      }
    `,
    'src/hooks/wrongCallback.ts': `
      export function useSubmitLock() {
        let busy = false;
        async function runLocked(
          protectedWork: () => Promise<unknown>,
          unprotectedWork: () => Promise<unknown>,
        ) {
          if (busy) return;
          busy = true;
          try { await protectedWork(); } finally { busy = false; }
          await unprotectedWork();
        }
        return { runLocked };
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/wrong-callback.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(issuesFor(result, 'app/wrong-callback.tsx').some(
    (issue) => issue.rule === 'submit-lock' && issue.status === 'fail',
  ));
});

test('credits a lock wrapper around a local save helper call', (t) => {
  const root = makeProject(t, {
    'app/helper-save.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useSubmitLock } from '@/hooks/submit';
      import { saveIncident } from '@/services/saveIncident';
      export default function HelperSave() {
        const { runLocked } = useSubmitLock();
        const submit = () => runLocked(() => saveIncident());
        return <SafeAreaView />;
      }
    `,
    'src/hooks/submit.ts': `
      export function useSubmitLock() {
        let busy = false;
        async function runLocked(work: () => Promise<unknown>) {
          if (busy) return;
          busy = true;
          try { await work(); } finally { busy = false; }
        }
        return { runLocked };
      }
    `,
    'src/services/saveIncident.ts': `
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export async function saveIncident() {
        return IncidentsService.create({ title: 'Protected helper' });
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/helper-save.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(!issuesFor(result, 'src/services/saveIncident.ts').some(
    (issue) => issue.rule === 'submit-lock',
  ));
});

test('does not treat busy setters or disabled UI as an atomic submit lock', (t) => {
  const root = makeProject(t, {
    'app/weak-lock.tsx': `
      import React from 'react';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { Button } from 'tamagui';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function WeakLock() {
        const [isSubmitting, setIsSubmitting] = React.useState(false);
        async function submit() {
          setIsSubmitting(true);
          try { await IncidentsService.create({ title: 'Duplicate prone' }); }
          finally { setIsSubmitting(false); }
        }
        return <SafeAreaView><Button disabled={isSubmitting} onPress={submit}>Save</Button></SafeAreaView>;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/weak-lock.tsx']);
  assert.equal(result.status, 0);
  assert.ok(issuesFor(result, 'app/weak-lock.tsx').some(
    (issue) => issue.rule === 'submit-lock' && issue.status === 'fail',
  ));
});

test('reports opaque semantic boundaries as visible non-blocking unknowns', (t) => {
  const root = makeProject(t, {
    'app/opaque.tsx': `
      import { ScreenFrame } from '@acme/design-system';
      export default function Opaque() { return <ScreenFrame />; }
    `,
  });

  const result = runAst(root, ['app/opaque.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const issue = issuesFor(result, 'app/opaque.tsx').find(
    (candidate) => candidate.rule === 'missing-safe-area-chrome',
  );
  assert.equal(issue.status, 'unknown');
});

test('treats unmodeled react-native packages as opaque boundaries', (t) => {
  const root = makeProject(t, {
    'node_modules/react-native-paper/index.d.ts': `
      export declare function Screen(props: object): unknown;
    `,
    'app/opaque-paper.tsx': `
      import { Screen } from 'react-native-paper';
      export default function OpaquePaper() { return <Screen />; }
    `,
  });

  const result = runAst(root, ['app/opaque-paper.tsx']);
  assert.equal(result.status, 0);
  const issue = issuesFor(result, 'app/opaque-paper.tsx').find(
    (candidate) => candidate.rule === 'missing-safe-area-chrome',
  );
  assert.equal(issue.status, 'unknown');
});

test('accepts top-only SafeAreaView when bottom chrome applies insets manually', (t) => {
  const root = makeProject(t, {
    'app/manual-bottom.tsx': `
      import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
      import { YStack } from 'tamagui';
      export default function ManualBottom() {
        const insets = useSafeAreaInsets();
        return (
          <SafeAreaView edges={['top']}>
            <YStack position="absolute" bottom={insets.bottom + 16} />
          </SafeAreaView>
        );
      }
    `,
  });

  const result = runAst(root, ['app/manual-bottom.tsx']);
  assert.equal(result.status, 0);
  assert.deepEqual(issuesFor(result, 'app/manual-bottom.tsx'), []);
});

test('checks Dataverse payloads only on generated service calls', (t) => {
  const root = makeProject(t, {
    'app/payload.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      const COLUMNS = { title: 'title', status: 'statuscodename' };
      const SELECT = [COLUMNS.title, COLUMNS.status];
      const payload = { title: 'Broken', 'statecode': 0 };
      const pickerConfig = { select: ['statuscodename'] };
      export default function Payload() {
        IncidentsService.getAll();
        IncidentsService.getAll({ select: SELECT });
        IncidentsService.create(payload);
        return <SafeAreaView />;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = {
        getAll: async (options: object) => options,
        create: async (payload: object) => payload,
      };
    `,
  });

  const result = runAst(root, ['app/payload.tsx']);
  assert.equal(result.status, 0);
  const issues = issuesFor(result, 'app/payload.tsx');
  assert.equal(issues.filter((issue) => issue.rule === 'dataverse-select-shadow-column').length, 1);
  assert.equal(issues.filter((issue) => issue.rule === 'dataverse-server-managed-payload').length, 1);
  assert.ok(!issues.some((issue) => issue.rule === 'dataverse-payload-error'));
});

test('follows local aliases back to generated services', (t) => {
  const root = makeProject(t, {
    'app/aliased-service.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      const service = IncidentsService;
      export default function AliasedService() {
        service.create({ statecode: 0 });
        return <SafeAreaView />;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/aliased-service.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const issues = issuesFor(result, 'app/aliased-service.tsx');
  assert.ok(issues.some((issue) => issue.rule === 'dataverse-server-managed-payload'));
  assert.ok(issues.some((issue) => issue.rule === 'submit-lock'));
});

test('follows local service factories back to generated services', (t) => {
  const root = makeProject(t, {
    'app/factory-service.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { getIncidentsService } from '@/services/getIncidentsService';
      export default function FactoryService() {
        getIncidentsService().create({ statecode: 0 });
        return <SafeAreaView />;
      }
    `,
    'src/services/getIncidentsService.ts': `
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export function getIncidentsService() { return IncidentsService; }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/factory-service.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const issues = issuesFor(result, 'app/factory-service.tsx');
  assert.ok(issues.some((issue) => issue.rule === 'dataverse-server-managed-payload'));
  assert.ok(issues.some((issue) => issue.rule === 'submit-lock'));
});

test('finds payload and connector violations inside imported local helpers', (t) => {
  const root = makeProject(t, {
    'app/helper-violations.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { loadDirect, saveInvalid } from '@/services/incidents';
      export default function HelperViolations() {
        loadDirect();
        saveInvalid();
        return <SafeAreaView />;
      }
    `,
    'src/services/incidents.ts': `
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export function loadDirect() {
        return fetch('https://example.crm.dynamics.com/api/data/v9.2/incidents');
      }
      export function saveInvalid() {
        return IncidentsService.create({ statecode: 0 });
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/helper-violations.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const helperIssues = issuesFor(result, 'src/services/incidents.ts');
  assert.ok(helperIssues.some((issue) => issue.rule === 'connector-first' && issue.status === 'fail'));
  assert.ok(helperIssues.some(
    (issue) => issue.rule === 'dataverse-server-managed-payload' && issue.status === 'fail',
  ));
});

test('checks every nested return path from local payload builders', (t) => {
  const root = makeProject(t, {
    'app/payload-builder.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      function buildPayload(existing: boolean) {
        if (existing) return { statecode: 0 };
        return { title: 'New incident' };
      }
      export default function PayloadBuilder() {
        IncidentsService.create(buildPayload(true));
        return <SafeAreaView />;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { create: async (payload: object) => payload };
    `,
  });

  const result = runAst(root, ['app/payload-builder.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(issuesFor(result, 'app/payload-builder.tsx').some(
    (issue) => issue.rule === 'dataverse-server-managed-payload'
      && issue.status === 'fail'
      && /statecode/.test(issue.message),
  ));
});

test('resolves cursor hooks, generic JSX, and hoisted service options', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'app/feed.tsx': `
      import { FlatList as List } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useIncidentCursor } from '@/hooks/useIncidentCursor';
      export default function Feed() {
        const { items, loadMore } = useIncidentCursor();
        return <SafeAreaView><List<{ id: string }> data={items} onEndReached={loadMore} renderItem={() => null} /></SafeAreaView>;
      }
    `,
    'src/hooks/useIncidentCursor.ts': `
      import { useInfiniteQuery } from '@tanstack/react-query';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      const OPTIONS = { select: ['title'], orderBy: ['createdon desc', 'incidentid asc'], maxPageSize: 50 };
      export function useIncidentCursor() {
        const query = useInfiniteQuery({
          queryKey: ['incidents'],
          queryFn: ({ pageParam }: { pageParam?: string }) =>
            IncidentsService.getAll({ ...OPTIONS, skipToken: pageParam }),
          getNextPageParam: (last: { skipToken?: string }) => last.skipToken,
          initialPageParam: undefined,
        });
        return { items: [], loadMore: query.fetchNextPage };
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { getAll: async (options: object) => options };
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!issuesFor(result, 'app/feed.tsx').some(
    (issue) => issue.rule === 'dataverse-heavy-lists',
  ));
});

test('resolves aliased cursor hook imports by symbol origin', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'app/feed.tsx': `
      import { FlatList } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useInfiniteQuery as usePages } from '@tanstack/react-query';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function Feed() {
        const query = usePages({
          queryKey: ['incidents'],
          queryFn: ({ pageParam }: { pageParam?: string }) => IncidentsService.getAll({
            select: ['title'],
            orderBy: ['createdon desc'],
            maxPageSize: 50,
            skipToken: pageParam,
          }),
          getNextPageParam: (last: { skipToken?: string }) => last.skipToken,
          initialPageParam: undefined,
        });
        return <SafeAreaView><FlatList data={[]} onEndReached={() => query.fetchNextPage()} renderItem={() => null} /></SafeAreaView>;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { getAll: async (options: object) => options };
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(!issuesFor(result, 'app/feed.tsx').some(
    (issue) => issue.rule === 'dataverse-heavy-lists' && /must use/.test(issue.message),
  ));
});

test('does not trust an app-local hook merely named useInfiniteQuery', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'app/feed.tsx': `
      import { FlatList } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      function useInfiniteQuery() { return { items: [] }; }
      export default function Feed() {
        const query = useInfiniteQuery();
        return <SafeAreaView><FlatList data={query.items} onEndReached={() => {}} renderItem={() => null} /></SafeAreaView>;
      }
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(issuesFor(result, 'app/feed.tsx').some(
    (issue) => issue.rule === 'dataverse-heavy-lists'
      && issue.status === 'fail'
      && /must use/.test(issue.message),
  ));
});

test('reports unresolved cursor option spreads as unknown without blocking', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'app/feed.tsx': `
      import { FlatList } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useInfiniteQuery } from '@tanstack/react-query';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      declare const opaqueOptions: object;
      const KNOWN = { select: ['title'], orderBy: ['createdon desc'], maxPageSize: 50 };
      export default function Feed() {
        const query = useInfiniteQuery({
          queryKey: ['incidents'],
          queryFn: ({ pageParam }: { pageParam?: string }) =>
            IncidentsService.getAll({ ...opaqueOptions, ...KNOWN, skipToken: pageParam }),
          getNextPageParam: (last: { skipToken?: string }) => last.skipToken,
          initialPageParam: undefined,
        });
        return <SafeAreaView><FlatList data={[]} onEndReached={() => query.fetchNextPage()} renderItem={() => null} /></SafeAreaView>;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { getAll: async (options: object) => options };
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const issues = issuesFor(result, 'app/feed.tsx').filter(
    (issue) => issue.rule === 'dataverse-heavy-lists',
  );
  assert.ok(
    issues.some((issue) => issue.status === 'unknown'),
    JSON.stringify(report(result), null, 2),
  );
  assert.ok(!issues.some((issue) => issue.status === 'fail'));
});

test('does not apply Dataverse paging rules to arbitrary services packages', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'node_modules/@acme/services/index.d.ts': `
      export declare const CatalogService: { getAll(options?: object): Promise<unknown[]> };
    `,
    'app/feed.tsx': `
      import { FlatList } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useInfiniteQuery } from '@tanstack/react-query';
      import { CatalogService } from '@acme/services';
      export default function Feed() {
        const query = useInfiniteQuery({
          queryKey: ['catalog'],
          queryFn: () => CatalogService.getAll(),
          getNextPageParam: () => undefined,
          initialPageParam: undefined,
        });
        return <SafeAreaView><FlatList data={[]} onEndReached={() => query.fetchNextPage()} renderItem={() => null} /></SafeAreaView>;
      }
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(!issuesFor(result, 'app/feed.tsx').some(
    (issue) => issue.rule === 'dataverse-heavy-lists' && issue.status === 'fail',
  ));
});

test('does not let an unused pageParam prove a getAll call is cursor-paged', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'app/feed.tsx': `
      import { FlatList } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useInfiniteQuery } from '@tanstack/react-query';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function Feed() {
        const query = useInfiniteQuery({
          queryKey: ['incidents'],
          queryFn: ({ pageParam }: { pageParam?: string }) =>
            IncidentsService.getAll({
              select: ['title'],
              orderBy: ['createdon desc'],
              maxPageSize: 50,
            }),
          getNextPageParam: (last: { skipToken?: string }) => last.skipToken,
          initialPageParam: undefined,
        });
        return <SafeAreaView><FlatList data={[]} onEndReached={() => query.fetchNextPage()} renderItem={() => null} /></SafeAreaView>;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { getAll: async (options: object) => options };
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(issuesFor(result, 'app/feed.tsx').some(
    (issue) => issue.rule === 'dataverse-heavy-lists'
      && issue.status === 'fail'
      && /skipToken/.test(issue.message),
  ));
});

test('rejects a static undefined skipToken value', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'app/feed.tsx': `
      import { FlatList } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useInfiniteQuery } from '@tanstack/react-query';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export default function Feed() {
        const query = useInfiniteQuery({
          queryKey: ['incidents'],
          queryFn: () => IncidentsService.getAll({
            select: ['title'],
            orderBy: ['createdon desc'],
            maxPageSize: 50,
            skipToken: undefined,
          }),
          getNextPageParam: () => undefined,
          initialPageParam: undefined,
        });
        return <SafeAreaView><FlatList data={[]} onEndReached={() => query.fetchNextPage()} renderItem={() => null} /></SafeAreaView>;
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { getAll: async (options: object) => options };
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(issuesFor(result, 'app/feed.tsx').some(
    (issue) => issue.rule === 'dataverse-heavy-lists'
      && issue.status === 'fail'
      && /static empty/.test(issue.message),
  ));
});

test('resolves renamed primitive imports for accessibility rules', (t) => {
  const root = makeProject(t, {
    'app/a11y.tsx': `
      import { Button as IconButton } from 'tamagui';
      import { SafeAreaView } from 'react-native-safe-area-context';
      export default function A11y() {
        return <SafeAreaView><IconButton icon={() => null} size="$2" /></SafeAreaView>;
      }
    `,
  });

  const result = runAst(root, ['app/a11y.tsx']);
  assert.equal(result.status, 0);
  const rules = issuesFor(result, 'app/a11y.tsx').map((issue) => issue.rule);
  assert.ok(rules.includes('icon-only-control-missing-label'));
  assert.ok(rules.includes('small-touch-target-without-hitslop'));
});

test('enforces semantic connector, icon, contrast, status, and navigation rules', (t) => {
  const root = makeProject(t, {
    'app/quality.tsx': `
      import { MaterialIcons } from '@expo/vector-icons';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { Badge, Text, YStack } from 'tamagui';
      import { router } from 'expo-router';
      const FAINT = '$color4';
      function loadDirect(org: string) {
        return fetch(\`https://\${org}.crm.dynamics.com/api/data/v9.2/incidents\`);
      }
      export default function Quality() {
        loadDirect('contoso');
        router.push('/login');
        return (
          <SafeAreaView>
            <YStack borderLeftWidth={4}><Badge>Failed</Badge></YStack>
            <YStack bg="$red10" minHeight={220}><Text color={FAINT}>Failure</Text></YStack>
            <Text bg="$yellow8" color="white">Warning</Text>
            <MaterialIcons name="home" />
          </SafeAreaView>
        );
      }
    `,
  });

  const result = runAst(root, ['app/quality.tsx']);
  assert.equal(result.status, 0);
  const rules = new Set(issuesFor(result, 'app/quality.tsx').map((issue) => issue.rule));
  for (const rule of [
    'connector-first',
    'dominant-red-detail-header',
    'icon-imports',
    'low-contrast-foreground-token',
    'navigation-singleton-push',
    'redundant-status-cues',
    'white-on-warm-status-fill',
  ]) {
    assert.ok(rules.has(rule), `missing ${rule}: ${JSON.stringify([...rules])}`);
  }
});

test('reports cross-file cursor violations at the helper source', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
      ## Screens
      ### Feed
      - File: app/feed.tsx
      - Pagination: cursor
    `,
    'app/feed.tsx': `
      import { FlatList } from 'react-native';
      import { SafeAreaView } from 'react-native-safe-area-context';
      import { useIncidentCursor } from '@/hooks/useIncidentCursor';
      export default function Feed() {
        const { items, loadMore } = useIncidentCursor();
        return <SafeAreaView><FlatList data={items} onEndReached={loadMore} renderItem={() => null} /></SafeAreaView>;
      }
    `,
    'src/hooks/useIncidentCursor.ts': `
      import { useInfiniteQuery } from '@tanstack/react-query';
      import { IncidentsService } from '@/generated/services/IncidentsService';
      export function useIncidentCursor() {
        useInfiniteQuery({
          queryKey: ['incidents'],
          queryFn: ({ pageParam }: { pageParam?: string }) =>
            IncidentsService.getAll({ select: ['title'], skipToken: pageParam }),
          getNextPageParam: (last: { skipToken?: string }) => last.skipToken,
          initialPageParam: undefined,
        });
        return { items: [], loadMore: () => undefined };
      }
    `,
    'src/generated/services/IncidentsService.ts': `
      export const IncidentsService = { getAll: async (options: object) => options };
    `,
  });

  const result = runAst(root, ['app/feed.tsx']);
  assert.equal(result.status, 0);
  const cursorIssues = report(result).issues.filter((issue) => issue.rule === 'dataverse-heavy-lists');
  assert.ok(cursorIssues.some((issue) => issue.file === 'src/hooks/useIncidentCursor.ts'));
  assert.ok(cursorIssues.every((issue) => issue.file !== 'app/feed.tsx'));
});

test('analyzes JavaScript and JSX sources', (t) => {
  const root = makeProject(t, {
    'app/legacy.jsx': `
      import { Feather } from '@expo/vector-icons';
      import { SafeAreaView } from 'react-native-safe-area-context';
      export default function Legacy() { return <SafeAreaView><Feather name="home" /></SafeAreaView>; }
    `,
  });

  const result = runAst(root, ['app/legacy.jsx']);
  assert.equal(result.status, 0);
  assert.ok(issuesFor(result, 'app/legacy.jsx').some((issue) => issue.rule === 'icon-imports'));
});

test('report mode is non-blocking while canonical mode blocks proven failures', (t) => {
  const root = makeProject(t, {
    'app/unsafe.tsx': `
      import { ScrollView } from 'react-native';
      export default function Unsafe() { return <ScrollView />; }
    `,
  });

  const reportResult = runAst(root, ['app/unsafe.tsx']);
  assert.equal(reportResult.status, 0);
  assert.equal(report(reportResult).summary.fail, 1);

  const checkResult = runAstCheck(root, ['app/unsafe.tsx']);
  assert.equal(checkResult.status, 2);
  assert.match(checkResult.stderr, /BLOCKED: 1 semantic finding/);
});

test('dispatcher builds one TypeScript Program for a multi-file batch', (t) => {
  const root = makeProject(t, {
    'app/one.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      export default function One() { return <SafeAreaView />; }
    `,
    'app/two.tsx': `
      import { SafeAreaView } from 'react-native-safe-area-context';
      export default function Two() { return <SafeAreaView />; }
    `,
  });
  const traceFile = path.join(root, 'program-trace.log');
  const result = spawnSync(
    process.execPath,
    [
      dispatcherScript,
      '--project-root',
      root,
      '--file',
      'app/one.tsx',
      '--file',
      'app/two.tsx',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MOBILE_AST_PROGRAM_TRACE_FILE: traceFile },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
});

test('missing TypeScript emits unknown and exits successfully', (t) => {
  const root = makeProject(t, {
    'app/unknown.tsx': 'export default function Unknown() { return null; }',
  });

  const result = runAst(root, ['app/unknown.tsx'], { MOBILE_AST_DISABLE_TYPESCRIPT: '1' });
  assert.equal(result.status, 0, result.stderr);
  const output = report(result);
  assert.equal(output.summary.fail, 0);
  assert.equal(output.summary.unknown, 1);
  assert.equal(output.issues[0].rule, 'analyzer-unavailable');
});

test('standalone report rejects targets outside the project root', (t) => {
  const root = makeProject(t, {
    'app/home.tsx': 'export default function Home() { return null; }',
  });
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.tsx`);
  fs.writeFileSync(outside, 'export default function Outside() { return null; }');
  t.after(() => fs.rmSync(outside, { force: true }));

  const result = spawnSync(
    process.execPath,
    [astScript, '--project-root', root, '--report', '--file', outside],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the mobile project root/);
});

test('standalone report rejects missing explicit targets and missing file values', (t) => {
  const root = makeProject(t, {
    'app/home.tsx': 'export default function Home() { return null; }',
  });

  const missingTarget = spawnSync(
    process.execPath,
    [astScript, '--project-root', root, '--report', '--file', path.join(root, 'app/missing.tsx')],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(missingTarget.status, 1);
  assert.match(missingTarget.stderr, /Validation target not found/);

  const missingValue = spawnSync(
    process.execPath,
    [astScript, '--project-root', root, '--report', '--file'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /Missing value for --file/);
});
