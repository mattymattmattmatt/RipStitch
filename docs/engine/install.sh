#!/usr/bin/env bash
# RipStitch Engine installer for macOS and Linux.
#
#   curl -fsSL https://mattymattmattmatt.github.io/RipStitch/engine/install.sh | bash
#
# Installs for this user only, starts the engine at login, keeps yt-dlp up to date,
# and opens RipStitch. Run it again any time to repair or update.
# Uninstall:  curl -fsSL https://mattymattmattmatt.github.io/RipStitch/engine/install.sh | bash -s -- --uninstall
set -euo pipefail

APP_URL="${RIPSTITCH_APP_URL:-https://mattymattmattmatt.github.io/RipStitch/}"
LABEL="io.github.mattymattmattmatt.ripstitch"
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  DIR="$HOME/Library/Application Support/RipStitch/app"
else
  DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ripstitch/app"
fi
ENGINE="$DIR/engine/ripstitch_engine.py"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ripstitch.service"
DESKTOP="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/ripstitch-engine.desktop"

if [ -t 1 ]; then O=$'\e[38;5;208m'; Y=$'\e[38;5;220m'; G=$'\e[32m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else O= Y= G= R= D= N=; fi
say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '  %s✗ %s%s\n' "$R" "$*" "$N"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

printf '\n  %s▶ Rip%s%sStitch%s %sengine installer%s\n  %s────────────────────────────────────────────%s\n' "$O" "$N" "$Y" "$N" "$D" "$N" "$D" "$N"

remove_autostart() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  else
    if [ -f "$UNIT" ]; then
      systemctl --user disable --now ripstitch.service 2>/dev/null || true
      rm -f "$UNIT"; systemctl --user daemon-reload 2>/dev/null || true
    fi
    rm -f "$DESKTOP"
  fi
}

find_python() {
  local c
  for c in python3.13 python3.12 python3.11 python3.10 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
    if have "$c" && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      PY="$(command -v "$c")"; return 0
    fi
  done
  return 1
}

if [ "${1:-}" = "--uninstall" ]; then
  if find_python && [ -f "$ENGINE" ]; then "$PY" "$ENGINE" --stop >/dev/null 2>&1 || true; fi
  remove_autostart
  rm -rf "$DIR"
  ok "RipStitch Engine removed. Your downloads and settings were left alone."
  exit 0
fi

# 1. Python 3.10+ ------------------------------------------------------------
if ! find_python; then
  say "Installing Python…"
  if [ "$OS" = "Darwin" ] && have brew; then brew install python
  elif have apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq python3 python3-venv
  elif have dnf; then $SUDO dnf install -y python3
  elif have pacman; then $SUDO pacman -S --noconfirm python
  fi
  find_python || die "Python 3.10 or newer is needed. Get it from https://www.python.org/downloads/ and run this again."
fi
if ! "$PY" -c 'import venv, ensurepip' 2>/dev/null && have apt-get; then
  say "Adding Python's venv module…"
  $SUDO apt-get install -y -qq python3-venv || true
fi
ok "Python $("$PY" -c 'import platform; print(platform.python_version())') ($PY)"

# 2. FFmpeg (merges HD video + audio, converts audio, cuts sections) ---------
if have ffmpeg && have ffprobe; then ok "FFmpeg already installed"
else
  say "Installing FFmpeg…"
  if [ "$OS" = "Darwin" ] && have brew; then brew install ffmpeg || true
  elif have apt-get; then $SUDO apt-get install -y -qq ffmpeg || true
  elif have dnf; then $SUDO dnf install -y ffmpeg || true
  elif have pacman; then $SUDO pacman -S --noconfirm ffmpeg || true
  fi
  if have ffmpeg; then ok "FFmpeg installed"
  else warn "Couldn't install FFmpeg automatically. Without it, HD and audio downloads are limited. https://ffmpeg.org/download.html"; fi
fi

# 3. Deno (yt-dlp uses it to unlock YouTube's full format list) ---------------
if have deno || [ -x "$HOME/.deno/bin/deno" ]; then ok "Deno already installed"
else
  say "Installing Deno…"
  if [ "$OS" = "Darwin" ] && have brew; then brew install deno >/dev/null 2>&1 || true
  else curl -fsSL https://deno.land/install.sh 2>/dev/null | sh -s -- -y --no-modify-path >/dev/null 2>&1 || true
  fi
  if have deno || [ -x "$HOME/.deno/bin/deno" ]; then ok "Deno installed"
  else warn "Couldn't install Deno. YouTube may offer fewer qualities. https://deno.com"; fi
fi

# 4. The engine itself ---------------------------------------------------------
mkdir -p "$DIR/engine"
if [ -f "$ENGINE" ]; then "$PY" "$ENGINE" --stop >/dev/null 2>&1 || true; fi
curl -fsSL "${APP_URL}engine/ripstitch_engine.py?v=$(date +%s)" -o "$ENGINE.new" || die "Couldn't download the engine from $APP_URL"
grep -q 'RipStitch Engine' "$ENGINE.new" || die "The download doesn't look like the RipStitch engine."
mv "$ENGINE.new" "$ENGINE"
printf '{"kind": "script", "installed": "%s"}\n' "$(date +%Y-%m-%d)" > "$DIR/installed.json"
ok "Engine $(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$ENGINE") saved to $DIR"
say "Setting up yt-dlp in a private runtime (about 30 seconds)…"
"$PY" "$ENGINE" --install >/dev/null || die "yt-dlp setup failed. Run: \"$PY\" \"$ENGINE\" --install"
ok "yt-dlp ready"

# 5. Start at login, and now ---------------------------------------------------
remove_autostart
if [ "$OS" = "Darwin" ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$ENGINE</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  ok "Starts at login (LaunchAgent)"
elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNIT
[Unit]
Description=RipStitch Engine (lets the RipStitch website download with yt-dlp)

[Service]
ExecStart="$PY" "$ENGINE" --background
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now ripstitch.service >/dev/null 2>&1
  ok "Starts at login (systemd user service)"
else
  mkdir -p "$(dirname "$DESKTOP")"
  cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=RipStitch Engine
Comment=Lets the RipStitch website download with yt-dlp
Exec="$PY" "$ENGINE" --background
X-GNOME-Autostart-enabled=true
NoDisplay=true
DESK
  nohup "$PY" "$ENGINE" --background >/dev/null 2>&1 &
  ok "Starts at login (autostart entry)"
fi

for _ in $(seq 1 40); do
  if curl -fsS --noproxy '*' -m 2 http://127.0.0.1:8731/api/ping >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if curl -fsS --noproxy '*' -m 2 http://127.0.0.1:8731/api/ping >/dev/null 2>&1; then
  ok "Engine running on 127.0.0.1:8731"
else
  if [ "$OS" = "Darwin" ]; then LOG="$HOME/Library/Application Support/RipStitch/engine.log"; else LOG="${XDG_CONFIG_HOME:-$HOME/.config}/ripstitch/engine.log"; fi
  warn "The engine didn't answer yet. Its log: $LOG"
fi

printf '\n  %sDone.%s Open %s and paste a link.\n\n' "$G" "$N" "$APP_URL"
if [ -z "${RIPSTITCH_NO_OPEN:-}" ]; then
  if [ "$OS" = "Darwin" ]; then open "$APP_URL" 2>/dev/null || true
  elif have xdg-open && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then xdg-open "$APP_URL" >/dev/null 2>&1 || true
  fi
fi
