"""事件固定色（对齐 UI 规范 §3.3 的 token 值）。

- 发售 release = 系统固定色
- 购买 purchase = 单独固定色
- 成就回退 = 主题色取不到时的兜底（成就 / 首玩取游戏主题色，此处仅兜底）
"""
from __future__ import annotations

RELEASE_COLOR = "#2F6BFF"      # --ev-release
PURCHASE_COLOR = "#0E9E68"     # --ev-purchase
ACHIEVE_FALLBACK = "#6D4AE0"   # --ev-achieve-fallback

__all__ = ["RELEASE_COLOR", "PURCHASE_COLOR", "ACHIEVE_FALLBACK"]
