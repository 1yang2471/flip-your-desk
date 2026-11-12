"""Generate the app icon. Run from the project root: python scripts/make_icon.py"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 2048
INK = (20, 23, 28, 255)
INK_EDGE = (43, 49, 58, 255)
CARD = (244, 240, 230, 255)
CARD_EDGE = (214, 207, 192, 255)
BACK = (32, 37, 44, 255)
BACK_EDGE = (58, 65, 76, 255)
ACCENT = (230, 180, 91, 255)
ACCENT_DARK = (169, 124, 47, 255)


def rounded(size: tuple[int, int], radius: int, fill, outline=None, width: int = 1) -> Image.Image:
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=fill,
                        outline=outline, width=width)
    return img


canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(canvas)
d.rounded_rectangle((40, 40, S - 40, S - 40), radius=430, fill=INK,
                    outline=INK_EDGE, width=8)

# back card, tilted
back = rounded((700, 930), 70, BACK, BACK_EDGE, 6)
back = back.rotate(-13, resample=Image.Resampling.BICUBIC, expand=True)
canvas.alpha_composite(back, (520, 540))

# front card
front = rounded((720, 950), 72, CARD, CARD_EDGE, 6)
fd = ImageDraw.Draw(front)
# thin card rule near the bottom
fd.rounded_rectangle((150, 790, 570, 800), radius=5, fill=(226, 220, 207, 255))
font_path = Path("C:/Windows/Fonts/segoeuib.ttf")
try:
    font = ImageFont.truetype(str(font_path), 430)
except OSError:
    font = ImageFont.load_default()
bbox = fd.textbbox((0, 0), "?", font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
fd.text(((720 - tw) / 2 - bbox[0], 300 - bbox[1]), "?", font=font, fill=ACCENT)
# small gold dot as the card's index mark
fd.ellipse((600, 820, 660, 880), fill=ACCENT_DARK)
canvas.alpha_composite(front, (600, 420))

# soft inner highlight on the panel
highlight = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(highlight)
hd.rounded_rectangle((60, 60, S - 60, 560), radius=410, fill=(255, 255, 255, 12))
canvas.alpha_composite(highlight)

icon = canvas.resize((1024, 1024), Image.Resampling.LANCZOS)
icon.save(OUT / "icon.png")
icon.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / "icon-512.png")
icon.resize((256, 256), Image.Resampling.LANCZOS).save(OUT / "128x128@2x.png")
icon.resize((128, 128), Image.Resampling.LANCZOS).save(OUT / "128x128.png")
icon.resize((32, 32), Image.Resampling.LANCZOS).save(OUT / "32x32.png")
icon.save(OUT / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("wrote", OUT / "icon.ico")