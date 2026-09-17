'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateRequest } = require('../lib/style-site-plan');
const { collectFindings, extractGateMarkers } = require('../lint-skills-alm');

const pluginRoot = path.resolve(__dirname, '..', '..');
const skillRoot = path.join(pluginRoot, 'skills', 'style-site');
const skillPath = path.join(skillRoot, 'SKILL.md');
const quickPath = path.join(skillRoot, 'references', 'quick-start.md');
const skill = fs.readFileSync(skillPath, 'utf8');
const quick = fs.readFileSync(quickPath, 'utf8');
const reference = fs.readFileSync(path.join(skillRoot, 'references', 'proposal-and-verification.md'), 'utf8');
const catalog = fs.readFileSync(path.join(pluginRoot, 'references', 'approval-gates.md'), 'utf8');
const capabilities = fs.readFileSync(path.join(skillRoot, 'references', 'studio-component-capabilities.md'), 'utf8');
const policy = fs.readFileSync(path.join(skillRoot, 'references', 'styling-policy.md'), 'utf8');
const referenceRequests = [...reference.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
  .map((match) => JSON.parse(match[1]));

test('mandatory styling guidance stays within its context budget', () => {
  const bytes = Buffer.byteLength(skill) + Buffer.byteLength(quick);
  assert.ok(bytes <= 12000, `SKILL.md + quick-start.md use ${bytes} bytes; limit is 12000.`);
  assert.ok(skill.length <= 6000, `SKILL.md uses ${skill.length} characters; target is 6000.`);
});

test('frontmatter retains the model and comma-separated tools without mandatory task bookkeeping', () => {
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
  assert.match(frontmatter, /^model: opus$/m);
  const tools = frontmatter.match(/^allowed-tools: (.+)$/m)[1];
  assert.ok(tools.includes(', '));
  assert.doesNotMatch(tools, /[\[\]]|TaskCreate|TaskUpdate|TaskList/);
  assert.ok(tools.includes('mcp__plugin_power-pages_playwright__browser_run_code_unsafe'));
  assert.doesNotMatch(tools, /browser_resize|browser_press_key|browser_take_screenshot/);
  assert.match(skill, /Once per installed plugin version in the current conversation/);
  assert.match(skill, /No final-completion confirmation/);
  assert.match(skill, /Routine CSS uses bundled verified guidance/);
});

test('quick start has one request accepted by the existing schema', () => {
  const examples = [...quick.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)];
  assert.equal(examples.length, 1, 'Keep one normal request, not a duplicate schema reference.');
  const request = JSON.parse(examples[0][1]);
  assert.doesNotThrow(() => validateRequest(request));
  assert.equal(request.styles[0].scope, 'page');
  assert.equal(request.styles[0].owner, 'custom');
  assert.ok(request.components[0].sourcePath);
});

test('component kind is required descriptive metadata, not a capability or authoring enum', () => {
  assert.match(reference, /`kind` \| Required nonempty descriptive text, maximum 120 characters/);
  assert.match(reference, /Metadata, not a capability\/authoring allowlist/);
  assert.match(reference, /Never infer a Studio family from `kind`/);
  assert.match(reference, /descriptive metadata does not authorize component creation or entering internals/);
  assert.doesNotMatch(reference, /\| `kind` \| `section`,/);

  const request = JSON.parse(quick.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1]);
  for (const kind of ['video', 'carousel', 'accordion', 'site-theme', 'Featured video', 'x'.repeat(120)]) {
    request.components[0].kind = kind;
    assert.doesNotThrow(() => validateRequest(request), kind);
  }
  for (const kind of ['', ' ', 'x'.repeat(121), null, 123, []]) {
    request.components[0].kind = kind;
    assert.throws(() => validateRequest(request), /kind/);
  }
  delete request.components[0].kind;
  assert.throws(() => validateRequest(request), /kind/);
});

