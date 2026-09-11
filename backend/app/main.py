"""FastAPI 应用入口：装配中间件、路由、建表、定时任务与前端静态托管。"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app import models  # noqa: F401  注册全部表到 metadata
from app.api import achievements, auth, calendar, games, media, openid, sync, wishlist
from app.config import settings
from app.core.rate_limit import limiter, rate_limit_handler
from app.core.security import key_source, key_was_generated
from app.database import engine
from app.tasks.scheduler import shutdown_scheduler, start_scheduler

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

logger = logging.getLogger(__name__)


def frontend_dir() -> Path | None:
    """要托管的前端目录；关掉托管或目录里没有 index.html 时返回 None。"""
    if not settings.serve_frontend:
        return None
    if settings.frontend_dir:
        path = Path(settings.frontend_dir)
    else:
        # backend/app/main.py → 仓库根 / timeline
        path = Path(__file__).resolve().parent.parent.parent / "timeline"
    return path if (path / "index.html").is_file() else None


class _NoCacheStaticFiles(StaticFiles):
    """静态文件一律 ``Cache-Control: no-cache``。

    前端是无构建的 ES Modules，文件名不带哈希。更新代码后浏览器若按启发式缓存继续吃旧
    模块，就会出现「改了代码页面还跑旧逻辑」——serve.py 在开发态就是为此关掉缓存的，
    托管路径得保持同样的行为。no-cache 仍允许协商缓存（ETag / 304），不是 no-store。
    """

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 开发便利：自动建表（生产建议走 Alembic，并设 GC_AUTO_CREATE_TABLES=false）。
    if settings.auto_create_tables:
        models.Base.metadata.create_all(bind=engine)

    logger.info("加密密钥来源：%s", key_source())
    if key_was_generated():
        # 刚生成了密钥文件：库里若有用旧默认密钥加密的 Key，此刻迁过来，否则采集时解不开
        from app.core.rekey import rekey_legacy_secrets

        logger.warning(
            "首次启动已生成加密密钥文件（%s）。它和数据库要一起备份，丢了就解不开已存的 API Key。",
            settings.fernet_key_file,
        )
        rekey_legacy_secrets()

    # P0-4：越权后门开启时打 WARNING，防止误上线。
    if settings.auth_trust_client_steamid:
        logger.warning(
            "⚠️ GC_AUTH_TRUST_CLIENT_STEAMID=true：Steam 校验后门已开启，"
            "任何人可自报 SteamID 冒用他人身份。仅限开发，生产必须 false。"
        )
    scheduler = start_scheduler()
    if settings.auto_open_login:
        _open_login_page()
    yield
    shutdown_scheduler()


def _open_login_page() -> None:
    """启动时自动用默认浏览器打开应用（托管前端时开首页，否则直接开登录）。"""
    import webbrowser

    base = settings.public_base_url.rstrip("/")
    url = f"{base}/" if frontend_dir() else f"{base}/auth/steam/openid/login"
    try:
        webbrowser.open(url)
        logger.info("已打开 %s", url)
    except Exception:  # noqa: BLE001
        logger.warning("自动打开浏览器失败，请手动访问 %s", url)


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="Game_C 游戏日历后端：SteamID 认证 + 每日采集 + 日历聚合 REST API。",
        lifespan=lifespan,
    )

    # 限流（最低程度，防滥用）
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_handler)
    app.add_middleware(SlowAPIMiddleware)

    # CORS（默认宽松；opaque token 走 Authorization 头，不由浏览器自动携带，故不开启 credentials）
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        # 跨源响应默认只暴露 6 个「简单」响应头，ETag 不在其中——不显式放行的话
        # 前端 `res.headers.get('ETag')` 永远是 null，If-None-Match 就永远发不出去，
        # /calendar/timeline 上那套 304 复用等于没接上（api.js::getTimeline）。
        expose_headers=["ETag"],
    )

    prefix = settings.api_prefix
    app.include_router(auth.router, prefix=prefix)
    app.include_router(openid.router, prefix=prefix)
    app.include_router(calendar.router, prefix=prefix)
    app.include_router(achievements.router, prefix=prefix)
    app.include_router(games.router, prefix=prefix)
    app.include_router(media.router, prefix=prefix)
    app.include_router(wishlist.router, prefix=prefix)
    app.include_router(sync.router, prefix=prefix)

    @app.get("/login", include_in_schema=False)
    def login_redirect() -> RedirectResponse:
        """登录入口：直接走 Steam OpenID（无侧载 QR / 账密页）。"""
        return RedirectResponse(url="/auth/steam/openid/login")

    @app.get("/health", tags=["ops"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # 前端托管必须放在**所有路由之后**：挂在 "/" 的 StaticFiles 会接住一切没被上面路由
    # 命中的路径。托管开着时 "/" 就是 index.html；没有前端目录（Docker 镜像）时才让根路径
    # 直接跳登录。
    static_root = frontend_dir()
    if static_root is not None:
        app.mount("/", _NoCacheStaticFiles(directory=str(static_root), html=True), name="frontend")
        logger.info("托管前端：%s → %s/", static_root, settings.public_base_url.rstrip("/"))
    else:

        @app.get("/", include_in_schema=False)
        def root() -> RedirectResponse:
            """未托管前端时根路径直接重定向到 Steam OpenID 登录。"""
            return RedirectResponse(url="/auth/steam/openid/login")

    return app


app = create_app()


def run() -> None:
    """控制台入口：``game-calendar-backend``。"""
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=settings.debug)


if __name__ == "__main__":
    run()
