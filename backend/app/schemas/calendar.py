"""日历聚合出入参。

字段命名说明（客户端对接映射）：
- ``theme_color`` 在日详情浮层消费为 ``themeColor``；
- ``name_zh`` / ``name_en`` 在客户端消费为 ``zh`` / ``en``。
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.game import GameOut

EventType = Literal["release", "purchase", "first_play", "achievement"]


class GameBrief(BaseModel):
    """日历事件里游戏的最小字段（不重复游戏库全量）。"""

    appid: int
    name_zh: str | None = None
    name_en: str | None = None
    cover: str | None = None
    cover_portrait: str | None = None
    theme_color: str | None = None


class TimelineEvent(BaseModel):
    """月历事件（``GET /calendar/{year}/{month}`` 返回扁平数组，客户端按 date 分组）。

    - ``type``：release(发售) | purchase(购买) | first_play(首次游玩) | achievement(成就簇)。
    - ``count``：成就簇为该日解锁数量，其余为 1。
    - ``theme_color``：成就 / 首玩取游戏主题色；购买 / 发售为后端下发的系统固定色。
    - ``minutes``：**当日第几分钟**（0~1439）。成就簇取该 (游戏, 日) **最早**一次解锁的时刻；
      购买取真实下单时刻；发售与首玩没有精确时间戳，按惯例值（01:00 / 12:00）给。
      与 ``DayRow.time`` 同一口径、同一来源。

      有它才谈得上「当天第一件事是什么」——原来出参里只有 ``date``（到日），同一天的事件按
      ``(date, type)`` 排序落到客户端手里，`type` 是**字符串序**，同类型之间更是数据库扫描
      顺序。客户端据此挑出来的「第一个成就」是个任意值，而不是最早那个。
    """

    date: date
    type: EventType
    count: int = Field(default=1, ge=1)
    minutes: int | None = Field(default=None, ge=0, le=1439)
    theme_color: str | None = None
    game: GameBrief


class DayCounts(BaseModel):
    """日详情三项计数（购买不进计数，规范只列三项）。"""

    achievement: int = 0
    first_play: int = 0
    release: int = 0


class DayRow(BaseModel):
    """日详情单行事件（按时间戳升序）。``time`` = 当日分钟数（0..1439）。"""

    type: EventType
    game: GameBrief
    theme_color: str | None = None
    count: int = Field(default=1, ge=1)
    time: int = Field(ge=0, le=1439, description="当日分钟数")


class ScreenshotOut(BaseModel):
    """截图缩略图（日详情浮层 / 时间轴轴下方用）。"""

    shot_id: str
    appid: int
    taken_at: datetime
    thumbnail_url: str | None = None
    url: str | None = None
    privacy: int = 0
    game: GameBrief | None = None


class DayDetailResponse(BaseModel):
    counts: DayCounts
    rows: list[DayRow]
    screenshots: list[ScreenshotOut] = Field(default_factory=list)


class TimelineResponse(BaseModel):
    """时间轴（范式 B）一次性全量数据：时点事件 + 截图 + 游戏（07 §4.5 / §4.7）。

    ``games`` 带生命状态六件套（PRD §3），供前端画封盘帽（07 §4.9）与
    「隐藏从未启动」开关**本地过滤**——切换开关不重新请求。
    """

    events: list[TimelineEvent]
    screenshots: list[ScreenshotOut]
    games: list[GameOut] = Field(default_factory=list)
