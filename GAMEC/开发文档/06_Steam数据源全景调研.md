---
title: Steam 数据源全景调研
aliases: [Steam 数据源全景, 状态类数据调研]
tags: [开发文档, Steam, 调研]
date: 2026-09-07
---

# Steam 数据源全景调研

> 问题：除了**成就解锁时间**与**截图截取时间**，Steam 还有哪些「属于某个用户、带时间戳、能绑到具体游戏」的状态类数据，可以落到时间轴上？
> 方法：不依赖二手博客，直接取三份一手材料交叉核对——
> 1. `ISteamWebAPIUtil/GetSupportedAPIList`（官方自述的公开接口子集，实测拉取）；
> 2. [xPaw/SteamWebAPIDocumentation `api.json`](https://github.com/xPaw/SteamWebAPIDocumentation)（**209 个接口**的全量表面，含未文档化接口的请求参数与 documented/undocumented 标记）；
> 3. [SteamDatabase/Protobufs](https://github.com/SteamDatabase/Protobufs) 的 `webui/*.proto` 与 `steam/*.proto`（**返回字段**的权威来源——官方文档只列请求参数，不列返回结构）；
> 外加 [SteamRE/SteamKit `enums.steamd`](https://github.com/SteamRE/SteamKit) 取枚举值、`curl` 实测认证行为。
> 上游：数据源现状见 [[03_Steam信息获取文档|03]] §3，已验证结论见 [[04_Steam信息获取技术验证文档|04]] §1。

## 0. 一句话结论

**同类数据比现在用的多得多，且有两个直接推翻既有结论的发现：**

1. **项目 §4.5 用的那个「非官方、不承诺稳定」的社区截图接口，有官方 Web API 等价物**——`IPublishedFileService/GetUserFiles`，已文档化、吃 API Key、支持时间范围增量，而且一个接口把截图 / 视频 / 艺术作品 / 指南 / 创意工坊物品 / **游戏录像剪辑**全都返回。
2. **[[04_Steam信息获取技术验证文档|04]] §2 判定「放弃」的首次游玩时间（`first_playtime`），在年度回顾接口里能拿到**——`ISaleFeatureService/GetUserYearInReview` 的 `CGameSummary.rtime_first_played_lifetime` 是终身首玩时间，不需要发行商密钥。

## 1. 认证分层（决定每个数据源落在 Layer 1 还是 Layer 2）

`api.json` 对每个方法标了 `documented` / `undocumented`，这个标记和认证方式高度相关，正好对上 [[03_Steam信息获取文档|03]] §2a 的分层：

| 类别 | 认证 | 落在 | 实测 |
|---|---|---|---|
| **documented** 接口（`GetBadges`、`GetUserFiles`、`GetFriendList`、`GetTradeHistory`…） | 用户自己的 **Web API Key** | **Layer 1**（OpenID + 用户提交 Key） | `GetUserFiles` 无 key → **HTTP 401 Unauthorized**（已实测） |
| **undocumented** 的 webui service 接口（`GetUserNews`、`GetUserYearInReview`、`EnumerateUserFiles`、`GetNotesForGame`…） | 浏览器用的 **`access_token`**（登录态 JWT），非 API Key | **Layer 2**（web session） | `ICloudService/EnumerateUserFiles` 的参数表里直接写着 `access_token`，是这条规律的自证 |
| 免认证 | 无 | 任意 | `IWishlistService/GetWishlist` 无 key → **HTTP 200**（已实测，印证 [[04_Steam信息获取技术验证文档|04]] §3a 的订正） |

**取 `access_token` 的路径**（Layer 2 已有 session cookie，可顺带取，无需额外授权）：

```
GET https://store.steampowered.com/pointssummary/ajaxgetasyncconfig   （带 sessionid + steamLoginSecure）
→ {"success":1,"data":{"webapi_token":"eyJ…"}}
```

实测无 cookie 时返回 `{"success":1,"data":[]}`（路径有效、data 为空），带 cookie 时 `data.webapi_token` 即所需 token。**这一步是解锁下面整个 B 级清单的钥匙**，成本只有一次 GET。

## 2. A 级——建议接入，Layer 1 即可（官方文档化 + 吃用户 Key）

### 2.1 `IPublishedFileService/GetUserFiles`：UGC 全家桶（**优先级最高**）

一个接口覆盖用户发布的**全部 UGC**，`PublishedFileDetails.file_type` 的取值来自 `EWorkshopFileType`（SteamKit `enums.steamd`，已核对）：

| `file_type` | 含义 | 与本项目的关系 |
|---|---|---|
| 5 | **Screenshot 截图** | 就是 [[03_Steam信息获取文档\|03]] §4.5 现在抓 HTML/XML 拿的那批数据 |
| 4 | Video 视频 | 同类，未接入 |
| 3 | Art 艺术作品 | 同类，未接入 |
| 9 / 10 | WebGuide / IntegratedGuide 指南 | 同类，未接入 |
| 2 | Collection 收藏集 | 同类，未接入 |
| 0 / 1 | Community / Microtransaction 创意工坊物品 | 同类，未接入 |
| **16** | **Clip 游戏录像剪辑** | Steam Game Recording 的剪辑，**与截图完全同源同质**，未接入 |

**关键返回字段**（`PublishedFileDetails`）：`publishedfileid`、`consumer_appid`、`creator_appid`、**`time_created`**、**`time_updated`**、`title`、`preview_url` / `image_url` / `image_width` / `image_height`、`visibility`、`file_type`、`time_subscribed`。

**请求侧有两个当前实现拿不到的能力**：

- **`date_range_created` / `date_range_updated`**——按创建/更新时间范围过滤，天然适配增量同步游标，不用像现在这样翻页翻到重复为止；
- `appid`、`privacy`、`sortmethod`、`numperpage` 分页，以及 `totalonly` / `ids_only` 轻量模式。

> **对项目的直接影响**：[[03_Steam信息获取文档|03]] §4.5 写的「社区内部接口、非官方 Web API、不承诺稳定，需 Provider 抽象 + 优雅降级」，其风险来源可以直接消除——换成官方接口，同时白捡视频 / 剪辑 / 艺术作品 / 指南四类新事件。建议把它作为主路径，社区 XML 接口降为兜底（补私密项）。

### 2.2 `IPlayerService/GetBadges`：徽章获得时间

- 官方文档化（`partner.steam-api.com/IPlayerService/GetBadges/v1/`，参数仅 `key` + `steamid`，已核对官方文档页）。
- 返回（官方文档不列返回结构，以下为社区长期实测口径，**接入前需实测复核**）：`badges[]` 每项含 **`completion_time`**（获得时间，Unix 秒）、**`appid`**（游戏徽章所属游戏）、`badgeid`、`level`、`xp`、`scarcity`、`communityitemid`；外层含 `player_level`、`player_xp`。
- **性质与成就高度一致**：一个「在某天、因为某款游戏、完成了某件事」的离散事件，且**天然带等级**（徽章 1→5 级），可以直接复用成就的时点渲染形态。
- 局限：徽章靠集换式卡片合成，**不是玩就有**，覆盖稀疏；且 `completion_time` 是「合成徽章那一刻」，不等于「玩那款游戏那一刻」——**只能当独立事件展示，不能当运行日证据**。

### 2.3 其它 documented 接口

| 接口 | 时间戳 | 说明 |
|---|---|---|
| `ISteamUser/GetFriendList` | `friend_since` | 加好友时间；与游戏无关，属社交事件 |
| `IEconService/GetTradeHistory` | 交易时间 | 支持 `start_after_time` 游标；物品级，游戏关联弱 |
| `IPublishedFileService/GetUserFileCount` | — | `GetUserFiles` 的轻量计数版，可用于同步前判断增量 |

## 3. B 级——需 Layer 2（`access_token`），信息密度最高

### 3.1 `IUserNewsService/GetUserNews`：**官方的统一事件流**

这是本次调研最契合「和成就、截图类似的状态信息」这个问法的答案——**Valve 自己就把这些事件统一建模了**：

```protobuf
message CUserNews_Event {
    optional uint32 eventtype = 1;          // 事件类型
    optional uint32 eventtime = 2;          // 事件时间 ← 统一时间戳
    optional fixed64 steamid_actor = 3;
    optional fixed64 gameid = 5;            // 关联游戏
    optional uint32 packageid = 6;
    repeated string achievement_names = 8;  // 成就事件：解锁了哪些成就
    optional fixed64 publishedfileid = 11;  // UGC 事件：截图/视频/指南 id
    repeated uint32 appids = 13;
    optional uint32 event_post_time = 14;
}
```

请求侧支持 **`starttime` / `endtime` / `filterappid` / `filterflags` / `count`**——即**按时间窗口拉取用户全部事件**，正是时间轴需要的取数形状。

**响应还附带 `achievement_display_data`**：`display_name`、`display_description`、`icon`、`unlocked_pct`、`hidden`。

> **对项目的直接影响**：[[03_Steam信息获取文档|03]] §4.3a 现在要靠 `GetPlayerAchievements` + `GetSchemaForGame` + `GetGlobalAchievementPercentagesForApp` **三个接口按 API 名关联**才能拼出「成就名 + 解锁率 + 所属游戏」；`GetUserNews` **一个响应里就带齐了**（展示名 + 图标 + 全球解锁率）。若 Layer 2 已开通，成就展示链路可大幅简化。

**待实测**：`eventtype`（`EUserNewsType`）与 `filterflags`（`EUserNewsFilterFlags`）的具体枚举值**未能从一手材料核实**——不在 SteamKit `enums.steamd`，也不在已公开的 proto 里（Valve 只在社区前端 bundle 里定义）。接入时的稳妥做法：**不传 `filterflags`，先拉一段时间窗口，按实际返回的 `eventtype` 取值反推映射**再固化。

### 3.2 `ISaleFeatureService/GetUserYearInReview`：年度回顾（**回溯覆盖率最高**）

Steam 年度回顾（Replay）背后的接口。返回结构（`webui/service_salefeature.proto`）里对本项目有价值的：

| 字段路径 | 含义 | 为什么重要 |
|---|---|---|
| `CGameSummary.rtime_first_played_lifetime` | **该游戏的终身首次游玩时间** | **直接推翻 [[04_Steam信息获取技术验证文档\|04]] §2「first_playtime 放弃」的结论**——不需要发行商密钥 |
| `CGamePlaytimeStats.rtime_first_played` | 该年该游戏首玩时间 | 同上，年内口径 |
| `CPlaytimeStreak.longest_consecutive_days` + `rtime_start` | **最长连续游玩天数 + 起始日** | 项目核心指标就是「运行天数」，这是官方口径的现成答案 |
| `CMonthlyPlaytimeStats.rtime_month` + `game_summary[]` | **逐月 × 逐游戏**的游玩明细 | **回溯覆盖率 100%**：不依赖用户解锁成就、也不依赖用户截图，只要玩过就有。粒度是月，但补齐了成就/截图两路都覆盖不到的「静默游玩」 |
| `CGameSummary` 的 `new_this_year` / `played_deck` / `played_vr` / `played_controller` / `total_sessions` / `rtime_release_date` | 该年首次接触、设备类型、会话数 | 可作为时点/游戏卡片的补充标签 |
| `CPlaytimeByNumbers` | 见 §5 | Valve 官方的「用户行为分类学」 |

**配套三个接口**：

- `GetUserYearAchievements`：`CAchievementDetails.rtime_unlocked` + `achievement_name_internal`，年度成就解锁时间（`GetPlayerAchievements` 的年度视图）；
- `GetUserYearScreenshots`：按 appid 分组的年度截图（`image_url` / `preview_url` / 尺寸 / `visibility`）；
- `GetYIRCurrentMonthlySummary`：**当年当月**的 `games_played` / `top_played_appid` / **`longest_streak_days`** / `rt_streak_start` / `achievements` / `screenshots`——不用等年底，**每月都能拉**。

**限制**：年度数据由 Valve 侧生成，历史年份可用性、`force_regenerate` 的实际行为、以及 `privacy_state` 对他人可见性的影响，**均需实测**。

### 3.3 `ICloudService/EnumerateUserFiles`：云存档写入时间（**潜在的第四路运行日证据**）

```protobuf
message CCloud_UserFile {
    optional uint32 appid = 1;
    optional string filename = 3;
    optional uint64 timestamp = 4;   // ← 存档写入时间
    optional uint32 file_size = 5;
}
```

- **`timestamp` 是「那天确实在玩这款游戏」的硬证据**，而且**不依赖用户主动做任何事**——不用截图、不用解锁成就，存档是游戏自己写的。对「玩了但没解锁成就、也没截图」这个 [[03_Steam信息获取文档|03]] §4.7 专门讨论的盲区，这是比 `rtime_last_played` 更细的填补（`rtime_last_played` 每游戏只有一个值，云存档是逐文件多点）。
- **代价**：`appid` 是请求参数，**需逐游戏调用**，全库扫一遍成本高；且只覆盖启用了 Steam Cloud 的游戏，存档也可能被覆盖写（只保留最后一次时间）。
- 建议：不做全库扫描，只对「已判定为近期在玩」的少量游戏调用，作运行日补强。

### 3.4 `IUserGameNotesService`：游戏笔记

```protobuf
message CUserGameNote {
    optional uint32 appid = 2;
    optional uint32 time_created = 6;
    optional uint32 time_modified = 7;
    optional string title = 8;
    optional string content = 9;
}
```

- `GetGamesWithNotes` 先拿「哪些游戏有笔记」（含 `last_modified`、`note_count`），再 `GetNotesForGame` 拿逐条。
- **形态与截图高度一致**：用户主动产生、带 appid、带秒级时间戳、有可展示内容（标题+正文）。是时间轴上「这天我在这款游戏里记了点什么」的天然素材，**且是用户自己写的字，展示价值高于截图**。

### 3.5 `IUserReviewsService/GetIndividualRecommendations`：评测

`RecommendationDetails` 字段极全：`appid`、**`time_created`** / **`time_updated`**、`voted_up`、`review`、**`playtime_at_review`**（写评测时的游玩时长）、`written_during_early_access`、`votes_up` / `votes_funny`、`time_developer_responded`。

- 「写了一篇评测」是明确的里程碑事件，比截图更有叙事分量。
- `playtime_at_review` 还能反推「写评测时玩了多久」，是时间轴上一个信息量很高的注脚。
- 公开评测另有免登录路径：商店 `appreviews` 接口（按 appid 查，含 `timestamp_created`）。

## 4. C 级——边缘/补充

| 数据 | 来源 | 时间戳 | 判断 |
|---|---|---|---|
| **许可证激活时间** | `store.steampowered.com/account/licenses/`（HTML，web cookie） | 激活日期 | **补 [[03_Steam信息获取文档\|03]] §4.1 明确未覆盖的缺口**：CD Key 兑换、免费领取不在购买历史页，在这里 |
| 社区市场买卖 | `/market/myhistory`（内部接口） | 成交时间 | 与游戏关联弱（是物品不是游戏） |
| 头像更换历史 | `ICommunityService/GetAvatarHistory` | `timestamp` | 与游戏无关，纯个人时间线；`filter_user_uploaded_only` 可只看自传图 |
| 卡片掉落数 | `IQuestService/GetNumTradingCardsEarned` | `timestamp_start` / `timestamp_end` 入参 | **只返回计数，无逐张时间**，不能落点 |
| 社区物品库存 | `IQuestService/GetCommunityInventory` | 无时间戳 | 有 `appid` 和 `item_type`，但拿不到获得时间 |
| Steam 通知 | `ISteamNotificationService/GetSteamNotifications` | 有 | 系统通知，非用户行为 |
| 视频书签 | `IVideoService/GetVideoBookmarks` | 有 | 极边缘 |

### 一个值得记录的「Steam 有但不给你」

`IPlayerService/GetRecentPlaytimeSessionsForChild` 返回的是**真正的会话级记录**：

```protobuf
optional uint32 time_start = 1;   // 精确到秒的开始
optional uint32 time_end = 2;     // 精确到秒的结束
optional uint32 appid = 3;
optional uint32 device_type = 4;
```

**这证明 Valve 服务端确实存着逐次启动的会话数据**——但接口名里的 `ForChild` 说明了一切：只有 Steam 家庭组的**家长查看孩子账号**时可用，**本人查自己拿不到**。本项目要的「运行日」在 Steam 后台是现成的，只是不开放；这也解释了为什么 [[04_Steam信息获取技术验证文档|04]] §3 只能靠成就/截图/轮询三路去**拼**它。

## 5. Valve 自己的「用户状态事件」分类学

年度回顾里的 `CPlaytimeByNumbers`，等于 Valve 官方给出的「一个用户一年会产生哪些状态事件」的完整枚举，可直接当作本项目数据源的选型清单来对照：

```protobuf
screenshots_shared      // 截图        ← 已接入
written_reviews         // 评测        ← §3.5
guides_submitted        // 指南        ← §2.1（file_type 9/10）
workshop_contributions  // 工坊投稿    ← §2.1（file_type 0/1）
badges_earned           // 徽章        ← §2.2
friends_added           // 加好友      ← §2.3
gifts_sent              // 赠礼
loyalty_reactions       // 点数反应
forum_posts             // 论坛发帖
workshop_subscriptions  // 工坊订阅    ← PublishedFileDetails.time_subscribed
```

> 换句话说：**项目现在只用了这张表里的第 1 项**（截图）**加上表外的成就**。

## 6. 对现有文档的修订建议

| 现有结论 | 位置 | 建议 |
|---|---|---|
| 截图走「社区内部接口、非官方、不承诺稳定」 | [[03_Steam信息获取文档\|03]] §4.5 | 改为**官方 `GetUserFiles` 为主路径**，社区 XML 降为私密项兜底；顺带接入视频/剪辑/指南/艺术作品 |
| 成就展示需三接口拼装 | [[03_Steam信息获取文档\|03]] §4.3a | Layer 2 开通时可用 `GetUserNews` 一次拿齐（展示名+图标+解锁率），三接口降为 Layer 1 路径 |
| 「首次游玩时间放弃」 | [[04_Steam信息获取技术验证文档\|04]] §2、§3 | **订正**：`GetUserYearInReview` 的 `rtime_first_played_lifetime` 可得，无需发行商密钥（Layer 2） |
| 运行日靠三路来源 | [[04_Steam信息获取技术验证文档\|04]] §3 | 可扩为**五路**：+ 云存档 `timestamp`（§3.3）、+ YIR 月度明细（§3.2，月粒度但 100% 覆盖） |
| 购买历史不覆盖 Key 激活 | [[03_Steam信息获取文档\|03]] §4.1 | `/account/licenses/` 可补（§4） |

## 7. 待实测清单

| # | 项 | 风险 | 验证方式 |
|---|---|---|---|
| 1 | `GetUserFiles` 对本人各 `file_type` 的实际返回与 `date_range_created` 行为 | 低 | 用自己的 Key + SteamID 拉一次，核对 `time_created` 与社区 XML 接口是否一致 |
| 2 | `GetBadges` 返回结构（`completion_time` / `appid` 是否如社区口径） | 低 | 同上，一次调用即可确认 |
| 3 | `webapi_token` 的取法与有效期 | 中 | Layer 2 登录后调 `pointssummary/ajaxgetasyncconfig`，观察 token 结构与过期时间 |
| 4 | `EUserNewsType` / `EUserNewsFilterFlags` 枚举值 | 中 | 不传 filterflags 拉一段窗口，按实际 `eventtype` 反推 |
| 5 | YIR 历史年份可用性 + `privacy_state` 影响 | 中 | 拉 2023/2024/2025 三年对比 |
| 6 | 云存档 `EnumerateUserFiles` 的覆盖率与调用成本 | 中 | 对 5 款启用 Cloud 的游戏各调一次 |
| 7 | undocumented 接口是否也接受 API Key（而非仅 `access_token`） | 中 | 用 Key 试调 `GetUserNews`，若 401 则确认必须 Layer 2 |

## 8. 来源

- `ISteamWebAPIUtil/GetSupportedAPIList`（实测拉取，2026-09-07：27 接口 / 63 方法，无 Key 的公开子集）
- [xPaw/SteamWebAPIDocumentation `api.json`](https://github.com/xPaw/SteamWebAPIDocumentation)（209 接口全量表面 + documented/undocumented 标记）
- [SteamDatabase/Protobufs](https://github.com/SteamDatabase/Protobufs)：`webui/service_usernews.proto`、`service_salefeature.proto`、`service_publishedfile.proto`、`service_cloud.proto`、`service_usergamenotes.proto`、`service_userreviews.proto`、`service_gamerecordingclip.proto`、`service_player.proto`、`service_community.proto`、`service_quest.proto`
- [SteamRE/SteamKit `Resources/SteamLanguage/enums.steamd`](https://github.com/SteamRE/SteamKit)（`EWorkshopFileType`）
- [Steamworks 官方 Web API 文档 IPlayerService](https://partner.steamgames.com/doc/webapi/IPlayerService)
- [Revadike/InternalSteamWebAPI wiki](https://github.com/Revadike/InternalSteamWebAPI/wiki)（127 个内部接口清单，交叉验证）
