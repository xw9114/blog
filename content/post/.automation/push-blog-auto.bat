@echo off
setlocal

cd /d "D:\blog" || goto :error

for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "branch=%%i"
if not defined branch goto :error

set "article=%~1"
set "msg=%~2"
if "%msg%"=="" set "msg=auto(blog): add daily post"

rem Stage only the generated article and in-repo automation memory when provided.
if "%article%"=="" (
    git add -- "content/post"
) else (
    git add -- "%article%" "content/post/.automation/blog-memory.md" "content/post/.automation/push-blog-auto.bat"
)
if errorlevel 1 goto :error

rem Exit early when there is nothing staged for commit.
git diff --cached --quiet
if not errorlevel 1 (
    echo No staged blog changes to commit.
    goto :end
)

git commit -m "%msg%"
if errorlevel 1 goto :error

git push origin "%branch%"
if errorlevel 1 goto :error

echo Auto push finished: origin/%branch%
goto :end

:error
echo Auto push failed. Please check git output above.

:end
endlocal
