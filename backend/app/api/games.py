"""游戏库与短评评分接口。"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Path, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models.game import Review
from app.models.user import User
from app.schemas.game import GameOut, ReviewRequest
from app.services.aggregation import build_game_outs

router = APIRouter(tags=["games"])


@router.get("/games", response_model=list[GameOut])
def list_games(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """游戏库：存储字段 + 派生指标（运行天数 / 首玩日 / 购买日 / 短评）+ 生命状态六件套。

    与 ``/calendar/timeline`` 的 ``games[]`` 是同一份构建逻辑，口径不会漂。
    """
    return build_game_outs(db, user.steamid)


@router.post("/games/{appid}/review", status_code=status.HTTP_204_NO_CONTENT)
def upsert_review(
    appid: int = Path(..., ge=1),
    body: ReviewRequest = Body(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """短评评分（P-5）：每用户每游戏一条，后写覆盖。"""
    review = db.scalars(
        select(Review).where(Review.user_id == user.steamid, Review.appid == appid)
    ).first()
    if review is None:
        review = Review(
            user_id=user.steamid, appid=appid, rating=body.rating, comment=body.comment
        )
        db.add(review)
    else:
        review.rating = body.rating
        review.comment = body.comment
    db.commit()
