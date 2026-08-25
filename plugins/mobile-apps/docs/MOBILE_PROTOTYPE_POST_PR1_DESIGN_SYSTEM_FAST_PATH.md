# Mobile Prototype Design-System Fast Path

Status: implemented after the prototype planner contraction

## Purpose

Prompt-only `/create-mobile-prototype` runs convert the approved PR1 design
intent into native design foundations without pausing for brand input, a style
or cost picker, Figma, screenshot matching, a gallery, or HTML preview.
Explicitly requested optional design modes remain available through
`/design-system` and load their references only after selection.

## Ownership

The semantic planner owns visual character, rationale, content tone,
hierarchy, palette, typography families, density, shape, media treatment,
state treatment, motion, accessibility intent, hard negatives, and the
experience-specific signature component contracts.

Deterministic code owns schema validation, source hashes and JSON-pointer
bindings, semantic token names, component/import paths, recipe and registry
shape, source generation, contrast and structural checks, output ownership,
and transactional writes. A missing AI-owned decision is an error; the
compiler does not substitute a generic visual direction.

## Inputs

The automatic compiler consumes only approved local machine contracts:

- `.tmp/prototype-semantic-plan.json`
- `.tmp/experience-contract.json`
- `.tmp/experience-screen-contract.json`
- `.tmp/experience-foundation-contract.json`
- `.tmp/navigation-contract.json`
- `.tmp/prototype-domain-model.json`
- the approved Context, Journey, and Execution contracts

The final Navigation Contract owns architecture. The design recipe styles its
destinations, flows, headers, persistent navigation, sticky actions, keyboard
behavior, and safe-area behavior without changing route ownership.

## Outputs

`compile-native-prototype-design.js` writes one atomic, owned artifact set:

- `brand/design-recipe.json`
- `brand/design-system.md`
- `brand/tokens.ts`
- `brand/signature-components.json`
- `src/components/experience/*.tsx`
- `src/components/experience/index.ts`
- the owned customization block in `tamagui.config.ts`
- `.mobile-app/prototype-design-manifest.json`

Identical validated inputs produce byte-identical recipe, token, registry,
component, and platform-mapping files. The compiler hashes the stable Tamagui
scaffold around its customization block and refuses to overwrite a modified or
unowned design output.

## Validation And Build-Pack Gate

Run the design phase with:

```bash
node scripts/compile-native-prototype-design.js --project-root <project>
node scripts/validate-native-prototype-design.js --project-root <project>
```

The validator writes `.tmp/prototype-design-validation.json` and reports
JSON-pointer paths for source or target drift. It checks the strict recipe,
PR1 design preservation, first-viewport budgets, semantic token completeness,
contrast, signature components, media/offline policy, Navigation chrome, and
accessibility intent.

For PR1 prototypes, `compile-screen-build-pack.js` requires a current successful
design-validation receipt as well as the existing generated-domain manifest.
The pack embeds the compact recipe, token bindings, signature registry,
Foundation registry, and fail-closed escape policy. After compilation, run:

```bash
node scripts/validate-screen-build-pack.js --project-root <project>
node scripts/validate-native-prototype-design.js \
  --project-root <project> --require-build-pack
```

## Golden Coverage

The Flight Shop and fictional field-receiving fixtures compile through the
same generic path. Tests require different palettes, heading families, screen
composition patterns, signature registries, and nested-navigation treatments.
The field workflow uses local-first media; the commerce workflow uses cached
remote media with local fallback.

## Local Prototype Host Workaround

`configure-prototype-runtime.js` keeps `PowerAppsProvider` mounted but passes a
copy of `powerConfig` with an empty `environmentId` only while
`dataMode === 'prototype'`. This prevents the current host from treating a
zero-GUID local prototype as auth-required. Dataverse mode receives the
original `powerConfig` object unchanged. This is intentionally a local
one-line workaround, not a generic authentication architecture.