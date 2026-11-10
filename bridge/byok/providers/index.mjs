// The provider layer (PRD §7, §9.1, §10; BUILD-PLAN "providers"): one data
// file per provider (manifests/<id>.json) and two wire adapters over the
// built-in fetch. No SDKs, no runtime dependencies. The manifests are the one
// place provider ids, names, key shapes, hosts and links live (providerIds,
// providerLinks); a change to one ships with an app update.
//
// Setup offers five: Claude, ChatGPT, Grok, Gemini, and Other (custom.json, a template: any
// OpenAI-compatible Chat Completions service at the player's own base URL, its key optional for a
// server on this computer). The template becomes a manifest only with the player's settings
// (customManifest; byok.custom {baseUrl, model}), and its one host is the only one it adds to the
// egress allowlist.
//
//   loadManifests()                   the bundled manifests, frozen
//   createProvider(manifest, {getKey, fetch, log, ...})
//       → { id, manifest, validate, testCall, stream, reach }
//                                     (reach: is the provider's host answering
//                                     at all, with no key sent)
//   pickProviderForKey(key)           paste routing by key shape only
//   resolveModel(manifest, available, wanted)
//   checkCustomUrl(url)               the Other form's base URL, checked and normalised
//   customManifest(template, {baseUrl, model}) · withCustom(manifests, custom) · manifestFor(id, manifests, custom)
//
// stream(req, {signal, onRequest}) yields TurnEvents and never throws:
//   {type:'start', requestId, rateLimit} · {type:'text', delta}
//   {type:'usage', usage:{input, output, cacheRead, cacheWrite, reasoning, costUsd?, exact, partial?}}
//   (partial: the stream failed after generation began; what was counted so far, right before the error)
//   {type:'done', finish:'stop'|'length'|'refusal'|'content_filter'} · {type:'error', error}
//   {type:'reasoning'}: once, when the model's reasoning first shows (a reasoning block or item, or
//   reasoning deltas), so an empty reply that ran out of room is known to have spent it thinking
// Usage is normalized: `input` is the uncached input, so the prompt was
// input + cacheRead + cacheWrite; `output` includes reasoning; `reasoning` is
// that part of it; `exact` means costUsd came from the provider (OpenRouter)
// or is known to be 0 (local).
//
// Timers (§7.5): no first token within 60 s, no new token within 30 s, or a
// run over 180 s ends the stream with a `timeout` error. A reasoning block or
// item starting counts as the provider's first sign of life, and while the
// model reasons (hidden reasoning emits nothing: Sonnet 5 by default, OpenAI
// without summaries) the idle timer waits and only the run timer applies. The
// caller's AbortSignal ends it with `interrupted` (aborted: true). Redirects
// are never followed (`unknown`, code redirect_refused), so a key header can
// never follow one to another host. A request that can't be built is
// `unknown`, code bad_request_shape, and nothing is sent. No key is `no_key`:
// code missing_key, or keystore_error when getKey throws (errors.mjs).
//
// The xAI Chat Completions fallback (useAltAdapter) sends the manifest's
// effortAlt map and defaultRequestOptionsAlt in place of effort and
// defaultRequestOptions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, makeError, fetchErrorPhase, parseRateLimit, errorLogFields, KINDS } from './errors.mjs';
import { deepFreeze, joinUrl, parseJSON, hasEffortControl, effortLevels, effortFragment, nearestEffort, EFFORT_LEVELS, THINK_ROOM } from './util.mjs';
import anthropic from './adapters/anthropic.mjs';
import { responses, chat } from './adapters/openai.mjs';

export const ADAPTERS = Object.freeze({
  'anthropic-messages': anthropic,
  'openai-responses': responses,
  'openai-chat': chat,
});

export const DEFAULT_TIMEOUTS = Object.freeze({ firstTokenMs: 60000, idleMs: 30000, runMs: 180000, requestMs: 30000 });

const MANIFEST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifests');
const PRIVACY_CLASSES = ['cloud', 'cloud-no-train', 'local'];
const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1']);
/** The sign-in flows a manifest's auth.signIn may name (bridge/byok/signin/<flow>.mjs). */
export const SIGN_INS = Object.freeze(['chatgpt']);
/** Does this manifest sign in (a plan) rather than take a pasted key? */
export const isSignIn = m => typeof m?.auth?.signIn === 'string';
/** The Other card's id: the one manifest whose base URL and model are the player's (custom.json). */
export const CUSTOM_ID = 'custom';
/** Hosts a custom base URL may reach over plain http: this computer only (Ollama, LM Studio). */
const CUSTOM_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The longest base URL the Other form takes. */
export const CUSTOM_URL_MAX = 512;
/** How long a turn waits for an Other server's thinking controls (provider.thinking), and the most it reads. */
export const THINKING_READ_MS = 3000;
const SHOW_READ_MAX = 2 * 1024 * 1024;
/** A model id as the Other form takes it (an OpenAI-compatible service's own id: "openai/gpt-5-mini", "qwen3:8b"). */
export const CUSTOM_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

// The only request fields an effort level may set, per adapter (§7.4), as
// dotted paths to scalar values: an effort map can't reach store,
// data_collection or num_ctx (PV-4).
export const EFFORT_FIELDS = Object.freeze({
  'anthropic-messages': Object.freeze(['output_config.effort', 'thinking.type', 'thinking.budget_tokens']),
  'openai-responses': Object.freeze(['reasoning.effort']),
  'openai-chat': Object.freeze(['reasoning.effort', 'reasoning_effort']),
});

// ---- manifests -------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function compiles(src) {
  try { new RegExp(src); return true; } catch { return false; }
}

function collectKinds(errorMap) {
  const out = [];
  if (!isObj(errorMap)) return out;
  for (const key of ['codes', 'codeContains', 'types', 'status']) {
    if (isObj(errorMap[key])) out.push(...Object.values(errorMap[key]));
  }
  if (Array.isArray(errorMap.messages)) out.push(...errorMap.messages.map(m => m?.kind));
  return out;
}

function hasSamplingParam(o) {
  if (!isObj(o)) return false;
  return Object.entries(o).some(([k, v]) => ['temperature', 'top_p', 'top_k'].includes(k) || hasSamplingParam(v));
}

// Every leaf of a request fragment as [dotted path, value].
function leaves(o, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) out.push(...leaves(v, p));
    else out.push([p, v]);
  }
  return out;
}

