"""同步服务测试（元数据补全 / 主题色接入 / 全量游戏 / 成就三件套，无需网络）。"""
from __future__ import annotations

from conftest import FakeSteamMixin

import pytest
from sqlalchemy import select

from app.core.colors import ACHIEVE_FALLBACK
from app.core.security import encrypt_secret
from app.models.game import Achievement, Game
from app.models.user import User
from app.services.sync_service import (
    backfill_achievements,
    sync_screenshots,
    backfill_owned_games,
    sync_owned_games,
    enrich_game_metadata,
    load_session,
    release_sync,
    try_acquire_sync,
)


class RichFakeSteam(FakeSteamMixin):
    def get_app_details(self, appid: int, language: str = "schinese"):
        if language == "schinese":
            return {
                "name": "艾尔登法环",
                "header_image": "https://x/header.jpg",
                "developers": ["FromSoftware"],
                "release_date": {"coming_soon": False, "date": "25 Feb, 2022"},
            }
        return {
            "name": "Elden Ring",
            "header_image": "https://x/header.jpg",
            "developers": ["FromSoftware"],
            "release_date": {"coming_soon": False, "date": "25 Feb, 2022"},
        }

    def download_bytes(self, url: str):
        return None  # 无封面字节 → 回退色


class LibraryFakeSteam(FakeSteamMixin):
    def get_owned_games(self, apikey: str, steamid: str):
        return [
            # playtime_forever / rtime_last_played 是封盘判定的输入（PRD §3）
            {
                "appid": 100, "name": "Game One",
                "playtime_forever": 900, "rtime_last_played": 1750000000,
            },
            {"appid": 200, "name": "Game Two", "playtime_forever": 0},
        ]

    def get_app_details(self, appid: int, language: str = "schinese"):
        return None  # 不补元数据，只验证游戏入库


class AchievementsFakeSteam(FakeSteamMixin):
    def get_player_achievements(self, apikey: str, steamid: str, appid: int):
        return [
            {"apiname": "WIN", "achieved": 1, "unlocktime": 1700000000},
            {"apiname": "LOSE", "achieved": 0, "unlocktime": 0},
        ]

    def get_schema_for_game(self, apikey: str, appid: int):
        return {"WIN": {"display_name": "Winner", "icon": "https://icon.png"}}

    def get_global_achievement_percentages(self, appid: int):
        return {"WIN": 3.9}


def test_enrich_metadata_zh_en_portrait_theme(db_session):
    uid = "76561198000000002"
    db_session.add(User(steamid=uid))
    db_session.commit()

    game = enrich_game_metadata(db_session, uid, 1245620, RichFakeSteam())
    db_session.commit()

    assert game.name_zh == "艾尔登法环"
    assert game.name_en == "Elden Ring"
    assert game.cover_portrait.endswith("/1245620/library_600x900.jpg")
    assert game.release_date.year == 2022
    assert game.theme_color == ACHIEVE_FALLBACK
    assert game.theme_color_source == "fallback"


def test_enrich_metadata_drops_missing_portrait(db_session):
    """CDN 上没有 library_600x900 的 app，不能把 404 地址当封面存下去。

    背景：这个地址是按 appid 拼的模板，真实库 348 款里 32 款（9.6%）是 404，而 CSS
    background-image 加载失败是静默的——前端只露出底下的主题色渐变，看着就像「这些游戏
    没封面」。存 None，前端才会退到横版 header_image（那一批实测 334/334 全部可用）。
    """
    uid = "76561198000000009"
    db_session.add(User(steamid=uid))
    db_session.commit()

    steam = RichFakeSteam()
    steam.portrait_exists = False
    game = enrich_game_metadata(db_session, uid, 1245620, steam)
    db_session.commit()

    assert game.cover_portrait is None
    assert game.cover  # 横版仍在，前端有东西可退


def test_enrich_metadata_keeps_verified_portrait_without_reprobing(db_session):
    """已经存着模板地址 = 上次验过是好的，不该每次同步都再 HEAD 一遍。"""
    uid = "76561198000000010"
    db_session.add(User(steamid=uid))
    db_session.commit()

    steam = RichFakeSteam()
    enrich_game_metadata(db_session, uid, 1245620, steam)
    db_session.commit()

    probed = []
    steam.asset_exists = lambda url: probed.append(url) or True
    enrich_game_metadata(db_session, uid, 1245620, steam)
    assert probed == []


