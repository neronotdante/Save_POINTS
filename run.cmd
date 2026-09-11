@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  Save Point（Game_C）一键启动：装依赖（仅首次）→ 起后端 → 打开浏览器
rem  后端同时托管前端，只有一个进程、一个地址：http://127.0.0.1:8000/
rem ============================================================
cd /d "%~dp0backend"

where py >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Python 启动器 py。请安装 Python 3.11 或更新版本：https://www.python.org/downloads/
    echo        安装时勾选 "Add python.exe to PATH" 与 "py launcher"。
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [首次] 创建虚拟环境并安装依赖，需要联网，约 1~3 分钟...
    py -3 -m venv .venv
    if errorlevel 1 (
        echo [错误] 创建虚拟环境失败。确认 py -3 --version 能打印 3.11 以上版本。
        pause
        exit /b 1
    )
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -e .
    if errorlevel 1 (
        echo [错误] 安装依赖失败，看上面 pip 的报错。网络不通时可配置 pip 镜像后重试。
        pause
        exit /b 1
    )
)

echo [启动] 后端窗口会最小化在任务栏，标题「Save Point 后端」。关掉它就是退出。
start "Save Point 后端" /min ".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000

rem 等 /health 通了再开浏览器，否则用户先看到的是「无法访问此页面」
set /a tries=0
:wait
set /a tries+=1
".venv\Scripts\python.exe" -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=1).status == 200 else 1)" >nul 2>nul
if not errorlevel 1 goto ready
if %tries% geq 30 (
    echo [错误] 后端 30 秒内没有就绪。切到「Save Point 后端」窗口看报错；
    echo        常见原因：8000 端口被占用（改端口见 README「常见问题」）。
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:ready
start "" "http://127.0.0.1:8000/"
echo.
echo 已在浏览器打开 http://127.0.0.1:8000/
echo 提醒：每日采集只在后端运行时进行；Steam 只保留最近两周的运行记录，
echo       两周以上不启动会丢那段时间的运行日。常驻方案见 README「让它一直跑」。
echo.
endlocal
