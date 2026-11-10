// Sign in with ChatGPT: a ChatGPT plan (Plus, Pro, Business …) in place of an API key, the way
// OpenAI's own Codex CLI signs in, and the way OpenAI supports for third-party tools. The flow is
// OAuth 2.0 authorization code with PKCE (RFC 7636) against auth.openai.com, its redirect caught by a
// listener on this computer (127.0.0.1 only), and the plan's model calls go to the Codex backend
// (manifests/chatgpt.json) with the access token and the account's id.
//
//   createChatgptSignIn({ id, keystore, fetch, log, now, random, listen, openUrl })
//     → { id, start({ openUrl, signal }) → {ok, account?, plan?} | {ok:false, error},
//         credentials() → {key, kind:'oauth', headers} | {expired:true} | null,
//         signedIn() → bool, signOut() }
//
// What's kept (KY-9: a key never leaves the key store or this process):
//   - the key store holds one entry, `${PREFIX}<account id>:<refresh token>` (well under KEY_MAX: a
//     refresh token is ~200 characters, an access token ~1,700, too big for Windows' entry);
//   - the access token lives in memory only, and is fetched again with the refresh token when it's
//     within REFRESH_EARLY_MS of expiring (or on start). OpenAI rotates refresh tokens: a new one is
//     saved before the access token it came with is used, so a crash can't strand the old one.
// A refresh OpenAI refuses (expired, reused, revoked: invalid_grant) means the sign-in ended:
// credentials() answers {expired:true}, the provider layer reports oauth_expired ("Sign in again"),
// and the entry stays until the player signs in again or out. A network failure isn't that: it
// throws, and the turn fails as a network error with the entry untouched.
import http from 'node:http';
import crypto from 'node:crypto';

