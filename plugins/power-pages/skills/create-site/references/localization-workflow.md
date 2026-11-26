### 5.8 Offer Additional Languages

Query the centralized add-localization availability before offering the child
workflow:

```bash
node "${PLUGIN_ROOT}/scripts/lib/localization-config.js" mode-availability --framework "<react|vue|angular|astro>"
```

If `availableModes` is empty, explain that localization is temporarily
unavailable for the selected framework using the returned reason, set
`LOCALIZATION_REQUESTED=false`, and do not ask the additional-languages
question. This currently applies to Astro. Do not hardcode a separate
framework availability list in create-site.

Ask whether more languages should be added now:

> **Would you like to add more languages now?**
> The site is currently single-language in `<SITE_LANGUAGE>`. This adds SPA localization only; Dataverse and Power Pages system messages remain English.

<!-- not-a-gate: this selects whether to enter the child workflow, whose Phase 3 gate approves every localization write -->

Ask the user:

Keep the following wording and options unchanged.

| Question | Header | Options |
|----------|--------|---------|
| Would you like to add more languages now?<br><br>The site is currently single-language in `<SITE_LANGUAGE>`. This adds SPA localization only; Dataverse and Power Pages system messages remain English. | Additional languages | Yes — add more languages now, No — keep the site in `<SITE_LANGUAGE>` only |

Record the answer as `LOCALIZATION_REQUESTED=true|false`. Ask at this point even
when the user's current request mentioned localization, so the maker's answer immediately
determines whether the child workflow starts.

When `LOCALIZATION_REQUESTED=true`, invoke:

```text
/power-pages:add-localization <PROJECT_ROOT> [FROM_CREATE_SITE]
```

Wait for the skill to complete before accessibility verification. The child
skill owns locale/package questions, translation generation, selector wiring,
its implementation review, build, and localization checks. The
`[FROM_CREATE_SITE]` context prevents a duplicate deployment prompt; control
returns here so create-site can run accessibility verification, final review,
and its existing deployment prompt.

When `LOCALIZATION_REQUESTED=false`, skip the child workflow.

### 5.9 Validate the Approved Site Language

Run the create-site validator explicitly with the approved language context.
Use only the canonical `SITE_LOCALE` returned by `resolve-locale` and the
validated `SITE_DIRECTION` enum; never pass the maker's original free-text
answer. Run the command with its working directory set to `PROJECT_ROOT`:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" \
  --expectedLocale "<SITE_LOCALE>" \
  --expectedDirection "<SITE_DIRECTION>"
```

Treat exit code `2` as blocking. Repair the reported document or
localization-default mismatch and rerun the command until it passes. The
automatic skill validator runs without these arguments and still checks that
the detected document or localization context is internally valid. The
explicit invocation verifies that it also matches the locale and direction
approved in this create-site session without temporary or persistent metadata.

> **GATE: Do NOT proceed to Phase 6 until the Phase 5.7 design critique is complete, any requested localization has completed, and the approved site language validation passes. The finished design must use script-capable typography and logical direction-neutral layout.**

**Output**: All pages, components, design elements, and requested localization implemented and verified

---
