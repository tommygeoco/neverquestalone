// Booting the public bridge (public BYOK PRD §5.1, §8.1, §8.4, §11.2, §12.3 TH10/TH15, SC-1,
// KY-6/KY-7/KY-9; BUILD-PLAN "boot.mjs"): the one assembly. The desktop app runs it
// (app/desktop/src/api-loader.mjs), and so does the developer command line from a checkout
// (bridge/nqa.mjs start: headless, with a key store in memory). There is no control pipe (systems
// plan D6): keys, sign-in, usage and diagnostics are the app's window, and nothing else answers for them.
//
//   bootByok({ paths, platform, log, openExternal, config?, configFile?, keystore?, fetch?, capture,
//              importer?, egress, ... })
//     paths = { userData, state?, logs?, version?, captureApp?, captureExe?, captureScript?, captureTeamId? }
//     (the capture helper's path in a packaged app's Resources, and the Mac app's own Developer ID
//     team, which its helper must be signed by)
//     → { api, bridge, backend, keystore, config, egress, stop(), restart() }
//
// In order: the config (<userData>/config.json unless one is passed); the key store ('os', service
// 'NeverQuestAlone', every key it reads registered with log.addSecret before use; outside the app
// (plain node: a test, a script) only a key store the caller passes, since a Keychain item written
// through node's identity is readable by any script node runs; on Linux without a Secret Service,
// and on Windows when Credential Manager or its binding can't be used, it fails closed to this
// session's memory, which the window says); the egress guard (security/egress.mjs guardedFetch),
// whose allowlist is the chosen provider's manifest hosts (Other's: the one host of the player's
// base URL) and a provider's hosts while its key is tested, with loopback always allowed (a model
// server on this computer), and whose
// ledger feeds connections(); the bundled manifests and prices (a change to either ships with an
// app update); the single-bridge lock for the AddOns folder (refused while another bridge serves
// it, an older build's included; lock.mjs); the backend (createLocalBackend) inside the core
// (createBridge), started, with the player's effort; the capture helper
// (transport/capture.mjs) unless capture:false; the app API. stop() undoes all of it in reverse,
// and twice is once. A stopped boot stays stopped: its API says the app needs a restart (status's
// not_running, reason app_stopped) and its guard refuses every request with EGRESS_STOPPED, whose
// words say so too; the desktop shell stops it only for a committed quit, and boots again if the
// process lives on (app/desktop/src/quit.mjs, src/api-loader.mjs createLiveApi; fix-102).
// With no WoW folder, or no addon in it yet, the backend runs alone (keys, provider, usage work);
// installAddon then calls restart(), which builds the bridge for the folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfigOrReset, configWithDefaults, migrateByokCaps, migrateLegacyProvider, saveConfig as saveConfigFile, REPO } from '../config.mjs';
import { createBridge } from '../service.mjs';
import { slotInterface } from '../transport/slots.mjs';
import { createLocalBackend } from './backend.mjs';
import { listOnlyState } from './runtime/context.mjs';
import { createAppApi } from './app-api.mjs';
import { createPatchDay } from './patchday.mjs';
import { pidAlive, takeBridgeLock, HEARTBEAT_MS, IDLE_HEARTBEAT_MS } from './lock.mjs';
import { publicPaths, captureSocketPath } from './paths.mjs';
import { findWow, wowRoots, recordAddonFolder, wowRunningAsync, FOREVER_FLAVORS, NOT_GAME } from './wow.mjs';
import { loadManifests, manifestFor } from './providers/index.mjs';
import { createKeyStore, SERVICE } from './security/keystore.mjs';
import { createEgress, isLoopbackHost, normHost } from './security/egress.mjs';
import { redact } from './security/redact.mjs';
import { createPriceBook } from './usage/prices.mjs';
import { createSignIns } from './signin/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_MODULE = path.join(HERE, '..', 'transport', 'capture.mjs');

export const LOG_RING = 200;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function bootError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The single-bridge lock (lock.mjs), named here too for the callers that already import it.
export { pidAlive, takeBridgeLock };

/** This account's own home folder: the password database's, which $HOME doesn't move; null when unknown. */
export function accountHome() {
  try { return os.userInfo().homedir || null; } catch { return null; }
}

/** Is `home` this account's own home folder? (A temp HOME, a sandbox's, isn't.) */
export function isAccountHome(home, real = accountHome(), platform = process.platform) {
  if (!home || !real) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = d => { const r = p.resolve(String(d)); return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r; };
  return norm(home) === norm(real);
}

