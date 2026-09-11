"""日历聚合测试：直接落库后验证月事件与日详情。"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select

from app.core.colors import PURCHASE_COLOR, RELEASE_COLOR
from app.models.game import Achievement, Game, PlayDay, Purchase, Screenshot
from app.models.user import User
from app.services.aggregation import get_day_detail, get_month_events, get_timeline


def _dt(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm)  # naive UTC（与全工程约定一致）


def seed(db) -> str:
    uid = "76561198000000001"
    db.add(User(steamid=uid))

    g1 = Game(user_id=uid, appid=100, status="played", theme_color="#B0761A",
              name_zh="艾尔登法环", name_en="Elden Ring")
    g2 = Game(user_id=uid, appid=200, status="owned", theme_color="#238A79",
              name_zh="空洞骑士", name_en="Hollow Knight")
    g3 = Game(user_id=uid, appid=300, status="wishlist", release_date=date(2026, 8, 15))
    db.add_all([g1, g2, g3])
    db.flush()

    db.add_all([
        PlayDay(user_id=uid, game_id=g1.id, date=date(2026, 8, 1)),
        PlayDay(user_id=uid, game_id=g1.id, date=date(2026, 8, 5)),
        PlayDay(user_id=uid, game_id=g2.id, date=date(2026, 8, 10)),
    ])
    db.add_all([
        Achievement(user_id=uid, game_id=g1.id, achievement_id="a1", unlocktime=_dt(2026, 8, 3, 10)),
        Achievement(user_id=uid, game_id=g1.id, achievement_id="a2", unlocktime=_dt(2026, 8, 3, 11)),
        Achievement(user_id=uid, game_id=g1.id, achievement_id="a3", unlocktime=_dt(2026, 8, 20, 9)),
    ])
    db.add(Purchase(user_id=uid, game_id=g2.id, time_created=_dt(2026, 8, 7, 12)))
    db.commit()
    return uid


def test_month_events(db_session):
    uid = seed(db_session)
    events = get_month_events(db_session, uid, 2026, 8)

    by_type = {}
    for e in events:
        by_type.setdefault(e.type, []).append(e)

    assert len(events) == 6
    assert len(by_type["release"]) == 1
    assert by_type["release"][0].date == date(2026, 8, 15)
    assert by_type["release"][0].theme_color == RELEASE_COLOR

    assert len(by_type["purchase"]) == 1
    assert by_type["purchase"][0].date == date(2026, 8, 7)
    assert by_type["purchase"][0].theme_color == PURCHASE_COLOR

    # 首次游玩：每游戏取最早运行日
    firsts = {(e.date, e.game.appid) for e in by_type["first_play"]}
    assert firsts == {(date(2026, 8, 1), 100), (date(2026, 8, 10), 200)}

    # 成就簇：按 (game, 日) 聚合
    ach = {(e.date, e.count) for e in by_type["achievement"]}
    assert ach == {(date(2026, 8, 3), 2), (date(2026, 8, 20), 1)}


def test_event_minutes(db_session):
    """事件带当日时刻：成就簇取该日**最早**一次解锁，与 DayRow.time 同口径。

    客户端要靠它挑「当天第一件事是什么」——出参里只有 date（到日）时，同一天的事件顺序
    由 (date, type) 的字符串序 + 数据库扫描顺序决定，是个任意值。
    """
    uid = seed(db_session)
    events = get_month_events(db_session, uid, 2026, 8)
    at = {(e.date, e.type): e.minutes for e in events}
    assert at[(date(2026, 8, 3), "achievement")] == 10 * 60   # a1 10:00 早于 a2 11:00
    assert at[(date(2026, 8, 7), "purchase")] == 12 * 60      # 真实下单时刻
    assert at[(date(2026, 8, 1), "first_play")] == 12 * 60    # 无时间戳，惯例 12:00
    assert at[(date(2026, 8, 15), "release")] == 60           # 无时间戳，惯例 01:00


def test_day_detail(db_session):
    uid = seed(db_session)
    detail = get_day_detail(db_session, uid, date(2026, 8, 3))

    assert detail.counts.achievement == 2
    assert detail.counts.first_play == 0
    assert detail.counts.release == 0
    assert len(detail.rows) == 1
    assert detail.rows[0].type == "achievement"
    assert detail.rows[0].count == 2
    assert detail.rows[0].time == 10 * 60  # 该日最早解锁 10:00
    assert detail.rows[0].game.appid == 100


def test_day_detail_release_count(db_session):
    uid = seed(db_session)
    detail = get_day_detail(db_session, uid, date(2026, 8, 15))
    assert detail.counts.release == 1
    assert any(r.type == "release" for r in detail.rows)


def test_empty_month(db_session):
    uid = seed(db_session)
    assert get_month_events(db_session, uid, 2020, 1) == []


def test_timeline_and_day_screenshots(db_session):
    uid = seed(db_session)
    game = db_session.scalars(select(Game).where(Game.user_id == uid, Game.appid == 100)).first()
    db_session.add(
        Screenshot(
            user_id=uid, game_id=game.id, shot_id="shot1",
            taken_at=_dt(2026, 8, 3, 14, 30), thumbnail_url="http://t/1.jpg", privacy=0,
        )
    )
    db_session.commit()

    timeline = get_timeline(db_session, uid)
    assert len(timeline.events) == 6  # 全量时点事件与 8 月一致（仅本月有数据）
    assert len(timeline.screenshots) == 1
    assert timeline.screenshots[0].appid == 100
    assert timeline.screenshots[0].shot_id == "shot1"

    detail = get_day_detail(db_session, uid, date(2026, 8, 3))
    assert len(detail.screenshots) == 1
    assert detail.screenshots[0].thumbnail_url == "http://t/1.jpg"
