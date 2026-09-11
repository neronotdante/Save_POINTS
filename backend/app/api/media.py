"""素材直取代理：只为**导出长图**存在的一条窄通道。

为什么非有它不可（不是「顺手加个代理」）：
导出长图是在浏览器里把整条轴画进 `<canvas>` 再取 PNG，而**跨域图片一旦画进画布，
画布就被污染，`toBlob` 直接抛 SecurityError**——整张图一个像素都拿不出来。要不污染，
图片必须是同源的，或者对方给 `Access-Control-Allow-Origin`。实测 Steam 的几个图床里：

  · ``cdn.cloudflare.steamstatic.com`` 的 ``/steam/apps/...``（封面、头图）—— 给 ACAO；
  · ``images.steamusercontent.com`` / ``steamuserimages-*.akamaihd.net``（截图）—— 给 ACAO；
  · ``steamcdn-a.akamaihd.net`` 的 ``/steamcommunity/public/images/apps/...``
    （**成就图标**）—— **不给**，换 cdn.cloudflare / cdn.akamai 同路径也一样不给。

也就是说前端自己能取回封面和截图，唯独取不回成就图标——而成就是这条轴上数量最大的一类
事件（本库 1139 个时点里绝大多数是成就），少了它们，导出的长图上是成千上万个纯色方块。
所以这里开一条**只读、只走白名单主机、只回图片**的代理，让浏览器有办法同源拿到这些图。

边界写死三条，防止它长成一个通用转发器：
  1. 主机必须在 ``ALLOWED_HOSTS`` 里，且必须是 https；
  2. 响应 Content-Type 必须是 ``image/*``，否则一律 502；
  3. 有大小上限，超了直接断——代理不是下载器。
"""
from __future__ import annotations

import logging
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.api.deps import get_current_user
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(tags=["media"])

#: 允许代理的图床。**只增不宽**：加新主机前先确认它确实是 Steam 的素材域名。
ALLOWED_HOSTS = frozenset(
    {
        "steamcdn-a.akamaihd.net",
        "cdn.akamai.steamstatic.com",
        "cdn.cloudflare.steamstatic.com",
        "shared.akamai.steamstatic.com",
        "shared.cloudflare.steamstatic.com",
        "media.steampowered.com",
        "images.steamusercontent.com",
        "steamuserimages-a.akamaihd.net",
        "avatars.akamai.steamstatic.com",
        "avatars.cloudflare.steamstatic.com",
    }
)

#: 单张素材的大小上限。封面 ~200KB、截图 ~2MB，8MB 是留足余量之后的硬闸。
MAX_BYTES = 8 * 1024 * 1024

#: 浏览器端会把同一张图缓存起来复用（一次导出里同一个图标可能出现在几十个时点上）。
#: 用 private 而不是 public——这条路要带 Bearer 才走得通，标成 public 等于允许中间缓存
#: 把一份「验过身份才拿得到」的响应发给下一个没验过的人。
CACHE_CONTROL = "private, max-age=86400"

#: 复用一个客户端而不是每张图现开一个：现开等于每张图都要和图床重做一次 TLS 握手，
#: 几千张图光握手就是好几分钟。keep-alive 之后一条连接能连着取几十张。
_client = httpx.Client(
    timeout=20.0,
    follow_redirects=True,
    limits=httpx.Limits(max_connections=16, max_keepalive_connections=16),
)


@router.get("/media/image", response_class=Response)
def media_image(
    url: str = Query(..., description="Steam 图床上的图片地址（https，且主机在白名单内）"),
    user: User = Depends(get_current_user),
) -> Response:
    """把一张 Steam 图床上的图片原样转回来，附带同源身份（供导出长图用）。

    ``user`` 只用来卡登录态：这条路不该对匿名开放，虽然它取的都是公开素材。
    """
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="只允许代理 Steam 图床上的 https 素材",
        )

    try:
        resp = _client.get(url)
    except httpx.HTTPError as exc:
        logger.warning("素材代理失败 %s: %s", url, exc)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "素材取不回来") from exc

    if resp.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"素材源返回 HTTP {resp.status_code}")

    content_type = resp.headers.get("content-type", "")
    if not content_type.startswith("image/"):
        # 404 页、防盗链页都会以 200 + text/html 回来。当图用会画出一片空白，
        # 不如在这里就说清楚「这不是图」。
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "素材源没有返回图片")
    if len(resp.content) > MAX_BYTES:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "素材超出大小上限")

    return Response(
        content=resp.content,
        media_type=content_type,
        headers={"Cache-Control": CACHE_CONTROL},
    )


__all__ = ["router", "ALLOWED_HOSTS"]
