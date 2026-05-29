// Maps each natural-language assertion in evals.json to a check function.
// Each check receives { files, eval } and returns { status, reason }.
//
//   files: array of { path, name, content } objects (every .tsx in the fixture,
//          excluding RuntimeTypes.ts)
//   eval:  the eval entry from evals.json (has id, tier, prompt, data, expectations)
//
// status is one of:
//   "pass"   verified
//   "fail"   violated; reason explains
//   "skip"   not applicable or not implementable yet
//
// To add a new assertion: append to ASSERTIONS keyed by exact text from evals.json.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

let _verifiedIcons = null;
function getVerifiedIcons() {
  if (_verifiedIcons) return _verifiedIcons;
  const iconsPath = path.join(
    __dirname,
    '..', '..', '..', '..',
    'plugins', 'model-apps', 'references', 'verified-icons.txt'
  );
  const text = fs.readFileSync(iconsPath, 'utf8');
  _verifiedIcons = new Set(
    text.split('\n').map((s) => s.trim()).filter(Boolean)
  );
  return _verifiedIcons;
}

function setVerifiedIcons(set) {
  _verifiedIcons = set;
}

// Strip line and block comments so regex checks for forbidden patterns don't
// trip on rule-documentation in JSDoc/inline comments. Approximate — doesn't
// parse strings, so `"// not a comment"` is stripped too. Acceptable for
// regex-grep semantics; precise comment handling needs a real parser.
function stripComments(content) {
  // Remove block comments first (greedy with non-greedy inner)
  let out = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Then line comments
  out = out.replace(/\/\/.*$/gm, '');
  return out;
}

function isDataverseFile(content) {
  return /from\s+['"]\.\/RuntimeTypes['"]/.test(content);
}

function isMockFile(content) {
  return !isDataverseFile(content);
}

function violatingFile(files, predicate) {
  return files.find((f) => predicate(f.content));
}

function extractIconImports(content) {
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]@fluentui\/react-icons['"]/g;
  const names = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const list = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of list) {
      const base = item.split(/\s+as\s+/)[0].trim();
      if (base) names.push(base);
    }
  }
  return names;
}

function fail(reason) { return { status: 'fail', reason }; }
function pass() { return { status: 'pass', reason: '' }; }
function skip(reason) { return { status: 'skip', reason }; }

const ASSERTIONS = new Map();

