// Sign in with a plan, through the app API (bridge/byok/app-api.mjs signIn): the terms first, the
// sign-in hosts allowed for the job alone, the opener taking OpenAI's sign-in page only, one tiny
// test request to the plan's backend with the session's token and account header, then the plan in
// use. The browser flow itself is signin_chatgpt_test.mjs's; here a session stands in for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAppApi } from '../../bridge/byok/app-api.mjs';
import { createLocalBackend } from '../../bridge/byok/backend.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { configWithDefaults } from '../../bridge/config.mjs';
import { createSignIns } from '../../bridge/byok/signin/index.mjs';
import { authorizeUrl, packEntry } from '../../bridge/byok/signin/chatgpt.mjs';
import { manifestsAt, tmpDir } from './helpers/byok-env.mjs';

const ACCESS = 'eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.ACCESS-CANARY';
const ACCOUNT = 'acct-0001';
const SSE = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'fixtures', 'byok', 'providers', 'openai', 'success.sse'), 'utf8');

/** The plan's backend: its model list and a reply, each request's headers kept. */
async function codexMock() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.method === 'GET' && req.url.startsWith('/backend-api/codex/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }, { slug: 'gpt-6-astra', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' }] }));
      return;
    }
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => server.close(r)) };
}

/** A session that signs in at once: its browser step opens the page it's given (the opener checks it). */
function fakeFlow(calls, { result = { ok: true, plan: 'plus' }, page = null } = {}) {
  return ({ id, keystore }) => ({
    id,
    async start({ openUrl }) {
      calls.push('start');
      await openUrl(page ?? authorizeUrl({ redirectUri: 'http://127.0.0.1:1455/auth/callback', challenge: 'c', state: 's' }));
      if (result.ok) await keystore.set(id, packEntry(ACCOUNT, 'rt_x'));
      return result;
    },
    cancel() { calls.push('cancel'); },
    async credentials() { return (await keystore.get(id)) ? { key: ACCESS, kind: 'oauth', headers: { 'chatgpt-account-id': ACCOUNT } } : null; },
    async signedIn() { return !!(await keystore.get(id)); },
    signOut() { calls.push('signOut'); },
  });
}

async function rig(t, { terms = true, flow = {}, openExternal = async () => {} } = {}) {
  const mock = await codexMock();
  const dataDir = tmpDir('nqa-signin-');
  const keystore = createKeyStore({ backend: 'memory' });
  const manifests = manifestsAt(mock.url, ['chatgpt']);
  const config = configWithDefaults({ wow: { flavorDir: path.join(dataDir, 'nowhere') }, byok: { provider: 'anthropic', terms: terms ? { chatgpt: { at: 1, v: 1 } } : {} } });
  const calls = [];
  const signIns = createSignIns({ keystore, flows: { chatgpt: fakeFlow(calls, flow) } });
  const lines = [];
  const log = Object.assign((k, d) => lines.push({ k, ...d }), { addSecret: () => {} });
  const timeouts = { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 };
  const backend = createLocalBackend({}, { config, dataDir, keystore, manifests, log, signIns, providerOpts: { timeouts }, checks: { models: false } });
  await backend.start();
  const widened = [];
  const egress = { ledger: () => [], widen(hosts, feature) { widened.push([hosts, feature]); return () => {}; } };
  const opened = [];
  const api = createAppApi({
    backend, keystore, config, paths: { userData: dataDir, version: '0.1.0-test' }, log, egress, manifests, signIns,
    openExternal: async (u) => { opened.push(u); return openExternal(u); },
    wow: { run: () => ({ status: 1, stdout: '' }), roots: [] }, restart: async () => {},
  });
  t.after(async () => { await api.stop(); await backend.stop(); await mock.close(); });
  return { api, backend, keystore, config, mock, calls, widened, opened, lines };
}

