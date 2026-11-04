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
[`site/explainer`](explainer/README.md) generates the video, its captions, and its poster, and its README explains how to change and re-render it.
The captions are committed in `assets/video/`; the video and poster come from the `site-media` branch.
The page builds the transcript from the film's `timeline.json` and `Descriptions.txt`, so it has both the narration and a description of what is on screen.
A test fails if the transcript, the captions, and the script disagree, if the descriptions miss text the film shows, or if the film shows a Power Pages skill that no longer exists.

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

1. Run the film's publish step, which writes the new files to `site/media/video/` and updates `site/media.json` (see [`explainer/README.md`](explainer/README.md)).
2. Commit the new files to `site-media` and push it, from the repository root:

   ```bash
   git fetch origin site-media
   git worktree add --detach ../site-media-worktree origin/site-media
   ```

   Copy the new files from `site/media/video/` to `../site-media-worktree/video/`, then:

   ```bash
   git -C ../site-media-worktree add video
   git -C ../site-media-worktree commit -m "Add the re-rendered explainer video"
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
