// The settings window renders text only (BYOK PRD §11.2 "Hardening the
// shell", SC-3): a static scan of the renderer for every HTML sink, the CSP
// meta and what it allows, the window's hardening in main.mjs, and the words
// and numbers the page shows (renderer/format.js, run in a vm; the tray's
// src/status-text.mjs uses the same state words).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { STATE_WORDS, trayLine, createNotifier } from '../../app/desktop/src/status-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', '..', 'app', 'desktop');
const R = path.join(APP, 'renderer');
const read = f => fs.readFileSync(f, 'utf8');
const rendererFiles = () => fs.readdirSync(R).map(f => path.join(R, f));
/** Source with comments removed, so a comment that names a sink doesn't count and one can't hide one. */
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

function loadFormat() {
  const ctx = { globalThis: {} };
  ctx.window = ctx.globalThis;
  vm.createContext(ctx);
  // The page's table first, as index.html loads it: the bar's usage lines and the key store's are its ids.
  vm.runInContext(read(path.join(R, 'strings.js')), ctx);
  vm.runInContext(read(path.join(R, 'format.js')), ctx);
  return ctx.globalThis.BonesFormat;
}

test('the renderer never writes HTML: no innerHTML, outerHTML, insertAdjacentHTML, document.write or friends', () => {
  const sinks = [
    /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write(ln)?\s*\(/, /\beval\s*\(/, /\bnew\s+Function\s*\(/,
    /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /createContextualFragment/, /DOMParser/, /\.srcdoc\b/,
    /javascript:/i, /\.setHTMLUnsafe|parseHTMLUnsafe/, /\bdocument\.domain\b/,
  ];
  const files = rendererFiles().filter(f => /\.(js|html)$/.test(f));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const src = f.endsWith('.js') ? code(read(f)) : read(f);
    for (const re of sinks) assert.doesNotMatch(src, re, `${path.basename(f)} uses ${re}`);
  }
  const app = code(read(path.join(R, 'app.js')));
  assert.match(app, /textContent/);
  assert.match(app, /createTextNode/);
});

test('the page helper can only set safe attributes (no src, href, style, srcdoc or on* attributes)', () => {
  const app = read(path.join(R, 'app.js'));
  const attrs = /var ATTRS = \{([\s\S]*?)\};/.exec(app)[1];
  const names = [...attrs.matchAll(/([A-Za-z-]+)\s*:/g)].map(m => m[1]);
  assert.ok(names.includes('for') && names.includes('type'));
  for (const bad of ['src', 'href', 'style', 'srcdoc', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'data']) {
    assert.ok(!names.includes(bad), `ATTRS must not allow ${bad}`);
  }
  assert.ok(!names.some(n => /^on/i.test(n)), 'no on* attributes');
  assert.doesNotMatch(code(app), /setAttribute\(\s*['"](src|href|style|srcdoc)['"]/);
  assert.doesNotMatch(code(app), /\.style\.|\.href\s*=|\.src\s*=/, 'no inline style or URL properties');
});

test('index.html: a CSP meta with no inline script, no remote anything, and no inline code in the page', () => {
  const html = read(path.join(R, 'index.html'));
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(m, 'CSP meta present');
  const csp = Object.fromEntries(m[1].split(';').map(s => s.trim()).filter(Boolean).map(s => { const [k, ...v] = s.split(/\s+/); return [k, v.join(' ')]; }));
  assert.equal(csp['default-src'], "'none'");
  // The app's own scheme (src/scheme.mjs) is the only source of script, style and images.
  assert.equal(csp['script-src'], 'nqa://app');
  assert.equal(csp['style-src'], 'nqa://app');
  assert.equal(csp['img-src'], 'nqa://app');
  // The landing's own faces, bundled in the renderer folder (never a remote font).
  assert.equal(csp['font-src'], 'nqa://app');
  assert.equal(csp['connect-src'], "'none'");
  assert.equal(csp['object-src'], "'none'");
  assert.equal(csp['frame-src'], "'none'");
  assert.equal(csp['base-uri'], "'none'");
  assert.equal(csp['form-action'], "'none'");
  assert.doesNotMatch(m[1], /unsafe-inline|unsafe-eval|unsafe-hashes|wasm-unsafe|https?:|data:|blob:|file:|'self'|\*/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'CSP comes before any script');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3, 'strings.js, format.js, app.js');
  for (const s of scripts) {
    assert.match(s[1], /src="[a-z]+\.js"/, 'every script is a local file');
    assert.equal(s[2].trim(), '', 'no inline script');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline handlers');
  // The only image is the welcome's route on the map, a local SVG file (CL-design-23; the in-game still is
  // gone in the app trim); NeverQuestAlone is the Dock icon's glass skull, lit and unlit, drawn by the stylesheet in the panel.
  const imgs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => m[1]);
  assert.deepEqual(imgs, ['img/route-map.svg']);
  assert.deepEqual([...html.matchAll(/<span class="bones" data-face="([a-z]+)"><\/span>/g)].map(m => m[1]), ['active', 'inactive'], 'NeverQuestAlone: lit and unlit, in the panel');
  assert.doesNotMatch(html, /<use\b|<svg\b/, 'no inline mark');
  assert.doesNotMatch(html, /\sstyle\s*=|<style/i, 'no inline style');
  assert.doesNotMatch(html, /https?:\/\//, 'no remote URLs');
  // The stylesheet loads only the renderer's own files: its fonts, its line icons and NeverQuestAlone's skull.
  const css = read(path.join(R, 'style.css'));
  assert.doesNotMatch(css, /@import|https?:\/\/|data:/, 'nothing remote, nothing inline');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]);
  assert.ok(urls.length > 10);
  for (const u of urls) {
    assert.match(u, /^(fonts\/[a-z0-9-]+\.woff2|icons\/[a-z-]+\.svg|img\/bones-(active|inactive)(-64)?(@2x)?\.png)$/, u);
    assert.ok(fs.existsSync(path.join(R, u)), u);
  }
});

test('main.mjs hardens the window: isolation, sandbox, no Node, no spellcheck, no new windows, no navigation', () => {
  const src = code(read(path.join(APP, 'main.mjs')));
  for (const re of [
    /contextIsolation:\s*true/, /sandbox:\s*true/, /nodeIntegration:\s*false/, /nodeIntegrationInWorker:\s*false/,
    /nodeIntegrationInSubFrames:\s*false/, /webviewTag:\s*false/, /spellcheck:\s*false/, /webSecurity:\s*true/,
    /allowRunningInsecureContent:\s*false/, /app\.enableSandbox\(\)/, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/,
    /on\('will-navigate',\s*e\s*=>\s*e\.preventDefault\(\)\)/, /on\('will-attach-webview',\s*e\s*=>\s*e\.preventDefault\(\)\)/,
    /setPermissionRequestHandler\(\(_wc,\s*_perm,\s*cb\)\s*=>\s*cb\(false\)\)/, /setSpellCheckerEnabled\(false\)/,
    /requestSingleInstanceLock\(\)/, /loadURL\(pageUrl\(page\)\)/, /protocol\.handle\(SCHEME,/, /installShellGuard\(/, /UPDATER_PARTITION/, /process\.report\.excludeEnv\s*=\s*true/,
  ]) assert.match(src, re, `main.mjs: ${re}`);
  assert.doesNotMatch(src, /loadURL\(\s*['"`]https?:/, 'no remote content');
  assert.doesNotMatch(src, /loadFile\(|loadURL\([^)]*file:/, 'never a file: page');
  assert.doesNotMatch(src, /enableRemoteModule|nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false/);
});

test('format.js: the §16.1 cost preview, the §9.5 usage lines and money in micro-dollars', () => {
  const F = loadFormat();
  assert.equal(F.costPreview({ replyCents: [0.43, 0.93], dayUsd: [0.17, 0.37], at: 40 }), 'about 0.4–0.9¢ a reply · about $0.17–0.37 a day at 40 replies');
  assert.equal(F.costPreview({ replyCents: [0.04, 0.09], dayUsd: [0.02, 0.04], at: 40 }), 'about 0.04–0.09¢ a reply · about $0.02–0.04 a day at 40 replies');
  // S3's words for free and local models (UX-W35): the limit is OpenRouter's, and "free" is the price.
  assert.equal(F.costPreview({ free: true, perDay: 50 }), 'No charge · up to 50 requests a day (the service’s limit)', 'no one service named (UX-W10)');
  // One word for a local model's place on every system (STYLE: "on this computer", CL-words-45).
  assert.equal(F.costPreview({ local: true }), 'Free · runs on this computer');
  assert.equal(F.costPreview({ local: true }, 'win32'), 'Free · runs on this computer');
  assert.equal(F.usageLine({ spentMicros: 180000 }, { id: 'anthropic', auth: 'key' }), '$0.18 today', 'no limit (the default): the spend alone');
  assert.equal(F.usageLine({ spentMicros: 180000, capMicros: 1000000 }, { id: 'anthropic', auth: 'key' }), '$0.18 of $1.00 today');
  assert.equal(F.usageLine({ spentMicros: 180000, capMicros: 1000000, keyLeftMicros: 4120000 }, { id: 'custom', auth: 'key' }), '$0.18 of $1.00 today', 'no key balance line of any one service');
  assert.equal(F.usageLine({ spentMicros: 0, freeUsed: 12, freeLimit: 50 }, { id: 'custom', auth: 'key' }), '12 of 50 requests today', 'bar.usageFree (UX-W08, UX-W10)');
  assert.equal(F.usageLine({ spentMicros: 0 }, { id: 'custom', auth: 'local', name: 'localhost:11434', model: 'qwen3:8b' }), 'On this computer · localhost:11434 · qwen3:8b');
  assert.equal(F.usdMicros(14), 'under $0.0001');
  assert.equal(F.usdMicros(4300), '0.4¢', 'under a cent: cents (STYLE.md §8)');
  assert.equal(F.usdMicros(0), '$0.00', 'money measured has cents (UX-W37)');
  assert.equal(F.usdMicros('x'), '—');
  assert.equal(F.tokens(7412), '7.4k');
  assert.equal(F.storeName('win32'), 'Windows Credential Manager');
  assert.equal(F.storeName('darwin'), 'your macOS Keychain');
  assert.equal(F.storeName('linux'), 'the Secret Service');
  assert.match(F.keyPromises('win32').join(' '), /Programs you run can read it/);
  assert.match(F.keyPromises('darwin').join(' '), /macOS will ask before another app reads it/);
});

test('format.js clean(): strips controls and text-direction marks, caps length, keeps newlines', () => {
  const F = loadFormat();
  const RLO = String.fromCharCode(0x202e);
  const ZW = String.fromCharCode(0x200b);
  assert.equal(F.clean(`ab${RLO}cd${ZW}e${String.fromCharCode(7)}`), 'abcde');
  assert.equal(F.clean('line1\nline2'), 'line1\nline2');
  assert.equal(F.clean('x'.repeat(10), 5), 'xxxx…');
  assert.equal(F.clean(null), '');
});

test('the window and the tray read the one vocabulary the bridge publishes (status.view; SY-06, UX-1)', async () => {
  const F = loadFormat();
  const { statusView, STATE_WORDS: BRIDGE } = await import('../../bridge/byok/status-view.mjs');
  assert.strictEqual(STATE_WORDS, BRIDGE, 'the tray re-exports the bridge\u2019s table');
  assert.equal(F.STATE_WORDS, undefined, 'no table in the window');
  const v = s => ({ ...s, view: statusView(s) });
  for (const st of ['ready', 'no_key', 'key_invalid', 'slowed', 'out_of_credit', 'cap', 'provider_down', 'local_down', 'paused']) {
    assert.equal(F.stateWords(v({ backend: { rt: { state: st }, provider: { id: 'anthropic', name: 'Anthropic', model: 'm' } } })), BRIDGE[st], st);
  }
  // No AI picked at all: the setup story's words, not "No key" (UX-W25).
  assert.equal(F.stateWords(v({ backend: { rt: { state: 'no_key' } } })), 'No AI yet');
  assert.equal(F.stateWords(v({ backend: { rt: { state: 'slowed', retryIn: 18.2 } } })), 'Slowed down · retrying in 18\u00a0s', 'the number and its unit stay together (UX-W37)');
  assert.equal(F.stateWords(null), 'Starting');
  const status = { backend: { rt: { state: 'ready' }, provider: { name: 'Anthropic', modelName: 'Claude Haiku 4.5' } } };
  assert.equal(trayLine(status), 'Ready · Anthropic · Claude Haiku 4.5');
  assert.equal(trayLine(v(status)), 'Ready · Anthropic · Claude Haiku 4.5', 'the same with the view carried');
  assert.equal(trayLine({ backend: { rt: { state: 'no_key' } } }), 'No AI yet', 'no AI picked: the setup story’s words (UX-W25)');
  assert.equal(trayLine({ backend: { rt: { state: 'no_key' }, provider: { name: 'Anthropic', model: 'm' } } }), 'No key', 'an AI picked with no key');
  assert.equal(trayLine(null), 'Starting');
  const RLO = String.fromCharCode(0x202e);
  assert.equal(trayLine({ backend: { rt: { state: 'ready' }, provider: { name: `Evil${RLO}`, model: 'm' } } }), 'Ready · Evil · m');
  // Until setup is done, the tray tells the setup story as the window's bar does (UX-W25, DU-08):
  // "Setting up" while nothing needs fixing, else the state's word alone, never the AI and its model.
  assert.equal(trayLine(status, { setup: true }), 'Setting up');
  assert.equal(trayLine(v({ backend: { rt: { state: 'key_invalid' }, provider: { name: 'Anthropic', model: 'm' } } }), { setup: true }), BRIDGE.key_invalid);
  // The tray's own words are main's table's: its line, tooltip and items (src/strings.mjs tray).
  const main = read(path.join(APP, 'main.mjs'));
  assert.match(main, /trayLine\(lastStatus, \{ setup: !onboarded \}\)/);
  assert.match(main, /STRINGS\.tray\.tooltip\.replace\('\{line\}', line\)/);
  assert.doesNotMatch(main, /'(Pause|Quit) NeverQuestAlone'/, 'the items are the table’s');
  // No copy of the words anywhere in the app.
  for (const f of [path.join(R, 'format.js'), path.join(APP, 'src', 'status-text.mjs')]) {
    const src = code(read(f));
    for (const w of ['Out of credit', 'Key rejected', 'Model app stopped', 'Daily spend limit reached']) assert.ok(!src.includes(`'${w}'`), `${path.basename(f)}: ${w}`);
  }
});
test('desktop notifications (ER-5): once per condition, held in combat, off with the setting', () => {
  const shown = [];
  let enabled = true;
  const n = createNotifier({ show: x => shown.push(x), enabled: () => enabled });
  const st = (state, extra = {}) => ({ backend: { rt: { state }, provider: { name: 'Anthropic', companion: 'NeverQuestAlone' }, usage: { capMicros: 1000000 } }, wow: extra });
  n.update(st('ready'));
  assert.equal(shown.length, 0);
  n.update(st('out_of_credit', { combat: true }));
  assert.equal(shown.length, 0, 'held in combat');
  n.update(st('out_of_credit', { combat: false }));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Your Anthropic account is out of credit.');
  assert.equal(shown[0].page, 'home', 'a click opens Home, the one page that shows the state and its fix (CL-player-55)');
  n.update(st('out_of_credit'));
  assert.equal(shown.length, 1, 'once per condition');
  n.update(st('cap'));
  assert.equal(shown[1].title, 'You’ve reached your daily spend limit ($1.00).');
  assert.equal(shown[1].page, 'home');
  n.update(st('ready'));
  enabled = false;
  n.update(st('key_invalid'));
  assert.equal(shown.length, 2, 'off with the setting');
  // Main's table's words (src/strings.mjs notifications; UX-W12): the AI company named, "click" for a
  // button on screen, no "provider", whole sentences even with no company name to give.
  const all = [];
  const m = createNotifier({ show: x => all.push(x) });
  const said = (rt, provider) => { m.update({ backend: { rt, provider, usage: {} } }); m.update({ backend: { rt: { state: 'ready' }, provider } }); return all.at(-1); };
  assert.deepEqual([said({ state: 'out_of_credit' }, { name: 'Anthropic' }).title, all.at(-1).body], ['Your Anthropic account is out of credit.', 'Add credit at Anthropic, then test your key in NeverQuestAlone.']);
  assert.deepEqual([said({ state: 'local_down' }, { name: 'Ollama', companion: 'Nova' }).title, all.at(-1).body], ['Nova can’t reach Ollama.', 'Start Ollama, then click Retry in game.']);
  assert.deepEqual([said({ state: 'key_invalid' }, { name: 'OpenAI' }).title, all.at(-1).body], ['Your OpenAI key was rejected.', 'Replace it in NeverQuestAlone.']);
  assert.deepEqual([said({ state: 'out_of_credit' }, {}).title, all.at(-1).body], ['Your account at your AI company is out of credit.', 'Add credit at your AI company, then test your key in NeverQuestAlone.']);
  assert.equal(said({ state: 'key_invalid' }, {}).title, 'Your key was rejected.');
  assert.equal(said({ state: 'local_down' }, {}).title, 'NeverQuestAlone can’t reach the app that runs your model.');
  for (const x of all) assert.doesNotMatch(`${x.title} ${x.body}`, /provider|press |\{[a-z]+\}|Your your|undefined/i);
});

test('update notices go through the same notifier: off with the setting, held in combat', () => {
  const shown = [];
  let enabled = true;
  const n = createNotifier({ show: x => shown.push(x), enabled: () => enabled });
  const upd = { title: 'NeverQuestAlone 0.2.0 is available', body: 'Click to download it.', page: 'updates' };
  const st = combat => ({ backend: { rt: { state: 'ready' } }, wow: { combat } });
  assert.equal(n.notify(upd), upd);
  assert.equal(shown.length, 1);
  n.update(st(true));
  assert.equal(n.notify(upd), null, 'held in combat');
  assert.equal(shown.length, 1);
  n.update(st(false));
  assert.equal(shown.length, 2, 'shown when combat ends');
  n.update(st(false));
  assert.equal(shown.length, 2, 'once');
  enabled = false;
  assert.equal(n.notify(upd), null, 'off with the setting');
  n.update(st(true));
  enabled = true;
  n.notify(upd);
  enabled = false;
  n.update(st(false));
  assert.equal(shown.length, 2, 'a held notice is dropped if notifications are turned off meanwhile');

  const main = code(read(path.join(APP, 'main.mjs')));
  assert.match(main, /notify:\s*n\s*=>\s*notifier\.notify\(n\)/, 'the updater notifies through the notifier');
  assert.match(main, /createNotifier\(\{\s*show:\s*showNotice,\s*enabled:\s*notificationsOn\s*\}\)/);
  assert.doesNotMatch(main, /notify:\s*showNotice/, 'nothing bypasses the setting');
});

test('the window has the switch for desktop notifications (ER-5: can be turned off), by click', () => {
  const app = read(path.join(R, 'app.js'));
  assert.match(app, /switchBtn\('sw-notifications', ST\('notificationsLabel'\)/);
  assert.match(app, /B\.setAppState\(\{ notifications: onNow \}\)/);
});

// ---------------------------------------------------------------------------
// The page itself, run in a small DOM (helpers/mini-dom.mjs) over the real IPC layer and the mock
// API (helpers/page-rig.mjs): the desktop UI critic's round 1 (D-01…D-21), and setup (onboarding
// spec §3; tests/byok/app_setup_test.mjs has the rest).


// ---------------------------------------------------------------------------
// The window itself, run in a small DOM (helpers/mini-dom.mjs) over the real IPC layer and the mock
// API (helpers/page-rig.mjs): NeverQuestAlone's panel, Home and its one card, the banners and notices, Your AI,
// Usage and the daily spend limit, Connections, Last request, Settings and its pages (the redesign's
// build spec §4–§6; setup is tests/byok/app_setup_test.mjs).

const { pageRig } = await import('./helpers/page-rig.mjs');
const { FAKE_KEY, FAKE_BAD_KEY } = await import('../../app/desktop/src/screenshots.mjs');
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null };
const SAVED = { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } };
const READY = { keys: SAVED, choice: HAIKU, addonInstalled: true };
const IN_GAME = { ...READY, wow: { found: true, running: true } };
const OPENAI = { keys: { openai: { masked: 'sk-proj-…xxxx', state: 'ok' } }, choice: { provider: 'openai', model: 'gpt-6-luna', effort: 'low' }, addonInstalled: true };
// Other (custom) at a server on this computer: Ollama's OpenAI-compatible address, no key.
const CUSTOM_LOCAL = Object.freeze({ custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' }, choice: { provider: 'custom', model: 'qwen3:8b', effort: null } });
const active = r => r.document.activeElement;
const titleText = r => r.document.getElementById('page-title')?.textContent;
const label = b => (b.querySelector('.btn-label') || b).textContent;
const fk = (r, key) => r.document.querySelector(`[data-fk="${key}"]`);
const alert = r => r.document.querySelector('#page .alert');
const banner = r => r.document.querySelector('#banners .banner');
const primaries = r => r.document.querySelectorAll('#page .btn-primary, #banners .btn-primary, #topbar .btn-primary');
const nav = (r, page) => r.press(r.document.querySelector(`[data-nav="${page}"]`));
/** A page the way a player reaches it: the nav, or Your data's rows (Connections, Last request); Usage is Your AI's spending group. */
const open = async (r, page) => {
  if (page === 'usage') return nav(r, 'provider');
  if (page === 'connections' || page === 'last-request') { await nav(r, 'privacy'); return r.press(fk(r, `open-${page}`)); }
  return nav(r, page);
};
const rowLine = r => r.document.querySelector('#page .set-line');

test('NeverQuestAlone’s panel after setup (the 1.3 refresh): no name label, pill, dot or speech line; his state is in his eye (lit in game, red when something needs you, dark when WoW is closed), its word beside the portrait on hover and in the portrait button’s name, said in the live region when it changes; the button opens Home; his eyes, never on the stage', async () => {
  const cases = [
    [IN_GAME, 'In game', 'ok', 'happy'],
    [READY, 'WoW closed', 'neutral', 'away'],
    [{ ...READY, paused: true }, 'Paused', 'neutral', 'away'],
    [{ ...IN_GAME, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } }, 'Needs you', 'needs', 'needs'],
    // No credit, a company that's down, a retired model and an empty reply, twice: the red eye too (1.2.0's causes; Home's card names each).
    [{ ...IN_GAME, rt: { state: 'out_of_credit' } }, 'Needs you', 'needs', 'needs'],
    [{ ...IN_GAME, rt: { state: 'provider_down' } }, 'Needs you', 'needs', 'needs'],
    [{ ...IN_GAME, choice: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, notice: { kind: 'model_retired', model: 'claude-sonnet-5', at: 1 } }, 'Needs you', 'needs', 'needs'],
    [{ ...IN_GAME, lastError: { kind: 'empty_reply', code: 'length', at: 5 } }, 'Needs you', 'needs', 'needs'],
    [{ ...IN_GAME, caps: { dailyUsd: 1 }, spentMicros: 1_000_000 }, 'Needs you', 'needs', 'needs'],
    [{ ...IN_GAME, caps: { dailyUsd: 1 }, spentMicros: 860_000 }, 'Needs you', 'needs', 'needs'],
    [{ ...IN_GAME, rt: { state: 'slowed', retryIn: 18 } }, 'In game', 'ok', 'idle'],
    [{ ...IN_GAME, capture: { state: 'waiting', mode: 'capture', signals: 'unknown', steps: { game: true, strip: false, message: false, reply: false } } }, 'Joining game', 'warn', 'idle'],
  ];
  for (const [state, word, tone, mood] of cases) {
    const r = await pageRig({ state });
    assert.equal(r.document.getElementById('app').getAttribute('data-mode'), 'app');
    const tip = r.document.getElementById('status-tip');
    assert.equal(tip.textContent, word);
    assert.equal(tip.getAttribute('data-tone'), tone, word);
    assert.equal(tip.getAttribute('aria-hidden'), 'true', 'the button’s name says it once');
    const bb = r.document.getElementById('bones-btn');
    assert.equal(bb.getAttribute('aria-label'), `NeverQuestAlone: ${word}. Open Home.`, word);
    assert.equal(bb.getAttribute('aria-hidden'), null, word);
    assert.equal(r.document.getElementById('portrait').getAttribute('data-mood'), mood, word);
    for (const id of ['says', 'pill', 'who-name', 'badge']) assert.equal(r.document.getElementById(id), null, `no #${id}`);
  }
  // The portrait opens Home, from any page.
  const nav = await pageRig({ state: IN_GAME });
  await nav.press(nav.document.querySelector('[data-nav="settings"]'));
  assert.notEqual(nav.document.querySelector('[data-nav="home"]').getAttribute('aria-current'), 'page');
  await nav.press(nav.document.getElementById('bones-btn'));
  assert.equal(nav.document.querySelector('[data-nav="home"]').getAttribute('aria-current'), 'page', 'the portrait opens Home');
  const err = await pageRig({ state: READY, apiMode: 'error' });
  assert.equal(err.statusText(), 'Not running');
  assert.equal(err.document.getElementById('portrait').getAttribute('data-mood'), 'away');
  // A change of state off Home is said once in the live region (the speech line that said it is gone).
  const ch = await pageRig({ state: READY });
  await ch.press(ch.document.querySelector('[data-nav="settings"]'));
  ch.mock.control.patch({ wow: { found: true, running: true } });
  await ch.push();
  assert.ok(ch.liveText().includes('NeverQuestAlone: In game.'), ch.liveText().join(' | '));
  // NeverQuestAlone is the panel's alone: the stage never draws him (spec §5), and no stage words are his.
  const html = read(path.join(R, 'index.html'));
  assert.match(html, /<aside class="companion"[\s\S]*<button type="button" class="bones-btn" id="bones-btn"[^>]*>\s*<span class="portrait" id="portrait" data-mood="idle" data-state="inactive"[^>]*>\s*<span class="bones" data-face="active"><\/span><span class="bones" data-face="inactive"><\/span>[\s\S]*<p class="wordmark" id="wordmark"[^>]*>[\s\S]*<\/aside>/);
  assert.equal((html.match(/class="bones"/g) || []).length, 2, 'one place draws him');
  assert.ok(!fs.existsSync(path.join(R, 'bones.svg')), 'the placeholder skull is gone');
  // His skull: the Dock icon's glass skull on its own (the owner, 2026-10-03), lit and unlit, at 1x and 2x of the
  // largest portrait (96 pt): no disc and no tile behind him, and the old per-mood faces are gone.
  const css2 = read(path.join(R, 'style.css'));
  for (const face of ['active', 'inactive']) {
    for (const [s, px] of [['', 96], ['@2x', 192], ['-64', 64], ['-64@2x', 128]]) {
      const b = fs.readFileSync(path.join(R, 'img', `bones-${face}${s}.png`));
      assert.deepEqual([b.toString('latin1', 1, 4), b.readUInt32BE(16), b.readUInt32BE(20)], ['PNG', px, px], `${face}${s}`);
      const kit = path.join(HERE, '..', '..', 'brand', 'ship-glass', 'app', `bones-${face}${s}.png`); // brand/ isn't in the public tree
      if (fs.existsSync(kit)) assert.deepEqual(b, fs.readFileSync(kit), `${face}${s} is the brand kit's, byte for byte`);
    }
    assert.match(css2, new RegExp(`\\.bones\\[data-face="${face}"\\] \\{ background-image: image-set\\(url\\(img/bones-${face}\\.png\\) 1x, url\\(img/bones-${face}@2x\\.png\\) 2x\\)`), face);
    assert.match(css2, new RegExp(`\\.portrait\\[data-state="${face}"\\] \\.bones\\[data-face="${face}"\\]`), `${face}: shown in its state`);
    assert.match(css2, new RegExp(`\\.app\\[data-mode="app"\\] \\.portrait \\.bones\\[data-face="${face}"\\] \\{ background-image: image-set\\(url\\(img/bones-${face}-64\\.png\\) 1x, url\\(img/bones-${face}-64@2x\\.png\\) 2x\\)`), `${face}: drawn at its own size at 64 pt`);
  }
  for (const mood of ['idle', 'happy', 'needs', 'away']) assert.ok(!fs.existsSync(path.join(R, 'img', `bones-${mood}.png`)), `the Ember ${mood} face is gone`);
  const portraitRule = css2.match(/\n\.portrait \{[^}]*\}/)[0];
  assert.doesNotMatch(portraitRule, /border-radius|background|box-shadow/, 'no circle and no tile behind the skull');
  const app = code(read(path.join(R, 'app.js')));
  assert.doesNotMatch(app, /bones\.svg|bones-(idle|happy|needs|away|active|inactive)|brand-mark|mark\.png/, 'the page never draws him itself');
  assert.match(app, /portrait\.setAttribute\('data-state', lit \? 'active' : 'inactive'\)/, 'the panel lights or dims him');
  assert.match(app, /screen !== 'welcome' && up\)/, 'setup\u2019s end lights him only while the client runs (APP-D-58)');
  assert.doesNotMatch(css2, /\.bones-btn[^{]*:hover \.portrait/, 'no hover glow on the skull (APP-D-56)');
});

test('the nav: four pages (Home, Your AI, Your data, Settings) and a warn dot on Home while a card is up (words for screen readers too); a page change focuses its heading; one live region outside the page', async () => {
  const r = await pageRig({ state: READY });
  assert.equal(titleText(r), 'WoW is closed');
  assert.equal(active(r).id, 'page-title', 'the heading after a page change');
  assert.equal(active(r).getAttribute('tabindex'), '-1');
  const n = r.document.getElementById('nav');
  assert.equal(n.hidden, false);
  assert.deepEqual(n.querySelectorAll('.nav-item').filter(b => !b.hidden).map(b => b.textContent), ['Home', 'Your AI', 'Your data', 'Settings']);
  assert.equal(n.querySelector('[aria-current="page"]').getAttribute('data-nav'), 'home');
  const live = r.live();
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(r.page().contains(live), false, 'outside #page');
  for (const [page, want] of [['provider', 'Your AI'], ['privacy', 'Your data'], ['settings', 'Settings']]) {
    await nav(r, page);
    assert.equal(titleText(r), want);
    assert.equal(active(r).id, 'page-title');
    assert.equal(n.querySelector('[aria-current="page"]').getAttribute('data-nav'), page);
  }
  // A sub-page keeps its nav item current: Settings for its pages (with ‹ Back), Your data for its records.
  await r.press(fk(r, 'more'));
  await r.press(fk(r, 'open-about'));
  assert.equal(titleText(r), 'About');
  assert.equal(n.querySelector('[aria-current="page"]').getAttribute('data-nav'), 'settings');
  assert.equal(label(fk(r, 'back')), 'Back');
  await r.press(fk(r, 'back'));
  assert.equal(titleText(r), 'Settings');
  // Updates is part of About and Memory's two actions are in More: their old names still lead there.
  for (const cb of r.subs.navigate) cb('updates');
  await r.settle();
  assert.equal(titleText(r), 'About');
  for (const cb of r.subs.navigate) cb('memory');
  await r.settle();
  assert.equal(titleText(r), 'Settings');
  assert.equal(fk(r, 'more').getAttribute('aria-expanded'), 'true', 'Memory’s old name opens More');
  for (const [page, want] of [['connections', 'Connections'], ['last-request', 'Last request']]) {
    await open(r, page);
    assert.equal(titleText(r), want);
    assert.equal(n.querySelector('[aria-current="page"]').getAttribute('data-nav'), 'privacy');
  }
  // Usage is Your AI's spending group now: its old name still leads there.
  for (const cb of r.subs.navigate) cb('usage');
  await r.settle();
  assert.equal(titleText(r), 'Your AI');
  assert.ok(r.document.getElementById('spend-group'));
  const bad = await pageRig({ state: { ...READY, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } } });
  await nav(bad, 'settings');
  const home = bad.document.querySelector('[data-nav="home"]');
  assert.equal(home.getAttribute('data-attention'), 'true');
  assert.equal(home.getAttribute('aria-label'), 'Home: Needs you', 'its name says it (the dot is the eye’s version)');
  await nav(bad, 'home');
  assert.equal(home.getAttribute('data-attention'), 'false', 'on Home the card itself says it');
  assert.equal(r.live(), live, 'the same live region after every page');
});

test('Home: NeverQuestAlone’s condition as the title (in game, joining, WoW closed, paused, no AI); the route card (what NeverQuestAlone does in game); one compact row for the AI and today’s spend (values as data) that opens Your AI', async () => {
  const r = await pageRig({ state: IN_GAME });
  assert.equal(titleText(r), 'NeverQuestAlone is in game');
  assert.deepEqual(primaries(r).map(label), [], 'nothing to do: Pause is quiet');
  assert.equal(label(fk(r, 'pause')), 'Pause');
  // No route drawn yet: no card and no slogan, nothing but the page's own title and the AI row (APP-D-28).
  assert.equal(r.document.querySelector('#page .route'), null, 'no card without a route');
  assert.doesNotMatch(r.pageText(), /plans your quests/, 'no slogan');
  assert.equal(r.document.querySelector('#page figure.ingame'), null, 'no example picture');
  assert.doesNotMatch(r.pageText(), /Last request/, 'no AI console on Home');
  // With a route on the map, the route itself leads, live (CL-design-41).
  const live = await pageRig({ state: { ...READY, wow: { found: true, running: true, route: { next: 'The Hunt Begins', stops: 7, title: 'Camp Narache' } } } });
  const lr = live.document.querySelector('#page .route');
  assert.equal(lr.querySelector('.proofs'), null, 'no proof list in game with a route');
  assert.deepEqual(['.route-live-key', '.route-live-stop', '.route-live-sub'].map(c => lr.querySelector(c).textContent), ['Next stop', 'The Hunt Begins', '7 stops on your map']);
  assert.equal(lr.querySelector('.route-live-stop').getAttribute('data-count'), 'data', 'the stop’s name is data');
  assert.equal(lr.querySelector('figure.ingame'), null, 'no example route beside the live one (CL-design-49, CL-player-50)');
  assert.match(lr.className, /\broute-solo\b/, 'the route text takes the card');
  assert.equal(lr.querySelector('#route-title').textContent, 'Your route', 'its name, for a screen reader (APP-W-21)');
  assert.match(lr.querySelector('#route-title').className, /\bsr-only\b/, 'the stop leads');
  assert.deepEqual(lr.children.map(c => c.className), ['route-text'], 'the route text takes the card: one column, nothing beside it');
  const lc = await pageRig({ state: { ...READY, wow: { found: true, running: false, route: { next: 'The Hunt Begins', stops: 7, title: '' } } } });
  assert.equal(lc.document.querySelector('#page .route-live'), null, 'WoW closed: his line alone');
  // One compact row: the model and today's spend; data, not words; it opens Your AI. No reply count (the trim).
  const strip = fk(r, 'ai-strip');
  assert.deepEqual(['.aistrip-model', '.aistrip-spent'].map(c => strip.querySelector(c).textContent), ['Claude Haiku 4.5', '$0.18 today']);
  assert.ok(['.aistrip-model', '.aistrip-spent'].every(c => strip.querySelector(c).getAttribute('data-count') === 'data'), 'values are data, not words');
  assert.equal(strip.querySelector('.aistrip-replies'), null, 'no reply count');
  assert.equal(strip.querySelector('.xp'), null, 'no meter without a limit of the player’s');
  await r.press(strip);
  assert.equal(titleText(r), 'Your AI');
  await r.press(r.document.querySelector('[data-nav="home"]'));
  await r.press(fk(r, 'pause'));
  assert.ok(r.calls.some(c => c[0] === 'setPaused'), 'Pause pauses');
  await r.push();
  assert.equal(titleText(r), 'NeverQuestAlone is paused');
  assert.deepEqual(primaries(r).map(label), ['Resume'], 'Resume, the way out, is the one primary');
  const closed = await pageRig({ state: READY });
  assert.equal(titleText(closed), 'WoW is closed');
  assert.deepEqual(primaries(closed).map(label), ['Open Battle.net']);
  assert.equal(fk(closed, 'pause'), null, 'no Pause while WoW is closed');
  await closed.press(primaries(closed)[0]);
  assert.ok(closed.calls.some(c => c[0] === 'openGame'));
  const joining = await pageRig({ state: { ...IN_GAME, capture: { state: 'waiting', mode: 'capture', signals: 'unknown', steps: { game: true, strip: false, message: false, reply: false } } } });
  assert.equal(titleText(joining), 'NeverQuestAlone is joining the game');
  const noAi = await pageRig({ state: {} });
  assert.equal(titleText(noAi), 'NeverQuestAlone has no AI yet');
  assert.deepEqual(primaries(noAi).map(label), ['Pick an AI']);
  // A daily limit the player set: the XP bar, 10 segments, a meter with words.
  const lim = await pageRig({ state: { ...IN_GAME, caps: { dailyUsd: 1 }, spentMicros: 420_000 } });
  assert.equal(fk(lim, 'ai-strip').querySelector('.aistrip-spent').textContent, '$0.42 of $1.00 today', 'one whole string (CL-words-24)');
  const xp = lim.document.querySelector('.xp');
  assert.equal(xp.getAttribute('role'), 'meter');
  assert.equal(xp.querySelectorAll('i').length, 10);
  assert.equal(xp.querySelectorAll('i.on').length, 4);
  assert.equal(xp.getAttribute('aria-valuetext'), '$0.42 of $1.00');
  assert.match(xp.className, /\bxp-ok\b/);
  const near = await pageRig({ state: { ...IN_GAME, caps: { dailyUsd: 1 }, spentMicros: 860_000 } });
  assert.match(near.document.querySelector('.xp').className, /\bxp-warn\b/, 'warn from 80%');
  const at = await pageRig({ state: { ...IN_GAME, caps: { dailyUsd: 1 }, spentMicros: 1_000_000 } });
  assert.match(at.document.querySelector('.xp').className, /\bxp-bad\b/, 'bad at the limit');
});

test('Home’s card (spec §6.2): the title says one thing needs you; one card, a sentence and one line, its fix the page’s one primary, no Okay while it holds; on another page, no banner (the app trim)', async () => {
  const r = await pageRig({ state: { ...READY, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } } });
  assert.equal(titleText(r), 'One thing needs you');
  const a = alert(r);
  assert.equal(a.querySelector('.alert-head').textContent, 'Anthropic rejected your key.');
  assert.equal(a.querySelector('.alert-sub').textContent, 'Paste a new one to keep playing.');
  assert.equal(r.document.getElementById(a.getAttribute('aria-labelledby')).textContent, 'Anthropic rejected your key.', 'named by its headline');
  assert.deepEqual(a.querySelectorAll('button').map(label), ['Replace key', 'Open Anthropic’s key page']);
  assert.deepEqual(primaries(r).map(label), ['Replace key']);
  assert.equal(r.byText('Okay').length, 0, 'no Okay while it holds');
  assert.equal(r.bannerText(), '', 'Home draws it itself: no banner too');
  // The app trim: the card is Home's. Another page draws no banner for it (the pill, his line and the nav's
  // dot say it needs you, as the tests of the panel and the nav pin); only a start that failed keeps one.
  await nav(r, 'settings');
  assert.equal(banner(r), null, 'no banner on another page');
  assert.equal(r.bannerText(), '');
  assert.equal(r.document.querySelector('[data-nav="home"]').getAttribute('data-attention'), 'true', 'the nav says it');
  await nav(r, 'home');
  await r.press(r.document.querySelector('#page .alert [data-fk="replace-key"]') || fk(r, 'replace-key'));
  assert.equal(titleText(r), 'Your AI');
  assert.equal(active(r).id, 'key-field', 'Replace key: the key field, focused');
  // The state ends, the card goes.
  r.mock.control.reset(READY);
  await r.push();
  await nav(r, 'home');
  assert.equal(alert(r), null);
  // Every state card's words (spec §6.2's table): whole sentences, the AI company named, no "provider".
  const words = async (state) => { const x = await pageRig({ state }); const c = alert(x); return c ? [c.querySelector('.alert-head').textContent, c.querySelector('.alert-sub')?.textContent ?? null, c.querySelectorAll('button').map(label)] : null; };
  assert.deepEqual(await words({ choice: HAIKU, addonInstalled: true }), ['No key from Anthropic yet.', 'Add one so NeverQuestAlone can answer.', ['Add key', 'Pick another AI']]);
  assert.deepEqual(await words({ ...READY, rt: { state: 'slowed', retryIn: 18 } }), ['Anthropic asked NeverQuestAlone to slow down.', 'Trying again in 18 seconds.', []]);
  assert.deepEqual(await words({ ...READY, rt: { state: 'slowed' } }), ['Anthropic asked NeverQuestAlone to slow down.', 'Trying again soon.', []]);
  assert.deepEqual(await words({ ...READY, rt: { state: 'out_of_credit' } }), ['Your Anthropic account is out of credit.', 'Add credit, then test.', ['Add credit at Anthropic', 'Test key']], 'the fix first: a banner shows only its first (CL-words-22)');
  assert.deepEqual(await words({ ...READY, caps: { dailyUsd: 1 }, spentMicros: 1_000_000 }), ['You’ve reached your daily spend limit.', 'NeverQuestAlone rests until midnight.', ['Raise limit']], 'the numbers are beside it already (CL-words-24)');
  assert.deepEqual(await words({ ...READY, caps: { dailyUsd: 1 }, spentMicros: 860_000 }), ['Today’s spend is near your limit.', 'NeverQuestAlone stops at $1.00, back at midnight.', ['Raise limit']]);
  assert.deepEqual(await words({ ...READY, rt: { state: 'provider_down' } }), ['Anthropic isn’t answering.', 'NeverQuestAlone tries again with your next message.', ['Check again', 'Pick another AI']], 'not the key (CL-words-22)');
  assert.deepEqual(await words({ ...CUSTOM_LOCAL, rt: { state: 'local_down' } }), ['Can’t reach localhost:11434.', 'Start your model app.', ['Check again']]);
  assert.deepEqual(await words({ ...READY, choice: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, notice: { kind: 'model_retired', model: 'claude-sonnet-5', at: 1 } }), ['Your model was retired.', 'Pick another to keep playing.', ['Pick another model']]);
  // No limits of ours (the owner, 2026-09-26): spending a lot is no state at all without a limit the player set.
  assert.equal(await words({ ...READY, spentMicros: 25_000_000 }), null);
  // Near the limit: said once in the live region, not again at every percent.
  const nr = await pageRig({ state: { ...READY, caps: { dailyUsd: 1 }, spentMicros: 860_000 } });
  assert.equal(alert(nr).getAttribute('data-say'), 'Today’s spend is near your limit.');
  // Raise limit opens Your AI's spending group at the amount.
  await nr.press(fk(nr, 'raise-limit'));
  assert.equal(titleText(nr), 'Your AI');
  assert.equal(active(nr).id, 'cap-dailyUsd');
  // A retired model: Pick another model goes to Your AI's model options, the chosen one focused.
  const ret = await pageRig({ state: { ...READY, choice: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, notice: { kind: 'model_retired', model: 'claude-sonnet-5', at: 1 } } });
  await ret.press(fk(ret, 'pick-model'));
  assert.equal(titleText(ret), 'Your AI');
  assert.ok(ret.document.scrolls.some(e => e.id === 'model-row'));
  assert.equal(active(ret).getAttribute('role'), 'radio');
  // The retired model reads Retired, with no price, never Older (CL-words-61); once another is picked, its row goes.
  const sonnet5 = () => ret.document.getElementById('model-claude-sonnet-5');
  assert.equal(sonnet5().querySelector('.chip').textContent, 'Retired');
  assert.equal(sonnet5().querySelector('.choice-cost').textContent, '');
  // A retired model has no Thinking (it can't answer at any level; CL-design-50, CL-design-52); its row says Retired in red,
  // as a rejected key's does; the lists open by themselves (that is the fix) and the page has no banner or primary (the app trim).
  assert.equal(ret.document.getElementById('effort-row'), null, 'no Thinking track for a model that can’t answer');
  assert.equal(ret.document.getElementById('model-sum').querySelector('.set-main').textContent, 'Claude Sonnet 5Retired');
  assert.deepEqual(ret.document.querySelectorAll('#model-sum .chip').map(c => [c.textContent, c.className]), [['Retired', 'chip chip-bad']]);
  assert.equal(fk(ret, 'model-change'), null, 'no Pick a model button while the retired model holds: the lists are open');
  assert.ok(ret.document.getElementById('model-sum-group').contains(ret.document.getElementById('model-box')), 'in the Model card');
  assert.deepEqual(primaries(ret).map(label), []);
  ret.mock.control.patch({ notice: null });
  await ret.press(ret.document.getElementById('model-claude-haiku-4-5'));
  if (fk(ret, 'all-models') && fk(ret, 'all-models').getAttribute('aria-expanded') !== 'true') await ret.press(fk(ret, 'all-models'));
  assert.equal(sonnet5(), null, 'a retired model is never offered again');
  assert.ok(ret.document.getElementById('model-claude-sonnet-5-5'), 'the others stay');
  // Other's service rejected its key: Replace key opens Other's form at its address.
  const oth = await pageRig({ state: { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' }, keys: { custom: { masked: 'sk-or-…m0ck', state: 'invalid' } }, choice: { provider: 'custom', model: 'openai/gpt-5-mini', effort: null } } });
  assert.equal(alert(oth).querySelector('.alert-head').textContent, 'openrouter.ai rejected your key.');
  assert.deepEqual(alert(oth).querySelectorAll('button').map(label), ['Replace key'], 'no page of ours to open for Other');
  await oth.press(fk(oth, 'replace-key'));
  assert.equal(active(oth).id, 'custom-url');
});

// The bridge's health states the window had no words for: chats that can't be saved (code health BR-11) and a
// limit held because today's spend couldn't be read (BR-09). Home's one card, as every state has it, and on
// another page only the nav's dot (the app trim).
test('code health BR-11, BR-09: chats that can’t be saved, and a limit held because today’s spend couldn’t be read, are Home’s one card in a few words, nowhere else; Set limit sets the same amount again; each card goes with its cause', async () => {
  const words = x => { const c = alert(x); return c ? [c.querySelector('.alert-head').textContent, c.querySelector('.alert-sub')?.textContent ?? null, c.querySelectorAll('button').map(label)] : null; };
  // A full disk (BR-11): the bridge's words (status-view.mjs savingLines). Making room is the player's, outside the
  // app, and the app writes them again by itself: no button, no Okay.
  const full = { file: 'records.json', code: 'ENOSPC', at: 1, diskFull: true };
  const r = await pageRig({ state: { ...IN_GAME, writeError: full } });
  assert.equal(titleText(r), 'One thing needs you');
  assert.deepEqual(words(r), ['Your disk is full, so chats aren’t saved.', 'Free up space, and NeverQuestAlone saves them.', []]);
  assert.match(alert(r).className, /\balert-bad\b/);
  assert.equal(r.byText('Okay').length, 0, 'no Okay while it holds');
  assert.equal(r.statusText(), 'Needs you', 'his word says it too');
  assert.equal(r.document.getElementById('portrait').getAttribute('data-mood'), 'needs');
  assert.equal(r.bannerText(), '', 'Home draws it itself: no banner too');
  await nav(r, 'settings');
  assert.equal(banner(r), null, 'no banner on another page (the app trim)');
  assert.equal(r.bannerText(), '');
  assert.equal(r.document.querySelector('[data-nav="home"]').getAttribute('data-attention'), 'true', 'the nav says it');
  // Written once there's room: the card goes.
  r.mock.control.patch({ writeError: null });
  await r.push();
  await nav(r, 'home');
  assert.equal(alert(r), null);
  assert.equal(r.statusText(), 'In game');
  // Any other write error: not a full disk (the store says which), so not that step (bones-ux-writer UX-W03).
  assert.deepEqual(words(await pageRig({ state: { ...IN_GAME, writeError: { file: 'outbox.jsonl', code: 'EROFS', at: 2, diskFull: false } } })),
    ['NeverQuestAlone can’t save your chats.', 'Restart your computer if it keeps happening.', []]);
  // One card: a state with a fix of its own comes first, and the full disk's card follows it.
  assert.deepEqual(words(await pageRig({ state: { ...IN_GAME, writeError: full, rt: { state: 'out_of_credit' } } }))[0], 'Your Anthropic account is out of credit.');
  // A limit held because today's spend couldn't be read (BR-09: rt cap, reason load_error, usage.held): its own words,
  // and its fix, Set limit, is the page's one primary.
  const held = await pageRig({ state: { ...IN_GAME, caps: { dailyUsd: 1 }, spentMicros: 120_000, held: true } });
  assert.equal(titleText(held), 'One thing needs you');
  assert.deepEqual(words(held), ['Today’s spend couldn’t be read, so NeverQuestAlone rests.', 'Set your limit again to count from now.', ['Set limit']]);
  assert.deepEqual(primaries(held).map(label), ['Set limit']);
  assert.equal(held.statusText(), 'Needs you');
  // The spend the bridge reports while held is the limit, not what was spent: the strip says it's unknown, with
  // no meter, and never "$1.00 of $1.00" under a card that says it couldn't be read (bones-ux-writer UX-W01).
  const strip = () => fk(held, 'ai-strip');
  assert.equal(strip().querySelector('.aistrip-spent').textContent, 'Today’s spend unknown');
  assert.equal(strip().querySelector('.xp'), null);
  // Set limit: Your AI's limit, its amount focused; Save limit shows for the same amount, which sets it again.
  await held.press(fk(held, 'set-limit-again'));
  assert.equal(titleText(held), 'Your AI');
  assert.equal(held.document.getElementById('today-row').textContent, 'TodayUnknown', 'the Today row says so too, with no meter');
  assert.equal(held.document.querySelector('#today-row .xp'), null);
  assert.equal(active(held).id, 'cap-dailyUsd');
  assert.equal(active(held).value, '1.00');
  assert.equal(fk(held, 'save-limit').hidden, false, 'Save limit for the same amount');
  await held.press(fk(held, 'save-limit'));
  assert.deepEqual(held.calls.filter(c => c[0] === 'setCaps').at(-1)[1], { dailyUsd: 1 });
  assert.equal(held.confirms.length, 0, 'the same amount asks nothing');
  assert.equal(rowLine(held).textContent, 'Saved.');
  assert.equal(fk(held, 'save-limit').hidden, true, 'no longer held: Save limit only for a new amount again');
  assert.equal(held.document.getElementById('today-row').textContent, 'Today$0.12 of $1.00', 'counted from what’s known again');
  await nav(held, 'home');
  assert.equal(alert(held), null, 'set again: the card goes');
  assert.equal(strip().querySelector('.aistrip-spent').textContent, '$0.12 of $1.00 today');
  // Away from the window: the tray's word and the desktop notification tell the same story, never "reached" (UX-W02).
  const hs = { backend: { rt: { state: 'cap', reason: 'load_error' }, provider: { name: 'Anthropic', modelName: 'Claude Haiku 4.5', companion: 'Nova' }, usage: { capMicros: 1_000_000, held: 'load_error', needs: 'cap' } } };
  assert.equal(trayLine(hs), 'Today’s spend unknown · Anthropic · Claude Haiku 4.5');
  const shown = [];
  const n = createNotifier({ show: x => shown.push(x) });
  n.update(hs);
  assert.deepEqual(shown.map(x => [x.kind, x.title, x.body, x.page]), [['cap_unread', 'Today’s spend couldn’t be read, so Nova rests.', 'Set your limit again in NeverQuestAlone.', 'home']]);
  n.update({ backend: { ...hs.backend, rt: { state: 'cap', reason: 'cap_spend' }, usage: { capMicros: 1_000_000, needs: 'cap' } } });
  assert.equal(shown.at(-1).title, 'You’ve reached your daily spend limit ($1.00).', 'a limit reached later is said as before');
});

// A message the bridge couldn't record because a write on this computer failed (local_write: a full disk, a folder
// it can't write). The card's line is the bridge's step, the first time too, and it has no button: Retry is the
// game's (bones-ux-writer UX-W07). The desktop notification's "Open NeverQuestAlone for the fix." leads to it.
test('UX-W07: a message a write on this computer kept from going: Home’s card says the step, the first time too, with no button (Retry is in game), for a full disk and any other write error; the notification leads there', async () => {
  const words = x => { const c = alert(x); return c ? [c.querySelector('.alert-head').textContent, c.querySelector('.alert-sub')?.textContent ?? null, c.querySelectorAll('button').map(label)] : null; };
  for (const [code, head, sub] of [
    ['ENOSPC', 'Your disk is full, so nothing was sent.', 'Free up space, then click Retry in game.'],
    ['EACCES', 'NeverQuestAlone couldn’t save on this computer, so nothing was sent.', 'Click Retry in game, or restart your computer.'],
  ]) {
    const r = await pageRig({ state: { ...IN_GAME, lastError: { kind: 'local_write', code, at: 7 } } });
    assert.equal(titleText(r), 'One thing needs you', code);
    assert.deepEqual(words(r), [head, sub, []], `${code}: the step, and no Open Last request`);
    assert.ok(sub.split(/\s+/).length <= 8, `${code}: a card's line, 8 words at most`);
    assert.deepEqual(primaries(r).map(label), [], `${code}: no button on the page either`);
    // Main's notifier on the same status: a click opens Home, where the card above has the fix.
    const shown = [];
    createNotifier({ show: x => shown.push(x) }).update(await r.api.status());
    assert.deepEqual(shown.map(x => [x.title, x.body, x.page]), [[head, 'Open NeverQuestAlone for the fix.', 'home']], code);
  }
});

test('D-05: a start that failed says “couldn’t start” and stays, with Quit and reopen and Copy diagnostics; setup shows it too', async () => {
  const r = await pageRig({ state: { ...READY, rt: { state: 'provider_down', reason: 'bridge_unavailable' } }, apiMode: 'error', apiReason: 'the bridge failed to start: Another copy of NeverQuestAlone is already running for this World of Warcraft (pid 4242). Quit it first.' });
  assert.equal(titleText(r), 'One thing needs you', 'the card says what; the title never repeats it');
  const a = alert(r);
  assert.equal(a.querySelector('.alert-head').textContent, 'NeverQuestAlone couldn’t start.');
  assert.equal(a.querySelector('.alert-sub').textContent, 'Another copy’s open.');
  assert.doesNotMatch(a.textContent, /bridge|pid/i, 'no plumbing words, no error text');
  assert.equal(r.byText('Okay').length, 0);
  await r.press(fk(r, 'copy-diagnostics'));
  assert.match(alert(r).textContent, /Copied\. Paste it into your bug report on GitHub\./);
  // Another copy runs: reopening would meet it again, so this copy just quits (CL-words-29).
  assert.equal(fk(r, 'quit-reopen'), null);
  assert.equal(label(fk(r, 'quit-copy')), 'Quit this copy');
  await r.press(fk(r, 'quit-copy'));
  assert.ok(r.calls.some(c => c[0] === 'quitApp'));
  const other = await pageRig({ state: { ...READY, rt: { state: 'provider_down', reason: 'bridge_unavailable' } }, apiMode: 'error', apiReason: 'the bridge failed to start: x' });
  await other.press(fk(other, 'quit-reopen'));
  assert.ok(other.calls.some(c => c[0] === 'relaunch'));
  const s = await pageRig({ onboarded: false, apiMode: 'error', apiReason: 'x' });
  assert.match(s.bannerText(), /NeverQuestAlone couldn’t start\./);
});

test('D-01 (rest): a failure no rt state covers, which the game sends to the desktop, is the card from the bridge’s line with its fix; two bad requests in a row say so; it goes with the next reply', async () => {
  const r = await pageRig({ state: { ...OPENAI, lastError: { kind: 'region_blocked', at: 1 } } });
  assert.equal(titleText(r), 'One thing needs you');
  assert.match(alert(r).textContent, /OpenAI isn’t available where you are\./);
  assert.equal(r.byText('Okay').length, 0);
  assert.deepEqual(alert(r).querySelectorAll('button').map(label), ['Pick another AI'], 'no key test for a place the AI isn’t offered (CL-words-22)');
  await r.press(fk(r, 'pick-ai'));
  assert.equal(titleText(r), 'Your AI');
  assert.ok(r.document.querySelector('.choices'), 'the AIs, as step 2 has them');
  const ib = await pageRig({ state: { ...OPENAI, lastError: { kind: 'identifier_blocked', at: 2 } } });
  assert.match(alert(ib).textContent, /OpenAI has blocked this install\./);
  assert.deepEqual(alert(ib).querySelectorAll('button').map(label), ['Pick another AI', 'Open Diagnostics']);
  // The provider's spend limit: a key test that clears the card when it passes (D-32), and its limits page.
  const sl = await pageRig({ state: { ...READY, lastError: { kind: 'spend_limit', at: 3 } } });
  // The fix first, then Check again: the key is fine (CL-words-22).
  assert.deepEqual(alert(sl).querySelectorAll('button').map(label), ['Open Anthropic’s limits page', 'Check again']);
  const limits = sl.byText('Open Anthropic’s limits page');
  if (limits.length) { await sl.press(limits[0]); assert.ok(sl.opened.includes('https://platform.claude.com/settings/billing')); }
  await sl.press(fk(sl, 'card-check'));
  await sl.push();
  assert.equal(alert(sl), null, 'the passing test cleared it');
  assert.doesNotMatch(sl.bannerText(), /ready again/, 'the card going is the answer: no second notice (the app trim)');
  // In-game fixes (a network drop) stay in game: no card.
  const net = await pageRig({ state: { ...READY, lastError: { kind: 'network_before_send', at: 4 } } });
  assert.equal(alert(net), null);
  // D-33: one bad request shows nothing on the page (the app trim: no one-off notice); two in a row
  // are the card: Test key first (a player's action), Open Last request beside it.
  const one = await pageRig({ state: { ...READY, lastError: { kind: 'bad_request', at: 5, streak: 1 } } });
  assert.equal(alert(one), null);
  assert.doesNotMatch(one.bannerText(), /One message failed/, 'no one-off notice');
  const { needsPlayer } = await import('../../app/desktop/src/status-text.mjs');
  const st = await one.ipc.call('status');
  assert.equal(needsPlayer(st), false, 'no tray attention');
  const shown = [];
  createNotifier({ show: x => shown.push(x) }).update(st);
  assert.equal(shown.length, 0, 'no OS notification');
  const two = await pageRig({ state: { ...READY, lastError: { kind: 'bad_request', at: 6, streak: 2 } } });
  // CL-words-22: not the key; which message is in Last request, diagnostics for a bug report.
  assert.equal(alert(two).querySelector('.alert-head').textContent, 'Anthropic turned down that message twice.');
  assert.equal(two.statusText(), 'Needs you');
  assert.deepEqual(alert(two).querySelectorAll('button').map(label), ['Open Last request', 'Copy diagnostics']);
  assert.deepEqual(primaries(two).map(label), ['Open Last request']);
  await two.click('Open Last request');
  assert.equal(titleText(two), 'Last request');
});

test('fix-102: a bridge that stopped while the window stayed says it needs a restart (not that it couldn’t start), with Quit and reopen; Your AI’s Test key whose fix is a restart has the same button', async () => {
  const r = await pageRig({ state: { ...READY, rt: { state: 'not_running', reason: 'app_stopped' } } });
  const a = alert(r);
  assert.equal(a.querySelector('.alert-head').textContent, 'NeverQuestAlone needs a restart.');
  assert.equal(a.querySelector('.alert-sub').textContent, 'Your keys and settings are kept.');
  assert.doesNotMatch(a.textContent, /couldn’t start|internet/i);
  await r.press(fk(r, 'quit-reopen'));
  assert.ok(r.calls.some(c => c[0] === 'relaunch'));
  const y = await pageRig({ state: { ...READY, results: { testKey: { ok: false, error: 'egress_blocked', action: 'restart', headline: 'NeverQuestAlone needs a restart.', detail: 'Click Quit and reopen.' } } }, hash: 'provider' });
  await y.press(fk(y, 'now-test'));
  const out = y.document.querySelector('#key-row .set-line');
  assert.match(out.textContent, /^NeverQuestAlone needs a restart\./);
  assert.deepEqual(out.querySelectorAll('button').map(b => b.textContent.trim()), ['Quit and reopen']);
  await y.press(out.querySelector('button'));
  assert.ok(y.calls.some(c => c[0] === 'relaunch'));
});

test('D-35 (the app trim): a one-off failure is no notice, in a new window or the first; two in a row are the card', async () => {
  const store = { seen: [] };
  const state = { ...READY, lastError: { kind: 'bad_request', at: 5, streak: 1 } };
  const r = await pageRig({ state, store });
  assert.doesNotMatch(r.bannerText(), /One message failed/, 'nothing says it');
  assert.equal(r.byText('Okay').length, 0, 'so there is no Okay to put away');
  const later = await pageRig({ state: { ...READY, lastError: { kind: 'bad_request', at: 9, streak: 1 } }, store });
  assert.doesNotMatch(later.bannerText(), /One message failed/, 'a new one says nothing either');
});

test('D-36 and D-38: a card’s check that passes clears the trouble behind it and leaves nothing to put away (the app trim); one that fails says only that nothing changed', async () => {
  const c = await pageRig({ state: { ...READY, rt: { state: 'out_of_credit' } } });
  await c.click('Add credit at Anthropic');
  assert.ok(c.opened.some(u => /billing/.test(u)), 'the billing page');
  await c.click('Test key');
  await c.push();
  assert.equal(alert(c), null, 'the card goes');
  assert.equal(c.document.querySelector('#banners .notice-ok'), null, 'and no “ready again” notice takes its place');
  const d = await pageRig({ state: { ...READY, rt: { state: 'provider_down' } } });
  // Not the key (CL-words-22): Check again, and the next message tries again anyway.
  assert.equal(alert(d).querySelector('.alert-sub').textContent, 'NeverQuestAlone tries again with your next message.');
  d.mock.control.reset({ ...READY });
  await d.click('Check again');
  await d.push();
  assert.equal(alert(d), null);
  assert.equal(d.document.querySelector('#banners .notice-ok'), null);
  const l = await pageRig({ state: { ...CUSTOM_LOCAL, rt: { state: 'local_down' } } });
  await l.click('Check again');
  await l.push();
  assert.equal(alert(l), null);
  assert.equal(l.document.querySelector('#banners .notice-ok'), null);
  const f = await pageRig({ state: { ...READY, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'nocredit' } }, rt: { state: 'out_of_credit' } } });
  await f.click('Test key');
  await f.push();
  assert.ok(alert(f), 'the card stays');
  assert.equal(alert(f).querySelector('.alert-out').textContent, 'Still no credit.', 'only that nothing changed');
  assert.equal(f.document.querySelector('#banners .notice-ok'), null);
  const lf = await pageRig({ state: { ...CUSTOM_LOCAL, addonInstalled: true, rt: { state: 'local_down' }, results: { testKey: { ok: false, error: 'local_unreachable', headline: 'x', detail: 'y', action: 'retry' } } } });
  await lf.click('Check again');
  assert.equal(alert(lf).querySelector('.alert-out').textContent, 'Still can’t reach localhost:11434.');
});

test('UX-W31: a test on Your AI that fails for the reason a card says is the card’s “still” line, with no second button; the key store has its own line', async () => {
  const fail = (error, extra = {}) => ({ testKey: { ok: false, error, headline: 'x', detail: 'y', action: null, ...extra } });
  const CASES = [
    ['rejected', { ...READY, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } }, results: fail('auth_invalid', { action: 'replace_key' }) }, 'Anthropic still rejects this key.'],
    ['spend limit', { ...READY, lastError: { kind: 'spend_limit', at: 1 }, results: fail('spend_limit', { action: 'provider_limits' }) }, 'Still at the spend limit you set at Anthropic.'],
    ['daily limit', { ...READY, caps: { dailyUsd: 1 }, spentMicros: 1_000_000, results: fail('cap_spend', { action: 'caps' }) }, 'Still at your daily spend limit.'],
    ['slowed', { ...READY, rt: { state: 'slowed', retryIn: 18 }, results: fail('rate_limited', { action: 'retry' }) }, 'Anthropic still asks NeverQuestAlone to slow down.'],
    ['region', { ...OPENAI, lastError: { kind: 'region_blocked', at: 1 }, results: fail('region_blocked', { action: 'pick_provider' }) }, 'OpenAI still isn’t available where you are.'],
    ['blocked install', { ...OPENAI, lastError: { kind: 'identifier_blocked', at: 1 }, results: fail('identifier_blocked', { action: 'pick_provider' }) }, 'OpenAI still blocks this install.'],
    ['retired model', { ...READY, choice: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, notice: { kind: 'model_retired', model: 'claude-sonnet-5', at: 1 }, results: fail('model_not_found', { action: 'pick_model' }) }, 'Claude Sonnet 5 is still retired.'],
    ['key store', { ...READY, rt: { state: 'no_key', reason: 'key store unreadable' }, results: fail('no_key', { action: 'keys' }) }, 'Still can’t read your Anthropic key.'],
  ];
  for (const [name, state, want] of CASES) {
    const r = await pageRig({ state, hash: 'provider' });
    assert.equal(banner(r), null, `${name}: no banner above (the app trim)`);
    await r.press(fk(r, 'now-test'));
    const out = rowLine(r);
    assert.equal(out.textContent, want, name);
    // A retired model's line is the model's, under Model, never the key's (CL-player-52).
    const inModel = r.document.querySelectorAll('#model-row .set-line').includes(out);
    assert.equal(inModel, name === 'retired model', `${name}: under ${name === 'retired model' ? 'Model' : 'its row'}`);
    assert.equal(out.querySelectorAll('button').length, 0, `${name}: the banner has the fix`);
  }
  // Out of credit (the view, with the key itself fine): the Key row reads No credit, never a green Saved (CL-player-55).
  const oc = await pageRig({ state: { ...READY, rt: { state: 'out_of_credit' } }, hash: 'provider' });
  assert.deepEqual(oc.document.querySelectorAll('#key-row .chip').map(e => [e.textContent, e.className]), [['No credit', 'chip chip-warn']]);
  const ks = await pageRig({ state: { ...READY, results: fail('no_key', { action: 'keys', headline: 'Couldn’t read your Anthropic key.', detail: 'Unlock your login keychain, then click Test key.' }) }, hash: 'provider' });
  await ks.press(fk(ks, 'now-test'));
  assert.equal(rowLine(ks).textContent, 'Unlock your login keychain, then test again.');
  // A key test with no card over it shows the bridge's desktop line.
  const c = await pageRig({ state: { ...READY, results: { testKey: { ok: false, error: 'out_of_credit', headline: 'Your Anthropic account is out of credit.', detail: 'Add credit at Anthropic, then click Test key.', action: 'add_credit' } } }, hash: 'provider' });
  await c.press(fk(c, 'now-test'));
  assert.equal(rowLine(c).textContent, 'Your Anthropic account is out of credit. Add credit at Anthropic, then click Test key.');
  const { desktopLine } = await import('../../bridge/byok/app-api.mjs');
  assert.equal(desktopLine({ kind: 'rate_limited', retryAfterMs: 18_000 }, { provider: 'Anthropic', platform: 'darwin' }).detail, 'Wait 18 seconds, then click Test key.');
});

test('Your AI (spec §6.3): the AI (Change), the key (masked, a chip in words, Test key, Replace key), every model by name with its cost a day (Recommended on the default), thinking from the model’s own levels, the spending group; saves on change; no primary', async () => {
  const r = await pageRig({ state: READY, hash: 'provider' });
  assert.equal(titleText(r), 'Your AI');
  assert.deepEqual(r.document.querySelectorAll('#page .group-title').map(e => e.textContent), [], 'no headings: every row names itself (the app trim)');
  assert.deepEqual(r.document.querySelectorAll('#page .set-key').map(e => e.textContent), ['AI', 'Key', 'Model', 'Today', 'Daily limit'], 'no Saved keys row: Delete key is on the Key row');
  assert.match(r.document.getElementById('ai-row').textContent, /ClaudeAnthropic/);
  const keyRow = r.document.getElementById('key-row');
  assert.equal(keyRow.querySelector('.mono').textContent, 'sk-ant-…xxxx');
  assert.equal(keyRow.querySelector('.mono').getAttribute('data-count'), 'data');
  assert.equal(keyRow.querySelector('.chip'), null, 'a working key has no chip: the mask says it’s saved (APP-D-07)');
  assert.match(keyRow.querySelector('.mono').className, /\bkey-mask\b/, 'the masked key on one line (CL-design-35)');
  assert.deepEqual(keyRow.querySelectorAll('.set-control button').map(b => [label(b), b.className]), [['Test key', 'btn btn-quiet btn-sm'], ['Replace key', 'btn btn-quiet btn-sm'], ['Delete key', 'btn btn-quiet btn-sm btn-danger']], 'one row, one style; Delete key where a player looks for it (CL-design-42, CL-player-56)');
  assert.deepEqual(primaries(r).map(label), [], 'no primary');
  // The app trim: the model is one row (which, at what thinking level, what it costs a day: one whole string, all data;
  // CL-words-78, CL-player-58), its day's cost on one line (CL-design-54); Pick a model opens the lists, behind a click.
  assert.equal(r.document.getElementById('model-sum').querySelector('.set-main').textContent, 'Claude Haiku 4.5 · Thinking: Low · $0.39–0.67 a day');
  assert.equal(r.document.getElementById('model-sum').querySelector('.set-main').getAttribute('data-count'), 'data');
  assert.deepEqual(r.document.querySelectorAll('#model-sum .nowrap').map(e => e.textContent), ['$0.39–0.67 a day'], 'the price and its “a day” never split');
  assert.equal(r.document.getElementById('model-row'), null, 'the list is behind Pick a model');
  assert.equal(r.document.getElementById('effort-row'), null, 'so is Thinking');
  const pickModel = fk(r, 'model-change');
  assert.deepEqual([label(pickModel), pickModel.getAttribute('aria-expanded')], ['Pick a model', 'false']);
  await r.press(pickModel);
  assert.deepEqual([label(fk(r, 'model-change')), fk(r, 'model-change').getAttribute('aria-expanded')], ['Hide models', 'true']);
  assert.equal(r.document.getElementById('model-box').getAttribute('data-behind'), 'click', 'what the word count leaves out');
  // The fold opens inside the Model card (CL-design-55): no second card, no heading; Thinking a muted label over its track.
  assert.ok(r.document.getElementById('model-sum-group').contains(r.document.getElementById('model-box')));
  assert.deepEqual(r.document.querySelectorAll('#page .group-title').map(e => e.textContent), []);
  assert.deepEqual(r.document.querySelectorAll('#effort-row .set-key').map(e => e.textContent), ['Thinking']);
  // The recommended model, the one in use and the cheapest (CL-words-34), at most one chip each
  // (CL-words-35), each with its cost a day at the level in use (CL-design-37); the rest one click away.
  const opts = () => r.document.querySelectorAll('#model-row [role="radio"]');
  const tags = () => opts().map(o => [o.querySelector('.choice-title').textContent, (o.querySelector('.chip') || {}).textContent || null, o.querySelector('.choice-cost').textContent]);
  assert.deepEqual(tags(), [['Claude Sonnet 5.5', 'Recommended', '$0.77–1.34 a day'], ['Claude Haiku 4.5', 'Cheapest', '$0.39–0.67 a day']]);
  assert.equal(opts()[1].getAttribute('aria-checked'), 'true', 'the saved Haiku 4.5');
  const all = fk(r, 'all-models');
  assert.deepEqual([label(all), all.getAttribute('aria-expanded')], ['Show all models', 'false']);
  await r.press(all);
  assert.deepEqual(tags(), [['Claude Sonnet 5.5', 'Recommended', '$0.77–1.34 a day'], ['Claude Opus 5.5', 'Smartest', '$1.48–2.68 a day'], ['Claude Haiku 4.5', 'Cheapest', '$0.39–0.67 a day'], ['Claude Fable 5.1', null, '$3.63–6.70 a day'], ['Claude Sonnet 5', 'Older', '$0.77–1.34 a day']], 'every model by name: the tagged ones, the rest cheapest first, Older last (CL-words-35, CL-design-46)');
  assert.ok(fk(r, 'all-models').querySelector('.ico-chevron'), 'a disclosure, as Show raw request (CL-design-45)');
  assert.deepEqual([label(fk(r, 'all-models')), fk(r, 'all-models').getAttribute('aria-expanded')], ['Show fewer models', 'true'], 'a button names its object; never a second Hide models (CL-words-78)');
  assert.equal(active(r).getAttribute('data-fk'), 'all-models', 'focus stays on the toggle');
  // Thinking: every level the model has (Haiku 4.5's budgets), in one track; under it, the level's day.
  const lv = p => p.document.querySelectorAll('#effort-row [role="radio"]').map(b => b.querySelector('.opt-name').textContent);
  assert.deepEqual(lv(r), ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  // One name at every width (CL-words-55): no short form; the narrow track wraps it in its segment.
  assert.equal(r.document.getElementById('effort-xhigh').textContent, 'Extra high');
  assert.equal(r.document.querySelector('#effort-xhigh .opt-short'), null);
  assert.match(r.document.querySelector('#effort-row .seg').className, /\bseg-row\b/, 'one row');
  assert.equal(r.document.querySelector('#effort-row .seg-note').textContent, 'Low: $0.39–0.67 a day.', 'the cost, and nothing explaining it');
  assert.equal(r.document.querySelector('#model-row select'), null, 'a list for any number of models, never a select');
  await r.press(opts()[1]);
  assert.deepEqual(r.calls.filter(c => c[0] === 'choose').at(-1)[1], { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' }, 'saved on change, at the nearest level to the one in use');
  assert.equal(r.confirms.length, 0, 'the same AI: no dialog');
  assert.equal(rowLine(r).textContent, 'Saved.');
  assert.deepEqual(lv(r), ['Low', 'Medium', 'High', 'Extra high', 'Max'], 'Opus 5.5 always thinks: no Off');
  await r.press(r.document.getElementById('effort-xhigh'));
  assert.deepEqual(r.calls.filter(c => c[0] === 'choose').at(-1)[1], { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.equal(r.document.getElementById('effort-xhigh').getAttribute('aria-checked'), 'true');
  // The rows and the line follow the level (CL-design-37): Extra high costs more than Low.
  assert.match(r.document.querySelector('#effort-row .seg-note').textContent, /^Extra high: \$\d+\.\d\d–\d+\.\d\d a day\./);
  const xhOpus = r.document.querySelector('#model-claude-opus-5-5 .choice-cost').textContent;
  assert.notEqual(xhOpus, '$1.48–2.68 a day', 'Opus at Extra high, not at Low');
  assert.ok(r.document.querySelector('#effort-row .seg-note').textContent.includes(xhOpus.replace(' a day', '')), 'the line and the row agree');
  // Test key: the result under the key, with its cost; focus stays on the button.
  await r.press(fk(r, 'now-test'));
  assert.equal(rowLine(r).textContent, 'Works. That test cost under $0.0001.');
  assert.equal(active(r).getAttribute('data-fk'), 'now-test');
  assert.ok(r.liveText().some(t => /Works\. That test cost/.test(t)), 'read out');
  // Show details: the same sheet as step 2, for the AI in use, with the spending sections (CL-design-42);
  // its name is its words, Show details, on every page (CL-words-85): the heading beside it names the subject.
  assert.equal(r.document.querySelectorAll('#page [data-fk="details"]').length, 1, 'one Show details on the page');
  assert.equal(fk(r, 'details').getAttribute('aria-label'), null, 'named by its own words, never “details” twice');
  // The app trim: the info icon alone shows (a quiet disclosure); its words are there for a screen reader, and the word count leaves them out.
  assert.match(fk(r, 'details').className, /\bbtn-icon\b/);
  assert.match(fk(r, 'details').querySelector('.btn-label').className, /\bsr-only\b/);
  assert.equal(fk(r, 'details').querySelector('.btn-label').textContent, 'Show details');
  await r.press(fk(r, 'details'));
  assert.equal(r.document.getElementById('sheet-title').textContent, 'Claude, in detail');
  assert.ok(r.document.querySelectorAll('#sheet-host .sheet-sec .label').map(l => l.textContent).includes('How it’s counted'), 'spending is in it');
  // The app trim: no tables of replies, days or companies in it, and no actions: Delete key is on the Key row (CL-words-77).
  assert.deepEqual(r.document.querySelectorAll('#sheet-host table').length, 0, 'no history tables');
  assert.deepEqual(r.document.querySelectorAll('#sheet-host .sheet-sec .label').map(l => l.textContent).filter(t => /Last replies|Last 30 days|By AI company/.test(t)), []);
  assert.equal(r.document.querySelector('#sheet-host [data-fk="delete-key"]'), null, 'never behind the icon');
  r.document.dispatchEvent(r.event('keydown', { key: 'Escape' }));
  await r.settle();
  // ChatGPT: GPT-6 Luna's levels, Off where it can answer without thinking.
  const o = await pageRig({ state: OPENAI, hash: 'provider' });
  await o.press(fk(o, 'model-change'));
  assert.deepEqual(lv(o), ['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  await o.press(o.document.getElementById('effort-medium'));
  assert.ok(o.calls.some(c => c[0] === 'choose' && c[1].effort === 'medium'));
  // OpenAI's safety ID isn't a row here (CL-words-19): it's in Your data's Details.
  assert.equal(o.document.getElementById('safety-row'), null);
  assert.equal(fk(o, 'regenerate-safety-id'), null);
  // A model without levels: no Thinking row.
  const nol = await pageRig({ state: { ...READY, extraModels: { anthropic: [{ id: 'claude-plain', name: 'Claude Plain', tier: 'other', effort: false, efforts: [], priceHint: { replyCents: [1, 2], dayUsd: [0.2, 0.41], at: 40 } }] }, choice: { provider: 'anthropic', model: 'claude-plain', effort: null } }, hash: 'provider' });
  assert.equal(nol.document.getElementById('model-sum').querySelector('.set-main').textContent, 'Claude Plain · $0.20–0.41 a day', 'no thinking to name');
  await nol.press(fk(nol, 'model-change'));
  assert.equal(nol.document.getElementById('effort-row'), null, 'no dead row');
  assert.deepEqual(nol.document.querySelectorAll('#page .group-title').map(e => e.textContent), [], 'the models alone: the row above names them');
  // A rejected key: Replace key is the page's primary.
  const bad = await pageRig({ state: { ...READY, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } }, hash: 'provider' });
  assert.equal(bad.document.getElementById('key-row').querySelector('.chip').textContent, 'Rejected');
  assert.deepEqual(primaries(bad).map(label), ['Replace key']);
  // No AI yet: Pick an AI (Home's words, CL-words-38) opens step 2's rows here.
  const none = await pageRig({ state: {}, hash: 'provider' });
  assert.match(none.pageText(), /No AI yet\./);
  await none.click('Pick an AI');
  assert.ok(none.document.querySelector('.choices'));
  // Other: its model as text; its Replace key opens its form, filled from the saved service.
  const oth = await pageRig({ state: { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' }, keys: { custom: { masked: 'sk-or-…m0ck', state: 'ok' } }, choice: { provider: 'custom', model: 'openai/gpt-5-mini', effort: null } }, hash: 'provider' });
  assert.match(oth.document.getElementById('ai-row').textContent, /Otheropenrouter\.ai/);
  assert.equal(oth.document.querySelector('#model-row .mono').textContent, 'openai/gpt-5-mini');
  await oth.press(fk(oth, 'key-custom'));
  assert.equal(oth.document.getElementById('custom-url').value, 'https://openrouter.ai/api/v1');
  assert.equal(oth.document.getElementById('custom-key').value, '', 'a saved key never comes back to the page');
  // A model on this computer (CL-words-45): no Key row; Runs on this Mac under the AI, Check again beside
  // Switch; the model's name with no second Model label.
  const loc = await pageRig({ state: { ...CUSTOM_LOCAL, addonInstalled: true }, hash: 'provider' });
  assert.equal(label(fk(loc, 'now-test')), 'Check again');
  assert.equal(loc.document.getElementById('key-row'), null);
  assert.ok(loc.document.getElementById('ai-row').contains(fk(loc, 'now-test')));
  assert.match(loc.document.getElementById('ai-row').textContent, /Runs on this computer/);
  assert.equal(loc.document.querySelector('#model-row .set-key'), null);
  // Keys kept for this session only: said.
  const sess = await pageRig({ state: { ...READY, keysPersistent: false }, hash: 'provider' });
  assert.match(sess.pageText(), /Your key is kept until you quit\./);
});

test('D-03 and D-04: Replace key tests the new key first; one Anthropic doesn’t accept leaves the saved key, and says so; focus stays on Paste across the redraw', async () => {
  const r = await pageRig({ state: READY, hash: 'provider' });
  await r.press(fk(r, 'key-anthropic'));
  assert.equal(active(r).id, 'key-field', 'Replace key opens the key field, focused');
  assert.ok(r.document.scrolls.some(e => e.id === 'key-row'), 'and brings it into view');
  r.setClipboard(FAKE_BAD_KEY);
  await r.press(fk(r, 'paste-key'));
  assert.equal(r.confirms.length, 1);
  assert.equal(r.confirms[0].okLabel, 'Test and replace');
  assert.equal(r.document.querySelector('#replace-box .result').textContent, 'Anthropic didn’t accept that key. Your saved key is unchanged.');
  assert.equal(r.document.getElementById('key-row').querySelector('.mono').textContent, 'sk-ant-…xxxx', 'the saved key is still there');
  assert.equal(r.calls.filter(c => c[0] === 'setKey' || c[0] === 'connect').length, 0, 'never stored');
  assert.equal(r.ctx.keys.size, 0, 'the key it didn’t accept is dropped in main');
  r.setClipboard(FAKE_KEY);
  await r.press(fk(r, 'paste-key'));
  assert.equal(r.confirms.at(-1).message, 'Replace your Anthropic key?');
  assert.equal(r.document.querySelector('#replace-box .result').textContent, 'Claude is connected.');
  assert.equal(active(r).getAttribute('data-fk'), 'paste-key', 'focus stays on Paste across the redraw');
  // The key field: typing is allowed; Enter sends it to main, and the field clears.
  const f = await pageRig({ state: READY, hash: 'provider' });
  await f.press(fk(f, 'key-anthropic'));
  const field = f.document.getElementById('key-field');
  field.value = FAKE_KEY;
  field.dispatchEvent(f.event('keydown', { key: 'Enter' }));
  await f.settle(30);
  assert.equal(f.document.getElementById('key-field').value, '');
  assert.ok(!f.page().textContent.includes('CANARY'), 'nothing typed is on the page');
  assert.equal(f.document.querySelector('#replace-box .result').textContent, 'Claude is connected.');
});

test('Replace key: a paste into the key field is Paste key: main reads the clipboard, never the page, and the key leaves it once saved (code health AP-05)', async () => {
  const r = await pageRig({ state: READY, hash: 'provider' });
  await r.press(fk(r, 'key-anthropic'));
  r.setClipboard(FAKE_KEY);
  let read = 0;
  const ev = r.event('paste', { clipboardData: { getData: () => { read += 1; return 'not this'; } } });
  r.document.getElementById('key-field').dispatchEvent(ev);
  await r.settle(30);
  assert.equal(ev.defaultPrevented, true, 'nothing lands in the field');
  assert.equal(read, 0, 'the page never reads the clipboard');
  assert.equal(r.confirms.length, 1);
  assert.equal(r.confirms[0].message, 'Replace your Anthropic key?');
  assert.equal(r.document.querySelector('#replace-box .result').textContent, 'Claude is connected.');
  assert.equal(r.clip.text, '', 'off the clipboard once saved');
  assert.equal(r.document.getElementById('key-field').value, '');
  assert.ok(!r.page().textContent.includes('CANARY'), 'nothing of the key on the page');
  // A key the company doesn't accept stays where the player copied it (nothing was saved).
  const b = await pageRig({ state: READY, hash: 'provider' });
  await b.press(fk(b, 'key-anthropic'));
  b.setClipboard(FAKE_BAD_KEY);
  b.document.getElementById('key-field').dispatchEvent(b.event('paste', { clipboardData: { getData: () => '' } }));
  await b.settle(30);
  assert.equal(b.document.querySelector('#replace-box .result').textContent, 'Anthropic didn’t accept that key. Your saved key is unchanged.');
  assert.equal(b.clip.text, FAKE_BAD_KEY);
});

test('Your AI, Change: step 2’s rows here with ‹ Your AI; a key for another AI switches (main’s dialog), then back to Your AI; Delete key is on the Key row, and in Switch for a key saved for another AI (main’s confirm first)', async () => {
  const r = await pageRig({ state: { ...READY, terms: { anthropic: 1 } }, hash: 'provider' });
  await r.press(fk(r, 'change-ai'));
  assert.ok(r.document.querySelector('.choices'));
  assert.equal(label(fk(r, 'back')), 'Back');
  await r.press(fk(r, 'card-openai'));
  r.setClipboard(`sk-proj-CANARY${'x'.repeat(60)}`);
  await r.press(fk(r, 'paste-key'));
  assert.equal(r.confirms.at(-1).message, 'Switch NeverQuestAlone to ChatGPT with this key?');
  assert.equal(r.document.querySelector('#result-slot .result').textContent, 'ChatGPT is connected.');
  await r.press(fk(r, 'continue'));
  assert.equal(titleText(r), 'Your AI');
  assert.match(r.document.getElementById('ai-row').textContent, /ChatGPTOpenAI/);
  // The app trim: no Saved keys page. The key in use is removed on its Key row, after main's confirm.
  assert.equal(fk(r, 'saved-keys'), null, 'no Saved keys row');
  assert.equal(r.document.getElementById('saved-keys-row'), null);
  assert.ok(r.document.getElementById('key-row').contains(fk(r, 'delete-key')));
  await r.press(fk(r, 'delete-key'));
  assert.equal(r.confirms.at(-1).message, 'Delete your OpenAI key?');
  assert.equal(r.confirms.at(-1).destructive, true);
  assert.equal(r.calls.filter(c => c[0] === 'deleteKey').at(-1)[1], 'openai', 'the key in use, ChatGPT’s');
  // Claude's key, saved but not in use: Switch, its row, Delete key (main asks first); a no deletes nothing.
  let answer = false;
  const sw = await pageRig({ state: { ...READY, keys: { ...SAVED, openai: { masked: 'sk-proj-…xxxx', state: 'ok' } }, terms: { anthropic: 1, openai: 1 } }, hash: 'provider', confirm: () => answer });
  await sw.press(fk(sw, 'change-ai'));
  assert.equal(fk(sw, 'delete-key'), null, 'Claude is in use: its Delete key is on the Key row');
  await sw.press(fk(sw, 'card-openai'));
  assert.equal(label(fk(sw, 'delete-key')), 'Delete key');
  assert.equal(fk(sw, 'delete-key').className, 'btn btn-quiet btn-danger');
  await sw.press(fk(sw, 'delete-key'));
  assert.equal(sw.confirms.at(-1).message, 'Delete your OpenAI key?');
  assert.equal(sw.calls.filter(c => c[0] === 'deleteKey').length, 0, 'a no deletes nothing');
  answer = true;
  await sw.press(fk(sw, 'delete-key'));
  assert.equal(sw.calls.filter(c => c[0] === 'deleteKey').at(-1)[1], 'openai');
  assert.equal(fk(sw, 'delete-key'), null, 'gone with the key');
  assert.equal(sw.document.querySelector('#choice-openai .chip'), null, 'no Key saved chip');
});

test('Spending (Your AI’s group, spec §6.4): today’s spend; the daily spend limit is the player’s, off by default, never pre-filled, one line says what it does; Save limit is the one primary only while editing, and shows for a set limit only once the amount changes; setting and raising ask, lowering doesn’t; turning it off asks; Enter saves', async () => {
  let answer = false;
  const r = await pageRig({ state: READY, hash: 'usage', confirm: () => answer });
  const field = () => r.document.getElementById('cap-dailyUsd');
  const type = async v => { const f = field(); f.focus(); f.value = v; f.dispatchEvent(r.event('input')); await r.settle(); };
  const save = () => fk(r, 'save-limit');
  assert.equal(titleText(r), 'Your AI');
  assert.equal(r.document.querySelector('#spend-group .group-title'), null, 'no heading: Today and Daily limit name themselves');
  assert.equal(r.document.getElementById('today-row').textContent, 'Today$0.18', 'the spend; no reply count (the app trim)');
  assert.ok(['today-row', 'limit-row'].every(id => /\bset-stack\b/.test(r.document.getElementById(id).className)), 'each label over its value, as Connection’s (CL-design-47)');
  assert.equal(r.document.querySelector('.xp'), null, 'no meter without a limit');
  assert.equal(r.document.getElementById('limit-row').textContent, 'Daily limitSet a limit', 'one row: no limit, said once, by its button');
  assert.deepEqual(primaries(r).map(label), []);
  await r.click('Set a limit');
  assert.equal(active(r).id, 'cap-dailyUsd', 'the amount, focused');
  assert.equal(field().value, '', 'empty: nothing pre-filled');
  assert.deepEqual(primaries(r).map(label), ['Save limit'], 'the one primary while editing');
  assert.match(r.document.getElementById('limit-row').textContent, /NeverQuestAlone stops here, back at midnight\./, 'what the limit does, under the amount');
  await r.click('Cancel');
  assert.equal(field(), null, 'Cancel: No limit again');
  await r.click('Set a limit');
  await r.click('Save limit');
  assert.equal(rowLine(r).textContent, 'Type an amount from $0.01 to $100.');
  assert.equal(field().getAttribute('aria-invalid'), 'true');
  assert.equal(r.calls.filter(c => c[0] === 'setCaps').length, 0);
  await type('0');
  await r.click('Save limit');
  assert.equal(r.calls.filter(c => c[0] === 'setCaps').length, 0, 'a $0 limit isn’t one');
  // A first limit asks nothing. Enter saves.
  await type('2.00');
  field().dispatchEvent(r.event('keydown', { key: 'Enter' }));
  await r.settle();
  assert.equal(r.confirms.length, 0, 'a first limit: no confirm');
  assert.equal(rowLine(r).textContent, 'Saved.');
  assert.equal(field().value, '2.00');
  assert.ok(r.document.querySelector('.xp'), 'the XP bar, with a limit');
  assert.equal(save().hidden, true, 'nothing changed: no Save limit');
  await type('2.50');
  assert.equal(save().hidden, false, 'the amount changed: Save limit shows');
  await type('2.00');
  assert.equal(save().hidden, true, 'back to what’s saved: it goes again');
  assert.deepEqual(await r.api.caps(), { dailyUsd: 2, spentTodayMicros: 180_000 });
  // Lowering asks nothing.
  await type('0.50');
  field().dispatchEvent(r.event('keydown', { key: 'Enter' }));
  await r.settle();
  assert.equal(r.confirms.length, 0, 'lowering: no confirm');
  // Raising asks; a cancel puts the saved value back.
  await type('5.00');
  await r.click('Save limit');
  assert.equal(r.confirms.length, 1, 'raising: a confirm');
  assert.equal(r.confirms[0].message, 'Raise your daily spend limit to $5.00?');
  assert.equal(field().value, '0.50', 'cancelled: back to what’s saved');
  assert.equal(rowLine(r).textContent, 'Canceled. Nothing changed.');
  await r.click('Turn off limit');
  assert.equal(r.confirms[1].message, 'Turn off your daily spend limit?');
  assert.equal(field().value, '0.50');
  await type('3.00');
  await open(r, 'connections');
  await open(r, 'usage');
  assert.equal(field().value, '0.50', 'a draft doesn’t survive leaving the page');
  answer = true;
  await r.click('Turn off limit');
  assert.equal(rowLine(r).textContent, 'Your daily limit is off.');
  assert.equal(field(), null);
  assert.deepEqual(await r.api.caps(), { dailyUsd: null, spentTodayMicros: 180_000 });
  // Its details are in the page's one Show details (CL-design-42): how it's counted and the limit. The
  // app trim: no tables of last replies, 30 days or AI companies.
  assert.equal(r.document.querySelector('#spend-group [data-fk="details"]'), null);
  await r.press(fk(r, 'details'));
  assert.equal(r.document.getElementById('sheet-title').textContent, 'Claude, in detail');
  const sheetText = r.sheetText();
  assert.match(sheetText, /Estimated from list prices/);
  assert.match(sheetText, /NeverQuestAlone stops at your limit and starts again at midnight\./, 'one subject, as the page and the card (CL-words-50)');
  assert.equal(r.document.querySelectorAll('#sheet-host td').length, 0, 'no history cells');
  assert.equal(r.document.querySelectorAll('#sheet-host table').length, 0, 'no history tables');
  assert.doesNotMatch(sheetText, /Last replies|Last 30 days|By AI company/);
  // The limits page is a full-width link row, as the terms below it (APP-D-46).
  const lim = r.document.querySelector('#sheet-host [data-fk="open-limits"]');
  assert.equal(lim.className, 'sheet-row sheet-link', 'a link row, not an inline link');
  assert.ok(lim.parentNode.classList.contains('sheet-card'), 'in its section’s card');
  // A local model: nothing to spend, nothing to limit.
  const lu = await pageRig({ state: { ...CUSTOM_LOCAL, addonInstalled: true }, hash: 'usage' });
  assert.match(lu.pageText(), /A model on this computer costs nothing\./);
  assert.equal(lu.document.getElementById('cap-dailyUsd'), null);
  assert.equal(lu.byText('Set a limit').length, 0);
});

test('no limits of ours in the window (owner, 2026-09-26): no message counts to stop at; setup never reads or saves a limit', async () => {
  const src = read(path.join(R, 'app.js'));
  assert.doesNotMatch(code(src), /typedPerDay|autoPerDay|capTurns|autoLeft|cap_turns|cap-typedPerDay|Set a daily limit|Save limits/, 'the message limits are gone');
  const k = await pageRig({ onboarded: false });
  k.setClipboard(FAKE_KEY);
  await k.press(fk(k, 'paste-key'));
  assert.equal(titleText(k), 'Set up WoW', 'a working key goes straight on to step 3');
  assert.equal(k.calls.filter(c => c[0] === 'caps' || c[0] === 'setCaps').length, 0, 'setup never reads or saves a limit');
});

test('the check-ins fuse (usage.autoPaused): one line with Okay, no card, no tray attention, no notification; Okay puts it away until it holds again; not over setup', async () => {
  const r = await pageRig({ state: { ...READY, fuse: true } });
  const notes = () => r.document.querySelectorAll('#banners .notice').filter(n => n.textContent.includes('Too many check-ins'));
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].querySelector('.notice-text').textContent, 'Too many check-ins at once. They’re paused until your next message.', 'and when they come back (CL-player-44, CL-words-64)');
  assert.equal(alert(r), null, 'not a problem state');
  const { needsPlayer } = await import('../../app/desktop/src/status-text.mjs');
  const st = await r.ipc.call('status');
  assert.equal(needsPlayer(st), false, 'no tray attention');
  const shown = [];
  createNotifier({ show: x => shown.push(x) }).update(st);
  assert.equal(shown.length, 0, 'no desktop notification');
  await r.press(notes()[0].querySelector('button'));
  assert.equal(notes().length, 0);
  await r.push();
  assert.equal(notes().length, 0);
  r.mock.control.reset(READY);
  await r.push();
  r.mock.control.reset({ ...READY, fuse: { turns: 60, windowMs: 3_600_000 } });
  await r.push();
  assert.equal(notes().length, 1, 'a later burst shows it again');
  const s = await pageRig({ onboarded: false, state: { fuse: true } });
  assert.equal(s.document.querySelectorAll('#banners .notice').length, 0);
});

test('the notices (spec §4.14): a switched model (Pick another model, Okay for good), patch day, settings reset; never a raw model id', async () => {
  const named = await pageRig({ state: { ...READY, notice: { kind: 'model_switched', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', at: 1 } } });
  assert.match(named.bannerText(), /^Claude Sonnet 5 was retired\. Switched to Claude Haiku 4\.5: same price or less\./, 'the old model by name, and that it switched (CL-words-48, CL-player-44)');
  assert.ok(named.byText('Pick another model').length);
  // A choice puts its actions under the words (the 1.3 refresh); Okay alone stays on the line.
  assert.equal(named.document.querySelectorAll('#banners .notice-stack .notice-acts button').length, 2, 'Pick another model and Okay, under the line');
  assert.doesNotMatch(`${named.bannerText()} ${named.liveText().join(' ')}`, /claude-[a-z0-9-]+/, 'never a raw id, on screen or said');
  await named.click('Okay');
  assert.doesNotMatch(named.bannerText(), /Switched to/);
  const { needsPlayer } = await import('../../app/desktop/src/status-text.mjs');
  const running = await pageRig({ state: { ...READY, wow: { found: true, running: true, patch: { to: '16100', version: '1.61.0.71000', restart: true } } } });
  const n = running.document.querySelector('#banners .notice-warn');
  assert.equal(n.querySelector('.notice-text').textContent, 'NeverQuestAlone updated the addon for the new version of World of Warcraft. Restart WoW to load it.');
  assert.equal(running.document.querySelector('#banners .notice-stack'), null, 'Okay alone: one line');
  assert.equal(needsPlayer(await running.ipc.call('status')), true, 'the tray’s attention');
  await running.click('Okay');
  assert.equal(running.document.querySelector('#banners .notice-warn'), null, 'put away');
  const closed = await pageRig({ state: { ...READY, wow: { found: true, running: false, patch: { to: '16100', restart: true } } } });
  assert.ok(closed.document.querySelector('#banners .notice-ok'));
  const failed = await pageRig({ state: { ...READY, wow: { found: true, running: false, patch: { to: '16100', restart: false, failed: true } } } });
  assert.match(failed.bannerText(), /In Settings, click Show more, then Run setup again\./);
});

test('D4, the typed guard: “Sending is paused.” is the card with Resume sending, the tray asks for the player, a notification says it once; the press ends it', async () => {
  const r = await pageRig({ state: { ...READY, sendingPaused: { turns: 20, windowMs: 60_000 } } });
  assert.equal(alert(r).querySelector('.alert-head').textContent, 'Sending is paused.');
  assert.equal(alert(r).querySelector('.alert-sub').textContent, 'More than 20 messages went in a minute, which normal play doesn’t do.');
  assert.deepEqual(alert(r).querySelectorAll('button').map(label), ['Resume sending']);
  const { needsPlayer } = await import('../../app/desktop/src/status-text.mjs');
  const st = await r.ipc.call('status');
  assert.equal(needsPlayer(st), true);
  await r.click('Resume sending');
  assert.ok(r.calls.some(c => c[0] === 'resumeSending'));
  await r.push();
  assert.equal(alert(r), null, 'sending again');
});

test('D7: busy offers Pick another AI, one click to Your AI’s rows; never an automatic switch', async () => {
  const busy = await pageRig({ state: { ...READY, rt: { state: 'provider_down' } } });
  await busy.click('Pick another AI');
  assert.equal(titleText(busy), 'Your AI');
  assert.ok(busy.document.querySelector('.choices'), 'the choice of AI');
  assert.ok(!busy.calls.some(c => c[0] === 'choose'), 'nothing switched by itself');
  assert.doesNotMatch(busy.document.querySelector('#banners').textContent + busy.pageText(), /provider/i, 'never “provider” in player text');
});

test('SY-04: screen reading that fails while WoW runs is one notice with its next step; Settings has no screen-reading row (the app trim)', async () => {
  const waiting = { mode: 'capture', signals: 'ok', steps: { game: true, strip: false, message: false, reply: false } };
  const lost = await pageRig({ state: { ...READY, wow: { found: true, running: true }, capture: { ...waiting, state: 'window_not_found' } } });
  const note = lost.document.querySelectorAll('#banners .notice').find(n => n.textContent.includes('can’t see the game'));
  assert.ok(note, lost.bannerText());
  assert.match(note.querySelector('.notice-text').textContent, /^NeverQuestAlone can’t see the game\. /);
  assert.doesNotMatch(lost.bannerText(), /capture|strip|signal|pixel/i);
  await lost.press(note.querySelector('button'));
  assert.equal(lost.document.querySelectorAll('#banners .notice').filter(n => n.textContent.includes('can’t see the game')).length, 0, 'Okay puts it away until the state changes');
  const closed = await pageRig({ state: { ...READY, wow: { found: true, running: false }, capture: { ...waiting, state: 'window_not_found' } } });
  assert.doesNotMatch(closed.bannerText(), /can’t see the game/, 'nothing to fix with WoW closed');
  const perm = await pageRig({ state: { ...READY, wow: { found: true, running: true }, capture: { ...waiting, state: 'no_permission' } } });
  await perm.click('Open System Settings');
  assert.ok(perm.opened.some(u => u.startsWith('x-apple.systempreferences:')));
  // The app trim: Settings has no screen-reading row (it changes only in game, and the notice above says the
  // next step when it fails; step 3 says how to skip it). Run setup again, in More, is the way back.
  const g = await pageRig({ state: { ...READY, capture: { ...waiting, state: 'ok' } }, hash: 'settings' });
  assert.equal(g.document.getElementById('screen-row'), null, 'no screen-reading row');
  await g.press(fk(g, 'more'));
  assert.equal(g.document.getElementById('screen-row'), null, 'not in More either');
  assert.doesNotMatch(g.pageText(), /Screen reading|\/nqa reading/);
});

test('Settings (spec §6.7, trimmed in the app trim): three switches and Show more; every control saves on change (Saved., or That didn’t save. with Save again); no primary', async () => {
  const r = await pageRig({ state: READY, hash: 'settings' });
  assert.equal(titleText(r), 'Settings');
  // The four switches a player changes (Automatic updates since 1.4.6), and one disclosure; no group headings (the app trim).
  assert.equal(r.document.querySelectorAll('#page .group-title').length, 0, 'no group headings');
  assert.deepEqual(r.document.querySelectorAll('#page .set-key').map(e => e.textContent), ['Start at login', 'Notifications', 'Automatic updates', 'Check-ins'], 'what Settings shows before a click');
  assert.equal(r.document.querySelector('#checkins-row .set-sub').textContent, 'Quest and level-up tips, billed as replies.', 'each tip costs a reply (CL-words-66, CL-player-51)');
  assert.ok(r.document.querySelectorAll('#page .set-sub').every(e => e.textContent.split(/\s+/).length <= 9), 'lines of 9 words or fewer');
  for (const gone of ['size-row', 'pv-echo', 'screen-row', 'history-row', 'memory-row', 'diag-row', 'updates-row', 'about-row', 'uninstall-row', 'setup-row']) assert.equal(r.document.getElementById(gone), null, `${gone}: not before a click`);
  const more = fk(r, 'more');
  assert.deepEqual([label(more), more.getAttribute('aria-expanded')], ['Show more', 'false']);
  assert.ok(more.querySelector('.ico-chevron'), 'a disclosure');
  assert.equal(r.document.getElementById('more-box'), null, 'closed: nothing behind it is drawn');
  assert.deepEqual(primaries(r).map(label), []);
  const sw = r.document.getElementById('sw-notifications');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  await r.press(sw);
  assert.equal(r.document.getElementById('sw-notifications').getAttribute('aria-checked'), 'false');
  assert.equal(r.appState().notifications, false);
  assert.equal(r.document.querySelector('#notes-row .set-line').textContent, 'Saved.');
  assert.equal(active(r).id, 'sw-notifications', 'focus stays on the switch');
  await r.press(r.document.getElementById('sw-login'));
  assert.deepEqual(r.loginSets, [true]);
  assert.equal(r.document.querySelector('#login-row .set-line').textContent, 'Saved.');
  // The app trim: no text-size control; ⌘+ and ⌘− still zoom (D-16), the window's zoom is main's.
  assert.equal(r.document.getElementById('size-row'), null);
  assert.equal(r.calls.filter(c => c[0] === 'zoom').length, 0);
  // Check-ins (a feature, here, not among what's sent): its switch saves on change.
  await r.press(r.document.getElementById('sw-companion'));
  assert.equal(r.document.getElementById('sw-companion').getAttribute('aria-checked'), 'true');
  assert.equal((await r.api.privacy()).companion, true);
  // Chat history: fewer days asks first (main's confirm); more asks nothing.
  let answer = true;
  const h = await pageRig({ state: READY, hash: 'settings', confirm: () => answer });
  await h.press(fk(h, 'more'));
  assert.equal(fk(h, 'more').getAttribute('aria-expanded'), 'true');
  assert.equal(label(fk(h, 'more')), 'Show less');
  assert.equal(h.document.getElementById('more-box').getAttribute('data-behind'), 'click', 'what the word count leaves out');
  const sel = () => h.document.getElementById('retention-days');
  assert.equal(sel().value, '30');
  sel().value = '7'; sel().dispatchEvent(h.event('change')); await h.settle(20);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].message, 'Keep chat history for 7 days instead of 30 days?');
  assert.equal(h.document.querySelector('#history-row .set-line').textContent, 'Saved.');
  answer = false;
  sel().value = '1'; sel().dispatchEvent(h.event('change')); await h.settle(20);
  assert.equal(h.document.querySelector('#history-row .set-line').textContent, 'Canceled. Nothing changed.');
  assert.equal(sel().value, '7', 'back to what’s saved');
  sel().value = '90'; sel().dispatchEvent(h.event('change')); await h.settle(20);
  assert.equal(h.confirms.length, 2, 'keeping them longer asks nothing');
  // OpenAI's safety ID is in Your data's Details (OpenAI only, CL-words-19), never a Settings or Your AI row.
  const o = await pageRig({ state: OPENAI, hash: 'settings' });
  await o.press(fk(o, 'more'));
  assert.equal(o.byText('Replace ID').length, 0);
  await nav(o, 'provider');
  assert.equal(o.byText('Replace ID').length, 0);
  await nav(o, 'privacy');
  await o.press(fk(o, 'details'));
  const rid = () => o.document.querySelector('#sheet-host [data-fk="regenerate-safety-id"]');
  // Replace ID is the row that ends its card, full width like the link rows (APP-D-47).
  assert.equal(rid().className, 'sheet-row sheet-link sheet-action');
  assert.ok(rid().parentNode.classList.contains('sheet-card') && rid().parentNode.lastChild === rid(), 'the card’s last row');
  await o.press(rid());
  assert.ok(o.calls.some(c => c[0] === 'regenerateSafetyId'));
  assert.match(o.sheetText(), /OpenAI gets the new ID now\./);
  assert.equal(o.document.activeElement.getAttribute('data-fk'), 'regenerate-safety-id', 'focus stays on the button');
  assert.ok(rid().parentNode.lastChild === rid(), 'still last: the result line sits above it');
  const a = await pageRig({ state: READY, hash: 'privacy' });
  await a.press(fk(a, 'details'));
  assert.equal(a.document.querySelector('#sheet-host [data-fk="regenerate-safety-id"]'), null, 'only for OpenAI');
  a.document.dispatchEvent(a.event('keydown', { key: 'Escape' }));
  await a.settle();
  await nav(a, 'settings');
  // Run setup again starts setup over; Uninstall opens its page (main confirms first). Both are in More.
  await a.press(fk(a, 'more'));
  await a.click('Uninstall');
  assert.equal(titleText(a), 'Uninstall');
  await a.click('Uninstall');
  assert.ok(a.calls.some(c => c[0] === 'uninstall') || a.confirms.length >= 1);
  // A setting that didn't save says so beside it, with Save again (Your data).
  const bad = await pageRig({ state: { ...READY, results: { setPrivacy: { ok: false, error: 'failed' } } }, hash: 'privacy' });
  await bad.press(bad.document.getElementById('sw-identity'));
  assert.equal(bad.document.getElementById('sw-identity').getAttribute('aria-checked'), 'false', 'it shows what’s saved');
  assert.match(bad.document.querySelector('#pv-identity .set-line').textContent, /Save again/);
});

test('Your data (the nav’s page): three switches with short labels under who they’re sent to, Connections and Last request one click away; where it goes and what the AI company keeps behind Show details (the manifests’ player text, never developer notes)', async () => {
  const r = await pageRig({ state: READY, hash: 'privacy' });
  assert.equal(titleText(r), 'Your data');
  // The app trim: no picture of where it goes on this page (it's the first thing in Show details, as in step 2's sheet);
  // the switches' title says who gets them (CL-words-75, CL-player-54).
  assert.equal(r.document.querySelector('#page figure.flow'), null, 'no picture on the page');
  assert.equal(r.document.querySelector('#sent-group .group-title').textContent, 'Sent to Anthropic with your messages');
  assert.equal(r.document.getElementById('sent-group').getAttribute('aria-label'), 'Sent to Anthropic with your messages');
  // The switches: only what's sent (CL-words-21); short labels, the line under each (CL-design-25).
  assert.deepEqual(r.document.querySelectorAll('#sent-group .set-key').map(e => e.textContent), ['Game data', 'Character name', 'Other players’ names']);
  assert.ok(r.document.querySelectorAll('#sent-group .set-sub').every(e => e.textContent.split(/\s+/).length <= 7));
  const sws = r.document.querySelectorAll('#page [role="switch"]');
  assert.deepEqual(sws.map(s => s.getAttribute('aria-checked')), ['true', 'false', 'false', 'true'], 'the least that works; screen reading on by default');
  assert.deepEqual(r.document.querySelectorAll('#page .set-stack').map(e => e.id), ['pv-gameContext', 'pv-identity', 'pv-otherNames', 'pv-screenReading', 'connections-row', 'last-request-row'], 'the rows take the class, never show it');
  // Screen reading, one click (the orchestrator's trust plan, 2026-10-03): its own group, what it reads
  // exactly, and what off means; off saves through setPrivacy with nothing else changed.
  assert.equal(r.document.querySelector('#screen-group .group-title'), null, 'its label says it (the page\'s 45 words)');
  assert.deepEqual(r.document.querySelectorAll('#screen-group .set-key').map(e => e.textContent), ['Screen reading']);
  assert.equal(r.document.querySelector('#pv-screenReading .set-sub').textContent, 'Reads only the top of WoW’s window.');
  await r.press(r.document.getElementById('sw-screenReading'));
  assert.deepEqual(r.calls.filter(c => c[0] === 'setPrivacy').pop()[1], { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: false });
  assert.equal(r.document.getElementById('sw-screenReading').getAttribute('aria-checked'), 'false');
  assert.equal(r.document.querySelector('#pv-screenReading .set-sub').textContent, 'Off: your messages wait for a /reload.');
  assert.equal(r.document.activeElement.id, 'sw-screenReading', 'focus stays on the switch');
  await r.press(r.document.getElementById('sw-screenReading'));
  assert.equal(r.document.getElementById('sw-screenReading').getAttribute('aria-checked'), 'true', 'on again, one click');
  // On here but off in the addon's Settings (its hello's mode): said, never hidden.
  const inGameOff = await pageRig({ state: { ...READY, setup: { game: { hello: { at: 1, sig: 'ok', mode: 'stream' } } } }, hash: 'privacy' });
  // A warning line, since the switch shows on (APP-D-48), saying where (SRS-W-05).
  assert.equal(inGameOff.document.querySelector('#pv-screenReading .set-sub'), null);
  assert.equal(inGameOff.document.querySelector('#pv-screenReading .set-line-warn').textContent, 'Off in the addon’s Settings, under What NeverQuestAlone Knows.');
  assert.equal(r.document.getElementById('sw-echo'), null, 'the chat-frame echo is Settings’');
  await r.press(r.document.getElementById('sw-identity'));
  assert.ok(r.calls.some(c => c[0] === 'setPrivacy' && c[1].identity === true));
  assert.equal(r.document.getElementById('sw-identity').getAttribute('aria-checked'), 'true');
  // CL-words-62: the picture says what stays private; the records' names say what they are.
  assert.equal(r.document.querySelector('#never-group'), null, 'no Stays private group');
  assert.deepEqual(r.document.querySelectorAll('#records-group .set-sub').map(e => e.textContent), [], 'no hint under Connections or Last request');
  assert.equal(r.document.querySelector('#records-group .group-title'), null, 'no heading over the two records');
  assert.equal(r.document.querySelector('#pv-otherNames .set-sub').textContent, 'Players you target or link.');
  assert.doesNotMatch(r.pageText(), /kept up to 2 years|sales team|Option to keep nothing/, 'no legal terms inline');
  // The records, one click each.
  await r.press(fk(r, 'open-connections'));
  assert.equal(titleText(r), 'Connections');
  // ‹ Back to Your data, from each record (CL-design-27).
  await r.press(fk(r, 'back'));
  assert.equal(titleText(r), 'Your data');
  await r.press(fk(r, 'open-last-request'));
  assert.equal(titleText(r), 'Last request');
  await r.press(fk(r, 'back'));
  assert.equal(titleText(r), 'Your data');
  // Show details: what Anthropic keeps and whether it trains (the manifest's player text) and its policy:
  // no keep-nothing options, no in-game tip, no other companies' policies (the app trim).
  await nav(r, 'privacy');
  await r.press(fk(r, 'details'));
  const sheet = r.sheetText();
  // Where it goes, first: your computer, straight to Anthropic; NeverQuestAlone gets nothing (CL-words-75).
  assert.deepEqual(r.document.querySelectorAll('#sheet-host .sheet-sec .label').map(l => l.textContent).slice(0, 2), ['Where it goes', 'At Anthropic']);
  // The picture is the first row of its card (the owner, 2026-10-03: organized, less cluttered).
  const flow = r.document.querySelector('#sheet-host .sheet-card .sheet-flow');
  assert.equal(flow.getAttribute('aria-label'), 'Your messages and game data go from your Mac straight to Anthropic. Nothing goes to NeverQuestAlone.');
  assert.match(r.document.querySelector('#sheet-host .sheet-card .sheet-row-off').textContent, /NeverQuestAloneGets nothing: no account, no tracking/);
  assert.doesNotMatch(sheet, /Option to keep nothing|sales team/, 'no keep-nothing options');
  assert.doesNotMatch(sheet, /What the app asks|Uncheck the Game Data box|Other players’ chat is never sent|Other companies’ policies/, 'nothing but what it keeps, whether it trains, and the policy');
  assert.doesNotMatch(sheet, /sends only your message/, 'game data goes with every message, so the row never says only your message does (CL-words-69)');
  assert.match(sheet, /Keeps your messages/, 'Trains on them has its noun');
  // On your screen, last (the trust plan, 2026-10-03): what screen reading reads, exactly, and what off means.
  assert.equal(r.document.querySelectorAll('#sheet-host .sheet-sec .label').map(l => l.textContent).pop(), 'On your screen');
  assert.match(sheet, /Reads only the top of WoW’s window\. Never keeps or sends pictures\./);
  assert.match(sheet, /When it’s off, your messages wait for a \/reload\. Replies still come in\./);
  assert.ok(r.byText('Open Anthropic’s data policy').length);
  assert.equal(r.byText('Open OpenAI’s data policy').length, 0, 'the others’ policies are gone');
  const DEV = /anthropic-workspace-id|top_p|store:false|data_collection|zdr:true|\/v1|safety_identifier|Covered Models|header/;
  assert.doesNotMatch(r.pageText() + sheet, DEV);
  const g = await pageRig({ state: { keys: { google: { masked: 'AIza…xxxx', state: 'ok' } }, choice: { provider: 'google', model: 'gemini-3.8-flash', effort: 'low' } }, hash: 'privacy' });
  await g.press(fk(g, 'details'));
  assert.match(g.sheetText(), /Until you set up billing, people at Google may read your messages\./);
  const o = await pageRig({ state: OPENAI, hash: 'privacy' });
  await o.press(fk(o, 'details'));
  assert.match(o.sheetText(), /OpenAI gets a random ID for this install/);
  const l = await pageRig({ state: CUSTOM_LOCAL, hash: 'privacy' });
  assert.match(l.pageText(), /Your messages stay on this Mac\./);
  assert.equal(l.document.querySelector('#sent-group .group-title').textContent, 'Sent with your messages', 'a model on this computer: nothing to name');
  assert.equal(l.document.querySelector('#never-group'), null);
  // Other off this computer: its service, by its host.
  const or = await pageRig({ state: { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' }, keys: { custom: { masked: 'sk-or-…m0ck', state: 'ok' } }, choice: { provider: 'custom', model: 'openai/gpt-5-mini', effort: null } }, hash: 'privacy' });
  assert.equal(or.document.querySelector('#sent-group .group-title').textContent, 'Sent to openrouter.ai with your messages');
  const none = await pageRig({ state: {}, hash: 'privacy' });
  assert.equal(none.document.querySelector('#sent-group .group-title').textContent, 'Sent with your messages', 'no AI yet');
});

test('CL-design-01: no page shows a class name as text (the "set-tall" under every privacy switch)', async () => {
  const pages = ['home', 'provider', 'privacy', 'connections', 'last-request', 'settings', 'memory', 'diagnostics', 'updates', 'about', 'uninstall'];
  for (const [state, list] of [[READY, pages], [OPENAI, ['provider', 'privacy']], [CUSTOM_LOCAL, ['provider', 'privacy']]]) {
    for (const hash of list) {
      const r = await pageRig({ state, hash });
      const classes = new Set();
      const texts = [];
      const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3) texts.push(c.data.trim()); else if (c.nodeType === 1) { String(c.className || '').split(/\s+/).forEach(x => x && classes.add(x)); walk(c); } } };
      walk(r.page());
      for (const t of texts) {
        assert.ok(!t || !classes.has(t), `${hash}: "${t}" is a class name`);
        assert.doesNotMatch(t || '', /\bset-[a-z]+\b/, `${hash}: a class name in "${t}"`);
      }
    }
  }
});

test('Show more (Settings), Diagnostics, About with its updates: what protects you and the pages behind it; ‹ Settings at the top (the app trim: no Memory page, no Updates page)', async () => {
  // Show more: chat history and Delete all on its row, Memory and Forget all on its row, Run setup again as a row,
  // and the three pages (CL-words-76, CL-design-59); no lines under them: labels and buttons say it.
  const m = await pageRig({ state: READY, hash: 'settings' });
  await m.press(fk(m, 'more'));
  assert.deepEqual(m.document.querySelectorAll('#more-box .set-key').map(e => e.textContent), ['Chat history', 'Memory', 'Replies in chat frame', 'Run setup again', 'Diagnostics', 'About', 'Uninstall']);
  assert.deepEqual(m.document.querySelectorAll('#more-box .set-sub').length, 0, 'no lines');
  assert.deepEqual(m.document.querySelectorAll('#history-row button').map(label), ['Delete all']);
  assert.ok(m.document.getElementById('history-row').contains(m.document.getElementById('retention-days')), 'the days kept, beside it');
  assert.equal(fk(m, 'delete-history').getAttribute('aria-label'), 'Delete all chat history', 'its name says what it deletes');
  assert.deepEqual(m.document.querySelectorAll('#memory-row button').map(label), ['Forget all']);
  assert.equal(m.document.getElementById('setup-row').getAttribute('data-fk'), 'run-setup', 'the row is the button');
  // Each deletion asks first (main's dialog, once) and says what happened under its own row.
  await m.press(fk(m, 'delete-history'));
  assert.ok(m.calls.some(c => c[0] === 'transcripts' && c[1] && c[1].deleteAll === true), 'asked for the deletion');
  assert.equal(m.confirms.at(-1).message, 'Delete all chat history?');
  assert.equal(m.document.querySelector('#history-row .set-line').textContent, 'Deleted.');
  const asked = m.confirms.length;
  await m.press(fk(m, 'forget-all'));
  assert.equal(m.confirms.length, asked + 1, 'one confirm for every character (CL-player-60)');
  assert.equal(m.confirms.at(-1).message, 'Forget what NeverQuestAlone remembers about all your characters?');
  assert.deepEqual(m.calls.filter(c => c[0] === 'forgetMemory').map(c => c[1]), ['Thokk-Testrealm', 'Brakka-Testrealm'], 'every character’s notes');
  assert.deepEqual(m.document.querySelectorAll('#memory-row .set-line').map(e => e.textContent), ['Forgotten.']);
  assert.equal(fk(m, 'forget-all'), null, 'nothing left to forget');
  assert.equal(active(m).getAttribute('data-fk'), 'more', 'focus goes to Show less, not the page’s top');
  const no = await pageRig({ state: READY, hash: 'settings', confirm: () => false });
  await no.press(fk(no, 'more'));
  await no.press(fk(no, 'delete-history'));
  assert.equal(no.document.querySelector('#history-row .set-line').textContent, 'Canceled. Nothing changed.', 'a no says so, and deletes nothing');
  await no.press(fk(no, 'forget-all'));
  assert.equal(no.calls.filter(c => c[0] === 'forgetMemory').length, 0, 'a no forgets nothing');
  assert.equal(no.document.querySelector('#memory-row .set-line').textContent, 'Canceled. Nothing changed.');
  const mem0 = await pageRig({ state: { ...READY, memoryChars: [] }, hash: 'settings' });
  await mem0.press(fk(mem0, 'more'));
  assert.equal(mem0.document.getElementById('memory-row'), null, 'no notes: no Memory row, nothing to forget');
  // Replies in chat frame (CL-words-73): the desktop's gate on the in-game echo, off by default, saved on change with
  // the other privacy values; the addon's words send the player here by this name.
  const echo = () => m.document.getElementById('sw-echo');
  assert.deepEqual([echo().getAttribute('role'), echo().getAttribute('aria-checked'), echo().getAttribute('aria-label')], ['switch', 'false', 'Replies in chat frame']);
  await m.press(echo());
  assert.equal(echo().getAttribute('aria-checked'), 'true');
  assert.equal((await m.api.privacy()).echo, true, 'privacy echo, as in 1.1.0');
  assert.equal(m.document.querySelector('#pv-echo .set-line').textContent, 'Saved.');
  assert.equal(active(m).id, 'sw-echo', 'focus stays on the switch');
  const tip = fs.readFileSync(path.join(HERE, '..', '..', 'addon', 'NeverQuestAlone', 'Settings.lua'), 'utf8');
  assert.ok(tip.includes('turn on Replies in chat frame under Settings, Show more.'), 'the game names this switch as the app does');
  // Diagnostics: one line about what the copy holds, the one button; no version, system or status rows.
  const d = await pageRig({ state: READY, hash: 'diagnostics' });
  assert.match(d.pageText(), /Leaves out keys and chats\. Nothing is uploaded\./);
  assert.equal(d.document.querySelector('#page [data-key="bundle"] p').textContent, 'Leaves out keys and chats. Nothing is uploaded.', 'the card says what its button copies (CL-design-62)');
  assert.equal(d.document.querySelector('#page .lead'), null);
  assert.doesNotMatch(d.pageText(), /Apple silicon|StatusRunning|Version/, 'the system and version stay in the copied bundle');
  assert.doesNotMatch(d.pageText(), /Electron|Chrome|Node/, 'the versions stay in the copied bundle');
  await d.click('Copy diagnostics');
  assert.match(d.pageText(), /Copied: .+, \d+ lines\. Paste it into your bug report\./);
  assert.equal(d.document.querySelector('#page pre.code'), null, 'what was copied is one click away (CL-words-37)');
  assert.doesNotMatch(d.pageText(), /Electron|Chrome|Node/, 'no versions on the page after a copy either');
  await d.press(fk(d, 'show-copied'));
  assert.equal(label(fk(d, 'show-copied')), 'Hide what was copied');
  assert.equal(d.document.querySelector('#page pre.code').getAttribute('tabindex'), '0', 'a long block takes focus so the keyboard can scroll it');
  // About, with the update line in it (Updates is no page of its own): its old name still leads here.
  const u = await pageRig({ state: READY, hash: 'updates' });
  assert.equal(titleText(u), 'About');
  assert.equal(u.document.querySelector('#page [data-key="updates"] .update-state').textContent, 'Updates aren’t set up in this version yet.', 'the idle updater of a development run');
  assert.equal(u.document.getElementById('sw-auto-updates'), null, 'no switch while updates are off (a development run)');
  const st = { mode: 'notify', configured: true, supported: true, notifyOnly: true, current: '0.1.0', state: 'available', available: { version: '0.2.0' }, progress: null, lastCheck: null, error: null };
  const modes = [];
  const updater = { status: () => ({ ...st }), check: async () => ({ ok: true }), download: async () => ({ ok: false }), setMode: m => { modes.push(m); return { ok: true }; }, installNow: () => ({ ok: false }) };
  const av = await pageRig({ state: READY, hash: 'updates', updater });
  assert.match(av.pageText(), /Version 0\.2\.0 is available\./);
  assert.ok(av.byText('Open download page').length);
  const sw = av.document.getElementById('sw-auto-updates');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.getAttribute('aria-checked'), 'true', 'automatic checks are on');
  assert.equal(av.document.getElementById('auto-updates-label').textContent, 'Update checks', 'it says what it checks (CL-words-79)');
  await av.press(sw);
  assert.deepEqual(modes, ['never'], 'one switch for the one setting (the monthly-reminder mode is no longer offered)');
  // Checks off (CL-words-79): the line says so, and the download page is one quiet click away; never a dead end.
  const off = { ...st, mode: 'never', state: 'idle', available: null };
  const co = await pageRig({ state: READY, hash: 'about', releases: 'https://github.com/bones-co/neverquestalone/releases', info: { releases: true }, updater: { ...updater, status: () => ({ ...off }) } });
  assert.equal(co.document.querySelector('#page [data-key="updates"] .update-state').textContent, 'Update checks are off.');
  assert.deepEqual(co.document.querySelectorAll('#page [data-key="updates"] .row button').map(b => [label(b), b.className]), [['Open download page', 'btn btn-quiet btn-sm']]);
  assert.equal(co.document.getElementById('sw-auto-updates').getAttribute('aria-checked'), 'false');
  await co.press(fk(co, 'open-download'));
  assert.deepEqual(co.opened, ['https://github.com/bones-co/neverquestalone/releases']);
  // An update already found stays said, checks off or not.
  const kept = await pageRig({ state: READY, hash: 'about', updater: { ...updater, status: () => ({ ...st, mode: 'never' }) } });
  assert.match(kept.pageText(), /Version 0\.2\.0 is available\./);
  const ab = await pageRig({ state: READY, hash: 'about' });
  assert.match(ab.pageText(), /NeverQuestAlone 0\.1\.0\./);
  assert.doesNotMatch(ab.pageText(), /intelligent quest companion|picks which quests/, 'no second pitch: the welcome and Home say what he does');
  assert.doesNotMatch(ab.pageText(), /not affiliated|an AI companion/, 'the legal text is one click away; NeverQuestAlone is never “an AI companion”');
  assert.ok(fk(ab, 'legal').querySelector('.ico-chevron'), 'an inline disclosure’s chevron, never the sheet’s info icon (CL-design-57)');
  await ab.press(fk(ab, 'legal'));
  assert.equal(fk(ab, 'legal').getAttribute('aria-expanded'), 'true');
  assert.match(ab.pageText(), /not affiliated with or endorsed by Blizzard Entertainment/);
  assert.match(ab.pageText(), /Inter and JetBrains Mono, under the SIL Open Font License\./, 'the bundled faces credited');
  // The carve-out travels with the art (systems critic OS-06): under the license, as in the addon's NOTICE.txt.
  assert.match(ab.document.querySelector('[data-key="license"]').textContent, /The license covers NeverQuestAlone’s code, not its name or its artwork: the skull logo, the icons and the pictures\.$/);
  assert.equal(ab.document.querySelector('#page pre.code').getAttribute('tabindex'), '0');
  for (const x of [d, u, ab]) assert.equal(label(fk(x, 'back')), 'Back');
  for (const f of ['OFL-Inter.txt', 'OFL-JetBrainsMono.txt', 'inter-400.woff2', 'inter-500.woff2', 'jetbrains-mono-500.woff2']) assert.ok(fs.existsSync(path.join(R, 'fonts', f)), f);
});

test('L3-5, D-23, D-29, D-31, D-37: loose AddOns permissions: a calm line after the install (Open Diagnostics); Diagnostics has Fix permissions and the command for an administrator, with the bridge’s explanation', async () => {
  const loose = { ok: false, fixable: true, fixed: [], paths: ['/Applications/World of Warcraft/_forever_/Interface/AddOns'], detail: 'Other accounts on this Mac can change /Applications/World of Warcraft/_forever_/Interface/AddOns, so they could run addon code in your game.' };
  let answer = false;
  const d = await pageRig({ state: { addonInstalled: true, permissions: loose }, hash: 'diagnostics', confirm: () => answer });
  assert.match(d.pageText(), /Addon folder permissions/);
  await d.click('Fix permissions');
  assert.equal(d.confirms[0].message, 'Fix the addon folder’s permissions?');
  assert.match(d.pageText(), /Canceled\. Nothing changed\./);
  answer = true;
  await d.click('Fix permissions');
  assert.ok(d.calls.some(c => c[0] === 'tightenAddonPermissions'), 'the permissions only');
  assert.equal(d.calls.some(c => c[0] === 'installAddon'), false, 'no reinstall');
  assert.match(d.pageText(), /Only your account can change the addon folder now\./);
  const adm = await pageRig({ state: { addonInstalled: true, permissions: { ...loose, fixable: false } }, hash: 'diagnostics' });
  assert.equal(adm.byText('Fix permissions').length, 0);
  await adm.click('Copy the command');
  assert.match(adm.pageText(), /Copied\. Give it to an administrator\./);
  // The command and why stay behind Show details, on every system (player-38).
  assert.equal(adm.document.querySelector('.copied pre.code'), null);
  assert.doesNotMatch(adm.pageText(), /Stops other accounts/);
  await adm.press(fk(adm, 'perm-details'));
  assert.equal(adm.document.querySelector('#perm-details-box pre.code').textContent, "sudo chmod go-w '/Applications/World of Warcraft/_forever_/Interface/AddOns'");
  assert.match(adm.pageText(), /Stops other accounts from changing these folders; nothing else changes\./);
  const winLoose = { ...loose, fixable: false, paths: ['C:\\WoW\\_forever_\\Interface\\AddOns'], detail: 'Every account on this PC can change the AddOns folder, so another account could run addon code in your game.' };
  const w = await pageRig({ state: { addonInstalled: true, permissions: winLoose }, hash: 'diagnostics', platform: 'win32' });
  assert.match(w.pageText(), /Other accounts can change your addons\. NeverQuestAlone works either way\./);
  assert.doesNotMatch(w.pageText(), /Optional\./, 'a sentence, never a fragment first (CL-words-53)');
  assert.doesNotMatch(w.pageText(), /has to fix it/, 'the detail is one click away');
  await w.press(fk(w, 'perm-details'));
  assert.match(w.pageText(), /An administrator of this PC has to fix it\./);
  await w.click('Copy the command');
  assert.equal(w.document.querySelector('.copied pre.code'), null, 'no SIDs inline (player-38)');
  assert.match(w.document.querySelector('#perm-details-box pre.code').textContent, /\*S-1-5-21-[\d-]+:\(OI\)\(CI\)M$/, 'this account keeps its access, by SID');
  assert.match(w.pageText(), /Stops other accounts from changing the AddOns folder; yours still can\./);
  const n = await pageRig({ state: { addonInstalled: true, noSid: true, permissions: winLoose }, hash: 'diagnostics', platform: 'win32' });
  assert.equal(n.byText('Copy the command').length, 0, 'no command');
  await n.press(fk(n, 'perm-details'));
  assert.match(n.pageText(), /Ask an administrator to remove write access for Users from this folder\./);
  const fine = await pageRig({ state: { addonInstalled: true }, hash: 'diagnostics' });
  assert.doesNotMatch(fine.pageText(), /Addon folder permissions/, 'nothing to say when the folder is fine');
});

test('UX-W44: in Diagnostics, Copy the command says only the copied line; the card was said when it first showed', async () => {
  const LOOSE = { ok: false, fixable: false, fixed: [], paths: ['/Applications/World of Warcraft/_forever_/Interface/AddOns'], detail: 'Other accounts on this Mac can change /Applications/World of Warcraft/_forever_/Interface/AddOns, so they could run addon code in your game.' };
  const r = await pageRig({ state: { keys: SAVED, choice: HAIKU, addonInstalled: true, permissions: LOOSE }, hash: 'diagnostics' });
  assert.equal(r.liveText().filter(t => /^Other accounts can change your addons\./.test(t)).length, 1, 'the card, once');
  const before = r.liveText();
  await r.click('Copy the command');
  assert.deepEqual(r.liveText(), [...before, 'Copied. Give it to an administrator.'].slice(-3), 'only the copied line is said');
});

test('Connections and Last request (spec §6.5, §6.6): one row per address (data) with a plain what-for in sentence case, a refused one says so in words; Last request readable first (what you asked, the game data as chips, sent to), the exact JSON one click away, key redacted, hostile text as text, scrolling inside itself; no Refresh, no sheet of other programs’ tools (the app trim)', async () => {
  const c = await pageRig({ state: { ...READY, blocked: [{ host: 'telemetry.example.com', port: 443, count: 2, first: Date.now() - 600e3, last: Date.now() - 60e3, feature: 'refused' }] }, hash: 'connections' });
  assert.equal(titleText(c), 'Connections');
  assert.match(c.pageText(), /Every address this app talked to\. Other programs aren’t listed\./, 'the one honest limit, in the lead (it was a sheet)');
  assert.equal(label(fk(c, 'back')), 'Back', '‹ Back to Your data (CL-design-27)');
  assert.equal(c.document.querySelector('#page [data-fk="details"]'), null, 'no Show details: no list of tools to download');
  assert.match(c.pageText(), /Google key test/, 'whose key a key test tried (player-20)');
  assert.match(c.pageText(), /Messages to Claude/, 'what the AI’s address is for (CL-words-58)');
  assert.doesNotMatch(c.pageText(), /today/, 'rows can be from other days');
  assert.ok(c.document.querySelectorAll('.host-sub').every(e => /^[A-Z]/.test(e.textContent)), 'what for, in sentence case');
  assert.equal(c.document.querySelector('#page [data-fk="refresh"]'), null, 'no Refresh: opening the page reads it');
  const hosts = c.document.querySelectorAll('.host');
  assert.ok(hosts.length >= 2);
  assert.ok(hosts.every(h => h.getAttribute('data-count') === 'data'), 'rows are data');
  const refused = hosts.find(h => h.textContent.includes('telemetry.example.com'));
  assert.equal(refused.querySelector('.chip').textContent, 'Blocked', 'what the app did, never read as phoning home (CL-player-65)');
  assert.equal(c.byText('Download LuLu').length, 0);
  const l = await pageRig({ state: READY, hash: 'last-request' });
  assert.equal(titleText(l), 'Last request');
  assert.equal(l.document.querySelector('#page [data-fk="refresh"]'), null, 'no Refresh');
  assert.equal(l.document.querySelector('#page pre.code'), null, 'the raw request is one click away');
  assert.equal(l.document.querySelector('#lr-asked .set-text').textContent, 'where do I turn in <img src=x onerror="alert(1)">?', 'what you asked, as text');
  assert.deepEqual(l.document.querySelectorAll('#lr-game .chip').map(e => e.textContent), ['Level 6 Tauren Warrior', 'Mulgore', '4 quests', 'Gear', 'Memory']);
  assert.match(l.document.getElementById('lr-to').textContent, /^Sent toAnthropic · Claude Haiku 4\.5 · /);
  assert.deepEqual(l.document.querySelectorAll('#page .set-key').map(e => e.textContent), ['You asked', 'Game data', 'Sent to'], 'three rows: no instructions row, no key row (the app trim)');
  await l.press(fk(l, 'raw-request'));
  assert.equal(fk(l, 'raw-request').getAttribute('aria-expanded'), 'true');
  assert.equal(label(fk(l, 'raw-request')), 'Hide raw request');
  const pre = l.document.querySelector('#page pre.code');
  assert.equal(pre.getAttribute('tabindex'), '0');
  assert.equal(pre.getAttribute('data-count'), 'data');
  assert.match(pre.textContent, /x-api-key/);
  assert.match(pre.textContent, /onerror=/, 'hostile text shown as text');
  assert.doesNotMatch(pre.textContent, /CANARY/);
  // The chat picker: a track named Chat (no visible label, CL-design-45), its options what the player did (CL-design-43, CL-words-41).
  assert.equal(l.document.getElementById('chat-label'), null);
  assert.equal(l.document.querySelector('[data-key="chat"] [role="radiogroup"]').getAttribute('aria-label'), 'Chat');
  assert.deepEqual(l.document.querySelectorAll('[data-key="chat"] [role="radio"]').map(b => b.textContent), ['Your question', 'Route update']);
  assert.equal(l.document.getElementById('lr-asked').className, 'set set-stack set-rec', 'each label over its value (CL-design-25), a record (CL-design-44)');
  await l.press(l.document.querySelectorAll('[data-key="chat"] [role="radio"]')[1]);
  assert.equal(l.document.querySelector('[data-key="chat"] [aria-checked="true"]').textContent, 'Route update', 'the route chat’s request, on a click');
});

test('D-06: no plumbing words on any page', async () => {
  const PLUMBING = /\b(?:bridge|gateway|slots?|strip|tokens?|egress|doorbell|VRAM|127\.0\.0\.1)\b/i;
  const r = await pageRig({ state: READY });
  for (const page of ['home', 'provider', 'usage', 'connections', 'last-request', 'settings', 'privacy', 'memory', 'diagnostics', 'updates', 'about', 'uninstall']) {
    await r.window.nqa.status(); // a no-op call between pages
    r.window.location.hash = `#${page}`;
    const x = await pageRig({ state: READY, hash: page });
    const text = x.pageText().replace(/\{[\s\S]*\}/, ''); // Last request's JSON is the exact request
    assert.doesNotMatch(text, PLUMBING, page);
    assert.doesNotMatch(text + x.statusText() + x.footText(), /⟦|\{[a-zA-Z]+\}|undefined/, page);
  }
});
test('D-16: zoom in, out and back with ⌘/Ctrl and = − 0, in half steps, remembered', async () => {
  const { zoomAction, nextZoom, cleanZoom, ZOOM_MIN, ZOOM_MAX } = await import('../../app/desktop/src/zoom.mjs');
  const key = (k, mods = {}) => ({ type: 'keyDown', key: k, ...mods });
  assert.equal(zoomAction(key('=', { meta: true }), 'darwin'), 'in');
  assert.equal(zoomAction(key('+', { meta: true, shift: true }), 'darwin'), 'in');
  assert.equal(zoomAction(key('-', { meta: true }), 'darwin'), 'out');
  assert.equal(zoomAction(key('0', { meta: true }), 'darwin'), 'reset');
  assert.equal(zoomAction(key('=', { control: true }), 'win32'), 'in');
  assert.equal(zoomAction(key('-', { control: true }), 'linux'), 'out');
  assert.equal(zoomAction(key('=', { control: true }), 'darwin'), null, 'Ctrl on a Mac isn’t the zoom key');
  assert.equal(zoomAction(key('=', { meta: true }), 'win32'), null);
  assert.equal(zoomAction(key('a', { meta: true }), 'darwin'), null);
  assert.equal(zoomAction({ ...key('=', { meta: true }), type: 'keyUp' }, 'darwin'), null);
  assert.equal(nextZoom(0, 'in'), 0.5);
  assert.equal(nextZoom(ZOOM_MAX, 'in'), ZOOM_MAX);
  assert.equal(nextZoom(ZOOM_MIN, 'out'), ZOOM_MIN);
  assert.equal(nextZoom(2, 'reset'), 0);
  assert.equal(cleanZoom('x'), 0);
  const main = code(read(path.join(APP, 'main.mjs')));
  assert.match(main, /before-input-event/);
  assert.match(main, /appState\?\.set\(\{ zoom: level \}\)/, 'remembered in app-state.json');
  assert.match(main, /setZoomLevel\(cleanZoom\(appState\?\.get\(\)\.zoom\)\)/, 'applied when the page loads');
});

test('D-18 and D-01: the uninstall ends in a dialog with Okay, never a timer; the tray shows an attention icon while a state needs the player', async () => {
  const main = code(read(path.join(APP, 'main.mjs')));
  const fn = /async function uninstallShell\(result\) \{([\s\S]*?)\n\}/.exec(main)[1];
  assert.doesNotMatch(fn, /setTimeout/);
  assert.match(fn, /buttons: \['Okay'\]/);
  assert.match(fn, /finishLine\(process\.platform\)/);
  assert.match(main, /tray\.setImage\(trayIcon\(attention\)\)/);
  for (const f of ['trayAttentionTemplate.png', 'trayAttentionTemplate@2x.png', 'tray-attention.png']) assert.ok(fs.existsSync(path.join(APP, 'assets', f)), f);
  const { needsPlayer, viewKey } = await import('../../app/desktop/src/status-text.mjs');
  const st = (rt, extra = {}) => ({ backend: { rt, provider: { name: 'Anthropic', keyState: 'ok' }, usage: { needs: null }, ...extra } });
  assert.equal(needsPlayer(st({ state: 'ready' })), false);
  assert.equal(needsPlayer(st({ state: 'paused' })), false);
  assert.equal(needsPlayer(st({ state: 'slowed', retryIn: 5 })), false);
  for (const s of ['no_key', 'key_invalid', 'out_of_credit', 'cap', 'provider_down', 'local_down']) assert.equal(needsPlayer(st({ state: s })), true, s);
  assert.equal(needsPlayer(st({ state: 'ready' }, { usage: { needs: 'near_cap' } })), true, 'near the cap');
  assert.equal(needsPlayer(st({ state: 'ready' }, { notice: { kind: 'model_retired', model: 'm' } })), true, 'a retired model');
  assert.equal(viewKey(st({ state: 'provider_down', reason: 'bridge_unavailable' })), 'not_running');
});

test('format and tray words (D-05, D-21): views of the bridge’s states, the player’s daily spend limit, locale dates', async () => {
  const F = loadFormat();
  const { statusView } = await import('../../bridge/byok/status-view.mjs');
  const s = (rt, b = {}) => { const x = { backend: { rt, ...b } }; return { ...x, view: statusView(x) }; };
  assert.equal(F.stateWords(s({ state: 'provider_down', reason: 'bridge_unavailable' })), 'Couldn’t start');
  assert.equal(F.stateWords(s({ state: 'key_invalid', reason: 'sign-in ended' })), 'Signed out');
  assert.equal(F.stateWords(s({ state: 'key_invalid' }, { provider: { keyState: 'expired' } })), 'Signed out');
  assert.equal(F.stateWords(s({ state: 'ready' }, { notice: { kind: 'model_retired', model: 'x' } })), 'Model retired');
  assert.equal(F.stateWords(s({ state: 'provider_down', reason: 'model_retired' })), 'Model retired');
  assert.equal(F.stateTone(s({ state: 'provider_down', reason: 'bridge_unavailable' })), 'bad');
  assert.equal(trayLine(s({ state: 'provider_down', reason: 'bridge_unavailable' }, { provider: { name: 'Anthropic', model: 'm' } })), 'Couldn’t start');
  assert.equal(F.dayCost({ dayUsd: [0.17, 0.37], at: 40 }), '$0.17–0.37');
  assert.equal(F.dayCost({ free: true }), '$0');
  assert.equal(F.dayCost(null), '');
  assert.equal(F.keyStoreLine('darwin'), 'Couldn’t save your key to your macOS Keychain. Unlock it, then try again.');
  assert.equal(F.keyStoreLine('darwin', true), 'Couldn’t read your key from your macOS Keychain. Unlock it, then try again.');
  assert.match(F.keyStoreLine('win32'), /Windows Credential Manager/);
  assert.match(F.keyStoreLine('linux', true), /read your key from the Secret Service/);
  const t = new Date(2026, 8, 26, 17, 5).getTime();
  assert.equal(F.timeText(t, 'en-US'), '5:05 PM');
  assert.equal(F.timeText(t, 'en-GB'), '17:05');
  // One date form (STYLE §8; UX-W40): short month and day, the year only when it isn't this year.
  const now = new Date(2026, 9, 1, 12).getTime();
  assert.match(F.dateTimeText(t, 'en-US', now), /^Sep 26, 5:05\sPM$/);
  assert.match(F.dateTimeText(new Date(2027, 0, 4, 14, 5).getTime(), 'en-US', now), /^Jan 4, 2027, 2:05\sPM$/);
  assert.equal(F.dayText('2026-09-26', 'en-US', now), 'Sep 26');
  assert.equal(F.dayText('2025-12-31', 'en-US', now), 'Dec 31, 2025');
  assert.match(F.whenText(new Date(2026, 9, 1, 9, 30).getTime(), 'en-US', now), /^9:30\sAM$/, 'today: the time alone');
  assert.match(F.whenText(t, 'en-US', now), /^Sep 26, 5:05\sPM$/, 'another day: with its date');
  assert.equal(F.dayText('nonsense'), 'nonsense');
  const shown = [];
  const n = createNotifier({ show: x => shown.push(x) });
  n.update({ backend: { rt: { state: 'cap', reason: 'cap_spend' }, provider: { name: 'Anthropic' }, usage: { capMicros: 2.5e6 } } });
  assert.equal(shown[0].title, 'You’ve reached your daily spend limit ($2.50).');
  assert.equal(shown[0].page, 'home', 'Home’s card has Raise limit');
  assert.equal(F.stateWords(s({ state: 'cap', reason: 'cap_spend' })), 'Daily spend limit reached', 'only ever the limit the player set');
  const quiet = [];
  createNotifier({ show: x => quiet.push(x) }).update({ backend: { rt: { state: 'cap' }, provider: { name: 'Anthropic' }, usage: {} } });
  assert.equal(quiet[0].title, 'You’ve reached your daily spend limit.', 'no amount to name: no made-up $1.00');
  n.update({ backend: { rt: { state: 'key_invalid', reason: 'sign-in ended' }, provider: { name: 'OpenRouter' } } });
  assert.equal(shown[1].title, 'Your OpenRouter sign-in ended.');
  assert.equal(shown[1].body, 'Sign in again in NeverQuestAlone.');
});

test('the Details sheet takes its clicks on a Mac: the top bar is the window\'s drag strip, so the sheet and its scrim opt out of it (the × closes, it never drags the window)', () => {
  const css = read(path.join(R, 'style.css'));
  assert.match(css, /\.topbar \{[^}]*-webkit-app-region: drag;/, 'the top bar is the drag strip');
  assert.match(css, /\.sheet-host > \* \{ -webkit-app-region: no-drag; \}/, 'everything in the sheet host opts out');
  // A no-drag region only cuts into the drag regions laid out before it.
  const html = read(path.join(R, 'index.html'));
  assert.ok(html.indexOf('id="sheet-host"') > html.indexOf('id="topbar"'), 'the sheet host comes after the top bar');
  // Belt and braces: while a sheet is open the top bar drags nothing at all.
  assert.match(css, /\.app\[data-sheet\] \.topbar \{ -webkit-app-region: no-drag; \}/, 'no drag strip under an open sheet');
});

test('the panel (the 1.3 refresh): the wordmark in the title strip; no gradient anywhere; the portrait and the foot take clicks inside the drag panel', () => {
  const css = read(path.join(R, 'style.css'));
  const html = read(path.join(R, 'index.html'));
  assert.doesNotMatch(css, /gradient\(/, 'no gradients: flat surfaces (the owner, 2026-10-02)');
  assert.doesNotMatch(read(path.join(R, 'img', 'route-map.svg')), /Gradient/, 'the welcome map is flat too');
  assert.ok(html.indexOf('id="bones-btn"') < html.indexOf('id="wordmark"') && html.indexOf('id="wordmark"') < html.indexOf('id="tracker"') && html.indexOf('id="wordmark"') < html.indexOf('id="nav"'), 'the wordmark sits under NeverQuestAlone, above the steps and the menu (the owner, 2026-10-03)');
  assert.ok(html.indexOf('id="side-foot"') > html.indexOf('id="nav"'), 'the foot is its last');
  assert.match(css, /\.companion > \.wordmark \{[^}]*display: grid; grid-template-columns: 16px 1fr; gap: 10px;[^}]*padding: 0 10px;/, 'a row of the menu, on the nav’s grid: the diamond in the icons’ column, the name on the labels’ line (the owner, 2026-10-03)');
  assert.match(css, /\.companion > \.wordmark \{[^}]*height: 32px; margin: 12px 0 0;[^}]*font: 500 14px\/20px var\(--sans\);/, 'a nav row’s height and type');
  assert.doesNotMatch(css, /\.companion > \.wordmark \{[^}]*(position: absolute|left: \d)/, 'never beside the lights again');
  assert.match(css, /\.companion button, \.companion a \{ -webkit-app-region: no-drag; \}/, 'the portrait button and the foot’s button take clicks and hover');
});

test('polish (the owner, 2026-10-02): the select’s caret sits in as far as its words, row actions share one edge, Back is the title row’s, the top bar holds nothing', async () => {
  const css = read(path.join(R, 'style.css'));
  // The caret is drawn: the system's sat on the right edge. Its stroke ends 12 px in, as the words start.
  assert.match(css, /\.select \{ height: 36px; padding: 0 32px 0 12px;/);
  assert.match(css, /\.select \{ -webkit-appearance: none; appearance: none; background-image: url\(icons\/caret-down\.svg\); background-repeat: no-repeat; background-position: right 8px center; background-size: 16px 16px; \}/);
  const caret = read(path.join(R, 'icons', 'caret-down.svg'));
  assert.match(caret, /stroke="#a8a49b"/, 'the caret is --muted: 3:1 and more on the field');
  // Delete all, beside the history menu, ends where Forget all and every switch end.
  assert.match(css, /\.set-control > \.btn-sm:last-child, \.set-control > \.row > \.btn-sm:last-child, \.set-rec \.row > \.btn-sm:last-child \{ margin-right: -8px; \}/);
  // Back: the same control as Show details, heading its title row; the top bar is a drag strip with nothing in it.
  assert.match(css, /\.title-row > \.btn-icon:last-child, \.say-head > \.btn-icon:last-child, \.title-row > \.btn-back, \.say-head > \.btn-back \{ color: var\(--text\); background: var\(--surface\); box-shadow: inset 0 0 0 1px var\(--line\); \}/);
  assert.doesNotMatch(css, /\.top-left|\.top-right/, 'no top bar groups left');
  // Round 2 (APP-D-36..38): step 3's say-head takes Back like a title row (Show details stays at its end),
  // the line under a title with Back starts where the title does, and the wordmark's baseline meets the title's.
  assert.match(css, /\.say-head \{ display: flex; align-items: flex-start; gap: 12px; \}/);
  // APP-D-39: every title on one line whatever its row holds (an icon box centres on it, Pause too).
  assert.match(css, /\.title-row \{ display: flex; align-items: flex-start; gap: 12px; \}\n\.title-row \.btn-ghost \{ margin-top: -1px; \}\n\.title-row > \.btn:not\(\.btn-ghost\) \{ margin-top: 2px; \}/);
  assert.match(css, /\.say-head \.btn-ghost \{ margin-top: -1px; \}/);
  // A short window keeps 16 px under the last card, so Your AI fits 760 × 540 without a scroll.
  assert.match(css, /@media \(max-height: 600px\) \{\n  :root \{ --portrait: 72px; \}\n[^\n]*\n  \.page \{ padding-bottom: 8px; \}/);
  assert.match(css, /\.title-row:has\(> \.btn-back\) \+ \.lead, \.say-head:has\(> \.btn-back\) \+ \.lead \{ padding-left: 46px; \}/);
  assert.match(css, /\.app\[data-os="darwin"\] \.nav, \.app\[data-os="darwin"\] \.tracker \{ margin-top: 6px; \}/, 'the menu starts 6 px under the wordmark');
  assert.doesNotMatch(css, /\.companion > \.wordmark \{ margin-top: 1[35]px; \}/, 'no baseline rule left from when it sat under the lights');
  assert.match(read(path.join(R, 'app.js')), /classList\.contains\('title-row'\) \|\| h1\.parentNode\.classList\.contains\('say-head'\)/);
  const r = await pageRig({ state: IN_GAME });
  await r.press(r.document.querySelector('[data-nav="privacy"]'));
  await r.press(fk(r, 'open-connections'));
  const back = fk(r, 'back');
  assert.equal(back.parentNode.className, 'title-row');
  assert.equal(back.parentNode.firstChild, back);
  assert.match(back.className, /\bbtn-back\b/);
  assert.equal(r.document.getElementById('topbar').childNodes.length, 0, 'the top bar holds no controls');
  await r.press(back);
  assert.equal(titleText(r), 'Your data');
  // The drag-region gate covers every control in every scene (screenshots, shot-probe.mjs).
  const probe = read(path.join(R, '..', 'src', 'shot-probe.mjs'));
  assert.match(probe, /document\.querySelectorAll\('button, a\[href\], select, input, textarea, summary, \[tabindex="0"\]'\)/);
  assert.doesNotMatch(probe, /if \(sheetOpen\) \{\n    const regions/);
});

test('the panel’s foot (the 1.3 refresh): the version, and the one small update action its state offers; About keeps the details', async () => {
  const stub = (st, extra = {}) => {
    const calls = [];
    let status = { supported: true, configured: true, mode: 'notify', state: 'idle', notifyOnly: false, available: null, progress: null, ...st };
    return {
      calls,
      updater: {
        status: () => status,
        check: async () => { calls.push('check'); status = { ...status, state: 'none' }; return { ok: true, status }; },
        download: async () => { calls.push('download'); status = { ...status, state: 'downloading', progress: 0 }; return { ok: true }; },
        installNow: () => { calls.push('install'); return { ok: true, installing: true }; },
        setMode: m => { status = { ...status, mode: m }; return { ok: true, status }; },
        scheduled: () => null,
        ...extra,
      },
    };
  };
  const foot = r => r.document.getElementById('side-foot');
  const btnIn = r => foot(r).querySelector('button');
  // A development run: the version alone.
  const dev = await pageRig({ state: IN_GAME });
  assert.equal(dev.footText(), 'v0.1.0');
  assert.equal(btnIn(dev), null);
  // An installed app: Check for updates; through the check it stays the same button (focus stays), then
  // Up to date, which no timer clears; the result is said in the live region.
  const a = stub({});
  const r = await pageRig({ state: IN_GAME, updater: a.updater });
  assert.equal(r.footText(), 'v0.1.0Check for updates');
  const b0 = btnIn(r);
  await r.press(b0);
  await r.settle();
  assert.deepEqual(a.calls, ['check']);
  assert.equal(r.footText(), 'v0.1.0Up to date');
  assert.equal(btnIn(r), b0, 'the same button: focus stays on it');
  assert.equal(btnIn(r).getAttribute('aria-disabled'), 'true');
  assert.ok(r.liveText().includes('NeverQuestAlone is up to date.'), r.liveText().join(' | '));
  // A check the app runs by itself never flickers the foot.
  r.subs.updates.forEach(cb => cb({ supported: true, configured: true, mode: 'notify', state: 'checking' }));
  await r.settle();
  assert.equal(r.footText(), 'v0.1.0Up to date');
  // An update found: Download v<version> (gold), which downloads.
  const b = stub({ state: 'available', available: { version: '0.2.0' } });
  const r2 = await pageRig({ state: IN_GAME, updater: b.updater });
  assert.equal(btnIn(r2).textContent, 'Download v0.2.0');
  assert.match(btnIn(r2).getAttribute('class'), /foot-accent/);
  await r2.press(btnIn(r2));
  assert.deepEqual(b.calls, ['download']);
  // Downloaded, WoW closed: Restart to update installs it (its confirm says the same words).
  const c = stub({ state: 'ready', available: { version: '0.2.0' } });
  const r3 = await pageRig({ state: READY, updater: c.updater });
  assert.equal(btnIn(r3).textContent, 'Restart to update');
  await r3.press(btnIn(r3));
  assert.deepEqual(c.calls, ['install']);
  assert.deepEqual([r3.confirms[0].message, r3.confirms[0].okLabel], ['Restart NeverQuestAlone to update to 0.2.0?', 'Restart to update']);
  // Downloaded while WoW runs: Update ready, a note (it won't install while the game runs).
  const c2 = stub({ state: 'ready', available: { version: '0.2.0' } });
  const r5 = await pageRig({ state: IN_GAME, updater: c2.updater });
  assert.equal(r5.footText(), 'v0.1.0Update ready');
  assert.equal(btnIn(r5), null);
  // Checks off: the version alone, never a check.
  const d = stub({ mode: 'never' });
  const r4 = await pageRig({ state: IN_GAME, updater: d.updater, releases: 'https://github.com/tommygeoco/neverquestalone/releases' });
  assert.equal(r4.footText(), 'v0.1.0');
  // About has the details: the foot shows the version alone there.
  await r.press(r.document.querySelector('[data-nav="settings"]'));
  await r.press(fk(r, 'more'));
  await r.press(fk(r, 'open-about'));
  assert.equal(titleText(r), 'About');
  assert.equal(r.footText(), 'v0.1.0');
  // Setup: the version and Finish later, where Check for updates sits after it (the owner, 2026-10-02);
  // an update found during setup waits for its end.
  const s = await pageRig({ onboarded: false, updater: stub({}).updater });
  assert.equal(s.footText(), 'v0.1.0Finish later');
  const s2 = await pageRig({ onboarded: false, updater: stub({ state: 'available', available: { version: '0.2.0' } }).updater });
  assert.equal(s2.footText(), 'v0.1.0Finish later');
});

test('the tokens (spec §2, SHARED-TOKENS): dark only; text and muted pass AA on every surface, control edges 3:1, the focus ring 3:1; --faint is never text; only the bundled faces at 400 and 500, never faux bold', () => {
  const css = read(path.join(R, 'style.css'));
  assert.doesNotMatch(css, /prefers-color-scheme|data-theme/, 'one theme: dark');
  assert.match(css, /color-scheme: dark;/);
  const t = Object.fromEntries([.../:root \{([\s\S]*?)\n\}/.exec(css)[1].matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
  // The landing's shared tokens win: the window, the text, the one accent.
  assert.equal(t.bg, '#0f0e12');
  assert.equal(t.surface, '#16151a');
  assert.equal(t.raised, '#211f26');
  // Depth in order (CL-design-15): sunk < the stage < the panel < a surface < raised.
  const L = hex => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0);
  assert.ok(L(t.sunk) < L(t.bg) && L(t.bg) < L(t.side) && L(t.side) < L(t.surface) && L(t.surface) < L(t.raised), 'sunk < stage < panel < surface < raised');
  assert.equal(t.accent, '#e3a458');
  assert.equal(t.focus, '#7aa7ff');
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const surface of ['bg', 'side', 'surface', 'raised', 'sunk']) {
    for (const fg of ['text', 'muted', 'accent', 'ok', 'warn', 'bad']) assert.ok(ratio(t[fg], t[surface]) >= 4.5, `--${fg} on --${surface}: ${ratio(t[fg], t[surface]).toFixed(2)}`);
    assert.ok(ratio(t['line-strong'], t[surface]) >= 3, `--line-strong on --${surface}`);
    assert.ok(ratio(t.focus, t[surface]) >= 3, `--focus on --${surface}`);
  }
  assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, 'the primary’s words on gold');
  assert.doesNotMatch(css, /color:\s*var\(--faint\)/, '--faint is decoration only');
  // No gradients in the app (the owner, 2026-10-02): the welcome's map is flat colours too (CL-design-63).
  assert.doesNotMatch(read(path.join(R, 'img', 'route-map.svg')), /Gradient|url\(#(?!frame\))/);
  const weights = [...css.matchAll(/font-weight:\s*(\d+)|font:\s*(\d{3})\s/g)].map(m => Number(m[1] || m[2]));
  // 400 and 500 everywhere; 600 only where the face is the Mac's SF (it has a real Semibold), the wordmark.
  assert.deepEqual([...new Set(weights)].sort(), [400, 500, 600], 'the bundled faces’ weights, and SF’s Semibold');
  assert.deepEqual([...css.matchAll(/([^{}\n]+)\{[^}]*font-weight:\s*600/g)].map(m => m[1].trim()), ['.app[data-os="darwin"] .companion > .wordmark'], '600 only on a Mac, on the wordmark');
  // Inter's tuning (its alternates, its tightened titles) applies only where Inter is the face (APP-D-43).
  assert.match(css, /font-feature-settings: normal;\n\}\n[^\n]*\n\.app:not\(\[data-os="darwin"\]\) \{ font-feature-settings: "cv11", "ss01"; \}/);
  assert.match(css, /\.app:not\(\[data-os="darwin"\]\) h1 \{ letter-spacing: -0\.022em; \}/);
  assert.match(css, /font-synthesis: none;/, 'never faux bold');
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \*, \*::before, \*::after \{ transition: none !important; animation: none !important; \}/);
  // Hover tints a colour, never moves, resizes or reveals anything. The one exception is the owner's
  // (2026-10-02): NeverQuestAlone's state in a word beside his portrait, an overlay that moves nothing else.
  const tip = css.split('}').filter(r => /:hover/.test(r.split('{')[0]) && /\.status-tip\b/.test(r.split('{')[0]));
  assert.deepEqual(tip.map(r => r.split('{')[0].trim()), ['.bones-btn:hover .status-tip, .bones-btn:focus-visible .status-tip'], 'the one hover reveal, keyboard focus too');
  assert.doesNotMatch(tip[0].split('{')[1], /\b(transform|width|height|margin|padding|display|top|left|right|bottom)\s*:/, 'it only fades in');
  assert.match(css, /\.status-tip \{[^}]*position: absolute;[^}]*pointer-events: none;/, 'an overlay: it takes no room and no clicks');
  for (const rule of css.split('}').filter(r => /:hover/.test(r.split('{')[0]) && !/\.status-tip\b/.test(r.split('{')[0]))) {
    const body = rule.split('{')[1] || '';
    assert.doesNotMatch(body, /\b(transform|width|height|margin|padding|display|visibility|opacity|top|left|right|bottom|border-width|font-size)\s*:/, rule.trim().split('{')[0]);
  }
});

test('SY-04: the Windows setup step promises no yellow border (the Desktop Duplication helper draws none)', () => {
  const src = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(src, /yellow border/i);
});

test('clarity r4: a rejected key reads Rejected with one Replace key; a model on this computer that is down has one Check again; the couldn’t-start banner says its cause and is setup’s one primary; Game data off says what it costs; a repeated failure says what to try', async () => {
  // A test that rejects the key (CL-player-42): the chip turns Rejected, and the banner leaves Replace key to the row.
  const r = await pageRig({ state: { ...READY, rt: { state: 'key_invalid' }, results: { testKey: { ok: false, error: 'auth_invalid', headline: 'x', detail: 'y', action: 'replace_key' } } }, hash: 'provider' });
  await r.press(fk(r, 'now-test'));
  assert.equal(r.document.querySelector('#key-row .chip').textContent, 'Rejected');
  assert.equal(r.byText('Replace key').length, 1, 'one Replace key on the page');
  assert.equal(banner(r), null, 'no banner: the chip and the one Replace key say it');
  // A model on this computer that is down (CL-words-45): the banner owns Check again.
  const loc = await pageRig({ state: { ...CUSTOM_LOCAL, rt: { state: 'local_down' } }, hash: 'provider' });
  assert.equal(loc.byText('Check again').length, 1, 'one Check again');
  assert.equal(label(fk(loc, 'now-test')), 'Check again', 'the page’s own: there is no banner to own it any more (the app trim)');
  assert.match(loc.pageText(), /Runs on this computer/);
  // The couldn't-start banner over setup (CL-words-29): its cause, and its button the one primary.
  const s = await pageRig({ onboarded: false, apiMode: 'error', apiReason: 'the bridge failed to start: Another copy of NeverQuestAlone is already running for this World of Warcraft (pid 4242). Quit it first.' });
  assert.match(s.bannerText(), /^Another copy’s open\./);
  assert.deepEqual(primaries(s).map(label), ['Quit this copy']);
  const u = await pageRig({ onboarded: false, apiMode: 'error', apiReason: 'x' });
  assert.match(u.bannerText(), /NeverQuestAlone couldn’t start\./, 'the headline when the cause is unknown');
  assert.equal(primaries(u).length, 1);
  // Game data off (CL-player-46): what the player loses, in one line.
  const pv = await pageRig({ state: READY, hash: 'privacy' });
  await pv.press(pv.document.getElementById('sw-gameContext'));
  assert.match(pv.document.getElementById('pv-gameContext').textContent, /Off: no route or quest picks\./);
  // Twice in a row (CL-words-51): what to try.
  const two = await pageRig({ state: { ...READY, lastError: { kind: 'bad_request', at: 6, streak: 2 } } });
  assert.equal(alert(two).querySelector('.alert-sub').textContent, 'Try asking another way.');
});

// The copy lint for the app trim (the owner: "a tiny bit simpler, a little too verbose"): the window's table stays
// short. A card, a key result, a toggle's line, a Home line and a notice each have a ceiling, the long texts live
// only where a click opens them, and what the trim removed doesn't come back by name.
test('the app trim: the window’s words stay short, and the trimmed ones stay gone', () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read(path.join(R, 'strings.js')), ctx);
  const leaves = [];
  (function walk(o, p) {
    for (const [k, v] of Object.entries(o)) {
      const at = p ? `${p}.${k}` : k;
      if (typeof v === 'string') leaves.push([at, v]);
      else if (v && typeof v === 'object') {
        if ('one' in v && 'other' in v && Object.keys(v).length === 2) { leaves.push([`${at}.one`, v.one], [`${at}.other`, v.other]); } else walk(v, at);
      }
    }
  })(ctx.window.BonesStrings, '');
  const words = t => t.replace(/\{[^}]+\}/g, 'x').split(/\s+/).filter(Boolean).length;
  const over = (re, max) => leaves.filter(([k, v]) => re.test(k) && words(v) > max).map(([k, v]) => `${k} (${words(v)} words, over ${max}): ${v}`);
  assert.deepEqual([
    ...over(/^homeCard\..*\.headline$/, 8), ...over(/^homeCard\..*\.detail/, 8), // a card: a headline and one line
    ...over(/^ai\.result\./, 10), ...over(/^custom\..*\.headline$/, 10), // an error: a headline or one line, the action is its button
    ...over(/^pages\.privacy\..*Hint$/, 7), ...over(/^settings\..*Line$/, 8), // a toggle: a label and at most one short line
    ...over(/^home\./, 6), ...over(/^finishLater\./, 7), ...over(/^notices\./, 11), ...over(/^done\./, 10),
    // Everything else the window says outside a click stays under 20 words; the sheets, the legal text and the key store's lines are the long ones.
    ...leaves.filter(([k, v]) => !/^(details|providers|flow|errors|common\.keyStore|pages\.about)\./.test(k) && !/^sayHi\.permission\.noReadingLine$/.test(k) && words(v) > 19).map(([k, v]) => `${k} (${words(v)} words): ${v}`),
  ], []);
  // What the trim removed stays removed: no proofs, example chip, reply counts, quote or flourish, saved-keys page,
  // usage tables, memory page, updates page, text size or screen-reading row in the table (the chat-frame echo came
  // back: the desktop still gates it, CL-words-73).
  const gone = /(^home\.(proof|exampleChip|routeAlt|repliesLine))|(^done\.(quote|signature|flourish))|(^yourAi\.(keysTitle|keyRowName|noKeyLine|thinkingMoreLine|connectionTitle))|(^usage\.(spendTitle|timeCol|modelCol|costCol|dayCol|spentCol|messagesCol|checkInsCol|companyCol|repliesEmptyLine|daysEmptyLine))|(^pages\.memory\.)|(^settings\.(textSize|screen|generalTitle|gameTitle|helpTitle|updatesLabel))|(^pages\.updates\.(title|lead|versionLabel|checksTitle|neverName|neverHint|lastCheckLabel))|(^pages\.about\.broughtBody)|(^notices\.(oneOffLine|readyAgainLine|updatesOff))/;
  assert.deepEqual(leaves.filter(([k]) => gone.test(k)).map(([k]) => k), []);
});

test('the owner, 2026-10-03: SF Pro on a Mac with Inter after it; Your data, in detail as cards of rows', async () => {
  const css = read(path.join(R, 'style.css'));
  // The Mac's own face first (SF Pro: Text small, Display at title sizes), the bundled Inter for the rest.
  assert.match(css, /--sans: -apple-system, BlinkMacSystemFont, "NQA Sans", "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif;/);
  assert.doesNotMatch(css, /SF-Pro|SFPro|sf-pro.*\.woff/i, 'never bundled: Apple’s licence keeps it on Apple’s systems');
  // The sheet: Where it goes and At <company>, each one card of rows; the policy is the card's last row.
  const r = await pageRig({ state: READY });
  await r.press(r.document.querySelector('[data-nav="privacy"]'));
  await r.press(fk(r, 'details'));
  const sheet = r.document.getElementById('sheet-host');
  const cards = sheet.querySelectorAll('.sheet-card');
  assert.equal(cards.length, 3, 'two cards of where it goes and what the company keeps, then On your screen (the trust plan)');
  const rows = c => c.querySelectorAll('.sheet-row');
  assert.equal(rows(cards[0]).length, 3, 'the picture, what each message carries, what NeverQuestAlone gets');
  assert.equal(rows(cards[2]).length, 2, 'On your screen: what screen reading reads, and what off means');
  assert.match(rows(cards[0])[0].className, /\bsheet-flow\b/);
  assert.match(rows(cards[0])[0].getAttribute('aria-label'), /Anthropic/);
  assert.equal(rows(cards[0])[1].textContent, 'In each message: your question, level, zone, quests and gear.');
  assert.equal(rows(cards[0])[2].textContent, 'NeverQuestAloneGets nothing: no account, no tracking');
  const at = rows(cards[1]);
  assert.equal(at[0].querySelector('.sheet-row-key').textContent, 'Keeps your messages');
  assert.equal(at[1].querySelector('.sheet-row-key').textContent, 'Trains on them');
  const policy = at[at.length - 1];
  assert.equal(policy.tagName, 'BUTTON');
  assert.equal(policy.getAttribute('data-fk'), 'data-policy');
  assert.match(policy.textContent, /^Open Anthropic’s data policy$/);
  assert.equal(sheet.querySelectorAll('.kv').length, 0, 'no two-column table left in it');
});
