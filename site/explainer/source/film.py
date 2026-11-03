"""Renders the "What are plugins and skills?" film.

Every frame is a pure function of time (frame_at), so any range can be previewed or rendered
on its own and the result is always the same. Frames are drawn at 2x and reduced to 1080p,
which anti-aliases shapes and gives half-pixel motion.

Usage (see ../README.md for setup):
  python source/film.py preview 4.5 8 12 15        keyframes and a contact sheet in build/frames
  python source/film.py render 3.4 16.9 out.mp4    video only, H.264
"""

import json
import math
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from project import FONTS, FRAMES, ICON, TIMELINE as TIMELINE_FILE

W, H, FPS, S = 1920, 1080, 60, 2

TIMELINE = json.loads(TIMELINE_FILE.read_text(encoding="utf-8"))
SEN = {item["id"]: item for item in TIMELINE["sentences"]}
DURATION = TIMELINE["duration"]

# The site's dark theme (site/assets/styles.css).
BG = (8, 22, 31)
SURFACE = (14, 33, 43)
RAISED = (18, 44, 56)
SUNKEN = (6, 18, 25)
TEXT = (231, 241, 241)
MUTED = (166, 186, 192)
BORDER = (33, 60, 72)
BORDER_STRONG = (55, 92, 106)
PRIMARY = (69, 211, 189)
ON_PRIMARY = (4, 33, 30)
SUCCESS = (143, 240, 170)
# Stops of the Power Platform ribbon gradient.
RIBBON = [(176, 240, 152), (82, 209, 124), (32, 172, 157), (26, 127, 124)]

# The site's self-hosted WOFF2 files (variable, Weight axis). FreeType reads WOFF2 directly
# and renders them pixel-identical to the upstream TTFs.
FONT_FILES = {"display": "schibsted-grotesk-latin.woff2", "body": "public-sans-latin.woff2",
              "mono": "jetbrains-mono-latin.woff2"}

# Layout, in 1080p units. Type is sized for a small embed: the site shows the film about
# 700 px wide, so 1080p text shrinks to about a third; nothing important is under 26 px here.
WIN = (110, 80, 1810, 1000)          # assistant window
HEADER_H = 84
RAIL_W = 450
SLOT = (WIN[0] + 28, 236, WIN[0] + RAIL_W - 28, 360)
MAIN_X = WIN[0] + RAIL_W + 56
PROMPT = (MAIN_X, 890, WIN[2] - 36, 966)
CHIP_W, CHIP_H, CHIP_GAP = 880, 86, 104
CHIP_Y0 = 252

SKILLS = [
    ("/create-site", "Start a new site"),
    ("/edit-site", "Change pages"),
    ("/setup-datamodel", "Add tables"),
    ("/setup-auth", "Add sign-in"),
    ("/deploy-site", "Upload the site"),
]
CREATE_STEPS = ["Ask what the site is for", "Show you a plan to approve", "Build the site", "Ask before deploying it"]


# ── Timing helpers ───────────────────────────────────────────────

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def prog(t, a, b):
    return clamp((t - a) / (b - a)) if b > a else float(t >= a)


def ease_in(x):
    return x ** 3


def ease_out(x):
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_back(x, s=1.5):
    c = s + 1
    return 1 + c * (x - 1) ** 3 + s * (x - 1) ** 2


def lerp(a, b, x):
    return a + (b - a) * x


def lerp_rect(r1, r2, x):
    return tuple(lerp(a, b, x) for a, b in zip(r1, r2))


def mix(c1, c2, x):
    return tuple(int(round(lerp(a, b, x))) for a, b in zip(c1, c2))


def bezier(p0, p1, p2, x):
    return ((1 - x) ** 2 * p0[0] + 2 * (1 - x) * x * p1[0] + x ** 2 * p2[0],
            (1 - x) ** 2 * p0[1] + 2 * (1 - x) * x * p1[1] + x ** 2 * p2[1])


# Named moments, all derived from when each sentence is spoken.
T = {
    "window_in": 0.2,
    "card_in": SEN["s2"]["start"] - 0.15,
    "card_fly": SEN["s2"]["start"] + 0.45,
    "dock": SEN["s2"]["start"] + 1.75,
    "skills_label": SEN["s3"]["start"] + 0.3,
    "chip0": SEN["s3"]["start"] + 1.15,
    "chip_step": 0.33,
    "morph": SEN["s4"]["start"] - 0.1,
    "step0": SEN["s4"]["start"] + 1.0,
    "step_step": 0.46,
    "badge": SEN["s5"]["start"] + 0.25,
    "split": SEN["s6"]["start"] - 0.3,
    "deploy_step0": SEN["s6"]["start"] + 0.35,
    "collapse": SEN["s7"]["start"] - 0.4,
    "to_rail": SEN["s7"]["start"] + 0.1,
    "type0": SEN["s7"]["start"] + 0.7,
    "send": SEN["s7"]["start"] + 2.2,
    "pick": SEN["s7"]["start"] + 2.65,
    "reply": SEN["s7"]["start"] + 3.25,
    "ask": SEN["s8"]["start"] - 0.1,
    "allow": SEN["s8"]["end"] - 0.55,
    "summary": SEN["s9"]["start"] - 0.45,
    "plugin_label": SEN["s9"]["start"] + 0.7,
    "skills_move": SEN["s9"]["start"] - 0.3,
    "summary_skills": SEN["s9"]["start"] + 2.05,
    "end": SEN["s10"]["start"] - 0.55,
}

