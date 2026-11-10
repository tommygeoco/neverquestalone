// NeverQuestAlone's desktop shell (BYOK PRD §11.2 DB10, §11.5 DB12, §16,
// PF-2, PF-4, SC-3, SC-9, KY-8, OB-1..OB-4; BUILD-PLAN "Desktop app").
//
// One process: main builds the bridge in-process through bridge/byok/boot.mjs
// (key store, config, egress guard, createBridge + createLocalBackend, capture,
// createAppApi), imported only from inside app.asar when packaged
// (src/api-loader.mjs), or, in a development run, the mock when asked, with a tray
// (status, Open, Pause, Quit) and one settings window made on demand. The tray
// and the window follow the bridge's status pushes (api.onChange). The Dock
// icon shows only while the window is open (LSUIElement). The window is
// hardened: context isolation, the sandbox, no Node, no remote content, served
// from the app's own privileged scheme (nqa://app/, src/scheme.mjs; never
// file:, whose extra-privileges fuse is off), a CSP with no inline script, no
// spellchecker, no new windows, no navigation. What Chromium may request is the
// app's page and, while update checks are on, the update feed; nothing else
// (src/net-guard.mjs). Every IPC call is schema-checked, and the risky ones
// need a native confirm (ipc.mjs).
//
// --self-test boots the real bridge from inside the app in a sandbox (no
// capture, no WoW, a memory key store), opens the window hidden on it and checks
// the page came from the app's scheme, the preload API answers, that the page is
// isolated, that IPC refuses bad input, and that the scheme and the guard refuse
// what they must; prints one JSON line and quits through the real quit (< 20 s;
// its lines on stdout, SY-102-2; --no-relaunch: as Quit and reopen does, with
// app.relaunch skipped). --screenshots
// <dir> (development runs) writes a PNG of every window state
// (src/screenshots.mjs). Neither the screenshot mode nor the mock API it drives
// is in the package (electron-builder.yml): both are imported only in an
// unpackaged run (systems plan Batch 5, SY-09).
//
// Hardware acceleration is off: the settings page is static text, and with GPU
// compositing its GPU process held about 520 MB beside the game (57 MB without;
// systems plan Batch 5, SY-11).
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, dialog, ipcMain, protocol, session, shell, clipboard, Notification, powerMonitor, crashReporter } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// First of the app's own modules (SR-05): the environment and the command line are checked before any
// other loads (src/launch-guard.mjs).
import { NET_ENV, LOADER_FOUND } from './src/launch-guard.mjs';
import { createIpc, registerIpc, createKeyStager, STATUS_CHANNEL, NAVIGATE_CHANNEL, storeName, finishLine, MAC_PANES, st } from './ipc.mjs';
import { STRINGS } from './src/strings.mjs';
import { createShellLedger, installShellGuard, UPDATER_PARTITION, guardNetworkEnv, refuseLine, EXTRA_CA_ENV, loaderVariable } from './src/net-guard.mjs';
import { SCHEME, CSP, schemePrivileges, createSchemeHandler, isAppPage, pageUrl, PAGE_URL } from './src/scheme.mjs';
import { loadApi, createLiveApi, bridgeRoots, wrapApi, captureHelperPaths, ownTeamId } from './src/api-loader.mjs';
import { addonToUpdate } from './src/addon-autoupdate.mjs';
import { captureGate, GATE_MS } from './src/capture-gate.mjs';
import { createQuitFlow } from './src/quit.mjs';
import { createLoginItem } from './src/login-item.mjs';
import { uninstallTargets, removeTargets, readCaptureBundleId, tccBundleIds } from './src/uninstall.mjs';
import { createAppState } from './src/app-state.mjs';
import { collectNotices } from './src/notices.mjs';
import { withNotice } from './src/model-notice.mjs';
import { trayLine, createNotifier, needsPlayer } from './src/status-text.mjs';
import { zoomAction, nextZoom, cleanZoom } from './src/zoom.mjs';
import { redactDeep, redactText, secretSet } from './src/redact.mjs';
import { startUpdater, idleUpdater, releasesUrl } from './updater.mjs';
import { IDENTITY } from './src/identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(HERE, 'renderer');
// The app's identity (src/identity.mjs): its app id and update feed.
const APP_ID = IDENTITY.appId;
const SELF_TEST = process.argv.includes('--self-test');
// --self-test --show-window: the window is shown (inactive: it takes no focus) for SHOW_WINDOW_MS, then
// closed, still in the sandbox, so the footprint of a shown window and of the tray after it closes
// can be sampled from outside (systems critic SY-11; a normal launch would reach the real keychain).
// --show-window-ms=<n> holds it up to 2 minutes, so a person or a click tool can use the packaged
// window by hand in the sandbox (a real click on the Details sheet's ×, which synthetic events can't
// prove: they never meet the title bar's drag region); 'window-idle' says the checks are done.
const SHOW_WINDOW = SELF_TEST && process.argv.includes('--show-window');
const SHOW_WINDOW_MS = (() => {
  const n = Number((process.argv.find(a => a.startsWith('--show-window-ms=')) ?? '').slice('--show-window-ms='.length) || NaN);
  return Number.isInteger(n) && n >= 0 && n <= 120_000 ? n : 5000;
})();
const AFTER_CLOSE_MS = 3000;
// --self-test --no-relaunch (systems critic SY-102-2): the self-test's quit goes as Quit and reopen's
// does (relaunch(), then app.quit()), with a second launch during it (SY-102-3), and app.relaunch is
// skipped (a line says so), so no copy starts; the checks are only the window on the real bridge.
const NO_RELAUNCH = SELF_TEST && process.argv.includes('--no-relaunch');
// --screenshots <dir> or --screenshots=<dir>; the folder is read with src/screenshots.mjs in start().
const SHOTS = process.argv.some(a => a === '--screenshots' || a.startsWith('--screenshots='));
let SHOTS_DIR = null;
let shotsKit = null; // src/screenshots.mjs, development runs only
const HEADLESS = SELF_TEST || SHOTS; // a hidden window, temp data, no tray menu of its own, nothing opened
const IS_MAC = process.platform === 'darwin';
const UPDATES_CHANNEL = 'nqa:updates';

// Crash output never carries the environment (§8.4 item 6).
if (process.report) { try { process.report.excludeEnv = true; } catch {} }

// The launch was checked before any other of the app's modules loaded (src/launch-guard.mjs, the
// first imported): a packaged app started with a switch its launchers don't pass has already exited
// 1, the loader variables and NODE_TLS_REJECT_UNAUTHORIZED are gone, and NET_ENV says whether the
// environment stops the start (start(), before the bridge boots).

// The app's own scheme, before ready (Electron's rule): standard and secure, nothing more.
protocol.registerSchemesAsPrivileged(schemePrivileges());

// ---------------------------------------------------------------------------
// Log: redacted, a ring for diagnostics, a file for packaged runs.

