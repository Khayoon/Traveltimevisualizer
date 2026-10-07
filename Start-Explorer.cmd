@echo off
cd /d "%~dp0"
if not exist "node_modules\vite\bin\vite.js" (
  echo Installing app dependencies...
  call npm.cmd --prefix "%~dp0" install
  if errorlevel 1 exit /b 1
)
echo Opening Ontario Drive-Time Explorer...
node "%~dp0node_modules\vite\bin\vite.js" "%~dp0" --host 127.0.0.1 --open
