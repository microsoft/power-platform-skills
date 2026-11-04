# site-media

This branch holds the large files for the [Power Platform Skills site](https://microsoft.github.io/power-platform-skills/): the explainer video and its poster.
It is never merged into `main`.

Marketplace installs clone `main`, so every file there is downloaded by everyone who adds the marketplace, and every new version again on each update.
AI assistants clone only the default branch, so files kept here cost them nothing.

## How the site uses it

`site/media.json` on `main` pins each file by its SHA-256 hash and its path on this branch.
The site's deploy fetches this branch, checks every hash, and copies the files into the site.
A file that is missing or different stops the deploy.

## Adding a new version

1. Name each new file after the first 12 characters of its SHA-256 hash and update its entry in `site/media.json` on `main`, as the "Site media" section of `site/README.md` there describes.
2. Commit the new files here, next to the old ones, and push this branch.
3. Open the pull request on `main` that changes `site/media.json`.

Keep the old files until `main` no longer pins them.
`main` keeps deploying the version it pins until that pull request merges.