const logRing = [];
let logFile = null;
// Keys no line may carry whatever their shape: the staged ones (logSecrets.from, once the key
// stager exists) and every one the bridge registered (bridgeLogger forwards to log.addSecret).
const logSecrets = secretSet();
function log(line) {
  logLine(redactText(String(line), { extra: logSecrets.list() }));
}
// Code health BR-21: every line was redacted again here (the bridge's three times on the way) and
// written with existsSync, statSync and appendFileSync on the main thread. A line is redacted once
// (log.scrub, the same set; the bridge's arrive redacted, through log.write) and shell.log is appended
// from a buffer, asynchronously, LOG_FLUSH_MS after its first line or once LOG_FLUSH_BYTES wait, the
// size kept as it goes (rotated past 1 MB to shell.log.1, as before). A crash's lines (uncaught,
// unhandled) and whatever waits when the process exits are written at once, synchronously.
const LOG_FLUSH_MS = 250;
const LOG_FLUSH_BYTES = 64 * 1024;
const LOG_ROTATE_BYTES = 1024 * 1024;
const logFlush = { queue: [], bytes: 0, timer: null, writing: false, file: null, size: null };
function logLine(redacted) {
  const text = `${new Date().toISOString()} ${redacted}`;
  logRing.push(text);
  if (logRing.length > 200) logRing.shift();
  if (!app.isPackaged && !HEADLESS) console.log(text);
  if (!logFile) return;
  logFlush.queue.push(`${text}\n`);
  logFlush.bytes += text.length + 1;
  if (logFlush.bytes >= LOG_FLUSH_BYTES) flushLog();
  else if (!logFlush.timer) { logFlush.timer = setTimeout(flushLog, LOG_FLUSH_MS); logFlush.timer.unref?.(); }
}
// What waits, taken off the queue for the file it's for (none: dropped, as after an uninstall).
function logChunk() {
  clearTimeout(logFlush.timer);
  logFlush.timer = null;
  const chunk = logFlush.queue.join('');
  logFlush.queue = [];
  logFlush.bytes = 0;
  if (!logFile || !chunk) return null;
  if (logFlush.file !== logFile) { logFlush.file = logFile; logFlush.size = null; }
  return chunk;
}
function flushLog() {
  if (logFlush.writing) return; // its end flushes what came meanwhile
  const chunk = logChunk();
  if (!chunk) return;
  const file = logFlush.file;
  logFlush.writing = true;
  (async () => {
    try {
      if (logFlush.size === null) logFlush.size = await fs.promises.stat(file).then(st => st.size, () => 0);
      if (logFlush.size > LOG_ROTATE_BYTES) { await fs.promises.rename(file, `${file}.1`).catch(() => {}); logFlush.size = 0; }
      await fs.promises.appendFile(file, chunk, { mode: 0o600 });
      logFlush.size += Buffer.byteLength(chunk);
    } catch {} finally {
      logFlush.writing = false;
      if (logFlush.queue.length) flushLog();
    }
  })();
}
function flushLogSync() {
  const chunk = logChunk();
  if (!chunk) return;
  try {
    if (logFlush.size === null) logFlush.size = fs.existsSync(logFlush.file) ? fs.statSync(logFlush.file).size : 0;
    if (logFlush.size > LOG_ROTATE_BYTES) { fs.renameSync(logFlush.file, `${logFlush.file}.1`); logFlush.size = 0; }
    fs.appendFileSync(logFlush.file, chunk, { mode: 0o600 });
    logFlush.size += Buffer.byteLength(chunk);
  } catch {}
}
log.addSecret = s => logSecrets.add(s);
log.scrub = s => redactText(String(s ?? ''), { extra: logSecrets.list() });
log.write = logLine; // a line already redacted with log.scrub (the bridge's, bridgeLogger)
// A crash's line goes now, unless a write is on its way (whose end takes it, in order).
process.on('uncaughtException', (e) => { log(`uncaught: ${e?.stack ?? e}`); if (!logFlush.writing) flushLogSync(); });
process.on('unhandledRejection', (e) => { log(`unhandled: ${e?.stack ?? e}`); if (!logFlush.writing) flushLogSync(); });
process.on('exit', flushLogSync);

// ---------------------------------------------------------------------------
// Before ready: one instance, every renderer sandboxed, self-test data in a temp folder.

let selfTestDir = null;
if (HEADLESS) {
  selfTestDir = fs.mkdtempSync(path.join(os.tmpdir(), SHOTS ? 'nqa-shots-' : 'nqa-self-test-'));
  app.setPath('userData', selfTestDir);
}
// The self-test's crash dumps (code-health AP-02: a self-test's quit on windows-latest ended in an
// access violation, 0xC0000005, about 1 run in 36, and left nothing to read). Electron's crash
// reporter, never uploading, writes them to a temp folder of their own: the sandbox goes in the
// quit's last step, and that crash came after it. CI keeps the folder when windows-smoke fails.
// Never in a normal launch, nor with --show-window (scripts/footprint.mjs measures a player's
// processes, and the reporter adds one).
let crashDumps = null;
if (SELF_TEST && !SHOW_WINDOW) {
  try {
    crashDumps = path.join(os.tmpdir(), 'nqa-self-test-crashes');
    app.setPath('crashDumps', crashDumps);
    crashReporter.start({ uploadToServer: false });
  } catch { crashDumps = null; }
}
const PRIMARY = HEADLESS || app.requestSingleInstanceLock();
app.enableSandbox();
app.disableHardwareAcceleration();
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let api = null;
let live = null; // the real bridge's holder (src/api-loader.mjs createLiveApi): never a stopped boot
let mock = null; // the screenshot mode's controllable mock
let loaded = { mode: 'none', reason: null };
let win = null;
let tray = null;
let lastStatus = null;
let paused = false;
let appState = null;
let updater = null;
let keys = null;
let ledger = null;
let notices = null;
let removeDataOnQuit = false;
const schemeLog = { served: 0, refused: [] };
const loginItem = createLoginItem({ app, packaged: app.isPackaged });

const hiddenLaunch = () => process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin);

// ---------------------------------------------------------------------------
// The window.

function isTrustedSender(event) {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  return isAppPage(frame.url);
}

function openWindow(page) {
  // A committed quit opens nothing (src/quit.mjs): a second launch or a Dock click while the bridge stops.
  if (quit.committed()) return null;
  if (win && !win.isDestroyed()) {
    if (page) win.webContents.send(NAVIGATE_CHANNEL, page);
    if (!HEADLESS) { win.show(); win.focus(); }
    return win;
  }
  if (IS_MAC && app.dock && !HEADLESS) app.dock.show();
  win = new BrowserWindow({
    // The page gets 1000×720 (and at least 760×540), the size every screen is designed and measured
    // at (onboarding spec §2 rule 6, the screenshots, the critics' probes); the title bar is outside
    // it. Without useContentSize the title bar came out of those sizes: 1000×688 on macOS, so S1, S2
    // and S4 states that fit the measured 1000×720 scrolled in the real window (DU-05, DU-12).
    useContentSize: true,
    width: 1000,
    height: 720,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: 'NeverQuestAlone',
    // Dark only, like a game launcher (the redesign's spec §1): the stage's colour behind the page.
    backgroundColor: '#0f0e12',
    autoHideMenuBar: true,
    // macOS: the traffic lights over Bones's panel, which is the window's drag area up top.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 } } : {}),
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: !app.isPackaged && !HEADLESS,
    },
  });
  if (!IS_MAC) win.setMenu(null);
  // Right-click on a field offers the edit roles, so the paste-only key field can be pasted into.
  win.webContents.on('context-menu', (_e, p) => {
    if (p.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut', enabled: p.editFlags.canCut },
        { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      ]).popup({ window: win });
    } else if (p.selectionText) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup({ window: win });
    }
  });
  // Zoom (D-16): ⌘/Ctrl with =, − and 0, at the level the player left it last time.
  win.webContents.on('before-input-event', (e, input) => {
    const action = zoomAction(input, process.platform);
    if (!action) return;
    e.preventDefault();
    zoomWindow(action);
  });
  win.webContents.on('did-finish-load', () => { try { win?.webContents.setZoomLevel(cleanZoom(appState?.get().zoom)); } catch {} });
  win.loadURL(pageUrl(page));
  win.once('ready-to-show', () => { if (!HEADLESS) win?.show(); else if (SHOW_WINDOW) win?.showInactive(); });
  win.on('closed', () => {
    win = null;
    keys?.clear();
    if (IS_MAC && app.dock && !HEADLESS) app.dock.hide();
  });
  return win;
}

/** Zoom the window in, out or back to 100%, and remember it (src/zoom.mjs, app-state.json). */
function zoomWindow(action) {
  const level = nextZoom(appState?.get().zoom ?? 0, action);
  appState?.set({ zoom: level });
  if (win && !win.isDestroyed()) win.webContents.setZoomLevel(level);
  return level;
}

/** The status the window sees: a model notice already put away is left out (src/model-notice.mjs). */
const forWindow = s => withNotice(s, appState?.noticesSeen() ?? []);

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, redactDeep(data, { extra: keys?.secrets() ?? [] }));
}

// ---------------------------------------------------------------------------
// Native confirms, links, login item, uninstall.

