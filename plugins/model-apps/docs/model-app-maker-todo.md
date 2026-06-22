# model-app-maker — Deferred / blocked items

Tracking doc for capabilities that are **intentionally deferred** (a real blocker, not just
"not done yet"). The broad backlog lives in [`model-app-maker-roadmap.md`](./model-app-maker-roadmap.md);
this doc captures the *why* for each punt so we don't re-litigate it. Most cluster around two
hard blockers: **(A)** anything needing **Power Fx + a component library** can't be authored
headlessly, and **(B)** **PCF control bindings** need **solution-import** delivery the SDK doesn't
package.

Legend: 🔴 hard-blocked (needs SDK/platform work) · 🟡 buildable but punted (cost/scope) · ⚠ org-gated.

---

## 🔴 PCF custom-control bindings — blocked on import-delivery packaging
**What:** bind a PCF code component to a form field (`addCustomControl(formId, { fieldName, controlName, … })`).
**Why deferred:** the SDK produces correct formxml (a `<controlDescriptions>` block keyed to the
control `uniqueid`), but a plain `pushArtifact` (systemforms Web API write) **strips the `uniqueid`**,
orphaning the binding so the server drops it. It persists **only via solution import**. To deliver it
the plugin would have to: `exportSolution` → **unzip** → patch the form's formxml in `customizations.xml`
with the binding-carrying `$meta.formxml` → **rezip** → `importSolution`. The SDK exposes no
artifact→zip packaging (export only returns the *live*, already-stripped solution), so this needs a
**new zip dependency + fragile XML surgery**, and it also needs a **pre-deployed PCF control** to bind
to (the SDK binds, it doesn't create the component). Not live-verifiable from the current setup.
**Unblock:** an SDK helper that packages a form artifact (with its `$meta.formxml`) into an importable
solution zip — then the plugin calls build-form → addCustomControl → packageAndImport. (SDK `a2550ee`
verified the formxml/import manually on a live org; there's no reproducible automated flow yet.)

## 🔴 Conditional (rule-based) command visibility — Power Fx only
**What:** show/hide or enable/disable a command-bar button based on a rule (e.g. "hide unless status = Open").
**Why deferred:** modern commands express conditional visibility **only** as Power Fx
(`visibilitytype = Formula` + a component-library bind + formula component/function names). The
component library can't be authored headlessly (blocker A). Classic JS enable-rules are `RibbonDiffXml`
(separate, also deferred). **Static** `hidden`/`disabled` *is* shipped (see commands).
**Unblock:** headless component-library authoring, or a classic RibbonDiffXml writer.

## 🔴 Power Fx command on-click — Power Fx only
**What:** a button whose on-click is a Power Fx formula (vs the shipped JavaScript on-click).
**Why deferred:** same component-library blocker (A). JavaScript on-click **is** shipped.

## ⚠ Business-rule validation — org-gated + Power Fx
**What:** form/field business rules (`businessRules[]`).
**Why deferred:** the SDK's business-rule writes are org-blocked on the Aurora test orgs (they lack the
`*ProcessWithWfomJson` action), so it can't be live-verified here; the modern authoring path is also
Power-Fx-flavored. Distinct from command visibility (this is field-level *form* logic). Build behind a
capability flag once an org supports it.

## 🟡 Quick-view form placement — no SDK helper
**What:** place a created `QuickView` form onto a parent form via a lookup (a quick-view control).
**Why deferred:** `formType: "QuickView"` **creates** the form, but there's no `addQuickViewControl`
helper to drop it on a parent form (unlike `addSubGrid`). Lint warns. **Unblock:** an SDK quick-view
placement helper, or a `$meta.formxml` injector (like `addCustomControl`/`addFormEventHandler`).

## 🟡 Dashboard sitemap placement — not auto-wired
**What:** make a built dashboard land in the app's sitemap/nav.
**Why deferred:** the dashboard is created + added to the solution, but `AddAppComponents` wiring for a
dashboard isn't done, so it isn't surfaced in the app automatically. **Unblock:** add the dashboard
(component type 60) to the app components + a sitemap subarea in the app-shell phase.

## 🟡 Interactive (type 10) dashboards
**What:** interactive/streams dashboards.
**Why deferred:** different formxml machinery (streams/tiles keyed by cell id in `icProperties`); the
SDK parses them best-effort and relies on `$meta.formxml` pass-through. The tile generator targets
Standard (type 0) dashboards. **Unblock:** an interactive-dashboard tile generator.

## 🟡 Command grouping (titled groups)
**What:** group command buttons under a titled group on the bar.
**Why deferred:** a titled group is a separate appaction that needs a parent command-bar row the
adapter doesn't synthesize for from-scratch commands (Dataverse 400 "Group button must have
parentappactionid"). Buttons currently emit as **loose controls** (empty-title group), which works.
**Unblock:** SDK synthesis of the parent command-bar/group rows.

## ⚠ Calculated / Rollup formula columns — not live-verified
**What:** `source: "Calculated" | "Rollup"` + `formula`.
**Why deferred:** plumbed through `columnOptions` but never live-verified end-to-end. **Unblock:** a
live shakeout (define a rollup/calculated column, confirm it computes).

---

## Larger roadmap items (not blocked — see roadmap for detail)
Edit flow (spec-diff), first-class teardown command, quick-create/quick-view richer layouts, standard
system views, multi-area sitemaps, security roles, solution export/import hand-off. These are scoped in
[`model-app-maker-roadmap.md`](./model-app-maker-roadmap.md) — they're sequencing decisions, not blockers.