DEPLOY_STEPS = ["Check your sign-in and environment", "Build the site", "Upload it to Power Pages"]
REQUEST = "Create a Power Pages site for a job board"
REPLY_STEPS = ["Asked what the site is for", "Showed you a plan to approve", "Built the site"]
COMMAND = "npm run build"


# ── Drawing primitives (all inputs in 1080p units) ───────────────

@lru_cache(maxsize=None)
def font(kind, size, weight):
    f = ImageFont.truetype(str(FONTS / FONT_FILES[kind]), int(round(size * S)))
    f.set_variation_by_axes([weight])
    return f


def px(v):
    return int(round(v * S))


@lru_cache(maxsize=None)
def text_sprite(text, kind, size, weight, color):
    f = font(kind, size, weight)
    left, top, right, bottom = f.getbbox(text)
    ascent, descent = f.getmetrics()
    img = Image.new("RGBA", (right + px(4), ascent + descent + px(4)), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((0, 0), text, font=f, fill=color + (255,))
    return img


@lru_cache(maxsize=None)
def panel_sprite(w, h, radius, fill, outline=None, width=1.5, shadow=0):
    """A rounded panel, optionally with a soft navy shadow. Sizes are rounded to whole pixels
    at 2x, so morphs that change size every frame still reuse nearby sprites."""
    pad = px(shadow * 1.6) if shadow else 0
    img = Image.new("RGBA", (px(w) + 2 * pad, px(h) + 2 * pad), (0, 0, 0, 0))
    if shadow:
        sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle(
            (pad, pad + px(shadow * 0.35), pad + px(w), pad + px(h) + px(shadow * 0.35)),
            radius=px(radius), fill=(1, 8, 14, 150))
        img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(px(shadow * 0.55))))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((pad, pad, pad + px(w) - 1, pad + px(h) - 1), radius=px(radius),
                        fill=fill + (255,) if len(fill) == 3 else fill,
                        outline=(outline + (255,)) if outline else None, width=px(width) if outline else 0)
    return img, pad


def put(frame, sprite, x, y, opacity=1.0, pad=0):
    """Composites a sprite with its top-left at (x, y) in 1080p units."""
    if opacity <= 0.003:
        return
    if opacity < 0.997:
        alpha = sprite.getchannel("A").point(lambda v: int(v * opacity))
        sprite = sprite.copy()
        sprite.putalpha(alpha)
    fx, fy = px(x) - pad, px(y) - pad
    # alpha_composite needs the sprite inside the frame; crop what falls outside.
    left, top = max(0, -fx), max(0, -fy)
    right = min(sprite.width, frame.width - fx)
    bottom = min(sprite.height, frame.height - fy)
    if right <= left or bottom <= top:
        return
    if (left, top, right, bottom) != (0, 0, sprite.width, sprite.height):
        sprite = sprite.crop((left, top, right, bottom))
    frame.alpha_composite(sprite, (fx + left, fy + top))


def put_panel(frame, rect, radius, fill, outline=None, opacity=1.0, shadow=0, width=1.5):
    x0, y0, x1, y1 = rect
    # Pop-in and collapse animations pass through zero size; Pillow rejects a rectangle
    # narrower than one pixel, and nothing would be visible anyway.
    if opacity <= 0 or x1 - x0 < 1 or y1 - y0 < 1:
        return
    sprite, pad = panel_sprite(round((x1 - x0) * 2) / 2, round((y1 - y0) * 2) / 2, radius, fill, outline, width, shadow)
    put(frame, sprite, x0, y0, opacity, pad)


def put_text(frame, text, x, y, kind, size, weight, color, opacity=1.0, anchor="la"):
    sprite = text_sprite(text, kind, size, weight, color)
    if anchor[0] == "m":
        x -= sprite.width / S / 2
    elif anchor[0] == "r":
        x -= sprite.width / S
    put(frame, sprite, x, y, opacity)


def text_width(text, kind, size, weight):
    return font(kind, size, weight).getlength(text) / S


@lru_cache(maxsize=None)
def icon_sprite(size):
    img = Image.open(ICON).convert("RGBA")
    return img.resize((px(size), px(size)), Image.LANCZOS)


