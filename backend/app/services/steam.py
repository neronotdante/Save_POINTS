"""Steam 上游客户端：封装 Web API / Store API，带重试与指数退避。

只负责「请求与解析」，不直接落库；落库编排见 ``sync_service``。
"""
from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime, timezone
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class SteamError(RuntimeError):
    """Steam 上游调用失败（网络 / 限流 / 解析失败）。"""


class SteamNotRetryable(SteamError):
    """4xx（429 除外）：请求本身有问题或上游明确说「没有」，重试多少次都是同一个答案。"""


class RateLimited(SteamError):
    """HTTP 429。单独成型，好让退避区分「限流」与「网络抖动」——两者该等的量级差一个数量级。"""

    def __init__(self, retry_after: float | None = None) -> None:
        super().__init__("HTTP 429")
        self.retry_after = retry_after


# 429 的退避阶梯（秒）。Store API 的配额桶按分钟级恢复，秒级重试只是白白耗掉重试次数。
_RATE_LIMIT_BACKOFF = (30.0, 60.0, 120.0)


def _retry_after(resp) -> float | None:
    """解析 ``Retry-After``（Steam 通常不给，给了就听它的）。"""
    raw = resp.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return None


class SteamClient:
    """同步 httpx 客户端（在线程池内运行，不阻塞事件循环）。

    **持有一个 ``httpx.Client`` 全程复用**：原先每个请求都 ``with httpx.Client(...)``
    新建一次，等于每次重做 TCP + TLS 握手——实测中位 1890ms，复用后 344ms，
    每次请求白花 ~1.55 秒。首轮同步上千次调用，这一项就占几十分钟。

    生命周期：一轮同步共用一个实例（``iter_user_sync`` 里建一次），结束时 :meth:`close`。
    也支持 ``with SteamClient() as steam:``。
    """

    def __init__(self) -> None:
        self._api_base = settings.steam_api_base.rstrip("/")
        self._store_base = settings.steam_store_base.rstrip("/")
        self._community_base = settings.steam_community_base.rstrip("/")
        self._timeout = settings.steam_request_timeout
        self._max_retries = settings.steam_max_retries
        self._client = httpx.Client(timeout=self._timeout, follow_redirects=True)
        # 自适应节流：Store API 是「配额桶」而非固定间隔——实测可先爆发 ~350 次，
        # 桶空后持续 429。所以不预设固定间隔（那会白白拖慢前期），
        # 改为撞 429 才降速，连续成功再逐步恢复。
        self._min_interval = 0.0
        self._last_request_at = 0.0
        self._ok_streak = 0

    def _throttle(self) -> None:
        """按当前节流间隔等待（间隔为 0 时不等）。"""
        if self._min_interval <= 0:
            return
        wait = self._last_request_at + self._min_interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)

    def _note_rate_limited(self) -> None:
        """撞 429：把最小间隔翻倍（0 → 1s 起步），上限 8s。"""
        self._min_interval = min(max(self._min_interval * 2, 1.0), 8.0)
        self._ok_streak = 0
        logger.warning("Steam 限流，节流间隔提到 %.1fs", self._min_interval)

    def _note_ok(self) -> None:
        """连续 50 次成功后把间隔减半，直到回到不节流。"""
        if self._min_interval <= 0:
            return
        self._ok_streak += 1
        if self._ok_streak >= 50:
            self._min_interval = 0.0 if self._min_interval <= 1.0 else self._min_interval / 2
            self._ok_streak = 0
            logger.info("Steam 恢复，节流间隔降到 %.1fs", self._min_interval)

    def close(self) -> None:
        """关闭底层连接池。重复调用安全。"""
        self._client.close()

    def __enter__(self) -> "SteamClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ 底层
    def _cookie_dict(self, sessionid: str, steam_login_secure: str) -> dict[str, str]:
        """由会话 cookie 对构造 httpx cookies（登录态接口用）。"""
        return {"sessionid": sessionid, "steamLoginSecure": steam_login_secure}

    def _get(self, url: str, params, cookies):
        """发一次 GET 并**清掉响应写回的 cookie**。

        复用 Client 会把 Steam 的 ``Set-Cookie``（browserid / 匿名 sessionid 等）攒进
        jar，之后带登录态的请求就可能被这些残留污染。每次请求后清空，保持与「每请求新建
        Client」完全一致的无状态语义——这次改动只提速，不改行为。
        """
        self._throttle()
        try:
            return self._client.get(url, params=params, cookies=cookies)
        finally:
            self._last_request_at = time.monotonic()
            self._client.cookies.clear()

    def _get_json(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        cookies: dict[str, str] | None = None,
        retries: int | None = None,
    ) -> dict[str, Any]:
        """GET JSON，带指数退避重试（429 / 5xx / 网络错误）。"""
        attempts = self._max_retries if retries is None else retries
        last_exc: Exception | None = None
        for attempt in range(attempts):
            try:
                resp = self._get(url, params, cookies)
                if resp.status_code == 429:
                    self._note_rate_limited()
                    raise RateLimited(_retry_after(resp))
                if resp.status_code >= 500:
                    raise SteamError(f"HTTP {resp.status_code}")
                if resp.status_code >= 400:
                    raise SteamNotRetryable(f"HTTP {resp.status_code}: {resp.text[:200]}")
                self._note_ok()
                return resp.json()
            except (httpx.HTTPError, SteamError, ValueError) as exc:  # noqa: PERF203
                last_exc = exc
                if isinstance(exc, SteamNotRetryable):
                    break  # 4xx：重试无意义，直接把答案交出去
                if attempt >= attempts - 1:
                    break
                # 限流要等的量级和普通抖动完全不同：1s/2s/4s 对配额桶是杯水车薪，
                # 实测三次全落空后整轮同步就崩了。429 单独走分钟级退避。
                if isinstance(exc, RateLimited):
                    delay = exc.retry_after or _RATE_LIMIT_BACKOFF[
                        min(attempt, len(_RATE_LIMIT_BACKOFF) - 1)
                    ]
                else:
                    delay = 2**attempt  # 1s, 2s, 4s, ...
                logger.warning("Steam 上游 %s 失败（%s），%ss 后重试", url, exc, delay)
                time.sleep(delay)
        raise self._final_error(url, last_exc)

    @staticmethod
    def _final_error(url: str, last_exc: Exception | None) -> SteamError:
        """把重试耗尽后的异常包成最终异常，**保留原类型**。

        否则 ``SteamNotRetryable`` 会在这里被降级成普通 ``SteamError``，
        上层「无成就就当空处理」的判断就永远命中不了（实测 19 款游戏全走了错误分支）。
        """
        msg = f"Steam 上游调用最终失败: {url} -> {last_exc}"
        if isinstance(last_exc, SteamNotRetryable):
            return SteamNotRetryable(msg)
        if isinstance(last_exc, RateLimited):
            return RateLimited()
        return SteamError(msg)

    # ------------------------------------------------------------------ 认证
    def get_token_details(self, access_token: str) -> str:
        """用 OAuth access_token 校验登录并取 SteamID64（无需 API Key）。"""
        url = f"{self._api_base}/ISteamUserOAuth/GetTokenDetails/v1/"
        data = self._get_json(url, params={"access_token": access_token})
        steamid = (data.get("response") or {}).get("params", {}).get("steamid")
        if not steamid:
            raise SteamError("GetTokenDetails 未返回 steamid")
        return str(steamid)

    def get_player_summaries(self, apikey: str, steamid: str) -> dict[str, Any]:
        """取昵称 / 头像，用于登录后补充用户资料。"""
        url = f"{self._api_base}/ISteamUser/GetPlayerSummaries/v2/"
        data = self._get_json(url, params={"key": apikey, "steamids": steamid})
        players = (data.get("response") or {}).get("players") or []
        return players[0] if players else {}

    # ------------------------------------------------------------------ 数据源
    def get_recently_played(self, apikey: str, steamid: str, count: int = 200) -> list[dict[str, Any]]:
        """每日轮询来源：近期游玩（含 rtime_last_played），记运行日。"""
        url = f"{self._api_base}/IPlayerService/GetRecentlyPlayedGames/v1/"
        data = self._get_json(url, params={"key": apikey, "steamid": steamid, "count": count})
        return (data.get("response") or {}).get("games") or []

    def get_player_achievements(self, apikey: str, steamid: str, appid: int) -> list[dict[str, Any]]:
        """历史回填来源：某游戏全部成就及 unlocktime。

        **没有成就系统的游戏会返回 400 ``Requested app has no stats``**——那是上游在如实回答
        「这游戏没成就」，不是故障。库里这类游戏很多，当成异常会直接打断整轮采集，
        所以这里吃掉它、返回空列表。资料非公开（``Profile is not public``）同理。
        """
        url = f"{self._api_base}/ISteamUserStats/GetPlayerAchievements/v1/"
        try:
            data = self._get_json(
                url, params={"key": apikey, "steamid": steamid, "appid": appid, "l": "schinese"}
            )
        except SteamNotRetryable as exc:
            if any(k in str(exc) for k in ("has no stats", "not public", '"success":false')):
                logger.debug("appid %s 无成就 / 资料非公开，按空处理", appid)
                return []
            raise
        return (data.get("playerstats") or {}).get("achievements") or []

    def get_owned_games(self, apikey: str, steamid: str) -> list[dict[str, Any]]:
        """游戏库全量来源（一次性回填，非每日差分）：GetOwnedGames。"""
        url = f"{self._api_base}/IPlayerService/GetOwnedGames/v1/"
        data = self._get_json(
            url,
            params={
                "key": apikey,
                "steamid": steamid,
                "include_appinfo": "1",
                "include_played_free_games": "1",
                "format": "json",
            },
        )
        return (data.get("response") or {}).get("games") or []

    def get_schema_for_game(self, apikey: str, appid: int) -> dict[str, dict[str, Any]]:
        """成就 schema（名称 / 图标），按 apiname 建索引（03 §4.3a）。"""
        url = f"{self._api_base}/ISteamUserStats/GetSchemaForGame/v2/"
        data = self._get_json(url, params={"key": apikey, "appid": appid, "l": "schinese"})
        achievements = (
            (data.get("game") or {}).get("availableGameStats") or {}
        ).get("achievements") or []
        out: dict[str, dict[str, Any]] = {}
        for a in achievements:
            name = a.get("name")
            if name:
                out[name] = {
                    "display_name": a.get("displayName") or a.get("name"),
                    "icon": a.get("icon"),
                    "description": a.get("description"),
                }
        return out

    def get_global_achievement_percentages(self, appid: int) -> dict[str, float]:
        """全球解锁率（无需 Key），按 apiname 建索引（03 §4.3a）。"""
        url = f"{self._api_base}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/"
        data = self._get_json(url, params={"gameid": appid})
        achievements = (
            (data.get("achievementpercentages") or {}).get("achievements") or []
        )
        return {a.get("name"): float(a["percent"]) for a in achievements if a.get("name") is not None}

    # ------------------------------------------------------------------ 元数据
    #: appdetails 的区域回退顺序。见 :meth:`get_app_details`。
    STORE_CC_CHAIN = ("cn", "us")

    def get_app_details(self, appid: int, language: str = "schinese") -> dict[str, Any] | None:
        """Store API appdetails：名称 / 发售日 / 封面 / 开发商（公开，无需 Key）。

        ``language`` 控制名称语言（``schinese`` / ``english``）。

        **``cc`` 要回退**。appdetails 的可见性是分区域的：一款在中国区下架 / 不发行的游戏，
        ``cc=cn`` 会返回 ``success:false``，看上去和「这个 app 根本不存在」一模一样。可它在
        库里、在玩、有成就记录——只是商店页在这个区不给看。实测本库 14 款拿不到元数据的游戏里
        有 5 款属于这一类（MGSV 两作、CoD MW2 2009、Ori 决定版、THE FINALS），换 ``cc=us``
        全部拿得到，其中 MGSV: TPP 还是这个库里玩得最久的几款之一（4811 分钟）。

        回退**只在拿不到时发生**：绝大多数游戏第一次就成，不会多打一次请求。价格字段本项目
        不用，所以换区拿到的名称 / 封面 / 发售日与 cn 区没有差别。
        """
        url = f"{self._store_base}/api/appdetails"
        for cc in self.STORE_CC_CHAIN:
            data = self._get_json(url, params={"appids": str(appid), "l": language, "cc": cc})
            node = data.get(str(appid)) or {}
            if node.get("success"):
                return node.get("data") or {}
        return None

    def asset_exists(self, url: str) -> bool:
        """CDN 静态资源是否真的存在（HEAD）。

        **不走 ``_throttle``**：节流是为 Steam Web API 的限流准备的，CDN 上的一张静态图片
        不受那套限制，一并排队只会把同步拖长。网络异常一律当「存在」返回，宁可留一个可能挂掉的
        地址，也不要因为一次超时就把好封面永久删掉。
        """
        try:
            resp = self._client.head(url, follow_redirects=True)
            return resp.status_code == 200
        except httpx.HTTPError:
            logger.warning("HEAD 失败，按存在处理: %s", url)
            return True
        finally:
            self._client.cookies.clear()

    def download_bytes(self, url: str) -> bytes | None:
        """下载图片 / 文件字节（封面取色用），失败返回 None（优雅降级）。"""
        try:
            resp = self._get(url, None, None)
            if resp.status_code == 200:
                return resp.content
        except httpx.HTTPError:
            logger.warning("下载失败: %s", url)
        return None

    def get_user_screenshots(
        self, apikey: str, steamid: str, page: int = 1, numperpage: int = 100
    ) -> list[dict[str, Any]]:
        """截图元数据：官方 ``IPublishedFileService/GetUserFiles``（``filetype=4``）。

        **取代原先爬社区页的做法**——社区截图页的 ``xml=1`` 参数已被 Steam 移除（现在返回
        HTML），旧解析器恒返回空，链路实际处于失效状态；而且那条路逐游戏拉，实测 256 次
        请求换来 0 条数据。官方接口一次能取 100 条，且直接给出 ``time_created``
        （截取时间，正是爬 HTML 拿不到的那个字段）。

        返回结构与旧实现保持一致，``sync_screenshots`` 不需要区分来源。
        """
        url = f"{self._api_base}/IPublishedFileService/GetUserFiles/v1/"
        data = self._get_json(
            url,
            params={
                "key": apikey,
                "steamid": steamid,
                "filetype": 4,  # 4 = 截图
                "numperpage": numperpage,
                "page": page,
            },
        )
        files = (data.get("response") or {}).get("publishedfiledetails") or []
        return [shot for shot in (_parse_published_file(f) for f in files) if shot]

    # ------------------------------------------------------------------ 登录态（web session cookie）
    def get_wishlist(
        self,
        steamid: str,
        sessionid: str | None = None,
        steam_login_secure: str | None = None,
    ) -> list[dict[str, Any]]:
        """愿望单：官方 ``IWishlistService/GetWishlist``（免 Key）；私密愿望单回落到 web session 版。

        返回 ``[{appid, priority, name}]``。官方接口不返回名称，``name`` 恒为 ``None``
        （元数据由 Store API 补）；回落版才有 ``name``。
        """
        # ① 官方接口（免 Key，公开愿望单直接查）——P0-3d
        url = f"{self._api_base}/IWishlistService/GetWishlist/v1/"
        try:
            data = self._get_json(url, params={"steamid": steamid})
            items = (data.get("response") or {}).get("items") or []
            if items:
                return [
                    {
                        "appid": int(it["appid"]),
                        "priority": int(it.get("priority", 0) or 0),
                        "name": None,
                    }
                    for it in items
                    if it.get("appid") is not None
                ]
        except SteamError:
            logger.warning("IWishlistService/GetWishlist 失败，回落 web session 版", exc_info=True)

        # ② 回落：store wishlistdata（私密愿望单，需 web session cookie）
        if sessionid and steam_login_secure:
            fallback_url = f"{self._store_base}/wishlist/profiles/{steamid}/wishlistdata/"
            data = self._get_json(
                fallback_url,
                params={"p": "0", "v": ""},
                cookies=self._cookie_dict(sessionid, steam_login_secure),
            )
            return parse_wishlist_data(data)
        return []

    def get_purchase_history(
        self, sessionid: str, steam_login_secure: str, page: int = 1
    ) -> str:
        """购买历史页（HTML，需 web session cookie），返回原始 HTML 文本。"""
        url = f"{self._store_base}/account/history/"
        return self._get_text(
            url, params={"l": "english", "p": str(page)},
            cookies=self._cookie_dict(sessionid, steam_login_secure),
        )

    def _get_text(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        cookies: dict[str, str] | None = None,
        retries: int | None = None,
    ) -> str:
        """GET 原始文本（截图 / 购买历史返回 HTML/XML），带指数退避。"""
        attempts = self._max_retries if retries is None else retries
        last_exc: Exception | None = None
        for attempt in range(attempts):
            try:
                resp = self._get(url, params, cookies)
                if resp.status_code == 429:
                    self._note_rate_limited()
                    raise RateLimited(_retry_after(resp))
                if resp.status_code >= 500:
                    raise SteamError(f"HTTP {resp.status_code}")
                if resp.status_code >= 400:
                    raise SteamNotRetryable(f"HTTP {resp.status_code}")
                self._note_ok()
                return resp.text
            except (httpx.HTTPError, SteamError) as exc:  # noqa: PERF203
                last_exc = exc
                if isinstance(exc, SteamNotRetryable):
                    break
                if attempt >= attempts - 1:
                    break
                if isinstance(exc, RateLimited):
                    delay = exc.retry_after or _RATE_LIMIT_BACKOFF[
                        min(attempt, len(_RATE_LIMIT_BACKOFF) - 1)
                    ]
                else:
                    delay = 2**attempt
                time.sleep(delay)
        raise self._final_error(url, last_exc)


