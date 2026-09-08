// App Spec schema + validator. The App Spec is the reviewable contract between
// the app-builder's LLM proposal and the deterministic builder.

const path = require('node:path');
const { normalizeSpecShape } = require('./spec-shape.js');

// URL scheme allowlist for spec-supplied URLs that the built app will RENDER (iframe dashboard tiles,
// sitemap URL subareas). Only http(s) is allowed — a `javascript:`, `data:`, `vbscript:`, or `file:`
// URL in an app the maker ships would be a script-injection / local-file-exfil vector for whoever opens
// the app. Anything unparseable or non-http(s) is rejected by the validator.
function isSafeHttpUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// Dataverse systemform.type codes. A form NAME is unique only per (entity, TYPE) — a table's auto-created
// Main / Quick View / Card forms are commonly ALL named "Information" — so any code that RESOLVES a form
// (build reconcile, preflight discovery, verify) must scope by type or a name-only match hits multiple
// rows. Shared here (the lowest-level spec module) so build + verify agree. Values per the option set:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/systemform#type-choicesoptions
const FORM_TYPE_CODE = { Main: 2, QuickView: 6, QuickCreate: 7, Card: 11 };

// A canonical GUID (used to validate an author-pinned forms[].formId, which is interpolated UNQUOTED into
// an Edm.Guid OData filter). Anchored so it can neither over-match nor be an injection seam.
const FORM_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Security-authoring enums (personas[]). These mirror the vendored SDK's security surface
// (cds-maker-sdk src/types/security.ts) EXACTLY — the app-spec validator is a lint-time echo of the
// SDK's own guards so an author sees a bad access/scope at author time instead of only on apply.
//   AccessLevel  -> Dataverse PrivilegeType (read->Read, appendTo->AppendTo, …)
//   PrivilegeScope depth, least->most permissive (user->Basic … organization->Global)
// Keep these in lockstep with the SDK; vendor-sdk-smoke asserts the vendored bundle still exposes them.
const ACCESS_LEVELS = new Set(['read', 'create', 'write', 'delete', 'append', 'appendTo', 'assign', 'share']);
const { AI_FEATURE_KEYS, AI_FEATURE_MAX_VALUE } = require('./ai-app-settings.js');
const PRIVILEGE_SCOPES = new Set(['user', 'businessUnit', 'parentChild', 'organization']);

// The exact ownership marker the vendored SDK (cds-maker-sdk SecurityApi) stamps on the `description`
// of every security role it authors. The SDK deletes/reuses ONLY a role carrying this marker (SEC-1);
// the plugin re-implements that guard in teardown (deleteSecurityRole takes a raw id and does not
// re-check ownership) and in verify (a same-name role someone else built is NOT the one we authored),
// so the string lives here as the single source of truth. Keep in lockstep with the SDK — vendor-sdk-
// smoke asserts the vendored bundle still contains it.
const SDK_ROLE_MARKER = 'Authored by @maker-studio/cds-maker-sdk (persona/security role).';

// A sitemap icon / vectorIcon VALUE the platform resolves DIRECTLY (as opposed to a locally-declared
// `webResources[]` NAME): a relative WebResources path (`/WebResources/...`, `/_imgs/...`) or a
// `$webresource:` reference. These are exactly what a DOWNLOADED app carries verbatim on its subareas —
// including OOB system icons like `/WebResources/msdyn_OmnichannelBase/_imgs/SitemapIcon/CDSEntity` — and
// what a modern custom nav icon uses (`/WebResources/<pub>/icons/x.svg`). They must ROUND-TRIP: the build
// emits them verbatim (case-preserved) and validation must NOT reject them for not being a declared web
// resource (that rejection broke download→build on every real app).
// The signal is a leading `/` or a `$webresource:` prefix — NOT a file extension: a web-resource NAME
// legitimately ends in an extension (e.g. `new_appicon.png`), so an extension alone can't distinguish a
// path from a declared name. A BARE token (no `/`, no scheme — e.g. a Fluent icon name `Shop`, or even a
// bare `x.svg`) is NOT a platform ref: as an `icon` it is a local web-resource name that must be declared,
// and as an entity-subarea `VectorIcon` it breaks the modern app-designer property pane (build drops it).
// Grounded by a live probe of the vendored SDK: it serializes
// `<SubArea Entity="…" … VectorIcon="/WebResources/<pub>/icons/x.svg">` correctly for a path value.
function isPlatformIconRef(v) {
  const s = String(v == null ? '' : v);
  return s.startsWith('/') || /^\$webresource:/i.test(s);
}

