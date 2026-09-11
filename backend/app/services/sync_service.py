"""数据同步编排：每日轮询 + 成就回填 + 元数据补全 + 愿望单 / 购买入库。

约定：
- 单用户失败不影响他人（调度器按用户隔离 try/except）。
- API Key 由调用方解密传入，不在此落日志。
- 所有时间戳统一 UTC；成就 / 运行日幂等（唯一约束去重）。
"""
from __future__ import annotations

import json
import logging
import threading
# 标准库 time 与 datetime.time 重名——后者被 sync_purchase_history 用来构造日粒度时间戳，
# 直接 `import time` 会被下一行的 from-import 覆盖掉，退避里的 time.sleep 就成了 AttributeError。
import time as _time
from collections.abc import Generator
from datetime import date, datetime, time
from typing import Any, Callable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import InvalidToken, decrypt_secret
from app.core.timeutil import from_ts, utc_date, utcnow
from app.database import SessionLocal
from app.models.game import (
    Achievement,
    Game,
    PlayDay,
    Purchase,
    Screenshot,
    SyncState,
)
from app.models.user import User
from app.services.steam import (
    SteamClient,
    SteamError,
    get_steam_client,
    parse_purchase_history,
)
from app.services import steam_cache
from app.services.lifecycle import recompute_user_lifecycle
from app.core.colors import ACHIEVE_FALLBACK
from app.services.theme import color_extraction_available, compute_theme_color

logger = logging.getLogger(__name__)


class NoApiKey(RuntimeError):
    """用户未绑定 API Key，跳过采集。"""


# --------------------------------------------------------------------------
# 基础 upsert
# --------------------------------------------------------------------------

def get_or_create_game(db: Session, user_id: str, appid: int, **fields: Any) -> Game:
    game = db.scalars(select(Game).where(Game.user_id == user_id, Game.appid == appid)).first()
    if game is None:
        game = Game(user_id=user_id, appid=appid, **fields)
        db.add(game)
        db.flush()
    else:
        for key, value in fields.items():
            if value is not None and getattr(game, key) is None:
                setattr(game, key, value)
    return game


def upsert_play_day(db: Session, user_id: str, game_id: int, day: date) -> bool:
    """记一条运行日；已存在返回 False（幂等）。

    ``db.flush()`` 不能省：会话是 ``autoflush=False``，``db.add()`` 之后对象还挂在
    pending 队列里，紧接着的 ``select`` **查不到它**。同一游戏同一天有多张截图时
    （截图按日聚簇派生运行日，PRD §3），同一个 (user, game, date) 会被连着 upsert 多次，
    每次都判定「不存在」→ 攒下多条 pending → 提交时 UNIQUE 约束炸。
    flush 让它立刻进事务，后续查询就能看见。
    """
    exists = db.scalars(
        select(PlayDay.id).where(
            PlayDay.user_id == user_id, PlayDay.game_id == game_id, PlayDay.date == day
        )
    ).first()
    if exists:
        return False
    db.add(PlayDay(user_id=user_id, game_id=game_id, date=day))
    db.flush()
    return True


def upsert_achievement(
    db: Session,
    user_id: str,
    game_id: int,
    achievement_id: str,
    unlocktime,
    *,
    display_name: str | None = None,
    icon_url: str | None = None,
    global_percent: float | None = None,
    percent_at=None,
) -> bool:
    existing = db.scalars(
        select(Achievement).where(
            Achievement.user_id == user_id,
            Achievement.game_id == game_id,
            Achievement.achievement_id == achievement_id,
        )
    ).first()
    if existing is not None:
        # 已有解锁记录：unlocktime 不动（历史事实），只补齐后来才拉到的展示三件套。
        if display_name and not existing.display_name:
            existing.display_name = display_name
        if icon_url and not existing.icon_url:
            existing.icon_url = icon_url
        if global_percent is not None:
            existing.global_percent = global_percent
            existing.percent_at = percent_at
        return False
    db.add(
        Achievement(
            user_id=user_id,
            game_id=game_id,
            achievement_id=achievement_id,
            unlocktime=unlocktime,
            display_name=display_name,
            icon_url=icon_url,
            global_percent=global_percent,
            percent_at=percent_at,
        )
    )
    return True


def upsert_purchase(db: Session, user_id: str, game_id: int, time_created, payment_method=None) -> bool:
    exists = db.scalars(
        select(Purchase.id).where(
            Purchase.user_id == user_id,
            Purchase.game_id == game_id,
            Purchase.time_created == time_created,
        )
    ).first()
    if exists:
        return False
    db.add(
        Purchase(
            user_id=user_id, game_id=game_id, time_created=time_created,
            payment_method=payment_method,
        )
    )
    return True


