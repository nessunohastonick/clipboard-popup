// Clipboard Popup — Windows-style clipboard history (Super+V) for GNOME Shell.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Behaviour mirrors Windows' clipboard history:
//  - every copy goes to the top of the history (duplicates move up instead of repeating);
//  - a limited number of unpinned items, pinned items never expire;
//  - after a reboot only pinned items survive;
//  - "Clear all" leaves pinned items alone;
//  - choosing an item puts it back on the clipboard and pastes it into the focused window.
//
// Unpinned items live in $XDG_RUNTIME_DIR (tmpfs, wiped at logout/reboot) so they
// survive the screen lock, during which GNOME disables extensions.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const DIR_NAME = 'clipboard-popup';
const MAX_TEXT_CHARS = 1_000_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const PANEL_WIDTH = 380;
const PANEL_MAX_HEIGHT = 520;

const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
// Password managers (KeePassXC, Bitwarden, ...) mark secrets with this type.
const SECRET_MIME = 'x-kde-passwordManagerHint';
// Terminals paste with Ctrl+Shift+V instead of Ctrl+V.
const TERMINALS = ['gnome-terminal', 'ptyxis', 'org.gnome.console', 'kgx', 'kitty', 'alacritty',
    'foot', 'ghostty', 'terminator', 'tilix', 'konsole', 'xterm', 'wezterm', 'blackbox'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readJson(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        return ok ? JSON.parse(decoder.decode(contents)) : null;
    } catch {
        return null;
    }
}

function writeJson(path, data) {
    try {
        GLib.file_set_contents(path, encoder.encode(JSON.stringify(data)));
    } catch (e) {
        console.error(`clipboard-popup: cannot write ${path}: ${e.message}`);
    }
}

