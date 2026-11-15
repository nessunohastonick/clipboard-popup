import sys, gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk
out = sys.argv[1]
def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title='target')
    entry = Gtk.Entry()
    def changed(e):
        open(out, 'w').write(e.get_text())
    entry.connect('changed', changed)
    win.set_child(entry)
    win.set_default_size(400, 80)
    win.present()
    entry.grab_focus()
app = Gtk.Application(application_id='local.cptest.target')
app.connect('activate', on_activate)
app.run([])
