'use strict';

// Single source of truth for dependency versions used by generated genux pages.
// Consumed by scripts/generate-page-manifest.js (writes package.json) and
// referenced by references/supported-dependencies.md (human-readable doc).
//
// Versions marked `confidence: 'pinned'` come from a definitive source
// (regenerate-verified-icons.js explicitly pins @fluentui/react-icons to
// 2.0.326; React 17 is fixed by the genux runtime).
//
// Versions marked `confidence: 'compatible'` are reasonable defaults that
// work with the genux runtime today but may not match the exact patch
// version the runtime ships. Adjusting to runtime-exact versions requires
// upstream cooperation from the genux platform team.
//
// When the upstream version list lands, update only this file — the
// reference doc and the generator both read from here.

const RUNTIME_DEPENDENCIES = {
  'react': {
    version: '17.0.2',
    confidence: 'pinned',
    notes: 'Genux runtime is React 17. Patch version 17.0.2 is the last stable React 17 release.',
  },
  'react-dom': {
    version: '17.0.2',
    confidence: 'pinned',
    notes: 'Pairs with react@17.0.2.',
  },
  '@fluentui/react-components': {
    version: '^9.54.0',
    confidence: 'compatible',
    notes: 'Fluent UI V9 — APIs used by samples (DataGrid, Card, makeStyles+tokens, Field, Dropdown) stable since 9.40.',
  },
  '@fluentui/react-icons': {
    version: '2.0.326',
    confidence: 'pinned',
    notes: 'Pinned by scripts/regenerate-verified-icons.js to keep references/verified-icons.txt in sync with this exact icon set.',
  },
  '@fluentui/react-datepicker-compat': {
    version: '^0.4.50',
    confidence: 'compatible',
    notes: 'V9 compat package — used only when the page calls for a DatePicker.',
  },
  '@fluentui/react-timepicker-compat': {
    version: '^0.2.40',
    confidence: 'compatible',
    notes: 'V9 compat package — used only when the page calls for a TimePicker.',
  },
  'd3': {
    version: '^7.8.5',
    confidence: 'compatible',
    notes: 'D3 v7+ required for d3.group() (the v6 replacement for d3.nest()). Used only by chart-bearing pages.',
  },
};

const DEV_DEPENDENCIES = {
  'typescript': {
    version: '^5.4.0',
    confidence: 'compatible',
    notes: 'Any TS 5.x works for editor support; runtime does its own TS-to-JS transpile.',
  },
  '@types/react': {
    version: '^17.0.80',
    confidence: 'compatible',
    notes: 'Type definitions for React 17.',
  },
  '@types/react-dom': {
    version: '^17.0.25',
    confidence: 'compatible',
    notes: 'Type definitions for React DOM 17.',
  },
  '@types/d3': {
    version: '^7.4.3',
    confidence: 'compatible',
    notes: 'Type definitions for D3 v7. Include only when the page uses D3.',
  },
};

// Subset of runtime deps that every Dataverse-backed page needs.
// Chart and DatePicker deps are included only when the page actually
// uses them (the manifest generator can be told via --features).
const DEFAULT_RUNTIME_KEYS = [
  'react',
  'react-dom',
  '@fluentui/react-components',
  '@fluentui/react-icons',
];

const FEATURE_RUNTIME_KEYS = {
  charts: ['d3'],
  datepicker: ['@fluentui/react-datepicker-compat'],
  timepicker: ['@fluentui/react-timepicker-compat'],
};

const DEFAULT_DEV_KEYS = ['typescript', '@types/react', '@types/react-dom'];

const FEATURE_DEV_KEYS = {
  charts: ['@types/d3'],
};

function buildDependencyMap(features = []) {
  const runtime = {};
  for (const key of DEFAULT_RUNTIME_KEYS) {
    runtime[key] = RUNTIME_DEPENDENCIES[key].version;
  }
  for (const f of features) {
    const keys = FEATURE_RUNTIME_KEYS[f] ?? [];
    for (const key of keys) {
      if (RUNTIME_DEPENDENCIES[key]) runtime[key] = RUNTIME_DEPENDENCIES[key].version;
    }
  }
  return runtime;
}

function buildDevDependencyMap(features = []) {
  const dev = {};
  for (const key of DEFAULT_DEV_KEYS) {
    dev[key] = DEV_DEPENDENCIES[key].version;
  }
  for (const f of features) {
    const keys = FEATURE_DEV_KEYS[f] ?? [];
    for (const key of keys) {
      if (DEV_DEPENDENCIES[key]) dev[key] = DEV_DEPENDENCIES[key].version;
    }
  }
  return dev;
}

module.exports = {
  RUNTIME_DEPENDENCIES,
  DEV_DEPENDENCIES,
  DEFAULT_RUNTIME_KEYS,
  DEFAULT_DEV_KEYS,
  FEATURE_RUNTIME_KEYS,
  FEATURE_DEV_KEYS,
  buildDependencyMap,
  buildDevDependencyMap,
};