// `iconDescription` is a DOCUMENTARY field: what the icon's glyph will DEPICT, in plain language
// ("a briefcase", "an outlined clipboard with a checkmark"). It is never written to Dataverse — it
// exists so `model-app-plan.md` can show the user what they are approving BEFORE the SVG is drawn.
//
// Why a Fluent token name is rejected outright: the SVG is authored fresh in this phase, so there is
// no icon library to look a token up in — and a token name the user has never seen ("ClipboardTask")
// tells them nothing about what the glyph will look like, which defeats the entire point of the
// field. Detect a token by SHAPE: a single word (no whitespace) that is either Capitalised the way
// every Fluent name is ("Briefcase", "ClipboardTask") or carries a Fluent style/size suffix
// ("...24Regular"). A single lowercase word ("briefcase") is terse but still a real depiction, so it
// passes — the rule targets library-name pasting, not brevity.
const FLUENT_TOKENISH = /^(?=\S+$)(?:[A-Z].*|.*[a-z0-9][A-Z].*|.*(?:Regular|Filled|Light|Color)\d*$)/;
function validateIconDescription(value, label, errors) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${label}: iconDescription must be a non-empty string describing what the glyph depicts (e.g. "a briefcase")`);
    return;
  }
  if (FLUENT_TOKENISH.test(value.trim())) {
    errors.push(`${label}: iconDescription '${value}' looks like a Fluent icon token, not a description. The SVG is drawn fresh, so describe what the glyph will DEPICT (e.g. "an outlined clipboard with a checkmark") — a token name the user has not seen tells them nothing.`);
  }
}

// The web-resource NAME a PLATFORM icon reference points at, or null when it isn't a resolvable
// web-resource reference. Two forms the platform emits:
//   `/WebResources/<name>`  → <name>   (the runtime path a modern nav icon uses)
//   `$webresource:<name>`   → <name>
// A `<name>` may itself contain `/` (web-resource names are folder-like, e.g. `pub_/icons/x.svg`), so
// strip ONLY the known prefix, verbatim. A non-WebResources path (an OOB static image like
// `/_imgs/TableIconsFluentV9/x.svg`) returns null — not a queryable web resource, so it stays a bare
// reference present on every env.
function webResourceNameFromRef(ref) {
  const s = String(ref == null ? '' : ref);
  let m = /^\/WebResources\/(.+)$/i.exec(s);
  if (m) return m[1];
  m = /^\$webresource:(.+)$/i.exec(s);
  if (m) return m[1];
  return null;
}

// App Spec column type -> { dv: Dataverse attribute type name }. (The SDK build engine
// maps App Spec types to the SDK's own ColumnType in lib/sdk-build.js.)
const TYPE_MAP = {
  Text: { dv: 'string' },
  Memo: { dv: 'memo' },
  Choice: { dv: 'picklist' },
  MultiChoice: { dv: 'multiselectpicklist' },
  Boolean: { dv: 'boolean' },
  Money: { dv: 'money' },
  DateTime: { dv: 'datetime' },
  Integer: { dv: 'integer' },
  BigInt: { dv: 'bigint' },
  Decimal: { dv: 'decimal' },
  Double: { dv: 'double' },
  File: { dv: 'file' },
  Image: { dv: 'image' },
  AutoNumber: { dv: 'string' },
  Customer: { dv: 'lookup' }, // polymorphic account/contact — built via createCustomerColumn
  Lookup: { dv: null }, // lookups come from relationships, not a column
};

function columnTypeMap(t) {
  return TYPE_MAP[t] || TYPE_MAP.Text;
}

// Map every Choice / MultiChoice column's option LABELS to the integer values the
// builder assigns (value = 100000000 + index — the same convention used for inline
// option sets AND global option sets; see lib/sdk-build.js). Resolves inline `options[]`
// columns AND columns bound to a `globalChoice` (looked up in spec.globalChoices). Pass
// `spec` to resolve global choices; without it, only inline-option columns resolve.
// { columnLogicalName: { "Platinum": 100000000, ... } }.
function choiceValueMap(entity, spec) {
  const globalByName = {};
  for (const g of (spec && spec.globalChoices) || []) {
    const byLabel = {};
    (g.options || []).forEach((label, i) => { byLabel[String(label)] = 100000000 + i; });
    globalByName[String(g.name).toLowerCase()] = byLabel;
  }
  const map = {};
  for (const c of entity.columns || []) {
    if (c.type !== 'Choice' && c.type !== 'MultiChoice') continue;
    let byLabel = null;
    if (Array.isArray(c.options) && c.options.length) {
      byLabel = {};
      c.options.forEach((label, i) => { byLabel[String(label)] = 100000000 + i; });
    } else if (c.globalChoice && globalByName[String(c.globalChoice).toLowerCase()]) {
      byLabel = globalByName[String(c.globalChoice).toLowerCase()];
    }
    if (byLabel) map[c.schemaName.toLowerCase()] = byLabel;
  }
  return map;
}

// Shared choice-value linter (#4). Returns [{ field, token }] for each Choice/MultiChoice sample VALUE
// in `record` that is neither a declared option label nor a raw integer option value. Both the hard
// validator (validateAppSpec) and the guardrail linter (spec-lint.js) call this so the two gates never
// diverge. A MultiChoice value is a comma-separated token list; a single Choice is one token — a label
// that legitimately contains a comma is matched WHOLE first (byLabel[val]) so it is never mis-split.
// Raw integer tokens pass through (an author may use the stable option value instead of the label).
function invalidChoiceSampleTokens(spec, entity, record) {
  if (!entity || !record || typeof record !== 'object' || Array.isArray(record)) return [];
  const byField = choiceValueMap(entity, spec);
  const multi = new Set((entity.columns || []).filter((c) => c.type === 'MultiChoice').map((c) => String(c.schemaName).toLowerCase()));
  const out = [];
  for (const [field, val] of Object.entries(record)) {
    if (field.startsWith('$') || field === 'statusReason') continue;
    const byLabel = byField[field.toLowerCase()];
    if (!byLabel || typeof val !== 'string') continue; // not a choice column, or already an int
    if (byLabel[val] !== undefined) continue; // whole value is a known label (incl. labels with commas)
    const tokens = multi.has(field.toLowerCase()) ? val.split(',').map((t) => t.trim()).filter(Boolean) : [val];
    for (const tok of tokens) {
      if (tok === '' || /^-?\d+$/.test(tok)) continue; // blank or a raw option int
      if (byLabel[tok] === undefined) out.push({ field, token: tok });
    }
  }
  return out;
}

// The sample records declared for an entity (keyed by schemaName, case-insensitive).
function sampleRecordsFor(spec, entity) {
  const sd = spec.sampleData || {};
  const key = Object.keys(sd).find((k) => k.toLowerCase() === entity.schemaName.toLowerCase());
  return (key && Array.isArray(sd[key]) && sd[key]) || [];
}

// Valid chart types (SDK ChartSeriesType values).
const CHART_TYPES = ['Column', 'Bar', 'Pie', 'Line'];

// Find the OneToMany relationship in the spec whose `referenced` = parentEntity and
// `referencing` = childEntity (case-insensitive on both schema names). Returns the
// relationship object (its `lookup.schemaName` is the @odata.bind nav-property; the
// sub-grid RelationshipName is relationshipSchemaName(rel)), or null when none exists.
function relationshipFor(spec, parentEntity, childEntity) {
  const p = String(parentEntity || '').toLowerCase();
  const c = String(childEntity || '').toLowerCase();
  return (
    (spec.relationships || []).find(
      (r) =>
        r.type === 'OneToMany' &&
        String(r.referenced || '').toLowerCase() === p &&
        String(r.referencing || '').toLowerCase() === c
    ) || null
  );
}

// The 1:N lookup columns a relationship places ON `entityLogical` (the referencing/child side).
// These lookups are NOT part of entities[].columns — they come from relationships[] — so form
// auto-layout and default-view enrichment call this to surface the parent links (otherwise the
// parent lookup is invisible on the form/grid). N:N relationships use an intersect table and place
// no lookup column on either side, so they're excluded. Deduped by logical name; declared order
// preserved. Returns [{ logical, displayName }].
function lookupColumnsFor(spec, entityLogical) {
  const child = String(entityLogical || '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const r of spec.relationships || []) {
    if (r.type !== 'OneToMany') continue;
    if (String(r.referencing || '').toLowerCase() !== child) continue;
    const logical = String((r.lookup && r.lookup.schemaName) || '').toLowerCase();
    if (!logical || seen.has(logical)) continue;
    seen.add(logical);
    out.push({ logical, displayName: (r.lookup && r.lookup.displayName) || (r.lookup && r.lookup.schemaName) || logical });
  }
  return out;
}

// The child relationships to show as sub-grids on `entityLogical`'s (parent) form: every 1:N where
// this entity is the REFERENCED (parent) side, plus every N:N it participates in. Returns the child
// (the "many"/other side) as [{ childEntity }], deduped, declared order preserved. Used by the opt-in
// forms[].autoSubgrids to give a hub table a "list of its children" grid without hand-authoring each.
function childRelationshipsFor(spec, entityLogical) {
  const parent = String(entityLogical || '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const r of spec.relationships || []) {
    let child = null;
    if (r.type === 'OneToMany' && String(r.referenced || '').toLowerCase() === parent) {
      child = String(r.referencing || '').toLowerCase();
    } else if (r.type === 'ManyToMany') {
      const a = String(r.entity1 || '').toLowerCase();
      const b = String(r.entity2 || '').toLowerCase();
      if (a === parent) child = b;
      else if (b === parent) child = a;
    }
    if (!child || seen.has(child)) continue;
    seen.add(child);
    out.push({ childEntity: child });
  }
  return out;
}

// The 1:N relationship's SCHEMA name (used for entity provisioning and the
// sub-grid RelationshipName). This MUST be distinct from the lookup attribute's
// schema name — Dataverse rejects a relationship whose name collides with the
// lookup column on the referencing table. Defaults to `<referenced>_<referencing>`,
// with the solution's publisher prefix guaranteed at the front (see
// prefixedRelationshipName) so a relationship to a STANDARD/system table (systemuser,
// account, …) — which has no custom prefix — still gets a valid, prefixed name that
// Dataverse accepts. An explicit `rel.schemaName` is honored verbatim.
function relationshipSchemaName(rel, publisherPrefix) {
  if (rel && rel.schemaName) {
    return rel.schemaName;
  }
  return prefixedRelationshipName(rel.referenced, rel.referencing, publisherPrefix);
}

// Compose a relationship schema name from two entity schema names, guaranteeing the result starts
// with the solution's publisher prefix. Dataverse REQUIRES a relationship schema name to start with
// the publisher prefix; the naive `<a>_<b>` only satisfies that when `a` is a custom (prefixed)
// table. When `a` is a standard/system table (systemuser, account, …) the composed name starts with
// the table name instead and Dataverse rejects the create with a 400. So when the composed name
// doesn't already start with `<prefix>_`, prepend it (stripping a redundant prefix from `b` so we
// don't double it). With no prefix supplied the legacy `<a>_<b>` is returned unchanged.
function prefixedRelationshipName(a, b, publisherPrefix) {
  const first = String(a || '').toLowerCase();
  const second = String(b || '').toLowerCase();
  const prefix = String(publisherPrefix || '').toLowerCase();
  const composed = `${first}_${second}`;
  if (!prefix || composed.startsWith(`${prefix}_`)) {
    return composed;
  }
  const secondStripped = second.startsWith(`${prefix}_`) ? second.slice(prefix.length + 1) : second;
  return `${prefix}_${first}_${secondStripped}`;
}

// Find the ManyToMany relationship linking two entities (order-independent), or null.
function manyToManyFor(spec, entityA, entityB) {
  const a = String(entityA || '').toLowerCase();
  const b = String(entityB || '').toLowerCase();
  return (
    (spec.relationships || []).find((r) => {
      if (r.type !== 'ManyToMany') return false;
      const e1 = String(r.entity1 || '').toLowerCase();
      const e2 = String(r.entity2 || '').toLowerCase();
      return (e1 === a && e2 === b) || (e1 === b && e2 === a);
    }) || null
  );
}

// The N:N relationship's SCHEMA name (the intersect/RelationshipName). #3: an N:N is symmetric, so the
// name is composed from the two entity logical names SORTED ALPHABETICALLY — this makes the name STABLE
// regardless of authoring order (the same pair authored `entity1/entity2` either way yields ONE name,
// fixing the V1/V2 reversal that broke a data-load assuming a fixed order). The publisher prefix is then
// guaranteed at the front (see prefixedRelationshipName). An explicit `schemaName` still wins verbatim.
// NOTE: only N:N sorts — a 1:N name (relationshipSchemaName) keeps its semantic `referenced_referencing`
// (parent_child) order and must NOT be sorted.
function manyToManySchemaName(rel, publisherPrefix) {
  if (rel && rel.schemaName) {
    return rel.schemaName;
  }
  const [a, b] = [String(rel.entity1 || '').toLowerCase(), String(rel.entity2 || '').toLowerCase()].sort();
  return prefixedRelationshipName(a, b, publisherPrefix);
}

// Turn author-friendly sample records into Web-API bodies: Choice / MultiChoice values
// written as labels ("Platinum", or "Low,High" for multi-select) are resolved to their
// option ints — for inline-option AND global-choice columns (pass `spec` so global
// choices resolve). Everything else passes through unchanged (raw ints, strings,
// booleans, ISO dates, and unknown tokens all still work).
function resolveSampleRecords(entity, records, spec) {
  const choices = choiceValueMap(entity, spec);
  const multi = new Set((entity.columns || []).filter((c) => c.type === 'MultiChoice').map((c) => c.schemaName.toLowerCase()));
  return (records || []).map((rec) => {
    const out = {};
    for (const [k, v] of Object.entries(rec)) {
      const byLabel = choices[k.toLowerCase()];
      out[k] = byLabel ? resolveChoiceValue(byLabel, v, multi.has(k.toLowerCase())) : v;
    }
    return out;
  });
}

// Resolve one sample value against a column's { label -> int } map.
//  - single-select Choice: a known label becomes its integer value (Edm.Int32);
//  - MultiChoice (multi-select picklist): the Web API expects a COMMA-SEPARATED STRING of
//    option ints *even for a single value* — so every token is resolved and re-joined as a
//    string (a bare Int32 is rejected: "Cannot convert '100000002' (Int32) to Edm.String").
// Unknown tokens and non-strings pass through unchanged (raw ints still work for single-select).
function resolveChoiceValue(byLabel, v, isMulti) {
  if (typeof v !== 'string') return v;
  if (isMulti) {
    return v.split(',').map((t) => {
      const tok = t.trim();
      return byLabel[tok] !== undefined ? String(byLabel[tok]) : tok;
    }).join(',');
  }
  return byLabel[v] !== undefined ? byLabel[v] : v;
}

// Valid validation profiles. `deploy` (default) is the strictest — every page must be implemented
// (a real .tsx). `design`/`plan` allow intent-only pages (author designs pages before generate-pages
// writes their .tsx). `structural` ignores page implementation (teardown/cleanup only cares about refs).
// See docs/app-builder-design.md §7.1.
const VALIDATION_PROFILES = ['design', 'plan', 'deploy', 'structural'];

// What a page does when a user opens it straight from the app navigation with no caller input.
// Every page is sitemap-placed, so this state is always reachable for a page that declares
// `pageInput`; these are the two honest answers.
//   selector   — render a picker/list so the user can choose the record the page needs.
//   emptyState — render an explanatory empty state ("open a row from X to see its detail").
const DIRECT_ENTRY_BEHAVIORS = ['selector', 'emptyState'];

// Per-column grid data visualization (PREVIEW). MIRRORS the vendored SDK's `ColumnVisualizationType`
// (types/schema.ts) exactly — widening here without widening there produces a mid-build throw.
//
// Semantics are per COLUMN, not per view: the platform renders the graphic in EVERY grid and view
// that shows the column, which is why this lives on `entities[].columns[]` rather than on `views[]`.
// Persisted as a `controlconfiguration` row bound to the attribute.
//
// `None` is the platform default (plain text) and is accepted so a spec can explicitly CLEAR a
// visualization set by an earlier build or by a maker in the portal. OMITTING the field is NOT the
// same as `None`: an omitted column is left exactly as deployed, because converging every undeclared
// column to "plain text" would cost one extra read per column on every build to find out whether
// there was anything to clear.
const COLUMN_VISUALIZATIONS = ['None', 'RadialDial', 'LineChart', 'HeatMap', 'StarRating'];

// Whole Number display Format (AB#6648522). MIRRORS the vendored SDK's `integerFormat` union
// (types/schema.ts) exactly, same reasoning as COLUMN_VISUALIZATIONS above — widening one without
// the other produces a mid-build InvalidArgumentError instead of a spec-gate rejection.
//
// 'None' is the platform default (plain integer). It is accepted here, same as visualization's
// 'None', so a spec can explicitly clear a Format set by an earlier build or a maker in the portal.
// Unlike visualization, this is Integer-type-only — the SDK throws InvalidArgumentError for any
// other numeric type (BigInt/Decimal/Double/Money), so validated below alongside the enum check.
const INTEGER_FORMATS = ['None', 'Duration', 'TimeZone', 'Language', 'Locale'];

// Business rules. These MIRROR the vendored SDK's supported slice.
//
// The list is the SDK's operator TABLE, not a subset of it, and that table is the authority for a
// sharp reason: the serializer resolves an operator with
// `Uf[operator] ?? WorkflowConditionOperator.Equal`, so an operator it does not know becomes
// **Equals**. `IsGreaterThan` is in the table; `GreaterThan` is not — writing the latter silently
// deploys an equality test. That is a wrong rule behind a green build, which is exactly what this
// gate exists to prevent, so `business-rules.test.js` pins this list against the bundle's own table.
//
// The list was four entries long for a long time. That was never a platform limit: the SDK used to
// fall back to a client-side workflow-XAML compiler that could only express those four, and the
// restriction outlived it. The compiler has been deleted upstream, so the JSON path's full table is
// available.
const BUSINESS_RULE_OPERATORS = [
  'Equals', 'DoesNotEqual',
  'IsGreaterThan', 'IsGreaterThanEqualTo', 'IsLessThan', 'IsLessThanEqualTo',
  'Contains', 'DoesNotContain',
  'BeginsWith', 'DoesNotBeginWith', 'EndsWith', 'DoesNotEndWith',
  'On', 'NotOn',
  'ContainsData', 'DoesNotContainData',
];
// Nothing is blocked at present. Kept (empty) so a future platform-side breakage can be re-declared
// here with an explanation, rather than being folded into "unknown operator".
const BUSINESS_RULE_BLOCKED_OPERATORS = new Set();
// Operators that take NO value: they test presence, so a `value` would be meaningless. Measured —
// the serializer emits an EMPTY right-hand operand list for exactly these two.
const BUSINESS_RULE_VALUELESS_OPERATORS = new Set(['ContainsData', 'DoesNotContainData']);
// action type -> the field carrying its payload. `null` = no payload (none currently).
//
// The SDK models seven action types (adding `SetDefaultValue`, `ShowErrorMessage` and
// `Recommendation`), and all seven were measured serializing correctly through the real bundle.
// They are deliberately NOT exposed yet: each needs new mapping in `businessRuleDef`, and business
// rules cannot be exercised end to end on an environment that does not declare
// `CreateProcessWithWfomJson` — which is the environment this was developed against. Shipping
// mapping code that has never round-tripped against the platform is how a rule deploys and quietly
// does the wrong thing. Expose them from an environment where they can be live-verified.
const BUSINESS_RULE_ACTIONS = { SetVisibility: 'visible', LockUnlock: 'lock', SetBusinessRequired: 'required', SetFieldValue: 'value' };
const BUSINESS_RULE_ACTION_TYPES = Object.keys(BUSINESS_RULE_ACTIONS);
// Boolean-payload actions, so a string "false" (truthy in JS) is rejected rather than silently
// inverting the author's intent — the same trap `app.newLook` validation exists to close.
const BUSINESS_RULE_BOOLEAN_ACTIONS = new Set(['SetVisibility', 'LockUnlock', 'SetBusinessRequired']);
// `valueWorkflowType` in SDK terms: how the platform should interpret the literal. Named `dataType`
// in the App Spec because `valueType` in the SDK means something else (Value vs Field vs Lookup),
// and only `Value` is supported — so exposing that name would invite a distinction authors cannot use.
//
// This list has NO counterpart in the bundle any more, and nothing pins it. It used to mirror the
// XAML compiler's literal-type map, which this SDK uptake deleted along with the compiler.
//
// MEASURED against the replacement JSON path: `dataType` is IGNORED. Across all ten tokens below —
// and a made-up one — on both the condition path and the SetFieldValue action path, the serializer
// emits WorkflowAttributeType String ("14") every time:
//   let r = valueType==='Lookup' ? … : valueType==='Clear' ? (valueWorkflowType ?? String)
//                                    : WorkflowAttributeType.String
// So this is a curated closed set kept for two reasons only: it catches a typo at the spec gate, and
// it keeps the surface forward-compatible if the SDK starts honouring the field. Do NOT add a token
// on the assumption a test will validate it against the SDK — no such test can exist while there is
// nothing to validate against. `business-rules.test.js` instead pins the measured no-op.
const BUSINESS_RULE_DATA_TYPES = ['String', 'Memo', 'Picklist', 'State', 'Status', 'Boolean', 'Integer', 'Double', 'Decimal', 'Money'];
// Only entity scope is supported. A form-scoped rule needs `processtriggerscope 1` plus a form id,
// which cannot be resolved before the forms phase has run.
const BUSINESS_RULE_SCOPES = ['Entity'];

// Normalize a Dataverse language identifier (LCID) to a positive integer, or null if it is not one.
//
// This is the SINGLE definition used by all three entry points an LCID can arrive from, so they can
// never disagree about what is valid: the `--language-code` CLI flag (always a string), the App Spec
// `languageCode` field (JSON, so nominally a number but in practice anything), and a programmatic
// caller of resolveLanguageCode().
//
// It deliberately does NOT use a bare `Number(value)` cast, which is far too lenient for a value that
// is sent straight to Dataverse as a label LanguageCode:
//   Number(true)   === 1     -> `"languageCode": true` would build every label with LCID 1
//   Number([1033]) === 1033  -> a one-element array would silently "work"
//   Number('1e3')  === 1000  -> exponent notation is never a real LCID
// Each of those passes a naive positive-integer check and then fails deep inside the data-model phase
// with an opaque Dataverse 400, instead of a clear spec/CLI error up front. Accept only a real number
// or an all-digits string, and bound it: an LCID is a 16-bit value, so anything above 0xFFFF cannot be
// one and would fail the same opaque way (65536, 1e20 and MAX_SAFE_INTEGER all cleared an unbounded
// positive-integer check).
// LCID reference: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-lcid/
const MAX_LCID = 0xFFFF;
function normalizeLanguageCode(value) {
  const ok = (n) => (n > 0 && n <= MAX_LCID ? n : null);
  if (typeof value === 'number') return Number.isInteger(value) ? ok(value) : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return ok(Number(value.trim()));
  return null;
}

// Normalize a page's implementation source into a discriminated shape:
//   { kind: 'tsx', codeFile } | { kind: 'intent' } | null
// A legacy top-level `codeFile` (schemaVersion < 2) is treated as an implemented tsx page. `null`
// means the page declares neither a source nor a codeFile. Whitespace-only codeFile values are
// treated as absent (codeFile trimmed to undefined) so a blank value fails the structural check
// rather than silently being treated as an implemented page.
function normalizePageSource(page) {
  if (page && page.source && typeof page.source === 'object') {
    if (page.source.kind === 'intent') return { kind: 'intent' };
    if (page.source.kind === 'tsx') {
      // Trim so '   ' is treated identically to undefined — blank is not an implemented codeFile.
      const codeFile = typeof page.source.codeFile === 'string' ? page.source.codeFile.trim() || undefined : page.source.codeFile;
      return { kind: 'tsx', codeFile };
    }
    return { kind: page.source.kind }; // malformed — surfaced by the validator below
  }
  // Treat a whitespace-only legacy codeFile as absent so it fails the implemented check.
  if (page && typeof page.codeFile === 'string' && page.codeFile.trim()) {
    return { kind: 'tsx', codeFile: page.codeFile.trim() };
  }
  return null;
}

// Whether the build should enable "Allow quick create" (`IsQuickCreateEnabled`) on a table.
// TWO triggers, both author-controlled:
//   1. explicit `entities[].quickCreate === true`, OR
//   2. the spec authors a `formType: 'QuickCreate'` form for that entity — enabling the flag then
//      just makes the form the author already declared actually reachable (the inline "+ New" from a
//      lookup / sub-grid). Authoring a Quick Create form but leaving the table flag OFF is a footgun:
//      the form exists but the platform never surfaces it, so we treat the authored QC form as intent.
// PURE: both the build engine (entity-provision.js) and the eval fact extractor (schema-facts.js) call
// this so the eval grades the EXACT rule the engine applies (DRY — never a naive spec echo).
function quickCreateEnabledFor(spec, entity) {
  if (!entity) return false;
  if (entity.quickCreate === true) return true;
  const logical = String(entity.schemaName || '').toLowerCase();
  if (!logical) return false;
  return (spec && spec.forms || []).some(
    (f) => f && f.formType === 'QuickCreate' && String(f.entity || '').toLowerCase() === logical,
  );
}

// A maker-facing `description`, supported on every artifact whose SDK create surface accepts one
// (table, column, view, chart, form, dashboard, business rule, app, web resource).
//
// Deliberately a soft contract: descriptions are OPTIONAL, because making them mandatory would fail
// every spec authored before they existed. What is validated is only that a supplied value is usable
// — a number or an object here means the author meant something else, and silently stringifying it
// would write "[object Object]" into Dataverse.
//
// 2000 is the Dataverse ceiling for a description Label; the platform truncates past it rather than
// erroring, so catching it here is the only place the author finds out.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/entity-attribute-metadata
const DESCRIPTION_MAX = 2000;
function validateDescription(value, label, errors, opts = {}) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    errors.push(`${label}: description must be a string`);
    return;
  }
  // `app.description` predates this contract and countless existing specs (and every spec emitted by
  // `download-model-app`) carry it as `""`. Rejecting that would fail specs that are otherwise fine,
  // so emptiness is tolerated exactly where it is already established — never for a NEW surface,
  // where an empty string is the one value that could blank a maker's text on rebuild.
  if (!value.trim()) {
    if (opts.allowEmpty) return;
    errors.push(`${label}: description must not be blank — omit the field instead of setting an empty string`);
    return;
  }
  if (value.length > DESCRIPTION_MAX) {
    errors.push(`${label}: description is ${value.length} characters (max ${DESCRIPTION_MAX})`);
  }
}

// Per-control form-field options: `readOnly`, `hidden`, `after`.
//
// Reachable two ways — inline on an EXPLICIT layout's `sections[].fields[]` entry, or via the
// form-level `fieldOptions` map (the only route under an AUTO layout, which has no field list).
//
// Only the ENABLED state is written by the build (`isReadOnly: true` / `visible: false`); `false` is
// a no-op rather than an un-set, so it is rejected here instead of being accepted and quietly
// ignored — an author who writes `readOnly: false` expecting it to clear an existing lock would
// otherwise get a green build and no change.
// `forms[].securityRoles` — who a form is offered to. AB#6648526.
//
// Direction matters and is easy to get backwards: a form with NO assignment is offered to EVERY
// role, so declaring this RESTRICTS the form. That makes every failure mode here access-relevant —
// a typo'd persona or an empty list narrows a form to nobody — so each is a hard error rather than
// a warning, and the build additionally halts on an unresolvable persona.
//
// `everyone` and `roleIds` are mutually exclusive in the PLATFORM's model (`<Everyone />` replaces
// the `<Role>` list rather than adding to it), not merely in this validator; the SDK rejects the
// combination with INVALID_ARGUMENT, so catching it here just names the form.
function validateFormSecurityRoles(f, spec, errors) {
  const sr = f.securityRoles;
  if (sr === undefined) return;
  const label = `form '${f.name || f.entity}'`;
  if (!sr || typeof sr !== 'object' || Array.isArray(sr)) {
    errors.push(`${label}: securityRoles must be an object like { "personas": ["Dispatcher"] } or { "everyone": true }`);
    return;
  }
  const known = new Set(['personas', 'everyone', 'fallbackForm', 'order']);
  for (const k of Object.keys(sr)) {
    if (!known.has(k)) errors.push(`${label}: securityRoles has unknown key '${k}' — expected ${[...known].join(', ')}`);
  }

  const hasEveryone = sr.everyone !== undefined;
  if (hasEveryone && typeof sr.everyone !== 'boolean') {
    errors.push(`${label}: securityRoles.everyone must be a boolean`);
  }
  // `everyone: false` is not "restrict to nobody" — it is an author reaching for a switch that does
  // not exist.
  if (sr.everyone === false) {
    errors.push(`${label}: securityRoles.everyone: false does nothing — use "everyone": true to make the form available to every role again, or list personas to restrict it`);
  }

  if (sr.personas !== undefined) {
    if (!Array.isArray(sr.personas) || sr.personas.some((p) => typeof p !== 'string' || !p.trim())) {
      errors.push(`${label}: securityRoles.personas must be an array of persona names`);
    } else if (!sr.personas.length) {
      errors.push(`${label}: securityRoles.personas is empty — that would offer the form to NO role. List at least one persona, or use "everyone": true.`);
    } else {
      // Resolved against `personas[]` at author time so a typo is a spec error naming the form,
      // rather than a build halt two minutes into a run.
      const declared = new Set((spec.personas || []).map((p) => String(canonicalPersonaName(p) || '').toLowerCase()));
      for (const p of sr.personas) {
        if (!declared.has(String(p).trim().toLowerCase())) {
          errors.push(`${label}: securityRoles names persona '${p}', which is not declared in personas[]`);
        }
      }
      const dupes = sr.personas.map((p) => String(p).trim().toLowerCase()).filter((p, i, a) => a.indexOf(p) !== i);
      if (dupes.length) errors.push(`${label}: securityRoles lists persona '${dupes[0]}' more than once`);
    }
  }

  if (sr.everyone === true && sr.personas !== undefined) {
    errors.push(`${label}: securityRoles cannot set both 'everyone' and 'personas' — the platform models <Everyone /> as a replacement for the role list, not an addition to it`);
  }
  if (!hasEveryone && sr.personas === undefined) {
    errors.push(`${label}: securityRoles must say who the form is for — set 'personas' or 'everyone': true`);
  }

  if (sr.fallbackForm !== undefined && typeof sr.fallbackForm !== 'boolean') {
    errors.push(`${label}: securityRoles.fallbackForm must be a boolean`);
  }
  if (sr.order !== undefined && (!Number.isInteger(sr.order) || sr.order < 0)) {
    errors.push(`${label}: securityRoles.order must be a non-negative integer (got ${JSON.stringify(sr.order)})`);
  }

  // The build addresses this form by (entity, formType, name) — `created.forms` is keyed by entity
  // and holds only the Main form, so a later phase cannot reach a sibling any other way. Duplicate
  // (entity, formType, name) is otherwise LEGAL here: only QuickView forms are checked for a unique
  // (entity, name), because Main and Card may both be called "Information" harmlessly.
  //
  // Harmless, that is, until one of them declares securityRoles: the map would keep whichever was
  // built last, and the restriction would land on the wrong form while every structural check passed
  // and the build reported success. Reject the ambiguity instead of picking a winner.
  const twin = (spec.forms || []).filter((o) => o
    && String(o.entity || '').toLowerCase() === String(f.entity || '').toLowerCase()
    && (o.formType || 'Main') === (f.formType || 'Main')
    && String(o.name || '') === String(f.name || ''));
  if (twin.length > 1) {
    errors.push(`${label}: securityRoles needs a form this spec can identify unambiguously, but ${twin.length} forms share (entity ${f.entity}, type ${f.formType || 'Main'}, name '${f.name || ''}') — rename one, or move the assignment to the form you meant`);
  }
}

function validateFormFieldOptions(f, entityByLower, errors, warnings) {
  const label = `form '${f.name || f.entity}'`;
  const entity = entityByLower.get(String(f.entity || '').toLowerCase());
  const columnType = (logical) => {
    if (!entity) return undefined;
    const c = (entity.columns || []).find((x) => x && x.schemaName && x.schemaName.toLowerCase() === logical);
    return c && (c.type || 'Text');
  };
  const explicit = Array.isArray(f.tabs) || f.layout === 'explicit';
  // Every field this form declares an option for, from either route, so the checks below run once
  // per (field, source) pair with a source-accurate message.
  const seen = [];
  // Fields the EXPLICIT layout lists by position. An `after` anchor for one of these — from either
  // route — would give the form two competing orderings.
  const listedByLayout = new Set();

  for (const t of (Array.isArray(f.tabs) ? f.tabs : [])) {
    for (const s of ((t && t.sections) || [])) {
      if (s && s.fields !== undefined && !Array.isArray(s.fields)) {
        // Guard the compiler, which does `(s.fields || []).map(...)`. A string is ITERABLE and every
        // character of it IS a string, so a `fields: "new_name"` typo would pass a naive per-entry
        // check and then throw a raw TypeError at compile time instead of producing a finding. A
        // non-iterable value (`{}`, `3`) would throw right here. Note `spec-shape.js` does not model
        // `fields`, so `normalizeSpecShape` does not coerce it — this check is load-bearing.
        errors.push(`${label}: a section's fields must be an array of column logical names`);
        continue;
      }
      for (const entry of ((s && s.fields) || [])) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          if (!entry.name || typeof entry.name !== 'string') {
            errors.push(`${label}: a field entry object is missing a string 'name'`);
            continue;
          }
          listedByLayout.add(String(entry.name).toLowerCase());
          seen.push({ name: String(entry.name).toLowerCase(), opt: entry, where: `field '${entry.name}'`, inline: true });
        } else if (typeof entry === 'string') {
          listedByLayout.add(entry.toLowerCase());
        } else {
          errors.push(`${label}: a field entry must be a column logical name or an object { name, readOnly?, hidden?, after? }`);
        }
      }
    }
  }

  if (f.fieldOptions !== undefined) {
    if (!f.fieldOptions || typeof f.fieldOptions !== 'object' || Array.isArray(f.fieldOptions)) {
      errors.push(`${label}: fieldOptions must be an object keyed by column logical name`);
    } else {
      for (const key of Object.keys(f.fieldOptions)) {
        const v = f.fieldOptions[key];
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          errors.push(`${label}: fieldOptions['${key}'] must be an object { readOnly?, hidden?, after? }`);
          continue;
        }
        seen.push({ name: String(key).toLowerCase(), opt: v, where: `fieldOptions['${key}']`, inline: false });
      }
    }
  }

  for (const { name, opt, where, inline } of seen) {
    for (const flag of ['readOnly', 'hidden']) {
      if (opt[flag] === undefined) continue;
      if (typeof opt[flag] !== 'boolean') {
        errors.push(`${label}: ${where} ${flag} must be a boolean`);
      } else if (opt[flag] === false) {
        errors.push(`${label}: ${where} sets ${flag}: false, which the build cannot apply — it only ever writes the ENABLED state, so a maker's existing setting is never silently cleared. Omit the flag, or clear it in the form designer.`);
      }
    }
    if (opt.after !== undefined) {
      if (typeof opt.after !== 'string' || !opt.after.trim()) {
        errors.push(`${label}: ${where} after must be the logical name of another field on this form`);
      } else if (String(opt.after).toLowerCase() === name) {
        errors.push(`${label}: ${where} anchors '${name}' after itself`);
      } else if (inline || listedByLayout.has(name)) {
        // An explicit layout already expresses order by listing position, so honouring `after` for a
        // listed field would give the form two competing orderings — and they would DISAGREE: the
        // create path follows the authored list, while the reconcile applies the anchor, so the same
        // spec would produce one order on a new form and another on the first rebuild.
        // A form-level anchor for a field the layout does NOT list stays legal: that is the
        // `prune: false` case, where the point is to position a control on a deployed form without
        // re-declaring the rest of it.
        errors.push(`${label}: ${where} cannot use 'after' for a field an explicit tabs layout already lists — the listed order positions it. Move it in the list instead, or drop it from the list if you mean to position it against fields this layout does not declare.`);
      }
    }
    // A BigInt has no Unified Interface control, so a form placement renders "Error loading control".
    // Auto layout skips them outright; an explicit layout still honours the author, but declaring
    // per-control options for one is almost certainly a mistake worth surfacing.
    if (columnType(name) === 'BigInt') {
      warnings.push(`${label}: ${where} targets '${name}', a BigInt column — Big Integer has no Unified Interface form control, so it renders "Error loading control" wherever it is placed`);
    }
  }

  // Two contradictory anchor shapes. Both are silently unstable rather than wrong-but-stable: the
  // reconcile moves each field to its anchor on every build and they undo each other, so the form
  // never converges and a rebuild issues writes forever. Neither can be resolved automatically —
  // "immediately after X" cannot be true of two fields at once, and a cycle has no valid order — so
  // they are rejected at author time instead of being papered over by the placement code.
  const anchorOf = new Map();
  for (const { name, opt } of seen) {
    if (opt.after && typeof opt.after === 'string') anchorOf.set(name, String(opt.after).toLowerCase());
  }
  const claimants = new Map();
  for (const [name, anchor] of anchorOf) {
    if (!claimants.has(anchor)) claimants.set(anchor, []);
    claimants.get(anchor).push(name);
  }
  for (const [anchor, names] of claimants) {
    if (names.length > 1) {
      errors.push(`${label}: ${names.map((n) => `'${n}'`).join(' and ')} are both anchored after '${anchor}' — only one field can sit immediately after another. Chain them instead (anchor the second one after the first).`);
    }
  }
  for (const start of anchorOf.keys()) {
    const seenInWalk = new Set([start]);
    let cur = anchorOf.get(start);
    while (cur !== undefined) {
      if (seenInWalk.has(cur)) {
        if (cur === start) errors.push(`${label}: the 'after' anchors form a cycle through '${start}' — there is no order that satisfies them all.`);
        break;
      }
      seenInWalk.add(cur);
      cur = anchorOf.get(cur);
    }
  }

  if (f.prune !== undefined) {
    if (typeof f.prune !== 'boolean') {
      errors.push(`${label}: prune must be a boolean`);
    } else if (f.prune === false && !explicit) {
      warnings.push(`${label}: prune: false has no effect on an auto layout — an auto layout is already additive and never removes a field`);
    }
  }

  // An explicit layout that names a BigInt column produces a broken control on a live record. It is a
  // warning, not an error: the author asked for it by name and may be pairing it with a custom control.
  if (explicit) {
    for (const t of (Array.isArray(f.tabs) ? f.tabs : [])) {
      for (const s of ((t && t.sections) || [])) {
        // Re-guard: the array check in the first loop `continue`s that loop only. Without repeating
        // it here a non-iterable `fields` (e.g. `{}` or `3`) throws a raw TypeError out of
        // validateAppSpec — discarding the correct finding the first loop already pushed.
        if (!Array.isArray(s && s.fields)) continue;
        for (const entry of s.fields) {
          const nm = String((entry && typeof entry === 'object' ? entry.name : entry) || '').toLowerCase();
          if (nm && columnType(nm) === 'BigInt') {
            warnings.push(`${label}: field '${nm}' is a BigInt column — Big Integer has no Unified Interface form control, so it will render "Error loading control" on every record. Keep it off the form (it stays readable through the API).`);
          }
        }
      }
    }
  }
}

