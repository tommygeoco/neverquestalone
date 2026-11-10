// The desktop app's IPC surface (BYOK PRD §11.2 "Hardening the shell", SC-3;
// BUILD-PLAN "Contract: the app API the desktop shell calls").
//
// The settings window shows untrusted text (model output, memory, game text,
// provider errors), so the main process trusts nothing the renderer sends:
//   - every call's input is checked against a small JSON-schema-style schema
//     (hand-written; no schema library), unknown keys refused, sizes capped,
//     control and text-direction characters refused. This is the one place
//     input is checked (systems plan SY-15): the bridge's app API checks only
//     what needs live data (a provider it lists, a model it offers, a folder
//     that holds WoW);
//   - raising or turning off the player's daily spend limit, saving or deleting
//     a key, switching the AI, starting a sign-in, forgetting memory and
//     uninstalling each need a native main-process confirm (TH21), whose text is
//     built here from checked input and fixed tables, never from renderer text.
//     Setting a first limit or lowering one, or picking another model at the
//     same AI company, needs none (D-12);
//   - a pasted key is read off the clipboard here (pasteKey; the page never reads
//     a paste, code health AP-05), a typed one comes straight here (stageKey); it
//     is held only in memory for five minutes, and is never sent back: every
//     result is redacted before it leaves. Saving one tests it first (the bridge's
//     testStagedKey reads it from the stager) and stores it only when the test
//     passes, so a bad new key never replaces a working one (D-03); a pasted one
//     then leaves the clipboard, while it's still there.
// Nothing here imports Electron, so the tests run under plain node --test.
import crypto from 'node:crypto';
import { redactDeep, redactText, maskKey } from './src/redact.mjs';
import { withNotice, NOTICE_ID } from './src/model-notice.mjs';
import { importBridge } from './src/bridge-module.mjs';
import { STRINGS } from './src/strings.mjs';

// The AIs, their names and their pages come from the bridge's manifests: the one place provider
// ids live (systems plan SY-14). Adding one is a manifest (and its fixtures), not an edit here.
const { loadManifests, providerLinks, checkCustomUrl } = await importBridge('bridge/byok/providers/index.mjs');
const { keyShape } = await importBridge('bridge/byok/security/keycheck.mjs');
const { pasteShape, MAX_PASTE_BYTES } = await importBridge('bridge/byok/providers/keytext.mjs');
const { displayOf } = await importBridge('bridge/byok/providers/display.mjs');
const ALL_MANIFESTS = loadManifests();
const MANIFESTS = ALL_MANIFESTS.filter(m => !m.hidden);

export const CHANNEL_PREFIX = 'nqa:';
export const STATUS_CHANNEL = 'nqa:status';
export const NAVIGATE_CHANNEL = 'nqa:navigate';

export const PROVIDER_IDS = Object.freeze(MANIFESTS.map(m => m.id));
export const PROVIDER_NAMES = Object.freeze(Object.fromEntries(MANIFESTS.map(m => [m.id, m.name])));
const LOCAL_PROVIDERS = new Set(MANIFESTS.filter(m => m.local).map(m => m.id));
/** Other (custom): the one AI whose key comes with its service's address (connectCustom), never by paste. */
const CUSTOM_PROVIDERS = new Set(MANIFESTS.filter(m => m.custom === true).map(m => m.id));
/** A plan that signs in (ChatGPT): no key is pasted for it, ever (signIn). */
const SIGNIN_PROVIDERS = new Set(MANIFESTS.filter(m => typeof m.auth?.signIn === 'string').map(m => m.id));
const PROVIDER_LINKS = providerLinks(MANIFESTS);
/** A link whose URL is a template main fills from checked input ({hash}). */
const isTemplate = url => url.includes('{hash}');

/**
 * Every page the app may open in the player's browser, by id. The renderer names an id; it never
 * supplies a URL. The AIs' pages (keys, billing, limits, privacy, terms, download) are the
 * manifests'; these are the rest.
 */
export const LINKS = Object.freeze({
  ...Object.fromEntries(Object.entries(PROVIDER_LINKS).filter(([, url]) => !isTemplate(url))),
  'verify.lulu': 'https://objective-see.org/products/lulu.html',
  'verify.tcpview': 'https://learn.microsoft.com/en-us/sysinternals/downloads/tcpview',
  'verify.opensnitch': 'https://github.com/evilsocket/opensnitch',
  'credits.upstream': 'https://github.com/chelinho139/wow-ai',
  'credits.codex': 'https://github.com/0xinuarashi/wow-forever-codex',
  'blizzard.trademarks': 'https://www.blizzard.com/en-us/legal/38fd0408-8431-469a-99bc-2cd9eb9462c8/blizzard-entertainment-trademark-usage-guidelines',
  'mac.screenRecording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  // Setup (onboarding spec §3.8): the login items pane, and Privacy & Security itself.
  'mac.loginItems': 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  'mac.privacy': 'x-apple.systempreferences:com.apple.preference.security',
});
/** The macOS settings panes the app may open: fixed literals, the only links that aren't https. */
export const MAC_PANES = Object.freeze(['mac.screenRecording', 'mac.loginItems', 'mac.privacy'].map(id => LINKS[id]));
/** Link ids whose URL is built in main from checked data: the manifests' templates and the release page. */
const TEMPLATE_LINKS = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_LINKS).filter(([, url]) => isTemplate(url))));
const DYNAMIC_LINKS = [...Object.keys(TEMPLATE_LINKS), 'releases'];
export const LINK_IDS = Object.freeze([...Object.keys(LINKS), ...DYNAMIC_LINKS]);

/** Fixed strings the copy button may put on the clipboard. */
export const COMMANDS = Object.freeze({
  bones_hi: '/nqa hi',
  bones_mode_reload: '/nqa mode reload',
  bones_diag: '/nqa diag',
  // The addon's Screen Reading switch by command (onboarding spec §3.8 row 2).
  bones_stream_on: '/nqa stream on',
  bones_stream_off: '/nqa stream off',
  // The same switch in its own word (the addon's /nqa reading on|off): what the window shows.
  bones_reading_off: '/nqa reading off',
  bones_reading_on: '/nqa reading on',
  bones_mode_pixel: '/nqa mode pixel',
});

// ---------------------------------------------------------------------------
// The validator: a small JSON-schema subset. check(schema, value) returns
// { ok: true, value } with a fresh object holding only declared keys, or
// { ok: false, error } naming the path and the rule.

const MAX_INPUT_BYTES = 8 * 1024;
const DEFAULT_MAX_STRING = 256;
// C0/C1 controls, zero-width and text-direction characters, the BOM.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

const okv = value => ({ ok: true, value });
const bad = (at, why) => ({ ok: false, error: `${at}: ${why}` });
const safeKey = k => JSON.stringify(String(k).slice(0, 32));

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function check(schema, value, at = 'input') {
  switch (schema.type) {
    case 'none':
      if (value === undefined || value === null) return okv(undefined);
      if (isPlainObject(value) && Object.keys(value).length === 0) return okv(undefined);
      return bad(at, 'takes no input');
    case 'object': {
      if ((value === undefined || value === null) && schema.optional) return okv(undefined);
      if (!isPlainObject(value)) return bad(at, 'must be an object');
      const props = schema.properties;
      for (const k of Object.keys(value)) {
        if (!Object.hasOwn(props, k)) return bad(`${at}[${safeKey(k)}]`, 'is not allowed');
      }
      const out = {};
      for (const [k, sub] of Object.entries(props)) {
        if (!Object.hasOwn(value, k) || value[k] === undefined) {
          if ((schema.required ?? []).includes(k)) return bad(`${at}.${k}`, 'is required');
          continue;
        }
        const r = check(sub, value[k], `${at}.${k}`);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      if (schema.minProperties && Object.keys(out).length < schema.minProperties) return bad(at, 'needs at least one field');
      return okv(out);
    }
    case 'string': {
      if (typeof value !== 'string') return bad(at, 'must be a string');
      if (schema.enum) return schema.enum.includes(value) ? okv(value) : bad(at, 'is not an allowed value');
      const len = [...value].length;
      if (len < (schema.minLength ?? 0)) return bad(at, 'is too short');
      if (len > (schema.maxLength ?? DEFAULT_MAX_STRING)) return bad(at, 'is too long');
      if (!schema.raw && UNSAFE_TEXT.test(value)) return bad(at, 'has control or text-direction characters');
      if (schema.pattern && !schema.pattern.test(value)) return bad(at, 'has the wrong shape');
      return okv(value);
    }
    case 'integer':
      if (!Number.isInteger(value)) return bad(at, 'must be a whole number');
      if (value < schema.minimum || value > schema.maximum) return bad(at, `must be ${schema.minimum}–${schema.maximum}`);
      return okv(value);
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad(at, 'must be a number');
      if (value < schema.minimum || value > schema.maximum) return bad(at, `must be ${schema.minimum}–${schema.maximum}`);
      if (schema.maxDecimals != null) {
        const scaled = value * 10 ** schema.maxDecimals;
        if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return bad(at, `has more than ${schema.maxDecimals} decimals`);
      }
      return okv(value);
    }
    case 'boolean':
      return typeof value === 'boolean' ? okv(value) : bad(at, 'must be true or false');
    case 'nullable':
      return value === null ? okv(null) : check(schema.of, value, at);
    default:
      return bad(at, 'has no schema');
  }
}

