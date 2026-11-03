# Explainer film: "What are plugins and skills?"

This folder makes the 35-second film in the Questions section of the [showcase site](../README.md).
Everything in it is generated here.
A local text-to-speech model reads the narration, a Python renderer draws every frame, and code synthesizes the music and sound effects.
Nothing is recorded, licensed, or sent to an online service.

## What ships

`source/publish.py` writes three files to `site/assets/video/`, and the site build copies them as-is:

- `plugins-and-skills.mp4`: 1920x1080, 60 fps, H.264 with AAC audio, about 3 MB.
- `plugins-and-skills.vtt`: English captions, on by default.
- `plugins-and-skills-poster.webp`: the poster, the film's summary frame.

`site/build.js` builds the page's transcript from `timeline.json` and `Descriptions.txt`: each paragraph of narration, then what is on screen while it is spoken.
The film shows examples the narration never says aloud, such as the skill names and their steps, so the descriptions carry them for anyone who cannot see the video.
The site tests check that the transcript, the captions, and the narration use the same words, that `Descriptions.txt` mentions every piece of text `film.py` draws, and that every skill the film shows still exists in the Power Pages plugin.

## What's here

| Path | What it is |
| --- | --- |
| `Narration.txt` | The script. A blank line separates paragraphs. |
| `Descriptions.txt` | What is on screen during each paragraph of the narration, one paragraph each, for the transcript. |
| `timeline.json` | When each sentence is spoken. `voice.py` writes it, and it is committed because the picture, captions, and transcript all follow it. |
| `power-pages.png` | The Power Pages icon at 256 px, rendered from `site/assets/brand/power-pages.svg`. The terms in [`site/assets/brand/README.md`](../assets/brand/README.md) apply. |
| `requirements.txt` | Pinned Python packages. |
| `source/project.py` | Every path the other scripts use. |
| `source/voice.py` | Narration: synthesizes each sentence and records its timing. |
| `source/film.py` | Picture: every frame as a function of time, with preview and render commands. |
| `source/audio.py` | Score and sound effects, the mix, and loudness mastering. |
| `source/captions.py` | WebVTT captions from `timeline.json`. |
| `source/publish.py` | Renders the film, writes the three site files, and checks them. |

Generated stems, frames, and the full-quality master go to `build/`, and the voice model goes to `models/`.
Git ignores both.

## Regenerate the film

You need Python 3.13 (the current film was made with it) and FFmpeg on your `PATH`.
Run every command from this folder.
On Windows, use `.venv\Scripts\python` where these use `.venv/bin/python`, and type `curl.exe` in PowerShell, where `curl` is an alias for a different command.

1. Install the packages and download the voice model, about 350 MB:

   ```bash
   python -m venv .venv
   .venv/bin/python -m pip install -r requirements.txt
   curl -L --create-dirs -o models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx
   curl -L --create-dirs -o models/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin
   ```

   The release publishes these SHA-256 digests, so you can check the downloads:

   - `kokoro-v1.0.onnx`: `beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a`
   - `voices-v1.0.bin`: `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d`

2. Generate the narration: `.venv/bin/python source/voice.py`.
   It rewrites `timeline.json`.
   Even with unchanged words, expect sentence times to move by a few milliseconds, because ONNX Runtime on a CPU is not bit-exact from run to run.
   That is less than one frame.
3. Build the soundtrack: `.venv/bin/python source/audio.py`.
4. Check the picture at the moments you changed: `.venv/bin/python source/film.py preview 10.6 17.5 31.6`.
   It writes full-size frames and a contact sheet to `build/frames/`.
5. Publish: `.venv/bin/python source/publish.py`.
   Rendering takes about two and a half minutes.
   The script stops with an error if the frame count, the decode, or the loudness is wrong.
6. Run `node site/build.js` and `node --test site/tests/site.test.js` from the repository root, then watch the film on a local preview of the site.

To change what a scene shows, edit `source/film.py`, and update `Descriptions.txt` to match.
The named moments in `T` tie each action to a sentence of the narration, and `audio.py` times its sound effects from the same moments, so picture and sound stay in sync when the narration changes.

## How it is made

- **Picture.** Each frame is drawn at twice the output size and reduced, which smooths edges and allows half-pixel motion.
  The film uses the site's dark-theme colors and its self-hosted fonts.
  A faint per-frame dither keeps the dark gradients from banding after H.264 compression.
- **Voice.** Kokoro 82M with the `af_heart` voice at 0.94 speed.
  Each sentence is synthesized separately and joined with fixed pauses, which gives exact sentence timings without a speech recognizer guessing at product names.
- **Sound.** An original score (pads, plucks, a soft pulse, and a closing bell) and interaction sounds, all synthesized with a fixed random seed, so every run produces the same soundtrack.
  The music drops under the voice, and the mix is mastered to -16 LUFS integrated and -1.5 dBTP true peak.

## What is real and what is illustrative

- The plugin, its five skills, and the steps shown for `/create-site` and `/deploy-site` come from the Power Pages plugin's skills.
- The assistant window, the "Allow this command?" prompt, and the `npm run build` command are illustrations.
  They are not the interface of any one AI assistant.
- "It asks before it runs commands or changes files" describes the assistants' default permission settings, which a user can change.

## Licenses

- Kokoro 82M model: Apache 2.0. kokoro-onnx runtime: MIT.
  The model files are downloaded, never committed.
- kokoro-onnx installs espeak-ng (GPL-3.0) to turn text into phonemes.
  It runs only while the narration is generated, and nothing from it ships.
- Fonts: the site's own, under the SIL Open Font License (`site/assets/fonts/`).
- Power Pages icon: Microsoft's official product icon, under the terms in `site/assets/brand/README.md`.
- Music and sound effects: original, generated by `source/audio.py`.
