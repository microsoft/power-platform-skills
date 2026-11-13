# Verify Flow (optional Phase 7)

After Phase 6 deployment, the orchestrator asks the user whether to verify in
the browser via Playwright. **This file is only loaded when the user opts in.**
If they skip, the orchestrator goes straight to Phase 8.

## 7.1 Navigate and Authenticate

Construct the URL from the environment base URL, app-id, and page-id returned by upload:

```
https://<env>.crm.dynamics.com/main.aspx?appid=<app-id>&pagetype=genux&id=<page-id>
```

1. Use `browser_navigate` to open the constructed URL.
2. If you get a "page closed" or "browser closed" error, retry navigation once.
3. Use `browser_snapshot` to capture the page state. Always snapshot before any clicks.
4. If a sign-in page appears, use `browser_click` on the sign-in option, then `browser_wait_for`.
5. Use `browser_wait_for` for the genux page content to render.

## 7.2 Structural Verification (Including Below-the-Fold Content)

Take an initial `browser_snapshot` to capture above-the-fold content.

The host gives the page a fixed-height container, and nothing above the page
scrolls: the window stays at the top, so `window.scrollTo` moves nothing. A page
shows content below the fold only by scrolling an element of its own
(`references/rules.md`, **Page Layout**). A `browser_snapshot` is not proof that
content can be seen: it lists elements that are cut off as well.

**Find the page's scroller.** It is an element that scrolls (`overflow-y` is
`auto` or `scroll`) and holds more than it shows. The script marks the largest
one and lists up to three:

```javascript
browser_evaluate(() => {
  const pick = 0; // the index of the entry that holds the page's content
  const found = [...document.querySelectorAll('body *')]
    .filter((el) => /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)
      && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  document.querySelectorAll('[data-verify-scroller]').forEach((el) => el.removeAttribute('data-verify-scroller'));
  if (found[pick]) found[pick].setAttribute('data-verify-scroller', '');
  return found.slice(0, 3).map((el) => ({ tag: el.tagName, scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight, text: el.innerText.slice(0, 60) }));
})
```

Check that the marked entry (`pick`) shows the page's own text, not the app's
navigation. If another entry does, run the script again with `pick` set to its
index.

**If no entry holds the page's content, check whether the page is cut off:**

```javascript
browser_evaluate(() => [...document.querySelectorAll('body *')]
  .filter((el) => { const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > window.innerHeight + 1
      && getComputedStyle(el).visibility !== 'hidden'; })
  .slice(0, 5).map((el) => ({ tag: el.tagName, bottom: el.getBoundingClientRect().bottom,
    text: (el.innerText || '').slice(0, 60) })))
```

An empty list means the whole page fits on the screen. Any entry is content
below the visible area that nothing can scroll to: the page has no scroll
context. Fix it in 7.5.

**If the page has a scroller, scroll it to the end and prove the last content
is visible:**

```javascript
browser_evaluate(() => {
  const el = document.querySelector('[data-verify-scroller]');
  el.scrollTop = el.scrollHeight;
  const scrolls = (a) => /^(auto|scroll|overlay)$/.test(getComputedStyle(a).overflowY);
  // Content inside a scroll region of its own (a list in a panel) is checked in the next step.
  const own = (d) => { for (let a = d.parentElement; a && a !== el; a = a.parentElement) if (scrolls(a)) return false; return true; };
  // The lowest visible point: the scroller and each ancestor that clips cut off what is below them.
  let visibleBottom = window.innerHeight;
  for (let a = el; a && a !== document.documentElement; a = a.parentElement)
    if (a === el || getComputedStyle(a).overflowY !== 'visible')
      visibleBottom = Math.min(visibleBottom, a.getBoundingClientRect().bottom);
  const lastContentBottom = Math.max(...[...el.querySelectorAll('*')].filter(own)
    .map((d) => d.getBoundingClientRect()).filter((r) => r.width > 1 && r.height > 1)
    .map((r) => r.bottom));
  const regions = [...el.querySelectorAll('*')]
    .filter((d) => scrolls(d) && d.clientHeight > 0 && d.scrollHeight > d.clientHeight + 1).length;
  return { atEnd: Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight,
    lastContentBottom, visibleBottom, lastContentVisible: lastContentBottom <= visibleBottom + 1, regions };
})
```

`lastContentVisible` must be `true`. If it is `false`, the end of the page is cut
off even at the end of the scroll. Usually the scroller is taller than the
host's container because its padding is added to `height: "100%"`. Fix it in 7.5.

**If `regions` is more than 0, check each scroll region inside the scroller the
same way.** A region of its own (a list in a fixed-height panel) is not a defect
of the page's layout until its own end is proven cut off, so scroll each one to
its end too:

```javascript
browser_evaluate(() => {
  const root = document.querySelector('[data-verify-scroller]');
  const scrolls = (a) => /^(auto|scroll|overlay)$/.test(getComputedStyle(a).overflowY);
  const regions = [...root.querySelectorAll('*')]
    .filter((d) => scrolls(d) && d.clientHeight > 0 && d.scrollHeight > d.clientHeight + 1);
  return regions.map((el) => {
    el.scrollTop = el.scrollHeight;
    const own = (d) => { for (let a = d.parentElement; a && a !== el; a = a.parentElement) if (scrolls(a)) return false; return true; };
    let visibleBottom = window.innerHeight;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement)
      if (a === el || getComputedStyle(a).overflowY !== 'visible')
        visibleBottom = Math.min(visibleBottom, a.getBoundingClientRect().bottom);
    const lastContentBottom = Math.max(...[...el.querySelectorAll('*')].filter(own)
      .map((d) => d.getBoundingClientRect()).filter((r) => r.width > 1 && r.height > 1)
      .map((r) => r.bottom));
    return { tag: el.tagName, text: (el.innerText || '').slice(0, 60), lastContentBottom, visibleBottom,
      lastContentVisible: lastContentBottom <= visibleBottom + 1 };
  });
})
```

Every entry's `lastContentVisible` must be `true`; one that is `false` names the
region whose end is cut off (usually its own padding on `height: "100%"`). Fix
it in 7.5.

Then verify that all sections render:

1. Take a fresh `browser_snapshot` and a `browser_take_screenshot` at the end
   of the scroll.
2. For very tall pages (long lists, multi-section dashboards), start at the top
   and scroll one screen at a time. Take a snapshot and a screenshot at each
   position:
   ```javascript
   browser_evaluate(() => {
     const el = document.querySelector('[data-verify-scroller]');
     el.scrollTop += el.clientHeight;
     return { scrollTop: el.scrollTop, atEnd: Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight };
   })
   ```

Verify expected DOM elements are present somewhere on the page (not just
above-the-fold):

| Page Type | Expected Elements |
|-----------|-------------------|
| Data Grid | Table/grid element with column headers and data rows |
| Form / Wizard | Form fields (inputs, dropdowns) and Next/Back buttons |
| CRUD | Data grid + action buttons (Add, Edit, Delete) |
| Dashboard | Multiple sections/panels with headings |
| Card Layout | Card containers with content |
| File Upload | File input or drop zone element |
| Navigation Sidebar | Nav element with menu items |

**Scroll back to the top before interactive testing** (when the page has a
scroller):
```javascript
browser_evaluate(() => { document.querySelector('[data-verify-scroller]').scrollTop = 0;
  document.querySelectorAll('[data-verify-scroller] *').forEach((el) => { if (el.scrollTop) el.scrollTop = 0; }); })
```

## 7.3 Interactive Testing

Test interactions based on the page type. **Always take a fresh
`browser_snapshot` before each click.** Move on after 2 failed attempts per
interaction.

| Page Type | Test Action | Expected Result |
|-----------|-------------|-----------------|
| Data Grid | Click a column header | Sort order changes |
| Form / Wizard | Click Next button | Step advances |
| CRUD | Click Add/New button | Form or dialog appears |
| Dashboard | Click a tab or section toggle | Content area updates |
| Card Layout | Click a card action button | Card responds |
| Navigation Sidebar | Click a menu item | Content area updates |

**Skip these:** Dataverse data mutations, file upload dialogs, complex form
validation, pagination.

## 7.4 Visual Confirmation

Use `browser_take_screenshot` to capture the page in its final verified state.

For pages taller than the viewport, capture multiple screenshots by scrolling
the page's scroller (7.2), not the window: the top
(`document.querySelector('[data-verify-scroller]').scrollTop = 0`), one or more
intermediate positions for long pages (`scrollTop += clientHeight`, as in 7.2),
and the end (`scrollTop = scrollHeight`). A scroll region inside it (7.2) is
captured at its end too, after the script that checks the regions. Run the 7.2 scripts again first if
the marker is gone (the page was reloaded). This gives a complete visual record
for the deployment summary.

## 7.5 Fix and Re-deploy

If issues are found: fix the code, check it, and re-deploy using the **update form**
from Phase 6 — `node "${PLUGIN_ROOT}/scripts/genpage-upload.js"` with `--page-id` and
no `--add-to-sitemap`. A fix is new code, and new code can write a CSS shorthand that Griffel
drops at runtime (the page then deploys without its border, color or reset — the rule is
`references/rules.md` Common Pitfalls 5, and Phase 5b step 9 runs the same gate), so check the
fixed page before the re-deploy:

```powershell
node "${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file '<working-dir>/<file>.tsx'
```

That command is for a page generated in this run (you came here from Phase 7 of
the create flow). If you came from **Edit Phase 7**, the page was downloaded, not
generated, so check it as Edit Phase 5 does — with `--existing`:

```powershell
node "${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file '<working-dir>/<page-id>/page.tsx' --existing
```

With `--existing`, the page's scroll context is reported in `notes` and does not
change the exit code. Handle each note as Edit Phase 5 says:

When the maker's requested edit itself rewrites the page's top-level layout, that
layout is new code written in this run and must follow the scroll rule: apply the
remedy as part of that edit, and tell the maker in one sentence that you did. Any
other scroll note on a downloaded page is offer-only: tell the maker that content
below the fold may be cut off, offer the edit its message gives, and apply it only
if they agree. A note is never a reason to change a layout the maker did not ask
to change.

Do not upload until it exits 0: fix what it reports (each key's line, column and longhands)
and run it again. The same command checks that the fixed page still establishes a scroll context
(`references/rules.md`, **Page Layout**); a scroll problem is fixed with the edit its message gives. `genpage-upload.js` makes the same check and refuses a page that adds a key the
deployed page did not already have, or gives one it had another value (`griffel-shorthand`), so skipping this step costs a refused
upload, not a shipped defect. A key the page already had before your fix, set the same, is reported as well:
delete it to keep the page looking as it does, or write the longhands to make the style start to
render (a visible change, so only when it is wanted).
A fix is held to the iteration rule too: convert a Map, Set or iterator with `Array.from` before
spreading, looping over or destructuring it (`references/rules.md`, **Common Errors > 5. Iteration
that another page compiler can lose**).
Per the "Prompt semantics" rule, the prompt for this
re-deploy describes the fix delta only — e.g.
`"Fix sort handler on Name column; correct accidental DataGrid type prop"` —
not a re-statement of the full page description. Write it to a file and pass
`--prompt-file`; never put it on a command line.

Omitting `--data-sources` here is safe: the page's existing table bindings are
read and re-sent, so a fix re-deploy does not unbind it. Pass `--data-sources`
to change the bindings, or `--clear-data-sources` to remove them deliberately.

Pass the same `--code-file` that Phase 6 (or Edit Phase 6) uploaded: that upload
wrote the page's base marker beside it from the hash of the file it uploaded.
When the readback matched, the marker source is `upload` and this update's
divergence check passes unless someone else saved the page since. When the
readback differed, the source is `upload-unverified` and records that uploaded
hash, not the bytes the service returned, so this update refuses
`deployed-changed` until the page is compared with `genpage-base.js check`. A
`no-base`, `deployed-changed`, or `deployed-unreadable` refusal is a stop:
**attended**, show the summary and ask exactly "Overwrite the deployed changes"
or "Stop so I can merge", and record the answer as its own line before the
upload command, exactly `Choice: Overwrite the deployed changes` or
`Choice: Stop so I can merge`; **unattended**, STOP and report the code and
`deployedCopy` when present. Never pass `--overwrite-deployed` unless the user
chose "Overwrite the deployed changes". Log the refusal and that `Choice:` line
in `workflow-log.md`.

**Edit Phase 7 only — the shared-page check before every fix-up upload.** The page the edit
uploaded may be shown by other apps, and the maker's confirmation in Edit Phase 6 was for the apps
found then; an app can start to show the page in the minutes since. So right before the upload
command below, and again before each retry of it, run the check exactly as Edit Phase 6 gives it
(`edit-flow.md`, **Before anything is uploaded: the other apps that show this page**):

```powershell
node "${PLUGIN_ROOT}/scripts/genpage-shared-check.js" `
  --env '<org-url>' `
  --app-id '<app-id>' `
  --page-id '<page-id>' `
  --confirmed-apps '<uniqueName>,<uniqueName>'
```

Pass `--confirmed-apps` only with the unique names recorded in `workflow-log.md` as the user's
confirmation for this page (the `Confirmed apps:` line); leave the flag out when none were recorded.
Never add a name the user did not confirm. Handle the exit status as Edit Phase 6 does: exit 0 goes on
to the upload; exit 2 names an app that was not confirmed, so ask (attended) or STOP and report
(unattended) — a new answer is confirmed for the apps now named and is logged as there; exit 1 is
a STOP in every mode. Log each run's result in `workflow-log.md`. A refused or retried upload
needs a new check: the one before it does not cover the upload after it. The upload itself is unchanged.

Check and clear `prompt.txt` and `agent-message.txt` as in SKILL.md Phase 6, then write them with your
file-writing tool — `prompt.txt` holding the fix delta and `agent-message.txt` holding
`Phase 7.5 fix re-deploy` — and deploy (after the shared-page check above when you came from Edit Phase 7):

```powershell
node "${PLUGIN_ROOT}/scripts/genpage-upload.js" `
  --env '<org-url>' `
  --app-id '<app-id>' `
  --page-id '<page-id>' `
  --code-file '<working-dir>/<file>.tsx' `
  --prompt-file '<working-dir>/prompt.txt' `
  --model '<current-model-id>' `
  --agent-message-file '<working-dir>/agent-message.txt'
```

**Common Playwright issues:**
- "Target page, context or browser has been closed" → retry the navigation.
- "Ref not found" → take a fresh `browser_snapshot` before clicking any element.
- Sign-in required → user must sign in manually first.
