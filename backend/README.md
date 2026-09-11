# Game_C 后端（game-calendar-backend）

游戏日历（Game_C）的**多用户后端**。依据 [`../GAMEC/开发文档/05_后端接口文档.md`](../GAMEC/开发文档/05_后端接口文档.md) 实现：用户以 **SteamID64** 唯一标识，后端集中存储并**每日采集** Steam 数据，客户端（桌面悬浮日历）只读。

> 上游契约：PRD [`02_PRD_游戏日历.md`](../GAMEC/02_PRD_游戏日历.md)（多用户 + 后端）、Steam 信息获取 [`03`](../GAMEC/开发文档/03_Steam信息获取文档.md) / 技术验证 [`04`](../GAMEC/开发文档/04_Steam信息获取技术验证文档.md)。

## 技术栈

- **Python 3.11+** + **FastAPI**（同步端点，线程池并发）
- **SQLAlchemy 2.0**（同步 ORM）：开发默认 **SQLite**（stdlib，零驱动），生产 **PostgreSQL**（`psycopg`）
- **Alembic** 迁移、**APScheduler** 每日采集、**httpx** 调 Steam、**cryptography**（Fernet 加密 API Key）、**slowapi** 限流

## 快速开始

> 只是想用：看仓库根目录的 [`README.md`](../README.md)，双击根目录 `run.cmd` 即可。本文件面向改代码和部署的人。

### 方式一：SQLite 开发态（零依赖，即刻可跑）

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows；POSIX: source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload   # http://127.0.0.1:8000/ 即应用；/docs 是接口文档
```

或直接双击 **`run.cmd`**（首次自动建环境、装依赖，带 `--reload`）。

默认无 `.env` 即用 SQLite（`./game_c.db`）+ 启动时自动建表，开箱即用。

**前端由后端托管**：`GC_SERVE_FRONTEND=true`（默认）时把仓库里的 `../timeline` 挂在 `/`，前后端同源，不需要另起静态服务器、也没有 CORS 与端口耦合。静态文件一律 `Cache-Control: no-cache`（前端是无构建的 ES Modules，否则改完代码浏览器还跑旧模块）。开发时仍可 `python ../timeline/serve.py 5173` 单独起，5173 在 CORS 白名单里，登录回跳用 `?front=` 自动回到发起页。

**加密密钥**：什么都不配时首次启动在 `./fernet.key` 生成一把每机独立的 Fernet 密钥，启动日志会打印来源；配了 `GC_SECRET_KEY`（非默认值）或 `GC_FERNET_KEY` 则以配置为准。刚生成密钥文件的那次启动会把库里用旧默认密钥加密过的字段自动迁到新密钥（`core/rekey.py`，幂等）。**密钥文件与数据库要一起备份。**

**绑定 API Key** 有三条路，效果相同：首启页（登录后必经）、设置页 ACCOUNT 组、或终端 `game-calendar-bind-apikey`。`POST /auth/apikey` 会先拿 Key 查一次本人 `GetPlayerSummaries`，无效直接 400 不落库。

### Steam 登录（扫码 QR，需要 node 侧车）

后端自主拉取愿望单 / 购买历史 / 私密截图，需要 Steam web 会话。登录走 **steam-session 侧车**（扫码为主、账号密码为辅）：

```bash
cd sidecar
npm install      # 装 steam-session + qrcode
npm start        # 127.0.0.1:8765
```

然后启动后端，浏览器打开 `http://127.0.0.1:8000/login`（500×500，非官方页含免责声明；扫码后手机 App 确认即可）。设 `GC_AUTO_OPEN_LOGIN=true` 可在启动时自动弹该页。登录成功后会话（`sessionid`/`steamLoginSecure`/`refreshToken`）**Fernet 加密**入库，密码不落盘、不落库、不落日志。

### 方式二：Docker + PostgreSQL（多用户生产形态）

```bash
cd backend
docker compose up --build      # db(5432) + api(8000)，自动 alembic upgrade head
```

