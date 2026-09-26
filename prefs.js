// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClipboardPopupPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const shortcutRow = new Adw.ActionRow({
            title: _('Shortcut'),
            subtitle: _('Opens the clipboard history'),
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const updateLabel = () =>
            shortcutLabel.set_accelerator(settings.get_strv('toggle-history')[0] ?? '');
        updateLabel();
        settings.connect('changed::toggle-history', updateLabel);

        const changeButton = new Gtk.Button({label: _('Change…'), valign: Gtk.Align.CENTER});
        changeButton.connect('clicked', () => this._captureShortcut(window, settings));
        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to Super+V'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetButton.connect('clicked', () => settings.reset('toggle-history'));
        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.add_suffix(changeButton);
        shortcutRow.add_suffix(resetButton);
        group.add(shortcutRow);

        const sizeRow = new Adw.SpinRow({
            title: _('History size'),
            subtitle: _('Pinned items do not count toward the limit'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 100, step_increment: 1, page_increment: 5}),
        });
        settings.bind('max-items', sizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(sizeRow);

        const imagesRow = new Adw.SwitchRow({
            title: _('Save images'),
            subtitle: _('Keep copied images in the history, not only text'),
        });
        settings.bind('store-images', imagesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(imagesRow);

        window.set_default_size(600, 400);
        window.add(page);
    }

    _captureShortcut(window, settings) {
        const dialog = new Adw.AlertDialog({
            heading: _('New shortcut'),
            body: _('Press the key combination to use. Esc cancels, Backspace disables the shortcut.'),
        });
        dialog.add_response('cancel', _('Cancel'));

        // Combinations GNOME Shell already uses never reach this window, so they cannot be
        // picked by mistake. Super+V comes back through the reset button.
        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!mods && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv('toggle-history', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // A shortcut without modifiers would steal ordinary typing.
            if (!mods || !Gtk.accelerator_valid(keyval, mods))
                return Gdk.EVENT_STOP;
            settings.set_strv('toggle-history', [Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mods)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(window);
    }
}
