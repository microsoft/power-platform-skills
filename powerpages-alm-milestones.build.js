// Rebuilds the unencrypted editing-master .docx from the deck content.
// Conventions: "Slide N · Title" headings, bold-teal field labels, <guillemet> placeholders, shaded speaker-notes blocks.
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType
} = require('docx');

// ---- palette (matches deck) ----
const TEAL = '0E7490', AMBER = 'B45309', GREEN = '0B6E36', VIOLET = '5B3FA3',
      INK = '16263B', MUTED = '566A82', LINE = 'CCD4DE';
const SUB = '·';                    // middle dot
const LAQUO = '‹', RAQUO = '›'; // guillemets for placeholders

// ---- run helpers ----
const t   = (text, o = {}) => new TextRun({ text, font: 'Segoe UI', size: 21, color: INK, ...o });
const lbl = (text) => t(text, { bold: true, color: TEAL });
const b   = (text) => t(text, { bold: true });
const em  = (text) => t(text, { italics: true, color: VIOLET });
const mut = (text) => t(text, { color: MUTED });
const ph  = (text) => t(`${LAQUO}${text}${RAQUO}`, { bold: true, color: AMBER });
const code = (text) => new TextRun({ text, font: 'Cascadia Code', size: 19, color: VIOLET });

// ---- paragraph helpers ----
const P = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: 120, line: 276 }, ...o });
const field = (label, ...rest) => P([lbl(label + ': '), ...rest]);
const bullet = (...runs) => new Paragraph({ children: runs, bullet: { level: 0 }, spacing: { after: 80, line: 268 } });
const H1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 80, after: 160 }, children: [t(text, { bold: true, size: 40, color: INK })] });
const slideH = (n, title) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: TEAL, space: 4 } }, children: [t(`Slide ${n} ${SUB} ${title}`, { bold: true, size: 30, color: INK })] });
const H3 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 80 }, children: [t(text, { bold: true, size: 24, color: TEAL })] });

// speaker-notes block (shaded)
const notesLabel = () => new Paragraph({ spacing: { before: 200, after: 60 }, shading: { type: ShadingType.CLEAR, fill: 'EEF2F7' }, children: [t('SPEAKER NOTES', { bold: true, color: TEAL, size: 18 })] });
const note = (children) => new Paragraph({ spacing: { after: 100, line: 276 }, shading: { type: ShadingType.CLEAR, fill: 'F7FAFC' }, children: Array.isArray(children) ? children : [children] });

// ---- table helpers ----
const cellBorders = { top:{style:BorderStyle.SINGLE,size:2,color:LINE}, bottom:{style:BorderStyle.SINGLE,size:2,color:LINE}, left:{style:BorderStyle.SINGLE,size:2,color:LINE}, right:{style:BorderStyle.SINGLE,size:2,color:LINE} };
const cell = (runs, { head = false, w } = {}) => new TableCell({
  width: w ? { size: w, type: WidthType.PERCENTAGE } : undefined,
  shading: head ? { type: ShadingType.CLEAR, fill: 'F1F5F9' } : undefined,
  margins: { top: 60, bottom: 60, left: 110, right: 110 },
  children: [new Paragraph({ spacing: { after: 0, line: 264 }, children: Array.isArray(runs) ? runs : [runs] })],
});
const tbl = (rows) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: cellBorders, rows });
const row = (cells) => new TableRow({ children: cells });
const headRow = (labels, widths) => row(labels.map((l, i) => cell(t(l, { bold: true, color: INK, size: 19 }), { head: true, w: widths && widths[i] })));

// ============================================================
const kids = [];

// ---- preamble ----
kids.push(H1('Power Pages ALM — End-State Architecture & Milestone Walkthrough'));
kids.push(P(mut('Editing source document for the leadership presentation deck'), { spacing: { after: 200 } }));
kids.push(field('Author', t('Nidhi Tyagi '), mut(`${SUB} Sr. SWE, Power Pages ALM`)));
kids.push(field('Audience', t('Skip-level leadership + dependent team leaders (PM, FastTrack, PowerCAT, support, platform)')));
kids.push(field('Source artifact', code('powerpages-alm-milestones.html'), t(' (10-section presentation)')));

