@echo off
setlocal

cd /d "D:\blog" || goto :error

REM Cleanup stale index.lock before staging.
if exist ".git\index.lock" (
    echo Detected Git lock file. Cleaning up...
    del /f /q ".git\index.lock"
    if exist ".git\index.lock" (
        echo Failed to remove .git\index.lock
        goto :error
    )
)

for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "branch=%%i"
if not defined branch goto :error

set "article=%~1"
set "msg=%~2"
if "%msg%"=="" set "msg=auto(blog): add daily post"

REM Stage the target article and automation memory.
if "%article%"=="" (
    git add -- "content/post"
) else (
    git add -- "%article%" "content/post/.automation/blog-memory.md" "content/post/.automation/push-blog-auto.bat"
)
if errorlevel 1 goto :error

REM Commit only when staged content is present.
git diff --cached --quiet
set "diff_rc=%errorlevel%"

if "%diff_rc%"=="0" (
    echo No staged blog changes to commit.
    goto :end
)

if not "%diff_rc%"=="1" (
    echo [Error] Failed to inspect staged changes.
    goto :error
)

git commit -m "%msg%"
if errorlevel 1 goto :error

git push origin "%branch%"
if errorlevel 1 goto :error

echo Auto push finished: origin/%branch%
goto :end

:error
echo Auto push failed.
echo Please check git output above.
endlocal & exit /b 1

:end
endlocal & exit /b 0