def upsert_screenshot(db: Session, user_id: str, game_id: int, shot: dict) -> bool:
    """截图入库（幂等，按 shot_id 去重）。"""
    exists = db.scalars(
        select(Screenshot.id).where(
            Screenshot.user_id == user_id,
            Screenshot.game_id == game_id,
            Screenshot.shot_id == shot["shot_id"],
        )
    ).first()
    if exists:
        return False
    db.add(
        Screenshot(
            user_id=user_id,
            game_id=game_id,
            shot_id=shot["shot_id"],
            taken_at=shot["taken_at"],
            thumbnail_url=shot.get("thumbnail_url"),
            url=shot.get("url"),
            privacy=int(shot.get("privacy", 0)),
            caption=shot.get("caption"),
        )
    )
    return True


def get_state(db: Session, user_id: str) -> SyncState:
    state = db.get(SyncState, user_id)
    if state is None:
        state = SyncState(user_id=user_id)
        db.add(state)
        db.flush()
    return state


# --------------------------------------------------------------------------
# 数据源同步
# --------------------------------------------------------------------------

def sync_recently_played(db: Session, user_id: str, apikey: str, steam: SteamClient) -> int:
    """每日轮询 GetRecentlyPlayedGames → 记运行日（核心指标）。返回本次记入的游戏数。"""
    games = steam.get_recently_played(apikey, user_id)
    recorded = 0
    for item in games:
        appid = int(item.get("appid", 0))
        if not appid:
            continue
        game = get_or_create_game(db, user_id, appid, name_en=item.get("name"), status="played")
        ts = item.get("rtime_last_played")
        if ts:
            if upsert_play_day(db, user_id, game.id, utc_date(from_ts(ts))):
                recorded += 1
    return recorded


# 首次同步补元数据时的落库 / 报进度批大小。
# 首次同步每款游戏要打 Store API + 下封面（各 1~2s，串行），500 款的库要跑几十分钟：
# 不分批就等于「几十分钟里前端一个事件收不到、数据库一条不落」——中途关页面全部白跑。
OWNED_BATCH = 10


def iter_sync_owned_games(
    db: Session, user_id: str, apikey: str, steam: SteamClient, *, enrich: bool = False
):
    """``GetOwnedGames`` 全量，**逐批产出进度事件**（供 SSE 实时呈现）。

    - ``playtime_forever`` / ``rtime_last_played`` **每轮都刷**——生命状态判据要跟着最新一次启动走。
    - ``enrich=True`` 时逐 appid 打 Store API 补元数据 / 主题色，**只补缺的那些**（判据见下）。
    - **每 ``OWNED_BATCH`` 款提交一次**：慢是没办法的（上游限速），但慢不该等于「不可中断」。
      分批提交后，中断 / 关页面已拉到的部分仍然留在库里，下一轮从缺元数据的那些继续。
    """
    owned = steam.get_owned_games(apikey, user_id)
    total = len(owned)
    count = 0
    # 先把总数报出去：前端在第一款游戏抓完之前就能显示「0 / 512」，而不是干等
    yield {"step": "owned_games", "status": "running", "processed": 0, "total": total}

    for item in owned:
        appid = int(item.get("appid", 0))
        if not appid:
            continue
        game = get_or_create_game(db, user_id, appid, name_en=item.get("name"), status="owned")
        # 判定输入：权威值直接覆盖（不走 get_or_create_game 的「仅补空」语义）
        game.playtime_forever = int(item.get("playtime_forever") or 0)
        last_played = item.get("rtime_last_played")
        if last_played:
            game.rtime_last_played = from_ts(int(last_played))
        # 缺元数据 / 主题色时补全（首次同步，Store API 带退避）。
        # 判据**不看 name_zh**：大量游戏根本没有中文名（实测 210 款里 154 款如此），
        # 拿它当「没补过」的信号，会让这些游戏每轮都重打一次 Store API、永远补不完。
        if enrich and (game.cover is None or game.theme_color is None):
            try:
                enrich_game_metadata(db, user_id, appid, steam)
            except SteamError as exc:
                # 元数据是渲染增强，不是数据骨架：一款拿不到不该中断整轮采集。
                # 实测一次 429 打穿重试就让整轮同步抛异常退出，前面的进度全靠分批提交才留住。
                logger.warning("appid %s 元数据补全失败（跳过，下轮再补）: %s", appid, exc)
        count += 1

        if count % OWNED_BATCH == 0:
            db.commit()
            yield {
                "step": "owned_games", "status": "running",
                "processed": count, "total": total,
            }

    db.commit()
    yield {"step": "owned_games", "status": "done", "games": count, "total": total}