test('normal command examples use bounded inspection and one coordinator operation per stage', () => {
  // Parse documented commands such as node "${PLUGIN_ROOT}/skills/...js" --flag
  // "<value>". These are documentation contracts only: no site/browser is touched.
  const commands = [...quick.matchAll(/^node "\$\{PLUGIN_ROOT\}\/([^"]+\.js)" (.+)$/gm)];
  assert.equal(commands.length, 3);
  for (const [, script] of commands) {
    assert.ok(fs.existsSync(path.join(pluginRoot, ...script.split('/'))), script);
  }
  const [inspect, prepare, apply] = commands;
  assert.ok(inspect[1].endsWith('inspect-style-context.js'));
  assert.match(inspect[2], /--summary --out "[^"]+" --pageId "[^"]+" --target "\.pp-card"/);
  for (const operation of [prepare, apply]) {
    assert.ok(operation[1].endsWith('style-site-workflow.js'));
  }
  assert.match(prepare[2], /--operation prepare --siteRoot "[^"]+" --request "[^"]+" --out "[^"]+\/revision-1"$/);
  assert.match(apply[2], /--operation apply --plan "[^"]+\/style-site\.plan\.json" --approvedHash "[^"]+" --receipt "[^"]+"$/);
  assert.doesNotMatch(apply[2], /--siteRoot|--apply/);
  assert.match(quick, /Read full review before approval if truncated/);
  assert.match(quick, /revised request and a fresh directory/);
  assert.match(quick, /--mode structure --maxCandidates 10 --selector/);
  assert.match(quick, /--mode styles --properties padding,border-radius --maxCandidates 1/);
});

test('guidance reflects proposal-only routing while retaining optional runtime discovery', () => {
  assert.match(quick, /at most 3 components\/10 style groups/);
  assert.match(quick, /literal IDs\/classes\/tags, not complex selectors/);
  assert.match(quick, /status: "ready-for-review"/);
  assert.match(quick, /artifacts: \{plan,review\}/);
  assert.match(quick, /route\.name: small-change\|expanded/);
  assert.match(quick, /truncated=true/);
  assert.match(reference, /`start`, `deleteCount`, `removed`, and `inserted`/);
  assert.match(reference, /UTF-16 code units/);
  assert.match(reference, /cold flow uses \*\*five\*\*, not four/);
  assert.match(quick, /no HTML preview, local server or browser prerequisite/);
  assert.match(reference, /schemaVersion 2/);
  assert.match(reference, /Never edit a legacy plan or carry its old approval forward/);
  assert.match(reference, /`browser_run_code_unsafe.filename` only when file execution and the path are already permitted/);
  assert.match(reference, /`browser_evaluate.filename` saves results, not collector input/);
  assert.match(reference, /absent properties are unobserved, not zero\/default values/);
});

test('approval markers and catalog retain exactly the conditional local workflow gates', () => {
  const expected = ['style-site:2.runtime', 'style-site:3.scope', 'style-site:5.approve', 'style-site:6.reapprove'];
  assert.deepEqual(extractGateMarkers(skill).map((gate) => gate.gateId), expected);
  assert.deepEqual([...catalog.matchAll(/^\| `(style-site:[^`]+)` \| gate \|/gm)].map((row) => row[1]), expected);
  assert.match(skill, /expanded or ambiguous scope only/);
  assert.match(skill, /exact diff, scope, warnings, and hash \*\*per revision\*\*/);
  assert.match(skill, /explicit host-tool answer/);
  assert.match(skill, /## Independently verify/);
  assert.match(quick, /Studio save\/reopen editability/);

  const findings = collectFindings({ pluginRoot }).filter((finding) =>
    finding.file === skillPath ||
    (path.basename(finding.file) === 'approval-gates.md' && finding.message.includes('style-site:')));
  assert.deepEqual(findings, [], 'Use the existing linter for marker/prose/catalog pairing.');
});

test('all styling guidance links and script references resolve to bundled files', () => {
  const references = fs.readdirSync(path.join(skillRoot, 'references')).filter((file) => file.endsWith('.md'))
    .map((file) => path.join(skillRoot, 'references', file));
  for (const file of [skillPath, ...references]) {
    const content = fs.readFileSync(file, 'utf8');
    for (const [, href] of content.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(href)) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), href)), `${file}: ${href}`);
    }
    for (const [, script] of content.matchAll(/\$\{PLUGIN_ROOT\}\/([^"`\s]+\.js)/g)) {
      assert.ok(fs.existsSync(path.join(pluginRoot, ...script.split('/'))), `${file}: ${script}`);
    }
  }
});