def _parse_filename_ts(filename: str | None) -> datetime | None:
    """截图文件名 `YYYYMMDDHHMMSS_序号.jpg` → 截取时间（rtime_created 缺失时兜底）。"""
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})", filename or "")
    if not m:
        return None
    try:
        return datetime(*[int(x) for x in m.groups()])
    except ValueError:
        return None


def _first_text(node, *names: str) -> str | None:
    for name in names:
        child = node.find(name)
        if child is not None and child.text and child.text.strip():
            return child.text.strip()
    return None



# 截图卡片：<a ... data-appid="1285190" data-publishedfileid="3793493595">
_SHOT_CARD_RE = re.compile(
    r'data-appid="(?P<appid>\d+)"\s+data-publishedfileid="(?P<shot_id>\d+)"'
)
# 卡片紧随其后的缩略图：<div style="background-image: url('https://images.steamusercontent.com/ugc/…');"
_SHOT_THUMB_RE = re.compile(r"background-image:\s*url\('(?P<url>[^']+)'\)")
# 日期分组标题：<div class="image_grid_title"> Sun, Aug 30 2026 - Mon, Aug 31 2026 </div>
_GRID_TITLE_RE = re.compile(
    r'<div class="image_grid_title">(?P<title>.*?)</div>', re.S
)
_GRID_DATE_RE = re.compile(r'([A-Z][a-z]{2},\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})')