def sync_owned_games(
    db: Session, user_id: str, apikey: str, steam: SteamClient, *, enrich: bool = False
) -> int:
    """``iter_sync_owned_games`` 的同步封装（不需要进度的调用方用它）。"""
    count = 0
    for event in iter_sync_owned_games(db, user_id, apikey, steam, enrich=enrich):
        if event.get("status") == "done":
            count = event.get("games", 0)
    return count


# 首次同步的语义别名（缺口 F 的原始命名，保留以免外部引用断裂）。
def backfill_owned_games(db: Session, user_id: str, apikey: str, steam: SteamClient) -> int:
    """首次同步：一次性 ``GetOwnedGames`` 回填并补全元数据。"""
    return sync_owned_games(db, user_id, apikey, steam, enrich=True)


def _achievement_queue(db: Session, user_id: str, limit: int) -> list[int]:
    """挑出本轮要回填成就的游戏（增量 + 分批）。

    排队规则（按优先级）：
    1. ``achievements_at IS NULL`` —— 从未回填过，先补「过去」；
    2. ``achievements_at < last_active_at`` —— 回填后又玩过，重拉以捕获新解锁。

    两者都不满足的游戏本轮跳过：无成就的游戏也带 ``achievements_at``，
    不会像旧版那样每轮重试一遍（旧版按「achievements 表有无记录」判断，无成就游戏永远命中）。
    """
    stale = Game.achievements_at.is_(None) | (
        Game.last_active_at.is_not(None) & (Game.achievements_at < Game.last_active_at)
    )
    rows = db.execute(
        select(Game.id)
        .where(
            Game.user_id == user_id,
            Game.status.in_(["owned", "played"]),
            stale,
        )
        # NULL 优先（从未回填），其余按最久未回填排；同序时用 id 保证轮转推进
        .order_by(Game.achievements_at.is_(None).desc(), Game.achievements_at, Game.id)
        .limit(limit)
    ).all()
    return [gid for (gid,) in rows]


def backfill_achievements(
    db: Session,
    user_id: str,
    apikey: str,
    steam: SteamClient,
    *,
    batch_size: int | None = None,
) -> tuple[int, int]:
    """成就回填：解锁历史 + 展示三件套（幂等、增量、分批）。

    - **增量**：只处理「从未回填」或「回填后又玩过」的游戏（见 :func:`_achievement_queue`）；
    - **分批**：单轮上限 ``batch_size``（默认 ``GC_ACHIEVEMENT_BATCH_SIZE``），
      避免首次同步在一次请求里打上千次上游接口；剩余的下一轮继续，靠
      ``games.achievements_at`` 自然推进，无需额外游标。

    返回 ``(本轮处理的游戏数, 新增解锁数)``。
    """
    limit = batch_size if batch_size is not None else settings.achievement_batch_size
    game_ids = _achievement_queue(db, user_id, limit)
    games_touched = 0
    unlocks = 0
    now = utcnow()
    for game_id in game_ids:
        game = db.get(Game, game_id)
        if game is None:
            continue
        try:
            rows = steam.get_player_achievements(apikey, user_id, game.appid)
        except SteamError as exc:
            # 单款失败不拖垮整批：盖上时间戳跳过，下轮按增量判据自然重来。
            # （「无成就 / 资料非公开」已在 SteamClient 内按空处理，走不到这里。）
            logger.warning("appid %s 成就拉取失败（跳过）: %s", game.appid, exc)
            game.achievements_at = now
            games_touched += 1
            continue

        # 三件套：schema（名称/图标/总数）+ 全球解锁率；单源失败不阻塞 unlocktime 入库
        # schema 与全球解锁率**与用户无关**，走缓存层：这两项占一轮同步 65% 的请求量
        schema: dict[str, dict] = {}
        pcts: dict[str, float] = {}
        try:
            schema = steam_cache.get_schema_for_game(db, steam, apikey, game.appid)
        except SteamError as exc:
            logger.warning("appid %s schema 拉取失败（降级）: %s", game.appid, exc)
        try:
            pcts = steam_cache.get_global_achievement_percentages(db, steam, game.appid)
        except SteamError as exc:
            logger.warning("appid %s 全球解锁率拉取失败（降级）: %s", game.appid, exc)

        # ach_total 优先取 schema 的成就总数；schema 拿不到时退回本次返回的成就条数
        total = len(schema) or len(rows)
        if total:
            game.ach_total = total

        for a in rows:
            if a.get("achieved") and int(a.get("unlocktime", 0)) > 0:
                apiname = a.get("apiname", "")
                meta = schema.get(apiname, {})
                if upsert_achievement(
                    db,
                    user_id,
                    game_id,
                    apiname,
                    from_ts(int(a["unlocktime"])),
                    display_name=meta.get("display_name"),
                    icon_url=meta.get("icon"),
                    global_percent=pcts.get(apiname),
                    percent_at=now,
                ):
                    unlocks += 1
        # 标记本轮已回填——无成就的游戏同样标记，下一轮不再重试（除非之后又玩过）
        game.achievements_at = now
        games_touched += 1
    return games_touched, unlocks


