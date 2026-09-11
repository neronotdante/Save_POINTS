---
title: Steam 信息获取技术验证文档
aliases: [Steam 验证, 数据源验证]
tags: [开发文档, Steam, 验证]
date: 2026-08-25
---

# Steam 信息获取技术验证文档

> 用途：逐条核查「登录路线」能否完备获取所需数据，结论用于修正 [[03_Steam信息获取文档|Steam 信息获取]] 与 [[02_PRD_游戏日历|PRD]] §3。
> 验证方式：联网核查 Steam Web API / 客户端协议 / 社区文档（SteamKit、node-steam-user、xpaw、SteamDatabase）。

## 1. 逐条验证结果

| # | 数据项 | 方法 / 协议 | 认证 | 关键字段 | 结论 |
|---|---|---|---|---|---|
| 1 | 愿望单 | `IWishlistService/GetWishlist/v1` | **公开优先：免 Key / 免登录，仅 SteamID**（私密愿望单才需登录 session cookie，见 §3a） | `appid`、`priority`、`date_added` | ✅ 公开可得（对方愿望单公开时） |
| 2 | 元数据 / 发售日 / 封面 | Store API `appdetails` | **无需认证**（公开） | `name`、`release_date`、`header_image` | ✅ 公开可得 |
| 3 | 购买时间 | 商店购买历史页 `/account/history/`（HTML，web cookie） | **登录**（session cookie） | 交易日期、物品(app/sub)、付款方式、金额 | ✅ 可得（日粒度，v1.1 改；入库时间 `CMsgClientLicenseList` 已放弃） |
| 4 | 首次游玩时间 | `IPlayerService/ClientGetLastPlayedTimes/v1` | **仅 API Key**（常需发行商密钥） | `first_playtime`、`last_playtime` | ❌ **登录不可得** |
| 5 | 成就解锁时间 | `ISteamUserStats/GetPlayerAchievements/v1` | **仅 API Key**（+ 档案公开） | `unlocktime`、`apiname` | ❌ **登录不可得** |
| 6 | 封面主色调 | 本地取色 / 第三方色值 API | 无需 Steam 认证 | 主色 hex | 🔲 非 Steam 数据，本地兜底 |
| 7 | 游戏截图（截取时间） | 社区截图接口 `profiles/{steamid}/screenshots/`（`xml=1`/`json=1`） | 公开可读；私密需登录 | `appid`、`rtime_created`、文件名 `YYYYMMDDHHMMSS`、`thumbnail_url`、`privacy` | ✅ 可得（逐张秒级时间戳） |

## 2. 关键结论（与 PRD 冲突点）

**「登录路线 + 成就时间戳为主」存在缺口：**

1. **成就解锁时间（`unlocktime`）不能经登录获取**——只有 Web API `GetPlayerAchievements` 返回，需 **API Key** 且目标游戏详情设为公开；SteamKit / node-steam-user 无对应客户端方法。→ PRD §3「成就解锁时间：登录自动采集」**不成立**。
2. **首次游玩时间（`first_playtime`）不能经登录获取**——`ClientGetLastPlayedTimes` 是 Web API，且 `first_playtime` 基本要求**发行商密钥（publisher key）**，普通 Key 会 403；无客户端协议等价物。→ PRD §3「首次游玩时间：登录自动采集」**不成立**。
3. **登录路线真正能拿到的只有**：愿望单（1）、元数据与封面（2）、主题色本地取色（6）、购买时间（3，购买历史页，web cookie，日粒度）。
4. **截图接口能补上"哪天玩过"的逐日证据**：`GetRecentlyPlayedGames` 只有 `rtime_last_played`（每游戏一个"最后玩"时间戳，无按日历史），成就 `unlocktime` 只覆盖"解锁过成就"的时段；而截图 `rtime_created` 是**逐张、秒级**的"此刻在玩这款游戏"证据，按日聚合后可直接派生运行日，密度通常更高（玩家全程截图，不限成就解锁时刻）。局限是依赖用户开 Overlay 截图并上传云端，以及截图隐私 / 删除状态。

## 3. 影响与待决策

- 若坚持「纯登录、不申请 API Key」，日历的"过去"将**没有时间戳证据**（成就与首玩两条时间戳拿不到；购买时间可走购买历史页，但那是「存 web session cookie」路线，非纯登录）。
- 若引入 **API Key**（Web API），成就解锁时间可获取（需档案公开）；首次游玩时间仍需发行商密钥，普通用户大概率拿不到。
- **已决策（本轮）**：核心指标 = **运行天数**（游玩时长不重要）。**三个互补来源**：① 每日轮询 `GetRecentlyPlayedGames` 记录**未来**运行增量（API Key）；② `GetPlayerAchievements.unlocktime` 回填**过去**的运行状态（API Key）；③ **游戏截图截取时间**（v0.7，社区截图接口）按日聚簇，未来 / 过去都补，密度通常更高。首次游玩时间（`first_playtime`）放弃。

## 3a. v1.2 补充核对（2026-08-28）

> 背景：调研 iRacing「通过 Steam 登录」按钮，确认是标准 Steam OpenID 2.0，据此把登录拆成 Layer 1（默认，OpenID，仅换 SteamID64）+ Layer 2（opt-in，现有 `node-steam-user` 侧车，换 web session cookie）。本文档 §1 表格「认证」列当初笼统写「登录」，未区分这两层，其中第 1 行（愿望单）需要订正——其余各行结论不变：

- **愿望单（表格第 1 行）已订正**：`IWishlistService/GetWishlist` 实际**免 Key、免登录**，只要 SteamID64 + 对方愿望单隐私为公开即可查；私密愿望单才需要 Layer 2 的 web session cookie。原表格写「账户登录（access_token）」是过时描述，2024 年 11 月前后随官方接口收口已不准确。
- **表格第 7 行（截图）结论不变**：本就是「公开可读；私密需登录」，与 Layer 1/Layer 2 框架天然吻合，无需改。
- **表格第 3 行（购买历史）结论不变**：无公开路径，是 Layer 2 存在的唯一硬需求。
- **表格第 4/5 行（首次游玩、成就解锁时间）结论不变**：两者都只认 API Key，与登录走 Layer 1 还是 Layer 2 无关——这一点原文档已经验证清楚，v1.2 分层没有推翻它，反而印证了「登录方式」和「能不能拿到某类数据」是两回事。

完整分层框架、数据源公开/私密分类表、`get_wishlist` 代码漂移提示，见 [[03_Steam信息获取文档|03]] §2a。

## 4. 来源

- [xpaw Steam Web API 文档（IPlayerService / ISteamUserStats）](https://steamapi.xpaw.me/)
- [Steamworks: Web API Key 认证](https://partner.steamgames.com/doc/webapi_overview/auth)
- [node-steam-user README（licenses / getOwnedApps）](https://github.com/DoctorMcKay/node-steam-user)
- [Store API appdetails](https://docs.steamapis.com/apps/details)
- [Stack Overflow: ClientGetLastPlayedTimes 403 / publisher key](https://stackoverflow.com/questions/76615333)
- [Steamworks: Screenshots（截图云端托管与发布）](https://partner.steamgames.com/doc/features/screenshots)
- [rsteamshot（Ruby 截图抓取，端点 / 字段参考）](https://rubydoc.info/gems/rsteamshot)
- [node-steamcommunity（Node，社区截图抓取实现）](https://github.com/DoctorMcKay/node-steamcommunity)