kids.push(H3('How to use this document'));
kids.push(bullet(b('One section per slide. '), t('Each section below maps 1:1 to a slide in the deck, in order, under the heading '), b('“Slide N '+SUB+' Title”'), t('. Keep that heading format so the deck can be regenerated from this file.')));
kids.push(bullet(b('Field labels are structural. '), t('Bold teal labels ('), lbl('Eyebrow, Title, Lead, Definition of done, …'), t(') mark fields that map to specific slide elements. Edit the value after the colon; keep the label.')));
kids.push(bullet(b('Placeholders to fill. '), t('Tokens written like '), ph('threshold X%'), t(' are intentional blanks — replace the text between the '), t(LAQUO+' '+RAQUO), t(' guillemets before sharing externally; leave the guillemets off your final value.')));
kids.push(bullet(b('Diagrams are captured as structured text. '), t('The architecture and timeline diagrams are represented as editable node/edge and phase lists so changes here can be rebuilt into the Mermaid diagrams.')));
kids.push(bullet(b('Speaker notes '), t('live in the shaded “Speaker notes” block at the end of each section (also editable directly in the HTML deck).')));

kids.push(H3('Thesis (framing — keep verbatim)'));
kids.push(P([t('For Power Pages, reliability comes from '), b('stabilizing'), t(' the solution boundary, not shrinking it. The '), b('site'), t(' is the unit of ALM; '), b('Git'), t(' is the unit of change; '), b('AI'), t(' is the orchestrator that removes the room to get it wrong.')]));

// ============================================================
// SLIDE 1
kids.push(slideH(1, 'Title & Thesis'));
kids.push(field('Eyebrow', t(`North Star ${SUB} Leadership walkthrough`)));
kids.push(field('Title', t('Power Pages ALM — End-State Architecture & Milestone Walkthrough')));
kids.push(field('Thesis', t('For Power Pages, reliability comes from '), b('stabilizing'), t(' the solution boundary, not shrinking it. The '), b('site'), t(' is the unit of ALM; '), b('Git'), t(' is the unit of change; '), b('AI'), t(' is the orchestrator that removes the room to get it wrong.')));
kids.push(field('Presenter', t(`Nidhi Tyagi ${SUB} Sr. SWE, Power Pages ALM`)));
kids.push(field('Audience', t('Skip-level leadership + dependent team leaders')));
kids.push(field('Date', t('June 3, 2026')));
kids.push(H3('Status row (four stat cards)'));
kids.push(tbl([
  headRow(['Phase', 'Status', 'Milestone'], [40, 24, 36]),
  row([cell(t('Phase 0 '+SUB+' Solution Explorer')), cell(t('Done', { bold: true, color: GREEN })), cell(t('GA '+SUB+' Jan 2026'))]),
  row([cell(t('Phase 1 '+SUB+' AI Outer Loop')), cell(t('Done', { bold: true, color: GREEN })), cell(t('GA '+SUB+' May 2026'))]),
  row([cell(t('Phase 2 '+SUB+' Native Git')), cell(t('Active', { bold: true, color: TEAL })), cell(t('Target '+SUB+' Jul 2026'))]),
  row([cell(t('Phase 3 '+SUB+' AI Inner Loop')), cell(t('Active', { bold: true, color: TEAL })), cell(t('Target '+SUB+' Jul 2026'))]),
]));
kids.push(notesLabel());
kids.push(note([t('Open with the thesis verbatim — it’s the through-line for the whole deck. The single most important reframe: we are '), em('not'), t(' trying to make the solution smaller or split sites into many solutions. We’re stabilizing one durable boundary per site.')]));
kids.push(note([t('Three nouns to plant now and reuse all deck: '), b('site'), t(' (unit of ALM), '), b('Git'), t(' (unit of change), '), b('AI'), t(' (orchestrator). Everything downstream hangs off these three.')]));
kids.push(note(t('Note the status row: two phases already GA, two targeting end of July. Lead with momentum — this is a “we’ve shipped, here’s what’s next and why” story, not a pitch for net-new investment.')));

