"""认证接口：Steam 登录 / 注册、API Key 提交与查询。"""
from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import bearer_scheme, get_current_user
from app.config import settings
from app.core.rate_limit import limiter
from app.core.security import decrypt_apikey, encrypt_apikey, generate_token, hash_token
from app.core.timeutil import utcnow
from app.database import get_db
from app.models.user import AuthToken, User
from app.schemas.auth import ApiKeyRequest, AuthResponse, HasKeyResponse, SteamLoginRequest
from app.services.steam import SteamError, get_steam_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/steam", response_model=AuthResponse)
@limiter.limit(settings.rate_limit_auth)
def steam_login(
    request: Request,
    body: SteamLoginRequest,
    db: Session = Depends(get_db),
):
    """Steam 登录 / 注册：校验 access_token → 取 SteamID64 → 建 / 绑用户 → 发 opaque token。"""
    steam = get_steam_client()
    try:
        return _do_steam_login(steam, body, db)
    finally:
        steam.close()


def _do_steam_login(steam, body: SteamLoginRequest, db: Session) -> AuthResponse:
    """登录主流程（从端点拆出，让端点只负责 SteamClient 的生命周期）。"""
    steamid: str | None = None
    try:
        steamid = steam.get_token_details(body.steam_access_token)
    except SteamError as exc:
        logger.warning("Steam GetTokenDetails 失败: %s", exc)
        if not (body.steamid and settings.auth_trust_client_steamid):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Steam 登录校验失败"
            ) from exc
        steamid = body.steamid

    # 客户端自报 steamid 与上游结果不一致时拒绝（开发信任模式除外）
    if body.steamid and steamid != body.steamid and not settings.auth_trust_client_steamid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="SteamID 不一致")

    user = db.get(User, steamid)
    if user is None:
        user = User(steamid=steamid)
        db.add(user)
        db.flush()

    # 已有 Key 时顺手补昵称 / 头像（失败不阻塞登录）
    if user.apikey_enc:
        try:
            apikey = decrypt_apikey(user.apikey_enc)
            summary = steam.get_player_summaries(apikey, steamid)
            user.nickname = summary.get("personaname") or user.nickname
            user.avatar = summary.get("avatarfull") or user.avatar
        except Exception:  # noqa: BLE001
            logger.debug("补充用户资料失败", exc_info=True)

    # 顺手清理该用户已过期的 token
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

    return AuthResponse(
        user_id=steamid, token=raw_token, nickname=user.nickname, avatar=user.avatar
    )


@router.post("/apikey", status_code=status.HTTP_204_NO_CONTENT)
def submit_apikey(
    body: ApiKeyRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """提交 Steam Web API Key（加密存储，不回显、不落日志）。

    写库前先拿这把 Key 查一次本人的 ``GetPlayerSummaries``：Key 无效时立刻 400，
    而不是留一个「绑定成功」的假象、等到同步时才在采集里炸——那时用户看到的只是一句
    「同步失败」，猜不到是 Key 的问题（与 cli.bind_apikey_cli 同一道校验）。
    """
    apikey = body.apikey.strip()
    steam = get_steam_client()
    try:
        try:
            summary = steam.get_player_summaries(apikey, user.steamid)
        except SteamError as exc:
            logger.info("API Key 校验失败（用户 %s）: %s", user.steamid, exc)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Steam 拒绝了这个 API Key。请确认复制完整，且是在 "
                "steamcommunity.com/dev/apikey 用当前登录的账号申请的。",
            ) from exc
    finally:
        steam.close()
    if not summary:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Steam 未返回该账号资料，API Key 可能无效。",
        )
    user.apikey_enc = encrypt_apikey(apikey)
    user.nickname = summary.get("personaname") or user.nickname
    user.avatar = summary.get("avatarfull") or user.avatar
    db.commit()


@router.delete("/apikey", status_code=status.HTTP_204_NO_CONTENT)
def delete_apikey(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """解绑 API Key（05 §6 要求的「解绑 / 吊销」出口）。已采集的数据保留，只是不再同步。"""
    user.apikey_enc = None
    db.commit()


@router.get("/apikey", response_model=HasKeyResponse)
def has_apikey(user: User = Depends(get_current_user)):
    """是否已绑定 API Key。"""
    return HasKeyResponse(has_key=bool(user.apikey_enc))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    credentials=Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    """登出：撤销当前 opaque token（库内删除，之后该 token 即失效）。"""
    if credentials is not None and credentials.credentials:
        token = db.scalars(
            select(AuthToken).where(AuthToken.token_hash == hash_token(credentials.credentials))
        ).first()
        if token is not None:
            db.delete(token)
            db.commit()
