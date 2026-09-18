# Small-change workflow

## Eligibility and safety

**Small-change:** ordinary declarations on one locale, at most 3 components/10 style groups in one section, inline-only/stylesheet-only/inline+CSS, at most one **existing** stylesheet and guarded class additions. Require known Bootstrap and local targets. Any raw `css`, global scope, nonempty `externalResources`/`importantReason`, new/shared files, templates or Studio-only work needs **expanded** review; unresolved/generated-source work blocks.

- **Local-only:** no PAC/authentication, remote writes, deployment/ALM, Sync or cache clearing. VS Code Web saves remotely; Desktop Preview uses uploaded content/clears cache. Neither is allowed.
- **Local-first:** use required `owner: "custom"` for **both listed and unlisted** properties. The [map](studio-component-capabilities.md) describes availability, not ownership. Unlisted properties allow safe local styling with warnings. Unknown components/Flex availability stay unverified; no promise values populate native controls.
- **Placement:** use owning inline declarations, locale CSS or reusable Web Files. Web File priority is advisory, not a `displayorder` or runtime load-order prerequisite; see [policy](styling-policy.md). Page Copy uses the selected locale; shared-template inline edits need site scope. Do not blanket-inline reusable styles.
- **Safety:** preserve defaults/order, Bootstrap, unrelated edits, Liquid, IDs, accessibility/Studio markers. Edit winning inline declarations, not ineffective overrides or blind priority escalation. Preserve exact-property inline importance; authored priority needs `importantReason` and expanded review.
- **Boundaries:** no DOM/component replacement, PCF/iframe/third-party internals, installs, generated-output overwrites or hand-edited plans. Keep artifacts private, **outside the uploadable site tree**, out of telemetry.

## Inspect with bounded evidence

Select the locale; save full evidence with a 4,096-byte summary:

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/inspect-style-context.js" --siteRoot "<siteRoot>" --summary --out "<workDir>/context.json" --pageId "<pageId>" --target ".pp-card"
```

Use `--page "<name-substring>"` for discovery or offline `--pageId`. Inspector targets are literal IDs/classes/tags, not complex selectors; candidates are advisory.

For consented runtime discovery, follow its reference: `--mode structure --maxCandidates 10 --selector "<section>"`, then `--mode styles --properties padding,border-radius --maxCandidates 1`. Reconcile via `--runtimeSnapshot "<snapshot.json>" --pageId "<pageId>"`. No text/values/credentials/storage/HTML capture or crawling.

## Request and prepare

Placeholder: verify source/`pp-card` and effective CSS; Design-panel support is unverified.

```json
{
  "title": "Service card spacing",
  "pageId": "<resolved-localized-page-id>",
  "components": [{
    "id": "service-card",
    "label": "Service card",
    "kind": "card",
    "className": "pp-card",
    "sourcePath": "web-pages\\home\\content-pages\\Home.en-US.webpage.copy.html"
  }],
  "styles": [{
    "id": "card-spacing",
    "componentId": "service-card",
    "owner": "custom",
    "scope": "page",
    "studioComponent": "Custom card",
    "declarations": { "padding": "1rem", "border-radius": "12px" },
    "rationale": "Adjust this locale's custom card."
  }]
}
```

Optional `location`: `stylesheet` (default) or `inline`. General `declarations` use bundled css-tree, not property/value/part or gradient allowlists; no npm installs. Parser acceptance is not rendering proof. Review unknown/semantic-grammar warnings; fix invalid CSS or verify newer browser support, never bypass errors.

Read the [deep contract/examples](proposal-and-verification.md) for raw `css`, `global: true`, resources, priority and inline/context edits. Scoped CSS needs verified hooks; global themes need no fictitious source/class. Inline `null` removes an exact property; combine scoped CSS in the same approved plan. Preserve other source/priority.

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/style-site-workflow.js" --operation prepare --siteRoot "<siteRoot>" --request "<workDir>/request.json" --out "<workDir>/revision-1"
```

Result: `status: "ready-for-review"`, `artifacts: {plan,review}`, `route.name: small-change|expanded`, hash/diff/warnings; no edits. Follow `contrastReview: "required-before-approval"` guidance. **Read full review before approval if truncated** (`truncated=true`). Use a revised request and a fresh directory.

Review targets/diffs, pages/locales, parser/resource warnings and global/priority effects; global means all matching elements in scope. There is **no HTML preview, local server or browser prerequisite**. `owner: "studio"` requires `handoffReason: "user-requested"` plus `studioAction`; native support alone is not a reason. Schema 2 remains; legacy/invalid requests need regeneration/new approval, never inherited consent.

## Apply and independently verify

After host approval of this exact hash:

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/style-site-workflow.js" --operation apply --plan "<workDir>/revision-1/style-site.plan.json" --approvedHash "<approved-planHash>" --receipt "<workDir>/receipt-1.json"
```

Require fresh preflights and independent validator success, not just a receipt. Verify blocks/tags, scope, defaults/markers and unrelated bytes. Drift/partial failure needs `6.reapprove`, recovery evidence and new diff/hash approval; never rollback.

Review source colors/semantics. Report **desktop/mobile rendering**, cascade, reflow, contrast and keyboard/states as pending live checks; never upload for evidence.

Explicit instructions-only: verify instructions/no edits; skip apply. Ambiguous/unrepresentable/generated-source local work is **blocked** with a specific local next step, not handoff success. Keep unlisted/unknown/conditional warnings in review, approval and final report. Liquid/native behavior and Studio save/reopen editability remain pending; earlier observation cannot verify unuploaded changes.