def _parse_grid_date(raw: str) -> datetime | None:
    """把 "Sun, Aug 30 2026"（分组标题里的第一个日期）解析成 UTC 日 0 点。"""
    try:
        return datetime.strptime(raw.strip(), "%a, %b %d %Y")
    except ValueError:
        return None


def parse_screenshots_html(text: str) -> list[dict[str, Any]]:
    """解析社区截图**页面 HTML** → 截图字典列表。

    为什么不是 XML：``?xml=1`` 这个老参数**已经失效**——带上它，Steam 返回的仍然是
    整页 HTML。旧的 ``parse_screenshots_xml`` 拿 HTML 去 ``ET.fromstring`` 必然
    ParseError → 返回空列表 → 「截图一张都同步不到」，而且因为失败被当成「该用户没有
    公开截图」而静默跳过，日志里看不出问题。

    时间精度：页面只在**日期分组标题**上给日期（可能是 "Aug 30 2026" 或
    "Aug 30 2026 - Aug 31 2026" 这样的跨日范围），单张截图没有精确时刻。取分组的
    **起始日 0 点**作 ``taken_at``——PRD §3 里截图的用途是「按日聚簇派生 PlayDay」、
    时间轴也只按日挂载（07§4.5），日粒度够用。要精确到秒得逐张打 filedetails 页，
    一张一个请求，不值得。
    """
    shots: list[dict[str, Any]] = []
    # 按分组标题切段，段内的卡片共享该组日期
    segments: list[tuple[datetime | None, str]] = []
    last_end = 0
    current_date: datetime | None = None
    for m in _GRID_TITLE_RE.finditer(text):
        segments.append((current_date, text[last_end : m.start()]))
        date_m = _GRID_DATE_RE.search(m.group("title"))
        current_date = _parse_grid_date(date_m.group(1)) if date_m else None
        last_end = m.end()
    segments.append((current_date, text[last_end:]))

    for taken_at, chunk in segments:
        for card in _SHOT_CARD_RE.finditer(chunk):
            # 缩略图 URL 紧跟在卡片 <a> 之后，取其后最近的一个 background-image
            tail = chunk[card.end() : card.end() + 400]
            thumb_m = _SHOT_THUMB_RE.search(tail)
            shot_id = card.group("shot_id")
            shots.append(
                {
                    "shot_id": shot_id,
                    "appid": int(card.group("appid")),
                    "taken_at": taken_at,
                    "thumbnail_url": thumb_m.group("url") if thumb_m else None,
                    # ⚠️ 这里曾经塞的是 filedetails 页面地址。`url` 是**图片**字段（前端拿它当
                    # background-image 加载），塞网页进去浏览器不报错、只画一片空白，
                    # 于是「点开截图看不到图」。社区页拿到的那个 UGC 路径本身不带 imw/imh
                    # 缩放参数，Steam 在该路径上给的就是原图——它既是缩略图也是大图。
                    # 详情页地址前端由 shot_id 现拼（lib/media.js::shotPageUrl），不必落库。
                    "url": thumb_m.group("url") if thumb_m else None,
                    "privacy": 0,  # 公开页面能看到的即公开；私密走 cookie 时同理不再细分
                    "caption": None,
                }
            )
    return shots


