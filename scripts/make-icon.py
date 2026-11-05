"""生成桌面端打包图标 build/icon.png（1024×1024）。

图标沿用安卓端（client-android）的品牌图形：源图 build/icon-source.png 就是
安卓自适应图标的前景层 ic_launcher_foreground.png（432×432）。

直接放大位图边缘会发虚，所以这里放大的是“覆盖率”而不是颜色：
把 alpha 当作 0..1 的覆盖率，用三次插值上采样后再做一次陡化，
让 50% 等值线落在插值出的真实轮廓上，边缘既清晰又不会出现锯齿。

用法：python scripts/make-icon.py
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "icon-source.png"
OUT = ROOT / "build" / "icon.png"

SIZE = 1024
# 下面三个比例取自安卓端 ic_launcher.png（192×192）的实测值。
CORNER_RATIO = 36 / 192
GLYPH_WIDTH_RATIO = 102 / 192
GLYPH_CENTER_RATIO = (95.5 / 192, 96.5 / 192)

MAIN_COLOR = (255, 81, 127)
# 前景图右上角那个浅粉圆点的填充透明度。
DOT_LEVEL = 84 / 255
# 陡化宽度：越小边缘越锐，过小会把源图栅格的抖动放大出来。
EDGE_WIDTH = 0.4
# 陡化前的高斯平滑半径（1024 画布像素）。
SMOOTH = 1.0


def dilate(mask: np.ndarray, times: int) -> np.ndarray:
    """4 邻域膨胀，用来找“离主字形足够远”的区域。"""
    out = mask.copy()
    for _ in range(times):
        grown = out.copy()
        grown[1:, :] |= out[:-1, :]
        grown[:-1, :] |= out[1:, :]
        grown[:, 1:] |= out[:, :-1]
        grown[:, :-1] |= out[:, 1:]
        out = grown
    return out


def upscale(cov: np.ndarray, scale: float, offset: tuple[float, float]) -> np.ndarray:
    """按 目标坐标 = 源坐标 × scale + offset 把覆盖率搬到 SIZE 画布。"""
    field = Image.fromarray(cov.astype(np.float32), mode="F")
    # 目标坐标 → 源坐标
    inv = 1 / scale
    coeffs = (inv, 0, -offset[0] * inv, 0, inv, -offset[1] * inv)
    warped = field.transform((SIZE, SIZE), Image.AFFINE, coeffs, resample=Image.BICUBIC)
    return np.asarray(warped)


def blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """可分离高斯模糊（Pillow 的滤镜不支持浮点图，这里直接算）。"""
    radius = max(1, round(sigma * 3))
    x = np.arange(-radius, radius + 1)
    kernel = np.exp(-(x**2) / (2 * sigma**2))
    kernel /= kernel.sum()
    h, w = img.shape
    padded = np.pad(img, ((0, 0), (radius, radius)), mode="edge")
    out = sum(kernel[i] * padded[:, i : i + w] for i in range(2 * radius + 1))
    padded = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
    return sum(kernel[i] * padded[i : i + h, :] for i in range(2 * radius + 1))


def crisp(cov: np.ndarray) -> np.ndarray:
    """先抹平源图 1px 栅格带来的抖动，再把 0..1 覆盖率陡化。

    陡化让边缘落在插值出的真实轮廓上，既清晰又不会出现锯齿。
    """
    t = np.clip((blur(cov, SMOOTH) - 0.5) / EDGE_WIDTH + 0.5, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def rounded_tile_alpha() -> np.ndarray:
    """白色圆角底板的 alpha，4× 超采样后缩小以得到平滑圆角。"""
    ss = 4
    big = Image.new("L", (SIZE * ss, SIZE * ss), 0)
    radius = CORNER_RATIO * SIZE * ss
    ImageDraw.Draw(big).rounded_rectangle((0, 0, SIZE * ss - 1, SIZE * ss - 1), radius=radius, fill=255)
    return np.asarray(big.resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float64) / 255


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    alpha = np.asarray(src)[..., 3].astype(np.float64) / 255

    # 主字形与浅粉圆点在位图上是两个独立色块，先分开再各自放大。
    glyph = alpha >= 0.5
    pale = (alpha > 0.12) & (alpha < 0.6) & ~dilate(glyph, 3)
    if not pale.any():
        raise SystemExit("前景图里没找到浅粉圆点，检查 build/icon-source.png")
    dot_zone = dilate(pale, 2)
    glyph_cov = np.where(dot_zone, 0.0, alpha)
    dot_cov = np.where(dot_zone, alpha / DOT_LEVEL, 0.0)

    ys, xs = np.nonzero(glyph)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    scale = (GLYPH_WIDTH_RATIO * SIZE) / (x1 - x0 + 1)
    offset = (
        GLYPH_CENTER_RATIO[0] * SIZE - (x0 + x1 + 1) / 2 * scale,
        GLYPH_CENTER_RATIO[1] * SIZE - (y0 + y1 + 1) / 2 * scale,
    )

    glyph_alpha = crisp(upscale(glyph_cov, scale, offset))
    dot_alpha = crisp(upscale(dot_cov, scale, offset)) * DOT_LEVEL

    # 白底上依次叠圆点与字形（两者不重叠，顺序无关）。
    rgb = np.full((SIZE, SIZE, 3), 255.0)
    for a in (dot_alpha, glyph_alpha):
        a = a[..., None]
        rgb = rgb * (1 - a) + np.array(MAIN_COLOR, dtype=np.float64) * a

    out = np.dstack([rgb, rounded_tile_alpha() * 255]).clip(0, 255).round().astype(np.uint8)
    Image.fromarray(out, mode="RGBA").save(OUT)
    print(f"icon written to {OUT} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
