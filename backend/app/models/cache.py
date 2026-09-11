"""Steam 公共数据的本地缓存。

缓存的只有**与用户无关**的上游响应——成就 schema、全球解锁率、商店元数据。
这些数据换谁来问都是同一份答案，却占了一轮同步 65% 的请求量（实测 154 次里 100 次），
首轮还要再加 297 次 appdetails。缓存后跨用户、跨轮共享，登录后的等待大幅缩短。

**per-user 数据一律不进这里**（GetOwnedGames / GetRecentlyPlayedGames /
GetPlayerAchievements / 截图）——那些每轮都必须是新鲜的，缓存了就等于不同步。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.timeutil import utcnow
from app.database import Base

# 缓存种类（同时用作 TTL 配置的键）
CACHE_APP_DETAILS = "app_details"          # Store appdetails：改名 / 改期 / 换封面才变
CACHE_ACH_SCHEMA = "ach_schema"            # 成就 schema：几乎不变
CACHE_ACH_PERCENT = "ach_percent"          # 全球解锁率：缓慢漂移


class SteamCache(Base):
    """一条缓存 = 一次公共上游响应。

    ``payload`` 存 JSON 文本；**否定结果也缓存**（下架游戏的 appdetails 返回 null），
    否则每轮都会重新去问一遍那些永远问不到的 appid。
    """

    __tablename__ = "steam_cache"
    __table_args__ = (Index("ix_steam_cache_fetched", "kind", "fetched_at"),)

    kind: Mapped[str] = mapped_column(String(32), primary_key=True)
    cache_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(), default=utcnow, nullable=False)
