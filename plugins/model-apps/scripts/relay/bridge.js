// model-maker relay — injected bridge.
//
// This file is injected into the live model-driven FORM designer page (the relay
// reads it as text and runs it via Playwright `page.evaluate`). It exposes a tiny
// synchronous-ish command surface on `window.__mmBridge` that the relay drives:
//   - status()                              -> readiness + how the handle was acquired
//   - inspect()                             -> live form: sections (+ ids) and available unused fields
//   - addField(fieldName, sectionId, force) -> add a table field to a section via the designer's own command
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

  var api = { status: status, inspect: inspect, addField: addField };

  var w = getWin();
  if (w && typeof w === 'object') w.__mmBridge = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    module.exports.__test = { getDesignerHandle: getDesignerHandle, isService: isService, fiberWalk: fiberWalk };
  }
})();
