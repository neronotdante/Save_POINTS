@echo off
chcp 65001 >nul
rem ============================================================
rem  Game_C 后端启动脚本（首次自动创建虚拟环境并安装依赖）
rem ============================================================
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Python 启动器 py，请先安装 Python 3.11+。
    pause
    exit /b 1
)

if not exist ".venv" (
    echo [首次] 创建虚拟环境并安装依赖...
    py -m venv .venv
    call ".venv\Scripts\activate.bat"
    python -m pip install --upgrade pip
    pip install -e ".[dev]"
) else (
    call ".venv\Scripts\activate.bat"
)

if not exist ".env" (
    echo [提示] 未找到 .env，使用默认配置（SQLite 开发态）。可复制 .env.example 修改。
)

echo [启动·开发态] 后端 + 托管的前端 http://127.0.0.1:8000/ （接口文档 /docs；--reload 热重载）
echo              日常使用请运行仓库根目录的 run.cmd（不带 --reload，并自动打开浏览器）
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
