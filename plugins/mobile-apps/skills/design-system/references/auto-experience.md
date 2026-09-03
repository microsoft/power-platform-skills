# Automatic Experience Materialization

Use this workflow for orchestrated `--auto-experience` and explicit
`--fast-experience`. It is the compact normal prototype path: approved recipe to
tokens to signature components to journey preview, without another design
question.

## Read boundary

Read only:

1. this file;
2. [`design-system-schema.md`](./design-system-schema.md);
3. [`final-experience-preview.md`](./final-experience-preview.md);
4. `native-app-plan.md` Product Experience, Product Scope, and Screens;
5. the approved canonical contracts under `.tmp/`:
   `product-experience-contract.json`, `product-scope-contract.json`,
   `workflow-journey-contract.json`, `navigation-manifest.json`,
   `compiled-screen-build-pack.json`, and `scenario-facts.json` when present;
6. existing `brand/design-system.md` and `brand/tokens.ts` only for drift
   detection in an existing project.

Do not read input modes, style galleries, named directions, brand examples,
Figma, extraction, reskin, migration, or history references. Do not infer an
industry or choose a named style from product keywords.

Test fixtures, snapshots, and benchmark implementations are prohibited
authoring inputs. Generate the experience only from the current run's contracts
and approved design references. Do not read an existing or previously generated
preview before authoring the current `_plan_preview.html`.

## Preconditions

Require current, hash-bound Product Experience, Product Scope, Workflow Journey,
navigation manifest, and compiled screen build pack artifacts. Require scenario
facts when the compiled packs bind scenario IDs or media keys. Missing or stale
contracts are `BLOCKED`; return to the owning planning step rather than inventing
replacement facts.

The approved contracts own product scope, behavior, navigation, data meaning,
identity, and media meaning. This workflow owns presentation decisions only.

## Materialize the recipe

Derive one coherent recipe from the approved contracts. Preserve every approved
design dimension:

- hierarchy and first-viewport order;
- content emphasis and primary-action prominence;
- media role, crop, fallback, and decision-support intent;
- visual character, palette, typography, density, spacing, shape, and motion;
- signature experience and per-screen signature interactions;
- trust signals, destructive-action treatment, and status semantics;
- accessibility, Dynamic Type, contrast, touch targets, screen-reader labels,
  keyboard behavior, safe areas, and reduced motion.

Resolve those dimensions deliberately even when no brand input exists. Neutral
tokens are not permission to emit generic CRUD composition. Never silently fall
back to an inspection preset or duplicate one card layout across every screen.

## Write required artifacts

Follow [`design-system-schema.md`](./design-system-schema.md) and write:

- `brand/design-system.md`: complete palette, status colors, typography,
  spacing, density, component recipes, motion, imagery, accessibility, hard
  negatives, first-viewport behavior, and provenance;
- `brand/tokens.ts`: importable Tamagui tokens corresponding exactly to the
  design spec;
- `brand/signature-components.ts`: typed, token-driven presentation interfaces
  for every approved signature interaction reused by compiled packs.

Signature component contracts include props, visual states, accessibility,
media treatment, and forbidden fallback. Domain operations stay in the compiled
screen contract. Do not add screens, routes, tables, jobs, or capabilities.

Record the Product Experience revision, compiled-pack revision, explicit brand
input revision when one was supplied upstream, generator version, and
`product-experience-derived` direction. Do not write secrets or customer data.

Snapshot an existing design spec before replacing it:

```bash
mkdir -p brand/.history
cp brand/design-system.md "brand/.history/$(date -u +%Y-%m-%dT%H-%M-%SZ)-auto.md" 2>/dev/null || true
```

## Author the approval preview

After all three brand artifacts are complete, read and execute
[`final-experience-preview.md`](./final-experience-preview.md) in this same model
invocation. Prepare the deterministic manifest, then author the final
`_plan_preview.html` from the generated design system and canonical authorities,
and run its validator. Do not invoke another model or use the deterministic
structural renderer as a final-design substitute.

Use only the two validator commands and canonical sidecar in
`final-experience-preview.md`; no `npm install`, TypeScript, or ad hoc check.
Its one to three frames and compact collapsed `All screens` never claim React
Native or native pixels were rendered. Never start Metro or native capture.

## Persist and return

Append a compact entry to `memory-bank.md` with timestamp, derived direction,
artifact paths, and `visual_companion`. In orchestrator mode return:

```text
DONE
brand_path: brand/design-system.md
tokens_path: brand/tokens.ts
signature_components_path: brand/signature-components.ts
experience_preview_path: _plan_preview.html
direction: product-experience-derived
visual_personality: <approved value>
visual_companion: <yes|no|skip>
```

Do not return `DONE` unless all three brand artifacts, the canonical final-
preview contract sidecar, and the model-authored journey preview exist and the
final `validate-product-experience-preview.js` JSON returns literal `"ok":
true`. Gate 3 in `/create-mobile-app` owns approval; this path asks no additional
design or preview question.