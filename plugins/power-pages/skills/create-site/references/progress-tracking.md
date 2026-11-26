### Progress Tracking

Before starting Phase 1, create only the path-agnostic upfront tasks using a task list:

| Task title | In-progress label | Description |
|-------------|------------|-------------|
| Discover site requirements | Discovering requirements | Collect site name, purpose, audience, and derived naming values |
| Select template or choose from-scratch | Selecting creation path | Offer matching templates, or route the user into the from-scratch path |

After Phase 1.5 selects the from-scratch path, append the existing from-scratch phase tasks:

| Task title | In-progress label | Description |
|-------------|------------|-------------|
| Scaffold and launch dev server | Scaffolding project | Copy template, replace placeholders with defaults, git init, npm install, start dev server, share URL |
| Plan site components | Planning components | Determine pages, components, design direction, and routes while user previews scaffold |
| Approve implementation plan | Getting plan approval | Present implementation plan covering design and pages, get user approval |
| Implement pages and components | Building site | Apply design tokens, create all pages, components, routing, and navigation in the approved content language, run the design critique pass, then ask whether to add more languages |
| Verify accessibility with axe-core | Verifying accessibility | Run axe-core on every page, fix all critical/serious violations, re-verify until passing |
| Review with user | Reviewing site | Navigate all pages, share URL, get user feedback, apply changes |
| Deploy and wrap up | Deploying site | Ask about deployment, present summary, suggest next steps |

After Phase 1.5 selects the template path, append the pre-install tasks immediately so the user can see each environment check:

| Task title | In-progress label | Description |
|-------------|------------|-------------|
| Choose local template directory | Choosing project location | Ask where the local template project should be cloned and require a new or empty destination |
| Resolve target environment | Resolving environment | Resolve the active PAC/Azure target environment and token before any environment preflight |
| Confirm target environment | Confirming environment | Ask whether the resolved environment is the one the user wants for the template install |
| Validate CLI tenant alignment | Checking CLI tenants | Verify PAC CLI and Azure CLI are authenticated to the same tenant before installation |
| Validate JavaScript unblock requirement | Checking JavaScript setting | Check `blockedattachments` for `.js` and, with consent, remove only `js` before site upload |
| Validate Dataverse language requirements | Checking language availability | Call `RetrieveAvailableLanguages` and require every LCID listed in the selected template's `requiredDataverseLanguages` |
| Confirm template install | Confirming template install | Show the selected template and target environment, then ask for final install consent |

After the reinstall policy chooses a normal import, update, or import-anyway path, append:

When `TEMPLATE_SOLUTIONS_TO_IMPORT` contains exactly one entry, use the task subject **Import template supporting solution** and active form **Importing supporting solution**. Use the plural forms in the table for two or more entries.

| Task title | In-progress label | Description |
|-------------|------------|-------------|
| Import template supporting solutions | Importing supporting solutions | Import each required unmanaged supporting solution in deterministic order; solutions marked `publishChanges` in the manifest publish changes as part of import |
| Clone, build, and upload template site | Creating template site | Clone the packaged SPA source into the selected local directory, install dependencies, build and verify the configured compiled output, then upload the resulting code site |
| Apply template seed data | Applying seed data | After read-only planning and any financial currency decision, insert optional template seed records in parallel with site creation; failures do not block activation |
| Show inactive template site | Showing template site | After site creation and seeding join, use the Website Record ID written by `pac pages clone` to `.powerpages-site/website.yml` and tell the user the uploaded site is not activated yet |
| Activate template site | Activating template site | Invoke activate-site with the resolved site name and Website Record ID |
| Show live template site | Showing live site | Show the activated site URL in the shared provisioning page and invite the user to continue customizing |

If the user chooses to customize the live template, append:

| Task title | In-progress label | Description |
|-------------|------------|-------------|
| Plan template customizations | Planning customizations | Ask what the user wants changed and plan edits against the existing cloned project |

When every supporting solution is already installed at the same or newer version, append the same list without **Import template supporting solutions**. The packaged SPA clone/upload, site discovery, seed, activation, and live-preview tasks still run.

Mark each task `in_progress` when starting it and `completed` when done via task updates. This gives the user visibility into progress and keeps the workflow deterministic while avoiding permanently skipped tasks on future non-from-scratch branches.
