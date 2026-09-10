'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const planner = read('agents/screen-planner.md');
const contract = read('shared/references/screen-planning/spec-contract.md');
const discovery = read('skills/create-mobile-app/references/requirements-discovery.md');
const planningDocuments = [
  'agents/screen-planner.md',
  'shared/references/screen-planning/spec-contract.md',
  'shared/references/screen-planning/navigation-contracts.md',
  'shared/references/screen-planning/journey-examples.md',
  'shared/references/screen-templates.md',
  'shared/references/screen-templates/catalogue-and-archetypes.md',
  'shared/references/universal-patterns.md',
  'shared/references/universal-patterns/recipes.md',
  'shared/references/mobile-design-philosophy.md',
  'skills/create-mobile-app/references/requirements-discovery.md',
];

// Authored fragments exercise the documented join/route/outcome contracts.
// They are not model-output benchmarks or evidence of generated app behavior.
const cases = [
  { name: 'shopping', actor: 'Shopper', home: 'shop', preview: 'basket',
    outcome: /OrdersService\.create.*persisted order ID/,
    recovery: /Retain basket/, supporting: /Categories, images, stock projections, and order lines/,
    behavior: /local draft until Place order/ },
  { name: 'learning', actor: 'Learner', home: 'learn', preview: 'practice',
    outcome: /Answer retained.*ProgressService\.update/,
    recovery: /Retain selected answer/, supporting: /Lesson sections, answer options, and progress records/,
    behavior: /retry only that operation, not an already saved answer/ },
  { name: 'expense-approval', actor: 'Approver', home: 'expense-queue', preview: 'expense-review',
    outcome: /ClaimDecisionsService\.create.*atomically/,
    recovery: /Retain reason/, supporting: /Receipts, policy limits and decision events/,
    behavior: /direct-entry fallback/ },
  { name: 'inspection', actor: 'Inspector', home: 'assigned-checks', preview: 'checklist',
    outcome: /required evidence retained.*InspectionsService\.update/,
    recovery: /Keep local capture/, supporting: /Sites, checklist definitions, responses and attachments/,
    behavior: /uploadFailed offers retry/ },
];

