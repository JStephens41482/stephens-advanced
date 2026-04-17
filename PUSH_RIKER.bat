@echo off
echo === Pushing Riker to production ===
echo.

cd /d "%~dp0"

echo Removing stale lock file if present...
del /f ".git\index.lock" 2>nul

echo.
echo Staging all changes...
git add -A

echo.
echo Committing...
git commit -m "Add Riker AI brain, SMS/email inbound, Mazon factoring module"

echo.
echo Pushing riker branch to GitHub...
git push origin riker

echo.
echo Switching to main and merging...
git checkout main
git pull origin main
git merge riker -m "Merge riker branch - AI brain, SMS/email inbound, Mazon factoring"
git push origin main

echo.
echo Switching back to riker branch...
git checkout riker

echo.
echo === DONE. Vercel will auto-deploy from main. ===
pause