test('preview implementation and instructions cannot silently remain in the installed skill', () => {
  for (const file of ['assets/style-preview.html', 'assets/component-samples.json',
    'scripts/render-style-preview.js', 'scripts/serve-style-preview.js', 'scripts/inspect-preview-contrast.js',
    'references/preview-and-verification.md']) {
    assert.equal(fs.existsSync(path.join(skillRoot, file)), false, file);
  }
  assert.doesNotMatch(skill + quick, /--operation preview|render-style-preview|serve-style-preview|inspect-preview-contrast/);
  const workflow = fs.readFileSync(path.join(skillRoot, 'scripts', 'style-site-workflow.js'), 'utf8');
  assert.doesNotMatch(workflow, /require\([^)]*(?:render-template|playwright|preview)/);
});

test('capability membership describes availability while listed and unlisted properties stay local-first', () => {
  assert.match(skill, /studio-component-capabilities\.md/);
  assert.match(skill, /local authoring for listed\/unlisted properties/);
  assert.match(quick, /required `owner: "custom"`/);
  assert.match(quick, /both listed and unlisted/);
  assert.match(quick, /Unlisted properties allow safe local styling/);
  assert.match(quick, /Unknown components\/Flex availability stay unverified/);
  assert.match(quick, /unlisted\/unknown\/conditional warnings in review, approval and final report/);
  assert.match(capabilities, /does \*\*not\*\* describe site-wide themes/);
  assert.match(capabilities, /not a styling prohibition/);
  assert.match(capabilities, /Design-panel availability, not exclusive ownership/);
  assert.match(capabilities, /not guaranteed to populate native controls/);
  assert.match(capabilities, /not CSS declaration names/);
  assert.match(reference, /`studioComponent`/);
  assert.match(reference, /`studioFlex`/);
  assert.match(policy, /recommendation, not a VS Code prohibition/);
  assert.match(policy, /Parser semantics and browser support remain independent of Design-panel membership/);
});

test('conditional inline example validates native Image properties without a synthetic class requirement', () => {
  assert.match(skill, /inline contract\/example.*read before inline edits/);
  assert.match(quick, /Optional `location`: `stylesheet` \(default\) or `inline`/);
  const request = referenceRequests.find((example) => example.styles.some((style) => style.location === 'inline'));
  assert.ok(request, 'Keep the inline example in the deep reference, not the normal quick start.');
  assert.equal(request.components[0].className, undefined);
  assert.equal(request.styles[0].owner, 'custom');
  assert.equal(request.styles[0].studioComponent, 'Image');
  assert.equal(request.styles[0].scope, 'page');
  assert.match(request.styles[0].inlineTarget, /^<img .*style="border-radius: 8px;">$/);
  assert.deepEqual(request.styles[0].declarations, {
    'border-radius': '50%',
    'box-shadow': '0 12px 32px #00000033',
    'border-width': '1px',
    'border-style': 'solid',
    'border-color': '#ffffff',
  });
  assert.match(reference, /Circle-1\.png.*Circle-2\.png.*Circle-3\.png/);
  assert.match(reference, /one placeholder image.*not an inspected user page/);
  assert.match(reference, /Inline-only components may omit `className`; component-scoped stylesheet groups still require/);
  assert.match(reference, /the class must identify that actual tag/);
});

