"""API 出入参的 Pydantic 模型（对外契约）。"""
from app.schemas.achievement import AchievementDetail
from app.schemas.auth import ApiKeyRequest, AuthResponse, HasKeyResponse, SteamLoginRequest
from app.schemas.calendar import (
    DayCounts,
    DayDetailResponse,
    DayRow,
    GameBrief,
    ScreenshotOut,
    TimelineEvent,
    TimelineResponse,
)
from app.schemas.game import GameOut, Lifecycle, ReviewOut, ReviewRequest
from app.schemas.sync import PurchaseItem, PurchasesRequest, SyncStatusResponse
from app.schemas.wishlist import WishlistItem, WishlistRequest

__all__ = [
    "AchievementDetail",
    "SteamLoginRequest",
    "AuthResponse",
    "ApiKeyRequest",
    "HasKeyResponse",
    "GameBrief",
    "TimelineEvent",
    "DayCounts",
    "DayRow",
    "DayDetailResponse",
    "ScreenshotOut",
    "TimelineResponse",
    "GameOut",
    "Lifecycle",
    "ReviewOut",
    "ReviewRequest",
    "WishlistItem",
    "WishlistRequest",
    "PurchaseItem",
    "PurchasesRequest",
    "SyncStatusResponse",
]
