"""Rasterize the simple bookmark mark for Chrome's required PNG icon sizes."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'extension' / 'chrome' / 'icons'
root.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    image = Image.new('RGBA', (512, 512))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((20, 20, 492, 492), radius=96, fill='#a34f34')
    draw.polygon([(167, 118), (345, 118), (345, 394), (256, 338), (167, 394)], fill='#fffefa')
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / f'{size}.png')
