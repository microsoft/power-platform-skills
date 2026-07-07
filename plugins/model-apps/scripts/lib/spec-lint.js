// plugins/model-apps/scripts/lib/spec-lint.js
// Pure App Spec guardrail. Returns { ok, errors, warnings }. errors block the plan
// gate; warnings teach. Bakes in the modeling lessons hit live — notably the
// relationship schema-name vs lookup-name collision Dataverse rejects.
const { relationshipSchemaName, relationshipFor, choiceValueMap } = require('./app-spec.js');

const CHOICE_OPTION_WARN = 12;
const SEQNUM_RE = /\{SEQNUM(:\d+)?\}/i;
// FetchXML operators that take no <value> (so a filter may omit value/values).
const NO_VALUE_OPS = new Set(['null', 'not-null', 'eq-userid', 'ne-userid', 'eq-useroruserteams', 'eq-userteams',
  'today', 'yesterday', 'tomorrow', 'this-week', 'last-week', 'next-week', 'this-month', 'last-month', 'next-month',
  'this-year', 'last-year', 'next-year', 'this-fiscal-year', 'last-seven-days', 'next-seven-days']);

function lintAppSpec(spec) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);
  const lc = (s) => String(s || '').toLowerCase();

  const prefix = spec.solution && spec.solution.publisherPrefix;
  const entityNames = new Set();
  const globalChoiceNames = new Set((spec.globalChoices || []).map((g) => lc(g.name)));
  const webResourceNames = new Set((spec.webResources || []).map((w) => lc(w.name)));
  const WEB_RESOURCE_KINDS = new Set(['js', 'html', 'css', 'xml', 'png', 'jpg', 'gif', 'xsl', 'ico', 'svg', 'resx']);
  const FORM_EVENTS = new Set(['onload', 'onsave', 'onchange']);
  // columns per entity (logical) — used to validate onchange attributes.
  const columnsByEntity = {};
  for (const e of spec.entities || []) {
    const set = new Set((e.columns || []).map((c) => lc(c.schemaName)));
    if (e.primaryAttribute && e.primaryAttribute.schemaName) set.add(lc(e.primaryAttribute.schemaName));
    columnsByEntity[lc(e.schemaName)] = set;
  }
  for (const wr of spec.webResources || []) {
    if (!wr.name) E('A webResource is missing a name');
    if (!WEB_RESOURCE_KINDS.has(lc(wr.type || 'js'))) E(`webResource '${wr.name}' has unknown type '${wr.type}'`);
    if (wr.content === undefined && wr.contentBase64 === undefined && !wr.contentPath) E(`webResource '${wr.name}' needs content, contentBase64, or contentPath`);
    if (lc(wr.type || 'js') === 'js' && wr.name && !lc(wr.name).endsWith('.js')) W(`web resource '${wr.name}' is a script but its name doesn't end in .js — Dataverse convention expects the extension`);
    if (prefix && wr.name && !lc(wr.name).startsWith(lc(prefix) + '_')) W(`web resource '${wr.name}' does not use the solution prefix '${prefix}_'`);
  }
  for (const g of spec.globalChoices || []) {
    if (!g.name) E('A globalChoice is missing a name');
    if (!(Array.isArray(g.options) && g.options.length)) E(`globalChoice '${g.name}' needs options[]`);
  }

  for (const e of spec.entities || []) {
    const key = lc(e.schemaName);
    if (entityNames.has(key)) E(`Duplicate entity schemaName: ${e.schemaName}`);
    entityNames.add(key);

    if (prefix && e.schemaName && !lc(e.schemaName).startsWith(lc(prefix) + '_')) {
      W(`Entity ${e.schemaName} does not use the solution prefix '${prefix}_'`);
    }
    if (!e.primaryAttribute || !e.primaryAttribute.schemaName || !e.primaryAttribute.displayName) {
      E(`Entity ${e.schemaName} is missing a primaryAttribute (schemaName + displayName)`);
    }
    if (e.primaryAttribute && e.primaryAttribute.autoNumberFormat && !SEQNUM_RE.test(e.primaryAttribute.autoNumberFormat)) {
      W(`Entity ${e.schemaName} primary AutoNumber format '${e.primaryAttribute.autoNumberFormat}' has no {SEQNUM} token — every record would get the same value`);
    }

    const cols = new Set();
    for (const c of e.columns || []) {
      const ck = lc(c.schemaName);
      if (cols.has(ck)) E(`Entity ${e.schemaName} has a duplicate column ${c.schemaName}`);
      cols.add(ck);
      if (c.type === 'Choice' || c.type === 'MultiChoice') {
        if (c.globalChoice && !globalChoiceNames.has(lc(c.globalChoice))) E(`Column ${e.schemaName}.${c.schemaName} references unknown globalChoice '${c.globalChoice}'`);
        else if (!c.globalChoice && !(c.options && c.options.length)) E(`${c.type} column ${e.schemaName}.${c.schemaName} needs options[] or a globalChoice`);
        else if (c.options && c.options.length > CHOICE_OPTION_WARN) W(`Column ${e.schemaName}.${c.schemaName} has ${c.options.length} options — consider a lookup table`);
      }
      if ((c.source === 'Calculated' || c.source === 'Rollup') && !c.formula) W(`${c.source} column ${e.schemaName}.${c.schemaName} has no formula — it will be created empty`);
      if (c.type === 'AutoNumber' && c.autoNumberFormat && !SEQNUM_RE.test(c.autoNumberFormat)) W(`AutoNumber column ${e.schemaName}.${c.schemaName} format '${c.autoNumberFormat}' has no {SEQNUM} token`);
    }
    const keyable = new Set([...cols, lc(e.primaryAttribute && e.primaryAttribute.schemaName)]);
    for (const k of e.alternateKeys || []) {
      if (!k.schemaName) E(`Entity ${e.schemaName} has an alternate key without a schemaName`);
      for (const kc of k.columns || []) if (!keyable.has(lc(kc))) E(`Alternate key ${e.schemaName}.${k.schemaName} references unknown column '${kc}'`);
      if (!(k.columns && k.columns.length)) E(`Alternate key ${e.schemaName}.${k.schemaName} needs columns[]`);
    }
    for (const sr of e.statusReasons || []) {
      if (!sr.label) E(`Entity ${e.schemaName} has a statusReason without a label`);
      if (sr.state && sr.state !== 'Active' && sr.state !== 'Inactive') E(`statusReason '${sr.label}' state must be 'Active' or 'Inactive'`);
    }
  }

  for (const r of spec.relationships || []) {
    if (r.type === 'ManyToMany') {
      if (!entityNames.has(lc(r.entity1))) E(`N:N relationship references unknown entity '${r.entity1}'`);
      if (!entityNames.has(lc(r.entity2))) E(`N:N relationship references unknown entity '${r.entity2}'`);
      continue;
    }
    if (r.type !== 'OneToMany') continue;
    if (!entityNames.has(lc(r.referenced))) E(`Relationship references unknown entity '${r.referenced}'`);
    if (!entityNames.has(lc(r.referencing))) E(`Relationship references unknown entity '${r.referencing}'`);
    if (!r.lookup || !r.lookup.schemaName) {
      E(`OneToMany ${r.referenced}->${r.referencing} is missing lookup.schemaName`);
      continue;
    }
    if (lc(relationshipSchemaName(r)) === lc(r.lookup.schemaName)) {
      E(`Relationship schema name '${relationshipSchemaName(r)}' collides with its lookup attribute name '${r.lookup.schemaName}' — Dataverse rejects this; use a distinct relationship name`);
    }
  }

  // QuickView forms referenced by a host form's quickViews[] (so we only warn about unplaced ones).
  const placedQuickViewForms = new Set();
  for (const f of spec.forms || []) for (const qv of f.quickViews || []) if (qv && qv.form) placedQuickViewForms.add(qv.form);
  for (const f of spec.forms || []) {
    const formType = f.formType || 'Main';
    if (!['Main', 'QuickCreate', 'QuickView'].includes(formType)) E(`Form ${f.entity} has invalid formType '${f.formType}' (use Main/QuickCreate/QuickView)`);
    if (formType !== 'Main' && (f.subgrids || []).length) E(`Form ${f.entity} is a ${formType} form but declares sub-grids — sub-grids are Main-form only`);
    if (formType === 'QuickView' && !placedQuickViewForms.has(f.name)) W(`Form ${f.entity} is a QuickView form but isn't placed on any host form — add a quickViews[] entry (lookup + form) on the parent form to surface it`);
    for (const sg of f.subgrids || []) {
      const has1N = (spec.relationships || []).some(
        (r) => r.type === 'OneToMany' && lc(r.referenced) === lc(f.entity) && lc(r.referencing) === lc(sg.childEntity)
      );
      const hasNN = (spec.relationships || []).some(
        (r) => r.type === 'ManyToMany' && ((lc(r.entity1) === lc(f.entity) && lc(r.entity2) === lc(sg.childEntity)) || (lc(r.entity1) === lc(sg.childEntity) && lc(r.entity2) === lc(f.entity)))
      );
      if (!has1N && !hasNN) E(`Form ${f.entity} sub-grid for ${sg.childEntity} has no matching OneToMany or ManyToMany relationship`);
    }
    for (const ev of f.events || []) {
      if (!FORM_EVENTS.has(lc(ev.event))) { E(`Form ${f.entity} has an event with unknown type '${ev.event}' (use onload/onsave/onchange)`); continue; }
      if (!ev.library) E(`Form ${f.entity} ${ev.event} handler is missing a library (web-resource name)`);
      else if (!webResourceNames.has(lc(ev.library))) E(`Form ${f.entity} ${ev.event} handler references undeclared web resource '${ev.library}' — add it to webResources[]`);
      if (!ev.function) E(`Form ${f.entity} ${ev.event} handler is missing a function name`);
      if (lc(ev.event) === 'onchange') {
        if (!ev.attribute) E(`Form ${f.entity} onchange handler requires an attribute (column logical name)`);
        else if ((columnsByEntity[lc(f.entity)] || new Set()).size && !columnsByEntity[lc(f.entity)].has(lc(ev.attribute))) W(`Form ${f.entity} onchange handler binds '${ev.attribute}', which isn't a column on ${f.entity}`);
      }
    }
    // Quick-view placement: each entry embeds a QuickView form (by name) via a lookup column.
    for (const qv of f.quickViews || []) {
      if (!qv || !qv.lookup) { E(`Form ${f.entity} has a quickView missing lookup (the lookup column logical name)`); continue; }
      if (!qv.targetEntity || !entityNames.has(lc(qv.targetEntity))) E(`Form ${f.entity} quickView references unknown targetEntity '${qv.targetEntity}'`);
      const qf = qv.form && (spec.forms || []).find((x) => x.name === qv.form);
      if (!qf) E(`Form ${f.entity} quickView references form '${qv.form}' not found in forms[]`);
      else if ((qf.formType || 'Main') !== 'QuickView') E(`Form ${f.entity} quickView form '${qv.form}' must be a QuickView form`);
    }
  }

  // Commands (modern command-bar buttons) — a functional leaf button needs a JS library + function;
  // a flyout/split container (type FlyoutAnchor/SplitButton) instead holds child buttons.
  const COMMAND_LOCATIONS = new Set(['maintab', 'hometab', 'contextualtab']);
  const COMMAND_TYPES = new Set(['button', 'flyoutanchor', 'splitbutton']);
  const lintCmdAction = (label, ent, library, fn) => {
    if (!library) E(`Command '${label}' on ${ent} needs a library (web-resource name)`);
    else if (!webResourceNames.has(lc(library))) E(`Command '${label}' references undeclared web resource '${library}' — add it to webResources[]`);
    if (!fn) E(`Command '${label}' on ${ent} needs a function name`);
  };
  for (const c of spec.commands || []) {
    if (!c.entity || !entityNames.has(lc(c.entity))) { E(`Command references unknown entity '${c.entity}'`); continue; }
    if (!c.label) E(`A command on ${c.entity} is missing a label`);
    if (c.location && !COMMAND_LOCATIONS.has(lc(c.location))) E(`Command '${c.label}' has invalid location '${c.location}' (MainTab/HomeTab/ContextualTab)`);
    const type = c.type || 'Button';
    if (!COMMAND_TYPES.has(lc(type))) E(`Command '${c.label}' has invalid type '${c.type}' (Button/FlyoutAnchor/SplitButton)`);
    if (lc(type) === 'flyoutanchor' || lc(type) === 'splitbutton') {
      if (!(Array.isArray(c.children) && c.children.length)) E(`Command '${c.label}' on ${c.entity} is a ${type} but has no children[] (menu buttons)`);
      for (const ch of c.children || []) {
        if (!ch || !ch.label) { E(`Command '${c.label}' on ${c.entity} has a child button without a label`); continue; }
        lintCmdAction(`${c.label} ▸ ${ch.label}`, c.entity, ch.library, ch.function);
      }
    } else {
      lintCmdAction(c.label, c.entity, c.library, c.function);
    }
  }

  // Dashboards — chart/list tiles must reference a declared chart/view; webresource a web resource.
  const DASH_TILE_TYPES = new Set(['chart', 'list', 'iframe', 'webresource']);
  const viewNames = new Set((spec.views || []).map((v) => lc(v.name)));
  const chartNames = new Set((spec.charts || []).map((c) => lc(c.name)));
  for (const d of spec.dashboards || []) {
    if (!d.name) { E('A dashboard is missing a name'); continue; }
    if (!(d.tiles && d.tiles.length)) W(`Dashboard '${d.name}' has no tiles`);
    for (const t of d.tiles || []) {
      if (!DASH_TILE_TYPES.has(t.type)) { E(`Dashboard '${d.name}' has a tile with invalid type '${t.type}' (chart/list/iframe/webresource)`); continue; }
      if (t.type === 'chart' && (!t.chart || !chartNames.has(lc(t.chart)))) E(`Dashboard '${d.name}' chart tile references unknown chart '${t.chart}'`);
      if ((t.type === 'chart' || t.type === 'list') && (!t.view || !viewNames.has(lc(t.view)))) E(`Dashboard '${d.name}' ${t.type} tile references unknown view '${t.view}'`);
      if (t.type === 'iframe' && !t.url) E(`Dashboard '${d.name}' iframe tile needs a url`);
      if (t.type === 'webresource' && (!t.webResource || !webResourceNames.has(lc(t.webResource)))) E(`Dashboard '${d.name}' webresource tile references undeclared web resource '${t.webResource}'`);
    }
  }

  // Sitemap subareas — each names exactly one target (entity/dashboard/url/page). A DashBoard subarea
  // surfaces a built dashboard in the app nav (and auto-pins it as an app component); a page subarea
  // surfaces a generative page (declared in pages[]) as a GenPage subarea.
  const dashNames = new Set((spec.dashboards || []).map((d) => d && d.name).filter(Boolean));
  const pageNames = new Set((spec.pages || []).map((p) => p && p.name).filter(Boolean));
  // Genpage data sources that aren't declared entities are likely standard tables (fine) or a typo.
  const entityLowerSet = new Set((spec.entities || []).map((e) => lc(e.schemaName)));
  for (const p of spec.pages || []) {
    for (const ds of p.dataSources || []) {
      if (!entityLowerSet.has(lc(ds))) W(`Page '${p.name}' data source '${ds}' isn't a declared entity — ok if it's a standard table, otherwise a likely typo`);
    }
  }
  // `icon` is a web-resource image; `vectorIcon` is a Fluent icon token. Warn on the common mixup.
  const looksLikeFile = (v) => v && /\.(png|jpe?g|gif|svg|ico)$/i.test(String(v));
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    if (looksLikeFile(a.vectorIcon)) W(`Sitemap area "${a.label || ''}": vectorIcon '${a.vectorIcon}' looks like a file — use "icon" for a web-resource image and "vectorIcon" for a Fluent icon token`);
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        const targets = ['entity', 'dashboard', 'url', 'page'].filter((k) => sa[k]);
        if (targets.length === 0) E(`Sitemap subarea "${sa.title || ''}" needs an entity, dashboard, url, or page`);
        else if (targets.length > 1) E(`Sitemap subarea "${sa.title || ''}" sets multiple targets (${targets.join(', ')}) — pick one`);
        if (sa.entity && !entityNames.has(lc(sa.entity))) E(`Sitemap subarea references unknown entity '${sa.entity}'`);
        if (sa.dashboard && !dashNames.has(sa.dashboard)) E(`Sitemap subarea references unknown dashboard '${sa.dashboard}' — declare it in dashboards[]`);
        if (sa.page && !pageNames.has(sa.page)) E(`Sitemap subarea references unknown page '${sa.page}' — declare it in pages[]`);
        if (looksLikeFile(sa.vectorIcon)) W(`Sitemap subarea "${sa.title || ''}": vectorIcon '${sa.vectorIcon}' looks like a file — use "icon" for a web-resource image and "vectorIcon" for a Fluent icon token`);
      }
    }
  }

  for (const ch of spec.charts || []) {
    const ent = (spec.entities || []).find((e) => lc(e.schemaName) === lc(ch.entity));
    if (!ent) { E(`Chart '${ch.name}' references unknown entity '${ch.entity}'`); continue; }
    const col = (ent.columns || []).find((c) => lc(c.schemaName) === lc(ch.groupBy));
    if (!col) W(`Chart '${ch.name}' groups by '${ch.groupBy}', which isn't a column on ${ch.entity}`);
    else if (col.type !== 'Choice') W(`Chart '${ch.name}' groups by a non-Choice column '${ch.groupBy}' — Choice columns chart best`);
  }

  // View filters: each condition needs a value unless the operator is a no-value kind; in/not-in
  // need a values[]. Choice labels in values resolve to ints at build time.
  for (const v of spec.views || []) {
    for (const f of v.filters || []) {
      if (!f.attr) { E(`View '${v.name}' has a filter without an attr`); continue; }
      const op = f.op || 'eq';
      if (op === 'in' || op === 'not-in') {
        if (!(Array.isArray(f.values) && f.values.length)) E(`View '${v.name}' filter on '${f.attr}' uses ${op} but has no values[]`);
      } else if (!NO_VALUE_OPS.has(op) && f.value === undefined) {
        E(`View '${v.name}' filter on '${f.attr}' (${op}) needs a value`);
      }
    }
  }

  // Sample data: a custom statusReason must be declared on the entity; every $parent/$parents
  // bind must have a OneToMany from the named parent to this entity (so the lookup exists);
  // every Choice/MultiChoice value must be a declared option label or an option int (a raw
  // label only auto-resolves for inline-option columns — global choices used to slip through
  // and get rejected by Dataverse, so catch unresolvable labels here regardless of binding).
  for (const [ent, recs] of Object.entries(spec.sampleData || {})) {
    const e = (spec.entities || []).find((x) => lc(x.schemaName) === lc(ent));
    if (!e) continue; // unknown-entity is already an error in validateAppSpec
    const declaredReasons = new Set((e.statusReasons || []).map((s) => lc(s.label)));
    const choiceInts = choiceValueMap(e, spec); // { colLogical: { label: int } } for Choice/MultiChoice
    for (const rec of Array.isArray(recs) ? recs : []) {
      if (rec && rec.statusReason && !declaredReasons.has(lc(rec.statusReason))) E(`sampleData['${ent}'] sets statusReason '${rec.statusReason}', which isn't a declared status reason on ${ent}`);
      const parents = [].concat(rec && rec.$parent ? [rec.$parent] : [], (rec && rec.$parents) || []);
      for (const p of parents) {
        if (p && p.entity && !relationshipFor(spec, p.entity, ent)) E(`sampleData['${ent}']: no OneToMany from parent '${p.entity}' to '${ent}' (needed to bind the lookup)`);
      }
      for (const [field, val] of Object.entries(rec || {})) {
        if (field.startsWith('$')) continue;
        const byLabel = choiceInts[lc(field)];
        if (!byLabel || typeof val !== 'string') continue; // not a choice column, or already an int
        if (byLabel[val] !== undefined) continue;          // whole value is a known label (incl. labels with commas)
        const tokens = val.indexOf(',') >= 0 ? val.split(',').map((t) => t.trim()) : [val];
        for (const tok of tokens) {
          if (tok === '' || /^\d+$/.test(tok)) continue;   // blank or a raw option int
          if (byLabel[tok] === undefined) E(`sampleData['${ent}'] sets ${field}='${tok}', which isn't a valid option for that Choice column — use a declared option label or its integer value`);
        }
      }
    }
  }

  dupWarn((spec.views || []).map((v) => v.name), 'view', W);
  dupWarn((spec.charts || []).map((c) => c.name), 'chart', W);
  dupWarn((spec.forms || []).map((f) => f.name).filter(Boolean), 'form', W);

  return { ok: errors.length === 0, errors, warnings };
}

function dupWarn(names, kind, W) {
  const seen = new Set();
  for (const n of names) {
    const k = String(n || '').toLowerCase();
    if (k && seen.has(k)) W(`Duplicate ${kind} name: ${n}`);
    seen.add(k);
  }
}

module.exports = { lintAppSpec };
