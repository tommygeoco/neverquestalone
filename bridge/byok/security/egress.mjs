// Egress: the Connections ledger and the allowlist (PRD §8.4 items 1-2, §11.2 "Network, one
// design", KY-6, KY-7, TH15; systems plan SY-13). Honest label: "what the app's own code connected
// to".
//
//   createEgress({ allowHosts: () => Set|Map, loopbackOk: true, featureFor, onEvent, now, fetch })
//     → { fetch: guardedFetch(input, init), ledger(), allowed(host), uninstall(), stopped(), reliable: true }
//
// One design, at the one door the bridge uses to reach the network: fetch. Boot hands the guarded
// fetch to everything that talks to a provider (the backend's turns, key tests, the balance and
// the model catalog, the ChatGPT plan sign-in's token exchange and renewal), and nothing in the bridge or the
// desktop app's main process opens a socket any other way: no module imports node:net, http,
// https, tls, http2 or dgram except the few that only listen on or talk to this computer (the
// ChatGPT plan sign-in's loopback listener (bridge/byok/signin/chatgpt.mjs) and the capture helper's local socket), which
// tests/byok/egress_test.mjs lists and checks. A child process, a worker
// or a native addon could bypass it; the bridge ships none that talk to the network. This replaces
// the process-wide socket hooks (diagnostics_channel, undici's beforeConnect, per-socket lookup),
// which depended on Node internals checked on three Node versions, and the HEAD request boot sent
// to prove them at every start.
//
// A request whose host the allowlist doesn't hold is refused before fetch is called: no name
// lookup, no connection, nothing sent. The refusal is a TypeError('fetch failed') whose cause has
// code EGRESS_BLOCKED (providers/errors.mjs), the shape fetch's own network errors have, so the
// provider layer files it as `egress_blocked` (never sent, never retried). After uninstall()
// (boot's stop) every request is refused with code EGRESS_STOPPED instead, and the event says
// stopped: nothing may go, and the words say the app needs a restart, never that the player's
// internet is down (fix-102). Only http: and https:
// go anywhere. A redirect is followed only to an allowed host, one hop at a time (callers that ask
// for redirect 'manual' or 'error', as the provider layer does, get fetch's own behavior).
//
// The allowlist is read on every request: allowHosts() returns a Set of hosts, or a Map of host →
// feature ('provider', 'sign_in', 'key_test', 'local_model', …). Entries are normalised like hosts
// (case, a trailing dot, brackets). A '*.example.com' entry allows subdomains only. A request's
// feature is the one the matching entry names: an exact entry first, else the longest matching '*.'
// entry, else featureFor(host). loopbackOk allows localhost, 127.0.0.0/8 and ::1 by name (local
// models). A hostname that merely resolves to loopback isn't loopback.
import { EGRESS_BLOCKED, EGRESS_STOPPED } from '../providers/errors.mjs';

// For the Connections page and the "Verify it yourself" help page.
export const CONNECTIONS_NOTE = 'Connections lists every host the app itself connected to. '
  + 'A host that isn\'t on the list is refused before anything is sent to it.';

/** Redirect statuses fetch would follow. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** fetch's own limit (the Fetch standard's 20). */
export const MAX_REDIRECTS = 20;

// 4 or 6 for an IP literal, else 0 (node:net's isIP, without importing node:net: see the header).
function ipVersion(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) return m.slice(1).every(x => Number(x) <= 255) ? 4 : 0;
  if (!h.includes(':') || /[^0-9a-f:.%]/i.test(h.split('%')[0])) return 0;
  try { new URL(`http://[${h}]/`); return 6; } catch { return 0; }
}

export function normHost(host) {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (ipVersion(h) === 6) {
    try { h = new URL(`http://[${h}]/`).hostname.slice(1, -1); } catch { /* zone ids and the like stay as written */ }
  }
  return h;
}

export function isLoopbackHost(host) {
  const h = normHost(host);
  if (h === 'localhost') return true;
  const v = ipVersion(h);
  if (v === 4) return h.startsWith('127.');
  if (v === 6) {
    if (h === '::1') return true;
    const m = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(h);
    return !!m && (parseInt(m[1], 16) >> 8) === 127;
  }
  return false;
}

/**
 * The refusal, shaped like fetch's own network failure: TypeError('fetch failed') with a coded cause
 * (EGRESS_STOPPED from a guard that had stopped).
 */
export function egressError(host, port, { stopped = false } = {}) {
  const to = `Connection to ${host}${port ? `:${port}` : ''} refused`;
  const cause = new Error(stopped ? `${to}: the app's connections stopped with its bridge` : `${to}: the host isn't in Connections' allowlist`);
  cause.code = stopped ? EGRESS_STOPPED : EGRESS_BLOCKED;
  cause.host = host;
  cause.port = port ?? null;
  return new TypeError('fetch failed', { cause });
}

