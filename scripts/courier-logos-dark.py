#!/usr/bin/env python3
"""Dark-mode versions of the delivery companies' logos (apps/web/public/couriers/*.webp → couriers/dark/*.webp).

What a company's own "on dark" logo usually is: its black or navy writing turns light, its brand colours stay. So:
- a white background is taken away (the counters of the letters too), its edges kept soft;
- dark greys and black become near-white (light greys stay), and a too-dark colour (navy, dark green…) is lifted to a
  lighter shade of the same colour; bright colours (red, orange, yellow…) are not touched;
- the soft edges take the colour of the logo next to them, so no light halo appears around a colour.
White logos (DARK in packages/core/src/couriers/companies.ts) need no dark version: the app shows them as they are.

Run after adding or changing a logo:  python3 scripts/courier-logos-dark.py   (needs Pillow, numpy and scipy)
"""
import glob
import os
import re

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'apps/web/public/couriers')
OUT = os.path.join(SRC, 'dark')
COMPANIES = os.path.join(ROOT, 'packages/core/src/couriers/companies.ts')


def white_logos() -> set:
    """The logos already white (shown on navy in light mode): no dark version."""
    src = open(COMPANIES, encoding='utf-8').read()
    m = re.search(r"const DARK = new Set\(\[([^\]]*)\]\)", src)
    return set(re.findall(r"'([^']+)'", m.group(1))) if m else set()


# ---------------------------------------------------------------- sRGB ⇄ OKLab
def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def to_oklab(rgb):
    r, g, b = [srgb_to_lin(rgb[..., i]) for i in range(3)]
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return np.stack([
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ], -1)