def derive_play_days_from_achievements(db: Session, user_id: str) -> int:
    """成就解锁日 → 运行日（**第二路来源**）。返回新增的运行日数。

    **为什么必须有这一步。** ``first_play``（轴上的封面）取的是 ``min(play_days.date)``，
    而在这一步之前 ``play_days`` 只有两个来源：``GetRecentlyPlayedGames``（Steam 只给
    **最近两周**）和截图的拍摄日。于是「轴上有封面的游戏」恰好等于「截过图的游戏」——
    实测本库两个集合各 69 款、**一款不差**，而启动过的游戏有 258 款。

    更麻烦的是它不只是缺，还会**错**：有截图的游戏取的是最早那张**截图**，不是最早那次
    **游玩**。实测 36 款游戏的 ``first_play`` 晚于它自己最早的成就解锁，赛博朋克 2077
    差了 1977 天（轴上说 2026-05 首玩，成就证明 2020-12 就在玩）。

    成就解锁时间戳是**已经在库里、精度到秒、能追溯到任意远**的证据：解锁成就当然意味着
    那天启动过这款游戏，与「那天截了图」是同一种硬证据。这个口径在本项目里本来就成立——
    ``lifecycle`` 算 ``last_active_at`` 用的正是「运行日 / 成就解锁 / 截图」三路取 max，
    只是 ``first_play`` 那条路只认 ``play_days`` 一张表，而成就从没写进去。

    **做成独立的一遍全量派生，而不是塞进 backfill_achievements 的写入循环**：后者只经手
    当轮批次里的游戏（``achievements_at`` 增量队列），已经回填过的历史成就永远不会再被路过，
    存量的几千条就补不上了。这里每轮扫一遍全量、只补缺的，幂等且自愈——不需要一次性脚本。
    """
    have: set[tuple[int, date]] = set(
        db.execute(
            select(PlayDay.game_id, PlayDay.date).where(PlayDay.user_id == user_id)
        ).all()
    )
    rows = db.execute(
        select(Achievement.game_id, Achievement.unlocktime).where(
            Achievement.user_id == user_id, Achievement.unlocktime.is_not(None)
        )
    ).all()
    added = 0
    for game_id, unlocktime in rows:
        day = utc_date(unlocktime)
        key = (game_id, day)
        # 本地集合去重就够了，不走 upsert_play_day：那个函数每条都要 select + flush 一次，
        # 而这里是几千条的全量扫描（同一天解锁十几个成就是常态），逐条查库会把这一步拖成分钟级。
        if key in have:
            continue
        have.add(key)
        db.add(PlayDay(user_id=user_id, game_id=game_id, date=day))
        added += 1
    return added


def sync_screenshots(
    db: Session, user_id: str, apikey: str, steam: SteamClient
) -> tuple[int, int]:
    """拉取截图元数据（第三路运行日来源），按日聚簇派生 play_day。

    走官方 ``IPublishedFileService/GetUserFiles``：一页 100 条，几次请求就能取完全部。
    原先爬社区页逐游戏拉，实测 256 次请求 / 156 秒、收获恒为 0——那条路的 ``xml=1``
    已被 Steam 移除，且拿不到截取时间。

    返回 ``(截图入库数, 派生运行日数)``。失败不阻塞整体同步（优雅降级）。
    """
    shots_added = 0
    days_added = 0
    for page in range(1, settings.screenshot_max_pages + 1):
        try:
            shots = steam.get_user_screenshots(apikey, user_id, page=page)
        except SteamError as exc:
            logger.warning("用户 %s 第 %s 页截图拉取失败（跳过，不阻塞）: %s", user_id, page, exc)
            break
        if not shots:
            break

        for shot in shots:
            game = get_or_create_game(db, user_id, shot["appid"])
            if upsert_screenshot(db, user_id, game.id, shot):
                shots_added += 1
            # 截图是「那天确实启动过这款游戏」的硬证据，据此补运行日
            if upsert_play_day(db, user_id, game.id, utc_date(shot["taken_at"])):
                days_added += 1
        db.commit()

        if len(shots) < 100:  # 不足一页即到尾页
            break
    return shots_added, days_added


