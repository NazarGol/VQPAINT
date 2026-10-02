"""Drive Safari on a USB-connected iPhone with safaridriver (Remote Automation on). Usage: python3 phone_ios.py http://<mac-ip>:8080  (pip install selenium)"""
import json, sys, time
from selenium import webdriver
from selenium.webdriver.safari.options import Options
base = sys.argv[1] if len(sys.argv) > 1 else "https://nazargol.github.io/VQPAINT"
opts = Options(); opts.set_capability("platformName", "iOS")
d = webdriver.Safari(options=opts)
url = f"{base}/research/test_engine.html?base=/models/&strokes=10&seconds=10&text=1"
print("opening", url); d.get(url); t0 = time.time()
while time.time() - t0 < 600:
    r = d.execute_script("return window.__result || null")
    if r: break
    time.sleep(2)
tries = [round(s["perSec"]) for s in r["strokes"]]
print(json.dumps({"ok": r["ok"], "error": r.get("error"), "renderer": r.get("renderer"), "loadMs": r.get("loadMs"), "strokes": len(r["strokes"]), "triesPerSec": tries, "decodeMs": [round(s["decodeMs"], 1) for s in r["strokes"]], "textMs": r.get("textMs"), "totalSec": round(time.time() - t0)}))
d.quit()