test('general inline CSS retains exact source edits, composition and conservative shared scope', () => {
  assert.match(reference, /exactly one existing static opening tag/);
  assert.match(reference, /maximum 8,000 characters/);
  assert.match(reference, /Static opening tags and CSS values may span lines/);
  assert.match(reference, /match whitespace and CRLF\/LF exactly, including newlines inside quoted style values/);
  assert.match(reference, /No Liquid in the target tag/);
  assert.match(reference, /Adding a quoted `style` attribute is permitted/);
  assert.match(reference, /Page Copy edits require `scope: "page"`.*exact selected locale/);
  assert.match(reference, /shared-template edits require `scope: "site"`.*every page/);
  assert.match(reference, /no nonempty `part`.*omit `targetId`, `fileName`, `parentPageId`, `handoffReason` and `studioAction`/);
  assert.match(reference, /same general CSS `declarations` syntax/);
  assert.match(reference, /same tag must not overlap properties/);
  assert.match(reference, /original exact tag/);
  assert.match(reference, /`kind: "markup"`.*reconstructed\/validated/);
  assert.match(reference, /class-only writes retain `kind: "class"`/);
  assert.match(reference, /Parse\/encode quoted fonts, HTML entities, CSS comments and escapes safely/);
  assert.match(reference, /raw style attribute is decoded\/encoded with the entities codec/);
  assert.match(reference, /Only that attribute may normalize entity spelling/);
  assert.match(reference, /rest of the tag\/document is preserved exactly/);
  assert.match(reference, /real rendered tags, including `input`, `textarea` and SVG, not a fixed div\/section\/img list/);
  assert.match(reference, /Only class\/style attributes change; embedded contents are never entered/);
  assert.match(reference, /Outer local iframe\/embedded elements may be styled under the same source guards/);
  assert.match(reference, /source tokenizer skips `iframe`\/`noembed`\/`noframes`\/`xmp` contents like `textarea`\/`script`\/`style` contents/);
  assert.match(reference, /tag-shaped text inside them is not a local DOM target/);
  assert.match(reference, /Runtime-discovery exclusions remain unchanged/);
  assert.match(reference, /Ambiguous\/malformed\/injected styles/);
  assert.match(reference, /conflicting related `!important` shorthand\/longhand rules/);
  assert.match(reference, /same requested property.*without a new priority justification/);
  assert.match(reference, /Authored priority changes require `importantReason` and expanded review/);
  assert.match(quick, /inline-only\/stylesheet-only\/inline\+CSS.*at most one \*\*existing\*\* stylesheet/);
  assert.match(policy, /do not emit ineffective CSS, blindly escalate priority\/specificity, rewrite the DOM or replace native components/);
  assert.match(policy, /theme\.css < custom < portalbasictheme\.css/);
  assert.match(reference, /directly addressable component roots and root states.*blocks stylesheet values/);
  assert.match(reference, /Exact already-equal inline values are permitted/);
  assert.match(reference, /Descendant\/generated targets still require explicit source\/cascade review/);
  assert.match(reference, /not a complete cascade analysis/);
});

test('repeated-wrapper guidance applies to general CSS without weakening source or Studio guards', () => {
  assert.match(skill, /read before inline edits or repeated tags/);
  assert.match(reference, /missing custom hook alone is not a blocker/);
  assert.match(reference, /`inlineContext`/);
  assert.match(reference, /before \+ match\/inlineTarget \+ after/);
  assert.match(reference, /16,000 characters/);
  assert.match(reference, /same original context on every group/);
  assert.match(reference, /No global occurrence numbers.*first-match fallback/);
  assert.match(reference, /context is hash-bound.*both preflights/);
  assert.match(reference, /not a gradient-specific exception/);
  assert.match(reference, /endpoints alone do not prove contrast/);
  assert.match(reference, /show its warning and continue with safe local authoring/);
  const example = referenceRequests.find((request) => request.title === 'Feature column surfaces');
  assert.equal(validateRequest(example), example);
  assert.equal(example.classEdits.length, 3);
  assert.equal(new Set(example.classEdits.map((edit) => edit.match)).size, 1);
  assert.equal(new Set(example.classEdits.map((edit) => edit.context.after)).size, 3);
  assert.equal(new Set(example.classEdits.map((edit) => edit.className)).size, 1);
});

