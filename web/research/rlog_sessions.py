"""List recent remote-log sessions (room, time, device). Usage: python3 rlog_sessions.py [n] [regex]"""
import json, sys, datetime, re, urllib.request
n = sys.argv[1] if len(sys.argv) > 1 else "60"; pat = re.compile(sys.argv[2] if len(sys.argv) > 2 else ".", re.I)
req = urllib.request.Request(f"https://vqpaint-rooms.vqpaint-rooms.workers.dev/logs/recent?n={n}", headers={"User-Agent": "Mozilla/5.0 vqpaint-rlog"}); d = json.load(urllib.request.urlopen(req))
for s in d.get("sessions", []):
    line = f"{datetime.datetime.fromtimestamp(s['ts'] / 1000).strftime('%m-%d %H:%M')}  {s['room']:16s} {s.get('c', ''):6s} {(s.get('ua') or '')[:70]}  {(s.get('gl') or '')[:40]}"
    if pat.search(line): print(line)