// ============================================================
// SLIDE 2
kids.push(slideH(2, 'Problem & Why Now'));
kids.push(field('Lead', t('Today’s Power Pages ALM is fragmented across tools that were never designed to compose. The maker pays the integration tax.')));
kids.push(H3('Fragmentation today'));
kids.push(bullet(b('PAC CLI'), t(' — scriptable, but a separate mental model from the Maker UX.')));
kids.push(bullet(b('Azure DevOps pipelines'), t(' — powerful, IT-owned, heavy to stand up.')));
kids.push(bullet(b('Power Platform Pipelines'), t(' — maker-friendly, but host provisioning + config is manual.')));
kids.push(bullet(b('Solution Explorer'), t(' — packaging UI, historically classic-only for Pages.')));
kids.push(bullet(b('Manual env-var & secret handling'), t(' — copy/paste between environments, error-prone.')));
kids.push(bullet(b('GitHub Actions'), t(' — wraps PAC CLI to invoke Power Platform solution-promotion actions; yet another CI/CD entry point to reconcile.')));
kids.push(H3('The human cost'));
kids.push(bullet(t('Makers and devs are '), b('forced to become ALM specialists'), t(' just to promote a site.')));
kids.push(bullet(t('Deployment errors spike at '), b('1,000+ component sites'), t(' — the exact sites that matter most.')));
kids.push(bullet(b('Limited traceability'), t(': no reliable map from “what’s deployed” back to “who changed what, when, why.”')));
kids.push(bullet(t('No single recommended pattern '), b('→ contradictory guidance'), t(' across FastTrack, PowerCAT, support.')));
kids.push(field('Callout — cost of inaction', t('Elevated incident volume, repeated deployment failures, and slowed enterprise adoption. Quantify locally with '), ph('incident count / quarter'), t(', '), ph('deploy failure rate at 1k+ sites'), t(', and '), ph('adoption / time-to-prod'), t('.')));
kids.push(field('Callout — why now', t('Solution Explorer for Pages went GA (Jan 2026) and the AI outer loop went GA (May 2026). The foundation exists — this is the moment to '), b('converge'), t(' the pieces before divergent guidance hardens.')));
kids.push(notesLabel());
kids.push(note([t('Don’t enumerate tools as features — frame each as a '), em('seam'), t(' the maker has to stitch by hand. The point isn’t “we have many tools,” it’s “the integration burden lands on the wrong person.”')]));
kids.push(note(t('The 1,000+ component number is the emotional hook for this audience — these are flagship customer sites, so failures here are disproportionately visible and escalation-heavy.')));
kids.push(note(t('Fill the placeholders with real numbers before presenting to leadership; even rough figures make the cost-of-inaction concrete and move the conversation from anecdote to trend.')));
kids.push(note(t('“Why now” pre-empts the obvious question — land that the foundation is already GA, so this is convergence, not a from-scratch bet.')));

// ============================================================
// SLIDE 3
kids.push(slideH(3, 'End-State Architecture'));
kids.push(field('Lead', t('A hub-and-spoke model. The AI orchestrator is the hub that captures intent, plans, validates, and executes. The building blocks are spokes — interoperable, not competing. Telemetry closes the loop.')));
kids.push(H3('Architecture diagram (structured text)'));
kids.push(field('Hub', t('AI orchestrator — plan '+SUB+' validate '+SUB+' execute')));
kids.push(field('Inner-loop spokes', t('Native Git, PAC CLI')));
kids.push(field('Outer-loop spokes', t('Solution Explorer, Power Pipelines, Azure DevOps, GitHub Actions, Env Variables + Key Vault')));
kids.push(field('Feedback', t('All spokes emit to Telemetry / App Insights / Diagnostics, which feeds back into the orchestrator.')));
kids.push(field('Key edges', t('AI → inner loop; inner loop —(PR merged)→ outer loop; inner & outer —emit→ telemetry; telemetry —feedback→ AI.')));
kids.push(H3('Architectural principles'));
kids.push(bullet(b('1. Site is the unit of ALM '), mut('— one long-lived solution per site.')));
kids.push(bullet(b('2. Git is the unit of change '), mut('— every artifact maps to a commit/PR.')));
kids.push(bullet(b('3. AI orchestrates; humans approve '), mut('— plan → consent → execute.')));
kids.push(bullet(b('4. Incrementality in source control '), mut('— not in solution composition.')));
kids.push(bullet(b('5. Idempotent '+SUB+' resumable '+SUB+' auditable '), mut('— every action, every time.')));
kids.push(notesLabel());
kids.push(note(t('This is the slide to slow down on. Walk the hub first: the orchestrator is the single front door — makers express intent, not tool invocations.')));
kids.push(note([t('Then the spokes. The key message: these are '), b('interoperable, not competing'), t('. PAC CLI, Power Pipelines, and ADO Pipelines are not three answers to the same question — they’re different reach points the orchestrator drives. Git is the gate everything promotes through.')]));
kids.push(note([t('Principle 4 is the one most likely to get pushback and is the heart of the thesis. The instinct under pressure is to shrink/split the solution to make deploys safer. We reject that: incrementality lives in '), em('source control'), t(' (diffs, PRs, selective commits), while the solution boundary stays whole and stable. Say it explicitly.')]));
kids.push(note(t('Close on the telemetry feedback edge — it’s what makes the orchestrator get smarter at diagnosis over time, not just a one-shot executor.')));

