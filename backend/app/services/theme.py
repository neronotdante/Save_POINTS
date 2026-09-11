"""游戏主题色取色与规范化（对齐 UI 规范 §3.4 的纯函数护栏）。

链路：① 色值 API（可选，本实现未接入第三方 Key，返回 None）→ ② 本地封面取色
（Pillow 可选依赖，中位切分）→ ③ 回退色 ``#6D4AE0``。

规范化规则（UI 规范 §3.4）：
1. 转 HSL（H 不变）；
2. 钳制 ``S → clamp(S, 35%, 85%)``、``L → clamp(L, 32%, 50%)``；
3. 与 ``--panel-ref``（``#F2F4F8``）验算对比度，不足 3:1 则以 4% 步长降 ``L``，
   下限 ``L = 24%``；仍不足则改用回退色。
"""
from __future__ import annotations

import colorsys

from app.core.colors import ACHIEVE_FALLBACK

PANEL_REF = "#F2F4F8"  # --panel-ref：对比度计算基准
MIN_CONTRAST = 3.0

# 「这张封面近乎灰度、取不出有意义的颜色」的判据：有效像素的平均饱和度下限。
#
# 原值 0.12 过严。理由是 normalize_color() **本来就把 S 钳到 35~85%**——低饱和的源色也会被
# 提到一个正常的可读颜色，所以这道门槛该判的只是「这张图到底有没有色相」，而不是「够不够艳」。
# 0.12 会把 Half-Life 2、Skyrim、Dishonored 这类偏暗偏灰的美术整片挡掉，落回同一个兜底紫。
#
# 实测（27 张真实封面，都是当前取不到色的）：0.12 → 9 张、0.08 → 13、**0.05 → 19**、0.03 → 22。
# 取 0.05：真·黑白封面（平均饱和度 0.0x）仍然被挡住，那道兜底还在。再往下就是在噪声里捞色相了。
SAT_FLOOR = 0.05


# --------------------------------------------------------------------------
# 纯函数：颜色转换与规范化（可单测）
# --------------------------------------------------------------------------

def hex_to_rgb(hex_color: str) -> tuple[int, int, int] | None:
    h = (hex_color or "").lstrip("#")
    if len(h) != 6:
        return None
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return None


def rgb_to_hex(r: int, g: int, b: int) -> str:
    return "#{:02X}{:02X}{:02X}".format(
        max(0, min(255, round(r))), max(0, min(255, round(g))), max(0, min(255, round(b)))
    )


