"""P0 · Steam 登录链路测试（07 后端计划 §2）。

覆盖：OpenID 2.0 登录 / 回调、登录失败路径（P0-6）、越权后门（P0-4）、过期 token。
"""
from __future__ import annotations

from conftest import FakeSteamMixin

from datetime import timedelta

import pytest

from app.config import settings
from app.core.security import generate_token, hash_token
from app.core.timeutil import utcnow
from app.models.user import AuthToken, User
from app.services.steam import SteamError

VALID_CALLBACK = "http://127.0.0.1:8000/auth/steam/openid/callback"


@pytest.fixture
def json_mode(monkeypatch):
    """回落模式：未配 GC_FRONTEND_BASE_URL 时回调直接返回 JSON（curl / 非浏览器客户端）。"""
    monkeypatch.setattr(settings, "frontend_base_url", None)


@pytest.fixture
def redirect_mode(monkeypatch):
    """默认模式：配了前端地址时回调 302 回前端，token 走 URL fragment。"""
    monkeypatch.setattr(settings, "frontend_base_url", "http://localhost:5173")


def assert_rejected(resp):
    """非法回调的**唯一硬要求：不得发出 token**。

    两种模式下表现不同（302 带 #error= / 401 JSON），但都不能泄出 token——
    断言锁的是这个安全属性，而不是某一种表现形式。
    """
    assert resp.status_code in (302, 401), resp.text
    if resp.status_code == 302:
        loc = resp.headers["location"]
        assert "#error=" in loc
        assert "token=" not in loc
    else:
        assert "token" not in resp.text


# ---------------------------------------------------------------------------
# OpenID（P0-3b）
# ---------------------------------------------------------------------------

def test_openid_login_redirects(client):
    resp = client.get("/auth/steam/openid/login", follow_redirects=False)
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("https://steamcommunity.com/openid/login")
    assert "openid.mode=checkid_setup" in loc
    assert "openid.return_to" in loc


