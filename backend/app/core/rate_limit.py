"""接口限流：最低程度（防滥用即可），基于 slowapi。

默认 300 次/分钟（全局）、30 次/分钟（认证端点，防爆破）。
依赖真实客户端 IP（`X-Forwarded-For` 兜底）。
"""
from __future__ import annotations

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import settings

limiter = Limiter(key_func=get_remote_address, default_limits=[settings.rate_limit_default])


def rate_limit_handler(request, exc: RateLimitExceeded):
    """把限流异常转成统一 JSON 响应（HTTP 429）。"""
    return _rate_limit_exceeded_handler(request, exc)


__all__ = ["limiter", "rate_limit_handler", "get_remote_address"]
