// Choosing and starting the app API the shell talks to (BUILD-PLAN "Desktop
// app" and "Contract: the app API the desktop shell calls"; PRD §11.2 SC-9).
//
// The assembly lives in the bridge: main imports bridge/byok/boot.mjs and calls
//   bootByok({ paths, platform, log, openExternal, importer })
// which loads <userData>/config.json, makes the key store ('os'), wraps fetch in
// the egress guard, takes the single-bridge lock, runs createBridge with
// createLocalBackend, starts the capture helper, and returns
//   { api, stop, bridge, backend, keystore, config }
// where api is createAppApi's (bridge/byok/app-api.mjs). Nothing else runs it:
// there is no headless bridge and no control pipe (systems plan D6). log comes
// from the shell.
//
// Where bridge code may be imported from (SC-9, TH22): a packaged app looks
// only inside app.asar (<appDir>/bridge/…), so OnlyLoadAppFromAsar and the
// asar integrity check cover every JavaScript module main runs; boot's own lazy
// imports (the capture helper's module) go through the same importer. Nothing
// beside the install folder (for a per-user NSIS install, a folder the player's
// account can write) is ever imported. An unpackaged run also looks in the repo.
// Not covered by the asar's hash: the keychain binding's native .node, which
// Electron can only load from app.asar.unpacked, and the capture helpers in
// Resources. On a signed Mac app the code signature (hardened runtime, library
// validation) covers them; on a per-user Windows or Linux install they can be
// replaced by the player's own account, which crosses no boundary there (that
// account can read its Credential Manager or Secret Service items anyway).
//
// Rules: the mock (src/mock-api.mjs, not in the package) is used only in an
// unpackaged run, when asked (NQA_MOCK_API=1) or when there is no boot.mjs
// yet; it is imported only then. The self-test runs on the real bridge. A packaged
// app without boot.mjs (a build that left bridge/ out), and a real module that
// fails to load or start, are error states the window shows, never a silent
// fall back to fake data where a saved key would go nowhere. Every contract
// call the module lacks answers { ok: false, error: 'unsupported' }.
//
// Capture (fork PRD §9.10, public PRD §11.1): boot starts the capture helper
// itself once there's a WoW folder with the addon; on macOS that's "NeverQuestAlone
// Capture.app", launched through LaunchServices so the Screen Recording grant
// belongs to it. A packaged app ships each OS's helper beside app.asar, in
// Resources (captureHelperPaths), since nothing can be run from inside an asar
// (scripts/fuses.cjs fails a build without it); a development run uses the
// repo's (boot's defaults). The Mac helper must satisfy a code requirement:
// the local identity, or a Developer ID team; a packaged app passes its own
// team (ownTeamId, read from its signature), so the helper electron-builder
// re-signed with the app's Developer ID passes on a player's Mac.
//
// The packaged --self-test runs the app on the real bridge from inside the asar
// (loadApi with selfTest, systems plan Batch 5): boot.mjs and everything it
// imports, in a sandbox with a memory key store, no WoW folder, no capture and
// no network (selfTestBootOptions; selfTestBridge boots the same sandbox alone).
//
// Main holds the real bridge through createLiveApi (fix-102): one boot at a time,
// never a stopped one. A boot stopped while no quit is committed (src/quit.mjs
// stops it only once a quit is) boots again at once, so the window can't talk
// to a bridge whose egress guard is gone, as it did on 2026-09-30.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { redactText } from './redact.mjs';
import { slotWorkerGate } from './slot-worker-gate.mjs';
import { IDENTITY } from './identity.mjs';

/** The contract's calls, plus the shell's own (setPaused, uninstall). */
export const API_METHODS = Object.freeze([
  'status', 'providers', 'setKey', 'testKey', 'testStagedKey', 'deleteKey', 'connectCustom', 'choose',
  'caps', 'setCaps', 'privacy', 'setPrivacy', 'usage', 'connections', 'lastRequest',
  'memory', 'forgetMemory', 'transcripts', 'findWow', 'useWowFolder', 'installAddon', 'wowRunning', 'addonPermissions', 'tightenAddonPermissions', 'diagnostics',
  'setPaused', 'resumeSending', 'uninstall', 'setRetention', 'retentionPreview', 'regenerateSafetyId',
  // Setup (onboarding spec §9.3): terms, connect, the saved key, the install (now or when WoW
  // closes), the launcher, Screen Recording.
  'recordTerms', 'connect', 'useSavedKey', 'signIn', 'cancelSignIn', 'setupInstall', 'armInstall', 'cancelInstall', 'launcher',
  'requestScreenPermission', 'screenPermission',
]);

