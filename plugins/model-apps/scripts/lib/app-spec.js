// App Spec schema + validator. The App Spec is the reviewable contract between
// the app-builder's LLM proposal and the deterministic builder.

const path = require('node:path');

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
// See docs/app-builder-staged-flow-design.md §7.1.
const VALIDATION_PROFILES = ['design', 'plan', 'deploy', 'structural'];

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
  if (!spec.solution || !spec.solution.uniqueName) {
    errors.push('solution.uniqueName is required');
  }
  if (!spec.solution || !spec.solution.publisherPrefix) {
    errors.push('solution.publisherPrefix is required');
  }
  if (!spec.app || !spec.app.name) {
    errors.push('app.name is required');
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
    for (const c of e.columns || []) {
      if (!c.schemaName) {
        errors.push(`entity ${e.schemaName}: a column is missing schemaName`);
      }
      if (c.type && !TYPE_MAP[c.type]) {
        errors.push(`entity ${e.schemaName}: column ${c.schemaName} has unknown type '${c.type}'`);
      }
      if ((c.type === 'Choice' || c.type === 'MultiChoice') && !(Array.isArray(c.options) && c.options.length) && !c.globalChoice) {
        errors.push(`column ${c.schemaName}: ${c.type} needs options[] or a globalChoice reference`);
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
  // Dashboards: chart/list tiles reference a declared chart/view; iframe needs a url; webresource a
  // declared web resource.
  const DASH_TILE_TYPES = new Set(['chart', 'list', 'iframe', 'webresource']);
  const viewNamesSet = new Set((spec.views || []).map((v) => v.name));
  const chartNamesSet = new Set((spec.charts || []).map((c) => c.name));
  for (const d of spec.dashboards || []) {
    if (!d || !d.name) { errors.push('a dashboard is missing a name'); continue; }
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
        if (sa.url && !isSafeHttpUrl(sa.url)) errors.push(`sitemap subArea "${sa.title || ''}" url must be an http(s) URL (got '${sa.url}')`);
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
// so downstream code only ever sees the v2 shape. See docs/app-builder-staged-flow-design.md §7.3.
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
  // Pass 1: mint every key and wrap legacy codeFile→source. nameToKey is fully populated
  // after this loop so the rewrite pass below needs only a single scan (no forward-ref gaps).
  for (const p of out.pages || []) {
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
  for (const p of out.pages || []) {
    for (const nav of p.navigatesTo || []) { if (nav && nameToKey.has(nav.targetKey)) nav.targetKey = nameToKey.get(nav.targetKey); }
  }
  for (const a of (out.appShell && out.appShell.areas) || []) {
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) { if (sa && sa.page && nameToKey.has(sa.page)) sa.page = nameToKey.get(sa.page); }
    }
  }
  return out;
}

module.exports = {
  validateAppSpec,
  normalizePageSource,
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
  CHART_TYPES,
};
