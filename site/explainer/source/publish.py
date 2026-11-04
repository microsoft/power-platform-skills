"""Renders the film and writes the files the site ships, then checks them.

Steps:
  1. Render the picture as a 1080p60 master (CRF 17) and mux it with build/Final-mix.wav.
  2. Encode the web copy from that master. CRF 22 keeps the film at about 3 MB while text stays
     sharp on high-density screens, where the site shows it about 1,300 device pixels wide.
     Every visitor who presses play downloads it, so it is worth keeping small.
  3. Write the poster (the summary frame, which answers the question even before anyone plays
     it) and the captions.
  4. Check frame count, a clean decode, and loudness, so a broken file cannot ship.
  5. Pin the video and poster: copy them into site/media under content-hashed names, the layout
     of the site-media branch, and record their hashes in site/media.json.

Run audio.py first; this script reads its mix. See ../README.md.
"""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import captions  # noqa: E402
import film  # noqa: E402
from project import (  # noqa: E402
    BUILD, FINAL_MIX, MASTER, MEDIA, MEDIA_MANIFEST, SITE_PATHS, WEB_POSTER, WEB_VIDEO,
)

# The summary: plugin card, all five skills, and both labels, after the lit sweep has finished
# and before the end card starts.
POSTER_TIME = film.T["end"] - 0.4


def run(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def loudness(path):
    """Integrated loudness and true peak, measured the same way audio.py masters."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path), "-vn", "-af",
         "loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True).stderr
    stats = json.loads(out[out.rindex("{"):out.rindex("}") + 1])
    return float(stats["input_i"]), float(stats["input_tp"])


def frame_count(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets,width,height,r_frame_rate", "-of", "json", str(path)],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)["streams"][0]


def pin():
    """Copies the web video and poster into site/media as <name>-<first 12 hex of sha256><ext>
    and writes site/media.json. A new render gets new names, so the site-media branch can hold
    it next to the version main still uses."""
    files = []
    for local, site_path in SITE_PATHS.items():
        data = local.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        source = f"video/{local.stem}-{digest[:12]}{local.suffix}"
        target = MEDIA / source
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(local, target)
        files.append({"path": site_path, "source": source, "sha256": digest, "bytes": len(data)})
    MEDIA_MANIFEST.write_text(json.dumps({"branch": "site-media", "files": files}, indent=2) + "\n", encoding="utf-8")
    for item in files:
        print(f"pinned {item['source']}")


def main():
    if not FINAL_MIX.exists():
        raise SystemExit(f"{FINAL_MIX} is missing. Run source/audio.py first.")
    BUILD.mkdir(parents=True, exist_ok=True)

    picture = BUILD / "video-only.mp4"
    film.render(0, film.DURATION, picture)
    run("-i", str(picture), "-i", str(FINAL_MIX), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", str(MASTER))
    run("-i", str(picture), "-i", str(FINAL_MIX), "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", str(WEB_VIDEO))

    poster = film.frame_at(POSTER_TIME).resize((1280, 720), Image.LANCZOS)
    poster.save(WEB_POSTER, quality=86, method=6)
    captions.main()

    expected = round(film.DURATION * film.FPS)
    for path in (MASTER, WEB_VIDEO):
        stream = frame_count(path)
        frames = int(stream["nb_read_packets"])
        # The last frame can round either way against the audio length.
        if abs(frames - expected) > 1 or (stream["width"], stream["height"]) != (film.W, film.H):
            raise SystemExit(f"{path.name}: {frames} frames at {stream['width']}x{stream['height']}, expected {expected}")
        run("-xerror", "-i", str(path), "-f", "null", "-")
        lufs, peak = loudness(path)
        if not (-17 <= lufs <= -15 and peak <= -1.0):
            raise SystemExit(f"{path.name}: {lufs} LUFS, {peak} dBTP; expected about -16 LUFS and at most -1 dBTP")
        print(f"{path.name}: {frames} frames, {lufs} LUFS, {peak} dBTP, {path.stat().st_size / 1e6:.2f} MB")

    pin()


if __name__ == "__main__":
    main()