def load_session(user: User) -> dict[str, str] | None:
    """解密用户的 Steam web 会话；无会话 / 解密失败返回 None。"""
    if not user.session_cookie_enc:
        return None
    try:
        session = json.loads(decrypt_secret(user.session_cookie_enc))
        if session.get("sessionid") and session.get("steamLoginSecure"):
            return session
    except (InvalidToken, ValueError, TypeError):
        pass
    return None


def sync_wishlist(
    db: Session,
    user_id: str,
    steam: SteamClient,
    sessionid: str | None = None,
    steam_login_secure: str | None = None,
) -> int:
    """拉愿望单 → 复用 ingest_wishlist（补元数据 + 归档已发售）。

    **cookie 是可选的**：官方 ``IWishlistService/GetWishlist`` 免 Key 免登录就能读公开
    愿望单（05§7 / 03§2a 的定案），只有愿望单设为私密时才需要回落到 web session 版。
    所以这一步**不该被 Layer 2 会话的有无卡住**——只走 OpenID 登录（Layer 1）的用户
    照样有愿望单，卡住的结果是「愿望单永远是空的」。
    """
    items = steam.get_wishlist(user_id, sessionid, steam_login_secure)
    return ingest_wishlist(
        db, user_id,
        [{"appid": i["appid"], "priority": i.get("priority", 0)} for i in items],
        steam,
    )


def sync_purchase_history(
    db: Session, user_id: str, steam: SteamClient, sessionid: str, steam_login_secure: str
) -> int:
    """用 web session cookie 拉购买历史页 → appid 映射 → 落 purchases（日粒度）。

    subid（DLC / 捆绑包）需 PICS 展开，V0.1 跳过（见 03 §4.1 回退链第 2 档）。
    """
    added = 0
    for page in range(1, settings.purchase_history_max_pages + 1):
        try:
            html = steam.get_purchase_history(sessionid, steam_login_secure, page)
        except SteamError as exc:
            logger.warning("购买历史第 %s 页拉取失败（跳过）: %s", page, exc)
            break
        rows = parse_purchase_history(html)
        if not rows:
            break
        for row in rows:
            d = row["date"]
            payment = row["payment_method"]
            ts = datetime.combine(d, time.min)  # 日粒度
            for item in row["items"]:
                appid = item.get("appid")
                if appid is None:
                    continue  # subid，跳过（待 PICS）
                game = get_or_create_game(db, user_id, appid)
                if game.status in ("wishlist", "released_wishlist"):
                    game.status = "owned"
                if upsert_purchase(db, user_id, game.id, ts, payment):
                    added += 1
    return added


def _is_cjk(name: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in name)


def _cover_portrait_url(appid: int) -> str:
    """竖版 2:3 封面（库容量 Library capsule 600×900，03 §4.6）。"""
    return f"{settings.steam_cdn_base}/{appid}/library_600x900.jpg"


def _resolve_cover_portrait(game: Game, appid: int, steam: SteamClient) -> str | None:
    """竖版封面地址——**存之前先确认它真的存在**。

    这个地址是按 appid 拼出来的模板，但**并不是每个 app 都上传过 library capsule**：本库
    348 款里 32 款（9.6%）返回 404。而 CSS ``background-image`` 加载失败是**静默**的，
    前端只会露出底下那层主题色渐变——看上去就是「这些游戏没有封面」，其实它们的横版
    ``header_image`` 全都good（实测 334/334 全部 200）。所以不能把没验证过的地址当结论存下去。

    已经存着模板地址 = 上次验过是好的，不再重复 HEAD；存着 None 才重验一次——万一 Steam
    后来补了这张图，下次同步就能自己长回来。
    """
    url = _cover_portrait_url(appid)
    if game.cover_portrait == url:
        return url
    return url if steam.asset_exists(url) else None


