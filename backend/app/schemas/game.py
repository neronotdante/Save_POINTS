"""游戏库与短评出入参。"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class ReviewOut(BaseModel):
    rating: int
    comment: str | None = None


Lifecycle = Literal["never_launched", "active", "dormant", "shelved"]


class GameOut(BaseModel):
    """``GET /games`` 与 ``GET /calendar/timeline`` 的 ``games[]`` 单条。

    = 存储字段 + 派生指标（运行天数 / 首玩日 / 购买日）+ **生命状态六件套**
    （PRD §3 / 07 §4.5 v1.3）：``lifecycle`` / ``shelved_at`` / ``launched_ever`` /
    ``play_days_count`` / ``ach_unlocked`` / ``ach_total``，供前端画封盘帽（07 §4.9）
    与「隐藏从未启动」开关本地过滤。

    注：``playtime_forever`` **不出参**——仅供后端封盘判定，界面上「玩得久不久」
    只有 ``play_days_count`` 一个口径（PRD §3）。
    """

    appid: int
    name_zh: str | None = None
    name_en: str | None = None
    cover: str | None = None
    cover_portrait: str | None = None
    developer: str | None = None
    release_date: date | None = None
    status: str
    theme_color: str | None = None
    # 取色来源：local = 真从封面里取到的；fallback = 这次没取成、给的是兜底紫；None = 还没算过。
    # 出参的理由：前端要拿主题色画封面边框，**必须能区分「这是这款游戏的颜色」和「这是兜底色」**
    # ——不然一堵一样的紫边看着像 bug。区分得出来，前端才好对没取到的那些自己从封面重算一次。
    theme_color_source: str | None = None
    play_days_count: int = 0
    first_play_date: date | None = None
    purchase_date: datetime | None = None
    review: ReviewOut | None = None
    # --- 生命状态（PRD §3；后端同步收尾派生，请求期只读） ---
    lifecycle: Lifecycle = "never_launched"
    shelved_at: datetime | None = None
    launched_ever: bool = False
    ach_unlocked: int = 0
    ach_total: int = 0


class ReviewRequest(BaseModel):
    """短评评分（P-5）。"""

    rating: int = Field(..., ge=1, le=5, description="1~5 分")
    comment: str | None = Field(default=None, max_length=2000)