// ============================================================
// SLIDE 4
kids.push(slideH(4, 'Inner Loop vs Outer Loop'));
kids.push(field('Lead', t('Two distinct cadences. The inner loop is a developer iterating inside one environment. The outer loop is promotion across environments. Same ALM substrate; different verbs.')));
kids.push(H3('Inner Loop — iterate inside an env'));
kids.push(P(mut('A maker/dev iterating within a single environment.')));
kids.push(bullet(t('Edit & preview; branch & commit; push & pull (two-way sync); pre-commit validation; multi-user edits & conflict resolution; inner-loop diagnostics.')));
kids.push(field('Investments', t('Native Git (Phase 2), AI Inner Loop skills (Phase 3), PAC CLI primitives.')));
kids.push(H3('Outer Loop — promote across envs'));
kids.push(P(mut('Promotion of a validated site from one environment to the next.')));
kids.push(bullet(t('Build & package; validate (solution checker, tests); deploy (managed upgrade); activate site; monitor; rollback.')));
kids.push(field('Investments', t('AI Outer Loop skills (Phase 1, GA), Solution Explorer packaging, Power Pipelines, ADO Pipelines, GitHub Actions, Env Variables + Key Vault, diagnose-deployment.')));
kids.push(H3('Mapping at a glance'));
kids.push(tbl([
  headRow(['Dimension', 'Inner loop', 'Outer loop'], [22, 39, 39]),
  row([cell(b('Scope')), cell(t('Single environment (Dev)')), cell(t('Dev → Test → Prod promotion path'))]),
  row([cell(b('Primary actor')), cell(t('Maker / pro-dev')), cell(t('Maker / release owner + approvers'))]),
  row([cell(b('Unit of work')), cell(t('Commit / PR')), cell(t('Managed solution upgrade'))]),
  row([cell(b('Cadence')), cell(t('Minutes — many times/day')), cell(t('Per release — gated'))]),
  row([cell(b('Source of truth')), cell(t('Native Git (two-way sync)')), cell(t('Git commit → pipeline artifact'))]),
  row([cell(b('AI phase')), cell(t('Phase 3 (Jul 2026 target)')), cell(t('Phase 1 (GA '+SUB+' May 2026)'))]),
  row([cell(b('Guarantee')), cell(t('Pre-commit validation, idempotent sync')), cell(t('Idempotent, resumable, auditable deploy + rollback'))]),
]));
kids.push(notesLabel());
kids.push(note(t('Why this slide exists: leaders conflate “deployment” with “all of ALM.” Separating the loops lets us show that the GA’d work (outer loop) and the in-flight work (inner loop) are complementary, not redundant.')));
kids.push(note([t('The punchline in the last table row: '), b('both loops carry the same guarantees'), t(' — idempotent, resumable, auditable. Phase 3’s job is to bring inner-loop daily work up to the bar outer loop already meets.')]));
kids.push(note(t('If asked “why ship outer loop first?” — because promotion failures are the loudest pain (escalations, prod incidents). Inner loop is higher-frequency but lower-blast-radius, so it followed.')));

