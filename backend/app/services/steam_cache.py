"""公共上游数据的缓存层（读穿 / 写回）。

只包住**与用户无关**的三个接口。调用方从这里取，命中就不打上游：

- :func:`get_app_details` —— Store 元数据（名称 / 封面 / 发售日 / 开发商）
- :func:`get_schema_for_game` —— 成就名 / 图标 / 总数
- :func:`get_global_achievement_percentages` —— 全球解锁率

TTL 按数据的实际变化速度分档（见 ``settings.cache_ttl_*``）：schema 基本不动，
解锁率缓慢漂移，商店元数据会改名 / 改期 / 换封面。过期只是「该去问了」，
**问不到时继续用旧值**——陈旧的封面也比没有封面好（优雅降级）。
"""
from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.core.timeutil import utcnow
from app.models.cache import (
    CACHE_ACH_PERCENT,
    CACHE_ACH_SCHEMA,
    CACHE_APP_DETAILS,
    SteamCache,
)
from app.services.steam import SteamClient, SteamError, SteamNotRetryable

logger = logging.getLogger(__name__)

_TTL: dict[str, timedelta] = {}


def _ttl(kind: str) -> timedelta:
    if not _TTL:
        _TTL.update(
            {
                CACHE_APP_DETAILS: timedelta(days=settings.cache_ttl_app_details_days),
                CACHE_ACH_SCHEMA: timedelta(days=settings.cache_ttl_ach_schema_days),
                CACHE_ACH_PERCENT: timedelta(days=settings.cache_ttl_ach_percent_days),
            }
        )
    return _TTL[kind]


def _read(db: Session, kind: str, key: str) -> tuple[bool, Any, bool]:
    """返回 ``(命中, 值, 是否过期)``。未命中时值为 None。"""
    row = db.get(SteamCache, (kind, key))
    if row is None:
        return False, None, False
    try:
        value = json.loads(row.payload)
    except ValueError:
        return False, None, False
    return True, value, utcnow() - row.fetched_at > _ttl(kind)


def _write(db: Session, kind: str, key: str, value: Any) -> None:
    row = db.get(SteamCache, (kind, key))
    payload = json.dumps(value, ensure_ascii=False)
    if row is None:
        db.add(SteamCache(kind=kind, cache_key=key, payload=payload, fetched_at=utcnow()))
    else:
        row.payload = payload
        row.fetched_at = utcnow()


_MISSING = object()


def _through(
    db: Session,
    kind: str,
    key: str,
    fetch: Callable[[], Any],
    *,
    negative: Any = _MISSING,
) -> Any:
    """读穿缓存：新鲜就直接用；过期 / 未命中才打上游。

    两类失败分开处理：

    - **4xx（``SteamNotRetryable``）是「上游明确说没有」**——比如没有全球统计的 app
      恒返回 403。这个答案不会变，所以**把否定结果也写进缓存**（``negative``），
      否则每轮都要为同一批 app 白问一遍（实测 7 款如此）。
    - 5xx / 网络故障是**暂时**的：有旧值就沿用（陈旧胜过没有），没有就抛给调用方。
    """
    hit, value, stale = _read(db, kind, key)
    if hit and not stale:
        return value
    try:
        fresh = fetch()
    except SteamNotRetryable as exc:
        if negative is not _MISSING:
            logger.debug("%s/%s 上游明确无此数据，缓存否定结果: %s", kind, key, exc)
            _write(db, kind, key, negative)
            return negative
        if hit:
            return value
        raise
    except SteamError as exc:
        if hit:
            # 上游暂时不可用：旧值比没有值有用得多（PRD 的优雅降级）
            logger.warning("%s/%s 刷新失败，沿用缓存旧值: %s", kind, key, exc)
            return value
        raise
    _write(db, kind, key, fresh)
    return fresh


def get_app_details(
    db: Session, steam: SteamClient, appid: int, language: str = "schinese"
) -> dict[str, Any] | None:
    """Store ``appdetails``。**下架游戏的 ``None`` 同样入缓存**，免得每轮重问。"""
    return _through(
        db, CACHE_APP_DETAILS, f"{appid}:{language}",
        lambda: steam.get_app_details(appid, language=language),
        negative=None,
    )


def get_schema_for_game(
    db: Session, steam: SteamClient, apikey: str, appid: int
) -> dict[str, dict[str, Any]]:
    """成就 schema（名称 / 图标 / 总数）。与谁在玩无关，跨用户共享。"""
    return _through(
        db, CACHE_ACH_SCHEMA, str(appid),
        lambda: steam.get_schema_for_game(apikey, appid),
        negative={},
    ) or {}


def get_global_achievement_percentages(
    db: Session, steam: SteamClient, appid: int
) -> dict[str, float]:
    """全球解锁率。与谁在玩无关，跨用户共享。"""
    return _through(
        db, CACHE_ACH_PERCENT, str(appid),
        lambda: steam.get_global_achievement_percentages(appid),
        negative={},
    ) or {}


def stats(db: Session) -> dict[str, int]:
    """各类缓存条数（供运维 / 测试观察）。"""
    from sqlalchemy import func

    rows = db.execute(
        select(SteamCache.kind, func.count()).group_by(SteamCache.kind)
    ).all()
    return dict(rows)


__all__ = [
    "get_app_details",
    "get_schema_for_game",
    "get_global_achievement_percentages",
    "stats",
]