def test_backfill_owned_games_populates_library(db_session):
    uid = "76561198000000003"
    db_session.add(User(steamid=uid))
    db_session.commit()

    count = backfill_owned_games(db_session, uid, "key", LibraryFakeSteam())
    db_session.commit()

    assert count == 2
    games = {g.appid: g for g in db_session.scalars(select(Game).where(Game.user_id == uid)).all()}
    assert set(games) == {100, 200}
    assert all(g.status == "owned" for g in games.values())
    # 封盘判定的两个输入随之落库
    assert games[100].playtime_forever == 900
    assert games[100].rtime_last_played is not None
    assert games[200].playtime_forever == 0


def test_sync_owned_games_refreshes_playtime_every_round(db_session):
    """playtime_forever / rtime_last_played 每轮都刷——判据要跟着最新一次启动走。"""
    uid = "76561198000000031"
    db_session.add(User(steamid=uid))
    db_session.add(Game(user_id=uid, appid=100, status="owned", playtime_forever=10))
    db_session.commit()

    sync_owned_games(db_session, uid, "key", LibraryFakeSteam())
    db_session.commit()

    game = db_session.scalars(select(Game).where(Game.user_id == uid, Game.appid == 100)).first()
    assert game.playtime_forever == 900  # 旧值被权威值覆盖，而不是「仅补空」


def test_backfill_achievements_display_trio(db_session):
    uid = "76561198000000004"
    db_session.add(User(steamid=uid))
    db_session.add(Game(user_id=uid, appid=100, status="owned", name_en="Game One"))
    db_session.commit()

    games, unlocks = backfill_achievements(db_session, uid, "key", AchievementsFakeSteam())
    db_session.commit()

    assert games == 1
    assert unlocks == 1
    ach = db_session.scalars(select(Achievement).where(Achievement.user_id == uid)).first()
    assert ach.achievement_id == "WIN"
    assert ach.display_name == "Winner"
    assert ach.icon_url == "https://icon.png"
    assert ach.global_percent == 3.9

    game = db_session.scalars(select(Game).where(Game.user_id == uid)).first()
    assert game.ach_total == 1              # schema 的成就总数（判定 ach_unlocked/ach_total 用）
    assert game.achievements_at is not None  # 回填时间戳 = 增量判据


def test_backfill_achievements_is_incremental(db_session):
    """增量：回填过就不再重拉；之后又玩过（last_active_at 变新）才重新入队。"""
    from datetime import timedelta

    from app.core.timeutil import utcnow

    uid = "76561198000000032"
    db_session.add(User(steamid=uid))
    db_session.add(Game(user_id=uid, appid=100, status="owned"))
    db_session.commit()
    steam = AchievementsFakeSteam()

    assert backfill_achievements(db_session, uid, "key", steam)[0] == 1
    db_session.commit()

    # 第二轮：没玩过 → 不重拉（旧实现按「achievements 表有无记录」判断，这里会重复打上游）
    assert backfill_achievements(db_session, uid, "key", steam)[0] == 0
    db_session.commit()

    # 回填之后又玩过 → 重新入队，捕获新解锁
    game = db_session.scalars(select(Game).where(Game.user_id == uid)).first()
    game.last_active_at = utcnow() + timedelta(minutes=1)
    db_session.commit()
    assert backfill_achievements(db_session, uid, "key", steam)[0] == 1


def test_backfill_achievements_batches(db_session):
    """分批：单轮不超过 batch_size，剩余的下一轮继续（靠 achievements_at 自然推进）。"""
    uid = "76561198000000033"
    db_session.add(User(steamid=uid))
    for appid in (101, 102, 103):
        db_session.add(Game(user_id=uid, appid=appid, status="owned"))
    db_session.commit()
    steam = AchievementsFakeSteam()

    assert backfill_achievements(db_session, uid, "key", steam, batch_size=2)[0] == 2
    db_session.commit()
    assert backfill_achievements(db_session, uid, "key", steam, batch_size=2)[0] == 1
    db_session.commit()
    assert backfill_achievements(db_session, uid, "key", steam, batch_size=2)[0] == 0


def test_backfill_achievements_marks_games_without_achievements(db_session):
    """无成就的游戏也盖回填时间戳，不会每轮重试一遍。"""
    uid = "76561198000000034"
    db_session.add(User(steamid=uid))
    db_session.add(Game(user_id=uid, appid=104, status="owned"))
    db_session.commit()

    class NoAchievementsSteam(FakeSteamMixin):
        def get_player_achievements(self, apikey, steamid, appid):
            return []

        def get_schema_for_game(self, apikey, appid):
            return {}

        def get_global_achievement_percentages(self, appid):
            return {}

    steam = NoAchievementsSteam()
    assert backfill_achievements(db_session, uid, "key", steam) == (1, 0)
    db_session.commit()
    game = db_session.scalars(select(Game).where(Game.user_id == uid)).first()
    assert game.achievements_at is not None
    assert backfill_achievements(db_session, uid, "key", steam) == (0, 0)