// Problems with one effort map for one adapter. Its levels are the thinking levels (EFFORT_LEVELS,
// util.mjs). A thinking budget (Anthropic's thinking.budget_tokens, on a model with no effort
// control) turns thinking on with at least 1,024 tokens, and never more than its level's room, so
// the request's max_tokens (the reply's ceiling plus that room) stays above it as the API needs.
function effortProblems(map, adapter, label) {
  if (!isObj(map)) return [`${label} must be an object`];
  const p = [];
  const allowed = EFFORT_FIELDS[adapter] || [];
  for (const [key, entry] of Object.entries(map)) {
    if (!isObj(entry)) { p.push(`${label} ${key} must be an object`); continue; }
    for (const [level, frag] of Object.entries(entry)) {
      if (!EFFORT_LEVELS.includes(level)) { p.push(`${label} ${key}: unknown level ${level}`); continue; }
      if (!isObj(frag)) { p.push(`${label} ${key}.${level} must be an object`); continue; }
      for (const [field, v] of leaves(frag)) {
        if (!allowed.includes(field)) p.push(`${label} ${key}.${level} may not set ${field}`);
        else if (!['string', 'number', 'boolean'].includes(typeof v)) p.push(`${label} ${key}.${level}.${field} must be a string, number or boolean`);
      }
      const budget = frag.thinking?.budget_tokens;
      if (budget !== undefined) {
        if (!Number.isInteger(budget) || budget < 1024 || budget > THINK_ROOM[level]) p.push(`${label} ${key}.${level}: thinking.budget_tokens must be a whole number from 1,024 to ${THINK_ROOM[level]}`);
        if (frag.thinking?.type !== 'enabled') p.push(`${label} ${key}.${level}: a thinking budget needs thinking.type enabled`);
      }
    }
  }
  return p;
}

