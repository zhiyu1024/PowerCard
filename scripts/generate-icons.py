"""Generate the app icons with Pillow (bundled runtime). No external assets."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

GREEN = (18, 156, 82, 255)
WHITE = (255, 254, 250, 255)
DARK_GREEN = (14, 122, 65, 255)


def draw_icon(size: int, padding_ratio: float = 0.0, bg: str = "green") -> Image.Image:
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg == "green":
        d.rounded_rectangle([0, 0, s, s], radius=int(s * 0.22), fill=GREEN)
    else:
        d.rounded_rectangle([0, 0, s, s], radius=int(s * 0.22), fill=WHITE)

    pad = int(s * padding_ratio)
    inner = s - pad * 2
    ox, oy = pad, pad

    def R(x0, y0, x1, y1):
        return [ox + int(x0 * inner), oy + int(y0 * inner), ox + int(x1 * inner), oy + int(y1 * inner)]

    # Monitor frame (white), screen (green), stand + base.
    frame = R(0.16, 0.20, 0.84, 0.68)
    rad = int(inner * 0.075)
    d.rounded_rectangle(frame, radius=rad, fill=WHITE)
    screen = R(0.19, 0.23, 0.81, 0.65)
    d.rounded_rectangle(screen, radius=int(rad * 0.68), fill=GREEN)
    # neck
    d.rounded_rectangle(R(0.455, 0.68, 0.545, 0.775), radius=int(inner * 0.012), fill=WHITE)
    # base
    d.rounded_rectangle(R(0.34, 0.775, 0.66, 0.828), radius=int(inner * 0.026), fill=WHITE)

    # Power glyph inside the screen.
    cx, cy = ox + inner * 0.5, oy + inner * 0.44
    r = inner * 0.095
    width = max(scale, int(inner * 0.032))
    # Arc from -50deg to 230deg leaves a gap at the top.
    bbox = [cx - r, cy - r, cx + r, cy + r]
    d.arc(bbox, start=305, end=235, fill=WHITE, width=width)
    d.rounded_rectangle(
        [cx - width / 2, cy - r * 1.12, cx + width / 2, cy + r * 0.30],
        radius=width / 2,
        fill=WHITE,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    draw_icon(512).save(OUT / "icon-512.png", optimize=True)
    draw_icon(192).save(OUT / "icon-192.png", optimize=True)
    draw_icon(180).save(OUT / "apple-touch-icon.png", optimize=True)
    # Maskable: keep art inside the 80% safe zone.
    draw_icon(512, padding_ratio=0.12).save(OUT / "maskable-512.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
