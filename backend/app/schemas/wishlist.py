"""愿望单提交出入参。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class WishlistItem(BaseModel):
    appid: int = Field(..., ge=1)
    priority: int = Field(default=0, ge=0, description="Steam 愿望单优先级序号")


class WishlistRequest(BaseModel):
    """客户端用登录态 access_token 调 GetWishlist 后，把结果整体提交给后端。"""

    items: list[WishlistItem] = Field(default_factory=list, max_length=20000)