// Links the desktop app opens: https only, no credentials. `verified` is a flag.
function linkProblems(links) {
  if (!isObj(links)) return ['links must be an object'];
  const p = [];
  for (const [k, v] of Object.entries(links)) {
    if (k === 'verified') { if (typeof v !== 'boolean') p.push('links.verified must be a boolean'); continue; }
    let u = null;
    try { u = new URL(v); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:' || u.username || u.password) p.push(`links.${k} must be an https URL`);
  }
  return p;
}

/**
 * Words a player reads in the desktop app (privacy.player, terms.playerNotes; desktop UI critic
 * D-22): plain sentences, never the developer notes beside them. A request field (store:false,
 * data_collection, top_p), a header, an API path, JSON or a code token fails.
 */
export const PLAYER_TEXT_BAD = /[_:{}[\]=`<>"\\|]|header|\btop_[pk]\b|\/v\d|\b(?:true|false|null)\b|[a-z]\.[a-z]|\d\/\d|\bDB\d|\bS\d{1,3}\b/i;
export const PLAYER_PRIVACY_FIELDS = Object.freeze(['keeps', 'trains', 'zeroRetention', 'sets']);
/**
 * The one token player text may carry: {os:Mac}, the player's computer by its system's name ("this
 * Mac", "this PC"), which the window fills as it fills the strings table's (renderer format.js render;
 * bones-ux-writer onboarding r4, UX-W41). Anything else in braces is still refused.
 */
export const PLAYER_TEXT_TOKENS = /\{os:Mac\}/g;
const playerText = (s, { empty = false } = {}) => typeof s === 'string' && s.length <= 300 && (empty || s.length > 0) && !PLAYER_TEXT_BAD.test(s.replace(PLAYER_TEXT_TOKENS, 'Mac'));

// The manifest schema. Returns a list of problems (empty when valid).
export function validateManifest(m) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  if (!isObj(m)) return ['manifest is not an object'];
  need(m.schema === 1, 'schema must be 1');
  need(typeof m.id === 'string' && /^[a-z][a-z0-9-]*$/.test(m.id), 'id must be a lowercase slug');
  need(typeof m.name === 'string' && m.name.length > 0, 'name is required');
  need(typeof m.hidden === 'boolean', 'hidden must be a boolean');
  need(typeof m.local === 'boolean', 'local must be a boolean');
  need(Object.hasOwn(ADAPTERS, m.adapter), `unknown adapter ${m.adapter}`);
  if (m.altAdapter != null) {
    need(Object.hasOwn(ADAPTERS, m.altAdapter), `unknown altAdapter ${m.altAdapter}`);
    need(typeof m.paths?.chatAlt === 'string', 'an altAdapter needs paths.chatAlt');
  }
  if (m.effortAlt != null) {
    need(m.altAdapter != null, 'effortAlt needs an altAdapter');
    p.push(...effortProblems(m.effortAlt, m.altAdapter, 'effortAlt'));
  }
  if (m.defaultRequestOptionsAlt != null) {
    need(m.altAdapter != null, 'defaultRequestOptionsAlt needs an altAdapter');
    need(isObj(m.defaultRequestOptionsAlt) && !hasSamplingParam(m.defaultRequestOptionsAlt), 'defaultRequestOptionsAlt must be an object without sampling parameters');
  }
  if (m.custom === true) {
    // Other (custom.json): the template has no base URL; customManifest fills it from the player's
    // settings, and it must then pass checkCustomUrl and name that one host. The key is optional (a
    // server on this computer takes none), and no key shape routes a paste to it.
    need(m.id === CUSTOM_ID, `a custom manifest's id is ${CUSTOM_ID}`);
    need(m.adapter === 'openai-chat' && m.altAdapter == null, 'a custom manifest speaks OpenAI Chat Completions only');
    if (m.baseUrl === null) need(Array.isArray(m.hosts) && m.hosts.length === 0 && m.local === false, 'the custom template has no hosts and isn’t local');
    else {
      const c = checkCustomUrl(m.baseUrl);
      need(c.ok && c.baseUrl === m.baseUrl, 'a custom baseUrl passes checkCustomUrl as written');
      need(c.ok && Array.isArray(m.hosts) && m.hosts.length === 1 && m.hosts[0] === c.host, 'a custom manifest names its one host');
      const cloud = CLOUD_MODEL_RE.test(String(m.models?.default ?? ''));
      need(c.ok && m.local === (c.local && !cloud), 'a custom manifest is local exactly when its host is this computer and its model is no cloud one');
    }
    need(isObj(m.auth) && m.auth.header === 'authorization' && m.auth.scheme === 'Bearer' && m.auth.optional === true, 'a custom manifest sends an optional Bearer key');
    need(m.keyPattern === null && m.keyRejectPattern == null, 'no key shape routes to a custom manifest');
  } else {
    let host = null;
    try {
      const u = new URL(m.baseUrl);
      host = u.hostname;
      if (m.local) need(u.protocol === 'http:' && LOOPBACK.has(u.hostname), 'a local provider must use http on a loopback literal');
      else need(u.protocol === 'https:', 'a cloud provider must use https');
      need(!u.username && !u.password && !u.search && !u.hash, 'baseUrl carries no credentials, query or fragment');
    } catch { p.push('baseUrl must be a URL'); }
    need(Array.isArray(m.hosts) && m.hosts.length > 0 && m.hosts.includes(host), 'hosts must list the baseUrl host');
    if (m.local) need(m.auth === null, 'a local provider has no auth');
    else need(isObj(m.auth) && typeof m.auth.header === 'string' && (m.auth.scheme === null || m.auth.scheme === 'Bearer') && m.auth.optional == null, 'auth needs a header and a null or Bearer scheme');
    if (m.auth?.signIn != null) {
      // A sign-in provider (a plan in place of a key: signIn names the flow, signin/<flow>.mjs): no
      // pasted key ever routes to it, and its token goes only to its own hosts over https.
      need(SIGN_INS.includes(m.auth.signIn), `unknown sign-in ${m.auth.signIn}`);
      need(!m.local && m.keyPattern === null && m.keyRejectPattern == null, 'a sign-in provider is a cloud one with no key shape');
    } else if (m.local) need(m.keyPattern === null, 'a local provider has no key pattern');
    else need(typeof m.keyPattern === 'string' && compiles(m.keyPattern), 'keyPattern must be a regex source');
  }
  if (m.keyRejectPattern != null) need(typeof m.keyRejectPattern === 'string' && compiles(m.keyRejectPattern), 'keyRejectPattern must be a regex source');
  need(Number.isInteger(m.keyMatchOrder), 'keyMatchOrder must be an integer');
  need(isObj(m.headers), 'headers must be an object');
  need(isObj(m.paths) && typeof m.paths.chat === 'string' && typeof m.paths.models === 'string', 'paths needs chat and models');
  if (m.keyCheck != null) need(isObj(m.keyCheck) && typeof m.keyCheck.path === 'string', 'keyCheck needs a path');
  const models = m.models;
  if (!isObj(models) || !Array.isArray(models.list)) p.push('models needs a list');
  else {
    need(typeof models.allowAny === 'boolean', 'models.allowAny must be a boolean');
    const ids = new Set();
    for (const e of models.list) {
      need(isObj(e) && typeof e.id === 'string' && typeof e.label === 'string' && Number.isInteger(e.costRank) && typeof e.effort === 'boolean', `model entry ${e?.id} needs id, label, costRank, effort`);
      if (isObj(e) && typeof e.id === 'string') {
        need(!ids.has(e.id), `duplicate model ${e.id}`);
        ids.add(e.id);
        need(e.effort === hasEffortControl(m, e.id), `model ${e.id}: the effort flag disagrees with the effort map`);
        // A model that always thinks and has no levels (Grok 4.20) names the output room it thinks in.
        if (e.thinkRoom !== undefined) need(e.effort === false && Number.isInteger(e.thinkRoom) && e.thinkRoom > 0 && e.thinkRoom <= THINK_ROOM.max, `model ${e.id}: thinkRoom is for a model with no levels, from 1 to ${THINK_ROOM.max}`);
        // Its documented output ceiling, thinking included (SY-102-6): at least the reply's, and every
        // thinking budget it takes leaves the reply's room under it (the API needs budget < max_tokens).
        if (e.outputTokens !== undefined) {
          const reply = Number.isInteger(m.limits?.maxOutputTokens) ? m.limits.maxOutputTokens : 0;
          need(Number.isInteger(e.outputTokens) && e.outputTokens >= reply, `model ${e.id}: outputTokens must be a whole number of at least the reply's ${reply}`);
          for (const l of effortLevels(m, e.id)) {
            const budget = effortFragment(m, e.id, l).thinking?.budget_tokens;
            if (Number.isInteger(budget) && Number.isInteger(e.outputTokens)) need(budget + reply <= e.outputTokens, `model ${e.id}: ${l}'s thinking budget and the reply's ${reply} must fit its outputTokens (${e.outputTokens})`);
          }
        }
        if (e.effort === true && m.effortAlt != null) need(effortLevels({ effort: m.effortAlt }, e.id).join() === effortLevels(m, e.id).join(), `model ${e.id}: effortAlt offers other levels than effort`);
        // A retirement its company announced (SY-102-5): the earliest day, and the model offered in its place.
        if (e.retiresAfter !== undefined || e.moveTo !== undefined) {
          need(isDay(e.retiresAfter), `model ${e.id}: retiresAfter is a day (YYYY-MM-DD)`);
          need(typeof e.moveTo === 'string' && e.moveTo !== e.id, `model ${e.id}: a retiring model names another model to move to (moveTo)`);
        }
      }
    }
    // The model a retiring one moves to is listed, and isn't retiring itself.
    for (const e of models.list) {
      if (!isObj(e) || typeof e.moveTo !== 'string') continue;
      const to = models.list.find(x => x?.id === e.moveTo);
      need(!!to && to.retiresAfter === undefined, `model ${e.id}: moveTo ${e.moveTo} must be a listed model that isn't retiring`);
    }
    if (models.default === null) need(models.allowAny, 'a null default model needs allowAny');
    else need(ids.has(models.default), 'the default model must be in the list');
    if (models.smarter != null) need(ids.has(models.smarter), 'the smarter model must be in the list');
  }
  p.push(...effortProblems(m.effort, m.adapter, 'effort'));
  if (m.rateLimitHeaders !== null) {
    need(isObj(m.rateLimitHeaders) && ['rfc3339', 'duration', 'epoch_ms', 'seconds'].includes(m.rateLimitHeaders.resetFormat) && isObj(m.rateLimitHeaders.buckets), 'rateLimitHeaders needs a resetFormat and buckets');
  }
  need(isObj(m.errorMap), 'errorMap must be an object');
  for (const k of collectKinds(m.errorMap)) need(KINDS.includes(k), `errorMap names unknown kind ${k}`);
  const pv = m.privacy;
  need(isObj(pv) && PRIVACY_CLASSES.includes(pv.class) && ['retention', 'trains', 'zdr', 'sets', 'notes'].every(k => typeof pv[k] === 'string'), 'privacy needs class, retention, trains, zdr, sets, notes');
  need(isObj(m.terms) && typeof m.terms.login === 'string' && Array.isArray(m.terms.notes), 'terms needs login and notes');
  need(isObj(pv) && isObj(pv.player) && PLAYER_PRIVACY_FIELDS.every(k => playerText(pv.player[k], { empty: k === 'zeroRetention' })), 'privacy.player needs keeps, trains, zeroRetention and sets in plain words (no request fields, headers, paths or code)');
  need(!isObj(pv?.player) || pv.player.short === undefined || (playerText(pv.player.short) && pv.player.short.split(/\s+/).length <= 12), 'privacy.player.short must be one plain line of 12 words or fewer');
  need(isObj(m.terms) && Array.isArray(m.terms.playerNotes) && m.terms.playerNotes.length <= 4 && m.terms.playerNotes.every(n => playerText(n)), 'terms.playerNotes must be up to 4 plain sentences (no request fields, headers, paths or code)');
  need(isObj(m.defaultRequestOptions) && !hasSamplingParam(m.defaultRequestOptions), 'defaultRequestOptions must be an object without sampling parameters');
  need(typeof m.safetyIdentifier === 'boolean', 'safetyIdentifier must be a boolean');
  need(isObj(m.limits) && Number.isInteger(m.limits.maxOutputTokens) && Number.isInteger(m.limits.testMaxTokens), 'limits needs maxOutputTokens and testMaxTokens');
  need(['bundled', 'response', 'free'].includes(m.priceSource), 'priceSource must be bundled, response or free');
  p.push(...linkProblems(m.links));
  need(Array.isArray(m.sources), 'sources must be a list');
  return p;
}