## 配置（环境变量，前缀 `GC_`，见 `.env.example`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GC_DATABASE_URL` | `sqlite:///./game_c.db` | 生产改 `postgresql+psycopg://…` |
| `GC_SECRET_KEY` | `dev-insecure-change-me` | 改掉默认值后由它派生 Fernet 密钥；**保持默认则改用密钥文件**（下一行） |
| `GC_FERNET_KEY_FILE` | `./fernet.key` | 未配 `GC_FERNET_KEY` / 非默认 `GC_SECRET_KEY` 时，首次启动在此生成每机独立密钥 |
| `GC_SERVE_FRONTEND` | `true` | 后端托管 `timeline/`（`/` 即应用）；Docker 镜像里没有该目录时自动跳过 |
| `GC_FRONTEND_DIR` | 空 | 前端目录，空 = 仓库里的 `../timeline` |
| `GC_AUTH_TRUST_CLIENT_STEAMID` | `false` | 仅开发：Steam 校验不可用时信任客户端自报 steamid |
| `GC_AUTO_CREATE_TABLES` | `true` | 生产走 Alembic 时设 `false` |
| `GC_SCHEDULER_ENABLED` | `true` | 每日采集定时任务开关 |
| `GC_DAILY_SYNC_HOUR` / `MINUTE` | `3` / `0` | 每日采集触发时间（UTC） |
| `GC_STEAM_SIDECAR_URL` | `http://127.0.0.1:8765` | node-steam-user 登录侧车地址 |
| `GC_AUTO_OPEN_LOGIN` | `false` | 启动时自动打开浏览器到登录页 |
| `GC_ACHIEVEMENT_BATCH_SIZE` | `50` | 成就回填单轮处理的游戏数上限（增量 + 分批） |
| `GC_CORS_ORIGINS` | 本机前端白名单 | **默认不再是 `["*"]`**；生产显式列出前端站点 |

## REST 接口

带 ✅ 的为文档 §3 原生接口；带 ➕ 的为补齐的接口（来源标注）。

| 方法 | 路径 | 出参 | 说明 |
|---|---|---|---|
| ✅ POST | `/auth/steam` | `{user_id, token, nickname, avatar}` | Steam 登录 / 注册（`GetTokenDetails` 校验 access_token） |
| ➕ GET | `/login` | HTML（500×500） | 登录页（扫码为主，含第三方免责声明） |
| ➕ POST | `/auth/steam/qr` | `{status, qr_data_uri}` | 开始扫码登录 |
| ➕ GET | `/auth/steam/poll` | `{status, user_id, token}` | 轮询登录结果 |
| ➕ POST | `/auth/steam/password` | `{status: guard\|pending}` | 账号密码登录第一步 |
| ➕ POST | `/auth/steam/guard` | `{status: pending}` | 提交 Steam Guard 码 |
| ✅ POST | `/auth/apikey` | `204` / `400` | 提交 API Key：先用它查一次本人资料，无效 400 不落库；有效则 Fernet 加密存储，不回显 |
| ➕ DELETE | `/auth/apikey` | `204` | 解绑 Key（05 §6「解绑 / 吊销」出口）；已采集数据保留，只停同步 |
| ✅ GET | `/auth/apikey` | `{has_key}` | 是否已绑 Key |
| ➕ GET | `/auth/steam/openid/login?front=` | 302 到 Steam | `front` = 发起登录的前端源；CORS 白名单内才记进 cookie，回调按它 302 回来（否则回落 `GC_FRONTEND_BASE_URL`） |
| ✅ GET | `/calendar/{year}/{month}` | `TimelineEvent[]` | 月历事件（后端聚合） |
| ✅ GET | `/calendar/day/{date}` | `{counts, rows, screenshots[]}` | 日详情浮层（含当日截图缩略图） |
| ✅ GET | `/calendar/timeline` | `{events, screenshots, games}` | 时间轴（范式 B）一次性全量数据（07 §4.7）；`games` 带生命状态，**支持 `ETag` / `If-None-Match` → 304** |
| ✅ GET | `/achievements/{appid}/{date}` | `AchievementDetail[]` | 时点 panel 成就形态按需懒加载（07 §4.8）；明细不进 `/timeline` 全量出参 |
| ✅ POST | `/wishlist` | `204` | 客户端拉取愿望单后提交（不存 access_token） |
| ✅ POST | `/sync` | SSE 事件流 | 手动触发同步（进度流，含并发保护） |
| ✅ GET | `/games` | `Game[]` | 游戏库（含生命状态六件套，与 `/timeline` 的 `games[]` 同一份构建逻辑） |
| ✅ POST | `/games/{appid}/review` | `204` | 短评评分（P-5） |
| ➕ GET | `/sync/status` | `{status, last_sync_at, last_error, has_key}` | 底栏同步状态（idle/syncing/error/unconfigured） |
| ➕ POST | `/purchases` | `204` | 购买入库（§4 `purchases` 表需要；客户端 license list + PICS 映射后提交） |
| ➕ POST | `/auth/logout` | `204` | 登出：撤销当前 opaque token |
| ➕ GET | `/health` | `{status}` | 健康检查 |

认证：除 `/auth/steam` 与 `/health` 外，均需 `Authorization: Bearer <opaque token>`。