test('all deep JSON examples are complete requests covering raw responsive and global stylesheets', () => {
  assert.ok(referenceRequests.length >= 5, 'Retain source examples and add full responsive/global requests.');
  for (const request of referenceRequests) {
    assert.doesNotThrow(() => validateRequest(request), request.title);
  }
  const removal = referenceRequests.find((request) => request.title === 'Responsive image sizing');
  assert.ok(removal);
  assert.match(removal.styles[0].inlineTarget, /\n\s+style="[^"]*\n/);
  const responsive = referenceRequests.find((request) => request.title === 'Responsive feature cards');
  assert.ok(responsive);
  const style = responsive.styles[0];
  assert.equal(style.owner, 'custom');
  assert.equal(style.scope, 'page');
  assert.equal(style.part, undefined);
  assert.equal(style.declarations, undefined);
  assert.ok(responsive.components[0].sourcePath);
  assert.equal(responsive.components[0].className, 'pp-motion-grid');
  for (const syntax of ['--pp-card-gap', 'clamp(', '@media', '@supports', '@container',
    '@keyframes pp-card-enter', 'prefers-reduced-motion', 'animation: none']) {
    assert.ok(style.css.includes(syntax), syntax);
  }
  const global = referenceRequests.find((request) => request.title === 'Global brand theme');
  assert.ok(global);
  assert.equal(global.components[0].kind, 'site-theme');
  assert.equal(global.components[0].sourcePath, undefined);
  assert.equal(global.components[0].className, undefined);
  assert.equal(global.styles[0].global, true);
  assert.equal(global.styles[0].scope, 'site');
  assert.equal(global.styles[0].fileName, 'brand-theme.css');
  assert.deepEqual(global.styles[0].externalResources, ['https://styles.example.com/brand.css']);
  assert.match(global.styles[0].css, /^@import url\("https:\/\/styles\.example\.com\/brand\.css"\);/);
  assert.match(global.styles[0].css, /@font-face.*url\("\/fonts\/example\.woff2"\)/s);
  assert.match(global.styles[0].css, /@property --pp-accent/);
  assert.match(global.styles[0].css, /@layer pp-site-theme/);
  assert.match(reference, /source-free descriptor is allowed \*\*only\*\* for explicit global stylesheets or user-requested Studio handoffs/);
  assert.match(reference, /all matching elements/);
});

test('general CSS declarations and stable selector parts are not fixed property or gradient enums', () => {
  const request = JSON.parse(quick.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1]);
  request.styles[0].part = ' > .card[data-state="ready"]::before';
  request.styles[0].declarations = {
    '--pp-gap': 'clamp(1rem, 2vw, 2rem)',
    'font-family': '"Example Sans", system-ui, sans-serif',
    margin: '-0.5rem auto',
    width: 'min(100%, calc(100vw - 2rem))',
    'box-shadow': '0 1px 3px #0003, 0 4px 16px #0002',
    transform: 'translateX(1rem) rotate(3deg)',
    transition: 'transform 200ms ease, opacity 150ms linear',
    'background-image': 'repeating-conic-gradient(from 45deg, #fff 0deg 15deg, #285b70 15deg 30deg)',
  };
  assert.doesNotThrow(() => validateRequest(request));
  assert.match(reference, /not a skill-specific property\/value\/enum allowlist/);
  assert.match(reference, /Arbitrary stable descendant\/state\/pseudo-element parts are allowed/);
  assert.match(reference, /Linear, radial, conic and repeating gradients, multiple background layers/);
  assert.match(reference, /Parser grammar support is not proof of Power Pages, browser or Studio rendering/);
  assert.match(reference, /semantic-grammar-unverified values produce explicit warnings/);
  assert.match(reference, /Fix actual invalid values.*verify newer browser support before approving/);
  assert.match(reference, /Do not bypass parser errors or equate missing parser grammar with unsupported Power Pages CSS/);
  assert.match(reference, /Malformed\/injected syntax and legacy executable CSS fail/);
  assert.match(reference, /authored\/insertion order, not alphabetical order/);
  assert.match(reference, /Shorthand-effects protection uses pinned \*\*mdn-data\*\*, with logical-side safety/);
  assert.doesNotMatch(skill + quick + reference + policy, /style-site-gradients\.js|2–8 color stops|No standalone interpolation hints|bounded gradient grammar|These are the only accepted stylesheet suffixes/);
});

