# Template acquisition

[`SKILL.md`](../SKILL.md) reads this only for confirmed new-app intent with a new or empty target directory, the **New/empty directory** row.
A fresh installed template skips it: the router's release check is all that template needs.
Both build orders start from its result; neither acquires, installs, or re-resolves the template later.

<!-- The step starts here; everything above is about the file. -->

The former local diagnostic artifact mode is retired. Only a finalized published
template package may scaffold a new app; missing publication is a blocker, not
permission to reconstruct a template or copy a bundled snapshot.

For confirmed new-app intent with a proposed new directory, first bind its
existing parent without creating the target. From the selected existing parent,
run `mobile-template-lifecycle.js destination --destination '<proposed_working_dir>'`
using the installed plugin's absolute script path. This read-only check returns
the canonical parent/destination and rejects a nonempty or invalid target.
Keep those returned paths as the scoped creation context. Only after acquisition
approval may the package CLI create the destination. Then bind the resulting
app root through
[app-working-directory.md](../../../shared/references/app-working-directory.md)
before installation, preparation or app/data operations. This exception does
not apply to an existing app or a creation continuation: those must bind the
existing absolute `working_dir` through the same reference before project reads
or commands, and a missing root remains `BLOCKED`.

For a new/empty target, offer **Acquire reviewed template** or **Cancel**. After explicit approval, run `mobile-template-lifecycle.js acquire --template-version "<exact-template-version>" --destination '<working_dir>'`. It verifies the immutable package and metadata before using the package's creation CLI. Separately approve dependency installation with the shipped lockfile (`npm ci`); use existing registry authentication, never print/provision credentials here. Do not fall back to `degit` or copy a bundled template on failure.
