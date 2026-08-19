'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildGate3PreviewContract,
  validateGate3PreviewContract,
} = require('../build-gate3-preview-contract');
const { renderPlan } = require('../render-mobile-plan');

function planFixture() {
  return `# Equipment Care — Native App Plan

## Product Experience
- Contract version: 1
- Industry context: Fitness equipment operations
- Product archetype: Equipment maintenance lifecycle from inspection through return to service
- Classification confidence: high
- Classification evidence: Equipment, service intervals, repair, verification
- Workflow capabilities: QR lookup, preventive service, issue triage, repair tracking
- Operating context: Indoor one-handed technician use with intermittent connectivity
- Visual personality: Precise equipment-focused interface with quiet premium detailing
- Visual ambition: Distinct branded production experience
- Content emphasis: Current equipment identity and health dominate supporting maintenance context
- Home composition: Equipment identity and health lead into next service and one integrated action
- Navigation mood: Branded native navigation subordinate to equipment content
- Navigation silhouette: Three bottom tabs with equipment-led Home and native work-order list
- Density: Comfortable scanning rhythm for repeated technician use
- Reference fidelity: none
- Media strategy: record-media
- Media source: cr_equipment.cr_image
- Media fallback: Stable equipment identity panel with model and location

### First Viewport Contract
| Field | Requirement |
|---|---|
| Signature component | EquipmentCommandHero |
| Viewport share | 0.42 |
| Minimum height | 320 |
| Media | required |
| Headline minimum | 38 |
| Supporting metrics maximum | 2 |
| Primary action | integrated |
| Next section visible | yes |
| Duplicate action with tab | forbidden |

### Reference Contract
_None._

## Design Direction
density: Comfortable scanning rhythm with 48dp-or-larger controls
surface: Full-width content with framed grouping only for owned actions
motion: Functional state transitions with reduced-motion support
list_style: Equipment name and urgency lead one contained status cue
tone: Direct technician language with actionable errors
primary_action_shape: High-contrast rectangular action with visible verb
primary_action_position: Integrated into the equipment command region
status_treatment: One contained status cue with text and accessible contrast
empty_state: Domain condition, explanation, and one recovery action
heading_font: Approved display family
body_font: Approved readable sans family

## Design
- Aesthetic rationale: Precision and calm hierarchy support repeated equipment decisions
- Palette: Background #F4F6F2, accent #176B57, text #17201D
- Typography: Compact display family with readable sans body and zero tracking
- Surface treatment: Quiet full-width canvas with selectively framed action groups
- Motion policy: Functional state and spatial transitions only
- One memorable thing: Equipment identity remains visually anchored throughout maintenance work

## Screens

### Navigation Pattern
**Tabs + Stack** — Home, Work Orders, and Profile tabs with pushed detail screens.

### Screen Map
| Screen | Route | File | Presentation | Purpose | Data | Native | Source |
|---|---|---|---|---|---|---|---|
| Home | \`/(app)/home\` | \`app/(app)/home.tsx\` | default | Show current equipment health and next maintenance action | EquipmentService | - | replace template |
| Work Orders | \`/(app)/work-orders\` | \`app/(app)/work-orders/index.tsx\` | default | Prioritize open maintenance work | WorkOrderService | - | new |
| Work Order Detail | \`/(app)/work-orders/[id]\` | \`app/(app)/work-orders/[id].tsx\` | default | Resolve one work order | WorkOrderService | camera | new |
| Profile | \`/(app)/profile\` | \`app/(app)/profile.tsx\` | default | Technician context and sign out | useAuth | - | new |

### Shared Conventions

**Tab-root silhouettes**
- Home: Equipment identity hero, vertical lifecycle context, integrated maintenance action, record image
- Work Orders: Native searchable queue, severity grouping, extended create action, no hero media
- Profile: Grouped technician context and preferences, no operational action or record media

### Per-Screen Specs

#### Home (\`/(app)/home\`)
- **Domain layout decisions:** Equipment identity, condition, location, and next service dominate. The integrated maintenance action is the primary decision. Real equipment media differentiates this from a generic dashboard.
- **Archetype:** Tab-root
- **Purpose:** Show current equipment health and next maintenance action.
- **Home composition:** Equipment identity and health lead into next service and one integrated action.
- **First viewport materialization:** EquipmentCommandHero uses 42% of the viewport with required record media, headline 38sp+, at most two metrics, integrated Open maintenance action, and next section visible.
- **Layout delta:** Stable equipment media and identity region, condition summary, integrated maintenance action, then next service and recent issue context.
- **UX contract:** Primary action Open maintenance is integrated into EquipmentCommandHero and must not duplicate a tab.
- **State delta:** Missing image preserves the hero geometry and renders equipment model plus location.

#### Work Orders (\`/(app)/work-orders\`)
- **Domain layout decisions:** Urgency, equipment, assignee, and due time lead each row. The overdue decision dominates. Severity grouping differentiates this from a generic list.
- **Archetype:** List
- **Purpose:** Prioritize open maintenance work.
- **Workflow arrangement:** Searchable severity-grouped queue with visible filters and one extended New work order action.
- **Layout delta:** Native large title and search, severity filters, then full-width urgency-ordered rows.
- **UX contract:** Primary create action New work order uses an extended bottom-reachable action.
- **State delta:** Empty state explains that assigned work appears here and offers refresh.

#### Work Order Detail (\`/(app)/work-orders/[id]\`)
- **Domain layout decisions:** Equipment, fault, blocker, and next resolution action lead. Decision readiness dominates. Evidence and parts history differentiate the record.
- **Archetype:** Detail
- **Purpose:** Resolve one work order.
- **Layout delta:** Contained readiness summary followed by evidence, parts, and chronological history.
- **UX contract:** Primary action Resolve work order is bottom-owned and disabled until blockers are addressed.
- **State delta:** Failed evidence retains its geometry and offers retry.

#### Profile (\`/(app)/profile\`)
- **Domain layout decisions:** Technician identity, assigned sites, and queue defaults lead. Operational context dominates sign out. Workflow preferences differentiate the profile.
- **Archetype:** Tab-root
- **Purpose:** Review technician context and sign out.
- **Layout delta:** Identity and assignment groups followed by preferences and separated sign-out action.
- **UX contract:** Sign out is a separated destructive action after confirmation.
`;
}

