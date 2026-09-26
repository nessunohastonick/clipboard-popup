#!/usr/bin/env bash
# Builds the zip to upload to extensions.gnome.org.
# Translations are compiled with Python, so gettext's msgfmt is not required.
set -euo pipefail
cd "$(dirname "$0")"

UUID="$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')"
DOMAIN="$(python3 -c 'import json; print(json.load(open("metadata.json"))["gettext-domain"])')"

python3 - "$DOMAIN" <<'PY'
import ast, glob, os, re, struct, sys

domain = sys.argv[1]

# Refresh the template from the _('...') calls in the sources.
msgids = []
for src in ('extension.js', 'prefs.js'):
    for m in re.finditer(r"""_\((['"])((?:\\.|(?!\1).)*)\1\)""", open(src, encoding='utf-8').read()):
        s = m.group(2).replace("\\'", "'")
        if s not in msgids:
            msgids.append(s)
esc = lambda s: s.replace('\\', '\\\\').replace('"', '\\"')
with open(f'po/{domain}.pot', 'w', encoding='utf-8') as f:
    f.write('msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n')
    for s in msgids:
        f.write(f'msgid "{esc(s)}"\nmsgstr ""\n\n')

def parse_po(path):
    entries, key, cur = {}, None, None
    def flush():
        if key is not None:
            entries[key] = cur
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line.startswith('msgid '):
            flush()
            key, cur, mode = ast.literal_eval(line[6:]), '', 'id'
        elif line.startswith('msgstr '):
            cur, mode = ast.literal_eval(line[7:]), 'str'
        elif line.startswith('"'):
            if mode == 'id':
                key += ast.literal_eval(line)
            else:
                cur += ast.literal_eval(line)
    flush()
    return entries

def write_mo(entries, path):
    items = sorted((k.encode(), v.encode()) for k, v in entries.items() if v or k == '')
    n = len(items)
    ids = strs = b''
    offsets = []
    for k, v in items:
        offsets.append((len(ids), len(k), len(strs), len(v)))
        ids += k + b'\0'
        strs += v + b'\0'
    keystart = 7 * 4 + 16 * n
    valuestart = keystart + len(ids)
    koffsets, voffsets = [], []
    for o1, l1, o2, l2 in offsets:
        koffsets += [l1, o1 + keystart]
        voffsets += [l2, o2 + valuestart]
    out = struct.pack('Iiiiiii', 0x950412de, 0, n, 7 * 4, 7 * 4 + n * 8, 0, 0)
    out += struct.pack(f'{len(koffsets)}i', *koffsets) + struct.pack(f'{len(voffsets)}i', *voffsets)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(out + ids + strs)

for po in glob.glob('po/*.po'):
    lang = os.path.splitext(os.path.basename(po))[0]
    entries = parse_po(po)
    missing = [s for s in msgids if not entries.get(s)]
    if missing:
        print(f'{lang}: {len(missing)} untranslated: {missing}', file=sys.stderr)
    write_mo(entries, f'locale/{lang}/LC_MESSAGES/{domain}.mo')
    print(f'{lang}: {sum(1 for s in msgids if entries.get(s))}/{len(msgids)} strings')
PY

# pack runs msgfmt whenever it sees a po/ folder, so it works on a copy without it.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r metadata.json extension.js prefs.js stylesheet.css LICENSE schemas locale "$STAGE/"
mkdir -p dist
gnome-extensions pack --force --out-dir="$PWD/dist" \
    --extra-source=LICENSE \
    --extra-source=locale \
    --schema="schemas/org.gnome.shell.extensions.clipboard-popup.gschema.xml" \
    "$STAGE"
echo "dist/$UUID.shell-extension.zip"
