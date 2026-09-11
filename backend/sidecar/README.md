# Steam 登录侧车（Node）

用 [steam-session](https://github.com/DoctorMcKay/node-steam-session) 完成 Steam 登录（**扫码 QR** 或 账号密码 + Steam Guard），导出 web session（`sessionid` + `steamLoginSecure` + `refreshToken`）给 Python 后端。密码只在内存中流转，不落盘、不写日志。

## 安装与启动

```bash
cd sidecar
npm install        # 装 steam-session + qrcode
npm start          # 默认 127.0.0.1:8765
```

环境变量（可选）：`SIDE_CAR_PORT`（默认 8765）、`SIDE_CAR_HOST`（默认 127.0.0.1）。

## 接口

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/qr` | — | `{status:"qr", qrDataUri}`（二维码 data URI）或 `{status:"error", message}` |
| POST | `/login` | `{username, password}` | `{status:"guard", actions}` 或 `{status:"pending"}` 或 `{status:"error"}` |
| POST | `/guard` | `{code}` | `{status:"pending"}` 或 `{status:"error"}` |
| GET | `/poll` | — | `{status:"pending"\|"scanned"\|"success", steamid, sessionid, steamLoginSecure, refreshToken}` 或 `{status:"error"}` |
| GET | `/health` | — | `{ok:true}` |

## 流程

- **扫码**：`/qr` 拿到二维码 → 前端展示 → 用户用 Steam 手机 App 扫码并确认 → 前端轮询 `/poll` 直到 `success`。
- **密码**：`/login` → 若 `guard` 弹验证码 → `/guard` 提交 → 轮询 `/poll` 直到 `success`。

## 说明

- 单实例单登录流程（本地自用）。登录成功后 Python 后端把 `sessionid`/`steamLoginSecure`/`refreshToken` **Fernet 加密**存入 `users.session_cookie_enc` / `refresh_token_enc`，密码不落库。
- 平台类型用 `WebBrowser`，可直接 `getWebCookies()` 导出 web 会话；会话失效时后端可用 `refreshToken` 重新导出。