def _parse_published_file(node: dict[str, Any]) -> dict[str, Any] | None:
    """``GetUserFiles`` 的单条 → 截图字典。缺 appid / 时间的条目丢弃（对时间轴无意义）。"""
    shot_id = str(node.get("publishedfileid") or "").strip()
    appid = int(node.get("consumer_appid") or node.get("creator_appid") or 0)
    ts = int(node.get("time_created") or 0)
    if not shot_id or not appid or not ts:
        return None

    taken_at = datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)
    # filename 形如 `1285190/screenshots/20260831220711_1.jpg`，带本地拍摄时刻。
    # time_created 是上传时间，两者通常只差几秒；文件名时间更贴近「截图那一刻」，优先用它。
    from_name = _parse_filename_ts(str(node.get("filename") or "").rsplit("/", 1)[-1])
    if from_name is not None:
        taken_at = from_name

    return {
        "shot_id": shot_id,
        "appid": appid,
        "taken_at": taken_at,
        "thumbnail_url": node.get("preview_url") or None,
        "url": node.get("file_url") or node.get("url") or None,
        "privacy": 0,  # 官方接口不返回可见性；用自己的 Key 查自己，取到的即本人可见
        "caption": node.get("title") or None,
    }


def parse_wishlist_data(data: dict[str, Any]) -> list[dict[str, Any]]:
    """愿望单接口 JSON（按 appid 键）→ [{appid, priority, name}]。"""
    out: list[dict[str, Any]] = []
    for appid_str, item in (data or {}).items():
        try:
            appid = int(appid_str)
        except (ValueError, TypeError):
            continue
        out.append(
            {
                "appid": appid,
                "priority": int(item.get("priority", 0) or 0),
                "name": item.get("name"),
            }
        )
    return out


