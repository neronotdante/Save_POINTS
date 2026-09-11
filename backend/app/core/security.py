"""安全基础件：API Key 加密（Fernet）与 opaque token 的生成 / 哈希。

约定（后端接口文档 §6）：
- API Key **加密存储**，日志不落 Key，接口不回显 Key。
- 登录态用**最简 opaque token**（随机串），存库的是其 SHA-256 哈希，不实现 JWT / session cookie。

密钥来源（``_resolve_key``，三选一，按优先级）：

1. ``GC_FERNET_KEY``：直接给一把 Fernet 密钥；
2. ``GC_SECRET_KEY``：**改过默认值**时由它 SHA-256 派生；
3. 密钥文件 ``GC_FERNET_KEY_FILE``（默认 ``./fernet.key``）：前两者都没配时，首次启动
   自动生成并落盘，之后每次启动读同一个文件。

第 3 条是给「clone 下来什么都不改就跑」的自托管用户准备的：原先默认密钥是一串固定
字符串，所有安装共用同一把锁，拿到 db 文件的人都能解出 Key。现在什么都不配也会得到
一把每机独立的密钥；代价是**密钥文件和数据库要一起备份**，丢了它就解不开已存的 Key。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.config import DEFAULT_SECRET_KEY, settings

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# 密钥解析
# --------------------------------------------------------------------------

def _fernet_key_from_secret(secret: str) -> bytes:
    """由服务端主密钥派生 32 字节 Fernet 密钥（urlsafe base64）。"""
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _load_or_create_key_file(path: Path) -> tuple[bytes, bool]:
    """读密钥文件；不存在就生成一把新的写进去。返回 ``(key, 是否新生成)``。"""
    if path.is_file():
        key = path.read_text(encoding="ascii").strip().encode("ascii")
        Fernet(key)  # 格式不对时在这里就炸，而不是等到第一次解密
        return key, False
    key = Fernet.generate_key()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(key.decode("ascii") + "\n", encoding="ascii")
    try:
        path.chmod(0o600)  # POSIX 下只给自己读；Windows 忽略
    except OSError:
        pass
    return key, True


@lru_cache(maxsize=1)
def _resolve_key() -> tuple[bytes, str, bool]:
    """返回 ``(key, 来源描述, 是否本次新生成)``。进程内只算一次。"""
    if settings.fernet_key:
        return settings.fernet_key.encode("ascii"), "GC_FERNET_KEY", False
    if not settings.secret_key_is_default:
        return _fernet_key_from_secret(settings.secret_key), "GC_SECRET_KEY 派生", False
    path = Path(settings.fernet_key_file)
    key, created = _load_or_create_key_file(path)
    return key, f"密钥文件 {path.resolve()}", created


def _fernet() -> Fernet:
    return Fernet(_resolve_key()[0])


def key_source() -> str:
    """当前密钥从哪来（启动日志 / 运维命令用，不含密钥本身）。"""
    return _resolve_key()[1]


def key_was_generated() -> bool:
    """本次启动是否刚生成了密钥文件——是的话旧库要做一次重加密（core/rekey）。"""
    return _resolve_key()[2]


def legacy_default_fernet() -> Fernet:
    """由**出厂默认** secret_key 派生的旧密钥。

    只有一个用途：把「密钥文件机制上线前、用默认密钥加密过」的旧库迁到新密钥。
    正常加解密路径不会用到它。
    """
    return Fernet(_fernet_key_from_secret(DEFAULT_SECRET_KEY))


# --------------------------------------------------------------------------
# API Key / 敏感串加密（Fernet 对称加密）
# --------------------------------------------------------------------------

def encrypt_apikey(plaintext: str) -> str:
    """加密 API Key，返回 Fernet token 字符串。"""
    if not plaintext:
        raise ValueError("apikey 不能为空")
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_apikey(token: str) -> str:
    """解密 API Key；解密失败（密钥不一致 / 被篡改）抛 InvalidToken。"""
    return _fernet().decrypt(token.encode("ascii")).decode("utf-8")


def encrypt_secret(plaintext: str) -> str:
    """加密任意敏感串（Steam 会话 cookie / refresh token），与 API Key 同 Fernet。"""
    if not plaintext:
        raise ValueError("secret 不能为空")
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    """解密敏感串；失败抛 InvalidToken。"""
    return _fernet().decrypt(token.encode("ascii")).decode("utf-8")


# --------------------------------------------------------------------------
# Opaque token
# --------------------------------------------------------------------------

def generate_token() -> str:
    """生成客户端携带的 opaque token（32 字节随机，urlsafe）。"""
    return secrets.token_urlsafe(32)


def hash_token(raw_token: str) -> str:
    """token 入库前哈希；库中只存哈希，泄库无法反推原始 token。"""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


__all__ = [
    "encrypt_apikey",
    "decrypt_apikey",
    "encrypt_secret",
    "decrypt_secret",
    "generate_token",
    "hash_token",
    "constant_time_equals",
    "key_source",
    "key_was_generated",
    "legacy_default_fernet",
    "InvalidToken",
]