function readBundled(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// loadManifests({dir}) → frozen manifests sorted by `order`. A bundled
// manifest that fails the schema throws.
export function loadManifests({ dir = MANIFEST_DIR } = {}) {
  const out = [];
  for (const base of readBundled(dir)) {
    const problems = validateManifest(base);
    if (problems.length) throw new Error(`manifest ${base.id}: ${problems.join('; ')}`);
    out.push(deepFreeze(structuredClone(base)));
  }
  out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return Object.freeze(out);
}

let bundledCache = null;
function bundled() {
  bundledCache ??= loadManifests();
  return bundledCache;
}

export function getManifest(id, manifests = bundled()) {
  return manifests.find(m => m.id === id) ?? null;
}

/** Every provider's id, from the manifests: the one list of them (systems plan SY-14). */
export function providerIds(manifests = bundled()) {
  return manifests.map(m => m.id);
}

/**
 * The pages the desktop app may open for each provider, by link id: {'anthropic.keys': url, …},
 * from each manifest's `links` (https only, checked by the schema). A url with a {hash} in it is a
 * template the shell fills from checked input (no shipped manifest has one now).
 */
export function providerLinks(manifests = bundled()) {
  const out = {};
  for (const m of manifests) {
    for (const [kind, url] of Object.entries(m.links ?? {})) if (kind !== 'verified' && typeof url === 'string') out[`${m.id}.${kind}`] = url;
  }
  return Object.freeze(out);
}

// ---- Other (custom): the player's own OpenAI-compatible service --------------------

/**
 * The Other form's base URL, checked: https, or http for this computer (localhost, 127.0.0.1, [::1]: Ollama,
 * LM Studio) and for the player's own network (isPrivateNetworkHost: a model on another computer at home, a
 * player's ask, 2026-10-05); no user name, password, query or fragment; at most CUSTOM_URL_MAX
 * characters. A URL that ends in /chat/completions (the whole endpoint, as some services' docs
 * show it) is taken as its base. Trailing slashes go.
 * → {ok: true, baseUrl, host, local[, lan: true]} | {ok: false, error}, error one of: empty, too_long, bad_url,
 *   https_required, credentials, query, not_http.
 */
export function checkCustomUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, error: 'empty' };
  if (s.length > CUSTOM_URL_MAX) return { ok: false, error: 'too_long' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'bad_url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'not_http' };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, error: 'bad_url' };
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(s)) return { ok: false, error: 'credentials' };
  // A bare "?" or "#" parses to an empty search or hash: the text itself decides.
  if (u.search || u.hash || s.includes('?') || s.includes('#')) return { ok: false, error: 'query' };
  const local = CUSTOM_HTTP_HOSTS.has(host);
  const lan = !local && isPrivateNetworkHost(host);
  if (u.protocol === 'http:' && !local && !lan) return { ok: false, error: 'https_required' };
  const pathname = u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return { ok: true, baseUrl: `${u.protocol}//${u.host.toLowerCase()}${pathname}`, host, local, ...(lan ? { lan: true } : {}) };
}

/**
 * A host on the player's own network, where http is allowed too: only a literal private address (10/8,
 * 172.16/12, 192.168/16, 169.254/16; IPv6 fc00::/7 and fe80::/10) or an mDNS name ending in .local, never a
 * public name that merely resolves to one (127.0.0.1.nip.io, localhost.evil.example stay https only).
 */
export function isPrivateNetworkHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some(x => x > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.local$/.test(h);
}

/**
 * A model a server on this computer serves from somewhere else (code health BR-06): Ollama's cloud
 * models (gpt-oss:120b-cloud, kimi-k2:cloud) go to ollama.com, so the messages leave this computer
 * and the service prices them.
 */
export const CLOUD_MODEL_RE = /(^|[-:])cloud$/i;

/**
 * What a known service needs on the Other card that the OpenAI shape doesn't say, by its host (a player,
 * 2026-10-05: DeepSeek through Other, every reply "couldn't finish"). DeepSeek's models think by default,
 * at high effort, and count the thinking inside max_tokens, so Other's 1,200-token reply (120 for a
 * hello) was all thinking and came back empty, twice. Other has no Thinking menu: its turns ask DeepSeek
 * for none. DeepSeek's own host only: services that serve its models elsewhere name the switch otherwise.
 */
export const CUSTOM_HOST_OPTIONS = Object.freeze({
  'api.deepseek.com': Object.freeze({ thinking: Object.freeze({ type: 'disabled' }) }),
});

