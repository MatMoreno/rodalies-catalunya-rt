@echo off
title Rodalies RT
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install || goto :err
)
echo.
echo   Rodalies RT  ->  http://localhost:3020
echo   (Ctrl+C para parar)
echo.
node src/server.mjs
goto :eof
:err
echo.
echo ERROR: fallo al instalar dependencias. Necesitas Node.js instalado.
pause
