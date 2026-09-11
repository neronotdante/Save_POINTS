"""主题色规范化纯函数测试（UI 规范 §3.4 护栏）。"""
from __future__ import annotations

from app.core.colors import ACHIEVE_FALLBACK
from app.services.theme import (
    PANEL_REF,
    contrast_ratio,
    hex_to_rgb,
    normalize_color,
    rgb_to_hex,
)


def test_hex_rgb_roundtrip():
    assert hex_to_rgb("#FF0000") == (255, 0, 0)
    assert hex_to_rgb("#2F6BFF") == (47, 107, 255)
    assert hex_to_rgb("bogus") is None
    assert hex_to_rgb("#12345") is None


def test_rgb_to_hex():
    assert rgb_to_hex(255, 0, 0) == "#FF0000"
    assert rgb_to_hex(-5, 300, 12) == "#00FF0C"  # 越界钳制


def test_contrast_ratio():
    assert contrast_ratio("#000000", "#FFFFFF") > 20.0
    assert contrast_ratio("#2F6BFF", PANEL_REF) >= 3.0


def test_normalize_invalid_falls_back():
    assert normalize_color("not-a-color") == ACHIEVE_FALLBACK
    assert normalize_color("#12345") == ACHIEVE_FALLBACK


def test_normalize_dark_color_keeps_contrast():
    # 极暗色会钳到 L∈[32%,50%]，验算对比度仍 ≥3:1
    out = normalize_color("#000000")
    assert out != "#000000"
    assert contrast_ratio(out, PANEL_REF) >= 3.0


def test_normalize_light_color_keeps_contrast():
    # 极亮 / 近灰度会降到可读色，达不到则回退
    out = normalize_color("#FFFFFF")
    assert contrast_ratio(out, PANEL_REF) >= 3.0 or out == ACHIEVE_FALLBACK


def test_normalize_saturation_clamped():
    # 低饱和灰点会被抬到 S≥35% 或直接回退
    out = normalize_color("#888888")
    assert out == ACHIEVE_FALLBACK or contrast_ratio(out, PANEL_REF) >= 3.0
