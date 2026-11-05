# From scratch

8. For the from-scratch path only, tell the user: "I'll scaffold this site from scratch."

<!-- not-a-gate: deferred data-gathering prompt for framework and directory before any scaffold files are written -->

9. Ask the from-scratch-only questions that were deferred from Phase 1:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which frontend framework? | Framework | React (Recommended), Vue, Angular, Astro, Non-SPA (Liquid + Web Template) |
   | Where should the project be created? | Location | Current directory, New folder in current directory (Recommended), Any other directory |

   If the user selects **Non-SPA (Liquid + Web Template)**, read and follow
   `${PLUGIN_ROOT}/skills/create-site/workflows/non-spa-site.md` and stop the SPA workflow.

10. Determine the site's single content language independently of whether the
   purpose was supplied in the user's current request.

   - If the request explicitly names the content language, resolve it without
     asking again and include it in the confirmation.
   - Do not infer the desired site language merely from the language used to
     converse with the maker.

   <!-- not-a-gate: the locale is validated before it can affect scaffolding -->

   When the content language was not explicit, get a best-effort suggestion:

   ```bash
   node "${PLUGIN_ROOT}/scripts/suggest-content-locale.js"
   ```

   The script returns the selected Dataverse environment's base language as a
   canonical BCP-47 locale when PAC and Azure CLI authentication are available.
   It silently returns `en-US` with `"source": "fallback"` when the environment,
   authentication, API response, or LCID mapping is unavailable. Do not retry,
   display an error, or block site creation when the lookup falls back.

   Ask the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which language should the site content use?<br><br>Pages, navigation, buttons, forms, and accessibility text will use this language. Dataverse and Power Pages system messages will remain in English. | Site content language | `<language> (<locale>) (Suggested)`, English (`en-US`) |

   Replace `<language>` and `<locale>` with the script result. If that result is
   `en-US`, show only `English (United States) (en-US) (Suggested)` rather than
   adding a duplicate English option. Label the environment-derived choice
   **Suggested**, not **Recommended**: an environment's base language is useful
   context but may not match the intended language of a public site.

   The question UI's free-text option lets the maker enter another language or
   locale, such as `Spanish (es-ES)`, `Japanese (ja-JP)`, or `Arabic (ar-SA)`.
   Convert a language name to an appropriate BCP-47 tag, preserving an explicit
   region or script when supplied. Keep the raw answer as data only: never place
   it in a shell command. In agent memory, convert it to
   `SAFE_LOCALE_CANDIDATE`, which must match
   `^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$` and be at most 255 characters.
   Reject and re-prompt before running a command if no safe candidate can be
   derived. Validate and canonicalize only that constrained candidate:

   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/localization-config.js" resolve-locale --locale "<SAFE_LOCALE_CANDIDATE>"
   ```

   Do not quote, escape, sanitize, or otherwise interpolate the raw maker answer
   into this command. Reject invalid resolver output and re-prompt with the
   reason. Record the canonical resolver output rather than inventing a
   language label:

   - `SITE_LANGUAGE` — resolver `languageName`, such as `Spanish`; if display
     names are unavailable, show the canonical locale and ask the maker for a
     readable label rather than guessing
   - `SITE_LOCALE` — canonical BCP-47 tag, such as `es-ES`
   - `SITE_DIRECTION` — `ltr` or `rtl` from the resolver
   - `SITE_LOCALE_NAME` — resolver `localeName`, such as `European Spanish`,
     retained for plan text that needs regional or script specificity

11. Resolve the project location:
   - **If "Current directory"**: Project root = `<cwd>`.
   - **If "New folder in current directory"**: Create a folder named
     `__SITE_NAME__` inside the cwd. Project root =
     `<cwd>/__SITE_NAME__/`. First verify that `__SITE_NAME__` is a valid
     directory name on the current operating system. Non-Latin characters alone
     are not a reason to reject it. If the site name contains invalid path
     characters, is reserved by the operating system, is empty after
     sanitization, or otherwise cannot be used safely, fall back to
     `__SITE_SLUG__`. Before creating a fallback folder, tell the maker which
     name will be used and why the original site name was not filesystem-safe.
   - **If "Any other directory"**: Ask for the full path. Verify/create it. Project root = provided path.

   After resolving, confirm: "The site will be created at `<resolved path>`."

   Store this as `PROJECT_ROOT`.

12. Finalize the derived values:
   - `__SITE_NAME__` — preserve the maker's site/brand name as entered, e.g.
     `Contoso Portal`; it does not need to match the content language.
   - `__SITE_SLUG__` — a lowercase ASCII kebab-case technical identifier used
     by npm, Angular project configuration, build paths, and the default folder.
     Derive it from the site name when possible, e.g. `Contoso Portal` →
     `contoso-portal`. Transliterate when reliable. If a non-Latin name cannot
     produce a safe, meaningful slug, derive one from the site's purpose or ask
     for a technical project name rather than emitting an empty or invalid
     identifier.
   - `__SITE_DESCRIPTION__` — one-line description written in `SITE_LANGUAGE`
     based on the name and purpose.

13. Summarize understanding and confirm with the user before proceeding. Include
   site name, technical slug, framework, purpose, audience, project location,
   `SITE_LANGUAGE` (`SITE_LOCALE`, `SITE_DIRECTION`), and the explicit statement
   that Dataverse and Power Pages system messages remain English.
14. After confirmation, emit the approved, taxonomy-only site configuration:

   - Map the purpose to `company-portal`, `blog-content`, `dashboard`,
     `landing-page`, or `other`. Never pass the maker's free-text purpose.
   - Set `choiceSource` to `arguments` only when both framework and content
     locale came from the initial request; otherwise use `prompt`.

   ```bash
   node "${PLUGIN_ROOT}/scripts/emit-skill-configured-telemetry.js" --skillName "create-site" --projectRoot "<PROJECT_ROOT>" --framework "<react|vue|angular|astro>" --siteContentLocale "<SITE_LOCALE>" --purpose "<PURPOSE_TAXONOMY>" --audience "<internal|external>" --choiceSource "<arguments|prompt>"
   ```

   The telemetry helper is fail-closed and removes locale extensions/private-use
   subtags. Do not add the site name, description, pages, routes, components,
   feature labels, or any other free-text requirement to this command.

15. Append the from-scratch task list (Phases 2-8) to the todo list (see
    the entry-linked progress-tracking contract), then mark **Select template or
    choose from-scratch** as `completed`.

**Output**: cloned template site identity (`IMPORTED_SITE_NAME`,
`IMPORTED_WEBSITE_RECORD_ID`) and a local project path ready for optional
customization; or `CREATION_PATH = "from-scratch"` with selected framework,
content language, derived naming values, and resolved project location.

---
