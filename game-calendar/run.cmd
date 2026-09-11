@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次运行，正在安装依赖（要下 100MB+ 的 Electron，请等几分钟）...
  call npm install
  if errorlevel 1 (
    echo.
    echo 安装失败。确认已装 Node.js: https://nodejs.org
    pause
    exit /b 1
  )
)

if not exist "assets\tray.png" call npm run make-icon

echo 正在启动「游戏日历」...
echo.
echo   窗口是无边框透明的悬浮面板，没有任务栏图标。
echo   如果没看见：托盘图标可能被 Win11 收进了溢出区，点任务栏右下角的 ^^ 展开，
echo   把「游戏日历」拖到任务栏上固定住。单击托盘图标显示或隐藏，右键退出。
echo.

start "" "node_modules\electron\dist\electron.exe" .
