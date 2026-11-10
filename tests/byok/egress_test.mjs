// The egress guard as a fetch wrapper (bridge/byok/security/egress.mjs; PRD §8.4 items 1-2, KY-6,
// KY-7, TH15; systems plan SY-13): the allowlist, the Connections ledger, redirects checked hop by
// hop, the refusal's shape the provider layer files as egress_blocked, and the CI check that no
// shipped module opens a socket any other way. A stand-in fetch records what would have gone out;
// one real round trip goes to a server on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEgress, normHost, isLoopbackHost, egressError, CONNECTIONS_NOTE, MAX_REDIRECTS } from '../../bridge/byok/security/egress.mjs';
import { classify, fetchErrorPhase, needsRestart, userLine, EGRESS_BLOCKED, EGRESS_STOPPED } from '../../bridge/byok/providers/errors.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A fetch that answers from a table ({url → {status, location}}) and records every call. */
function fakeFetch(table = {}) {
  const calls = [];
  const f = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url ?? input.href;
    calls.push({ url, init });
    const r = table[url] ?? { status: 200 };
    return new Response(r.body ?? 'ok', { status: r.status, headers: r.location ? { location: r.location } : {} });
  };
  f.calls = calls;
  return f;
}

test('egress: host names are normalised; loopback means localhost, 127/8 and ::1 by name', () => {
  assert.equal(normHost(' API.Anthropic.com. '), 'api.anthropic.com');
  assert.equal(normHost('[::1]'), '::1');
  for (const h of ['localhost', '127.0.0.1', '127.9.8.7', '::1', '[::1]', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['127.example.com', '10.0.0.1', '999.0.0.1', 'localhost.evil.test', '::2']) assert.equal(isLoopbackHost(h), false, h);
});

test('egress: an allowed host goes through and is recorded; any other is refused before fetch is called', async () => {
  const f = fakeFetch();
  let t = 1000;
  const eg = createEgress({ allowHosts: () => new Map([['api.provider.test', 'provider']]), fetch: f, now: () => t++ });
  assert.equal((await eg.fetch('https://api.provider.test/v1/x', { method: 'POST' })).status, 200);
  await assert.rejects(eg.fetch('https://evil.test/steal'), (e) => {
    assert.ok(e instanceof TypeError);
    assert.equal(e.cause.code, EGRESS_BLOCKED);
    assert.equal(e.cause.host, 'evil.test');
    return true;
  });
  assert.deepEqual(f.calls.map(c => c.url), ['https://api.provider.test/v1/x'], 'nothing was sent to evil.test, not even a name lookup');
  assert.deepEqual(eg.ledger().map(e => [e.host, e.port, e.feature, e.allowed, e.count]), [
    ['api.provider.test', 443, 'provider', true, 1],
    ['evil.test', 443, 'unknown', false, 1],
  ]);
});

test('egress: only http and https go anywhere; a Request and a URL are checked like a string', async () => {
  const f = fakeFetch();
  const eg = createEgress({ allowHosts: () => new Set(['api.provider.test']), fetch: f });
  for (const u of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://api.provider.test/x']) {
    await assert.rejects(eg.fetch(u), e => e.cause?.code === EGRESS_BLOCKED, u);
  }
  await eg.fetch(new URL('https://api.provider.test/a'));
  await eg.fetch(new Request('https://api.provider.test/b'));
  await assert.rejects(eg.fetch(new Request('https://other.test/c')), e => e.cause?.code === EGRESS_BLOCKED);
  assert.equal(f.calls.length, 2);
});

test('egress: the refusal is filed by the provider layer as egress_blocked: never sent, never retried', () => {
  const e = egressError('evil.test', 443);
  assert.equal(fetchErrorPhase(e), 'before_send');
  const c = classify('anthropic', { networkPhase: fetchErrorPhase(e), networkError: e });
  assert.equal(c.kind, 'egress_blocked');
  assert.equal(c.retryable, false);
});

test('egress: redirects are followed here, one hop at a time, and only to allowed hosts', async () => {
  const f = fakeFetch({
    'https://a.test/start': { status: 302, location: 'https://b.test/next' },
    'https://b.test/next': { status: 307, location: '/final' },
    'https://a.test/leak': { status: 301, location: 'https://evil.test/collect' },
    'https://a.test/post': { status: 303, location: 'https://b.test/got' },
  });
  const eg = createEgress({ allowHosts: () => new Set(['a.test', 'b.test']), fetch: f });
  const r = await eg.fetch('https://a.test/start');
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls.map(c => [c.url, c.init.redirect]), [['https://a.test/start', 'manual'], ['https://b.test/next', 'manual'], ['https://b.test/final', 'manual']]);
  f.calls.length = 0;
  await assert.rejects(eg.fetch('https://a.test/leak'), e => e.cause?.code === EGRESS_BLOCKED && e.cause.host === 'evil.test');
  assert.deepEqual(f.calls.map(c => c.url), ['https://a.test/leak'], 'the redirect to evil.test never went out');
  f.calls.length = 0;
  await eg.fetch('https://a.test/post', { method: 'POST', body: 'x' });
  assert.equal(f.calls[1].init.method, 'GET', '303 turns into a GET');
  assert.equal(f.calls[1].init.body, undefined);
  // A caller that asks for redirect 'manual' (the provider layer always does) gets fetch's own.
  f.calls.length = 0;
  const manual = await eg.fetch('https://a.test/start', { redirect: 'manual' });
  assert.equal(manual.status, 302);
  assert.equal(f.calls.length, 1);
  // A loop ends after fetch's own limit.
  const loop = fakeFetch({ 'https://a.test/loop': { status: 302, location: 'https://a.test/loop' } });
  const eg2 = createEgress({ allowHosts: () => new Set(['a.test']), fetch: loop });
  await assert.rejects(eg2.fetch('https://a.test/loop'), e => e.cause?.code === 'ERR_TOO_MANY_REDIRECTS');
  assert.equal(loop.calls.length, MAX_REDIRECTS + 1);
});