function inputSize(value) {
  if (value === undefined) return 0;
  try { return Buffer.byteLength(JSON.stringify(value) ?? ''); } catch { return Infinity; }
}

// Shapes used by the schemas below.
export const PATTERNS = Object.freeze({
  key: /^[A-Za-z0-9._~+/=-]+$/,
  stageId: /^[0-9a-f]{32}$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/,
  chatId: /^[A-Za-z0-9_-]{1,64}$/,
  character: /^[\p{L}\p{M}0-9](?:[\p{L}\p{M}0-9' -]{0,62}[\p{L}\p{M}0-9])?$/u,
  hash: /^[0-9a-f]{64}$/,
});

const NONE = { type: 'none' };
/** Setup's screens and paths, as appState.setup saves them (onboarding spec §3.11). */
export const SETUP_SCREENS = Object.freeze(['welcome', 'ai', 'connect', 'defaults', 'wow']);
export const SETUP_PATHS = Object.freeze(['key', 'custom']);
const BOOL = { type: 'boolean' };
const PROVIDER = { type: 'string', enum: PROVIDER_IDS };
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, ...extra });

// ---------------------------------------------------------------------------
// Keys: guessed from their shape (§16.1 step 4), staged in main memory only.

/**
 * Which AI a pasted key is for, from its shape alone (the one table of key shapes, keycheck.mjs
 * KEY_SHAPES, which also drives redaction and the in-game refusal): an id, or null. A shape with no
 * manifest (a Google key) comes back as its company's id, so the window can say it isn't offered.
 */
export function guessProvider(key) {
  return keyShape(String(key ?? ''));
}

/**
 * Pasted keys wait here (never in the renderer) until a dialog is agreed to (onboarding spec §3.4.2).
 * A stage lasts ttlMs (5 minutes); a key whose test failed for a reason fixed away from the app
 * (credit, a spend limit, a busy company) is approved for its AI and held heldMs (30 minutes), so
 * Test again needs no paste and no second dialog. lock, suspend, quit, Back and a new paste clear it.
 *   stage(key, {source}) → id · peek(id, provider?) → key|null · entry(id) → {source, provider, held, lastError}
 *   approve(id, provider) · hold(id) · note(id, {lastError}) · drop(id) · clear() · secrets()
 */
export function createKeyStager({ now = Date.now, ttlMs = 5 * 60_000, heldMs = 30 * 60_000, max = 4, random = () => crypto.randomBytes(16).toString('hex') } = {}) {
  const staged = new Map();
  const sweep = () => {
    const t = now();
    for (const [id, s] of staged) if (t - s.at > (s.held ? heldMs : ttlMs)) staged.delete(id);
  };
  return {
    stage(key, { source = 'field' } = {}) {
      sweep();
      while (staged.size >= max) staged.delete(staged.keys().next().value);
      const id = random();
      staged.set(id, { key, at: now(), source: source === 'clipboard' ? 'clipboard' : 'field', provider: null, held: false, lastError: null });
      return id;
    },
    /** The key, or null (gone, or approved for another AI than provider). */
    peek(id, provider = null) {
      sweep();
      const s = staged.get(id);
      if (!s) return null;
      if (provider && s.provider && s.provider !== provider) return null;
      return s.key;
    },
    entry(id) {
      sweep();
      const s = staged.get(id);
      return s ? { source: s.source, provider: s.provider, held: s.held, lastError: s.lastError } : null;
    },
    /** The dialog was agreed to for provider: the key may be tested (again) for it alone. */
    approve(id, provider) { const s = staged.get(id); if (!s || !provider) return false; s.provider = provider; return true; },
    /** Keep an approved key 30 minutes from now (a fix away from the app). */
    hold(id) { const s = staged.get(id); if (!s || !s.provider) return false; s.held = true; s.at = now(); return true; },
    note(id, fields = {}) { const s = staged.get(id); if (s && typeof fields.lastError === 'string') s.lastError = fields.lastError; },
    drop(id) { staged.delete(id); },
    clear() { staged.clear(); },
    secrets() { return [...staged.values()].map(s => s.key); },
    get size() { sweep(); return staged.size; },
  };
}

// ---------------------------------------------------------------------------
// Text for the native confirms. Built from checked input and fixed tables.

/** Dollars as a measured or set amount (STYLE §8): US dollars with cents, through Intl. */
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export function usdText(dollars) {
  const n = Number(dollars) || 0;
  return USD.format(n);
}
/**
 * The daily spend limit's native confirm (TH21, D-12), or null for none, in main's table's words
 * (src/strings.mjs limitConfirm; bones-ux-writer onboarding r1, UX-W11). The limit is the player's
 * own and off by default (null). Only what lets more be spent asks: raising it, or turning it off
 * (the largest raise there is; without that dialog a page could skip the raise's by clearing
 * instead). A first limit, or a lower one, asks nothing: it only lowers what can be spent. A
 * previous value that can't be read asks, whatever the change.
 */
export function capsConfirm(next, prev, name = 'NeverQuestAlone') {
  const before = isPlainObject(prev) && (prev.dailyUsd === null || typeof prev.dailyUsd === 'number') ? prev.dailyUsd : undefined;
  const cancelLabel = st('limitConfirm.cancelLabel');
  if (next === null) {
    if (before === null) return null;
    return {
      message: st('limitConfirm.off.message'),
      detail: typeof before === 'number' ? st('limitConfirm.off.detail', { before: usdText(before), name }) : st('limitConfirm.off.detailNoLimit', { name }),
      okLabel: st('limitConfirm.off.okLabel'), cancelLabel,
    };
  }
  if (before === null) return null;
  if (typeof before === 'number' && next <= before) return null;
  const amount = usdText(next);
  if (typeof before === 'number') {
    return { message: st('limitConfirm.raise.message', { amount }), detail: st('limitConfirm.raise.detail', { amount, before: usdText(before) }), okLabel: st('limitConfirm.raise.okLabel'), cancelLabel };
  }
  return { message: st('limitConfirm.set.message', { amount }), detail: st('limitConfirm.set.detail', { amount }), okLabel: st('limitConfirm.set.okLabel'), cancelLabel };
}
export function storeName(platform) {
  if (platform === 'win32') return 'Windows Credential Manager';
  if (platform === 'darwin') return 'your macOS Keychain';
  return 'the Secret Service';
}
/** The last step of an uninstall, per OS (the app can't remove itself). */
export function finishLine(platform) {
  if (platform === 'darwin') return 'To finish, drag NeverQuestAlone from Applications to the Trash.';
  if (platform === 'win32') return 'To finish, remove NeverQuestAlone in Settings > Apps.';
  return 'To finish, delete the NeverQuestAlone AppImage.';
}
const cleanName = (v, n = 60) => String(v ?? '').replace(UNSAFE_TEXT, '').trim().slice(0, n);
function companionName(ctx) {
  const n = String(ctx.companion?.() ?? 'NeverQuestAlone').replace(UNSAFE_TEXT, '').trim().slice(0, 24);
  return n || 'NeverQuestAlone';
}
const pname = id => PROVIDER_NAMES[id] ?? 'this AI company';


// ---------------------------------------------------------------------------
// Setup: Paste key, the connect dialog and what Agree does (onboarding spec §3.4; plan §3.2).

/**
 * T1: a first key whose company documents "no credit yet" is saved anyway (as no_credit), so the
 * player never pastes it again. Anthropic and OpenAI document it; xAI's and Google's are guesses.
 */
export const SAVE_FIRST_KEY_WITHOUT_CREDIT = true;
const NO_CREDIT_AIS = new Set(ALL_MANIFESTS.filter(m => displayOf(m).noCreditDocumented).map(m => m.id));
/** A setup test's results that are fixed away from the app: the key is held 30 minutes for Test again. */
const HELD_RESULTS = new Set(['out_of_credit', 'spend_limit', 'org_verification', 'rate_limited', 'overloaded', 'network', 'failed', 'keystore_error', 'busy']);
/** The key test's cost, as the dialogs and the ok line say it (F.usdMicros under 100 micro-dollars). */
export const TEST_COST = 'under $0.0001';
/** Paste key: at most one read of the clipboard a second. */
export const PASTE_MIN_MS = 1000;

/** A string from main's table (src/strings.mjs) by dotted id, filled; {os:Mac} per platform. */
export function st(id, vars = {}, platform = process.platform) {
  let node = STRINGS;
  for (const k of String(id).split('.')) node = node && typeof node === 'object' ? node[k] : undefined;
  if (typeof node !== 'string') throw new Error(`no string ${id}`);
  const os = { Mac: platform === 'win32' ? 'PC' : 'Mac' };
  return node.replace(/\{os:([^}]+)\}/g, (m, l) => os[l] ?? l).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}
