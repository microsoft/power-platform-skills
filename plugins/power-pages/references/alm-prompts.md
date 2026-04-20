# ALM prompts — what they mean and how to respond

As of the 2026-04 plugin release, several Power Pages skills ask ALM-related questions that weren't in earlier versions. These prompts prevent a recurring class of bugs where Dataverse records created by one skill (an env var, a server logic record, a cloud flow binding) silently landed in the `Default` solution and were never promoted to staging or production.

This page explains each prompt, why it exists, and what to pick.

---

## 1. "Existing solution manifest found. Sync mode?" — `/power-pages:setup-solution`

**What you'll see**

```
Found existing solution "ContosoSite" v1.0.0.2. Running in sync mode — I'll
discover the current site inventory, diff against what's already in the
solution, and only add missing components.
```

**What happened** — the skill noticed a `.solution-manifest.json` in your project root, so it's skipping the "create publisher + solution" flow. Sync mode adopts any components added to the site after the solution was first created — for example, a server logic added via `/power-pages:add-server-logic` after your initial setup.

**What to do** — nothing. Sync mode is the recommended path when you've added components since your last setup run. If you actually meant to start fresh (different publisher, different solution), rename or delete the existing manifest first.

**When you'd see this most often** — your second, third, …, Nth run of `setup-solution` on the same project. First-time users get the full fresh setup.

---

## 2. "Adopt orphaned env var definitions?" — `/power-pages:setup-solution` Step 5.4b

**What you'll see**

```
We found env var definitions with your publisher prefix (crd50_) that aren't
in ContosoSite yet. Select the ones you want to include.

1. crd50_auth_openauth_microsoft_clientsecret (Microsoft OAuth Client Secret)
   — type Secret, currently in: DEFAULT-ONLY
2. crd50_FeatureFlag (Feature Flag)
   — type String, currently in: IN OTHER SOLUTION: AuthConfig
```

**What happened** — the skill ran a publisher-scoped search and found env vars that exist in Dataverse but live only in the `Default` solution (or in a different user solution). `DEFAULT-ONLY` orphans are almost always a side effect of another skill (like `setup-auth` generating an OAuth secret) — they should usually be adopted so they travel with your deployment.

**How to decide**

| Tag on entry | What it means | Usual choice |
|---|---|---|
| `DEFAULT-ONLY` | Created by some skill, never added to any user solution | **Include** — otherwise it won't travel to staging/prod |
| `IN OTHER SOLUTION: <name>` | Already owned by a different user solution you created | **Skip** — adding it here duplicates ownership |

**What if I skip?** — secrets still exist in the current environment, but they won't export with your solution. Target environments will show "environment variable definition missing" errors for any code that references the var.

---

## 3. "The solution is missing N components — proceed anyway?" — `/power-pages:export-solution` Phase 2.5 and `/power-pages:deploy-pipeline` Phase 3.5

**What you'll see**

```
The source solution appears incomplete relative to the live site. What
would you like to do?

 1. Run /power-pages:setup-solution now (sync mode) — adopts missing
    components and bumps the version, then resume this export (Recommended)
 2. Export as-is — the missing components will not reach the target
 3. Cancel — I'll investigate first
```

**What happened** — before shipping, the skill compared your site's actual components to what's in the solution and found drift. The most common causes:

- A cloud flow was added via Power Automate UI and never registered to the solution.
- A server logic was added with `/power-pages:add-server-logic` but setup-solution hasn't been re-run since.
- A bot was published to the site and the bot consumer record wasn't added to the solution.
- An env var definition was created in isolation and the solution import step missed it.

**How to decide**

| Option | Pick it when | Result |
|---|---|---|
| **Run sync mode now (Recommended)** | You expected this component to travel. Almost always. | Sync runs, version bumps, your export/deploy resumes. |
| **Export as-is** | You have a specific reason (staging-only test, known-deferred component) | The gap is recorded in `.last-deploy.json` under `knownGaps` for audit. |
| **Cancel** | You're not sure what's happening | Nothing changes. Investigate, then re-run. |

**What if I pick "Export as-is"?** — the component stays in your source environment but is never added to the export zip. Target environments won't have it until a later deploy brings it along.

---

## 4. "env var created but no target solution resolved" — background warning from `create-environment-variable.js`

**What you'll see (on stderr)**

```
Warning: env var "crd50_ApiSecret" was created but no target solution was resolved.
It currently lives only in the Default solution. Pass --solutionUniqueName
or run /power-pages:setup-solution to capture it.
```

**What happened** — a skill (or you directly) invoked `create-environment-variable.js` without a `--solutionUniqueName` argument AND there was no `.solution-manifest.json` in the working directory. The env var definition still succeeded in Dataverse, but it's orphaned.

**What to do**

1. Run `/power-pages:setup-solution` in the affected project — sync mode will find and adopt the new env var.
2. Or re-invoke the creating skill from a directory that has a `.solution-manifest.json`.
3. Or, for a one-off, pass `--solutionUniqueName ContosoSite` explicitly.

This is a warning, not an error — the skill that called the script still succeeds. The warning exists so you notice the gap before it bites you during promotion.

---

## FAQ

**Q: Can I disable these prompts?**
Not globally — they gate against a real class of production bugs. But individual skills that are intentionally exempt (e.g. a read-only diagnostic skill) can be allowlisted in `plugins/power-pages/.almlintignore`. Ask in your team review if a blanket exemption is needed.

**Q: Will I see these on first-time setup?**
No. Fresh projects skip the sync-mode prompt, and the orphan-adoption step only triggers when it finds orphans. Completeness checks in export/deploy only ask when there's actual drift.

**Q: How do I test that a component will travel correctly?**
Run `/power-pages:export-solution` in a scratch output directory and inspect the zip. The solution.xml manifest lists everything included — if a component you expected to see is missing, sync mode is the fix.

**Q: The pre-deploy completeness check caught something — should I always run sync mode?**
Yes, unless you have a specific reason to defer. Sync mode is the idempotent "bring solution into alignment with the site" operation.

---

## Skill developers: see PLUGIN_DEVELOPMENT_GUIDE.md

If you're building a new Power Pages skill, these prompts come from rules enforced by `scripts/lint-skills-alm.js`. See `PLUGIN_DEVELOPMENT_GUIDE.md` → "ALM Checklist for New Skills" and `AGENTS.md` → "ALM-aware by default" for the developer-facing rules.
