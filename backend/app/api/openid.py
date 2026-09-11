"""Steam OpenID 2.0 登录（Layer 1，默认路径，零客户端依赖）。

流程（07 后端计划 P0-3b）：
1. ``GET /auth/steam/openid/login`` → 302 到 ``steamcommunity.com/openid/login``；
2. 用户在 Steam 授权后，Steam 302 回 ``/auth/steam/openid/callback?openid.mode=id_res&…``；
3. 后端校验 ``return_to`` 匹配 → 正则从 ``openid.claimed_id`` 取 SteamID64 →
   原样 POST 回 ``check_authentication`` 验签 → 建 / 绑用户 → 发 opaque token。

session cookie（Layer 2）在此**留空**，等侧车登录时再补。
"""
from __future__ import annotations

import logging
import re
from datetime import timedelta
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.config import settings
from app.core.rate_limit import limiter
from app.core.security import generate_token, hash_token
from app.core.timeutil import utcnow
from app.database import get_db
from app.models.user import AuthToken, User
from app.schemas.auth import AuthResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/steam/openid", tags=["auth"])

_OPENID_NS = "http://specs.openid.net/auth/2.0"
_STEAM_OPENID = "https://steamcommunity.com/openid/login"
_STEAMID_RE = re.compile(r"https?://steamcommunity\.com/openid/id/(\d{17,})")


#: 记住「登录是从哪个前端源发起的」的 cookie（见 ``_pick_frontend``）。
FRONT_COOKIE = "gc_front"
_FRONT_COOKIE_MAX_AGE = 600  # 一次登录来回用不了 10 分钟


def _callback_url() -> str:
    return f"{settings.public_base_url.rstrip('/')}/auth/steam/openid/callback"


def _pick_frontend(candidate: str | None) -> str | None:
    """登录完成后跳回哪个前端源。

    前端现在有两种起法——由后端托管（``http://127.0.0.1:8000/``）或 serve.py 起在 5173——
    而回跳地址不能猜。所以前端在发起登录时用 ``?front=<location.origin>`` 报上自己的源，
    这里**只接受 CORS 白名单里的源**（否则这就是一个开放重定向：任何人都能把带 token
    的回跳指到自己的站点），不在白名单里就回落到配置值 ``frontend_base_url``。
    """
    if candidate:
        origin = candidate.rstrip("/")
        if origin in {o.rstrip("/") for o in settings.cors_origins}:
            return origin
    return settings.frontend_base_url


def _fail(detail: str, front: str | None):
    """登录失败的统一出口。

    有前端地址就 302 回前端带 ``#error=``——否则用户会被卡在后端的 JSON 错误页上，
    没有任何回到应用的路径（这正是「点了登录就回不来」的一半原因）。
    """
    if front:
        target = f"{front.rstrip('/')}/#error={quote(detail)}"
        resp = RedirectResponse(url=target, status_code=302)
        resp.delete_cookie(FRONT_COOKIE)
        return resp
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


@router.get("/login")
def openid_login(front: str | None = None):
    """发起 Steam OpenID 登录：302 到 steamcommunity.com/openid/login。

    ``front``：发起登录的前端源（``location.origin``），白名单内才记进 cookie 供回调使用。
    """
    params = {
        "openid.ns": _OPENID_NS,
        "openid.mode": "checkid_setup",
        "openid.return_to": _callback_url(),
        "openid.realm": settings.public_base_url.rstrip("/"),
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    }
    resp = RedirectResponse(url=f"{_STEAM_OPENID}?{urlencode(params)}", status_code=302)
    chosen = _pick_frontend(front)
    if front and chosen == front.rstrip("/"):
        # SameSite=Lax：从 Steam 302 回来是顶层导航，Lax 下 cookie 照样带上
        resp.set_cookie(
            FRONT_COOKIE, chosen, max_age=_FRONT_COOKIE_MAX_AGE, httponly=True, samesite="lax"
        )
    return resp


@router.get("/callback", response_model=AuthResponse)
@limiter.limit(settings.rate_limit_auth)
def openid_callback(request: Request, db: Session = Depends(get_db)):
    """OpenID 回调：验签 → 取 SteamID64 → 建 / 绑用户 → 发 token。"""
    params = dict(request.query_params)
    front = _pick_frontend(request.cookies.get(FRONT_COOKIE))

    if params.get("openid.mode") == "cancel":
        return _fail("用户取消了登录", front)

    if params.get("openid.mode") != "id_res":
        return _fail("OpenID 登录失败（mode）", front)

    # return_to 必须与我们发起的一致（防 CSRF / 回放）。
    if params.get("openid.return_to") != _callback_url():
        return _fail("OpenID return_to 不匹配", front)

    claimed_id = params.get("openid.claimed_id", "")
    match = _STEAMID_RE.search(claimed_id)
    if not match:
        return _fail("无法从 claimed_id 解析 SteamID64", front)
    steamid = match.group(1)

    # 原样回传验签（check_authentication）。
    if not _verify_openid(params):
        return _fail("OpenID 验签失败", front)

    user = db.get(User, steamid)
    if user is None:
        user = User(steamid=steamid)
        db.add(user)

    # 顺手清理该用户已过期 token（P0-5）。
    db.execute(
        delete(AuthToken).where(
            AuthToken.user_id == steamid,
            AuthToken.expires_at.is_not(None),
            AuthToken.expires_at < utcnow(),
        )
    )

    raw_token = generate_token()
    db.add(
        AuthToken(
            token_hash=hash_token(raw_token),
            user_id=steamid,
            expires_at=utcnow() + timedelta(days=settings.token_ttl_days),
        )
    )
    db.commit()
    db.refresh(user)

    # 有前端地址就跳回前端，token 放 URL fragment：
    # fragment 不会被浏览器发给服务端，也不进 Referer / 访问日志，比 query 参数安全。
    # 前端取到后应立即 history.replaceState 清掉，避免留在地址栏与历史记录里。
    if front:
        target = f"{front.rstrip('/')}/#token={quote(raw_token)}&user_id={quote(steamid)}"
        resp = RedirectResponse(url=target, status_code=302)
        resp.delete_cookie(FRONT_COOKIE)
        return resp

    # 未配置前端地址：沿用旧行为返回 JSON（curl / 调试 / 非浏览器客户端仍可用）。
    return AuthResponse(
        user_id=steamid, token=raw_token, nickname=user.nickname, avatar=user.avatar
    )


def _verify_openid(params: dict[str, str]) -> bool:
    """把收到的参数原样 POST 回 check_authentication，验证 ``is_valid:true``。"""
    check = dict(params)
    check["openid.mode"] = "check_authentication"
    try:
        with httpx.Client(timeout=settings.steam_request_timeout, follow_redirects=True) as client:
            resp = client.post(_STEAM_OPENID, data=check)
        if resp.status_code >= 400:
            logger.warning("OpenID check_authentication HTTP %s", resp.status_code)
            return False
        return "is_valid:true" in resp.text
    except httpx.HTTPError as exc:
        logger.warning("OpenID check_authentication 请求失败: %s", exc)
        return False


__all__ = ["router", "FRONT_COOKIE"]