test('signIn: terms first; then the browser, the sign-in hosts for the job, one test with the token and account header, and the plan in use', async (t) => {
  const none = await rig(t, { terms: false });
  assert.deepEqual(await none.api.signIn('chatgpt'), { ok: false, error: 'terms_required' });
  assert.deepEqual(none.calls, [], 'nothing opens before the terms');

  const r = await rig(t);
  const out = await r.api.signIn('chatgpt');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.plan, 'plus');
  assert.equal(out.model, 'GPT-6 Luna');
  assert.equal(out.testCall.micros, 0, 'a plan costs nothing per reply');
  assert.equal(r.opened.length, 1);
  assert.match(r.opened[0], /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.deepEqual(r.widened, [[['chatgpt.com', 'auth.openai.com'], 'sign_in'], [['chatgpt.com', 'auth.openai.com'], 'key_test']], 'the sign-in hosts for the sign-in, then for its test');
  assert.equal(r.config.byok.provider, 'chatgpt');
  assert.equal(r.config.byok.auth, 'oauth');
  assert.equal(r.config.byok.authBy.chatgpt, 'oauth');
  const post = r.mock.seen.find(s => s.method === 'POST');
  assert.ok(post, 'the one tiny test request reached the plan\'s backend');
  assert.equal(post.url, '/backend-api/codex/responses');
  assert.equal(post.headers.authorization, `Bearer ${ACCESS}`);
  assert.equal(post.headers['chatgpt-account-id'], ACCOUNT);
  assert.equal(post.headers.originator, 'neverquestalone');
  assert.ok(r.mock.seen.some(s => s.method === 'GET' && s.url === '/backend-api/codex/models?client_version=1.0.0'));
});

test('providers: the plan\'s row signs in, says it\'s signed in without a mask, and has no price per reply; a key is never pasted for it', async (t) => {
  const r = await rig(t);
  let p = (await r.api.providers()).find(x => x.id === 'chatgpt');
  assert.equal(p.auth, 'signin');
  assert.deepEqual(p.key, { saved: false });
  assert.ok(p.models.every(m => m.priceHint?.plan === true && m.levelDays === undefined));
  await r.api.signIn('chatgpt');
  p = (await r.api.providers()).find(x => x.id === 'chatgpt');
  assert.equal(p.key.saved, true);
  assert.equal(p.key.signedIn, true);
  assert.equal(p.key.masked, undefined, 'the entry is no key to show');
  assert.equal((await r.api.setKey('chatgpt', 'sk-proj-' + 'a'.repeat(40))).error, 'bad_input');
  assert.equal((await r.api.connect('chatgpt', 'sk-proj-' + 'a'.repeat(40))).error, 'bad_input');
  assert.equal((await r.api.testStagedKey('chatgpt', async () => 'sk-proj-x')).error, 'bad_input');
  const test1 = await r.api.testKey('chatgpt');
  assert.equal(test1.ok, true, 'Test sign-in uses the session');
  assert.deepEqual(test1.models, ['gpt-6-luna', 'gpt-6-astra'], 'the hidden ones aren\'t offered');
});

test('signIn: a failed browser step saves nothing and changes no AI; the opener refuses any other page; deleteKey signs out', async (t) => {
  const fail = await rig(t, { flow: { result: { ok: false, error: 'cancelled' } } });
  assert.deepEqual(await fail.api.signIn('chatgpt'), { ok: false, error: 'cancelled' });
  assert.equal(fail.config.byok.provider, 'anthropic');
  assert.equal(await fail.keystore.get('chatgpt'), null);

  const evil = await rig(t, { flow: { page: 'https://evil.test/oauth/authorize?client_id=x' } });
  await assert.rejects(evil.api.signIn('chatgpt'), /not the sign-in page/);
  assert.deepEqual(evil.opened, [], 'never handed to the shell');

  const r = await rig(t);
  await r.api.signIn('chatgpt');
  assert.deepEqual(await r.api.cancelSignIn('chatgpt'), { ok: true });
  assert.deepEqual(await r.api.deleteKey('chatgpt'), { ok: true });
  assert.ok(r.calls.includes('signOut'));
  assert.equal(await r.keystore.get('chatgpt'), null);
  assert.equal((await r.api.signIn('anthropic')).error, 'bad_input', 'a keyed AI has no sign-in');
});