// ============================================================
// SLIDE 5
kids.push(slideH(5, 'Phased Milestones — Timeline'));
kids.push(field('Lead', t('Five phases. Two shipped, two targeting end of July 2026, one directional. Dates are exact where committed; anything post-July is marked '), b('Directional / TBD'), t('.')));
kids.push(H3('Timeline (phase table)'));
kids.push(tbl([
  headRow(['Phase', 'Status', 'Window'], [46, 26, 28]),
  row([cell(t('Phase 0 — Solution Explorer in Maker UX')), cell(t('Done (GA)', { bold: true, color: GREEN })), cell(t('→ Jan 2026'))]),
  row([cell(t('Phase 1 — AI-first Outer Loop')), cell(t('Done (GA)', { bold: true, color: GREEN })), cell(t('→ May 2026'))]),
  row([cell(t('Phase 2 — Native Git for Pages')), cell(t('Active', { bold: true, color: TEAL })), cell(t('target Jul 2026'))]),
  row([cell(t('Phase 3 — AI-first Inner Loop')), cell(t('Active', { bold: true, color: TEAL })), cell(t('target Jul 2026'))]),
  row([cell(t('Phase 4 — Convergence & Enterprise Hardening')), cell(t('Directional / TBD', { bold: true, color: VIOLET })), cell(t('post-Jul 2026'))]),
]));
kids.push(H3('Phase 0 — Foundation (GA '+SUB+' Jan 2026)'));
kids.push(P(mut('Solution Explorer support for Power Pages in Maker UX — fully available end of January 2026.')));
kids.push(field('Definition of done', t('Makers can author, package, and move site-scoped solutions from Maker UX without falling back to classic experiences.')));
kids.push(H3('Phase 1 — AI-first Outer Loop (GA '+SUB+' May 2026)'));
kids.push(field('Skills', code('/plan-alm'), t(', '), code('/setup-solution'), t(', '), code('/export-solution'), t(', '), code('/import-solution'), t(', '), code('/setup-pipeline'), t(', '), code('/deploy-pipeline'), t(', '), code('/ensure-pipelines-host'), t(', '), code('/configure-env-variables'), t(', '), code('/diagnose-deployment'), t('.')));
kids.push(field('Definition of done', t('A maker/dev can go from “deploy Dev → Prod” intent to a validated production deployment without manual PPAC click-throughs.')));
kids.push(H3('Phase 2 — Native Git for Power Pages (Target '+SUB+' Jul 2026)'));
kids.push(bullet(t('Two-way sync between Dataverse and the customer’s source control.')));
kids.push(bullet(t('Human-readable formats (yaml / js / css / html) replacing XML.')));
kids.push(bullet(t('PR-style review with component-level diffs.')));
kids.push(bullet(t('PAC CLI commands for push/pull/commit/sync (non-AI path) + skill wrappers (AI path).')));
kids.push(field('Definition of done', t('An enterprise customer can use Git as source of truth with PR review, branching strategies, and reliable two-way sync — without IT involvement beyond providing the repo.')));
kids.push(H3('Phase 3 — AI-first Inner Loop (Target '+SUB+' Jul 2026)'));
kids.push(bullet(t('Skills: branch creation, multi-user edits, conflict-resolution guidance, pre-commit validation, local preview orchestration, inner-loop diagnostics.')));
kids.push(field('Definition of done', t('A developer’s daily edit-commit-preview-PR cycle is orchestrated and validated by the AI plugin with the same idempotency guarantees as the outer loop.')));
kids.push(H3('Phase 4 — Convergence & Enterprise Hardening (Directional / TBD '+SUB+' post-Jul 2026)'));
kids.push(bullet(b('End-to-end: '), t('intent → AI orchestrator → Native Git PR → Pipelines (Power, ADO, or GitHub Actions) → managed solution upgrade → validation → rollback.')));
kids.push(bullet(t('Selective commits, conflict-resolution UX, monitoring-hub integration, post-deployment site-config skills.')));
kids.push(bullet(b('Enterprise governance: '), t('solution-checker integration, code/security analysis, test plans, approval gates.')));
kids.push(field('Definition of done', t('“enterprise-grade ALM” criteria met (see Slide 7).')));
kids.push(notesLabel());
kids.push(note(t('Anchor on the dates and don’t drift: Jan 2026, end-May 2026, end-July 2026 (×2, in progress). Everything after July is explicitly Directional / TBD — say “directional” out loud so no one writes down a commitment we didn’t make.')));
kids.push(note(t('Phase 2 and Phase 3 land together (end of July). That’s deliberate: inner-loop AI (Phase 3) is only as good as the Git substrate (Phase 2) underneath it — they’re co-dependent, so they ship as a pair.')));
kids.push(note(t('If pushed on Phase 4 dates: we’ll commit dates once Phase 2/3 land and we’ve measured the failure-rate and rollback metrics in Slide 7. Resist being pinned.')));

