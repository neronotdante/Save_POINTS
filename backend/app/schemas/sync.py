"""同步与购买入库的出入参。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class PurchaseItem(BaseModel):
    """客户端 license list（package→appid 已在客户端用 PICS 映射）提交的单条。"""

    appid: int = Field(..., ge=1)
    time_created: int | None = Field(default=None, description="许可证创建 Unix 秒时间戳")
    payment_method: str | None = None


class PurchasesRequest(BaseModel):
    purchases: list[PurchaseItem] = Field(default_factory=list, max_length=50000)


class SyncStatusResponse(BaseModel):
    """``GET /sync/status``：底栏「上次同步」与状态（含失败原因，供优雅降级）。"""

    status: str = Field(description="idle | syncing | error | unconfigured")
    last_sync_at: datetime | None = None
    last_error: str | None = None
    has_key: bool = False