function newId() {
    return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function previewText(text) {
    const lines = text.slice(0, 2000).replace(/\t/g, '    ').split('\n');
    let out = lines.slice(0, 4).map(l => (l.length > 160 ? `${l.slice(0, 160)}…` : l)).join('\n');
    if (lines.length > 4 || text.length > 2000)
        out += '\n…';
    return out.trim() ? out : _('(whitespace only)');
}

class Store {
    constructor(maxItems) {
        this.runDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), DIR_NAME]);
        this.dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), DIR_NAME]);
        GLib.mkdir_with_parents(this.runDir, 0o700);
        GLib.mkdir_with_parents(this.dataDir, 0o700);
        this._sessionFile = GLib.build_filenamev([this.runDir, 'history.json']);
        this._pinnedFile = GLib.build_filenamev([this.dataDir, 'pinned.json']);
        this._saveId = 0;
        this._maxItems = maxItems;
        this.items = [];
        this.onChanged = null;
    }

    load() {
        // Same session (e.g. after unlocking): full history.
        // New session: pinned items only, as Windows does after a reboot.
        const items = readJson(this._sessionFile) ?? readJson(this._pinnedFile) ?? [];
        this.items = items.filter(it =>
            it && (it.type === 'text' ? typeof it.text === 'string'
                : it.type === 'image' && GLib.file_test(it.file, GLib.FileTest.EXISTS)));
    }

    set maxItems(value) {
        this._maxItems = value;
        this._trim();
        this._changed();
    }

    addText(text) {
        const idx = this.items.findIndex(it => it.type === 'text' && it.text === text);
        this._insert(idx, () => ({id: newId(), type: 'text', text, pinned: false}));
    }

    addImage(bytes, mime) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes);
        const idx = this.items.findIndex(it => it.type === 'image' && it.hash === hash);
        if (idx >= 0) {
            this._insert(idx, null);
            return;
        }
        const id = newId();
        const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'img';
        const path = GLib.build_filenamev([this.runDir, `${id}.${ext}`]);
        Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    console.error(`clipboard-popup: cannot save image: ${e.message}`);
                    return;
                }
                if (this.onChanged)
                    this._insert(-1, () => ({id, type: 'image', file: path, mime, hash, pinned: false}));
            });
    }

    _insert(existingIdx, make) {
        let item;
        if (existingIdx >= 0)
            [item] = this.items.splice(existingIdx, 1);
        else
            item = make();
        this.items.unshift(item);
        this._trim();
        this._changed();
    }

    _trim() {
        let unpinned = 0;
        this.items = this.items.filter(it => it.pinned || ++unpinned <= this._maxItems);
    }

    remove(id) {
        this.items = this.items.filter(it => it.id !== id);
        this._changed();
    }

    togglePin(id) {
        const item = this.items.find(it => it.id === id);
        if (item) {
            item.pinned = !item.pinned;
            this._changed();
        }
    }

    clearUnpinned() {
        this.items = this.items.filter(it => it.pinned);
        this._changed();
    }

    _changed() {
        this.onChanged?.();
        if (!this._saveId) {
            this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._saveId = 0;
                this.save();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    save() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        // Pinned images must survive a reboot, so they move out of the tmpfs.
        for (const it of this.items) {
            if (it.type === 'image' && it.pinned && !it.file.startsWith(this.dataDir)) {
                const dest = GLib.build_filenamev([this.dataDir, GLib.path_get_basename(it.file)]);
                try {
                    Gio.File.new_for_path(it.file).copy(Gio.File.new_for_path(dest),
                        Gio.FileCopyFlags.OVERWRITE, null, null);
                    it.file = dest;
                } catch (e) {
                    console.error(`clipboard-popup: cannot copy pinned image: ${e.message}`);
                }
            }
        }
        writeJson(this._sessionFile, this.items);
        writeJson(this._pinnedFile, this.items.filter(it => it.pinned));
        this._collectGarbage();
    }

    _collectGarbage() {
        const used = new Set(this.items.filter(it => it.type === 'image').map(it => it.file));
        for (const dir of [this.runDir, this.dataDir]) {
            let en;
            try {
                en = Gio.File.new_for_path(dir).enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch {
                continue;
            }
            for (let info; (info = en.next_file(null));) {
                const name = info.get_name();
                const path = GLib.build_filenamev([dir, name]);
                // Only images created here (id.extension): anything else is not ours.
                if (/^[a-z0-9]+\.[a-z0-9]+$/.test(name) && !name.endsWith('.json') && !used.has(path))
                    GLib.unlink(path);
            }
            en.close(null);
        }
    }

    destroy() {
        this.save();
        this.onChanged = null;
    }
}

class HistoryPopup {
    constructor(ext) {
        this._ext = ext;
        this._rows = [];
        this._selected = 0;
        this._grab = null;

        this._backdrop = new St.Widget({reactive: true, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height});
        this._backdrop.connect('key-press-event', (_a, ev) => this._onKey(ev));
        this._backdrop.connect('button-press-event', (_a, ev) => this._onBackdropPress(ev));

        this._panel = new St.BoxLayout({style_class: 'cp-panel', reactive: true,
            orientation: Clutter.Orientation.VERTICAL});
        this._backdrop.add_child(this._panel);

        const header = new St.BoxLayout({style_class: 'cp-header'});
        header.add_child(new St.Label({text: _('Clipboard'), style_class: 'cp-title', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER}));
        const clearBtn = new St.Button({label: _('Clear all'), style_class: 'cp-clear'});
        clearBtn.connect('clicked', () => this._ext.store.clearUnpinned());
        header.add_child(clearBtn);
        this._panel.add_child(header);

        this._list = new St.BoxLayout({style_class: 'cp-list',
            orientation: Clutter.Orientation.VERTICAL});
        this._scroll = new St.ScrollView({style_class: 'cp-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._list});
        this._panel.add_child(this._scroll);
    }

    open() {
        Main.uiGroup.add_child(this._backdrop);
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        this._backdrop.grab_key_focus();
        this._selected = 0;
        this.rebuild();
    }

    rebuild() {
        this._list.destroy_all_children();
        this._rows = [];
        const items = this._ext.store.items;
        if (!items.length) {
            const empty = new St.BoxLayout({style_class: 'cp-empty',
                orientation: Clutter.Orientation.VERTICAL});
            empty.add_child(new St.Label({text: _('Nothing here yet'), style_class: 'cp-empty-title'}));
            const sub = new St.Label({text: _('Items you copy will show up here.')});
            sub.clutter_text.line_wrap = true;
            empty.add_child(sub);
            this._list.add_child(empty);
        }
        items.forEach((item, i) => this._list.add_child(this._makeRow(item, i)));
        this._selected = Math.max(0, Math.min(this._selected, this._rows.length - 1));
        this._select(this._selected);
        this._place();
    }

    _makeRow(item, index) {
        const row = new St.BoxLayout({style_class: 'cp-item', reactive: true, track_hover: true});
        row.connect('enter-event', () => this._select(index, false));

        let content;
        if (item.type === 'text') {
            content = new St.Label({text: previewText(item.text), style_class: 'cp-text',
                x_expand: true, x_align: Clutter.ActorAlign.START});
            content.clutter_text.line_wrap = true;
            content.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            content.clip_to_allocation = true;
        } else {
            content = new St.Widget({style_class: 'cp-image', x_expand: true, x_align: Clutter.ActorAlign.FILL,
                style: `background-image: url("${item.file}");`});
        }
        const body = new St.Button({style_class: 'cp-body', x_expand: true, child: content,
            x_align: Clutter.ActorAlign.FILL});
        body.connect('clicked', () => this._ext.pasteItem(item));
        row.add_child(body);

        const side = new St.BoxLayout({style_class: 'cp-side', orientation: Clutter.Orientation.VERTICAL});
        const pin = new St.Button({style_class: 'cp-icon-btn', can_focus: false,
            accessible_name: item.pinned ? _('Unpin') : _('Pin'),
            child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 14})});
        if (item.pinned)
            pin.add_style_class_name('cp-pin-on');
        pin.connect('clicked', () => this._ext.store.togglePin(item.id));
        const del = new St.Button({style_class: 'cp-icon-btn', can_focus: false,
            accessible_name: _('Delete'),
            child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 14})});
        del.connect('clicked', () => this._ext.store.remove(item.id));
        side.add_child(pin);
        side.add_child(del);
        row.add_child(side);

        this._rows.push({row, item});
        return row;
    }

    _select(index, scroll = true) {
        if (!this._rows.length)
            return;
        this._rows[this._selected]?.row.remove_style_class_name('cp-selected');
        this._selected = Math.max(0, Math.min(index, this._rows.length - 1));
        const {row} = this._rows[this._selected];
        row.add_style_class_name('cp-selected');
        if (scroll)
            ensureActorVisibleInScrollView(this._scroll, row);
    }

    _place() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = PANEL_WIDTH * scale;
        const [, natHeight] = this._panel.get_preferred_height(width);
        const height = Math.min(natHeight, PANEL_MAX_HEIGHT * scale);
        this._panel.set_size(width, height);

        if (this._anchor === undefined) {
            const [px, py] = global.get_pointer();
            this._anchor = {px, py};
        }
        const {px, py} = this._anchor;
        const monIndex = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: px, y: py, width: 1, height: 1}));
        const mon = Main.layoutManager.monitors[monIndex] ?? Main.layoutManager.primaryMonitor;
        const margin = 12 * scale;
        const x = Math.min(Math.max(px, mon.x + margin), mon.x + mon.width - width - margin);
        let y = py + 16 * scale;
        if (y + height > mon.y + mon.height - margin)
            y = Math.max(mon.y + margin, py - height - 16 * scale);
        this._panel.set_position(Math.round(x), Math.round(y));
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        if ((state & Clutter.ModifierType.MOD4_MASK) && (sym === Clutter.KEY_v || sym === Clutter.KEY_V)) {
            this._ext.closePopup();
            return Clutter.EVENT_STOP;
        }
        const current = this._rows[this._selected]?.item;
        switch (sym) {
        case Clutter.KEY_Escape:
            this._ext.closePopup();
            break;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._select(this._selected - 1);
            break;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._select(this._selected + 1);
            break;
        case Clutter.KEY_Home:
            this._select(0);
            break;
        case Clutter.KEY_End:
            this._select(this._rows.length - 1);
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            if (current)
                this._ext.pasteItem(current);
            break;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            if (current)
                this._ext.store.remove(current.id);
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _onBackdropPress(event) {
        const [x, y] = event.get_coords();
        const [px, py] = this._panel.get_transformed_position();
        const [pw, ph] = this._panel.get_transformed_size();
        if (x < px || x > px + pw || y < py || y > py + ph) {
            this._ext.closePopup();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._backdrop.destroy();
    }
}

export default class ClipboardPopupExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._shellKeys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});

        this.store = new Store(this._settings.get_int('max-items'));
        this.store.load();
        this.store.onChanged = () => this._popup?.rebuild();
        this._popup = null;
        this._pasteId = 0;
        this._clipboard = St.Clipboard.get_default();

        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed',
            (_sel, type, source) => this._onOwnerChanged(type, source));

        this._settingsIds = [
            this._settings.connect('changed::max-items', () => {
                this.store.maxItems = this._settings.get_int('max-items');
            }),
            this._settings.connect('changed::toggle-history', () => {
                this._restoreShellShortcut();
                this._freeShellShortcut();
            }),
        ];

        this._freeShellShortcut();
        Main.wm.addKeybinding('toggle-history', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-history');
        this._restoreShellShortcut();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = null;
        this._selection.disconnect(this._ownerId);
        this.closePopup();
        if (this._pasteId) {
            GLib.source_remove(this._pasteId);
            this._pasteId = 0;
        }
        this.store.destroy();
        this.store = null;
        this._settings = null;
        this._shellKeys = null;
        this._selection = null;
        this._clipboard = null;
        this._keyboard = null;
    }

    // GNOME binds Super+V to the notification list. While enabled, the extension takes
    // over whichever of its own shortcuts collide with it, and gives them back on disable.
    _freeShellShortcut() {
        const ours = this._settings.get_strv('toggle-history').map(a => a.toLowerCase());
        const tray = this._shellKeys.get_strv('toggle-message-tray');
        const taken = tray.filter(a => ours.includes(a.toLowerCase()));
        if (!taken.length)
            return;
        const already = this._settings.get_strv('freed-shell-shortcuts');
        this._settings.set_strv('freed-shell-shortcuts', [...new Set([...already, ...taken])]);
        this._shellKeys.set_strv('toggle-message-tray', tray.filter(a => !taken.includes(a)));
    }

    _restoreShellShortcut() {
        const freed = this._settings.get_strv('freed-shell-shortcuts');
        if (!freed.length)
            return;
        const tray = this._shellKeys.get_strv('toggle-message-tray');
        const present = tray.map(a => a.toLowerCase());
        this._shellKeys.set_strv('toggle-message-tray',
            [...freed.filter(a => !present.includes(a.toLowerCase())), ...tray]);
        this._settings.set_strv('freed-shell-shortcuts', []);
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
            return;
        const mimes = source.get_mimetypes();
        if (mimes.includes(SECRET_MIME))
            return;

        if (mimes.some(m => TEXT_MIMES.includes(m))) {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                if (text && text.length <= MAX_TEXT_CHARS)
                    this.store?.addText(text);
            });
            return;
        }
        if (!this._settings.get_boolean('store-images'))
            return;
        const mime = mimes.includes('image/png') ? 'image/png' : mimes.find(m => m.startsWith('image/'));
        if (mime) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (_c, bytes) => {
                const size = bytes?.get_size() ?? 0;
                if (size > 0 && size <= MAX_IMAGE_BYTES)
                    this.store?.addImage(bytes, mime);
            });
        }
    }

    _toggle() {
        if (this._popup) {
            this.closePopup();
            return;
        }
        this._popup = new HistoryPopup(this);
        this._popup.open();
    }

    closePopup() {
        this._popup?.destroy();
        this._popup = null;
    }

    pasteItem(item) {
        this.closePopup();
        if (item.type === 'text') {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.text);
        } else {
            try {
                const [, contents] = GLib.file_get_contents(item.file);
                this._clipboard.set_content(St.ClipboardType.CLIPBOARD, item.mime,
                    new GLib.Bytes(contents));
            } catch (e) {
                console.error(`clipboard-popup: cannot read image: ${e.message}`);
                return;
            }
        }
        // Give the window time to get its focus back before sending it Ctrl+V.
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._pasteId = 0;
            this._sendPasteKeys();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteKeys() {
        const wmClass = (global.display.focus_window?.get_wm_class() ?? '').toLowerCase();
        const terminal = TERMINALS.some(t => wmClass.includes(t));
        this._keyboard ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const keys = terminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const t = GLib.get_monotonic_time();
        for (const k of keys)
            this._keyboard.notify_keyval(t, k, Clutter.KeyState.PRESSED);
        for (const k of keys.reverse())
            this._keyboard.notify_keyval(t, k, Clutter.KeyState.RELEASED);
    }
}
