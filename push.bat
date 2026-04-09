@echo off
cd /d D:\blog
git add .
set /p msg=Commit message: 
git commit -m "%msg%"
git push
echo.
echo Done!
pause