function validateAppSpec(spec, opts = {}) {
  const profile = opts.profile || 'deploy';
  const errors = [];
  // Non-blocking advisories (e.g. a PRE-EXISTING duplicate page name the current run did not create).
  // Additive to the return shape — callers that only read { ok, errors } are unaffected.
  const warnings = [];
  if (!VALIDATION_PROFILES.includes(profile)) {
    return { ok: false, errors: [`unknown validation profile '${profile}' (valid: ${VALIDATION_PROFILES.join(', ')})`], warnings };
  }
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['spec is not an object'], warnings };
  }
  // Structural normalization (shared with lintAppSpec) so a half-typed collection produces findings
  // rather than a raw TypeError. Covers NESTED collections too — `entity.columns: {}` and
  // `appShell.areas: {}` are realistic mid-edit states that reach `for...of` and throw.
  const shape = normalizeSpecShape(spec);
  errors.push(...shape.errors);
  spec = shape.spec;
  if (!spec.solution || !spec.solution.uniqueName) {
    errors.push('solution.uniqueName is required');
  }
  if (!spec.solution || !spec.solution.publisherPrefix) {
    errors.push('solution.publisherPrefix is required');
  }
  if (!spec.app || !spec.app.name) {
    errors.push('app.name is required');
  }
  validateDescription(spec.solution && spec.solution.description, 'solution', errors);
  // allowEmpty: `app.description: ""` is the established shape (download-model-app emits it).
  validateDescription(spec.app && spec.app.description, 'app', errors, { allowEmpty: true });
  for (const gc of spec.globalChoices || []) {
    validateDescription(gc && gc.description, `globalChoice '${(gc && gc.name) || '(unnamed)'}'`, errors);
  }
  // The modern ("new look") shell is an opt-in per-app SETTING, not an appmodule column —
  // `navigationtype` only selects Single/Multi session and is unrelated. Boolean-only: a string
  // "false" is truthy in JS and would silently turn the new look ON for an author who meant to
  // disable it.
  if (spec.app && spec.app.newLook !== undefined && typeof spec.app.newLook !== 'boolean') {
    errors.push('app.newLook must be a boolean');
  }
  // The Wave 2 header/navigation refresh is a SEPARATE public-preview setting from the new look;
  // enabling one does not enable the other. Boolean-only for the same reason as newLook — a string
  // "false" is truthy and would silently turn the feature ON for an author who meant to disable it.
  if (spec.app && spec.app.headerNavigationRefresh !== undefined && typeof spec.app.headerNavigationRefresh !== 'boolean') {
    errors.push('app.headerNavigationRefresh must be a boolean');
  }
  if (spec.languageCode !== undefined && normalizeLanguageCode(spec.languageCode) === null) {
    errors.push('languageCode must be a positive integer LCID');
  }
  const entityNames = new Set();
  const entityByLower = new Map(); // logical (lowercased schemaName) -> entity
  for (const e of spec.entities || []) {
    if (!e.schemaName) {
      errors.push('entity.schemaName is required');
    } else {
      entityNames.add(e.schemaName);
      entityByLower.set(e.schemaName.toLowerCase(), e);
    }
    if (!e.primaryAttribute || !e.primaryAttribute.schemaName) {
      errors.push(`entity ${e.schemaName}: primaryAttribute.schemaName required`);
    }
    if (e.quickCreate !== undefined && typeof e.quickCreate !== 'boolean') {
      errors.push(`entity ${e.schemaName}: quickCreate must be a boolean`);
    }
    validateDescription(e.description, `entity ${e.schemaName}`, errors);
    for (const c of e.columns || []) {
      if (!c.schemaName) {
        errors.push(`entity ${e.schemaName}: a column is missing schemaName`);
      }
      validateDescription(c.description, `entity ${e.schemaName}: column ${c.schemaName}`, errors);
      // A Customer column is created through `createCustomerColumn`, whose payload is only
      // { Lookup, OneToManyRelationships } — the SDK has nowhere to put a description, so one
      // authored here is silently discarded. Warn rather than error: the spec is still valid and
      // still builds; the author just needs to know the value will not appear in Dataverse.
      if (c.type === 'Customer' && c.description) {
        warnings.push(`entity ${e.schemaName}: column ${c.schemaName} is a Customer column — the SDK's createCustomerColumn accepts no description, so this one will NOT be written to Dataverse`);
      }
      if (c.type && !TYPE_MAP[c.type]) {
        errors.push(`entity ${e.schemaName}: column ${c.schemaName} has unknown type '${c.type}'`);
      }
      if ((c.type === 'Choice' || c.type === 'MultiChoice') && !(Array.isArray(c.options) && c.options.length) && !c.globalChoice) {
        errors.push(`column ${c.schemaName}: ${c.type} needs options[] or a globalChoice reference`);
      }
      // Grid data visualization (preview). Only the enum is enforced. Column-TYPE compatibility is
      // deliberately NOT enforced: the SDK does not constrain it either, and the sensible pairings
      // are not a clean "numeric only" rule (LineChart is documented for a TEXT column holding
      // comma-separated numbers). Guessing a constraint the platform does not have would reject
      // valid specs, so type guidance lives in the schema doc instead.
      if (c.visualization !== undefined && !COLUMN_VISUALIZATIONS.includes(c.visualization)) {
        errors.push(`entity ${e.schemaName}: column ${c.schemaName} has unknown visualization '${c.visualization}' — must be one of ${COLUMN_VISUALIZATIONS.join('|')}`);
      }
      // AB#6648523: Boolean default value. The SDK used to hardcode `DefaultValue: false`; the
      // vendored bundle now honours an explicit value on create AND update (measured against
      // cds-maker-sdk.cjs). Boolean-only for the same reason as the form-event flags below —  a
      // truthy-but-non-boolean value (e.g. the string "false") must be rejected, not coerced — and
      // type-gated to the exact 'Boolean' column: the SDK itself throws InvalidArgumentError for
      // defaultValue on any other type, so this just moves that same failure to the spec gate and
      // names the column instead of surfacing mid-build.
      if (c.defaultValue !== undefined) {
        if (typeof c.defaultValue !== 'boolean') {
          errors.push(`entity ${e.schemaName}: column ${c.schemaName} defaultValue must be a boolean (got ${JSON.stringify(c.defaultValue)})`);
        } else if (c.type !== 'Boolean') {
          errors.push(`entity ${e.schemaName}: column ${c.schemaName} defaultValue is only valid on a Boolean column (this one is '${c.type || 'Text'}')`);
        }
      }
      // AB#6648522: Whole Number display Format (e.g. render a raw integer count of minutes as a
      // Duration picker in the maker UI). Restricted to the exact 'Integer' App Spec type, NOT the
      // wider Integer/BigInt/Decimal/Double/Money switch case columnOptions() shares for min/max/
      // precision — the SDK's Format option is Integer-only, so a spec targeting Decimal would
      // otherwise pass this gate and hit the SDK's own InvalidArgumentError deep inside the
      // data-model phase instead of here.
      if (c.integerFormat !== undefined) {
        if (!INTEGER_FORMATS.includes(c.integerFormat)) {
          errors.push(`entity ${e.schemaName}: column ${c.schemaName} has unknown integerFormat '${c.integerFormat}' — must be one of ${INTEGER_FORMATS.join('|')}`);
        } else if (c.type !== 'Integer') {
          errors.push(`entity ${e.schemaName}: column ${c.schemaName} integerFormat is only valid on an Integer column (this one is '${c.type || 'Text'}')`);
        }
      }
      // AB#6651276: per-verb write/read permissions (e.g. isValidForUpdate:false makes a column
      // write-once after creation — the entire point of the feature, so `false` must validate and
      // build identically to `true`). Boolean-only, same reasoning as the form-event flags below.
      // Type-agnostic per the SDK — every buildable column type accepts these on BOTH create and
      // update (measured) — EXCEPT Customer, which is created through createCustomerColumn, a
      // wholly separate SDK call whose options carry no such fields. Warned rather than rejected
      // there, matching the Customer + description precedent above: the spec stays valid and still
      // builds, the author just needs to know the flag will not reach Dataverse.
      let hasValidForFlag = false;
      for (const flag of ['isValidForCreate', 'isValidForUpdate', 'isValidForRead']) {
        if (c[flag] === undefined) continue;
        hasValidForFlag = true;
        if (typeof c[flag] !== 'boolean') {
          errors.push(`entity ${e.schemaName}: column ${c.schemaName} ${flag} must be a boolean (got ${JSON.stringify(c[flag])})`);
        }
      }
      if (hasValidForFlag && c.type === 'Customer') {
        warnings.push(`entity ${e.schemaName}: column ${c.schemaName} is a Customer column — the SDK's createCustomerColumn accepts no isValidForCreate/isValidForUpdate/isValidForRead, so these will NOT be written to Dataverse`);
      }
    }
  }
  if (!entityNames.size) {
    errors.push('at least one entity is required');
  }
  // Web resources (optional — JS/HTML/CSS shipped for form logic).
  const WEB_RESOURCE_KINDS = new Set(['js', 'html', 'css', 'xml', 'png', 'jpg', 'gif', 'xsl', 'ico', 'svg', 'resx']);
  const FORM_EVENTS = new Set(['onload', 'onsave', 'onchange']);
  const webResourceNames = new Set();
  const IMAGE_WR_TYPES = new Set(['png', 'jpg', 'gif', 'svg', 'ico']);
  const imageWebResourceNames = new Set();
  const svgWebResourceNames = new Set();      // SVG only — valid for a table's vector icon
  const rasterWebResourceNames = new Set();   // png/jpg/gif/ico — valid for a table's raster icon
  for (const wr of spec.webResources || []) {
    if (!wr || !wr.name) { errors.push('a webResource is missing a name'); continue; }
    validateDescription(wr.description, `webResource '${wr.name}'`, errors);
    webResourceNames.add(wr.name.toLowerCase());
    const wrType = String(wr.type || '').toLowerCase();
    if (IMAGE_WR_TYPES.has(wrType)) imageWebResourceNames.add(wr.name.toLowerCase());
    if (wrType === 'svg') svgWebResourceNames.add(wr.name.toLowerCase());
    else if (IMAGE_WR_TYPES.has(wrType)) rasterWebResourceNames.add(wr.name.toLowerCase());
    if (!WEB_RESOURCE_KINDS.has(String(wr.type || 'js').toLowerCase())) {
      errors.push(`webResource ${wr.name}: type must be one of ${[...WEB_RESOURCE_KINDS].join('|')}`);
    }
    if (wr.content === undefined && wr.contentBase64 === undefined && !wr.contentPath) {
      errors.push(`webResource ${wr.name}: needs content, contentBase64, or contentPath`);
    }
  }
  // #6: a Main form that sets deactivateOtherMainForms must be the ONLY Main form declared for its
  // entity. Rationale: forms build concurrently and every Main form on an OWN custom table is promoted
  // to isdefault. If a flagged form shares its entity with ANOTHER Main form (flagged or not), the
  // sibling can win the isdefault race and then be deactivated by the flagged form's pass — leaving the
  // entity's default form INACTIVE (a bricked form experience). Requiring the flagged form to stand
  // alone removes the race entirely: the only other active main form is then the stock "Information"
  // form (which the build never promotes), so deactivating it is safe.
  const mainFormsByEntity = {};
  const flaggedByEntity = {};
  for (const f of spec.forms || []) {
    if (!f || (f.formType !== undefined && f.formType !== 'Main')) continue;
    const key = String(f.entity || '').toLowerCase();
    mainFormsByEntity[key] = (mainFormsByEntity[key] || 0) + 1;
    if (f.deactivateOtherMainForms === true) flaggedByEntity[key] = (flaggedByEntity[key] || 0) + 1;
  }
  for (const [ent, n] of Object.entries(flaggedByEntity)) {
    if (n > 1) {
      errors.push(`entity '${ent}': ${n} Main forms set deactivateOtherMainForms — at most one may (two would deactivate each other)`);
    } else if ((mainFormsByEntity[ent] || 0) > 1) {
      errors.push(`entity '${ent}': a Main form sets deactivateOtherMainForms but the entity declares ${mainFormsByEntity[ent]} Main forms — a flagged form must be the ONLY Main form for its entity (a concurrent build would nondeterministically deactivate the sibling and could leave the default form inactive)`);
    }
  }
  for (const f of spec.forms || []) {
    validateDescription(f.description, `form '${f.name || f.entity}'`, errors);
    if (!entityNames.has(f.entity)) {
      errors.push(`form references unknown entity '${f.entity}'`);
    }
    if (f.layout !== undefined && f.layout !== 'auto' && f.layout !== 'explicit') {
      errors.push(`form ${f.entity}: layout must be 'auto' or 'explicit'`);
    }
    const formType = f.formType === undefined ? 'Main' : f.formType;
    if (!['Main', 'QuickCreate', 'QuickView'].includes(formType)) {
      errors.push(`form ${f.entity}: formType must be one of Main|QuickCreate|QuickView`);
    }
    // Optional author-pinned target: a GUID that reconciles an EXACT existing form when a table has two
    // forms of the same (entity, type, name) that type-scoped resolution can't disambiguate. Validated
    // here because the build interpolates it UNQUOTED into an Edm.Guid OData filter (a non-GUID would both
    // break the query and be an injection seam).
    if (f.formId !== undefined && !FORM_GUID_RE.test(String(f.formId))) {
      errors.push(`form ${f.entity}: formId '${f.formId}' is not a valid GUID`);
    }
    if (formType !== 'Main' && Array.isArray(f.subgrids) && f.subgrids.length) {
      errors.push(`form ${f.entity}: ${formType} forms can't host sub-grids (Main forms only)`);
    }
    if (formType === 'QuickView' && Array.isArray(f.events) && f.events.length) {
      errors.push(`form ${f.entity}: QuickView forms are read-only and can't have event handlers`);
    }
    for (const ev of f.events || []) {
      if (!ev || !FORM_EVENTS.has(ev.event)) { errors.push(`form ${f.entity}: event must be one of ${[...FORM_EVENTS].join('|')}`); continue; }
      if (!ev.library) errors.push(`form ${f.entity}: ${ev.event} handler is missing a library (web-resource name)`);
      else if (!webResourceNames.has(String(ev.library).toLowerCase())) errors.push(`form ${f.entity}: ${ev.event} handler references undeclared web resource '${ev.library}'`);
      if (!ev.function) errors.push(`form ${f.entity}: ${ev.event} handler is missing a function name`);
      if (ev.event === 'onchange' && !ev.attribute) errors.push(`form ${f.entity}: onchange handler requires an attribute (column logical name)`);
      // These three are documented as optional with defaults, and are now actually honoured by the
      // build (they used to be hardcoded and the authored value discarded). Validate the types so a
      // string "false" — which is truthy in JS and would silently enable a handler the author meant
      // to disable — is rejected rather than coerced.
      for (const flagKey of ['enabled', 'passExecutionContext']) {
        if (ev[flagKey] !== undefined && typeof ev[flagKey] !== 'boolean') {
          errors.push(`form ${f.entity}: ${ev.event} handler ${flagKey} must be a boolean (got ${JSON.stringify(ev[flagKey])})`);
        }
      }
      if (ev.parameters !== undefined && typeof ev.parameters !== 'string') {
        errors.push(`form ${f.entity}: ${ev.event} handler parameters must be a string (a comma-separated argument list)`);
      }
    }
    for (const qv of f.quickViews || []) {
      if (!qv || !qv.lookup) { errors.push(`form ${f.entity}: a quickView is missing lookup (the lookup column logical name on this form)`); continue; }
      if (!qv.targetEntity || !entityByLower.has(String(qv.targetEntity).toLowerCase())) errors.push(`form ${f.entity}: quickView references unknown targetEntity '${qv.targetEntity}'`);
      if (!qv.form) { errors.push(`form ${f.entity}: quickView is missing form (the name of a QuickView form in forms[])`); continue; }
      // Resolve by (name, targetEntity) AND prefer the QuickView — a same-named Main on the target entity
      // must not shadow the intended QuickView (order-dependent otherwise; Sol review). The build keys the
      // quick-view lookup by (entity, QuickView, name) too.
      const qvCandidates = (spec.forms || []).filter((x) => x.name === qv.form && String(x.entity).toLowerCase() === String(qv.targetEntity || '').toLowerCase());
      const qf = qvCandidates.find((x) => (x.formType || 'Main') === 'QuickView') || qvCandidates[0];
      if (!qf) errors.push(`form ${f.entity}: quickView references form '${qv.form}' (a QuickView on '${qv.targetEntity}') not found in forms[]`);
      else if ((qf.formType || 'Main') !== 'QuickView') errors.push(`form ${f.entity}: quickView form '${qv.form}' must have formType: "QuickView"`);
    }
    if (f.subgrids !== undefined) {
      if (!Array.isArray(f.subgrids)) {
        errors.push(`form ${f.entity}: subgrids must be an array`);
      } else {
        for (const sg of f.subgrids) {
          if (!sg || !sg.childEntity) {
            errors.push(`form ${f.entity}: a subgrid is missing childEntity`);
            continue;
          }
          if (!entityByLower.has(String(sg.childEntity).toLowerCase())) {
            errors.push(`form ${f.entity}: subgrid references unknown childEntity '${sg.childEntity}'`);
            continue;
          }
          if (!relationshipFor(spec, f.entity, sg.childEntity) && !manyToManyFor(spec, f.entity, sg.childEntity)) {
            errors.push(
              `form ${f.entity}: no OneToMany or ManyToMany relationship between '${f.entity}' and subgrid childEntity '${sg.childEntity}'`
            );
          }
        }
      }
    }
    validateFormFieldOptions(f, entityByLower, errors, warnings);
    validateFormSecurityRoles(f, spec, errors);
    // `layout: 'explicit'` with no `tabs[]` is a spec that asks for one thing and builds another.
    // `compileFormIntent` takes the explicit path only when `tabs` is an ARRAY, so this combination
    // silently compiles an AUTO layout — while `prune` and the field-positioning rules read as
    // explicit-layout behaviour to the author. Rejected rather than warned: the two layouts differ in
    // whether a rebuild REMOVES deployed fields, so guessing wrong is destructive.
    if (f && f.layout === 'explicit' && !Array.isArray(f.tabs)) {
      errors.push(`form '${f.name || f.entity}': layout is 'explicit' but no tabs[] were authored — an explicit layout IS its tabs. Author tabs[], or drop layout: 'explicit' to use the auto layout.`);
    }
  }
  // Two QuickView forms sharing (entity, name) make a quick-view reference — which resolves a QuickView by
  // (targetEntity, name) — ambiguous (the build map keeps only one, order-dependently). Reject the
  // ambiguity at author time (Sol review). Main/Card share the "Information" name harmlessly (they're not
  // quick-view targets), so this is scoped to QuickView.
  const qvIdentity = new Set();
  for (const f of spec.forms || []) {
    if (!f || (f.formType || 'Main') !== 'QuickView' || !f.name) continue;
    const key = `${String(f.entity).toLowerCase()}|${String(f.name).toLowerCase()}`;
    if (qvIdentity.has(key)) errors.push(`form ${f.entity}: duplicate QuickView form '${f.name}' — two QuickView forms on one table can't share a name (a quick-view reference resolves a QuickView by name)`);
    qvIdentity.add(key);
  }
  for (const ch of spec.charts || []) {
    validateDescription(ch && ch.description, `chart '${(ch && (ch.name || ch.entity)) || '(unnamed)'}'`, errors);
    if (!ch || !ch.entity || !entityByLower.has(String(ch.entity).toLowerCase())) {
      errors.push(`chart references unknown entity '${ch && ch.entity}'`);
      continue;
    }
    if (!ch.name) {
      errors.push(`chart on '${ch.entity}': name is required`);
    }
    if (!CHART_TYPES.includes(ch.chartType)) {
      errors.push(`chart '${ch.name || ch.entity}': chartType must be one of ${CHART_TYPES.join('|')}`);
    }
    const entity = entityByLower.get(String(ch.entity).toLowerCase());
    const choiceCol =
      entity &&
      (entity.columns || []).find(
        (c) => c.type === 'Choice' && c.schemaName.toLowerCase() === String(ch.groupBy || '').toLowerCase()
      );
    if (!choiceCol) {
      errors.push(`chart '${ch.name || ch.entity}': groupBy '${ch.groupBy}' is not a Choice column on '${ch.entity}'`);
    }
  }
  for (const v of spec.views || []) {
    validateDescription(v && v.description, `view '${(v && (v.name || v.entity)) || '(unnamed)'}'`, errors);
    if (!entityNames.has(v.entity)) {
      errors.push(`view references unknown entity '${v.entity}'`);
    }
  }
  // Commands (modern command-bar buttons). A functional button needs a JS library + function;
  // the library must be a declared web resource (the on-click binds to it).
  const COMMAND_LOCATIONS = new Set(['MainTab', 'HomeTab', 'ContextualTab']);
  const COMMAND_TYPES = new Set(['Button', 'FlyoutAnchor', 'SplitButton']);
  // A leaf button (top-level or a flyout child) needs a JS library + function; the library must be
  // a declared web resource (the on-click binds to it).
  const checkCmdAction = (where, library, fn) => {
    if (!library) errors.push(`${where}: library (web-resource name) is required`);
    else if (!webResourceNames.has(String(library).toLowerCase())) errors.push(`${where}: library '${library}' is not a declared webResources[] name`);
    if (!fn) errors.push(`${where}: function (JS function name) is required`);
  };
  for (const c of spec.commands || []) {
    if (!c || !c.entity || !entityNames.has(c.entity)) { errors.push(`command references unknown entity '${c && c.entity}'`); continue; }
    // The SDK's command surface drops `description` (the artifact it returns carries only
    // commandBars/entityLogicalName/id), so one authored here never reaches Dataverse. Warn rather
    // than error — the spec is otherwise valid — but do not let it pass silently.
    if (c.description) {
      warnings.push(`command '${c.label || c.entity}': the SDK's command surface accepts no description, so this one will NOT be written to Dataverse`);
    }
    if (!c.label) errors.push(`command on ${c.entity}: label is required`);
    if (c.location && !COMMAND_LOCATIONS.has(c.location)) errors.push(`command '${c.label}' on ${c.entity}: location must be MainTab|HomeTab|ContextualTab`);
    const type = c.type || 'Button';
    if (!COMMAND_TYPES.has(type)) errors.push(`command '${c.label}' on ${c.entity}: type must be Button|FlyoutAnchor|SplitButton`);
    if (type === 'FlyoutAnchor' || type === 'SplitButton') {
      // A flyout/split container holds child buttons; it has no on-click of its own.
      if (!Array.isArray(c.children) || !c.children.length) errors.push(`command '${c.label}' on ${c.entity}: a ${type} needs children[] (its menu buttons)`);
      for (const ch of c.children || []) {
        if (!ch || !ch.label) { errors.push(`command '${c.label}' on ${c.entity}: a child button is missing a label`); continue; }
        checkCmdAction(`command '${c.label}' child '${ch.label}' on ${c.entity}`, ch.library, ch.function);
      }
    } else {
      checkCmdAction(`command '${c.label}' on ${c.entity}`, c.library, c.function);
    }
  }
  // Business rules. Every reference is checked against the spec's own columns, because a rule that
  // names a column the app does not create is authored against nothing — and the platform accepts it
  // silently (the rule just never fires), so nothing downstream would catch it.
  for (const r of spec.businessRules || []) {
    const label = `business rule '${(r && r.name) || '(unnamed)'}'`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push('businessRules[] entries must be objects'); continue; }
    validateDescription(r.description, label, errors);
    if (!r.name) errors.push(`${label}: name is required`);
    if (!r.entity || !entityNames.has(r.entity)) { errors.push(`${label}: references unknown entity '${r.entity}'`); continue; }
    if (r.scope !== undefined && !BUSINESS_RULE_SCOPES.includes(r.scope)) {
      errors.push(`${label}: scope must be ${BUSINESS_RULE_SCOPES.join('|')} (a form-scoped rule needs a form id that does not exist until the forms phase runs)`);
    }
    if (r.status !== undefined && !['Active', 'Draft'].includes(r.status)) {
      errors.push(`${label}: status must be Active|Draft`);
    }

    // Columns the rule may reference: the entity's own declared columns plus its primary name.
    const ent = (spec.entities || []).find((e) => e && e.schemaName === r.entity);
    const cols = new Set();
    if (ent) {
      if (ent.primaryAttribute && ent.primaryAttribute.schemaName) cols.add(String(ent.primaryAttribute.schemaName).toLowerCase());
      for (const c of ent.columns || []) if (c && c.schemaName) cols.add(String(c.schemaName).toLowerCase());
      // A lookup created by a relationship is a real column on the referencing table.
      for (const rel of spec.relationships || []) {
        if (rel && rel.referencing === r.entity && rel.lookup && rel.lookup.schemaName) cols.add(String(rel.lookup.schemaName).toLowerCase());
      }
    }
    const checkField = (field, what) => {
      if (!field) { errors.push(`${label}: ${what} needs a field`); return; }
      if (cols.size && !cols.has(String(field).toLowerCase())) {
        errors.push(`${label}: ${what} references '${field}', which is not a column on ${r.entity}`);
      }
    };

    if (!Array.isArray(r.conditions) || !r.conditions.length) {
      errors.push(`${label}: conditions[] is required (a rule with no condition would apply unconditionally, which the SDK serializes as an empty rule that silently never fires)`);
    }
    for (const c of r.conditions || []) {
      if (!c || typeof c !== 'object') { errors.push(`${label}: each condition must be an object`); continue; }
      checkField(c.field, 'condition');
      if (!BUSINESS_RULE_OPERATORS.includes(c.operator)) {
        // Name the platform failure rather than pretending the operator is unrecognised: an author
        // who reaches for a blocked operator has written something reasonable that we cannot deploy.
        if (BUSINESS_RULE_BLOCKED_OPERATORS.has(c.operator)) {
          errors.push(`${label}: operator '${c.operator}' is not usable — see https://github.com/microsoft/power-platform-skills/issues/481`);
        } else {
          // The near-misses matter more than the nonsense here. `GreaterThan` is a natural thing to
          // write and is NOT in the SDK's table, and the serializer resolves an unknown operator to
          // Equals — so without this gate that spec would deploy an equality test. Name the closest
          // legal spelling so the fix is obvious.
          const near = BUSINESS_RULE_OPERATORS.find((o) => o.toLowerCase() === `is${String(c.operator).toLowerCase()}`
            || o.toLowerCase().replace(/^is/, '') === String(c.operator).toLowerCase()
            || o.toLowerCase() === String(c.operator).toLowerCase());
          errors.push(`${label}: condition operator must be one of ${BUSINESS_RULE_OPERATORS.join('|')} (got '${c.operator}')${near ? ` — did you mean '${near}'?` : ''}`);
        }
        continue;
      }
      const valueless = BUSINESS_RULE_VALUELESS_OPERATORS.has(c.operator);
      if (valueless && c.value !== undefined) {
        errors.push(`${label}: '${c.operator}' tests presence, so it must not carry a value`);
      }
      if (!valueless && (c.value === undefined || c.value === null || c.value === '')) {
        errors.push(`${label}: '${c.operator}' needs a value`);
      }
      if (c.dataType !== undefined && !BUSINESS_RULE_DATA_TYPES.includes(c.dataType)) {
        // Name the offending value: this is a curated closed set with no bundle counterpart, and the
        // most likely mistake is a plausible-but-absent type (DateTime is the classic one), so
        // echoing what was written is what makes the message actionable.
        errors.push(`${label}: condition dataType '${c.dataType}' is not supported — must be one of ${BUSINESS_RULE_DATA_TYPES.join('|')}`);
      }
    }

    if (!Array.isArray(r.actions) || !r.actions.length) {
      errors.push(`${label}: actions[] is required (a rule that does nothing is not worth deploying)`);
    }
    for (const a of r.actions || []) {
      if (!a || typeof a !== 'object') { errors.push(`${label}: each action must be an object`); continue; }
      if (!BUSINESS_RULE_ACTION_TYPES.includes(a.type)) {
        errors.push(`${label}: action type must be one of ${BUSINESS_RULE_ACTION_TYPES.join('|')} (got '${a.type}')`);
        continue;
      }
      checkField(a.field, `action '${a.type}'`);
      const payload = BUSINESS_RULE_ACTIONS[a.type];
      if (a[payload] === undefined) {
        errors.push(`${label}: action '${a.type}' needs '${payload}'`);
      } else if (BUSINESS_RULE_BOOLEAN_ACTIONS.has(a.type) && typeof a[payload] !== 'boolean') {
        // A string "false" is truthy, so coercing here would invert the author's intent silently.
        errors.push(`${label}: action '${a.type}'.${payload} must be a boolean`);
      }
      if (a.type === 'SetFieldValue' && a.dataType !== undefined && !BUSINESS_RULE_DATA_TYPES.includes(a.dataType)) {
        errors.push(`${label}: action dataType must be one of ${BUSINESS_RULE_DATA_TYPES.join('|')}`);
      }
    }
  }
  // Dashboards: chart/list tiles reference a declared chart/view; iframe needs a url; webresource a
  // declared web resource.
  const DASH_TILE_TYPES = new Set(['chart', 'list', 'iframe', 'webresource']);
  const viewNamesSet = new Set((spec.views || []).map((v) => v.name));
  const chartNamesSet = new Set((spec.charts || []).map((c) => c.name));
  for (const d of spec.dashboards || []) {
    if (!d || !d.name) { errors.push('a dashboard is missing a name'); continue; }
    validateDescription(d.description, `dashboard '${d.name}'`, errors);
    if (!Array.isArray(d.tiles) || !d.tiles.length) { errors.push(`dashboard '${d.name}': needs tiles[]`); continue; }
    for (const t of d.tiles) {
      if (!t || !DASH_TILE_TYPES.has(t.type)) { errors.push(`dashboard '${d.name}': tile type must be chart|list|iframe|webresource`); continue; }
      // ID-passthrough tiles (from a round-tripped/downloaded app) carry the deployed view/chart ids
      // + entity directly instead of names — they bind to existing artifacts, so skip the name checks.
      const byId = t.viewId || t.visualizationId;
      if (t.type === 'chart') {
        if (byId) {
          if (!t.viewId) errors.push(`dashboard '${d.name}': chart tile with visualizationId also needs viewId`);
          if (!t.entity) errors.push(`dashboard '${d.name}': id-based chart tile needs entity`);
        } else {
          if (!t.chart || !chartNamesSet.has(t.chart)) errors.push(`dashboard '${d.name}': chart tile references unknown chart '${t.chart}'`);
          if (!t.view || !viewNamesSet.has(t.view)) errors.push(`dashboard '${d.name}': chart tile needs a declared view for its data — '${t.view}' not found`);
        }
      } else if (t.type === 'list') {
        if (byId) {
          if (!t.entity) errors.push(`dashboard '${d.name}': id-based list tile needs entity`);
        } else if (!t.view || !viewNamesSet.has(t.view)) {
          errors.push(`dashboard '${d.name}': list tile references unknown view '${t.view}'`);
        }
      } else if (t.type === 'iframe') {
        if (!t.url) errors.push(`dashboard '${d.name}': iframe tile needs a url`);
        else if (!isSafeHttpUrl(t.url)) errors.push(`dashboard '${d.name}': iframe tile url must be an http(s) URL (got '${t.url}')`);
        if (!t.name) errors.push(`dashboard '${d.name}': iframe tile needs a name`);
      } else if (t.type === 'webresource') {
        if (!t.webResource || !webResourceNames.has(String(t.webResource).toLowerCase())) errors.push(`dashboard '${d.name}': webresource tile references undeclared web resource '${t.webResource}'`);
        if (!t.name) errors.push(`dashboard '${d.name}': webresource tile needs a name`);
      }
    }
  }
  const dashNamesSet = new Set((spec.dashboards || []).map((d) => d && d.name).filter(Boolean));
  // Generative pages. Each needs a name. Implementation state is a discriminated `source`
  // (`intent` | `tsx`+codeFile); a legacy top-level `codeFile` is accepted as an implemented tsx.
  // The `deploy` profile requires every page implemented; `design`/`plan` allow intent (the page's
  // .tsx is produced by generate-pages after approval); `structural` ignores implementation.
  // isV2/pageKeysSet are declared here — before the page loop — so the appShell subarea loop that
  // follows can also reference them (both loops live in the same function scope). pageNamesSet is
  // kept for legacy (schemaVersion < 2) appShell page refs; pageRefSet selects the right set.
  const isV2 = (spec.schemaVersion || 0) >= 2;
  const pageKeysSet = new Set();
  const pageNamesSet = new Set();
  // Stable-key grammar (schemaVersion 2): lowercase slug — alphanumerics + internal single hyphens,
  // no leading/trailing hyphen, no underscores/spaces/uppercase. migrateAppSpec mints keys via
  // slugify (:686) which always conforms; a hand-authored v2 key must too, since the key is the
  // cross-reference identity (navigatesTo.targetKey, PAGEREF_<key>, appShell page subareas).
  const PAGE_KEY_GRAMMAR = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  // GUID pattern for pages[].pageId — a 36-char hyphenated hex UUID as minted by Dataverse / PAC CLI.
  // A spec page carrying this field is an EDIT-SNAPSHOT (env-specific, downloaded from a live app);
  // a portable fresh-authored spec omits it. When present it must be exactly this shape so
  // reconcilePageIds can use it as the highest identity authority without silently accepting garbage
  // (e.g. a cross-env GUID that happens to match an unrelated page). Addenda Task 4 / C3.
  const PAGE_ID_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const pageCodeFilesNorm = new Set(); // implemented-page normalized codeFile uniqueness (Critical 4)
  // A codeFile must resolve INSIDE the working directory. Use path.normalize to canonicalize before
  // checking — this catches aliases like 'pages/./x.tsx' and 'pages/../pages/x.tsx' that resolve to
  // the same file but evade a naive string-split check (addendum Crit 4). path.isAbsolute is
  // platform-specific (on POSIX it does NOT flag a Windows drive-letter path like 'C:/x'), so we ALSO
  // match a drive-letter prefix explicitly — a spec authored on Windows must be rejected the same way
  // on a Linux CI runner. After normalization, a path starting with '..' has escaped the workspace
  // root. sdk-build resolves codeFile with path.resolve(appDir, codeFile) at :1037-1041, so an
  // unconfined path reaches the filesystem outside the app folder — reject it here, before any write. Design §7.2.
  const codeFileConfined = (codeFile) => {
    const cf = String(codeFile);
    // Drive-letter guard (/^[a-zA-Z]:[/\\]/) catches 'C:\x'/'C:/x' on POSIX where path.isAbsolute misses it.
    if (path.isAbsolute(cf) || /^[a-zA-Z]:[/\\]/.test(cf)) return false;
    const normalized = path.normalize(cf);
    // normalized === '..' means the codeFile IS the parent directory.
    // normalized.startsWith('..' + path.sep) means it is a path beneath the parent directory.
    return normalized !== '..' && !normalized.startsWith('..' + path.sep);
  };
  for (const p of spec.pages || []) {
    if (!p || !p.name) { errors.push('a page is missing a name'); continue; }
    pageNamesSet.add(p.name);
    // NOTE: case-insensitive page-name uniqueness is enforced in a dedicated pass AFTER this loop
    // (see "page-name uniqueness" below) so it can distinguish a NEW page from a PRE-EXISTING one.
    // A page MAY carry its own deployed `pageId` (edit-snapshot marker). A portable fresh-authored spec
    // omits it — absence is never an error. When present it MUST be a valid 36-char GUID: the
    // reconcilePageIds authority logic (addenda Task 4 / C3) consumes it as the HIGHEST identity source,
    // so silently accepting a malformed / empty value would cause reconcile to bind the wrong page.
    if (p.pageId !== undefined && !PAGE_ID_GUID.test(String(p.pageId))) {
      errors.push(`page '${p.key || p.name}': pageId must be a 36-char GUID`);
    }
    const src = normalizePageSource(p);
    // Track whether a structural source error was emitted so the profile check below doesn't
    // double-report (e.g. source:{kind:'tsx'} with no codeFile should get ONE error, not two).
    let structuralSourceOk = true;
    if (src && src.kind !== 'intent' && src.kind !== 'tsx') {
      errors.push(`page '${p.key || p.name}': source.kind must be 'intent' or 'tsx'`);
      structuralSourceOk = false;
    } else if (src && src.kind === 'tsx' && (typeof src.codeFile !== 'string' || !src.codeFile)) {
      errors.push(`page '${p.key || p.name}': source.kind 'tsx' needs a codeFile (path to the .tsx)`);
      structuralSourceOk = false;
    }
    if (structuralSourceOk) {
      if (profile === 'deploy') {
        if (!(src && src.kind === 'tsx' && typeof src.codeFile === 'string' && src.codeFile)) {
          errors.push(`page '${p.key || p.name}': must be implemented (source.kind 'tsx' with a codeFile) for a deploy build — run generate-pages`);
        }
      } else if (profile !== 'structural' && src === null) {
        // design/plan still require SOME declared source (intent or tsx) — a page with neither is a
        // spec error, not a valid design.
        errors.push(`page '${p.key || p.name}': needs a source ({ kind: 'intent' } or { kind: 'tsx', codeFile })`);
      }
    }
    // codeFile confinement + path-uniqueness (Critical 4). Only checked for implemented tsx pages
    // (intent pages have no codeFile; the codeFile presence was already validated above). Normalize
    // the path before checking so that 'pages/./x.tsx' and 'pages/../pages/x.tsx' are detected as
    // duplicates of 'pages/x.tsx' (addendum Crit 4). Replace backslashes with forward slashes before
    // lowercasing for cross-platform-safe comparison in the set.
    if (src && src.kind === 'tsx' && typeof src.codeFile === 'string' && src.codeFile) {
      if (!codeFileConfined(src.codeFile)) {
        errors.push(`page '${p.key || p.name}': codeFile '${src.codeFile}' must be a workspace-confined relative path (no '..' escape, no absolute path)`);
      }
      const cfNorm = path.normalize(src.codeFile).replace(/\\/g, '/').toLowerCase();
      if (pageCodeFilesNorm.has(cfNorm)) errors.push(`page '${p.key || p.name}': duplicate codeFile '${src.codeFile}' (another page already uses this path)`);
      else pageCodeFilesNorm.add(cfNorm);
    }
    // schemaVersion 2 adds a required, unique stable key per page so pages can be referenced by an
    // identity that survives renames. The key is also what navigatesTo.targetKey and appShell page
    // subareas use (key-based refs replace name-based refs for v2 specs).
    if (isV2) {
      if (!p.key || typeof p.key !== 'string') errors.push(`page '${p.name}': needs a stable key (schemaVersion 2)`);
      else if (!PAGE_KEY_GRAMMAR.test(p.key)) errors.push(`page '${p.name}': key '${p.key}' has an invalid key grammar (lowercase slug: ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$)`);
      else if (pageKeysSet.has(p.key)) errors.push(`duplicate page key '${p.key}'`);
      else pageKeysSet.add(p.key);
    }
  }
  // Page-name uniqueness (case-insensitive) — SCOPED to what the current run authors. Two pages that
  // share a name (e.g. 'Overview' vs 'overview') are confusing in the app navigation. BUT a downloaded
  // edit-snapshot can legitimately carry a PRE-EXISTING duplicate the run did NOT create (two pages
  // authored by different people/tools), and blocking every build — even an unrelated form edit that
  // never touches pages — on a dupe the run is not changing is wrong (the pages phase matches by id/key,
  // never by name: genpage-cli.js enumerateEnv is id-keyed, and download's assignPageKeys de-dups keys
  // with a -N suffix, so distinct-id same-name pages build fine). Signal: a page carrying a deployed
  // `pageId` is PRE-EXISTING (an edit-snapshot marker); a page WITHOUT one is NEW (authored this run).
  //   - collision involving a NEW page  → ERROR  (prevent authoring/adding a duplicate)
  //   - collision purely among PRE-EXISTING pages → WARNING (tolerate; rename one in Maker to fix nav)
  const nameGroups = new Map(); // nameLower -> { display, count, anyNew }
  for (const p of spec.pages || []) {
    if (!p || !p.name) continue;
    const nl = String(p.name).toLowerCase();
    const g = nameGroups.get(nl) || { display: p.name, count: 0, anyNew: false };
    g.count += 1;
    if (!p.pageId) g.anyNew = true; // no deployed id ⇒ this page is being created/authored by this run
    nameGroups.set(nl, g);
  }
  for (const g of nameGroups.values()) {
    if (g.count <= 1) continue;
    if (g.anyNew) errors.push(`duplicate page name '${g.display}' (page names must be unique, case-insensitive)`);
    else warnings.push(`pre-existing duplicate page name '${g.display}' — ${g.count} deployed pages share this name (case-insensitive); tolerated because this build does not create them, but the app navigation is ambiguous. Rename one in Maker (or a fresh spec) to disambiguate.`);
  }
  // Navigation graph (v2 only — these fields don't exist in hand-authored legacy specs):
  // every navigatesTo.targetKey must resolve to a known page key. pageInput shape is validated
  // here too (object, not array/null).
  if (isV2) {
    for (const p of spec.pages || []) {
      for (const nav of p.navigatesTo || []) {
        if (!nav || typeof nav.targetKey !== 'string') { errors.push(`page '${p.key || p.name}': navigatesTo entry needs a targetKey`); continue; }
        if (!pageKeysSet.has(nav.targetKey)) errors.push(`page '${p.key || p.name}': navigatesTo target '${nav.targetKey}' is not a known page key`);
        if (nav.data !== undefined && (typeof nav.data !== 'object' || nav.data === null || Array.isArray(nav.data))) errors.push(`page '${p.key || p.name}': navigatesTo.data must be an object`);
      }
      if (p.pageInput !== undefined) {
        if (typeof p.pageInput !== 'object' || p.pageInput === null || Array.isArray(p.pageInput)) errors.push(`page '${p.key || p.name}': pageInput must be an object`);
      }
    }
    // INPUT CONTRACT. These two rules together resolve a policy conflict that was previously left
    // implicit, and that a page author had no way to satisfy:
    //
    //   - Every page MUST be sitemap-placed (the MEMBERSHIP invariant above): the sitemap is the
    //     download's only membership oracle, so a page reached only by navigation is invisible to
    //     download and gets re-created as a duplicate on the next build.
    //   - But a DETAIL page declares `pageInput` (e.g. `{ data: { orderId: 'string' } }`) because it
    //     is opened from a list with a row id.
    //
    // Being sitemap-placed means the page is ALSO reachable straight from the app's navigation, with
    // NO input at all. That is a real, user-reachable state — it is what a user gets by clicking the
    // nav entry — and previously nothing made the author account for it, so the generated page would
    // render against `undefined` context. Rather than weaken the membership invariant (which would
    // reintroduce duplicate pages on every rebuild), require the author to say what direct entry
    // does. `directEntry` is that answer, and page-plan feeds it to the generator.
    for (const p of spec.pages || []) {
      const key = p.key || p.name;
      const inputKeys = Object.keys((p.pageInput && p.pageInput.data) || {});
      if (!inputKeys.length) continue;

      if (p.directEntry === undefined) {
        errors.push(`page '${key}' declares pageInput (${inputKeys.join(', ')}) but no directEntry — every page is sitemap-placed, so a user can open it from the app navigation with no input. Declare directEntry: { "behavior": "selector" | "emptyState", "note": "…" } to say what that shows.`);
      } else if (typeof p.directEntry !== 'object' || p.directEntry === null || Array.isArray(p.directEntry)) {
        errors.push(`page '${key}': directEntry must be an object`);
      } else if (!DIRECT_ENTRY_BEHAVIORS.includes(p.directEntry.behavior)) {
        errors.push(`page '${key}': directEntry.behavior must be one of ${DIRECT_ENTRY_BEHAVIORS.join('|')}`);
      }

      // Trace each declared input back to a navigation edge that actually produces it. An input no
      // caller supplies is either a typo or a page that can ONLY ever be entered directly — both are
      // worth failing on, because the generated page would read a key nothing ever sets.
      //
      // EXCEPT when the spec was RECONSTRUCTED from a deployed app (`opts.reconstructed`, set by
      // download). This is an authoring rule: it gates what you are about to create. A reconstruction
      // describes an app that ALREADY EXISTS, and download validates before it writes — so treating
      // it as fatal there produces no spec file at all and strands the author with nothing to edit,
      // which is the #430 failure this release exists to fix. A page whose manifest predates the rule
      // (input supplied externally, or from its own .tsx) hits exactly that. Reported as a warning
      // instead: the author gets the file, the finding, and the chance to fix it.
      const produced = new Set();
      for (const other of spec.pages || []) {
        for (const nav of other.navigatesTo || []) {
          if (nav && nav.targetKey === key) for (const k of Object.keys((nav.data) || {})) produced.add(k);
        }
      }
      const orphaned = inputKeys.filter((k) => !produced.has(k));
      if (orphaned.length) {
        const msg = `page '${key}': pageInput declares ${orphaned.map((k) => `'${k}'`).join(', ')} but no page navigates to it with that data — add it to the producing page's navigatesTo[].data, or drop it from pageInput.`;
        if (opts.reconstructed) warnings.push(msg);
        else errors.push(msg);
      }
    }
  }
  // Icons are chrome, not a target. An `icon` that is a **platform reference** (a path or
  // `$webresource:` — see isPlatformIconRef) is a live/OOB value a downloaded app carries and is valid
  // AS-IS (rejecting it broke the download→build round-trip on real apps). Only a BARE NAME is treated
  // as a local web-resource reference and must be a declared IMAGE web resource. `vectorIcon` handling
  // is per-subarea below (entity vs non-entity differ).
  const checkIcon = (icon, label) => {
    if (!icon) return;
    if (isPlatformIconRef(icon)) return; // live/OOB platform reference — pass through
    const ic = String(icon).toLowerCase();
    if (!webResourceNames.has(ic)) errors.push(`${label}: icon '${icon}' is not a declared web resource`);
    else if (!imageWebResourceNames.has(ic)) errors.push(`${label}: icon '${icon}' must be an image web resource (png/jpg/gif/svg/ico)`);
  };
  // Portability advisory: a platform icon/vectorIcon that references THIS app's OWN custom web resource
  // (by the solution publisher prefix) but does NOT declare it in webResources[] will render only on an
  // env that already has that web resource — on a fresh/other env it dangles (a broken icon). A DOWNLOADED
  // spec re-declares its OWN-prefix UNMANAGED image icon web resources automatically (download-model-app
  // collectSitemap + iconWebResources), so this normally fires only for a hand-authored spec (a rare
  // exception: an own-prefix MANAGED icon WR, which download can't recreate and so leaves undeclared). An
  // OOB/system reference (a different prefix, or a non-WebResources `/_imgs/...` path) is assumed present on
  // every env → not flagged.
  const pubPrefix = (spec.solution && spec.solution.publisherPrefix) ? String(spec.solution.publisherPrefix).toLowerCase() : '';
  const checkPortableIconRef = (val, label) => {
    if (!val || !isPlatformIconRef(val)) return;
    const wrName = webResourceNameFromRef(val);
    if (!wrName || !pubPrefix) return;
    const lc = wrName.toLowerCase();
    if (lc.startsWith(pubPrefix + '_') && !webResourceNames.has(lc)) {
      warnings.push(`${label}: icon reference '${val}' points at a custom web resource ('${wrName}') that is NOT declared in webResources[] — it will render only on an environment that already has it (a rebuild into a fresh env shows a broken icon). Declare that web resource so the build recreates it; a downloaded spec does this automatically.`);
    }
  };
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    checkIcon(a.icon, `sitemap area "${a.label || ''}"`);
    checkPortableIconRef(a.icon, `sitemap area "${a.label || ''}"`);
    checkPortableIconRef(a.vectorIcon, `sitemap area "${a.label || ''}"`);
    validateIconDescription(a.iconDescription, `sitemap area "${a.label || ''}"`, errors);
    for (const g of a.groups || []) {
      validateIconDescription(g && g.iconDescription, `sitemap group "${(g && g.label) || ''}"`, errors);
      for (const sa of g.subAreas || []) {
        const targets = ['entity', 'dashboard', 'url', 'page'].filter((k) => sa[k]);
        if (targets.length === 0) errors.push(`sitemap subArea "${sa.title || ''}" needs an entity, dashboard, url, or page`);
        else if (targets.length > 1) errors.push(`sitemap subArea "${sa.title || ''}" sets multiple targets (${targets.join(', ')}) — pick one`);
        // Case-insensitive: Dataverse logical names are lower-case while `schemaName` is cased
        // (`Account`), and a sitemap subarea's `entity` comes from the deployed sitemap XML as a
        // LOGICAL name. A downloaded spec therefore legitimately pairs `schemaName: "Account"` with
        // `entity: "account"`. Matches the chart check above, which already uses `entityByLower`.
        if (sa.entity && !entityByLower.has(String(sa.entity).toLowerCase())) errors.push(`sitemap subArea references unknown entity '${sa.entity}'`);
        if (sa.dashboard && !dashNamesSet.has(sa.dashboard)) errors.push(`sitemap subArea references unknown dashboard '${sa.dashboard}' (declare it in dashboards[])`);
        // A sitemap URL subarea is EITHER a real link OR a web-resource reference —
        // `$webresource:<name>` (what the Site Map Designer writes for a "custom page backed by an
        // HTML web resource") or the equivalent `/WebResources/<name>` path.
        //
        // A web-resource reference passes through AS-IS, exactly like a platform icon ref above,
        // and for the same reason recorded there: it is a live/OOB value a downloaded app carries,
        // and rejecting it broke the download→build round-trip on real apps. Requiring it to be
        // DECLARED would re-make that mistake in a new place — the referenced resource is often
        // managed or owned by another publisher, which download deliberately leaves as a bare
        // reference (it exists in the target env; re-creating a foreign prefix would hard-fail a
        // fresh build). Download still captures the CONTENT when it can safely do so, so an
        // own-prefix unmanaged page travels with the app.
        //
        // This does not weaken the http(s) guard, which exists to stop an ARBITRARY scheme
        // (`javascript:`, `file:`) becoming a nav entry in a shipped app. A web-resource reference
        // is not arbitrary: it names a resource inside Dataverse, not a script or a local file.
        if (sa.url && !webResourceNameFromRef(sa.url) && !isSafeHttpUrl(sa.url)) {
          errors.push(`sitemap subArea "${sa.title || ''}" url must be an http(s) URL or a $webresource:<name> reference (got '${sa.url}')`);
        }
        // schemaVersion 2 references pages by stable KEY; legacy specs still reference by name.
        const pageRefSet = isV2 ? pageKeysSet : pageNamesSet;
        if (sa.page && !pageRefSet.has(sa.page)) errors.push(`sitemap subArea references unknown page '${sa.page}' (declare it in pages[])`);
        checkIcon(sa.icon, `sitemap subArea "${sa.title || ''}"`);
        checkPortableIconRef(sa.icon, `sitemap subArea "${sa.title || ''}"`);
        checkPortableIconRef(sa.vectorIcon, `sitemap subArea "${sa.title || ''}"`);
        validateIconDescription(sa.iconDescription, `sitemap subArea "${sa.title || ''}"`, errors);
        // Ask 3: don't SILENTLY drop an entity-subarea vectorIcon. A valid platform ref round-trips
        // (emitted by the build); a BARE token can't be emitted on an entity subarea (it breaks the
        // modern app-designer), so surface it as a warning at author time rather than a silent drop.
        if (sa.entity && sa.vectorIcon && !isPlatformIconRef(sa.vectorIcon)) {
          warnings.push(`sitemap subArea "${sa.title || ''}": vectorIcon '${sa.vectorIcon}' is a bare token — on an entity subarea a bare Fluent token breaks the app designer and is DROPPED from the sitemap. Use an SVG path (e.g. /WebResources/<pub>/icons/x.svg) or a $webresource:<name>.svg reference, or set entities[].vectorIcon (the table icon) for a custom nav glyph.`);
        }
      }
    }
  }
  // MEMBERSHIP invariant (Plan 5 v2 / Task 3): every generative page MUST appear as a sitemap subarea.
  // A model-driven app's membership IS sitemap presence — there is no hidden-but-navigable subarea.
  // A page that is only a navigatesTo target (no subarea) is NOT owned by the app's navigation: build
  // will create it, but download enumeration (membership = sitemap) and verify (membership check) will
  // both miss it, and the next build from a downloaded spec will then re-create it as a duplicate.
  // Enforced for specs that will be BUILT: deploy / plan / design. The `structural` profile is shape-
  // only (used by the eval harness and teardown / cleanup) and is explicitly excluded.
  if (isV2 && profile !== 'structural') {
    const sitemappedPageKeys = new Set();
    for (const a of (spec.appShell && spec.appShell.areas) || [])
      for (const g of a.groups || [])
        for (const sa of g.subAreas || []) if (sa && sa.page) sitemappedPageKeys.add(sa.page);
    for (const p of spec.pages || []) {
      const key = p.key || p.name;
      if (!sitemappedPageKeys.has(key)) {
        errors.push(`page '${key}' is not placed in the sitemap — every page must be an appShell subarea (a page reached only by navigation is not owned by the app; add a subarea for it)`);
      }
    }
  }
  // Table (entity) icons — these set the table's OWN icon (what the modern app designer and app
  // nav render for the table). Unlike a sitemap subarea's `vectorIcon` (a free-form Fluent token),
  // a TABLE's icon must be a declared, buildable web resource: `vectorIcon` an SVG web resource
  // (Dataverse IconVectorName), `icon` a raster PNG/JPG/GIF/ICO web resource (IconMediumName). An
  // unresolvable value is exactly what leaves the designer's property pane stuck on a glimmer, so
  // this is a hard error, not a lint warning.
  for (const e of spec.entities || []) {
    const label = `entity ${e.schemaName || ''}`;
    if (e.vectorIcon) {
      const v = String(e.vectorIcon).toLowerCase();
      if (!webResourceNames.has(v)) errors.push(`${label}: vectorIcon '${e.vectorIcon}' is not a declared web resource (a table's vectorIcon must be an SVG web resource — declare it in webResources[])`);
      else if (!svgWebResourceNames.has(v)) errors.push(`${label}: vectorIcon '${e.vectorIcon}' must be an SVG web resource (type "svg")`);
    }
    if (e.icon) {
      const ic = String(e.icon).toLowerCase();
      if (!webResourceNames.has(ic)) errors.push(`${label}: icon '${e.icon}' is not a declared web resource`);
      else if (!rasterWebResourceNames.has(ic)) errors.push(`${label}: icon '${e.icon}' must be a raster image web resource (png/jpg/gif/ico); use vectorIcon for an SVG`);
    }
    validateIconDescription(e.iconDescription, label, errors);
  }
  // App tile icon (optional). When set it must be a declared IMAGE web resource so the app is
  // self-contained on export/import; when omitted, the build generates a default icon in-solution.
  if (spec.app && spec.app.icon) {
    const ai = String(spec.app.icon).toLowerCase();
    if (!webResourceNames.has(ai)) errors.push(`app.icon '${spec.app.icon}' is not a declared web resource`);
    else if (!imageWebResourceNames.has(ai)) errors.push(`app.icon '${spec.app.icon}' must be an image web resource (png/jpg/gif/svg/ico)`);
  }
  if (spec.sampleData !== undefined) {
    if (typeof spec.sampleData !== 'object' || spec.sampleData === null || Array.isArray(spec.sampleData)) {
      errors.push('sampleData must be an object keyed by entity schemaName');
    } else {
      const lower = new Set([...entityNames].map((n) => n.toLowerCase()));
      for (const [k, v] of Object.entries(spec.sampleData)) {
        if (!lower.has(k.toLowerCase())) {
          errors.push(`sampleData references unknown entity '${k}'`);
        }
        if (!Array.isArray(v)) {
          errors.push(`sampleData['${k}'] must be an array of records`);
          continue;
        }
        // #4: catch Choice/MultiChoice sample values that are NOT a declared option label. Unknown
        // labels otherwise pass through resolveChoiceValue() unchanged and reach Dataverse as a raw
        // string, which either 400s late in the build or (for a MultiChoice) is silently wrong — a
        // typo like 'Urgnet' should fail here, not the live deploy. Uses the shared token linter so
        // this hard gate and spec-lint's guardrail apply identical rules. Built once per entity.
        const ent = lower.has(k.toLowerCase())
          ? (spec.entities || []).find((e) => String(e.schemaName).toLowerCase() === k.toLowerCase())
          : null;
        for (const rec of v) {
          for (const { field, token } of invalidChoiceSampleTokens(spec, ent, rec)) {
            errors.push(`sampleData['${k}']: value '${token}' for choice column '${field}' is not a declared option label`);
          }
          if (!rec || typeof rec !== 'object') {
            continue;
          }
          // #1: validate the parent bind(s) — one `$parent` (singular) and/or many `$parents` (a
          // junction row binding multiple sides). Each must name a known parent entity, carry a
          // non-empty match, have an existing OneToMany relationship, AND a match that resolves to
          // EXACTLY ONE parent sample record. Zero matches silently drops the bind (child created with
          // the lookup UNSET); more than one is ambiguous and the seeder would silently pick the first
          // (a mis-bind) — both fail loud here at lint time instead of shipping a wrong/half-linked row.
          if (rec.$parents !== undefined && !Array.isArray(rec.$parents)) {
            // A non-array $parents is silently ignored by the array-guarded map below but IS processed
            // by the seeder ([].concat(..., nonArray) keeps it as one element), so validation must
            // reject it rather than diverge from runtime.
            errors.push(`sampleData['${k}']: $parents must be an array of { entity, match } binds`);
          }
          const parentBinds = [].concat(
            rec.$parent !== undefined ? [{ p: rec.$parent, key: '$parent' }] : [],
            Array.isArray(rec.$parents) ? rec.$parents.map((pp) => ({ p: pp, key: '$parents' })) : []
          );
          for (const { p, key } of parentBinds) {
            if (!p || typeof p !== 'object' || Array.isArray(p) || !p.entity || !lower.has(String(p.entity).toLowerCase())) {
              errors.push(`sampleData['${k}']: ${key}.entity '${p && p.entity}' is unknown`);
              continue;
            }
            if (!p.match || typeof p.match !== 'object' || Array.isArray(p.match) || !Object.keys(p.match).length) {
              errors.push(`sampleData['${k}']: ${key}.match must be a non-empty object`);
              continue;
            }
            if (!relationshipFor(spec, p.entity, k)) {
              errors.push(`sampleData['${k}']: no OneToMany relationship from ${key} '${p.entity}' to '${k}'`);
              continue;
            }
            // The match must resolve to EXACTLY ONE parent sample record.
            const pKey = Object.keys(spec.sampleData).find((kk) => kk.toLowerCase() === String(p.entity).toLowerCase());
            const parentRecs = (pKey && Array.isArray(spec.sampleData[pKey])) ? spec.sampleData[pKey] : [];
            const matchCount = parentRecs.filter((pr) => pr && typeof pr === 'object' && Object.entries(p.match).every(([mk, mv]) => {
              const rk = Object.keys(pr).find((x) => x.toLowerCase() === mk.toLowerCase());
              return rk !== undefined && pr[rk] === mv;
            })).length;
            if (matchCount === 0) {
              errors.push(`sampleData['${k}']: ${key}.match ${JSON.stringify(p.match)} matched no '${String(p.entity).toLowerCase()}' sample record — the lookup would be left unset`);
            } else if (matchCount > 1) {
              errors.push(`sampleData['${k}']: ${key}.match ${JSON.stringify(p.match)} is ambiguous — it matches ${matchCount} '${String(p.entity).toLowerCase()}' sample records; tighten the match to select exactly one`);
            }
          }
        }
      }
    }
  }
  // ai block (optional) — validates appFeatures flags and summaries table references.
  if (spec.ai !== undefined) {
    if (!spec.ai || typeof spec.ai !== 'object' || Array.isArray(spec.ai)) {
      errors.push('ai must be an object');
    } else {
      const AI_FEATURE_KEYS_LIST = [...AI_FEATURE_KEYS].join(', ');
      if (spec.ai.appFeatures !== undefined) {
        if (!spec.ai.appFeatures || typeof spec.ai.appFeatures !== 'object' || Array.isArray(spec.ai.appFeatures)) {
          errors.push('ai.appFeatures must be an object');
        } else {
          for (const [k, v] of Object.entries(spec.ai.appFeatures)) {
            if (!AI_FEATURE_KEYS.has(k)) errors.push(`ai.appFeatures: unknown key '${k}' (allowed: ${AI_FEATURE_KEYS_LIST})`);
            // These map to NUMERIC Dataverse app settings, not booleans: `true`/`false` are the
            // ergonomic spellings of 1/0, but the platform also defines other values (notably 2 =
            // "on for everyone"), which a boolean-only contract made inexpressible (ADO 6560699).
            // Accept a boolean or a non-negative integer; reject anything else (a string like '2'
            // would silently bypass the range check downstream).
            //
            // The upper bound MIRRORS the SDK's `MAX_SETTING_VALUE` in api/AiApi.ts. The SDK THROWS
            // an InvalidArgumentError for an out-of-range value, so without this bound a spec would
            // validate cleanly and then abort the build half-applied — validation must reject it up
            // front, where the maker gets a message naming the field. `isSafeInteger` (not
            // `isInteger`) because beyond 2^53 an "integer" double no longer round-trips.
            if (typeof v !== 'boolean' && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= AI_FEATURE_MAX_VALUE)) {
              errors.push(`ai.appFeatures.${k}: must be a boolean or an integer between 0 and ${AI_FEATURE_MAX_VALUE} (e.g. true, false, or 2 for "on for everyone")`);
            }
          }
        }
      }
      if (spec.ai.summaries !== undefined) {
        if (!spec.ai.summaries || typeof spec.ai.summaries !== 'object' || Array.isArray(spec.ai.summaries)) {
          errors.push('ai.summaries must be an object');
        } else {
          if (spec.ai.summaries.default !== undefined && !['auto', 'off'].includes(spec.ai.summaries.default)) {
            errors.push(`ai.summaries.default must be 'auto' or 'off'`);
          }
          if (spec.ai.summaries.tables !== undefined) {
            if (!spec.ai.summaries.tables || typeof spec.ai.summaries.tables !== 'object' || Array.isArray(spec.ai.summaries.tables)) {
              errors.push('ai.summaries.tables must be an object');
            } else {
              for (const [k, v] of Object.entries(spec.ai.summaries.tables)) {
                const ent = entityByLower.get(k.toLowerCase());
                if (!ent) {
                  errors.push(`ai.summaries.tables: unknown table '${k}'`);
                  continue;
                }
                if (!v || typeof v !== 'object' || Array.isArray(v)) {
                  errors.push(`ai.summaries.tables['${k}']: must be an object`);
                  continue;
                }
                if (v.enabled !== undefined && typeof v.enabled !== 'boolean') errors.push(`ai.summaries.tables['${k}'].enabled: must be a boolean`);
                if (v.instruction !== undefined && typeof v.instruction !== 'string') errors.push(`ai.summaries.tables['${k}'].instruction: must be a string`);
                if (v.columns !== undefined) {
                  if (!Array.isArray(v.columns)) {
                    errors.push(`ai.summaries.tables['${k}'].columns: must be an array`);
                  } else {
                    const entCols = new Set([
                      ...(ent.columns || []).map((c) => c.schemaName.toLowerCase()),
                      ...(ent.primaryAttribute && ent.primaryAttribute.schemaName ? [ent.primaryAttribute.schemaName.toLowerCase()] : []),
                    ]);
                    for (const c of v.columns) {
                      if (typeof c !== 'string') {
                        errors.push(`ai.summaries.tables['${k}'].columns: each entry must be a string`);
                      } else if (!entCols.has(c.toLowerCase())) {
                        errors.push(`ai.summaries.tables['${k}'].columns: unknown column '${c}'`);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  // Page design contract (optional, v2 only). Shape-only in this plan; the token→Fluent mapping
  // and generated-page validation land in the Pages plan. Reject unknown keys so typos fail early.
  // Gated on isV2 so a hand-authored legacy spec is not rejected for a v2-only field.
  if (isV2 && spec.design !== undefined) {
    if (typeof spec.design !== 'object' || spec.design === null || Array.isArray(spec.design)) {
      errors.push('design must be an object');
    } else {
      const allowed = new Set(['accentColor', 'density', 'cornerRadius', 'darkMode', 'layout']);
      for (const k of Object.keys(spec.design)) if (!allowed.has(k)) errors.push(`design: unknown key '${k}' (allowed: ${[...allowed].join(', ')})`);
    }
  }
  // Security personas (optional; additive — validated on v1 and v2 specs). Each persona authors ONE
  // security role (role name = persona) whose privilege set is the UNION of the entity access every
  // one of its jobs-to-be-done declares (the SDK unions them, max scope wins per entity+access). The
  // planner DECLARES the access each job needs — the engine never infers it — so this validator only
  // checks the declared SHAPE: valid Dataverse access/scope tokens and well-formed GUIDs. Two guards
  // are intentionally deferred to apply time because they need live entity metadata the lint pass does
  // not have: (1) whether an entity actually supports a requested access, and (2) the SDK's shared-
  // privilege rule (entities that alias to the same prv* must request one scope). Those surface as a
  // clean BuildHalt from the security phase, not here. Entity NAMES are likewise resolved against live
  // metadata by the SDK (a persona legitimately grants access to standard tables like `account` that
  // this spec does not author), so we validate only that `entity` is a non-empty string.
  if (spec.personas !== undefined) {
    if (!Array.isArray(spec.personas)) {
      errors.push('personas must be an array');
    } else {
      const personaNames = new Set();
      // Reject unknown keys so a typo fails loudly at author time instead of silently taking a default.
      // WHY this matters for security: `appAcces:false` (typo) would leave the REAL `appAccess` absent →
      // defaulting to true → the persona wrongly gets app-module read + the app association. Same pattern
      // the `design` block uses. Allowlists mirror the vendored SDK's PersonaRoleSpec/JobToBeDone/
      // EntityPrivilege shapes exactly.
      const PERSONA_KEYS = new Set(['persona', 'jobs', 'additionalPrivileges', 'appAccess', 'businessUnitId', 'assignTo']);
      const JOB_KEYS = new Set(['name', 'description', 'privileges', 'surfaces']);
      const PRIVILEGE_KEYS = new Set(['entity', 'access', 'scope']);
      const rejectUnknown = (obj, allowed, ctx) => {
        for (const k of Object.keys(obj)) if (!allowed.has(k)) errors.push(`${ctx}: unknown key '${k}' (allowed: ${[...allowed].join(', ')})`);
      };
      // Validate a persona/JTBD EntityPrivilege[] (shape + enum only — see the deferral note above).
      const validatePrivileges = (privs, ctx, { allowEmpty = false } = {}) => {
        if (privs === undefined) {
          if (!allowEmpty) errors.push(`${ctx}: privileges[] is required`);
          return;
        }
        if (!Array.isArray(privs) || (!allowEmpty && !privs.length)) {
          errors.push(`${ctx}: privileges must be a non-empty array`);
          return;
        }
        for (const pr of privs) {
          if (!pr || typeof pr !== 'object' || Array.isArray(pr)) { errors.push(`${ctx}: each privilege must be an object`); continue; }
          rejectUnknown(pr, PRIVILEGE_KEYS, `${ctx}: privilege`);
          if (!pr.entity || typeof pr.entity !== 'string') errors.push(`${ctx}: privilege.entity (a table logical name) is required`);
          if (!Array.isArray(pr.access) || !pr.access.length) {
            errors.push(`${ctx}: privilege on '${pr.entity || '?'}' needs a non-empty access[]`);
          } else {
            for (const a of pr.access) if (!ACCESS_LEVELS.has(a)) errors.push(`${ctx}: unknown access '${a}' on '${pr.entity}' (valid: ${[...ACCESS_LEVELS].join(', ')})`);
          }
          if (pr.scope !== undefined && !PRIVILEGE_SCOPES.has(pr.scope)) errors.push(`${ctx}: unknown scope '${pr.scope}' on '${pr.entity}' (valid: ${[...PRIVILEGE_SCOPES].join(', ')})`);
        }
      };
      for (const p of spec.personas) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push('personas[]: each persona must be an object'); continue; }
        rejectUnknown(p, PERSONA_KEYS, 'persona');
        // The SDK TRIMS the role name before its (name, business-unit) lookup, so validate + dedup on the
        // TRIMMED name — otherwise "Agent" and " Agent " pass as distinct here but collapse onto one role
        // (the second silently REPLACES the first's privileges), and teardown/verify would query the wrong
        // (untrimmed) name and miss the role.
        const pname = typeof p.persona === 'string' ? p.persona.trim() : p.persona;
        if (!pname || typeof pname !== 'string') {
          errors.push('persona: persona (the role name) is required and cannot be blank/whitespace-only');
        } else {
          const key = pname.toLowerCase();
          if (personaNames.has(key)) errors.push(`persona "${pname}": duplicate persona name (each persona authors one role — names must be unique after trimming)`);
          personaNames.add(key);
        }
        const label = pname || '?';
        if (p.appAccess !== undefined && typeof p.appAccess !== 'boolean') errors.push(`persona "${label}": appAccess must be a boolean`);
        if (p.businessUnitId !== undefined && (typeof p.businessUnitId !== 'string' || !FORM_GUID_RE.test(p.businessUnitId))) errors.push(`persona "${label}": businessUnitId must be a GUID`);
        if (!Array.isArray(p.jobs) || !p.jobs.length) {
          errors.push(`persona "${label}": at least one job (jobs[]) is required`);
        } else {
          for (const j of p.jobs) {
            if (!j || typeof j !== 'object' || Array.isArray(j)) { errors.push(`persona "${label}": each job must be an object`); continue; }
            rejectUnknown(j, JOB_KEYS, `persona "${label}" job`);
            if (!j.name || typeof j.name !== 'string') errors.push(`persona "${label}": a job is missing name`);
            // surfaces[]: the view/form/page names (or page keys) that let this persona DO the job.
            // Purely documentary — it drives the design doc's traceability table and the "job with no
            // surface" lint warning, and is never applied to Dataverse. Shape-only validation, because
            // a surface may legitimately name an artifact this spec doesn't author (a stock view).
            if (j.surfaces !== undefined) {
              if (!Array.isArray(j.surfaces)) errors.push(`persona "${label}" job "${j.name || '?'}": surfaces must be an array of strings`);
              else for (const s of j.surfaces) if (typeof s !== 'string' || !s.trim()) errors.push(`persona "${label}" job "${j.name || '?'}": each surfaces[] entry must be a non-empty string`);
            }
            validatePrivileges(j.privileges, `persona "${label}" job "${(j && j.name) || '?'}"`);
          }
        }
        if (p.additionalPrivileges !== undefined) validatePrivileges(p.additionalPrivileges, `persona "${label}" additionalPrivileges`, { allowEmpty: true });
        // assignTo (optional, grant-only). Team/user ids are Dataverse GUIDs — validate the shape so a
        // typo'd id fails at author time rather than as an opaque SDK GUID-normalization error on apply.
        if (p.assignTo !== undefined) {
          if (typeof p.assignTo !== 'object' || p.assignTo === null || Array.isArray(p.assignTo)) {
            errors.push(`persona "${label}": assignTo must be an object with teams[]/users[]`);
          } else {
            for (const k of Object.keys(p.assignTo)) if (k !== 'teams' && k !== 'users') errors.push(`persona "${label}": assignTo unknown key '${k}' (allowed: teams, users)`);
            for (const k of ['teams', 'users']) {
              if (p.assignTo[k] === undefined) continue;
              if (!Array.isArray(p.assignTo[k])) { errors.push(`persona "${label}": assignTo.${k} must be an array of GUIDs`); continue; }
              for (const id of p.assignTo[k]) if (typeof id !== 'string' || !FORM_GUID_RE.test(id)) errors.push(`persona "${label}": assignTo.${k} contains a non-GUID value`);
            }
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Slugify a page name into a stable key candidate: lowercase, non-alphanumerics -> '-', trimmed.
//   "Sales Overview"  -> "sales-overview"
//   "KPI / Analytics" -> "kpi-analytics"
function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

// The canonical role name for a persona: the TRIMMED `persona` string. The vendored SDK trims the name
// before its (name, business-unit) role lookup/create, so every plugin site that identifies the role —
// the create mapper (personaRoleSpecFor), teardown, and verify — MUST use this same trimmed form or they
// will disagree on the role's identity (create "Agent" but tear down / verify " Agent ").
function canonicalPersonaName(persona) {
  const n = persona && persona.persona;
  return typeof n === 'string' ? n.trim() : n;
}

// Upgrade a legacy App Spec to schemaVersion 2 in one pure pass (no I/O; returns a deep copy):
//   - mint a stable, unique `key` per page (slug of name, de-duplicated with a -N suffix)
//   - wrap a legacy top-level `codeFile` into `source: { kind: 'tsx', codeFile }`
//   - rewrite name-based references (appShell page subareas + navigatesTo.targetKey) to keys
// Idempotent: a spec already at schemaVersion >= 2 is returned as-is. Runs on load before validate,
// so downstream code only ever sees the v2 shape. See docs/app-builder-design.md §7.3.
//
// Two-pass design: pass 1 mints ALL keys first so nameToKey is fully populated before any
// rewrite. A single rewrite pass (pass 2) then replaces every name-ref exactly once, preventing
// the double-rewrite bug that occurred when a minted key collided with another page's name
// (e.g. pages "Detail" → key "detail" and "detail" → key "detail-2": the old two-pass code
// would rewrite a "Detail" name-ref to "detail" in pass 1, then re-apply nameToKey in pass 2
// and wrongly map "detail" (now a key, but also the name of the second page) to "detail-2").
function migrateAppSpec(spec) {
  if (!spec || typeof spec !== 'object' || (spec.schemaVersion || 0) >= 2) return spec;
  const out = JSON.parse(JSON.stringify(spec));
  out.schemaVersion = 2;
  const nameToKey = new Map();
  const used = new Set();
  // Migration runs BEFORE validateAppSpec at every CLI entry point (build/preview/verify/teardown
  // all migrate the file they just read, then validate), so a malformed collection reached these
  // loops and threw a raw TypeError before the gate that is supposed to report it ever ran. Iterate
  // defensively — but do NOT rewrite the value, or validateAppSpec would see a repaired spec and
  // report nothing. The shape error stays for the gate to find.
  const arr = (v) => (Array.isArray(v) ? v : []);
  // Pass 1: mint every key and wrap legacy codeFile→source. nameToKey is fully populated
  // after this loop so the rewrite pass below needs only a single scan (no forward-ref gaps).
  for (const p of arr(out.pages)) {
    if (!p || typeof p !== 'object') continue;
    let key = slugify(p.name);
    let n = 1;
    while (used.has(key)) { n += 1; key = `${slugify(p.name)}-${n}`; }
    used.add(key);
    p.key = key;
    nameToKey.set(p.name, key);
    if (!p.source && typeof p.codeFile === 'string') { p.source = { kind: 'tsx', codeFile: p.codeFile }; delete p.codeFile; }
  }
  // Pass 2: rewrite name-refs to keys exactly once. Because nameToKey is complete, forward refs
  // (a page referencing a later-declared page) resolve correctly without a repeated second pass.
  for (const p of arr(out.pages)) {
    if (!p || typeof p !== 'object') continue;
    for (const nav of arr(p.navigatesTo)) { if (nav && nameToKey.has(nav.targetKey)) nav.targetKey = nameToKey.get(nav.targetKey); }
  }
  for (const a of arr(out.appShell && out.appShell.areas)) {
    if (!a || typeof a !== 'object') continue;
    for (const g of arr(a.groups)) {
      if (!g || typeof g !== 'object') continue;
      for (const sa of arr(g.subAreas)) { if (sa && sa.page && nameToKey.has(sa.page)) sa.page = nameToKey.get(sa.page); }
    }
  }
  return out;
}

module.exports = {
  validateAppSpec,
  normalizePageSource,
  normalizeLanguageCode,
  quickCreateEnabledFor,
  isPlatformIconRef,
  webResourceNameFromRef,
  FORM_TYPE_CODE,
  FORM_GUID_RE,
  ACCESS_LEVELS,
  PRIVILEGE_SCOPES,
  SDK_ROLE_MARKER,
  canonicalPersonaName,
  VALIDATION_PROFILES,
  DIRECT_ENTRY_BEHAVIORS,
  COLUMN_VISUALIZATIONS,
  INTEGER_FORMATS,
  BUSINESS_RULE_OPERATORS,
  BUSINESS_RULE_VALUELESS_OPERATORS,
  BUSINESS_RULE_ACTIONS,
  BUSINESS_RULE_ACTION_TYPES,
  BUSINESS_RULE_DATA_TYPES,
  BUSINESS_RULE_SCOPES,
  migrateAppSpec,
  columnTypeMap,
  TYPE_MAP,
  choiceValueMap,
  invalidChoiceSampleTokens,
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  lookupColumnsFor,
  childRelationshipsFor,
  relationshipSchemaName,
  prefixedRelationshipName,
  manyToManyFor,
  manyToManySchemaName,
  isSafeHttpUrl,
  CHART_TYPES,
};