ASSERTIONS.set(
  'Generated .tsx is a single file with `export default GeneratedComponent`',
  ({ files }) => {
    const offender = violatingFile(files, (c) => !/^\s*export\s+default\s+GeneratedComponent\b/m.test(c));
    return offender ? fail(`${offender.name}: missing 'export default GeneratedComponent'`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx destructures props including `pageInput` (e.g., `const { dataApi, pageInput } = props;`)',
  ({ files }) => {
    const offender = violatingFile(files, (c) => !/const\s*\{[^}]*\bpageInput\b[^}]*\}\s*=\s*props/.test(c));
    return offender ? fail(`${offender.name}: does not destructure pageInput from props`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx imports types from `./RuntimeTypes` (for Dataverse pages) or uses realistic inline mock data (for mock pages)',
  ({ files }) => {
    const offender = files.find((f) => {
      if (isDataverseFile(f.content)) return false;
      const hasObjectArray = /\[\s*\{[\s\S]*?\}\s*,\s*\{/.test(f.content);
      return !hasObjectArray;
    });
    return offender ? fail(`${offender.name}: neither imports ./RuntimeTypes nor contains inline mock array`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx uses `makeStyles` with tokens for styling — no inline styles for static values',
  ({ files }) => {
    const offender = violatingFile(files, (c) => !/\bmakeStyles\b/.test(c));
    return offender ? fail(`${offender.name}: makeStyles not used`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx nests `@media` queries inside `makeStyles` slots — no media query used as a top-level slot key',
  ({ files }) => {
    // A media query used as a top-level makeStyles key "reaches into" named
    // slots — i.e. its object's first entry is `slotName: { ... }`. Griffel
    // compiles that as an unused class (overrides never apply) and it fails
    // type-checking. A correctly nested media query (inside a slot) only sets
    // flat CSS property:value pairs, so it never matches `<ident>: {`.
    // Heuristic regex, matching the rest of this file's grep-style checks.
    const topLevelMedia = /@media[^{}]*\{\s*[A-Za-z_$][\w$]*\s*:\s*\{/;
    const offender = violatingFile(files, (c) => topLevelMedia.test(stripComments(c)));
    return offender
      ? fail(`${offender.name}: @media used as a top-level makeStyles key — nest it inside the slot it modifies`)
      : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx does NOT use `100vh` or `100vw`',
  ({ files }) => {
    const offender = violatingFile(files, (c) => /\b100v[hw]\b/.test(stripComments(c)));
    return offender ? fail(`${offender.name}: contains 100vh or 100vw`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx does NOT import `createTheme`, `mergeThemes`, or `useTheme` (these do not exist in Fluent UI V9)',
  ({ files }) => {
    const offender = violatingFile(files, (c) => /\b(createTheme|mergeThemes|useTheme)\b/.test(stripComments(c)));
    return offender ? fail(`${offender.name}: imports forbidden theme function`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx does NOT wrap content in a top-level `<FluentProvider>` (already provided at root)',
  ({ files }) => {
    const offender = violatingFile(files, (c) => /<FluentProvider\b/.test(stripComments(c)));
    return offender ? fail(`${offender.name}: wraps content in <FluentProvider>`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx does NOT use React Router or construct raw URLs / manipulate `window.location` for navigation',
  ({ files }) => {
    const offender = violatingFile(files, (c) => {
      const stripped = stripComments(c);
      return /\bwindow\.location\b/.test(stripped) || /from\s+['"]react-router/.test(stripped) || /pagetype=/i.test(stripped);
    });
    return offender ? fail(`${offender.name}: uses forbidden navigation mechanism`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx uses `Xrm.Navigation.navigateTo` for any in-app navigation',
  ({ files }) => {
    const navIntentFiles = files.filter((f) =>
      /\b(Xrm\.Navigation|openRecord|openForm|navigateTo|openWebResource)\b/.test(stripComments(f.content)));
    if (navIntentFiles.length === 0) return skip('no navigation intent detected');
    // Accept any form of the Xrm Navigation API surface — the rule is about
    // using `Navigation.navigateTo` as the navigation mechanism (vs raw URLs
    // or React Router). The regex matches all defensible forms:
    //   Xrm.Navigation.navigateTo                  (canonical)
    //   Xrm?.Navigation?.navigateTo                (defensive)
    //   xrm.Navigation.navigateTo                  (aliased — e.g. const xrm = (window as any).Xrm)
    //   xrm?.Navigation?.navigateTo                (aliased + defensive)
    // The accompanying nav-intent filter already excludes non-Xrm libraries
    // (react-router, window.location, raw URLs), so a `.Navigation.navigateTo`
    // call here is by definition the Xrm API.
    const offender = navIntentFiles.find((f) => {
      const stripped = stripComments(f.content);
      return !/\bNavigation\s*\??\s*\.\s*navigateTo\b/.test(stripped);
    });
    return offender ? fail(`${offender.name}: nav intent but does not use Xrm.Navigation.navigateTo`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx uses Fluent UI icons in unsized form (e.g., `AddRegular`, not `Add24Regular`)',
  ({ files }) => {
    const sizedRe = /\b[A-Z][A-Za-z0-9]*(?:12|16|20|24|28|32|48)(?:Regular|Filled|Light)\b/;
    const offender = violatingFile(files, (c) => sizedRe.test(stripComments(c)));
    if (!offender) return pass();
    const match = stripComments(offender.content).match(sizedRe);
    return fail(`${offender.name}: contains sized icon ${match[0]}`);
  }
);

ASSERTIONS.set(
  'Every named import from `@fluentui/react-icons` in the generated .tsx appears in references/verified-icons.txt — no hallucinated icon names',
  ({ files }) => {
    const verified = getVerifiedIcons();
    for (const f of files) {
      const imports = extractIconImports(f.content);
      const missing = imports.filter((n) => !verified.has(n));
      if (missing.length > 0) {
        return fail(`${f.name}: ${missing.length} unverified icon(s): ${missing.slice(0,3).join(', ')}${missing.length>3?'...':''}`);
      }
    }
    return pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx wraps async `dataApi` calls in try-catch (Dataverse pages only)',
  ({ files }) => {
    const dv = files.filter((f) => isDataverseFile(f.content));
    if (dv.length === 0) return skip('no Dataverse files');
    const offender = dv.find((f) => {
      const hasAwait = /await\s+(?:this\.)?(?:props\.)?dataApi\./.test(f.content);
      if (!hasAwait) return false;
      return !/\btry\s*\{[\s\S]*?\}\s*catch\b/.test(f.content);
    });
    return offender ? fail(`${offender.name}: awaits dataApi but lacks try/catch`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx does NOT include any `TODO`, `FIXME`, ellipsis placeholders, or incomplete function bodies',
  ({ files }) => {
    const offender = files.find((f) => {
      if (/\b(TODO|FIXME)\b/.test(f.content)) return true;
      if (/\/\/\s*\.\.\./.test(f.content)) return true;
      if (/\/\*\s*\.\.\.\s*\*\//.test(f.content)) return true;
      if (/^\s*\.\.\.\s*(\/\/.*)?$/m.test(f.content)) return true;
      return false;
    });
    return offender ? fail(`${offender.name}: contains TODO/FIXME or ellipsis placeholder`) : pass();
  }
);

ASSERTIONS.set(
  'Generated .tsx for lookup display names uses `@OData.Community.Display.V1.FormattedValue` annotations, not lookup-name fields in $select',
  ({ files }) => {
    const dv = files.filter((f) => isDataverseFile(f.content));
    if (dv.length === 0) return skip('no Dataverse files');
    const offender = dv.find((f) => {
      const hasLookupSelect = /\$select=[^"'`]*_[a-z][a-z0-9_]*_value/.test(f.content);
      if (!hasLookupSelect) return false;
      return !/FormattedValue/.test(f.content);
    });
    return offender ? fail(`${offender.name}: lookup _value in $select without FormattedValue`) : pass();
  }
);

ASSERTIONS.set(
  'For DataGrids, generated .tsx imports `createTableColumn` from `@fluentui/react-components` and configures column sizing (columnSizingOptions or resizableColumns)',
  ({ files }) => {
    const gridFiles = files.filter((f) => /<DataGrid\b/.test(f.content));
    if (gridFiles.length === 0) return skip('no <DataGrid> usage');
    const offender = gridFiles.find((f) => {
      const importsCTC = /import\s*\{[^}]*\bcreateTableColumn\b[^}]*\}\s*from\s*['"]@fluentui\/react-components['"]/.test(f.content);
      const sizingCfg = /\b(columnSizingOptions|resizableColumns)\b/.test(f.content);
      return !(importsCTC && sizingCfg);
    });
    return offender ? fail(`${offender.name}: DataGrid usage missing createTableColumn or column sizing`) : pass();
  }
);

ASSERTIONS.set(
  'For Dataverse pages with fetching, separate setState calls inside async callbacks are batched into a single setData(...) call (Rule 14)',
  () => skip('Rule 14 batched-setState requires AST analysis')
);

ASSERTIONS.set(
  'For Dataverse list/detail pages, the inline IIFE + window cache + cache-guard pattern from references/data-caching.md is used (Rule 15); no useCallback for data-fetching functions',
  ({ files }) => {
    const dv = files.filter((f) => isDataverseFile(f.content));
    if (dv.length === 0) return skip('no Dataverse files');
    // Trigger only on files that READ data — queryTable / retrieveMultipleRecords
    // / retrieveRow (the read ops). Write-only pages (createRow/updateRow/
    // deleteRow only, e.g., save-on-completion game pages) aren't list/detail
    // pages and shouldn't be expected to follow the cache pattern.
    const fetching = dv.filter((f) =>
      /dataApi\.(queryTable|retrieveMultipleRecords|retrieveRow|retrieve\b)/.test(f.content)
    );
    if (fetching.length === 0) return skip('no read operations (queryTable/retrieveRow) detected');
    const offender = fetching.find((f) => {
      // Accept any of the canonical window-cache patterns:
      //   window.__foo = ...                  (direct dunderscore)
      //   window as unknown as Record<...>    (typed cast — see sample 9)
      //   window as any                       (loose cast — common in real captures)
      //   (window as any).__foo               (paren-cast property access)
      //   window[CACHE_KEY] = ...              (bracket access)
      const hasCache =
        /\bwindow\s*\.\s*__\w+/.test(f.content) ||
        /\bwindow\s+as\s+(unknown|any)\b/.test(f.content) ||
        /\bwindow\s*\[/.test(f.content);
      const usesCallback = /useCallback\s*\(\s*async/.test(f.content);
      return !hasCache || usesCallback;
    });
    return offender ? fail(`${offender.name}: missing window cache or uses useCallback for fetch`) : pass();
  }
);

ASSERTIONS.set(
  'For multi-page builds, cross-page navigation uses quoted `"PAGEREF_<filename>"` placeholders that the orchestrator\'s Phase 6.5 resolves to real GUIDs',
  ({ files }) => {
    if (files.length <= 1) return skip('single-page fixture');
    const hasPageref = files.some((f) => /["']PAGEREF_[a-zA-Z0-9_-]+["']/.test(f.content));
    const hasNav = files.some((f) => /Xrm\.Navigation\.navigateTo/.test(f.content));
    if (hasNav && !hasPageref) {
      return fail('multi-page fixture has navigation calls but no "PAGEREF_<name>" placeholders');
    }
    return pass();
  }
);

ASSERTIONS.set(
  'For Dataverse pages that call dataApi.queryTable, the result is accessed via .rows (DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() }) — never used directly as an array (Rule 11)',
  ({ files }) => {
    const dv = files.filter((f) => isDataverseFile(f.content));
    if (dv.length === 0) return skip('no Dataverse files');
    const queryFiles = dv.filter((f) => /\bdataApi\.queryTable\b/.test(f.content));
    if (queryFiles.length === 0) return skip('no queryTable usage');
    // Each file that calls queryTable must access .rows somewhere — that's
    // the only safe way to get the records array out of DataTable<T>. Files
    // that iterate `result` / `data` / etc. directly as if it were an array
    // will fail at runtime with "X.map is not a function".
    const offender = queryFiles.find((f) => !/\.rows\b/.test(stripComments(f.content)));
    return offender
      ? fail(`${offender.name}: dataApi.queryTable result must be accessed via .rows (it is a DataTable<T>, not an array)`)
      : pass();
  }
);

const PHASE5_EXPECTATIONS = new Map();

PHASE5_EXPECTATIONS.set(
  'Phase 5b: Generated .tsx uses only column names verified from RuntimeTypes.ts — no guessed names',
  () => skip('column-name verification requires RuntimeTypes.ts fixture')
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated .tsx includes realistic mock data (not empty arrays or identical values)',
  ({ files }) => {
    const mock = files.filter((f) => isMockFile(f.content));
    if (mock.length === 0) return skip('no mock files');
    const offender = mock.find((f) => !/\[\s*\{[\s\S]*?\}\s*,\s*\{/.test(f.content));
    return offender ? fail(`${offender.name}: no realistic mock data array`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Chart uses D3.js exclusively — no Chart.js, Recharts, or other libraries. D3 code uses group() not nest()',
  ({ files }) => {
    const offender = files.find((f) =>
      /from\s+['"](chart\.js|recharts|chartjs|victory|nivo|@nivo|@chartjs)/.test(f.content) ||
      /\bd3\.nest\s*\(/.test(f.content)
    );
    return offender ? fail(`${offender.name}: forbidden chart library or d3.nest()`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): DatePicker (if used) is imported from @fluentui/react-datepicker-compat, not @fluentui/react-components',
  ({ files }) => {
    const offender = files.find((f) =>
      /import\s*\{[^}]*\bDatePicker\b[^}]*\}\s*from\s*['"]@fluentui\/react-components['"]/.test(f.content)
    );
    return offender ? fail(`${offender.name}: DatePicker imported from react-components`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Charts use D3.js exclusively — no Chart.js, Recharts, or other chart libraries',
  ({ files }) => {
    const offender = files.find((f) =>
      /from\s+['"](chart\.js|recharts|chartjs|victory|nivo|@nivo|@chartjs)/.test(f.content));
    return offender ? fail(`${offender.name}: forbidden chart library`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Mock data is realistic (not empty arrays, not identical values)',
  ({ files }) => {
    const mock = files.filter((f) => isMockFile(f.content));
    if (mock.length === 0) return skip('no mock files');
    const offender = mock.find((f) => !/\[\s*\{[\s\S]*?\}\s*,\s*\{/.test(f.content));
    return offender ? fail(`${offender.name}: no realistic mock data array`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Drag-and-drop uses native HTML5 events (onDragStart, onDragOver, onDrop) — no external DnD library',
  ({ files }) => {
    const offender = files.find((f) =>
      /from\s+['"](react-dnd|react-beautiful-dnd|@dnd-kit)/.test(f.content));
    return offender ? fail(`${offender.name}: forbidden DnD library`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): All form fields have aria-labels or aria-labelledby for accessibility',
  () => skip('aria-label coverage requires AST analysis')
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): RTL support is included (dir attribute set based on language.isRtl) because Arabic is a detected RTL language',
  ({ files }) => {
    const offender = files.find((f) => !/\bisRtl\b|dir\s*[:=]\s*["']?(rtl|ltr)/.test(f.content));
    return offender ? fail(`${offender.name}: no RTL handling`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated .tsx uses logical CSS properties (marginInlineStart/End, paddingInlineStart/End) instead of physical (marginLeft/Right)',
  ({ files }) => {
    const offender = files.find((f) => /\b(marginLeft|marginRight|paddingLeft|paddingRight)\b/.test(f.content));
    return offender ? fail(`${offender.name}: uses physical CSS properties`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated .tsx has a translations dictionary with entries for en-US, ar-SA, and fr-FR',
  ({ files }) => {
    const offender = files.find((f) => !/en-US/.test(f.content) || !/ar-SA/.test(f.content) || !/fr-FR/.test(f.content));
    return offender ? fail(`${offender.name}: missing en-US/ar-SA/fr-FR entries`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated .tsx includes language detection boilerplate using Xrm.Utility.getGlobalContext().userSettings.languageId',
  ({ files }) => {
    const offender = files.find((f) => !/Xrm\.Utility\.getGlobalContext\s*\(\s*\)\.userSettings\.languageId/.test(f.content));
    return offender ? fail(`${offender.name}: missing Xrm.Utility.getGlobalContext().userSettings.languageId`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): All user-visible text goes through a translate() helper — no hardcoded display strings in JSX',
  () => skip('translate() coverage requires AST analysis')
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated .tsx uses the choice enum names from RuntimeTypes.ts (not magic numbers)',
  () => skip('choice enum verification requires RuntimeTypes.ts fixture')
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated .tsx uses dataApi.getChoices() or reads FormattedValue annotations for choice display names',
  ({ files }) => {
    const dv = files.filter((f) => isDataverseFile(f.content));
    if (dv.length === 0) return skip('no Dataverse files');
    const choiceUsers = dv.filter((f) => /\b(statuscode|statecode)\b/.test(f.content));
    if (choiceUsers.length === 0) return skip('no choice column usage');
    const offender = choiceUsers.find((f) => {
      // Three valid patterns for handling choice display:
      //  1. dataApi.getChoices() (canonical API)
      //  2. @OData.Community.Display.V1.FormattedValue annotation (canonical)
      //  3. Local enum mapping — constants or option arrays keyed off the
      //     Dataverse choice value floor (100000000+). The agent verifies
      //     these against RuntimeTypes at gen time, so they're safe.
      const hasCanonical = /dataApi\.getChoices|FormattedValue/.test(f.content);
      const hasLocalEnum = /\b1000000\d\d\b/.test(f.content);
      return !hasCanonical && !hasLocalEnum;
    });
    return offender
      ? fail(`${offender.name}: choice columns used without getChoices(), FormattedValue, or a local enum mapping with 100000000+ constants`)
      : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Form uses Fluent UI V9 components (Input, Dropdown, etc.) — not HTML form elements',
  ({ files }) => {
    const offender = files.find((f) => /<(input|select|textarea)(\s|>|\/)/.test(f.content));
    return offender ? fail(`${offender.name}: uses raw HTML <input>/<select>/<textarea>`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Submit uses dataApi.createRow with verified column names from RuntimeTypes.ts',
  ({ files }) => {
    const dv = files.filter((f) => isDataverseFile(f.content));
    if (dv.length === 0) return skip('no Dataverse files');
    const submit = dv.filter((f) => /\b(handleSubmit|onSubmit|onSave)\b/i.test(f.content));
    if (submit.length === 0) return skip('no submit handler');
    const offender = submit.find((f) => !/dataApi\.createRow\b/.test(f.content));
    return offender ? fail(`${offender.name}: submit handler without dataApi.createRow`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): All components and utilities are separate top-level functions (no nested function definitions)',
  () => skip('nested function detection requires AST analysis')
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated code uses ONLY verified column names from RuntimeTypes.ts',
  () => skip('column-name verification requires RuntimeTypes.ts fixture')
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Generated code has no unnecessary complexity matching the \'clean and minimal\' request',
  () => skip('subjective; defer to Layer 3 UX rubric')
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Code uses entity logical name \'task\' (singular lowercase) not \'tasks\'',
  ({ files }) => {
    const offender = files.find((f) => /['"]tasks['"]/.test(f.content));
    return offender ? fail(`${offender.name}: uses 'tasks' instead of 'task'`) : pass();
  }
);

PHASE5_EXPECTATIONS.set(
  'Phase 5 (Page Builder): Status update on drop uses dataApi.updateRow with the correct status enum value',
  ({ files }) => {
    const offender = files.find((f) => /\bonDrop\b/.test(f.content) && !/dataApi\.updateRow/.test(f.content));
    return offender ? fail(`${offender.name}: onDrop without dataApi.updateRow`) : pass();
  }
);

module.exports = {
  ASSERTIONS,
  PHASE5_EXPECTATIONS,
  setVerifiedIcons,
  extractIconImports,
  isDataverseFile,
  isMockFile,
};
