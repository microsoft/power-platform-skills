---
name: manage-headers
description: >-
  Inspects and configures the security headers a Power Pages site sends
  to browsers — Content Security Policy, frame and clickjacking protection,
  cross-origin sharing, cookie behavior, and related site settings.
  Identifies gaps and walks the user through fixes. Use when the user
  wants to review headers, fix CSP errors, allow embedding in another site,
  control cross-origin access, harden cookie settings, or asks "are my
  browser settings safe?", "fix my CSP", "set up CORS" — even if they only
  mention a specific header name without saying "security headers".
user-invocable: true
argument-hint: "[optional: --review <out-dir>]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage Headers

Inspect and configure the HTTP security headers for a Power Pages site. Headers are configured as `HTTP/*` site settings stored in `.powerpages-site/site-settings/` YAML files.

**Initial request:** $ARGUMENTS

## Gotchas

- **Site settings are YAML files.** Each header is a separate `.yml` file in `.powerpages-site/site-settings/`. The file name uses `-` instead of `/` (e.g., `HTTP/X-Frame-Options` → `http-x-frame-options.sitesetting.yml`).
- **Absent = no header.** When a site setting is absent, the runtime omits that header entirely (except CSP on new sites — see headers-reference.md).
- **HSTS and Cache-Control are platform-managed.** Do not try to set `HTTP/Strict-Transport-Security` — the runtime does not recognize it and the setting has no effect.
- **Maker-mode bypasses headers.** Requests from Power Pages Studio skip all `HTTP/*` header emission. Verify headers in an incognito tab, not the studio preview.
- **CSP is pass-through.** The runtime emits the value verbatim — it does NOT merge runtime sources automatically. The CSP MUST include Power Pages runtime hosts or the site breaks.
- **CSP nonce.** When `script-src` contains `'nonce'`, the runtime replaces it per-request with `'nonce-<random>'` and auto-hashes inline event handlers. Scripts created dynamically via `document.createElement` do NOT receive the nonce.
- **`SameSite=None` requires HTTPS.** The runtime sets `Secure` on every cookie over HTTPS automatically.
- **CORS `*` is auto-specialized.** The runtime replaces `*` per-request with the specific requesting Origin — the browser sees a single-origin header, not a wildcard.

## Workflow

1. **Prerequisites** — Locate project, confirm site-settings directory exists
2. **Inspect current headers** — Read site-setting YAML files, identify configured and missing headers
3. **Assess and plan** — Identify gaps, present recommendations
4. **Apply changes** — Edit existing settings or create new ones
5. **Summarize** — Present results, record usage, offer follow-ups

## Task Tracking

Create tasks in four groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When to create | Tasks |
|-------|----------------|-------|
| 1 | At start | Check prerequisites |
| 2 | After prerequisites pass | Inspect current headers · Assess and plan (skip "Assess and plan" in review mode) |
| 3 | After user approves changes | Apply changes (skip in review mode OR if no changes were accepted) |
| 4 | After apply or assess | Summarize (always) |

---

## 1. Prerequisites

### 1.1 Locate the project, detect review mode

Use `Glob` to find `**/powerpages.config.json`. If `$ARGUMENTS` contains `--review <out-dir>`, remember the output directory — Steps 3–4 are skipped and Step 5 writes JSON only.

### 1.2 Verify site-settings directory

Check that `.powerpages-site/site-settings/` exists. If not, the site has not been deployed yet — tell the user and recommend `/deploy-site`. Stop.

---

## 2. Inspect current headers

Use `Glob` to find all `*.yml` files in `.powerpages-site/site-settings/`. Use `Read` to read each file and extract the `name` and `value` fields. Identify all settings with an `HTTP/` prefix — these are the configured headers.

Compare against the recognized header catalogue in `references/headers-reference.md`. For each header in the catalogue:
- **Present** — record its current value.
- **Missing** — record it as absent and note the recommended value from headers-reference.md.

For CSP specifically: if `HTTP/Content-Security-Policy` is present, scan the project's source files using `Glob` + `Read` to find external URLs and check whether they are covered by the policy. Identify the site's cloud environment via `pac auth who` to determine the correct Power Pages runtime host (see headers-reference.md § "Power-Pages-runtime sources a CSP must allow").

---

## 3. Assess and plan

Skip in **review mode**.

MUST use plain language only. Never lead with words like CSP, CORS, HSTS, or MIME sniffing — explain using everyday language:

| Header concept | Plain-language name |
|----------------|---------------------|
| Content-Security-Policy | "which scripts and resources the browser is allowed to load" |
| X-Frame-Options / frame-ancestors | "whether other websites can put your site inside a frame" |
| X-Content-Type-Options | "stop the browser from guessing file types" |
| CORS headers | "which other websites can call your site's data" |
| SameSite cookies | "when the browser sends your sign-in cookie" |

### Default approach

Read `references/headers-reference.md` for recommended values and guidance. **Present the most important gaps first** — headers that are missing or misconfigured relative to the recommended values.