function table(document, heading) {
  const marker = `### ${heading}\n`;
  const start = document.indexOf(marker);
  assert.notEqual(start, -1, `missing ${heading}`);
  const section = document.slice(start + marker.length).split(/\n#{1,3} /)[0];
  const rows = section.split(/\r?\n/).filter(line => line.startsWith('|'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  assert.ok(rows.length >= 2, `${heading} needs a table`);
  const [headers, separator, ...body] = rows;
  assert.ok(separator.every(cell => /^:?-+:?$/.test(cell)), `${heading} separator`);
  return body.map(cells => {
    assert.equal(cells.length, headers.length, `${heading} column count`);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
}

function validateFragment(document) {
  const screens = table(document, 'Screen Map');
  const byId = new Map(screens.map(screen => [screen.ID, screen]));
  assert.equal(byId.size, screens.length, 'unique stable screen IDs');
  assert.equal(new Set(screens.map(screen => screen.Route)).size, screens.length, 'unique routes');
  assert.equal(new Set(screens.map(screen => screen.File)).size, screens.length, 'unique files');
  for (const screen of screens) {
    assert.match(screen.ID, /^[a-z][a-z0-9-]*$/);
    assert.ok(screen.Rationale.length > 15, 'task-based rationale');
    assert.equal(screen.File.replace(/^app/, '').replace(/\/index\.tsx$/, '').replace(/\.tsx$/, ''),
      screen.Route, 'route matches file');
    assert.ok(!screens.some(other => other.File === screen.File.replace(/\.tsx$/, '/index.tsx')),
      'no flat/folder route collision');
  }
  const journeys = table(document, 'Primary journeys');
  for (const journey of journeys) {
    for (const column of ['Actor', 'Task', 'Entry', 'Decision', 'Action + operation', 'Committed outcome',
      'Next destination', 'Recovery', 'Screen IDs']) assert.ok(journey[column], `journey ${column}`);
    for (const id of journey['Screen IDs'].split(/,\s*/)) {
      assert.ok(byId.has(id), `journey references unknown screen ${id}`);
    }
    assert.ok(byId.has(journey['Next destination']), 'next destination exists');
  }
  for (const preview of table(document, 'Preview selection')) {
    assert.ok(byId.has(preview['Screen ID']), 'preview references existing screen');
    assert.ok(preview.Rationale && preview.State, 'preview has rationale and state');
  }
  const navigation = table(document, 'Navigation Contracts');
  for (const screen of screens) assert.ok(navigation.some(row => row.Route === screen.Route));
  for (const row of navigation) {
    assert.ok(screens.some(screen => screen.Route === row.Route), 'known route');
    assert.match(row.Intent, /^(navigate|push|replace)$/);
    assert.ok(row['Returns to caller'] && row['Source action / outcome']);
    for (const [, param] of row.Route.matchAll(/\[([^\]]+)\]/g)) {
      assert.ok(row['Path params'].includes(`${param}:`), `path param ${param}`);
    }
    for (const sibling of navigation.filter(other => other.Route === row.Route)) {
      assert.equal(row['Query params (UNION across all senders)'],
        sibling['Query params (UNION across all senders)'], 'same destination param union');
    }
  }
  return { screens, journeys, navigation };
}

function validateEntryComposition(document) {
  assert.match(document, /Layout suggestions are provisional until visual approval/,
    'authored fixture must distinguish provisional presentation');
  const source = document.split('### Per-Screen Specs\n')[1];
  assert.ok(source, 'entry composition needs existing screen specs');
  const specs = source.split(/^#### /m).slice(1).map(section => {
    const field = name => section.split(/\r?\n/)
      .find(line => line.startsWith(`- **${name}** — `))
      ?.split(' — ').slice(1).join(' — ');
    const layout = field('Layout delta') || '';
    assert.match(layout, /^First viewport: \S.+; Below fold: \S.+$/,
      'entry composition needs first viewport and below-fold access');
    assert.match(field('Data') || '', /^Initial scope: \S.+/,
      'entry composition needs explicit initial scope');
    return { id: field('Screen ID'), layout, data: field('Data') };
  });
  const home = table(document, 'Screen Map').find(screen => screen.Route === '/(app)/home');
  assert.ok(specs.some(spec => spec.id === home.ID), 'main destination needs entry composition');
  for (const selected of table(document, 'Preview selection')) {
    assert.ok(specs.some(spec => spec.id === selected['Screen ID']),
      'selected preview screen needs entry composition');
  }
  return specs;
}

test('planner selects jobs and outcomes instead of mandatory entity screens or dashboards', () => {
  assert.match(planner, /actor → task → entry → decision → committed outcome → next destination → recovery/);
  assert.match(planner, /Supporting entities.*do not need independent screens/);
  assert.match(planner, /CRUD is appropriate.*actual user task/);
  assert.match(planner, /Repeated structures are valid/);
  assert.match(planner, /no fixed screen-count target/);
  assert.doesNotMatch(planner, /MUST have at least a List \+ Detail|under 8 for v0|only use what the industry mapping recommends/);
  assert.match(contract, /Committed outcome names the persisted\/observable postcondition/);
  assert.match(contract, /read-only work.*useful read\/selection outcome/);
});

test('graph and specs preserve foreground ownership and the existing markdown contract', () => {
  assert.doesNotMatch(planner, /AskUserQuestion|EnterPlanMode|ExitPlanMode|\bTask\b/);
  assert.match(planner, /Specs never writes `_screens_section\.md`/);
  assert.match(planner, /approved graph.*immutable/);
  assert.match(planner, /NEEDS_CONTEXT: graph revision required/);
  assert.match(contract, /\| Screen \| Route \| File \| Presentation \| Purpose \| Data \| Native \| Source \| ID \| Rationale \|/);
  assert.match(contract, /\| Screen ID \| Rationale \| State \|/);
  assert.match(contract, /### Primary journeys/);
  assert.match(contract, /### Preview selection/);
  assert.match(contract, /\| Action \+ operation \| Committed outcome \|/);
  assert.match(contract, /no separate journey\/preview sidecar/);
  assert.match(contract, /Source action \/ outcome/);
  assert.match(contract, /Related entity read contract/);
  assert.match(contract, /`@odata\.bind`/);
  assert.match(contract, /`skipToken` continuation/);
});

test('screen scope is consolidated before approval without fixed caps or hidden route growth', () => {
  const scope = contract.split('#### Screen scope and consolidation\n')[1]?.split('\n### Primary journeys')[0];
  assert.ok(scope, 'graph contract needs a scope review before journey/spec expansion');
  assert.match(scope, /smallest coherent screen set that preserves every approved job/);
  assert.match(scope, /never a target derived from tables, roles, or features/);
  assert.match(scope, /do not remove necessary work to meet an arbitrary cap/);
  assert.match(scope, /Parameterize detail routes by ID/);
  assert.match(scope, /Screen Map Rationale/);
  assert.match(scope, /long\/resumable task, direct-link requirements, separate permissions\/context/);
  assert.match(scope, /overloaded mega-screen/);
  assert.match(scope, /Every journey still has its entry, action, outcome/);
  assert.match(scope, /unique business routes \(including routed modals\/sheets\)/);
  assert.match(scope, /Count each route once/);
  assert.match(scope, /Unrouted overlays belong in their host's spec/);
  assert.match(scope, /preview screens are representative views, not the application's route budget/);
  assert.match(planner, /scope\/consolidation review[\s\S]*before graph approval/);
  const planning = read('skills/create-mobile-app/references/phase-02-planning.md');
  const building = read('skills/create-mobile-app/references/phase-09-build.md');
  assert.match(planning, /Gate 4a[\s\S]*Show the derived scope breakdown/);
  assert.match(planning, /what was consolidated and why remaining similar surfaces cannot be combined/);
  assert.match(building, /Build only approved Screen Map routes/);
  assert.match(building, /Necessary graph additions return to Gate 4a/);
});

test('navigation choice follows jobs and hierarchy instead of exposing every generated route', () => {
  const navigation = read('shared/references/screen-planning/navigation-contracts.md');
  const shell = read('skills/create-mobile-app/references/phase-08-screens.md');
  assert.match(navigation, /frequency of switching/);
  assert.match(navigation, /not from total route count or the three preview frames/);
  for (const pattern of ['Stack', 'Tabs with child stacks', 'Drawer with child stacks', 'Tabs plus secondary menu', 'Contextual modal/sheet']) {
    assert.ok(navigation.includes(`| ${pattern} |`), `missing navigation choice ${pattern}`);
  }
  assert.match(navigation, /Do not force a minimum number of tabs/);
  assert.match(navigation, /consolidate equivalent work first/);
  assert.match(navigation, /Profile\/sign-out reachable through a labeled account\/header\/menu entry/);
  assert.match(navigation, /Child stacks preserve the parent's scope, filters and return state/);
  assert.match(navigation, /intent preview and native layout use these same destination IDs/);
  assert.match(shell, /Only approved visible destination IDs\s+become Tabs\/Drawer entries/);
  assert.match(shell, /a flat route or folder root is not automatically a menu item/);
  assert.match(shell, /For stack-only use `Stack`/);
  assert.doesNotMatch(shell, /Each folder\/flat root becomes one\s+Tabs\/Drawer entry/);
});

test('minimum UX requires independent domain states and useful first entry without new artifacts', () => {
  assert.match(contract, /Keep independent business states separate/);
  assert.match(contract, /authorized actor, preconditions, permitted transition/);
  assert.match(contract, /ask through foreground only when an unknown rule changes/);
  assert.match(contract, /not another table or sidecar/);
  assert.match(contract, /not an arbitrary example record/);
  assert.match(contract, /initial scope\/filter and its rationale/);
  assert.match(contract, /Preserve explicit user filters and scope/);
  assert.match(contract, /Distinguish no records, no matching records, unauthorized access, and a failed load/);
  assert.match(contract, /exact identified record\s+with required parent\/context/);
  assert.match(contract, /safe direct-entry fallback/);
  const intake = read('skills/create-mobile-app/references/phase-01-intake.md');
  const planning = read('skills/create-mobile-app/references/phase-02-planning.md');
  const build = read('skills/create-mobile-app/references/phase-09-build.md');
  const builder = read('agents/screen-builder.md');
  const preview = read('skills/preview-screens/SKILL.md');
  assert.match(intake, /before data planning[\s\S]*Capture known domain rules/);
  assert.match(planning, /Gate 4b[\s\S]*independent domain states and authorized transitions/);
  assert.match(build, /Minimum product UX review/);
  assert.match(build, /actual source\/handler\/route evidence/);
  assert.match(build, /Compilation and the presence of handlers alone do not establish task completion/);
  assert.match(builder, /authorized transition[\s\S]*first-entry scope\/filter/);
  assert.match(preview, /First use:[\s\S]*Do not auto-switch explicit filters/);
  assert.match(preview, /Domain behavior:[\s\S]*updates only intended state\/records/);
});

test('creation plans semantic dependencies before generated-service verification', () => {
  assert.match(planner, /Before generation, specs use approved semantic data dependencies/);
  assert.match(contract, /Expected absent files do not cause `NEEDS_CONTEXT`/);
  assert.match(contract, /no unresolved identifier may reach implementation/);
  assert.match(contract, /Edits use verified existing evidence now/);
  assert.match(contract, /pending Step 10\.7 verification/);
});

test('entry composition strengthens existing fields without a universal layout or new gate', () => {
  assert.match(planner, /entry composition.*Layout delta/);
  assert.match(planner, /first-entry scope.*distinct from deliberately selected preview variants/);
  const entry = contract.split('### Entry composition within existing specs\n')[1]
    ?.split('**Conditional fields**')[0];
  assert.ok(entry);
  assert.match(entry, /First viewport:/);
  assert.match(entry, /Below fold:/);
  assert.match(entry, /actual approved context, facts\/content, and next action or read outcome/);
  assert.match(entry, /first-entry scope in \*\*Data\/Navigation\*\*/);
  assert.match(entry, /illustrative state in \*\*Preview selection\*\*/);
  assert.match(entry, /not a new artifact or approval gate/);
  assert.match(entry, /Long forms, reading and larger text may scroll/);
  assert.match(entry, /No mandatory hero, grid, dashboard, palette, card count, or minimum record count/);
  assert.match(entry, /provisional until visual approval/);
  assert.match(entry, /explicit user presentation requirements identified\s+separately/);
  assert.match(entry, /visible subject's emphasis, not only its\s+container/);
  assert.match(entry, /provisional visual intent, not a frozen composition/);
  assert.match(planner, /not inferred visual styling\s+for the later design phase/);
  assert.match(planner, /foreground-directed design reconciliation, update only the accepted presentation delta/);
  const planning = read('skills/create-mobile-app/references/phase-02-planning.md');
  assert.match(planning, /Gate 4b approves behavior, data\/permissions and navigation, not model-inferred visual arrangement/);
  assert.match(planning, /does not promote provisional styling\s+into fixed requirements/);
  assert.match(contract, /Do not default every collection to All/);
  assert.match(read('agents/references/screen-builder/design-api.md'),
    /accepted entry composition from Layout delta/);
});

test('requirements distinguish approval, attachments and provider-neutral collaboration', () => {
  const rows = table(discovery.replace('## Evidence-to-requirement mapping',
    '### Evidence-to-requirement mapping'), 'Evidence-to-requirement mapping');
  const find = signal => rows.find(row => row['Evidence in the brief'].startsWith(signal));
  assert.match(find('Approve, reject')['Requirement to record'], /Decision\/action/);
  assert.match(find('Approve, reject')['Do not infer'], /Handwritten signature/);
  assert.match(find('Explicit SharePoint')['Requirement to record'], /SharePoint connector/);
  assert.match(find('Explicit SharePoint')['Do not infer'], /generic "list", "document"/);
  assert.match(find('Generic in-app chat')['Do not infer'], /external provider without evidence/);
  assert.match(find('Attach, evidence')['Do not infer'], /Camera.*generic attachment/);
  assert.match(discovery, /foreground.*owns questions and approval/);
  assert.match(discovery, /Do not run a generic feature questionnaire/);
});

test('requirements ask only outcome-changing maker questions', () => {
  assert.match(discovery, /Should <action> only record the result, trigger <related action>, or wait for review/);
  assert.match(discovery, /Who can perform <specific transition>/);
  assert.match(discovery, /do not assume that all transitions must remain independent/);
  assert.match(discovery, /scheduled checklist\/inspection, review a history of\s+changes, or both/);
  assert.match(discovery, /custom Audit Event table[\s\S]*from the word alone/);
  assert.match(discovery, /Data\/system ownership needed to make approved operations real/);
  assert.match(discovery, /Native feasibility or disconnected\/offline requirement/);
  assert.match(discovery, /Do not ask \"how many screens,\" generic fidelity, or a feature checklist/);
  assert.match(discovery, /defer the one-time provide-or-infer choice\s+to the design phase/);
});

test('on-demand planning links and selected recipe anchors remain resolvable', () => {
  for (const relative of planningDocuments) {
    const document = read(relative).replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*(?:\n|$)/gm, '');
    for (const [, destination] of document.matchAll(/\[[^\]\n]+\]\(([^)\n]+\.md(?:#[^)\n]*)?)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) continue;
      const [file, anchor] = destination.split('#');
      const target = path.resolve(root, path.dirname(relative), file);
      assert.ok(fs.existsSync(target), `${relative}: missing ${destination}`);
      if (anchor) {
        const headings = fs.readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm);
        const slugs = [...headings].map(([, heading]) => heading.toLowerCase()
          .replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-'));
        assert.ok(slugs.includes(anchor), `${relative}: missing anchor ${destination}`);
      }
    }
  }
  const index = read('shared/references/universal-patterns.md');
  assert.ok(index.split('\n').length < 80, 'pattern entry is an index, not the recipe library');
  assert.match(index, /only the named recipe section/);
  assert.match(index, /do not read the whole library/);
  assert.doesNotMatch(index, /industry mapping|Building a \*\*/);
});

for (const fixture of cases) {
  test(`authored ${fixture.name} journey is coherent and grounded in its brief`, () => {
    const document = read(`scripts/tests/fixtures/screen-planning/${fixture.name}.md`);
    assert.match(document, /Authored expected plan fragment, not captured AI output/);
    assert.match(document, fixture.supporting);
    assert.match(document, fixture.behavior);
    const { screens, journeys } = validateFragment(document);
    const entrySpecs = validateEntryComposition(document);
    const homeSpec = entrySpecs.find(spec => spec.id === fixture.home);
    assert.ok(homeSpec);
    assert.equal(screens.find(screen => screen.Route === '/(app)/home').ID, fixture.home);
    assert.equal(journeys[0].Actor, fixture.actor);
    assert.match(journeys[0]['Committed outcome'], fixture.outcome);
    assert.match(journeys[0].Recovery, fixture.recovery);
    assert.equal(table(document, 'Preview selection')[0]['Screen ID'], fixture.preview);
    assert.notEqual(fixture.preview, fixture.home, 'preview can select the actual decision, not automatically Home');
    assert.doesNotMatch(document, /home-dashboard|KPI tiles/);
    if (fixture.name === 'expense-approval') {
      assert.ok(screens.every(screen => screen.Native === 'none'), 'approval does not require ink capture');
      assert.match(homeSpec.data, /submitted claims awaiting a decision; never switch to all claims/);
    }
    if (fixture.name === 'learning') {
      assert.match(homeSpec.layout, /retained reading position and readable lesson prose/);
      assert.match(homeSpec.data, /current lesson at retained reading position/);
    }
    if (fixture.name === 'shopping') {
      assert.match(homeSpec.layout, /product images, names, prices and availability/);
      assert.match(homeSpec.data, /active collection across all categories/);
    }
    if (fixture.name === 'inspection') {
      assert.equal(screens.find(screen => screen.ID === 'checklist').Native, 'expo-camera');
      assert.match(homeSpec.data, /current user's assigned site checks/);
    }
  });

}

test('authored entry checks reject missing composition, scope and main destination', () => {
  const document = read('scripts/tests/fixtures/screen-planning/learning.md');
  assert.throws(() => validateEntryComposition(document.replace(
    'Layout suggestions are provisional until visual approval', 'All layout suggestions are fixed')),
  /distinguish provisional presentation/);
  assert.throws(() => validateEntryComposition(document.replace('First viewport:', 'Polished layout:')),
    /first viewport and below-fold access/);
  assert.throws(() => validateEntryComposition(document.replace('; Below fold:', '; More content:')),
    /first viewport and below-fold access/);
  assert.throws(() => validateEntryComposition(document.replace('Initial scope:', 'Data:')),
    /explicit initial scope/);
  assert.throws(() => validateEntryComposition(document.replace('- **Screen ID** — learn',
    '- **Screen ID** — unrelated')), /main destination/);
  assert.throws(() => validateEntryComposition(document.replace('- **Screen ID** — completion',
    '- **Screen ID** — unrelated')), /selected preview screen/);
});

test('fixture checks reject broken joins, route collisions and lost sender parameters', () => {
  const shopping = read('scripts/tests/fixtures/screen-planning/shopping.md');
  assert.throws(() => validateFragment(shopping.replace('| basket | Shows quantity', '| missing | Shows quantity')),
    /preview references/);
  assert.throws(() => validateFragment(shopping.replace('| shop, basket, order-confirmation |',
    '| shop, missing, order-confirmation |')), /unknown screen/);
  const expense = read('scripts/tests/fixtures/screen-planning/expense-approval.md');
  assert.throws(() => validateFragment(expense.replace('notificationId?: string', '—')), /param union/);
  const inspection = read('scripts/tests/fixtures/screen-planning/inspection.md');
  assert.throws(() => validateFragment(inspection.replace('app/(app)/inspections/[id]/review.tsx',
    'app/(app)/inspections/[id].tsx')), /route matches file/);
});
