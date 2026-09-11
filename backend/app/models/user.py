"""用户与登录态模型。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.timeutil import utcnow
from app.database import Base


class User(Base):
    """用户：唯一标识 = SteamID64（Steam 登录获得）。"""

    __tablename__ = "users"

    steamid: Mapped[str] = mapped_column(String(17), primary_key=True)
    nickname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    avatar: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 加密存储（Fernet token），绝不回显 / 记录明文。
    apikey_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Steam web 会话（v1.1）：`sessionid=...; steamLoginSecure=...`，Fernet 加密。
    session_cookie_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    # node-steam-user 刷新令牌，Fernet 加密；cookie 失效时用它续期。
    refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


class AuthToken(Base):
    """opaque token 的库内映射：只存 SHA-256 哈希，原始 token 仅回给客户端一次。"""

    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.steamid", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utcnow, nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