let shotsConfirm = null; // the screenshot mode answers confirms itself
async function confirmNative(spec) {
  if (SHOTS) return shotsConfirm ? shotsConfirm(spec) : true;
  if (SELF_TEST) return false;
  const opts = {
    type: spec.destructive ? 'warning' : 'question',
    buttons: [String(spec.okLabel || 'Okay'), String(spec.cancelLabel || 'Cancel')],
    defaultId: spec.destructive ? 1 : 0,
    cancelId: 1,
    noLink: true,
    normalizeAccessKeys: false,
    title: 'NeverQuestAlone',
    message: String(spec.message ?? ''),
    detail: String(spec.detail ?? ''),
  };
  const parent = win && !win.isDestroyed() ? win : null;
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return r.response === 0;
}

async function openLinkUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'bad_link' }; }
  if (u.protocol !== 'https:' && !MAC_PANES.includes(url)) return { ok: false, error: 'bad_link' };
  if (HEADLESS) return { ok: true };
  await shell.openExternal(u.href);
  return { ok: true };
}

// Sign in with a plan (ChatGPT; bridge/byok/signin): the bridge hands its sign-in page here, and only
// that page opens, in the player's own browser (never in a window of ours). The bridge checked it
// too (isAuthorizeUrl): the company's https origin, its authorize path, our callback on 127.0.0.1.
const SIGN_IN_PAGES = Object.freeze(['https://auth.openai.com/oauth/authorize']);
async function openSignInPage(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('bad_link'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || !SIGN_IN_PAGES.includes(u.origin + u.pathname)) throw new Error('bad_link');
  if (HEADLESS) return;
  await shell.openExternal(u.href);
}

// The login item: macOS and Windows through Electron (src/login-item.mjs);
// unsupported elsewhere (Linux runs from source only) and in dev runs.
function getLoginItem() { return loginItem.get(); }
function setLoginItem(open) { return loginItem.set(open); }

// Uninstall (OB-3): after the bridge's own uninstall, the login item and, on
// macOS, the Screen Recording entries of the app and of the capture helper
// (its bundle id from the packaged app's bridge/capture/mac/BUNDLE_ID, NeverQuestAlone's own; never a checkout's helper, src/uninstall.mjs);
// the data, logs and update caches go in will-quit (src/uninstall.mjs).
// The last instruction (drag the app to the Trash, …) is in the confirm and in a final dialog
// that stays until Okay (D-18); the app quits after it, never on a timer.
async function uninstallShell(result) {
  if (app.isPackaged) {
    try { loginItem.set(false); } catch {}
    if (IS_MAC) {
      const fromFile = readCaptureBundleId(bridgeRoots(HERE, { packaged: app.isPackaged }));
      for (const id of tccBundleIds({ fromBridge: result?.tccBundleIds, fromFile })) {
        execFile('/usr/bin/tccutil', ['reset', 'ScreenCapture', id], () => {});
      }
    }
  }
  removeDataOnQuit = true;
  const finish = finishLine(process.platform);
  if (!HEADLESS) {
    const opts = { type: 'info', buttons: ['Okay'], defaultId: 0, noLink: true, title: 'NeverQuestAlone', message: 'NeverQuestAlone is uninstalled.', detail: `${finish}\nNeverQuestAlone quits when you click Okay.` };
    try { await (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)); } catch {}
  }
  setImmediate(() => app.quit());
  return { ...(result ?? {}), ok: true, quitting: true, finish };
}

/**
 * Open Battle.net (Start WoW and log in): the app bundle on macOS, the launcher on Windows (then
 * this window goes to the tray, so it doesn't cover WoW's corner, T7). Nothing in a headless run.
 */
async function openGame() {
  const where = await api?.launcher?.().catch(() => null);
  if (HEADLESS) return { ok: true };
  if (!where?.found || typeof where.path !== 'string') return { ok: false, error: 'not_found' };
  const err = await shell.openPath(where.path);
  if (err) return { ok: false, error: 'failed' };
  if (process.platform === 'win32' && win && !win.isDestroyed()) win.hide();
  return { ok: true };
}
/** Move to Applications (macOS): Electron moves it and relaunches from there. */
function moveToApplications() {
  if (HEADLESS || !IS_MAC || !app.isPackaged) return { ok: false, error: 'dev_build' };
  try { return { ok: !!app.moveToApplicationsFolder() }; } catch {
    // Both lines name {os:Applications}: st() puts the Mac's own label in each.
    return { ok: false, error: 'move_failed', headline: st('moveToApplications.failed.headline'), detail: st('moveToApplications.failed.detail') };
  }
}
/** The one notification Continue on Check your defaults posts (macOS asks then), silent. */
function notifyOnce(n) {
  if (HEADLESS || !Notification.isSupported()) return;
  try { new Notification({ title: n.title, body: n.body, silent: true }).show(); } catch { /* macOS asks at the first real one */ }
}

/** "Choose folder…" (D-09): a native folder dialog; the bridge checks what was picked. */
let shotsFolder = null; // the screenshot mode's answer
async function pickFolder() {
  if (HEADLESS) return shotsFolder;
  const opts = { title: 'Choose the World of Warcraft folder', buttonLabel: 'Choose', properties: ['openDirectory', 'dontAddToRecent'] };
  const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths?.[0] ?? null);
}

/** "Quit this copy" on the not-running card while another copy runs (words-29). */
function quitApp() {
  if (HEADLESS) return { ok: true };
  setImmediate(() => app.quit());
  return { ok: true };
}

/** "Quit and reopen" on the not-running card (D-05): one relaunch (the quit flow's), then the quit. */
function relaunch() {
  if (HEADLESS && !NO_RELAUNCH) return { ok: true };
  quit.relaunchOnce();
  setImmediate(() => app.quit());
  return { ok: true };
}
/**
 * Electron's relaunch, with this launch's arguments but --hidden: a relaunch the player asked for (Quit and
 * reopen, a launch during the quit) opens the window.
 */
function relaunchApp() {
  app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--hidden') });
}
/**
 * A second launch (second-instance) or macOS's reopen (activate): the window; while a quit is
 * committed, the quit takes it and the app comes back after the exit (src/quit.mjs reopen, SY-102-3).
 */
function launchedAgain() {
  if (quit.reopen()) return;
  openWindow();
}

let apiModeShown = null; // the screenshot mode shows the real app's banners, not "Demo data"
let platformShown = null; // the screenshot mode's Windows scenes
let infoShown = null; // the screenshot mode's setup facts (osRelease, inApplications, appleSilicon, workPc, loginItem)
let updaterShown = null; // the screenshot mode's installed-app updater (About's update line and switch), or null: the idle one
let shotsClipboard = ''; // the screenshot mode's clipboard (Paste key reads it; never the real one)
/** Apple silicon or Intel (setup's local-model lead): sysctl, once. */
let appleSiliconCache;
function appleSilicon() {
  if (!IS_MAC) return null;
  if (appleSiliconCache === undefined) {
    try { appleSiliconCache = process.arch === 'arm64' || String(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 2000 })).trim() === '1'; } catch { appleSiliconCache = process.arch === 'arm64'; }
  }
  return appleSiliconCache;
}
function appInfo() {
  let license = '';
  for (const p of [path.join(HERE, 'LICENSE'), path.join(HERE, '..', '..', 'LICENSE')]) {
    try { license = fs.readFileSync(p, 'utf8'); break; } catch {}
  }
  return {
    name: 'NeverQuestAlone',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: platformShown ?? process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    apiMode: apiModeShown ?? loaded.mode,
    apiReason: apiModeShown === 'error' ? 'the bridge failed to start: Another copy of NeverQuestAlone is already running for this World of Warcraft (pid 4242). Quit it first.' : loaded.reason,
    store: storeName(process.platform),
    loginItem: getLoginItem(),
    releases: releasesUrl(IDENTITY) != null,
    license,
    // Setup (onboarding spec §3.2, §3.6, §3.8): where the app runs from, the OS release (the
    // Screen Recording pane's name), the chip, a work PC's roaming profile.
    inApplications: IS_MAC && app.isPackaged ? safe(() => app.isInApplicationsFolder(), null) : null,
    osRelease: os.release(),
    appleSilicon: appleSilicon(),
    workPc: process.platform === 'win32' && !!process.env.USERDNSDOMAIN,
    ...(infoShown ?? {}),
  };
}
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

