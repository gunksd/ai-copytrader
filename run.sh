#!/usr/bin/env bash
# 启动跟单。代理端口按自己的改;不需要代理就删掉 HTTPS_PROXY / HTTP_PROXY 两行。
cd "$(dirname "$0")"
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:7890}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:7890}"
exec node copytrader.mjs "$@"
