"""成就明细出参（``GET /achievements/{appid}/{date}``，07 §4.8 成就形态 panel）。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class AchievementDetail(BaseModel):
    """单条成就（展示三件套 + 解锁时间，03 §4.3a）。

    - ``display_name`` / ``icon_url`` 来自 ``GetSchemaForGame``；
    - ``global_percent`` 来自 ``GetGlobalAchievementPercentagesForApp``，
      panel 上按 1 位小数渲染（如 ``3.9%``）；
    - 三件套任一源采集失败时为 ``None``，前端按缺省降级（不阻塞解锁时间的展示）。
    """

    achievement_id: str
    display_name: str | None = None
    icon_url: str | None = None
    global_percent: float | None = None
    unlocktime: datetime


__all__ = ["AchievementDetail"]
