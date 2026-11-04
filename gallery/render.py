#!/usr/bin/env python3
"""Draw the banner: the Pi start screen on the left, two halves of OpenCode on the right.

Every picture is the producer's own artwork, fetched by gallery/fetch.sh: the Pi terminal screen
from the pi-mono docs, the OpenCode splash and working screens from the opencode repo. No mock-up,
no screenshot from any operator's machine.

Output is 1200 x 630 PNG, the size the Pi gallery and Open Graph use.
Needs: pillow. Run: /tmp/imgvenv/bin/python gallery/render.py
"""
from PIL import Image, ImageDraw, ImageFont

VENDOR = "gallery/.vendor"
OUT = "assets/banner.png"
MENLO = "/System/Library/Fonts/Menlo.ttc"

WIDTH, HEIGHT = 1200, 630
BACK = "#0b0f14"
EDGE = "#232b34"
CHIP = "#0b0f14"
TEXT = "#d5dde6"
DIM = "#8b98a5"
ACCENT = "#7aa2f7"


def font(size, bold=False):
    return ImageFont.truetype(MENLO, size, index=1 if bold else 0)


def trim(image):
    """Crop to the window, ignoring the soft drop shadow the producer screenshots carry."""
    solid = image.getchannel("A").point(lambda a: 255 if a > 90 else 0)
    return image.crop(solid.getbbox())


def paste_cover(base, image, box, radius=14):
    """Scale image to cover box (x1, y1, x2, y2), crop overflow at the centre, clip the corners."""
    x, y, x2, y2 = box
    w, h = x2 - x, y2 - y
    scale = max(w / image.width, h / image.height)
    sized = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    left, top = (sized.width - w) // 2, (sized.height - h) // 2
    crop = sized.crop((left, top, left + w, top + h))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, fill=255)
    base.paste(crop, (x, y), mask)


def label(draw, x, top, text, colour=DIM):
    """Caption row above a card, so nothing sits on top of the screenshot."""
    draw.text((x + 2, top - 12), text, font=font(16), fill=colour)


def main():
    pi = Image.open(f"{VENDOR}/pi-screen.png").convert("RGBA")
    splash = Image.open(f"{VENDOR}/opencode-splash.png").convert("RGBA")
    worker = Image.open(f"{VENDOR}/opencode-screen.png").convert("RGBA")
    # The producer screenshots carry a shadow, so trim to the window itself before any crop.
    splash, worker = trim(splash), trim(worker)

    canvas = Image.new("RGBA", (WIDTH, HEIGHT), BACK)
    draw = ImageDraw.Draw(canvas)

    pi_box = (44, 74, 496, 600)
    idle_box = (548, 74, 1156, 318)
    work_box = (548, 356, 1156, 600)
    paste_cover(canvas, pi, pi_box)
    paste_cover(canvas, splash, idle_box)
    paste_cover(canvas, worker, work_box)
    for box in (pi_box, idle_box, work_box):
        draw.rounded_rectangle(box, radius=14, outline=EDGE, width=2)

    label(draw, 46, 62, "Pi session", TEXT)
    label(draw, 550, 62, "OpenCode thread, idle")
    label(draw, 550, 344, "OpenCode thread, at work")

    # Out goes the brief, back comes one wake-up.
    draw.text((522, 196), "→", font=font(30, True), fill=ACCENT, anchor="mm")
    draw.text((522, 478), "←", font=font(30, True), fill=DIM, anchor="mm")
    draw.text((WIDTH // 2, 620), "one session, many threads", font=font(17), fill=DIM, anchor="mm")

    canvas.save(OUT)
    print(OUT)


main()