/** The bridge module main imports, relative to the bridge root (BUILD-PLAN "boot.mjs"). */
export const BRIDGE_FILES = Object.freeze({
  boot: 'bridge/byok/boot.mjs',
});
/**
 * The key store's service name, the app's identity's (bridge/byok/security/keystore.mjs SERVICE; the
 * Windows uninstaller deletes "<provider>.<service>").
 */
export const KEY_SERVICE = IDENTITY.keychainService;
/** The key store module, imported only by the self-test's sandboxed boot (a memory store). */
export const KEYSTORE_FILE = 'bridge/byok/security/keystore.mjs';
/**
 * The macOS capture helper's bundle, the app's identity's, shipped in the app's Resources
 * (scripts/plugin-config.mjs extraResources); null for an app without one.
 */
export const CAPTURE_APP_NAME = IDENTITY.captureHelper ? `${IDENTITY.captureHelper.app}.app` : null;
/**
 * Each OS's capture helper in a packaged app's Resources (electron-builder.yml extraResources;
 * scripts/fuses.cjs CAPTURE_HELPERS says the same and fails a build without it), and the boot path
 * it overrides: the Mac app, the Windows helper, the X11 script (run by python3, so not from the asar).
 */
export const CAPTURE_HELPERS = Object.freeze({
  ...(CAPTURE_APP_NAME ? { darwin: Object.freeze({ file: CAPTURE_APP_NAME, key: 'captureApp' }) } : {}),
  win32: Object.freeze({ file: 'capture/nqa-capture.exe', key: 'captureExe' }),
  linux: Object.freeze({ file: 'capture/capture_x11.py', key: 'captureScript' }),
});

/** Where boot finds the capture app: the packaged Mac app's Resources; else boot's default (the repo's build). */
export function captureAppPath({ packaged = false, platform = process.platform, resourcesPath = null } = {}) {
  return packaged && platform === 'darwin' && resourcesPath && CAPTURE_APP_NAME ? path.join(resourcesPath, CAPTURE_APP_NAME) : undefined;
}

/** The paths boot takes for this OS's capture helper ({captureApp} | {captureExe} | {captureScript}), packaged only; else {}. */
export function captureHelperPaths({ packaged = false, platform = process.platform, resourcesPath = null } = {}) {
  const h = CAPTURE_HELPERS[platform];
  if (!packaged || !h || !resourcesPath) return {};
  return { [h.key]: path.join(resourcesPath, ...h.file.split('/')) };
}

/**
 * The Developer ID team this packaged Mac app is signed by (codesign's TeamIdentifier), or null:
 * unpackaged, another OS, ad hoc or unsigned ("not set"), or codesign can't say. Boot accepts a
 * capture helper signed by the same team (the build re-signs the helper with the app's identity).
 */
export function ownTeamId({ packaged = false, platform = process.platform, execPath = process.execPath, run = spawnSync } = {}) {
  if (!packaged || platform !== 'darwin') return null;
  const at = String(execPath).lastIndexOf('.app/');
  if (at < 0) return null;
  let r;
  try { r = run('/usr/bin/codesign', ['-dv', '--verbose=2', String(execPath).slice(0, at + 4)], { encoding: 'utf8', timeout: 5000 }); } catch { return null; }
  const m = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(`${r?.stderr ?? ''}\n${r?.stdout ?? ''}`);
  return m ? m[1] : null;
}

/** Where the bridge may come from: inside the app only when packaged; the app, then the repo, when not. */
export function bridgeRoots(appDir, { packaged = false } = {}) {
  const inApp = path.resolve(appDir);
  return packaged ? [inApp] : [inApp, path.resolve(appDir, '..', '..')];
}