// ============================================================
// SLIDE 6
kids.push(slideH(6, 'Trade-offs'));
kids.push(field('Lead', t('Every phase made a deliberate cut. Surfacing them builds trust — and pre-empts “why didn’t you just…” questions.')));
kids.push(tbl([
  headRow(['Phase', 'What we chose', 'What we deferred', 'Why'], [13, 29, 29, 29]),
  row([cell(b('Phase 0 (Foundation)')), cell(t('Solution Explorer in Maker UX as the packaging surface for sites.')), cell(t('Deep classic Solution Explorer parity for edge component types.')), cell(t('Meet makers where they already work; cover the 90% authoring path first.'))]),
  row([cell(b('Phase 1 (Outer Loop)')), cell(t('Orchestrator + /plan-alm front door with human approval gates.')), cell(t('Fully autonomous, unattended deploy.')), cell(t('Human approval gates build trust at GA; autonomy is earned after the failure-rate bar is proven.'))]),
  row([cell(b('Phase 2 (Native Git)')), cell(t('Two-way sync via Dataverse native APIs.')), cell(t('Migration from external Git providers; ADO-API-based sync.')), cell(t('Reliability + off-sync avoidance — owning the sync path end-to-end prevents drift.'))]),
  row([cell(b('Phase 3 (Inner Loop)')), cell(t('AI-assisted inner loop layered on existing PAC CLI primitives.')), cell(t('IDE-native (VS Code) deep integration beyond what exists today.')), cell(t('Ship orchestration value first, deepen IDE integration later once the skill surface stabilizes.'))]),
  row([cell(b('Phase 4 (Convergence)')), cell(t('Unify into one end-to-end path + enterprise governance gates.')), cell(t('Locking dates & full autonomy until metrics are proven.')), cell(t('Converge only on a measured foundation; governance before autonomy.'))]),
]));
kids.push(field('Callout — the meta-trade-off', t('We consistently chose '), b('trust and reliability over speed and autonomy'), t('. Approval gates, owned sync paths, and primitives-first all defer convenience to protect correctness — exactly the right ordering for 1,000+ component flagship sites.')));
kids.push(notesLabel());
kids.push(note(t('This is the credibility slide. Leaders trust roadmaps that name their own cuts. Walk each row as “we chose X, we knowingly deferred Y, and here’s the principle that made that the right call.”')));
kids.push(note([t('The recurring theme — call it out at the bottom — is '), b('trust/reliability over speed/autonomy'), t('. Every deferral protects correctness on high-stakes sites.')]));
kids.push(note([t('The Phase 2 row is the one platform peers will probe: why native Dataverse APIs instead of reusing ADO’s Git APIs? Answer: to '), em('own the sync contract'), t(' and avoid off-sync states. That’s a reliability decision, not a NIH one.')]));

// ============================================================
// SLIDE 7
kids.push(slideH(7, 'What “Done” Looks Like — Enterprise-Grade ALM'));
kids.push(field('Lead', t('Ten measurable criteria. Fill the placeholders with committed thresholds before sharing externally; this is the bar Phase 4 closes against.')));
kids.push(bullet(b('Site-as-unit-of-ALM. '), t('Bundled solution (one or split based on size) per site, long-lived, managed upgrades only — no recreate-from-scratch deploys.')));
kids.push(bullet(b('Git is the source of truth. '), t('Every deployed artifact maps to a commit / PR; provenance is queryable.')));
kids.push(bullet(b('Idempotent, resumable, auditable. '), t('Any deployment can be re-run safely, resumed after interruption, and reconstructed from an audit trail.')));
kids.push(bullet(b('Shared substrate across personas. '), t('Maker and pro-dev share the same underlying ALM substrate — no fork in tooling or guidance.')));
kids.push(bullet(b('AI removes ≥ '), ph('80'), b('% of manual ALM setup steps'), t(', with consent checkpoints preserved at every state-changing action.')));
kids.push(bullet(b('Deployment failure rate at 1,000+ component sites < '), ph('10'), b('%'), t(' (set committed threshold), measured over '), ph('30d'), t('.')));
kids.push(bullet(b('Rollback is a single command'), t(' and predictable — bounded, well-understood blast radius.')));
kids.push(bullet(b('Closed telemetry loop. '), t('Deployment telemetry feeds back into AI orchestrator diagnostics; recurring failures become guided fixes.')));
kids.push(bullet(b('One recommended pattern. '), t('FastTrack / SI / PowerCAT give a single, non-contradictory ALM recommendation.')));
kids.push(bullet(b('Interoperable, not competing. '), t('Native Git, Power Pipelines, ADO Pipelines, GitHub Actions, and PAC CLI compose into one model with clear persona defaults.')));
kids.push(notesLabel());
kids.push(note(t('This is the contract. When someone asks “how will we know we’re done?”, this slide is the answer. Every line is meant to be measurable or binary.')));
kids.push(note(t('Two numbers need committing before external sharing: the ≥80% automation target and the failure-rate threshold X%. Set them with the telemetry team using a real baseline, not a guess.')));
kids.push(note(t('The last two criteria are organizational, not technical — single recommended pattern and interoperability. They matter most to the dependent-team leads in the room.')));

