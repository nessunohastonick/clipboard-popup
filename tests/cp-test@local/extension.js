import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Test driver for Clipboard Popup, loaded only by tests/run.sh in a headless shell.
// Results go to $CPTEST_DIR/results.txt, one PASS/FAIL line per check.

const UUID = 'clipboard-popup@claudiosaitta';
const DIR = GLib.getenv('CPTEST_DIR');
const RESULTS = `${DIR}/results.txt`;
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

// Disabling the extension under test makes the shell disable and re-enable the ones
// loaded after it, this one included: run the suite only once.
let started = false;
let lines = [];
let fails = 0;
function log(s) {
    lines.push(s);
    GLib.file_set_contents(RESULTS, lines.join('\n') + '\n');
}
function check(name, cond, extra = '') {
    if (!cond) fails++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
}
const ext = () => Main.extensionManager.lookup(UUID);
const obj = () => ext().stateObj;
const items = () => obj().store.items;
const texts = () => items().filter(i => i.type === 'text').map(i => i.text);
const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
const readJ = p => { try { return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(p)[1])); } catch { return null; } };
const mode = p => Gio.File.new_for_path(p).query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777;
const clip = St.Clipboard.get_default();
const copyText = t => clip.set_text(St.ClipboardType.CLIPBOARD, t);
const copyImage = p => clip.set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(GLib.file_get_contents(p)[1]));

async function waitState(state, ms = 3000) {
    for (let t = 0; t < ms; t += 20) {
        if (ext()?.state === state) return true;
        await sleep(20);
    }
    return false;
}
async function disable() { Main.extensionManager.disableExtension(UUID); return waitState(2); }
async function enable() { Main.extensionManager.enableExtension(UUID); return waitState(1); }
async function shot(name) {
    const f = Gio.File.new_for_path(`${DIR}/${name}.png`);
    const stream = f.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}
function focusTarget() {
    const w = global.display.list_all_windows().find(x => x.get_title() === 'target');
    if (w) Main.activateWindow(w);
    return !!w;
}

