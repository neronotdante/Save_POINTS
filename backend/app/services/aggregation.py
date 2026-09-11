"""日历聚合：把落库的 purchase / play_day / achievement / release_date / screenshot 派生为 TimelineEvent。

口径（对齐 PRD §3 与前端功能文档 §3 / 视图范式 07 §4.5）：
- 发售：``status == wishlist`` 且发售日落在当月（F-1；已发售归档不进入主显示区）。
- 购买：每游戏取**最早**入库时间（首次购买日期）。
- 首次游玩：每游戏取**最早**运行日（由 play_days 派生）。
- 成就簇：按 (游戏, 日) 聚合，count = 该日解锁数量。
- 截图：日详情 / 时间轴轴下方素材（P-12）。
- 渲染色：成就 / 首玩取游戏主题色（回退色兜底），购买 / 发售用系统固定色。
- 所有时间戳按 **UTC 计日**（V0.1 简化）。
"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.colors import ACHIEVE_FALLBACK, PURCHASE_COLOR, RELEASE_COLOR
from app.models.game import Achievement, Game, PlayDay, Purchase, Review, Screenshot, SyncState
from app.schemas.calendar import (
    DayCounts,
    DayDetailResponse,
    DayRow,
    GameBrief,
    ScreenshotOut,
    TimelineEvent,
    TimelineResponse,
)
from app.schemas.game import GameOut, ReviewOut

# 无精确时间戳的事件默认时刻（当日分钟数）：发售按 Steam 惯例 01:00，首玩取 12:00。
_RELEASE_MINUTES = 60
_FIRST_PLAY_MINUTES = 720


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    """返回 [start, end) 的当月日期边界。"""
    start = date(year, month, 1)
    end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return start, end


def _dt_bounds(start: date, end: date) -> tuple[datetime, datetime]:
    """date 边界 → naive UTC datetime 边界（用于 datetime 列过滤）。"""
    return datetime.combine(start, time.min), datetime.combine(end, time.min)


def _day_after(d: date) -> date:
    return d + timedelta(days=1)


@dataclass
class _RawEvent:
    """聚合中间态：先记录 game_id，解析出 Game 后再填 game / 主题色。"""

    date: date
    type: str
    count: int
    game_id: int | None
    minutes: int | None = None  # 当日分钟数（日详情用）


def _brief(game: Game) -> GameBrief:
    return GameBrief(
        appid=game.appid,
        name_zh=game.name_zh,
        name_en=game.name_en,
        cover=game.cover,
        cover_portrait=game.cover_portrait,
        theme_color=game.theme_color,
    )


def _games_by_id(db: Session, user_id: str, game_ids: set[int]) -> dict[int, Game]:
    if not game_ids:
        return {}
    games = db.scalars(select(Game).where(Game.user_id == user_id, Game.id.in_(game_ids))).all()
    return {g.id: g for g in games}


def _first_play_dates(db: Session, user_id: str) -> dict[int, date]:
    rows = db.execute(
        select(PlayDay.game_id, func.min(PlayDay.date))
        .where(PlayDay.user_id == user_id)
        .group_by(PlayDay.game_id)
    ).all()
    return {game_id: d for game_id, d in rows if d is not None}


def _first_purchase_dates(db: Session, user_id: str) -> dict[int, datetime]:
    rows = db.execute(
        select(Purchase.game_id, func.min(Purchase.time_created))
        .where(Purchase.user_id == user_id)
        .group_by(Purchase.game_id)
    ).all()
    return {game_id: t for game_id, t in rows if t is not None}


def _collect_raw(
    db: Session, user_id: str, start: date | None = None, end: date | None = None
) -> list[_RawEvent]:
    """收集原始事件（含 game_id，尚未填 game）。``start`` / ``end`` 为 None 表示全量。"""
    raw: list[_RawEvent] = []

    # 发售（wishlist 且有发售日；可选限定区间）
    conds = [Game.user_id == user_id, Game.status == "wishlist", Game.release_date.is_not(None)]
    if start is not None and end is not None:
        conds += [Game.release_date >= start, Game.release_date < end]
    for g in db.scalars(select(Game).where(*conds)).all():
        raw.append(
            _RawEvent(date=g.release_date, type="release", count=1, game_id=g.id,
                      minutes=_RELEASE_MINUTES)
        )

    # 购买：首次购买日期（可选限定区间）
    for game_id, t in _first_purchase_dates(db, user_id).items():
        if start is None or start <= t.date() < end:
            raw.append(
                _RawEvent(date=t.date(), type="purchase", count=1, game_id=game_id,
                          minutes=t.hour * 60 + t.minute)
            )

    # 首次游玩：最早运行日（可选限定区间）
    for game_id, d in _first_play_dates(db, user_id).items():
        if start is None or start <= d < end:
            raw.append(
                _RawEvent(date=d, type="first_play", count=1, game_id=game_id,
                          minutes=_FIRST_PLAY_MINUTES)
            )

    # 成就簇：按 (game, 日) 聚合（可选限定区间）
    ach_conds = [Achievement.user_id == user_id]
    if start is not None and end is not None:
        start_dt, end_dt = _dt_bounds(start, end)
        ach_conds += [Achievement.unlocktime >= start_dt, Achievement.unlocktime < end_dt]
    unlocks = db.execute(
        select(Achievement.game_id, Achievement.unlocktime).where(*ach_conds)
    ).all()
    cluster_count: dict[tuple[int, date], int] = defaultdict(int)
    cluster_first: dict[tuple[int, date], datetime] = {}
    for game_id, unlocktime in unlocks:
        key = (game_id, unlocktime.date())
        cluster_count[key] += 1
        if key not in cluster_first or unlocktime < cluster_first[key]:
            cluster_first[key] = unlocktime
    for (game_id, d), count in cluster_count.items():
        t = cluster_first[(game_id, d)]
        raw.append(
            _RawEvent(date=d, type="achievement", count=count, game_id=game_id,
                      minutes=t.hour * 60 + t.minute)
        )

    raw.sort(key=lambda e: (e.date, e.type))
    return raw


def _build_event(raw: _RawEvent, gmap: dict[int, Game]) -> TimelineEvent:
    game = gmap.get(raw.game_id) if raw.game_id is not None else None
    game_brief = _brief(game) if game else GameBrief(appid=0)

    if raw.type == "release":
        color = RELEASE_COLOR
    elif raw.type == "purchase":
        color = PURCHASE_COLOR
    else:
        color = (game.theme_color if game else None) or ACHIEVE_FALLBACK

    return TimelineEvent(date=raw.date, type=raw.type, count=raw.count,
                         minutes=raw.minutes, theme_color=color, game=game_brief)


def _screenshot_outs(db: Session, user_id: str, day: date | None = None) -> list[ScreenshotOut]:
    """截图（可选限定某日）→ 出参列表，补 game 简要信息。"""
    q = select(Screenshot).where(Screenshot.user_id == user_id)
    if day is not None:
        start_dt, end_dt = _dt_bounds(day, _day_after(day))
        q = q.where(Screenshot.taken_at >= start_dt, Screenshot.taken_at < end_dt)
    shots = db.scalars(q.order_by(Screenshot.taken_at)).all()
    gmap = _games_by_id(db, user_id, {s.game_id for s in shots})
    out: list[ScreenshotOut] = []
    for s in shots:
        game = gmap.get(s.game_id)
        out.append(
            ScreenshotOut(
                shot_id=s.shot_id,
                appid=game.appid if game else 0,
                taken_at=s.taken_at,
                thumbnail_url=s.thumbnail_url,
                url=s.url,
                privacy=s.privacy,
                game=_brief(game) if game else None,
            )
        )
    return out


def build_game_outs(db: Session, user_id: str) -> list[GameOut]:
    """游戏库出参（``/games`` 与 ``/timeline`` 的 ``games[]`` 共用）。

    存储字段直出 + 四项派生指标（运行天数 / 首玩日 / 购买日 / 短评）；
    **生命状态是读库即得**——由同步收尾的 ``recompute_user_lifecycle`` 写入，请求期不算（§5）。
    """
    games = db.scalars(select(Game).where(Game.user_id == user_id).order_by(Game.appid)).all()
    if not games:
        return []

    play_counts = dict(
        db.execute(
            select(PlayDay.game_id, func.count(PlayDay.id))
            .where(PlayDay.user_id == user_id)
            .group_by(PlayDay.game_id)
        ).all()
    )
    first_plays = _first_play_dates(db, user_id)
    purchases = _first_purchase_dates(db, user_id)
    unlocked = dict(
        db.execute(
            select(Achievement.game_id, func.count(Achievement.id))
            .where(Achievement.user_id == user_id)
            .group_by(Achievement.game_id)
        ).all()
    )
    reviews = {
        r.appid: r for r in db.scalars(select(Review).where(Review.user_id == user_id)).all()
    }

    out: list[GameOut] = []
    for g in games:
        review = reviews.get(g.appid)
        out.append(
            GameOut(
                appid=g.appid,
                name_zh=g.name_zh,
                name_en=g.name_en,
                cover=g.cover,
                cover_portrait=g.cover_portrait,
                developer=g.developer,
                release_date=g.release_date,
                status=g.status,
                theme_color=g.theme_color,
                theme_color_source=g.theme_color_source,
                play_days_count=play_counts.get(g.id, 0),
                first_play_date=first_plays.get(g.id),
                purchase_date=purchases.get(g.id),
                review=ReviewOut(rating=review.rating, comment=review.comment) if review else None,
                lifecycle=g.lifecycle,
                shelved_at=g.shelved_at,
                launched_ever=g.launched_ever,
                ach_unlocked=unlocked.get(g.id, 0),
                ach_total=g.ach_total or 0,
            )
        )
    return out


# 出参形状版本：`/timeline` 的字段集合每变一次就 +1（见 timeline_etag 的 ⚠️）。
# v2 = 2026-09-07 给 GameOut 加 theme_color_source。
# v3 = 2026-09-07 给 TimelineEvent 加 minutes（当日时刻）。
_SHAPE_VERSION = "v3"


def timeline_etag(db: Session, user_id: str) -> str:
    """``/timeline`` 的弱指纹：数据没变时让客户端直接吃 304，省下整份全量出参。

    只跑几条聚合查询（各表的行数 / 最大主键 + games 的最近更新时间 + 同步时间戳），
    **比构造全量响应便宜得多**——命中 304 时完全不进聚合。
    任一路数据变动（新事件、新截图、元数据刷新、生命状态重算）都会改变指纹。

    ⚠️ 指纹里必须带 ``_SHAPE_VERSION``：它只按**数据**算的时候，后端改了出参形状（加字段、
    改字段含义）指纹不变，客户端就一直吃 304、拿着旧结构的缓存体，新字段在前端永远是
    ``undefined``——而且没有任何报错。实测踩过一次：``theme_color_source`` 加进出参后，
    浏览器里连着好几次刷新都读不到它，curl 却是好的。**改出参形状就要把这个数 +1。**
    """
    parts: list[str] = [_SHAPE_VERSION, user_id]
    for model in (Game, PlayDay, Achievement, Purchase, Screenshot, Review):
        rows = db.execute(
            select(func.count(model.id), func.max(model.id)).where(model.user_id == user_id)
        ).one()
        parts.append(f"{model.__tablename__}:{rows[0]}:{rows[1]}")

    # 覆盖「行数不变但内容变了」的情形：生命状态重算、元数据刷新都会写 games.updated_at
    touched = db.execute(
        select(func.max(Game.updated_at)).where(Game.user_id == user_id)
    ).scalar()
    parts.append(f"games_touched:{touched}")

    state = db.get(SyncState, user_id)
    if state is not None:
        parts.append(f"sync:{state.last_sync_at}:{state.lifecycle_at}")

    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]
    return f'W/"{digest}"'


def get_month_events(db: Session, user_id: str, year: int, month: int) -> list[TimelineEvent]:
    start, end = _month_bounds(year, month)
    raw = _collect_raw(db, user_id, start, end)
    game_ids = {e.game_id for e in raw if e.game_id is not None}
    gmap = _games_by_id(db, user_id, game_ids)
    return [_build_event(e, gmap) for e in raw]


def get_timeline(db: Session, user_id: str) -> TimelineResponse:
    """时间轴（范式 B）一次性全量：时点事件 + 截图。"""
    raw = _collect_raw(db, user_id)
    game_ids = {e.game_id for e in raw if e.game_id is not None}
    gmap = _games_by_id(db, user_id, game_ids)
    events = [_build_event(e, gmap) for e in raw]
    screenshots = _screenshot_outs(db, user_id)
    return TimelineResponse(
        events=events, screenshots=screenshots, games=build_game_outs(db, user_id)
    )


def get_day_detail(db: Session, user_id: str, d: date) -> DayDetailResponse:
    """日详情浮层：三项计数 + 事件行（时间戳升序）+ 当日截图缩略图条。"""
    raw = _collect_raw(db, user_id, d, _day_after(d))
    game_ids = {e.game_id for e in raw if e.game_id is not None}
    gmap = _games_by_id(db, user_id, game_ids)

    counts = DayCounts()
    rows: list[DayRow] = []
    for e in raw:
        game = gmap.get(e.game_id) if e.game_id is not None else None
        game_brief = _brief(game) if game else GameBrief(appid=0)
        color = (game.theme_color if game else None) or ACHIEVE_FALLBACK
        if e.type == "release":
            counts.release += 1
        elif e.type == "first_play":
            counts.first_play += 1
        elif e.type == "achievement":
            counts.achievement += e.count
        # purchase 不进计数（规范只列三项）
        rows.append(
            DayRow(type=e.type, game=game_brief, theme_color=color, count=e.count,
                   time=e.minutes or 0)
        )

    rows.sort(key=lambda r: r.time)
    return DayDetailResponse(counts=counts, rows=rows, screenshots=_screenshot_outs(db, user_id, d))


__all__ = [
    "get_month_events",
    "get_timeline",
    "get_day_detail",
    "build_game_outs",
    "timeline_etag",
]
