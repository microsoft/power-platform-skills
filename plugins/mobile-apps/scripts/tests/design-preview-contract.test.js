'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { readSkillWorkflow } = require('./helpers/workflow-documents');

const pluginRoot = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(pluginRoot, relative), 'utf8');
const design = read('skills/design-system/SKILL.md');
const preview = read('skills/preview-screens/SKILL.md');
const mapping = read('shared/references/tamagui-html-mapping.md');
const integration = read('skills/design-system/references/tamagui-integration.md');
const intent = read('skills/preview-screens/references/intent-authoring.md');

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

function fencedBlocks(source, language) {
  return [...source.matchAll(new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)```', 'g'))]
    .map(match => match[1]);
}

test('design entry stays bounded and routes optional work instead of preloading the catalog', () => {
  assert.ok(design.split(/\r?\n/).length <= 160, 'design entry exceeds 160 lines');
  assert.ok(Buffer.byteLength(design) <= 10_000, 'design entry exceeds 10 KB');
  assert.match(design, /Read only the active step and input reference/);
  assert.match(design, /No brand input \| No extraction or preset reference/);
  assert.match(design, /Optional operations — read only on request/);
  assert.match(design, /brand\/design-system\.md/);
  assert.match(design, /brand\/tokens\.ts/);
  assert.match(design, /preview_path: _design_preview\.html/);
  assert.doesNotMatch(design, /References — read before executing|defaulting to polished-inspection|aviation.*carve-out/i);
});

test('reachable design and preview phases retain their existing checkpoint names exactly once', () => {
  const expected = {
    'design-system': [
      'collect_brand_inputs', 'select_design_depth', 'generate_design_system_artifacts',
      'render_design_system_gallery', 'approve_design_system', 'render_branded_screen_previews',
      'persist_design_system',
    ],
    'preview-screens': [
      'discover_app_screens', 'render_screen_preview_frames',
      'write_screen_preview_document', 'open_screen_preview',
    ],
  };
  for (const [skill, names] of Object.entries(expected)) {
    const workflow = readSkillWorkflow(skill);
    const markers = [...workflow.matchAll(/\*\*Telemetry checkpoint: `([^`]+)`\*\*/g)];
    assert.deepEqual(markers.map(match => match[1]).sort(), [...names].sort());
    for (const marker of markers) {
      const precedingLine = workflow.slice(0, marker.index).trimEnd().split(/\r?\n/).at(-1);
      assert.match(precedingLine, /^#{2,4}\s+\S/, `${skill}:${marker[1]} must follow its heading`);
    }
  }
});

test('design handoff keeps decisions and approval provenance in the foreground memory contract', () => {
  assert.match(design, /Missing product decisions → `NEEDS_CONTEXT`/);
  assert.match(design, /Only foreground approves through an actual available host question tool/);
  assert.match(design, /No nested or no-op agent dispatch/);
  for (const field of ['Current phase', 'Pending decision', 'Approved preview']) assert.ok(design.includes(field));
  assert.match(design, /path \+ plan\/design revision; it is not runtime proof/);
  assert.match(design, /`DONE`, `DONE_WITH_CONCERNS: \.\.\.`, `NEEDS_CONTEXT: \.\.\.`, or `BLOCKED: \.\.\.`/);
  assert.doesNotMatch(design, /INDUSTRY_CONFIRM_REQUESTED|DESIGN_VIBE_REQUESTED/);
});

