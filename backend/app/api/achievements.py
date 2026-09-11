"""成就明细接口：时点悬浮 panel 的成就形态按需懒加载（07 §4.5 / §4.8，v2.0）。

明细**不进 ``/timeline`` 全量出参**——体积会翻几倍；``/timeline`` 的成就事件只带数量，
悬浮成就簇时前端才用 ``(appid, 日期)`` 到这里取当日明细。
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, Path
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models.game import Achievement, Game
from app.models.user import User
from app.schemas.achievement import AchievementDetail

router = APIRouter(tags=["achievements"])


@router.get("/achievements/{appid}/{day}", response_model=list[AchievementDetail])
def achievements_of_day(
    appid: int = Path(..., ge=1),
    day: date = Path(..., description="YYYY-MM-DD（UTC 计日，与时间轴一致）"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """某游戏在某日解锁的全部成就，按解锁时间升序。

    游戏不属于该用户 / 当日无解锁时返回空数组（不是 404）——悬浮取数不该以错误呈现。
    """
    game_id = db.scalars(
        select(Game.id).where(Game.user_id == user.steamid, Game.appid == appid)
    ).first()
    if game_id is None:
        return []

    start = datetime.combine(day, time.min)
    end = start + timedelta(days=1)
    rows = db.scalars(
        select(Achievement)
        .where(
            Achievement.user_id == user.steamid,
            Achievement.game_id == game_id,
            Achievement.unlocktime >= start,
            Achievement.unlocktime < end,
        )
        .order_by(Achievement.unlocktime)
    ).all()

    return [
        AchievementDetail(
            achievement_id=a.achievement_id,
            display_name=a.display_name,
            icon_url=a.icon_url,
            global_percent=a.global_percent,
            unlocktime=a.unlocktime,
        )
        for a in rows
    ]
