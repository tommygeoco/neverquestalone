// The shell's network guard (BYOK PRD §11.2 "Network", KY-6, KY-7, SC-9): what Chromium may
// request is the app's own page from its scheme (nqa://app/, only paths that can name a
// renderer file), https to the four update-feed hosts only while update checks are on, and
// nothing else: never file:, never the providers (those are the bridge's, through Node), never
// the OpenRouter sign-in page (the player's own browser opens it, through shell.openExternal).
// The ledger feeding Connections keeps only the scheme and host of a refused request.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  checkShellRequest, createShellLedger, installShellGuard, UPDATE_HOSTS, UPDATER_PARTITION, updateFeature, guardNetworkEnv, refuseLine, REFUSED_ENV, EXTRA_CA_ENV,
  LOADER_ENV_PREFIX, loaderVariable, guardLoaderEnv, DEBUG_SWITCHES, debugSwitches, LAUNCH_SWITCHES, ALLOWED_SWITCHES, SELF_TEST_SWITCHES, switchNames, allowedSwitch, launchSwitches, switchLine,
} from '../../app/desktop/src/net-guard.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const REPO = path.join(APP, '..', '..');
const ON = { allowUpdates: true };
// URLs with a user part are built with AT: the scrub scanner reads user@host as an email address,
// and these files go out with the public tree (security review SR-02).
const AT = '@';
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