test('egress: features come from the allowlist Map (the longest wildcard wins), else featureFor; the list is read per request', async () => {
  const hosts = new Map([['*.cloud.test', 'provider'], ['*.cdn.cloud.test', 'sign_in'], ['API.X.test.', 'key_test']]);
  const f = fakeFetch();
  const eg = createEgress({ allowHosts: () => hosts, loopbackOk: true, featureFor: h => (isLoopbackHost(h) ? 'local_model' : null), fetch: f });
  await eg.fetch('https://gen.cloud.test/');
  await eg.fetch('https://a.cdn.cloud.test/');
  await eg.fetch('https://api.x.test/');
  await eg.fetch('http://127.0.0.1:11434/api/tags');
  assert.deepEqual(eg.ledger().map(e => [e.host, e.port, e.feature]), [
    ['gen.cloud.test', 443, 'provider'], ['a.cdn.cloud.test', 443, 'sign_in'], ['api.x.test', 443, 'key_test'], ['127.0.0.1', 11434, 'local_model'],
  ]);
  hosts.delete('API.X.test.');
  await assert.rejects(eg.fetch('https://api.x.test/'), e => e.cause?.code === EGRESS_BLOCKED, 'read per request');
  await assert.rejects(eg.fetch('https://cloud.test/'), e => e.cause?.code === EGRESS_BLOCKED, '*.domain allows subdomains only');
  eg.uninstall();
  await assert.rejects(eg.fetch('https://gen.cloud.test/'), e => e.cause?.code === EGRESS_STOPPED, 'nothing goes after stop, and the refusal says the guard stopped');
});

