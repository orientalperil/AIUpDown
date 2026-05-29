#!/usr/bin/env python3
"""Generate the extension's PNG icons (16/48/128 px) locally.

Usage:
    pip install Pillow
    python3 make_icons.py

Produces icons/icon16.png, icons/icon48.png, icons/icon128.png:
an indigo (#6366f1) rounded square with stacked up/down chevrons in white.
This avoids shipping binary files through text-only channels.
"""
import os
from PIL import Image, ImageDraw

SS = 4  # supersample factor for clean anti-aliased edges
OUT = os.path.join(os.path.dirname(__file__), "icons")


def make(size):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # rounded-rect indigo background
    r = int(S * 28 / 128)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(99, 102, 241, 255))
    # two white chevrons (up over down); coords scaled from a 128 grid
    def sc(pts):
        return [(x / 128 * S, y / 128 * S) for x, y in pts]
    w = max(2, int(S * 9 / 128))
    for pts in ([(44, 52), (64, 32), (84, 52)], [(44, 76), (64, 96), (84, 76)]):
        d.line(sc(pts), fill=(255, 255, 255, 255), width=w, joint="curve")
        for x, y in sc(pts):  # round the caps/joints
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2],
                      fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 48, 128):
        path = os.path.join(OUT, f"icon{s}.png")
        make(s).save(path)
        print("wrote", path)


if __name__ == "__main__":
    main()