def _apply_theme_color(db: Session, game: Game, steam: SteamClient, cover_url: str) -> None:
    """下载封面字节 → compute_theme_color（本地取色 / 回退）→ 规范化后入库（03 §6）。

    取色能力不可用（Pillow 缺失）时**不下载封面**：下了也只能丢，而这一下就是 1~2 秒 ×
    全库游戏数。直接落回退色，并如实记 source=fallback。
    """
    # 只有真正取到的色才算「已完成」：fallback 是「这次没取成」，不该把它当结论钉死。
    # 否则一次 Pillow 缺失就会让全库永久停在同一个紫色，装上依赖也不会自愈。
    if game.theme_color and game.theme_color_source in ("local", "api"):
        return
    if not color_extraction_available():
        game.theme_color = ACHIEVE_FALLBACK
        game.theme_color_source = "fallback"
        game.theme_color_at = utcnow()
        return
    cover_bytes = steam.download_bytes(cover_url)
    source, color = compute_theme_color(cover_bytes)
    game.theme_color = color
    game.theme_color_source = source
    game.theme_color_at = utcnow()


def enrich_game_metadata(db: Session, user_id: str, appid: int, steam: SteamClient) -> Game | None:
    """Store API appdetails 补全名称（中/英）/ 封面（横+竖）/ 发售日 / 开发商 + 主题色。"""
    data = steam_cache.get_app_details(db, steam, appid, language="schinese")
    if not data:
        return None

    game = get_or_create_game(db, user_id, appid)

    name = data.get("name") or ""
    is_cjk = _is_cjk(name)
    name_zh = name if is_cjk else None
    name_en = None if is_cjk else (name or None)
    # 英文名再打一次 Store API —— **仅当本地还没有**。
    # owned 路径下 GetOwnedGames 已经给了英文名（sync_owned_games 存进 name_en），
    # 无条件再拉一次等于白打，占首轮 Store 调用的约 40%。
    # 愿望单路径没有这个兜底，那里仍会走到这一支。
    if is_cjk and not game.name_en:
        en = steam_cache.get_app_details(db, steam, appid, language="english")
        name_en = (en or {}).get("name") or name_en

    release = data.get("release_date") or {}
    release_date = None
    raw_date = release.get("date")
    if raw_date and not release.get("coming_soon", False):
        release_date = _parse_store_date(raw_date)

    cover = data.get("header_image")
    # 权威元数据直接覆盖（解决「元数据永不刷新」：改期 / 改名 / 换封面都会更新）
    game.name_zh = name_zh or game.name_zh
    game.name_en = name_en or game.name_en
    game.cover = cover or game.cover
    game.cover_portrait = _resolve_cover_portrait(game, appid, steam)
    game.developer = (data.get("developers") or [None])[0] or game.developer
    game.release_date = release_date or game.release_date
    if cover:
        _apply_theme_color(db, game, steam, cover)
    return game


def _parse_store_date(raw: str) -> date | None:
    """解析 Store API 发售日字符串（如 "25 Feb, 2022"）。失败返回 None。"""
    from datetime import datetime as _dt

    for fmt in ("%d %b, %Y", "%d %B, %Y", "%b %Y", "%B %Y", "%Y"):
        try:
            return _dt.strptime(raw.strip(), fmt).date()
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------
# 入库（客户端提交）
# --------------------------------------------------------------------------

def ingest_wishlist(db: Session, user_id: str, items: list[dict], steam: SteamClient) -> int:
    """愿望单入库：upsert 游戏 + 补元数据，已发售的置 released_wishlist（归档）。"""
    count = 0
    for item in items:
        appid = int(item["appid"])
        game = get_or_create_game(
            db, user_id, appid, status="wishlist", wishlist_priority=item.get("priority")
        )
        enriched = enrich_game_metadata(db, user_id, appid, steam)
        if enriched is None:
            enriched = game
        # 已发售 → 归档，不进日历主显示区
        if enriched.release_date and enriched.release_date <= utcnow().date():
            enriched.status = "released_wishlist"
        count += 1
    return count


def ingest_purchases(db: Session, user_id: str, purchases: list[dict]) -> int:
    """购买入库（客户端 license list 提交）：首次入库游戏置 owned。"""
    count = 0
    for p in purchases:
        appid = int(p["appid"])
        game = get_or_create_game(db, user_id, appid)
        if game.status in ("wishlist", "released_wishlist"):
            game.status = "owned"
        time_created = p.get("time_created")
        if time_created:
            ts = time_created if hasattr(time_created, "date") else from_ts(time_created)
            if upsert_purchase(db, user_id, game.id, ts, p.get("payment_method")):
                count += 1
    return count


# --------------------------------------------------------------------------
# 单用户完整同步（手动 / 调度共用）
# --------------------------------------------------------------------------

