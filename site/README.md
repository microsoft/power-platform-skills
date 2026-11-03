# Showcase site

The source for the plugin showcase at <https://microsoft.github.io/power-platform-skills/>.
It is a static site with no dependencies beyond Node.js.

## Build and preview

```bash
node site/build.js
node --test site/tests/site.test.js
```

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
[`site/explainer`](explainer/README.md) generates the video, its captions, and its poster into `assets/video/`, and its README explains how to change and re-render it.
The page builds the transcript from the film's `timeline.json` and `Descriptions.txt`, so it has both the narration and a description of what is on screen.
A test fails if the transcript, the captions, and the script disagree, if the descriptions miss text the film shows, or if the film shows a Power Pages skill that no longer exists.

The video never autoplays and preloads nothing, so its 3 MB download starts only when a visitor presses play.
Until then, `assets/site.js` shows one large play button over the poster in place of the native controls.
The film's text is sized for a desktop embed, so on a touch screen with a narrow player that button also opens the film full screen.

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
