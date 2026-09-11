# Save Point（Game_C 游戏日历）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg)](https://www.python.org/downloads/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#1-需要准备什么)
[![Self-hosted](https://img.shields.io/badge/Self--hosted-local%20only-0E9E68.svg)](#7-密钥与安全)

把你的 Steam 购买、首次启动、成就解锁和当时的截图，放回同一条横向时间轴上。

自托管、单机、本地数据：登录 Steam 后，后端用**你自己的 Web API Key** 每天拉一次数据存进本机 SQLite，浏览器打开 `http://127.0.0.1:8000/` 看时间轴。没有账号系统，不上传任何东西到第三方。

> 这是一个**需要自己搭环境**的项目，不提供安装包。你需要会装 Python、会在终端里跑一条命令。整个流程 10 分钟以内，下面从零开始写。

---

## 目录

1. [需要准备什么](#1-需要准备什么)
2. [第一次运行](#2-第一次运行)
3. [绑定 API Key](#3-绑定-api-key)
4. [首次同步要等多久](#4-首次同步要等多久)
5. [让它一直跑（重要）](#5-让它一直跑重要)
6. [数据存在哪、怎么备份](#6-数据存在哪怎么备份)
7. [密钥与安全](#7-密钥与安全)
8. [常见问题](#8-常见问题)
9. [开发者入口](#9-开发者入口)
10. [许可证](#10-许可证)

---

## 1. 需要准备什么

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10 / 11 | 一键脚本是 `.cmd`；macOS / Linux 见 [§9](#9-开发者入口) 手动起 |
| Python | **3.11 或更新** | [python.org 下载](https://www.python.org/downloads/)，安装时勾选 **Add python.exe to PATH** 和 **py launcher** |
| 浏览器 | Chrome / Edge / Firefox 近两年的版本 | 前端是原生 ES Modules，不支持 IE |
| Steam 账号 | 「游戏详情」隐私设为**公开** | 设为私密时 Steam 不会把游戏库和成就给任何 Key，包括你自己的 |
| 网络 | 首次装依赖和每次同步都要能访问 `api.steampowered.com` 与 `store.steampowered.com` | 装依赖时不通可配 pip 镜像 |

不需要 Node.js（登录侧车是可选功能，见 [§8](#8-常见问题)）。

## 2. 第一次运行

1. 把仓库放到任意目录，路径里**不要有中文或空格**（Python 虚拟环境对此不稳）：

   ```bash
   git clone https://github.com/neronotdante/Save_POINTS.git
   ```

   没装 Git 也可以在 [仓库页面](https://github.com/neronotdante/Save_POINTS) 点 **Code → Download ZIP** 后解压。
2. 双击仓库根目录的 **`run.cmd`**。
   - 首次会创建 `backend/.venv` 并安装依赖，约 1 到 3 分钟。
   - 之后每次直接起后端，就绪后自动打开浏览器到 `http://127.0.0.1:8000/`。
   - 后端窗口标题是「Save Point 后端」，最小化在任务栏。**关掉它就是退出**。
3. 浏览器里点 **登录 Steam**：整页跳到 `steamcommunity.com` 授权，密码只在 Steam 官网输入，本项目拿到的只有你的 SteamID64。
4. 登录回来后会停在 **绑定 API Key** 页，按下一节做。

## 3. 绑定 API Key

同步游戏库、运行记录、成就和截图，用的是 Steam 给每个账号签发的 **Web API Key**。登录本身给不了它，必须你自己申请一次：

1. 打开 <https://steamcommunity.com/dev/apikey>（用刚才登录的同一个账号）。
2. 「域名」随便填，例如 `localhost`，勾选同意，点注册。
3. 复制页面上那串 32 位的 Key。
4. 回到应用：

   - **首启页**（登录后自动停在这里）：粘贴到输入框，点 **绑定并开始同步**。
   - **设置页 → ACCOUNT → Steam Web API Key**：以后换 Key 或解绑都在这一行。

后端收到 Key 会先拿它查一次你自己的资料，无效的 Key 当场报错，不会存进去。存进去的 Key 是加密的，界面和接口都不回显。

**不想在浏览器里粘 Key？** 终端里也能绑（Key 不回显、不进历史记录）：

```bash
cd backend && .venv\Scripts\activate && game-calendar-bind-apikey
```

> 这把 Key 只会被用来拉取**你自己**的数据。不要把它发给别人，也不要提交到任何仓库。

## 4. 首次同步要等多久

绑完 Key 会自动开始首次同步。它要逐款游戏向 Steam 商店拉名称、封面、发售日，商店接口有限流：

| 库的规模 | 大致耗时 |
|---|---|
| 100 款以内 | 几分钟 |
| 300 到 500 款 | 20 到 40 分钟 |
| 1000 款以上 | 一小时以上 |

进度页上有「先查看已有数据」按钮，已入库的部分随时能看，同步在后台继续。**别关后端窗口，也别关浏览器标签页**：同步进度是通过当前页面的连接推送的，关掉标签页会中断这一轮，下一次点同步会从断点继续（已入库的数据不会丢）。

之后的每日同步只拉增量，一般一两分钟。

## 5. 让它一直跑（重要）

这一节决定你的数据会不会有缺口，请务必读完。

- 「哪天玩了什么」来自 Steam 的 `GetRecentlyPlayedGames`，**它只保留最近两周**。
- 后端每天 UTC 03:00（北京时间 11:00）自动拉一次。**但只在后端进程活着的时候**。
- 所以：**连续两周以上没启动过后端，那段时间的运行日就永久丢了**。成就时间和截图能部分补回，运行日不能。

三种常驻方式，选一种：

**A. 开机自动启动（推荐给日常开机的电脑）**

以管理员身份打开 PowerShell，把下面的路径换成你的仓库路径，执行一次：

```powershell
schtasks /Create /TN "SavePoint" /SC ONLOGON /RL LIMITED /TR "\"E:\path\to\Game_C\backend\.venv\Scripts\python.exe\" -m uvicorn app.main:app --host 127.0.0.1 --port 8000" /F
```

再给这个任务设好工作目录：打开「任务计划程序」→ 找到 SavePoint → 属性 → 操作 → 编辑 → 「起始于」填 `E:\path\to\Game_C\backend`。之后登录 Windows 就会在后台起后端，浏览器随时打开 `http://127.0.0.1:8000/` 即可。

删除任务：`schtasks /Delete /TN "SavePoint" /F`。

**B. 每次用之前手动双击 `run.cmd`**

最简单，但你要记得**至少每两周开一次**。

**C. Docker 常驻（NAS / 家庭服务器）**

```bash
cd backend
docker compose up -d --build
```

Docker 镜像里没有前端文件，得把 `timeline/` 目录挂进去并设 `GC_FRONTEND_DIR`，或另起一个静态服务指向它。多机访问时还要把访问地址加进 `GC_CORS_ORIGINS`、改 `GC_PUBLIC_BASE_URL`。这条路面向会用 Docker 的人，细节见 [`backend/README.md`](backend/README.md)。

## 6. 数据存在哪、怎么备份

所有数据都在 `backend/` 目录下：

| 文件 | 内容 | 备份时 |
|---|---|---|
| `game_c.db`（及 `-wal` / `-shm`） | 你的全部数据：游戏库、运行日、成就、截图记录、加密后的 Key | **要** |
| `fernet.key` | 首次启动自动生成的加密密钥 | **要，和 db 一起** |
| `.env` | 你改过的配置（如果有） | 建议 |
| `.venv/` | Python 依赖 | 不用，重跑 `run.cmd` 会重建 |

**没有 `fernet.key` 的 db 备份等于丢了 Key**：数据都在，但后端解不开 Key，得重新绑一次。

另外，设置页 → DATA → **导出 JSON 备份** 会把时间轴数据导成一个 JSON 文件。它不含 Key，可以随便放；首启页的「导入本地备份」能在**没有后端**的情况下只读地看它。

## 7. 密钥与安全

- **加密密钥**：默认什么都不用配。首次启动在 `backend/fernet.key` 生成一把每台机器独立的密钥，用它加密 Key。想自己指定，在 `backend/.env` 里设 `GC_SECRET_KEY`（随便一串长随机字符串）或 `GC_FERNET_KEY`。**换密钥会解不开已存的 Key**。
- **登录态**：登录后浏览器 `localStorage` 里存一个 30 天有效的随机 token，库里只存它的哈希。设置页「退出登录」会作废它。
- **后端只监听 127.0.0.1**：默认不接受局域网和公网访问。想让别的设备访问，你需要自己处理反向代理、TLS 和 CORS 白名单，并理解这意味着别人能用你的 Key 采集你的数据。**本项目未按公网多用户加固**，不要直接暴露到互联网。
- **不要提交这些文件到任何仓库**：`game_c.db*`、`fernet.key`、`.env`。根目录 `.gitignore` 已经挡了，推送前用 `git status --ignored` 确认一遍。

## 8. 常见问题

**双击 `run.cmd` 提示找不到 `py`**
没装 Python，或安装时没勾 py launcher。重装时勾上，或者手动按 [§9](#9-开发者入口) 起。

**后端 30 秒内没就绪 / 浏览器打不开 8000**
多半是 8000 被占了。切到「Save Point 后端」窗口看报错。要换端口得同时改三处：启动命令的 `--port`、`.env` 里的 `GC_PUBLIC_BASE_URL`、`GC_CORS_ORIGINS`。Steam 登录的回调地址依赖 `GC_PUBLIC_BASE_URL`，改了端口不改它登录会回不来。**不要用 8080**：Steam 客户端自己占着它。

**登录后提示「Steam 拒绝了这个 API Key」**
Key 复制不完整，或者是在另一个账号下申请的。Key 必须是**当前登录账号**在 <https://steamcommunity.com/dev/apikey> 申请的。

**同步完了，时间轴上没有运行记录 / 成就**
Steam 隐私设置里「游戏详情」不是公开。改成公开后再同步一次。

**没有购买记录**
购买历史 Steam 不对任何 Key 开放，只能用网页登录会话抓取。这条链路需要额外的 Node 侧车且**当前版本没有接进界面**，默认不采集。时间轴上的「购买」事件为空是预期行为。

**升级到新版本后启动报错，提示表或列不存在**
到 `backend/` 目录执行一次迁移：

```bash
cd backend && .venv\Scripts\activate && alembic upgrade head
```

**想清空重来**
关掉后端，删除 `backend/game_c.db`、`game_c.db-wal`、`game_c.db-shm`，再启动。`fernet.key` 留着也行。

## 9. 开发者入口

不用一键脚本、或在 macOS / Linux 上：

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --host 127.0.0.1 --port 8000
# 打开 http://127.0.0.1:8000/
```

后端直接托管 `timeline/` 目录，前后端同源。开发时想用无缓存的独立静态服务：

```bash
python timeline/serve.py 5173     # 后端 CORS 白名单已放行 5173
```

- 后端接口、配置项、数据模型、采集流程：[`backend/README.md`](backend/README.md)
- 前端结构与约定：[`timeline/docs/前端开发规范.md`](timeline/docs/前端开发规范.md)
- 产品与设计文档（Obsidian 库）：[`GAMEC/`](GAMEC/README.md)
- 测试：`cd backend && pytest`
- `game-calendar/` 是已归档的旧 Electron 月历原型，与当前时间轴无关。

### 仓库结构

```
Save_POINTS/
├── run.cmd              一键启动：建 venv → 装依赖 → 起后端 → 开浏览器
├── backend/             FastAPI 后端，同时托管前端静态文件
│   ├── app/
│   │   ├── api/         REST 路由（认证、同步、时间轴聚合、设置）
│   │   ├── core/        配置加载、加密、限流等基础设施
│   │   ├── models/      SQLAlchemy 数据模型
│   │   ├── schemas/     Pydantic 请求/响应模型
│   │   ├── services/    Steam 采集、封面取色、聚合等业务逻辑
│   │   └── tasks/       每日同步定时任务
│   ├── alembic/         数据库迁移
│   ├── scripts/         运维脚本（绑 Key、重算等）
│   ├── sidecar/         可选的 Node 登录侧车（购买历史，未接入界面）
│   ├── tests/           pytest 测试
│   └── .env.example     全部配置项及说明
├── timeline/            前端：原生 ES Modules，无构建步骤
│   ├── index.html
│   ├── app.js           入口与路由
│   ├── timeline.js      横向时间轴主视图
│   ├── lib/             布局、取色、灯箱、存储等模块
│   └── docs/            前端开发规范
├── GAMEC/               产品与设计文档（Obsidian 库）
└── game-calendar/       已归档的旧 Electron 月历原型
```

运行时生成、**不进仓库**的文件：`backend/.venv/`、`backend/game_c.db*`、`backend/fernet.key`、`backend/.env`。

## 10. 许可证

本项目以 [MIT 许可证](LICENSE) 发布，你可以自由使用、修改和分发，保留版权声明即可。

本项目与 Valve Corporation 无关联，不隶属于 Steam。所有游戏数据经由 Steam 官方 Web API 获取，归各自权利人所有。