export function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Candidate paths of boot.mjs, in order. */
export function apiCandidates(appDir, { packaged = false } = {}) {
  return bridgeRoots(appDir, { packaged }).map(root => path.join(root, ...BRIDGE_FILES.boot.split('/')));
}

/** Give any object every contract call; a missing one answers "unsupported". */
export function wrapApi(api, { stop = null } = {}) {
  const out = {};
  for (const m of API_METHODS) {
    out[m] = typeof api?.[m] === 'function' ? (...a) => api[m](...a) : async () => ({ ok: false, error: 'unsupported' });
  }
  out.onChange = typeof api?.onChange === 'function' ? cb => api.onChange(cb) : () => () => {};
  out.stop = stop ?? (typeof api?.stop === 'function' ? () => api.stop() : async () => {});
  out.mock = !!api?.mock;
  return out;
}

/**
 * The app API main holds (fix-102): one boot at a time, and never a stopped one. boot() is
 * loadApi's call ({ api, mode, reason, report? }); start() runs it. stop() stops the boot, which
 * main does when a quit is committed (src/quit.mjs), after commit(). A boot stopped with no quit
 * committed boots again at once, and a call that comes meanwhile waits for the new boot: the window
 * never talks to a bridge whose egress guard is gone (a stopped guard refuses every request before
 * it's sent, and the player was told to check their internet, 2026-09-30). A commit is final
 * (quit-race): from commit() on, nothing boots in this process again, whoever asks (a call, a
 * stop's end, reboot(), a reboot already waiting for an old stop); the process is ending, and a
 * relaunch, if one was asked, is the only way back. The quit flow used to reboot after an exit that
 * was only slow (src/quit.mjs, CI run 37107199251). The onChange listeners move
 * to each new boot, and hear a new boot's status at once (the tray and the window stop showing the
 * old one's); onBoot(loaded) hears every boot, so main keeps the window's mode and reason.
 *
 * One boot's stop never overlaps the next boot (systems critic SY-102-7): the stop that runs is
 * kept, and a reboot waits for it, at most waitMs, before it boots again; an old stop's lock
 * release (bridge/byok/lock.mjs, by pid) would remove the new boot's lock, which has the same pid.
 * Reboots are one at a time, and a stop that ends after a newer boot was adopted reboots nothing.
 * → { api (every contract call, onChange, stop), start(), stop(), reboot(why), commit(), current(), stopped() }
 */
/** The longest a reboot waits for the old boot's stop before it boots again anyway. */
export const REBOOT_WAIT_MS = 10_000;

