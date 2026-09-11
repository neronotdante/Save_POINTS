"""REST 接口集成测试（假 Steam，无真实网络）。"""
from __future__ import annotations


def _login(client) -> str:
    resp = client.post("/auth/steam", json={"steam_access_token": "fake-token-12345678"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["user_id"] == "76561198000000000"
    assert data["token"]
    return data["token"]


def test_auth_requires_token(client):
    assert client.get("/auth/apikey").status_code == 401
    assert client.get("/calendar/2026/8").status_code == 401
    assert client.get("/games").status_code == 401


def test_full_flow(client):
    token = _login(client)
    headers = {"Authorization": f"Bearer {token}"}

    # 未绑 Key
    assert client.get("/auth/apikey", headers=headers).json() == {"has_key": False}
    assert client.get("/sync/status", headers=headers).json()["status"] == "unconfigured"

    # 提交 API Key（加密存储，不回显）
    resp = client.post("/auth/apikey", headers=headers, json={"apikey": "ABCDEF1234567890"})
    assert resp.status_code == 204
    assert client.get("/auth/apikey", headers=headers).json() == {"has_key": True}
    status = client.get("/sync/status", headers=headers).json()
    assert status["status"] == "idle"
    assert status["has_key"] is True

    # 提交愿望单
    resp = client.post("/wishlist", headers=headers, json={"items": [{"appid": 500, "priority": 0}]})
    assert resp.status_code == 204

    # 短评评分
    resp = client.post(
        "/games/500/review", headers=headers, json={"rating": 4, "comment": "不错"}
    )
    assert resp.status_code == 204

    # 游戏库（含生命状态六件套；愿望单游戏从未启动）
    games = client.get("/games", headers=headers).json()
    assert len(games) == 1
    assert games[0]["appid"] == 500
    assert games[0]["status"] == "wishlist"
    assert games[0]["review"]["rating"] == 4
    assert games[0]["lifecycle"] == "never_launched"
    assert games[0]["launched_ever"] is False
    assert games[0]["shelved_at"] is None
    assert games[0]["ach_unlocked"] == 0 and games[0]["ach_total"] == 0
    # playtime_forever 只供后端判定，不出参（PRD §3）
    assert "playtime_forever" not in games[0]

    # 日历（无数据 → 空数组）
    assert client.get("/calendar/2026/8", headers=headers).json() == []
    detail = client.get("/calendar/day/2026-08-15", headers=headers).json()
    assert detail == {
        "counts": {"achievement": 0, "first_play": 0, "release": 0},
        "rows": [],
        "screenshots": [],
    }

    # 时间轴（范式 B）全量接口：events + screenshots + games（带生命状态）
    timeline = client.get("/calendar/timeline", headers=headers).json()
    assert timeline["events"] == []
    assert timeline["screenshots"] == []
    assert [g["appid"] for g in timeline["games"]] == [500]
    assert timeline["games"] == games  # 与 /games 同一份构建逻辑，口径不漂


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_apikey_rejected_when_steam_refuses(client, monkeypatch):
    """Key 无效时 POST /auth/apikey 立刻 400，不落库——不能留一个同步时才炸的坏 Key。"""
    from conftest import FakeSteamMixin

    from app.services.steam import SteamNotRetryable

    token = _login(client)
    headers = {"Authorization": f"Bearer {token}"}

    class RefusingSteam(FakeSteamMixin):
        def get_token_details(self, access_token):
            return "76561198000000000"

        def get_player_summaries(self, apikey, steamid):
            raise SteamNotRetryable("HTTP 403: Forbidden")

    monkeypatch.setattr("app.api.auth.get_steam_client", lambda: RefusingSteam())
    resp = client.post("/auth/apikey", headers=headers, json={"apikey": "BADBADBADBADBAD1"})
    assert resp.status_code == 400
    assert "API Key" in resp.json()["detail"]
    assert client.get("/auth/apikey", headers=headers).json() == {"has_key": False}


def test_apikey_can_be_unbound(client):
    """DELETE /auth/apikey 解绑后 has_key 回到 false，同步状态回到 unconfigured。"""
    token = _login(client)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/auth/apikey", headers=headers, json={"apikey": "ABCDEF1234567890"}).status_code == 204
    assert client.get("/auth/apikey", headers=headers).json() == {"has_key": True}

    assert client.delete("/auth/apikey", headers=headers).status_code == 204
    assert client.get("/auth/apikey", headers=headers).json() == {"has_key": False}
    assert client.get("/sync/status", headers=headers).json()["status"] == "unconfigured"


def test_logout_revokes_token(client):
    token = _login(client)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/auth/apikey", headers=headers).status_code == 200

    assert client.post("/auth/logout", headers=headers).status_code == 204
    # token 已撤销，后续请求 401
    assert client.get("/auth/apikey", headers=headers).status_code == 401


def test_timeline_etag_304(client):
    """数据没变时 If-None-Match 命中 → 304 且无 body；数据一变指纹就变。"""
    token = _login(client)
    headers = {"Authorization": f"Bearer {token}"}

    first = client.get("/calendar/timeline", headers=headers)
    etag = first.headers["ETag"]
    assert etag

    cached = client.get("/calendar/timeline", headers={**headers, "If-None-Match": etag})
    assert cached.status_code == 304
    assert cached.content == b""

    # 写入一条数据 → 指纹变化 → 旧 ETag 不再命中
    client.post("/wishlist", headers=headers, json={"items": [{"appid": 777, "priority": 0}]})
    changed = client.get("/calendar/timeline", headers={**headers, "If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["ETag"] != etag


def test_timeline_forbids_heuristic_caching(client):
    """ETag 必须配 ``Cache-Control: no-cache``，200 与 304 两条路上都要有。

    只给 ETag 不给新鲜度信息时，浏览器会按 RFC 9111 给响应**自己估一个保质期**，在这段时间
    里直接吃本地副本、一次条件请求都不发。症状是同步完刷新页面还是旧数据、且毫无报错——
    这条断言就是为了不让那个坑再回来。
    """
    token = _login(client)
    headers = {"Authorization": f"Bearer {token}"}

    fresh = client.get("/calendar/timeline", headers=headers)
    assert fresh.headers["Cache-Control"] == "no-cache"

    cached = client.get(
        "/calendar/timeline", headers={**headers, "If-None-Match": fresh.headers["ETag"]}
    )
    assert cached.status_code == 304
    assert cached.headers["Cache-Control"] == "no-cache"


def test_achievement_detail_route(client, db_engine):
    """时点成就明细懒加载（07 §4.8）：按 (appid, 日期) 取当日解锁，升序。"""
    from datetime import datetime

    from sqlalchemy.orm import sessionmaker

    from app.models.game import Achievement, Game

    token = _login(client)
    headers = {"Authorization": f"Bearer {token}"}
    uid = "76561198000000000"

    session = sessionmaker(bind=db_engine)()
    game = Game(user_id=uid, appid=440, status="played")
    session.add(game)
    session.flush()
    session.add_all(
        [
            Achievement(
                user_id=uid, game_id=game.id, achievement_id="LATE",
                unlocktime=datetime(2026, 5, 4, 18, 0), display_name="后解锁", global_percent=3.9,
            ),
            Achievement(
                user_id=uid, game_id=game.id, achievement_id="EARLY",
                unlocktime=datetime(2026, 5, 4, 9, 0), display_name="先解锁", global_percent=42.5,
            ),
            Achievement(
                user_id=uid, game_id=game.id, achievement_id="OTHERDAY",
                unlocktime=datetime(2026, 5, 5, 9, 0),
            ),
        ]
    )
    session.commit()
    session.close()

    rows = client.get("/achievements/440/2026-05-04", headers=headers).json()
    assert [r["achievement_id"] for r in rows] == ["EARLY", "LATE"]  # 时间升序
    assert rows[0]["global_percent"] == 42.5
    assert rows[1]["display_name"] == "后解锁"

    # 当日无解锁 / 非本人游戏 → 空数组（不是 404）
    assert client.get("/achievements/440/2026-05-06", headers=headers).json() == []
    assert client.get("/achievements/999999/2026-05-04", headers=headers).json() == []
