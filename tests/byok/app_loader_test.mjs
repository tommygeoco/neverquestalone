// The app on the real API (BUILD-PLAN "Desktop app", "boot.mjs"; PRD §11.1, §11.2 SC-9; fork
// PRD §9.10 capture): main.mjs → src/api-loader.mjs → bridge/byok/boot.mjs bootByok, for real,
// in temp folders. With a WoW folder that holds the addon, boot starts the capture helper itself,
// on macOS through the capture app (its bundle, beside app.asar in a packaged app); the
// self-test boots the same bridge in a sandbox with capture off, no WoW folder, no control pipe
// and a memory key store. A stand-in capture helper; canary-free (no key is set); nothing here
// reads the real config, the real keychain or a real AddOns folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as loader from '../../app/desktop/src/api-loader.mjs';
import { loadApi, selfTestBridge, captureAppPath, captureHelperPaths, ownTeamId, CAPTURE_APP_NAME, CAPTURE_HELPERS, KEYSTORE_FILE, BRIDGE_FILES } from '../../app/desktop/src/api-loader.mjs';
import { installAddon } from '../../bridge/byok/wow.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { REPO, DEFAULTS } from '../../bridge/config.mjs';
import { IDENTITY } from '../../bridge/identity.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const NOT_RUNNING = () => ({ status: 1, stdout: '' });
const NO_CHECKS = { checks: { models: false } };