### 关键出参结构

`GET /calendar/{year}/{month}` 返回扁平 `TimelineEvent[]`，客户端按 `date` 分组：

```json
{
  "date": "2026-08-03",
  "type": "achievement",          // release | purchase | first_play | achievement
  "count": 12,
  "theme_color": "#B0761A",       // 成就/首玩=游戏主题色；购买=#0E9E68；发售=#2F6BFF
  "game": { "appid": 1245620, "name_zh": "艾尔登法环", "name_en": "Elden Ring",
            "cover": "https://…", "theme_color": "#B0761A" }
}
```

`GET /calendar/day/{date}` 结构对齐客户端 mock（`mock-data.js` 的 `getDayDetail`）：

```json
{
  "counts": { "achievement": 12, "first_play": 3, "release": 1 },
  "rows": [
    { "type": "achievement", "game": { … }, "theme_color": "#B0761A", "count": 12, "time": 603 }
  ]
}
```

> **客户端对接字段映射**（接真数据时在 fetch 层转一次即可，渲染层不动）：`theme_color → themeColor`、`name_zh → zh`、`name_en → en`、`counts.achievement/first_play/release` 与 `rows[].time` 保持不变。

`GET /calendar/timeline` 的 `games[]`（与 `GET /games` 同构）带**生命状态六件套**（PRD §3 / 07 §4.5），供前端画封盘帽与「隐藏从未启动」开关本地过滤：

```json
{
  "appid": 1245620, "name_zh": "艾尔登法环", "status": "played", "theme_color": "#B0761A",
  "lifecycle": "shelved",              // never_launched | active | dormant | shelved
  "shelved_at": "2026-05-04T18:00:00", // = 最后活动时点；非 shelved 恒为 null
  "launched_ever": true,
  "play_days_count": 63,               // 界面上「玩得久不久」的唯一口径
  "ach_unlocked": 38, "ach_total": 50  // 封盘 panel 的判定依据行
}
```

> `playtime_forever` **不出参**——只供后端封盘判定，界面不呈现小时数（PRD §3）。
>
> **ETag**：`/calendar/timeline` 返回弱 ETag，客户端回带 `If-None-Match` 时数据未变直接 304（连聚合都不做）。指纹含 `user_id`，不会跨用户命中。

## 数据模型（`app/models`）

`users`（steamid 主键 / nickname / avatar / `apikey_enc`）、`auth_tokens`（opaque token 哈希映射）、`games`（含横版 `cover` + 竖版 `cover_portrait` 2:3 + 主题色 + **生命状态派生列** `lifecycle`/`shelved_at`/`last_active_at`/`launched_ever`/`playtime_forever`/`rtime_last_played`/`ach_total`/`achievements_at`）、`play_days`（运行日，核心指标）、`achievements`（历史回填 + 展示三件套 `display_name`/`icon_url`/`global_percent`）、`screenshots`（v0.7 截图，运行日补强）、`purchases`、`reviews`（P-5）、`sync_state`（各源游标 + `lifecycle_at` + 状态机 `status`/`last_error`）。

- `auth_tokens`、`reviews`、`screenshots` 为文档 §4 六表之外的补充：opaque token 落点、短评存储、截图数据源，均为最小补充，见对应模型注释。

## 采集任务

> ⚠️ **只在后端进程活着时才采集。** `GetRecentlyPlayedGames` 只覆盖最近两周，后端停超过两周，那段运行日永久丢失（成就 / 截图能部分补，运行日不能）。自托管的常驻方案（任务计划 / Docker）写在根目录 README §5。

- **每日定时**（APScheduler cron，默认 UTC 03:00）：遍历已绑 Key 的用户，逐用户 `GetOwnedGames` 刷判定字段、`GetRecentlyPlayedGames` 记 `play_days`、成就增量回填、拉社区截图元数据（按日聚簇派生 `play_days`），**收尾重算生命状态**。
- **首次同步**：`GetOwnedGames` 回填游戏库并补元数据（覆盖「过去」）；之后每轮仍拉 `GetOwnedGames`——`playtime_forever` / `rtime_last_played` 是封盘判定的输入。
- **成就回填是增量 + 分批的**：只处理「从未回填」或「回填后又玩过」的游戏（判据 `games.achievements_at` vs `last_active_at`），单轮上限 `GC_ACHIEVEMENT_BATCH_SIZE`，剩下的下一轮继续。
- **生命状态每轮收尾重算**（PRD §3 P-13 / P-14）：`last_active_at` = `rtime_last_played` 与本地三路（运行日 / 成就 / 截图）取 max，按 `T_quiet=45d` / `T_time=600min` / `T_ach=10%` 判四态。判定**幂等且无状态**——再启动即自然回落 `active`、`shelved_at` 清空。阈值改动后用 `game-calendar-recompute` 一次性重算全库。
- **首轮同步的提速措施**（三条，实测首轮请求数降约 35%、单请求延迟降约 8x）：
  - `SteamClient` **持有并复用一个 `httpx.Client`**——原先每请求新建，等于每次重做 TCP+TLS 握手（实测中位 1890ms → 222ms）。一轮同步共用一个实例，结束即 `close()`；每次请求后清空 cookie jar，保持与原来一致的无状态语义。
  - **英文名不重复拉**：`GetOwnedGames` 已返回英文名，`enrich_game_metadata` 仅在 `name_en` 为空时才为英文再打一次 Store API（愿望单路径没有这个兜底，仍会走到）。
  - **截图只拉启动过的游戏**：判据是 `launched_ever`，不是 `play_days`——首轮 `play_days` 只有近两周数据，拿它过滤会漏掉历史截图。
