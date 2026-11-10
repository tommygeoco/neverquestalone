// Sign in with ChatGPT (bridge/byok/signin/chatgpt.mjs): the PKCE pair, the sign-in page's URL and
// the shell's check of it, the redirect's listener on 127.0.0.1, the token exchange, and the access
// token's refresh (rotation, an ended sign-in, a network failure). No request leaves this computer:
// the token endpoint is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  pkce, authorizeUrl, isAuthorizeUrl, claimsOf, accountOf, packEntry, unpackEntry, listenForCode,
  createChatgptSignIn, CLIENT_ID, ISSUER, PREFIX, REFRESH_EARLY_MS, ORIGINATOR,
} from '../../bridge/byok/signin/chatgpt.mjs';
import { createSignIns } from '../../bridge/byok/signin/index.mjs';
import { KEY_MAX } from '../../bridge/byok/security/keystore.mjs';

const ACCOUNT = '0f0e0d0c-0b0a-4908-8706-050403020100';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token-shaped JWT (unsigned: only its claims are read). */
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const authClaim = (extra = {}) => ({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus', ...extra } });

function memKeystore() {
  const m = new Map();
  return { m, get: async id => m.get(id) ?? null, set: async (id, v) => { m.set(id, v); }, delete: async id => { m.delete(id); } };
}

/** A token endpoint: each call is recorded; `reply(body)` answers {status, json}. */
function tokenServer(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    const ct = init.headers['content-type'];
    const body = ct.includes('json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, ct, body, redirect: init.redirect });
    const r = await reply(body);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const tokens = ({ now = Date.now(), refresh = 'rt_1', life = 3600 } = {}) => ({
  access_token: jwt({ exp: Math.floor(now / 1000) + life, ...authClaim() }),
  id_token: jwt(authClaim()),
  refresh_token: refresh,
  expires_in: life,
});

test('PKCE: an S256 challenge of a 64-byte verifier; the sign-in page URL carries the public client id, the challenge, the state and our name', () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const url = authorizeUrl({ redirectUri: 'http://127.0.0.1:1455/auth/callback', challenge, state: 'st8' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, `${ISSUER}/oauth/authorize`);
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('code_challenge'), challenge);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'st8');
  assert.equal(u.searchParams.get('scope'), 'openid profile email offline_access', 'no connector scopes: the app only talks');
  assert.equal(u.searchParams.get('originator'), ORIGINATOR, 'the app says who it is; it never poses as Codex');
  assert.equal(u.searchParams.has('code_verifier'), false, 'the verifier never leaves');
  assert.equal(isAuthorizeUrl(url), true);
});

test('the shell opens OpenAI\'s authorize page only, for our client, with our callback on 127.0.0.1', () => {
  const ok = authorizeUrl({ redirectUri: 'http://127.0.0.1:1457/auth/callback', challenge: 'c', state: 's' });
  assert.equal(isAuthorizeUrl(ok), true, 'the fallback port too');
  const bad = [
    'https://auth.openai.com.evil.test/oauth/authorize?client_id=' + CLIENT_ID,
    ok.replace('https://', 'http://'),
    ok.replace('/oauth/authorize', '/oauth/token'),
    ok.replace(CLIENT_ID, 'app_other'),
    ok.replace(encodeURIComponent('http://127.0.0.1:1457/auth/callback'), encodeURIComponent('https://evil.test/cb')),
    ok.replace(encodeURIComponent('http://127.0.0.1:1457/auth/callback'), encodeURIComponent('http://127.0.0.1:9999/auth/callback')),
    ok + '#frag',
    'not a url',
    'https://user:pw@auth.openai.com/oauth/authorize',
  ];
  for (const u of bad) assert.equal(isAuthorizeUrl(u), false, u);
});

test('claims: the account, plan and expiry from the tokens; a bad token reads as nothing', () => {
  const now = 1_790_000_000_000;
  const t = tokens({ now });
  assert.deepEqual(accountOf(t), { account: ACCOUNT, plan: 'plus', exp: Math.floor(now / 1000) * 1000 + 3600_000 });
  assert.deepEqual(claimsOf('garbage'), {});
  assert.deepEqual(accountOf({ access_token: 'x.y.z' }), { account: null, plan: null, exp: null });
});

test('the key-store entry: the account and refresh token only, well under the key store\'s limit; anything else reads as no sign-in', () => {
  const refresh = 'rt_' + 'A'.repeat(200);
  const e = packEntry(ACCOUNT, refresh);
  assert.ok(e.startsWith(PREFIX) && e.length < KEY_MAX / 2, `${e.length} characters`);
  assert.match(e, /^[\x21-\x7e]+$/, 'printable ASCII, no spaces (normalizeKey)');
  assert.deepEqual(unpackEntry(e), { account: ACCOUNT, refresh });
  assert.deepEqual(unpackEntry(packEntry(ACCOUNT, 'rt:with:colons')), { account: ACCOUNT, refresh: 'rt:with:colons' });
  for (const bad of [null, '', 'sk-proj-abc', PREFIX, `${PREFIX}${ACCOUNT}`, `${PREFIX}${ACCOUNT}:`, `${PREFIX}:rt`]) assert.equal(unpackEntry(bad), null, String(bad));
});

test('the listener: 127.0.0.1 only, the callback path only, the state it sent; a wrong state is refused and the wait goes on', async () => {
  const l = await listenForCode({ state: 'right', ports: [0], timeoutMs: 5000 });
  try {
    const u = new URL(l.redirectUri);
    assert.equal(u.hostname, '127.0.0.1');
    assert.equal(u.pathname, '/auth/callback');
    assert.equal((await fetch(new URL('/other', u))).status, 404);
    const wrong = await fetch(`${l.redirectUri}?code=c1&state=wrong`);
    assert.equal(wrong.status, 400);
    const ok = await fetch(`${l.redirectUri}?code=c2&state=right`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /signed in/i);
    assert.deepEqual(await l.result, { code: 'c2' });
  } finally { l.close(); }
});

test('the listener: a denial is cancelled, a timeout times out, an abort cancels, and a busy port moves to the next', async () => {
  const deny = await listenForCode({ state: 's', ports: [0], timeoutMs: 5000 });
  await fetch(`${deny.redirectUri}?error=access_denied&state=s`);
  assert.deepEqual(await deny.result, { error: 'cancelled' });
  const slow = await listenForCode({ state: 's', ports: [0], timeoutMs: 30 });
  assert.deepEqual(await slow.result, { error: 'timeout' });
  const ac = new AbortController();
  const ab = await listenForCode({ state: 's', ports: [0], timeoutMs: 5000, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await ab.result, { error: 'cancelled' });
  // The first port taken: the second answers.
  const first = await listenForCode({ state: 'a', ports: [0], timeoutMs: 5000 });
  const taken = Number(new URL(first.redirectUri).port);
  const second = await listenForCode({ state: 'b', ports: [taken, 0], timeoutMs: 5000 });
  assert.notEqual(Number(new URL(second.redirectUri).port), taken);
  // Every port taken (Codex's own sign-in open on 1455 and 1457): port_busy, nothing listening.
  const none = await listenForCode({ state: 'c', ports: [taken], timeoutMs: 5000 });
  assert.equal(none.redirectUri, null);
  assert.deepEqual(await none.result, { error: 'port_busy' });
  first.close(); second.close();
});

/** A sign-in whose browser "signs in" at once: openUrl follows the redirect with a code. */
function browserThatSignsIn({ code = 'the-code', mutate = u => u } = {}) {
  const opened = [];
  const openUrl = async (url) => {
    opened.push(url);
    const u = new URL(url);
    const cb = new URL(u.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', code);
    cb.searchParams.set('state', u.searchParams.get('state'));
    setTimeout(() => { fetch(mutate(cb.href)).catch(() => {}); }, 5);
  };
  return { opened, openUrl };
}
const anyPort = (o) => listenForCode({ ...o, ports: [0] });

test('start: the browser signs in, the code and verifier become tokens, the entry is saved, and requests get the token and the account header', async () => {
  const ks = memKeystore();
  const srv = tokenServer(() => ({ json: tokens() }));
  const secrets = [];
  const log = Object.assign(() => {}, { addSecret: s => secrets.push(s) });
  const s = createChatgptSignIn({ keystore: ks, fetch: srv.fetch, listen: anyPort, log });
  const b = browserThatSignsIn();
  const r = await s.start({ openUrl: b.openUrl });
  assert.deepEqual(r, { ok: true, plan: 'plus' });
  assert.equal(b.opened.length, 1);
  assert.equal(srv.calls.length, 1);
  const c = srv.calls[0];
  assert.equal(c.url, `${ISSUER}/oauth/token`);
  assert.equal(c.redirect, 'manual', 'a token request never follows a redirect');
  assert.match(c.ct, /x-www-form-urlencoded/);
  assert.equal(c.body.grant_type, 'authorization_code');
  assert.equal(c.body.code, 'the-code');
  assert.equal(c.body.client_id, CLIENT_ID);
  const sent = new URL(b.opened[0]);
  assert.equal(crypto.createHash('sha256').update(c.body.code_verifier).digest('base64url'), sent.searchParams.get('code_challenge'), 'the verifier matches the challenge the page got');
  assert.equal(c.body.redirect_uri, sent.searchParams.get('redirect_uri'));
  assert.deepEqual(unpackEntry(ks.m.get('chatgpt')), { account: ACCOUNT, refresh: 'rt_1' });
  assert.equal(await s.signedIn(), true);
  const cred = await s.credentials();
  assert.equal(cred.kind, 'oauth');
  assert.deepEqual(cred.headers, { 'chatgpt-account-id': ACCOUNT });
  assert.match(cred.key, /^eyJ/);
  assert.equal(srv.calls.length, 1, 'a fresh token is used as it is, no refresh');
  assert.ok(secrets.includes('rt_1') && secrets.includes(cred.key), 'the tokens are registered with the log\'s redactor');
});

test('start: a wrong state, a refused code, an account-less token, no opener, and a browser that won\'t open each fail plainly and save nothing', async () => {
  const ks = memKeystore();
  const ok = tokenServer(() => ({ json: tokens() }));
  const wrongState = createChatgptSignIn({ keystore: ks, fetch: ok.fetch, listen: o => anyPort({ ...o, timeoutMs: 200 }) });
  const b1 = browserThatSignsIn({ mutate: u => u.replace(/state=[^&]+/, 'state=forged') });
  assert.deepEqual(await wrongState.start({ openUrl: b1.openUrl }), { ok: false, error: 'timeout' }, 'a forged state is never taken; the wait runs out');
  assert.equal(ok.calls.length, 0);
  const refused = tokenServer(() => ({ status: 400, json: { error: 'invalid_grant' } }));
  const s2 = createChatgptSignIn({ keystore: ks, fetch: refused.fetch, listen: anyPort });
  assert.deepEqual(await s2.start({ openUrl: browserThatSignsIn().openUrl }), { ok: false, error: 'sign_in_failed' });
  const noAcct = tokenServer(() => ({ json: { access_token: jwt({ exp: 9e9 }), refresh_token: 'rt' } }));
  const s3 = createChatgptSignIn({ keystore: ks, fetch: noAcct.fetch, listen: anyPort });
  assert.deepEqual(await s3.start({ openUrl: browserThatSignsIn().openUrl }), { ok: false, error: 'no_account' });
  const s4 = createChatgptSignIn({ keystore: ks, fetch: ok.fetch, listen: anyPort });
  assert.deepEqual(await s4.start({}), { ok: false, error: 'unsupported' });
  assert.deepEqual(await s4.start({ openUrl: async () => { throw new Error('no browser'); } }), { ok: false, error: 'browser_failed' });
  assert.equal(ks.m.size, 0, 'nothing saved');
});

test('credentials: a token near its expiry is refreshed first; a rotated refresh token is saved before the new access token is used; one refresh at a time', async () => {
  let t = 1_790_000_000_000;
  const ks = memKeystore();
  ks.m.set('chatgpt', packEntry(ACCOUNT, 'rt_old'));
  let n = 0;
  const srv = tokenServer(async (body) => {
    n++;
    await new Promise(r => setTimeout(r, 10));
    return { json: tokens({ now: t, refresh: `rt_${n}`, life: 3600 }) };
  });
  const s = createChatgptSignIn({ keystore: ks, fetch: srv.fetch, now: () => t });
  const [a, b] = await Promise.all([s.credentials(), s.credentials()]);
  assert.equal(srv.calls.length, 1, 'two requests at once share one refresh');
  assert.equal(a.key, b.key);
  assert.deepEqual(srv.calls[0].body, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'rt_old' });
  assert.match(srv.calls[0].ct, /json/);
  assert.deepEqual(unpackEntry(ks.m.get('chatgpt')), { account: ACCOUNT, refresh: 'rt_1' }, 'OpenAI rotated it: the new one is kept');
  t += 3600_000 - REFRESH_EARLY_MS - 1000;
  await s.credentials();
  assert.equal(srv.calls.length, 1, 'still fresh');
  t += 2000;
  await s.credentials();
  assert.equal(srv.calls.length, 2, 'within five minutes of expiring: refreshed');
  assert.equal(srv.calls[1].body.refresh_token, 'rt_1');
});

test('credentials: no entry is no sign-in; a refused refresh ends the sign-in (expired) until the next one; a network failure throws and keeps the entry', async () => {
  const empty = createChatgptSignIn({ keystore: memKeystore(), fetch: async () => { throw new Error('no request expected'); } });
  assert.equal(await empty.credentials(), null);
  for (const code of ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']) {
    const ks = memKeystore();
    ks.m.set('chatgpt', packEntry(ACCOUNT, 'rt'));
    const srv = tokenServer(() => ({ status: 400, json: { error: code } }));
    const s = createChatgptSignIn({ keystore: ks, fetch: srv.fetch });
    assert.deepEqual(await s.credentials(), { expired: true }, code);
    assert.deepEqual(await s.credentials(), { expired: true }, `${code}: no second refresh`);
    assert.equal(srv.calls.length, 1);
    assert.ok(ks.m.has('chatgpt'), 'the entry stays until the player signs in again or out');
    s.signOut();
  }
  const ks = memKeystore();
  ks.m.set('chatgpt', packEntry(ACCOUNT, 'rt'));
  const down = createChatgptSignIn({ keystore: ks, fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(down.credentials(), /fetch failed/);
  const busy = createChatgptSignIn({ keystore: ks, fetch: tokenServer(() => ({ status: 503, json: {} })).fetch });
  await assert.rejects(busy.credentials(), e => e.code === 'refresh_failed' && e.status === 503);
  assert.deepEqual(unpackEntry(ks.m.get('chatgpt')), { account: ACCOUNT, refresh: 'rt' });
  const broken = createChatgptSignIn({ keystore: { get: async () => { throw new Error('locked'); } }, fetch: srv0() });
  await assert.rejects(broken.credentials(), e => e.code === 'keystore_error');
});
function srv0() { return async () => { throw new Error('no request expected'); }; }

test('the sign-ins: one session per sign-in manifest, shared; none for a keyed one or without a key store', () => {
  const si = createSignIns({ keystore: memKeystore(), fetch: srv0() });
  const m = { id: 'chatgpt', auth: { signIn: 'chatgpt' } };
  assert.ok(si.for(m));
  assert.equal(si.for(m), si.for(m));
  assert.equal(si.for({ id: 'openai', auth: { header: 'authorization' } }), null);
  assert.equal(si.for({ id: 'x', auth: { signIn: 'unknown' } }), null);
  assert.equal(createSignIns({ keystore: null }).for(m), null);
});

test('the provider layer: an ended sign-in is oauth_expired (Sign in again), a renewal that couldn\'t reach OpenAI is a network error, and the account header is redacted in Last request', async () => {
  const { loadManifests, createProvider, redactHeaders } = await import('../../bridge/byok/providers/index.mjs');
  const m = loadManifests().find(x => x.id === 'chatgpt');
  const first = async (getKey) => {
    for await (const ev of createProvider(m, { getKey, fetch: srv0() }).stream({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] })) if (ev.type === 'error') return ev.error;
    return null;
  };
  assert.equal((await first(async () => ({ expired: true }))).kind, 'oauth_expired');
  assert.equal((await first(async () => null)).kind, 'no_key');
  const net = await first(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  assert.match(net.kind, /^network/, net.kind);
  assert.equal((await first(async () => { throw Object.assign(new Error('locked'), { code: 'keystore_error' }); })).code, 'keystore_error');
  const shown = redactHeaders({ authorization: 'Bearer eyJabcdefghijklmnopqrstuvwxyz0123', 'chatgpt-account-id': ACCOUNT, originator: 'neverquestalone' }, m);
  assert.equal(shown['chatgpt-account-id'], '[redacted]');
  assert.equal(shown.originator, 'neverquestalone');
  assert.doesNotMatch(shown.authorization, /abcdefghijklmnop/);
});