// fix-102 (2026-09-30): the player's app kept its window after the bridge stopped at a quit that
// didn't finish. The stopped guard refused api.anthropic.com, the AI's own host, and setup said
// "Can't reach Anthropic. Check your internet". Its refusal now has its own code, the event says
// stopped, and the provider layer files it as the app's own fault (needsRestart), never a network one.
test('egress (fix-102): a stopped guard refuses even the AI\'s own host with EGRESS_STOPPED, the event says stopped, and the words say restart, never the internet', async () => {
  const f = fakeFetch();
  const events = [];
  const manifest = { id: 'anthropic', hosts: ['api.anthropic.com'] };
  const eg = createEgress({ allowHosts: () => new Map([['api.anthropic.com', 'provider']]), fetch: f, onEvent: e => events.push(e) });
  assert.equal(eg.stopped(), false);
  assert.equal((await eg.fetch('https://api.anthropic.com/v1/models')).status, 200, 'a fresh guard lets the AI\'s host through');
  eg.uninstall();
  assert.equal(eg.stopped(), true);
  let refused = null;
  await assert.rejects(eg.fetch('https://api.anthropic.com/v1/models'), (e) => { refused = e; return e instanceof TypeError && e.message === 'fetch failed'; });
  assert.equal(refused.cause.code, EGRESS_STOPPED);
  assert.equal(refused.cause.host, 'api.anthropic.com');
  assert.equal(f.calls.length, 1, 'nothing was sent after the stop');
  // The owner's log line, "egress-blocked {host: api.anthropic.com, port 443, feature: provider}", now says why.
  const last = events.at(-1);
  assert.deepEqual([last.type, last.host, last.port, last.feature, last.stopped], ['blocked', 'api.anthropic.com', 443, 'provider', true]);
  // Filed before anything was sent, never retried, and as the app's own fault.
  assert.equal(fetchErrorPhase(refused), 'before_send');
  const c = classify(manifest, { networkPhase: fetchErrorPhase(refused), networkError: refused });
  assert.deepEqual([c.kind, c.code, c.retryable], ['egress_blocked', EGRESS_STOPPED, false]);
  assert.equal(needsRestart(c), true);
  const l = userLine(c, { provider: 'Anthropic' });
  assert.equal(l.headline, 'NeverQuestAlone needs a restart.');
  assert.equal(l.detail, 'Quit and reopen the NeverQuestAlone app.');
  assert.equal(l.action.id, 'restart');
  assert.doesNotMatch(`${l.headline} ${l.detail}`, /internet|can.t reach/i);
  // A live guard refusing the AI's own host (an allowlist that lost it) is the app's fault too.
  const lost = createEgress({ allowHosts: () => new Set(), fetch: f });
  let e2 = null;
  await assert.rejects(lost.fetch('https://api.anthropic.com/v1/models'), (e) => { e2 = e; return true; });
  assert.equal(e2.cause.code, EGRESS_BLOCKED);
  const c2 = classify(manifest, { networkPhase: 'before_send', networkError: e2 });
  assert.deepEqual([c2.kind, c2.code, c2.ownHost], ['egress_blocked', EGRESS_BLOCKED, true]);
  assert.equal(needsRestart(c2), true);
  // Another host refused by a live guard stays a block the Connections page explains.
  const c3 = classify(manifest, { networkPhase: 'before_send', networkError: egressError('evil.test', 443) });
  assert.equal(c3.ownHost, undefined);
  assert.equal(needsRestart(c3), false);
  assert.equal(userLine(c3, { provider: 'Anthropic' }).action.id, 'connections');
});

test('egress: loopbackOk allows local models by name; a name that resolves to loopback is not loopback', async () => {
  const f = fakeFetch();
  const off = createEgress({ allowHosts: () => new Set(), loopbackOk: false, fetch: f });
  await assert.rejects(off.fetch('http://127.0.0.1:1234/'), e => e.cause?.code === EGRESS_BLOCKED);
  const on = createEgress({ allowHosts: () => new Set(), fetch: f });
  await on.fetch('http://localhost:1234/');
  await assert.rejects(on.fetch('http://localtest.me:1234/'), e => e.cause?.code === EGRESS_BLOCKED);
});

test('egress: a real round trip through the global fetch to 127.0.0.1 is recorded', async (t) => {
  // Connection: close, and every connection closed before the test ends (the mock provider's reason:
  // tests/byok/helpers/mock-provider.mjs, CI run 37150133957).
  const srv = http.createServer((req, res) => { res.shouldKeepAlive = false; res.end('pong'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); });
  const eg = createEgress({ allowHosts: () => new Set() });
  const res = await eg.fetch(`http://127.0.0.1:${srv.address().port}/ping`);
  assert.equal(await res.text(), 'pong');
  assert.deepEqual(eg.ledger().map(e => [e.host, e.port, e.allowed]), [['127.0.0.1', srv.address().port, true]]);
});

