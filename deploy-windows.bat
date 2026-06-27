@echo off
chcp 65001 >nul
echo.
echo  ==========================================
echo   你的专属开发管家 - Windows 一键部署脚本
echo  ==========================================
echo.

:: 检查 Node.js 是否已安装
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/5] 正在下载安装 Node.js...
    powershell -Command "& {Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.14.0/node-v20.14.0-x64.msi' -OutFile '%TEMP%\node-install.msi'}"
    msiexec /i "%TEMP%\node-install.msi" /quiet /norestart
    echo     Node.js 安装完成，请关闭此窗口后重新运行本脚本
    pause
    exit /b
) else (
    echo [1/5] Node.js 已安装:
    node --version
)

:: 检查 Git 是否已安装
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/5] 正在下载安装 Git...
    powershell -Command "& {Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.45.2.windows.1/Git-2.45.2-64-bit.exe' -OutFile '%TEMP%\git-install.exe'}"
    "%TEMP%\git-install.exe" /VERYSILENT /NORESTART
    echo     Git 安装完成
) else (
    echo [2/5] Git 已安装:
    git --version
)

:: 创建项目目录
echo [3/5] 克隆项目代码...
if exist "C:\dev-butler" (
    echo     项目目录已存在，拉取最新代码...
    cd /d "C:\dev-butler"
    git pull
) else (
    cd /d "C:\"
    git clone https://github.com/zzy20050314-blip/dev-butler.git
    cd /d "C:\dev-butler"
)

:: 安装依赖
echo [4/5] 安装 Node.js 依赖...
npm install --production

:: 创建 .env 文件
echo [5/5] 配置环境变量...
(
echo OPENAI_API_KEY=sk-3212186b46974a3280f6b0f7a1ed3682
echo OPENAI_BASE_URL=https://api.deepseek.com
echo OPENAI_MODEL=deepseek-chat
echo PORT=3000
) > .env
echo     .env 配置完成

:: 安装 PM2 进程管理器（保持服务后台运行）
echo.
echo  正在安装 PM2 进程管理器...
npm install -g pm2

:: 停止旧的进程（如果有）
pm2 stop dev-butler >nul 2>&1
pm2 delete dev-butler >nul 2>&1

:: 启动服务
echo.
echo  启动服务...
pm2 start server.js --name dev-butler
pm2 save

echo.
echo  ==========================================
echo   部署完成！
echo   本地访问: http://localhost:3000
echo   局域网访问: http://159.75.85.143:3000
echo  ==========================================
echo.
echo  如需开机自启，请以管理员身份运行:
echo    pm2 startup
echo    pm2 save
echo.
pause
