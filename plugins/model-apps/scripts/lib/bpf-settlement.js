'use strict';
// Declared business process flows (`businessProcessFlows[].reconcile: "declared"`) on the managed settlement layer.
//
// OWNERSHIP. A flow is one `workflows` row (category 4, type 1) whose stages and steps live in its XAML. Unlike a
// business rule's nodes, a stage and a step keep the id they were written with, so the group binds the whole graph:
// the root (`bpf`, the workflow GUID), one `bpfStage` record per stage (`stage:<stage key>`) and one `bpfStep` record per
// step (`step:<stage key>/<step key>`, under its stage). Every id comes from the create catalog BEFORE any local SDK
// edit or request: the workflow id and stage ids under the flow's id, and a step id under ITS stage's id — the stage
// reserved in the same call (a new stage), or the stage GUID the group holds (a step added to a stage that exists).
// A retry in a fresh workspace therefore derives the same ids, and a write whose answer was lost is proved at them.
// The group's consumer state keeps the declaration, what it applied (by key) and the flow's stored backing table
// name; the key -> id map is in `stages`. Content is never evidence of ownership: a live flow that differs from the
// proof is `bpf-drift` before any request that could change it, and only a complete read-only re-adoption
// (`bpf:<table>/<name>`, with a declaration that names the whole current flow in order) records it again.
//
// STRUCTURE. A structural declaration names its stages and steps with explicit keys. A declaration that omits a held
// stage or step, or reorders them, refuses the WHOLE operation (`bpf-structure-refused`), the metadata included, before
// any request. Allowed: new stages and steps at any position, a key-preserving rename, a step's column and required
// flag, and the description and order. A metadata-only declaration of a managed flow may omit `stages`. Branching,
// stage actions and a stage on another table are not managed (`bpf-shape-unsupported`).
//
// CREATE AND EDIT (the existing-workflow edit gate, as for rules). A new flow is created Draft with ONE
// `POST workflows` whose XAML carries every reserved id, proved by a fresh read (the row, the declared table, every
// expected child id and exactly the projection that was sent) and then activated by its own state-only write. A
// substituted or missing child id is `create-completion-required` whether or not the POST was acknowledged, and
// nothing is bound. Any change to a flow that already exists refuses before any workflow request with
// `workflow-edit-refused` unless `opts.workflowConditionalEdits` is on. With the switch, an Active flow is edited as
// three effects — Draft, body, Active — each conditioned on the version its own proof read returned (an Active
// flow's SDK push is a `$batch` the effect gate cannot read whole, so it is never sent); a state-only change is ONE
// conditional state write with no definition push. The gate also holds on every recovery path: with the switch off a
// re-run may prove by reading that an earlier write landed, but it sends nothing to an existing flow. A declaration
// that changes nothing of the workflow but differs from the one the group recorded (its `securityRoles`, say) is a
// declaration-only change: no workflow request, and a commit that records it as the group's original declaration,
// the one the managed download restores.
//
// WHAT A RE-RUN MAY DO. Only the exact unresolved create of an attempt continues as a create; an absent row is never
// permission to create again, and a missing adopted flow stops. A write whose answer was lost, or that was answered
// with a generic 4xx/5xx, is `unconfirmed` (an answer is not proof that nothing started): it is proved by reading and
// never sent again. Only a 412 to a write that carried If-Match is a request-specific refusal that proves no start. A
// create that no 2xx acknowledged is activated and bound only with the flow's typed adoption approval
// (`managed-adoption-required`, the attempt kept). The SDK's local copy is checked first on every path, and a copy with
// unsent edits stops everything (`create-completion-required`, category `workspace-copy-unsent-edits`). The live XAML
// is walked against the shape this module writes before any live flow is accepted: a foreign activity, a branch or a
// stage action anywhere refuses (`bpf-shape-unsupported`) before any mutation, metadata-only edits and adoption included.
//
// Nothing here publishes: activating a flow is a state change, not PublishXml.

const { intentSha256, normalizeGuid, isApproved } = require('./reconcile-common.js');
const { runManagedFeature } = require('./managed-feature-contract.js');
const { requestBodySha256 } = require('./workflow-effect-context.js');
const { identityFor, reserveChildren } = require('./creates-catalog.js');
const { uuidV5 } = require('./creates-identity.js');
const { CODES, rootCreateAcknowledged } = require('./managed-bindings.js');
const { createWorkflowDriver, createCopyGuard, answeredRefusal, coded, completionBytesFor, completionWithin, HASH_BOUND, NAME_BOUND, ACTIVE, DRAFT } = require('./workflow-drive.js');

// sdk-build is required lazily: it is the module that will call this one, so a top-level require would be a cycle.
const { markFreshTable, isFreshTableReadLag } = require('./retry-policy.js');
const sdkBuild = () => require('./sdk-build.js');

const FAMILY = 'bpf';
const ROOT_KIND = 'bpf';
const ARTIFACT = 'bpf';
const PROOF_SCHEMA = 'bpf/declared-1';
const DEFAULT_ORDER = 100;
const MAX_DESCRIPTION = 2000;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// `securityRoles` is granted by the build from the stored backing table this module returns, never written here.
const FLOW_KEYS = ['name', 'entity', 'reconcile', 'description', 'status', 'order', 'stages', 'securityRoles'];
const STAGE_KEYS = ['key', 'name', 'entity', 'steps'];
const STEP_KEYS = ['key', 'name', 'field', 'required'];
// The PATCH body the SDK sends for a Draft flow's push is these fields of the prepared record, when defined (measured
// with the vendored bundle: GET workflows(<id>)?$select=…, then PATCH workflows(<id>) with exactly these keys).
const PATCH_FIELDS = ['xaml', 'name', 'description', 'processorder'];
const EDIT_REFUSED_REMEDY = 'A declared process flow can be created and adopted read-only; changing one that already exists stays off until '
  + 'conditional writes are enabled, because a local lock cannot stop another session changing the flow between the read and the write. '
  + 'Change the flow in the maker, then re-adopt it with a declaration that names its whole current body.';

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404 || (err.cause && (err.cause.statusCode === 404 || err.cause.status === 404)));
const isDeclaredBpf = (flow) => !!flow && flow.reconcile === 'declared';
const tableOf = (flow) => lc(flow && flow.entity);
const bpfKey = (flow) => `${tableOf(flow)}/${String((flow && flow.name) || '')}`;
const stageLocator = (k) => `stage:${k}`;
const stepLocator = (sk, k) => `step:${sk}/${k}`;
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;

// ---------------------------------------------------------------------------------------------------------------
// The declaration.

