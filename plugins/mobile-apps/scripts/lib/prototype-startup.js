'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inside, readJson } = require('./prototype-files');

function localStartup(entryRoute) {
  return {
    'app/_layout.tsx': `import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PrototypeProvider } from '../src/data/PrototypeProvider';
export default function RootLayout() {
  return <PrototypeProvider><StatusBar style="auto" /><Slot /></PrototypeProvider>;
}
`,
    'app/index.tsx': `import { Redirect } from 'expo-router';\nexport default function Index() { return <Redirect href=${JSON.stringify(entryRoute)} />; }\n`,
    'app/(app)/_layout.tsx': `import { Stack } from 'expo-router';\nexport default function AppLayout() { return <Stack screenOptions={{ headerShown: false }} />; }\n`,
  };
}

function verifyPrototypeStartup(root) {
  const rootSource = fs.readFileSync(inside(root, 'app/_layout.tsx'), 'utf8');
  if (!rootSource.includes('PrototypeProvider')) throw new Error('Prototype startup is not fully materialized');
  const paths = readJson(root, 'tsconfig.json').compilerOptions?.paths;
  if (JSON.stringify(paths?.['@/data']) !== '["src/data"]' || JSON.stringify(paths?.['@/data/*']) !== '["src/data/*"]') {
    throw new Error('Prototype app-owned data aliases are missing or stale');
  }
  const errors = [];
  function visit(relative) {
    const file = inside(root, relative);
    if (!fs.existsSync(file)) return;
    if (relative === 'src/generated') return; // Official bytes are never modified or repurposed.
    if (fs.statSync(file).isDirectory()) {
      for (const entry of fs.readdirSync(file)) visit(`${relative}/${entry}`);
    } else if (/\.[jt]sx?$/.test(file)) {
      const source = fs.readFileSync(file, 'utf8');
      if (/(?:from\s*|require\s*\(\s*)['"][^'"]*(?:power\.config|\/generated\/)/.test(source)
        || /(?:from\s*|require\s*\(\s*)['"]@microsoft\/power-apps-native-host['"]/.test(source)) errors.push(relative);
    }
  }
  visit('app');
  visit('src');
  if (errors.length) throw new Error(`Prototype source imports inactive live modules: ${errors.join(', ')}`);
  return { ok: true };
}

module.exports = { localStartup, verifyPrototypeStartup };
