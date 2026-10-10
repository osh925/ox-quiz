#!/usr/bin/env python3
"""앱 아이콘(PNG) 생성 — 한 번만 실행하면 됨. Pillow 필요."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)

def make(size, maskable=False):
    im = Image.new("RGBA", (size, size), (37, 99, 235, 255))
    d = ImageDraw.Draw(im)
    pad = size * (0.22 if maskable else 0.14)
    w = size * 0.075
    # O (왼쪽)
    cx, cy, r = size * 0.33, size * 0.5, (size / 2 - pad) * 0.62
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline="white", width=int(w))
    # X (오른쪽)
    cx2 = size * 0.69
    d.line([cx2 - r * 0.8, cy - r * 0.8, cx2 + r * 0.8, cy + r * 0.8], fill=(254, 202, 202), width=int(w))
    d.line([cx2 - r * 0.8, cy + r * 0.8, cx2 + r * 0.8, cy - r * 0.8], fill=(254, 202, 202), width=int(w))
    return im

for s in (192, 512):
    make(s).save(OUT / f"icon-{s}.png")
make(512, maskable=True).save(OUT / "icon-maskable-512.png")
make(180).save(OUT / "apple-touch-icon.png")
print("icons written to", OUT)
