# Summary

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 17 | Step 13 |

<!-- The step starts here; everything above is about the file. -->

Print a compact status block, then present exactly 6 options with no explanation. Do not add prose, tips, or "you might want to" text — keep it concise.

```
✅ Native code app created
─────────────────────────────────────────────
App name      : <displayName>
Project       : <working_dir>
Environment   : <env name> (<env id>)
Data model    : <N tables — M reuse, K extend, L create>
Native caps   : <list>
Connectors    : <list>
Screens       : <N total — M from template, K built in parallel>
Preview       : <N preview-gate rounds; first preview <N min> after the brief>
Sample data   : <none | entities and device actions still on sample data, by name>
Planning      : metadata <N ms> | local <N ms> | architect <N ms> | screens <N ms>
Approval wait : <N ms> (excluded from agent performance)
Execution     : scaffold <N ms or not recorded> | mutation <N ms or not recorded>
App Insights  : <enabled for selected customer-owned resource | disabled>
Dev server    : Metro running on port <port>
Build plan    : docs/create-app-plan.html
Debug logs    : .powernative/metro-logs/
─────────────────────────────────────────────
```

The Preview and Sample data rows are for the screens-first order; leave them out in the data-model-first order.

Close the build plan before printing the summary:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id run --status done
```

Point the user at `docs/create-app-plan.html` once — it holds the environment, the approved data
model with its ER diagram, and the screen plan, and it outlives the terminal session.

If Step 1 emitted warnings, list them in one line each under the block (no decoration).

Do **not** re-open the `run` phase for these. The build is finished, the plan has settled and
stopped reloading, and marking a phase active again would restart that loop and report work in
progress on a run that is over. These options are a menu, not a gate the run is blocked on.

Then present exactly these 6 options:

```
What now?

1. Preview screens in browser  (/preview-screens)
2. Deploy to tenant            (/deploy)
3. Edit the app                (/edit-app)
4. Add more capabilities       (/add-dataverse, /add-connector, /add-native)
5. Configure auth later        (/set-app-registration-native)
6. Set up Application Insights (/setup-app-insights)

Which option? (or "none — I'll keep iterating locally")
```

**Hard rules for this step:**

- Do NOT add explanatory paragraphs after the options.
- Do NOT recommend an option ("most users want #2").
- Do NOT list alternative `npm` commands — the dev server is already running and is the only local iteration process the user needs to know about.
- Wait for the user's choice before doing anything else. If they pick none, stop.
