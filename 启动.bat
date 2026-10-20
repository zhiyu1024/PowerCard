@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有检测到 Node.js。
  echo 请先安装 Node.js 20 或更高版本：https://nodejs.org/
  echo 安装完成后重新双击本文件。
  echo.
  pause
  exit /b 1
)

if not defined PORT set PORT=8787

echo.
echo 正在启动「远程电脑控制」...
echo 浏览器将自动打开：http://127.0.0.1:%PORT%
echo 手机请访问启动日志里的“局域网访问”地址。
echo 按 Ctrl+C 可以停止服务。
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"
node server/start.js

echo.
echo 服务已停止。
pause
