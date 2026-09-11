"""多用户隔离断言（后端接口文档 §6：后端只存用户自己的数据，用户间按 steamid 过滤）。

此前测试里只有一个 fake steamid，跨用户串数据的路径没有断言 —— 本文件补上：
两个用户各有一份同 appid 的数据，逐接口验证互不可见。
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.api.deps import get_current_user
from app.core.security import generate_token, hash_token
from app.database import get_db
from app.main import app
from app.models.game import Achievement, Game, PlayDay, Purchase, Review, Screenshot
from app.models.user import AuthToken, User
from app.services.aggregation import build_game_outs, get_day_detail, get_timeline

ALICE = "76561198000000101"
BOB = "76561198000000102"
DAY = datetime(2026, 6, 10, 8, 30)


def _seed(session, uid: str, appid: int, shot_id: str) -> Game:
    """给某用户造一份四类事件齐全的数据（两人 appid 相同，专门制造串数据的机会）。"""
    session.add(User(steamid=uid))
    game = Game(user_id=uid, appid=appid, status="played", name_en=f"game-of-{uid}")
    session.add(game)
    session.flush()
    session.add_all(
        [
            PlayDay(user_id=uid, game_id=game.id, date=DAY.date()),
            Achievement(
                user_id=uid, game_id=game.id, achievement_id=f"ACH-{uid}", unlocktime=DAY,
                display_name=f"ach-of-{uid}",
            ),
            Purchase(user_id=uid, game_id=game.id, time_created=DAY - timedelta(days=1)),
            Screenshot(user_id=uid, game_id=game.id, shot_id=shot_id, taken_at=DAY, privacy=0),
            Review(user_id=uid, appid=appid, rating=5, comment=f"review-of-{uid}"),
        ]
    )
    session.commit()
    return game


@pytest.fixture()
def two_users(db_engine):
    session = sessionmaker(bind=db_engine)()
    _seed(session, ALICE, 600, "shot-alice")
    _seed(session, BOB, 600, "shot-bob")  # 同 appid，不同用户
    session.close()
    yield


def test_service_layer_filters_by_user(db_engine, two_users):
    """服务层：聚合 / 游戏库出参都只含本人数据。"""
    session = sessionmaker(bind=db_engine)()

    alice_timeline = get_timeline(session, ALICE)
    assert {s.shot_id for s in alice_timeline.screenshots} == {"shot-alice"}
    assert {g.name_en for g in alice_timeline.games} == {f"game-of-{ALICE}"}
    # 四类事件各一条（发售不计：status 是 played）
    assert {e.type for e in alice_timeline.events} == {"purchase", "first_play", "achievement"}
    assert len(alice_timeline.events) == 3

    bob_games = build_game_outs(session, BOB)
    assert [g.name_en for g in bob_games] == [f"game-of-{BOB}"]
    assert bob_games[0].review.comment == f"review-of-{BOB}"

    alice_day = get_day_detail(session, ALICE, DAY.date())
    assert {s.shot_id for s in alice_day.screenshots} == {"shot-alice"}
    assert alice_day.counts.achievement == 1  # 只数自己的
    session.close()


def _client_as(db_engine, uid: str) -> tuple[TestClient, dict[str, str]]:
    """以指定 steamid 建立带 token 的客户端（跳过 Steam 登录链路）。"""
    Session = sessionmaker(bind=db_engine)
    session = Session()
    raw = generate_token()
    session.add(AuthToken(token_hash=hash_token(raw), user_id=uid))
    session.commit()
    session.close()

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app), {"Authorization": f"Bearer {raw}"}


def test_api_layer_filters_by_user(db_engine, two_users):
    """接口层：同一 appid 下，两人拿到的是各自的数据，ETag 也互不相同。"""
    try:
        client, alice_h = _client_as(db_engine, ALICE)
        _, bob_h = _client_as(db_engine, BOB)

        alice_games = client.get("/games", headers=alice_h).json()
        bob_games = client.get("/games", headers=bob_h).json()
        assert alice_games[0]["name_en"] == f"game-of-{ALICE}"
        assert bob_games[0]["name_en"] == f"game-of-{BOB}"
        assert alice_games[0]["review"]["comment"] != bob_games[0]["review"]["comment"]

        alice_tl = client.get("/calendar/timeline", headers=alice_h)
        bob_tl = client.get("/calendar/timeline", headers=bob_h)
        assert [s["shot_id"] for s in alice_tl.json()["screenshots"]] == ["shot-alice"]
        assert [s["shot_id"] for s in bob_tl.json()["screenshots"]] == ["shot-bob"]
        # 指纹带 user_id，A 的 ETag 不会让 B 命中 304
        assert alice_tl.headers["ETag"] != bob_tl.headers["ETag"]
        crossed = client.get(
            "/calendar/timeline", headers={**bob_h, "If-None-Match": alice_tl.headers["ETag"]}
        )
        assert crossed.status_code == 200

        # 成就明细：同 appid 同日，各自只看到自己的那条
        alice_ach = client.get(f"/achievements/600/{DAY.date()}", headers=alice_h).json()
        bob_ach = client.get(f"/achievements/600/{DAY.date()}", headers=bob_h).json()
        assert [a["achievement_id"] for a in alice_ach] == [f"ACH-{ALICE}"]
        assert [a["achievement_id"] for a in bob_ach] == [f"ACH-{BOB}"]

        # 写接口同样按 token 归属落库，不会盖到对方
        assert client.post(
            "/games/600/review", headers=alice_h, json={"rating": 1, "comment": "改了"}
        ).status_code == 204
        assert client.get("/games", headers=bob_h).json()[0]["review"]["rating"] == 5
    finally:
        app.dependency_overrides.clear()


def test_unknown_token_is_rejected(db_engine, two_users):
    """伪造 token 拿不到任何人的数据。"""
    try:
        client, _ = _client_as(db_engine, ALICE)
        assert client.get("/games", headers={"Authorization": "Bearer not-a-real-token"}).status_code == 401
        assert client.get("/calendar/timeline").status_code == 401
        assert client.get(f"/achievements/600/{DAY.date()}").status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_get_current_user_is_bound_to_token_owner(db_engine, two_users):
    """依赖层直测：token → user 的映射不受任何请求参数影响。"""
    Session = sessionmaker(bind=db_engine)
    session = Session()
    raw = generate_token()
    session.add(AuthToken(token_hash=hash_token(raw), user_id=BOB))
    session.commit()

    from fastapi.security import HTTPAuthorizationCredentials

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=raw)
    user = get_current_user(credentials=creds, db=session)
    assert user.steamid == BOB
    session.close()
