// App Spec schema + validator. The App Spec is the reviewable contract between
// the app-builder's LLM proposal and the deterministic builder.

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

// The N:N relationship's SCHEMA name (the intersect/RelationshipName), defaulting to
// `<entity1>_<entity2>` with the publisher prefix guaranteed at the front (see
// prefixedRelationshipName) — matches the builder's createRelationship naming.
function manyToManySchemaName(rel, publisherPrefix) {
  if (rel && rel.schemaName) {
    return rel.schemaName;
  }
  return prefixedRelationshipName(rel.entity1, rel.entity2, publisherPrefix);
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
// means the page declares neither a source nor a codeFile.
function normalizePageSource(page) {
  if (page && page.source && typeof page.source === 'object') {
    if (page.source.kind === 'intent') return { kind: 'intent' };
    if (page.source.kind === 'tsx') return { kind: 'tsx', codeFile: page.source.codeFile };
    return { kind: page.source.kind }; // malformed — surfaced by the validator below
  }
  if (page && typeof page.codeFile === 'string') return { kind: 'tsx', codeFile: page.codeFile };
  return null;
}

function validateAppSpec(spec, opts = {}) {
  const profile = opts.profile || 'deploy';
  const errors = [];
  if (!VALIDATION_PROFILES.includes(profile)) {
    return { ok: false, errors: [`unknown validation profile '${profile}' (valid: ${VALIDATION_PROFILES.join(', ')})`] };
  }
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['spec is not an object'] };
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
      const qf = (spec.forms || []).find((x) => x.name === qv.form);
      if (!qf) errors.push(`form ${f.entity}: quickView references form '${qv.form}' not found in forms[]`);
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
  for (const p of spec.pages || []) {
    if (!p || !p.name) { errors.push('a page is missing a name'); continue; }
    pageNamesSet.add(p.name);
    const src = normalizePageSource(p);
    if (src && src.kind !== 'intent' && src.kind !== 'tsx') {
      errors.push(`page '${p.key || p.name}': source.kind must be 'intent' or 'tsx'`);
    } else if (src && src.kind === 'tsx' && (typeof src.codeFile !== 'string' || !src.codeFile)) {
      errors.push(`page '${p.key || p.name}': source.kind 'tsx' needs a codeFile (path to the .tsx)`);
    }
    if (profile === 'deploy') {
      if (!(src && src.kind === 'tsx' && typeof src.codeFile === 'string' && src.codeFile)) {
        errors.push(`page '${p.key || p.name}': must be implemented (source.kind 'tsx' with a codeFile) for a deploy build — run generate-pages`);
      }
    } else if (profile !== 'structural' && src === null) {
      // design/plan still require SOME declared source (intent or tsx) — a page with neither is a
      // spec error, not a valid design.
      errors.push(`page '${p.key || p.name}': needs a source ({ kind: 'intent' } or { kind: 'tsx', codeFile })`);
    }
    // schemaVersion 2 adds a required, unique stable key per page so pages can be referenced by an
    // identity that survives renames. The key is also what navigatesTo.targetKey and appShell page
    // subareas use (key-based refs replace name-based refs for v2 specs).
    if (isV2) {
      if (!p.key || typeof p.key !== 'string') errors.push(`page '${p.name}': needs a stable key (schemaVersion 2)`);
      else if (pageKeysSet.has(p.key)) errors.push(`duplicate page key '${p.key}'`);
      else pageKeysSet.add(p.key);
    }
  }
  // Navigation graph: every navigatesTo.targetKey must resolve to a known page key. pageInput shape
  // is validated here too (object, not array/null). Both are independent of profile — they are spec
  // structural errors, not implementation-state errors.
  for (const p of spec.pages || []) {
    for (const nav of p.navigatesTo || []) {
      if (!nav || typeof nav.targetKey !== 'string') { errors.push(`page '${p.key || p.name}': navigatesTo entry needs a targetKey`); continue; }
      if (isV2 && !pageKeysSet.has(nav.targetKey)) errors.push(`page '${p.key || p.name}': navigatesTo target '${nav.targetKey}' is not a known page key`);
      if (nav.data !== undefined && (typeof nav.data !== 'object' || nav.data === null || Array.isArray(nav.data))) errors.push(`page '${p.key || p.name}': navigatesTo.data must be an object`);
    }
    if (p.pageInput !== undefined) {
      if (typeof p.pageInput !== 'object' || p.pageInput === null || Array.isArray(p.pageInput)) errors.push(`page '${p.key || p.name}': pageInput must be an object`);
    }
  }
  // Icons are chrome, not a target: a web-resource `icon` must reference a declared IMAGE web
  // resource; `vectorIcon` is a free-form Fluent token (no web resource, not validated here).
  const checkIcon = (icon, label) => {
    if (!icon) return;
    const ic = String(icon).toLowerCase();
    if (!webResourceNames.has(ic)) errors.push(`${label}: icon '${icon}' is not a declared web resource`);
    else if (!imageWebResourceNames.has(ic)) errors.push(`${label}: icon '${icon}' must be an image web resource (png/jpg/gif/svg/ico)`);
  };
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    checkIcon(a.icon, `sitemap area "${a.label || ''}"`);
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        const targets = ['entity', 'dashboard', 'url', 'page'].filter((k) => sa[k]);
        if (targets.length === 0) errors.push(`sitemap subArea "${sa.title || ''}" needs an entity, dashboard, url, or page`);
        else if (targets.length > 1) errors.push(`sitemap subArea "${sa.title || ''}" sets multiple targets (${targets.join(', ')}) — pick one`);
        if (sa.entity && !entityNames.has(sa.entity)) errors.push(`sitemap subArea references unknown entity '${sa.entity}'`);
        if (sa.dashboard && !dashNamesSet.has(sa.dashboard)) errors.push(`sitemap subArea references unknown dashboard '${sa.dashboard}' (declare it in dashboards[])`);
        // schemaVersion 2 references pages by stable KEY; legacy specs still reference by name.
        const pageRefSet = isV2 ? pageKeysSet : pageNamesSet;
        if (sa.page && !pageRefSet.has(sa.page)) errors.push(`sitemap subArea references unknown page '${sa.page}' (declare it in pages[])`);
        checkIcon(sa.icon, `sitemap subArea "${sa.title || ''}"`);
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
        for (const rec of v) {
          if (!rec || rec.$parent === undefined) {
            continue;
          }
          const p = rec.$parent;
          if (!p || typeof p !== 'object' || !p.entity || !lower.has(String(p.entity).toLowerCase())) {
            errors.push(`sampleData['${k}']: $parent.entity '${p && p.entity}' is unknown`);
            continue;
          }
          if (!p.match || typeof p.match !== 'object' || !Object.keys(p.match).length) {
            errors.push(`sampleData['${k}']: $parent.match must be a non-empty object`);
            continue;
          }
          if (!relationshipFor(spec, p.entity, k)) {
            errors.push(`sampleData['${k}']: no OneToMany relationship from $parent '${p.entity}' to '${k}'`);
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
      const AI_FEATURE_KEYS = new Set(['formFill', 'nlSearch', 'nlChart', 'm365']);
      if (spec.ai.appFeatures !== undefined) {
        if (!spec.ai.appFeatures || typeof spec.ai.appFeatures !== 'object' || Array.isArray(spec.ai.appFeatures)) {
          errors.push('ai.appFeatures must be an object');
        } else {
          for (const [k, v] of Object.entries(spec.ai.appFeatures)) {
            if (!AI_FEATURE_KEYS.has(k)) errors.push(`ai.appFeatures: unknown key '${k}' (allowed: formFill, nlSearch, nlChart, m365)`);
            if (typeof v !== 'boolean') errors.push(`ai.appFeatures.${k}: must be a boolean`);
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
  // Page design contract (optional). Shape-only in this plan; the token→Fluent mapping and
  // generated-page validation land in the Pages plan. Reject unknown keys so typos fail early.
  if (spec.design !== undefined) {
    if (typeof spec.design !== 'object' || spec.design === null || Array.isArray(spec.design)) {
      errors.push('design must be an object');
    } else {
      const allowed = new Set(['accentColor', 'density', 'cornerRadius', 'darkMode', 'layout']);
      for (const k of Object.keys(spec.design)) if (!allowed.has(k)) errors.push(`design: unknown key '${k}' (allowed: ${[...allowed].join(', ')})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateAppSpec,
  normalizePageSource,
  VALIDATION_PROFILES,
  columnTypeMap,
  TYPE_MAP,
  choiceValueMap,
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
