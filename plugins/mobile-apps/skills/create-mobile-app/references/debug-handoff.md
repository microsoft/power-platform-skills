# Optional debug handoff

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 16.5 | Step 12.5 |
| the dev-server step | Step 16 | Step 12 |
| the Summary step | Step 17 | Step 13 |

<!-- The step starts here; everything above is about the file. -->

Do not perform screen-by-screen runtime verification: runtime verification on the device belongs to the user, who now has the real app in hand, and in the screens-first order the web preview already covered screen-by-screen review on sample data. Do not crawl routes, open browser targets, use React Native Web, or call Metro HTTP endpoints directly.

After Metro is running and the QR has been presented, offer a single optional debug handoff:

> "If the app shows an error or a workflow looks wrong after you load it in the native dev client, tell me the symptom and I can run `/debug-app "<symptom>"` using the project-local Metro log."

After a successful launch, only invoke `/debug-app` if the user asks for debugging
or gives a concrete symptom (including QR/device-opening failure). the dev-server step's
approved startup-only failure handoff is separate and never starts indefinite
monitoring. `/debug-app` uses `.powernative/metro-logs/` for runtime diagnosis;
it must not request a bundle URL or run any React Native Web setup. If the user
gives no symptom, proceed directly to the Summary step.

When the user is ready to deploy:

```
/deploy            # runs npm run build + pa app push
```