def test_retry_with_backoff_actually_retries():
    """退避重试真的会重试并原样抛出业务异常。

    回归点：模块里 `import time` 曾被 `from datetime import ... time` 覆盖，
    退避那行 `time.sleep` 实际抛 AttributeError，把原始异常吞掉——
    §5 的「失败重试 + 指数退避」从未生效过。
    """
    from app.services.sync_service import NoApiKey, retry_with_backoff

    calls = []

    def boom():
        calls.append(1)
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        retry_with_backoff(boom, max_attempts=3, base_delay=0.001)
    assert len(calls) == 3  # 重试到上限，而不是第一次就炸在 sleep 上

    # NoApiKey 不可恢复，不进重试
    unrecoverable = []

    def no_key():
        unrecoverable.append(1)
        raise NoApiKey

    with pytest.raises(NoApiKey):
        retry_with_backoff(no_key, max_attempts=3, base_delay=0.001)
    assert len(unrecoverable) == 1


def test_sync_concurrency_guard():
    assert try_acquire_sync("uid-lock") is True
    assert try_acquire_sync("uid-lock") is False  # 已在同步，拒绝并行
    release_sync("uid-lock")
    assert try_acquire_sync("uid-lock") is True
    release_sync("uid-lock")


def test_load_session_roundtrip(db_session):
    import json

    uid = "76561198000000005"
    user = User(
        steamid=uid,
        session_cookie_enc=encrypt_secret(
            json.dumps({"sessionid": "sid1", "steamLoginSecure": "sls1"})
        ),
    )
    db_session.add(user)
    db_session.commit()

    assert load_session(user) == {"sessionid": "sid1", "steamLoginSecure": "sls1"}

    u2 = User(steamid="76561198000000006")
    db_session.add(u2)
    db_session.commit()
    assert load_session(u2) is None


# --------------------------------------------------------------------------
# 首轮同步提速（L0 连接复用 / L1 去掉无效调用）
# --------------------------------------------------------------------------

def test_steam_client_reuses_one_connection_pool():
    """L0：同一个 SteamClient 全程复用一个 httpx.Client（不再每请求新建）。

    每请求新建等于每次重做 TCP+TLS 握手，实测每次多花约 1.55 秒。
    """
    import httpx

    from app.services.steam import SteamClient

    with SteamClient() as steam:
        assert isinstance(steam._client, httpx.Client)
        assert steam._client is steam._client  # 同一实例上是同一个池
        assert steam._client.is_closed is False
    # with 退出后连接池已释放
    assert steam._client.is_closed is True


def test_enrich_skips_english_call_when_name_en_known(db_session):
    """L1：本地已有英文名时，不再为英文名多打一次 Store API。

    owned 路径下 GetOwnedGames 已经给了英文名，无条件再拉是白打
    ——占首轮 Store 调用的约 40%。
    """
    uid = "76561198000000040"
    db_session.add(User(steamid=uid))
    db_session.commit()

    class CountingSteam(RichFakeSteam):
        def __init__(self):
            self.langs = []

        def get_app_details(self, appid, language="schinese"):
            self.langs.append(language)
            return super().get_app_details(appid, language)

    # ① 已有英文名（模拟 GetOwnedGames 存过）→ 只打中文那一次
    db_session.add(Game(user_id=uid, appid=100, status="owned", name_en="Elden Ring"))
    db_session.commit()
    steam = CountingSteam()
    enrich_game_metadata(db_session, uid, 100, steam)
    db_session.commit()
    assert steam.langs == ["schinese"], "已有英文名却仍拉了 english"

    # ② 没有英文名（愿望单路径没有兜底）→ 仍要拉 english，否则英文名永远缺
    steam2 = CountingSteam()
    enrich_game_metadata(db_session, uid, 200, steam2)
    db_session.commit()
    assert steam2.langs == ["schinese", "english"]
    game = db_session.scalars(select(Game).where(Game.appid == 200)).first()
    assert game.name_en == "Elden Ring"