/**
 * What an Other server on this computer or the home network asks of a model that thinks by default, from the
 * thinking controls it reports for that model: Ollama's POST /api/show answers `thinking: {values, default}`
 * (Ollama 0.34.3 and later; docs/capabilities/thinking.mdx: "values can contain booleans (true or false) for
 * on/off controls. It can also contain model-defined strings for named levels", "values: [false] means the
 * model does not support thinking"). Its OpenAI-compatible chat takes them as reasoning_effort
 * (docs/api/openai-compatibility.mdx: "supported names are applied exactly", "\"none\" requests false"):
 * - false among the values (qwen3:8b, whose template has /think and /no_think): "none", no thinking, so Other's
 *   1,200-token reply is the answer;
 * - named levels only (gpt-oss: low, medium, high; its reasoning can't be turned off): the lowest;
 * - true alone (a template that always opens a thinking block: qwen3:30b, the *-thinking-2507 models), false
 *   alone (no thinking), or nothing reported (deepseek-r1, whose template Ollama has no thinking metadata for;
 *   any model on an older Ollama; LM Studio, llama.cpp): nothing. An empty reply that thought its room away
 *   gets more room instead (backend roomForRetry).
 * → the request options, or null.
 */
export function thinkingOptions(show) {
  const values = isObj(show) && isObj(show.thinking) && Array.isArray(show.thinking.values) ? show.thinking.values : null;
  if (!values) return null;
  if (values.includes(false)) return values.includes(true) || values.some(v => typeof v === 'string') ? { reasoning_effort: 'none' } : null;
  const named = values.filter(v => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(v));
  if (!named.length) return null;
  const lowest = EFFORT_LEVELS.find(l => l !== 'off' && named.includes(l)) ?? named[0];
  return { reasoning_effort: lowest };
}

/**
 * The Other card as a working manifest: the template (custom.json) with the player's base URL, its
 * one host (also its name), and the model (listed, so the app names it). null when the settings don't pass
 * checkCustomUrl or name no model. A server on this computer is local: $0, and its messages stay
 * here (the template's privacy.local replaces privacy); not for a cloud model it serves (CLOUD_MODEL_RE):
 * that's cloud privacy and the service's price, as any service's. One at home is free too, with cloud privacy
 * (its messages go to that computer). A known service's own request options (CUSTOM_HOST_OPTIONS) go with
 * every request.
 */
export function customManifest(template, custom) {
  if (!template || template.custom !== true || !isObj(custom)) return null;
  const c = checkCustomUrl(custom.baseUrl);
  const model = typeof custom.model === 'string' ? custom.model.trim() : '';
  if (!c.ok || !CUSTOM_MODEL_RE.test(model)) return null;
  const base = structuredClone(template);
  const { local: localPrivacy, ...privacy } = base.privacy;
  // Named by its host ("openrouter.ai", "localhost:11434"): all the app knows of the service.
  const name = new URL(c.baseUrl).host;
  const cloud = CLOUD_MODEL_RE.test(model);
  const local = c.local && !cloud;
  const out = {
    ...base,
    name,
    display: { ...base.display, maker: name },
    baseUrl: c.baseUrl,
    hosts: [c.host],
    local,
    models: { ...base.models, default: model, list: [{ id: model, label: model, costRank: 0, effort: false }] },
    privacy: local && isObj(localPrivacy) ? { ...privacy, ...localPrivacy } : privacy,
    // A server at home costs nothing either (README: "Free"), though its messages leave this computer.
    priceSource: local || (c.lan === true && !cloud) ? 'free' : base.priceSource,
    defaultRequestOptions: structuredClone(Object.hasOwn(CUSTOM_HOST_OPTIONS, c.host) ? CUSTOM_HOST_OPTIONS[c.host] : base.defaultRequestOptions),
  };
  return validateManifest(out).length ? null : deepFreeze(out);
}

/** The manifests with the Other template replaced by the player's own (customManifest), or left out when it isn't set. */
export function withCustom(manifests, custom) {
  const out = [];
  for (const m of manifests ?? []) {
    if (m?.custom !== true) { out.push(m); continue; }
    const made = customManifest(m, custom);
    if (made) out.push(made);
  }
  return out;
}

/** One provider's manifest, the Other card's built from the player's settings (null when they aren't set). */
export function manifestFor(id, manifests, custom) {
  const m = (manifests ?? []).find(x => x?.id === id) ?? null;
  if (m?.custom !== true) return m;
  return m.baseUrl ? m : customManifest(m, custom);
}

// ---- key routing (paste only; validation is a live call) ------------------------

// pickProviderForKey(key) → {id, hidden} | {id:null, reason}. Shapes are tried
// in keyMatchOrder, so sk-ant- wins before OpenAI's generic sk-.
export function pickProviderForKey(key, manifests = bundled()) {
  const k = String(key ?? '').trim();
  if (!k) return { id: null, reason: 'empty' };
  const ordered = [...manifests].filter(m => m.keyPattern).sort((a, b) => a.keyMatchOrder - b.keyMatchOrder);
  for (const m of ordered) {
    if (m.keyRejectPattern && new RegExp(m.keyRejectPattern).test(k)) return { id: null, reason: 'admin_key', provider: m.id };
  }
  for (const m of ordered) {
    if (new RegExp(m.keyPattern).test(k)) return { id: m.id, hidden: !!m.hidden };
  }
  return { id: null, reason: 'unknown_shape' };
}

// ---- models (PV-3) -----------------------------------------------------------------

// Whether `id` is among the provider's listed models. A dated snapshot
// ("claude-haiku-4-5-20251001") counts for its alias; "qwen3" for "qwen3:latest".
export function modelAvailable(id, available) {
  if (!id || !Array.isArray(available)) return false;
  return available.some(a => a === id
    || (a.startsWith(id + '-') && /^-\d{8}$/.test(a.slice(id.length)))
    || a === `${id}:latest` || id === `${a}:latest`);
}

