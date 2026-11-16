# Template customization

20. Mark **Plan template customizations** as `in_progress`, then inspect the
       cloned project before asking what the user wants changed:

       ```bash
       node "${PLUGIN_ROOT}/scripts/lib/localization-config.js" inspect --projectRoot "<PROJECT_ROOT>"
       ```

       Establish the language context required by the Phase 4 plan in this order:
       - When `localization.detected=true` and `localization.valid=true`, use
         `localization.defaultLocale` as the authoritative locale. Resolve it
         with `resolve-locale`, set `SITE_LOCALE`, `SITE_DIRECTION`, and
         `SITE_LANGUAGE` from the returned `locale`, `direction`, and
         `languageName`, and retain `localeName` when regional or script detail
         needs to be displayed. Do not scan locale-specific document roots as
         though they described one single-language site.
       - When `localization.detected=true` and `localization.valid=false`, show
         the localization conflicts and stop before planning customization. The
         localization configuration must be repaired; do not fall back to
         static document attributes or report localized roots as a
         single-language conflict.
       - When no localization is detected and `siteLanguage.detected=true` with
         `siteLanguage.valid=true`, resolve `siteLanguage.locale` with
         `resolve-locale`. Use the returned `locale`, `direction`, and
         `languageName` to establish `SITE_LOCALE`, `SITE_DIRECTION`, and
         `SITE_LANGUAGE`.
       - When `siteLanguage.reason` is `document-not-found`,
         `html-root-not-found`, `document-ambiguous`, or
         `document-configuration-invalid`, show its conflicts and
         `expectedSources`, then stop before planning customization. Locate or
         repair the actual application root document before asking for a
         content language.
       - When the document exists but its static language attributes are
         missing or invalid, ask the **Content language** question below,
         resolve the answer with `resolve-locale`, and include repairing
         `siteLanguage.source` in the approved customization plan.

       After `SITE_LANGUAGE`, `SITE_LOCALE`, and `SITE_DIRECTION` are all
       established, ask what the user wants changed in `PROJECT_ROOT`. Use the
       existing Phase 3/4/5/6/7 implementation, verification, and review flow
       against the cloned project; do **not** run Phase 2 scaffold/copy-template.
       In Phase 3, skip the Brand sub-prompt and set `BRAND_SOURCE` to
       `template` - the template's existing theme tokens are the source of truth
       unless the user asks for a redesign. On this path Phase 5 edits the cloned
       project in place: keep the existing theme file, layout, and pages, change
       only what the approved plan names, and skip every `scaffold-status.json`
       step because no loader is running. Run the Phase 5.7 design critique on
       the pages you changed.
   21. After the customization plan is approved, mark **Plan template customizations** as `completed`, **Implement pages and components** as `in_progress`, and make the requested changes.
   22. Run the existing validation/review flow. Do not automatically deploy unless the user explicitly asks to run `/deploy-site`.