def iter_user_sync(user_id: str, apikey: str) -> Generator[dict[str, Any], None, None]:
    """对单个用户执行一轮同步，逐事件产出进度（供 SSE 与调度器共用）。

    自行打开 / 关闭会话；失败时回滚并向外抛出，由调用方决定如何呈现 / 重试。
    """
    db = SessionLocal()
    steam = get_steam_client()
    try:
        state = get_state(db, user_id)
        state.status = "syncing"
        db.commit()
        yield {"step": "sync", "status": "running"}

        # 加载 Steam web 会话（可选；无会话则跳过登录态数据源）
        user = db.get(User, user_id)
        session = load_session(user) if user else None

        # GetOwnedGames：顺带补元数据（缺口 F，覆盖「过去」的成就回填范围）；
        # 每轮都要跑——playtime_forever / rtime_last_played 是封盘判定的输入。
        #
        # enrich **每轮都开**，不再只在首轮。原先是 `enrich=first_run`，可 enrich 里那句
        # 「跳过，下轮再补」的日志是句空话：根本没有下一轮。实测本库 14 款游戏就这样永久停在
        # 「没名字、没封面、没主题色」——首轮撞上一次 429 或临时故障，此后再没有第二次机会。
        # 每轮开着不贵：判据是「缺元数据才补」，334 款齐全的游戏一个请求都不会打；剩下真的
        # 拿不到的（PTS / Beta / 已停运，商店页本就不存在）由 steam_cache 把 None 也缓存下来
        # （7 天 TTL），所以它们平均每 7 天才重试一次，而不是每轮。
        first_run = state.owned_games_at is None
        owned_count = 0
        # 逐批转发进度：首次同步这一步要跑几十分钟，是整轮里唯一会让人以为「卡死」的地方
        for event in iter_sync_owned_games(db, user_id, apikey, steam, enrich=True):
            heartbeat_sync(user_id)  # 证明这一轮还活着，避免被当成陈旧锁抢占
            if event.get("status") == "done":
                owned_count = event.get("games", 0)
                break
            yield {**event, "first_run": first_run}
        state.owned_games_at = utcnow()
        db.commit()
        yield {"step": "owned_games", "status": "done", "games": owned_count, "first_run": first_run}

        # 愿望单：官方接口免 Key 免登录（05§7），**不依赖 Layer 2 会话**；
        # 只有愿望单设为私密时才用得上 cookie，有就带上、没有也照跑。
        wishlist_count = 0
        try:
            wishlist_count = sync_wishlist(
                db, user_id, steam,
                session["sessionid"] if session else None,
                session["steamLoginSecure"] if session else None,
            )
            db.commit()
        except SteamError as exc:
            logger.warning("愿望单拉取失败，降级: %s", exc)
        yield {"step": "wishlist", "status": "done", "games": wishlist_count}

        # 购买历史：**只有** web session cookie（Layer 2 opt-in）能拿到，没有公开路径
        # （03§2a / PRD §3）。没会话时明确产出 skipped 让前端能解释「为什么没有购买记录」，
        # 而不是让这一类数据静默缺席。
        purchases_count = 0
        if session:
            try:
                purchases_count = sync_purchase_history(
                    db, user_id, steam, session["sessionid"], session["steamLoginSecure"]
                )
                db.commit()
            except SteamError as exc:
                logger.warning("购买历史（cookie）拉取失败，降级: %s", exc)
            yield {"step": "purchase_history", "status": "done", "purchases": purchases_count}
        else:
            yield {
                "step": "purchase_history", "status": "skipped", "purchases": 0,
                "reason": "需要 Steam 网页会话（Layer 2），当前仅 OpenID 登录",
            }

        played = sync_recently_played(db, user_id, apikey, steam)
        db.commit()
        yield {"step": "recently_played", "status": "done", "games_played": played}

        # 先算一次生命状态：成就回填的增量判据（achievements_at < last_active_at）要读它。
        # 幂等纯本地查询，收尾还会再算一次把本轮新成就 / 截图纳入。
        recompute_user_lifecycle(db, user_id)
        db.commit()

        games_touched, unlocks = backfill_achievements(db, user_id, apikey, steam)
        # 成就解锁日补运行日：必须在回填之后、且是**全量**派生（见函数注释）。
        # 纯本地计算，不打上游，所以放在同一步里报，不单开一个步骤。
        ach_days = derive_play_days_from_achievements(db, user_id)
        db.commit()
        yield {
            "step": "achievements",
            "status": "done",
            "games": games_touched,
            "unlocks": unlocks,
            "play_days": ach_days,
            # 队列没排空说明还有游戏待回填，下一轮继续（分批）
            "batch_full": games_touched >= settings.achievement_batch_size,
        }

        shots_added, shot_days = sync_screenshots(db, user_id, apikey, steam)
        db.commit()
        yield {
            "step": "screenshots",
            "status": "done",
            "screenshots": shots_added,
            "play_days": shot_days,
        }

        # 采集收尾重算生命状态（§5）：判定必须读库即得，/timeline 不在请求期算。
        now = utcnow()
        changed = recompute_user_lifecycle(db, user_id, now=now)
        state.recently_played_at = now
        state.achievements_at = now
        state.screenshots_at = now
        state.lifecycle_at = now
        state.last_sync_at = now
        state.status = "idle"
        state.last_error = None
        db.commit()
        yield {"step": "lifecycle", "status": "done", "changed": changed}

        yield {
            "step": "done",
            "last_sync_at": now.isoformat(),
            "games_played": played,
            "achievement_unlocks": unlocks,
            "screenshots": shots_added,
            "wishlist": wishlist_count,
            "purchases": purchases_count,
            "lifecycle_changed": changed,
        }
    except Exception as exc:
        db.rollback()
        try:
            state = get_state(db, user_id)
            state.status = "error"
            state.last_error = str(exc)[:500]
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        raise
    finally:
        db.close()
        steam.close()  # 归还连接池：一轮同步共用一个 Client，结束即释放


