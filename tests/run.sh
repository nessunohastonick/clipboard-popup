#!/usr/bin/env bash
# Functional tests: runs the extension in an isolated headless GNOME Shell
# (own dconf, data and runtime dirs: the real session is not touched) and
# drives it with tests/cp-test@local. Needs GNOME Shell 50 and GTK 4 PyGObject.
#
#   tests/run.sh [zip]     default: dist/<uuid>.shell-extension.zip (run ./build.sh first)
#
# Exit status 0 only if every check passed. Output: results.txt, shell.log and
# popup.png in the work directory printed at the end.
set -u
H="$(cd "$(dirname "$0")" && pwd)"
UUID=clipboard-popup@claudiosaitta
ZIP="$(realpath "${1:-$H/../dist/$UUID.shell-extension.zip}")"
[ -f "$ZIP" ] || { echo "missing $ZIP: run ./build.sh" >&2; exit 2; }

T="$(mktemp -d "${TMPDIR:-/tmp}/cptest.XXXXXX")"
# The Wayland socket path is limited to 108 bytes: the runtime dir must be short.
RT="$(mktemp -d /tmp/cpt.XXXX)"; chmod 700 "$RT"
trap 'rm -rf "$RT"' EXIT
python3 -I "$H/mkpng.py" "$T/red.png" "$T/blue.png"

EXT="$T/data/gnome-shell/extensions"
mkdir -p "$EXT/$UUID" "$T/cfg" "$T/cache" "$T/state"
python3 -I -m zipfile -e "$ZIP" "$EXT/$UUID"
glib-compile-schemas "$EXT/$UUID/schemas"
cp -r "$H/cp-test@local" "$EXT/"

# Seed: session history with two texts, one existing image, one missing image,
# a stray image (garbage) and a file that is not ours.
RUN="$RT/clipboard-popup"; DATA="$T/data/clipboard-popup"
mkdir -p "$RUN" "$DATA"; chmod 700 "$RUN" "$DATA"
cp "$T/red.png" "$RUN/seed1.png"; cp "$T/red.png" "$RUN/zz9.png"; echo x > "$RUN/README-not-ours"
cat > "$RUN/history.json" <<J
[{"id":"a1","type":"text","text":"seed text one","pinned":false},
 {"id":"a2","type":"text","text":"seed text two","pinned":false},
 {"id":"a3","type":"image","file":"$RUN/seed1.png","mime":"image/png","hash":"h-red","pinned":false},
 {"id":"a4","type":"image","file":"$RUN/gone.png","mime":"image/png","hash":"h-gone","pinned":false}]
J
echo '[]' > "$DATA/pinned.json"

# env -i: the VS Code snap terminal exports GSETTINGS_SCHEMA_DIR, XDG_DATA_DIRS and
# GDK_BACKEND values that make gnome-shell and GTK apps fail.
env -i HOME="$HOME" PATH=/usr/bin:/bin LANG="${LANG:-C.UTF-8}" USER="$USER" \
  XDG_RUNTIME_DIR="$RT" XDG_DATA_HOME="$T/data" XDG_CONFIG_HOME="$T/cfg" \
  XDG_CACHE_HOME="$T/cache" XDG_STATE_HOME="$T/state" \
  XDG_DATA_DIRS=/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/ \
  XDG_CURRENT_DESKTOP=ubuntu:GNOME GNOME_SHELL_SESSION_MODE=ubuntu XDG_SESSION_TYPE=wayland \
  CPTEST_DIR="$T" CPTEST_HARNESS="$H" \
  dbus-run-session -- bash -c '
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"clipboard-popup@claudiosaitta\", \"cp-test@local\"]"
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display wl-x \
        > "$CPTEST_DIR/shell.log" 2>&1 &
    SH=$!
    for i in $(seq 100); do [ -S "$XDG_RUNTIME_DIR/wl-x" ] && break; sleep 0.2; done
    sleep 2
    # Paste target: a GTK window with a text entry that writes its content to target.txt.
    WAYLAND_DISPLAY=wl-x GDK_BACKEND=wayland python3 -I "$CPTEST_HARNESS/target.py" \
        "$CPTEST_DIR/target.txt" > "$CPTEST_DIR/target.log" 2>&1 &
    for i in $(seq 450); do grep -q "^DONE\|eccezione" "$CPTEST_DIR/results.txt" 2>/dev/null && break; sleep 0.2; done
    sleep 0.5
    kill $SH 2>/dev/null; wait $SH 2>/dev/null
  ' > "$T/session.log" 2>&1

cat "$T/results.txt" 2>/dev/null || echo "no results: see $T/shell.log"
ERRS="$(grep -E "clipboard-popup|JS ERROR|JS WARNING" "$T/shell.log" | grep -v '^DING:')"
[ -n "$ERRS" ] && { echo "--- shell log:"; echo "$ERRS"; }
echo "work dir: $T"
grep -q "^DONE fails=0$" "$T/results.txt" 2>/dev/null && [ -z "$ERRS" ]