function validateDeclaredBpf(flow) {
  const errors = [];
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return ['a declared process flow must be an object'];
  for (const k of Object.keys(flow)) if (!FLOW_KEYS.includes(k)) errors.push(`"${k}" is not managed on a declared process flow`);
  if (!nonempty(flow.name)) errors.push('name is required');
  if (!nonempty(flow.entity)) errors.push('entity is required');
  if (flow.description !== undefined && (typeof flow.description !== 'string' || flow.description.length > MAX_DESCRIPTION)) {
    errors.push(`description must be text of at most ${MAX_DESCRIPTION} characters`);
  }
  if (flow.order !== undefined && !(Number.isInteger(flow.order) && flow.order >= 0)) errors.push('order must be a whole number of 0 or more');
  if (flow.status !== undefined && flow.status !== ACTIVE && flow.status !== DRAFT) errors.push('status must be Active or Draft');
  if (flow.stages === undefined) return errors;
  if (!Array.isArray(flow.stages) || !flow.stages.length) return [...errors, 'stages, when given, must list at least one stage'];
  const stageKeys = new Set();
  flow.stages.forEach((st, i) => {
    const at = `stages[${i}]`;
    if (!st || typeof st !== 'object' || Array.isArray(st)) { errors.push(`${at} must be an object`); return; }
    for (const k of Object.keys(st)) {
      if (!STAGE_KEYS.includes(k)) errors.push(`${at}: "${k}" is not managed (branching, stage actions and other stage settings are refused)`);
    }
    if (typeof st.key !== 'string' || !KEY_RE.test(st.key)) errors.push(`${at}: a declared stage needs a key (letters, digits, "_", "-", "."; at most 64)`);
    else if (stageKeys.has(st.key)) errors.push(`${at}: the stage key "${st.key}" is used twice`);
    else stageKeys.add(st.key);
    if (!nonempty(st.name)) errors.push(`${at}: name is required`);
    if (st.entity !== undefined && lc(st.entity) !== tableOf(flow)) errors.push(`${at}: a stage on another table is not managed`);
    if (!Array.isArray(st.steps)) { errors.push(`${at}: steps must be a list`); return; }
    const stepKeys = new Set();
    st.steps.forEach((p, j) => {
      const sat = `${at}.steps[${j}]`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push(`${sat} must be an object`); return; }
      for (const k of Object.keys(p)) if (!STEP_KEYS.includes(k)) errors.push(`${sat}: "${k}" is not managed`);
      if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) errors.push(`${sat}: a declared step needs a key`);
      else if (stepKeys.has(p.key)) errors.push(`${sat}: the step key "${p.key}" is used twice in its stage`);
      else stepKeys.add(p.key);
      if (!nonempty(p.name)) errors.push(`${sat}: name is required`);
      if (!nonempty(p.field)) errors.push(`${sat}: field is required`);
      if (p.required !== undefined && typeof p.required !== 'boolean') errors.push(`${sat}: required must be true or false`);
    });
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// The flow as this module compares it.

// ---------------------------------------------------------------------------------------------------------------
// The flow's retained XAML.

/*
 * The vendored SDK keeps a fetched flow's XAML as a parsed tree on `art.bag.xaml`: the document element's attributes
 * and children, `{ a: [[name, value], …], c: [child, …] }`, where a child is an element `{ n, a, c }` (or `{ i, node }`
 * around one) and text is `{ n: '#text', … }`. A linear flow the SDK writes (and a maker's linear flow) is, with text
 * omitted:
 *   x:Members > x:Property*                       this:XrmWorkflow<id>.InputEntities|CreatedEntities > InArgument
 *   mva:VisualBasic.Settings                      mxswa:Workflow > one EntityComposite:
 *   mxswa:ActivityReference AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.EntityComposite, …"
 *     mxswa:ActivityReference.Properties
 *       sco:Collection x:Key=Variables (empty)    sco:Collection x:Key=Activities > StageComposite*
 *       x:Null|x:String x:Key=RelationshipName, AttributeName      x:Boolean x:Key=IsClosedLoop
 *   StageComposite > Properties: Variables (empty), Activities > StepComposite*, StepLabels > mcwo:StepLabel*,
 *                                StageId, StageCategory, NextStageId
 *   StepComposite  > Properties: Variables (empty), Activities > Sequence > mcwb:Control*,
 *                                StepLabels > mcwo:StepLabel*, ProcessStepId, IsProcessRequired
 *   mcwb:Control   > mcwb:Control.<property> > InArgument > Literal | x:Null
 * Anything else — another activity in any Activities collection, a stage action, a condition, a Variables entry, an
 * unknown property — is a shape this module does not manage. The check is an allowlist: what it does not name refuses.
 *
 * A control step is recognised by its structure (a `Sequence` whose only children are `mcwb:Control` activities), not
 * by its DisplayName: the SDK and the designer write "ControlStep4", but the name is presentation only and a maker may
 * rename or drop it.
 *
 * Character content is checked as well as elements, because XAML carries meaning in text too: an argument written
 *   <InArgument x:TypeArguments="x:String">[System.DateTime.UtcNow.ToString()]</InArgument>
 * is a Visual Basic expression the SDK neither models nor reports, and a metadata-only edit would push it back
 * unchanged. Whitespace between elements is benign (an indented XAML has it everywhere). Other text is allowed only
 * where it is a plain value: an `x:String` leaf, an `x:Boolean` leaf of True/False, and the fixed placeholder sentence
 * the designer writes into `mva:VisualBasic.Settings`. A control argument is one of the forms in `controlArgError`.
 */
const WF_ACTIVITY = 'Microsoft.Crm.Workflow.Activities.';
const LEAF_TAGS = ['x:Null', 'x:String', 'x:Boolean'];
const COMPOSITE_PROPS = {
  EntityComposite: { Variables: 'empty', Activities: 'StageComposite', RelationshipName: 'leaf', AttributeName: 'leaf', IsClosedLoop: 'leaf' },
  StageComposite: { Variables: 'empty', Activities: 'StepComposite', StepLabels: 'labels', StageId: 'leaf', StageCategory: 'leaf', NextStageId: 'leaf' },
  StepComposite: { Variables: 'empty', Activities: 'ControlStep', StepLabels: 'labels', ProcessStepId: 'leaf', IsProcessRequired: 'leaf' },
};
const xNode = (c) => (c && c.node) || c;
const xElements = (n) => ((n && n.c) || []).map(xNode).filter((c) => c && typeof c.n === 'string' && !c.n.startsWith('#'));
const xAttr = (n, k) => { const hit = ((n && n.a) || []).find((p) => Array.isArray(p) && p[0] === k); return hit ? String(hit[1]) : null; };
// The attributes that carry a value. `#…` keys are the SDK's own bookkeeping (e.g. `#empty` on a self-closing element)
// and `xmlns…` keys declare namespaces; neither is a value of the flow.
const xValueAttrs = (n) => ((n && n.a) || []).filter((p) => Array.isArray(p) && !String(p[0]).startsWith('#') && !/^xmlns(:|$)/.test(String(p[0])));
// The concatenated text directly inside an element. A text node is `{ n: '#text', a: [['#text', value]] }`.
const xText = (n) => ((n && n.c) || []).map(xNode).filter((c) => c && c.n === '#text').map((c) => xAttr(c, '#text') || '').join('');
const VB_SETTINGS_TEXT = 'Assembly references and imported namespaces for internal implementation';

/** Why some node of a retained XAML tree holds content this module does not manage; null when none does. */
function contentError(el) {
  for (const c of ((el && el.c) || []).map(xNode)) {
    if (!c || typeof c.n !== 'string') return 'its XAML holds a node this module cannot read';
    if (c.n === '#text') continue;
    // The SDK's tree keeps elements and text only today; a comment or CDATA node reaching it is refused, not skipped.
    if (c.n.startsWith('#')) return `its XAML holds a ${c.n.slice(1)} node, which this module does not manage`;
    const why = contentError(c);
    if (why) return why;
  }
  const text = xText(el).trim();
  if (!text) return null;
  if (el.n === 'x:String') return null;
  if (el.n === 'x:Boolean' && /^(true|false)$/i.test(text)) return null;
  if (el.n === 'mva:VisualBasic.Settings' && text === VB_SETTINGS_TEXT) return null;
  return `its XAML holds text in <${el.n || 'the document'}> (an expression or a value this module does not manage)`;
}

// A control's own attributes: its identity and flags, and the four arguments the designer may also write inline.
const CONTROL_FLAGS = new Set(['ControlId', 'IsSystemControl', 'IsUnbound', 'SystemStepType']);
const CONTROL_ARGS = new Set(['ClassId', 'ControlDisplayName', 'DataFieldName', 'Parameters']);
// In attribute form a XAML argument value is a literal unless it opens an expression (`[…]`, Visual Basic) or a markup
// extension (`{…}`, including the `{}` escape); `{x:Null}` is the one extension that is a plain null.
const isPlainArgText = (v) => v === '{x:Null}' || !/^\s*[[{]/.test(v);

/**
 * Why a control's argument is not a supported form; null when it is. The supported forms are:
 *   <mcwb:Control.P />                                                       no value
 *   <mcwb:Control.P><InArgument x:TypeArguments="T" /></mcwb:Control.P>      an empty argument
 *   <mcwb:Control.P><InArgument x:TypeArguments="T"><Literal x:TypeArguments="T" Value="…" /></InArgument></…>
 *   <mcwb:Control.P><InArgument x:TypeArguments="T"><x:Null /></InArgument></mcwb:Control.P>
 * Text in the argument (an expression), any other value activity, a second value or argument, or an attribute outside
 * these is not a form this module manages.
 */
function controlArgError(cp) {
  if (!cp.n.startsWith('mcwb:Control.') || xValueAttrs(cp).length || xText(cp).trim()) return 'a control step carries a value this module does not manage';
  const args = xElements(cp);
  if (args.length > 1) return 'a control step carries a value this module does not manage';
  for (const arg of args) {
    if (arg.n !== 'InArgument' || xValueAttrs(arg).some(([k]) => k !== 'x:TypeArguments')) return 'a control step carries a value this module does not manage';
    if (xText(arg).trim()) return 'a control step carries an expression, which this module does not manage';
    const values = xElements(arg);
    if (values.length > 1) return 'a control step carries a value this module does not manage';
    for (const v of values) {
      const literal = v.n === 'Literal' && xValueAttrs(v).every(([k, val]) => k === 'x:TypeArguments' || (k === 'Value' && !/^\s*\{/.test(String(val))));
      const nil = v.n === 'x:Null' && !xValueAttrs(v).length;
      if (!(literal || nil) || xElements(v).length || xText(v).trim()) return 'a control step carries a value this module does not manage';
    }
  }
  return null;
}

/** Why one entry of a step's Activities collection is not a control step; null when it is. */
function controlStepError(seq) {
  if (seq.n !== 'Sequence') return `a step holds <${seq.n}>, which this module does not manage (only a control step is)`;
  if (xValueAttrs(seq).some(([k]) => k !== 'DisplayName')) return 'a control step carries settings this module does not manage';
  for (const ctl of xElements(seq)) {
    if (ctl.n !== 'mcwb:Control') return `a control step holds <${ctl.n}>, which this module does not manage`;
    for (const [k, v] of xValueAttrs(ctl)) {
      if (CONTROL_FLAGS.has(k)) continue;
      if (!CONTROL_ARGS.has(k) || !isPlainArgText(String(v))) return 'a control step carries a value this module does not manage';
    }
    for (const cp of xElements(ctl)) {
      const why = controlArgError(cp);
      if (why) return why;
    }
  }
  return null;
}

/** Every `ControlId` a retained XAML tree holds, lower-cased. */
function controlIdsOf(tree) {
  const out = new Set();
  const walk = (n) => { for (const el of xElements(n)) { const v = xAttr(el, 'ControlId'); if (v) out.add(v.toLowerCase()); walk(el); } };
  if (tree && typeof tree === 'object') walk(tree);
  return out;
}
/*
 * The SDK mints a random `ControlId` for each control step it writes into new XAML (a fresh GUID per prepare), so staging
 * the same declaration twice gives two different bodies:
 *   <mcwb:Control ControlId="a6e5bd68-…" IsSystemControl="False" …>   then, from another process,   ControlId="11dcf977-…"
 * A create or edit that a later run sends again under its recorded token must be byte-identical to the body whose
 * sha256 the effect recorded (the send gate refuses anything else), so every ControlId the base row did not already
 * hold is replaced, in document order, by one derived from the flow's id, its ordinal and the held set. Held ids are
 * never touched: they are the live row's own. Each id appears once in the XAML, as that attribute value only.
 */
function settleControlIds(rec, id, held) {
  if (typeof rec.xaml !== 'string') return;
  const base = [...held].sort();
  let n = 0;
  rec.xaml = rec.xaml.replace(/ControlId="([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"/g, (whole, v) => {
    if (held.has(v.toLowerCase())) return whole;
    const fixed = uuidV5(normalizeGuid(id), JSON.stringify(['bpf-control', 1, n, ...base]));
    n += 1;
    return `ControlId="${fixed}"`;
  });
}

/** Why a retained XAML tree is not a linear flow of stages and control steps; null when it is. */
function xamlShapeError(xaml) {
  if (!xaml || typeof xaml !== 'object' || !Array.isArray(xaml.c)) return 'its XAML could not be read as a linear flow';
  const content = contentError(xaml);
  if (content) return content;
  const workflows = [];
  for (const el of xElements(xaml)) {
    if (el.n === 'x:Members') {
      if (xElements(el).some((p) => p.n !== 'x:Property')) return 'its XAML declares members this module does not manage';
    } else if (/^this:XrmWorkflow[0-9A-Fa-f]*\.(InputEntities|CreatedEntities)$/.test(el.n)) {
      if (xElements(el).some((p) => p.n !== 'InArgument' || xElements(p).length)) return 'its XAML carries workflow arguments this module does not manage';
    } else if (el.n === 'mva:VisualBasic.Settings') {
      if (xElements(el).length) return 'its XAML carries expression settings this module does not manage';
    } else if (el.n === 'mxswa:Workflow') {
      workflows.push(el);
    } else {
      return `its XAML carries <${el.n}>, which this module does not manage`;
    }
  }
  if (workflows.length !== 1) return 'its XAML does not hold exactly one workflow';
  const top = xElements(workflows[0]);
  if (top.length !== 1) return 'its workflow does not hold exactly one entity step';
  return compositeError(top[0], 'EntityComposite');
}

function compositeError(el, kind) {
  const aqn = xAttr(el, 'AssemblyQualifiedName') || '';
  if (el.n !== 'mxswa:ActivityReference' || !aqn.startsWith(`${WF_ACTIVITY}${kind},`)) {
    const what = el.n === 'mxswa:ActivityReference' ? aqn.split(',')[0].replace(WF_ACTIVITY, '') || 'an activity' : `<${el.n}>`;
    return `a ${kind === 'StageComposite' ? 'flow' : kind === 'StepComposite' ? 'stage' : 'process'} holds ${what}, which this module does not manage (only stages of control steps are)`;
  }
  const kids = xElements(el);
  if (kids.length !== 1 || kids[0].n !== 'mxswa:ActivityReference.Properties') return `a ${kind} carries settings this module does not manage`;
  const allowed = COMPOSITE_PROPS[kind];
  const seen = new Set();
  for (const prop of xElements(kids[0])) {
    const k = xAttr(prop, 'x:Key');
    const rule = k && allowed[k];
    if (!rule || seen.has(k)) return `a ${kind} carries the property ${k || `<${prop.n}>`}, which this module does not manage`;
    seen.add(k);
    const items = xElements(prop);
    if (rule === 'leaf') {
      if (!LEAF_TAGS.includes(prop.n) || items.length) return `a ${kind} property ${k} is not a plain value`;
    } else if (prop.n !== 'sco:Collection') {
      return `a ${kind} property ${k} is not a collection`;
    } else if (rule === 'empty') {
      if (items.length) return `a ${kind} declares variables, which this module does not manage`;
    } else if (rule === 'labels') {
      if (items.some((x) => x.n !== 'mcwo:StepLabel' || xElements(x).length)) return `a ${kind} carries labels this module does not manage`;
    } else if (rule === 'ControlStep') {
      for (const seq of items) {
        const why = controlStepError(seq);
        if (why) return why;
      }
    } else {
      for (const child of items) {
        const why = compositeError(child, rule);
        if (why) return why;
      }
    }
  }
  return null;
}

/**
 * The projection of an SDK BpfArtifact, e.g. (fetchArtifact('bpf', id) with the vendored bundle):
 *   { id, name, entityLogicalName, status: 'Active'|'Draft', order: 100, uniqueName: 'new_ticketflow', description?,
 *     stages: [ { id, name, entityLogicalName, category?, nextStageId?, steps: [ { id, name, fieldName?, required? } ] } ] }
 * `description` is present only when the row has a non-empty one, and `order` reads 100 when it was never set. A stage
 * with a `nextStageId` other than the following stage (a branch) or on another table is not a shape this module manages. The status is kept apart
 * (`savedShaOf`) because a state change is its own write; `uniqueName` (the backing table) is kept apart because the
 * SDK's parse of a request record does not carry it.
 */
function projectBpf(art) {
  // The SDK's stages and steps are a lossy view of the XAML: an activity it does not model (a stage action, a workflow
  // step, an opaque Sequence) is kept in the artifact's retained XAML and pushed back unchanged. The retained tree is
  // checked against the linear stage/step shape first, so no write — a metadata-only edit or an adoption included —
  // can be built on a flow that carries anything else.
  const xamlError = xamlShapeError(art && art.bag && art.bag.xaml);
  if (xamlError) return { unsupported: xamlError };
  const entity = lc(art && art.entityLogicalName);
  const stages = [];
  const raw = (art && art.stages) || [];
  for (const [i, st] of raw.entries()) {
    // The SDK reports each stage's next-stage pointer. In a linear flow it names the following stage and the last
    // stage has none; any other pointer is a branch.
    const following = raw[i + 1] ? lc(raw[i + 1].id) : null;
    if (st.nextStageId && lc(st.nextStageId) !== following) return { unsupported: 'the flow branches' };
    if (lc(st.entityLogicalName) !== entity) return { unsupported: 'a stage is on another table' };
    stages.push({
      id: lc(st.id),
      name: String(st.name == null ? '' : st.name),
      category: st.category === undefined ? null : st.category,
      steps: (st.steps || []).map((p) => ({ id: lc(p.id), name: String(p.name == null ? '' : p.name), field: lc(p.fieldName), required: p.required === true })),
    });
  }
  const projection = {
    name: String(art.name == null ? '' : art.name),
    entity,
    description: typeof art.description === 'string' ? art.description : '',
    order: art.order === undefined || art.order === null ? DEFAULT_ORDER : Number(art.order),
    stages,
  };
  return {
    projection,
    status: art.status === ACTIVE ? ACTIVE : DRAFT,
    hasDescription: typeof art.description === 'string' && art.description !== '',
    uniqueName: nonempty(art.uniqueName) ? String(art.uniqueName) : null,
  };
}

const savedShaOf = (projection, status) => intentSha256({ projection, status });
// What the row keeps that a declaration cannot state (each stage's category), in stage order.
const preservationOf = (projection) => intentSha256(projection.stages.map((s) => ({ id: s.id, category: s.category })));

/** The key -> id map of a declaration laid over a flow whose stages and steps are in declaration order. */
function positionalMap(flow, projection) {
  return flow.stages.map((st, i) => ({
    key: st.key,
    id: projection.stages[i].id,
    steps: st.steps.map((p, j) => ({ key: p.key, id: projection.stages[i].steps[j].id })),
  }));
}

/** Whether every id of `map` is where the map says in `projection` (the whole flow is managed, so every live part). */
function mapFits(map, projection) {
  if (map.length !== projection.stages.length) return false;
  return map.every((s, i) => s.id === projection.stages[i].id && s.steps.length === projection.stages[i].steps.length
    && s.steps.every((p, j) => p.id === projection.stages[i].steps[j].id));
}

/** What the group applied, by key: the declaration's effective flow as it was proved. */
function appliedOf(view, map) {
  const p = view.projection;
  return {
    description: p.description,
    order: p.order,
    status: view.status,
    stages: map.map((s) => {
      const live = p.stages.find((x) => x.id === s.id);
      return {
        key: s.key,
        name: live.name,
        steps: s.steps.map((t) => {
          const lt = live.steps.find((x) => x.id === t.id);
          return { key: t.key, name: lt.name, field: lt.field, required: lt.required };
        }),
      };
    }),
  };
}

/** Why the declaration changes the flow the group holds; [] when it does not. An omitted part keeps its live value. */
function editsOf(applied, flow) {
  const out = [];
  if (flow.description !== undefined && flow.description !== applied.description) out.push('changes the description');
  if (flow.order !== undefined && flow.order !== applied.order) out.push('changes the order');
  if (flow.status !== undefined && flow.status !== applied.status) out.push(`sets the flow ${flow.status}`);
  for (const st of flow.stages || []) {
    const held = applied.stages.find((s) => s.key === st.key);
    if (!held) { out.push(`adds the stage "${st.key}"`); continue; }
    if (held.name !== st.name) out.push(`renames the stage "${st.key}"`);
    for (const p of st.steps) {
      const h = held.steps.find((x) => x.key === p.key);
      if (!h) out.push(`adds the step "${st.key}/${p.key}"`);
      else if (h.name !== p.name || h.field !== lc(p.field) || h.required !== (p.required === true)) out.push(`changes the step "${st.key}/${p.key}"`);
    }
  }
  return out;
}

/**
 * The structural refusals of a declaration against the stages the group holds: a held stage or step the declaration
 * omits, or held ones it puts in another order. Nothing is ever removed or moved, so either refuses the whole operation.
 */
function structureErrors(map, flow) {
  if (flow.stages === undefined) return [];
  const errs = [];
  const declared = flow.stages.map((s) => s.key);
  for (const s of map) if (!declared.includes(s.key)) errs.push(`omits the stage "${s.key}"`);
  const kept = declared.filter((k) => map.some((s) => s.key === k));
  if (!errs.length && kept.join('\u0000') !== map.map((s) => s.key).join('\u0000')) errs.push('puts its stages in another order');
  for (const s of map) {
    const st = flow.stages.find((x) => x.key === s.key);
    if (!st) continue;
    const keys = st.steps.map((p) => p.key);
    const missing = s.steps.filter((p) => !keys.includes(p.key));
    for (const p of missing) errs.push(`omits the step "${s.key}/${p.key}"`);
    const keptSteps = keys.filter((k) => s.steps.some((p) => p.key === k));
    if (!missing.length && keptSteps.join('\u0000') !== s.steps.map((p) => p.key).join('\u0000')) errs.push(`puts the steps of "${s.key}" in another order`);
  }
  return errs;
}

/** Why a read-only adoption cannot record `view` for this declaration; [] when the declaration names it whole. */
function wholeBodyErrors(flow, view) {
  const p = view.projection;
  const errs = [];
  if (!Array.isArray(flow.stages)) return ['the declaration names no stages'];
  if (flow.description !== undefined && flow.description !== p.description) errs.push('its description differs');
  if (flow.order !== undefined && flow.order !== p.order) errs.push('its order differs');
  if (flow.status !== undefined && flow.status !== view.status) errs.push(`it is ${view.status}`);
  if (flow.stages.length !== p.stages.length) return [...errs, `it has ${p.stages.length} stages and the declaration names ${flow.stages.length}`];
  flow.stages.forEach((st, i) => {
    const live = p.stages[i];
    if (live.name !== st.name) errs.push(`stage ${i + 1} is "${live.name}"`);
    if (live.steps.length !== st.steps.length) { errs.push(`stage "${st.key}" has ${live.steps.length} steps`); return; }
    st.steps.forEach((s, j) => {
      const l = live.steps[j];
      if (l.name !== s.name || l.field !== lc(s.field) || l.required !== (s.required === true)) errs.push(`step "${st.key}/${s.key}" differs`);
    });
  });
  return errs;
}

// ---------------------------------------------------------------------------------------------------------------
// Settlement.

/**
 * Settle one declared business process flow through runManagedFeature.
 * @param {object} input
 *   flow              the App Spec flow (`reconcile: "declared"`, every stage and step keyed)
 *   sdk               the maker SDK over the plugin's HTTP client (with the workflow effect gate)
 *   store             the managed binding handle (opened with the publication barrier)
 *   catalog           the plan's create-intent catalog; the flow's entry is { catalogKind: 'bpf', key: '<table>/<name>' }
 *   approvals         the build's approval set; `bpf:<table>/<name>` (adopt) approves a complete read-only adoption
 *   opts              { workflowConditionalEdits?: true } turns on the edit path (off by default; the skill never writes it)
 *   halt              the build's halt factory (managedStop)
 *   ensureMembership  ({ root, records, recovering }) => solution membership of the workflow
 *   phase, label, barrier
 *   httpClient, instanceUrl  needed for every state change, which carries If-Match: the default activation of the
 *                     attempt's own create as well as the edit path. Without them no activation is sent
 *   sendObserver      the build's createAttemptSendObserver, installed on the transport sdk and httpClient send through
 *                     (runManagedFeature): an attempt whose window shows nothing sent is continued under its own token
 * @returns {{ committed?: true, recovered?: boolean, noop?: true, id: string, uniqueName: string|null }} where
 *   `uniqueName` is the backing table the platform STORED for the flow (read back, never recomputed from its name):
 *   what security-role grants and the app's components must use.
 */
async function settleDeclaredBpf(input) {
  const { flow, sdk, store, catalog, approvals = null, opts = {}, halt, phase = 'business-process-flows', barrier, httpClient = null, instanceUrl = null, sendObserver = null, freshTable = null, retryFreshRead = null } = input || {};
  const ensureMembership = (input && input.ensureMembership) || (async () => {});
  if (!isDeclaredBpf(flow)) throw coded(CODES.notSettled, 'settleDeclaredBpf takes a flow with reconcile: "declared"');
  if (!store || typeof store.snapshot !== 'function') throw coded(CODES.notSettled, 'settleDeclaredBpf needs the managed binding store');
  const key = bpfKey(flow);
  const table = tableOf(flow);
  const label = (input && input.label) || `declared business process flow "${flow.name}" on ${table}`;
  const approved = isApproved(approvals, FAMILY, key);
  const switchOn = opts.workflowConditionalEdits === true;
  const declarationSha256 = intentSha256(flow);
  const head = store.snapshot().envelope;
  const record = (kind, k, id, origin, parentKey) => ({
    formatVersion: 1, appUniqueName: head.appUniqueName, environmentFingerprint: head.environmentFingerprint,
    kind, key: k, id, intentSha256: declarationSha256, origin, ...(parentKey ? { parentKey } : {}),
  });
  const run = { token: null, committed: null };
  const { readVersion, attemptOf, effectOf, sendOnce, driveState, activateOwnCreate, refuseRecordedEdits } = createWorkflowDriver({
    store, sdk, httpClient, instanceUrl, family: FAMILY, key, label, noun: 'process flow', driftCode: 'bpf-drift',
    conditionalEdits: switchOn, editRefusedRemedy: EDIT_REFUSED_REMEDY,
  });
  // The local SDK copy is checked before anything reads over it, reseeds or deletes it (an unsent edit stops the build).
  const guard = createCopyGuard({ sdk, artifact: ARTIFACT, label, noun: 'process flow' });

  // ----- reads.
  async function readBody(id) {
    await guard.assertClean(id);
    try {
      await sdk.fetchArtifact(ARTIFACT, id, { overwrite: true });
      const art = await sdk.getArtifact(ARTIFACT, id);
      if (!art) return { missing: true };
      const view = projectBpf(art);
      if (view.unsupported) throw coded('bpf-shape-unsupported', `${label}: ${view.unsupported}; this shape is not managed (nothing is changed)`);
      // A flow an id names must be that id and the declared table's flow, or nothing of it is trusted.
      if (normalizeGuid(art.id) !== id || view.projection.entity !== table) return { missing: true, stranger: true };
      return view;
    } catch (err) {
      if (err && err.code === 'bpf-shape-unsupported') throw err;
      if (isNotFound(err)) return { missing: true };
      throw coded(CODES.notSettled, `${label}: the flow ${id} could not be read`, { cause: err });
    }
  }
  async function readLive(id) {
    const row = await readVersion(id);
    if (!row) return { missing: true };
    const view = await readBody(id);
    if (view.missing) return { missing: true, stranger: view.stranger === true };
    return { version: row.version, view };
  }

  // ----- the ids. Every child id is derived by the catalog before any local edit: under the flow's id for a stage,
  // under its stage's id for a step (the stage reserved in the same call, or the stage GUID the group holds).
  function createMap() {
    const children = [];
    for (const st of flow.stages) {
      children.push({ locator: stageLocator(st.key), childKind: 'bpfStage', keyParts: [st.key] });
      for (const p of st.steps) children.push({ locator: stepLocator(st.key, p.key), childKind: 'bpfStep', keyParts: [st.key, p.key], parentLocator: stageLocator(st.key) });
    }
    const { rootId, childIds } = reserveChildren('bpf', key, { catalog, children });
    return { id: rootId, map: flow.stages.map((st) => ({ key: st.key, id: childIds[stageLocator(st.key)], steps: st.steps.map((p) => ({ key: p.key, id: childIds[stepLocator(st.key, p.key)] })) })) };
  }
  /** The map after an edit: held ids kept, new children reserved under the flow's actual id. */
  function editedMap(id, held) {
    if (flow.stages === undefined) return held;
    const children = [];
    for (const st of flow.stages) {
      const hs = held.find((s) => s.key === st.key);
      if (!hs) children.push({ locator: stageLocator(st.key), childKind: 'bpfStage', keyParts: [st.key] });
      for (const p of st.steps) {
        if (hs && hs.steps.some((x) => x.key === p.key)) continue;
        children.push({ locator: stepLocator(st.key, p.key), childKind: 'bpfStep', keyParts: [st.key, p.key], ...(hs ? { actualParentId: hs.id } : { parentLocator: stageLocator(st.key) }) });
      }
    }
    const { childIds } = children.length ? reserveChildren('bpf', key, { catalog, actualRootId: id, children }) : { childIds: {} };
    return flow.stages.map((st) => {
      const hs = held.find((s) => s.key === st.key);
      return {
        key: st.key,
        id: hs ? hs.id : childIds[stageLocator(st.key)],
        steps: st.steps.map((p) => {
          const hp = hs && hs.steps.find((x) => x.key === p.key);
          return { key: p.key, id: hp ? hp.id : childIds[stepLocator(st.key, p.key)] };
        }),
      };
    });
  }

  // ----- local SDK staging (no request). The local copy is laid out from the declaration or the proved read, so a
  // dirty earlier copy is never pushed (and never thrown away: it was refused before this, by the copy guard).
  const stepEl = (t, p) => ({ id: t.id, name: p.name, fieldName: lc(p.field), ...(p.required === true ? { required: true } : {}) });
  async function stageCreate(id, map) {
    await guard.assertClean(id);
    guard.noteStaged(id);
    const def = sdkBuild().bpfDef(flow);
    const stages = def.stages.map((st, i) => ({ ...st, id: map[i].id, steps: st.steps.map((p, j) => ({ ...p, id: map[i].steps[j].id })) }));
    try { await sdk.deleteArtifact(ARTIFACT, id); } catch { /* no local copy */ }
    await sdk.createArtifact(ARTIFACT, { ...def, id, status: DRAFT, stages });
    return prepared(id, def.status, 'create');
  }
  // Edits on the copy the last read fetched (with overwrite): each held element is found again by id, since an insert
  // shifts every index after it, and a stage only ever gains steps, so the flow stays valid after every operation.
  // `baseStatus` is the state the flow had when the edit was planned: the drive takes an Active flow to Draft before it
  // stages again, and the edit must still end Active.
  async function stageEdit(id, view, map, baseStatus = view.status) {
    guard.noteStaged(id);
    const held = controlIdsOf((((await sdk.getArtifact(ARTIFACT, id)) || {}).bag || {}).xaml);
    const stagesNow = async () => ((await sdk.getArtifact(ARTIFACT, id)) || {}).stages || [];
    if (flow.stages !== undefined) {
      for (let i = 0; i < flow.stages.length; i += 1) {
        const st = flow.stages[i];
        const m = map[i];
        const index = (await stagesNow()).findIndex((s) => lc(s.id) === m.id);
        if (index < 0) {
          await sdk.addElement(ARTIFACT, id, '/stages', { id: m.id, name: st.name, entityLogicalName: table, steps: st.steps.map((p, j) => stepEl(m.steps[j], p)) }, { position: { index: i } });
          continue;
        }
        const stage = (await stagesNow())[index];
        if (stage.name !== st.name) await sdk.updateElement(ARTIFACT, id, `/stages/${index}/name`, st.name);
        for (let j = 0; j < st.steps.length; j += 1) {
          const p = st.steps[j];
          const steps = (await stagesNow())[index].steps || [];
          const at = steps.findIndex((s) => lc(s.id) === m.steps[j].id);
          if (at < 0) {
            await sdk.addElement(ARTIFACT, id, `/stages/${index}/steps`, stepEl(m.steps[j], p), { position: { index: j } });
            continue;
          }
          const live = steps[at];
          const patch = {};
          if (live.name !== p.name) patch.name = p.name;
          if (lc(live.fieldName) !== lc(p.field)) patch.fieldName = lc(p.field);
          if ((live.required === true) !== (p.required === true)) patch.required = p.required === true;
          if (Object.keys(patch).length) await sdk.updateElement(ARTIFACT, id, `/stages/${index}/steps/${at}`, patch);
        }
      }
    }
    const live = view.projection;
    if (flow.description !== undefined && flow.description !== live.description) {
      // A description the row does not have yet is added at the artifact root; an existing one is updated in place.
      if (!view.hasDescription) await sdk.addElement(ARTIFACT, id, '', { description: flow.description });
      else await sdk.updateElement(ARTIFACT, id, '/description', flow.description);
    }
    if (flow.order !== undefined && flow.order !== live.order) await sdk.updateElement(ARTIFACT, id, '/order', flow.order);
    return prepared(id, flow.status || baseStatus, 'edit', held);
  }
  async function prepared(id, desiredStatus, mode, held = new Set()) {
    const prep = await sdk.withArtifactLock(ARTIFACT, id, () => sdk.prepareArtifactUnlocked(ARTIFACT, id, undefined));
    const rec = prep.payload && prep.payload.record;
    if (!rec || typeof rec !== 'object') throw coded(CODES.notSettled, `${label}: the SDK prepared no workflow record`);
    settleControlIds(rec, id, held);
    // The SDK's own parser over the exact record it will send: the projection a fresh read must give back.
    const sent = projectBpf(prep.reg.adapter.fromApiResponse(clone({ ...rec, statecode: 0 })));
    if (sent.unsupported) throw coded('bpf-shape-unsupported', `${label}: ${sent.unsupported}`);
    const body = mode === 'create' ? rec : Object.fromEntries(PATCH_FIELDS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));
    return { prep, desiredSha256: requestBodySha256(body), sent, desiredStatus, version: (prep.meta && prep.meta.etag) || null };
  }

  // A staged projection must be exactly the map laid out with the declaration: a local edit the SDK took differently
  // is caught here, before anything is sent.
  function checkStaged(sent, map) {
    if (flow.stages === undefined) return;
    if (!mapFits(map, sent.projection) || flow.stages.some((st, i) => sent.projection.stages[i].name !== st.name
      || st.steps.some((p, j) => { const s = sent.projection.stages[i].steps[j]; return s.name !== p.name || s.field !== lc(p.field) || s.required !== (p.required === true); }))) {
      throw coded(CODES.notSettled, `${label}: the SDK staged another flow than the declaration; nothing is sent`);
    }
  }

  function childrenOf(id, map, held) {
    const has = (kind, k) => !!held && held.some((r) => r.kind === kind && r.key === k);
    const out = [];
    for (const s of map) {
      const sk = stageLocator(s.key);
      if (!has('bpfStage', sk)) out.push({ kind: 'bpfStage', key: sk, namespaceParentId: id, id: s.id, associationSha256: intentSha256({ parent: key, key: sk }) });
      for (const p of s.steps) {
        const pk = stepLocator(s.key, p.key);
        if (!has('bpfStep', pk)) out.push({ kind: 'bpfStep', key: pk, namespaceParentId: s.id, id: p.id, associationSha256: intentSha256({ parent: sk, key: pk }) });
      }
    }
    return out;
  }
  function expectedOf({ id, sent, desiredStatus, map, live }) {
    return {
      proofVersion: 1,
      proofSchema: PROOF_SCHEMA,
      rootId: id,
      baseProofSha256: run.committed ? intentSha256(run.committed.proof) : null,
      sentProjectionSha256: savedShaOf(sent.projection, desiredStatus),
      preservationSha256: preservationOf(sent.projection),
      baseObservation: live ? { rowVersion: live.version || null, savedSha256: savedShaOf(live.view.projection, live.view.status) } : null,
      children: childrenOf(id, map, run.committed ? run.committed.records : null),
    };
  }
  // Every child id the attempt said it would bind, where a fresh read finds it; [] when all are there.
  function missingChildren(expected, projection) {
    const ids = new Set();
    for (const s of projection.stages) { ids.add(s.id); for (const p of s.steps) ids.add(p.id); }
    return expected.children.filter((c) => !ids.has(c.id)).map((c) => c.key);
  }
  // The status the expected proof was sent for, given a live projection: the one for which the hashes agree.
  function statusFor(expected, projection) {
    for (const s of [ACTIVE, DRAFT]) if (savedShaOf(projection, s) === expected.sentProjectionSha256) return s;
    return null;
  }
  function notTheSentFlow(expected, view) {
    const missing = missingChildren(expected, view.projection);
    if (missing.length) return `the flow read back lacks ${missing.join(', ')} under the ids this build reserved`;
    if (statusFor(expected, view.projection) === null) return 'the flow read back is not the flow this build sent';
    return null;
  }

  /**
   * Send the Draft create of this attempt's own row (from `apply` only: a first send, or the same create under the same
   * token after resumeCreate read its id absent), then finish it (finishCreate). An answered create is durable at once
   * (noteSaved, acknowledgedRoot): that answer is what lets this attempt call the row, and its stages and steps, its own.
   */
  async function driveCreate(token, id, staged) {
    let create = effectOf(token, (e) => e.effect === 'create');
    let failure = null;
    if (!create || create.state === 'definitely-unsent') {
      const s = staged || await stageCreate(id, createMap().map);
      if (create && create.desiredSha256 !== s.desiredSha256) throw coded(CODES.pending, `${label}: the create waiting to be sent was made from another declaration; restore it to finish`);
      failure = await sendOnce(token, create, {
        rowId: id, effect: 'create', request: { method: 'POST', shape: 'bpf-create' }, desiredSha256: s.desiredSha256, desiredState: null, expectedVersion: null,
      }, () => sdk.withArtifactLock(ARTIFACT, id, () => sdk.executePrepared(s.prep)));
      if (!failure) store.noteSaved(token, { proof: null, acknowledgedRoot: true, phase: 'state-pending' });
    }
    return finishCreate(token, id, failure);
  }

  /**
   * Prove this attempt's own create by reading (never by sending it again), then complete its own activation. The
   * activation needs no edit switch — the row is the one this exact attempt created — and is held to the version of the
   * read that proved it (activateOwnCreate: If-Match; a maker's change in between is never undone or activated). A
   * create no answer acknowledged is not known to be this build's: it is neither activated nor bound without the flow's
   * typed adoption approval (`managed-adoption-required`, the attempt kept).
   */
  async function finishCreate(token, id, failure) {
    const create = effectOf(token, (e) => e.effect === 'create');
    const expected = attemptOf(token).attempt.expected;
    if (create.state !== 'confirmed') {
      const live = await readLive(id);
      if (live.missing) {
        if (live.stranger) throw coded('create-completion-required', `${label}: the workflow ${id} is not this table's process flow; nothing is bound to it`);
        if (failure && answeredRefusal(failure)) {
          throw coded('create-completion-required', `${label}: the create was refused (${failure.message}) and no row is there now. That answer does not prove the `
            + `create never started, so it is not sent again from this attempt; a later run reads ${id} again`, { cause: failure });
        }
        throw coded(CODES.pending, `${label}: the create of ${id} has not appeared; it is not sent again, and a later run reads the row again`, { cause: failure });
      }
      // Acknowledged or not, a row that is not exactly what was sent (a substituted stage or step id included) binds nothing.
      const why = notTheSentFlow(expected, live.view);
      if (why) throw coded('create-completion-required', `${label}: ${why}; nothing is bound to it`);
      store.confirmEffect(create.token, { observedSha256: create.desiredSha256 });
    }
    const { attempt } = attemptOf(token);
    // The store's one reading of the acknowledgement: honoured only for an attempt whose expected proof records no base
    // observation, so an answer to an edit of an existing row never makes it this attempt's creation.
    const acknowledged = rootCreateAcknowledged(attempt);
    const live = await readLive(id);
    if (live.missing) throw coded(CODES.pending, `${label}: the workflow ${id} could not be read back`);
    const why = notTheSentFlow(expected, live.view);
    if (why) throw coded('create-completion-required', `${label}: ${why}`);
    if (statusFor(expected, live.view.projection) === ACTIVE) {
      if (live.view.status !== ACTIVE && !acknowledged && !approved) {
        throw coded(CODES.adoptionRequired, `${label}: the workflow ${id} carries what this build sent, but no answer acknowledged its create, so it is not known `
          + `to be this build's; it is neither activated nor bound without the adoption approval adopt:bpf:${key}. The attempt is kept`);
      }
      await activateOwnCreate(token, id, live, {
        reread: () => readLive(id),
        provedActive: (view) => notTheSentFlow(expected, view) || (statusFor(expected, view.projection) === ACTIVE ? null : 'the flow read back was not sent to be Active'),
      });
    }
    return { acknowledged };
  }

  /** The switch path: Draft (when Active), body, then Active, each conditioned on the version its proof read returned. */
  async function driveEdit(token, id, planned) {
    const base = planned.live;
    const baseSemantic = intentSha256(base.view.projection);
    if (base.view.status === ACTIVE) await driveState(token, id, DRAFT, base.version, { conditional: true, observed: base.view.status });
    // Read again whatever the state: the copy staged while planning is replaced by the row as it is now, so no local
    // edit is ever applied twice, and the body write carries the version of THIS read.
    const live = await readLive(id);
    if (live.missing || intentSha256(live.view.projection) !== baseSemantic) throw coded('bpf-drift', `${label}: the flow changed on the server while it was being edited; nothing more is sent`);
    const staged = await stageEdit(id, live.view, planned.map, base.view.status);
    checkStaged(staged.sent, planned.map);
    if (savedShaOf(staged.sent.projection, staged.desiredStatus) !== planned.expected.sentProjectionSha256) {
      throw coded('bpf-drift', `${label}: the flow read back differently from the proof it was planned on; nothing more is sent`);
    }
    if (staged.version !== live.version) throw coded('bpf-drift', `${label}: the flow's version moved between two reads; nothing more is sent`);
    const failure = await sendOnce(token, null, {
      rowId: id, effect: 'body', request: { method: 'PATCH', shape: 'workflow-patch' }, desiredSha256: staged.desiredSha256, desiredState: null, expectedVersion: staged.version,
    }, () => sdk.withArtifactLock(ARTIFACT, id, () => sdk.executePrepared(staged.prep)));
    const body = effectOf(token, (e) => e.effect === 'body');
    if (body.state === 'definitely-unsent') throw coded('bpf-drift', `${label}: the flow changed on the server after it was read, so the edit was refused; it is not retried`, { cause: failure });
    const after = await readLive(id);
    if (after.missing || savedShaOf(after.view.projection, staged.desiredStatus) !== planned.expected.sentProjectionSha256) {
      // An answered refusal does not prove the body never started (a service can answer 4xx after it applied part of a
      // request), so it is never recorded as unsent: the attempt stays open and the body is not sent again.
      if (failure && answeredRefusal(failure)) {
        throw coded('create-completion-required', `${label}: the edit was refused (${failure.message}) and the row does not carry it. That answer does not `
          + 'prove the edit never started, so it is not sent again from this attempt; the flow is kept as it is', { cause: failure });
      }
      throw coded(failure ? CODES.pending : 'create-completion-required', `${label}: the edit is not proved by a fresh read; it is not sent again`, { cause: failure });
    }
    store.confirmEffect(body.token, { observedSha256: body.desiredSha256 });
    if (staged.desiredStatus === ACTIVE && after.view.status !== ACTIVE) await driveState(token, id, ACTIVE, after.version, { conditional: true, observed: after.view.status });
  }

  async function finalProof(id, expected, map, origin, acknowledged) {
    const live = await readLive(id);
    if (live.missing) throw coded(CODES.pending, `${label}: the workflow ${id} could not be read back`);
    const missing = missingChildren(expected, live.view.projection);
    if (missing.length) throw coded('create-completion-required', `${label}: a fresh read of ${id} lacks ${missing.join(', ')}; nothing is bound`);
    const saved = savedShaOf(live.view.projection, live.view.status);
    if (saved !== expected.sentProjectionSha256 || preservationOf(live.view.projection) !== expected.preservationSha256 || !mapFits(map, live.view.projection)) {
      throw coded(run.committed ? 'bpf-drift' : 'create-completion-required', `${label}: a fresh read of ${id} is not what was sent; nothing is bound`);
    }
    // A child is recorded `created` only on this attempt's acknowledged create (the store refuses it otherwise).
    const childOrigin = acknowledged === true ? 'created' : 'adopted';
    const records = [record(ROOT_KIND, key, id, origin)];
    for (const s of map) {
      records.push(record('bpfStage', stageLocator(s.key), s.id, childOrigin, key));
      for (const p of s.steps) records.push(record('bpfStep', stepLocator(s.key, p.key), p.id, childOrigin, stageLocator(s.key)));
    }
    const proof = {
      savedSha256: saved,
      semanticSha256: intentSha256(live.view.projection),
      preservationSha256: preservationOf(live.view.projection),
      expectedChildrenSha256: intentSha256(records.filter((r) => r.kind !== ROOT_KIND).map((r) => [r.kind, r.key, r.id])),
    };
    const backing = live.view.uniqueName;
    return {
      savedProof: proof, acknowledgedRoot: acknowledged === true, records, proof,
      consumerState: { declaration: { flow: clone(flow), applied: appliedOf(live.view, map), backing }, stages: map },
      publication: null, proofSchema: PROOF_SCHEMA,
    };
  }

  // ----- the four steps.
  async function resolve({ committed, pending }) {
    run.committed = committed;
    run.pending = pending || null;
    const errors = validateDeclaredBpf(flow);
    if (errors.length) throw coded('bpf-shape-unsupported', `${label}: ${errors.join('; ')}`);
    if (pending && pending.declarationSha256 !== declarationSha256) {
      throw coded(CODES.pending, `${label}: an earlier change was prepared from another declaration of this flow; restore that declaration to finish it`);
    }
    return committed ? resolveManaged(committed) : resolveNew();
  }

  async function resolveManaged(committed) {
    if (!committed.root || committed.root.kind !== ROOT_KIND) throw coded(CODES.groupInvalid, `${label}: the managed group is not a process flow`);
    const id = committed.root.id;
    const state = committed.consumerState || {};
    const held = state.stages || [];
    // Both refusals come before ANY request: a structural one refuses the whole operation, the metadata included.
    const structure = structureErrors(held, flow);
    if (structure.length) throw coded('bpf-structure-refused', `${label}: the declaration ${structure.join(', ')}; stages and steps are never removed or moved, so nothing is changed`);
    const edits = editsOf((state.declaration && state.declaration.applied) || { stages: [] }, flow);
    if (edits.length && !switchOn && !approved) throw coded('workflow-edit-refused', `${label}: the declaration ${edits.join(', ')}. ${EDIT_REFUSED_REMEDY}`);
    const live = await readLive(id);
    if (live.missing) throw coded('bpf-drift', `${label}: its workflow ${id} is gone or is not this table's flow; nothing re-creates or rebinds it`);
    if (savedShaOf(live.view.projection, live.view.status) !== committed.proof.savedSha256) {
      if (!approved) {
        throw coded('bpf-drift', `${label}: the flow changed outside the spec since it was last proved; nothing is sent. Re-adopt it (adopt:bpf:${key}) with a declaration that names its whole current body, in order`);
      }
      return adoption(id, live);
    }
    if (!edits.length) {
      // Nothing of the workflow changes. The authored flow may still differ from the one the group recorded: the
      // security roles a later phase grants, or a property the flow already holds stated (or left out) differently.
      // That is a declaration-only change: a plan that sends nothing, whose commit records today's flow as the group's
      // originalDeclaration (what the managed download restores). A no-op would keep the earlier one as current.
      const recorded = committed.originalDeclaration;
      if (recorded !== undefined && intentSha256(recorded) === declarationSha256) return { mode: 'noop' };
      return { mode: 'declaration', id, live, held };
    }
    if (!switchOn) throw coded('workflow-edit-refused', `${label}: the declaration ${edits.join(', ')}. ${EDIT_REFUSED_REMEDY}`);
    // A declaration that changes only the status is a pure state change: one conditional state write, no body push
    // (the body is already proved, and regenerating its XAML would rewrite what the server holds for nothing).
    const applied = (state.declaration && state.declaration.applied) || { stages: [] };
    if (!editsOf(applied, { ...flow, status: applied.status }).length) return { mode: 'state', id, live, held, target: flow.status };
    return { mode: 'edit', id, live, held };
  }

  async function resolveNew() {
    if (!Array.isArray(flow.stages)) throw coded('bpf-shape-unsupported', `${label}: creating or adopting a flow needs its stages, each with a key`);
    const { id } = identityFor('bpf', key, { catalog });
    let sameName;
    let atId;
    for (;;) {
      try {
        sameName = await sdk.queryRecords('workflow', { select: ['workflowid'], filter: sdkBuild().bpfFilter(flow.name, table), paginate: true });
        atId = await readVersion(id);
        break;
      } catch (err) {
        // On a table this invocation created (`freshTable`, the caller's), the read can meet the table's metadata-cache lag
        // (retry-policy.js isFreshTableLag): it is read again here, as long as the build's one retry allowance lasts
        // (`retryFreshRead`, build-model-app.js), and nothing was sent before it. Once that is spent, or for any other failure,
        // the failure is final and carries the service's answer.
        if (freshTable) markFreshTable(err, freshTable);
        if (freshTable && typeof retryFreshRead === 'function' && isFreshTableReadLag(err) && (await retryFreshRead(err, freshTable)) === true) continue;
        throw coded('create-identity-unverified', `${label}: whether the flow already exists could not be read, so it is neither created nor adopted`, { cause: err });
      }
    }
    if (!Array.isArray(sameName)) throw coded('create-identity-unverified', `${label}: the read of its name answered no list`);
    const ids = sameName.map((r) => normalizeGuid(r.workflowid));
    if (atId && !ids.includes(id)) throw coded('create-identity-conflict', `${label}: its id ${id} is held by another workflow`);
    if (ids.length > 1) throw coded('create-identity-conflict', `${label}: ${ids.length} process flows on ${table} have this name; none is adopted`);
    if (ids.length === 1) {
      if (!approved) {
        throw coded('create-ownership-required', `${label}: a process flow of this name already exists (${ids[0]}); approve adopt:bpf:${key} with a declaration that names its whole body to manage it`);
      }
      const live = await readLive(ids[0]);
      if (live.missing) throw coded('create-identity-unverified', `${label}: the flow ${ids[0]} could not be read back`);
      return adoption(ids[0], live);
    }
    return { mode: 'create', id };
  }

  function adoption(id, live) {
    const errs = wholeBodyErrors(flow, live.view);
    if (errs.length) throw coded('bpf-whole-body-required', `${label}: adopting a flow needs a declaration that names its whole current body, in order: ${errs.join('; ')}`);
    return { mode: 'adopt', id, live };
  }

  // runManagedFeature `plan`: the change (planChange) plus the ORIGINAL authored flow as `declaration`, a plain-JSON
  // copy the shared seam checks (checkDeclaration) and records with the attempt before anything is sent, then commits as
  // the group's originalDeclaration. It is kept apart from consumerState, which stays this module's derived state as
  // prove answers it. A continued or resumed attempt is sent only for the declaration it recorded, so that replan
  // answers the recorded one (resolve has already refused one prepared from another declaration hash).
  async function plan(input) {
    const planned = await planChange(input);
    if (!planned || planned.noop === true) return planned;
    const recorded = (input.continuing || input.resuming) && run.pending ? run.pending.declaration : undefined;
    const declaration = recorded !== undefined ? recorded : clone(flow);
    return { ...planned, declaration, completionBytes: completionWithin(completionBytesOf(planned, declaration), label, 'process flow', 'stages or steps') };
  }

  // The bytes this attempt's completion may add to the store (runManagedFeature `completionBytes`; see
  // workflow-drive completionBytesFor): the parts its commit adds as finalProof builds them — the root, stage and step
  // records, the proof (twice: the saved proof is noted on the attempt as well), the consumer state — plus the original
  // declaration and the expected proof. The consumer state keeps the flow, what was applied, the backing table name
  // and the stage map; what was applied is a projection of the proved row, which the final proof requires to be the one
  // this plan sends or keeps (`proved`, by hash), so that projection and the map's keys bound it.
  function completionBytesOf(planned, declaration) {
    const { map } = planned;
    const records = [record(ROOT_KIND, key, planned.root.id, 'adopted')];
    for (const s of map) {
      records.push(record('bpfStage', stageLocator(s.key), s.id, 'adopted', key));
      for (const p of s.steps) records.push(record('bpfStep', stepLocator(s.key, p.key), p.id, 'adopted', stageLocator(s.key)));
    }
    const proof = { savedSha256: HASH_BOUND, semanticSha256: HASH_BOUND, preservationSha256: HASH_BOUND, expectedChildrenSha256: HASH_BOUND };
    const consumerState = { declaration: { flow, applied: { projection: planned.proved, keys: map }, backing: NAME_BOUND }, stages: map };
    return completionBytesFor([records, proof, proof, consumerState, declaration, planned.expected]);
  }

  async function planChange({ resolution }) {
    const root = (id) => ({ kind: ROOT_KIND, key, id });
    if (resolution.mode === 'noop') return { noop: true };
    if (resolution.mode === 'adopt') {
      const { id, live } = resolution;
      const map = positionalMap(flow, live.view.projection);
      const expected = expectedOf({ id, sent: live.view, desiredStatus: live.view.status, map, live });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'adopt', map, proved: live.view.projection };
    }
    if (resolution.mode === 'create') {
      const { id, map } = createMap();
      if (id !== resolution.id) throw coded(CODES.notSettled, `${label}: the catalog answered two ids for one flow`);
      const staged = await stageCreate(id, map);
      checkStaged(staged.sent, map);
      const expected = expectedOf({ id, sent: staged.sent, desiredStatus: staged.desiredStatus, map, live: null });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'create', staged, map, proved: staged.sent.projection };
    }
    if (resolution.mode === 'declaration') {
      // The live flow stays as it is, status included (it equals the committed proof, checked in resolveManaged); only
      // the recorded declaration changes, so the proof expected is today's, under the held map.
      const { id, live, held } = resolution;
      const expected = expectedOf({ id, sent: live.view, desiredStatus: live.view.status, map: held, live });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'declaration', map: held, proved: live.view.projection };
    }
    if (resolution.mode === 'state') {
      // The live flow is what stays; only the status moves. The held map still names the live stages and steps (the
      // row equals the committed proof, checked in resolveManaged).
      const { id, live, held, target } = resolution;
      const expected = expectedOf({ id, sent: live.view, desiredStatus: target, map: held, live });
      return { root: root(id), expected, declarationSha256, publication: null, mode: 'state', live, target, map: held, proved: live.view.projection };
    }
    const { id, live, held } = resolution;
    const map = editedMap(id, held);
    const staged = await stageEdit(id, live.view, map);
    checkStaged(staged.sent, map);
    const expected = expectedOf({ id, sent: staged.sent, desiredStatus: staged.desiredStatus, map, live });
    return { root: root(id), expected, declarationSha256, publication: null, mode: 'edit', live, map, proved: staged.sent.projection };
  }

  async function apply({ token, plan: planned }) {
    run.token = token;
    if (planned.mode === 'adopt') return { mode: 'adopt', acknowledged: false, map: planned.map };
    if (planned.mode === 'declaration') return { mode: 'declaration', acknowledged: false, sent: false, map: planned.map };
    if (planned.mode === 'create') return { mode: 'create', ...(await driveCreate(token, planned.root.id, planned.staged)), map: planned.map };
    if (planned.mode === 'state') {
      await driveState(token, planned.root.id, planned.target, planned.live.version, { conditional: true, observed: planned.live.view.status });
      return { mode: 'state', acknowledged: false, map: planned.map };
    }
    await driveEdit(token, planned.root.id, { live: planned.live, map: planned.map, expected: planned.expected });
    return { mode: 'edit', acknowledged: false, map: planned.map };
  }

  async function prove({ token, expected, applied, recovering }) {
    run.token = token;
    const id = expected.rootId;
    if (!recovering) {
      const committedOrigin = run.committed ? (run.committed.records.find((r) => r.kind === ROOT_KIND) || {}).origin : null;
      const created = applied.mode === 'create' && applied.acknowledged;
      return finalProof(id, expected, applied.map, committedOrigin || (created ? 'created' : 'adopted'), created);
    }
    // Recovery: the change may already be on the server. Nothing is planned again; the attempt's own effects are
    // proved by reading at the ids the catalog derives again, and only what is definitely unsent may still be sent
    // (under its stored record). `expected`, persisted before the first send, names every child id to prove.
    const { committed } = store.readGroup(FAMILY, key);
    run.committed = committed;
    const { attempt, effects } = attemptOf(token);
    if (attempt.declarationSha256 !== declarationSha256) {
      throw coded(CODES.pending, `${label}: an earlier change of this flow is not proved, and the declaration it was sent from has changed; restore that declaration to finish it`);
    }
    if (!committed) return proveUncommitted(token, id, expected, attempt, effects);
    const origin = (committed.records.find((r) => r.kind === ROOT_KIND) || {}).origin || 'adopted';
    const held = (committed.consumerState && committed.consumerState.stages) || [];
    const live = await readLive(id);
    // The status the change was meant to end in, when the row as it is now carries exactly what was sent. A row that
    // carries the sent body in the other status is a change stopped between its body and its own state write.
    const target = live.missing ? null : statusFor(expected, live.view.projection);
    if (target === null || (target !== live.view.status && !effects.length)) {
      if (!effects.length) throw coded(CODES.pending, `${label}: an earlier change of this flow was prepared and is not on the row; nothing of it is sent from this attempt, which stays pending`);
      throw coded(CODES.pending, `${label}: an earlier edit of this flow is not proved by the row as it is now; it is not sent again`);
    }
    // An edit's map is derived again (held ids, catalog ids for the new children); a re-adoption's is positional.
    const edited = editedMap(id, held);
    const fits = mapFits(edited, live.view.projection);
    if (!fits && !Array.isArray(flow.stages)) throw coded(CODES.pending, `${label}: an earlier change of this flow cannot be matched to its stages; re-run with the declaration it was made from`);
    const map = fits ? edited : positionalMap(flow, live.view.projection);
    if (!effects.length) {
      // A re-adoption (no write), or a change whose first write was never recorded: the row already carries it.
      const rebased = !(expected.baseObservation && expected.baseObservation.savedSha256 === committed.proof.savedSha256);
      // Binding the flow's current body again (a re-adoption) is the maker's decision, on this run as on the first.
      if (rebased && !approved) {
        throw coded(CODES.adoptionRequired, `${label}: an earlier re-adoption of this flow is proved by reading, but binding its current body again needs the adoption approval adopt:bpf:${key}; the attempt is kept`);
      }
      return finalProof(id, expected, map, origin, false);
    }
    for (const e of effects) {
      if (e.state === 'confirmed') continue;
      // The change's own final state write is settled below.
      if (e.effect === 'state' && e.desiredState === target && live.view.status !== target) continue;
      if (e.state === 'definitely-unsent') throw coded(CODES.pending, `${label}: an earlier edit of this flow has a write that was never sent`);
      if (e.effect === 'state') {
        if (e.desiredState === live.view.status) store.confirmEffect(e.token, { observedState: e.desiredState });
        else if (e.desiredState === DRAFT) throw coded(CODES.pending, `${label}: an earlier edit's state change is not proved`);
      } else {
        store.confirmEffect(e.token, { observedSha256: e.desiredSha256 });
      }
    }
    if (target !== live.view.status) {
      // The body is on the row and proved; only the change's own state write is missing. That is a write to a workflow
      // that already exists, so by default it is refused before anything is sent, whatever its record says.
      if (!switchOn) {
        throw coded('workflow-edit-refused', `${label}: an earlier change is on the row but the flow is not ${target}; setting it ${target} is a state change of a `
          + `workflow that already exists, so nothing is sent and the attempt stays pending. ${EDIT_REFUSED_REMEDY}`);
      }
      // Sent (once, against the version of this read) only when its record says it never left; one that may have left
      // is proved by reading, never sent again.
      await driveState(token, id, target, live.version, { conditional: true, observed: live.view.status });
    }
    // A Draft state effect the row has since left (the edit's own Active) is proved by the later Active write.
    for (const e of attemptOf(token).effects) {
      if (e.state !== 'confirmed' && e.effect === 'state' && e.desiredState === DRAFT) {
        const active = attemptOf(token).effects.find((x) => x.effect === 'state' && x.desiredState === ACTIVE && x.state === 'confirmed');
        if (!active) throw coded(CODES.pending, `${label}: an earlier edit's state change is not proved`);
        store.confirmEffect(e.token, { observedState: DRAFT });
      }
    }
    return finalProof(id, expected, map, origin, false);
  }

  /**
   * Recovery of an attempt with no committed group: a create, or a read-only adoption. Only the attempt's own CREATE
   * may continue as a create, and only by proving it (resumeCreate is what sends a create again, when the row is
   * proved absent). The discriminator is positive: no base generation, no base observation, no base proof — what
   * expectedOf records for a create and never for an adoption. Neither "not committed" nor "the row is absent" is
   * creation authority: an adoption whose row is gone stops, nothing created.
   */
  async function proveUncommitted(token, id, expected, attempt, effects) {
    const isCreate = attempt.baseGeneration === null && expected.baseObservation === null && expected.baseProofSha256 === null;
    if (isCreate) {
      if (createMap().id !== id) throw coded(CODES.pending, `${label}: the pending create is at another id than the catalog derives`);
      const create = effects.find((e) => e.effect === 'create') || null;
      if (!create || create.state === 'definitely-unsent') {
        if (await readVersion(id)) throw coded('create-identity-conflict', `${label}: a workflow already holds the id ${id}, and no create of this build reached the server; nothing is bound to it`);
        throw coded(CODES.pending, `${label}: its create never left and the row is absent; it is not sent from here`);
      }
      const { acknowledged } = await finishCreate(token, id, null);
      return finalProof(id, expected, createMap().map, acknowledged ? 'created' : 'adopted', acknowledged);
    }
    if (effects.length) throw coded('create-completion-required', `${label}: an earlier adoption of ${id} recorded a write, which an adoption never makes; nothing is sent or bound`);
    const live = await readLive(id);
    if (live.missing) {
      throw coded('create-completion-required', `${label}: the flow ${id} an earlier run was adopting is gone; an adoption never becomes a create, so nothing is created or bound`);
    }
    return finalProof(id, expected, positionalMap(flow, live.view.projection), 'adopted', false);
  }

  // The feature's own checks on every path (runManagedFeature `preflight`), before anything is read into the
  // workspace or sent: the local copy of every row this attempt may touch holds no unsent edit. No request is made.
  async function preflight({ committed, pending, effects }) {
    // With the edit switch off, an attempt that still has to send a write to an existing row stops here, before any read.
    refuseRecordedEdits({ pending, effects });
    const ids = [committed && committed.root && committed.root.id, pending && pending.root && pending.root.id, pending && pending.expected && pending.expected.rootId];
    if (!committed) {
      try { ids.push(identityFor('bpf', key, { catalog }).id); } catch { /* resolve reports a catalog without this flow */ }
    }
    for (const id of ids) if (id) await guard.assertClean(id);
  }

  // A create no answer acknowledged (runManagedFeature `resumeCreate`): is its row there, by the id the create names?
  // A workflow row has one layer (no unpublished/published split), so one read answers for both; a failed read throws.
  async function resumeCreate({ pending }) {
    return { root: (await readVersion(pending.root.id)) ? 'present' : 'absent' };
  }

  let out;
  try {
    out = await runManagedFeature({
      phase, family: FAMILY, key, label, knownScopes: [], knownIds: [], store, barrier, halt,
      preflight, resolve, plan, apply, prove, ensureMembership, resumeCreate, adoptionApproved: approved,
      ...(sendObserver ? { sendObserver } : {}),
      // The catalog's incarnation token of this key: a plan made before its root was retired again is refused by the store
      // under the lease (prepareAttempt `incarnation`), never prepared under a retired root.
      incarnation: catalog && typeof catalog.incarnationOf === 'function' ? catalog.incarnationOf('bpf', key) : undefined,
    });
  } finally {
    await guard.restoreStaged();
  }
  const group = out.committedGroup || null;
  const id = group && group.root ? group.root.id : null;
  const decl = group && group.consumerState ? group.consumerState.declaration : null;
  return { ...out.result, id, uniqueName: (decl && decl.backing) || null };
}

module.exports = {
  settleDeclaredBpf,
  validateDeclaredBpf,
  isDeclaredBpf,
  bpfKey,
  projectBpf,
  editsOf,
  structureErrors,
  wholeBodyErrors,
  EDIT_REFUSED_REMEDY,
  PROOF_SCHEMA,
};
