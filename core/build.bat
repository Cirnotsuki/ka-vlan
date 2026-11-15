@echo off
rem Build vlancore only (virtual NIC up/down)
setlocal
cd /d "%~dp0"
set CGO_ENABLED=0
go build -trimpath -ldflags "-s -w" -o vlancore.exe .\cmd\vlancore
if errorlevel 1 exit /b 1
echo [OK] vlancore.exe
exit /b 0
