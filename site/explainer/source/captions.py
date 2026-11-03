"""Writes WebVTT captions from timeline.json, so captions use the exact approved wording and
the same sentence timings the picture follows.

Captions are at most two lines of about 42 characters, the common guideline for readable
captions. A sentence too long for that is split into two cues at a comma.
"""

import json

from project import PUBLISHED, PUBLISHED_CAPTIONS, TIMELINE

MAX_LINE = 42


def stamp(seconds):
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


# Names that must never be split across caption lines.
KEEP_TOGETHER = ("Power Platform", "Power Pages", "AI assistant")


def lines(text):
    """One line when it fits; otherwise the most balanced two-line break between words that
    does not split a product name."""
    if len(text) <= MAX_LINE:
        return [text]
    words = text.split()
    best = None
    for i in range(1, len(words)):
        first, second = " ".join(words[:i]), " ".join(words[i:])
        if len(first) > MAX_LINE or len(second) > MAX_LINE:
            continue
        if any(name.split()[0] == words[i - 1] and name.split()[1] == words[i] for name in KEEP_TOGETHER):
            continue
        score = abs(len(first) - len(second))
        if best is None or score < best[0]:
            best = (score, [first, second])
    return best[1] if best else [text]


def split_sentence(text):
    """Splits a sentence too long for one two-line caption at the comma nearest its middle."""
    if len(text) <= 2 * MAX_LINE - 6:
        return [text]
    commas = [i for i, ch in enumerate(text) if ch == ","]
    if not commas:
        return [text]
    cut = min(commas, key=lambda i: abs(i - len(text) / 2)) + 1
    return [text[:cut].strip(), text[cut:].strip()]


def main():
    timeline = json.loads(TIMELINE.read_text(encoding="utf-8"))
    cues = []
    for item in timeline["sentences"]:
        parts = split_sentence(item["text"])
        # Time each part by its share of the characters, which tracks speech closely enough
        # for a caption boundary.
        at = item["start"]
        for part in parts:
            share = len(part) / sum(len(p) for p in parts)
            end = at + (item["end"] - item["start"]) * share
            cues.append((at, end, lines(part)))
            at = end
    body = ["WEBVTT", ""]
    for index, (start, end, text) in enumerate(cues):
        # Hold each caption a little past the last word, but never into the next caption.
        next_start = cues[index + 1][0] if index + 1 < len(cues) else end + 1
        body += [f"{stamp(start)} --> {stamp(min(end + 0.25, next_start))}", *text, ""]
    PUBLISHED.mkdir(parents=True, exist_ok=True)
    PUBLISHED_CAPTIONS.write_text("\n".join(body), encoding="utf-8")
    print(f"wrote {len(cues)} captions to {PUBLISHED_CAPTIONS}")


if __name__ == "__main__":
    main()