/** OpenAI's sign-in service, and the public client id its Codex CLI signs in with. */
export const ISSUER = 'https://auth.openai.com';
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** The redirect ports the client id allows (Codex CLI's own: 1455, else 1457), on 127.0.0.1 only. */
export const PORTS = Object.freeze([1455, 1457]);
export const CALLBACK_PATH = '/auth/callback';
export const SCOPE = 'openid profile email offline_access';
/** Who's asking, as the sign-in page and the Codex backend are told (no impersonation of Codex). */
export const ORIGINATOR = 'neverquestalone';
/** The key-store entry's shape: `nqa-cg1:<account id>:<refresh token>`. */
export const PREFIX = 'nqa-cg1:';
/** How long the browser has to come back (the player signs in, maybe makes an account). */
export const SIGN_IN_MS = 5 * 60_000;
/** A token this close to expiring is refreshed first. */
export const REFRESH_EARLY_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
/** The claim OpenAI's tokens carry the ChatGPT account in. */
const AUTH_CLAIM = 'https://api.openai.com/auth';
const REFRESH_ENDED = new Set(['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']);

const b64url = buf => Buffer.from(buf).toString('base64url');

/** A PKCE pair (S256): the verifier stays here, the challenge goes in the sign-in URL. */
export function pkce(random = crypto.randomBytes) {
  const verifier = b64url(random(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** The sign-in page's URL. The query is the whole of what the player's browser is sent to. */
export function authorizeUrl({ redirectUri, challenge, state }) {
  const u = new URL('/oauth/authorize', ISSUER);
  const q = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.href;
}

/** Is this the sign-in page's URL, and only that (the shell's check before it opens a browser)? */
export function isAuthorizeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== ISSUER || u.pathname !== '/oauth/authorize' || u.username || u.password || u.hash) return false;
  if (u.searchParams.get('client_id') !== CLIENT_ID) return false;
  const r = u.searchParams.get('redirect_uri') ?? '';
  return PORTS.some(p => r === `http://127.0.0.1:${p}${CALLBACK_PATH}`);
}

/** A JWT's claims, unverified (they came straight from OpenAI over TLS; only ids and times are read). */
export function claimsOf(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}

/** The ChatGPT account id, plan and expiry a token set names. */
export function accountOf({ id_token: idt, access_token: at } = {}) {
  const ic = claimsOf(idt);
  const ac = claimsOf(at);
  const a = { ...(ac[AUTH_CLAIM] ?? {}), ...(ic[AUTH_CLAIM] ?? {}) };
  const account = typeof a.chatgpt_account_id === 'string' && a.chatgpt_account_id ? a.chatgpt_account_id : null;
  const plan = typeof a.chatgpt_plan_type === 'string' ? a.chatgpt_plan_type : null;
  const exp = Number.isFinite(ac.exp) ? ac.exp * 1000 : null;
  return { account, plan, exp };
}

/** The key-store entry for a signed-in account, and back. */
export function packEntry(account, refresh) { return `${PREFIX}${account}:${refresh}`; }
export function unpackEntry(s) {
  if (typeof s !== 'string' || !s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { account: rest.slice(0, i), refresh: rest.slice(i + 1) };
}

function signInError(code, extra = {}) { return { ok: false, error: code, ...extra }; }

/** POST to the token endpoint. → {ok, json} | {ok:false, status, code} (network errors throw). */
async function tokenPost(fetchFn, body, form) {
  const res = await fetchFn(new URL('/oauth/token', ISSUER).href, {
    method: 'POST',
    headers: form ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { json = null; }
  if (res.ok && json && typeof json.access_token === 'string') return { ok: true, json };
  const e = json?.error;
  const code = typeof e === 'string' ? e : typeof e?.code === 'string' ? e.code : null;
  return { ok: false, status: res.status, code };
}

/** The code from the browser, swapped for tokens (the verifier proves this app asked for it). */
export function exchangeCode(fetchFn, { code, verifier, redirectUri }) {
  return tokenPost(fetchFn, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier }, true);
}

/** A refresh token swapped for a new access token (and, usually, a new refresh token). */
export function refreshTokens(fetchFn, refresh) {
  return tokenPost(fetchFn, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refresh }, false);
}

const PAGE = (title, line) => `<!doctype html><meta charset="utf-8"><title>${title}</title>`
  + '<body style="font:16px system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px">'
  + `<h1 style="font-size:20px">${title}</h1><p>${line}</p></body>`;

/** Where the browser lands after a sign-in: a plain address, so the code isn't left in its history. */
export const DONE_PATH = '/auth/done';
/** How long the listener waits for the browser to follow that redirect before it closes anyway. */
const LINGER_MS = 3000;

/**
 * The redirect's listener: 127.0.0.1 on the first free port of PORTS, one GET to CALLBACK_PATH with
 * the state we sent. A good one is sent on (303) to DONE_PATH, which says it's done, so the address
 * bar and history show no code. → {redirectUri, result: Promise<{code} | {error}>, close()}.
 */
export async function listenForCode({ state, ports = PORTS, timeoutMs = SIGN_IN_MS, signal = null, createServer = http.createServer, lingerMs = LINGER_MS } = {}) {
  let settle;
  const result = new Promise(r => { settle = r; });
  let done = false;
  let signedIn = false; // the code came: DONE_PATH says so, once
  let landed = null; // closes the server once the browser has landed on DONE_PATH
  const finish = (v) => { if (!done) { done = true; settle(v); } };
  const server = createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
    const send = (status, title, line) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(PAGE(title, line)); };
    if (req.method === 'GET' && u.pathname === DONE_PATH && signedIn) {
      send(200, 'You’re signed in', 'You can close this tab and go back to the NeverQuestAlone app.');
      res.on('finish', () => landed?.());
      return;
    }
    if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH || signedIn) { res.writeHead(404).end(); return; }
    if (u.searchParams.get('state') !== state) { send(400, 'Sign-in didn’t match', 'Start again from the NeverQuestAlone app.'); return; }
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (err || !code) {
      send(400, 'Sign-in didn’t finish', 'Go back to the NeverQuestAlone app to try again.');
      finish({ error: err === 'access_denied' ? 'cancelled' : 'sign_in_failed' });
      return;
    }
    signedIn = true;
    res.writeHead(303, { location: DONE_PATH, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
    finish({ code });
  });
  let port = null;
  for (const p of ports) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(p, '127.0.0.1');
      });
      port = server.address().port;
      break;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' && e?.code !== 'EACCES') throw e;
    }
  }
  if (port === null) return { redirectUri: null, result: Promise.resolve({ error: 'port_busy' }), close() {} };
  const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
  timer.unref?.();
  const onAbort = () => finish({ error: 'cancelled' });
  signal?.addEventListener?.('abort', onAbort, { once: true });
  let closed = false;
  const shut = () => { server.close(); server.closeAllConnections?.(); };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    finish({ error: 'cancelled' });
    // Signed in: the browser is on its way to DONE_PATH; wait for it (briefly), then close.
    if (signedIn) {
      const linger = setTimeout(shut, lingerMs);
      linger.unref?.();
      landed = () => { clearTimeout(linger); shut(); };
    } else shut();
  };
  result.then(close, close);
  return { redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, result, close };
}

/**
 * One provider's sign-in (the ChatGPT plan's): the browser flow, the stored refresh token and the
 * in-memory access token. keystore is boot's secretKeystore (every value read or written is
 * registered with the log's redactor); fetch is the egress-guarded one, so the token endpoint must be
 * allowed (the manifest's hosts list auth.openai.com).
 */