/** The WoW roots findWow may search from a sandbox (a HOME that isn't the account's own): the ones inside it. */
export function sandboxRoots({ platform, env, home, run }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const inside = (r) => { const rel = p.relative(p.resolve(home), p.resolve(r)); return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel); };
  return wowRoots({ platform, env, home, ...(run ? { run } : {}) }).filter(inside);
}

/**
 * The WoW folder a config names, or null: only a folder the config names skips findWow. There is no
 * default one (config.mjs DEFAULTS.wow.flavorDir is null): a default is a real game's folder on some
 * machine, and a bridge that took one published its slots into whatever game sat there. The retired
 * default (a folder on its author's Mac) isn't one either: a build before the C3 review filled it in
 * and saved it into a config nobody pointed at a folder, so that config names none.
 */
const RETIRED_DEFAULT_FLAVOR_DIR = '/Applications/World of Warcraft/_classic_beta_';
export function givenFlavorDir(dir) {
  return typeof dir === 'string' && dir !== '' && dir !== RETIRED_DEFAULT_FLAVOR_DIR ? dir : null;
}

/**
 * The backend as the core sees it, with the player's privacy switches applied live (§13.1):
 * - game context: off, a typed turn goes without the context lines and the state; on, it goes
 *   with them, even when the core was built while it was off (the core reads the setting once).
 * - echo: the slot carries bridge.echo 'on'|'off' (cap 'echo', PR-1, TH13) for the addon, which
 *   puts no reply lines in the chat frame while it's 'off'.
 * - companion: the slot's bridge.usage.autoOn is the app's companion switch (§9.4: off until the
 *   player turns it on), which the addon needs before it sends an event or the state on its own; a
 *   typed message's state then is the quest log alone. The bridge holds it too (PRIVACY.md, audit
 *   CV-01, QL-F-14): off, a typed turn's state is only its game information (listOnlyState: the
 *   character, the place and every quest's id, title and ready flag), never objectives, quest chains,
 *   gear or points of interest, whatever the addon sent or the core kept from while it was on; the context
 *   lines (game information, game context's switch) still go.
 * Both are read at every publish, so a setPrivacy (whose backend.setConfig makes the core publish)
 * shows in game at once. Every other part of the backend is passed through untouched.
 *
 * Every turn the core sends goes through send() here: the core calls the backend's send directly, by
 * chat id (code health BR-22), so this is where the switches hold. A core handed the backend itself
 * would send game context with it off, and companion information with the companion off.
 */
export function withPrivacy(backend, privacy) {
  const read = () => { try { return privacy() ?? {}; } catch { return {}; } };
  const out = Object.defineProperties({}, Object.getOwnPropertyDescriptors(backend));
  out.send = args => backend.send(privateTurn(args, read()));
  if (typeof backend.slotExtras === 'function') {
    out.slotExtras = () => {
      const x = backend.slotExtras();
      if (!isObj(x)) return x;
      const b = isObj(x.bridge) ? x.bridge : {};
      const caps = Array.isArray(b.caps) ? b.caps : [];
      const p = read();
      const usage = isObj(b.usage) ? { usage: { ...b.usage, autoOn: p.companion === true } } : {};
      const withCaps = ['echo', 'reading'].reduce((list, c) => (list.includes(c) ? list : [...list, c]), caps);
      // reading: the app's Screen Reading switch; off, the addon draws nothing and its messages go by its saved data.
      return { ...x, bridge: { ...b, ...usage, caps: withCaps, echo: p.echo === true ? 'on' : 'off', reading: p.screenReading === false ? 'off' : 'on' } };
    };
  }
  return out;
}

/**
 * A send's args ({chatId, idem, turn, thinking}) as the privacy switches let a typed turn go: game
 * context off, no context lines and no state; on, the context lines (useContext again, whatever the
 * core read at its start), and with the companion off only the state's game information
 * (listOnlyState). An event or a recap passes as it is (its own opt-in). The caller's args stay as
 * they were.
 */
export function privateTurn(args, pv = {}) {
  let p = args;
  if (!isObj(p?.turn) || (p.turn.kind ?? 'msg') !== 'msg') return p;
  if (pv.gameContext === false) {
    const { state: _state, ...rest } = p.turn;
    return { ...p, turn: { ...rest, useContext: false, contextLines: null } };
  }
  if (pv.companion !== true && 'state' in p.turn) {
    const { state, ...rest } = p.turn;
    p = { ...p, turn: isObj(state) ? { ...rest, state: listOnlyState(state) } : rest };
  }
  if (p.turn.useContext === false) p = { ...p, turn: { ...p.turn, useContext: true } };
  return p;
}

