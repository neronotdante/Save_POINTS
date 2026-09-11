"""愿望单提交接口：客户端用登录态拉取后整体提交，后端补元数据并落库。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.timeutil import utcnow
from app.database import get_db
from app.models.user import User
from app.schemas.wishlist import WishlistRequest
from app.services.steam import get_steam_client
from app.services.sync_service import get_state, ingest_wishlist

router = APIRouter(tags=["wishlist"])


@router.post("/wishlist", status_code=status.HTTP_204_NO_CONTENT)
def submit_wishlist(
    body: WishlistRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """提交愿望单（appid + priority）。后端不缓存 access_token，只存结果。

    注：首次提交会逐 appid 调 Store API 补发售日 / 封面（带 429 退避），大愿望单耗时较长。
    """
    items = [{"appid": i.appid, "priority": i.priority} for i in body.items]
    # with：大愿望单要逐 appid 打 Store API，这些请求共用一个连接池，用完即释放
    with get_steam_client() as steam:
        ingest_wishlist(db, user.steamid, items, steam)

    state = get_state(db, user.steamid)
    state.wishlist_at = utcnow()
    db.commit()
