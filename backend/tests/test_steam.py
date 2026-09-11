"""Steam 客户端纯函数测试（截图 XML / 愿望单 / 购买历史解析，无需网络）。"""
from __future__ import annotations

from datetime import date

from app.services.steam import (
    _appid_from_url,
    _parse_history_date,
    _subid_from_url,
    parse_purchase_history,
    parse_wishlist_data,
)



def test_parse_published_file_maps_all_fields():
    """GetUserFiles 单条 → 截图字典（官方接口取代已失效的社区 XML）。"""
    from app.services.steam import _parse_published_file

    shot = _parse_published_file({
        "publishedfileid": "3793493595",
        "consumer_appid": 1285190,
        "filename": "1285190/screenshots/20260831220711_1.jpg",
        "time_created": 1756654050,
        "preview_url": "https://images.steamusercontent.com/ugc/thumb/",
        "file_url": "https://images.steamusercontent.com/ugc/full/",
        "title": "好看",
    })
    assert shot["shot_id"] == "3793493595"
    assert shot["appid"] == 1285190
    # 文件名里的拍摄时刻优先于上传时间
    assert (shot["taken_at"].year, shot["taken_at"].month, shot["taken_at"].day) == (2026, 8, 31)
    assert (shot["taken_at"].hour, shot["taken_at"].minute) == (22, 7)
    assert shot["thumbnail_url"].endswith("thumb/")
    assert shot["url"].endswith("full/")
    assert shot["caption"] == "好看"


def test_parse_published_file_falls_back_to_time_created():
    """文件名解析不出时间时退回 time_created。"""
    from app.services.steam import _parse_published_file

    shot = _parse_published_file({
        "publishedfileid": "1", "consumer_appid": 440,
        "filename": "", "time_created": 1756654050,
    })
    # 1756654050 = 2025-08-31（与上一个用例的文件名 2026… 刻意错开，好证明来源确实不同）
    assert (shot["taken_at"].year, shot["taken_at"].month) == (2025, 8)


def test_parse_published_file_drops_unusable():
    """缺 appid / 时间的条目对时间轴没有意义，直接丢弃。"""
    from app.services.steam import _parse_published_file

    assert _parse_published_file({"publishedfileid": "1", "consumer_appid": 0, "time_created": 1}) is None
    assert _parse_published_file({"publishedfileid": "1", "consumer_appid": 440, "time_created": 0}) is None
    assert _parse_published_file({}) is None


def test_parse_wishlist_data():
    data = {
        "1245620": {"name": "ELDEN RING", "priority": 0},
        "abc": {"name": "bad-appid"},
    }
    assert parse_wishlist_data(data) == [
        {"appid": 1245620, "priority": 0, "name": "ELDEN RING"}
    ]


def test_appid_subid_from_url():
    assert _appid_from_url("https://store.steampowered.com/app/1245620/Elden_Ring/") == 1245620
    assert _appid_from_url("https://store.steampowered.com/sub/654321/") is None
    assert _subid_from_url("https://store.steampowered.com/sub/654321/") == 654321


def test_parse_history_date():
    assert _parse_history_date("Jan 15, 2024") == date(2024, 1, 15)
    assert _parse_history_date("Feb 3, 2023") == date(2023, 2, 3)
    assert _parse_history_date("garbage") is None


PURCHASE_HTML = """
<table>
  <tr class="wallet_table_row">
    <td class="wallet_date">Jan 15, 2024</td>
    <td><a href="https://store.steampowered.com/app/1245620/">Elden Ring</a></td>
    <td class="wallet_column">支付宝</td>
  </tr>
  <tr>
    <td class="wallet_date">Feb 3, 2023</td>
    <td><a href="https://store.steampowered.com/sub/654321/">HELLDIVERS 2</a></td>
    <td class="wallet_column">Visa</td>
  </tr>
</table>
"""


def test_parse_purchase_history():
    rows = parse_purchase_history(PURCHASE_HTML)
    assert len(rows) == 2

    assert rows[0]["date"] == date(2024, 1, 15)
    assert rows[0]["items"][0]["appid"] == 1245620
    assert rows[0]["payment_method"] == "支付宝"

    assert rows[1]["date"] == date(2023, 2, 3)
    assert rows[1]["items"][0]["appid"] is None
    assert rows[1]["items"][0]["subid"] == 654321
    assert rows[1]["payment_method"] == "Visa"


def test_parse_purchase_history_empty():
    assert parse_purchase_history("<html>no rows</html>") == []
    assert parse_purchase_history("") == []


def test_app_details_falls_back_to_us_region():
    """``cc=cn`` 返回 ``success:false`` 时改问 ``cc=us``——这不是「没有这个 app」。

    appdetails 的可见性分区域：中国区下架 / 不发行的游戏在 cn 下会返回失败，和「app 不存在」
    长得一模一样。实测本库 14 款拿不到元数据的游戏里 5 款属于此类（MGSV 两作、CoD MW2 2009、
    Ori 决定版、THE FINALS），换区全部拿得到。
    """
    from app.services.steam import SteamClient

    steam = SteamClient()
    seen: list[str] = []

    def fake_get_json(url, params=None, cookies=None):
        cc = (params or {}).get("cc")
        seen.append(cc)
        if cc == "cn":
            return {"287700": {"success": False}}
        return {"287700": {"success": True, "data": {"name": "METAL GEAR SOLID V"}}}

    steam._get_json = fake_get_json  # type: ignore[method-assign]
    try:
        data = steam.get_app_details(287700)
    finally:
        steam.close()

    assert data == {"name": "METAL GEAR SOLID V"}
    assert seen == ["cn", "us"]


def test_app_details_does_not_retry_region_when_first_hit_succeeds():
    """第一区就拿到 → 不多打一次请求。回退只在拿不到时发生。"""
    from app.services.steam import SteamClient

    steam = SteamClient()
    seen: list[str] = []

    def fake_get_json(url, params=None, cookies=None):
        seen.append((params or {}).get("cc"))
        return {"440": {"success": True, "data": {"name": "TF2"}}}

    steam._get_json = fake_get_json  # type: ignore[method-assign]
    try:
        assert steam.get_app_details(440) == {"name": "TF2"}
    finally:
        steam.close()
    assert seen == ["cn"]