export function createLiveApi({ boot, log = () => {}, onBoot = () => {}, waitMs = REBOOT_WAIT_MS, timers = globalThis }) {
  if (typeof boot !== 'function') throw new TypeError('createLiveApi needs boot()');
  let cur = null;
  let stopped = false;
  let committed = false;
  let pending = null;
  let rebooting = null;
  let stopping = null; // the running stop, settled (never rejects), until it ends
  let boots = 0;
  const listeners = new Set();
  let detach = () => {};
  const fanOut = (s) => { for (const cb of listeners) { try { cb(s); } catch { /* a listener never breaks the rest */ } } };
  function adopt(loaded) {
    try { detach(); } catch { /* the old boot's listener */ }
    cur = loaded;
    stopped = false;
    boots += 1;
    const off = cur?.api?.onChange?.(fanOut);
    detach = typeof off === 'function' ? off : () => {};
    try { onBoot(loaded); } catch { /* main's bookkeeping */ }
    // A boot after the first: its status goes out now (main reads the first one itself at start).
    if (boots > 1) {
      const api = cur?.api;
      Promise.resolve().then(() => api?.status?.()).then((s) => { if (s && cur?.api === api) fanOut(s); }, () => {});
    }
    return loaded;
  }
  function start() {
    pending ??= Promise.resolve().then(() => boot()).then(adopt).finally(() => { pending = null; });
    return pending;
  }
   /** Stop a boot, and keep its stop until it ends (SY-102-7). → the stop's own promise. */
  function stopBoot(b) {
    const run = Promise.resolve().then(() => b.api.stop());
    const kept = run.then(() => {}, () => {}).finally(() => { if (stopping === kept) stopping = null; });
    stopping = kept;
    return run;
  }
  /** The running stop's end, waited for at most waitMs; a stop that runs over is said, and left. */
  async function stopEnded() {
    const s = stopping;
    if (!s) return;
    let bound = null;
    const over = new Promise((r) => { bound = timers.setTimeout(() => r('over'), waitMs); bound?.unref?.(); });
    const how = await Promise.race([s.then(() => 'ended'), over]);
    timers.clearTimeout(bound);
    if (how === 'over') log(`the old bridge was still stopping after ${Math.round(waitMs / 100) / 10} s; the bridge starts again anyway`);
  }
  /** A committed quit boots nothing again (quit-race): → true, and says so, when this boot is refused. */
  function refused(why) {
    if (!committed) return false;
    log(`the bridge stays stopped: the quit is committed (${why})`);
    return true;
  }
  function reboot(why = 'asked') {
    if (refused(why)) return Promise.resolve(null);
    if (pending) return pending;
    rebooting ??= (async () => {
      const old = cur;
      if (old && !stopped) { stopped = true; stopBoot(old).catch(() => { /* stopping */ }); }
      await stopEnded();
      // A quit committed while the old stop ran: nothing boots now.
      if (refused(why)) return null;
      log(`the bridge starts again (${why})`);
      return start();
    })().finally(() => { rebooting = null; });
    return rebooting;
  }
  async function live() {
    if (pending) await pending.catch(() => {});
    if (!stopped) return cur?.api ?? null;
    if (committed) return null;
    await reboot('a call came after it stopped').catch(e => log(`the bridge couldn't start again: ${e?.message ?? e}`));
    return stopped ? null : cur?.api ?? null;
  }
  async function stop() {
    if (pending) await pending.catch(() => {});
    if (!cur || stopped) return;
    stopped = true;
    const b = cur;
    try { await stopBoot(b); } finally {
      // Stopped while no quit is committed: the process lives on, so the bridge starts again now
      // (unless a newer boot already serves: a stop that outran a reboot's wait).
      if (!committed && cur === b) reboot('it stopped with no quit committed').catch(e => log(`the bridge couldn't start again: ${e?.message ?? e}`));
    }
  }
  const api = {};
  for (const m of API_METHODS) {
    api[m] = async (...a) => {
      const x = await live();
      return x ? x[m](...a) : { ok: false, error: 'quitting' };
    };
  }
  api.onChange = (cb) => {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  api.stop = stop;
  Object.defineProperty(api, 'mock', { enumerable: true, get: () => !!cur?.api?.mock });
  return {
    api, start, stop, reboot,
    commit() { committed = true; },
    current: () => cur,
    stopped: () => stopped,
  };
}

/** An API that answers every call with the load failure, so the window can say so. */
export function unavailableApi(reason) {
  const err = async () => ({ ok: false, error: 'bridge_unavailable', detail: reason });
  const api = {};
  for (const m of API_METHODS) api[m] = err;
  api.status = async () => ({ bridge: { running: false, error: reason }, backend: { rt: { state: 'provider_down', reason: 'bridge_unavailable' } } });
  api.providers = async () => [];
  return wrapApi(api);
}

/**
 * The bridge's log is (event, data); the shell's is one redacted line. Every key the bridge
 * registers goes to the shell's log too (log.addSecret), so the shell's own lines (an uncaught
 * exception, a failed start) never carry one either.
 */
export function bridgeLogger(log) {
  const secrets = new Set();
  // One redaction a line (code health BR-21): the shell's own redactor when it has one (main.mjs
  // log.scrub: these keys and the key stager's too), and the line handed over already redacted
  // (log.write), so the shell doesn't redact it again. boot.mjs's ring log redacts a line with
  // out.scrub and gives it here through out.line.
  const scrub = s => (typeof log.scrub === 'function' ? String(log.scrub(String(s ?? ''))) : redactText(String(s ?? ''), { extra: [...secrets] }));
  const write = typeof log.write === 'function' ? log.write : log;
  const out = (event, data) => write(scrub(`bridge ${event}${data === undefined ? '' : ` ${safeJson(data)}`}`));
  out.line = line => write(`bridge ${line}`);
  out.addSecret = (s) => {
    if (typeof s !== 'string' || s.length < 8) return;
    secrets.add(s);
    try { log.addSecret?.(s); } catch { /* the patterns still apply */ }
  };
  out.scrub = scrub;
  return out;
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return '[unprintable]'; }
}