- **单用户失败不影响他人**；失败重试 + 指数退避（`retry_with_backoff`）；Steam 429/5xx 逐请求退避（`SteamClient`）；截图接口非承诺稳定、失败不阻塞。
- **愿望单**由客户端用 access_token 拉取后 `POST /wishlist`，后端补 Store API 元数据（名称中/英 + 横竖封面 + 发售日 + 主题色）并把已发售的置 `released_wishlist`（归档，不进日历主显示区）。

## 安全与合规

- API Key **Fernet 加密存储**（`apikey_enc`），日志不落 Key、接口不回显（`GET /auth/apikey` 只回 `has_key`）。
- 登录态 = **最简 opaque token**：库中只存 SHA-256 哈希，原始 token 仅登录时下发一次；不实现 JWT / session cookie。
- 用户间按 steamid 过滤隔离（`tests/test_isolation.py` 有跨用户串数据的断言）；接口最低程度限流（全局 300/min、认证 30/min）。
- CORS 默认只放行本机前端白名单（不再是 `["*"]`），生产用 `GC_CORS_ORIGINS` 显式列出站点。
- Store API 带 429 退避；不碰 SteamDB（合规红线见 03 文档 §9）。

## 测试

```bash
pip install -e ".[dev]"
pytest
```

覆盖：安全基础件（Fernet / token）、主题色规范化（纯函数护栏）、日历聚合、生命状态判定与重算、成就增量分批、`/timeline` ETag、**多用户隔离**（服务层 + 接口层双向断言）、REST 集成（假 Steam，无网络）。

## 目录结构

```
backend/
  app/
    main.py             FastAPI 装配（CORS / 限流 / 路由 / 建表 / 调度器）
    config.py           pydantic-settings 配置
    database.py         引擎 + Base + get_db
    core/               security(Fernet/token)、colors、timeutil、rate_limit
    models/             users/auth_tokens/games/play_days/achievements/purchases/reviews/screenshots/sync_state
    schemas/            出入参 Pydantic 模型
    api/                auth / openid / calendar / achievements / games / wishlist / sync 路由 + deps
    services/           steam(上游客户端)、session(侧车客户端)、sync_service(采集编排)、aggregation(日历聚合 + ETag)、lifecycle(生命状态派生)、theme(取色)
    cli.py              运维入口：game-calendar-recompute（全库重算生命状态）
    tasks/scheduler.py  每日采集定时任务
  sidecar/              node-steam-user 登录侧车（账号密码 + Steam Guard → 导出 web 会话）
  alembic/              迁移（显式建表的初始迁移，autogenerate 可比对）
  tests/                pytest
  docker-compose.yml    PostgreSQL + API
  Dockerfile
  .env.example          环境变量示例
  run.cmd               Windows 一键启动
```

## 已知取舍（V0.1）

- 主题色：同步期随元数据补全下载封面 → 本地中位切分取色 → 规范化 + 对比度护栏 → 回退 `#6D4AE0`（三级兜底，03 §6）。色值 API（①）仍未接入（无第三方 Key）。
- 竖版封面 `cover_portrait` 直连 CDN `library_600x900`，回退链（横版胶囊裁 2:3 等）由前端处理（03 §4.6 / 07 §5.6）。
- 截图仅缓存缩略图 URL、原图按需拉取；接口非承诺稳定、只能读到公开截图（私密需登录），拿不到时运行日仍由轮询 / 成就支撑。
- 所有时间戳按 **UTC 计日**；购买事件取「首次购买日期」、首玩事件取「最早运行日」近似口径（对齐 PRD §3）。