async function run() {
    const run = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'clipboard-popup']);
    const data = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipboard-popup']);
    log(`runDir=${run} dataDir=${data}`);
    await waitState(1, 10000);
    await sleep(1500);

    // T1 load
    check('T1 carica la cronologia della sessione', JSON.stringify(texts()) === '["seed text one","seed text two"]', JSON.stringify(texts()));
    check('T1 tiene l\'immagine esistente, scarta quella mancante',
        items().filter(i => i.type === 'image').length === 1 && items().some(i => i.file === `${run}/seed1.png`));
    // T2 GC
    check('T2 il GC toglie il file orfano', !exists(`${run}/zz9.png`));
    check('T2 il GC lascia l\'immagine in uso', exists(`${run}/seed1.png`));
    check('T2 il GC lascia i file non suoi', exists(`${run}/README-not-ours`));

    // T3 copy text
    copyText('hello async');
    await sleep(800);
    check('T3 testo copiato in cima', texts()[0] === 'hello async', JSON.stringify(texts()));
    const hj = readJ(`${run}/history.json`);
    check('T3 history.json scritto', hj?.[0]?.text === 'hello async');
    check('T3 history.json con permessi 0600', mode(`${run}/history.json`) === 0o600, mode(`${run}/history.json`).toString(8));

    // T4 duplicate
    copyText('seed text two');
    await sleep(500);
    check('T4 duplicato sale in cima senza ripetersi', JSON.stringify(texts()) === '["seed text two","hello async","seed text one"]', JSON.stringify(texts()));

    // T5 image
    copyImage(`${DIR}/blue.png`);
    await sleep(800);
    const img = items()[0];
    check('T5 immagine copiata in cima', img?.type === 'image' && img.file.startsWith(run) && exists(img.file), JSON.stringify(img));
    check('T5 file immagine 0600', img && mode(img.file) === 0o600);

    // T6 pin image
    obj().store.togglePin(img.id);
    await sleep(900);
    const pinned = items().find(i => i.id === img.id);
    check('T6 immagine fissata spostata in dataDir', pinned.file.startsWith(data) && exists(pinned.file), pinned.file);
    check('T6 copia in runDir rimossa dal GC', !exists(`${run}/${GLib.path_get_basename(pinned.file)}`));
    check('T6 pinned.json contiene l\'immagine', readJ(`${data}/pinned.json`)?.some(i => i.id === img.id && i.file === pinned.file));
    check('T6 pinned.json 0600', mode(`${data}/pinned.json`) === 0o600);

    // T7 popup
    const childrenBefore = Main.uiGroup.get_n_children();
    obj()._toggle();
    await sleep(500);
    const popup = obj()._popup;
    check('T7 popup aperto con le righe', popup && popup._rows.length === items().length, `${popup?._rows.length} righe`);
    await shot('popup');
    obj()._toggle();
    await sleep(300);
    check('T7 popup chiuso e riferimenti azzerati', obj()._popup === null && popup._backdrop === null && popup._panel === null && popup._list === null && popup._scroll === null && popup._backdropIds === null);
    check('T7 nessun attore rimasto in uiGroup', Main.uiGroup.get_n_children() === childrenBefore, `${childrenBefore} -> ${Main.uiGroup.get_n_children()}`);

    // T8 paste text into GTK target
    let found = false;
    for (let i = 0; i < 50 && !(found = focusTarget()); i++) await sleep(200);
    check('T8 finestra bersaglio trovata', found);
    await sleep(400);
    obj()._toggle();
    await sleep(400);
    obj().pasteItem(items().find(i => i.text === 'hello async'));
    await sleep(60);
    await sleep(800);
    let got = '';
    try { got = new TextDecoder().decode(GLib.file_get_contents(`${DIR}/target.txt`)[1]); } catch {}
    
    obj()._toggle();
    await sleep(400);
    obj().pasteItem(items().find(i => i.text === 'seed text one'));
    await sleep(800);
    try { got = new TextDecoder().decode(GLib.file_get_contents(`${DIR}/target.txt`)[1]); } catch {}
    
    check('T8 testo incollato nella finestra', got.endsWith('seed text one'), JSON.stringify(got));
    check('T8 primo incolla dopo l\'avvio arrivato', got.startsWith('hello async'), JSON.stringify(got));
    check('T8 elemento incollato sale in cima', texts()[0] === 'seed text one');

    // T9 paste image
    obj().pasteItem(items().find(i => i.type === 'image' && i.pinned));
    await sleep(600);
    const mimes = clip.get_mimetypes(St.ClipboardType.CLIPBOARD);
    const size = await new Promise(r => clip.get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_c, b) => r(b?.get_size() ?? 0)));
    check('T9 immagine rimessa negli appunti', mimes.includes('image/png') && size === GLib.file_get_contents(`${DIR}/blue.png`)[1].length, `${mimes} ${size}`);
    check('T9 nessun duplicato dell\'immagine', items().filter(i => i.type === 'image' && i.hash === img.hash).length === 1);

    // T10 lock: copy, disable at once, enable at once
    copyText('before lock');
    await sleep(150);
    const countBefore = items().length;
    check('T10 disabilita', await disable());
    check('T10 riabilita', await enable());
    await sleep(1200);
    check('T10 cronologia intatta dopo blocco/sblocco', texts()[0] === 'before lock' && items().length === countBefore, `${items().length}/${countBefore} ${JSON.stringify(texts())}`);
    check('T10 immagine fissata ancora presente', items().some(i => i.id === img.id && i.pinned));
    focusTarget();
    await sleep(400);
    obj()._toggle();
    await sleep(400);
    obj().pasteItem(items().find(i => i.text === 'hello async'));
    await sleep(800);
    try { got = new TextDecoder().decode(GLib.file_get_contents(`${DIR}/target.txt`)[1]); } catch {}
    check('T10 primo incolla dopo lo sblocco arrivato', got.endsWith('seed text onehello async'), JSON.stringify(got));

    // T11 copy during load
    await disable();
    await enable();
    copyText('during load');
    await sleep(1200);
    check('T11 copia durante il caricamento in cima, senza perdite', texts()[0] === 'during load' && items().length === countBefore + 1, JSON.stringify(texts()));
    copyText('before lock');
    await sleep(400);
    await disable(); await enable();
    copyText('before lock');
    await sleep(1200);
    check('T11 duplicato copiato durante il caricamento non si ripete', texts().filter(t => t === 'before lock').length === 1, JSON.stringify(texts()));

    // T12 disable with popup open
    const c2 = Main.uiGroup.get_n_children();
    obj()._toggle();
    await sleep(300);
    check('T12 disabilita con popup aperto', await disable());
    check('T12 popup sparito', Main.uiGroup.get_n_children() === c2 && !Main.modalCount, `${c2} -> ${Main.uiGroup.get_n_children()}, modal ${Main.modalCount}`);
    await enable();
    await sleep(800);

    // T13 disable during image paste
    obj().pasteItem(items().find(i => i.type === 'image'));
    await disable();
    await sleep(600);
    check('T13 disabilitato durante incolla immagine senza errori', ext().state === 2);
    await enable();
    await sleep(800);

    // T14 max items
    const settings = obj().getSettings();
    const oldMax = settings.get_int('max-items');
    for (const t of ['x1', 'x2', 'x3', 'x4']) { copyText(t); await sleep(150); }
    await sleep(300);
    const unpinnedBefore = items().filter(i => !i.pinned).length;
    settings.set_int('max-items', 5);
    await sleep(800);
    check('T14 max-items taglia i non fissati', unpinnedBefore > 5 && items().filter(i => !i.pinned).length === 5 && texts()[0] === 'x4' && items().some(i => i.pinned), `${unpinnedBefore} -> ${items().length} elementi`);
    check('T14 history.json rispecchia il taglio', readJ(`${run}/history.json`)?.length === items().length);
    settings.set_int('max-items', oldMax);

    // T15 new session (reboot): runtime dir wiped
    await disable();
    await sleep(500);
    for (const n of ['history.json']) GLib.unlink(`${run}/${n}`);
    await enable();
    await sleep(1000);
    check('T15 nuova sessione: restano solo i fissati', items().length === 1 && items()[0].pinned && items()[0].type === 'image', JSON.stringify(items()));

    log(`DONE fails=${fails}`);
}

export default class T extends Extension {
    enable() { if (started) return; started = true; run().catch(e => log(`FAIL eccezione nel test: ${e}\n${e.stack}`)); }
    disable() {}
}
