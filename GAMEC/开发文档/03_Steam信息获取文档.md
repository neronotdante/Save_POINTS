---
title: Steam 信息获取文档
aliases: [Steam 信息获取, Steam 数据]
tags: [开发文档, Steam]
date: 2026-08-25
---

# Steam 信息获取文档

> 用途：Steam 登录与数据采集的技术细节。产品口径见 [[02_PRD_游戏日历|PRD v1.0]] §3，能力与合规背景见 [[01_调研报告_游戏日历|调研报告]] §3。
> 原则：**登录路线**（取代 API Key + 内部接口抓取）；时间戳以**成就解锁时间**为主，**游戏截图截取时间**（v0.7）作运行日补强。

## 1. 认证路线

- **用户标识**：Steam 客户端协议登录（SteamKit / node-steam-user）→ 拿 **SteamID64** 作为后端唯一用户标识。
- **数据采集**：用户自带 **Web API Key**，登录后引导到 `steamcommunity.com/dev/apikey` 申请并粘贴提交；后端加密存储，用它每日轮询。
- **愿望单 / 私密截图 / 购买历史**由后端用存储的 web session cookie 拉取（用户授权上传、加密存储，见 §9.2）；客户端拉取提交（`/wishlist`）为兜底。
- **登录在谁那（v1.1）**：登录走**后端拉起的 `steam-session` 侧车**（Node 组件；**扫码 QR 为主、账号密码为辅**）；后端弹出 500×500 登录页（非官方页面，页内明示「正在登录第三方 Game_C」）；登录成功后侧车 `getWebCookies()` 导出 web 会话（`sessionid` / `steamLoginSecure`）+ `refresh_token`，后端 Fernet 加密存储，**密码不落盘、不落库、不落日志**。
- 登录需处理：用户名密码 / QR 登录、2FA（Steam Guard）、登录会话维护与续期。

## 2. 登录

| 项 | 方案 A（Tauri/C#） | 方案 B（Node） |
|---|---|---|
| 库 | SteamKit | node-steam-user |
| 2FA | Steam Guard 码 / 移动确认 | 同左 |
| 凭据 | 仅存登录令牌，不存明文密码 | 同左 |

**验证**：先写一个 spike——登录 → 拉愿望单，确认全程可跑通（PRD §7 最高风险项）。

### 2.1 后端登录（v1.1，steam-session 侧车）

> 目标：后端独立完成 Steam 登录，拿到 web 会话（`sessionid` + `steamLoginSecure`）+ `refresh_token`，用于自主拉取愿望单 / 私密截图 / 购买历史。