// ============================================================
// SLIDE 8
kids.push(slideH(8, 'Dependencies & Ask'));
kids.push(field('Lead', t('Convergence is cross-team. Each dependency below has a specific ask, an owner to assign, and a by-when to commit.')));
kids.push(tbl([
  headRow(['Team', 'Specific ask', 'Owner', 'By when'], [20, 40, 20, 20]),
  row([cell(b('Platform')), cell(t('Native Git API stability + Dataverse two-way sync reliability (no off-sync states); published SLA for sync.')), cell(ph('nityagi')), cell(ph('July 2026'))]),
  row([cell(b('Power Platform Pipelines')), cell(t('Pipeline host provisioning + BAP API stability; deterministic host creation for /ensure-pipelines-host.')), cell(ph('nityagi')), cell(ph('August 2026'))]),
  row([cell(b('PAC CLI')), cell(t('Command-surface alignment with skill expectations (push/pull/commit/sync); versioned, stable contract.')), cell(ph('owner')), cell(ph('July 2026'))]),
  row([cell(b('Telemetry / App Insights')), cell(t('Structured deployment events (schema’d, queryable) to power the closed-loop diagnostics in the orchestrator.')), cell(ph('owner')), cell(ph('by-when'))]),
  row([cell(b('Docs / PM')), cell(t('Single recommended ALM pattern published across FastTrack / PowerCAT / Pro-Dev; retire contradictory guidance.')), cell(ph('owner')), cell(ph('August 2026'))]),
]));
kids.push(field('Callout — what I’m asking for in this room', t('Name an owner per row and agree a by-when. These five unblock convergence (Phase 4); without them, the spokes stay loosely coupled and the “one pattern” promise can’t hold.')));
kids.push(notesLabel());
kids.push(note(t('This is the action slide — don’t leave the room without owners named against at least the top three rows (Platform, Pipelines, PAC CLI). Those three are on the critical path for Phase 2/3 landing in July.')));
kids.push(note(t('Telemetry and Docs/PM are convergence-enablers (Phase 4) — important but not July-blocking. Frame them as “start now so we’re ready when Phase 2/3 land.”')));
kids.push(note([t('Have a fallback ask ready: if an owner can’t be named live, ask for a delegate to follow up within '), ph('N'), t(' business days. Movement beats perfection here.')]));