// ---------------------------------------------------------------------------
// Tray (PF-2): status, Open, Pause, Quit.

// Two icons: the plain skull, and the attention one (a dot) while a state needs the player (D-01).
const trayIcons = {};
function trayIcon(attention) {
  const name = IS_MAC ? (attention ? 'trayAttentionTemplate.png' : 'trayTemplate.png') : (attention ? 'tray-attention.png' : 'tray.png');
  if (!trayIcons[name]) {
    const icon = nativeImage.createFromPath(path.join(HERE, 'assets', name));
    if (IS_MAC) icon.setTemplateImage(true);
    trayIcons[name] = icon;
  }
  return trayIcons[name];
}
let trayAttention = false;

function createTray() {
  trayAttention = needsPlayer(lastStatus);
  tray = new Tray(trayIcon(trayAttention));
  if (!IS_MAC) tray.on('click', () => openWindow());
  refreshTray();
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const attention = needsPlayer(lastStatus);
  if (attention !== trayAttention) {
    trayAttention = attention;
    tray.setImage(trayIcon(attention));
  }
  // Until setup is done, the line tells the setup story and the first item finishes it (onboarding
  // spec §3.11; UX-W25); every word is main's table's (src/strings.mjs tray).
  const onboarded = !!appState?.get().onboarded;
  const line = trayLine(lastStatus, { setup: !onboarded });
  tray.setToolTip(STRINGS.tray.tooltip.replace('{line}', line));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: line, enabled: false },
    { type: 'separator' },
    onboarded ? { label: STRINGS.tray.openAppLabel, click: () => openWindow() } : { label: STRINGS.tray.finishSetupLabel, click: () => openWindow('setup') },
    { label: STRINGS.tray.pauseLabel, type: 'checkbox', checked: paused, click: item => togglePause(item.checked) },
    { type: 'separator' },
    { label: STRINGS.tray.quitLabel, click: () => app.quit() },
  ]));
}

async function togglePause(on) {
  const r = await api.setPaused(on).catch(() => ({ ok: false }));
  paused = r?.ok === false ? !on : on;
  refreshTray();
}

/** A status push (api.onChange, debounced by the bridge): the tray, notifications and the window follow. */
const addonTried = new Set(); // the folders this session already updated (src/addon-autoupdate.mjs)
function onStatus(s) {
  lastStatus = s;
  // The app's own addon updates itself when it's older than the one this app ships (2026-10-05).
  const upd = HEADLESS ? null : addonToUpdate(s?.setup?.addon, appState?.get().addonConsent, addonTried);
  if (upd && api && typeof api.armInstall === 'function') { addonTried.add(upd); Promise.resolve(api.armInstall({ flavorDir: upd })).catch(() => {}); }
  // Setup ends on the first real reply (onboarding spec §3.9): written here, whatever the window does.
  if ((s?.setup?.firstReplyAt || s?.setup?.game?.hello) && appState && !appState.get().onboarded) { appState.set({ onboarded: true }); refreshTray(); }
  paused = !!(s?.bridge?.paused ?? s?.backend?.rt?.state === 'paused');
  refreshTray();
  notifier?.update(s);
  send(STATUS_CHANNEL, forWindow(s));
}

let notifier = null;
/** Desktop notifications (ER-5) are one setting, for bridge states and updates alike. */
const notificationsOn = () => appState?.get().notifications !== false;
function showNotice(n) {
  if (HEADLESS || !Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, silent: true });
  note.on('click', () => openWindow(n.page));
  note.show();
}

// ---------------------------------------------------------------------------
// Start.

