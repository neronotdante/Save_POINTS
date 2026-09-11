"""同步接口：手动同步（SSE 进度事件流）、同步状态、购买入库。"""
from __future__ import annotations

import json
import logging
from collections.abc import Generator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.security import decrypt_apikey
from app.database import get_db
from app.models.user import User
from app.schemas.sync import PurchasesRequest, SyncStatusResponse
from app.services.sync_service import (
    get_state,
    ingest_purchases,
    iter_user_sync,
    release_sync,
    try_acquire_sync,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sync"])


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/sync")
def manual_sync(user: User = Depends(get_current_user)):
    """手动触发同步，返回 SSE 进度事件流（owned_games → recently_played → achievements → screenshots → done）。

    并发保护：同一用户已有同步在跑时返回 409，不并行开两轮。
    """
    if not user.apikey_enc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="尚未绑定 API Key")
    if not try_acquire_sync(user.steamid):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="同步正在进行中")

    apikey = decrypt_apikey(user.apikey_enc)
    steamid = user.steamid

    def stream() -> Generator[str, None, None]:
        try:
            for event in iter_user_sync(steamid, apikey):
                yield _sse(event.get("step", "message"), event)
        except Exception as exc:  # noqa: BLE001
            logger.exception("手动同步失败")
            yield _sse("error", {"message": str(exc)})
        finally:
            release_sync(steamid)

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/sync/status", response_model=SyncStatusResponse)
def sync_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """底栏同步状态 + 上次同步时间戳 + 失败原因。"""
    if not user.apikey_enc:
        return SyncStatusResponse(status="unconfigured", has_key=False)
    state = get_state(db, user.steamid)
    db.commit()
    return SyncStatusResponse(
        status=state.status, last_sync_at=state.last_sync_at,
        last_error=state.last_error, has_key=True,
    )


@router.post("/purchases", status_code=status.HTTP_204_NO_CONTENT)
def submit_purchases(
    body: PurchasesRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """购买 / 入库记录提交（补充接口：客户端登录后拉 license list + PICS 映射后提交）。"""
    purchases = [
        {
            "appid": p.appid,
            "time_created": p.time_created,
            "payment_method": p.payment_method,
        }
        for p in body.purchases
    ]
    ingest_purchases(db, user.steamid, purchases)
    db.commit()
