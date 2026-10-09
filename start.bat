@echo off
REM Double-click: start local server and open browser (requires Python)
cd /d "%~dp0"
where py 1>nul 2>nul
if %errorlevel%==0 (py serve.py) else (python serve.py)
pause