async function start() {
  if (SHOTS) {
    // A packaged app refuses --screenshots without loading anything (the module isn't in it).
    if (!app.isPackaged) {
      shotsKit = await import('./src/screenshots.mjs');
      SHOTS_DIR = shotsKit.screenshotsDir(process.argv);
    }
    const ok = shotsKit ? shotsKit.screenshotsAllowed({ packaged: false, dir: SHOTS_DIR }) : { ok: false, reason: '--screenshots is for development runs; a packaged app refuses it' };
    if (!ok.ok) {
      process.stderr.write(`${ok.reason}\n`);
      try { fs.rmSync(selfTestDir, { recursive: true, force: true }); } catch {}
      app.exit(2);
      return;
    }
  }
  await app.whenReady();
  // One theme, dark (the redesign's spec §1): the window, its native dialogs and menus.
  nativeTheme.themeSource = 'dark';
  if (IS_MAC && app.dock) app.dock.hide();
  if (!HEADLESS) logFile = path.join(app.getPath('logs'), 'shell.log');
  log(`NeverQuestAlone ${app.getVersion()} starting (Electron ${process.versions.electron}, Node ${process.versions.node})`);
  const removedEnv = [...LOADER_FOUND.removed, ...NET_ENV.removed];
  if (removedEnv.length) log(`removed from the environment: ${removedEnv.join(', ')}`);
  // An environment proxy stops the start before the bridge boots: its line in the log, on stderr, and
  // in a native error box (the self-test's line instead, under --self-test).
  if (NET_ENV.refuse) {
    const line = refuseLine(NET_ENV.refuse);
    log(line);
    try { fs.writeSync(2, `${line}\n`); } catch {}
    if (HEADLESS) {
      try { fs.writeSync(1, `${JSON.stringify({ selfTest: 'neverquestalone', ok: false, error: 'env_proxy', variable: NET_ENV.refuse })}\n`); } catch {}
      try { fs.rmSync(selfTestDir, { recursive: true, force: true }); } catch {}
    } else {
      dialog.showErrorBox('NeverQuestAlone', line);
    }
    app.exit(1);
    return;
  }

  // The settings page, from the renderer folder only (SC-3): nqa://app/<file>.
  protocol.handle(SCHEME, createSchemeHandler({
    root: RENDERER_DIR,
    onServe: v => {
      if (v.status === 200) { schemeLog.served += 1; return; }
      if (schemeLog.refused.length < 20) schemeLog.refused.push(v.status);
      log(`the app scheme refused a request (${v.status} ${v.why})`);
    },
  }));

  // Nothing but the app's page and, while checks are on, the update feed (SC-9, KY-7).
  ledger = createShellLedger();
  const sessions = [session.defaultSession, session.fromPartition(UPDATER_PARTITION, { cache: false })];
  installShellGuard(sessions, {
    ledger,
    allowUpdates: () => { const s = updater?.status?.(); return !!s && s.supported === true && s.mode === 'notify'; },
    allowDevtools: !app.isPackaged && !HEADLESS,
    onBlocked: v => log(`refused a request to ${v.scheme ?? '?'}://${v.host ?? ''} (${v.kind})`),
  });
  for (const ses of sessions) {
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setSpellCheckerEnabled(false);
  }
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', e => e.preventDefault());
    wc.on('will-frame-navigate', e => { if (!e.isMainFrame) e.preventDefault(); });
    wc.on('will-redirect', e => e.preventDefault());
    wc.on('will-attach-webview', e => e.preventDefault());
  });
  // The View menu names the zoom keys; the window's own key handler does the zooming (D-16).
  const viewMenu = {
    label: 'View',
    submenu: [
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => zoomWindow('reset') },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => zoomWindow('in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => zoomWindow('out') },
    ],
  };
  Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, viewMenu, { role: 'windowMenu' }]) : null);

  appState = createAppState(app.getPath('userData'));
  keys = createKeyStager();
  logSecrets.from(() => keys.secrets());
  const userData = app.getPath('userData');
  const paths = {
    userData, state: path.join(userData, 'bridge'), logs: app.getPath('logs'), appDir: HERE, resources: process.resourcesPath, version: app.getVersion(),
    // Capture (fork PRD §9.10): boot launches the capture helper once there's a WoW folder with the
    // addon: a packaged app's is in Resources; the Mac one is signed by this app's own team.
    ...captureHelperPaths({ packaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath }),
    captureTeamId: ownTeamId({ packaged: app.isPackaged, platform: process.platform }),
  };
  const apiLine = l => log(`app API: ${l.mode}${l.reason ? ` (${l.reason})` : ''}`);
  if (SHOTS) {
    const { createMockApi } = await import('./src/mock-api.mjs');
    mock = createMockApi({ controllable: true, delayMs: 0 });
    api = wrapApi(mock);
    loaded = { mode: 'mock', reason: 'screenshots' };
    apiLine(loaded);
  } else {
    // The self-test runs on the real bridge, in its sandbox (src/api-loader.mjs selfTestBootOptions).
    // The holder serves one boot at a time and never a stopped one (fix-102): a boot stopped while
    // no quit is committed starts again at once, and the window's mode and reason follow each boot.
    live = createLiveApi({
      boot: () => loadApi({ appDir: HERE, packaged: app.isPackaged, paths, log, selfTest: SELF_TEST, openExternal: openSignInPage }),
      log: holderLog,
      onBoot: (l) => { loaded = l; apiLine(l); },
    });
    await live.start();
    api = SELF_TEST ? withHostileRequest(live.api) : live.api;
  }

  // Desktop notifications (ER-5): bridge states and update notices alike go
  // through the notifier, so one setting turns them all off and combat holds them.
  notifier = createNotifier({ show: showNotice, enabled: notificationsOn });

  const prefs = appState.updatesPrefs();
  const savePrefs = p => appState.saveUpdatesPrefs(p);
  updater = HEADLESS || !app.isPackaged
    ? idleUpdater({ identity: IDENTITY, prefs, savePrefs, current: app.getVersion(), packaged: app.isPackaged })
    : await startUpdater({
      app, identity: IDENTITY, prefs, savePrefs, log, onChange: s => send(UPDATES_CHANNEL, s), notify: n => notifier.notify(n),
      // Automatic updates install only while the game is closed and the window is shut.
      idle: async () => {
        if (win && !win.isDestroyed() && win.isVisible()) return false;
        if (!api || typeof api.wowRunning !== 'function') return false;
        try { return (await api.wowRunning())?.running === false; } catch { return false; }
      },
      beforeInstall: () => appState.saveUpdatesPrefs({ relaunchHidden: true }),
    });

  // The screenshot mode's About scenes show an installed app's updater (up to date, available, ready,
  // checks off): its status is the scene's, and nothing is fetched (the window never sees the difference).
  const ipcUpdater = !SHOTS ? updater : {
    ...updater,
    status: () => (updaterShown ? { ...updaterShown, remind: false } : updater.status()),
    check: async () => (updaterShown ? { ok: true, status: { ...updaterShown, remind: false } } : updater.check()),
    setMode: mode => {
      if (!updaterShown) return updater.setMode(mode);
      updaterShown.mode = mode;
      return { ok: true, status: { ...updaterShown, remind: false } };
    },
  };
  const ipc = createIpc({
    api, keys, ledger, updater: ipcUpdater, appState,
    platform: process.platform,
    confirm: confirmNative,
    links: { open: openLinkUrl },
    // readText: Paste key's one read, and the check that a saved key is still there before it's
    // cleared (PRD §8.1, SY-18; onboarding spec §3.4.2). The screenshot mode has its own clipboard.
    clipboard: { writeText: t => { if (SHOTS) shotsClipboard = String(t); else if (!HEADLESS) clipboard.writeText(String(t)); }, readText: async () => (SHOTS ? shotsClipboard : HEADLESS ? '' : clipboard.readText()) },
    isFocused: () => SHOTS || (!!win && !win.isDestroyed() && win.isFocused()),
    loginItem: { set: setLoginItem, get: getLoginItem },
    notify: notifyOnce,
    openGame,
    moveToApplications,
    info: appInfo,
    notices: () => (notices ??= collectNotices(HERE)),
    companion: () => lastStatus?.backend?.provider?.companion ?? 'NeverQuestAlone',
    releasesUrl: () => releasesUrl(IDENTITY),
    onPaused: p => { paused = p; refreshTray(); },
    onNoticeSeen: () => { if (lastStatus) send(STATUS_CHANNEL, forWindow(lastStatus)); },
    // The player agreed in a key's or the sign-in's dialog: the page may say "Checking with …" now (DU-03).
    onAgreed: (call, provider) => send('nqa:agreed', { call, provider: provider ?? null }),
    uninstallShell,
    pickFolder,
    relaunch,
    quitApp,
    shellLog: () => logRing.slice(-50),
    log,
  });
  registerIpc(ipcMain, ipc, { isTrustedSender });

  api.onChange(onStatus);
  try { onStatus(await api.status()); } catch {}
  if (!SHOTS) createTray();
  if (!HEADLESS) {
    // Back from System Settings: check Screen Recording at once while it isn't on (onboarding spec §3.8).
    app.on('browser-window-focus', () => {
      const perm = lastStatus?.setup?.permission;
      if (IS_MAC && perm && perm !== 'granted' && perm !== 'n/a' && lastStatus?.setup?.captureState !== 'off') api.screenPermission?.({ fresh: true }).catch(() => {});
    });
    // A held key is gone at lock and sleep (onboarding spec §3.11).
    for (const ev of ['lock-screen', 'suspend']) powerMonitor.on(ev, () => keys?.clear());
  }

  app.on('second-instance', launchedAgain);
  app.on('activate', launchedAgain);
  // The screenshot mode's driver is src/screenshots.mjs's (code health AP-15), on main's window, app
  // state and mock; what a scene shows main's confirm, folder dialog, appInfo, updater and clipboard
  // comes back through show.
  if (SHOTS) {
    return shotsKit.screenshots({
      outDir: SHOTS_DIR, argv: process.argv, app, nativeTheme, openWindow, appState, mock, log, selfTestDir,
      roots: bridgeRoots(HERE, { packaged: app.isPackaged }),
      show: {
        confirm: (fn) => { shotsConfirm = fn; },
        folder: (dir) => { shotsFolder = dir; },
        apiMode: (mode) => { apiModeShown = mode; },
        platform: (p) => { platformShown = p; },
        info: (facts) => { infoShown = facts; },
        updater: (status) => { updaterShown = status; },
        clipboard: (text) => { shotsClipboard = text; },
      },
    });
  }
  if (SELF_TEST) return selfTest();
  // A launch that isn't hidden always opens the window: at setup until it's done, then at home
  // (onboarding spec §3.11; a reinstall that kept its data isn't stranded in the tray).
  // A quiet automatic update (updater.mjs) relaunches with no window, once.
  const afterQuietUpdate = appState.get().updates?.relaunchHidden === true;
  if (afterQuietUpdate) appState.saveUpdatesPrefs({ relaunchHidden: false });
  if (!hiddenLaunch() && !afterQuietUpdate) openWindow(appState.get().onboarded ? null : 'setup');
}

app.on('window-all-closed', () => { /* the app lives in the tray */ });

// Quitting (fix-102, src/quit.mjs): before-quit is only a request, and the bridge stops only once
// the quit is committed (will-quit: every window closed), then the app exits. The bridge used to
// stop at the request, and a quit that didn't finish left the window on a stopped bridge whose
// guard refused every key test. shell.log says quit-requested, quit-committed and quit-stalled.
/**
 * The quit flow's log: shell.log, and in a self-test stdout too, one JSON line each
 * ({"selfTestQuit": line}; scripts/self-test.mjs checks them, SY-102-2).
 */