/** Where keys are kept, as the tables say it ({store}). */
export function storeText(platform) {
  if (platform === 'win32') return 'Windows Credential Manager';
  if (platform === 'darwin') return 'your macOS Keychain';
  return 'the Secret Service';
}
const manifestOf = id => ALL_MANIFESTS.find(m => m.id === id) ?? null;
/** The AI's name as its card shows it (Claude, ChatGPT, Grok, Gemini; Other), and its company's. */
export function aiNames(id) {
  const m = manifestOf(id);
  const d = m ? displayOf(m) : {};
  return { ai: d.card ?? m?.name ?? id, co: d.maker ?? m?.name ?? id, termsVersion: d.termsVersion ?? 1 };
}
/** The model setup picks for an AI's first key: its default. */
function setupModel(p, id) {
  const m = manifestOf(id);
  const want = m?.models?.default;
  const models = Array.isArray(p?.models) ? p.models : [];
  const e = models.find(x => x && x.id === want) ?? models[0];
  return cleanName(e?.name || want || '') || null;
}

/**
 * What the dialog for a staged key needs, from the live provider list and status (before any
 * dialog): which AI, whether a key is saved for it (a Replace), another AI in use (a Switch), the
 * terms recorded, and whether a no-credit first key may be saved. → prep | {ok: false, error}.
 */
async function connectPrep(ctx, provider, stageId, source) {
  const p = (await listProviders(ctx)).find(x => x.id === provider);
  if (!p) return { ok: false, error: 'unknown_provider' };
  if (p.hidden) return { ok: false, error: 'hidden_provider', guess: provider };
  if (LOCAL_PROVIDERS.has(provider) || CUSTOM_PROVIDERS.has(provider)) return { ok: false, error: 'no_key_needed' };
  const key = ctx.keys.peek(stageId);
  if (!key) return { ok: false, error: 'stage_expired' };
  let current = null;
  let currentName = null;
  let currentLocal = false;
  try {
    const cur = providerOf(await ctx.api.status());
    // Other with no key (a server on this computer) is in use all the same.
    current = cur && cur.id && (cur.keyState !== 'missing' || cur.auth === 'local') ? cur.id : null;
    // Other is named by its service's host (the bridge's name for it), and says whether it's this computer.
    currentName = current && CUSTOM_PROVIDERS.has(current) ? cleanName(cur.name, 60) || null : null;
    currentLocal = !!current && cur.auth === 'local';
  } catch { current = null; }
  const had = !!(isPlainObject(p.key) && p.key.saved);
  const termsRecorded = !!(isPlainObject(p.terms) && p.terms.recorded === true);
  const names = aiNames(provider);
  return {
    provider, stageId, source: source === 'clipboard' ? 'clipboard' : 'field', had, current: current && current !== provider ? current : null, currentName, currentLocal,
    termsRecorded, termsVersion: names.termsVersion, masked: maskKey(key), model: setupModel(p, provider),
    noCreditOk: SAVE_FIRST_KEY_WITHOUT_CREDIT && !had && NO_CREDIT_AIS.has(provider),
  };
}

/** The native dialog for a staged key (TH21): built here, from main's table and checked names. */
export function connectDialog(ctx, prep) {
  const pf = ctx.platform;
  const { ai, co } = aiNames(prep.provider);
  const v = { ai, co, name: companionName(ctx), store: storeText(pf), testCost: TEST_COST, model: prep.model ?? '', masked: prep.masked };
  const clip = prep.source === 'clipboard';
  const nc = prep.noCreditOk ? 'NoCredit' : '';
  const body = (base) => st(`${base}.${clip ? 'clipboard' : 'field'}${nc}`, v, pf);
  const para = xs => xs.filter(Boolean).join('\n\n');
  const cancelLabel = st('pasteDialog.cancelLabel', v, pf);
  if (prep.had) {
    return {
      message: st('pasteDialog.replace.message', v, pf),
      detail: para([prep.masked, st(clip ? 'pasteDialog.replace.bodyClipboard' : 'pasteDialog.replace.body', v, pf), prep.termsRecorded ? null : st('pasteDialog.connect.terms', v, pf)]),
      okLabel: st('pasteDialog.replace.okLabel', v, pf), cancelLabel, showTerms: !prep.termsRecorded,
    };
  }
  if (prep.current) {
    const from = prep.currentName ? { co: prep.currentName } : aiNames(prep.current);
    const fromLocal = LOCAL_PROVIDERS.has(prep.current) || prep.currentLocal === true;
    const line = fromLocal ? st(pf === 'win32' ? 'pasteDialog.switch.fromLocalLineWin' : 'pasteDialog.switch.fromLocalLine', v, pf) : st('pasteDialog.switch.toCoLine', { ...v, fromCo: from.co }, pf);
    return {
      message: st('pasteDialog.switch.message', v, pf),
      detail: para([prep.masked, body('pasteDialog.connect.body'), line, prep.termsRecorded ? null : st('pasteDialog.connect.terms', v, pf)]),
      okLabel: st(prep.termsRecorded ? 'pasteDialog.switch.okLabelTermsRecorded' : 'pasteDialog.switch.okLabel', v, pf), cancelLabel, showTerms: !prep.termsRecorded,
    };
  }
  return {
    message: st('pasteDialog.connect.message', v, pf),
    detail: para([prep.masked, body('pasteDialog.connect.body'), st('pasteDialog.connect.terms', v, pf)]),
    okLabel: st('pasteDialog.connect.okLabel', v, pf), cancelLabel, showTerms: true,
  };
}

/** A key off the clipboard is cleared there once saved, but only while it's still this key (T3). */
async function clearClipboard(ctx, key) {
  try {
    if (typeof ctx.clipboard?.readText !== 'function') return false;
    const now = String((await ctx.clipboard.readText()) ?? '');
    if (now.trim() !== key && normalizeClip(now) !== key) return false;
    ctx.clipboard.writeText('');
    return true;
  } catch { return false; }
}
// A card's key as a paste wraps it, or an OpenRouter key's (DU-44: Other's form takes it as carry).
const normalizeClip = t => { try { const s = pasteShape(t, ALL_MANIFESTS); return s.key ?? s.carry ?? null; } catch { return null; } };

/**
 * After Agree: record the terms the dialog showed, test the staged key once (setup's way), and
 * save it only when the company accepted it (or, T1, documented no credit on a first key). A
 * failure fixed away from the app holds the key 30 minutes; any other drops it.
 */
async function connectRun(ctx, prep, { recordTerms = true, testFirst = true } = {}) {
  const { provider, stageId } = prep;
  const getKey = () => ctx.keys.peek(stageId, provider);
  if (!getKey()) return { ok: false, error: 'stage_expired', provider };
  ctx.keys.approve(stageId, provider);
  if (recordTerms && prep.showTerms) {
    const rt = await ctx.api.recordTerms(provider, prep.termsVersion);
    if (rt?.ok === false) return { ok: false, error: 'failed', provider };
  }
  const names = aiNames(provider);
  let test = { ok: true, testCall: null };
  if (testFirst) test = await ctx.api.testStagedKey(provider, getKey, { context: 'setup' });
  const key = getKey();
  if (!key) return { ok: false, error: 'stage_expired', provider };
  const save = async (noCredit) => {
    const out = await ctx.api.connect(provider, key, noCredit ? { noCredit: true } : undefined);
    if (!out || out.ok !== true) return out ?? { ok: false, error: 'failed' };
    ctx.keys.drop(stageId);
    const cleared = prep.source === 'clipboard' ? await clearClipboard(ctx, key) : false;
    return { ...out, cleared };
  };
  if (test?.ok === true) {
    const out = await save(false);
    if (out.ok !== true) {
      const err = out.error === 'keystore_error' ? 'keystore_error' : 'failed';
      ctx.keys.hold(stageId);
      ctx.keys.note(stageId, { lastError: err });
      return { ok: false, error: err, provider, ...names, held: true, stageId };
    }
    return { ok: true, provider, ...names, masked: out.masked ?? prep.masked, model: out.model ?? prep.model, cleared: out.cleared, testCall: isPlainObject(test.testCall) ? { micros: test.testCall.micros ?? 0 } : null };
  }
  const t = isPlainObject(test) ? test : { error: 'failed' };
  const error = typeof t.error === 'string' ? t.error : 'failed';
  const facts = { documented: !!t.documented, inferred: !!t.inferred, tier: !!t.tier, ...(Number.isFinite(t.resetAt) ? { resetAt: t.resetAt } : {}), ...(t.model ? { model: cleanName(t.model) } : {}) };
  if (error === 'out_of_credit' && t.documented && prep.noCreditOk) {
    const out = await save(true);
    if (out.ok === true) return { ok: false, error: 'out_of_credit', provider, ...names, ...facts, saved: true, masked: out.masked ?? prep.masked, cleared: out.cleared };
  }
  if (HELD_RESULTS.has(error)) {
    ctx.keys.hold(stageId);
    ctx.keys.note(stageId, { lastError: error });
    // The stage's id (never the key): Test again names it (retryConnect).
    return { ok: false, error, provider, ...names, ...facts, held: true, stageId, kept: prep.had };
  }
  if (error === 'key_mismatch' && t.guess) return { ok: false, error, provider, ...names, guess: t.guess, stageId, kept: prep.had };
  ctx.keys.drop(stageId);
  return { ok: false, error, provider, ...names, ...facts, kept: prep.had };
}

/** The longest key Other's form takes (connectCustom's schema). */
const CUSTOM_KEY_MAX = 1024;

