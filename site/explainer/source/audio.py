"""Builds the original score and sound effects, mixes them under the narration, and masters.

Everything is synthesized here with a seeded generator, so the soundtrack is original, free of
third-party rights, and identical on every run. Effect times come from film.T, the same
named moments the picture uses, so sound and picture cannot drift apart.

Usage (see ../README.md for setup):
  python source/audio.py                 full soundtrack, build/Final-mix.wav
  python source/audio.py 3.4 16.9 x.wav  mastered excerpt for that range
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
import film  # noqa: E402 - shares the timeline and named moments

from project import BUILD, FINAL_MIX, MUSIC_AND_EFFECTS, PREMASTER, VOICEOVER  # noqa: E402

RATE = 48000
BPM = 96
BEAT = 60 / BPM
RNG = np.random.default_rng(20261103)


def silence(duration):
    return np.zeros((int(duration * RATE), 2), np.float32)


def add(buffer, clip, at, gain=1.0, pan=0.0):
    """Adds a mono or stereo clip at a time in seconds, with constant-power panning."""
    start = int(at * RATE)
    if start >= len(buffer):
        return
    if clip.ndim == 1:
        left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        clip = np.stack([clip * left, clip * right], axis=1) * np.sqrt(2)
    end = min(len(buffer), start + len(clip))
    buffer[start:end] += clip[: end - start] * gain


def envelope(n, attack, release, total):
    t = np.arange(n) / RATE
    env = np.minimum(1, t / max(attack, 1e-4))
    env *= np.clip((total - t) / max(release, 1e-4), 0, 1)
    return env


def band_noise(duration, low, high):
    """White noise shaped to a band in the frequency domain (a gentle, ringing-free filter)."""
    n = int(duration * RATE)
    spectrum = np.fft.rfft(RNG.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / RATE)
    shape = np.exp(-0.5 * ((np.log2(np.maximum(freqs, 1)) - np.log2(np.sqrt(low * high))) / (np.log2(high / low) / 2)) ** 2)
    out = np.fft.irfft(spectrum * shape, n)
    return (out / (np.abs(out).max() + 1e-9)).astype(np.float32)


def tone(freq, duration, decay, harmonics=(1.0, 0.18, 0.06)):
    t = np.arange(int(duration * RATE)) / RATE
    wave = sum(a * np.sin(2 * np.pi * freq * (i + 1) * t) for i, a in enumerate(harmonics))
    return (wave * np.exp(-t / decay) * np.minimum(1, t / 0.004)).astype(np.float32)


# ── Score ─────────────────────────────────────────────────────────

NOTE = {"G2": 98.0, "A2": 110.0, "B2": 123.47, "D3": 146.83, "E3": 164.81, "F#3": 185.0, "G3": 196.0,
        "A3": 220.0, "B3": 246.94, "C#4": 277.18, "D4": 293.66, "E4": 329.63, "F#4": 369.99, "A4": 440.0}
CHORDS = [
    ["D3", "F#3", "A3", "C#4", "E4"],   # Dmaj9
    ["B2", "D3", "F#3", "A3", "C#4"],   # Bm9
    ["G2", "B2", "D3", "F#3", "A3"],    # Gmaj9
    ["A2", "D3", "E3", "F#3", "B3"],    # A6sus
]
CHORD_LEN = 8 * BEAT  # two bars


def pad(duration):
    """Slow detuned pad that crossfades between chords; brightest in the middle of the film."""
    out = silence(duration)
    n_chords = int(np.ceil(duration / CHORD_LEN)) + 1
    for k in range(n_chords):
        start = k * CHORD_LEN - 0.6
        notes = CHORDS[k % len(CHORDS)] if start < duration - 3.2 else CHORDS[0]
        length = CHORD_LEN + 1.2
        t = np.arange(int(length * RATE)) / RATE
        env = envelope(len(t), 0.9, 1.2, length)
        for j, name in enumerate(notes):
            f = NOTE[name]
            for detune, pan in ((-0.0025, -0.5), (0.0025, 0.5)):
                phase = RNG.random() * 2 * np.pi
                wave = np.sin(2 * np.pi * f * (1 + detune) * t + phase) + 0.12 * np.sin(4 * np.pi * f * t + phase)
                add(out, (wave * env).astype(np.float32), max(0, start), 0.028 / (1 + j * 0.15), pan)
    return out


def plucks(duration, start, stop, density_change):
    """Arpeggiated chord tones an octave up, on eighth notes, sparser before density_change."""
    out = silence(duration)
    step = BEAT / 2
    k = int(np.ceil(start / step))
    while k * step < stop:
        at = k * step
        sparse = at < density_change
        if not sparse or k % 2 == 0:
            notes = CHORDS[int(at // CHORD_LEN) % len(CHORDS)]
            name = notes[(k * 2 + k // 3) % len(notes)]
            gain = 0.05 * (0.75 + 0.25 * RNG.random()) * (0.8 if sparse else 1.0)
            add(out, tone(NOTE[name] * 2, 1.2, 0.32), at, gain, pan=0.35 * np.sin(k * 1.7))
        k += 1
    return out


def pulse(duration, start, stop):
    """A soft low thump on beats one and three, for momentum in the second half."""
    out = silence(duration)
    t = np.arange(int(0.35 * RATE)) / RATE
    freq = 46 + 54 * np.exp(-t / 0.05)
    thump = (np.sin(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t / 0.12)).astype(np.float32)
    k = int(np.ceil(start / (2 * BEAT)))
    while k * 2 * BEAT < stop:
        add(out, thump, k * 2 * BEAT, 0.12)
        k += 1
    return out


def ending(duration, at):
    """The resolve: a bell-like Dmaj9 spread across the last seconds."""
    out = silence(duration)
    for i, name in enumerate(["D4", "F#4", "A4", "E4"]):
        add(out, tone(NOTE[name] * 2, 2.6, 0.9, (1.0, 0.3, 0.12, 0.05)), at + i * 0.11, 0.045, pan=-0.3 + i * 0.2)
    return out


# ── Effects ───────────────────────────────────────────────────────

def whoosh(duration, rising=True):
    n = int(duration * RATE)
    noise = band_noise(duration, 300, 4000)
    shape = np.linspace(0, 1, n) ** 1.6 if rising else np.linspace(1, 0, n) ** 1.6
    return noise * shape * envelope(n, 0.05, 0.15, duration)


def dock():
    thump = tone(110, 0.25, 0.06, (1.0, 0.25))
    click = band_noise(0.03, 2000, 9000) * np.exp(-np.arange(int(0.03 * RATE)) / RATE / 0.006)
    chime = tone(880, 1.0, 0.35) * 0.5 + tone(1318.5, 1.0, 0.3) * 0.35
    out = np.zeros(len(chime), np.float32)
    out[: len(thump)] += thump * 0.9
    out[: len(click)] += click * 0.35
    out += chime * 0.45
    return out


def tick(freq):
    body = tone(freq, 0.3, 0.07, (1.0, 0.2))
    click = band_noise(0.012, 3000, 10000) * 0.25
    body[: len(click)] += click
    return body


def effects(duration):
    out = silence(duration)
    T = film.T
    add(out, whoosh(0.9, rising=True) * 0.18, T["window_in"] - 0.2)
    add(out, whoosh(T["dock"] - T["card_fly"], rising=True) * 0.22, T["card_fly"], pan=0.3)
    add(out, dock(), T["dock"], 0.55)
    for i in range(len(film.SKILLS)):
        add(out, tick(659.25 * 2 ** (i * 2 / 12)), film.chip_time(i) + 0.32, 0.32, pan=0.2)
    add(out, whoosh(0.75, rising=True) * 0.2, T["morph"] - 0.1)
    for i in range(len(film.CREATE_STEPS)):
        add(out, tick(987.77 * 2 ** (i / 12)), T["step0"] + i * T["step_step"] + 0.05, 0.22, pan=-0.15)
    add(out, tone(1046.5, 1.2, 0.4) * 0.5 + tone(1568, 1.2, 0.3) * 0.3, T["badge"] + 0.15, 0.3)
    # deploy-site arrives and lists its steps
    add(out, whoosh(0.6, rising=True) * 0.2, T["split"] - 0.05, pan=0.4)
    for i in range(len(film.DEPLOY_STEPS)):
        add(out, tick(987.77 * 2 ** ((i + 2) / 12)), T["deploy_step0"] + i * 0.32 + 0.05, 0.2, pan=0.2)
    # cards return to their rows, then the skills move to the rail
    add(out, whoosh(0.5, rising=False) * 0.16, T["collapse"])
    add(out, whoosh(0.7, rising=False) * 0.1, T["to_rail"], pan=-0.4)
    # typing the request: one soft key click per character, slightly uneven
    count = len(film.REQUEST)
    for i in range(count):
        at = T["type0"] + 1.35 * i / count
        add(out, band_noise(0.018, 1500, 6000) * np.exp(-np.arange(int(0.018 * RATE)) / RATE / 0.004),
            at, 0.05 * (0.7 + 0.6 * RNG.random()), pan=0.15)
    add(out, tone(784, 0.4, 0.08, (1.0, 0.3)), T["send"], 0.22)
    # the pick and the reply
    add(out, tone(1174.7, 1.0, 0.35) * 0.5 + tone(1760, 1.0, 0.25) * 0.3, T["pick"] + 0.1, 0.28)
    for i in range(len(film.REPLY_STEPS)):
        add(out, tick(880 * 2 ** (i * 2 / 12)), T["reply"] + 0.4 + i * 0.42, 0.2)
    # asking permission, and the approval
    add(out, tone(659.25, 0.6, 0.18, (1.0, 0.25)) * 0.6 + tone(987.77, 0.6, 0.15) * 0.4, T["ask"] + 0.05, 0.3)
    add(out, dock() * 0.7, T["allow"], 0.35)
    # to the summary, then each skill lights as "skills" is said
    add(out, whoosh(0.9, rising=True) * 0.16, T["summary"])
    for i in range(len(film.SKILLS)):
        add(out, tick(1318.5 * 2 ** (i * 2 / 12)), T["summary_skills"] + i * 0.1, 0.12, pan=0.3)
    add(out, whoosh(0.6, rising=False) * 0.12, T["end"])
    return out


# ── Mix and master ────────────────────────────────────────────────

def voice_envelope(voice):
    """Narration loudness at 100 Hz, smoothed with a fast attack and a slow release, 0..1."""
    hop = RATE // 100
    frames = np.sqrt(np.mean(voice[: len(voice) // hop * hop].reshape(-1, hop, 2) ** 2, axis=(1, 2)))
    env = np.zeros_like(frames)
    level = 0.0
    for i, value in enumerate(frames):
        coeff = 0.5 if value > level else 0.04
        level += (value - level) * coeff
        env[i] = level
    env = env / (env.max() + 1e-9)
    return np.interp(np.arange(len(voice)) / hop, np.arange(len(env)), env).astype(np.float32)


def build():
    voice, rate = sf.read(VOICEOVER, dtype="float32", always_2d=True)
    assert rate == RATE, rate
    duration = len(voice) / RATE
    music = pad(duration)
    music += plucks(duration, film.SEN["s3"]["start"] - 0.4, film.SEN["s10"]["start"] - 0.2, film.SEN["s7"]["start"])
    music += pulse(duration, film.SEN["s7"]["start"] - 0.2, film.SEN["s10"]["start"] - 0.2)
    music += ending(duration, film.SEN["s10"]["start"])
    # Fade the score in and out at the film's edges.
    n = len(music)
    music *= envelope(n, 1.2, 1.4, duration)[:, None]
    # Duck the score about 7 dB under speech; effects duck less so actions stay audible.
    env = voice_envelope(voice)[:, None]
    music_ducked = music * 10 ** (-7 * env / 20)
    fx = effects(duration) * 10 ** (-3 * env / 20)
    music_fx = music_ducked + fx
    BUILD.mkdir(parents=True, exist_ok=True)
    sf.write(MUSIC_AND_EFFECTS, music_fx, RATE, subtype="PCM_24")
    sf.write(PREMASTER, voice + music_fx, RATE, subtype="FLOAT")
    print(f"built {duration:.2f}s soundtrack")


def master(source, target, start=None, end=None):
    """Two-pass EBU R128 loudness normalization to -16 LUFS integrated, -1.5 dBTP."""
    trim = []
    fades = ""
    if start is not None:
        trim = ["-ss", f"{start}", "-to", f"{end}"]
        fades = f"afade=t=in:d=0.25,afade=t=out:st={end - start - 0.4}:d=0.4,"
    measure = subprocess.run(
        ["ffmpeg", "-hide_banner", *trim, "-i", str(source), "-af",
         f"{fades}loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True).stderr
    stats = json.loads(measure[measure.rindex("{"):measure.rindex("}") + 1])
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *trim, "-i", str(source), "-af",
         f"{fades}loudnorm=I=-16:TP=-1.5:LRA=9:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
         f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}"
         ":linear=true,aresample=48000", "-ac", "2", "-c:a", "pcm_s24le", str(target)], check=True)
    print("mastered", target)


if __name__ == "__main__":
    build()
    if len(sys.argv) == 4:
        master(PREMASTER, Path(sys.argv[3]), float(sys.argv[1]), float(sys.argv[2]))
    else:
        master(PREMASTER, FINAL_MIX)
