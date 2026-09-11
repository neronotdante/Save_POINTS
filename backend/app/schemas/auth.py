"""认证相关出入参。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class SteamLoginRequest(BaseModel):
    """Steam 登录 / 注册入参。

    - ``steam_access_token``：客户端 SteamKit 登录后拿到的 OAuth access_token，
      后端用它调 ``GetTokenDetails`` 校验并取 SteamID64（不落库、不回显）。
    - ``steamid``：可选，客户端已拿到的 SteamID64，用于与上游校验结果交叉核对。
    """

    steam_access_token: str = Field(..., min_length=8, description="Steam OAuth access_token")
    steamid: str | None = Field(default=None, description="可选：客户端自报 SteamID64")


class AuthResponse(BaseModel):
    """登录成功返回：user_id = SteamID64，token = opaque token（只此一次下发）。"""

    user_id: str
    token: str
    nickname: str | None = None
    avatar: str | None = None


class ApiKeyRequest(BaseModel):
    apikey: str = Field(..., min_length=8, description="Steam Web API Key")


class HasKeyResponse(BaseModel):
    has_key: bool


class SteamPasswordRequest(BaseModel):
    """后端账号密码登录第一步。"""

    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class SteamGuardRequest(BaseModel):
    """后端账号密码登录第二步：Steam Guard 码。"""

    code: str = Field(..., min_length=1)


class SteamLoginProgress(BaseModel):
    """登录进度：guard = 需要 2FA；success = 完成并下发 token。"""

    status: str = Field(description="guard | pending | scanned | success | error")
    domain: str | None = None
    user_id: str | None = None
    token: str | None = None
    message: str | None = None


class SteamQrStartResponse(BaseModel):
    """扫码登录开始：返回二维码 data URI。"""

    status: str = Field(description="qr | error")
    qr_data_uri: str | None = None
    message: str | None = None