test('resource, namespace and justified-priority contracts preserve explicit review without fetching', () => {
  assert.match(reference, /`css` \| Alternative full stylesheet string.*no `part` or `declarations`/);
  assert.match(reference, /Namespace new keyframe\/font\/property\/layer identifiers with `pp-`\/`--pp-`/);
  assert.match(reference, /Declare exact external HTTPS CSS URL references in `externalResources`/);
  assert.match(reference, /relative, root-relative and fragment Web File URLs need no external declaration/);
  assert.match(reference, /No protocol-relative URLs, JavaScript\/file schemes, unreviewed external tracking\/font\/image URLs or embedded data payloads/);
  assert.match(reference, /CSP requirements, availability, licensing and privacy/);
  assert.match(reference, /exact external URLs and warnings are hash-bound/);
  assert.match(reference, /compiler performs no runtime fetch/);
  assert.match(reference, /browser\/network access is not a prerequisite/);
  assert.match(reference, /Imported CSS requires `global: true`.*beginning-of-stylesheet `@import` placement/);
  assert.match(reference, /Do not automatically fetch imports/);
  assert.match(reference, /`importantReason` is optional nonempty text.*expanded diff review/);
  assert.match(reference, /Raw CSS and a reason cannot bypass root inline conflicts/);
  assert.match(catalog, /Every raw `style.css` requires expanded review/);
  assert.match(catalog, /`global: true`, nonempty `externalResources` or `importantReason`/);
});

test('layer support warns about unlayered default priority without banning layers', () => {
  for (const content of [reference, policy]) {
    assert.match(content, /within the same author origin, unlayered normal Power Pages default\/theme CSS outranks normal `@layer` rules regardless of selector specificity or stylesheet order/);
    assert.match(content, /Do not blindly put default overrides into new layers; honor the actual layer\/unlayered architecture/);
    assert.match(content, /`@layer` remains supported/);
  }
  assert.match(reference, /wrapper illustrates supported syntax, not a default-override recipe/);
  assert.match(reference, /If unlayered defaults win, keep the needed overrides unlayered at the approved custom placement and review the full cascade/);
});

test('every raw stylesheet or declared resource expands review while broad declarations may stay small', () => {
  assert.match(reference, /Every `style.css` request takes expanded review/);
  assert.match(reference, /including scoped raw CSS, for selectors\/conditions\/global definitions/);
  assert.match(reference, /small-change route allows ordinary broad `declarations`/);
  assert.match(quick, /Any raw `css`.*nonempty `externalResources`\/`importantReason`.*\*\*expanded\*\* review/);
  assert.match(skill, /raw CSS\/resources\/global\/priority work needs expanded review/);
  assert.match(policy, /Every raw `style.css` takes expanded review/);
  assert.match(policy, /Ordinary broad declarations remain eligible for the small-change route/);
});

test('bundled parser documentation separates maintainer builds from runtime installs', () => {
  const guide = fs.readFileSync(path.join(pluginRoot, 'PLUGIN_DEVELOPMENT_GUIDE.md'), 'utf8');
  assert.match(guide, /scripts\/vendor\/css-tools/);
  for (const file of ['package.json', 'package-lock.json', 'css-tools.cjs']) {
    assert.ok(guide.includes(file), file);
    assert.ok(fs.existsSync(path.join(pluginRoot, 'scripts', 'vendor', 'css-tools', file)), file);
  }
  assert.match(guide, /Set-Location plugins\\power-pages\\scripts\\vendor\\css-tools\r?\nnpm ci --ignore-scripts\r?\nnpm run build/);
  assert.match(guide, /Users need \*\*no npm installs\*\* in their plugin or site/);
  assert.match(guide, /bundled licenses/);
  assert.match(guide, /including the mdn-data license/);
  assert.match(quick, /bundled css-tree.*no npm installs/);
});