def oklab_to_lin(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return np.stack([
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076956879 * s,
    ], -1)


def oklab_to_srgb(lab):
    """Back to sRGB, bringing out-of-gamut colours in by lowering their chroma (the hue and lightness stay)."""
    lab = lab.copy()
    for _ in range(12):
        lin = oklab_to_lin(lab)
        out = ((lin < -1e-4) | (lin > 1 + 1e-4)).any(-1)
        if not out.any():
            break
        lab[out, 1:] *= 0.88
    return lin_to_srgb(oklab_to_lin(lab))


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- steps
def white_to_alpha(rgb):
    """A logo on a white background: the white goes, the soft edges keep their true colour (« colour to alpha »)."""
    a = np.max(1 - rgb, axis=-1)                     # how far from white
    a = np.where(a < 0.035, 0, a)                    # a paper-white background (250,250,250) is background too
    safe = np.maximum(a, 1e-6)[..., None]
    col = np.clip((rgb - (1 - safe)) / safe, 0, 1)
    return col, a


def bleed_edges(rgb, alpha, reach=2.0):
    """Soft edge pixels take the colour of the nearest solid pixel (within `reach` px)."""
    solid = alpha >= 0.98
    if not solid.any():
        return rgb
    dist, idx = ndimage.distance_transform_edt(~solid, return_indices=True)
    near = rgb[idx[0], idx[1]]
    use = (~solid) & (dist <= reach)
    out = rgb.copy()
    out[use] = near[use]
    return out


def lighter(lab):
    """Black and dark greys → near-white (light greys stay); a too-dark colour → a lighter shade of the same colour
    (navy → periwinkle, dark red → raspberry); bright colours stay."""
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    C = np.hypot(a, b)
    neutral = 1 - smoothstep(0.035, 0.075, C)        # 1 = grey/black, 0 = a real colour
    Ln = np.maximum(L, 0.96 - 0.28 * L)              # black → 0.96, mid grey → 0.82
    k = 1 - smoothstep(0.42, 0.56, L)                # how much a colour is lifted (0 for bright colours)
    Lc = L + (0.74 - 0.10 * smoothstep(0.08, 0.16, C) - L) * k   # vivid colours lifted a little less
    boost = (1 + 0.35 * k) * (1 - 0.6 * neutral)
    return np.stack([neutral * Ln + (1 - neutral) * Lc, a * boost, b * boost], -1)


EIGHT = np.ones((3, 3), bool)


def components(mask):
    """Each connected part of the mask (8-connected) with its bounding box."""
    lab, n = ndimage.label(mask, structure=EIGHT)
    return lab, ndimage.find_objects(lab)


def ring_of(lab, i, box, shape, width=2):
    """The pixels just around part i (within `width` px), as (y, x) slices + mask."""
    y0, y1 = max(box[0].start - width, 0), min(box[0].stop + width, shape[0])
    x0, x1 = max(box[1].start - width, 0), min(box[1].stop + width, shape[1])
    part = lab[y0:y1, x0:x1] == i
    ring = ndimage.binary_dilation(part, EIGHT, iterations=width) & ~part
    return (slice(y0, y1), slice(x0, x1)), part, ring


def adapt(rgb, alpha):
    """The « on dark » version: the dark parts that sit on the page (writing, outlines) turn light; the dark parts
    inside the logo's own colour shapes (black text in a yellow oval) stay dark; a white part closed in by dark
    writing that turned light (white letters in a black bar, a white fill inside a black outline) becomes a hole."""
    lab = to_oklab(rgb)
    L, C = lab[..., 0], np.hypot(lab[..., 1], lab[..., 2])
    solid = alpha > 0.5
    see_through = alpha < 0.3

    # 1. dark parts: lifted when they touch the page (a quarter of what is around them is see-through)
    lift = np.zeros(L.shape, bool)
    dlab, boxes = components(solid & (L < 0.52))
    for i, box in enumerate(boxes, 1):
        if box is None:
            continue
        sl, part, ring = ring_of(dlab, i, box, L.shape)
        around = see_through[sl][ring]
        if not around.size or around.mean() >= 0.25:
            lift[sl] |= part
    # their soft edges and the faint dark bits (thin lines, gradients) lie on the page too
    faint = (~solid) & (alpha > 0) & (L < 0.6)
    lift |= faint | (ndimage.binary_dilation(lift, EIGHT) & (L < 0.75) & ~solid)

    # 2. white parts closed in by lifted writing become holes (their soft edges partly)
    hole = np.zeros(L.shape, bool)
    wlab, boxes = components(solid & (L > 0.86) & (C < 0.05))
    for i, box in enumerate(boxes, 1):
        if box is None:
            continue
        sl, part, ring = ring_of(wlab, i, box, L.shape)
        around = lift[sl][ring]
        if around.size and around.mean() >= 0.6:
            hole[sl] |= part
    hole = ndimage.binary_dilation(hole, EIGHT) & ~lift | hole

    out = lab.copy()
    out[lift] = lighter(lab[lift][None])[0]
    alpha = alpha.copy()
    whiteness = smoothstep(0.80, 0.97, L) * (1 - smoothstep(0.035, 0.075, C))
    alpha[hole] *= 1 - whiteness[hole]
    return oklab_to_srgb(out), alpha


# logos the automatic version gets wrong: 'keep' = shown as they are on dark (they carry their own background)
KEEP = set()


def make_dark(path, name):
    im = Image.open(path).convert('RGBA')
    px = np.asarray(im).astype(np.float64) / 255
    rgb, alpha = px[..., :3], px[..., 3]
    if (alpha < 0.98).mean() < 0.02:                 # no transparency: a logo on white
        rgb, alpha = white_to_alpha(rgb)
    rgb = bleed_edges(rgb, alpha)
    if name not in KEEP:
        rgb, alpha = adapt(rgb, alpha)
    out = np.dstack([rgb, alpha])
    out[alpha <= 0.004] = 0
    return Image.fromarray(np.round(out * 255).astype(np.uint8), 'RGBA')


def main():
    os.makedirs(OUT, exist_ok=True)
    skip = white_logos()
    done = 0
    for path in sorted(glob.glob(os.path.join(SRC, '*.webp'))):
        name = os.path.splitext(os.path.basename(path))[0]
        if name in skip:
            continue
        make_dark(path, name).save(os.path.join(OUT, f'{name}.webp'), 'WEBP', quality=90, method=6)
        done += 1
    print(f'{done} dark logos in {os.path.relpath(OUT, ROOT)} ({len(skip)} white logos need none)')


if __name__ == '__main__':
    main()