def _relative_luminance(rgb: tuple[int, int, int]) -> float:
    def channel(c: int) -> float:
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = channel(rgb[0]), channel(rgb[1]), channel(rgb[2])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(hex_a: str, hex_b: str) -> float:
    """WCAG 对比度（1~21）。"""
    rgb_a, rgb_b = hex_to_rgb(hex_a), hex_to_rgb(hex_b)
    if rgb_a is None or rgb_b is None:
        return 0.0
    la, lb = _relative_luminance(rgb_a), _relative_luminance(rgb_b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def normalize_color(hex_color: str, *, min_contrast: float = MIN_CONTRAST) -> str:
    """规范化主题色；输入非法或对比度无法达标时返回回退色。"""
    rgb = hex_to_rgb(hex_color)
    if rgb is None:
        return ACHIEVE_FALLBACK

    r, g, b = rgb
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    s = min(0.85, max(0.35, s))
    l = min(0.50, max(0.32, l))

    # 不足 3:1 则以 4% 步长降 L，下限 24%
    while l >= 0.24:
        r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
        candidate = rgb_to_hex(r2 * 255, g2 * 255, b2 * 255)
        if contrast_ratio(candidate, PANEL_REF) >= min_contrast:
            return candidate
        l -= 0.04

    # 降到 24% 仍不足 → 回退
    return ACHIEVE_FALLBACK


# --------------------------------------------------------------------------
# 本地封面取色（中位切分；Pillow 为可选依赖，缺失时返回 None）
# --------------------------------------------------------------------------

def pick_color_from_cover(cover_bytes: bytes, k: int = 3) -> str | None:
    """对封面字节做中位切分取主色；近灰度 / 无有效像素返回 None。"""
    try:
        from PIL import Image  # 延迟导入，Pillow 为可选依赖
    except ImportError:  # pragma: no cover - 依赖缺失路径
        return None

    try:
        img = Image.open(__import__("io").BytesIO(cover_bytes)).convert("RGB")
    except Exception:  # noqa: BLE001
        return None

    img = img.resize((64, 64))
    pixels = list(img.getdata())

    # 丢弃极亮 / 极暗像素（L < 12% / L > 92%）
    def keep(px: tuple[int, int, int]) -> bool:
        r, g, b = px
        _, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        return 0.12 < l < 0.92

    kept = [p for p in pixels if keep(p)]
    if len(kept) < 64:  # 有效像素太少
        return None

    # 近灰度兜底：整体饱和度低于 SAT_FLOOR 时交给回退
    def sat(px: tuple[int, int, int]) -> float:
        r, g, b = px
        _, _, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        return s

    if sum(sat(p) for p in kept) / len(kept) < SAT_FLOOR:
        return None

    # 中位切分 → k 个桶，取像素最多桶的均值
    buckets = [kept]
    while len(buckets) < k:
        idx, bucket = max(enumerate(buckets), key=lambda t: _channel_range(t[1]))
        ch = _widest_channel(bucket)
        bucket.sort(key=lambda px: px[ch])
        mid = len(bucket) // 2
        if mid == 0 or mid == len(bucket):
            break
        buckets[idx : idx + 1] = [bucket[:mid], bucket[mid:]]

    dominant = max(buckets, key=len)
    n = len(dominant)
    r = sum(p[0] for p in dominant) / n
    g = sum(p[1] for p in dominant) / n
    b = sum(p[2] for p in dominant) / n
    return rgb_to_hex(r, g, b)


def _channel_range(pixels: list[tuple[int, int, int]]) -> int:
    if not pixels:
        return 0
    rs = [p[0] for p in pixels]
    gs = [p[1] for p in pixels]
    bs = [p[2] for p in pixels]
    return max(max(rs) - min(rs), max(gs) - min(gs), max(bs) - min(bs))


def _widest_channel(pixels: list[tuple[int, int, int]]) -> int:
    ranges = [_channel_range(pixels), 0, 0]
    ranges[1] = max([p[1] for p in pixels]) - min([p[1] for p in pixels])
    ranges[2] = max([p[2] for p in pixels]) - min([p[2] for p in pixels])
    return max(range(3), key=lambda i: ranges[i])


def color_extraction_available() -> bool:
    """本地取色是否可用（Pillow 在位）。

    给调用方一个**在下载封面之前**就能问的问题：取不了色就别下图。
    曾经的行为是「每款游戏下完 1~2s 的封面，再在解码那一步 ImportError 丢掉」，
    297 款的库里白白花掉约 10 分钟。
    """
    try:
        import PIL  # noqa: F401
    except ImportError:
        return False
    return True


def compute_theme_color(cover_bytes: bytes | None) -> tuple[str, str]:
    """主题色编排：① API（未接入）→ ② 本地取色 → ③ 回退。

    返回 ``(source, color)``，source ∈ {api, local, fallback}。
    """
    if cover_bytes:
        local = pick_color_from_cover(cover_bytes)
        if local:
            return "local", normalize_color(local)
    return "fallback", ACHIEVE_FALLBACK


__all__ = [
    "PANEL_REF",
    "hex_to_rgb",
    "rgb_to_hex",
    "contrast_ratio",
    "normalize_color",
    "pick_color_from_cover",
    "compute_theme_color",
    "color_extraction_available",
]
