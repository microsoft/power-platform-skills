"""Paths shared by every step of the explainer film, resolved from this file so the scripts work
from any current directory and on any platform.

Committed inputs live in site/explainer. Everything a step generates, except timeline.json and
the published files, goes to site/explainer/build, which Git ignores: the WAV stems and the
1080p master are large and can be regenerated.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]      # site/explainer
SITE = ROOT.parent                              # site
MODELS = ROOT / "models"                        # Kokoro weights; downloaded, never committed
BUILD = ROOT / "build"
FRAMES = BUILD / "frames"

NARRATION = ROOT / "Narration.txt"
TIMELINE = ROOT / "timeline.json"
ICON = ROOT / "power-pages.png"
# The renderer uses the site's own self-hosted fonts, so the film and the page share type.
FONTS = SITE / "assets" / "fonts"

NARRATION_ORIGINAL = BUILD / "Narration-original.wav"
VOICEOVER = BUILD / "Voiceover.wav"
MUSIC_AND_EFFECTS = BUILD / "Music-and-effects.wav"
PREMASTER = BUILD / "premaster.wav"
FINAL_MIX = BUILD / "Final-mix.wav"
MASTER = BUILD / "Final.mp4"

# The web copies, before they are pinned and handed to the site.
WEB_VIDEO = BUILD / "plugins-and-skills.mp4"
WEB_POSTER = BUILD / "plugins-and-skills-poster.webp"

# The captions are text, so they are committed with the site.
PUBLISHED = SITE / "assets" / "video"
PUBLISHED_CAPTIONS = PUBLISHED / "plugins-and-skills.vtt"

# The video and poster are not committed on main, which every marketplace install clones. They go
# to site/media, a local copy of the site-media branch, and site/media.json pins them by hash.
# See site/lib/media.js. The "path" values are the URLs site/lib/render.js uses.
MEDIA = SITE / "media"
MEDIA_MANIFEST = SITE / "media.json"
SITE_PATHS = {
    WEB_VIDEO: "assets/video/plugins-and-skills.mp4",
    WEB_POSTER: "assets/video/plugins-and-skills-poster.webp",
}
