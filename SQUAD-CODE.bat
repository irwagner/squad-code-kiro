@echo off
title SQUAD/CODE KIRO
cd /d "%~dp0"
echo(
echo    ============================================
echo      SQUAD/CODE KIRO  -  bridge local
echo      Abrindo em  http://127.0.0.1:4317
echo      Feche esta janela para parar o sistema.
echo    ============================================
echo(
where node >nul 2>nul
if errorlevel 1 (
  echo    [ERRO] Node.js nao encontrado no PATH. Instale o Node 22+ e tente novamente.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\better-sqlite3" (
  echo    Primeira execucao: instalando dependencias ^(npm install^)...
  call npm install
  echo.
)
rem Abre o navegador na UI depois de 3s, sem travar a inicializacao do bridge.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:4317'"
rem Sobe o bridge (serve a UI + executa os agentes). Esta janela segura o processo.
node server.js
echo(
echo    Bridge encerrado.
pause