const defaultPort = (protocol) => (protocol === 'https:' ? 443 : 80);

function urlOf(input) {
  if (input instanceof URL) return new URL(input.href);
  if (typeof input === 'string') return new URL(input);
  if (input && typeof input.url === 'string') return new URL(input.url); // a Request
  throw new TypeError('guardedFetch takes a URL, a string or a Request');
}

export function createEgress({ allowHosts = () => new Set(), onEvent = () => {}, loopbackOk = true, featureFor = null, now = Date.now, fetch = globalThis.fetch } = {}) {
  const entries = new Map();
  let active = true;
  const emit = (ev) => { try { onEvent(ev); } catch { /* a listener never breaks a request */ } };
  const list = () => {
    let v;
    try { v = allowHosts(); } catch { v = null; }
    return v instanceof Map || v instanceof Set ? v : new Set();
  };

  // The allowlist entry (as written, so a Map lookup works) that admits h: an exact entry, else
  // the longest '*.' entry it's a subdomain of; or null.
  const matchEntry = (h, l = list()) => {
    let best = null;
    let bestLen = 0;
    for (const entry of l.keys()) {
      const e = normHost(entry);
      if (!e) continue;
      if (e === h) return { entry };
      if (e.startsWith('*.') && h.length > e.length - 1 && h.endsWith(e.slice(1)) && e.length > bestLen) {
        best = { entry };
        bestLen = e.length;
      }
    }
    return best;
  };

  const allowed = (host) => {
    const h = normHost(host);
    if (!h) return false;
    if (loopbackOk && isLoopbackHost(h)) return true;
    return matchEntry(h) !== null;
  };

  const featureOf = (host) => {
    const l = list();
    if (l instanceof Map) {
      const m = matchEntry(host, l);
      const f = m ? l.get(m.entry) : null;
      if (typeof f === 'string' && f) return f;
    }
    try { const f = featureFor?.(host); if (typeof f === 'string' && f) return f; } catch { /* unknown */ }
    return 'unknown';
  };

  const record = (host, port, ok, stopped = false) => {
    const t = now();
    const feature = featureOf(host);
    const key = `${host}|${port ?? ''}|${feature}|${ok ? 1 : 0}`;
    const e = entries.get(key) || { host, port, feature, allowed: ok, count: 0, first: t, last: t };
    e.count += 1;
    e.last = t;
    entries.set(key, e);
    emit({ type: ok ? 'connect' : 'blocked', host, port, feature, at: t, ...(stopped ? { stopped: true } : {}) });
  };

  /** Check one URL against the allowlist and record it; throws the refusal. */
  const admit = (u) => {
    const host = normHost(u.hostname);
    const port = Number(u.port) || defaultPort(u.protocol);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !host || !active || !allowed(host)) {
      const stopped = !active;
      record(host || u.protocol, port, false, stopped);
      throw egressError(host || u.protocol, port, { stopped });
    }
    record(host, port, true);
  };

  async function guardedFetch(input, init = {}) {
    let u = urlOf(input);
    admit(u);
    const mode = init?.redirect ?? (input && typeof input === 'object' && typeof input.redirect === 'string' && !(input instanceof URL) ? input.redirect : 'follow');
    if (mode !== 'follow') return fetch(input, init);
    // Follow redirects here, one hop at a time, so each host is checked before anything goes to it.
    let req = input;
    let opts = { ...init, redirect: 'manual' };
    for (let hop = 0; ; hop++) {
      const res = await fetch(req, opts);
      const to = REDIRECTS.has(res.status) ? res.headers.get('location') : null;
      if (!to) return res;
      if (hop >= MAX_REDIRECTS) { try { await res.body?.cancel(); } catch { /* gone */ } throw new TypeError('fetch failed', { cause: Object.assign(new Error('too many redirects'), { code: 'ERR_TOO_MANY_REDIRECTS' }) }); }
      try { await res.body?.cancel(); } catch { /* gone */ }
      u = new URL(to, u);
      admit(u);
      const method = String(opts.method ?? 'GET').toUpperCase();
      // 303, and 301/302 after a POST, turn into a GET without a body, as fetch does.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        const { body: _body, ...rest } = opts;
        opts = { ...rest, method: 'GET' };
      }
      req = u.href;
    }
  }

  return {
    fetch: guardedFetch,
    reliable: true,
    allowed,
    ledger: () => [...entries.values()].sort((a, b) => a.first - b.first).map(e => ({ ...e })),
    /** Stop letting anything through (boot's stop); every request is refused with EGRESS_STOPPED from here on. */
    uninstall() { active = false; },
    /** True once uninstall() ran. */
    stopped: () => !active,
  };
}