test('egress: the Connections note says what it covers, with no startup self-test left to fail', () => {
  assert.match(CONNECTIONS_NOTE, /refused before anything is sent/);
  assert.doesNotMatch(CONNECTIONS_NOTE, /DNS|lookup/);
  const boot = fs.readFileSync(path.join(REPO, 'bridge', 'byok', 'boot.mjs'), 'utf8');
  assert.doesNotMatch(boot, /selfTest\(|method: 'HEAD'/, 'no HEAD request at every start');
});

// ---- the CI check: nothing the app ships opens a socket except through guardedFetch --------------

/** The public app's own JavaScript: what electron-builder packs from bridge/ and the desktop app's main process. */
function shippedFiles() {
  const out = [];
  const walk = (dir, keep) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, keep); } else if (keep(p)) out.push(p);
    }
  };
  const B = path.join(REPO, 'bridge');
  for (const f of ['service.mjs', 'config.mjs', 'log.mjs']) if (fs.existsSync(path.join(B, f))) out.push(path.join(B, f));
  for (const d of ['app', 'transport', 'byok']) walk(path.join(B, d), p => /\.(mjs|js|cjs)$/.test(p));
  const D = path.join(REPO, 'app', 'desktop');
  for (const f of ['main.mjs', 'ipc.mjs', 'updater.mjs', 'preload.cjs']) out.push(path.join(D, f));
  walk(path.join(D, 'src'), p => /\.(mjs|js|cjs)$/.test(p));
  return out;
}

/** The modules that may import a network module, and why: none of them reaches the internet. */
const LOCAL_ONLY = Object.freeze({
  'bridge/transport/capture.mjs': ['node:net', 'the capture helper\'s local socket (a Unix socket in the app\'s own folder)'],
  'app/desktop/src/capture-gate.mjs': ['node:net', 'the packaged self-test\'s check of the capture helper (code health BR-01): a Unix socket in a temp folder of its own, only under --self-test'],
  'bridge/byok/signin/chatgpt.mjs': ['node:http', 'Sign in with ChatGPT\'s redirect: a listener on 127.0.0.1 only (ports 1455, 1457), one GET with the state it sent, open only while a sign-in waits; the token requests go through the guarded fetch'],
  'app/desktop/src/extra-ca.mjs': ['node:tls', 'the packaged self-test\'s count of the certificates NODE_EXTRA_CA_CERTS added (SR-05): tls.getCACertificates(\'extra\'), a list read, never a connection, only under --self-test'],
});

const NET_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:node:)?(net|http|https|tls|http2|dgram|undici)['"]/g;

test('CI: no shipped module imports net, http, https, tls, http2, dgram or undici except the local-only ones listed', () => {
  const files = shippedFiles();
  assert.ok(files.length > 40, `the scan sees the app (${files.length} files)`);
  const found = {};
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const mods = [...text.matchAll(NET_IMPORT)].map(m => `node:${m[1]}`);
    if (mods.length) found[path.relative(REPO, f).split(path.sep).join('/')] = [...new Set(mods)];
  }
  for (const [file, mods] of Object.entries(found)) {
    assert.ok(Object.hasOwn(LOCAL_ONLY, file), `${file} imports ${mods.join(', ')}: reach the network through the guarded fetch boot hands out, or list it here with why it never leaves this computer`);
    assert.deepEqual(mods, [LOCAL_ONLY[file][0]], file);
  }
  for (const file of Object.keys(LOCAL_ONLY)) assert.ok(found[file], `${file} no longer needs its exception: drop it`);
  // The pattern itself: it sees every form an import can take.
  for (const line of ["import net from 'node:net';", 'const h = require("https")', "await import('node:tls')", "import { request } from 'undici'"]) {
    NET_IMPORT.lastIndex = 0;
    assert.ok(NET_IMPORT.test(line), line);
  }
});
