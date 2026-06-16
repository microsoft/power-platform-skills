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
//   - setControl(field, controlId, p, ff)   -> set a custom control on a field (prefers the first-party facade)
//   - getControl(field)                     -> (READ-ONLY) the control currently on a field's cell (classId + custom controls)
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
    try {
      fm.visit(function (n) {
        if (n && n.getNodeName && n.getNodeName() === 'section' && n.id) {
          sections.push({ id: n.id.guidString });
        }
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

    return { ok: true, result: { formType: fm.formType, sections: sections, available: available } };
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
    return { ok: true, result: { field: fieldName, dataFieldName: control.dataFieldName, classId: classId, customControls: customControls } };
  }

  var api = { status: status, inspect: inspect, addField: addField, listControls: listControls, describeControl: describeControl, setControl: setControl, getControl: getControl };

  var w = getWin();
  if (w && typeof w === 'object') w.__mmBridge = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    module.exports.__test = { getDesignerHandle: getDesignerHandle, isService: isService, fiberWalk: fiberWalk };
  }
})();