/**
 * A paste into Other's API key field, read off the clipboard by pasteKey (code health AP-05). Any
 * text the typed field takes is a key there (connectCustom's rule: trimmed, no space or control
 * character), so no card's shape is asked of it. It's staged for Other's form as an OpenRouter key
 * pasted on a card is (DU-44: custom_key, with the stage and its mask, never the key; Connect's own
 * dialog asks), and connectCustom takes it off the clipboard once it's saved.
 */
function customPaste(ctx, text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_PASTE_BYTES) return { ok: false, error: 'not_a_key' };
  const key = text.trim();
  if (!key) return { ok: false, error: 'clipboard_empty' };
  if (key.length > CUSTOM_KEY_MAX || /[\s\u0000-\u001f\u007f]/.test(key)) return { ok: false, error: 'not_a_key' };
  const stageId = ctx.keys.stage(key, { source: 'clipboard' });
  return { ok: false, error: 'custom_key', stageId, masked: maskKey(key) };
}

/** Why a paste isn't a key this screen can use, before any dialog. Non-key text goes no further. */
async function pastePrep(ctx, screen, shape, source) {
  const err = (error, extra = {}) => ({ ok: false, error, ...extra });
  switch (shape.reason) {
    case 'clipboard_empty': return err('clipboard_empty');
    case 'not_a_key': return err('not_a_key');
    case 'subscription_token': return err('subscription_token', { guess: 'anthropic' });
    case 'admin_key': return err('admin_key', { guess: shape.id });
    // An OpenRouter key: it connects through Other, with OpenRouter's address (the window offers it).
    // [DU-44] The key is staged, so Other's form has it: Connect is the only click left.
    case 'custom_key': {
      if (!shape.carry) return err('custom_key', { guess: 'openrouter' });
      const stageId = ctx.keys.stage(shape.carry, { source });
      return err('custom_key', { guess: 'openrouter', stageId, masked: maskKey(shape.carry) });
    }
    default: break;
  }
  if (!shape.key || !shape.id) return err('not_a_key');
  const m = manifestOf(shape.id);
  if (!m || m.hidden || shape.hidden) return err('hidden_provider', { guess: shape.id });
  const stageId = ctx.keys.stage(shape.key, { source });
  if (screen && screen !== shape.id) return err('key_mismatch', { guess: shape.id, stageId });
  return connectPrep(ctx, shape.id, stageId, source);
}

// ---------------------------------------------------------------------------
// The handlers. Each: input schema; optional prepare (checks against live
// data, before any dialog); optional confirm (the native dialog's text);
// run. ctx is supplied by main.mjs (see createIpc).

const unsupported = { ok: false, error: 'unsupported' };

// The thinking levels (bridge/byok/providers/util.mjs EFFORT_LEVELS), cheapest first; each one's sentence
// is src/strings.mjs switchConfirm.replyAt, and the window's labels are strings.js bar.thinkingLevel.
export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** The model's nearest level to the one asked for: at or above it, else its highest (util.mjs nearestEffort). */
function nearestLevel(levels, want) {
  const list = Array.isArray(levels) ? levels.filter(l => THINKING_LEVELS.includes(l)) : [];
  if (!list.length || list.includes(want)) return list.length ? want : null;
  const at = THINKING_LEVELS.indexOf(want);
  return list.find(l => THINKING_LEVELS.indexOf(l) > at) ?? list[list.length - 1];
}