/** A key store whose every key read or written is registered with the log's redactor first (KY-9). */
export function secretKeystore(ks, log) {
  const note = (k) => { if (typeof k === 'string' && k) { try { log.addSecret?.(k); } catch { /* the patterns still apply */ } } return k; };
  return Object.freeze({
    backend: ks.backend,
    persistent: ks.persistent,
    label: ks.label,
    get: async (p) => note(await ks.get(p)),
    set: async (p, k) => { note(k); return ks.set(p, k); },
    delete: p => ks.delete(p),
    list: (ps) => ks.list(ps),
    probe: () => ks.probe?.() ?? Promise.resolve({ ok: true }),
  });
}

/**
 * A log that also keeps its last lines (redacted) for the diagnostics bundle. Each line is redacted
 * once (code health BR-21; it was three times, four redact passes in the app): with the host's
 * redactor when it has one (log.scrub: the app's covers the bridge's patterns, the home folder and
 * every key it knows), else the bridge's own; and a host that takes a line already redacted (log.line:
 * the app's) gets that one instead of (event, data) to redact again.
 */
function ringLog(log) {
  const ring = [];
  const scrub = (s) => {
    if (typeof log.scrub === 'function') { try { return String(log.scrub(String(s))); } catch { /* the patterns below */ } }
    return redact(String(s));
  };
  const out = (event, data) => {
    let body;
    try { body = `${event}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`; } catch { body = `${event} [unprintable]`; }
    const line = scrub(body);
    try { if (typeof log.line === 'function') log.line(line); else log(event, data); } catch { /* logging never breaks the bridge */ }
    ring.push(`${new Date().toISOString()} ${line}`);
    if (ring.length > LOG_RING) ring.shift();
  };
  out.addSecret = s => log.addSecret?.(s);
  out.scrub = scrub;
  out.lines = () => ring.slice();
  return out;
}

const defaultImporter = p => import(pathToFileURL(p).href);

/**
 * A saved OpenRouter, Ollama or LM Studio choice, as Other (custom) with its base URL: the config
 * migrated in place and saved once (save), and a saved OpenRouter key moved to Other's entry in the
 * key store. A key store that can't be read leaves the OpenRouter key where it is (Other then asks
 * for one).
 */
export async function migrateLegacy(config, keystore, { log = () => {}, save = null } = {}) {
  const was = config.byok?.provider;
  if (was !== 'openrouter' && was !== 'ollama' && was !== 'lmstudio') return null;
  let orKey = null;
  if (was === 'openrouter') { try { orKey = await keystore.get('openrouter'); } catch { orKey = null; } }
  const hadAuth = !!config.byok?.authBy?.openrouter;
  const { byok, from } = migrateLegacyProvider(config.byok, { openRouterKey: !!orKey || hadAuth });
  if (!from) return null;
  config.byok = byok;
  if (orKey && byok.provider === 'custom') {
    try {
      if (!(await keystore.get('custom'))) await keystore.set('custom', orKey);
      await keystore.delete('openrouter');
    } catch (e) { log('byok-key-move-failed', { from, error: e?.code || 'keystore_error' }); }
  }
  if (typeof save === 'function') {
    try { save(config); } catch (e) { log('byok-config-save-error', { error: redact(String(e?.message ?? e)).slice(0, 160) }); }
  }
  log('byok-provider-migrated', { from, to: byok.provider });
  return { from, to: byok.provider };
}

