@echo off
rem Start the copy-trader. Change the proxy port to yours, or delete the two PROXY lines if you need no proxy.
cd /d "%~dp0"
set NODE_USE_ENV_PROXY=1
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
node copytrader.mjs %*