export const HANDLERS = {
  // The status the page gets: a model notice it already put away is left out (src/model-notice.mjs).
  status: { input: NONE, run: async ctx => withNotice(await ctx.api.status(), ctx.appState?.noticesSeen?.() ?? [], { platform: ctx.platform }) },
  /** Okay on the model notice (§10, PV-3): it never shows again. Only an id the page was shown. */
  dismissNotice: {
    input: obj({ id: { type: 'string', pattern: NOTICE_ID } }),
    run: (ctx, v) => {
      ctx.appState.seeNotice(v.id);
      ctx.onNoticeSeen?.();
      return { ok: true };
    },
  },
  providers: { input: NONE, run: ctx => ctx.api.providers() },
  appInfo: { input: NONE, run: ctx => ctx.info() },
  notices: { input: NONE, run: ctx => ctx.notices() },
  appState: { input: NONE, run: ctx => ctx.appState.get() },
  setAppState: {
    input: obj({
      onboarded: BOOL, notifications: BOOL, defaultsSeen: BOOL,
      // Where setup is (onboarding spec §3.11): no secrets, only the screen and the AI.
      setup: { type: 'nullable', of: obj({ v: { type: 'integer', minimum: 2, maximum: 2 }, screen: { type: 'string', enum: SETUP_SCREENS }, path: { type: 'string', enum: SETUP_PATHS }, provider: { type: 'nullable', of: PROVIDER } }, ['v', 'screen']) },
    }, [], { minProperties: 1 }),
    run: (ctx, v) => ({ ok: true, state: ctx.appState.set(v) }),
  },
  setLoginItem: {
    input: obj({ openAtLogin: BOOL }),
    run: (ctx, v) => ctx.loginItem.set(v.openAtLogin),
  },

  // Keys (KY-1, §16.1 step 4). stageKey takes what was typed into the key field (a paste there is
  // pasteKey, code health AP-05), normalized, then its shape; connectKey connects it. The key never
  // goes back to the page.
  stageKey: {
    input: obj({ key: { type: 'string', minLength: 1, maxLength: MAX_PASTE_BYTES, raw: true } }),
    run: (ctx, v) => {
      const shape = pasteShape(v.key, ALL_MANIFESTS);
      if (shape.reason === 'custom_key' && shape.carry) { // [DU-44] staged for Other's form
        const stageId = ctx.keys.stage(shape.carry, { source: 'field' });
        return { ok: false, error: 'custom_key', guess: 'openrouter', stageId, masked: maskKey(shape.carry) };
      }
      if (!shape.key) return { ok: false, error: shape.reason ?? 'not_a_key', ...(shape.id ? { guess: shape.id } : {}) };
      const stageId = ctx.keys.stage(shape.key, { source: 'field' });
      return { ok: true, stageId, masked: maskKey(shape.key), guess: shape.id, guessName: PROVIDER_NAMES[shape.id] ?? null };
    },
  },
  /**
   * Paste key (onboarding spec §3.4.2): main reads the clipboard itself (the page never sees the
   * key), checks its shape, stages a key, and shows the dialog when it's a key for this screen's AI
   * (provider null on the first screen: any AI with a card). Refused while the window isn't
   * focused, and past one read a second: both silently. A paste into a key field comes here too
   * (code health AP-05): Your AI's is Paste key for the AI in use; Other's (provider custom) is
   * staged for its form, below.
   */
  pasteKey: {
    input: obj({ provider: { type: 'nullable', of: PROVIDER } }, [], { optional: true }),
    announce: true, // the page hears when the test starts (after Agree): ctx.onAgreed
    prepare: async (ctx, v) => {
      if (typeof ctx.isFocused === 'function' && !ctx.isFocused()) return { ok: false, error: 'ignored' };
      const t = (ctx.now ?? Date.now)();
      if (ctx.lastPasteAt && t - ctx.lastPasteAt < PASTE_MIN_MS) return { ok: false, error: 'ignored' };
      ctx.lastPasteAt = t;
      let text = '';
      try { text = typeof ctx.clipboard?.readText === 'function' ? String((await ctx.clipboard.readText()) ?? '') : ''; } catch { text = ''; }
      if (v?.provider && CUSTOM_PROVIDERS.has(v.provider)) {
        const staged = customPaste(ctx, text);
        text = '';
        return staged;
      }
      const shape = pasteShape(text, ALL_MANIFESTS);
      text = '';
      return pastePrep(ctx, v?.provider ?? null, shape, 'clipboard');
    },
    confirm: (ctx, v, prep) => connectDialog(ctx, prep),
    run: (ctx, v, prep) => connectRun(ctx, { ...prep, showTerms: connectDialog(ctx, prep).showTerms }),
  },
  /** Connect a staged key (the key field's arrow, or Use <AI> instead on a key for another AI): the dialog, then as Paste key. */
  connectKey: {
    input: obj({ provider: PROVIDER, stageId: { type: 'string', pattern: PATTERNS.stageId } }),
    announce: true, // the page hears when the test starts (after Agree): ctx.onAgreed
    prepare: async (ctx, v) => {
      const e = ctx.keys.entry(v.stageId);
      if (!e) return { ok: false, error: 'stage_expired' };
      const key = ctx.keys.peek(v.stageId);
      const shape = pasteShape(key ?? '', ALL_MANIFESTS);
      if (shape.id && shape.id !== v.provider) return { ok: false, error: 'key_mismatch', guess: shape.id, stageId: v.stageId };
      return connectPrep(ctx, v.provider, v.stageId, e.source);
    },
    confirm: (ctx, v, prep) => connectDialog(ctx, prep),
    run: (ctx, v, prep) => connectRun(ctx, { ...prep, showTerms: connectDialog(ctx, prep).showTerms }),
  },
  /**
   * Test again (or Save again) on a key held for a fix away from the app: no paste, no second
   * dialog, only for the AI its dialog was agreed to, within 30 minutes. After the key store
   * failed, only the write runs again.
   */
  retryConnect: {
    input: obj({ provider: PROVIDER, stageId: { type: 'string', pattern: PATTERNS.stageId } }),
    prepare: async (ctx, v) => {
      const e = ctx.keys.entry(v.stageId);
      if (!e) return { ok: false, error: 'stage_expired' };
      if (!e.held || e.provider !== v.provider) return { ok: false, error: 'needs_confirm' };
      const prep = await connectPrep(ctx, v.provider, v.stageId, e.source);
      if (prep.ok === false) return prep;
      return { ...prep, lastError: e.lastError };
    },
    run: (ctx, v, prep) => connectRun(ctx, { ...prep, showTerms: false }, { recordTerms: false, testFirst: prep.lastError !== 'keystore_error' }),
  },
  /** Use saved key (Connect <AI>, returning): the dialog only when the terms aren't recorded. */
  useSavedKey: {
    input: obj({ provider: PROVIDER }),
    announce: true, // the page hears when the test starts (after Agree): ctx.onAgreed
    prepare: async (ctx, v) => {
      if (LOCAL_PROVIDERS.has(v.provider) || CUSTOM_PROVIDERS.has(v.provider)) return { ok: false, error: 'no_key_needed' };
      const p = (await listProviders(ctx)).find(x => x.id === v.provider);
      if (!p || p.hidden) return { ok: false, error: 'unknown_provider' };
      if (!(isPlainObject(p.key) && p.key.saved)) return { ok: false, error: SIGNIN_PROVIDERS.has(v.provider) ? 'not_signed_in' : 'no_key' };
      const names = aiNames(v.provider);
      return { termsRecorded: !!p.terms?.recorded, termsVersion: names.termsVersion, masked: cleanName(p.key.masked, 40), model: setupModel(p, v.provider) };
    },
    confirm: (ctx, v, prep) => {
      if (prep.termsRecorded) return null;
      const pf = ctx.platform;
      const { ai, co } = aiNames(v.provider);
      const vars = { ai, co, name: companionName(ctx), store: storeText(pf), testCost: TEST_COST, model: prep.model ?? '', masked: prep.masked };
      return {
        message: st('pasteDialog.useSaved.message', vars, pf),
        detail: [st('pasteDialog.useSaved.body', vars, pf), st('pasteDialog.connect.terms', vars, pf)].join('\n\n'),
        okLabel: st('pasteDialog.useSaved.okLabel', vars, pf), cancelLabel: st('pasteDialog.cancelLabel', vars, pf),
      };
    },
    run: async (ctx, v, prep) => {
      if (!prep.termsRecorded) await ctx.api.recordTerms(v.provider, prep.termsVersion);
      const r = await ctx.api.useSavedKey(v.provider);
      const names = aiNames(v.provider);
      if (r?.ok === true) return { ok: true, provider: v.provider, ...names, masked: r.masked ?? prep.masked, model: prep.model, testCall: isPlainObject(r.testCall) ? { micros: r.testCall.micros ?? 0 } : null, cleared: false };
      return { ...(isPlainObject(r) ? r : {}), ok: false, error: typeof r?.error === 'string' ? r.error : 'failed', provider: v.provider, ...names };
    },
  },
  dropStagedKey: {
    input: obj({ stageId: { type: 'string', pattern: PATTERNS.stageId } }),
    run: (ctx, v) => { ctx.keys.drop(v.stageId); return { ok: true }; },
  },
  testKey: { input: obj({ provider: PROVIDER }), run: (ctx, v) => ctx.api.testKey(v.provider) },
  /**
   * Sign in with a plan (ChatGPT): the dialog (the terms, and a switch from the AI in use), then the
   * bridge opens the player's browser at the company's sign-in page and waits for it (app-api signIn).
   * No key passes through the page or this process's IPC.
   */
  signIn: {
    input: obj({ provider: PROVIDER }),
    announce: true, // the page hears when the browser opens (after Agree): ctx.onAgreed
    prepare: async (ctx, v) => {
      if (!SIGNIN_PROVIDERS.has(v.provider)) return { ok: false, error: 'unknown_provider' };
      const p = (await listProviders(ctx)).find(x => x.id === v.provider);
      if (!p || p.hidden) return { ok: false, error: 'unknown_provider' };
      let current = null;
      try {
        const cur = providerOf(await ctx.api.status());
        current = cur && cur.id && cur.id !== v.provider && (cur.keyState !== 'missing' || cur.auth === 'local') ? cur.id : null;
      } catch { current = null; }
      return { termsRecorded: !!p.terms?.recorded, termsVersion: aiNames(v.provider).termsVersion, current };
    },
    confirm: (ctx, v, prep) => {
      const pf = ctx.platform;
      const { ai, co } = aiNames(v.provider);
      const vars = { ai, co, name: companionName(ctx), fromCo: prep.current ? aiNames(prep.current).co : '' };
      return {
        message: st('signInDialog.message', vars, pf),
        detail: [st('signInDialog.body', vars, pf), prep.current ? st('signInDialog.switchLine', vars, pf) : null, prep.termsRecorded ? null : st('signInDialog.terms', vars, pf)].filter(Boolean).join('\n\n'),
        okLabel: st(prep.termsRecorded ? 'signInDialog.okLabelTermsRecorded' : 'signInDialog.okLabel', vars, pf),
        cancelLabel: st('pasteDialog.cancelLabel', vars, pf),
      };
    },
    run: async (ctx, v, prep) => {
      if (!prep.termsRecorded) await ctx.api.recordTerms(v.provider, prep.termsVersion);
      const r = await ctx.api.signIn(v.provider);
      const names = aiNames(v.provider);
      if (r?.ok === true) return { ok: true, provider: v.provider, ...names, plan: cleanName(r.plan, 24) || null, model: cleanName(r.model) || null, testCall: isPlainObject(r.testCall) ? { micros: 0 } : null };
      return { ok: false, error: typeof r?.error === 'string' ? r.error : 'failed', provider: v.provider, ...names };
    },
  },
  /** Cancel a sign-in waiting on the browser. */
  cancelSignIn: {
    input: obj({ provider: PROVIDER }),
    run: (ctx, v) => (SIGNIN_PROVIDERS.has(v.provider) ? ctx.api.cancelSignIn(v.provider) : { ok: false, error: 'unknown_provider' }),
  },
  deleteKey: {
    input: obj({ provider: PROVIDER }),
    prepare: (ctx, v) => (LOCAL_PROVIDERS.has(v.provider) ? { ok: false, error: 'no_key_needed' } : {}),
    confirm: (ctx, v) => (SIGNIN_PROVIDERS.has(v.provider) ? {
      message: `Sign out of your ${aiNames(v.provider).ai}?`,
      detail: `Your sign-in is removed from ${storeName(ctx.platform)}. ${companionName(ctx)} can’t use your plan until you sign in again.`,
      okLabel: 'Sign out',
      destructive: true,
    } : {
      message: `Delete your ${pname(v.provider)} key?`,
      detail: `It’s removed from ${storeName(ctx.platform)}. ${companionName(ctx)} can’t use ${pname(v.provider)} until you add a key again.`,
      okLabel: 'Delete key',
      destructive: true,
    }),
    run: (ctx, v) => ctx.api.deleteKey(v.provider),
  },
  /**
   * Other (custom): the player's own OpenAI-compatible service, its base URL, model and (optional)
   * key, typed into the form or pasted (staged by pasteKey: stageId, code health AP-05). One native
   * confirm names the service's address (TH21), then the bridge tests it with one tiny request and
   * saves it only when it answers. The key goes no further than the bridge's key store, and the
   * result carries only its mask.
   */
  connectCustom: {
    input: obj({
      baseUrl: { type: 'string', minLength: 1, maxLength: 512 },
      model: { type: 'string', maxLength: 128, pattern: PATTERNS.model },
      key: { type: 'string', maxLength: CUSTOM_KEY_MAX, raw: true },
      // [DU-44] A key pasted where a card's goes (an OpenRouter key), or into the form (code health
      // AP-05), staged by main: used when no key is typed.
      stageId: { type: 'string', pattern: PATTERNS.stageId },
    }, ['baseUrl', 'model']),
    announce: true, // the page hears when the test starts (after Agree): ctx.onAgreed
    prepare: async (ctx, v) => {
      const c = checkCustomUrl(v.baseUrl);
      if (!c.ok) return { ok: false, error: c.error };
      if (typeof v.key === 'string' && /[\s\u0000-\u001f\u007f]/.test(v.key.trim())) return { ok: false, error: 'not_a_key' };
      const typed = typeof v.key === 'string' && !!v.key.trim();
      if (!typed && v.stageId && !ctx.keys.peek(v.stageId)) return { ok: false, error: 'key_expired' };
      return { provider: 'custom', baseUrl: c.baseUrl, host: new URL(c.baseUrl).host, local: c.local, hasKey: typed || !!v.stageId, staged: !typed && v.stageId ? v.stageId : null };
    },
    confirm: (ctx, v, prep) => {
      const pf = ctx.platform;
      const vars = { name: companionName(ctx), host: prep.host, url: prep.baseUrl, model: cleanName(v.model, 128), store: storeText(pf) };
      const d = prep.local ? 'customDialog.localBody' : prep.hasKey ? 'customDialog.keyBody' : 'customDialog.noKeyBody';
      return {
        message: st('customDialog.message', vars, pf),
        detail: [st(d, vars, pf), prep.local ? null : st('customDialog.terms', vars, pf)].filter(Boolean).join('\n\n'),
        okLabel: st('customDialog.okLabel', vars, pf), cancelLabel: st('pasteDialog.cancelLabel', vars, pf),
      };
    },
    run: async (ctx, v, prep) => {
      const staged = prep?.staged ? ctx.keys.peek(prep.staged) : null;
      if (prep?.staged && !staged) return { ok: false, error: 'key_expired', provider: 'custom' };
      // A key pasted into the form (or an OpenRouter key pasted on a card) came off the clipboard: once
      // it's saved it leaves there too, while it's still there (code health AP-05; PRD §8.1, T3).
      const pasted = !!staged && ctx.keys.entry(prep.staged)?.source === 'clipboard';
      const key = staged ?? (typeof v.key === 'string' ? v.key : null);
      const r = await ctx.api.connectCustom({ baseUrl: v.baseUrl, model: v.model, ...(key !== null ? { key } : {}) });
      if (prep?.staged && isPlainObject(r) && r.ok) {
        ctx.keys.drop(prep.staged);
        if (pasted) await clearClipboard(ctx, staged);
      }
      return isPlainObject(r) ? { ...r, provider: 'custom' } : { ok: false, error: 'failed', provider: 'custom' };
    },
  },
  choose: {
    input: obj({
      provider: PROVIDER,
      model: { type: 'string', maxLength: 128, pattern: PATTERNS.model },
      effort: { type: 'nullable', of: { type: 'string', enum: THINKING_LEVELS } },
    }, ['provider', 'model']),
    prepare: async (ctx, v) => {
      const p = (await listProviders(ctx)).find(x => x.id === v.provider);
      if (!p || p.hidden) return { ok: false, error: 'unknown_provider' };
      // Only a model the provider lists: an empty list (no key yet, a local
      // server that's down) means nothing can be chosen, not anything can.
      const models = Array.isArray(p.models) ? p.models : [];
      const m = models.find(x => x && x.id === v.model);
      if (!m) return { ok: false, error: models.length ? 'unknown_model' : 'no_models' };
      // The provider in use: one with a key (or a local one). A provider with no key yet
      // (a fresh install's default) isn't in use, so the first choice is no switch.
      let current = null;
      let currentLocal = false;
      try {
        const cur = providerOf(await ctx.api.status());
        current = cur && cur.id && (cur.keyState !== 'missing' || cur.auth === 'local') ? cur.id : null;
        currentLocal = !!current && cur.auth === 'local';
      } catch {}
      return { current, currentLocal, toLocal: CUSTOM_PROVIDERS.has(v.provider) && p.local === true, modelName: cleanName(m.name || m.id) || v.model, levels: Array.isArray(m.efforts) ? m.efforts : [] };
    },
    // A native confirm only when the provider changes (where messages go, TH21); another
    // model at the same provider needs none (D-12). Names, never raw ids, where there are names.
    confirm: (ctx, v, prep) => {
      if (!prep.current || prep.current === v.provider) return null;
      const toLocal = LOCAL_PROVIDERS.has(v.provider) || prep.toLocal === true;
      const fromLocal = LOCAL_PROVIDERS.has(prep.current) || prep.currentLocal === true;
      const vars = { name: companionName(ctx), model: prep.modelName, ai: pname(v.provider), fromCo: pname(prep.current) };
      const privacy = st(`switchConfirm.${toLocal ? 'toLocal' : (fromLocal ? 'fromLocal' : 'move')}`, vars);
      // The level as the model runs it (the bridge saves the model's nearest), as its own sentence.
      const level = v.effort ? nearestLevel(prep.levels, v.effort) : null;
      return {
        message: st('switchConfirm.message', vars),
        detail: `${st(level ? `switchConfirm.replyAt.${level}` : 'switchConfirm.reply', vars)} ${privacy}`,
        okLabel: st('switchConfirm.okLabel'),
      };
    },
    run: (ctx, v) => ctx.api.choose({ provider: v.provider, model: v.model, effort: v.effort ?? null }),
  },

  // Spend (§9.4, DB8). The public build has no limits of its own (maintainer, 2026-09-26): the one limit
  // left is a daily spend limit the player may set, none by default (dailyUsd null).
  caps: { input: NONE, run: ctx => ctx.api.caps() },
  setCaps: {
    input: obj({ dailyUsd: { type: 'nullable', of: { type: 'number', minimum: 0, maximum: 100, maxDecimals: 2 } } }),
    prepare: async ctx => {
      let prev = null;
      try { prev = await ctx.api.caps(); } catch {}
      return { prev: isPlainObject(prev) ? prev : null };
    },
    confirm: (ctx, v, prep) => capsConfirm(v.dailyUsd, prep.prev, companionName(ctx)),
    run: (ctx, v) => ctx.api.setCaps({ dailyUsd: v.dailyUsd }),
  },

  // Privacy (§13.1, PR-1, PR-4).
  privacy: { input: NONE, run: ctx => ctx.api.privacy() },
  setPrivacy: {
    input: obj({ identity: BOOL, otherNames: BOOL, companion: BOOL, echo: BOOL, gameContext: BOOL, screenReading: BOOL }),
    run: (ctx, v) => ctx.api.setPrivacy(v),
  },

  // Seeing what happened (§8.4, KY-6..KY-8, PR-3).
  usage: {
    input: obj({ days: { type: 'integer', minimum: 1, maximum: 90 } }, [], { optional: true }),
    run: (ctx, v) => ctx.api.usage({ days: v?.days ?? 30 }),
  },
  connections: {
    input: NONE,
    run: async ctx => ({ bridge: await ctx.api.connections(), shell: ctx.ledger.snapshot() }),
  },
  lastRequest: {
    input: obj({ chatId: { type: 'string', pattern: PATTERNS.chatId } }, [], { optional: true }),
    run: (ctx, v) => ctx.api.lastRequest(v?.chatId),
  },

  // Memory and transcripts (§13.1).
  memory: {
    input: obj({ char: { type: 'string', maxLength: 64, pattern: PATTERNS.character } }, [], { optional: true }),
    run: (ctx, v) => ctx.api.memory(v?.char),
  },
  // One character ({char}), or every character the memory lists ({all: true}: Settings' Forget all,
  // one confirm for all of them, CL-words-76). The characters come from the bridge, never the page.
  forgetMemory: {
    input: obj({ char: { type: 'string', maxLength: 64, pattern: PATTERNS.character }, all: BOOL }, [], { minProperties: 1 }),
    prepare: async (ctx, v) => {
      if (v.all === undefined) return v.char === undefined ? { ok: false, error: 'bad_input' } : {};
      if (v.all !== true || v.char !== undefined) return { ok: false, error: 'bad_input' };
      let m = null;
      try { m = await ctx.api.memory(); } catch {}
      const chars = Array.isArray(m?.chars) ? m.chars.filter(c => typeof c === 'string' && PATTERNS.character.test(c)) : [];
      return chars.length ? { chars } : { ok: false, error: 'not_found' };
    },
    confirm: (ctx, v) => (v.all ? {
      message: `Forget what ${companionName(ctx)} remembers about all your characters?`,
      detail: 'The notes on this computer are deleted. Chat history stays. This can’t be undone.',
      okLabel: 'Forget all',
      destructive: true,
    } : {
      message: `Forget what ${companionName(ctx)} remembers about ${v.char}?`,
      detail: 'The notes about this character on this computer are deleted. This can’t be undone.',
      okLabel: 'Forget',
      destructive: true,
    }),
    run: async (ctx, v, prep) => {
      if (!v.all) return ctx.api.forgetMemory(v.char);
      for (const c of prep.chars) {
        const r = await ctx.api.forgetMemory(c);
        if (!isPlainObject(r) || r.ok === false) return { ...(isPlainObject(r) ? r : {}), ok: false, error: (isPlainObject(r) && r.error) || 'failed' };
      }
      return { ok: true, forgot: prep.chars.length };
    },
  },
  transcripts: {
    input: obj({ deleteAll: BOOL }),
    confirm: (ctx, v) => (v.deleteAll ? {
      message: 'Delete all chat history?',
      detail: 'Every chat’s history that NeverQuestAlone keeps on this computer is deleted. The chat window in the game keeps its own copy of what it showed: /nqa delete removes a chat there. This can’t be undone.',
      okLabel: 'Delete all',
      destructive: true,
    } : null),
    run: (ctx, v) => ctx.api.transcripts({ deleteAll: v.deleteAll }),
  },
  // How long chat history is kept (§13.1 "Retention: a setting"; final review L5-5).
  // A native confirm only when the number goes down, saying what that deletes now (D-24); keeping
  // conversations as long or longer needs none.
  setRetention: {
    input: obj({ days: { type: 'integer', minimum: 1, maximum: 365 } }),
    prepare: async (ctx, v) => {
      let pre = null;
      try { pre = await ctx.api.retentionPreview?.(v.days); } catch {}
      if (!isPlainObject(pre) || pre.ok === false) {
        let tr = null;
        try { tr = await ctx.api.transcripts({ deleteAll: false }); } catch {}
        pre = { retentionDays: Number.isInteger(tr?.retentionDays) ? tr.retentionDays : null, chats: null, trimmed: null };
      }
      return { current: Number.isInteger(pre.retentionDays) ? pre.retentionDays : null, chats: pre.chats, trimmed: pre.trimmed };
    },
    confirm: (ctx, v, prep) => {
      if (prep.current != null && v.days >= prep.current) return null;
      const plural = new Intl.PluralRules('en-US');
      const d = n => (plural.select(n) === 'one' ? `${n} day` : `${n} days`);
      const chats = n => (plural.select(n) === 'one' ? `${n} chat` : `${n} chats`);
      let now = `Chat history older than ${d(v.days)} is deleted now.`;
      if (Number.isInteger(prep.chats)) {
        if (prep.chats && prep.trimmed) now = `This deletes ${chats(prep.chats)} older than ${d(v.days)} now, and the older messages of ${chats(prep.trimmed)} more.`;
        else if (prep.chats) now = `This deletes ${chats(prep.chats)} older than ${d(v.days)} now.`;
        else if (prep.trimmed) now = `This deletes the older messages of ${chats(prep.trimmed)} now.`;
        else now = 'Nothing is deleted now.';
      }
      return {
        message: prep.current != null ? `Keep chat history for ${d(v.days)} instead of ${d(prep.current)}?` : `Keep chat history for ${d(v.days)}?`,
        detail: `${now} From then on, chat history is deleted as it reaches ${d(v.days)}. The chat window in the game keeps its own copy. This can’t be undone.`,
        okLabel: `Keep for ${d(v.days)}`,
        destructive: !(prep.chats === 0 && prep.trimmed === 0),
      };
    },
    run: (ctx, v) => ctx.api.setRetention(v.days),
  },
  // OpenAI's safety_identifier (§13.1 "Regenerate in Settings"; final review L5-6): a new random one.
  regenerateSafetyId: { input: NONE, run: ctx => ctx.api.regenerateSafetyId() },

  // The game (§16.1 step 2, PF-5).
  findWow: { input: NONE, run: ctx => ctx.api.findWow() },
  /** "Choose folder…" (D-09): main's native folder dialog; the bridge checks the folder holds WoW: Forever. */
  chooseWowFolder: {
    input: NONE,
    run: async ctx => {
      const dir = await ctx.pickFolder?.();
      if (typeof dir !== 'string' || !dir) return { ok: false, error: 'cancelled' };
      return ctx.api.useWowFolder(dir);
    },
  },
  // One of the installs findWow listed (the bridge refuses any other folder). tighten (TH12; final
  // review L3-5): after an install whose permissions check said `fixable`, remove the other
  // accounts' write access this account can remove, behind a native confirm.
  installAddon: {
    input: obj({ flavorDir: { type: 'string', minLength: 1, maxLength: 1024 }, tighten: BOOL, whenClosed: BOOL }, [], { optional: true }),
    confirm: (ctx, v) => (v?.tighten === true ? {
      message: 'Fix the addon folder’s permissions?',
      detail: 'NeverQuestAlone takes away the write access other accounts on this computer have to World of Warcraft’s AddOns folder and the addon’s folders, where your account owns them. Folders another account or an administrator owns stay as they are.',
      okLabel: 'Fix permissions',
    } : null),
    run: async (ctx, v) => {
      const o = {};
      if (v?.flavorDir) o.flavorDir = v.flavorDir;
      if (v?.tighten === true) o.tighten = true;
      if (o.tighten) return ctx.api.installAddon(o);
      // Setup's Install and Install when WoW closes (PF-5): the player's click is the consent, kept
      // for this folder (an update arms itself later only for it; onboarding spec §3.11).
      const r = v?.whenClosed === true ? await ctx.api.armInstall(o) : await ctx.api.setupInstall(o);
      if (r?.ok !== false || r?.error === 'install_failed') {
        const at = (ctx.now ?? Date.now)();
        const where = typeof r?.path === 'string' ? r.path : o.flavorDir ?? null;
        try { ctx.appState.set({ addonConsent: { path: where, at } }); } catch { /* the install stands */ }
      }
      return r;
    },
  },
  /** Cancel an install armed for when WoW closes. */
  cancelInstall: { input: NONE, run: ctx => ctx.api.cancelInstall() },
  /** Allow (Screen Recording, macOS): the helper asks macOS; the row follows the grant. */
  requestScreenRecording: { input: NONE, run: ctx => ctx.api.requestScreenPermission() },
  /** Open Battle.net (and on Windows, tuck this window into the tray, T7). */
  openGame: { input: NONE, run: async ctx => (typeof ctx.openGame === 'function' ? ctx.openGame() : unsupported) },
  /** Move to Applications (macOS, only while it runs from elsewhere). */
  moveToApplications: { input: NONE, run: async ctx => (typeof ctx.moveToApplications === 'function' ? ctx.moveToApplications() : unsupported) },
  /**
   * Continue on Check your defaults (PR-4, ER-5): the login item, desktop notifications and "seen"
   * in one call, so the page can't half-apply it. With notifications on, a Mac posts one silent
   * notification the first time, so macOS asks now rather than at the first real one.
   */
  finishDefaults: {
    input: obj({ loginItem: BOOL, notifications: BOOL }),
    run: async (ctx, v) => {
      let login = null;
      try {
        const now = ctx.loginItem.get?.();
        if (!now || now.supported) login = await ctx.loginItem.set(v.loginItem);
      } catch { login = { ok: false, error: 'failed' }; }
      const before = ctx.appState.get();
      let state = ctx.appState.set({ notifications: v.notifications });
      if (v.notifications && ctx.platform === 'darwin' && !before.alertsAsked) {
        try {
          const vars = { name: companionName(ctx) };
          ctx.notify?.({ title: st('notifications.alertsOn.title', vars, ctx.platform), body: st('notifications.alertsOn.body', vars, ctx.platform) });
        } catch { /* macOS asks at the first real one */ }
        state = ctx.appState.set({ alertsAsked: true });
      }
      state = ctx.appState.set({ defaultsSeen: true });
      return { ok: true, state, loginItem: login };
    },
  },
  /** The AddOns folder's permissions, checked now (Diagnostics' card; D-23). */
  addonPermissions: { input: NONE, run: ctx => ctx.api.addonPermissions() },
  /**
   * "Fix permissions" (setup and Diagnostics; D-29): only the permissions, no reinstall, so WoW may be
   * running; main asks first (TH12).
   */
  tightenAddonPermissions: {
    input: NONE,
    confirm: () => ({
      message: 'Fix the addon folder’s permissions?',
      detail: 'NeverQuestAlone takes away the write access other accounts on this computer have to World of Warcraft’s AddOns folder and the addon’s folders, where your account owns them. Nothing else changes, and WoW can stay open.',
      okLabel: 'Fix permissions',
    }),
    run: ctx => ctx.api.tightenAddonPermissions(),
  },
  /**
   * "Copy the command" for an administrator (D-23): the bridge builds it from its own check of the
   * folder (app-api adminCommand), never from the window's text.
   */
  copyPermissionsCommand: {
    input: NONE,
    run: async ctx => {
      const r = await ctx.api.addonPermissions();
      const command = r?.permissions?.command;
      if (typeof command !== 'string' || !command || command.length > 4000) return { ok: false, error: 'nothing_to_fix' };
      ctx.clipboard.writeText(command);
      // The bridge's sentence for this exact command (D-37): the window shows it as given.
      const explanation = typeof r.permissions.explanation === 'string' ? r.permissions.explanation : '';
      return { ok: true, command, explanation };
    },
  },

  // Support (SL-7).
  copyDiagnostics: {
    input: NONE,
    run: async ctx => {
      const text = await diagnosticsText(ctx);
      ctx.clipboard.writeText(text);
      return { ok: true, bytes: Buffer.byteLength(text), lines: text.split('\n').length, text };
    },
  },
  copyCommand: {
    input: obj({ id: { type: 'string', enum: Object.keys(COMMANDS) } }),
    run: (ctx, v) => { ctx.clipboard.writeText(COMMANDS[v.id]); return { ok: true, text: COMMANDS[v.id] }; },
  },
  openLink: {
    input: obj({ id: { type: 'string', enum: LINK_IDS }, hash: { type: 'string', pattern: PATTERNS.hash } }, ['id']),
    run: (ctx, v) => {
      let url = LINKS[v.id] ?? null;
      if (Object.hasOwn(TEMPLATE_LINKS, v.id)) url = v.hash ? TEMPLATE_LINKS[v.id].replace('{hash}', v.hash) : null;
      if (v.id === 'releases') url = ctx.releasesUrl?.() ?? null;
      if (!url) return { ok: false, error: 'no_link' };
      return ctx.links.open(url);
    },
  },

  // "Quit and reopen" (D-05): while the bridge failed to start, and (fix-102) while it says it needs
  // a restart: a bridge that stopped with the window open, or a result that asked for one (the
  // app's own guard refused the AI's host: setup's restart, a §10 line whose fix is Quit and reopen).
  relaunch: {
    input: NONE,
    prepare: async (ctx, v, seen) => {
      if (ctx.info?.().apiMode === 'error' || seen?.restartAsked) return {};
      let st = null;
      try { st = await ctx.api.status(); } catch { st = null; }
      return saysRestart(st) ? {} : { ok: false, error: 'not_needed' };
    },
    run: ctx => ctx.relaunch?.() ?? { ok: false, error: 'unsupported' },
  },

  // Quit this copy (words-29): only while the engine couldn't start, as when another copy already
  // runs; reopening would hit the same wall, so this just quits.
  quitApp: {
    input: NONE,
    prepare: ctx => (ctx.info?.().apiMode === 'error' ? {} : { ok: false, error: 'not_needed' }),
    run: ctx => ctx.quitApp?.() ?? { ok: false, error: 'unsupported' },
  },

  // Resume sending (systems plan D4): the typed guard paused sending after messages at machine
  // speed; only the player's press in the window ends it. Nothing to resume: not_paused.
  resumeSending: { input: NONE, run: ctx => ctx.api.resumeSending() },

  // The tray's pause, also in the window (§16.3 "Pause everything").
  setPaused: {
    input: obj({ paused: BOOL }),
    run: async (ctx, v) => {
      const out = await ctx.api.setPaused(v.paused);
      if (out?.ok !== false) ctx.onPaused?.(v.paused);
      return out;
    },
  },

  // Updates (§11.5, DB12, PF-4).
  updates: { input: NONE, run: ctx => ctx.updater.status() },
  setUpdateMode: { input: obj({ mode: { type: 'string', enum: ['notify', 'never'] } }), run: (ctx, v) => ctx.updater.setMode(v.mode) },
  // Automatic updates (Settings): on by default; off is the old notify-and-click.
  setUpdateAuto: { input: obj({ on: BOOL }), run: (ctx, v) => ctx.updater.setAuto(v.on) },
  checkForUpdates: { input: NONE, run: ctx => ctx.updater.check() },
  downloadUpdate: { input: NONE, run: ctx => ctx.updater.download() },
  installUpdateNow: {
    input: NONE,
    prepare: async ctx => {
      const s = ctx.updater.status();
      if (s.state !== 'ready') return { ok: false, error: 'no_update_ready' };
      let running = false;
      try { running = !!(await ctx.api.wowRunning())?.running; } catch {}
      if (running) return { ok: false, error: 'wow_running' };
      return { version: s.available?.version };
    },
    confirm: (ctx, v, prep) => ({
      message: prep.version ? `Restart NeverQuestAlone to update to ${prep.version}?` : 'Restart NeverQuestAlone to update?',
      detail: 'NeverQuestAlone quits, installs the update and starts again. Anything waiting in game is sent once it’s back.',
      okLabel: 'Restart to update',
    }),
    run: ctx => ctx.updater.installNow(),
  },

  // Uninstall (OB-3, §16.3).
  uninstall: {
    input: obj({ removeAddon: BOOL }),
    confirm: (ctx, v) => ({
      message: 'Uninstall NeverQuestAlone?',
      detail: [
        'This removes:',
        // The game's copy of the chats goes with the addon (code health AP-11; app-api uninstall).
        v.removeAddon ? '• the NeverQuestAlone addon, its folders and chats in WoW' : null,
        '• the app’s data (chat history, memory, usage, settings)',
        `• your saved keys in ${storeName(ctx.platform)}`,
        '• the login item',
        ctx.platform === 'darwin' ? '• the Screen Recording permission' : null,
        `Then NeverQuestAlone quits. ${finishLine(ctx.platform)}`,
      ].filter(Boolean).join('\n'),
      okLabel: 'Uninstall',
      destructive: true,
    }),
    run: async (ctx, v) => {
      const out = await ctx.api.uninstall({ removeAddon: v.removeAddon });
      if (out?.ok === false) return out;
      return ctx.uninstallShell?.(out) ?? out;
    },
  },
};

