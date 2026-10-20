#!/usr/bin/env python3
"""从 public/icons/icon-512.png 生成 Android 启动图标资源。

输出（不修改 public/icons/）：
  app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png
  app/src/main/res/mipmap-*/ic_launcher_round.png
  app/src/main/res/mipmap-*/ic_launcher_foreground.png   （自适应图标前景，108dp）
  app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml / ic_launcher_round.xml
  app/src/main/res/values/ic_launcher_background.xml      （从图标取样得到的品牌绿）

用法：python android/tools/generate-icons.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "public" / "icons" / "icon-512.png"
RES_DIR = REPO_ROOT / "android" / "app" / "src" / "main" / "res"

LEGACY_SIZES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}
FOREGROUND_SIZES = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}
# 自适应图标安全区：前景内容应落在中心 66/108 的圆内
SAFE_ZONE_RATIO = 66.0 / 108.0


def sample_background(image: Image.Image) -> tuple[int, int, int]:
    """取图标左上角（圆角外/背景色）作为自适应图标背景色。"""
    rgba = image.convert("RGBA")
    # 取几个点里不透明的第一个
    for point in ((4, 4), (8, 8), (16, 16), (20, 20), (4, 200), (200, 4)):
        pixel = rgba.getpixel(point)
        if pixel[3] > 200:
            return pixel[0], pixel[1], pixel[2]
    # 兜底：全图平均
    pixels = [p for p in rgba.getdata() if p[3] > 200]
    if not pixels:
        return 31, 143, 78
    count = len(pixels)
    return (
        sum(p[0] for p in pixels) // count,
        sum(p[1] for p in pixels) // count,
        sum(p[2] for p in pixels) // count,
    )


def extract_glyph(image: Image.Image) -> Image.Image:
    """从绿底白字图标中提取白色显示器图形（保留抗锯齿 alpha）。"""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()
    background = sample_background(image)
    bg_luma = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2]
    span = max(1.0, 255.0 - bg_luma)
    out = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    out_pixels = out.load()
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
            alpha = (luma - bg_luma) / span
            alpha = 0.0 if alpha < 0.06 else min(1.0, alpha)
            if alpha > 0:
                out_pixels[x, y] = (255, 255, 255, int(round(alpha * 255)))
    return out


def fit_glyph(glyph: Image.Image, canvas_size: int) -> Image.Image:
    """把图形内容缩放到自适应图标安全区内并居中。"""
    bbox = glyph.getbbox()
    if not bbox:
        raise SystemExit("图标中未识别到白色图形，无法生成 adaptive icon")
    trimmed = glyph.crop(bbox)
    target = max(1, int(round(canvas_size * SAFE_ZONE_RATIO)))
    scale = min(target / trimmed.width, target / trimmed.height)
    resized = trimmed.resize(
        (max(1, int(round(trimmed.width * scale))), max(1, int(round(trimmed.height * scale)))),
        Image.LANCZOS,
    )
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    canvas.alpha_composite(
        resized,
        ((canvas_size - resized.width) // 2, (canvas_size - resized.height) // 2),
    )
    return canvas


def round_mask(image: Image.Image) -> Image.Image:
    """给传统图标加圆形遮罩（透明背景）。"""
    size = image.width
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rounded.paste(image, (0, 0), mask)
    return rounded


def write_density_pngs(icon: Image.Image) -> None:
    background = sample_background(icon)
    glyph = extract_glyph(icon)
    for density, size in LEGACY_SIZES.items():
        folder = RES_DIR / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        legacy = icon.resize((size, size), Image.LANCZOS)
        legacy.save(folder / "ic_launcher.png", optimize=True)
        round_mask(legacy).save(folder / "ic_launcher_round.png", optimize=True)
        foreground = fit_glyph(glyph, FOREGROUND_SIZES[density])
        foreground.save(folder / "ic_launcher_foreground.png", optimize=True)

    anydpi = RES_DIR / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    adaptive = f"""<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
    (anydpi / "ic_launcher.xml").write_text(adaptive, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(adaptive, encoding="utf-8")

    values = RES_DIR / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(
        f"""<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 从 public/icons/icon-512.png 取样得到的品牌绿，供自适应图标背景使用 -->
    <color name="ic_launcher_background">#{background[0]:02X}{background[1]:02X}{background[2]:02X}</color>
</resources>
""",
        encoding="utf-8",
    )
    print(f"background color: #{background[0]:02X}{background[1]:02X}{background[2]:02X}")


def main() -> int:
    if not SOURCE.exists():
        print(f"缺少源图标: {SOURCE}", file=sys.stderr)
        return 1
    icon = Image.open(SOURCE).convert("RGBA")
    if icon.width != icon.height:
        print("源图标不是正方形", file=sys.stderr)
        return 1
    write_density_pngs(icon)
    print(f"图标已生成: {RES_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

