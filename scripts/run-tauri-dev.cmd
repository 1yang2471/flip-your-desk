@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d D:\workspace\flip-your-desk
where cl.exe >nul 2>&1
if errorlevel 1 (
  echo [dev] MSVC environment not loaded
  exit /b 1
)
call node_modules\.bin\tauri.cmd dev %*
