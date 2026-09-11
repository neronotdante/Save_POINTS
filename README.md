# Save Point

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg)](https://www.python.org/downloads/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#准备)
[![Self-hosted](https://img.shields.io/badge/Self--hosted-local%20only-0E9E68.svg)](#安全)

把你的 Steam 购买、首次启动、成就解锁和当时的截图，放回同一条时间轴上。

自托管，数据只存在你自己电脑上，不经过任何第三方。没有安装包，需要自己装 Python 跑起来，十分钟以内。

![横向时间轴主视图](docs/screenshot-landscape.webp)

<p align="center">
  <img src="docs/screenshot-portrait.webp" width="380" alt="纵向时间轴视图">
</p>

<p align="center"><sub>上：横向时间轴——封面按购买/游玩日排布，轴下是当日的成就与截图。下：纵向布局，左侧年份标尺可跨年跳转。</sub></p>

---

## 准备

| | |
|---|---|
| Python | 3.11 或更新。[下载](https://www.python.org/downloads/)时勾上 **Add python.exe to PATH** 和 **py launcher** |
| 浏览器 | Chrome / Edge / Firefox 近两年的版本 |
| Steam | 「游戏详情」隐私必须设为**公开**，否则拿不到游戏库和成就 |
| 路径 | 仓库放的目录**别带中文和空格**，Python 虚拟环境对此不稳 |

不需要 Node.js。

## 跑起来

```bash
git clone https://github.com/neronotdante/Save_POINTS.git
```

然后双击根目录的 `run.cmd`。首次会装依赖，一到三分钟；之后每次直接起后端，就绪后自动打开 `http://127.0.0.1:8000/`。

后端窗口标题是「Save Point 后端」，关掉它就是退出。

浏览器里点**登录 Steam**，密码只在 Steam 官网输入，本项目只拿到你的 SteamID64。

macOS / Linux 或不想用脚本，见 [开发](#开发)。

## 绑 API Key

拉数据要用 Steam 给每个账号签发的 Web API Key，登录本身给不了，得自己申请一次：

1. 打开 <https://steamcommunity.com/dev/apikey>，**用刚登录的同一个账号**
2. 域名随便填个 `localhost`，注册
3. 复制那串 32 位的 Key，粘回应用里点绑定

Key 存进库前会先拿它查一次你的资料，无效的当场报错。存进去是加密的，界面和接口都不回显。

不想在浏览器里粘，终端也能绑：

```bash
cd backend && .venv\Scripts\activate && game-calendar-bind-apikey
```

这把 Key 只用来拉你自己的数据，别发给别人，别提交到任何仓库。

## 首次同步

绑完自动开始。要逐款游戏向商店拉名称、封面、发售日，商店有限流：

| 库的规模 | 大概要等 |
|---|---|
| 100 款以内 | 几分钟 |
| 300 到 500 款 | 20 到 40 分钟 |
| 1000 款以上 | 一小时以上 |

进度页有「先查看已有数据」，入库的部分随时能看。**别关浏览器标签页**——进度是通过当前页面推送的，关了会中断这一轮，下次点同步从断点继续，已入库的不会丢。

之后只拉增量，一两分钟。

## 数据与备份

都在 `backend/` 下：

| 文件 | 是什么 | 要不要备份 |
|---|---|---|
| `game_c.db`（含 `-wal` / `-shm`） | 你的全部数据 | 要 |
| `fernet.key` | 加密密钥，首次启动自动生成 | 要，和 db 一起 |
| `.env` | 你改过的配置 | 有就备 |
| `.venv/` | Python 依赖 | 不用，重跑 `run.cmd` 会重建 |

**只备份 db 不备份 `fernet.key` 等于丢了 Key**：数据还在，但解不开，得重新绑一次。

设置页 → DATA → 导出 JSON 备份，导出的文件不含 Key，随便放。首启页的「导入本地备份」能在没有后端的情况下只读地看它。

## 安全

- 加密密钥默认不用配，首次启动在 `backend/fernet.key` 生成一把，每台机器独立。换了密钥就解不开已存的 Key。
- 登录态是浏览器 `localStorage` 里一个 30 天的随机 token，库里只存哈希。
- 后端只监听 `127.0.0.1`。**没按公网多用户加固，别直接暴露到互联网**——别人能用你的 Key 采你的数据。
- `game_c.db*`、`fernet.key`、`.env` 不要提交，`.gitignore` 已经挡了。

## 常见问题

**找不到 `py`** — 没装 Python，或装的时候没勾 py launcher。

**8000 打不开** — 多半端口被占，看后端窗口的报错。换端口要同时改三处：`--port`、`.env` 里的 `GC_PUBLIC_BASE_URL` 和 `GC_CORS_ORIGINS`，登录回调依赖前者，不改会回不来。**别用 8080**，Steam 客户端自己占着。

**提示 Steam 拒绝了这个 API Key** — Key 不完整，或者是在别的账号下申请的。

**没有运行记录 / 成就** — Steam 的「游戏详情」隐私不是公开。改了再同步一次。

**没有购买记录** — 购买历史 Steam 不对任何 Key 开放，得用网页会话抓，这条链路没接进界面，默认不采集。空是预期的。

**升级后报错说表或列不存在** — `cd backend && .venv\Scripts\activate && alembic upgrade head`

**想清空重来** — 关掉后端，删 `backend/game_c.db` 和它的 `-wal` / `-shm`，再启动。

## 开发

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

后端直接托管 `timeline/`，前后端同源。想要无缓存的独立静态服务：`python timeline/serve.py 5173`（CORS 已放行）。

测试：`cd backend && pytest`

```
backend/     FastAPI 后端，同时托管前端
  app/       api 路由 · core 基础设施 · models · schemas · services 采集与聚合 · tasks 定时
  alembic/   数据库迁移
  sidecar/   可选的 Node 登录侧车，未接入界面
timeline/    前端，原生 ES Modules，无构建步骤
GAMEC/       产品与设计文档（Obsidian 库）
game-calendar/  已归档的旧 Electron 月历原型
```

细节：[后端](backend/README.md) · [前端规范](timeline/docs/前端开发规范.md) · [设计文档](GAMEC/README.md)

## 许可证

[MIT](LICENSE)。与 Valve 无关联，游戏数据经 Steam 官方 Web API 获取，归各自权利人所有。
