# Stylistic fix sweep

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 15 | Step 11.4 |
| `Step <n>/<total>` in progress lines | 15/17 | 11.4/13 |
| the screen-building steps | Steps 5-6 | Steps 10.8-11 |

<!-- The step starts here; everything above is about the file. -->

Run one controlled stylistic debt sweep once every screen is built and the last TypeScript gate is clean, before the dev-server launch. In the screens-first order that is after the data layer is wired and the design system applied, so contrast is judged against the real brand tokens. This keeps screen-builder retries focused on critical compile/data/route issues, then fixes visual and accessibility quality across the full screen set in batches.

**Print before starting:**
> "→ [Step <n>/<total>] Running stylistic validators in batch + auto-fixing contrast / accessibility / token issues across all screens (~2-3 min)"

**Scope:** generated screen files only: every file from the Screen Map plus any `app/(app)/**/*.tsx` screen written by the screen-building steps. Exclude layout files unless the reported issue is clearly inside generated screen chrome for that route group. Do not scan `src/generated/`, `src/hooks/data/`, `brand/`, `node_modules/`, `.expo/`, or sample files.

**Available validators in v0:**

```bash
node "${PLUGIN_ROOT}/hooks/validate-screen-quality.js" --report <screen-files-or-app-dir>
node "${PLUGIN_ROOT}/hooks/validate-color-contrast.js" --report <screen-files-or-app-dir>
```

`validate-screen-quality` includes accessibility-label/role, safe-area, touch-target, raw-hex, token, empty-state, shadow, and status-visual checks. If future stylistic hooks exist (for example `validate-accessibility-labels.js`), include them here only if they support `--report` and emit the same JSON issue shape.

For each available stylistic validator:

1. Run in `--report` mode against all generated screens. Report mode is non-blocking; it emits JSON issues with `file`, `line`, `rule`, `match`, `fix`, and `autoFixable`.
2. Merge issues by file and rule. Keep exact line numbers for user/debug output, but do not rely on stale line numbers after the first edit in a file.
3. Split findings into deterministic auto-fixes and judgement calls:
  - **Auto-fixable:** weak foreground tokens, white-on-yellow/orange status pairs, missing icon-only `aria-label`, missing tappable `role`, tiny icon button `hitSlop`, obvious raw hex/token substitutions, top-only safe area with bottom UI, `allowFontScaling={false}`. Apply these web-standard accessibility props to Tamagui 2 components; raw React Native components retain their React Native accessibility props.
  - **Needs review:** complex safe-area restructuring, dominant red detail headers, redundant status cue design, ambiguous brand colors, empty-state restructuring that requires moving JSX across large blocks.
4. Build one file-level edit batch per affected file. Apply affected files in parallel because screen files are independent. Do not run one edit per issue when multiple issues are in the same file; that reintroduces slow per-write loops and line-number drift.
5. Re-run the same validator in `--report` mode for the touched files. Cap retries at 2 per file per validator.

These validators are invoked explicitly by this mobile workflow. They are not registered as plugin-wide hooks because that would run them during unrelated Canvas Apps and other plugin operations.

After all validators report no auto-fixable issues, run:

```bash
npx --no-install tsc --noEmit
```

If `tsc` fails, use the existing TypeScript batch-repair policy. If stylistic issues remain after 2 retries or are judgement calls, do not keep looping. Record them in `memory-bank.md` and surface them as:

```text
DONE_WITH_CONCERNS: the stylistic sweep left <N> stylistic issue(s) for review: <file:line rule summary>
```

Then continue only if TypeScript is clean. This step may leave concerns, but it may not leave the app in a broken TypeScript state.
