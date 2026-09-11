"""游戏生命状态派生（PRD §3 封盘判定，P-13 / P-14）。

口径要点（唯一来源是 [[02_PRD_游戏日历|PRD]] §3）：

- **判据是「最后一次启动时间」** ``last_active_at`` —— 取 ``rtime_last_played``
  （Steam 直接给的最后启动时间）与本地三路来源（运行日 / 成就解锁 / 截图截取）的**最大值**。
- **只在采集收尾算，不在请求期算**：``/timeline`` 要一次性返回全量，判定必须读库即得。
- **幂等且无状态**：只看当下的 ``last_active_at``，不读上一次的 ``lifecycle``——
  再次启动会自然回落到 ``active`` 并清空 ``shelved_at``，无需回滚逻辑、无需状态机。
- 阈值是**服务端常量**，V0.1 写死不暴露（PRD §5 非目标：不做界面配置）；
  改动后用 :func:`recompute_all_lifecycle` 一次性重算全库。
"""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.timeutil import utcnow
from app.models.game import (
    LIFECYCLE_ACTIVE,
    LIFECYCLE_DORMANT,
    LIFECYCLE_NEVER_LAUNCHED,
    LIFECYCLE_SHELVED,
    Achievement,
    Game,
    PlayDay,
    Screenshot,
)

logger = logging.getLogger(__name__)

# --- 阈值（PRD §3，V0.1 写死） ---
T_QUIET = timedelta(days=45)   # 沉寂：一个半月没启动，这一轮就算过去了
T_TIME_MINUTES = 600           # 投入·时长：10h 是「玩进去了」的常见门槛
T_ACH_RATIO = 0.10             # 投入·成就比例：只看比例，不设绝对数目门槛


def _max_dt(*values: datetime | None) -> datetime | None:
    """取非空最大值；全为空返回 None。"""
    present = [v for v in values if v is not None]
    return max(present) if present else None


def _last_play_dates(db: Session, user_id: str) -> dict[int, datetime]:
    """每游戏最后运行日 → 当日 00:00（date 列升维成 datetime，便于与时间戳取 max）。"""
    rows = db.execute(
        select(PlayDay.game_id, func.max(PlayDay.date))
        .where(PlayDay.user_id == user_id)
        .group_by(PlayDay.game_id)
    ).all()
    return {gid: datetime.combine(d, time.min) for gid, d in rows if d is not None}


def _last_unlocks(db: Session, user_id: str) -> dict[int, datetime]:
    rows = db.execute(
        select(Achievement.game_id, func.max(Achievement.unlocktime))
        .where(Achievement.user_id == user_id)
        .group_by(Achievement.game_id)
    ).all()
    return {gid: t for gid, t in rows if t is not None}


def _unlock_counts(db: Session, user_id: str) -> dict[int, int]:
    rows = db.execute(
        select(Achievement.game_id, func.count(Achievement.id))
        .where(Achievement.user_id == user_id)
        .group_by(Achievement.game_id)
    ).all()
    return dict(rows)


def _last_shots(db: Session, user_id: str) -> dict[int, datetime]:
    rows = db.execute(
        select(Screenshot.game_id, func.max(Screenshot.taken_at))
        .where(Screenshot.user_id == user_id)
        .group_by(Screenshot.game_id)
    ).all()
    return {gid: t for gid, t in rows if t is not None}


def classify(
    *,
    last_active_at: datetime | None,
    launched_ever: bool,
    playtime_forever: int,
    ach_unlocked: int,
    ach_total: int,
    now: datetime,
) -> str:
    """纯函数判定四态（PRD §3 的判定表逐条翻译，便于单测）。"""
    if not launched_ever:
        return LIFECYCLE_NEVER_LAUNCHED
    if last_active_at is None:
        # 启动过（playtime_forever > 0）却拿不到任何时间证据：无法算沉寂天数。
        # 保守归 dormant——轴上不画标记，不会误报封盘。
        return LIFECYCLE_DORMANT
    if now - last_active_at < T_QUIET:
        return LIFECYCLE_ACTIVE
    # 沉寂已够久，再看投入是否达标（两条是「或」：时长长 / 成就刷得多，任一即可）
    invested = playtime_forever >= T_TIME_MINUTES or (
        ach_total > 0 and ach_unlocked / ach_total >= T_ACH_RATIO
    )
    return LIFECYCLE_SHELVED if invested else LIFECYCLE_DORMANT


def recompute_user_lifecycle(
    db: Session, user_id: str, *, now: datetime | None = None
) -> int:
    """重算某用户全部游戏的生命状态，返回**发生变化**的条数（不 commit，由调用方决定）。"""
    now = now or utcnow()
    games = db.scalars(select(Game).where(Game.user_id == user_id)).all()
    if not games:
        return 0

    play = _last_play_dates(db, user_id)
    unlock_at = _last_unlocks(db, user_id)
    unlocked = _unlock_counts(db, user_id)
    shots = _last_shots(db, user_id)

    changed = 0
    for g in games:
        local_last = _max_dt(play.get(g.id), unlock_at.get(g.id), shots.get(g.id))
        last_active = _max_dt(g.rtime_last_played, local_last)
        # 「启动过」= 有任意一路本地证据，或 Steam 侧记了时长 / 最后启动时间
        launched_ever = bool(
            local_last is not None or g.playtime_forever > 0 or g.rtime_last_played is not None
        )
        lifecycle = classify(
            last_active_at=last_active,
            launched_ever=launched_ever,
            playtime_forever=g.playtime_forever or 0,
            ach_unlocked=unlocked.get(g.id, 0),
            ach_total=g.ach_total or 0,
            now=now,
        )
        shelved_at = last_active if lifecycle == LIFECYCLE_SHELVED else None

        if (
            g.lifecycle != lifecycle
            or g.launched_ever != launched_ever
            or g.last_active_at != last_active
            or g.shelved_at != shelved_at
        ):
            changed += 1
        g.lifecycle = lifecycle
        g.launched_ever = launched_ever
        g.last_active_at = last_active
        g.shelved_at = shelved_at
        g.lifecycle_at = now
    return changed


def recompute_all_lifecycle(db: Session, *, now: datetime | None = None) -> int:
    """阈值改动后一次性重算全库（逐用户跑，返回变化总数）。"""
    now = now or utcnow()
    user_ids = [uid for (uid,) in db.execute(select(Game.user_id).distinct()).all()]
    total = 0
    for uid in user_ids:
        total += recompute_user_lifecycle(db, uid, now=now)
    logger.info("全库生命状态重算完成：%d 个用户，%d 条变化", len(user_ids), total)
    return total


__all__ = [
    "T_QUIET",
    "T_TIME_MINUTES",
    "T_ACH_RATIO",
    "classify",
    "recompute_user_lifecycle",
    "recompute_all_lifecycle",
]