- **组件**：`sidecar/`（Node + [`steam-session`](https://github.com/DoctorMcKay/node-steam-session)），本地 HTTP 服务；Python 后端通过本地接口调用它，不直接碰 Steam 登录协议。
- **流程**（500×500 登录页，**扫码为主**）：
  1. 后端启动 → 打开 `/login` 登录页 → 页面调 `POST /auth/steam/qr` → 侧车 `LoginSession.startWithQR()` 生成二维码（`qrDataUri`）并展示；
  2. 用户用 **Steam 手机 App 扫码并确认**（密码完全不经过我们）；前端轮询 `GET /auth/steam/poll` → 侧车 `getWebCookies()` 导出 `sessionid` + `steamLoginSecure` + `refreshToken` → Python **Fernet 加密存 `users.session_cookie_enc` / `refresh_token_enc`**，发 opaque token。
  3. 兜底（可选）：账号密码 → Steam Guard 码 → 同样走 `/auth/steam/password` + `/auth/steam/guard` + 轮询 `/auth/steam/poll`。
- **凭据边界**：账号密码只在「登录页 → 侧车」内存中流转一次，**不落盘、不落库、不落日志**；扫码登录则密码根本不经过本系统。落库的只有加密后的会话 cookie + refresh token（见 §9.2）。
- **续期**：cookie 失效时用 `refresh_token` 在侧车 `getWebCookies()` 重新导出；refresh token 也失效则要求重新登录。
- **降级**：侧车不可用 / 登录失败 → 后端照常用 API Key 采集运行日 / 成就 / 公开截图，登录态数据降级为空。

## 2a. 分层登录与公开数据优先（v1.2，2026-08-28 定案）

> 背景：对照 iRacing 等第三方站点的「通过 Steam 登录」按钮，确认是标准 **Steam OpenID 2.0**——用户密码全程留在 `steamcommunity.com`，第三方只拿到签过名的 SteamID64，不产生任何可读私密数据的会话。据此把登录拆成两层，缩小 §10「登录链路」这项最高风险 spike 的默认命中面。反过来，小黑盒等同类产品的账密绑定流程（App 内直接输入 Steam 账号密码 + 邮箱验证码）印证了 Layer 2 仍必须存在——愿望单 / 购买历史 / 私密截图这三类数据官方就没有开放给第三方免密获取。

**Layer 1（默认，所有用户）—— Steam OpenID 2.0**

- 新增 `GET /auth/steam/openid/login`（302 到 `steamcommunity.com/openid/login`）与 `GET /auth/steam/openid/callback`（收参数、原样 POST 回 `openid.mode=check_authentication` 验签、从 `claimed_id` 正则取 SteamID64）。全程零密码、零侧车依赖。
- 建号 + 发 opaque token，复用 §2.1 `_issue_session` 的建号 / 发 token 逻辑，但不写 `session_cookie_enc` / `refresh_token_enc`（留空，等 Layer 2 补）。
- 拿到 SteamID64 后引导用户去 `steamcommunity.com/dev/apikey` 提交自己的 Web API Key（`POST /auth/apikey`）——这一步本就独立于登录方式：运行日历 / 成就 / 游戏库（`GetRecentlyPlayedGames` / `GetPlayerAchievements` / `GetOwnedGames`）只吃 `apikey`，不吃 session cookie，Layer 1 单独即可解锁。

**Layer 2（可选，opt-in）—— 现有 §2.1 steam-session 侧车**

- 流程不变；仅当用户主动要看愿望单 / 购买历史 / 私密截图时触发，登录页 / 前端标注「解锁完整数据」。

**数据源按「能否在对方资料公开时免密拿到」重新分组**（§3 明细同步更新）：

| 数据 | Layer 1（OpenID + 用户自己的 Key）能拿到吗 | 说明 |
|---|---|---|
| 昵称 / 头像 | 能 | `GetPlayerSummaries` + Key |
| 运行日历 / 成就 / 游戏库 | 能（前提：对方「游戏详情」隐私为公开） | 只吃 apikey，见上 |
| **愿望单** | **能（前提：愿望单隐私为公开）** | 改走官方 `IWishlistService/GetWishlist`，**免 Key、免登录，任意 SteamID 可查**；私密愿望单查不到，降级 Layer 2 |
| **截图** | **能（公开截图）** | 社区截图接口本就支持无 cookie 读公开项（§4.5 已写明「公开截图无需登录可读」）；仅好友 / 私密才需要 Layer 2 |
| 购买历史 | **不能** | Steam 不对外公开任何人的交易记录，无公开路径，唯一入口是 Layer 2 的 web session cookie |

⚠️ **代码现状核对（2026-08-28）**：`backend/app/services/steam.py::get_wishlist` 目前打的是 `store.steampowered.com/wishlist/profiles/{steamid}/wishlistdata/`——这个内部接口已于 2024 年 11 月前后被 Steam 废弃，与本文档 §3 早先就写的 `IWishlistService/GetWishlist` 本不一致，**属代码漂移，需按本节改法补，非本次新引入的改动**。

## 3. 数据源清单

| 数据             | 来源 / 协议                                                   | 认证           | 关键字段                                                    | 用途             |
| -------------- | --------------------------------------------------------- | ------------ | ------------------------------------------------------- | -------------- |
| 愿望单            | `IWishlistService/GetWishlist`                            | 公开优先：免 Key / 仅 SteamID，私密愿望单降级 Layer 2（见 §2a） | appid、priority                                          | F-2 同步         |
| 元数据 / 发售日 / 封面 | Store API `appdetails`（`l=schinese`、`cc=cn`）              | 无 Key        | 名称、发售日、封面、开发商                                           | 元数据补全          |
| 首次游玩时间         | `IPlayerService/ClientGetLastPlayedTimes`（steamclient 方法） | 登录           | `first_playtime`、`last_playtime`                        | FirstPlay      |
| 成就解锁时间         | `ISteamUserStats/GetPlayerAchievements`                   | 登录 / API Key | 每个成就的 `unlocktime`                                      | 可选增强（需 Key）     |
| 游戏主题色          | ① 色值 API（如 SteamGridDB 主色字段）→ ② 本地封面取色 → ③ 回退 `#6D4AE0`   | —            | 主色 hex                                                  | P-11 成就色标      |
| 游戏截图（v0.7 新增） | 社区截图接口 `profiles/{steamid}/screenshots/`（`sort=newestfirst&browsefilter=myfiles&view=grid`，`xml=1`/`json=1`） | 公开优先：公开截图免登录；仅好友 / 私密需 Layer 2（见 §2a） | `appid`、`rtime_created`（截取时间）、文件名 `YYYYMMDDHHMMSS`、`url`/`thumbnail_url`、`privacy`、`caption` | 运行日补强 + 日详情缩略图 |
| 购买时间（v0.9 新增） | 商店购买历史页 `/account/history/`（HTML 抓取，web cookie） | 登录（session cookie，**无公开路径，Layer 2 唯一刚需**，见 §2a） | 交易日期、物品(appid/subid)、付款方式、金额 | PurchaseRecord |

> 已不做：`localconfig.vdf` 会话监听、进程监听、`GetOwnedGames` 每日差分（会话级采集整体砍掉）。
> **主来源已改为「每日轮询 `GetRecentlyPlayedGames` → 运行天数」**，游玩时长不作为核心指标；首次游玩时间（`first_playtime`）放弃、成就解锁时间降为可选；**v0.7 新增「游戏截图截取时间」作为第三路运行日来源**，详见 [[04_Steam信息获取技术验证文档|Steam 验证文档]]。

## 4. 关键协议 / 接口注意点

### 4.1 购买历史页（购买时间，v0.9 新增）

> **「入库时间」与「购买时间」拆开**：旧 `CMsgClientLicenseList.time_created` 是「许可证入库 / 激活时间」（TCP 协议）——**已放弃**。**购买时间**改走**商店购买历史页**：给的是真实交易（支付）时间，比入库时间更贴合「购买」。本质是**「授权代取本人数据」的爬虫**——用户授权后端用其会话 cookie 读本人页面，非官方接口，Provider 抽象 + 防御式解析 + 优雅降级（与截图接口 §4.5 同款）。

- **端点**：`https://store.steampowered.com/account/history/?l=english&p={页}`，返回 **HTML 表格（非 JSON）**；需 **web session cookie**（`sessionid` + `steamLoginSecure`）。先强制 `l=english` 让日期格式稳定（否则要同时解析「2024年1月15日」「Jan 15, 2024」两套）。
- **一行 = 一笔交易，可含多款游戏**，逐 `<a>` 拆成多条 `purchase_record`。字段：`wallet_date`（交易日期，**仅日粒度，无时分秒**）、物品链接（app/sub）、`wallet_column`（付款方式）、`wallet_total`（金额，V0.1 不存）。
- **appid 映射回退链**（主要工作量，非时间本身）：
  1. `/app/{appid}/` 链接 → 直接取 appid；
  2. `/sub/{subid}/` 链接（DLC / 捆绑包 / 豪华版）→ `PICSGetProductInfo` 把 subid 展开成含哪些 appid；
  3. 纯文本无链接（下架 / 老游戏）→ 游戏名走 Store 搜索反查 appid（有歧义，命中率非 100%）。
- **边界**：退款行跳过；免费领取 / 礼物保留（`payment_method` 记「礼物」）；**Key 激活（CD key 兑换）不在购买历史页**（在 `/account/licenses/`），不覆盖；分页 `p=1` 递增，遇空页 / 重复停；页面改版 → 解析降级，不影响其他源。

**数据示例**（一行含两游戏）：

```html
<tr>
  <td class="wallet_date">Jan 15, 2024</td>
  <td>
    <a href=".../app/1245620/">艾尔登法环</a>
    <a href=".../sub/654321/">HELLDIVERS™ 2 超级公民版</a>
  </td>
  <td class="wallet_column">支付宝</td>
  <td class="wallet_total">¥ 466.00</td>
</tr>
```

解析 + appid 映射 → 落库 `purchases`：`1245620`（app 链接直取）；`654321`（sub 链接，需 PICS 展开为具体 appid）→ 各写一条 `time_created=2024-01-15 00:00:00`、`payment_method=支付宝`。

### 4.2 `ClientGetLastPlayedTimes`（首次游玩）

- 属 **steamclient 客户端协议方法**（`steammessages_player.steamclient`），**需登录**，不是 Web API gateway。
- 返回 `first_playtime`（首次游玩时间戳）、`last_playtime`、分平台（Windows/Mac/Linux/Deck）首次/最后游玩、`playtime_disconnected`。

### 4.3 `GetPlayerAchievements`（成就时间戳）

- 返回某游戏全部成就及各自 `unlocktime`；**仅覆盖有成就且确实解锁的时段**，刷完成就后的游玩看不到。
- 密集解锁时间簇 = 一次游玩；稀疏单点 = "这天玩过"。是唯一能回溯到过去的时间证据。

### 4.3a 成就展示三件套（v0.8 新增，供时点悬浮 panel 成就形态用）

时间轴悬浮成就簇要显示**名称 / 解锁率 / 所属游戏**（[[07_视图范式_游戏日历|07]] §4.8），单靠 `GetPlayerAchievements` 不够，需三个来源拼：

| 要素 | 接口 | 需要 Key | 关键字段 |
|---|---|---|---|
| 解锁时间 | `ISteamUserStats/GetPlayerAchievements/v1` | 是 | `apiname`、`achieved`、`unlocktime` |
| **名称 / 图标** | `ISteamUserStats/GetSchemaForGame/v2`（`appid`、`l=schinese`） | **是** | `name`（API 名）、`displayName`（展示名）、`description`、`icon` / `icongray`（CDN URL） |
| **全球解锁率** | `ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2`（`gameid`） | **否** | `name`（API 名）、`percent`（float，0–100） |

- **三者靠 API 名关联**：`GetPlayerAchievements.apiname` = schema 的 `name` = 百分比表的 `name`。展示名只在 schema 里，解锁率只在百分比表里，缺一不可。
- **所属游戏**不来自成就接口，用本地 `games` 表按 `appid` 取（名称 + 封面 + 主题色）。
- 公开主机为 `api.steampowered.com`（Steamworks 文档里写的是 `partner.steam-api.com` 合作方镜像）。
- **入库**：`achievement` 表补 `display_name`、`icon_url`、`global_percent`、`percent_at`；解锁率随每日同步刷新（变化慢，可低频），schema 按 appid 缓存、随封面一起更新。

### 4.4 Store API（元数据）

- 必须本地缓存 + 429 指数退避；元数据缓存 30 天，价格缓存 6~24 小时（V0.1 无价格，可只缓存元数据）。
- 中文名覆盖不全时接受英文名（PRD 已决策）。

### 4.5 截图接口（v0.7 新增，运行日补强）

- **端点**：`https://steamcommunity.com/profiles/{steamid}/screenshots/?appid={appid}&sort=newestfirst&browsefilter=myfiles&view=grid&xml=1`（部分实现用 `json=1`），分页 `p=1` 递增；这是**社区内部接口**（与 `IWishlistService` 同类），**非官方 Web API、不承诺稳定**，需 Provider 抽象 + 优雅降级。
- **关键字段**：`appid`、`rtime_created`（截取 / 上传时间，Unix 秒级）、`id`、`filename`、`url` / `thumbnail_url`（`steamuserimages` / `steamusercontent.com`）、`privacy`（0 公开 / 1 仅好友 / 2 私密）、`caption`。
- **文件名即时间戳**：Steam 截图文件名形如 `YYYYMMDDHHMMSS_序号.jpg`，当 `rtime_created` 缺失时从文件名解析截取时间兜底。
- **隐私**：公开截图无需登录可读；仅好友 / 私密需登录（私密仅本人）；用户可关闭云端上传或删除截图，**覆盖不保证完整**。
- **取数口径**：按 `appid` + 截取日期聚簇 → 派生 `PlayDay` 运行日；只缓存**缩略图**（原图按需拉取），避免存储膨胀。

### 4.6 图片规格（v0.8 新增，前端取值依据）

Steam 官方**上传**尺寸（Steamworks 商店素材文档）：

| 素材 | 上传尺寸 | 比例 | 前端用途 |
|---|---|---|---|
| **库容量（Library capsule）** | **600 × 900** | **2:3** | **时点悬浮 panel 的封面**（96 × 144）与列表行封面（46 × 62），[[07_视图范式_游戏日历\|07]] §4.8 |
| 头图（Header capsule） | 920 × 430 | ≈2.14:1 | 暂不使用（与截图 16:9 并存会出现第二套比例） |
| 小容量（Small capsule） | 462 × 174 | ≈2.66:1 | 不使用 |
| 主容量（Main capsule） | 1232 × 706 | ≈1.75:1 | 不使用 |
| 竖版容量（Vertical capsule） | 748 × 896 | ≈1:1.2 | 不使用 |
| **截图** | **≥ 1920 × 1080** | **16:9** | 轴下方缩略图 96 × 54（16:9 一致，等比缩放不裁切） |
| **成就图标** | Valve 建议 **256 × 256**（历史规范 64 × 64），另有灰度未解锁版 | 1:1 | 成就 panel 行图标 32 × 32；实际下发尺寸随开发者上传件，前端固定渲染尺寸 |

- CDN 实际下发的路径与尺寸（`header.jpg` 460 × 215、`library_600x900.jpg`、`capsule_231x87.jpg` 等）**未经本项目核实**，属 §7 spike 待办：拉 3 个 appid 实测下发尺寸与命中率，再决定缓存哪一档。
- 社区截图接口的 `thumbnail_url` 下发尺寸同样待实测；若缩略图短边不足 54，改用 `url` 原图前端缩放。
- 封面缺失时走 05 §5「封面占位」：主题色双色渐变 + 缩写，比例同样按 2:3。

### 4.7 `GetOwnedGames`（总时长，v0.8 新增，仅供封盘判定）

- `IPlayerService/GetOwnedGames/v1`（`steamid`、`include_appinfo=1`、`include_played_free_games=1`），**要 Key**。
- 关键字段：`appid`、`playtime_forever`（分钟，全平台累计）、`playtime_windows_forever` 等分平台字段、**`rtime_last_played`（最后一次启动时间，Unix 秒）**。
- **`rtime_last_played` 是封盘判定的主判据**：它比本地三路来源（运行日 / 成就 / 截图）更直接——玩了但没解锁成就、没截图、又不在轮询窗口里的那次启动，只有它记得。判定时与本地三路取 `max`（PRD §3）。
- **用途边界**：只喂 PRD §3 的封盘判定（`T_time`）。**不作为界面指标**——「玩得久不久」在界面上只有 P-9 的运行天数一个口径，两个口径同时出现会互相拆台（时长长但只玩过 3 天 / 时长短但断续玩了两年，都会让用户不知道信哪个）。
- 它同时是 `launched_ever` 的兜底：`playtime_forever > 0` 但本地三路来源都没记录（成就 / 截图 / 轮询开始之前就玩完了），仍算**启动过**，不该被 P-14 的开关隐藏。
- 每日同步拉一次即可（全库一次返回，无需分页）。

## 5. 数据模型映射（→ PRD §3）

| Steam 数据 | 落库表 |
|---|---|
| `ClientGetLastPlayedTimes.first_playtime` | `first_play.first_playtime` |
| `GetPlayerAchievements.unlocktime` | `achievement_unlock.unlocktime` |
| `GetWishlist` appid + Store API 发售日 | `game.status`（含 `released_wishlist` 归档） |
| 主题色 API / 本地取色 | `game.theme_color` / `theme_color_source` / `theme_color_at` |
| 截图接口 `rtime_created` / 文件名时间戳 | `screenshot.taken_at`（按日聚簇派生 `play_day`） |
| 购买历史页 交易日期 / 付款方式 | `purchase_record.time_created`（日粒度）/ `payment_method` |

## 6. 主题色取色链路（UI 规范 §3.4，同步期执行）

1. **① API**：第三方 / 官方色值接口，按 appid 批量取，命中即用。
2. **② 本地**：缓存封面缩放到 64×64 → 丢弃 `L<12%` / `L>92%` 像素 → 中位切分 / k-means（k=3）取覆盖率最高簇。
3. **③ 回退**：前两级失败或封面近灰度（`S<12%`）时用 `#6D4AE0`。
4. **规范化**：转 HSL（H 不变）→ `S∈[35%,85%]`、`L∈[32%,50%]` → 对比度 ≥3:1（不足按 4% 步长降 L，下限 24%，仍不足用回退色）。
5. **同日去重**：当日成就簇按数量降序取前 3 游戏各画一点；两游戏规范化后色相差 <20° 时第二个 `L−8%`，仍冲突用回退色。
6. **缓存**：随封面一起入库，同步期算一次，渲染期只读。

## 7. 同步流程

```
登录 → 拉愿望单(GetWishlist) → 逐 appid 补元数据/封面(Store API, 缓存+退避)
     → 拉首次游玩(ClientGetLastPlayedTimes) → 入库 first_play
     → 逐游戏拉成就(GetPlayerAchievements) → 入库 achievement_unlock
     → 拉截图元数据(社区截图接口, 按 appid 分页) → 入库 screenshot，按日聚簇派生 play_day
     → 拉购买历史(account/history, web cookie) → appid 映射 → 入库 purchase_record
     → 主题色：API 批量取 → 未命中本地取色 → 回退；规范化后入库
     → 写 sync_meta（游标/时间戳）
```

- 增量同步：愿望单与元数据按需；时间戳类（首玩 / 成就）以游标 / 去重键增量，避免重复全量。
- 失败降级：单源失败不阻塞整体，UI 显示同步状态；已缓存数据照常渲染（PRD 优雅降级原则）。

## 8. 限流 / 缓存 / 错误处理

- Store API：本地缓存 + 429 指数退避 + 单次同步限流；失败不阻塞 UI。
- 成就 / 首玩：登录态失效时提示重新登录，数据用本地缓存兜底。
- 截图：接口非承诺稳定 → 分页限流 + 本地缩略图缓存 + 失败不阻塞；拿不到时运行日仍由轮询 / 成就支撑。
- 购买历史：HTML 抓取非承诺稳定 → 分页限流 + 防御式解析 + 失败不阻塞；Key 激活 / 无 appid 行降级跳过。
- 主题色：三级兜底，永不因取色失败而阻塞渲染（回退色兜底）。

## 9. 合规红线（调研 §3.1，必须遵守）

1. **不碰 SteamDB**（自动封 IP）。
2. **账号密码 / 客户端协议登录凭据（SteamKit login ticket、Steam Guard 令牌）本地加密，绝不上传、不硬编码**。**Web 会话 cookie（`sessionid` / `steamLoginSecure`）与 `refresh_token` 经用户明确授权后可上传后端、Fernet 加密存储**，仅用于采集该用户自己的 Steam 数据（愿望单 / 私密截图 / 购买历史），并提供「解绑 / 吊销」出口。⚠️ v0.9 决策：此条为对旧「凭据绝不上传」红线的**唯一例外**——服务端存会话是第三方工具的灰色做法，存在 Steam 风控 / 账号标记风险，自托管场景自担，公开多用户必须在隐私政策中明示。
3. **Store API 必须缓存**，不频繁抓取。
4. 分享只输出用户自己的数据（X-3 延后，V0.1 无分享）。

## 10. 验证清单（对齐 PRD §7）

| 项 | 风险 | 验证 |
|---|---|---|
| OpenID 验签（Layer 1，默认路径） | 低 | 拉一次真实 openid 回调，核对 `check_authentication` 返回 `is_valid:true`、SteamID64 提取正确 |
| steam-session 侧车登录（Layer 2，含 2FA / 续期，opt-in 触发） | 高 | 登录 spike → 拉愿望单 |
| `first_playtime` 有值 | 中 | 登录后调一次看返回 |
| 成就 `unlocktime` 覆盖密度 | 中 | 3 款老游戏看分布 |
| 色值 API 命中率 + 规范化达标率 | 中 | 50 个 appid 抽样 |
| 截图接口返回截取时间 / 缩略图 + 隐私 / 分页 | 中 | 拉自己截图列表核对 `rtime_created` 与文件名时间戳 |
| 购买历史页返回交易日期 / 物品 / 付款方式，appid 映射命中率 | 中 | 拉自己购买历史核对日期粒度、sub→appid 展开、退款行识别 |
