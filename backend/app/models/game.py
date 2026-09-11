"""游戏与时间戳数据模型（对齐后端接口文档 §4 与 PRD §3）。"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.timeutil import utcnow
from app.database import Base

# 游戏状态取值（PRD §3）：wishlist | owned | played | released_wishlist
GAME_STATUS_WISHLIST = "wishlist"
GAME_STATUS_OWNED = "owned"
GAME_STATUS_PLAYED = "played"
GAME_STATUS_RELEASED_WISHLIST = "released_wishlist"

# 生命状态取值（PRD §3 封盘判定，v1.2）：never_launched | active | dormant | shelved
LIFECYCLE_NEVER_LAUNCHED = "never_launched"
LIFECYCLE_ACTIVE = "active"
LIFECYCLE_DORMANT = "dormant"
LIFECYCLE_SHELVED = "shelved"


class Game(Base):
    """游戏：按 (user, appid) 唯一；元数据与主题色在同步期写入。"""

    __tablename__ = "games"
    __table_args__ = (
        UniqueConstraint("user_id", "appid", name="uq_games_user_appid"),
        # 「隐藏从未启动」过滤与封盘帽查询都按 (user, lifecycle) 走。
        Index("ix_games_user_lifecycle", "user_id", "lifecycle"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), index=True
    )
    appid: Mapped[int] = mapped_column(Integer, nullable=False)
    name_zh: Mapped[str | None] = mapped_column(String(255), nullable=True)
    name_en: Mapped[str | None] = mapped_column(String(255), nullable=True)
    cover: Mapped[str | None] = mapped_column(Text, nullable=True)  # header_image URL（横版）
    cover_portrait: Mapped[str | None] = mapped_column(Text, nullable=True)  # library_600x900（2:3 竖版）
    developer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    release_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default=GAME_STATUS_OWNED)
    wishlist_priority: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 愿望单优先级序号
    # 主题色（UI 规范 §3.4）：hex，如 "#B0761A"
    theme_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    theme_color_source: Mapped[str | None] = mapped_column(String(16), nullable=True)  # api|local|fallback
    theme_color_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)

    # --- 生命状态（PRD §3，v1.2；每次同步收尾重算，不在请求期算） ---
    # GetOwnedGames.playtime_forever（分钟）：仅供封盘判定，不上界面。
    playtime_forever: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # GetOwnedGames.rtime_last_played：Steam 直接给的最后启动时间。
    rtime_last_played: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    # 最后一次启动时间 = rtime_last_played 与本地三路（运行日 / 成就 / 截图）取 max。
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    launched_ever: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    lifecycle: Mapped[str] = mapped_column(
        String(16), nullable=False, default=LIFECYCLE_NEVER_LAUNCHED
    )
    # 封盘时点 = last_active_at；非 shelved 恒为 NULL（再启动即清空）。
    shelved_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    lifecycle_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    # 成就总数（GetSchemaForGame）：判定用 ach_unlocked / ach_total >= T_ach；解锁数由 achievements 表派生。
    ach_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 该游戏最近一次成就回填时间：NULL = 从未回填（优先排队）；
    # 早于 last_active_at = 回填后又玩过，需重拉以捕获新解锁（增量判据）。
    achievements_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


class PlayDay(Base):
    """运行日：「这一天启动过这款游戏」，核心指标「运行天数」，也是 ``first_play`` 的唯一来源。

    **三路来源**（同一张表，不区分出处——一天启动过就是启动过）：
      1. ``GetRecentlyPlayedGames`` 的 ``rtime_last_played``——Steam 只给**最近两周**；
      2. **成就解锁日**（``derive_play_days_from_achievements``）——精度到秒、能追溯到任意远，
         是这三路里覆盖最广的一路；
      3. 截图的拍摄日（``sync_screenshots``）。

    只有 1 和 3 的时候，「轴上有封面的游戏」恰好等于「截过图的游戏」（实测两个集合各 69 款、
    一款不差，而启动过的有 258 款），且有截图的那些取的是最早那张**截图**而不是最早那次
    **游玩**——36 款的 ``first_play`` 因此晚于它自己最早的成就解锁。第 2 路就是为此补上的。
    """

    __tablename__ = "play_days"
    __table_args__ = (
        UniqueConstraint("user_id", "game_id", "date", name="uq_play_days_user_game_date"),
        Index("ix_play_days_user_date", "user_id", "date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), index=True
    )
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )


class Achievement(Base):
    """成就解锁：GetPlayerAchievements 历史回填，补足「过去」的运行状态。"""

    __tablename__ = "achievements"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "game_id", "achievement_id", name="uq_achievements_user_game_ach"
        ),
        Index("ix_achievements_user_unlocktime", "user_id", "unlocktime"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), index=True
    )
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    achievement_id: Mapped[str] = mapped_column(String(128), nullable=False)  # apiname
    unlocktime: Mapped[datetime] = mapped_column(DateTime(), nullable=False)
    # 成就展示三件套（03 §4.3a）：名称 / 图标来自 GetSchemaForGame，解锁率来自百分比接口
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    icon_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    global_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    percent_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )


class Purchase(Base):
    """购买 / 入库记录：time_created 为许可证创建时间（近似口径，PRD §3）。"""

    __tablename__ = "purchases"
    __table_args__ = (
        UniqueConstraint("user_id", "game_id", "time_created", name="uq_purchases_user_game_time"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), index=True
    )
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    time_created: Mapped[datetime] = mapped_column(DateTime(), nullable=False)
    payment_method: Mapped[str | None] = mapped_column(String(64), nullable=True)
    channel: Mapped[str] = mapped_column(String(32), nullable=False, default="steam")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )


class Screenshot(Base):
    """游戏截图（v0.7，运行日补强 + 日详情视觉素材）。

    taken_at = 截取时间（rtime_created，缺失时由文件名 `YYYYMMDDHHMMSS` 解析兜底）；
    按日聚簇派生 play_day；只存缩略图 URL，原图按需拉取（03 §4.5）。
    """

    __tablename__ = "screenshots"
    __table_args__ = (
        UniqueConstraint("user_id", "game_id", "shot_id", name="uq_screenshots_user_game_shot"),
        Index("ix_screenshots_user_taken", "user_id", "taken_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), index=True
    )
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    shot_id: Mapped[str] = mapped_column(String(64), nullable=False)
    taken_at: Mapped[datetime] = mapped_column(DateTime(), nullable=False)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    privacy: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 0公开/1仅好友/2私密
    caption: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )


class Review(Base):
    """短评评分（P-5）：每用户每游戏一条，后写覆盖。"""

    __tablename__ = "reviews"
    __table_args__ = (UniqueConstraint("user_id", "appid", name="uq_reviews_user_appid"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), index=True
    )
    appid: Mapped[int] = mapped_column(Integer, nullable=False)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)  # 1..5
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


class SyncState(Base):
    """同步游标 / 状态：各源最近成功时间 + 底栏状态机（idle/syncing/error/unconfigured）。"""

    __tablename__ = "sync_state"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), primary_key=True
    )
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    recently_played_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    owned_games_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    achievements_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    screenshots_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    wishlist_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    # 生命状态最近一次重算时间（PRD §3，采集收尾重算）。
    lifecycle_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    # 状态机：idle | syncing | error；unconfigured 由「是否绑 Key」派生，不落库。
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="idle")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )
