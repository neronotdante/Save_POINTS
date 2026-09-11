"""API 依赖：Bearer opaque token 认证。"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_token
from app.core.timeutil import utcnow
from app.database import get_db
from app.models.user import AuthToken, User

bearer_scheme = HTTPBearer(auto_error=False, description="Authorization: Bearer <opaque token>")


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """校验 opaque token → 返回对应 User；缺失 / 无效 / 过期返回 401。"""
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="未登录或登录态失效",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None or not credentials.credentials:
        raise unauthorized

    token_hash = hash_token(credentials.credentials)
    token = db.scalars(select(AuthToken).where(AuthToken.token_hash == token_hash)).first()
    if token is None:
        raise unauthorized
    if token.expires_at is not None and token.expires_at < utcnow():
        raise unauthorized

    user = db.get(User, token.user_id)
    if user is None:
        raise unauthorized

    # 记录最近使用（个人规模，写放大可忽略）；供过期 token 清理参考。
    token.last_used_at = utcnow()
    db.commit()
    return user


__all__ = ["bearer_scheme", "get_current_user"]
