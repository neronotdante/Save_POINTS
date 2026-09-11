"""时间工具：统一使用 **naive UTC** 时间（无 tzinfo 的 UTC）。

选择 naive UTC 的原因：SQLite 存储 DateTime 会丢失 tzinfo（读回为 naive），
而 PostgreSQL ``TIMESTAMP WITHOUT TIME ZONE`` 同样用 naive。为让两种后端行为一致、
避免 naive/aware 比较报错，全工程统一「UTC 墙上时间 + 无 tzinfo」约定。
"""
from __future__ import annotations

from datetime import date, datetime, timezone


def utcnow() -> datetime:
    """当前 UTC 时刻（naive）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def from_ts(ts: int | float) -> datetime:
    """Steam 返回的 Unix 秒级时间戳 → naive UTC datetime。"""
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).replace(tzinfo=None)


def utc_date(dt: datetime) -> date:
    """取 UTC 日历日（V0.1 简化：所有日期按 UTC 计日）。"""
    return dt.date()


__all__ = ["utcnow", "from_ts", "utc_date"]