/** A calendar day as YYYY-MM-DD that exists ("2026-02-30" doesn't). */
function isDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * The retirement a model's company announced (systems critic SY-102-5), from its manifest entry:
 * retiresAfter, the earliest day it may go (the company's "not sooner than"), and moveTo, the model
 * the window offers in its place. → {model, after, to}, or null for a model with none.
 */
export function retiringOf(manifest, id) {
  const e = manifest?.models?.list?.find(x => x.id === id);
  return e && isDay(e.retiresAfter) && typeof e.moveTo === 'string' ? { model: e.id, after: e.retiresAfter, to: e.moveTo } : null;
}

// resolveModel → {model, switched, from?} or {model:null, reason}. Falls back
// only within the provider, and only to an equal or cheaper model (§10, PV-3):
// the entry's named replacement (`replacedBy`) when it's listed, available and no dearer, else the nearest listed
// model at or below the wanted one's cost rank.
export function resolveModel(manifest, available, wanted) {
  const want = wanted ?? manifest.models.default;
  if (want && modelAvailable(want, available)) return { model: want, switched: false };
  if (!want) {
    const first = (available || [])[0];
    return first ? { model: first, switched: false } : { model: null, reason: 'no_models' };
  }
  const entry = manifest.models.list.find(e => e.id === want);
  if (!entry) return { model: null, reason: 'retired' };
  const named = typeof entry.replacedBy === 'string' ? manifest.models.list.find(e => e.id === entry.replacedBy) : null;
  if (named && named.id !== want && named.costRank <= entry.costRank && modelAvailable(named.id, available)) {
    return { model: named.id, switched: true, from: want, by: 'replacement' };
  }
  const pool = manifest.models.list
    .filter(e => e.id !== want && e.costRank <= entry.costRank && modelAvailable(e.id, available))
    .sort((a, b) => b.costRank - a.costRank);
  return pool.length ? { model: pool[0].id, switched: true, from: want, by: 'cost' } : { model: null, reason: 'retired' };
}

// ---- providers ------------------------------------------------------------------------

// Header names that carry a credential whatever the manifest says (a workspace header added by the
// app, a proxy's token): their values are replaced whole.
const SECRET_HEADER_RE = /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie)$|token|secret|key$|account-id$/i;

/**
 * The request's headers as the "Last request" view shows them (§8.4 item 3, KY-8): the provider's
 * auth header as `sk-ant-…A1b2 (redacted)` (at most 7 characters of the start and 4 of the end, none
 * of a short key), and any other credential-shaped header as "[redacted]".
 */
export function redactHeaders(headers, manifest) {
  const out = { ...headers };
  const name = manifest.auth?.header;
  for (const k of Object.keys(out)) {
    if (name && k.toLowerCase() === name.toLowerCase()) {
      const scheme = manifest.auth.scheme ? `${manifest.auth.scheme} ` : '';
      const v = String(out[k]).slice(scheme.length);
      const tail = v.length > 24 ? v.slice(-4) : '';
      out[k] = `${scheme}${v.slice(0, Math.min(7, Math.max(0, v.length - 20)))}…${tail} (redacted)`;
    } else if (SECRET_HEADER_RE.test(k)) out[k] = '[redacted]';
  }
  return out;
}

// A 3xx (or a browser-style opaque redirect): never followed (fetch runs with
// redirect:'manual'), always an error.
const isRedirect = (res) => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);

async function discard(res) {
  try { await res.body?.cancel(); } catch { /* nothing to release */ }
}

// The manifest as the adapter sees it. On the alt path (xAI's Chat
// Completions fallback) the alt effort map and defaults replace the main ones;
// with no effortAlt the alt path sends no effort field rather than one in the
// wrong shape, and with no defaultRequestOptionsAlt it keeps the main defaults.
function wireManifest(manifest, alt) {
  if (!alt) return manifest;
  return Object.freeze({
    ...manifest,
    effort: manifest.effortAlt ?? {},
    defaultRequestOptions: manifest.defaultRequestOptionsAlt ?? manifest.defaultRequestOptions,
  });
}

async function readText(res, limit = 64 * 1024) {
  if (!res.body) return '';
  const dec = new TextDecoder();
  let text = '';
  try {
    for await (const chunk of res.body) {
      text += dec.decode(chunk, { stream: true });
      if (text.length >= limit) break;
    }
  } catch { /* partial body is fine for classification */ }
  return text.slice(0, limit);
}