function quitLog(line) {
  log(line);
  if (SELF_TEST) process.stdout.write(`${JSON.stringify({ selfTestQuit: redactText(String(line), { extra: logSecrets.list() }) })}\n`);
}
const quit = createQuitFlow({
  app,
  log: quitLog,
  relaunch: NO_RELAUNCH ? () => quitLog('relaunch: skipped (--no-relaunch)') : relaunchApp,
  // An update downloaded installs at this quit: its installer replaces the app, so a launch during
  // the quit doesn't relaunch the old one.
  canRelaunch: () => updater?.status?.()?.state !== 'ready',
  onCommit: () => {
    live?.commit(); // the holder boots nothing again from here on
    try { tray?.destroy(); } catch {}
    tray = null;
    // The self-test's relaunch run (SY-102-2): a second launch while this quit is committed (SY-102-3).
    if (NO_RELAUNCH) setImmediate(() => app.emit('second-instance', { preventDefault() {} }, [], process.cwd(), {}));
  },
  stop: () => api?.stop?.(),
  beforeExit: () => {
    if (!removeDataOnQuit) return;
    if (HEADLESS) {
      try { fs.rmSync(selfTestDir, { recursive: true, force: true }); } catch {}
      return;
    }
    logFile = null; // nothing may write shell.log back after its folder is gone
    removeTargets(uninstallTargets({ platform: process.platform, userData: app.getPath('userData'), logs: app.getPath('logs') }));
  },
  // Still running after exit: nothing comes back (no bridge, no tray). Electron's exit only ends
  // slowly on a busy PC, and the bridge it rebooted here ran in a dying process (quit-race).
});
/**
 * The holder's log: shell.log; in a self-test, its lines about the bridge starting again or staying
 * stopped go to stdout with the quit's, and scripts/self-test.mjs fails a start after the commit.
 */
function holderLog(line) {
  if (SELF_TEST && /^the bridge (starts again|stays stopped)/.test(String(line))) quitLog(line);
  else log(line);
}

// ---------------------------------------------------------------------------
// --self-test

/**
 * The self-test's one stand-in: the last request carries markup, so the check that the page shows
 * data as text (never as elements) runs on the real bridge too; its sandbox hasn't sent anything.
 */
function withHostileRequest(real) {
  return {
    ...real,
    lastRequest: async () => ({
      chats: [{ id: 'c3f9a1e', title: 'NeverQuestAlone' }], chatId: 'c3f9a1e', at: Date.now() - 60e3, provider: 'anthropic', model: 'claude-haiku-4-5',
      request: {
        method: 'POST', url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': 'sk-ant-…A1b2 (redacted)', 'content-type': 'application/json' },
        body: { model: 'claude-haiku-4-5', max_tokens: 1200, stream: true, messages: [{ role: 'user', content: 'where do I turn in <img src=x onerror="alert(1)">?' }] },
      },
    }),
  };
}

/** 'blocked' when the guard cancelled it, else the HTTP status, else the error's text. */
async function probe(ses, url) {
  try {
    const r = await ses.fetch(url);
    return r.status;
  } catch (e) {
    const m = String(e?.message ?? e);
    return /BLOCKED_BY_CLIENT/i.test(m) ? 'blocked' : m.slice(0, 120);
  }
}

/** --show-window: a line for whoever samples the footprint from outside, at each phase. */
function phase(name) {
  if (SHOW_WINDOW) process.stdout.write(`${JSON.stringify({ selfTestPhase: name, at: Date.now() })}\n`);
}