// ============================================================
// SLIDE 9
kids.push(slideH(9, 'Risks & Mitigations'));
kids.push(field('Lead', t('The three risks most likely to derail convergence — each with a concrete mitigation already in the design, not a hope.')));
kids.push(tbl([
  headRow(['Risk', 'Mitigation', 'Likelihood', 'Impact'], [30, 42, 14, 14]),
  row([cell(b('Sync conflicts in Native Git — concurrent edits in Dataverse and Git drift into off-sync states.')), cell(t('Sequence the rollout: land the clean ADO Connect scenario first, prove reliable two-way sync, then tackle complex multi-user/conflict scenarios. Pre-commit validation + component-level diffs surface conflicts early.')), cell(ph('M')), cell(ph('H'))]),
  row([cell(b('AI orchestrator hallucinating destructive actions — a wrong plan deletes or overwrites production state.')), cell(t('/plan-alm shows the full plan before execution + human approval gates at every state-changing step + idempotency (re-runs are safe, partial runs resume). No unattended destructive ops at GA.')), cell(ph('L')), cell(ph('H'))]),
  row([cell(b('Customer confusion across PAC CLI / Power Pipelines / ADO Pipelines / GitHub Actions — perceived as competing answers.')), cell(t('Hub-and-spoke framing + one recommended pattern per persona (maker → Power Pipelines; enterprise → ADO or GitHub Actions; automation → PAC CLI), all driven by the same orchestrator. Docs/PM dependency (Slide 8) makes it official.')), cell(ph('M')), cell(ph('M'))]),
]));
kids.push(field('Callout — cross-cutting safeguard', t('The three architectural guarantees — idempotent, resumable, auditable — are the common mitigation thread. They turn “scary AI deploy” into “reviewable, reversible, traceable AI deploy.”')));
kids.push(notesLabel());
kids.push(note([t('Lead with the AI-destructive-action risk — it’s the one this audience worries about most, and we have the strongest answer: plan-then-approve plus idempotency. “The AI never does anything you didn’t see and approve, and if it half-finishes, re-running is safe.”')]));
kids.push(note([t('For the sync-conflict risk, the sequencing message matters: we are '), em('not'), t(' attempting the hardest multi-user conflict case first. Clean ADO Connect scenario proves the contract, then we expand.')]));
kids.push(note(t('The confusion risk is half-technical, half-comms — that’s why the Docs/PM ask in Slide 8 is paired here. Likelihood/impact cells are editable placeholders; set them with the team’s real risk-scoring rubric.')));

// ============================================================
// SLIDE 10
kids.push(slideH(10, 'Closing — Summary'));
kids.push(field('Thesis (restated)', t('The '), b('site'), t(' is the unit of ALM; '), b('Git'), t(' is the unit of change; '), b('AI'), t(' is the orchestrator that removes the room to get it wrong. Reliability comes from '), b('stabilizing'), t(' the solution boundary, not shrinking it.')));
kids.push(field('You are here', t('Jun 2026 — between Phase 0 (Jan 2026, done), Phase 1 (May 2026, done), the Phase 2+3 pair (Jul 2026, in progress), and Phase 4 (Directional).')));
kids.push(H3('What shipped'));
kids.push(P(t('Solution Explorer for Pages (Jan 2026) and the AI-first outer loop (May 2026). A maker can already go from “deploy Dev → Prod” intent to a validated production deployment — no PPAC click-throughs.')));
kids.push(H3('What ships in July'));
kids.push(P(t('Native Git for Pages (Git as source of truth, PR review, two-way sync) and the AI-first inner loop (branch → edit → validate → commit → PR), with the same idempotency guarantees as the outer loop.')));
kids.push(H3('What it unlocks'));
kids.push(P(t('Convergence: one end-to-end path — intent → orchestrator → Git PR → pipeline → managed upgrade → validation → rollback — plus enterprise governance. The path to enterprise-grade ALM.')));
kids.push(field('The ask', t('Name owners against the five dependencies (Slide 8) so Phase 2/3 land on time and Phase 4 convergence can begin on a measured foundation.')));
kids.push(notesLabel());
kids.push(note(t('Close by restating the thesis verbatim — bookend the deck. Then the three-sentence summary: shipped (outer loop), shipping July (Git + inner loop), unlocks (convergence → enterprise-grade ALM).')));
kids.push(note(t('Point physically at the “you are here” marker — June 2026, between two GA’d phases and the July pair. The narrative is momentum: two done, two imminent, one directional.')));
kids.push(note(t('End on the ask, not the vision. The single outcome that makes this meeting worth it is named owners against the Slide 8 dependencies. Drive to that.')));

// ============================================================
const doc = new Document({
  creator: 'Nidhi Tyagi',
  title: 'Power Pages ALM — End-State Architecture & Milestone Walkthrough',
  description: 'Editing source document for the leadership presentation deck',
  styles: {
    default: { document: { run: { font: 'Segoe UI', size: 21, color: INK } } },
  },
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
    children: kids,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  const out = process.argv[2] || 'powerpages-alm-milestones.docx';
  fs.writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes,', kids.length, 'blocks');
});