<!-- gate: manage-headers:3.per-finding | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · manage-headers:3.per-finding):** Per-finding loop — for each header gap, prompt accept / customize / skip. Fires PER FINDING in the loop; skipped findings leave the header at its current value, accepted/customized findings get an Edit / create-script call in Phase 4.
>
> **Trigger:** Phase 3 entry has tallied header gaps against `references/headers-reference.md`.
> **Why we ask:** Auto-accepting can apply CSP/CORS values that break the site (legitimate scripts blocked, third-party widgets refused); auto-skipping leaves the site missing important headers.
> **Cancel leaves:** Nothing — Phase 4's Edit / create-script call only fires on accepted findings.

For each finding, present via `AskUserQuestion`:
- A plain-language explanation of why the change matters
- The recommended value
- Options: accept the recommendation, customize, or skip

Do NOT present all headers at once — present the important gaps first. For headers already set to recommended values, mention them in the summary without requiring action.

### CSP composition

When the user needs a CSP (missing or incomplete), compose one using:
1. The starter template from headers-reference.md
2. The correct cloud-specific runtime host
3. External URLs discovered from the project's source files — scan ALL source files, templates, scripts, etc.
4. The `'nonce'` keyword for inline scripts

When reviewing an existing CSP, validate:
- All external URLs actually loaded by the site are covered in the policy
- Runtime hosts are included for the site's cloud

Present the composed or corrected CSP for review. Recommend starting in report-only mode (`HTTP/Content-Security-Policy-Report-Only`) before enforcing.

---

## 4. Apply changes

Skip in **review mode**.

For **existing** settings: use `Edit` on the YAML file directly — change the `value` field.

For **new** settings: use the shared create script:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<setting-name>" \
  --value "<value>" \
  --description "<description>"
```

See `references/commands.md` for details.

After all changes are applied, offer to deploy: "Ready to deploy these changes? They take effect after the next deploy." If yes, invoke `/deploy-site`.

---

## 5. Summarize

### 5.1 Review mode

First, read the configured `HTTP/*` site settings (from Step 2 — you already have them). Then write `<REVIEW_DIR>/header-annotations.json` with a plain-language description for each header and, when the configured value has a genuine issue (missing critical directive, weak value), a suggested fix. The transform script no longer hardcodes header descriptions — they come from you.

```json
{
  "headers": {
    "HTTP/<HeaderName>": { "description": "What this header does, in plain language.", "fix": "Optional fix if the configured value has a genuine issue." }
  }
}
```

Use `references/headers-reference.md` for authoritative descriptions and validation rules. Surface a `fix` **only** when the value has a real problem — do not editorialize on every header.

Then run the transform:

```bash
node "${PLUGIN_ROOT}/skills/manage-headers/scripts/transform-headers.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --annotations "<REVIEW_DIR>/header-annotations.json"
```

Write the stdout to `<REVIEW_DIR>/manage-headers.json` and stop. The transform emits `{ status, findings, details }`; the orchestrating skill handles presentation.

### 5.2 Present summary

Skip in **review mode**.

Plain-language summary: what was changed, what gaps remain, and what is already well-configured.

### 5.3 Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ManageHeaders"`.

### 5.4 Offer follow-ups

If a natural follow-up exists based on findings, suggest it. If no meaningful follow-up exists, end the skill.

---

## Constraints

- **Plain language** — MUST NOT use technical jargon with the user. Explain header names using everyday language.
- **headers-reference.md is the source of truth** — recommended values and the recognized header catalogue live there. Read it before assessing.
- **Context-aware interactions** — every recommendation MUST reflect the site's actual configuration and usage:
  - Read the site's source files, integrations, and auth setup before recommending any value.
  - Never recommend a value without verifying it will not break the site's functionality (see the "Context to verify" column in headers-reference.md).
  - Acknowledge existing values when proposing changes — they may be intentional.
  - For CSP, reference actual external URLs found in the project's source files.
  - For CORS, verify the site's actual cross-origin consumers before scoping.
  - For Cross-Origin-Opener-Policy, verify whether the site uses popup-based auth.
  - For Cross-Origin-Resource-Policy, verify whether the site hosts Azure AD B2C custom login pages, is embedded cross-origin, or has integrations that load its resources. Leave absent or use `cross-origin` when unsure.
- **Preview is for change review only** — include `preview` only on options that modify a setting value. Do not add to informational choices.
- **Recommendations MUST NOT break the site** — before recommending a value, consider whether it would block resources the site actually uses. For CSP, always verify that runtime sources and project external URLs are included. For CORS, verify the site's actual cross-origin needs. When unsure, recommend report-only mode first.
- **NEVER recommend broadening an existing policy** — if the user already has a tight CSP, CORS scope, or restrictive header value, do not suggest making it less restrictive. A working tight policy is better than a broad one. Never recommend `https:` wildcards in CSP directives — list specific hosts instead.
- **Deploy after changes** — header changes only take effect after deploying. Always offer `/deploy-site` after applying changes.

## References

- `references/headers-reference.md` — recognized header catalogue, recommended values, CSP composition rules, runtime sources. Read before Step 2 (inspect) and Step 3 (assess) in **interactive** mode.
- `references/commands.md` — shared `create-site-setting.js` usage. Read at Step 4 (apply) when creating new settings.
