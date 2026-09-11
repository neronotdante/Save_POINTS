"""模型包：导入即注册全部表到 ``Base.metadata``（供建表与迁移）。"""
from app.database import Base
from app.models.cache import (
    CACHE_ACH_PERCENT,
    CACHE_ACH_SCHEMA,
    CACHE_APP_DETAILS,
    SteamCache,
)
from app.models.game import (
    Achievement,
    Game,
    PlayDay,
    Purchase,
    Review,
    Screenshot,
    SyncState,
)
from app.models.user import AuthToken, User

__all__ = [
    "Base",
    "SteamCache",
    "CACHE_APP_DETAILS",
    "CACHE_ACH_SCHEMA",
    "CACHE_ACH_PERCENT",
    "User",
    "AuthToken",
    "Game",
    "PlayDay",
    "Achievement",
    "Purchase",
    "Review",
    "Screenshot",
    "SyncState",
]
