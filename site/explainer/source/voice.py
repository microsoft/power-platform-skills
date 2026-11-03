"""Generates the narration with local Kokoro TTS and records when each sentence is spoken.

Each sentence is synthesized with the same voice and speed, then joined with fixed pauses:
a short one inside a paragraph and a longer one between paragraphs. Kokoro already splits
long input into separate phoneme batches internally, so per-sentence synthesis keeps the
same acoustic result while giving exact sentence timings for the picture to follow, without
a speech recognizer guessing at product names.

Outputs (paths in project.py):
  build/Narration-original.wav   the unmodified 24 kHz voice
  build/Voiceover.wav            48 kHz stereo, leading silence added, for the mix
  timeline.json                  sentence start and end times on the final timeline (committed)
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import espeakng_loader
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from kokoro_onnx.config import EspeakConfig

from project import BUILD, MODELS, NARRATION, NARRATION_ORIGINAL, TIMELINE, VOICEOVER

VOICE = "af_heart"
SPEED = 0.94
LEAD_IN = 0.9           # seconds of picture before the first word
SENTENCE_GAP = 0.32     # pause between sentences in one paragraph
PARAGRAPH_GAP = 0.62    # pause between paragraphs
TAIL = 1.6              # seconds after the last word, for the end card


def sentences(text):
    """Split into paragraphs, then sentences. Sentence ends are ., ?, or ! followed by a space."""
    paragraphs = [p.strip() for p in text.strip().split("\n\n") if p.strip()]
    return [re.split(r"(?<=[.?!])\s+", " ".join(p.split())) for p in paragraphs]


def trim(audio, rate, threshold=0.004, pad=0.03):
    """Removes leading and trailing near-silence, keeping a few ms so consonants stay whole."""
    loud = np.flatnonzero(np.abs(audio) > threshold)
    if loud.size == 0:
        return audio
    start = max(0, loud[0] - int(pad * rate))
    end = min(audio.size, loud[-1] + int(pad * rate))
    return audio[start:end]


def espeak_config():
    """Points espeak-ng at a copy of its bundled data on a short path.

    espeak-ng copies the data path into a fixed-size buffer (about 160 bytes in this build) and
    silently truncates longer paths, then falls back to the path compiled into the library on
    the build machine and exits the process:
      Error processing file '/Users/runner/work/espeakng-loader/.../espeak-ng-data/phontab'
    A virtual environment in a deep project folder easily exceeds that. A symlink does not help,
    because phonemizer resolves the data path to its real location before passing it on, so the
    data is copied (about 20 MB, once) to a short folder in the user cache instead.
    """
    data = espeakng_loader.get_data_path()
    if len(data) < 120:
        return EspeakConfig(data_path=data)
    target = Path.home() / ".cache" / "kokoro-espeak" / "espeak-ng-data"
    marker = target / ".source"
    if not (marker.exists() and marker.read_text(encoding="utf-8") == data):
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(data, target)
        marker.write_text(data, encoding="utf-8")
    return EspeakConfig(data_path=str(target))


def main():
    engine = Kokoro(
        str(MODELS / "kokoro-v1.0.onnx"),
        str(MODELS / "voices-v1.0.bin"),
        espeak_config=espeak_config(),
    )
    paragraphs = sentences(NARRATION.read_text(encoding="utf-8"))

    rate = None
    pieces = []
    timeline = []
    cursor = 0.0
    for p_index, paragraph in enumerate(paragraphs):
        for s_index, sentence in enumerate(paragraph):
            audio, rate = engine.create(sentence, voice=VOICE, speed=SPEED, lang="en-us")
            audio = trim(np.asarray(audio, dtype=np.float32), rate)
            if pieces:
                gap = SENTENCE_GAP if s_index > 0 else PARAGRAPH_GAP
                pieces.append(np.zeros(int(gap * rate), dtype=np.float32))
                cursor += gap
            start = cursor
            pieces.append(audio)
            cursor += audio.size / rate
            timeline.append({
                "id": f"s{len(timeline) + 1}",
                "paragraph": p_index + 1,
                "text": sentence,
                "start": round(start + LEAD_IN, 3),
                "end": round(cursor + LEAD_IN, 3),
            })

    voice = np.concatenate(pieces)
    BUILD.mkdir(parents=True, exist_ok=True)
    sf.write(NARRATION_ORIGINAL, voice, rate)

    duration = round(cursor + LEAD_IN + TAIL, 3)
    # Resample to 48 kHz stereo and place the lead-in silence with FFmpeg's built-in
    # resampler, set to high quality (soxr is not compiled into every FFmpeg build).
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-i", str(NARRATION_ORIGINAL),
        "-af", f"aresample=48000:filter_size=64:phase_shift=10:cutoff=0.97,adelay={int(LEAD_IN * 1000)}:all=1,apad=whole_dur={duration}",
        "-ac", "2", "-c:a", "pcm_s24le", str(VOICEOVER),
    ], check=True)

    TIMELINE.write_text(json.dumps({
        "voice": VOICE, "speed": SPEED, "duration": duration, "sentences": timeline,
    }, indent=2) + "\n", encoding="utf-8")
    for item in timeline:
        print(f"{item['id']:>4} {item['start']:6.2f}-{item['end']:6.2f}  {item['text']}")
    print("duration", duration)


if __name__ == "__main__":
    main()