export async function bootByok(opts = {}) {
  const {
    paths: given = {}, platform = process.platform, env = process.env, home = os.homedir(), openExternal = null,
    fetch = undefined, capture: wantCapture = true, importer = defaultImporter,
    egress: wantEgress = true, manifests: givenManifests = null,
    priceBook: givenPriceBook = null, providerOpts = undefined, wow = {}, alive = pidAlive,
    lockDir: givenLockDir = null, createCapture = null, backendOptions = null,
    signalTimings = null, captureThresholds = null, realHome = accountHome(), electron = !!process.versions.electron, keystoreFactory = createKeyStore,
  } = opts;
  const pub = publicPaths({ platform, env, home });
  const P = {
    ...given,
    userData: given.userData ?? pub.data,
    state: given.state ?? path.join(given.userData ?? pub.data, 'bridge'),
    logs: given.logs ?? pub.logs,
  };
  const log = ringLog(opts.log ?? (() => {}));
  const configFile = opts.configFile ?? path.join(P.userData, 'config.json');
  // A config.json that can't be read is moved aside and the app starts on the defaults, saying so
  // once in the window (SY-12); keys are in the OS store, so they're kept.
  const loaded = opts.config ? { config: opts.config, reset: null } : loadConfigOrReset(configFile);
  if (loaded.reset) log('byok-config-reset', { keptAs: loaded.reset.keptAs ? path.basename(loaded.reset.keptAs) : null });
  const config = configWithDefaults(loaded.config);
  // No usage limits of the build's own (maintainer, 2026-09-26; spec §9.9): a spend cap only when the player
  // set one (config.mjs migrateByokCaps). A saved section without v: 2 is written back below, once.
  config.byok = isObj(config.byok) ? config.byok : {};
  const capsToWrite = !opts.config && config.byok.caps?.v !== 2 && fs.existsSync(configFile);
  config.byok.caps = migrateByokCaps(config.byok.caps);
  config.wow = { ...(config.wow || {}), flavorDir: givenFlavorDir(config.wow?.flavorDir) };
  // The WoW folder the addon went into, for the Windows uninstaller (uninstall.ini; audit CV-07): at
  // each save of the settings (installAddon saves a new folder) and at start, for installs made before.
  const noteAddonFolder = (dir) => {
    if (!dir) return;
    try { recordAddonFolder({ userData: P.userData, flavorDir: dir, platform }); } catch (e) { log('byok-uninstall-record-failed', { error: e?.code || 'failed' }); }
  };
  const saveConfig = (cfg) => {
    saveConfigFile({ wow: { flavorDir: cfg.wow?.flavorDir, account: cfg.wow?.account ?? '' }, byok: cfg.byok }, configFile);
    noteAddonFolder(cfg.wow?.flavorDir);
  };
  if (capsToWrite) {
    try { saveConfig(config); log('byok-caps-migrated', { limit: config.byok.caps.dailyUsd !== null }); } catch (e) { log('byok-config-save-error', { error: redact(String(e?.message ?? e)).slice(0, 160) }); }
  }
  fs.mkdirSync(P.userData, { recursive: true, mode: 0o700 });
  fs.mkdirSync(P.state, { recursive: true, mode: 0o700 });
  noteAddonFolder(config.wow.flavorDir);

  const undo = []; // what stop() runs, last first
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    while (undo.length) {
      const fn = undo.pop();
      try { await fn(); } catch (e) { log('byok-stop-error', { error: redact(String(e?.message ?? e)).slice(0, 160) }); }
    }
  };

  try {
    // ---- keys (KY-2, KY-9): the OS store, under the app's own signed identity
    let keystoreNote = null;
    let ks = opts.keystore ?? null;
    // Outside the app (a stock node): a Keychain item written through node's code identity is
    // readable by any script any official node runs, with no prompt (§8.1 "Never"), so boot takes
    // only a key store its caller passes there. There is no headless bridge (systems plan D6).
    if (!ks && !electron) throw bootError('NOT_THE_APP', 'the public bridge runs inside the NeverQuestAlone app; pass a key store to boot it anywhere else');
    ks ??= keystoreFactory({ backend: 'os', service: SERVICE, platform });
    if (!opts.keystore && platform !== 'darwin') {
      // Linux without a Secret Service; Windows where Credential Manager, or the keyring binding
      // itself (Smart App Control refuses an unsigned .node), can't be used: this session's memory,
      // never a file, and the window says the key is kept until the app quits (status().keys).
      const probe = await ks.probe().catch(e => ({ ok: false, code: e.code }));
      if (!probe.ok && (probe.code === 'no_secret_service' || (platform === 'win32' && probe.code === 'keystore_unavailable'))) {
        ks = keystoreFactory({ backend: 'memory' });
        keystoreNote = probe.code === 'no_secret_service' ? 'no Secret Service: keys are kept for this session only' : 'Credential Manager unavailable: keys are kept for this session only';
        log('byok-keystore', { backend: 'memory', reason: probe.code });
      }
    }
    const keystore = secretKeystore(ks, log);

    // ---- OpenRouter, Ollama and LM Studio chosen before Other (custom) replaced them: Other with
    // their base URL, an OpenRouter key moved to Other's entry (config.mjs migrateLegacyProvider)
    await migrateLegacy(config, keystore, { log, save: opts.config ? null : saveConfig });

    // ---- egress (KY-6, KY-7): one guarded fetch for everything that reaches a provider; its
    // allowlist is read on every request, so it follows choose()
    const widened = new Map();
    let manifests = givenManifests;
    // Other's manifest is the player's own (its one host), built from byok.custom on every read.
    const byId = id => manifestFor(id, manifests ?? [], config.byok?.custom);
    const allowHosts = () => {
      const m = new Map();
      const add = (h, f) => { const n = normHost(h); if (n && !m.has(n)) m.set(n, f); };
      const cur = byId(config.byok?.provider);
      for (const h of cur?.hosts ?? []) add(h, cur.local ? 'local_model' : 'provider');
      for (const w of widened.values()) for (const h of w.hosts) add(h, w.feature);
      return m;
    };
    const rawFetch = fetch ?? globalThis.fetch;
    let guard = null;
    if (wantEgress) {
      guard = createEgress({
        allowHosts,
        loopbackOk: true,
        featureFor: host => (isLoopbackHost(host) ? 'local_model' : null),
        fetch: rawFetch,
        onEvent: (e) => { if (e.type === 'blocked') log('egress-blocked', { host: e.host, port: e.port, feature: e.feature, ...(e.stopped ? { stopped: true } : {}) }); },
      });
      undo.push(() => guard.uninstall());
    }
    // What every provider call, key test and sign-in fetches with (the raw one only in the
    // self-test's sandbox, which sends nothing).
    const netFetch = guard ? guard.fetch : rawFetch;
    const egress = {
      /** The guarded fetch (the raw one in the self-test's sandbox). */
      fetch: netFetch,
      ledger: () => guard?.ledger() ?? [],
      allowed: host => (guard ? guard.allowed(host) : true),
      /** True once boot's stop ran (it uninstalls the guard): nothing goes until the app starts again (fix-102). */
      stopped: () => stopped || !!guard?.stopped(),
      /** Allow hosts for one job (a sign-in, a key test); returns release(). */
      widen(hosts, feature) {
        const id = Symbol(feature);
        widened.set(id, { hosts: [...(hosts ?? [])], feature: String(feature) });
        return () => widened.delete(id);
      },
    };

    // ---- manifests and prices: the bundled ones (a change ships with an app update)
    manifests = givenManifests ?? loadManifests();
    const priceBook = givenPriceBook ?? createPriceBook();
    // A plan's sign-in (ChatGPT): one session per provider, shared by the backend and the app API.
    const signIns = createSignIns({ keystore, fetch: netFetch, log });

    // ---- the player's privacy choices (§13.1), read where they're used: the core reads byok.privacy
    // itself (automatic turns are opt-in), and withPrivacy below at every send and publish
    const privacy = () => config.byok?.privacy ?? {};

    // ---- the bridge (or the backend alone, until there's a WoW folder)
    const core = { bridge: null, backend: null, capture: null, releaseLock: null, patch: null, game: 'unknown', flavorDir: null };
    let api = null;
    const lockDir = givenLockDir ?? pub.state;
    const backendOpts = () => ({
      config, dataDir: P.userData, keystore, manifests, priceBook, log, fetch: netFetch, signIns,
      ...(providerOpts ? { providerOpts } : {}), ...(backendOptions ?? {}),
    });
    // The core's handlers, with the app's status pushes beside them (every handler the core
    // passes goes through: onReady, onState, onEvent, onResume, onChange).
    const hub = handlers => ({
      ...handlers,
      onState: (s) => { handlers.onState?.(s); api?.changed(); },
      onEvent: (e) => { handlers.onEvent?.(e); if (e?.event === 'chat') api?.changed(); },
      onChange: (o) => { handlers.onChange?.(o); keepSwitchedModel(); api?.changed(); },
    });
    // The start-time model check (PV-3) replaced a model that's gone: the replacement becomes the
    // player's model (saved), so the key test, doctor and the next launch use it and the switch
    // is announced once, not at every start.
    const keepSwitchedModel = () => {
      let n = null;
      try { n = core.backend?.status?.()?.notice ?? null; } catch { n = null; }
      if (n?.kind !== 'model_switched' || typeof n.to !== 'string' || !n.to) return;
      const cur = config.byok?.model || null;
      if (cur === n.to || (cur !== null && cur !== n.from)) return;
      if (!isObj(config.byok)) config.byok = {};
      config.byok.model = n.to;
      try { saveConfig(config); } catch (e) { log('byok-config-save-failed', { error: redact(String(e?.message ?? e)).slice(0, 160) }); }
      log('byok-model-kept', { from: n.from, to: n.to });
    };
    // The WoW folder: the one the config names, else findWow's first (final review L3-1, L4-1):
    // - a named folder that's gone is no folder (wow_not_found): searching would find whatever
    //   game sits in /Applications or Program Files, which a sandbox's config never meant; the
    //   app's find-and-install flow picks a folder again;
    // - from a HOME that isn't this account's own (a temp HOME: a test, a sandbox, a dev run), only
    //   the roots inside that HOME are searched: /Applications and Program Files don't move with
    //   HOME, and neither do the other bridges' locks there.
    const sandboxed = !isAccountHome(home, realHome, platform);
    const resolveFlavorDir = () => {
      const dir = config.wow?.flavorDir;
      if (dir) return fs.existsSync(dir) ? dir : null;
      let roots = wow.roots ?? null;
      if (roots === null && sandboxed) {
        try { roots = sandboxRoots({ platform, env, home, run: wow.run }); } catch { roots = []; }
        log('byok-wow-search', { scope: 'home', reason: 'home_not_account_home', roots: roots.length });
      }
      let found = [];
      try { found = (wow.find ?? findWow)({ platform, env, home, roots, run: wow.run }); } catch { found = []; }
      if (found[0]) { config.wow = { ...(config.wow || {}), flavorDir: found[0].flavorDir, account: '' }; return found[0].flavorDir; }
      return null;
    };

    // ---- screen reading: the capture helper, started and stopped by itself (never the whole core), so a
    // reply in flight is never touched. On while the config allows a helper and the player's Screen
    // Reading switch in the app (byok.privacy.screenReading) isn't off; the addon's own switch is the
    // other half (its session's mode, read by the watchdog).
    // ... and while the addon's own Screen Reading is on: its talking session says pixel, or hasn't said
    // (a fresh install; an older addon). Off there (stream, reload), no helper runs either, so a Mac's
    // Screen Recording indicator goes off with it (the /safety critic's SF-01). A kept token's mode
    // counts at a cold start.
    const sessionReads = () => { const m = core.bridge?.sessionMode?.(); return m !== 'stream' && m !== 'reload'; };
    const readingOn = () => config.capture?.enabled !== false && privacy().screenReading !== false && sessionReads();
    async function startCapture() {
      if (wantCapture === false) return false;
      // The module first, then the checks (SY-03): a switch flipped, a stop or a restart during the
      // import is seen, so no helper starts behind an "off".
      const make = createCapture ?? (await importer(CAPTURE_MODULE)).createCaptureForPlatform;
      if (stopped || !readingOn() || core.capture || !core.bridge) return false;
      const flavorDir = core.flavorDir;
      // None for an app whose identity names no Mac helper (config.mjs), as app-api.mjs's screenRunner reads it.
      const captureApp = P.captureApp ?? (typeof config.capture.app === 'string' && config.capture.app ? (path.isAbsolute(config.capture.app) ? config.capture.app : path.join(REPO, config.capture.app)) : null);
      core.capture = make({
        // A stats line every 10 s (display R0, capture.mjs STATS_SEC): the watchdog's hung and stalled
        // rules count in them.
        platform, intervalMs: config.capture.intervalMs, statsSec: 10, log,
        // Every line reaches the watchdog through the core (D-07): the strip (R6), the game, the
        // helper's status (stats, window, permission, the away line, connecting) and typed errors.
        onPayload: ({ text }) => core.bridge?.handlePayload(text, 'strip'),
        onGame: g => core.bridge?.onGame(g),
        onStatus: s => core.bridge?.onCaptureStatus(s),
        onError: e => core.bridge?.onCaptureError(e),
        // A packaged app gives its helpers' paths in Resources (nothing runs from inside an asar)
        // and the Mac app's Developer ID team, which the helper it ships is signed by. Windows
        // checks no signer at launch (capture.mjs createWindowsCapture; the release job does).
        // The socket moves to the per-user temp folder when <state>/capture.sock is too long for one (PF-07).
        mac: { app: captureApp, socketPath: captureSocketPath(P.state, { env }), teamId: P.captureTeamId ?? config.capture.teamId ?? null },
        // The Windows helper takes a window for the game's only when its exe is in a flavor folder, never
        // a helper exe of the game's, and prefers the one in this WoW folder (display DR-05, D-03).
        windows: {
          ...(P.captureExe ? { exe: P.captureExe } : {}), flavorDirs: FOREVER_FLAVORS, notGame: NOT_GAME,
          ...(typeof flavorDir === 'string' && path.isAbsolute(flavorDir) && fs.statSync(flavorDir, { throwIfNoEntry: false })?.isDirectory() ? { exeDir: flavorDir } : {}),
        },
        linux: { ...(P.captureScript ? { script: P.captureScript } : {}) },
      });
      // The watchdog's restarts, and the kind: no helper for this platform is 'off'.
      const cap = core.capture;
      core.bridge.setCaptureControl({ kind: cap.kind, restart: reason => cap.restart?.(reason) });
      core.capture.start();
      return true;
    }
    function stopCapture() {
      if (!core.capture) return false;
      try { core.capture.stop(); } catch { /* stopping */ }
      core.capture = null;
      // No helper now: the watchdog's control is gone (it reads 'off'), and the game is followed by its
      // pid and the process list (service.mjs checkGamePid, slowCheck).
      try { core.bridge?.setCaptureControl(null); } catch { /* no watchdog */ }
      try { core.bridge?.helperGone?.(); } catch { /* no gate */ }
      return true;
    }
    // The app's Screen Reading switch flipped (app-api setPrivacy): start or stop the helper alone.
    const applyScreenReading = async () => {
      if (restarting) { try { await restarting; } catch { /* the restart said why */ } }
      const changedNow = readingOn() ? await startCapture() : stopCapture();
      if (changedNow) {
        log('screen-reading', { on: !!core.capture });
        api?.rebind({ capture: core.capture });
      }
      return { ok: true, on: !!core.capture };
    };

    async function startCore() {
      const flavorDir = resolveFlavorDir();
      core.flavorDir = flavorDir;
      // Built expecting a helper: then bridge.start() waits for its word, and no helper means asking (SY-14).
      const builtWithHelper = wantCapture !== false && readingOn(); // the helper's game folder (startCapture), for this start
      const addonsDir = flavorDir ? path.join(flavorDir, 'Interface', 'AddOns') : null;
      // No game, or no addon in it yet: nothing to publish to, so the backend runs alone until
      // installAddon (onboarding step 2) calls restart().
      if (!flavorDir || !fs.existsSync(path.join(addonsDir, 'NeverQuestAlone', 'NeverQuestAlone.toc'))) {
        log('byok-no-bridge', { reason: flavorDir ? 'addon_not_installed' : 'wow_not_found' });
        core.backend = createLocalBackend(hub({}), backendOpts());
        await core.backend.start();
        return;
      }
      // One lock (code health BR-27): the AddOns folder's, else this state folder's for it.
      core.releaseLock = takeBridgeLock({ lockDir, addonsDir, platform, alive });
      if (!core.releaseLock.folder) log('byok-folder-lock', { taken: false, reason: 'no real NeverQuestAlone/sig folder to lock', held: 'state folder' });
      // Patch day (SY-29): a new World of Warcraft's interface number, and the installed TOCs set to
      // it; checked at start, at the game's launch and exit, at each hello (the client's own number)
      // and at the slow check while WoW is closed (a stat of .build.info). The window and the tray say
      // so (status().wow.patch); the addon's own line when the TOCs couldn't be written (bridge.patch).
      core.game = 'unknown';
      core.patch = createPatchDay({
        flavorDir, addonsDir, platform, log, ...(wow.run ? { run: wow.run } : {}),
        gameRunning: () => (core.game === 'up' ? true : core.game === 'down' ? false : null),
        onChange: () => { api?.changed(); try { core.bridge?.publisher?.publish({}); } catch { /* the next publish */ } },
      });
      const account = config.wow.account || null;
      core.bridge = createBridge(config, {
        stateDir: P.state, addonsDir, log,
        // Reload mode reads the NeverQuestAlone.lua the game wrote last, looked up at each poll: two WoW
        // accounts, a stale account folder, or none until the first login all work (SY-18). An
        // account named in the config is read alone.
        ...(account
          ? { savedVariablesFile: path.join(flavorDir, 'WTF', 'Account', account, 'SavedVariables', 'NeverQuestAlone.lua') }
          : { wtfDir: path.join(flavorDir, 'WTF') }),
        slotInterface: () => slotInterface(addonsDir),
        // The runaway fuse paused or resumed automatic help, or the typed guard paused or resumed
        // sending: the window's status (the tray's icon, the Resume sending card) changed now.
        onAutoPause: () => api?.changed(),
        onSendPause: () => api?.changed(),
        // A write the disk refused, or made again (code health BR-11): the window's card for chats that
        // can't be saved (status().store.writeError) comes and goes now, not at the next status change.
        onHealthChange: () => api?.changed(),
        // The capture watchdog (transport/capture-health.mjs; display DR-04): the one source of what the
        // game's setup row and warn line name (bridge.capture, cap capture) and of the window's screen
        // card, and what starts a helper over. Screen reading turned off in the app is 'off'. A host
        // that feeds the strip itself (capture: false, as the tests do) has none and says nothing.
        ...(wantCapture !== false ? {
          // Tests only: shorter waits (capture-health.mjs HEALTH).
          captureHealth: { platform, off: () => !readingOn(), ...(captureThresholds ? { thresholds: captureThresholds } : {}) },
          // The window hears a change of what it shows, never a stats line (SY-10).
          onCaptureChange: () => api?.changed(),
        } : {}),
        // Tests only: shorter doorbell pulses (transport/signals.mjs pulseMs, actGapMs).
        ...(signalTimings ? { signalsOpts: { pulseMs: signalTimings.pulseMs, actGapMs: signalTimings.actGapMs } } : {}),
        // No idle work while WoW is closed (SY-30): the core's in-game work follows the game, which the
        // capture helper reports (its {game} lines) while it's connected; with Screen Reading off, or no
        // helper, the process list says (async, off the main thread), and the game's pid it names is
        // followed until it exits. The lock beats every minute while the game is closed, every 30 s
        // while it runs.
        gameGate: true,
        gameHelper: builtWithHelper,
        gameReported: () => {
          let cs = null;
          try { cs = core.capture?.status?.() ?? null; } catch { cs = null; }
          return !!cs && cs.kind !== 'none' && cs.connected === true;
        },
        gameCheck: async () => {
          const r = await (wow.running ?? wowRunningAsync)({ platform, flavorDir, run: wow.run });
          return { running: r?.running === true, pids: Array.isArray(r?.pids) ? r.pids : [] };
        },
        onGameState: (state) => {
          core.game = state;
          try { core.releaseLock?.pace?.(state === 'up' ? HEARTBEAT_MS : IDLE_HEARTBEAT_MS); } catch { /* the next beat */ }
          try { if (state === 'up') core.patch?.gameUp(); else core.patch?.gameDown(); } catch (e) { log('patch-day-error', { error: String(e?.code || e?.message || e).slice(0, 80) }); }
        },
        onSlowCheck: () => core.patch?.tick(),
        onClientInterface: iface => core.patch?.heard(iface),
        patchState: () => (core.patch?.notice()?.failed ? 'failed' : null),
        // The slot files are written by a worker thread, not the window's (code health BR-04,
        // write-queue.mjs); one that can't start leaves them written in place. The same thread
        // writes the outbox, state.json and the ledger, in one ordered queue (BR-04, durable writes): the
        // core hands the backend its queue (shared.writer).
        publisherOpts: { worker: true },
        // The addon's Screen Reading changed (its session's mode): the helper stops or starts with it (SF-01).
        onSessionMode: () => { applyScreenReading().catch(e => log('screen-reading-error', { error: String(e?.message ?? e).slice(0, 120) })); },
        gatewayFactory: (handlers, shared) => {
          core.backend = createLocalBackend(hub(handlers), { ...backendOpts(), ...(shared?.writer ? { writer: shared.writer } : {}) });
          return withPrivacy(core.backend, privacy);
        },
      });
      core.bridge.start();
      if (!core.backend) throw bootError('NO_BACKEND', 'the bridge started without a backend');
      try { core.patch.check({ reason: 'start' }); } catch (e) { log('patch-day-error', { error: String(e?.code || e?.message || e).slice(0, 80) }); }
      await startCapture();
      // No helper at the start (screen reading off here or in the addon): the game gate asks the process list.
      if (!core.capture && builtWithHelper) { try { core.bridge?.helperGone?.(); } catch { /* no gate */ } }
      log('byok-bridge-started', { capture: !!core.capture, slots: config.transport?.slots ?? 200 });
    }
    async function stopCore() {
      try { core.capture?.stop(); } catch { /* stopping */ }
      core.capture = null;
      // Detached before it stops, so a helper start in flight sees no bridge (SY-03).
      const bridge = core.bridge;
      core.bridge = null;
      if (bridge) await bridge.stop();
      else await core.backend?.stop();
      core.backend = null;
      core.releaseLock?.();
      core.releaseLock = null;
      core.patch = null;
    }
    // A new WoW folder (installAddon): the bridge again, for it.
    let restarting = null;
    const restart = () => {
      restarting ??= (async () => {
        try {
          await stopCore();
          try { await startCore(); } catch (e) {
            // Keep the API working (keys, provider, usage) with the backend alone, and say why.
            await stopCore().catch(() => {});
            core.backend = createLocalBackend(hub({}), backendOpts());
            await core.backend.start();
            throw e;
          }
        } finally {
          api?.rebind({ bridge: core.bridge, backend: core.backend, capture: core.capture });
          restarting = null;
        }
      })();
      return restarting;
    };

    undo.push(() => stopCore()); // before starting: a start that fails half way is undone too
    await startCore();

    // ---- the app API
    api = createAppApi({
      bridge: core.bridge, backend: core.backend, capture: core.capture, keystore, config, paths: P, log, openExternal,
      egress, saveConfig, manifests, priceBook, fetch: netFetch, platform, env, home, signIns,
      logLines: () => log.lines(), restart, halt: stopCore, wow, keystoreNote, version: P.version ?? null,
      settingsReset: !!loaded.reset, patchDay: () => core.patch?.notice() ?? null, configFile, screenReading: applyScreenReading,
    });
    undo.push(() => api.stop());
    log('byok-boot', { bridge: !!core.bridge, capture: !!core.capture, egress: !!guard, keystore: keystore.label ?? keystore.backend });

    return {
      api,
      get bridge() { return core.bridge; },
      get backend() { return core.backend; },
      get capture() { return core.capture; },
      keystore,
      config,
      egress,
      restart,
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
