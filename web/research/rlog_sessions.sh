#!/bin/zsh
exec python3 "$(dirname "$0")/rlog_sessions.py" "$@"