/** The calls a renderer may make, which the preload mirrors. */
export const CALLS = Object.freeze(Object.keys(HANDLERS));
/** Calls that always (or, for transcripts, when deleting) show a native confirm. */
export const CONFIRMED = Object.freeze(Object.keys(HANDLERS).filter(k => HANDLERS[k].confirm));

async function listProviders(ctx) {
  try {
    const list = await ctx.api.providers();
    return Array.isArray(list) ? list.filter(isPlainObject) : [];
  } catch { return []; }
}
function providerOf(status) {
  const b = status?.backend;
  return b?.provider ?? b?.rt?.provider ?? null;
}

/** The diagnostics bundle: the bridge's redacted bundle plus the shell's own lines, redacted again. */
export async function diagnosticsText(ctx) {
  let bridge = '';
  try {
    const d = await ctx.api.diagnostics();
    bridge = typeof d === 'string' ? d : typeof d?.text === 'string' ? d.text : JSON.stringify(d ?? {}, null, 2);
  } catch { bridge = '(the bridge did not return diagnostics)'; }
  const info = ctx.info();
  const shell = ctx.ledger.snapshot();
  const upd = ctx.updater.status();
  const lines = [
    '== NeverQuestAlone (desktop shell) ==',
    `version ${info.version} · Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`,
    `${info.platform} ${info.arch} · ${info.packaged ? 'packaged' : 'unpackaged'} · bridge: ${info.apiMode}`,
    `shell connections: ${shell.allowed.map(r => `${r.host}:${r.port} ×${r.count} (${r.feature})`).join(', ') || 'none'}`,
    `shell requests refused: ${shell.blocked.map(r => `${r.scheme}://${r.host ?? ''} ×${r.count}`).join(', ') || 'none'}`,
    `updates: ${upd.mode} · ${upd.state}${upd.lastCheck ? ` · last check ${new Date(upd.lastCheck).toISOString()}` : ''}`,
    '',
    '== Shell log (last 50 lines) ==',
    ...(ctx.shellLog?.() ?? []),
    '',
    '== Bridge ==',
    bridge,
  ];
  return redactText(lines.join('\n'), { extra: ctx.keys.secrets() });
}