test('builds a valid structural preview contract from a free-form plan', () => {
  const markdown = planFixture();
  const contract = buildGate3PreviewContract(markdown, {
    planPath: '/tmp/equipment/native-app-plan.md',
    projectRoot: '/tmp/equipment',
    generatedAt: '2026-08-20T00:00:00.000Z',
  });
  assert.deepStrictEqual(validateGate3PreviewContract(contract), []);
  assert.strictEqual(contract.product.structure, 'Equipment maintenance lifecycle from inspection through return to service');
  assert.strictEqual(contract.firstViewport.viewportShare, 0.42);
  assert.strictEqual(contract.firstViewport.minimumHeight, 320);
  assert.deepStrictEqual(contract.representativeScreens, [
    '/(app)/home',
    '/(app)/work-orders',
    '/(app)/work-orders/[id]',
  ]);
  assert.strictEqual(contract.navigation.silhouettes.length, 3);
  assert.match(contract.screens.find((screen) => screen.isHome).action, /Open maintenance/);
});

test('blocks an incomplete Home structural projection', () => {
  const contract = buildGate3PreviewContract(planFixture(), { generatedAt: '2026-08-20T00:00:00.000Z' });
  contract.screens.find((screen) => screen.isHome).action = '';
  const issues = validateGate3PreviewContract(contract);
  assert.ok(issues.some((issue) => issue.rule === 'incomplete-home-preview' && issue.field === 'action'));
});

test('renders annotated representative frames and escapes contract content', () => {
  const markdown = planFixture();
  const contract = buildGate3PreviewContract(markdown, { generatedAt: '2026-08-20T00:00:00.000Z' });
  contract.screens.find((screen) => screen.route === '/(app)/work-orders').dominant = '<script>alert(1)</script>';
  const html = renderPlan(markdown, { phase: 'experience', completed: 3, total: 4 }, contract);
  assert.match(html, /Gate 3 structural design preview/);
  assert.match(html, /Signature region · 42% viewport/);
  assert.match(html, /Cross-tab silhouettes/);
  assert.match(html, /Required media/);
  assert.match(html, /Structural preview/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('builds, validates, and renders the Gate 3 contract through the CLI', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate3-preview-'));
  const plan = path.join(projectRoot, 'native-app-plan.md');
  const contract = path.join(projectRoot, '.tmp', 'gate3-preview-contract.json');
  const output = path.join(projectRoot, 'mobile-app-plan.html');
  const scriptsRoot = path.resolve(__dirname, '..');
  fs.writeFileSync(plan, planFixture(), 'utf8');

  const build = spawnSync(process.execPath, [
    path.join(scriptsRoot, 'build-gate3-preview-contract.js'),
    '--project-root', projectRoot,
    '--plan', plan,
    '--output', contract,
  ], { encoding: 'utf8' });
  assert.strictEqual(build.status, 0, build.stderr);
  assert.ok(fs.existsSync(contract));

  const validate = spawnSync(process.execPath, [
    path.join(scriptsRoot, 'build-gate3-preview-contract.js'),
    '--validate', contract,
  ], { encoding: 'utf8' });
  assert.strictEqual(validate.status, 0, validate.stderr);
  assert.strictEqual(JSON.parse(validate.stdout).status, 'ok');

  const render = spawnSync(process.execPath, [
    path.join(scriptsRoot, 'render-mobile-plan.js'),
    '--plan', plan,
    '--preview-contract', contract,
    '--output', output,
  ], { encoding: 'utf8' });
  assert.strictEqual(render.status, 0, render.stderr);
  const html = fs.readFileSync(output, 'utf8');
  assert.match(html, /Gate 3 structural design preview/);
  assert.match(html, /Equipment maintenance lifecycle/);
  assert.match(html, /Work Orders/);
});