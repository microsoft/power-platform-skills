'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
const media = read('shared/references/media-sources.md');

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
  assert.match(design, /one-time input choice/);
  assert.match(design, /Read only matching extractors and security policies/);
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

test('brand intake distinguishes unanswered input from permission to infer before design generation', () => {
  const inputs = read('skills/design-system/references/input-modes.md');
  const phase = read('skills/create-mobile-app/references/phase-04-design.md');
  const rules = [
    [/Supplied design material or explicit app-brand\/named-direction request/, /without the generic input question/],
    [/Explicit "Let AI choose", "you decide", or decline/, /without another question/],
    [/Existing accepted design, including legacy artifacts/, /Preserve it on resume\/edit/],
    [/No input decision, or only model-inferred draft values/, /before materialization/],
    [/Cancel, no response, or unavailable question tool/, /pending and stop before design generation/],
  ];
  const rows = inputs.split('\n').filter(line => line.startsWith('| '));
  for (const [evidence, behavior] of rules) {
    const row = rows.find(line => evidence.test(line));
    assert.ok(row, `missing input decision case: ${evidence}`);
    assert.match(row, behavior);
  }
  assert.match(design, /Before generating tokens or preview HTML/);
  assert.match(design, /a draft alone does not answer Step 2/);
  assert.match(inputs, /A child returns `NEEDS_CONTEXT: brand input choice/);
  assert.match(inputs, /--no-discovery` does not answer the brand question/);
  assert.match(inputs, /--no-design` skips this entire phase/);
  assert.match(inputs, /choose references without supplying any[\s\S]*keep that choice pending/);
  assert.match(phase, /in foreground before design generation/);
  assert.ok(phase.indexOf('one-time brand input choice') < phase.indexOf('Then invoke `/design-system'));
  assert.match(phase, /No second picker inside the child/);
  assert.doesNotMatch(design, /No-brand creation needs no question|No brand input means infer/);
});

test('brand references accept existing materials and combine them by intent, not format', () => {
  const inputs = read('skills/design-system/references/input-modes.md');
  const inputRows = inputs.split('\n').filter(line => line.startsWith('| '))
    .map(line => line.split('|')[1].replace(/`/g, '').trim());
  for (const input of [
    'Pasted design notes, Markdown', '--brand-doc <path>', '--logo <path>',
    'Screenshot / reference image / attached logo', '--from-url <url>',
    '--stylesheet <path>', 'Token file (`.json` / `.ts`)', '--design-spec <path>',
    '--from-figma <file-key>',
  ]) assert.ok(inputRows.some(row => row.startsWith(input.replace(/`/g, ''))), `missing input form: ${input}`);
  assert.match(inputs, /flags are shortcuts, not prerequisites/);
  assert.match(inputs, /Accept combinations without requiring reformatting/);
  assert.match(inputs, /requirements outrank inspiration and inference/);
  assert.match(inputs, /source authority and stated intent, not file format/);
  assert.match(inputs, /inaccessible Figma reference[\s\S]*request an accessible export/);
  assert.match(inputs, /Never alter the original attachment/);
  assert.match(inputs, /Strip EXIF only from an approved output copy, never the original/);
  assert.match(inputs, /Reject traversal or symlinks escaping the approved input scope/);
  assert.match(inputs, /No scripts or live site execution/);
});

