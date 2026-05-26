# Workflow Log — Eval 13: Contact list with localization

## Phase 0 — Working directory setup
- Working directory created: `contact-localized/`
- Plugin root: `D:\Projects\power-platform-skills\plugins\model-apps`

## Phase 1 — Planner (genpage-planner agent invoked via Task)

### Prereq checks
- `node --version` → v20.11.0
- `pac help` → PAC CLI Version 2.7.3 (>= 2.7.0 verified)

### Auth check
- `pac auth list` → active profile aurora365-user1@auroratstgeo.onmicrosoft.com
- Active environment: https://aurorabapenv4ab3f.crm10.dynamics.com/ (reported to user)

### Entity discovery
- `pac model list-tables --search 'contact'` — contact entity exists

### Language discovery
- `pac model list-languages` returned: English (United States) (1033, en-US), Arabic (Saudi Arabia) (1025, ar-SA), French (France) (1036, fr-FR)
- Multiple non-English languages detected → planner activates localization code path
- Arabic detected as RTL language

### Discovery questions (AskUserQuestion)
- Question 1 (new or edit): user answered "Create new page(s)"
- Question 2 (data source): user answered "Dataverse entity: contact"
- Question 3 (specific requirements): "Contact list display"
- Question 4 (app selection): user selected existing app "Sales Hub"

### Solution selection
- Build is code-only → solution selection question SKIPPED
- Defaults written to plan: `Solution: Default`, `Publisher Prefix: new`

### Plan presented
- EnterPlanMode called with plan including Localization section; user approved

### Plan written
- genpage-plan.md written; ## Localization lists detected languages (1033, 1025, 1036) and RTL flag on Arabic
- references/localization.md loaded conditionally

## Phase 2 — Entity creation
- SKIPPED (contact exists)

## Phase 3 — App creation
- SKIPPED (existing app selected)

## Phase 4 — Schema generation
- pac model genpage generate-types --data-sources 'contact' --output-file contact-localized/RuntimeTypes.ts

## Phase 5b — Single-page fast path
- Plan has 1 page → fast path taken (inlined build, no Task subagent dispatched)
- Data mode: dataverse
- Read sample: plugins/model-apps/samples/9-list-with-caching.tsx (Dataverse list pattern)
- Read ${CLAUDE_PLUGIN_ROOT}/references/localization.md (multi-language + RTL pattern)
- Read ${CLAUDE_PLUGIN_ROOT}/references/verified-icons.txt
- Wrote page.tsx with:
  - Xrm.Utility.getGlobalContext().userSettings.languageId for language detection
  - LOCALE_MAP for 1033/1025/1036 → BCP-47 + isRtl
  - TRANSLATIONS dictionary with en-US, ar-SA, fr-FR entries
  - translate() helper t(key)
  - dir attribute set to rtl when locale.isRtl
  - Logical CSS properties (paddingInlineStart/End, marginInlineStart, paddingBlock)
- Post-write icon verification: PeopleRegular verified against verified-icons.txt

## Phase 6 — Deployment
- pac model genpage upload --app-id 55555555-4444-5555-6666-777777777777 --code-file contact-localized/page.tsx --data-sources 'contact' --prompt "Build a page showing Contact records with name, email, and phone." --model claude-sonnet --name "Contacts (Localized)" --agent-message "Contact list with en-US/ar-SA/fr-FR translations and RTL support" --add-to-sitemap

## Phase 8 — Summary
- 1 page deployed: page.tsx → "Contacts (Localized)" in Sales Hub
- Localization: en-US, ar-SA (RTL), fr-FR
- No entities created