test('owned design and preview references remain reachable inside the installed plugin', () => {
  const files = [
    ...markdownFiles(path.join(pluginRoot, 'skills/design-system')),
    ...markdownFiles(path.join(pluginRoot, 'skills/preview-screens')),
    ...['design-planning', 'tamagui-html-mapping', 'color-palette-architecture', 'typography-and-tone']
      .map(name => path.join(pluginRoot, 'shared/references', `${name}.md`)),
  ];
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(href.split('#')[0]));
      const relative = path.relative(pluginRoot, target);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file}: link escapes plugin: ${href}`);
      assert.ok(fs.existsSync(target), `${file}: missing ${href}`);
      checked++;
    }
  }
  assert.ok(checked > 20, 'reference traversal did not cover the workflow');
});

test('preview mode routing keeps intent and implementation artifacts distinct', () => {
  assert.match(preview, /\| `--mode intent` \|[^\n]+`_design_preview\.html`/);
  assert.match(preview, /\| `--mode implementation` \|[^\n]+`preview\.html`/);
  assert.match(preview, /No mode \| Implementation if visible app screen sources have been built; otherwise intent/);
  assert.match(preview, /Auth-only\/scaffold placeholders/);
  assert.match(preview, /explicit mode always wins/);
  assert.match(preview, /explicit implementation has no built screens, report the missing input/);
  assert.match(preview, /Never copy `_design_preview\.html` to `preview\.html`/);
  assert.match(preview, /read the full selected screen TSX and its referenced local UI components\/hooks/i);
  assert.match(preview, /actual source determines what exists/);
  assert.match(preview, /never “native app verified[.”]/);
});

test('intent authoring uses compact product context and three main screens without Tamagui conversion', () => {
  assert.match(preview, /Intent:\*\* use approved design\/token values directly in CSS/);
  assert.match(preview, /Implementation only:\*\* read \[Tamagui-to-HTML mapping\]/);
  assert.match(intent, /Do not read the Tamagui component\s+conversion table/);
  assert.match(intent, /three main screens by default/);
  for (const field of ['Product/domain', 'Journeys', 'Data model', 'Business rules', 'Connectors', 'Native capabilities', 'Navigation', 'Design']) {
    assert.ok(intent.includes(`| ${field} |`), `missing product context ${field}`);
  }
  assert.match(intent, /planned before preview, not provisioned/);
  assert.match(intent, /do not resolve environments or create Dataverse resources/);
  assert.match(intent, /updates affected existing screen specs/);
  assert.match(intent, /not HTML-to-TSX conversion/);
  assert.match(intent, /visual thesis/);
  assert.match(intent, /Container hierarchy and phone density/);
  assert.match(preview, /390 x 844 CSS px as the phone frame default/);
  assert.match(intent, /Do not widen the phone/);
  assert.match(intent, /avoid redundant nesting/);
  assert.match(intent, /image grids for\s+visual discovery/);
  assert.match(intent, /timeline\/agenda for chronological work/);
  assert.match(intent, /universal continuous-list default/);
  assert.match(intent, /Tablet-first work uses the approved tablet viewport/);
  assert.match(intent, /Reserve pills\/chips for selectable filters or states/);
  assert.match(intent, /without flattening useful hierarchy/);
  assert.match(intent, /three representative screens side by side above\s+the fold/);
  assert.match(intent, /assumptions.*secondary to the screens/);
  assert.match(intent, /No out-of-scope record\s+remains/);
  assert.match(intent, /Back\s+restores the originating scope\/filter\/selection/);
  assert.match(intent, /Reset restores the exact initial scenario/);
  assert.match(intent, /desktop and 320px widths/);
  assert.match(intent, /Do not report these checks from source inspection alone/);
  assert.match(mapping, /implementation previews only/);
  const handoff = read('skills/create-mobile-app/references/phase-04-design.md');
  assert.match(handoff, /planned connector\s+reads\/writes, approved native capabilities/);
  assert.match(handoff, /accepted preview's hierarchy, layout and interactions/);
  assert.match(read('agents/screen-builder.md'), /accepted intent-preview screen as a visual reference/);
  assert.match(read('agents/references/screen-builder/design-api.md'), /Cards and continuous lists are\s+both valid/);
});

test('device references set both dimensions without changing the app composition', () => {
  assert.match(preview, /match its width and height/);
  assert.match(preview, /not the surrounding screenshot/);
  assert.match(preview, /Keep the same geometry across screens and revisions/);
  assert.match(preview, /Measure usable content\s+separately from decorative bezels/);
  assert.match(preview, /Do not stretch frames with grid columns or shorten them using\s+browser `vh`/);
  assert.match(preview, /Scroll content inside the device/);
  assert.match(preview, /Report measured frame\/content dimensions/);
  assert.match(intent, /Inspect every selected screen/);
  assert.match(intent, /not only an empty-state screenshot/);
  assert.match(intent, /without resizing their device geometry/);
});

test('task substance comes from product context without hardcoded visual or data quotas', () => {
  assert.match(intent, /Task substance before polish/);
  assert.match(intent, /then choose their visual hierarchy/);
  assert.match(intent, /typical populated scenario/);
  assert.match(intent, /no\s+minimum record count/);
  assert.match(intent, /Do not broaden scope, duplicate records or pad cards/);
  assert.match(intent, /do not require every item to have an owner, progress bar, image or action menu/);
  assert.match(intent, /Progress indicators need meaningful evidence, not invented percentages/);
  assert.match(intent, /Does selection open the relevant task\/content/);
  assert.match(intent, /not a new maker questionnaire, approval gate, universal layout or domain-field checklist/);
  assert.match(read('shared/references/design-planning.md'), /Choose content before containers/);
  assert.match(read('shared/references/screen-planning/spec-contract.md'), /no mandatory metadata fields, container types or record counts/);
  assert.match(read('agents/references/screen-builder/design-api.md'), /do not invent production data to reproduce a richer mock/);
});

test('journey contract requires coherent interactions without an archetype quota or invented native success', () => {
  assert.match(preview, /representative preview screen IDs and selection rationale/);
  assert.match(preview, /one coherent, clearly labeled illustrative scenario/);
  assert.match(preview, /Reset restores the initial scenario/);
  assert.match(preview, /Implementation mock actions must correspond to handlers\/states present in source/);
  assert.match(preview, /Native-only — not executed in browser/);
  assert.match(preview, /Hard checks before handoff/);
  for (const category of ['Safety:', 'Links:', 'Required actions:', 'Accessibility:', 'Token coherence:']) {
    assert.ok(preview.includes(category), `missing execution check: ${category}`);
  }
  assert.match(preview, /are \*\*advisory\*\*, not blocking tests/);
  assert.match(preview, /browser interaction was not verified/);
});

test('preview guidance stays product-neutral instead of turning one pilot into universal rules', () => {
  const contract = read('shared/references/screen-planning/spec-contract.md');
  const rules = contract.split('#### Domain rules and first-use review\n')[1]?.split('\n### Preview selection')[0];
  assert.ok(rules, 'domain review must stay in the existing screen contract');
  assert.doesNotMatch(intent, /\bgym\b|\bequipment\b|\bwarrant(?:y|ies)\b|\brepair\b/i);
  assert.doesNotMatch(rules, /\bgym\b|\bequipment\b|\bwork order\b|\basset availability\b/i);
  assert.match(rules, /Neither automatically couple nor artificially separate transitions/);
  assert.match(rules, /reader, resume point, workspace/);
  assert.match(intent, /Do not add search, filters, counters or mutations just to satisfy this check/);
  assert.match(intent, /Independent views need\s+not share a filter/);
  for (const option of ['rows for rapid scanning', 'visual discovery', 'reader/exercise canvas', 'cards, grids']) {
    assert.ok(intent.includes(option), `missing valid alternative: ${option}`);
  }
  assert.match(preview, /Include scanning only when approved/);
  assert.match(preview, /any explicitly approved coupling/);
});

test('import and refresh paths preserve ordinary artifacts and do not execute imported projects', () => {
  const spec = read('skills/design-system/references/design-spec-extraction.md');
  const code = read('skills/design-system/references/code-app-extraction.md');
  const refresh = read('skills/design-system/references/refresh-flow.md');
  const inputs = read('skills/design-system/references/input-modes.md');
  assert.match(spec, /brand\/design-system\.md` and importable `brand\/tokens\.ts/);
  assert.doesNotMatch(spec, /SKIP Sub-step|Jump to Sub-step/);
  assert.match(code, /Never run npm\/npx or the target's configuration/);
  assert.doesNotMatch(code, /npx tailwindcss --print-config/);
  assert.match(inputs, /No-brand work reads none of the extractors/);
  assert.match(refresh, /snapshot affected files before mutation/);
  assert.match(refresh, /History is opt-in/);
  assert.match(refresh, /brand\/tokens\.dark\.ts/);
  assert.match(refresh, /after\*\* source\/config changes, reading current sources/);
});

function runBrandExample() {
  const example = fencedBlocks(integration, 'ts').find(block => block.includes('const tokens = createTokens'));
  assert.ok(example, 'brand-import example is missing');
  // Execute the documented customization body with the host boundary stubbed.
  // This tests merge/forwarding contracts, not the external host's alias algorithm.
  const body = example.slice(example.indexOf('const tokens = createTokens'), example.indexOf('// CUSTOMIZATION END'))
    .replace(/\bexport /g, '');
  const brandTokens = {
    color: {
      bg: '#fbf7ef', surface: '#fffdf9', text: '#201a12', textMuted: '#635345',
      primary: '#714617', accent: '#714617',
      statusSuccess: '#225c37', statusWarning: '#785000',
      statusDanger: '#a12828', statusInfo: '#235479',
    },
    space: { sm: 8, lg: 18 },
    size: { buttonHeight: 52 },
    radius: { md: 10 },
  };
  const defaultConfig = {
    tokens: {
      space: { 4: 16, true: 16 }, size: { 4: 44 }, radius: { 4: 9 }, zIndex: { 1: 100 },
    },
    themes: {
      light: { background: '#fff', color: '#111', color6: '#ccc' },
      dark: { background: '#151515', color: '#eee', color6: '#555' },
      dark_blue: { background: '#123' },
    },
  };
  const calls = [];
  const context = vm.createContext({
    defaultConfig, brandTokens, createTokens: value => value,
    withPowerAppsSemanticAliases: (base, colors) => {
      calls.push({ base, colors });
      return {
        ...base,
        surface0: colors.bg || base.background,
        surface1: colors.surface || base.background,
        text0: colors.text || base.color,
        accentBase: colors.accent,
      };
    },
  });
  vm.runInContext(`${body}\nglobalThis.result = { tokens, appLightTheme, appDarkTheme, customConfig };`, context);
  return { result: context.result, calls, brandTokens, defaultConfig };
}

test('documented brand import preserves numeric scales and separates light and dark surfaces', () => {
  const { result, calls, brandTokens, defaultConfig } = runBrandExample();
  assert.equal(result.tokens.space[4], 16);
  assert.equal(result.tokens.space.lg, 18);
  assert.equal(result.tokens.size[4], 44);
  assert.equal(result.tokens.size.buttonHeight, 52);
  assert.equal(result.tokens.radius[4], 9);
  assert.equal(result.tokens.radius.md, 10);
  assert.equal(result.tokens.zIndex, defaultConfig.tokens.zIndex);
  assert.equal(calls[0].colors, brandTokens.color);
  assert.equal(calls[1].colors.bg, undefined);
  assert.equal(calls[1].colors.text, undefined);
  assert.equal(calls[1].colors.accent, brandTokens.color.accent);
  assert.equal(result.appLightTheme.surface0, '#fbf7ef');
  assert.equal(result.appDarkTheme.surface0, '#151515');
  assert.equal(result.customConfig.themes.light, result.appLightTheme);
  assert.equal(result.customConfig.themes.dark, result.appDarkTheme);
  assert.equal(result.customConfig.themes.dark_blue, defaultConfig.themes.dark_blue);
});

test('provider examples forward both resolved themes instead of unrelated baseline colors', () => {
  const example = fencedBlocks(integration, 'tsx').find(block => block.includes('const brandedLightTheme'));
  const body = example.slice(example.indexOf('const brandedLightTheme'), example.indexOf('<PowerAppsProvider'))
    .replace(/: ThemeTokens/g, '');
  const keys = ['surface0', 'surface1', 'surface2', 'surface3', 'color6',
    'text0', 'text1', 'text2', 'text3', 'accentDeep', 'accentBase', 'accentSoft', 'accentOnAccent'];
  const appLightTheme = Object.fromEntries(keys.map(key => [key, `light-${key}`]));
  const appDarkTheme = Object.fromEntries(keys.map(key => [key, `dark-${key}`]));
  const context = vm.createContext({
    appLightTheme, appDarkTheme, hostLightTheme: { preserved: true }, hostDarkTheme: { preserved: true },
  });
  vm.runInContext(`${body}\nglobalThis.result = { brandedLightTheme, brandedDarkTheme };`, context);
  for (const [name, prefix] of [['brandedLightTheme', 'light'], ['brandedDarkTheme', 'dark']]) {
    const resolved = context.result[name];
    assert.equal(resolved.preserved, true);
    for (const key of keys.filter(key => key !== 'color6')) assert.equal(resolved[key], `${prefix}-${key}`);
    assert.equal(resolved.surface4, `${prefix}-color6`);
  }
  assert.match(example, /theme=\{brandedLightTheme\}/);
  assert.match(example, /darkTheme=\{brandedDarkTheme\}/);
});

test('typography example consumes approved roles and converts native units without replacing the scale', () => {
  const example = fencedBlocks(integration, 'ts').find(block => block.includes('const bodyFont = createFont'));
  const font = {
    family: 'Existing', size: { 4: 14, 5: 16 }, weight: { 4: '400', 5: '500' },
    lineHeight: { 4: 20, 5: 24 }, letterSpacing: { 4: 0, 5: 0 },
  };
  const context = vm.createContext({
    brandTokens: { typography: { body: { family: 'Approved', size: 18, weight: '600', lineHeight: 1.5, tracking: 0.02 } } },
    defaultConfig: { fonts: { body: font } }, createFont: value => value,
  });
  vm.runInContext(`${example.slice(example.indexOf('const body ='))}\nglobalThis.result = bodyFont;`, context);
  assert.equal(context.result.family, 'Approved');
  assert.equal(context.result.size[4], 14);
  assert.equal(context.result.size[5], 18);
  assert.equal(context.result.weight[5], '600');
  assert.equal(context.result.lineHeight[5], 27);
  assert.equal(context.result.letterSpacing[5], 0.36);
});

function previewShell() {
  const html = fencedBlocks(mapping, 'html')[0];
  assert.ok(html, 'HTML conversion shell is missing');
  return html;
}

test('preview shell projects resolved brand values and closes CSS variables in both themes', () => {
  const { result } = runBrandExample();
  const substitutions = {
    'light.surface0': result.appLightTheme.surface0, 'light.surface1': result.appLightTheme.surface1,
    'light.background': result.appLightTheme.background, 'light.text0': result.appLightTheme.text0,
    'light.accentBase': result.appLightTheme.accentBase, 'light.accentOnAccent': '#fff',
    'dark.surface0': result.appDarkTheme.surface0, 'dark.surface1': result.appDarkTheme.surface1,
    'dark.background': result.appDarkTheme.background, 'dark.text0': result.appDarkTheme.text0,
    'dark.accentBase': result.appDarkTheme.accentBase, 'dark.accentOnAccent': '#fff',
    'font.body': 'system-ui', 'font.heading': 'system-ui',
  };
  const html = previewShell().replace(/\{\{([^}]+)\}\}/g, (_, name) => substitutions[name] || '');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const root = css.match(/:root\s*\{([^}]+)\}/)[1];
  const dark = css.match(/html\.dark\s*\{([^}]+)\}/)[1];
  const declarations = block => Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(match => [match[1], match[2].trim()]));
  const lightVars = declarations(root);
  const darkVars = { ...lightVars, ...declarations(dark) };
  for (const [, variable] of css.matchAll(/var\((--[\w-]+)/g)) {
    assert.ok(lightVars[variable], `undefined light variable ${variable}`);
    assert.ok(darkVars[variable], `undefined dark variable ${variable}`);
  }
  assert.equal(lightVars['--surface0'], '#fbf7ef');
  assert.equal(lightVars['--surface1'], '#fffdf9');
  assert.equal(darkVars['--surface0'], '#151515');
  assert.equal(darkVars['--surface1'], '#151515');
  assert.equal(lightVars['--accentBase'], '#714617');
  assert.equal(darkVars['--accentBase'], '#714617');
  assert.doesNotMatch(html, /fonts\.googleapis|<script[^>]+src=/i);
});

function element(id, screen = false) {
  const classes = new Set(screen ? ['screen'] : []);
  return {
    id, hidden: false, dataset: {}, attributes: {}, listeners: {}, focused: false,
    classList: {
      contains: value => classes.has(value),
      toggle(value) {
        if (classes.has(value)) { classes.delete(value); return false; }
        classes.add(value); return true;
      },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    focus() { this.focused = true; },
  };
}

test('documented shell navigation is reachable, focusable, and safe for absent destinations', () => {
  const entry = element('screen-start', true);
  const review = element('screen-review', true);
  const startButton = element('start-button');
  const reviewButton = element('review-button');
  startButton.dataset.screen = entry.id;
  reviewButton.dataset.screen = review.id;
  const theme = element('theme-toggle');
  const root = element('root');
  const elements = [entry, review, startButton, reviewButton, theme];
  const document = {
    documentElement: root,
    getElementById: id => elements.find(item => item.id === id),
    querySelectorAll: selector => selector === '.screen' ? [entry, review] : [startButton, reviewButton],
    querySelector: () => entry,
  };
  const script = previewShell().match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace('{{MOCK_JOURNEY_SCRIPT}}', '');
  const context = vm.createContext({ document });
  vm.runInContext(script, context);
  assert.equal(entry.hidden, false);
  assert.equal(review.hidden, true);
  assert.equal(startButton.attributes['aria-current'], 'page');
  reviewButton.listeners.click();
  assert.equal(entry.hidden, true);
  assert.equal(review.hidden, false);
  assert.equal(review.focused, true);
  assert.equal(startButton.attributes['aria-current'], undefined);
  assert.equal(reviewButton.attributes['aria-current'], 'page');
  assert.equal(context.showScreen('missing'), false);
  assert.equal(context.showScreen('theme-toggle'), false);
  assert.equal(review.hidden, false, 'invalid navigation must not blank the current screen');
  theme.listeners.click();
  assert.equal(root.classList.contains('dark'), true);
  assert.equal(theme.attributes['aria-pressed'], 'true');
  theme.listeners.click();
  assert.equal(root.classList.contains('dark'), false);
  assert.equal(context.showScreen(entry.id), true);
});
