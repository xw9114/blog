@echo off
setlocal

cd /d "D:\blog" || goto :error

for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "branch=%%i"
if not defined branch goto :error

for /f %%i in ('git status --porcelain ^| find /c /v ""') do set "changes=%%i"
if "%changes%"=="0" (
    echo No changes to commit.
    goto :end
)

set /p msg=Commit message: 
if "%msg%"=="" set "msg=update blog"

git add .
if errorlevel 1 goto :error

git commit -m "%msg%"
if errorlevel 1 goto :error

git push origin "%branch%"
if errorlevel 1 goto :error

echo.
echo Done! Pushed to origin/%branch%.
goto :end

:error
echo.
echo Push failed. Please check git output above.

:end
pause
endlocal