/**
 * Build the dispatcher. ctx = { api, confirm(spec) → Promise<boolean>, keys,
 * links: {open(url)}, clipboard: {writeText}, ledger, updater, appState,
 * loginItem, info(), notices(), platform, companion(), releasesUrl(),
 * onPaused(bool), onNoticeSeen(), uninstallShell(result), pickFolder() →
 * Promise<path|null>, relaunch(), log(line) }.
 */
export function createIpc(ctx) {
  let confirming = false;
  // A result this window got asked for a restart (saysRestart): its Quit and reopen may run.
  let restartAsked = false;
  const finish = value => redactDeep(value, { extra: ctx.keys.secrets() });

  async function call(name, payload) {
    if (!Object.hasOwn(HANDLERS, name)) return { ok: false, error: 'unknown_call' };
    const h = HANDLERS[name];
    if (inputSize(payload) > MAX_INPUT_BYTES) return { ok: false, error: 'bad_input', detail: 'input: too large' };
    const v = check(h.input, payload);
    if (!v.ok) return { ok: false, error: 'bad_input', detail: v.error };
    try {
      let prep = {};
      if (h.prepare) {
        prep = (await h.prepare(ctx, v.value, { restartAsked })) ?? {};
        if (prep.ok === false) return finish(prep);
      }
      const spec = h.confirm ? h.confirm(ctx, v.value, prep) : null;
      if (spec) {
        // One native dialog at a time: a page can't queue up a stack of them.
        if (confirming) return { ok: false, error: 'busy' };
        confirming = true;
        let yes = false;
        try { yes = await ctx.confirm(spec); } finally { confirming = false; }
        if (!yes) return { ok: false, error: 'cancelled' };
      }
      // The player agreed (or there was nothing to agree to): a key's test or the sign-in starts
      // now, and only now may the page say "Checking with {co}…" (onboarding spec §3.4.2 step 7;
      // desktop UI critic r2, DU-03). The call's name and its AI's id; nothing of the key.
      if (h.announce) { try { ctx.onAgreed?.(name, typeof prep?.provider === 'string' ? prep.provider : v.value?.provider ?? null); } catch { /* the page just won't hear it */ } }
      const out = await h.run(ctx, v.value, prep);
      if (saysRestart(out)) restartAsked = true;
      return finish(out);
    } catch (e) {
      ctx.log?.(`ipc ${name} failed: ${redactText(e?.message ?? e, { extra: ctx.keys.secrets() })}`);
      return { ok: false, error: 'failed' };
    }
  }
  return { call, calls: CALLS };
}

/**
 * A result that asks for a restart (fix-102): setup's restart, a §10 line whose fix is Quit and
 * reopen, or a status that says the bridge stopped (or whose last failure's fix is a restart).
 */
export function saysRestart(r) {
  if (!r || typeof r !== 'object') return false;
  const b = r.backend && typeof r.backend === 'object' ? r.backend : null;
  return r.error === 'restart' || r.action === 'restart' || b?.rt?.reason === 'app_stopped' || b?.lastError?.action === 'restart';
}

/** Bind every call to ipcMain.handle; a call from anything but the app's own page is refused. */
export function registerIpc(ipcMain, ipc, { isTrustedSender }) {
  for (const name of ipc.calls) {
    ipcMain.handle(CHANNEL_PREFIX + name, async (event, payload) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'forbidden' };
      return ipc.call(name, payload);
    });
  }
}

export const _internal = { unsupported, UNSAFE_TEXT, MAX_INPUT_BYTES };
