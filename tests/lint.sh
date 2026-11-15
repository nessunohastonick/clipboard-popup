#!/usr/bin/env bash
# Runs Shexli, the analyzer extensions.gnome.org shows on review pages, on the zip.
# No pip needed: the wheels are fetched from PyPI once and unpacked into a cache dir.
#
#   tests/lint.sh [zip]
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
ZIP="${1:-$H/../dist/clipboard-popup@claudiosaitta.shell-extension.zip}"
LIB="${XDG_CACHE_HOME:-$HOME/.cache}/clipboard-popup-shexli/$(python3 -I -c 'import sys; print(sys.implementation.cache_tag)')"
if [ ! -d "$LIB/shexli" ]; then
    mkdir -p "$LIB"
    python3 -I - "$LIB" <<'PY'
import io, json, sys, sysconfig, urllib.request, zipfile
lib = sys.argv[1]
tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
arch = sysconfig.get_platform().split('-')[-1]
def fits(name):
    if name.endswith('-none-any.whl'):
        return True
    return 'manylinux' in name and arch in name and (f'-{tag}-' in name or '-abi3-' in name)
for pkg in ('shexli', 'tree-sitter', 'tree-sitter-javascript'):
    files = json.load(urllib.request.urlopen(f'https://pypi.org/pypi/{pkg}/json'))['urls']
    whl = next(f for f in files if f['filename'].endswith('.whl') and fits(f['filename']))
    print('fetching', whl['filename'])
    zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(whl['url']).read())).extractall(lib)
PY
fi
PYTHONPATH="$LIB" python3 -m shexli --format text "$ZIP"
