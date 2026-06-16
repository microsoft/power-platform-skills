// model-maker relay — injected bridge.
//
// This file is injected into the live model-driven FORM designer page (the relay
// reads it as text and runs it via Playwright `page.evaluate`). It exposes a tiny
// synchronous-ish command surface on `window.__mmBridge` that the relay drives:
//   - status()                              -> readiness + how the handle was acquired
//   - inspect()                             -> live form: sections (+ ids) and available unused fields
//   - addField(fieldName, sectionId, force) -> add a table field to a section via the designer's own command
//   - listControls(fieldName)               -> (READ-ONLY) custom controls (PCF/AI Builder) the env offers for a field
//   - describeControl(controlId)            -> (READ-ONLY) a control's binding kind + param schema (from its manifest)
//   - setControl(field, controlId, p, ff)   -> set a custom control on a field (prefers the first-party facade); p applies params
//   - addComponent(controlId, sectionId, p, ff) -> place a control as a NEW component in a section (unbound/dataset, e.g. PowerBI)
//   - getControl(field)                     -> (READ-ONLY) a field cell's control + props (classId, customControls, label, visible, ...)
//   - removeControl(field)                  -> remove a field/control from the form (DIRECT; any build)
//   - setFieldProps(field, props)           -> set label/visible/readonly/showLabel/locked/availableForPhone (DIRECT; any build)
//   - moveControl(field, targetId, pos)     -> move a control to another section/position (DIRECT; any build)
//   - addSubgrid(sectionId, entity, opts)   -> add a related-records subgrid to a section (facade)
//   - addTab(targetTabId, columns, name)    -> add a tab to the form (facade)
//   - addSection(targetId, columns, name)   -> add a section to a tab/section (facade)
//   - addColumn(sectionId, columns)         -> set a section's column count 1-4 (DIRECT; any build)
//   - addEventHandler(target, options)      -> add a form/control event handler (DIRECT; any build)
//   - setFormProps(props)                   -> set form name/description/maxWidth/showImage (DIRECT; any build)
//   - removeElement(elementId)              -> remove any element (tab/section/cell) by id (DIRECT; any build)
//   - undo() / redo()                       -> undo/redo the last designer change (DIRECT; any build)
//   - save() / publish()                    -> PERSIST (gated by the relay's MM_ALLOW_SAVE / MM_ALLOW_PUBLISH)
//
// It is also `require()`-able so it can be unit-tested with `node --test`
// (the functions read the ambient `window`/`document` at call time, which tests
// stub). It deliberately avoids any imports and stays conservative ES so it runs
// unchanged in the page.
//
// HOW THE HANDLE IS ACQUIRED (validated live on the deployed React 16.14 designer,
// see docs/ModelMaker/poc-findings.md in the modelpages-ade repo):
//   1. `window.__formDesignerApi` if present (the first-party flag-gated export);
//   2. else a React fiber walk from `#root`, matching the FormDesignerService by
//      DUCK-TYPING on its public method names — never on minification-fragile
//      component names.