def test_screenshots_fetched_via_official_api(db_session):
    """截图一次性拉全部，不逐游戏请求。

    社区接口不带 appid 就返回全部截图、每条自带 appid。逐游戏拉在实测里是
    256 次请求 / 156 秒、收获恒为 0——占整轮请求量的 69%。
    """
    from datetime import datetime

    uid = "76561198000000041"
    db_session.add(User(steamid=uid))
    db_session.add_all([
        Game(user_id=uid, appid=101, status="owned", launched_ever=True),
        Game(user_id=uid, appid=102, status="owned", launched_ever=False),
    ])
    db_session.commit()

    class ShotSteam(FakeSteamMixin):
        def __init__(self):
            self.calls = []

        def get_user_screenshots(self, apikey, steamid, page=1, numperpage=100):
            self.calls.append(page)
            if page > 1:
                return []
            return [
                {"shot_id": "s1", "appid": 101, "taken_at": datetime(2026, 5, 4, 9, 0),
                 "thumbnail_url": None, "url": None, "privacy": 0, "caption": None},
                # 截图能带出库里还没有的游戏（appid 103）——按需建档
                {"shot_id": "s2", "appid": 103, "taken_at": datetime(2026, 5, 4, 10, 0),
                 "thumbnail_url": None, "url": None, "privacy": 0, "caption": None},
            ]

    steam = ShotSteam()
    added, days = sync_screenshots(db_session, uid, "key", steam)
    db_session.commit()

    assert steam.calls == [1], "一次请求就该取完，不该逐游戏拉"
    assert added == 2 and days == 2
    assert db_session.scalars(select(Game).where(Game.user_id == uid, Game.appid == 103)).first()


def test_screenshots_stop_when_first_page_empty(db_session):
    """首页解析不出截图就收手：没有公开截图 / 上游结构变更时，翻页全是白跑。"""
    uid = "76561198000000042"
    db_session.add(User(steamid=uid))
    db_session.add(Game(user_id=uid, appid=101, status="owned", launched_ever=True))
    db_session.commit()

    class EmptySteam(FakeSteamMixin):
        def __init__(self):
            self.pages = []

        def get_user_screenshots(self, apikey, steamid, page=1, numperpage=100):
            self.pages.append(page)
            return []

    steam = EmptySteam()
    assert sync_screenshots(db_session, uid, "key", steam) == (0, 0)
    assert steam.pages == [1], "首页无果后仍在继续翻页"


def test_derive_play_days_from_achievements(db_session):
    """成就解锁日 → 运行日：补齐、幂等、同一天多个成就只算一天。"""
    from datetime import date, datetime as _dt

    from app.models.game import PlayDay
    from app.services.sync_service import (
        derive_play_days_from_achievements,
        get_or_create_game,
        upsert_achievement,
    )

    uid = "76561198000000901"
    db_session.add(User(steamid=uid))
    db_session.commit()
    game = get_or_create_game(db_session, uid, 4242)
    # 同一天解锁三个 + 另一天解锁一个 → 应派生出 2 个运行日
    for i, ts in enumerate([
        _dt(2015, 9, 12, 10, 0), _dt(2015, 9, 12, 22, 30), _dt(2015, 9, 12, 23, 59),
        _dt(2016, 3, 1, 8, 0),
    ]):
        upsert_achievement(db_session, uid, game.id, f"ACH_{i}", ts)
    db_session.commit()

    assert derive_play_days_from_achievements(db_session, uid) == 2
    db_session.commit()

    days = sorted(
        d for (d,) in db_session.execute(
            select(PlayDay.date).where(PlayDay.user_id == uid, PlayDay.game_id == game.id)
        ).all()
    )
    assert [d.isoformat() for d in days] == ["2015-09-12", "2016-03-01"]

    # 再跑一次不重复插入（幂等），也不与已有的运行日撞唯一约束
    assert derive_play_days_from_achievements(db_session, uid) == 0
    db_session.commit()


def test_derive_play_days_pulls_first_play_earlier(db_session):
    """回归：只有截图时 first_play 取的是最早**截图**日，成就能把它前移到真实的首玩日。"""
    from datetime import date, datetime as _dt

    from sqlalchemy import func as _func

    from app.models.game import PlayDay
    from app.services.sync_service import (
        derive_play_days_from_achievements,
        get_or_create_game,
        upsert_achievement,
        upsert_play_day,
    )

    uid = "76561198000000902"
    db_session.add(User(steamid=uid))
    db_session.commit()
    game = get_or_create_game(db_session, uid, 4243)
    # 截图派生的运行日（晚）
    upsert_play_day(db_session, uid, game.id, date(2016, 9, 9))
    # 成就证明更早就玩过（早了 305 天，Fallout 4 的真实情况）
    upsert_achievement(db_session, uid, game.id, "ACH_EARLY", _dt(2015, 11, 9, 20, 0))
    db_session.commit()

    first = db_session.execute(
        select(_func.min(PlayDay.date)).where(PlayDay.user_id == uid, PlayDay.game_id == game.id)
    ).scalar_one()
    assert first == date(2016, 9, 9)

    derive_play_days_from_achievements(db_session, uid)
    db_session.commit()

    first = db_session.execute(
        select(_func.min(PlayDay.date)).where(PlayDay.user_id == uid, PlayDay.game_id == game.id)
    ).scalar_one()
    assert first == date(2015, 11, 9)
