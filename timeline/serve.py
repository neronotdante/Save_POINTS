#!/usr/bin/env python3
"""开发用静态服务器：在 http.server 基础上强制关闭缓存，避免浏览器缓存旧的 ES Module 造成
「改了代码但页面还是跑旧逻辑」的调试假象。仅用于本地开发，不代表生产部署方式。

端口默认 5173（不是 8080）——**8080 被 Steam 客户端自己占用**：
steamwebhelper.exe 以 `--remote-debugging-port=8080` 启动 CEF 远程调试。
本项目的用户必然开着 Steam，撞端口是必然而非偶然：那时浏览器打开 8080 拿到的是
Steam 的调试页而不是本应用，症状表现为「页面打不开 / 登录按钮没反应」。
换端口时记得后端 CORS 要放行（backend/app/config.py 的 cors_origins 默认已含 5173）。
"""
import functools
import http.server
import pathlib
import socket
import sys

DEFAULT_PORT = 5173
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
HERE = pathlib.Path(__file__).resolve().parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


def _port_taken(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(('127.0.0.1', port)) == 0


if __name__ == '__main__':
    # 显式预检：http.server 绑不上时只抛一句 WinError 10048，看不出是谁占的。
    if _port_taken(PORT):
        print(f'[错误] 端口 {PORT} 已被占用，静态服务器没有启动。', file=sys.stderr)
        if PORT == 8080:
            print('       8080 常被 Steam 客户端的 CEF 远程调试占用'
                  '（steamwebhelper.exe --remote-debugging-port=8080）。', file=sys.stderr)
        print(f'       换个端口：python serve.py 5174'
              f'（记得后端 GC_CORS_ORIGINS 要放行该源）', file=sys.stderr)
        raise SystemExit(1)

    Handler = functools.partial(NoCacheHandler, directory=str(HERE))
    print(f'timeline 前端: http://localhost:{PORT}/')
    http.server.test(HandlerClass=Handler, port=PORT)