/**
 * Boot the bridge from root (bridge/byok/boot.mjs). Its state lives under the
 * app's own data folder (paths.userData, paths.state). Lazy imports boot makes go
 * through the same importer, so they stay inside the asar too.
 */
export async function assembleBridge({ root, paths, log = () => {}, platform = process.platform, openExternal = null, importer, bootOptions = null }) {
  const bootFile = path.join(root, ...BRIDGE_FILES.boot.split('/'));
  const mod = await importer(bootFile);
  if (typeof mod?.bootByok !== 'function') throw new Error('boot.mjs does not export bootByok');
  const inRoot = inRootImporter(root, importer);
  const started = await mod.bootByok({ ...(bootOptions ?? {}), paths, platform, log: bridgeLogger(log), openExternal, importer: inRoot });
  if (!started?.api) {
    await Promise.resolve(started?.stop?.()).catch(() => {});
    throw new Error('the bridge started without an app API');
  }
  return started;
}

/** An importer that refuses anything outside root (boot's own lazy imports go through it too). */
function inRootImporter(root, importer) {
  return async (p) => {
    if (!isInside(root, p)) throw new Error('refused bridge code from outside the app');
    return importer(p);
  };
}

const defaultImporter = p => import(pathToFileURL(p).href);

/** The mock API, imported only when a development run asks for it (it isn't in the package). */
async function mockApi() {
  const { createMockApi } = await import('./mock-api.mjs');
  return wrapApi(createMockApi());
}

/**
 * bootByok's options for the self-test's sandbox: a memory key store, the WoW folder pinned to a
 * path inside paths.userData that doesn't exist (never a real install: a sandbox that found one
 * would publish slots into a live game), nothing
 * searched for, no capture, no egress guard, no start-up checks. Throws sandbox_not_empty when
 * that path exists.
 */
export async function selfTestBootOptions({ root, paths, importer = defaultImporter, exists = fs.existsSync }) {
  const noWow = path.join(paths.userData, 'no-wow', '_forever_');
  if (exists(noWow)) throw Object.assign(new Error('sandbox_not_empty'), { code: 'sandbox_not_empty' });
  const { createKeyStore } = await inRootImporter(root, importer)(path.join(root, ...KEYSTORE_FILE.split('/')));
  return {
    keystore: createKeyStore({ backend: 'memory' }),
    config: { wow: { flavorDir: noWow, account: '' }, capture: { enabled: false } },
    configFile: path.join(paths.userData, 'config.json'), home: paths.userData, env: {},
    capture: false, egress: false,
    lockDir: path.join(paths.userData, 'locks'),
    wow: { find: () => [], running: () => ({ running: false }), roots: [], run: () => ({ status: 1, stdout: '' }) },
    backendOptions: { checks: { models: false } },
  };
}

/**
 * What the self-test reports about a sandboxed bridge it booted: { ok, root, state, bridge, capture,
 * providers, slotWorker }. slotWorker (code health BR-04, src/slot-worker-gate.mjs): the bridge's slot
 * worker started from the same root (app.asar, packaged) and wrote a slot table into the sandbox; a
 * worker that falls back to writing on the main thread fails the report.
 */
async function sandboxReport(started, { root, packaged, importer, paths }) {
  if (started.bridge) return { ok: false, error: 'a bridge started in the sandbox; stopped' };
  const st = await started.api.status();
  const pv = await started.api.providers();
  const slotWorker = await slotWorkerGate({ root, importer: inRootImporter(root, importer), dir: paths.userData });
  return {
    ok: Array.isArray(pv) && pv.length > 0 && typeof st?.backend?.rt?.state === 'string' && st?.bridge?.error === 'wow_not_found' && st?.bridge?.running === false
      && slotWorker.ok === true,
    root: packaged ? 'app.asar' : root, state: st?.backend?.rt?.state ?? null, bridge: st?.bridge?.error ?? null,
    capture: st?.capture?.state ?? null, providers: Array.isArray(pv) ? pv.length : 0, slotWorker,
  };
}