export function createChatgptSignIn({ id = 'chatgpt', keystore, fetch: fetchFn = globalThis.fetch, log = () => {}, now = Date.now, random = crypto.randomBytes, listen = listenForCode } = {}) {
  let access = null; // {token, exp, account}
  let refreshing = null;
  let ended = false;
  let running = null;
  const secret = (s) => { if (typeof s === 'string' && s) { try { log.addSecret?.(s); } catch { /* the patterns still apply */ } } };

  async function saved() {
    let raw = null;
    try { raw = await keystore.get(id); } catch (e) { throw Object.assign(new Error('keystore_error'), { code: 'keystore_error', cause: e }); }
    return unpackEntry(raw);
  }

  /** Keep what a token response gave: the new refresh token first (saved), then the access token. */
  async function keep(json, fallbackAccount, fallbackRefresh) {
    const { account: acct, plan, exp } = accountOf(json);
    const account = acct ?? fallbackAccount;
    if (!account) return { ok: false, error: 'no_account' };
    const refresh = typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : fallbackRefresh;
    if (!refresh) return { ok: false, error: 'no_refresh' };
    secret(json.access_token); secret(refresh); secret(json.id_token);
    if (refresh !== fallbackRefresh || account !== fallbackAccount) await keystore.set(id, packEntry(account, refresh));
    const expiresIn = Number(json.expires_in);
    access = { token: json.access_token, exp: exp ?? (Number.isFinite(expiresIn) ? now() + expiresIn * 1000 : now() + 30 * 60_000), account };
    ended = false;
    return { ok: true, account, plan };
  }

  async function refresh() {
    refreshing ??= (async () => {
      try {
        const s = await saved();
        if (!s) { access = null; return null; }
        secret(s.refresh);
        const r = await refreshTokens(fetchFn, s.refresh);
        if (!r.ok) {
          if (REFRESH_ENDED.has(r.code) || r.status === 401) {
            ended = true;
            access = null;
            log('signin-refresh-ended', { provider: id, status: r.status, code: r.code });
            return null;
          }
          log('signin-refresh-failed', { provider: id, status: r.status, code: r.code });
          throw Object.assign(new Error('refresh_failed'), { code: 'refresh_failed', status: r.status });
        }
        const k = await keep(r.json, s.account, s.refresh);
        return k.ok ? access : null;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  return {
    id,

    /**
     * The browser flow. openUrl(url) opens the player's browser at the sign-in page (the shell's
     * opener, which checks isAuthorizeUrl). One at a time: a second start cancels the first.
     */
    async start({ openUrl, signal = null, timeoutMs = SIGN_IN_MS } = {}) {
      if (typeof openUrl !== 'function') return signInError('unsupported');
      running?.close();
      const state = b64url(random(32));
      const { verifier, challenge } = pkce(random);
      let l;
      try { l = await listen({ state, timeoutMs, signal }); } catch (e) {
        log('signin-listen-failed', { provider: id, code: e?.code ?? null });
        return signInError('port_busy');
      }
      if (!l.redirectUri) return signInError('port_busy');
      running = l;
      try {
        const url = authorizeUrl({ redirectUri: l.redirectUri, challenge, state });
        try { await openUrl(url); } catch { l.close(); return signInError('browser_failed'); }
        log('signin-started', { provider: id });
        const got = await l.result;
        if (got.error) return signInError(got.error);
        let r;
        try { r = await exchangeCode(fetchFn, { code: got.code, verifier, redirectUri: l.redirectUri }); } catch (e) {
          log('signin-exchange-failed', { provider: id, network: true });
          return signInError('network');
        }
        if (!r.ok) { log('signin-exchange-failed', { provider: id, status: r.status, code: r.code }); return signInError('sign_in_failed'); }
        let k;
        try { k = await keep(r.json, null, null); } catch (e) { return signInError(e?.code || 'keystore_error'); }
        if (!k.ok) return signInError(k.error);
        log('signin-done', { provider: id, plan: k.plan });
        return { ok: true, plan: k.plan };
      } finally {
        l.close();
        if (running === l) running = null;
      }
    },

    /** Stop a sign-in in progress (the window's Cancel). */
    cancel() { running?.close(); },

    /**
     * What the provider layer sends (createProvider's getKey): a fresh access token and the account
     * header, {expired:true} once OpenAI refused the refresh token, or null when not signed in.
     */
    async credentials() {
      if (ended) return { expired: true };
      if (!access || access.exp - now() < REFRESH_EARLY_MS) {
        const a = await refresh();
        if (!a) return ended ? { expired: true } : null;
      }
      return { key: access.token, kind: 'oauth', headers: { 'chatgpt-account-id': access.account } };
    },

    /** Is a sign-in saved (not whether it still works)? */
    async signedIn() {
      try { return !!(await saved()); } catch { return false; }
    },

    /** Forget the in-memory token (the key store entry goes with the app's deleteKey). */
    signOut() { access = null; ended = false; running?.close(); },
  };
}
