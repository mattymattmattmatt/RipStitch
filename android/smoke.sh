#!/usr/bin/env bash
# CI check for the Android app on an emulator: install, let the app run its own self-test against a
# local test clip (real downloads through the engine, Stitch, an export), take screenshots, report.
set -uo pipefail
PKG=io.github.mattymattmattmatt.ripstitch
OUT=android-smoke
EXT=/sdcard/Android/data/$PKG/files
APK=$(ls android/app/build/outputs/apk/release/*x86_64*.apk | head -1)
mkdir -p $OUT/shots

echo "== install $APK"
adb install -r -g "$APK" || exit 1

echo "== serve the test clip on the host (the emulator reaches it at 10.0.2.2)"
python3 -m http.server 9200 --bind 127.0.0.1 --directory $OUT/media > $OUT/http.log 2>&1 &

echo "== first launch (creates the app's folders, unpacks Python and FFmpeg)"
adb shell am start -W -n $PKG/.MainActivity
sleep 8
adb shell mkdir -p $EXT
echo '{"url":"http://10.0.2.2:9200/clip.mp4"}' > $OUT/smoke.json
adb push $OUT/smoke.json $EXT/smoke.json
adb shell am force-stop $PKG
adb logcat -c

echo "== launch with the self-test"
adb shell am start -W -n $PKG/.MainActivity
taken=" "; res=""
for i in $(seq 1 330); do
  res=$(adb shell cat $EXT/smoke-result.txt 2>/dev/null | tr -d '\r')
  for ph in $(printf '%s\n' "$res" | sed -n 's/^phase: //p'); do
    case "$taken" in *" $ph "*) ;; *) adb exec-out screencap -p > $OUT/shots/android-$ph.png; taken="$taken$ph "; echo "  screenshot $ph";; esac
  done
  printf '%s\n' "$res" | grep -q '^result:' && break
  sleep 2
done
echo "$res"
adb logcat -d -v time RipStitch:V RipStitch-web:V RipStitch-smoke:V AndroidRuntime:E '*:S' > $OUT/logcat.txt 2>&1
adb pull $EXT/engine.log $OUT/ >/dev/null 2>&1
adb pull $EXT/engine-console.log $OUT/ >/dev/null 2>&1
echo "--- page errors"; grep -E " E/RipStitch-web" $OUT/logcat.txt | tail -20 || true
if ! printf '%s\n' "$res" | grep -q '^result: ok'; then
  echo "::error::Android self-test failed"
  echo "--- logcat"; tail -80 $OUT/logcat.txt
  echo "--- engine.log"; tail -60 $OUT/engine.log 2>/dev/null
  echo "--- engine console"; tail -40 $OUT/engine-console.log 2>/dev/null
  exit 1
fi
echo "== all good"