test('named brands require contextual interpretation and source-backed proposals', () => {
  const inputs = read('skills/design-system/references/input-modes.md');
  assert.match(inputs, /A brand appearing only in products, suppliers or examples is not automatically the app's identity/);
  assert.match(inputs, /If ambiguous, ask one focused clarification before adopting it/);
  assert.match(inputs, /official public brand\/site references/);
  assert.match(inputs, /Never fabricate a URL, official hex value or font from a name/);
  assert.match(inputs, /Label sampled\/inferred values/);
  assert.match(inputs, /without transferring its branding,\s+product claims, reviews, integrations or actions/);
  assert.match(inputs, /No second palette-only approval or brand-name lookup table/);
});

test('brand choice survives resume and remains separate from visual approval and native handoff', () => {
  const inputs = read('skills/design-system/references/input-modes.md');
  const phase = read('skills/create-mobile-app/references/phase-04-design.md');
  const schema = read('skills/design-system/references/design-system-schema.md');
  assert.match(read('shared/memory-bank.md'), /\| Brand input \|.*pending until answered/);
  assert.match(inputs, /Persist the actual choice promptly/);
  assert.match(inputs, /`Pending decision` for missing input; do not mark design approval/);
  assert.match(inputs, /Never create a bank or separate intake artifact solely for this/);
  assert.match(inputs, /On resume, reuse that evidence/);
  assert.match(schema, /Brand input: supplied references or explicit AI-inference choice/);
  assert.match(schema, /input choice is not design approval/);
  assert.match(phase, /brand-input choice and safe source references/);
  assert.match(inputs, /preview\/design review for confirmation, then the same tokens\/specs into native implementation/);
  assert.match(phase, /do not approve one experience and then independently redesign it during native generation/);
});

test('owned design and preview references remain reachable inside the installed plugin', () => {
  const files = [
    ...markdownFiles(path.join(pluginRoot, 'skills/design-system')),
    ...markdownFiles(path.join(pluginRoot, 'skills/preview-screens')),
    ...['design-planning', 'tamagui-html-mapping', 'color-palette-architecture', 'typography-and-tone', 'media-sources']
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
  assert.match(preview, /390 x 844 CSS px as the usable app viewport default/);
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
  assert.match(preview, /place decorative bezels outside that area/);
  assert.match(preview, /Compare references\s+at the same usable width/);
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

test('design references transfer composition without importing business behavior', () => {
  const planning = read('shared/references/design-planning.md');
  assert.match(design, /design-planning\.md#entry-composition-and-reference-transfer/);
  assert.match(planning, /Adopt \/ Adapt \/ Exclude/);
  assert.match(planning, /visual reference does not authorize new business behavior/);
  assert.match(planning, /without executing imported scripts/);
  assert.match(planning, /Layout deltas; standalone designs record it under Components/);
  assert.match(planning, /"Clean\/simple" means low cognitive load/);
  assert.match(planning, /return the delta to foreground rather than\s+silently changing it/);
});

test('pre-approval layout proposals do not override fixed behavior or explicit brand decisions', () => {
  const planning = read('shared/references/design-planning.md');
  const phase = read('skills/create-mobile-app/references/phase-04-design.md');
  const receipt = read('skills/create-mobile-app/references/approval-receipt.md');
  assert.match(planning, /\*\*Fixed:\*\* approved data, operations, authorization/);
  assert.match(planning, /explicit user brand\/presentation decisions/);
  assert.match(planning, /\*\*Provisional until visual approval:\*\*/);
  assert.match(planning, /Early structural\/spec approval does not freeze these suggestions/);
  assert.match(planning, /revise them within fixed constraints without reopening business\s+approvals/);
  assert.match(planning, /accepted presentation is the implementation reference, not the\s+earliest planner suggestion/);
  assert.match(planning, /Children still do not edit the plan or approve themselves/);
  assert.match(intent, /Missing content order alone does not require `NEEDS_CONTEXT`/);
  assert.match(intent, /Conflicts with fixed requirements do require foreground resolution/);
  assert.doesNotMatch(intent, /Missing content order or a\s+conflict with locked input returns/);
  assert.match(design, /Refine provisional presentation/);
  assert.match(phase, /designer may improve them within approved behavior and explicit brand constraints/);
  assert.match(phase, /existing design review may explicitly accept that presentation\/spec delta/);
  assert.match(receipt, /Leave the authoritative plan and receipt unchanged while\s+authoring those proposals/);
  assert.match(receipt, /invalidate its old plan-byte binding/);
  assert.match(receipt, /Preserve all\s+unaffected approval timestamps and contract\/service declarations/);
});

test('intent state fidelity distinguishes illustrative selection from normal first entry', () => {
  assert.match(intent, /initial state to \*\*Preview selection\*\*/);
  assert.match(intent, /scope\/filter,\s+selected record, data state and outcome stage/);
  assert.match(intent, /Reset restores those exact values, not merely the route/);
  assert.match(intent, /separately exercise the app's first-entry\s+scope from Data\/Navigation/);
  assert.match(intent, /Do not switch to All or add records/);
  assert.match(intent, /every offered filter and search with an expected match and no-match result/);
  assert.match(intent, /loaded-page count must not\s+be presented as a whole-dataset count/);
});

test('image media permits verified HTTPS sources without granting executable or data access', () => {
  assert.match(media, /Remote image media is not remote executable\s+code/);
  for (const use of ['HTML intent preview', 'Source-derived implementation preview',
    'React Native image display', 'Sample data in an approved image-URL/Text column',
    'Dataverse Image/File column']) {
    assert.ok(media.includes(`| ${use} |`), `missing image-source use: ${use}`);
  }
  assert.match(preview, /local illustrative assets or verified, appropriately licensed public HTTPS image URLs/);
  assert.match(intent, /local assets or verified licensed HTTPS imagery/);
  assert.match(mapping, /local or verified public HTTPS imagery/);
  assert.match(media, /do not\s+authorize CDN JavaScript, remote executable HTML, analytics\/tracking, remote fonts, live tenant\s+calls, business API calls or production writes/);
  assert.match(preview, /Compare observed requests with declared image sources\/validated redirects/);
  assert.doesNotMatch(intent, /no external resources\/network calls/);
  assert.match(media, /Source-derived previews must not fabricate missing source handlers or media fallbacks/);
});

test('remote imagery requires provenance, bounded verification and stable failure states', () => {
  assert.match(media, /license\/permission covering\s+the intended use, attribution and remote embedding/);
  assert.match(media, /working URL does not prove licensing/);
  assert.match(media, /validate public destinations and redirects/);
  assert.match(media, /time\/size limits, and verify an image response and successful decode/);
  assert.match(media, /not merely a URL suffix\s+or successful HEAD request/);
  assert.match(media, /No credentials, authorization headers, signed access tokens, personal\/tenant data or tracking/);
  assert.match(media, /referrerpolicy="no-referrer"/);
  assert.match(media, /do not inline fetched SVG\/HTML or execute imported content/);
  assert.match(media, /one failed image must not erase usable records or block an unrelated action/);
  assert.match(media, /Local downloading\/caching is optional for online display/);
  assert.match(media, /offline support,\s+self-contained delivery, reproducibility or an explicit user requirement/);
  assert.match(media, /Honor network opt-out/);
  assert.match(media, /Never claim that an\s+unchecked source was verified/);
  assert.match(read('skills/design-system/references/design-system-schema.md'),
    /Remote media: URL, license\/permission evidence, attribution and verification result/);
});

test('native and sample-media paths distinguish URL fields from binary storage', () => {
  const seeding = read('skills/add-sample-data/SKILL.md');
  const reads = read('agents/references/screen-builder/data-reads.md');
  const catalogue = read('shared/references/screen-templates/catalogue-and-archetypes.md');
  const shared = read('shared/shared-instructions.md');
  assert.match(shared, /Rendering public HTTPS images with an image component is allowed/);
  assert.match(reads, /not a connector-first violation/);
  assert.match(catalogue, /Local assets and verified licensed public HTTPS images, including CDNs, are both supported/);
  assert.match(catalogue, /Always use `expo-image`.*remote images/);
  assert.match(media, /Store image\/file bytes, not a URL string/);
  assert.match(media, /Do not change approved schema just to accommodate an illustrative preview image/);
  assert.match(seeding, /image-URL\/Text field, store the verified URL directly; no download\/upload is\s+required/);
  assert.match(seeding, /remote-sourced Image\/File media, download and validate bytes/);
  assert.match(seeding, /Never set a File\/Image column to a CDN URL\. Store a URL only in an approved URL\/Text column/);
  assert.match(reads, /Dataverse Image\/File columns hold bytes, never that URL/);
});

test('connector guard allows remote image component sources but still blocks direct service bypasses', () => {
  // Supply a Write payload for a hypothetical app outside the plugin; no file or network is used.
  const filePath = path.join(pluginRoot, '..', 'media-contract-fixture', 'app', 'image.tsx');
  const check = content => spawnSync(process.execPath, [
    path.join(pluginRoot, 'hooks/validate-connector-first.js'),
  ], {
    cwd: pluginRoot,
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_ROOT: pluginRoot },
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content },
    }),
  });
  const image = check(`import { Image } from 'expo-image';
    export const Cover = () => <Image source={{ uri: 'https://images.example.com/cover.webp' }} />;`);
  assert.equal(image.status, 0, image.stderr);
  for (const source of [
    `fetch("https://graph.microsoft.com/v1.0/me")`,
    `fetch("https://contoso.crm.dynamics.com/api/data/v9.2/accounts")`,
    `import axios from 'axios';`,
  ]) {
    const forbidden = check(source);
    assert.equal(forbidden.status, 2, forbidden.stderr);
    assert.match(forbidden.stderr, /connector-first rule violated/);
  }
});

test('rendered experience evidence is required without making decoration a quality gate', () => {
  const review = intent.split('## Rendered experience review\n')[1]
    ?.split('\n## Approval and implementation handoff')[0];
  assert.ok(review);
  for (const check of ['Context', 'Hierarchy', 'Decision/read evidence',
    'Media proportions (when relevant)', 'Usable first viewport', 'Action placement', 'State fidelity']) {
    assert.ok(review.includes(`| ${check} |`), `missing observed experience check: ${check}`);
  }
  assert.match(preview, /Experience evidence \(intent\)/);
  assert.match(review, /every selected screen, not just Home/);
  assert.match(review, /actual screenshots\s+alongside normal browser interaction/);
  assert.match(review, /320px\s+reflow and every offered theme/);
  assert.match(review, /No fixed hero, image, palette, card\s+count, density or screenshot-similarity target/);
  assert.match(review, /Genuine empty\/error scenarios pass/);
  assert.match(review, /Screen\/state \| viewport\/theme \| observed/);
  assert.match(review, /pass\/fail\/unverified \+ reason \| repair\/recheck/);
  assert.match(review, /not "looks polished"/);
  assert.match(review, /Do not create a score file/);
  assert.match(preview, /forced clicks or injected handler calls are not\s+evidence of reachability/);
});

test('rendered review distinguishes subject, container, bezel and chrome without fixed ratios', () => {
  const review = intent.split('## Rendered experience review\n')[1];
  assert.match(review, /Measure the \*\*visible subject\*\*, media container, usable app width\/height and scrolling viewport/);
  assert.match(review, /SVG viewBox includes transparent\/internal whitespace/);
  assert.match(review, /CSS\s+dimensions do not establish the subject's prominence/);
  assert.match(review, /explicitly labeled estimate if the visible bounds cannot be measured precisely/);
  assert.match(review, /compare designs at the same usable\s+width/);
  assert.match(review, /height relative to the scrolling viewport\s+and which task content it displaces/);
  assert.match(review, /shorten, remove or retain it based on\s+the job, not a universal percentage/);
  assert.match(review, /More records,\s+larger containers or an added hero are not evidence of better design/);
  assert.match(review, /do not invent metadata to make it appear richer/);
  assert.match(review, /subject\/container proportions when media matters/);
  const builder = read('agents/references/screen-builder/design-api.md');
  assert.match(builder, /visible\s+media-subject scale/);
  assert.match(builder, /not a superseded provisional planner suggestion/);
});

test('experience repairs are bounded and cannot fabricate validation or approval', () => {
  assert.match(intent, /one focused repair pass/);
  assert.match(intent, /rerun the affected\s+visual and interaction checks/);
  assert.match(intent, /known failure remaining after the\s+repair returns `BLOCKED: intent experience review failed`/);
  assert.match(intent, /change returns `NEEDS_CONTEXT` for foreground approval/);
  assert.match(intent, /opening was declined.*unverified and return `DONE_WITH_CONCERNS`/);
  assert.match(intent, /No repair is required after\s+a clean review/);
  assert.match(intent, /cannot guarantee aesthetic preference or native runtime behavior/);
  assert.match(preview, /For implementation report source shortcomings rather than improving the preview/);
  assert.match(design, /Passing markup\/interaction tests alone is not visual approval/);
  const handoff = read('skills/create-mobile-app/references/phase-04-design.md');
  assert.match(handoff, /per-screen rendered experience evidence/);
  assert.match(handoff, /known unresolved review\s+failure blocks progression/);
  assert.match(handoff, /accepted first-viewport content order and below-fold access in Layout delta/);
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
  assert.doesNotMatch(intent, /\bgym\b|\bequipment\b|\bwarrant(?:y|ies)\b|\brepair (?:shop|order|ticket)s?\b/i);
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
