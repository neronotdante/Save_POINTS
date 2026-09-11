"""node-steam-user 侧车客户端：Python 后端与登录侧车之间的薄封装。"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class SidecarError(RuntimeError):
    """侧车调用失败 / 侧车返回错误。"""


def _post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = settings.steam_sidecar_url.rstrip("/") + path
    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(url, json=payload)
    except httpx.HTTPError as exc:
        raise SidecarError(f"侧车不可达: {exc}") from exc
    if resp.status_code != 200:
        raise SidecarError(f"侧车 HTTP {resp.status_code}")
    return resp.json()


def sidecar_login(username: str, password: str) -> dict[str, Any]:
    """密码登录第一步：提交账号密码。返回 {status: guard|pending|error, ...}。"""
    return _post("/login", {"username": username, "password": password})


def sidecar_guard(code: str) -> dict[str, Any]:
    """密码登录第二步：提交 Steam Guard 码。返回 {status: pending|error, ...}。"""
    return _post("/guard", {"code": code})


def sidecar_qr() -> dict[str, Any]:
    """扫码登录：开始一次 QR 登录，返回 {status: qr, qrDataUri}。"""
    return _post("/qr", {})


def sidecar_poll() -> dict[str, Any]:
    """轮询登录结果（QR 与密码共用）：{status: pending|scanned|success|error, ...}。"""
    url = settings.steam_sidecar_url.rstrip("/") + "/poll"
    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(url)
    except httpx.HTTPError as exc:
        raise SidecarError(f"侧车不可达: {exc}") from exc
    if resp.status_code != 200:
        raise SidecarError(f"侧车 HTTP {resp.status_code}")
    return resp.json()


__all__ = ["SidecarError", "sidecar_login", "sidecar_guard", "sidecar_qr", "sidecar_poll"]