test('the update hosts are exactly GitHub releases and its two asset CDNs; not its API, which a public feed never uses (SY-14)', () => {
  assert.deepEqual([...UPDATE_HOSTS].sort(), ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  assert.equal(checkShellRequest('https://api.github.com/repos/OWNER/neverquestalone/releases/latest', ON).allow, false);
  assert.equal(UPDATER_PARTITION, 'electron-updater');
});

test('allowed: the app page and its files from nqa://app/; https to each update host while checks are on', () => {
  for (const url of ['nqa://app/index.html', 'nqa://app/app.js', 'nqa://app/style.css', 'nqa://app/format.js', 'nqa://app/mark.png', 'nqa://app/index.html#setup']) {
    const v = checkShellRequest(url);
    assert.equal(v.allow, true, url);
    assert.equal(v.kind, 'page');
  }
  for (const url of [
    'https://github.com/OWNER/neverquestalone/releases.atom',
    'https://github.com/OWNER/neverquestalone/releases/download/v0.2.0/latest-mac.yml',
    'https://objects.githubusercontent.com/github-production-release-asset/1/2?X-Amz-Signature=abc',
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/2',
    'https://GITHUB.COM/OWNER/r/releases.atom',
    'https://github.com:443/OWNER/r/releases.atom',
  ]) {
    const v = checkShellRequest(url, ON);
    assert.equal(v.allow, true, url);
    assert.equal(v.kind, 'update');
    assert.equal(v.port, 443);
  }
});

test('update checks off (or not yet known): the feed hosts are refused too', () => {
  for (const url of ['https://github.com/OWNER/r/releases.atom', 'https://objects.githubusercontent.com/x']) {
    const off = checkShellRequest(url);
    assert.equal(off.allow, false, url);
    assert.equal(off.kind, 'updates_off');
    assert.equal(checkShellRequest(url, { allowUpdates: false }).allow, false);
  }
});

test('refused: file: everywhere, every other scheme, host, port and look-alike, and app-scheme paths that aren’t renderer files', () => {
  const refused = [
    // file: is never loaded (the GrantFileProtocolExtraPrivileges fuse is off; the page comes from nqa://app/).
    pathToFileURL(path.join(APP, 'renderer', 'index.html')).href,
    pathToFileURL('/etc/passwd').href,
    'file://server/share/x.html',
    'file:///',
    // The app's scheme: only a renderer file's shape, only the app host.
    'nqa://app/',
    'nqa://app',
    'nqa://app/main.mjs',
    'nqa://app/preload.cjs',
    'nqa://app/package.json',
    'nqa://app/%2e%2e/main.mjs',
    'nqa://app/renderer%2f..%2f..%2fmain.js',
    'nqa://app/.hidden.js',
    'nqa://app/a//b.js',
    'nqa://app/x.js%00.png',
    'nqa://app/..%5c..%5cmain.js',
    'nqa://evil/index.html',
    'nqa://app:8080/index.html',
    'nqa://user@app/index.html',
    // Everything else.
    'http://github.com/OWNER/r/releases.atom',
    'https://github.com:8443/x',
    `https://user:pass${AT}github.com/x`,
    'https://github.com.evil.example/x',
    'https://evilgithub.com/x',
    'https://github.com./x',
    'https://raw.githubusercontent.com/x',
    'https://gist.github.com/x',
    'https://codeload.github.com/x',
    'https://uploads.github.com/x',
    'https://api.anthropic.com/v1/messages',
    'https://openrouter.ai/api/v1/key',
    'https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A3000',
    'https://140.82.112.3/x',
    'https://[::1]/x',
    `https://g${String.fromCharCode(0x0456)}thub.com/x`,
    'https://example.invalid/bones-self-test',
    'wss://github.com/socket',
    'ws://127.0.0.1:9222/devtools',
    'http://127.0.0.1:11434/api/tags',
    'ftp://github.com/x',
    'data:text/html,<script>alert(1)</script>',
    'blob:nqa://app/abc',
    'javascript:alert(1)',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'not a url',
    '',
  ];
  for (const url of refused) {
    for (const opts of [{}, ON]) {
      const v = checkShellRequest(url, opts);
      assert.equal(v.allow, false, `refuses ${url} (${JSON.stringify(opts)})`);
    }
  }
  assert.equal(checkShellRequest(pathToFileURL('/etc/passwd').href).kind, 'file');
  assert.equal(checkShellRequest('nqa://app/main.mjs').kind, 'page_path');
  assert.equal(checkShellRequest('https://openrouter.ai/auth?x=1', ON).kind, 'host', 'the sign-in page never loads in the app');
  assert.equal(checkShellRequest('devtools://devtools/x', { allowDevtools: true }).allow, true, 'devtools only when asked (unpackaged runs)');
});

test('the one sign-in page (ChatGPT plan) opens only in the player\'s own browser, through one checked opener; the OpenRouter sign-in stays gone; a page never opens a window of its own', () => {
  const main = code(fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8'));
  assert.doesNotMatch(main, /openSignInUrl|signInUrlOk/);
  // The bridge's opener is main's openSignInPage alone, and it takes OpenAI's authorize page only.
  assert.deepEqual([...main.matchAll(/openExternal: (\w+)/g)].map(m => m[1]), ['openSignInPage']);
  assert.match(main, /const SIGN_IN_PAGES = Object\.freeze\(\['https:\/\/auth\.openai\.com\/oauth\/authorize'\]\);/);
  assert.match(main, /async function openSignInPage\(url\) \{[\s\S]*?SIGN_IN_PAGES\.includes\(u\.origin \+ u\.pathname\)[\s\S]*?shell\.openExternal\(u\.href\)/);
  assert.doesNotMatch(main, /loadURL\([^)]*auth\.openai/i, 'the sign-in page never loads in a window of ours');
  assert.doesNotMatch(main, /loadURL\([^)]*openrouter/i);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/, 'a page can never open a window of its own');
});

test('the ledger: allowed update requests with counts and a feature; page loads counted; refused ones by scheme and host only', () => {
  let t = 1000;
  const led = createShellLedger({ now: () => t });
  const see = (url, opts = ON) => led.record(checkShellRequest(url, opts), url);
  see('nqa://app/index.html');
  see('nqa://app/app.js');
  see('https://github.com/OWNER/r/releases.atom');
  t = 2000;
  see('https://github.com/OWNER/r/releases.atom');
  see('https://objects.githubusercontent.com/asset?token=SECRET');
  see('https://api.anthropic.com/v1/messages?key=SECRET');
  see('file:///Users/someone/SECRET.txt');
  see('https://github.com/OWNER/r/releases.atom?SECRET', {});
  const snap = led.snapshot();
  assert.equal(snap.pages, 2);
  assert.deepEqual(snap.allowed.map(r => [r.host, r.count, r.first, r.last, r.feature]), [
    ['github.com', 2, 1000, 2000, 'update check'],
    ['objects.githubusercontent.com', 1, 2000, 2000, 'update download'],
  ]);
  assert.deepEqual(snap.blocked.map(r => [r.scheme, r.host, r.count, r.reason]), [
    ['https', 'api.anthropic.com', 1, 'host'],
    ['file', null, 1, 'file'],
    ['https', 'github.com', 1, 'updates_off'],
  ]);
  assert.ok(!JSON.stringify(snap).includes('SECRET'), 'no paths or queries are kept');
  assert.equal(updateFeature('https://github.com/o/r/releases/download/v1/x.zip'), 'update download');
});

test('installShellGuard cancels what the check refuses, on every session, reading update checks on every request', () => {
  const sessions = [0, 1].map(() => {
    const s = { listener: null };
    s.webRequest = { onBeforeRequest: fn => { s.listener = fn; } };
    return s;
  });
  const led = createShellLedger();
  const blocked = [];
  let checks = true;
  installShellGuard(sessions, { ledger: led, allowUpdates: () => checks, onBlocked: v => blocked.push(v.host ?? v.kind) });
  for (const s of sessions) {
    const out = [];
    s.listener({ url: 'https://github.com/OWNER/r/releases.atom' }, r => out.push(r));
    s.listener({ url: 'https://www.google.com/' }, r => out.push(r));
    s.listener({ url: 'nqa://app/index.html' }, r => out.push(r));
    s.listener({ url: pathToFileURL(path.join(APP, 'renderer', 'index.html')).href }, r => out.push(r));
    assert.deepEqual(out, [{ cancel: false }, { cancel: true }, { cancel: false }, { cancel: true }]);
  }
  checks = false;
  const after = [];
  sessions[1].listener({ url: 'https://github.com/OWNER/r/releases.atom' }, r => after.push(r));
  assert.deepEqual(after, [{ cancel: true }], '"Never check" closes the feed at once');
  const throws = { listener: null, webRequest: { onBeforeRequest: fn => { throws.listener = fn; } } };
  installShellGuard([throws], { ledger: null, allowUpdates: () => { throw new Error('no updater yet'); } });
  const r = [];
  throws.listener({ url: 'https://github.com/x' }, v => r.push(v));
  assert.deepEqual(r, [{ cancel: true }], 'an updater that can’t say means checks are off');
  assert.deepEqual(blocked, ['www.google.com', 'file', 'www.google.com', 'file', 'github.com']);
});

test('main.mjs: the guard on the default and the updater sessions; the feed open only while checks are on in a packaged app', () => {
  const main = code(fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8'));
  assert.match(main, /const sessions = \[session\.defaultSession, session\.fromPartition\(UPDATER_PARTITION, \{ cache: false \}\)\]/);
  assert.match(main, /allowUpdates: \(\) => \{ const s = updater\?\.status\?\.\(\); return !!s && s\.supported === true && s\.mode === 'notify'; \}/);
  assert.match(main, /allowDevtools: !app\.isPackaged && !HEADLESS/);
  assert.doesNotMatch(main, /fileRoot/, 'no file: allowance left');
});

test('the environment Node reads for the bridge\'s connections: certificate checks stay on, an environment proxy stops the start; NODE_EXTRA_CA_CERTS (gone before Node starts in a packaged app) and NODE_USE_SYSTEM_CA are left alone, the reasons beside the list (final review L2-1, SR-05)', () => {
  const env = { NODE_TLS_REJECT_UNAUTHORIZED: '0', HTTPS_PROXY: 'http://127.0.0.1:8888', PATH: '/usr/bin' };
  assert.deepEqual(guardNetworkEnv(env), { removed: ['NODE_TLS_REJECT_UNAUTHORIZED'], refuse: null });
  assert.equal('NODE_TLS_REJECT_UNAUTHORIZED' in env, false, 'removed in place, before any connection');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8888', 'a proxy variable alone does nothing in Node: left alone');
  for (const v of ['1', 'true', '0']) assert.equal(guardNetworkEnv({ NODE_USE_ENV_PROXY: v }).refuse, 'NODE_USE_ENV_PROXY', v);
  assert.equal(guardNetworkEnv({ NODE_USE_ENV_PROXY: '' }).refuse, null);
  assert.deepEqual(guardNetworkEnv({}), { removed: [], refuse: null });
  assert.match(refuseLine('NODE_USE_ENV_PROXY'), /won’t start while NODE_USE_ENV_PROXY is set/);

  // SR-05: the refusal list is the proxy alone. NODE_EXTRA_CA_CERTS never reaches a packaged app (Electron's
  // SetNodeOptions unsets it before Node reads it while the NODE_OPTIONS fuse is off; the packaged self-test proves it),
  // and NODE_USE_SYSTEM_CA only adds the OS trust store (a new root there needs the person's approval; Chromium trusts it
  // already), and Claude Code exports it in every shell. Neither is refused nor removed here.
  assert.deepEqual([...REFUSED_ENV], ['NODE_USE_ENV_PROXY']);
  assert.equal(EXTRA_CA_ENV, 'NODE_EXTRA_CA_CERTS');
  for (const name of ['NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA']) {
    const env = { [name]: name === 'NODE_USE_SYSTEM_CA' ? '1' : '/tmp/corp-root.pem' };
    assert.deepEqual(guardNetworkEnv(env), { removed: [], refuse: null }, name);
    assert.ok(Object.hasOwn(env, name), `${name} left as it is`);
  }
  assert.equal(guardNetworkEnv({ NODE_EXTRA_CA_CERTS: '/tmp/x.pem', NODE_USE_ENV_PROXY: '1' }).refuse, 'NODE_USE_ENV_PROXY');
  assert.equal(refuseLine('NODE_USE_ENV_PROXY'), 'NeverQuestAlone won’t start while NODE_USE_ENV_PROXY is set, because it would send your API key through a proxy. Start it again without that variable.');
  // The fuse that does it (scripts/fuses.cjs; tests/byok/app_build_test.mjs pins the whole plan), and the reasons, beside the list.
  assert.equal(createRequire(import.meta.url)(path.join(APP, 'scripts', 'fuses.cjs')).FUSE_PLAN.EnableNodeOptionsEnvironmentVariable, false);
  const src = fs.readFileSync(path.join(APP, 'src', 'net-guard.mjs'), 'utf8');
  const beside = src.slice(src.lastIndexOf('/**', src.indexOf('export const REFUSED_ENV')), src.indexOf('export const REFUSED_ENV')).replace(/\n\s*\*\s*/g, ' ');
  for (const why of ['Electron\'s SetNodeOptions', 'unsets it before Node reads it', 'EnableNodeOptionsEnvironmentVariable fuse is off (scripts/fuses.cjs)', 'A development run\'s Electron keeps that fuse on, so it honours NODE_EXTRA_CA_CERTS',
    'NODE_USE_SYSTEM_CA only adds the operating system\'s trust store', 'the person approves a trust change', 'Chromium\'s own network stack', 'Claude Code exports it']) {
    assert.ok(beside.includes(why), `the reason sits beside the list: ${why}`);
  }
});

// A throwaway certificate authority and a certificate it signed for 127.0.0.1 (P-256, valid for a day), made here:
// DER by hand, signed with node:crypto, kept in memory and a temp folder only.
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  return Buffer.concat([Buffer.from([tag]), n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]), body]);
};
const seq = (...parts) => der(0x30, ...parts);
const oid = s => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a + b];
  for (let v of rest) { const sub = [v & 0x7f]; while ((v = Math.floor(v / 128)) > 0) sub.unshift(0x80 | (v & 0x7f)); out.push(...sub); }
  return der(0x06, Buffer.from(out));
};
const dn = cn => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));
const utc = d => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
function certificate({ subject, issuer, publicKey, signer, ca }) {
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const exts = ca
    ? [ext('2.5.29.19', true, seq(der(0x01, Buffer.from([0xff])))), ext('2.5.29.15', true, der(0x03, Buffer.from([0x01, 0x06])))]
    : [ext('2.5.29.19', true, seq()), ext('2.5.29.15', true, der(0x03, Buffer.from([0x07, 0x80]))), ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), ext('2.5.29.17', false, seq(der(0x87, Buffer.from([127, 0, 0, 1]))))];
  const now = Date.now();
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.concat([Buffer.from([1]), crypto.randomBytes(8)])), ecdsaSha256, dn(issuer),
    seq(utc(new Date(now - 3600e3)), utc(new Date(now + 86400e3))), dn(subject), publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(...exts)));
  const body = seq(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, signer)])));
  return `-----BEGIN CERTIFICATE-----\n${body.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
/** process.env without what changes Node's trust, a child's starting point. */
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NAPI_RS_\w+)$/i.test(k)) delete env[k];
  return env;
};
const node = (args, env) => new Promise(resolve => {
  execFile(process.execPath, args, { env, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: String(stdout).trim(), stderr: String(stderr) }));
});

test('SR-05, the record of why a JavaScript delete can\'t help: Node reads NODE_EXTRA_CA_CERTS when it starts, so deleting it from process.env first thing changes nothing (a throwaway CA, a local TLS server, Node\'s own fetch); in a packaged app Electron unsets it before Node starts (the NODE_OPTIONS fuse), which the packaged self-test proves', async () => {
  const caKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leafKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caPem = certificate({ subject: 'NQA throwaway test CA', issuer: 'NQA throwaway test CA', publicKey: caKeys.publicKey, signer: caKeys.privateKey, ca: true });
  const leafPem = certificate({ subject: '127.0.0.1', issuer: 'NQA throwaway test CA', publicKey: leafKeys.publicKey, signer: caKeys.privateKey, ca: false });
  assert.ok(new crypto.X509Certificate(leafPem).verify(new crypto.X509Certificate(caPem).publicKey), 'the leaf is the CA\'s');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-ca-'));
  const caFile = path.join(dir, 'ca.pem');
  fs.writeFileSync(caFile, caPem);
  const server = https.createServer({ key: leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: leafPem }, (_q, s) => s.end('ok'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    // The bridge's way (bridge/byok/boot.mjs: globalThis.fetch), in a child Node; the first line deletes the variable or doesn't.
    const probe = del => `${del ? 'delete process.env.NODE_EXTRA_CA_CERTS;' : ''}
      try { const r = await fetch('https://127.0.0.1:${server.address().port}/'); console.log('trusted ' + r.status); }
      catch (e) { console.log('refused ' + (e.cause?.code ?? e.code ?? e.message)); }`;
    const run = (env, del = false) => node(['--input-type=module', '-e', probe(del)], env);
    const control = await run(cleanEnv());
    assert.match(control.stdout, /^refused (UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/, `the throwaway CA is nobody's root: ${control.stdout}`);
    const set = await run({ ...cleanEnv(), NODE_EXTRA_CA_CERTS: caFile });
    assert.equal(set.stdout, 'trusted 200', `NODE_EXTRA_CA_CERTS makes Node trust it: ${set.stdout} ${set.stderr}`);
    const deleted = await run({ ...cleanEnv(), NODE_EXTRA_CA_CERTS: caFile }, true);
    assert.equal(deleted.stdout, 'trusted 200', `still trusted after the delete, before any connection: ${deleted.stdout} ${deleted.stderr}`);
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dependency\'s loader can\'t be sent to other code: the keyring\'s loader runs whatever NAPI_RS_NATIVE_LIBRARY_PATH names, and guardLoaderEnv before the import stops it (SR-05)', async () => {
  // Every napi-rs loader knob the keyring's loader reads (its path, its WASI switches, its version check), in any case
  // (Windows' variable names have none), and nothing else.
  assert.equal(LOADER_ENV_PREFIX, 'NAPI_RS_');
  const env = { NAPI_RS_NATIVE_LIBRARY_PATH: '/tmp/x.js', NAPI_RS_FORCE_WASI: 'true', NAPI_RS_WASI_FLAVOR: 'wasm32-wasi', NAPI_RS_ENFORCE_VERSION_CHECK: '1', napi_rs_native_library_path: '/tmp/y.js', PATH: '/usr/bin', NAPI_RSX: 'x', MY_NAPI_RS_X: 'y' };
  assert.deepEqual(guardLoaderEnv(env), { removed: ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI', 'NAPI_RS_WASI_FLAVOR', 'NAPI_RS_ENFORCE_VERSION_CHECK', 'napi_rs_native_library_path'] });
  assert.deepEqual(env, { PATH: '/usr/bin', NAPI_RSX: 'x', MY_NAPI_RS_X: 'y' }, 'removed in place; the rest stays');
  assert.equal(loaderVariable('Napi_Rs_Force_Wasi'), true);
  assert.equal(loaderVariable('NAPI_RSFOO'), false);
  // The keyring's loader reads no variable outside the prefix (were one added, it would show here).
  const loaderSrc = fs.readFileSync(createRequire(path.join(REPO, 'bridge', 'byok', 'security', 'keystore.mjs')).resolve('@napi-rs/keyring'), 'utf8');
  const read = [...new Set([...loaderSrc.matchAll(/process\.env\.([A-Z_a-z0-9]+)|process\.env\[['"]([^'"]+)['"]\]/g)].map(m => m[1] ?? m[2]))].sort();
  assert.deepEqual(read.filter(v => !loaderVariable(v)), [], `the loader's variables: ${read.join(', ')}`);
  assert.ok(read.includes('NAPI_RS_NATIVE_LIBRARY_PATH'), 'the one it require()s');
  assert.deepEqual(guardLoaderEnv({ PATH: '/usr/bin' }), { removed: [] });

  // The real loader, resolved as keystore.mjs resolves it, in a child Node with NAPI_RS_NATIVE_LIBRARY_PATH naming a
  // .js file that records it ran: without the guard the file runs (the hole is real), with it the file never runs and
  // the keyring's own binding loads.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-loader-'));
  try {
    const wire = path.join(dir, 'wire.cjs');
    const ran = path.join(dir, 'ran');
    fs.writeFileSync(wire, "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran'), 'ran');\nmodule.exports = {};\n");
    const keyring = pathToFileURL(createRequire(path.join(REPO, 'bridge', 'byok', 'security', 'keystore.mjs')).resolve('@napi-rs/keyring')).href;
    const guard = pathToFileURL(path.join(APP, 'src', 'net-guard.mjs')).href;
    const probe = guarded => `${guarded ? `(await import(${JSON.stringify(guard)})).guardLoaderEnv(process.env);` : ''}
      try { console.log(typeof (await import(${JSON.stringify(keyring)})).Entry); } catch (e) { console.log('threw ' + e.message.split('\\n')[0]); }`;
    const unguarded = await node(['--input-type=module', '-e', probe(false)], { ...cleanEnv(), NAPI_RS_NATIVE_LIBRARY_PATH: wire });
    assert.equal(fs.existsSync(ran), true, `without the guard, the loader runs the file: ${unguarded.stdout} ${unguarded.stderr}`);
    assert.equal(unguarded.stdout, 'undefined', 'and takes its exports for the binding');
    fs.rmSync(ran);
    const guarded = await node(['--input-type=module', '-e', probe(true)], { ...cleanEnv(), NAPI_RS_NATIVE_LIBRARY_PATH: wire });
    assert.equal(fs.existsSync(ran), false, 'with the guard first, the file never runs');
    assert.equal(guarded.stdout, 'function', `and the keyring's own binding loads: ${guarded.stdout} ${guarded.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** The modules a file loads before its own code runs: its static imports, and the bridge modules src/bridge-module.mjs imports with top-level await, all the way down. */
function loadedFirst(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm)) loadedFirst(path.resolve(path.dirname(file), m[1] ?? m[2]), seen);
  for (const m of src.matchAll(/^(?:const|let|var)[^\n]*=\s*await\s+importBridge\(['"]([^'"]+)['"]\)/gm)) loadedFirst(path.join(REPO, m[1]), seen);
  return seen;
}

test('main.mjs: the launch is checked in src/launch-guard.mjs, the first of the app\'s own modules it imports, so the loader variables are gone and a refused switch has exited before any bridge module (keystore.mjs among them) loads (SR-05)', () => {
  const rel = f => path.relative(REPO, f).split(path.sep).join('/');
  const mainSrc = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  const local = [...mainSrc.matchAll(/^import\s[^;]*?\sfrom\s*'(\.[^']+)'/gm)].map(m => m[1]);
  assert.equal(local[0], './src/launch-guard.mjs', `the first local import: ${local.join(', ')}`);
  assert.match(mainSrc, /^import \{ NET_ENV, LOADER_FOUND \} from '\.\/src\/launch-guard\.mjs';$/m);
  // Every module main.mjs loads before its first line: keystore.mjs is among them (src/redact.mjs's top-level await),
  // which is why the guard can't wait for main.mjs's body; launch-guard.mjs itself loads no bridge module.
  const before = [...loadedFirst(path.join(APP, 'main.mjs'))].map(rel);
  assert.ok(before.includes('bridge/byok/security/keystore.mjs'), 'keystore.mjs loads during main.mjs\'s imports');
  assert.deepEqual([...loadedFirst(path.join(APP, 'src', 'launch-guard.mjs'))].map(rel).sort(), ['app/desktop/src/launch-guard.mjs', 'app/desktop/src/net-guard.mjs', 'app/desktop/src/scheme.mjs']);
  for (const f of ['src/launch-guard.mjs', 'src/net-guard.mjs', 'src/scheme.mjs']) assert.doesNotMatch(code(fs.readFileSync(path.join(APP, f), 'utf8')), /^\s*(?:const|let|var)[^\n]*=\s*await\s|^await\s/m, `${f}: no top-level await, so it runs before the next import starts`);
  // The keyring's loader is only ever imported lazily (inside keystore.mjs's osBackend, and main.mjs's self-test), never
  // while the app's modules load.
  for (const f of before) {
    if (f === 'app/desktop/main.mjs' || f === 'bridge/byok/security/keystore.mjs') continue;
    assert.doesNotMatch(code(fs.readFileSync(path.join(REPO, f), 'utf8')), /@napi-rs\/keyring/, `${f} names @napi-rs/keyring`);
  }
  const ks = code(fs.readFileSync(path.join(REPO, 'bridge', 'byok', 'security', 'keystore.mjs'), 'utf8'));
  assert.equal([...ks.matchAll(/@napi-rs\/keyring/g)].length, 1);
  assert.match(ks, /function osBackend\([^)]*\) \{[\s\S]*?mod = await import\('@napi-rs\/keyring'\)/, 'one lazy import, inside a function');

  // launch-guard.mjs, at its top level: the loader variables first, then the network ones, then the switches; a refused
  // switch comes off Chromium's command line, then one line on stderr and the self-test's on stdout (written
  // synchronously: app.exit before ready ends the process at once), then exit 1.
  const lg = code(fs.readFileSync(path.join(APP, 'src', 'launch-guard.mjs'), 'utf8'));
  const at = s => { const i = lg.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('export const LOADER_FOUND = guardLoaderEnv(process.env);') < at('export const NET_ENV = guardNetworkEnv(process.env);'));
  assert.ok(at('export const NET_ENV') < at('const refused = launchSwitches({ packaged: app.isPackaged, hasSwitch: s => app.commandLine.hasSwitch(s), argv: process.argv });'));
  assert.match(lg.slice(at('const refused = ')), /^const refused = [^\n]+\nif \(refused\.length\) \{\n\s+for \(const s of refused\) \{ try \{ app\.commandLine\.removeSwitch\(s\); \} catch \{\} \}\n\s+try \{ fs\.writeSync\(2, `\$\{switchLine\(refused\[0\]\)\}\\n`\); \} catch \{\}\n\s+if \(process\.argv\.includes\('--self-test'\)\) \{\n\s+const error = DEBUG_SWITCHES\.includes\(refused\[0\]\) \? 'debug_switch' : 'launch_switch';\n\s+try \{ fs\.writeSync\(1, `\$\{JSON\.stringify\(\{ selfTest: 'neverquestalone', ok: false, error, switch: refused\[0\] \}\)\}\\n`\); \} catch \{\}\n\s+\}\n\s+app\.exit\(1\);\n\}/);

  // main.mjs: the environment refusal in start(), before the bridge boots: its line in the log, on stderr and in the box.
  const main = code(mainSrc);
  assert.doesNotMatch(main, /guardNetworkEnv\(process\.env|guardLoaderEnv\(|launchSwitches\(|debugSwitches\(/, 'one check, in launch-guard.mjs');
  for (const later of ['protocol.registerSchemesAsPrivileged', 'requestSingleInstanceLock()', 'app.enableSandbox()', 'crashReporter.start(', 'async function start()']) assert.ok(main.indexOf(later) > main.indexOf("from './src/launch-guard.mjs'"), later);
  const start = main.slice(main.indexOf('async function start()'));
  assert.ok(start.indexOf('if (NET_ENV.refuse)') > start.indexOf('await app.whenReady()'), 'the box needs ready');
  assert.ok(start.indexOf('if (NET_ENV.refuse)') < start.indexOf('loadApi('), 'refused before the bridge boots');
  assert.match(start, /if \(NET_ENV\.refuse\) \{\n\s+const line = refuseLine\(NET_ENV\.refuse\);\n\s+log\(line\);\n\s+try \{ fs\.writeSync\(2, `\$\{line\}\\n`\); \} catch \{\}\n\s+if \(HEADLESS\) \{\n\s+try \{ fs\.writeSync\(1, `\$\{JSON\.stringify\(\{ selfTest: 'neverquestalone', ok: false, error: 'env_proxy', variable: NET_ENV\.refuse \}\)\}\\n`\); \} catch \{\}\n[\s\S]*?dialog\.showErrorBox\('NeverQuestAlone', line\);\n\s+\}\n\s+app\.exit\(1\);\n\s+return;/);
  assert.match(start, /const removedEnv = \[\.\.\.LOADER_FOUND\.removed, \.\.\.NET_ENV\.removed\];\n\s+if \(removedEnv\.length\) log\(/);
  // The self-test's pass names each check (AP-02), the loader's too: gone, and the key store's binding loads (packaged).
  assert.match(main, /c\.networkEnv = \{/);
  assert.match(main, /tlsOffRemoved: c\.networkEnv\.tlsOffRemoved, proxyRefused: c\.networkEnv\.proxyRefused,\n\s+extraCaIgnored: !app\.isPackaged \|\| \(c\.networkEnv\.extraCaGone && c\.networkEnv\.extraCaCerts === 0\),\n\s+loaderEnvGone: c\.loaderEnv\.gone, keyStoreLoads: !app\.isPackaged \|\| c\.loaderEnv\.keyStoreLoads,/);
  // NODE_EXTRA_CA_CERTS in the report: gone from process.env, and Node's own list of the certificates it added from it
  // (src/extra-ca.mjs, tls.getCACertificates('extra'), the one module allowed node:tls for it: tests/byok/egress_test.mjs).
  assert.match(main, /extraCaGone: process\.env\[EXTRA_CA_ENV\] === undefined,\n\s+extraCaCerts: \(await import\('\.\/src\/extra-ca\.mjs'\)\)\.extraCaCount\(\),/);
  const ca = code(fs.readFileSync(path.join(APP, 'src', 'extra-ca.mjs'), 'utf8'));
  assert.match(ca, /tls\.getCACertificates\('extra'\)\.length/);
  assert.doesNotMatch(ca, /connect|createServer|request\(/, 'a list read, never a connection');
  assert.match(main, /keyStoreLoads = typeof \(await import\('@napi-rs\/keyring'\)\)\.Entry === 'function';/);
  assert.match(main, /c\.loaderEnv = \{ removed: \[\.\.\.LOADER_FOUND\.removed\], gone: !Object\.keys\(process\.env\)\.some\(loaderVariable\), keyStoreLoads \};/);
});

test('a packaged app won’t start with Chromium’s debugging switches, V8 flags, --no-sandbox or --disable-web-security; a development run keeps them (code health AP-04)', () => {
  assert.deepEqual([...DEBUG_SWITCHES].sort(), ['disable-web-security', 'js-flags', 'no-sandbox', 'remote-allow-origins', 'remote-debugging-address', 'remote-debugging-pipe', 'remote-debugging-port']);
  // The fuses already turn off Node's inspector (scripts/fuses.cjs): those switches aren't this list's.
  for (const s of ['inspect', 'inspect-brk']) assert.ok(!DEBUG_SWITCHES.includes(s), s);
  // Chromium's own parser (app.commandLine.hasSwitch) as a set; argv as process.argv has it.
  const line = (...on) => s => on.includes(s);
  const exe = '/Applications/NeverQuestAlone.app/Contents/MacOS/NeverQuestAlone';
  for (const s of DEBUG_SWITCHES) {
    assert.deepEqual(debugSwitches({ packaged: true, hasSwitch: line(s), argv: [exe] }), [s], `${s}: Chromium sees it`);
    for (const a of [`--${s}`, `--${s}=9222`, `-${s}`, `/${s}`, `--${s.toUpperCase()}=x`]) {
      assert.deepEqual(debugSwitches({ packaged: true, argv: [exe, '--hidden', a] }), [s], `${a}: only in argv`);
    }
  }
  assert.deepEqual(debugSwitches({ packaged: true, hasSwitch: line('remote-debugging-pipe'), argv: [exe, '--remote-debugging-port=0', '--self-test'] }), ['remote-debugging-port', 'remote-debugging-pipe'], 'every one, in the list’s order');
  // The app's own switches, Node's (the fuses' job) and look-alikes start it.
  const fine = [exe, '--hidden', '--self-test', '--no-relaunch', '--use-mock-keychain', '--show-window-ms=500', '--inspect=9229', '--updated', '-psn_0_123', '--remote-debugging-portal', 'remote-debugging-port', '--', '/Users/p/no-sandbox'];
  assert.deepEqual(debugSwitches({ packaged: true, hasSwitch: line('hidden', 'inspect'), argv: fine }), []);
  // A development run stays debuggable; a command line that can't answer is refused.
  assert.deepEqual(debugSwitches({ packaged: false, hasSwitch: line(...DEBUG_SWITCHES), argv: [exe, '--remote-debugging-port=9222'] }), []);
  assert.deepEqual(debugSwitches({ packaged: true, hasSwitch: () => { throw new Error('no command line'); }, argv: [exe] }), [...DEBUG_SWITCHES]);
  assert.equal(switchLine('remote-debugging-port'), 'NeverQuestAlone won’t start with --remote-debugging-port. Start it again without it.');
  // debugSwitches is launchSwitches' Chromium-parser half for these (SR-05; src/launch-guard.mjs calls launchSwitches):
  // whatever it finds, the launch check refuses, first, in its order, wherever argv hides it.
  for (const s of DEBUG_SWITCHES) {
    assert.deepEqual(launchSwitches({ packaged: true, hasSwitch: line(s), argv: [exe] }), [s], `${s}: Chromium sees it, argv doesn't`);
    assert.deepEqual(launchSwitches({ packaged: true, argv: [exe, `--${s}=1`] }), [s]);
  }
  assert.deepEqual(launchSwitches({ packaged: true, hasSwitch: () => { throw new Error('no command line'); }, argv: [exe] }), [...DEBUG_SWITCHES, ...LAUNCH_SWITCHES]);
});

test('a packaged app starts only with the switches its own launchers pass: every allowed form starts it, the four process-launch switches and anything else are refused in every syntax, and a development run keeps them all (SR-05)', () => {
  const MAC = '/Applications/NeverQuestAlone.app/Contents/MacOS/NeverQuestAlone';
  const WIN = 'C:\\Users\\p\\AppData\\Local\\Programs\\NeverQuestAlone\\NeverQuestAlone.exe';
  const exeFor = platform => (platform === 'win32' ? WIN : MAC);
  const check = (platform, args, opts = {}) => launchSwitches({ packaged: true, platform, argv: [exeFor(platform), ...args], ...opts });
  const line = (...on) => s => on.includes(s);
  assert.deepEqual([...LAUNCH_SWITCHES], ['renderer-cmd-prefix', 'browser-subprocess-path', 'utility-cmd-prefix', 'gpu-launcher']);
  assert.deepEqual([...ALLOWED_SWITCHES], ['hidden', 'updated', 'self-test']);
  assert.deepEqual([...SELF_TEST_SWITCHES], ['show-window', 'show-window-ms', 'no-relaunch', 'use-mock-keychain']);

  // What starts it: no arguments (shortcuts, the macOS login item, Squirrel.Mac's and Move to Applications' relaunch),
  // the Windows login item, the installer after an update, the self-test family as scripts/self-test.mjs and
  // footprint.mjs pass it, a relaunch passing all of that on, COM's -Embedding on Windows, LaunchServices' -psn_ on a
  // Mac, and arguments that aren't switches (nothing reads them; -- and - alone aren't switches either).
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const args of [[], ['--hidden'], ['--updated'], ['--self-test', '--use-mock-keychain'], ['--self-test', '--no-relaunch', '--use-mock-keychain', '--hidden', '--updated'],
      ['--self-test', '--show-window', '--use-mock-keychain'], ['--self-test', '--show-window', '--show-window-ms=500'], ['--HIDDEN', '-hidden', '--updated=1'],
      ['remote-debugging-port', 'C:\\games\\notes.txt', '--', '-'], ['--hidden', '--', 'x']]) {
      assert.deepEqual(check(platform, args), [], `${platform}: ${args.join(' ')}`);
    }
  }
  assert.deepEqual(check('win32', ['-Embedding']), []);
  assert.deepEqual(check('win32', ['/Embedding', '/hidden', '/updated']), [], 'Windows also reads /x');
  assert.deepEqual(check('darwin', ['-psn_0_123456']), []);
  assert.deepEqual(check('darwin', ['/Users/p/no-sandbox', '/tmp/--gpu-launcher=x']), [], 'a Mac path is no switch (Chromium reads / only on Windows)');
  assert.deepEqual(check('darwin', ['-Embedding']), ['embedding'], 'COM\'s is Windows only');
  assert.deepEqual(check('win32', ['-psn_0_1']), ['psn_0_1'], 'a process serial number is macOS only');
  assert.deepEqual(check('darwin', ['-psn_0_x', '-psn_1']), ['psn_0_x', 'psn_1']);

  // The four process-launch switches, in every syntax Chromium reads (--x, -x, Windows' /x, any case, =value, around
  // spaces it trims), and each also when only Chromium's parser sees it.
  for (const s of LAUNCH_SWITCHES) {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const a of [`--${s}=/tmp/x`, `--${s}`, `-${s}=x`, `--${s.toUpperCase()}=x`, ` --${s}=x`, `\t--${s}=x \n`, `\u00a0--${s}=x`, `\u0085--${s}=x`, `--${s}=a b c`]) {
        assert.deepEqual(check(platform, ['--hidden', a]), [s], `${platform}: ${JSON.stringify(a)}`);
      }
      assert.deepEqual(check(platform, [], { hasSwitch: line(s) }), [s], `${platform}: ${s}, Chromium's parser only`);
    }
    assert.deepEqual(check('win32', [`/${s}=x`]), [s], `/${s} on Windows`);
    assert.deepEqual(check('win32', [`/${s.toUpperCase()}`]), [s]);
  }
  // Chromium's debugging switches, as before (AP-04), now through the same check.
  for (const s of DEBUG_SWITCHES) assert.deepEqual(check('darwin', [`-${s}`]), [s], s);
  // Anything else is refused, the switches Chromium would take that no list ever had among them.
  for (const [a, name] of [['--user-data-dir=/tmp/x', 'user-data-dir'], ['--ignore-certificate-errors', 'ignore-certificate-errors'], ['--proxy-server=127.0.0.1:8080', 'proxy-server'],
    ['--host-resolver-rules=MAP * 127.0.0.1', 'host-resolver-rules'], ['--single-process', 'single-process'], ['--in-process-gpu', 'in-process-gpu'], ['--enable-logging', 'enable-logging'],
    ['--inspect=9229', 'inspect'], ['--type=renderer', 'type'], ['--remote-debugging-portal', 'remote-debugging-portal'], ['--screenshots=/tmp/x', 'screenshots'], ['--NSDocumentRevisionsDebugMode', 'nsdocumentrevisionsdebugmode'],
    ['---x', '-x'], ['--=x', '']]) {
    assert.deepEqual(check('darwin', [a]), [name], a);
  }
  // The self-test's own switches only beside --self-test, read as main.mjs reads it (exactly).
  for (const s of SELF_TEST_SWITCHES) {
    assert.deepEqual(check('darwin', [`--${s}`]), [s], `${s} without --self-test`);
    assert.deepEqual(check('win32', ['--SELF-TEST', `--${s}`]), [s], `${s} beside --SELF-TEST, which isn't the self-test`);
    assert.deepEqual(check('win32', ['/self-test', `--${s}`]), [s], `${s} beside /self-test, which isn't either`);
  }
  // Each once, argv's first, then what only Chromium's parser saw; the line names the first.
  assert.deepEqual(check('darwin', ['--foo', '--gpu-launcher=x', '--foo', '--remote-debugging-port=1'], { hasSwitch: line('renderer-cmd-prefix', 'remote-debugging-port') }),
    ['foo', 'gpu-launcher', 'remote-debugging-port', 'renderer-cmd-prefix']);
  // A command line that can't answer is refused; a development run keeps every switch.
  assert.deepEqual(check('darwin', [], { hasSwitch: () => { throw new Error('no command line'); } }), [...DEBUG_SWITCHES, ...LAUNCH_SWITCHES]);
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(launchSwitches({ packaged: false, platform, hasSwitch: line(...DEBUG_SWITCHES, ...LAUNCH_SWITCHES), argv: [exeFor(platform), '--gpu-launcher=x', '--anything', '--remote-debugging-port=9222'] }), []);
  }

  // The parts: the parser (Chromium's prefixes and trim), the rule, and the line.
  assert.deepEqual(switchNames(['--A=1', '-b', '/c', 'd', '--', '-', ' --e ', '---f'], { platform: 'linux' }), ['a', 'b', 'e', '-f']);
  assert.deepEqual(switchNames(['/c=1', '/', '//x'], { platform: 'win32' }), ['c', '/x']);
  assert.equal(allowedSwitch('use-mock-keychain', { platform: 'darwin' }), false);
  assert.equal(allowedSwitch('use-mock-keychain', { platform: 'darwin', selfTest: true }), true);
  assert.equal(allowedSwitch('embedding', { platform: 'win32' }), true);
  assert.equal(switchLine('gpu-launcher'), 'NeverQuestAlone won’t start with --gpu-launcher. Start it again without it.');
  assert.equal(switchLine(`x\u001b[31m${'y'.repeat(80)}`), `NeverQuestAlone won’t start with --x?[31m${'y'.repeat(58)}. Start it again without it.`, 'shown in plain ASCII, at most 64 characters');
});