def retry_with_backoff(fn: Callable[[], Any], *, max_attempts: int = 4, base_delay: float = 2.0):
    """任务级重试 + 指数退避（供调度器对单用户失败重试）。

    除 ``NoApiKey``（不可恢复）外一律重试——包括 ``SteamError``：SteamClient 内部退避
    已尽力，任务级再补一轮网络 / 上游抖动兜底（§5「失败重试 + 指数退避」）。
    """
    last: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except NoApiKey:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt >= max_attempts - 1:
                break
            _time.sleep(base_delay * (2**attempt))
    raise last  # type: ignore[misc]


# --------------------------------------------------------------------------
# 同步并发保护（单进程内存锁；连点 /sync 不会并行跑两轮）
# --------------------------------------------------------------------------

# user_id → 最近一次心跳的单调时钟读数。用 dict 而不是 set 是为了能判断「锁是否还活着」。
_sync_locks: dict[str, float] = {}
_sync_locks_guard = threading.Lock()

# 超过这么久没有心跳，视为持锁方已死（客户端断开后生成器卡在 yield、进程内异常路径漏掉
# release 等），允许下一次请求抢占。取 10 分钟：owned_games 阶段每 10 款产出一次事件，
# 正常间隔约 45s，即使某款游戏走满重试退避也远小于这个阈值。
SYNC_STALE_SECONDS = 600


def try_acquire_sync(user_id: str) -> bool:
    """获取同步锁；持锁方已失联（心跳陈旧）时允许抢占。

    没有抢占机制时，一次客户端断开就会让该用户**永久**拿不到锁——表现为此后每次点同步
    都是「同步正在进行中」，而实际上没有任何同步在推进，只能重启后端才能恢复。
    抢占是安全的：同步分批提交，重来一轮不会丢已入库的数据。
    """
    now = _time.monotonic()
    with _sync_locks_guard:
        last = _sync_locks.get(user_id)
        if last is not None and (now - last) < SYNC_STALE_SECONDS:
            return False
        if last is not None:
            logger.warning("抢占用户 %s 的陈旧同步锁（%.0fs 无心跳）", user_id, now - last)
        _sync_locks[user_id] = now
        return True


def heartbeat_sync(user_id: str) -> None:
    """续期同步锁。每产出一个进度事件调用一次，证明这一轮还活着。"""
    with _sync_locks_guard:
        if user_id in _sync_locks:
            _sync_locks[user_id] = _time.monotonic()


def release_sync(user_id: str) -> None:
    with _sync_locks_guard:
        _sync_locks.pop(user_id, None)


__all__ = [
    "NoApiKey",
    "get_or_create_game",
    "upsert_play_day",
    "upsert_achievement",
    "upsert_purchase",
    "get_state",
    "sync_recently_played",
    "sync_owned_games",
    "iter_sync_owned_games",
    "backfill_owned_games",
    "backfill_achievements",
    "derive_play_days_from_achievements",
    "sync_screenshots",
    "sync_wishlist",
    "sync_purchase_history",
    "load_session",
    "enrich_game_metadata",
    "ingest_wishlist",
    "ingest_purchases",
    "iter_user_sync",
    "retry_with_backoff",
    "try_acquire_sync",
    "heartbeat_sync",
    "release_sync",
]
