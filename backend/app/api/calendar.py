"""日历接口：月事件聚合与日详情。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Header, Path, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.calendar import DayDetailResponse, TimelineEvent, TimelineResponse
from app.services.aggregation import (
    get_day_detail,
    get_month_events,
    get_timeline,
    timeline_etag,
)

router = APIRouter(prefix="/calendar", tags=["calendar"])


@router.get("/timeline", response_model=TimelineResponse)
def timeline(
    response: Response,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """时间轴（范式 B）一次性全量：时点事件 + 截图 + 游戏（带生命状态），前端本地过滤。

    带 **ETag**：全量出参在大库上不小，而两次同步之间数据完全不变。客户端回带
    ``If-None-Match`` 时先比指纹，命中就直接 304——**连聚合都不做**（指纹只跑几条计数查询）。

    ``Cache-Control: no-cache`` 是**必须显式写出来的**，不是保险起见。只给 ETag 而不给任何
    新鲜度信息时，浏览器会按 RFC 9111 的**启发式缓存**自行给它定一个保质期，在这段时间里
    直接吃本地副本、连一次条件请求都不发。实测症状：同步（或直接改库）之后刷新页面，拿到的
    还是旧的 timeline，且没有任何报错——只能靠 no-store 或硬刷新才看得到新数据。
    ``no-cache`` 的意思不是「不许缓存」而是「每次都得来问一句」：副本照存，ETag 一致时
    仍然走 304 空响应，省下的还是整个 payload。
    """
    etag = timeline_etag(db, user.steamid)
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if if_none_match and if_none_match.strip() == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    response.headers.update(headers)
    return get_timeline(db, user.steamid)


@router.get("/day/{day}", response_model=DayDetailResponse)
def day_detail(
    day: date = Path(..., description="YYYY-MM-DD"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """日详情浮层：三项计数 + 事件行（时间戳升序）。"""
    return get_day_detail(db, user.steamid, day)


@router.get("/{year}/{month}", response_model=list[TimelineEvent])
def month_events(
    year: int = Path(..., ge=2000, le=2100),
    month: int = Path(..., ge=1, le=12),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当月日历事件（后端聚合后输出，客户端按 date 分组渲染）。"""
    return get_month_events(db, user.steamid, year, month)
