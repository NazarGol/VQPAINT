#!/bin/zsh
# Read a room's remote device log. Usage: web/research/rlog_read.sh <room-id> [n]
R=${1:?room id}; N=${2:-300}
curl -s "https://vqpaint-rooms.vqpaint-rooms.workers.dev/room/$R/log?n=$N" | python3 -c '
import json, sys, datetime
d = json.load(sys.stdin)
for e in d.get("entries", []):
    t = datetime.datetime.fromtimestamp(e.pop("at", 0) / 1000).strftime("%H:%M:%S"); c = e.pop("c", ""); e.pop("ts", None)
    print(t, c.ljust(6), " ".join(f"{k}={v}" for k, v in e.items())[:300])
'