@lru_cache(maxsize=None)
def ring_sprite(w, h, radius, color, width):
    img = Image.new("RGBA", (px(w) + px(width) * 2, px(h) + px(width) * 2), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle(
        (px(width) // 2, px(width) // 2, img.width - px(width) // 2 - 1, img.height - px(width) // 2 - 1),
        radius=px(radius), outline=color + (255,), width=px(width))
    return img


def dashed_rect(draw, rect, radius, color, dash=10, gap=8, width=1.5):
    """Dashed outline for the empty plugin slot (straight edges only; corners stay open)."""
    x0, y0, x1, y1 = (px(v) for v in rect)
    r, w, step = px(radius), px(width), px(dash + gap)
    for x in range(x0 + r, x1 - r, step):
        draw.line((x, y0, min(x + px(dash), x1 - r), y0), fill=color, width=w)
        draw.line((x, y1, min(x + px(dash), x1 - r), y1), fill=color, width=w)
    for y in range(y0 + r, y1 - r, step):
        draw.line((x0, y, x0, min(y + px(dash), y1 - r)), fill=color, width=w)
        draw.line((x1, y, x1, min(y + px(dash), y1 - r)), fill=color, width=w)


# ── Static layers ────────────────────────────────────────────────

@lru_cache(maxsize=1)
def background():
    """Navy base, two soft glows in the ribbon's teal and green, and the site's dotted grid."""
    w, h = W * S, H * S
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.zeros((h, w, 3), np.float32) + np.array(BG, np.float32)
    for cx, cy, rad, color, strength in [
        (0.30, 0.30, 0.55, (32, 172, 157), 0.20),
        (0.78, 0.78, 0.55, (82, 209, 124), 0.12),
    ]:
        d = np.sqrt(((xs / w - cx) / 1.0) ** 2 + ((ys / h - cy) * (h / w)) ** 2) / rad
        glow = np.clip(1 - d, 0, 1) ** 2 * strength
        img += glow[..., None] * (np.array(color, np.float32) - img)
    grid = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).convert("RGBA")
    dots = Image.new("RGBA", grid.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(dots)
    step = px(30)
    for y in range(step // 2, h, step):
        for x in range(step // 2, w, step):
            d.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(231, 241, 241, 14))
    return Image.alpha_composite(grid, dots)


@lru_cache(maxsize=1)
def window_sprite():
    x0, y0, x1, y1 = WIN
    img, pad = panel_sprite(x1 - x0, y1 - y0, 26, SURFACE, BORDER, 2, shadow=44)
    img = img.copy()
    d = ImageDraw.Draw(img)
    o = lambda v: pad + px(v)  # noqa: E731 - local offset helper
    hh = HEADER_H
    # Plugins rail (drawn first so the header line crosses it)
    d.rounded_rectangle((o(0), o(hh), o(RAIL_W), o(y1 - y0) - 1), radius=px(26), fill=SUNKEN + (255,))
    d.rectangle((o(0), o(hh), o(RAIL_W), o(hh + 40)), fill=SUNKEN + (255,))
    d.rectangle((o(RAIL_W - 40), o(hh), o(RAIL_W), o(y1 - y0) - 1), fill=SUNKEN + (255,))
    d.line((o(RAIL_W), o(hh), o(RAIL_W), o(y1 - y0) - 1), fill=BORDER + (255,), width=px(2))
    d.text((o(28), o(hh + 30)), "Plugins", font=font("body", 28, 600), fill=MUTED + (255,))
    # Header
    d.line((o(0), o(hh), o(x1 - x0) - 1, o(hh)), fill=BORDER + (255,), width=px(2))
    d.ellipse((o(34), o(34), o(50), o(50)), fill=PRIMARY + (255,))
    d.text((o(66), o(22)), "Your AI assistant", font=font("body", 30, 600), fill=TEXT + (255,))
    # Prompt bar
    px0, py0, px1, py1 = (v - (x0 if i % 2 == 0 else y0) for i, v in enumerate(PROMPT))
    d.rounded_rectangle((o(px0), o(py0), o(px1), o(py1)), radius=px(16), fill=SUNKEN + (255,),
                        outline=BORDER_STRONG + (255,), width=px(2))
    return img, pad


@lru_cache(maxsize=None)
def plugin_card(glow=False, scale=1.0):
    k = scale
    w, h = (SLOT[2] - SLOT[0]) * k, (SLOT[3] - SLOT[1]) * k
    img, pad = panel_sprite(round(w * 2) / 2, round(h * 2) / 2, 18 * k, RAISED, PRIMARY if glow else BORDER_STRONG,
                            (3 if glow else 2) * k, shadow=18 * k)
    img = img.copy()
    img.alpha_composite(icon_sprite(round(70 * k)), (pad + px(24 * k), pad + px(27 * k)))
    d = ImageDraw.Draw(img)
    d.text((pad + px(114 * k), pad + px(20 * k)), "Power Pages", font=font("display", round(38 * k), 700), fill=TEXT + (255,))
    d.text((pad + px(114 * k), pad + px(70 * k)), "Plugin", font=font("body", round(28 * k), 500), fill=MUTED + (255,))
    return img, pad


RAIL_CHIP_W, RAIL_CHIP_H, RAIL_CHIP_GAP = RAIL_W - 56, 54, 64
RAIL_CHIP_Y0 = SLOT[3] + 40


def rail_chip_rect(index):
    y = RAIL_CHIP_Y0 + index * RAIL_CHIP_GAP
    return (SLOT[0], y, SLOT[0] + RAIL_CHIP_W, y + RAIL_CHIP_H)


@lru_cache(maxsize=None)
def compact_chip(index, lit=False, scale=1.0):
    k = scale
    img, pad = panel_sprite(round(RAIL_CHIP_W * k * 2) / 2, round(RAIL_CHIP_H * k * 2) / 2, 12 * k, RAISED,
                            PRIMARY if lit else BORDER, (3 if lit else 2) * k)
    img = img.copy()
    d = ImageDraw.Draw(img)
    d.ellipse((pad + px(20 * k), pad + px(21 * k), pad + px(32 * k), pad + px(33 * k)), fill=PRIMARY + (255,))
    d.text((pad + px(46 * k), pad + px(9 * k)), SKILLS[index][0], font=font("mono", round(28 * k), 600), fill=TEXT + (255,))
    return img, pad


@lru_cache(maxsize=None)
def chip_sprite(index, lit=False):
    name, desc = SKILLS[index]
    img, pad = panel_sprite(CHIP_W, CHIP_H, 16, RAISED, PRIMARY if lit else BORDER, 3 if lit else 2)
    img = img.copy()
    d = ImageDraw.Draw(img)
    d.ellipse((pad + px(30), pad + px(35), pad + px(46), pad + px(51)), fill=PRIMARY + (255,))
    d.text((pad + px(70), pad + px(19)), name, font=font("mono", 38, 600), fill=TEXT + (255,))
    d.text((pad + px(CHIP_W - 32), pad + px(25)), desc, font=font("body", 30, 400), fill=MUTED + (255,), anchor="ra")
    return img, pad


def chip_rect(index):
    y = CHIP_Y0 + index * CHIP_GAP
    return (MAIN_X, y, MAIN_X + CHIP_W, y + CHIP_H)


# ── Scenes ───────────────────────────────────────────────────────

def summary_leave(t):
    """Everything on the summary fades out before the end card fades in, so the two layouts
    never double-expose."""
    return 1 - ease_in(prog(t, T["end"], T["end"] + 0.3))


def window_alpha(t):
    appear = ease_out(prog(t, T["window_in"], T["window_in"] + 0.9))
    leave = 1 - ease_in_out(prog(t, T["summary"], T["summary"] + 0.7))
    return appear * leave


def draw_window(frame, t):
    x = window_alpha(t)
    if x <= 0:
        return
    rise = (1 - ease_out(prog(t, T["window_in"], T["window_in"] + 0.9))) * 34
    sprite, pad = window_sprite()
    put(frame, sprite, WIN[0], WIN[1] + rise, x, pad)
    # Empty slot until the plugin docks
    slot_alpha = x * (1 - prog(t, T["dock"] - 0.05, T["dock"] + 0.2))
    if slot_alpha > 0:
        layer = Image.new("RGBA", (px(SLOT[2] - SLOT[0]) + 8, px(SLOT[3] - SLOT[1]) + 8), (0, 0, 0, 0))
        dashed_rect(ImageDraw.Draw(layer), (2 / S, 2 / S, SLOT[2] - SLOT[0], SLOT[3] - SLOT[1]), 18,
                    BORDER_STRONG + (255,), dash=14, gap=10, width=2)
        put(frame, layer, SLOT[0] - 1 / S, SLOT[1] + rise - 1 / S, slot_alpha)
        put_text(frame, "No plugins yet", (SLOT[0] + SLOT[2]) / 2, SLOT[1] + rise + 42, "body", 28, 500, MUTED,
                 slot_alpha * 0.9, anchor="ma")
    # Prompt: placeholder, then the typed request, then empty again after it is sent.
    typed = int(len(REQUEST) * prog(t, T["type0"], T["type0"] + 1.35))
    sent = t >= T["send"]
    text_x, text_y = PROMPT[0] + 34, PROMPT[1] + rise + 20
    if typed and not sent:
        put_text(frame, REQUEST[:typed], text_x, text_y, "body", 30, 500, TEXT, x)
        caret_x = text_x + text_width(REQUEST[:typed], "body", 30, 500) + 3
    else:
        put_text(frame, "Describe what you need", text_x, text_y, "body", 30, 400, MUTED, x * 0.8)
        caret_x = PROMPT[0] + 28
    if (t % 1.06) < 0.6 or (typed and not sent):
        caret = Image.new("RGBA", (px(3), px(38)), PRIMARY + (255,))
        put(frame, caret, caret_x, PROMPT[1] + rise + 19, x)


def plugin_state(t):
    """(x, y, scale, glow, alpha) for the Power Pages card: flying in, docked, then the summary."""
    appear = ease_out(prog(t, T["card_in"], T["card_in"] + 0.5))
    start = (WIN[2] + 40, 470)
    control = (1180, 40)
    fly = ease_in_out(prog(t, T["card_fly"], T["dock"]))
    x, y = bezier(start, control, (SLOT[0], SLOT[1]), fly)
    y += math.sin((t - T["card_in"]) * 2.4) * 6 * (1 - fly)
    glow = T["dock"] <= t < T["dock"] + 1.4
    move = ease_in_out(prog(t, T["summary"], T["summary"] + 0.9))
    if move > 0:
        x = lerp(x, SUMMARY_PLUGIN[0], move)
        y = lerp(y, SUMMARY_PLUGIN[1], move)
    # The card grows only after the first skills have left the rows beneath it; growing
    # earlier pushes its lower edge into the /create-site chip on its way out.
    grow = ease_in_out(prog(t, T["summary"] + 0.35, T["summary"] + 1.15))
    scale = lerp(1.0, SUMMARY_SCALE, grow)
    leave = summary_leave(t)
    return x, y, scale, glow, appear * leave


SUMMARY_SCALE = 1.35
SUMMARY_PLUGIN = (190, 226)
SUMMARY_CHIPS_X = 1050
SUMMARY_CHIP_Y0 = 112
SUMMARY_LABEL_Y = 640


def draw_plugin(frame, t):
    x, y, scale, glow, alpha = plugin_state(t)
    if alpha <= 0:
        return
    sprite, pad = plugin_card(glow, round(scale * 50) / 50)
    # Lands with a small settle: a 4% squash that springs back.
    k = prog(t, T["dock"], T["dock"] + 0.35)
    if 0 < k < 1:
        squash = 1 - 0.04 * math.sin(k * math.pi) * (1 - k)
        sprite = sprite.resize((sprite.width, int(sprite.height * squash)), Image.LANCZOS)
        y += (1 - squash) * (SLOT[3] - SLOT[1]) / 2
    put(frame, sprite, x, y, alpha, pad)
    p = prog(t, T["dock"], T["dock"] + 0.7)
    if 0 < p < 1:
        grow = ease_out(p) * 22
        w, h = SLOT[2] - SLOT[0] + grow * 2, SLOT[3] - SLOT[1] + grow * 2
        put(frame, ring_sprite(round(w), round(h), 18 + grow / 2, PRIMARY, 3), SLOT[0] - grow - 3, SLOT[1] - grow - 3,
            (1 - p) * 0.9)


def chip_time(index):
    return T["chip0"] + index * T["chip_step"]


def summary_chip_rect(index):
    k = SUMMARY_SCALE
    y = SUMMARY_CHIP_Y0 + index * RAIL_CHIP_GAP * k
    return (SUMMARY_CHIPS_X, y, SUMMARY_CHIPS_X + RAIL_CHIP_W * k, y + RAIL_CHIP_H * k)


def hidden_by_card(index, t):
    """create-site and deploy-site chips are drawn as cards while their cards are open."""
    if index == 0:
        return T["morph"] <= t < T["collapse"] + 0.5
    if index == 4:
        return T["split"] <= t < T["collapse"] + 0.5
    return False


def chip_return(index, t):
    return 1.0


def draw_skills(frame, t):
    label = ease_out(prog(t, T["skills_label"], T["skills_label"] + 0.5))
    if label <= 0:
        return
    cards_open = ease_in_out(prog(t, T["morph"], T["morph"] + 0.7)) * (1 - ease_in_out(prog(t, T["collapse"], T["collapse"] + 0.6)))
    to_rail = [ease_in_out(prog(t, T["to_rail"] + i * 0.06, T["to_rail"] + i * 0.06 + 0.7)) for i in range(len(SKILLS))]
    dim = 1 - 0.75 * cards_open
    main_alpha = label * dim * (1 - to_rail[0])
    if main_alpha > 0:
        put_text(frame, "Skills in this plugin", MAIN_X, CHIP_Y0 - 62, "body", 28, 600, MUTED, main_alpha)
        # A tree line from the plugin card to each skill, drawn as the skills arrive.
        line = Image.new("RGBA", frame.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(line)
        trunk_x = MAIN_X - 28
        last_y = None
        color = BORDER_STRONG + (int(255 * main_alpha),)
        for i in range(len(SKILLS)):
            a = ease_out(prog(t, chip_time(i), chip_time(i) + 0.45))
            if a <= 0:
                continue
            cy = chip_rect(i)[1] + CHIP_H / 2
            last_y = cy
            d.line((px(trunk_x), px(cy), px(trunk_x + 28 * a), px(cy)), fill=color, width=px(3))
        if last_y is not None:
            mid = (SLOT[1] + SLOT[3]) / 2
            d.line((px(SLOT[2]), px(mid), px(trunk_x), px(mid)), fill=color, width=px(3))
            d.line((px(trunk_x), px(mid), px(trunk_x), px(last_y)), fill=color, width=px(3))
            frame.alpha_composite(line)
    lit_index = 0 if t >= T["pick"] else None
    leave = summary_leave(t)
    for i in range(len(SKILLS)):
        a = ease_out(prog(t, chip_time(i), chip_time(i) + 0.5))
        if a <= 0 or hidden_by_card(i, t):
            continue
        x0, y0, _, _ = chip_rect(i)
        sx = lerp(SLOT[2] - 60, x0, a)
        sy = lerp((SLOT[1] + SLOT[3]) / 2 - CHIP_H / 2, y0, a)
        r = to_rail[i]
        back = chip_return(i, t)
        # Moving to the rail: the full chip drifts toward it and fades out, then the compact
        # chip slides into the rail. They never overlap, so no text ghosts over other text.
        out = clamp(r / 0.45)
        if out < 1:
            sprite, pad = chip_sprite(i)
            put(frame, sprite, sx - 90 * ease_in_out(out), sy, a * dim * back * (1 - out), pad)
        inn = ease_out(clamp((r - 0.4) / 0.6))
        if inn > 0:
            rx, ry, _, _ = rail_chip_rect(i)
            px0, py0 = rx + 50 * (1 - inn), ry
            summary = ease_in_out(prog(t, T["skills_move"] + i * 0.07, T["skills_move"] + i * 0.07 + 1.0))
            if summary > 0:
                tx, ty, _, _ = summary_chip_rect(i)
                # Along its own row first (below the plugin card), then up into the column,
                # so no two skills and no skill and the card ever cross.
                px0, py0 = bezier((rx, ry), (tx - 60, ry), (tx, ty), summary)
            scale = lerp(1.0, SUMMARY_SCALE, summary)
            sweep = T["summary_skills"] + i * 0.1
            lit = (i == lit_index and summary == 0) or (sweep <= t < sweep + 0.5)
            sprite, pad = compact_chip(i, lit, round(scale * 50) / 50)
            put(frame, sprite, px0, py0, a * inn * leave, pad)
    # The pick: a ring pulses around the chosen skill in the rail.
    p = prog(t, T["pick"], T["pick"] + 0.8)
    if 0 < p < 1:
        rx0, ry0, rx1, ry1 = rail_chip_rect(0)
        grow = ease_out(p) * 16
        put(frame, ring_sprite(round(rx1 - rx0 + grow * 2), round(ry1 - ry0 + grow * 2), 12 + grow / 2, PRIMARY, 3),
            rx0 - grow - 3, ry0 - grow - 3, (1 - p))


CARD = (250, 110, 1670, 970)
CARD_BACK = (110, 170, 1250, 860)
CARD_FRONT = (560, 210, 1810, 870)


def draw_card(frame, rect, name, title, steps, step_start, step_gap, content, k=1.0, opacity=1.0, badge=0.0, fade=1.0,
              badge_alpha=1.0):
    """A skill card. Content is laid out from the card's own corner and scale, so it moves
    and scales with the card. A lower opacity dims the card (it is behind another one) but
    the panel stays opaque, so nothing behind it shows through."""
    dim = 1 - opacity
    put_panel(frame, rect, 28 * k, mix(RAISED, SURFACE, dim), mix(PRIMARY, BORDER_STRONG, dim), fade, shadow=44 * k, width=3 * k)
    if content <= 0:
        return
    c = content * opacity * fade
    x0, y0 = rect[0] + 80 * k, rect[1] + 70 * k
    put_text(frame, name, x0, y0, "mono", round(44 * k), 600, PRIMARY, c)
    put_text(frame, title, x0, y0 + 70 * k - 12 * (1 - content), "display", round(80 * k), 800, TEXT, c)
    for i, step in enumerate(steps):
        a = step_visible(step_start + i * step_gap)
        if a <= 0:
            continue
        sy = y0 + (250 + i * 118) * k
        sx = x0 - 24 * (1 - a) * k
        put_panel(frame, (sx, sy, sx + 72 * k, sy + 72 * k), 36 * k, SUNKEN, PRIMARY, a * c, width=3 * k)
        put_text(frame, str(i + 1), sx + 36 * k, sy + 12 * k, "display", round(38 * k), 800, PRIMARY, a * c, anchor="ma")
        put_text(frame, step, sx + 108 * k, sy + 8 * k, "body", round(46 * k), 500, TEXT, a * c)
    if badge > 0:
        scale = ease_back(badge)
        label = "One skill, one job"
        w = text_width(label, "body", round(34 * k), 700) + 64 * k
        bx, by = rect[2] - 72 * k - w, rect[1] + 70 * k
        cx, cy = bx + w / 2, by + 34 * k
        r = (cx - w / 2 * scale, cy - 34 * k * scale, cx + w / 2 * scale, cy + 34 * k * scale)
        put_panel(frame, r, 34 * k * scale, PRIMARY, None, clamp(badge * 2) * opacity * badge_alpha)
        if badge > 0.4:
            put_text(frame, label, cx, by + 13 * k, "body", round(34 * k), 700, ON_PRIMARY,
                     clamp((badge - 0.4) * 3) * opacity * badge_alpha, anchor="ma")


_NOW = [0.0]


def step_visible(at):
    return ease_out(prog(_NOW[0], at, at + 0.4))


def reverse_morph(frame, rect, target, back, name, steps_title, steps, step_start, step_gap, k, opacity, badge, chip):
    """The opening morph played backwards: content fades, the panel shrinks into its skill
    row, and the skill's own chip fades in as it lands."""
    content = 1 - clamp(back / 0.3)
    shape = ease_in_out(clamp((back - 0.15) / 0.85))
    r = lerp_rect(rect, chip_rect(target), shape)
    if content > 0:
        draw_card(frame, r, name, steps_title, steps, step_start, step_gap, content, k, opacity, badge)
    else:
        put_panel(frame, r, lerp(28 * k, 16, shape), mix(RAISED, SURFACE, 1 - opacity), mix(PRIMARY, BORDER, shape), 1,
                  shadow=44 * (1 - shape), width=lerp(3 * k, 2, shape))
    land = clamp((back - 0.6) / 0.4)
    if land > 0:
        sprite, pad = chip
        put(frame, sprite.crop((pad, pad, pad + px(CHIP_W), pad + px(CHIP_H))), r[0], r[1], land)


def draw_cards(frame, t):
    _NOW[0] = t
    m = ease_in_out(prog(t, T["morph"], T["morph"] + 0.7))
    back = prog(t, T["collapse"], T["collapse"] + 0.5)
    if m <= 0 or back >= 1:
        return
    frame.alpha_composite(Image.new("RGBA", frame.size, (3, 10, 15, int(150 * m * (1 - ease_in_out(back))))))
    split = ease_in_out(prog(t, T["split"], T["split"] + 0.7))
    badge = prog(t, T["badge"], T["badge"] + 0.45)
    # create-site: grows from its chip and steps back when deploy-site arrives.
    rect = lerp_rect(chip_rect(0), CARD, m)
    k = lerp(1.0, 0.8, split)
    opacity = lerp(1.0, 0.45, split)
    if split > 0:
        rect = lerp_rect(rect, CARD_BACK, split)
    if back > 0:
        reverse_morph(frame, rect, 0, back, "/create-site", "Create a Power Pages site", CREATE_STEPS, T["step0"],
                      T["step_step"], k, opacity, 0.0, chip_sprite(0))
    elif m < 1 and t < T["morph"] + 0.7:
        put_panel(frame, rect, lerp(16, 28, m), RAISED, mix(BORDER, PRIMARY, m), 1, shadow=44 * m, width=lerp(2, 3, m))
        if m < 0.5:
            sprite, pad = chip_sprite(0)
            put(frame, sprite.crop((pad, pad, pad + px(CHIP_W), pad + px(CHIP_H))), rect[0], rect[1], 1 - m * 2)
        content = ease_out(prog(t, T["morph"] + 0.5, T["morph"] + 0.95))
        if content > 0:
            draw_card(frame, rect, "/create-site", "Create a Power Pages site", CREATE_STEPS, T["step0"], T["step_step"],
                      content, 1.0, 1.0, badge)
    else:
        content = ease_out(prog(t, T["morph"] + 0.5, T["morph"] + 0.95))
        draw_card(frame, rect, "/create-site", "Create a Power Pages site", CREATE_STEPS, T["step0"], T["step_step"],
                  content, k, opacity, badge, badge_alpha=1 - clamp(split * 2))
    # deploy-site: slides in front from the right.
    if split > 0:
        offscreen = (CARD_FRONT[0] + 1100, CARD_FRONT[1], CARD_FRONT[2] + 1100, CARD_FRONT[3])
        rect2 = lerp_rect(offscreen, CARD_FRONT, ease_out(prog(t, T["split"], T["split"] + 0.6)))
        if back > 0:
            reverse_morph(frame, rect2, 4, back, "/deploy-site", "Deploy the site", DEPLOY_STEPS, T["deploy_step0"], 0.32,
                          0.9, 1.0, 0.0, chip_sprite(4))
        else:
            draw_card(frame, rect2, "/deploy-site", "Deploy the site", DEPLOY_STEPS, T["deploy_step0"], 0.32, 1.0, 0.9)


def draw_chat(frame, t):
    # The conversation clears faster than the window, so the skills that travel across it
    # into the summary never pass over its text.
    alpha = window_alpha(t) * (1 - ease_out(prog(t, T["summary"], T["summary"] + 0.3)))
    if alpha <= 0 or t < T["send"]:
        return
    # The sent request, as a bubble at the top right of the conversation.
    b = ease_out(prog(t, T["send"], T["send"] + 0.4))
    w = text_width(REQUEST, "body", 32, 500) + 64
    bx1 = WIN[2] - 40
    bx0 = bx1 - w
    by0 = WIN[1] + HEADER_H + 36 + (1 - b) * 24
    put_panel(frame, (bx0, by0, bx1, by0 + 76), 22, (21, 70, 74), None, b * alpha)
    put_text(frame, REQUEST, bx0 + 32, by0 + 17, "body", 32, 500, TEXT, b * alpha)
    # The pick: a line from the request to the skill it matches.
    p = ease_in_out(prog(t, T["pick"], T["pick"] + 0.5))
    if p > 0:
        layer = Image.new("RGBA", frame.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        rx0, ry0, rx1, ry1 = rail_chip_rect(0)
        start = (bx0 + 40, by0 + 76)
        end = (rx1 + 6, (ry0 + ry1) / 2)
        control = (start[0] - 120, end[1] - 10)
        points = [bezier(start, control, end, i / 40 * p) for i in range(41)]
        d.line([(px(x), px(y)) for x, y in points], fill=PRIMARY + (int(230 * alpha),), width=px(3), joint="curve")
        fade = 1 - prog(t, T["reply"] + 0.4, T["reply"] + 1.0)
        if fade > 0:
            if fade < 1:
                layer.putalpha(layer.getchannel("A").point(lambda v: int(v * fade)))
            frame.alpha_composite(layer)
    # The reply: which skill it is using, and its steps ticking off.
    r = ease_out(prog(t, T["reply"], T["reply"] + 0.4))
    if r > 0:
        x0, y0 = MAIN_X, by0 + 130
        put_text(frame, "Using", x0, y0 + 4, "body", 30, 500, MUTED, r * alpha)
        put_text(frame, "/create-site", x0 + text_width("Using", "body", 30, 500) + 14, y0, "mono", 34, 600, PRIMARY, r * alpha)
        for i, step in enumerate(REPLY_STEPS):
            a = ease_out(prog(t, T["reply"] + 0.35 + i * 0.42, T["reply"] + 0.7 + i * 0.42))
            if a <= 0:
                continue
            sy = y0 + 76 + i * 68
            check = Image.new("RGBA", (px(34), px(34)), (0, 0, 0, 0))
            ImageDraw.Draw(check).line([(px(6), px(18)), (px(14), px(26)), (px(28), px(9))], fill=SUCCESS + (255,),
                                       width=px(4), joint="curve")
            put(frame, check, x0, sy + 4, a * alpha)
            put_text(frame, step, x0 + 52, sy, "body", 34, 400, TEXT, a * alpha)
    # Permission: the assistant stops and asks before it runs a command.
    q = ease_out(prog(t, T["ask"], T["ask"] + 0.45))
    if q > 0:
        h = 196
        y1 = PROMPT[1] - 22
        y0 = y1 - h + (1 - q) * 40
        rect = (MAIN_X, y0, WIN[2] - 36, y0 + h)
        put_panel(frame, rect, 20, (13, 45, 50), PRIMARY, q * alpha, shadow=24, width=3)
        put_text(frame, "Allow this command?", rect[0] + 36, y0 + 28, "body", 34, 700, TEXT, q * alpha)
        put_panel(frame, (rect[0] + 36, y0 + 92, rect[0] + 36 + text_width(COMMAND, "mono", 32, 500) + 48, y0 + 160), 12,
                  SUNKEN, BORDER_STRONG, q * alpha)
        put_text(frame, COMMAND, rect[0] + 60, y0 + 103, "mono", 32, 500, TEXT, q * alpha)
        pressed = prog(t, T["allow"], T["allow"] + 0.18)
        squeeze = 1 - 0.05 * math.sin(pressed * math.pi)
        allowed = t >= T["allow"] + 0.18
        bw, bh = 196 * squeeze, 68 * squeeze
        bx1 = rect[2] - 36
        dx1 = bx1 - 196 - 20
        put_panel(frame, (dx1 - 156, y0 + 92, dx1, y0 + 160), 14, SURFACE, BORDER_STRONG, q * alpha * (1 - prog(t, T["allow"], T["allow"] + 0.3)))
        put_text(frame, "Deny", dx1 - 78, y0 + 104, "body", 30, 600, TEXT, q * alpha * (1 - prog(t, T["allow"], T["allow"] + 0.3)), anchor="ma")
        cx, cy = bx1 - 98, y0 + 126
        put_panel(frame, (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2), 14, SUCCESS if allowed else PRIMARY, None, q * alpha)
        put_text(frame, "Allowed" if allowed else "Allow", cx, y0 + 104, "body", 30, 700, ON_PRIMARY, q * alpha, anchor="ma")
        if not allowed:
            badge_w = text_width("Your turn", "body", 26, 700) + 36
            put_panel(frame, (rect[2] - 36 - badge_w, y0 + 26, rect[2] - 36, y0 + 70), 22, PRIMARY, None, q * alpha)
            put_text(frame, "Your turn", rect[2] - 36 - badge_w / 2, y0 + 33, "body", 26, 700, ON_PRIMARY, q * alpha, anchor="ma")


def draw_summary(frame, t):
    leave = summary_leave(t)
    a = ease_out(prog(t, T["plugin_label"], T["plugin_label"] + 0.5)) * leave
    if a > 0:
        x = SUMMARY_PLUGIN[0]
        put_text(frame, "Plugin", x, SUMMARY_LABEL_Y + (1 - a) * 16, "display", 110, 800, TEXT, a)
        put_text(frame, "What you install", x, SUMMARY_LABEL_Y + 140 + (1 - a) * 16, "body", 50, 500, MUTED, a)
    b = ease_out(prog(t, T["summary_skills"], T["summary_skills"] + 0.5)) * leave
    if b > 0:
        x = SUMMARY_CHIPS_X
        put_text(frame, "Skills", x, SUMMARY_LABEL_Y + (1 - b) * 16, "display", 110, 800, TEXT, b)
        put_text(frame, "The jobs inside it", x, SUMMARY_LABEL_Y + 140 + (1 - b) * 16, "body", 50, 500, MUTED, b)


def draw_end(frame, t):
    a = ease_out(prog(t, T["end"] + 0.3, T["end"] + 0.85))
    if a <= 0:
        return
    put_text(frame, "You just ask.", W / 2, 300 + (1 - a) * 20, "display", 120, 800, TEXT, a, anchor="ma")
    rect = (380, 520 + (1 - a) * 20, 1540, 620 + (1 - a) * 20)
    put_panel(frame, rect, 22, SUNKEN, PRIMARY, a, shadow=30, width=3)
    put_text(frame, "Describe what you need", rect[0] + 48, rect[1] + 28, "body", 40, 400, MUTED, a)
    if (t % 1.06) < 0.6:
        put(frame, Image.new("RGBA", (px(3), px(50)), PRIMARY + (255,)), rect[0] + 40, rect[1] + 25, a)
    put_text(frame, "Power Platform Skills", W / 2, 720, "display", 44, 700, TEXT, a * 0.95, anchor="ma")
    put_text(frame, "microsoft.github.io/power-platform-skills", W / 2, 784, "body", 32, 400, MUTED, a, anchor="ma")


# ── Frame assembly ───────────────────────────────────────────────

def frame_at(t, seed=None):
    frame = background().copy()
    draw_window(frame, t)
    draw_chat(frame, t)
    draw_plugin(frame, t)
    draw_skills(frame, t)
    draw_cards(frame, t)
    draw_summary(frame, t)
    draw_end(frame, t)
    out = np.asarray(frame.reduce(S).convert("RGB"), dtype=np.float32)
    # Sub-LSB triangular dither, seeded per frame so renders repeat exactly. It breaks up the
    # banding that H.264 otherwise shows in the dark gradients.
    rng = np.random.default_rng(int(round(t * FPS)) if seed is None else seed)
    out += rng.random(out.shape, dtype=np.float32) - rng.random(out.shape, dtype=np.float32)
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8))


def preview(times):
    out = FRAMES
    out.mkdir(parents=True, exist_ok=True)
    thumbs = []
    for t in times:
        img = frame_at(t)
        img.save(out / f"key-{t:06.2f}.png")
        thumbs.append(img.resize((640, 360), Image.LANCZOS))
    cols = 3
    rows = math.ceil(len(thumbs) / cols)
    sheet = Image.new("RGB", (cols * 640 + (cols + 1) * 12, rows * 360 + (rows + 1) * 12), (30, 30, 30))
    for i, th in enumerate(thumbs):
        sheet.paste(th, (12 + (i % cols) * 652, 12 + (i // cols) * 372))
    sheet.save(out / "contact-sheet.png")
    print("wrote", len(times), "keyframes and", out / "contact-sheet.png")


def render(start, end, path):
    frames = int(round((end - start) * FPS))
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
           "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", str(path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for n in range(frames):
        proc.stdin.write(frame_at(start + n / FPS).tobytes())
        if n % 120 == 0:
            print(f"frame {n}/{frames}", flush=True)
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed")
    print("wrote", path, frames, "frames")


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "preview":
        preview([float(v) for v in sys.argv[2:]])
    elif command == "render":
        render(float(sys.argv[2]), float(sys.argv[3]), Path(sys.argv[4]))
    else:
        raise SystemExit(__doc__)
