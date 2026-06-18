---
name: model-app-maker
version: 0.1.0
description: Builds a model-driven Power Apps APP from a natural-language intent — proposes a structured App Spec, confirms it with you, then provisions tables, columns, a main form, a view, and the app module + sitemap into a solution. Use when the user says "build an app for X", "create a model-driven app", or "make me an app to manage Y". For generative PAGES use /genpage; for editing one existing form use the model-maker relay.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
---

# model-app-maker — intent → model-driven app

Turn a natural-language request into a runnable model-driven app. This skill is a
thin loop around the deterministic builder (`scripts/build-model-app.js`); it does
NOT hand-write metadata or XML — tables/columns/relationships go through the
plugin's `dv-*` scripts, and forms/views/sitemap XML is produced headlessly by the
vendored `cds-maker-kernel` bundle.

## Workflow

1. **Confirm the target environment** (org URL) — the mandatory multi-env safety
   check. Never provision without it.
2. **Confirm auth:** `node scripts/check-auth.js <envUrl>` → expect `ok:true` and
   `identitiesMatch:true`.
3. **Propose an App Spec.** From the user's prompt, draft a structured App Spec
   (see `samples/app-spec.project-tracker.json` for the exact shape): `solution`,
   `app`, `entities` (with `columns` + `type`), `relationships`, `forms`, `views`,
   `appShell`. Column `type` is one of Text / Memo / Choice / Boolean / Money /
   DateTime / Integer / Decimal / Lookup (Choice needs `options[]`). Keep the MVP
   to ONE entity unless the user asks for more. Write it to a scratch JSON file.
4. **Review gate.** Show the App Spec and the build **plan**:
   `node scripts/build-model-app.js --env <url> --spec @spec.json` (no `--apply` =
   dry-run; it prints the ordered plan and writes nothing). Let the user edit the
   spec. **Nothing is written to Dataverse until they confirm.**
5. **Build.** `node scripts/build-model-app.js --env <url> --spec @spec.json --apply`
   (add `--publish` to publish customizations, `--preview` to open the app/form in
   the relay). The builder is deterministic and scopes everything to a dedicated
   unmanaged solution.
6. **Verify.** Open the app; iterate on the spec and re-run.

## What the builder does (in order)

solution → tables + columns (`dv-*` scripts) → relationships → main form
(kernel `buildForm` → PATCH the system-generated form) → view (kernel `buildView`
→ create `savedquery`) → app module + sitemap (kernel `buildSitemap` →
`appmodule` / `sitemap` / `AddAppComponents`) → publish (opt-in).

## Notes & limits

- **Dedicated unmanaged solution per app** (review / teardown). **Publish and
  preview are opt-in** (`--publish` / `--preview`); the builder never publishes by
  accident.
- **Creates, does not update.** Updating an existing app (diffing a spec against a
  deployed app) is a later increment; a name/schema collision stops with a clear
  message.
- The kernel produces designer-fidelity FormXML by reusing the form designer's own
  serializer headlessly — no browser needed for the build. The relay is only the
  optional `--preview`.
- Not in scope (later phases): quick-create / quick-view forms, lookup/associated
  views, multi-area sitemaps, security roles, charts, business rules.