def test_openid_login_remembers_whitelisted_front(client, monkeypatch):
    """前端用 ?front= 报上自己的源：在 CORS 白名单里就记进 cookie，回调按它跳回。

    这让后端托管（8000）与 serve.py（5173）两种起法都不用改配置就能回到发起页。
    """
    monkeypatch.setattr(settings, "frontend_base_url", "http://127.0.0.1:8000")
    monkeypatch.setattr("app.api.openid._verify_openid", lambda params: True)

    resp = client.get(
        "/auth/steam/openid/login",
        params={"front": "http://localhost:5173"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert "gc_front" in resp.cookies

    resp = client.get(
        "/auth/steam/openid/callback",
        params={
            "openid.mode": "id_res",
            "openid.return_to": VALID_CALLBACK,
            "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000077",
        },
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("http://localhost:5173/#token=")


def test_openid_login_ignores_front_outside_whitelist(client, monkeypatch):
    """白名单外的 front 是开放重定向的入口：不记 cookie，回调仍走配置值。"""
    monkeypatch.setattr(settings, "frontend_base_url", "http://127.0.0.1:8000")
    monkeypatch.setattr("app.api.openid._verify_openid", lambda params: True)

    resp = client.get(
        "/auth/steam/openid/login",
        params={"front": "https://evil.example"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert "gc_front" not in resp.cookies

    resp = client.get(
        "/auth/steam/openid/callback",
        params={
            "openid.mode": "id_res",
            "openid.return_to": VALID_CALLBACK,
            "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000077",
        },
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("http://127.0.0.1:8000/#token=")


def test_root_redirects_to_openid(client):
    """启动页：根路径直接跳 Steam OpenID。"""
    resp = client.get("/", follow_redirects=False)
    assert resp.status_code in (302, 307)
    assert resp.headers["location"].endswith("/auth/steam/openid/login")


def test_login_redirects_to_openid(client):
    """登录入口：/login 直接跳 Steam OpenID（无侧载 QR / 账密页）。"""
    resp = client.get("/login", follow_redirects=False)
    assert resp.status_code in (302, 307)
    assert resp.headers["location"].endswith("/auth/steam/openid/login")


def test_openid_callback_issues_token(client, monkeypatch, json_mode):
    """回落模式：未配前端地址时仍返回 JSON（curl / 非浏览器客户端调试路径）。"""
    monkeypatch.setattr("app.api.openid._verify_openid", lambda params: True)
    resp = client.get(
        "/auth/steam/openid/callback",
        params={
            "openid.mode": "id_res",
            "openid.return_to": VALID_CALLBACK,
            "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000077",
            "openid.sig": "abc",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["user_id"] == "76561198000000077"
    assert data["token"]


def test_openid_callback_redirects_to_frontend_with_token(client, monkeypatch, redirect_mode):
    """默认模式：验签成功后 302 回前端，token 放 URL fragment。

    fragment 不会被浏览器发往服务端，也不进访问日志 / Referer——这是选它而不是 query 的原因。
    """
    monkeypatch.setattr("app.api.openid._verify_openid", lambda params: True)
    resp = client.get(
        "/auth/steam/openid/callback",
        params={
            "openid.mode": "id_res",
            "openid.return_to": VALID_CALLBACK,
            "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000077",
            "openid.sig": "abc",
        },
        follow_redirects=False,
    )
    assert resp.status_code == 302, resp.text
    loc = resp.headers["location"]
    assert loc.startswith("http://localhost:5173/#")
    assert "token=" in loc
    assert "user_id=76561198000000077" in loc
    # token 必须在 fragment 里，不能落在 query 上（否则会进服务端日志）
    assert "?" not in loc


@pytest.mark.parametrize("mode_fixture", ["json_mode", "redirect_mode"])
def test_openid_callback_rejects_cancel(client, request, mode_fixture):
    request.getfixturevalue(mode_fixture)
    resp = client.get(
        "/auth/steam/openid/callback",
        params={"openid.mode": "cancel"},
        follow_redirects=False,
    )
    assert_rejected(resp)


@pytest.mark.parametrize("mode_fixture", ["json_mode", "redirect_mode"])
def test_openid_callback_rejects_bad_mode(client, request, mode_fixture):
    request.getfixturevalue(mode_fixture)
    resp = client.get(
        "/auth/steam/openid/callback",
        params={"openid.mode": "bogus"},
        follow_redirects=False,
    )
    assert_rejected(resp)


@pytest.mark.parametrize("mode_fixture", ["json_mode", "redirect_mode"])
def test_openid_callback_rejects_wrong_return_to(client, monkeypatch, request, mode_fixture):
    request.getfixturevalue(mode_fixture)
    monkeypatch.setattr("app.api.openid._verify_openid", lambda params: True)
    resp = client.get(
        "/auth/steam/openid/callback",
        params={
            "openid.mode": "id_res",
            "openid.return_to": "http://evil.example/callback",
            "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000077",
        },
        follow_redirects=False,
    )
    assert_rejected(resp)


@pytest.mark.parametrize("mode_fixture", ["json_mode", "redirect_mode"])
def test_openid_callback_rejects_bad_claimed_id(client, monkeypatch, request, mode_fixture):
    request.getfixturevalue(mode_fixture)
    monkeypatch.setattr("app.api.openid._verify_openid", lambda params: True)
    resp = client.get(
        "/auth/steam/openid/callback",
        params={
            "openid.mode": "id_res",
            "openid.return_to": "http://127.0.0.1:8000/auth/steam/openid/callback",
            "openid.claimed_id": "https://evil.com/openid/id/123",
        },
        follow_redirects=False,
    )
    assert_rejected(resp)


@pytest.mark.parametrize("mode_fixture", ["json_mode", "redirect_mode"])
def test_openid_callback_rejects_bad_signature(client, monkeypatch, request, mode_fixture):
    request.getfixturevalue(mode_fixture)
    monkeypatch.setattr("app.api.openid._verify_openid", lambda params: False)
    resp = client.get(
        "/auth/steam/openid/callback",
        params={
            "openid.mode": "id_res",
            "openid.return_to": "http://127.0.0.1:8000/auth/steam/openid/callback",
            "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000077",
        },
        follow_redirects=False,
    )
    assert_rejected(resp)


# ---------------------------------------------------------------------------
# 登录失败路径（P0-6）
# ---------------------------------------------------------------------------

def test_login_upstream_failure_401(client, monkeypatch):
    """上游 5xx / 返回空 steamid → 401。"""

    class FailingSteam(FakeSteamMixin):
        def get_token_details(self, access_token):
            raise SteamError("HTTP 500")

    monkeypatch.setattr("app.api.auth.get_steam_client", lambda: FailingSteam())
    resp = client.post("/auth/steam", json={"steam_access_token": "x" * 16})
    assert resp.status_code == 401


def test_login_steamid_mismatch_401(client):
    """客户端自报 steamid 与上游结果不一致 → 401。"""
    resp = client.post(
        "/auth/steam",
        json={"steam_access_token": "x" * 16, "steamid": "76561198000000001"},
    )
    assert resp.status_code == 401


def test_no_auth_header_401(client):
    assert client.get("/games").status_code == 401


def test_expired_token_rejected(client, db_session):
    """过期 token → 401。"""
    raw = generate_token()
    user = User(steamid="76561198000000042")
    db_session.add(user)
    db_session.flush()
    db_session.add(
        AuthToken(
            token_hash=hash_token(raw),
            user_id="76561198000000042",
            expires_at=utcnow() - timedelta(days=1),
        )
    )
    db_session.commit()

    resp = client.get("/auth/apikey", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 越权后门（P0-4）
# ---------------------------------------------------------------------------

def test_backdoor_disabled_rejects_self_reported_steamid(client, monkeypatch):
    """auth_trust_client_steamid=false 时，上游失败 + 自报 steamid 被拒（不冒用身份）。"""

    class FailingSteam(FakeSteamMixin):
        def get_token_details(self, access_token):
            raise SteamError("upstream down")

        def get_player_summaries(self, apikey, steamid):
            return {}

    monkeypatch.setattr("app.api.auth.get_steam_client", lambda: FailingSteam())
    resp = client.post(
        "/auth/steam",
        json={"steam_access_token": "x" * 16, "steamid": "76561198000000099"},
    )
    assert resp.status_code == 401