function tmp(t, prefix = 'bones-loader-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A WoW install in a temp folder with the addon and 3 slots. */
function wowWithAddon(root) {
  const flavorDir = path.join(root, 'wow', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  assert.equal(installAddon({ flavorDir, running: false, slots: 3 }).ok, true);
  return flavorDir;
}

/** A stand-in for transport/capture.mjs createCaptureForPlatform, recording what boot asks of it. */
function fakeCapture() {
  const calls = [];
  const make = (opts) => {
    const c = { opts, started: 0, stopped: 0 };
    calls.push(c);
    return { kind: opts.platform === 'darwin' ? 'mac' : opts.platform, start() { c.started += 1; }, stop() { c.stopped += 1; }, status: () => ({ connected: false, permission: null }) };
  };
  return { calls, make };
}

function bootOpts(root, { flavorDir, createCapture, ...extra } = {}) {
  return {
    keystore: createKeyStore({ backend: 'memory' }),
    config: { wow: { flavorDir: flavorDir ?? path.join(root, 'no-wow') }, transport: { slots: 3 }, byok: { provider: 'anthropic' } },
    configFile: path.join(root, 'ud', 'config.json'), home: path.join(root, 'home'), env: {},
    egress: false, lockDir: path.join(root, 'locks'),
    wow: { run: NOT_RUNNING, roots: [] }, backendOptions: NO_CHECKS,
    ...(createCapture ? { createCapture } : {}),
    ...extra,
  };
}
const pathsIn = (root, extra = {}) => ({ userData: path.join(root, 'ud'), state: path.join(root, 'ud', 'bridge'), logs: path.join(root, 'logs'), version: '0.1.0-test', ...extra });

// The app's names are its identity's (bridge/identity.mjs); HELPER is its Mac screen-reading helper, or
// null for an app without one (the example's), whose boot without one is lane 4's.
const HELPER = IDENTITY.captureHelper;
const NO_HELPER = HELPER ? false : 'an app without a Mac capture helper (its boot without one is lane 4\'s)';
const RESOURCES = `/Applications/${IDENTITY.productName}.app/Contents/Resources`;

test('captureAppPath: a packaged Mac app’s Resources; boot’s default (the repo’s build) otherwise; none for an app without a helper', () => {
  assert.equal(CAPTURE_APP_NAME, HELPER ? `${HELPER.app}.app` : null);
  const res = RESOURCES;
  assert.equal(captureAppPath({ packaged: true, platform: 'darwin', resourcesPath: res }), HELPER ? path.join(res, `${HELPER.app}.app`) : undefined);
  assert.equal(captureAppPath({ packaged: false, platform: 'darwin', resourcesPath: res }), undefined);
  assert.equal(captureAppPath({ packaged: true, platform: 'win32', resourcesPath: 'C:\\x' }), undefined);
});

test('captureHelperPaths and ownTeamId: each OS\'s helper in a packaged app\'s Resources, and the Mac app\'s own team (C3 review)', async () => {
  const res = RESOURCES;
  assert.deepEqual(captureHelperPaths({ packaged: true, platform: 'darwin', resourcesPath: res }), HELPER ? { captureApp: path.join(res, `${HELPER.app}.app`) } : {});
  assert.deepEqual(captureHelperPaths({ packaged: true, platform: 'win32', resourcesPath: '/r' }), { captureExe: path.join('/r', 'capture', 'nqa-capture.exe') });
  assert.deepEqual(captureHelperPaths({ packaged: true, platform: 'linux', resourcesPath: '/r' }), { captureScript: path.join('/r', 'capture', 'capture_x11.py') });
  assert.deepEqual(captureHelperPaths({ packaged: false, platform: 'linux', resourcesPath: '/r' }), {}, 'a development run: boot\'s defaults, the repo\'s');
  assert.deepEqual(captureHelperPaths({ packaged: true, platform: 'freebsd', resourcesPath: '/r' }), {});
  // The team: codesign's TeamIdentifier for the bundle the running binary is in, never "not set".
  const exe = `/Applications/${IDENTITY.productName}.app/Contents/MacOS/${IDENTITY.productName}`;
  const asked = [];
  const run = out => (bin, args) => { asked.push([bin, ...args]); return { status: 0, stdout: '', stderr: out }; };
  assert.equal(ownTeamId({ packaged: true, platform: 'darwin', execPath: exe, run: run(`Identifier=${IDENTITY.appId}\nTeamIdentifier=AB12CD34EF\n`) }), 'AB12CD34EF');
  assert.deepEqual(asked[0], ['/usr/bin/codesign', '-dv', '--verbose=2', `/Applications/${IDENTITY.productName}.app`]);
  assert.equal(ownTeamId({ packaged: true, platform: 'darwin', execPath: exe, run: run('Signature=adhoc\nTeamIdentifier=not set\n') }), null, 'ad hoc');
  assert.equal(ownTeamId({ packaged: true, platform: 'darwin', execPath: exe, run: () => { throw new Error('no codesign'); } }), null);
  assert.equal(ownTeamId({ packaged: false, platform: 'darwin', execPath: exe, run: run('TeamIdentifier=AB12CD34EF') }), null);
  assert.equal(ownTeamId({ packaged: true, platform: 'win32', execPath: 'C:\\x.exe', run: run('TeamIdentifier=AB12CD34EF') }), null);
  // Windows checks no signer at launch (SY-09: the signer plumbing is gone; the release job checks signatures).
  assert.equal(loader.ownPublisher, undefined);
  // main.mjs hands them to boot.
  const main = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  assert.match(main, /\.\.\.captureHelperPaths\(\{ packaged: app\.isPackaged, platform: process\.platform, resourcesPath: process\.resourcesPath \}\),\n    captureTeamId: ownTeamId\(\{ packaged: app\.isPackaged, platform: process\.platform \}\),\n  \};/);
  assert.doesNotMatch(main, /captureSigner|ownPublisher/);
  // The build ships each one where these paths say (electron-builder.yml, the Mac helper's entry from
  // the identity: scripts/plugin-config.mjs; and fuses.cjs checks it).
  const { pluginConfig } = await import('../../app/desktop/scripts/plugin-config.mjs');
  const yml = fs.readFileSync(path.join(APP, 'electron-builder.yml'), 'utf8')
    + (pluginConfig().mac?.extraResources ?? []).map(r => `  - from: ${r.from}\n    to: ${r.to}\n`).join('');
  // A file entry (to: <file>), or its folder with a filter naming only it (to: <folder>, filter: <name>;
  // how the Windows helper ships, so electron-builder signs it: SY-20).
  const shipsAt = file => yml.includes(`to: ${file}\n`)
    || new RegExp(`to: ${path.posix.dirname(file)}\\n\\s+filter:\\n\\s+- ${path.posix.basename(file).replace(/[.]/g, '\\.')}\\n(?!\\s+- )`).test(yml);
  for (const [os_, h] of Object.entries(CAPTURE_HELPERS)) assert.ok(shipsAt(h.file), `${os_}: ${h.file} in extraResources`);
});

test('boot runs a packaged app\'s capture helpers from its Resources; the Mac one signed by the app\'s own team (C3 review)', async (t) => {
  for (const platform of HELPER ? ['darwin', 'win32', 'linux'] : ['win32', 'linux']) {
    const root = tmp(t);
    const flavorDir = wowWithAddon(root);
    const cap = fakeCapture();
    const res = path.join(root, 'Resources');
    const paths = pathsIn(root, { ...captureHelperPaths({ packaged: true, platform, resourcesPath: res }), captureTeamId: platform === 'darwin' ? 'AB12CD34EF' : null });
    const out = await loadApi({ appDir: APP, env: {}, paths, platform, bootOptions: bootOpts(root, { flavorDir, createCapture: cap.make }) });
    assert.equal(out.mode, 'real', out.reason);
    const { opts } = cap.calls[0];
    if (platform === 'darwin') {
      assert.equal(opts.mac.app, path.join(res, `${HELPER.app}.app`));
      assert.equal(opts.mac.teamId, 'AB12CD34EF', 'the app\'s own Developer ID team');
    }
    if (platform === 'win32') {
      assert.equal(opts.windows.exe, path.join(res, 'capture', 'nqa-capture.exe'));
      assert.equal(opts.windows.signer, undefined, 'no signer at launch (SY-09)');
    }
    if (platform === 'linux') assert.equal(opts.linux.script, path.join(res, 'capture', 'capture_x11.py'));
    await out.api.stop();
  }
});

test('the real API: loadApi boots bridge/byok/boot.mjs; with WoW and the addon, capture starts inside boot on macOS through the capture app', { skip: NO_HELPER }, async (t) => {
  const root = tmp(t);
  const flavorDir = wowWithAddon(root);
  const cap = fakeCapture();
  const captureApp = path.join(root, `${IDENTITY.productName}.app`, 'Contents', 'Resources', CAPTURE_APP_NAME);
  const paths = pathsIn(root, { captureApp });
  const lines = [];
  // The capture watchdog names a typed error once it has lasted its wait (display DR-04): none here.
  const out = await loadApi({ appDir: APP, packaged: false, env: {}, paths, platform: 'darwin', log: l => lines.push(l), bootOptions: bootOpts(root, { flavorDir, createCapture: cap.make, captureThresholds: { typedWaitMs: 0 } }) });
  t.after(() => out.api.stop());
  assert.equal(out.mode, 'real', out.reason);
  assert.equal(out.api.mock, false);
  assert.equal(cap.calls.length, 1, 'one capture helper');
  const { opts } = cap.calls[0];
  assert.equal(opts.platform, 'darwin');
  assert.equal(opts.mac.app, captureApp, 'the capture app the shell names');
  assert.equal(opts.mac.socketPath, path.join(paths.state, 'capture.sock'), 'its socket under the app’s bridge state');
  assert.equal(opts.mac.teamId, null);
  assert.equal(typeof opts.onPayload, 'function');
  assert.equal(typeof opts.onGame, 'function');
  assert.equal(typeof opts.onError, 'function');
  assert.equal(cap.calls[0].started, 1, 'started');
  const st = await out.api.status();
  assert.equal(st.bridge.running, true);
  assert.equal(st.wow.addon, true);
  assert.deepEqual([st.capture.state, st.capture.mode], ['waiting', 'capture']);
  // A typed error reaches the window through the watchdog (the one publisher, SY-20), at the core's next
  // 2 s tick, in the state the contract maps it to; a kind the contract doesn't know names nothing.
  opts.onError({ kind: 'no_permission_yet', message: 'a later helper\'s kind' });
  opts.onError({ kind: 'signature_invalid', message: 'the capture app does not satisfy the code requirement' });
  const deadline = Date.now() + 5000;
  let state = null;
  while (Date.now() < deadline && (state = (await out.api.status()).capture.state) !== 'damaged') await new Promise(r => setTimeout(r, 50));
  assert.equal(state, 'damaged', 'typed capture errors reach the window');
  assert.ok(lines.some(l => /bridge byok-bridge-started \{"capture":true/.test(l)), 'the shell log says so');
  await out.api.stop();
  assert.equal(cap.calls[0].stopped, 1, 'stopped with the app');
});

test('a development run with no capture app named: boot uses the repo’s build of it', { skip: NO_HELPER }, async (t) => {
  const root = tmp(t);
  const flavorDir = wowWithAddon(root);
  const cap = fakeCapture();
  const out = await loadApi({ appDir: APP, env: {}, paths: pathsIn(root), platform: 'darwin', bootOptions: bootOpts(root, { flavorDir, createCapture: cap.make }) });
  t.after(() => out.api.stop());
  assert.equal(out.mode, 'real', out.reason);
  assert.equal(cap.calls[0].opts.mac.app, path.join(REPO, DEFAULTS.capture.app));
});

test('capture off: no WoW folder, no addon, capture:false or capture.enabled false start no helper', async (t) => {
  const root = tmp(t);
  const cap = fakeCapture();
  const noWow = await loadApi({ appDir: APP, env: {}, paths: pathsIn(root), platform: 'darwin', bootOptions: bootOpts(root, { createCapture: cap.make }) });
  t.after(() => noWow.api.stop());
  assert.equal(noWow.mode, 'real');
  assert.equal((await noWow.api.status()).capture.state, 'no_game');
  await noWow.api.stop();
  for (const extra of [{ capture: false }, { config: null }]) {
    const r = tmp(t);
    const flavorDir = wowWithAddon(r);
    const o = bootOpts(r, { flavorDir, createCapture: cap.make, ...extra });
    if (extra.config === null) o.config = { wow: { flavorDir }, transport: { slots: 3 }, capture: { enabled: false } };
    const out = await loadApi({ appDir: APP, env: {}, paths: pathsIn(r), platform: 'darwin', bootOptions: o });
    assert.equal(out.mode, 'real', out.reason);
    assert.equal((await out.api.status()).capture.state, 'off');
    await out.api.stop();
  }
  assert.equal(cap.calls.length, 0);
});

test('bootOptions never override what the shell owns: its folders, platform, log and importer', async () => {
  let seen = null;
  const importer = async (file) => {
    if (file.endsWith(path.join(...BRIDGE_FILES.boot.split('/')))) return { bootByok: async (o) => { seen = o; return { api: { stop: async () => {} }, stop: async () => {} }; } };
    throw new Error(`unexpected ${file}`);
  };
  const paths = { userData: '/u/x' };
  const out = await loadApi({ appDir: APP, env: {}, exists: p => p.endsWith(path.join('bridge', 'byok', 'boot.mjs')), importer, paths, platform: 'linux',
    bootOptions: { paths: { userData: '/evil' }, platform: 'win32', log: () => {}, importer: async () => ({}), capture: false } });
  assert.equal(out.mode, 'real');
  assert.equal(seen.paths, paths);
  assert.equal(seen.platform, 'linux');
  assert.equal(typeof seen.log.addSecret, 'function', 'the shell’s redacting logger');
  await assert.rejects(seen.importer('/elsewhere/x.mjs'), /outside the app/);
  assert.equal(seen.capture, false, 'the rest passes through');
});

test('the self-test’s sandbox: the real bridge boots with capture off, no WoW folder (never the config’s default one), no egress guard, a memory key store', async (t) => {
  const root = tmp(t, 'bones-selftest-');
  const paths = pathsIn(root);
  let seen = null;
  const importer = async (file) => {
    const mod = await import(pathToFileURL(file).href);
    if (!file.endsWith(path.join('byok', 'boot.mjs'))) return mod;
    return { ...mod, bootByok: async (o) => { seen = o; return mod.bootByok(o); } };
  };
  const r = await selfTestBridge({ appDir: APP, paths, importer });
  assert.deepEqual({ ...r, root: null }, { ok: true, root: null, state: 'no_key', bridge: 'wow_not_found', capture: 'no_game', providers: 6, slotWorker: { ok: true, state: 'running', written: 201, errors: 0, failed: [] } });
  assert.equal(seen.capture, false);
  assert.equal(seen.control, undefined, 'no control pipe to turn off (systems plan D6)');
  assert.equal(seen.egress, false);
  assert.equal(seen.keystore.backend, 'memory');
  assert.equal(seen.home, paths.userData);
  assert.ok(seen.config.wow.flavorDir.startsWith(paths.userData), 'the WoW folder is pinned inside the sandbox');
  assert.notEqual(seen.config.wow.flavorDir, DEFAULTS.wow.flavorDir);
  assert.equal(fs.existsSync(seen.config.wow.flavorDir), false);
  assert.deepEqual(seen.wow.find(), [], 'nothing is searched for');
  assert.deepEqual(seen.backendOptions, NO_CHECKS, 'no start-time network checks');
  assert.equal(KEYSTORE_FILE, 'bridge/byok/security/keystore.mjs');
  // Everything it wrote is inside the sandbox.
  const top = fs.readdirSync(root);
  assert.deepEqual(top, ['ud']);
});

test('the packaged self-test runs the app on the real bridge in that sandbox, never the mock (systems plan Batch 5: mock-api.mjs is not in the package)', async (t) => {
  const root = tmp(t, 'bones-selftest-');
  const paths = pathsIn(root);
  let seen = null;
  const imported = [];
  const importer = async (file) => {
    imported.push(file);
    const mod = await import(pathToFileURL(file).href);
    if (!file.endsWith(path.join('byok', 'boot.mjs'))) return mod;
    return { ...mod, bootByok: async (o) => { seen = o; return mod.bootByok(o); } };
  };
  // forceMock and NQA_MOCK_API are development switches: the self-test ignores both.
  const out = await loadApi({ appDir: APP, paths, selfTest: true, forceMock: true, env: { NQA_MOCK_API: '1' }, importer,
    bootOptions: { capture: true, egress: true, keystore: null } });
  t.after(() => out.api.stop());
  assert.equal(out.mode, 'real');
  assert.equal(out.reason, 'self-test');
  assert.equal(out.api.mock, false);
  assert.deepEqual({ ...out.report, root: null }, { ok: true, root: null, state: 'no_key', bridge: 'wow_not_found', capture: 'no_game', providers: 6, slotWorker: { ok: true, state: 'running', written: 201, errors: 0, failed: [] } });
  assert.equal(seen.capture, false, 'the sandbox wins over bootOptions');
  assert.equal(seen.egress, false);
  assert.equal(seen.keystore.backend, 'memory');
  assert.ok(seen.config.wow.flavorDir.startsWith(paths.userData));
  assert.ok(!imported.some(f => /mock-api\.mjs$/.test(f)));
  const st = await out.api.status();
  assert.equal(st.backend.rt.state, 'no_key', 'the page gets the real status');
  assert.ok((await out.api.providers()).length > 0);
  // A development run still gets the mock when it asks; a packaged one never (it isn't there).
  const dev = await loadApi({ appDir: APP, env: { NQA_MOCK_API: '1' } });
  assert.equal(dev.mode, 'mock');
  assert.equal(dev.api.mock, true);
  const packagedAsk = await loadApi({ appDir: APP, packaged: true, forceMock: true, env: { NQA_MOCK_API: '1' }, exists: () => false });
  assert.equal(packagedAsk.mode, 'error', 'a packaged app without its bridge says so; it never falls back to the mock');
});

// Code health BR-04: the bridge's slot worker, started from the bridge root the app runs (app.asar,
// packaged): a worker that falls back to the main thread fails the self-test's report.
test('the self-test’s slot-worker check (code health BR-04): the worker loads from the bridge root through the loader’s importer and writes a slot table in the sandbox; one that can’t start, dies or doesn’t answer fails it, by name', async (t) => {
  const { slotWorkerGate, SLOT_WORKER_FILE } = await import('../../app/desktop/src/slot-worker-gate.mjs');
  const root = path.join(APP, '..', '..');
  const loaded = [];
  const importer = async (file) => { loaded.push(path.relative(root, file).split(path.sep).join('/')); return import(pathToFileURL(file).href); };
  const dir = tmp(t, 'bones-slot-gate-');
  const ok = await slotWorkerGate({ root, importer, dir });
  assert.deepEqual(ok, { ok: true, state: 'running', written: 201, errors: 0, failed: [] });
  assert.ok(loaded.includes(SLOT_WORKER_FILE), 'the module the publisher loads, from that root');
  assert.deepEqual(fs.readdirSync(dir), [], 'its AddOns folder goes when it’s done');
  const scripts = tmp(t, 'bones-slot-gate-scripts-');
  fs.writeFileSync(path.join(scripts, 'silent.mjs'), "import { workerData } from 'node:worker_threads';\nworkerData.port.on('message', () => {});\n");
  fs.writeFileSync(path.join(scripts, 'dying.mjs'), "import { workerData } from 'node:worker_threads';\nworkerData.port.on('message', () => process.exit(3));\n");
  for (const [script, why] of [['missing.mjs', 'error'], ['dying.mjs', 'exit'], ['silent.mjs', 'timeout']]) {
    const r = await slotWorkerGate({ root, importer, dir, waitMs: 300, url: pathToFileURL(path.join(scripts, script)) });
    assert.deepEqual([r.ok, r.state, r.failed], [false, 'failed', [why]], script);
  }
  const broken = await slotWorkerGate({ root: path.join(dir, 'nowhere'), importer, dir });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /Cannot find|ERR_MODULE_NOT_FOUND|no such file/i, 'a bridge root without the worker says why');
});

test('the self-test’s sandbox refuses to run over a folder that looks like a WoW install, and says when there is no bridge', async (t) => {
  const root = tmp(t, 'bones-selftest-');
  const paths = pathsIn(root);
  fs.mkdirSync(path.join(paths.userData, 'no-wow', '_forever_'), { recursive: true });
  assert.deepEqual(await selfTestBridge({ appDir: APP, paths }), { ok: false, error: 'sandbox_not_empty' });
  assert.deepEqual(await selfTestBridge({ appDir: APP, paths: pathsIn(tmp(t)), exists: () => false }), { ok: false, error: 'no_bridge' });
});
