"""应用配置：集中读取环境变量，pydantic-settings 提供默认值与校验。"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

#: 出厂默认主密钥。**它不是一个可用的密钥，而是一个信号**：secret_key 仍等于它时，
#: core/security 会改用每机独立生成的密钥文件（见 ``fernet_key_file``），
#: 而不是让所有安装共用同一把由这串字符派生出来的锁。
DEFAULT_SECRET_KEY = "dev-insecure-change-me"


class Settings(BaseSettings):
    """所有可配置项。环境变量前缀为 ``GC_``，可在项目根 ``.env`` 覆盖。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="GC_",
        case_sensitive=False,
        extra="ignore",
    )

    # --- 运行 ---
    app_name: str = "Game_C Backend"
    debug: bool = False
    log_level: str = "INFO"
    api_prefix: str = ""

    # --- 数据库 ---
    database_url: str = "sqlite:///./game_c.db"

    # --- 安全 ---
    # 密钥解析顺序（core/security._resolve_key）：
    #   GC_FERNET_KEY（直接指定）> GC_SECRET_KEY（非默认值时派生）> 密钥文件（首次启动自动生成）。
    # 自托管用户什么都不配也能得到一把每机独立的密钥；显式配了就以配置为准。
    secret_key: str = DEFAULT_SECRET_KEY
    fernet_key: str | None = None
    # 自动生成的 Fernet 密钥存放处（相对后端工作目录）。丢了它 = 解不开库里已存的 Key，
    # 备份数据库时要一起备份；已进 .gitignore。
    fernet_key_file: str = "./fernet.key"
    token_ttl_days: int = 30

    # --- 前端托管 ---
    # 后端直接托管 timeline/ 静态文件（http://127.0.0.1:8000/），前后端同源：
    # 不用另起静态服务器，也不再有 CORS / 端口耦合。开发时仍可用 serve.py 起 5173。
    serve_frontend: bool = True
    # 前端目录；留空 = 仓库里的 ../timeline（相对 app 包）。Docker 镜像里没有它时自动跳过托管。
    frontend_dir: str | None = None

    # --- Steam 上游 ---
    steam_api_base: str = "https://api.steampowered.com"
    steam_store_base: str = "https://store.steampowered.com"
    steam_community_base: str = "https://steamcommunity.com"
    steam_cdn_base: str = "https://cdn.cloudflare.steamstatic.com/steam/apps"
    # node-steam-user 登录侧车地址（本地）。
    steam_sidecar_url: str = "http://127.0.0.1:8765"
    # 启动时是否自动打开浏览器到登录页。
    auto_open_login: bool = False
    # OpenID 2.0 登录（Layer 1）的绝对回调 / realm 基址（07 后端计划 P0-3a）。
    # 例：http://127.0.0.1:8000 —— return_to/realm 需要绝对 URL。
    public_base_url: str = "http://127.0.0.1:8000"
    # 登录成功后跳回的前端地址。配置后 OpenID 回调 302 回前端并在 URL fragment 里带 token
    # （`#token=...`，fragment 不进服务端日志与 Referer）；留空则沿用旧行为：直接返回 JSON。
    # 必须是 cors_origins 里的源，否则跳回去也调不通接口。
    frontend_base_url: str | None = "http://localhost:5173"
    steam_request_timeout: float = 10.0
    steam_max_retries: int = 4
    # 截图接口：最多拉取的页数（官方 GetUserFiles 一页 100 条，20 页 = 2000 张，够用且防膨胀）。
    screenshot_max_pages: int = 20
    # 购买历史页最多拉取的页数（防膨胀）。
    purchase_history_max_pages: int = 10
    # --- 公共数据缓存 TTL（天）。只缓存与用户无关的上游响应，见 services/steam_cache。 ---
    # 商店元数据：会改名 / 改期 / 换封面，但都是低频事件。
    cache_ttl_app_details_days: int = 7
    # 成就 schema：成就名 / 图标 / 总数，基本不动。
    cache_ttl_ach_schema_days: int = 30
    # 全球解锁率：缓慢漂移，隔天刷一次足够。
    cache_ttl_ach_percent_days: int = 1

    # 成就回填单轮处理的游戏数上限（增量 + 分批，见 services/sync_service）。
    # 每个游戏要打 2~3 次上游接口，首次同步的大库不能在一轮里全跑完。
    achievement_batch_size: int = 50

    # 仅开发：Steam 校验不可用时信任客户端自报 steamid。
    # ⚠️ 越权后门（07 后端计划 P0-4）：一旦开启，任何人报任意 SteamID 即可拿到该用户 token。
    # 生产必须保持 false；开启时启动日志会打 WARNING。
    auth_trust_client_steamid: bool = False

    # --- 启动行为 ---
    auto_create_tables: bool = True
    scheduler_enabled: bool = True
    daily_sync_hour: int = 3
    daily_sync_minute: int = 0
    daily_sync_timezone: str = "UTC"

    # --- 限流 ---
    rate_limit_default: str = "300/minute"
    rate_limit_auth: str = "30/minute"

    # --- CORS ---
    # 默认只放行本机前端（timeline/ 的静态服务与 Vite 常用端口）。
    # 生产用 GC_CORS_ORIGINS 显式列出站点；`["*"]` 仅限临时调试。
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://127.0.0.1:8000",
            "http://localhost:8000",
        ]
    )

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def secret_key_is_default(self) -> bool:
        return self.secret_key == DEFAULT_SECRET_KEY


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
