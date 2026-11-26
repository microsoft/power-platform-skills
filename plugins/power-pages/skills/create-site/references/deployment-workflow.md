## Phase 8: Deployment & Next Steps

**Goal**: Deploy the site and suggest enhancements

> **This phase is MANDATORY. Do NOT end the session without asking about deployment.**

<!-- gate: create-site:8.deploy | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:8.deploy):** Deploy prompt — invokes `/deploy-site` on Yes. Skipping leaves the site files on disk for the user to deploy later. Fires at step 3 of the action list below.
>
> **Trigger:** Phase 8 entry; Phase 7 review approved.
> **Why we ask:** Auto-deploy picks whatever env PAC CLI happens to be pointing at — wrong-env first deploy is messy to undo.
> **Cancel leaves:** Nothing — site files stay on disk; no deploy fired.

**Actions**:

1. Record skill usage:

   > Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

   Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "CreateSite"`. Note: `.powerpages-site` may not exist for first-time sites — the script exits silently.

2. Search `src` for `SAMPLE CONTENT` markers again. If any remain, list each with its file before asking, say that they are invented placeholders to replace before a public launch, include the count in the question, and make **Skip for now** the recommended option.
3. Offer **Deploy now (Recommended)** and **Skip for now**, or recommend **Skip for now** when sample content remains.

   Ask the user:
   > "Would you like to deploy your site to Power Pages now?" (when sample content remains: "Would you like to deploy your site to Power Pages now? It still contains <N> sample-content placeholders listed above.")
4. If the user chooses to deploy, invoke the `/deploy-site` skill.
5. Mark all todos complete
6. Present a final summary:
   - Site name and purpose
   - Site content language and the fact that Dataverse/Power Pages system
     messages remain English
   - Framework and project location
   - Components created (X pages, Y components, Z design elements)
   - Key files and their purposes
   - Total file count and git commit count
   - Sample content to replace before launch - every `SAMPLE CONTENT` marker with its file, or "None"
   - Final bidirectional readiness status, static/rendered finding totals, and
     rendered evidence path
   - Every maker-approved limitation with exact impact and evidence
   - When localization is configured, available and unavailable locales from
     the final manifest; never describe an unavailable locale as enabled
7. Suggest optional enhancement skills:
   - `/setup-datamodel` — Create Dataverse tables for dynamic content
   - `/add-localization` — Add or extend SPA languages (suggest only when
     `LOCALIZATION_REQUESTED=false` and the centralized availability result
     contains at least one available mode)
   - `/add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon
   - `/add-tests` — Add unit tests (Vitest) and E2E tests (Playwright)
   - `/add-ai-webapi` — Add generative-AI summaries (Search Summary and Data Summarization). **Recommend first when `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty** — the pages already carry `POWERPAGES:AI-SLOT` comment markers at the intended insertion points, so the follow-up skill's explore step finds them deterministically and the user gets the AI surface they picked during discovery without any page redesign.
8. Run the `create_site_from_scratch` telemetry command silently (fail-closed). Do not mention this telemetry command to the user and do not print its output:
   ```bash
   node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
    --eventName create_site_from_scratch \
    --framework "<framework>" \
    --audience "<audience>"
   ```

**Output**: Deployed (or deployment-ready) site with clear next steps

---
