#!/usr/bin/env python3
"""Make the Pilotix app icons and start screens (Android) from the brand pictures.

Run from the mobile/ folder:  python3 scripts/make-icons.py
Sources: resources/icon-only.png (1024 x 1024, square, no rounded corners)
         resources/logo.png      (1024 x 1024, rounded corners, transparent outside)
Run it again whenever the icon changes, then commit the new pictures.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android/app/src/main/res"
ICON = Image.open(ROOT / "resources/icon-only.png").convert("RGBA")
LOGO = Image.open(ROOT / "resources/logo.png").convert("RGBA")
NAVY = (0x1B, 0x2A, 0x47, 255)

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def adaptive_layer(px: int) -> Image.Image:
    """108dp adaptive-icon layer: the whole icon fills the 72dp visible middle, and the
    edges are stretched outward (navy on top, orange below) so launchers never show a gap."""
    inner = round(px * 72 / 108)
    pad = (px - inner) // 2
    art = np.asarray(ICON.resize((inner, inner), Image.LANCZOS))
    out = np.pad(art, ((pad, px - inner - pad), (pad, px - inner - pad), (0, 0)), mode="edge")
    return Image.fromarray(out, "RGBA")


def round_icon(px: int) -> Image.Image:
    big = ICON.resize((px * 4, px * 4), Image.LANCZOS)
    mask = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    out = Image.new("RGBA", big.size, (0, 0, 0, 0))
    out.paste(big, (0, 0), mask)
    return out.resize((px, px), Image.LANCZOS)


def splash(w: int, h: int) -> Image.Image:
    out = Image.new("RGBA", (w, h), NAVY)
    size = round(min(w, h) * 0.30)
    logo = LOGO.resize((size, size), Image.LANCZOS)
    out.alpha_composite(logo, ((w - size) // 2, (h - size) // 2))
    return out.convert("RGB")


for name, k in DENSITIES.items():
    folder = RES / f"mipmap-{name}"
    LOGO.resize((round(48 * k),) * 2, Image.LANCZOS).save(folder / "ic_launcher.png", optimize=True)
    round_icon(round(48 * k)).save(folder / "ic_launcher_round.png", optimize=True)
    adaptive_layer(round(108 * k)).save(folder / "ic_launcher_foreground.png", optimize=True)

for f in sorted(RES.glob("drawable*/splash.png")):
    w, h = Image.open(f).size
    splash(w, h).save(f, optimize=True)

print("icons and start screens done")
