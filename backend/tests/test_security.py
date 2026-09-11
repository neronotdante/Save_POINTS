"""安全基础件测试。"""
from __future__ import annotations

from app.core.security import (
    constant_time_equals,
    decrypt_apikey,
    encrypt_apikey,
    generate_token,
    hash_token,
)


def test_apikey_encrypt_decrypt_roundtrip():
    token = encrypt_apikey("ABCDEF1234567890")
    assert token != "ABCDEF1234567890"
    assert decrypt_apikey(token) == "ABCDEF1234567890"


def test_apikey_encrypt_is_nondeterministic():
    a = encrypt_apikey("ABCDEF1234567890")
    b = encrypt_apikey("ABCDEF1234567890")
    assert a != b  # Fernet 带随机 IV / 时间戳，相同明文密文不同


def test_token_generation_and_hash():
    raw = generate_token()
    assert len(raw) >= 32
    assert hash_token(raw) != raw
    assert len(hash_token(raw)) == 64  # sha256 hex


def test_constant_time_equals():
    assert constant_time_equals("abc", "abc")
    assert not constant_time_equals("abc", "abd")