test('Studio handoffs require explicit instructions-only intent rather than native capability', () => {
  const request = JSON.parse(quick.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1]);
  request.styles[0].owner = 'studio';
  request.styles[0].studioAction = 'In the requested Studio instructions, set the selected component padding to 1rem.';
  assert.throws(() => validateRequest(request), /handoffReason|user-requested/);
  request.styles[0].handoffReason = 'no-safe-local-target';
  assert.throws(() => validateRequest(request), /handoffReason|user-requested/);
  request.styles[0].handoffReason = 'user-requested';
  assert.doesNotThrow(() => validateRequest(request));
  delete request.styles[0].owner;
  assert.throws(() => validateRequest(request));
  assert.match(reference, /`owner` \| \*\*Required\*\*/);
  assert.match(quick, /`owner: "studio"` requires `handoffReason: "user-requested"` plus `studioAction`/);
  assert.match(quick, /native support alone is not a reason/);
  assert.match(reference, /Plans remain \*\*schemaVersion 2\*\*/);
  assert.match(reference, /Old zero-write Studio requests missing `handoffReason: "user-requested"`.*regeneration/);
  assert.match(reference, /Never edit a legacy plan or carry its old approval forward/);
  assert.match(policy, /Explicitly requested Studio instructions-only can be a complete outcome/);
  assert.match(quick, /local work is \*\*blocked\*\* with a specific local next step, not handoff success/);
});

test('installed guidance removes native-property prohibitions without removing source protection', () => {
  const referenceFiles = fs.readdirSync(path.join(skillRoot, 'references'))
    .filter((file) => file.endsWith('.md')).map((file) => path.join(skillRoot, 'references', file));
  const documents = [skillPath, ...referenceFiles,
    ...['AGENTS.md', 'PLUGIN_DEVELOPMENT_GUIDE.md', 'README.md'].map((file) => path.join(pluginRoot, file))];
  const retiredInstructions = [
    'Preserve Studio ownership of supported theme/component properties',
    'Listed native controls retain Studio handoffs',
    'Preserve the existing Studio ownership/handoff policy',
    'Native Studio typography/colors require Studio handoffs',
    'otherwise use a Studio-owned handoff instead',
    'Keeps supported theme/component properties in Design Studio',
    'If all requested properties are confirmed Studio-owned',
    'Resolve failures and Studio prerequisites before approval',
    'Resolve known failures and Studio prerequisites before approval',
    'Studio-first ownership',
    'preview reset/export controls',
    'style-site-gradients.js',
    '2–8 color stops',
    'bounded gradient grammar',
    'same bounded `declarations` grammar',
    'Request declaration values cannot include `!important`',
    'The request schema permits references to existing tokens in color values, not new custom-property definitions',
    'Supported tag names are `div`, `section`',
    'single-line static',
    'on one line',
  ];
  for (const file of documents) {
    const content = fs.readFileSync(file, 'utf8');
    for (const retired of retiredInstructions) {
      assert.ok(!content.includes(retired), `${file} still directs: ${retired}`);
    }
  }
  assert.match(policy, /Never replace, deactivate, delete, or reorder/);
  assert.match(policy, /Unknown orders block preparation/);
  assert.match(policy, /Do not remove ownership markers, overwrite generated output, or install a new toolchain/);
  assert.match(reference, /leading HTML comment banner containing `generated file` or `do not edit` also blocks markup updates/);
  assert.match(reference, /local-source-pipeline change instead; do not remove the banner/);
  assert.match(policy, /Preserve Bootstrap containers, accessibility semantics, Studio editing attributes, Liquid expressions/);
});

test('visual changes require paired resolved colors without importing the SPA redesign workflow', () => {
  const design = fs.readFileSync(path.join(skillRoot, 'references', 'design-quality.md'), 'utf8');
  assert.match(skill, /new treatments, palette\/background, typography or redesign/);
  assert.match(skill, /Resolve failures and local declaration dependencies before approval/);
  assert.match(design, /create-site\/references\/design-aesthetics\.md/);
  assert.match(design, /does not override a child's explicit dark color/);
  assert.match(design, /do not execute that SPA workflow/);
  assert.match(design, /theme\.css rewrite/);
  assert.match(design, /4\.5:1/);
  assert.match(design, /18\.667 CSS px/);
  assert.match(design, /required-before-approval/);
  assert.match(design, /check-style-contrast\.js/);
  assert.match(design, /supplied-color-pair-only/);
  assert.match(design, /not a cascade check/);
  assert.match(design, /Never count a not-yet-performed Studio text-color change/);
  assert.match(design, /Native Studio typography\/colors do not require handoffs/);
  assert.match(design, /there is no native-color Studio prerequisite/);
  assert.match(design, /No HTML generation or browser review is required/);
  assert.match(reference, /" h2".*" h3"/);
});