(function () {
  'use strict';

  function getWin() {
    if (typeof window !== 'undefined') return window;
    if (typeof globalThis !== 'undefined') return globalThis;
    return {};
  }
  function getDoc() {
    if (typeof document !== 'undefined') return document;
    var w = getWin();
    return w && w.document ? w.document : null;
  }

  // The FormDesignerService is identified by the methods the bridge actually
  // calls; these are string keys on the live object and are not minified.
  function isService(v) {
    return !!v && typeof v === 'object' &&
      typeof v.addFieldOnConfirm === 'function' &&
      typeof v.onElementMetadataChange === 'function' &&
      'formModel' in v;
  }

  // React 16 (ReactDOM.render): the container carries `_reactRootContainer`;
  // fall back to the `__reactContainer$`/`__reactFiber$` keys for safety.
  function firstFiber(node) {
    if (!node) return null;
    var rc = node._reactRootContainer;
    if (rc && rc._internalRoot && rc._internalRoot.current) return rc._internalRoot.current;
    if (rc && rc.current) return rc.current;
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('__reactContainer$') === 0 || k.indexOf('__reactFiber$') === 0) return node[k];
    }
    return null;
  }

  function fiberWalk() {
    var doc = getDoc();
    var el = doc && doc.getElementById ? doc.getElementById('root') : null;
    if (!el) return null;
    var start = firstFiber(el);
    if (!start) return null;
    var stack = [start];
    var depth = 0;
    while (stack.length && depth < 200000) {
      var cur = stack.pop();
      depth++;
      if (!cur) continue;
      // A context Provider's current value is on memoizedProps.value.
      if (cur.memoizedProps && isService(cur.memoizedProps.value)) return cur.memoizedProps.value;
      if (cur.child) stack.push(cur.child);
      if (cur.sibling) stack.push(cur.sibling);
    }
    return null;
  }

  function getDesignerHandle() {
    var w = getWin();
    var api = w.__formDesignerApi;
    if (api && isService(api.service)) {
      return { service: api.service, store: api.store, source: 'export' };
    }
    var svc = fiberWalk();
    if (svc) return { service: svc, store: svc.store, source: 'fiber' };
    return null;
  }

  // computeUsedFields returns an array of logical names on the live designer;
  // tolerate a Set too, just in case a future build changes it.
  function usedFieldsArray(svc, fm) {
    var u = svc.formFieldService.computeUsedFields(fm);
    if (Array.isArray(u)) return u;
    if (u && typeof u.forEach === 'function') {
      var out = [];
      u.forEach(function (x) { out.push(x); });
      return out;
    }
    return [];
  }

  function status() {
    var h = getDesignerHandle();
    return {
      ok: !!h,
      source: h ? h.source : null,
      capability: h ? { inspect: true, addField: true } : null,
    };
  }

  function inspect() {
    var h = getDesignerHandle();
    if (!h) return { ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } };
    var svc = h.service;
    var fm = svc.formModel;

    var sections = [];
    var tabs = [];
    try {
      fm.visit(function (n) {
        if (!n || !n.getNodeName) return;
        var nm = n.getNodeName();
        if (nm === 'section' && n.id) sections.push({ id: n.id.guidString });
        else if (nm === 'tab' && n.id) tabs.push({ id: n.id.guidString || n.id.GuidString });
      });
    } catch (e) { /* tolerate a partially-loaded tree */ }

    var available = [];
    try {
      var attrs = (svc.formFieldService.getModel().attributes) || [];
      var used = usedFieldsArray(svc, fm);
      var usedSet = {};
      for (var i = 0; i < used.length; i++) usedSet[used[i]] = true;
      for (var j = 0; j < attrs.length; j++) {
        var a = attrs[j];
        if (a.isValidForForm && !usedSet[a.name]) available.push({ name: a.name, displayName: a.displayName });
      }
    } catch (e) { /* field service not ready */ }

    return { ok: true, result: { formType: fm.formType, tabs: tabs, sections: sections, available: available } };
  }

  function addField(fieldName, sectionId, force) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var fm = svc.formModel;

    // The designer does not block duplicate fields on a body section (the picker
    // UI just greys used fields out), so the bridge owns the guard. See poc-findings.
    var used;
    try { used = usedFieldsArray(svc, fm); } catch (e) { used = []; }
    if (used.indexOf(fieldName) >= 0 && !force) {
      return Promise.resolve({
        ok: false,
        validation: [{ code: 'duplicate-field', message: fieldName + ' is already on the form' }],
      });
    }

    return Promise.resolve()
      .then(function () { return svc.addFieldOnConfirm(fieldName, sectionId, 'Click'); })
      .then(function () {
        return { ok: true, result: { fieldName: fieldName, targetSectionId: sectionId, source: h.source } };
      })
      .catch(function (e) {
        return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } };
      });
  }

  // Read a Loadable<string> (the designer wraps localized display names); tolerate
  // a plain string or {value}/{getValue()} shapes across builds.
  function readLoadable(l) {
    if (l == null) return undefined;
    if (typeof l === 'string') return l;
    if (typeof l.value !== 'undefined') return l.value;
    if (typeof l.getValue === 'function') { try { return l.getValue(); } catch (e) { /* ignore */ } }
    return undefined;
  }

  // Resolve a field's EntityAttribute. It carries dataType/dataTypeFormat/formatName,
  // which gate which controls are compatible with the field.
  function getFieldAttr(svc, name) {
    var ffs = svc.formFieldService;
    if (!ffs) return null;
    try { if (ffs.getEntityAttribute) { var f = ffs.getEntityAttribute(name); if (f) return f; } } catch (e) { /* ignore */ }
    try {
      var model = ffs.getModel && ffs.getModel();
      if (model && model.getEntityAttributeByName) { var g = model.getEntityAttributeByName(name); if (g) return g; }
      var attrs = (model && model.attributes) || [];
      for (var i = 0; i < attrs.length; i++) if (attrs[i].name === name) return attrs[i];
    } catch (e) { /* ignore */ }
    return null;
  }

  // READ-ONLY discovery: list the custom controls (PCF / AI Builder, e.g. "Business
  // card reader") the environment offers for a field. Mirrors
  // CustomControlService.getControls via the discovery service that hangs off
  // FormModelService -- reachable from the same handle we already hold.
  //
  // Passing [] as the seed returns the WHITELISTED (first-party) controls
  // compatible with the field's data type -- i.e. the default component-picker
  // list. Previously-imported, non-whitelisted PCF would need the in-product seed
  // (cached + form ControlDescriptions); that's a reason the first-party facade is
  // the robust path for the setter (see the Phase-2 notes in the poc plan).
  function listControls(fieldName) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;

    var discovery, env;
    try {
      discovery = svc.FormModelService && svc.FormModelService.customControlDiscoveryService;
      env = svc.Environment && svc.Environment.name;
    } catch (e) { /* ignore */ }
    if (!discovery || typeof discovery.getAllCompatibleControlsMetadata !== 'function') {
      return Promise.resolve({ ok: false, error: { code: 'no-discovery', message: 'customControlDiscoveryService unavailable' } });
    }

    var field = null;
    if (fieldName) {
      field = getFieldAttr(svc, fieldName);
      if (!field) return Promise.resolve({ ok: false, error: { code: 'no-field', message: fieldName + ' not found on entity' } });
    }
    var dataType = field ? field.dataType : undefined;
    var dataTypeFormat = field ? field.dataTypeFormat : undefined;
    var formatName = field ? field.formatName : undefined;

    return Promise.resolve()
      .then(function () { return discovery.getAllCompatibleControlsMetadata(env, [], dataType, dataTypeFormat, formatName, false); })
      .then(function (map) {
        var controls = [];
        var add = function (ccmd, key) {
          if (!ccmd) return;
          controls.push({
            name: ccmd.name || key,
            displayName: readLoadable(ccmd.displayName) || ccmd.displayNameKey || ccmd.manifestName || ccmd.name || key,
            bindingKind: bindingKindFor(ccmd),
            compatibleDataTypes: ccmd.compatibleDataTypes,
            isBound: typeof ccmd.isBound === 'function' ? !!ccmd.isBound() : undefined,
            hasDataset: !!ccmd.hasDatasetConfiguration,
          });
        };
        if (map && typeof map.forEach === 'function') {
          map.forEach(function (v, k) { add(v, k); }); // Map -> (value, key)
        } else if (map && typeof map === 'object') {
          var keys = Object.keys(map);
          for (var i = 0; i < keys.length; i++) add(map[keys[i]], keys[i]);
        }
        return { ok: true, result: { field: fieldName || null, dataType: dataType, count: controls.length, controls: controls } };
      })
      .catch(function (e) { return { ok: false, error: { code: 'discovery-error', message: String((e && e.message) || e) } }; });
  }

  // Classify a control from its metadata so callers know HOW it binds (and thus
  // which intent applies). Derived from compatibleDataTypes / dataset config /
  // isBound -- generic, no per-control knowledge.
  function bindingKindFor(md) {
    if (!md) return 'unknown';
    var compat = md.compatibleDataTypes || [];
    var has = function (pred) { for (var i = 0; i < compat.length; i++) { if (pred(String(compat[i]))) return true; } return false; };
    if (md.hasDatasetConfiguration || has(function (t) { return t === 'Grid'; })) return 'dataset';     // bound to a view/relationship, not a field
    if (has(function (t) { return t.indexOf('Lookup') === 0; })) return 'lookup';
    if (typeof md.isBound === 'function' ? md.isBound() : md.isBound) return 'fieldBound';
    return 'unbound';                                                                                   // standalone widget (often needs config)
  }

  // READ-ONLY: a control's binding kind + parameter schema, read from its manifest
  // (CustomControlMetadata.configurations). This is what makes the setter generic:
  // every control is self-describing, so form_setControl(field, controlId, params)
  // can validate against the schema instead of hardcoding per control.
  function describeControl(controlId) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var discovery;
    try { discovery = svc.FormModelService && svc.FormModelService.customControlDiscoveryService; } catch (e) { /* ignore */ }
    if (!discovery || typeof discovery.getCustomControlMetadata !== 'function') {
      return Promise.resolve({ ok: false, error: { code: 'no-discovery', message: 'customControlDiscoveryService unavailable' } });
    }

    return Promise.resolve()
      .then(function () { return discovery.getCustomControlMetadata(controlId, false); })
      .then(function (md) {
        if (!md) return { ok: false, error: { code: 'no-control', message: controlId + ' not found in env' } };
        var params = [];
        try {
          var cfg = md.configurations; // Map<string, CustomControlConfigurationMetadata | CustomControlProperty>
          if (cfg && typeof cfg.forEach === 'function') {
            cfg.forEach(function (p, key) {
              params.push({
                name: p.name || key,
                displayName: readLoadable(p.displayName) || p.displayNameKey || p.name || key,
                usage: p.usage,            // input | bound | output (undefined for non-property configs)
                ofType: p.ofType,
                isRequired: !!p.isRequired,
                isPrimary: !!p.isPrimary,
                defaultValue: p.defaultValue,
                enumValues: p.enumValues && p.enumValues.map(function (e) { return { name: e.name, value: e.value, isDefault: e.isDefault }; }),
              });
            });
          }
        } catch (e) { /* tolerate a manifest we can't fully parse */ }

        return { ok: true, result: {
          controlId: md.name || controlId,
          displayName: readLoadable(md.displayName) || md.displayNameKey || md.manifestName || md.name || controlId,
          bindingKind: bindingKindFor(md),
          isBound: typeof md.isBound === 'function' ? !!md.isBound() : undefined,
          hasDataset: !!md.hasDatasetConfiguration,
          compatibleDataTypes: md.compatibleDataTypes,
          requiredParams: params.filter(function (p) { return p.isRequired; }).map(function (p) { return p.name; }),
          params: params,
        } };
      })
      .catch(function (e) { return { ok: false, error: { code: 'describe-error', message: String((e && e.message) || e) } }; });
  }

  // Set a custom control on a field. The robust path is the first-party intent
  // facade window.__formDesignerApi.addCustomControl (built in cds-form-designer
  // where the model classes are in scope -- a minified deployed build can't `new`
  // CustomControlModel/ControlDescriptionModel from here). The bridge is a thin
  // pass-through; the facade owns model-building, param policy, and validation.
  function setControl(fieldName, controlId, params, factors) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var w = getWin();
    var fapi = w.__formDesignerApi;
    if (fapi && typeof fapi.addCustomControl === 'function') {
      return Promise.resolve()
        .then(function () { return fapi.addCustomControl(fieldName, controlId, params || null, factors || null); })
        .then(function (r) {
          if (r && r.ok === false) return r;                       // facade reported a problem (e.g. params-unsupported, no-cell)
          return { ok: true, result: { field: fieldName, controlId: controlId, source: 'facade', facade: r } };
        })
        .catch(function (e) { return { ok: false, error: { code: 'facade-error', message: String((e && e.message) || e) } }; });
    }
    return Promise.resolve({ ok: false, error: {
      code: 'needs-facade',
      message: 'setControl needs the first-party addCustomControl facade. Deploy the cds-form-designer export with the enableModelMakerBridge gate (Phase 2.3), then open the form with the gate on.',
    } });
  }

  // Place a control as a NEW component in a section (unbound/dataset controls like
  // PowerBI that aren't bound to a field's value). Thin pass-through to the
  // first-party facade window.__formDesignerApi.addComponent.
  function addComponent(controlId, targetSectionId, params, factors) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var w = getWin();
    var fapi = w.__formDesignerApi;
    if (fapi && typeof fapi.addComponent === 'function') {
      return Promise.resolve()
        .then(function () { return fapi.addComponent(controlId, targetSectionId, params || null, factors || null); })
        .then(function (r) {
          if (r && r.ok === false) return r;
          return { ok: true, result: (r && r.result) || { controlId: controlId, targetSectionId: targetSectionId }, source: 'facade' };
        })
        .catch(function (e) { return { ok: false, error: { code: 'facade-error', message: String((e && e.message) || e) } }; });
    }
    return Promise.resolve({ ok: false, error: {
      code: 'needs-facade',
      message: 'addComponent needs the first-party addComponent facade (enableModelMakerBridge build).',
    } });
  }

  // Find the cell currently hosting a field, by walking the form model.
  function findCellForField(fm, fieldName) {
    var found = null;
    try {
      fm.visit(function (n) {
        if (found) return;
        if (n && n.getNodeName && n.getNodeName() === 'cell' && n.control && n.control.dataFieldName === fieldName) found = n;
      });
    } catch (e) { /* tolerate a partial tree */ }
    return found;
  }

  // READ-ONLY: report the control currently bound to a field's cell — the control
  // class id and any applied custom controls (from the form's ControlDescriptions).
  // This is the verify step after setControl (and a useful read on its own): when a
  // custom control is set, classId flips to the CustomControl class id and the
  // custom control name appears here.
  function getControl(fieldName) {
    var h = getDesignerHandle();
    if (!h) return { ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } };
    var fm = h.service.formModel;
    var cell = findCellForField(fm, fieldName);
    if (!cell) return { ok: false, error: { code: 'no-cell', message: fieldName + ' is not placed on the form' } };
    var control = cell.control || {};
    var classId = control.ClassId && (control.ClassId.guidString || control.ClassId.GuidString || String(control.ClassId));
    var customControls = [];
    try {
      var uid = control.UniqueId;
      var desc = (uid != null && typeof fm.getControlDescriptionByForControl === 'function') ? fm.getControlDescriptionByForControl(uid) : null;
      var list = desc && (desc.customControls || desc.CustomControls);
      if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
          var cc = list[i] || {};
          customControls.push({ name: cc.customControlName || cc.name, formFactor: cc.formFactor });
        }
      }
    } catch (e) { /* tolerate models we can't fully read */ }
    var lcid = +((h.service.sessionInfo && h.service.sessionInfo.lCID) || 1033) || 1033;
    var label;
    try { label = typeof cell.getDisplayName === 'function' ? cell.getDisplayName(lcid) : cell.displayName; } catch (e) { /* ignore */ }
    return { ok: true, result: {
      field: fieldName, dataFieldName: control.dataFieldName, classId: classId, customControls: customControls,
      label: label, visible: cell.visible, readonly: cell.readonly, locked: cell.isLocked, showLabel: cell.showlabel,
    } };
  }

  // Remove a field/control from the form. DIRECT designer command — works on ANY
  // build (no facade needed).
  function removeControl(fieldName) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var cell = findCellForField(svc.formModel, fieldName);
    if (!cell) return Promise.resolve({ ok: false, error: { code: 'no-cell', message: fieldName + ' is not placed on the form' } });
    var id = cell.id && (cell.id.guidString || cell.id.GuidString);
    return Promise.resolve()
      .then(function () { return svc.removeElement(id); })
      .then(function () { return { ok: true, result: { field: fieldName, removedCellId: id } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Set common properties on a field's cell (label / visible / readonly / showLabel
  // / locked / availableForPhone). DIRECT (makeFormModelChange + node setters) —
  // works on ANY build.
  function setFieldProps(fieldName, props) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var cell = findCellForField(svc.formModel, fieldName);
    if (!cell) return Promise.resolve({ ok: false, error: { code: 'no-cell', message: fieldName + ' is not placed on the form' } });
    var p = props || {};
    var lcid = +((svc.sessionInfo && svc.sessionInfo.lCID) || 1033) || 1033;
    var applied = {};
    return Promise.resolve()
      .then(function () {
        return svc.makeFormModelChange(function () {
          if ('label' in p && typeof cell.setDisplayName === 'function') { cell.setDisplayName(String(p.label), lcid); applied.label = String(p.label); }
          if ('visible' in p) { cell.visible = !!p.visible; applied.visible = !!p.visible; }
          if ('readonly' in p) { cell.readonly = !!p.readonly; applied.readonly = !!p.readonly; }
          if ('showLabel' in p) { cell.showlabel = !!p.showLabel; applied.showLabel = !!p.showLabel; }
          if ('locked' in p) { cell.isLocked = !!p.locked; applied.locked = !!p.locked; }
          if ('availableForPhone' in p) { cell.availableforphone = !!p.availableForPhone; applied.availableForPhone = !!p.availableForPhone; }
        }, { actionName: 'Change property' }, 'Set field properties');
      })
      .then(function () { return { ok: true, result: { field: fieldName, applied: applied } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Move a field's control to another element (a section, or a cell with a
  // before/after position). DIRECT — works on ANY build.
  function moveControl(fieldName, targetElementId, position) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    if (!targetElementId) return Promise.resolve({ ok: false, error: { code: 'no-target', message: 'targetElementId is required (a section/cell id from form_inspect)' } });
    var cell = findCellForField(svc.formModel, fieldName);
    if (!cell) return Promise.resolve({ ok: false, error: { code: 'no-cell', message: fieldName + ' is not placed on the form' } });
    var id = cell.id && (cell.id.guidString || cell.id.GuidString);
    return Promise.resolve()
      .then(function () { return svc.moveElement(id, targetElementId, 'Click', position || undefined); })
      .then(function () { return { ok: true, result: { field: fieldName, movedTo: targetElementId } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Generic thin pass-through to a facade method that needs in-product model
  // construction. Returns needs-facade on a normal (non-facade) build.
  function facadeCall(method, args, label) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var w = getWin();
    var fapi = w.__formDesignerApi;
    if (fapi && typeof fapi[method] === 'function') {
      return Promise.resolve()
        .then(function () { return fapi[method].apply(fapi, args); })
        .then(function (r) { if (r && r.ok === false) return r; return { ok: true, result: (r && r.result) || {}, source: 'facade' }; })
        .catch(function (e) { return { ok: false, error: { code: 'facade-error', message: String((e && e.message) || e) } }; });
    }
    return Promise.resolve({ ok: false, error: { code: 'needs-facade', message: (label || method) + ' needs the first-party facade (enableModelMakerBridge build).' } });
  }

  // Add a TAB to the form (facade — model construction).
  function addTab(targetTabId, columns, displayName) {
    return facadeCall('addTab', [targetTabId || null, columns || null, displayName || null], 'addTab');
  }

  // Add a SECTION to a tab/section (facade — model construction).
  function addSection(targetElementId, columns, displayName) {
    return facadeCall('addSection', [targetElementId, columns || null, displayName || null], 'addSection');
  }

  // The form's root node (for form-level events like onLoad/onSave).
  function formNode(svc) {
    var fm = svc.formModel;
    if (fm && fm.getNodeName && fm.getNodeName() === 'form') return fm;
    var found = null;
    try { fm.visit(function (n) { if (!found && n && n.getNodeName && n.getNodeName() === 'form') found = n; }); } catch (e) { /* ignore */ }
    return found || fm;
  }

  // Find a section node by its id.
  function findSectionById(fm, sectionId) {
    var found = null;
    try {
      fm.visit(function (n) {
        if (found) return;
        if (n && n.getNodeName && n.getNodeName() === 'section' && n.id && (n.id.guidString === sectionId || n.id.GuidString === sectionId)) found = n;
      });
    } catch (e) { /* ignore */ }
    return found;
  }

  // Set a section's column count (1-4) — the designer's "add/remove column" op.
  // DIRECT (SectionCanvasService.setNewColumnCount via the element-service factory,
  // inside makeFormModelChange); works on any build.
  function addColumn(sectionId, columns) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var count = Math.max(1, Math.min(4, +columns || 1));
    var section = findSectionById(svc.formModel, sectionId);
    if (!section) return Promise.resolve({ ok: false, error: { code: 'no-section', message: sectionId + ' not found on the form' } });
    return Promise.resolve()
      .then(function () {
        return svc.makeFormModelChange(function () {
          var factory = svc.formCanvasService && svc.formCanvasService.formElementServiceFactory;
          var sectionSvc = factory && typeof factory.getFormElementService === 'function' && factory.getFormElementService(section);
          if (sectionSvc && typeof sectionSvc.setNewColumnCount === 'function') {
            sectionSvc.setNewColumnCount(section, count);
          } else {
            throw new Error('section column service unavailable');
          }
        }, { actionName: 'Change property' }, 'Set section columns');
      })
      .then(function () { return { ok: true, result: { sectionId: sectionId, columns: count } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Add a form/control EVENT HANDLER (onLoad/onSave on the form; onChange on a
  // field). DIRECT (FormDesignerService.formEventsService.addEventHandler); works on
  // any build. The referenced `library` (web resource) must already be on the form.
  function addEventHandler(target, options) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var ehs = svc.formEventsService;
    if (!ehs || typeof ehs.addEventHandler !== 'function') {
      return Promise.resolve({ ok: false, error: { code: 'no-events-service', message: 'formEventsService unavailable' } });
    }
    var o = options || {};
    if (!o.library || !o.functionName) {
      return Promise.resolve({ ok: false, error: { code: 'missing-args', message: 'library and functionName are required' } });
    }
    var node;
    if (!target || target === 'form') {
      node = formNode(svc);
    } else {
      node = findCellForField(svc.formModel, target);
      if (!node) return Promise.resolve({ ok: false, error: { code: 'no-cell', message: target + ' is not placed on the form' } });
    }
    var opts = {
      eventType: o.eventType || 'onload',
      library: o.library,
      functionName: o.functionName,
      enabled: o.enabled !== false,
      executionContext: o.passExecutionContext !== false,
      parametersList: o.parameters || '',
    };
    return Promise.resolve()
      .then(function () { return ehs.addEventHandler(opts, node); })
      .then(function () { return { ok: true, result: { target: target || 'form', eventType: opts.eventType, library: opts.library, functionName: opts.functionName } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Set FORM-level properties (name / description / maxWidth / showImage /
  // showNavigation). DIRECT (form node setters in makeFormModelChange); any build.
  function setFormProps(props) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var node = formNode(svc);
    if (!node) return Promise.resolve({ ok: false, error: { code: 'no-form', message: 'form node not found' } });
    var p = props || {};
    var applied = {};
    return Promise.resolve()
      .then(function () {
        return svc.makeFormModelChange(function () {
          if ('name' in p) { node.formName = String(p.name); applied.name = String(p.name); }
          if ('description' in p) { node.description = String(p.description); applied.description = String(p.description); }
          if ('maxWidth' in p) { node.MaxWidth = String(p.maxWidth); applied.maxWidth = String(p.maxWidth); }
          if ('showImage' in p) { node.ShowImagecheck = !!p.showImage; applied.showImage = !!p.showImage; }
          if ('showNavigation' in p) { node.ShowNavigation = !!p.showNavigation; applied.showNavigation = !!p.showNavigation; }
        }, { actionName: 'Change property' }, 'Set form properties');
      })
      .then(function () { return { ok: true, result: { applied: applied } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Remove ANY element by id (tab / section / cell). DIRECT; any build.
  function removeElement(elementId) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    if (!elementId) return Promise.resolve({ ok: false, error: { code: 'no-target', message: 'elementId is required (an id from form_inspect)' } });
    var svc = h.service;
    return Promise.resolve()
      .then(function () { return svc.removeElement(elementId); })
      .then(function () { return { ok: true, result: { removedElementId: elementId } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Undo / redo the last designer change. DIRECT; any build.
  function undoRedo(which) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    var fn = (typeof svc[which] === 'function') ? svc[which].bind(svc)
      : (svc.actionService && typeof svc.actionService[which] === 'function') ? svc.actionService[which].bind(svc.actionService) : null;
    if (!fn) return Promise.resolve({ ok: false, error: { code: 'unsupported', message: which + ' unavailable' } });
    return Promise.resolve().then(function () { return fn(); })
      .then(function () { return { ok: true, result: { action: which } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }
  function undo() { return undoRedo('undo'); }
  function redo() { return undoRedo('redo'); }

  // PERSIST — save / publish. The relay never persists by default; the operator
  // opt-in gate lives in the relay handler (MM_ALLOW_SAVE / MM_ALLOW_PUBLISH).
  function save() {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    if (typeof svc.saveAsync !== 'function') return Promise.resolve({ ok: false, error: { code: 'unsupported', message: 'saveAsync unavailable' } });
    return Promise.resolve().then(function () { return svc.saveAsync(); })
      .then(function (formId) { return { ok: true, result: { saved: true, formId: formId } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }
  function publish() {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var svc = h.service;
    if (typeof svc.publishAsync !== 'function') return Promise.resolve({ ok: false, error: { code: 'unsupported', message: 'publishAsync unavailable' } });
    return Promise.resolve().then(function () { return svc.publishAsync(); })
      .then(function (formId) { return { ok: true, result: { published: true, formId: formId } }; })
      .catch(function (e) { return { ok: false, error: { code: 'designer-error', message: String((e && e.message) || e) } }; });
  }

  // Add a subgrid (related-records grid) to a section. Needs the facade (FormCell +
  // FormGridControl construction). Thin pass-through.
  function addSubgrid(targetSectionId, entity, opts) {
    var h = getDesignerHandle();
    if (!h) return Promise.resolve({ ok: false, error: { code: 'not-loaded', message: 'Form designer not ready' } });
    var w = getWin();
    var fapi = w.__formDesignerApi;
    if (fapi && typeof fapi.addSubgrid === 'function') {
      return Promise.resolve()
        .then(function () { return fapi.addSubgrid(targetSectionId, entity, opts || null); })
        .then(function (r) { if (r && r.ok === false) return r; return { ok: true, result: (r && r.result) || { targetSectionId: targetSectionId, entity: entity }, source: 'facade' }; })
        .catch(function (e) { return { ok: false, error: { code: 'facade-error', message: String((e && e.message) || e) } }; });
    }
    return Promise.resolve({ ok: false, error: { code: 'needs-facade', message: 'addSubgrid needs the first-party addSubgrid facade (enableModelMakerBridge build).' } });
  }

  var api = {
    status: status, inspect: inspect, addField: addField,
    listControls: listControls, describeControl: describeControl,
    setControl: setControl, addComponent: addComponent, addSubgrid: addSubgrid,
    addTab: addTab, addSection: addSection, addColumn: addColumn, addEventHandler: addEventHandler,
    setFormProps: setFormProps, removeElement: removeElement, undo: undo, redo: redo, save: save, publish: publish,
    getControl: getControl, removeControl: removeControl, setFieldProps: setFieldProps, moveControl: moveControl,
  };

  var w = getWin();
  if (w && typeof w === 'object') w.__mmBridge = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    module.exports.__test = { getDesignerHandle: getDesignerHandle, isService: isService, fiberWalk: fiberWalk };
  }
})();