// createProvider(manifest, opts). opts:
//   getKey(providerId) → key string | {key, kind:'key'|'oauth'} | null (keychain)
//   fetch        injectable fetch (tests; the egress guard wraps the global one)
//   log(kind, data)  the bridge logger; gets status, type, code, request id and
//                usage only, never a body, a key or message text
//   timeouts     {firstTokenMs, idleMs, runMs, requestMs}
//   headers      extra request headers (Anthropic's anthropic-workspace-id)
//   requestOptions  the app's own choices, merged over the manifest's defaults
//                and the effort fragment (OpenRouter zdr:true; a raised num_ctx;
//                data_collection 'allow' only after the player's click, §9).
//   useAltAdapter   xAI's Chat Completions fallback
//   onRequest({method, url, headers, body})  the "Last request" view (KY-8);
//                the auth header arrives redacted. stream(req, {onRequest})
//                takes one for that call only (the backend's per-chat view).
export function createProvider(manifest, opts = {}) {
  const {
    getKey = async () => null,
    fetch: fetchFn = globalThis.fetch,
    log = () => {},
    timeouts = {},
    headers: extraHeaders = {},
    requestOptions = null,
    useAltAdapter = false,
    onRequest = null,
    now = Date.now,
  } = opts;
  const alt = !!(useAltAdapter && manifest.altAdapter);
  const adapter = ADAPTERS[alt ? manifest.altAdapter : manifest.adapter];
  if (!adapter) throw new Error(`no adapter for ${manifest.id}`);
  const chatPath = alt ? manifest.paths.chatAlt : manifest.paths.chat;
  const wire = wireManifest(manifest, alt);
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const id = manifest.id;

  // No key is `no_key`, never `auth_invalid`: nothing reached the provider, so
  // nothing may mark the stored key invalid (§10). A throwing getKey (a locked
  // keychain, no Secret Service) is keystore_error, not "no key stored".
  const noKey = (code) => makeError({ kind: 'no_key', provider: id, code, retryable: false });

  async function credentials() {
    if (!manifest.auth) return { key: null, kind: 'local', headers: {} };
    let got;
    try { got = await getKey(id); } catch (e) {
      // A sign-in renews its token over the network: a renewal that couldn't reach OpenAI, or that
      // got a server error, is that, never a broken key store.
      if (isSignIn(manifest) && e?.code !== 'keystore_error') {
        return { error: Number.isInteger(e?.status) && e.status > 0 ? classify(manifest, { status: e.status, now: now() }) : classify(manifest, { networkPhase: fetchErrorPhase(e), networkError: e }) };
      }
      return { error: noKey('keystore_error') };
    }
    // A sign-in OpenAI (or another) refused to renew: ended, so "Sign in again", never "no key".
    if (got && typeof got === 'object' && got.expired === true) return { error: makeError({ kind: 'oauth_expired', provider: id, code: 'refresh_refused', retryable: false }) };
    const key = typeof got === 'string' ? got : got?.key;
    // Other (custom) may run with no key: a server on this computer takes none.
    if (!key && manifest.auth.optional === true) return { key: null, kind: 'none', headers: {} };
    if (!key) return { error: noKey('missing_key') };
    const kind = typeof got === 'object' && got?.kind === 'oauth' ? 'oauth' : 'key';
    const { header, scheme } = manifest.auth;
    // A sign-in's own headers (ChatGPT's account id) go with its token, and only on its requests.
    const own = typeof got === 'object' && isObj(got?.headers) ? got.headers : {};
    return { key, kind, headers: { ...own, [header]: scheme ? `${scheme} ${key}` : key } };
  }

  function logError(err, model) {
    log('provider.error', { provider: id, model, ...errorLogFields(err) });
  }

  // A JSON GET (models, key check) with its own timeout.
  async function getJSON(route, signal, cred) {
    const url = joinUrl(manifest.baseUrl, route);
    const timeout = AbortSignal.timeout(t.requestMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetchFn(url, { method: 'GET', headers: { ...manifest.headers, ...extraHeaders, ...cred.headers, accept: 'application/json' }, signal: sig, redirect: 'manual' });
    } catch (e) {
      if (signal?.aborted) return { ok: false, error: makeError({ kind: 'interrupted', provider: id, aborted: true, retryable: false }) };
      if (timeout.aborted) return { ok: false, error: makeError({ kind: 'timeout', provider: id, phase: 'request', afterMs: t.requestMs, retryable: false }) };
      return { ok: false, error: classify(manifest, { networkPhase: fetchErrorPhase(e), networkError: e }) };
    }
    if (isRedirect(res)) {
      await discard(res);
      return { ok: false, error: makeError({ kind: 'unknown', provider: id, status: res.status || undefined, code: 'redirect_refused', retryable: false }) };
    }
    const text = await readText(res, 4 * 1024 * 1024);
    if (!res.ok) return { ok: false, error: classify(manifest, { status: res.status, headers: res.headers, body: text, auth: cred.kind, now: now() }) };
    const json = parseJSON(text);
    if (json === null) return { ok: false, error: makeError({ kind: 'unknown', provider: id, status: res.status, code: 'bad_json' }) };
    return { ok: true, json, headers: res.headers };
  }

  async function validate({ signal } = {}) {
    const cred = await credentials();
    if (cred.error) { logError(cred.error); return { ok: false, error: cred.error }; }
    if (manifest.keyCheck) {
      const r = await getJSON(manifest.keyCheck.path, signal, cred);
      if (!r.ok) { logError(r.error); return r; }
      const d = r.json?.data ?? r.json;
      const blocked = (manifest.keyCheck.blockedFields || []).find(f => d?.[f] === true);
      if (blocked) return { ok: false, error: makeError({ kind: 'auth_invalid', provider: id, code: blocked, retryable: false }) };
    }
    const models = [];
    let route = manifest.paths.models;
    for (let page = 0; route && page < 10; page++) {
      const r = await getJSON(route, signal, cred);
      if (!r.ok) { logError(r.error); return r; }
      const { ids, next } = adapter.modelsPage(r.json, route);
      models.push(...ids);
      route = next;
    }
    return { ok: true, models: [...new Set(models)] };
  }

  // Is the provider's host answering (§10 "Network down": a turn held while nothing could leave)?
  // One HEAD to the models route with no key: any HTTP answer, even a 401 or a 404, means it's
  // reachable; only a failure before the request left says it isn't.
  async function reach({ signal } = {}) {
    const url = joinUrl(manifest.baseUrl, manifest.paths.models);
    const timeout = AbortSignal.timeout(t.requestMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetchFn(url, { method: 'HEAD', headers: { ...manifest.headers }, signal: sig, redirect: 'manual' });
      await discard(res);
      return { ok: true, status: res.status || 0 };
    } catch (e) {
      if (signal?.aborted) return { ok: false, error: makeError({ kind: 'interrupted', provider: id, aborted: true, retryable: false }) };
      if (timeout.aborted) return { ok: false, error: makeError({ kind: 'timeout', provider: id, phase: 'request', afterMs: t.requestMs, retryable: false }) };
      return { ok: false, error: classify(manifest, { networkPhase: fetchErrorPhase(e), networkError: e }) };
    }
  }

  async function* stream(req, { signal, onRequest: onThisRequest = null } = {}) {
    const ctl = new AbortController();
    let why = null;
    const stop = (reason) => { if (!why) { why = reason; ctl.abort(); } };
    if (signal?.aborted) {
      yield { type: 'error', error: makeError({ kind: 'interrupted', provider: id, aborted: true, retryable: false }) };
      return;
    }
    const onAbort = () => stop('caller');
    signal?.addEventListener('abort', onAbort, { once: true });
    const firstTimer = setTimeout(() => stop('first_token'), t.firstTokenMs);
    const runTimer = setTimeout(() => stop('run'), t.runMs);
    let idleTimer = null;
    let started = false;
    let reasoning = false; // inside a reasoning block: the idle timer waits
    let reasoned = false; // the model reasoned in this stream (said once, {type:'reasoning'})
    const armIdle = () => { clearTimeout(idleTimer); idleTimer = reasoning ? null : setTimeout(() => stop('idle'), t.idleMs); };
    const touch = () => { if (!started) { started = true; clearTimeout(firstTimer); } armIdle(); };
    const failure = (e, stage) => {
      if (why === 'caller') return makeError({ kind: 'interrupted', provider: id, aborted: true, retryable: false });
      if (why) {
        const afterMs = why === 'first_token' ? t.firstTokenMs : why === 'idle' ? t.idleMs : t.runMs;
        return makeError({ kind: 'timeout', provider: id, phase: why, afterMs, retryable: false });
      }
      const phase = stage === 'read' ? 'after_send' : fetchErrorPhase(e);
      return classify(manifest, { networkPhase: phase, networkError: e });
    };
    const emitError = (err) => { logError(err, req.model); return { type: 'error', error: err }; };
    try {
      const cred = await credentials();
      if (cred.error) { yield emitError(cred.error); return; }
      // Build everything before anything is sent: a malformed req, a body that
      // won't serialize or a header value fetch would refuse is our fault, not
      // a dropped connection. The thrown message may quote a header (the key),
      // so it's dropped.
      let target, payload;
      try {
        target = adapter.chatRequest(wire, req, { authHeaders: { ...extraHeaders, ...cred.headers }, requestOptions, path: chatPath });
        payload = JSON.stringify(target.body);
        new Headers(target.headers);
      } catch {
        yield emitError(makeError({ kind: 'unknown', provider: id, code: 'bad_request_shape', retryable: false }));
        return;
      }
      for (const hook of [onRequest, onThisRequest]) {
        if (typeof hook !== 'function') continue;
        try { hook({ method: target.method, url: target.url, headers: redactHeaders(target.headers, manifest), body: structuredClone(target.body) }); } catch { /* the view is best effort */ }
      }
      let res;
      try {
        res = await fetchFn(target.url, { method: target.method, headers: target.headers, body: payload, signal: ctl.signal, redirect: 'manual' });
      } catch (e) {
        yield emitError(failure(e, 'fetch'));
        return;
      }
      if (isRedirect(res)) {
        await discard(res);
        yield emitError(makeError({ kind: 'unknown', provider: id, status: res.status || undefined, code: 'redirect_refused', retryable: false }));
        return;
      }
      if (!res.ok) {
        const text = await readText(res);
        if (why) { yield emitError(failure(null, 'read')); return; }
        yield emitError(classify(manifest, { status: res.status, headers: res.headers, body: text, auth: cred.kind, now: now() }));
        return;
      }
      const reqId = (manifest.requestIdHeader && res.headers.get(manifest.requestIdHeader)) || res.headers.get('x-request-id') || null;
      yield { type: 'start', requestId: reqId, rateLimit: parseRateLimit(res.headers, manifest, now()) };
      const ctx = {
        manifest,
        req,
        body: target.body,
        fail: (streamEvent) => classify(manifest, { status: 200, headers: res.headers, streamEvent, auth: cred.kind, now: now() }),
        error: (fields) => makeError({ provider: id, requestId: reqId ?? undefined, ...fields }),
        truncated: () => classify(manifest, { networkPhase: 'after_send', networkError: { code: 'ERR_STREAM_TRUNCATED' } }),
      };
      for await (const ev of adapter.parse(res, ctx)) {
        if (ev.type === 'thinking' || ev.type === 'progress') {
          if (ev.type === 'thinking') reasoning = ev.active !== false;
          touch();
          if (!reasoned && (ev.type === 'thinking' ? reasoning : ev.reasoning === true)) { reasoned = true; yield { type: 'reasoning' }; }
          continue;
        }
        if (ev.type === 'text') { reasoning = false; touch(); }
        if (ev.type === 'error') {
          if (why) { yield emitError(failure(null, 'read')); return; }
          yield emitError(ev.error);
          return;
        }
        if (ev.type === 'usage') {
          if (manifest.local || manifest.priceSource === 'free') ev.usage = { ...ev.usage, costUsd: 0, exact: true };
          log('provider.usage', { provider: id, model: req.model, ...ev.usage });
        }
        clearTimeout(idleTimer); // a slow consumer isn't a stalled provider
        yield ev;
        if (started) armIdle();
        if (ev.type === 'done') return;
      }
      yield emitError(why ? failure(null, 'read') : ctx.truncated());
    } catch (e) {
      yield emitError(failure(e, 'read'));
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(runTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
      ctl.abort();
    }
  }

  // One small request: a 1-token reply (16 where the API has a floor), at the model's lowest
  // thinking level (fix-102): Off where the model can answer without thinking (Claude Sonnet 5.5's
  // between_tools, Sonnet 5's disabled, OpenAI's none), else its lowest, so a key test doesn't think.
  async function testCall({ model, signal } = {}) {
    const m = model ?? manifest.models.default;
    const req = {
      model: m,
      system: [{ text: 'Reply with one word.' }],
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: manifest.limits.testMaxTokens,
      effort: nearestEffort(effortLevels(manifest, m), 'off'),
    };
    let usage = null;
    let finish = null;
    for await (const ev of stream(req, { signal })) {
      if (ev.type === 'error') return { ok: false, error: ev.error };
      if (ev.type === 'usage') usage = ev.usage;
      if (ev.type === 'done') finish = ev.finish;
    }
    return finish ? { ok: true, usage, finish } : { ok: false, error: makeError({ kind: 'unknown', provider: id }) };
  }

  // Other on this computer or at home: what the server reports of the model's thinking (thinkingOptions),
  // from POST /api/show (no key sent). → request options or null when it answered (anything but an
  // Ollama answers 404 or no such field: null), undefined when it couldn't be read (try again later).
  async function thinking({ model, signal } = {}) {
    const c = manifest.custom === true ? checkCustomUrl(manifest.baseUrl) : null;
    if (!c?.ok || !(c.local || c.lan)) return null;
    const timeout = AbortSignal.timeout(Math.min(t.requestMs, THINKING_READ_MS));
    try {
      const res = await fetchFn(new URL('/api/show', manifest.baseUrl).href, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model ?? manifest.models.default }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'manual',
      });
      if (!res.ok) { await discard(res); return res.status >= 500 ? undefined : null; }
      return thinkingOptions(parseJSON(await readText(res, SHOW_READ_MAX)));
    } catch { return undefined; }
  }

  return Object.freeze({ id, manifest, validate, testCall, stream, reach, thinking });
}

export { classify, userLine, durWords, retryPlan, KINDS, RETRYABLE_KINDS, EGRESS_BLOCKED, EGRESS_STOPPED, needsRestart, parseRateLimit, parseRetryAfter, parseDuration } from './errors.mjs';
export { readSSE, readNDJSON, readLines } from './sse.mjs';
export { EFFORT_LEVELS, THINK_ROOM, START_EFFORT, effortLevels, nearestEffort, thinkRoom, startThinkRoom, outputCeiling } from './util.mjs';
