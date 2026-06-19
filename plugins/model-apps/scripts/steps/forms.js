const { columnTypeMap, relationshipFor, relationshipSchemaName } = require('../lib/app-spec.js');
const recs = require('../lib/dataverse-records.js');

// Build the kernelSpec object for a form. Handles tabs/autoFields layout and,
// when includeSubgrids is true (default), resolves declared sub-grids.
// Pass result and deps in opts when includeSubgrids is true so the subgrid
// resolution loop can read result.created.views and emit deps.log messages.
function formKernelSpec(spec, f, { includeSubgrids = true, result, deps } = {}) {
  const entityLogical = f.entity.toLowerCase();
  const entity = spec.entities.find((x) => x.schemaName.toLowerCase() === entityLogical);
  const primaryLogical = entity && entity.primaryAttribute.schemaName.toLowerCase();
  const colOf = (logical) =>
    entity && (entity.columns || []).find((c) => c.schemaName.toLowerCase() === logical);
  // Kernel field type for a logical name (primary is always string).
  const typeOf = (logical) => {
    if (logical === primaryLogical) {
      return 'string';
    }
    const col = colOf(logical);
    return col ? columnTypeMap(col.type || 'Text').kernel : 'string';
  };
  // Display label for a logical name (fixes F1: forms showed logical names).
  const labelOf = (logical) => {
    if (logical === primaryLogical) {
      return entity.primaryAttribute.displayName || logical;
    }
    const col = colOf(logical);
    return (col && (col.displayName || col.schemaName)) || logical;
  };

  const kernelSpec = {};
  const explicit = Array.isArray(f.tabs) || f.layout === 'explicit';
  if (explicit) {
    kernelSpec.tabs = (f.tabs || []).map((t) => ({
      label: t.label,
      sections: t.sections.map((s) => ({
        label: s.label,
        columns: s.columns || 1,
        fields: s.fields.map((fl) => {
          const logical = fl.toLowerCase();
          return { logicalName: logical, label: labelOf(logical), type: typeOf(logical) };
        }),
      })),
    }));
  } else {
    // autoFields: the primary, then every scalar column, with display labels.
    const autoFields = [];
    if (entity) {
      const primaryDisplay = entity.primaryAttribute.displayName || primaryLogical;
      autoFields.push({
        logicalName: primaryLogical,
        // `label` keeps the explicit-tabs/cellXml path working; `displayName` is what
        // the kernel's planFormLayout/displayLabel reads for the auto-layout path (fixes F1).
        label: primaryDisplay,
        displayName: primaryDisplay,
        type: 'string',
        required: true,
      });
      for (const c of entity.columns || []) {
        const colDisplay = c.displayName || c.schemaName;
        autoFields.push({
          logicalName: c.schemaName.toLowerCase(),
          label: colDisplay,
          displayName: colDisplay,
          type: columnTypeMap(c.type || 'Text').kernel,
          required: c.required === true,
        });
      }
    }
    kernelSpec.autoFields = autoFields;
    if (f.purpose) {
      kernelSpec.purpose = f.purpose;
    }
  }

  if (includeSubgrids) {
    // Resolve declared sub-grids: relationshipName from the App Spec relationship,
    // child view id from the views we already built (by name, else the child's first).
    const subgrids = [];
    for (const sg of f.subgrids || []) {
      const rel = relationshipFor(spec, f.entity, sg.childEntity);
      if (!rel) {
        if (deps) {
          deps.log(`form ${f.entity}: skipping subgrid for ${sg.childEntity} (no OneToMany relationship)`);
        }
        continue;
      }
      const childLogical = sg.childEntity.toLowerCase();
      const createdViews = (result && result.created && result.created.views) || {};
      let viewId = sg.view && createdViews[sg.view];
      if (!viewId) {
        // fall back to the first built view of the child entity
        const childView = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical);
        viewId = childView && createdViews[childView.name];
      }
      subgrids.push({
        targetEntity: childLogical,
        relationshipName: relationshipSchemaName(rel), // the relationship schema name, not the lookup
        viewId,
        label: sg.label || sg.childEntity,
      });
    }
    if (subgrids.length) {
      kernelSpec.subgrids = subgrids;
    }
  }

  return kernelSpec;
}

// --- 3. Forms: kernel buildForm -> PATCH the system-generated main form.
// If the form declares explicit `tabs` (or layout==="explicit") we send the maker's
// structure verbatim (now with a per-field display label). Otherwise we send
// `autoFields` (the entity's primary + columns as {logicalName,label,type,required})
// plus `purpose` and let the kernel's planFormLayout derive the layout. Sub-grids in
// `form.subgrids` are resolved here to a relationshipName + child view id.
async function forms(spec, opts, deps, result) {
  result.created.forms = {};
  for (const f of spec.forms) {
    deps.step(`form for ${f.entity}`);
    const entityLogical = f.entity.toLowerCase();

    const kernelSpec = formKernelSpec(spec, f, { includeSubgrids: true, result, deps });

    const built = deps.kernel({
      kind: 'buildForm',
      spec: kernelSpec,
      ctx: { entityName: entityLogical, formId: '{00000000-0000-0000-0000-000000000000}', formName: f.name },
    });
    if (!built.ok) {
      throw new Error(`kernel buildForm failed: ${built.error && built.error.message}`);
    }
    const form = await recs.findMainForm(deps.dv, entityLogical);
    if (!form) {
      throw new Error(`no main form found for ${entityLogical}`);
    }
    await recs.patchFormXml(deps.dv, form.formid, built.formxml);
    deps.runScript('add-to-solution.js', [opts.env, spec.solution.uniqueName, form.formid, '60']); // 60 = Form
    result.created.forms[entityLogical] = form.formid;
  }
}

module.exports = { forms, formKernelSpec };
