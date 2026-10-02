# Measuring on a real phone over USB

The emulation numbers (M1 Pro) say nothing about a 2018–2020 phone's GPU or iOS memory accounting. Both scripts below drive the
engine test page (`research/test_engine.html`: 10 strokes, text encode per stroke, real-CLIP scoring) and the app itself.

## Android (Chrome, USB debugging on)
1. Phone: Settings → Developer options → USB debugging. Plug in, accept the prompt. `adb devices` must list it.
2. `adb forward tcp:9222 localabstract:chrome_devtools_remote` (Chrome must be open on the phone).
3. `adb reverse tcp:8080 tcp:8080` and serve the repo: `cd web && npx serve . -p 8080` (or `python3 -m http.server 8080`).
4. `node research/phone_android.mjs` — connects over CDP, opens `http://localhost:8080/research/test_engine.html?base=/models/&strokes=10&seconds=10&text=1`
   and the room page, prints tries/s, decode ms, text ms, and the JS heap; memory: `adb shell dumpsys meminfo com.android.chrome | head -40` during a stroke
   (look at "TOTAL PSS").

## iPhone (Safari)
1. Phone: Settings → Safari → Advanced → Web Inspector on, and (iOS 16+) Settings → Safari → Advanced → Remote Automation on. Plug in, trust the Mac.
2. Mac: `safaridriver --enable` once (asks for the password). Serve the repo on the Mac (`npx serve web -p 8080`), the phone reaches it over USB
   via Safari's remote inspector only for inspection, so use the Mac's Wi-Fi IP in the URL (same network) or the live gh-pages URL.
3. `python3 research/phone_ios.py http://<mac-ip>:8080` — WebDriver (selenium) through safaridriver to the device; prints the same numbers.
   Memory: Safari on the Mac → Develop → <iPhone> → the page → Timelines → Memory, or simply watch for the "This webpage was reloaded
   because it was using significant memory" banner during 10 strokes.

Report: phone model, OS version, tries/s, seconds per stroke, decode ms, whether a reload happened, and how the painting looked next to the laptop's.