/**
 * The self-test's sandboxed boot of the real bridge: { ok: true, root, state, bridge, providers,
 * capture } or { ok: false, error }. paths.userData must be the self-test's temp folder; it is
 * also boot's home, so nothing outside it is read or written (no control socket, no locks).
 * The WoW folder is pinned to a path inside the sandbox that doesn't exist, and nothing is
 * searched for, so no bridge starts: the backend runs alone. (A real WoW folder found or named
 * there would get slots published into a live game.)
 * A boot that started a bridge anyway is stopped at once and reported as a failure.
 */
export async function selfTestBridge({ appDir, packaged = false, paths, log = () => {}, platform = process.platform, exists = fs.existsSync, importer = defaultImporter }) {
  const root = bridgeRoots(appDir, { packaged }).find(r => exists(path.join(r, ...BRIDGE_FILES.boot.split('/'))));
  if (!root) return { ok: false, error: 'no_bridge' };
  let started = null;
  try {
    const bootOptions = await selfTestBootOptions({ root, paths, importer, exists });
    started = await assembleBridge({ root, paths, log, platform, importer, bootOptions });
    return await sandboxReport(started, { root, packaged, importer, paths });
  } catch (e) {
    if (e?.code === 'sandbox_not_empty') return { ok: false, error: 'sandbox_not_empty' };
    return { ok: false, error: redactText(String(e?.message ?? e)).slice(0, 300) };
  } finally {
    if (started) await Promise.resolve(started.stop?.()).catch(() => {});
  }
}

/**
 * The app API main runs on: { api, mode: 'real' | 'mock' | 'error', reason }. selfTest (the
 * --self-test) boots the real bridge in its sandbox (selfTestBootOptions) and adds `report`, what
 * selfTestBridge would say; the sandbox's options win over bootOptions. forceMock is honored only
 * in an unpackaged run.
 */
export async function loadApi({
  appDir, packaged = false, paths = {}, log = () => {}, env = process.env, forceMock = false, selfTest = false, openExternal = null,
  platform = process.platform, exists = fs.existsSync, importer = defaultImporter, bootOptions = null,
}) {
  if (!packaged && !selfTest && (forceMock || env.NQA_MOCK_API === '1')) return { api: await mockApi(), mode: 'mock', reason: forceMock ? 'asked' : 'NQA_MOCK_API=1' };
  const root = bridgeRoots(appDir, { packaged }).find(r => exists(path.join(r, ...BRIDGE_FILES.boot.split('/'))));
  if (!root && packaged) {
    const reason = 'this build of NeverQuestAlone is missing its bridge (bridge/byok/boot.mjs)';
    log(reason);
    return { api: unavailableApi(reason), mode: 'error', reason };
  }
  if (!root) return { api: await mockApi(), mode: 'mock', reason: 'bridge/byok/boot.mjs is not in this build yet' };
  if (packaged && !isInside(appDir, path.join(root, BRIDGE_FILES.boot))) {
    const reason = 'refused bridge code from outside the app';
    log(reason);
    return { api: unavailableApi(reason), mode: 'error', reason };
  }
  try {
    const options = selfTest ? { ...(bootOptions ?? {}), ...(await selfTestBootOptions({ root, paths, importer, exists })) } : bootOptions;
    const started = await assembleBridge({ root, paths, log, platform, openExternal, importer, bootOptions: options });
    if (!selfTest) return { api: wrapApi(started.api, { stop: started.stop }), mode: 'real', reason: null };
    const report = await sandboxReport(started, { root, packaged, importer, paths });
    if (started.bridge) await Promise.resolve(started.stop?.()).catch(() => {});
    return { api: wrapApi(started.api, { stop: started.stop }), mode: 'real', reason: 'self-test', report };
  } catch (e) {
    const reason = redactText(`the bridge failed to start: ${e?.message ?? e}`);
    log(reason);
    return { api: unavailableApi(reason), mode: 'error', reason };
  }
}
