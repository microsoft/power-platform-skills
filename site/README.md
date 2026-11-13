# Showcase site

The source for the plugin showcase at <https://microsoft.github.io/power-platform-skills/>.
It is a static site with no dependencies beyond Node.js.

## Build and preview

```bash
node site/fetch-media.js
node site/build.js
node --test site/tests/site.test.js
```

`fetch-media.js` downloads the explainer video and poster into `site/media/` (see [Site media](#site-media)).
Skip it if you don't need the video: the build then leaves it out with a warning, and the rest of the site works.
The build writes to `site/dist/`, which Git ignores.
To preview it, serve that folder with any static file server, for example `npx serve site/dist`.
The [showcase-site workflow](../.github/workflows/showcase-site.yml) runs the tests and the build on pull requests, and deploys to GitHub Pages from `main`.

## Deployment and repo stats

GitHub Pages serves one artifact for the whole repository.
The [github-repo-stats workflow](../.github/workflows/github-repo-stats.yml) writes its daily report to the `github-repo-stats` branch, and every site deploy copies that branch's `microsoft/` folder into the artifact.
That keeps the report at its existing address, `microsoft/power-platform-skills/latest-report/report.html`.
The site workflow also runs after each successful stats run, so the published report stays current.
A test fails if a deploy would stop carrying the report.

## Where the content comes from

- `marketplace.json` decides which plugins appear.
- Each plugin's `.plugin/plugin.json` supplies its version.
- `site/catalog.json` holds the plain-language content that no manifest carries: who a plugin is for, example prompts, what you need, skills to list, notes, and Microsoft Learn links.
- `site/lib/install-links.js` builds every install command and link. The README's install links come from the same templates, and a test fails if they drift.

## Evaluation dashboard

The `/evaluations/` page lists every marketplace plugin and every local `skills/<name>/SKILL.md`, including skills that are not featured in the catalog.
External plugins stay visible, but their skill inventory is marked unavailable rather than inferred from the catalog.
Without supplied results, the page shows an honest "Not evaluated" inventory.

Include offline evaluation summaries when building:

```bash
node site/build.js --eval-results eval-results/summary.json
node site/build.js --eval-results results/model-a --eval-results results/model-b
```

Each input can be a summary JSON file or a directory.
Directory discovery reads only `summary.json` and `*.summary.json`, including nested directories, so other JSON artifacts are not read.
An explicitly supplied empty directory, malformed summary, unknown plugin or skill, duplicate role/trial record, or ambiguous same-date model run stops the build before the output folder is cleared.
For publication before the first run or after artifact expiry, `--allow-empty-eval-results` permits a genuinely empty results directory without accepting malformed summaries.
Missing trials remain visible as incomplete evidence; they cannot produce a consistent-evidence label or baseline delta.
The build publishes rendered, allowlisted summary fields only, never the input files or raw model output.
Run links must be canonical `https://github.com/<owner>/<repo>/actions/runs/<id>` URLs without credentials, queries or fragments.

Summaries use schema version 3; versions 1 and 2 remain readable.
The CommonJS export `validateSummary(summary)` in `site/lib/evaluations.js` validates all three versions.
It returns the supplied object unchanged on success and throws an `Error` for invalid schema or record data.
It does not read files, check current source hashes, or require complete coverage; `loadEvaluations({ repoRoot, catalog, evalResults, now })` checks inventory and freshness and labels incomplete coverage.
Each includes the plugin, source commit, generation time, actual execution and judge model identifiers, optional run URL, plugin hash, required `runtimeHash`, and suites.
Each suite identifies a skill, SKILL.md and suite directory hashes, repeat count, expected capability/dormancy cases, and baseline/skilled trial records.
Every record carries the status, optional score, named boolean grader checks, optional token/duration counts, and a fixed error code rather than an error message.
Version 2 records add agent input, output and cache counters plus judge call counts and reported input/output counters.
Version 3 retains those counters and requires agent and judge reasoning efforts plus distinct agent/judge models.
Earlier summaries display unreported effort and remain separate from explicitly measured effort settings.
Unknown agent counters stay null, and judge totals are lower bounds because Vally can substitute zero for missing provider fields.
Version 1 zero-token totals are treated as unknown because they could indicate missing usage events.
Unrecognized fields are rejected so raw transcripts cannot accidentally enter the page.

`scripts/lib/eval-evidence.js` exports dependency-free CommonJS `hashFile(file)` and `hashTree(root)` helpers shared with the evaluator.
The tree hash is SHA-256 over lexically sorted relative paths using `/`, then NUL, raw bytes, then NUL for each file.
It skips `node_modules`, `.git`, `dist`, `__pycache__`, and `.DS_Store`, and rejects symlinks and special files.
The dashboard checks `suiteHash` with `hashTree(evals/<marketplace-plugin-name>/<skill-directory>)`, including eval.yaml, fixtures and hidden checks.
It checks the required top-level `runtimeHash` with `hashTree(evals/runtime)`, using the same exclusions.
Changing plugin files, SKILL.md, suite inputs or runtime files invalidates current evidence; runs older than 30 days are stale.

The page separates capability from routing/dormancy, shows observed passes over expected trials, counts distinct tasks and all-repeats-pass tasks, and compares capability against its matched baseline.
Repeats do not count as additional independent tasks.
Only the newest supplied run for each plugin / skill / execution model / judge model / agent effort / judge effort combination is shown.
Separate summaries from a per-skill Actions matrix can share a timestamp and still contribute coverage.
Every skill retains its selected run's date, commit and hashes; results from different runs, models or versions are never pooled, and missing trials are never filled from older runs.
The descriptive "Consistent offline evidence" category requires current, complete results, all skilled trials passing, at least two capability tasks, one dormancy task, and two repeats.
These minimums check task breadth, routing, and repeatability; they do not establish calibrated confidence or production readiness.
The page explains every category and keeps stale runs inspectable.
The token view aggregates all supplied summaries rather than only the newest evidence.
It shows reported agent and judge usage by each skill evaluation's UTC start date and by plugin, along with missing counts and incomplete trial records.
The usage totals include all models and are not changed by the skill filters.
On the public site, history is limited to retained artifacts from the latest 20 default-branch manual workflow runs, for up to 90 days.

Power Pages evaluations assess generated documentation, HTML, and semantic/quality properties of ER diagrams offline.
They do not provision resources, contact a tenant, or verify deployed behavior.
The dashboard uses the showcase site's shared layout, colors, fonts, and system/light/dark theme controls.
Native details elements keep the full inventory and case results readable without JavaScript.
JavaScript adds combined name, plugin, model and evidence filters.

## Design

The design follows the Power Pages plugin's design references (`plugins/power-pages/references/design-aesthetics.md`, `page-blueprints.md`, and `design-critique.md`).
The brief and design thesis are at the top of `site/lib/render.js`.

- **Theme.** Light and dark themes follow the visitor's system setting by default.
  The header switch pins either one, and `assets/theme.js` applies the choice before the page paints.
  Every color is a `light-dark()` token in `assets/styles.css`.
- **Brand.** The Power Platform logo and product icons are Microsoft's official icons, used under the rules in [`assets/brand/README.md`](assets/brand/README.md).
  Each plugin names its Microsoft product in `catalog.json` (`product`), and a test checks that every product icon has its product name beside it.
- **Fonts.** Schibsted Grotesk, Public Sans, and JetBrains Mono are self-hosted under the SIL Open Font License (licenses in `assets/fonts/`), so the site loads nothing from other origins.
- **Hero session.** `showcase` in `catalog.json` lists the example sessions in the hero.
  Each prompt must be one of the plugin's example prompts, and each step must describe something the plugin's skill really does, in order.

## Explainer video

The Questions section opens with "What are plugins and skills?", a 35-second film with captions and a transcript.
Only the finished film is kept, not the tools that made it:

- The video and its poster are on the `site-media` branch (see [Site media](#site-media)).
- The captions are `assets/video/plugins-and-skills.vtt`.
- The transcript is `video.transcript` in `catalog.json`: each part of the narration (`spoken`) and what is on screen while it plays (`shown`), for anyone who cannot see or play the video.

A test fails if the transcript and the captions disagree, or if the transcript names a Power Pages skill that no longer exists.
If a skill the video shows is renamed or removed, the video needs replacing.
[`assets/video/README.md`](assets/video/README.md) says how the film was made and what is illustrative.

The video never autoplays and preloads nothing, so its 3 MB download starts only when a visitor presses play.
Until then, `assets/site.js` shows one large play button over the poster in place of the native controls.
The film's text is sized for a desktop embed, so on a touch screen with a narrow player that button also opens the film full screen.

## Site media

Marketplace installs clone `main`.
Every byte committed there is downloaded by everyone who adds the marketplace, and every new version of a file is downloaded again on each update.
Claude Code and GitHub Copilot CLI clone only the default branch, so the site keeps its large binary files, the explainer video and its poster, on the `site-media` branch instead.
That branch is never merged.

- `site/media.json` pins each file: where the site serves it, its path on `site-media`, its SHA-256 hash, and its size.
- `node site/fetch-media.js` fetches only the tip of `site-media` from the public repository and writes the pinned files to `site/media/`, which Git ignores.
  It fetches into a temporary repository and deletes it, so it never changes your clone.
  `--from <remote or path>` fetches from somewhere else, for example `--from .` for a local branch you have not pushed yet.
- `node site/build.js` checks each file's hash and copies it into the site.
  A different file stops the build, and `--require-media` also stops it when a file is missing.
  The workflow fetches the media and builds with `--require-media` on every pull request and deploy.
- A test fails if anyone commits audio, video, or a file over 256 KB under `site/`.

Files on `site-media` are named by their hash, so a new version sits next to the old one.
To publish one:

1. Name each new file after the first 12 characters of its SHA-256 hash, such as `video/plugins-and-skills-51f78cf58fab.mp4`, and update its entry in `site/media.json`.
   This prints a file's hash and size on any system:

   ```bash
   node -e "const d = require('fs').readFileSync(process.argv[1]); console.log(require('crypto').createHash('sha256').update(d).digest('hex'), d.length)" <file>
   ```

   For a new video, also update the captions and `video.transcript` in `catalog.json` to match it.
2. Commit the new files to `site-media` and push it, from the repository root:

   ```bash
   git fetch origin site-media
   git worktree add --detach ../site-media-worktree origin/site-media
   ```

   Copy the new files to `../site-media-worktree/video/`, then:

   ```bash
   git -C ../site-media-worktree add video
   git -C ../site-media-worktree commit -m "Add the new explainer video"
   git -C ../site-media-worktree push origin HEAD:site-media
   git worktree remove ../site-media-worktree
   ```

3. Open the pull request on `main` with the new `site/media.json`.
   `main` keeps deploying the files it pins until that pull request merges.

Keep old files on `site-media` until `main` no longer pins them.

## Check a design change

To check a change, run the Power Pages design capture against a local preview:

```bash
node plugins/power-pages/scripts/capture-design-review.js --input - --axe <<'REQUEST'
{"url": "http://localhost:8080/", "routes": ["/", "/plugins/model-apps/"]}
REQUEST
```

## Add or change a plugin

1. Add an entry to `site/catalog.json` with the plugin's marketplace name and its Microsoft `product`.
   The build fails if a marketplace plugin has no entry, if an entry names a plugin that isn't in the marketplace, or if a listed skill has no `skills/<name>/SKILL.md`.
2. Add the plugin's install links to the README.
   Run the tests to see which links are missing.
3. Run the build and look at the new page.

## How the install buttons work

Each button uses a link handler that the assistant already registers, so a click never installs anything by itself:

- **Claude Code** registers `claude-cli://` links.
  The link opens a terminal with `/plugin install <name> --marketplace microsoft/power-platform-skills` typed in, and the user presses Enter.
  GitHub removes `claude-cli:` links from Markdown, so README links go through the site's `install/` page, which only accepts plugin names from the marketplace.
- **The GitHub Copilot app** accepts `ghapp://plugins/...` links through GitHub's https launcher and asks the user to confirm.
- **GitHub Copilot CLI** has no link handler, so the site offers commands to copy.
