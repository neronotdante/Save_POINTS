"""旧库重加密：把用出厂默认密钥加密过的敏感列迁到当前密钥。

背景：密钥文件机制上线前，什么都不配的安装用的是 ``dev-insecure-change-me`` 派生的
固定密钥。上线后首次启动会生成每机独立的密钥文件——如果此时库里已经有用旧密钥加密的
API Key，新密钥解不开它们，每日采集会在 ``decrypt_apikey`` 处静默失败。

所以在「本次启动刚生成密钥文件」这一个时机，逐用户尝试用旧密钥解、再用新密钥加回去。
解不开的（本来就是别的密钥加的）原样跳过，不动。整个过程幂等：第二次跑什么都不会改。
"""
from __future__ import annotations

import logging

from cryptography.fernet import InvalidToken
from sqlalchemy import select

from app.core.security import encrypt_secret, legacy_default_fernet
from app.database import SessionLocal
from app.models.user import User

logger = logging.getLogger(__name__)

_SECRET_COLUMNS = ("apikey_enc", "session_cookie_enc", "refresh_token_enc")


def rekey_legacy_secrets() -> int:
    """返回重加密的字段数。"""
    legacy = legacy_default_fernet()
    changed = 0
    db = SessionLocal()
    try:
        for user in db.scalars(select(User)).all():
            for col in _SECRET_COLUMNS:
                token = getattr(user, col)
                if not token:
                    continue
                try:
                    plain = legacy.decrypt(token.encode("ascii")).decode("utf-8")
                except (InvalidToken, ValueError):
                    continue  # 不是旧默认密钥加的，别碰
                setattr(user, col, encrypt_secret(plain))
                changed += 1
        if changed:
            db.commit()
            logger.warning("已把 %d 个用旧默认密钥加密的字段迁到新密钥", changed)
        return changed
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


__all__ = ["rekey_legacy_secrets"]