async function selfTest() {
  const t0 = Date.now();
  const result = {
    selfTest: 'neverquestalone',
    ok: false,
    run: NO_RELAUNCH ? 'relaunch' : 'full',
    api: loaded.mode,
    packaged: app.isPackaged,
    versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    crashDumps,
    checks: {},
  };
  let done = false;
  const finish = extra => {
    if (done) return;
    done = true;
    Object.assign(result, extra, { elapsedMs: Date.now() - t0 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok) return quitPhase();
    try { fs.rmSync(selfTestDir, { recursive: true, force: true }); } catch {}
    app.exit(1);
  };
  // A packaged Mac run's full self-test also launches its capture helper (captureGate, BR-01).
  const gateMs = IS_MAC && app.isPackaged && !NO_RELAUNCH ? GATE_MS : 0;
  setTimeout(() => finish({ ok: false, error: 'timeout' }), (SHOW_WINDOW ? 20_000 + SHOW_WINDOW_MS + AFTER_CLOSE_MS : 20_000) + gateMs).unref?.();
  // Every condition by name, so a failure says which ({ ok, failed: [names] }; code-health AP-02:
  // the pass was one long AND, and a false one was named nowhere).
  const verdict = (need) => {
    const failed = Object.keys(need).filter(k => !need[k]);
    return { ok: failed.length === 0, failed };
  };

  try {
    const c = result.checks;
    c.tray = !!tray && !tray.isDestroyed();
    const w = openWindow();
    await new Promise((resolve, reject) => {
      w.webContents.once('did-finish-load', resolve);
      w.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`load failed: ${code} ${desc}`)));
    });
    if (SHOW_WINDOW) {
      // Shown once it's ready to show (ready-to-show may come just after the load finishes).
      for (let i = 0; i < 40 && !w.isVisible(); i++) await new Promise(r => setTimeout(r, 50));
      c.windowShown = w.isVisible();
      phase('window-shown');
    } else c.windowHidden = !w.isVisible();
    // The page settles before the self-test goes on to quit (AP-02): the fonts it has drawn text in
    // have loaded (a page asks for each as it first uses it). A quit while one was still being served
    // crashed Electron's exit: 0xC0000005 in a thread-pool copy of the response body, 14,564 bytes,
    // the size of fonts/inter-500.woff2 (the dump CI run 37110399434 kept). A condition, not a time.
    const settled = () => w.webContents.executeJavaScript('(async () => { void document.body.offsetHeight; await document.fonts.ready; return true; })()', true);
    if (NO_RELAUNCH) {
      // The relaunch run: a window on the real bridge is all its quit needs (the full run checks the rest).
      c.pageStatus = await w.webContents.executeJavaScript('window.nqa.status().then(s => !!(s && s.backend && s.backend.rt && s.backend.rt.state))', true) === true;
      c.bridge = loaded.report ?? { ok: false, error: loaded.reason ?? 'no bridge' };
      await settled();
      return finish(verdict({ tray: c.tray, windowHidden: c.windowHidden, pageStatus: c.pageStatus, bridge: c.bridge.ok === true }));
    }
    // The capture helper this packaged app runs, beside app.asar in Resources (C3 review), and its peer
    // check (code health BR-01: src/capture-gate.mjs), started now so the walk below covers its launches.
    // The app's team (null for an ad hoc build) is the one boot accepts the helper from, and the one the
    // app's own listener holds the helper's connection to (code health LS-03 / peer check): the gate runs
    // that listener, the bridge's capture module from inside app.asar, as boot imports it.
    const helper = captureHelperPaths({ packaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath });
    const helperPath = Object.values(helper)[0] ?? null;
    const team = IS_MAC ? ownTeamId({ packaged: app.isPackaged, platform: process.platform }) : null;
    const gate = IS_MAC && app.isPackaged && helperPath && fs.existsSync(helperPath)
      ? import(pathToFileURL(path.join(HERE, 'bridge', 'transport', 'capture.mjs')).href)
        .then(m => captureGate({ helper: helperPath, team, createCapture: m.createCapture }))
        .catch(e => ({ handshake: false, strangerRefused: false, argsRefused: false, connectRefused: false, connectAccepted: false, lines: { error: redactText(String(e?.message ?? e)).slice(0, 160) } }))
      : null;
    c.pageUrl = w.webContents.getURL();
    c.fromAppScheme = isAppPage(c.pageUrl) && c.pageUrl.startsWith(PAGE_URL);
    const prefs = w.webContents.getLastWebPreferences() ?? {};
    c.webPreferences = {
      contextIsolation: prefs.contextIsolation === true,
      sandbox: prefs.sandbox === true,
      nodeIntegration: prefs.nodeIntegration === true,
      spellcheck: prefs.spellcheck === true,
      webviewTag: prefs.webviewTag === true,
    };
    c.page = await w.webContents.executeJavaScript(`(async () => {
      const out = {};
      const b = window.nqa;
      out.origin = location.origin;
      out.secureContext = window.isSecureContext;
      out.preload = typeof b === 'object' && b !== null;
      out.methods = out.preload ? Object.keys(b).length : 0;
      out.nodeGlobals = [typeof require, typeof process, typeof module, typeof Buffer].filter(t => t !== 'undefined').length;
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      out.csp = meta ? meta.getAttribute('content') : null;
      out.inlineScripts = [...document.scripts].filter(s => !s.src).length;
      out.stylesheet = [...document.styleSheets].some(s => s.href && s.href.startsWith('nqa://app/') && s.cssRules.length > 0);
      // Bones's skull (the Dock icon's glass skull, lit and unlit): each loads from the scheme, and the shown one is drawn (it has a size and its picture).
      out.brandMark = (await Promise.all(['active', 'inactive'].map(m => new Promise(res => {
        const img = new Image();
        img.onload = () => res(img.naturalWidth > 0);
        img.onerror = () => res(false);
        img.src = 'img/bones-' + m + '.png';
      })))).every(Boolean) && (() => { const f = document.querySelector('#portrait .bones[data-face="' + document.getElementById('portrait').getAttribute('data-state') + '"]'); const r = f && f.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0 && getComputedStyle(f).opacity === '1' && /bones-/.test(getComputedStyle(f).backgroundImage); })();
      const st = await b.status();
      out.state = st && st.backend && st.backend.rt ? st.backend.rt.state : null;
      out.mock = !!(st && st.mock);
      const pv = await b.providers();
      out.providers = Array.isArray(pv) ? pv.length : -1;
      const info = await b.appInfo();
      out.name = info && info.name;
      const refused = await b.setCaps({ dailyUsd: '<script>alert(1)</script>' });
      out.hostileInputRefused = !!refused && refused.ok === false && refused.error === 'bad_input';
      const refused2 = await b.dismissNotice({ id: '../../etc/passwd' });
      const refused3 = await b.openLink({ id: 'https://evil.example/' });
      const refused4 = await b.stageKey({ key: 12345 });
      out.validatorsRefuse = [refused2, refused3, refused4].every(r => r && r.ok === false && r.error === 'bad_input');
      // Text that isn't a key is never staged (the key field takes any text; its shape decides).
      const notKey = await b.stageKey({ key: 'short' });
      out.notAKeyRefused = !!notKey && notKey.ok === false && notKey.error === 'not_a_key';
      out.pageFetchRefused = await fetch('file:///etc/hosts').then(() => false, () => true);
      // One polite live region outside the page, the same node whatever the page does (D-04).
      const live = document.getElementById('live');
      const pageEl = document.getElementById('page');
      out.liveRegion = !!live && live.getAttribute('aria-live') === 'polite' && !pageEl.contains(live);
      out.titleFocused = true;
      // A page is drawn once its data has come over IPC from the bridge, so the walk waits for what a
      // click starts, at most 5 s each, never a fixed time: an updated app's first run on a busy
      // Windows runner took longer than the 500 ms the walk used to sleep, and its checks read the page
      // before (titleFocused and notificationsSwitch false, run 37077685873). The checks are the same.
      const until = async (cond) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > 5000) return false; await new Promise(r => setTimeout(r, 25)); } return true; };
      const pageEl2 = document.getElementById('page');
      // Settings from the sidebar, then Your data and its Last request row, then Settings' About row (behind Show more, which is clicked first).
      const walk = [['settings', '[data-nav="settings"]'], ['privacy', '[data-nav="privacy"]'], ['last-request', '[data-fk="open-last-request"]'], ['settings', '[data-nav="settings"]'], ['about', '[data-fk="open-about"]', '[data-fk="more"]']];
      for (const [page, sel, before] of walk) {
        // Show more draws Settings again (its data over IPC): the row behind it, once it's there.
        if (before) { const pre = document.querySelector(before); if (pre) { pre.click(); await until(() => !!document.querySelector(sel)); } else out.titleFocused = false; }
        const btn = document.querySelector(sel);
        if (btn) btn.click(); else out.titleFocused = false;
        // Drawn: the page sets data-page and focuses its heading in the same step (app.js rerender).
        if (!await until(() => pageEl2.getAttribute('data-page') === page)) out.titleFocused = false;
        // A page change puts focus on its heading (D-04).
        const a = document.activeElement;
        out.titleFocused = out.titleFocused && !!a && a.tagName === 'H1' && a.getAttribute('tabindex') === '-1';
        if (page === 'privacy') {
          // The data policies are behind Your data's Details (its sheet); close it before walking on.
          const d = document.querySelector('#page [data-fk="details"]');
          if (d) { d.click(); await until(() => !!document.querySelector('#sheet-host [data-fk="sheet-close"]')); }
          // By its hook, not its look: the sheet's link rows changed class (app-data-sheet), the data-fk didn't.
          out.policyLinks = [...document.querySelectorAll('#sheet-host [data-fk="data-policy"]')].filter(b => /’s data policy/.test(b.textContent)).length;
          const x = document.querySelector('#sheet-host [data-fk="sheet-close"]');
          if (x) { x.click(); await until(() => !document.querySelector('#sheet-host [data-fk="sheet-close"]')); }
        }
        // The last request's markup shows as text, never as an element: read on its own page, before the walk goes on.
        if (page === 'last-request') {
          const pg = document.getElementById('page');
          out.hostileTextShownAsText = pg.textContent.includes('onerror=');
          out.hostileElements = pg.querySelectorAll('img, iframe, object, embed, webview').length;
        }
        if (page === 'settings') {
          const sw = document.getElementById('sw-notifications');
          out.notificationsSwitch = !!sw && sw.getAttribute('role') === 'switch' && sw.getAttribute('aria-checked') === 'true';
        }
      }
      out.liveRegion = out.liveRegion && document.getElementById('live') === live;
      // The page's own images are the in-game frame and the route map (index.html's hidden figures and their clones); nothing else.
      out.injectedElements = [...document.querySelectorAll('img, iframe, object, embed, webview')].filter(e => !(e.tagName === 'IMG' && e.closest('figure.ingame') && (['ask', 'thinking', 'reply'].some(n => e.src === 'nqa://app/img/ingame-' + n + '@1x.webp') || e.src === 'nqa://app/img/route-map.svg'))).length + document.scripts.length - 3 + (out.hostileElements ?? 1); // strings.js, format.js, app.js; and none on the last request's page
      return out;
    })()`, true);
    await settled();

    // What the page itself asked for: its own files, nothing else (before the probes below add refusals).
    const snap = ledger.snapshot();
    c.requests = { pages: snap.pages, updateHosts: snap.allowed.length, refused: snap.blocked.map(r => `${r.scheme}://${r.host ?? ''} (${r.reason})`) };
    c.onlyPageRequests = snap.allowed.length === 0 && snap.blocked.length === 0;

    // The scheme serves the renderer folder and nothing else; the guard refuses file: and every other host.
    const ses = session.defaultSession;
    c.scheme = {
      page: await probe(ses, PAGE_URL),
      missing: await probe(ses, 'nqa://app/nothing-here.js'),
      folder: await probe(ses, 'nqa://app/'),
      outside: await probe(ses, 'nqa://app/%2e%2e/main.mjs'),
      otherHost: await probe(ses, 'nqa://evil/index.html'),
      file: await probe(ses, pathToFileURL(path.join(RENDERER_DIR, 'index.html')).href),
    };
    const csp = (await ses.fetch(PAGE_URL)).headers.get('content-security-policy');
    c.schemeCspHeader = csp === CSP;
    c.requests.served = schemeLog.served;
    c.guardCancels = {
      defaultSession: await probe(session.defaultSession, 'https://example.invalid/bones-self-test') === 'blocked',
      updaterSession: await probe(session.fromPartition(UPDATER_PARTITION), 'https://example.invalid/bones-self-test') === 'blocked',
      updateHostWhileChecksOff: await probe(session.fromPartition(UPDATER_PARTITION), 'https://github.com/') === 'blocked',
    };

    // The real bridge the page just ran on, from inside the app (the asar when packaged), in its
    // sandbox: capture off, no WoW folder, a memory key store.
    c.bridge = loaded.report ?? { ok: false, error: loaded.reason ?? 'no bridge' };
    c.bridge.api = loaded.mode;

    // The capture helper, and the team boot accepts for it on macOS (the app's own; null for an ad hoc build).
    c.captureHelper = { present: helperPath ? fs.existsSync(helperPath) : null, team };
    // The Mac helper carries NeverQuestAlone's own bundle id, the one the bridge's code requirement
    // and the uninstall read, never a checkout's (final review L3-4).
    if (IS_MAC && app.isPackaged && helperPath) {
      const idFile = readCaptureBundleId(bridgeRoots(HERE, { packaged: true }));
      let plistId = null;
      try { plistId = (/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(path.join(helperPath, 'Contents', 'Info.plist'), 'utf8')) || [])[1] ?? null; } catch {}
      c.captureHelper.bundleId = plistId;
      c.captureHelper.bundleIdOk = !!plistId && plistId === idFile && /^com\.neverquestalone\.(?!capture\.dev$)/.test(plistId);
    }
    // Its peer check (BR-01): it serves this app (the handshake: a team or bundle id that doesn't match
    // fails it), refuses another program's socket (exit 6; asked of an app with a team, as an ad hoc
    // helper has none to ask for) and refuses aim (exit 7). And the app's (LS-03 / peer check): its
    // listener closes a stranger's connection unread and takes the helper's (an app with a team).
    if (gate) c.capturePeer = await gate;

    // The shell's own log: a staged key of no known shape, and one the bridge registered, never
    // reach it (C3 review). Canaries made here, dropped at once.
    const stagedProbe = `nqa-self-test-${Date.now().toString(36)}-staged-0123456789`;
    const knownProbe = `nqa.self.test.${Date.now().toString(36)}.known.0123456789`;
    const probeId = keys.stage(stagedProbe);
    log.addSecret(knownProbe);
    log(`self-test log probe: ${stagedProbe} ${knownProbe}`);
    keys.drop(probeId);
    const probeLine = logRing.at(-1) ?? '';
    c.logRedacts = probeLine.includes('self-test log probe') && !probeLine.includes(stagedProbe) && !probeLine.includes(knownProbe);

    // The environment Node reads for the bridge's connections (final review L2-1): certificate
    // checks can't be turned off (NODE_TLS_REJECT_UNAUTHORIZED is gone before any connection),
    // and an environment proxy would have stopped the start. NODE_EXTRA_CA_CERTS (SR-05): Electron
    // unsets it before Node starts while the NODE_OPTIONS fuse is off, so it's gone and Node trusts no
    // certificate from it; scripts/self-test.mjs starts the full run with it naming a CA file.
    c.networkEnv = {
      tlsOffRemoved: process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined,
      proxyRefused: guardNetworkEnv({ NODE_USE_ENV_PROXY: '1' }).refuse === 'NODE_USE_ENV_PROXY',
      extraCaGone: process.env[EXTRA_CA_ENV] === undefined,
      extraCaCerts: (await import('./src/extra-ca.mjs')).extraCaCount(),
    };
    // What a dependency's loader would load instead of its own code (SR-05): gone before any module
    // loaded (src/launch-guard.mjs), and the key store's binding loads from the app, as keystore.mjs
    // imports it (the same module; nothing here touches a keychain). scripts/self-test.mjs starts this
    // run with NAPI_RS_NATIVE_LIBRARY_PATH naming a file that would say if it ever ran.
    let keyStoreLoads = false;
    try { keyStoreLoads = typeof (await import('@napi-rs/keyring')).Entry === 'function'; } catch {}
    c.loaderEnv = { removed: [...LOADER_FOUND.removed], gone: !Object.keys(process.env).some(loaderVariable), keyStoreLoads };

    const p = c.page;
    const wp = c.webPreferences;
    const cspOk = typeof p.csp === 'string' && p.csp === CSP.replace("; frame-ancestors 'none'", '') && /script-src nqa:\/\/app;/.test(p.csp) && !/unsafe-inline|unsafe-eval|'self'|file:|https?:/.test(p.csp);
    c.cspOk = cspOk;
    const sc = c.scheme;
    c.schemeOk = sc.page === 200 && sc.missing === 404 && [404, 'blocked'].includes(sc.folder) && [404, 'blocked'].includes(sc.outside)
      && [404, 'blocked'].includes(sc.otherHost) && sc.file === 'blocked' && c.schemeCspHeader;
    const g = c.guardCancels;
    const passed = verdict({
      tray: c.tray, window: SHOW_WINDOW ? c.windowShown : c.windowHidden, fromAppScheme: c.fromAppScheme, origin: p.origin === 'nqa://app', secureContext: p.secureContext === true,
      contextIsolation: wp.contextIsolation, sandbox: wp.sandbox, noNodeIntegration: !wp.nodeIntegration, noSpellcheck: !wp.spellcheck, noWebviewTag: !wp.webviewTag,
      preload: p.preload, methods: p.methods > 30, noNodeGlobals: p.nodeGlobals === 0, csp: cspOk, noInlineScripts: p.inlineScripts === 0, stylesheet: p.stylesheet, brandMark: p.brandMark,
      state: p.state != null, providers: p.providers > 0, name: p.name === 'NeverQuestAlone', hostileInputRefused: p.hostileInputRefused, validatorsRefuse: p.validatorsRefuse, notAKeyRefused: p.notAKeyRefused, pageFetchRefused: p.pageFetchRefused,
      noInjectedElements: p.injectedElements === 0, hostileTextShownAsText: p.hostileTextShownAsText, notificationsSwitch: p.notificationsSwitch, policyLinks: p.policyLinks > 0, liveRegion: p.liveRegion, titleFocused: p.titleFocused,
      scheme: c.schemeOk, onlyPageRequests: c.onlyPageRequests, guardDefaultSession: g.defaultSession, guardUpdaterSession: g.updaterSession, guardUpdateHostWhileChecksOff: g.updateHostWhileChecksOff,
      bridge: c.bridge.ok === true, logRedacts: c.logRedacts, tlsOffRemoved: c.networkEnv.tlsOffRemoved, proxyRefused: c.networkEnv.proxyRefused,
      extraCaIgnored: !app.isPackaged || (c.networkEnv.extraCaGone && c.networkEnv.extraCaCerts === 0),
      loaderEnvGone: c.loaderEnv.gone, keyStoreLoads: !app.isPackaged || c.loaderEnv.keyStoreLoads,
      captureHelper: !app.isPackaged || c.captureHelper.present === true, captureBundleId: !(IS_MAC && app.isPackaged) || c.captureHelper.bundleIdOk === true,
      captureHandshake: !gate || c.capturePeer.handshake === true, captureArgsRefused: !gate || c.capturePeer.argsRefused === true,
      captureStrangerRefused: !gate || !c.captureHelper.team || c.capturePeer.strangerRefused === true,
      captureConnectRefused: !gate || !c.captureHelper.team || c.capturePeer.connectRefused === true,
      captureConnectAccepted: !gate || !c.captureHelper.team || c.capturePeer.connectAccepted === true,
    });
    if (SHOW_WINDOW) {
      // The shown window a while, then only the tray: the phases the footprint sampler reads.
      phase('window-idle');
      await new Promise(r => setTimeout(r, SHOW_WINDOW_MS));
      phase('window-closing');
      w.close();
      await new Promise(r => setTimeout(r, AFTER_CLOSE_MS));
      phase('after-close');
    }
    finish(passed);
  } catch (e) {
    finish({ ok: false, error: redactText(String(e?.message ?? e)) });
  }
}

/**
 * The self-test's last phase (systems critic SY-102-2): the real quit, never app.exit. Plain, as the
 * tray's Quit asks it: app.quit(), so before-quit, will-quit's preventDefault, the bridge's stop and
 * app.exit(0) all run; with --no-relaunch, as Quit and reopen does (relaunch(): the flow's one
 * relaunch, skipped, then app.quit()), and a second launch comes during it (onCommit). The quit
 * flow's lines go to stdout (quitLog); scripts/self-test.mjs checks them and the exit code. The
 * sandbox's folder goes after the stop (beforeExit). A quit that never ends exits 1.
 */
function quitPhase() {
  removeDataOnQuit = true;
  setTimeout(() => { quitLog('quit-stalled (the self-test quit never ended)'); app.exit(1); }, 15_000);
  if (NO_RELAUNCH) relaunch();
  else app.quit();
}

if (PRIMARY) {
  start().catch(e => {
    log(`start failed: ${e?.stack ?? e}`);
    if (HEADLESS) {
      process.stdout.write(`${JSON.stringify({ selfTest: 'neverquestalone', ok: false, error: redactText(String(e?.message ?? e)) })}\n`);
      app.exit(1);
    }
  });
} else {
  app.quit();
}
