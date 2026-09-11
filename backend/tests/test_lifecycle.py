"""生命状态派生测试（PRD §3 封盘判定 P-13 / P-14）。"""
from __future__ import annotations

from datetime import datetime, timedelta

from app.models.game import Achievement, Game, PlayDay, Screenshot
from app.models.user import User
from app.services.lifecycle import (
    T_QUIET,
    classify,
    recompute_all_lifecycle,
    recompute_user_lifecycle,
)

NOW = datetime(2026, 9, 2, 12, 0)


def test_classify_four_states():
    """四态判定逐条对齐 PRD §3 的判定表。"""
    common = {"now": NOW, "ach_unlocked": 0, "ach_total": 0}

    # 从未启动
    assert (
        classify(last_active_at=None, launched_ever=False, playtime_forever=0, **common)
        == "never_launched"
    )
    # 沉寂未满 45 天 → active（哪怕投入很深）
    assert (
        classify(
            last_active_at=NOW - timedelta(days=44),
            launched_ever=True,
            playtime_forever=10_000,
            **common,
        )
        == "active"
    )
    # 沉寂够久但投入未达标 → dormant（轴上不画标记）
    assert (
        classify(
            last_active_at=NOW - timedelta(days=60),
            launched_ever=True,
            playtime_forever=120,
            **common,
        )
        == "dormant"
    )
    # 沉寂够久 + 时长达标 → shelved
    assert (
        classify(
            last_active_at=NOW - timedelta(days=60),
            launched_ever=True,
            playtime_forever=600,
            **common,
        )
        == "shelved"
    )


def test_classify_investment_is_or_not_and():
    """投入两条是「或」：时长不够但成就比例达标同样算玩够了。"""
    assert (
        classify(
            last_active_at=NOW - timedelta(days=60),
            launched_ever=True,
            playtime_forever=30,        # 远不到 600 分钟
            ach_unlocked=5,
            ach_total=50,               # 10% 恰好达标
            now=NOW,
        )
        == "shelved"
    )
    # 比例差一点就不算
    assert (
        classify(
            last_active_at=NOW - timedelta(days=60),
            launched_ever=True,
            playtime_forever=30,
            ach_unlocked=4,
            ach_total=50,
            now=NOW,
        )
        == "dormant"
    )
    # 无成就游戏只看时长，不被成就条挡住
    assert (
        classify(
            last_active_at=NOW - timedelta(days=60),
            launched_ever=True,
            playtime_forever=700,
            ach_unlocked=0,
            ach_total=0,
            now=NOW,
        )
        == "shelved"
    )


def test_last_active_takes_max_of_four_sources(db_session):
    """last_active_at = rtime_last_played 与本地三路（运行日 / 成就 / 截图）取 max。"""
    uid = "76561198000000010"
    db_session.add(User(steamid=uid))
    game = Game(
        user_id=uid, appid=100, status="played", playtime_forever=900,
        rtime_last_played=NOW - timedelta(days=300),
    )
    db_session.add(game)
    db_session.flush()

    latest_shot = NOW - timedelta(days=100)
    db_session.add_all(
        [
            PlayDay(user_id=uid, game_id=game.id, date=(NOW - timedelta(days=200)).date()),
            Achievement(
                user_id=uid, game_id=game.id, achievement_id="A",
                unlocktime=NOW - timedelta(days=150),
            ),
            Screenshot(
                user_id=uid, game_id=game.id, shot_id="s1", taken_at=latest_shot, privacy=0,
            ),
        ]
    )
    db_session.commit()

    recompute_user_lifecycle(db_session, uid, now=NOW)
    db_session.commit()

    assert game.last_active_at == latest_shot     # 四路取最大 = 截图
    assert game.launched_ever is True
    assert game.lifecycle == "shelved"            # 沉寂 100 天 + 900 分钟
    assert game.shelved_at == latest_shot


def test_relaunch_falls_back_to_active_and_clears_shelved_at(db_session):
    """再次启动 → 下次同步回 active、shelved_at 清空（无状态、无需回滚逻辑）。"""
    uid = "76561198000000011"
    db_session.add(User(steamid=uid))
    game = Game(user_id=uid, appid=200, status="played", playtime_forever=1200)
    db_session.add(game)
    db_session.flush()
    old_day = (NOW - timedelta(days=90)).date()
    db_session.add(PlayDay(user_id=uid, game_id=game.id, date=old_day))
    db_session.commit()

    recompute_user_lifecycle(db_session, uid, now=NOW)
    db_session.commit()
    assert game.lifecycle == "shelved"
    assert game.shelved_at is not None

    # 今天又玩了一把
    db_session.add(PlayDay(user_id=uid, game_id=game.id, date=NOW.date()))
    db_session.commit()
    recompute_user_lifecycle(db_session, uid, now=NOW)
    db_session.commit()

    assert game.lifecycle == "active"
    assert game.shelved_at is None


def test_recompute_is_idempotent(db_session):
    """幂等：判定只看当下的 last_active_at，第二次重算不再产生变化。"""
    uid = "76561198000000012"
    db_session.add(User(steamid=uid))
    game = Game(user_id=uid, appid=300, status="played", playtime_forever=1200)
    db_session.add(game)
    db_session.flush()
    db_session.add(
        PlayDay(user_id=uid, game_id=game.id, date=(NOW - timedelta(days=90)).date())
    )
    db_session.commit()

    assert recompute_user_lifecycle(db_session, uid, now=NOW) == 1  # never_launched → shelved
    db_session.commit()
    assert game.lifecycle == "shelved"

    assert recompute_user_lifecycle(db_session, uid, now=NOW) == 0  # 再算无变化
    db_session.commit()
    assert game.lifecycle == "shelved"


def test_quiet_threshold_boundary(db_session):
    """阈值边界：恰好 45 天算沉寂（`>= T_quiet`），44 天仍是 active。"""
    uid = "76561198000000013"
    db_session.add(User(steamid=uid))
    db_session.commit()

    assert (
        classify(
            last_active_at=NOW - T_QUIET, launched_ever=True, playtime_forever=1000,
            ach_unlocked=0, ach_total=0, now=NOW,
        )
        == "shelved"
    )
    assert (
        classify(
            last_active_at=NOW - T_QUIET + timedelta(seconds=1), launched_ever=True,
            playtime_forever=1000, ach_unlocked=0, ach_total=0, now=NOW,
        )
        == "active"
    )


def test_recompute_all_covers_every_user(db_session):
    """阈值改动后的全库一次性重算：逐用户跑，互不干扰。"""
    for i, uid in enumerate(("76561198000000014", "76561198000000015")):
        db_session.add(User(steamid=uid))
        db_session.add(Game(user_id=uid, appid=400 + i, status="owned", playtime_forever=0))
    db_session.commit()

    # 两条都已是默认的 never_launched，重算不产生「变化」，但 lifecycle_at 一律盖章
    assert recompute_all_lifecycle(db_session, now=NOW) == 0
    db_session.commit()
    games = db_session.query(Game).all()
    assert len(games) == 2
    assert all(g.lifecycle == "never_launched" and g.lifecycle_at == NOW for g in games)