_DATE_RE = re.compile(
    r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,|\s)?\s*\d{4}"
)
_LINK_RE = re.compile(r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)
_PAY_RE = re.compile(r'class="[^"]*wallet_column[^"]*"[^>]*>(.*?)</td>', re.DOTALL | re.IGNORECASE)


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s).strip()


def _appid_from_url(href: str) -> int | None:
    m = re.search(r"/app/(\d+)/?", href)
    return int(m.group(1)) if m else None


def _subid_from_url(href: str) -> int | None:
    m = re.search(r"/sub/(\d+)/?", href)
    return int(m.group(1)) if m else None


def _parse_history_date(s: str) -> date | None:
    clean = s.replace(",", " ").strip()
    for fmt in ("%b %d %Y", "%B %d %Y", "%d %b %Y"):
        try:
            return datetime.strptime(clean, fmt).date()
        except ValueError:
            continue
    return None


def parse_purchase_history(html: str) -> list[dict[str, Any]]:
    """购买历史页 HTML → [{date, items:[{name,appid,subid}], payment_method}]（防御式）。

    只依赖「日期字符串 + /app/ /sub/ 链接」两个稳定特征，容忍 class 名漂移；解析失败返回空。
    """
    rows = re.findall(r"<tr\b[^>]*>.*?</tr>", html, re.DOTALL | re.IGNORECASE)
    out: list[dict[str, Any]] = []
    for row in rows:
        date_m = _DATE_RE.search(row)
        if not date_m:
            continue
        parsed_date = _parse_history_date(date_m.group(0))
        if parsed_date is None:
            continue

        items = []
        for href, text in _LINK_RE.findall(row):
            appid = _appid_from_url(href)
            subid = _subid_from_url(href)
            if appid is None and subid is None:
                continue
            items.append({"name": _strip_tags(text), "appid": appid, "subid": subid})
        if not items:
            continue

        payment = None
        pm = _PAY_RE.search(row)
        if pm:
            payment = _strip_tags(pm.group(1)) or None

        out.append({"date": parsed_date, "items": items, "payment_method": payment})
    return out


def get_steam_client() -> SteamClient:
    return SteamClient()


__all__ = [
    "SteamClient",
    "SteamError",
    "SteamNotRetryable",
    "RateLimited",
    "get_steam_client",
    "parse_wishlist_data",
    "parse_purchase_history",
]
