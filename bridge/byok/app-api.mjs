// The app API (public BYOK PRD §8, §9, §11.2, §13, §15 SL-7, §16; BUILD-PLAN "Contract: the app
// API the desktop shell calls"): what the desktop app's settings window and the tray call, and
// nothing else (no control pipe, no command line: systems plan D6). The Electron main process owns
// it and exposes each call over schema-checked IPC (app/desktop/ipc.mjs); the shapes match
// app/desktop/src/mock-api.mjs, which the window was written against.
//
//   createAppApi({ bridge, backend, keystore, config, paths, log, openExternal, egress, capture,
//                  saveConfig, manifests, priceBook, fetch, platform, wow, restart, halt }) → api
//   (restart: boot's, after installAddon; halt: boot's stop of the core, before uninstall removes data)
//
// Every call is async and returns plain JSON, never a key: status · providers · setKey · testKey ·
// testStagedKey · deleteKey · connectCustom · choose · caps · setCaps · privacy · setPrivacy ·
// usage · connections · lastRequest · memory · forgetMemory · transcripts · retentionPreview · findWow ·
// useWowFolder · installAddon · wowRunning · addonPermissions · tightenAddonPermissions · diagnostics · setPaused · uninstall ·
// onChange · stop. A failed key test says what went wrong the way the desktop window shows it
// (desktopLine: the §10 headline, a second line that names the fix in the window, the action id).
// Input is checked once, at the one boundary that takes untrusted input: the IPC layer's schemas
// (app/desktop/ipc.mjs; systems plan SY-15). Here only what needs live data is checked (a provider
// the manifests list, a model it offers, a key's shape against its provider, a folder that holds
// WoW) and a name that becomes a path is checked where it's used; either answers { ok: false,
// error: 'bad_input' | … }. A config change is saved through
// saveConfig (config.mjs: atomic, 0600) and takes effect through backend.setConfig; the backend's
// newer calls (lastRequest, usageHistory, memory, forgetMemory) are used when it has them.
// bridge may be null (no WoW folder yet): the backend then runs alone, and installAddon starts
// the bridge through restart().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRIDGE_VERSION } from '../service.mjs';
import { countSlots, SLOT_COUNT } from '../transport/slots.mjs';
import { loadManifests, createProvider, pickProviderForKey, userLine, durWords, manifestFor, checkCustomUrl, customManifest, needsRestart, retiringOf, effortLevels, nearestEffort, startThinkRoom, THINK_ROOM, START_EFFORT, EFFORT_LEVELS, CUSTOM_ID, CUSTOM_MODEL_RE, isSignIn } from './providers/index.mjs';
import { isAuthorizeUrl } from './signin/chatgpt.mjs';
import { maskKey } from './security/keystore.mjs';
import { redact } from './security/redact.mjs';
import { CONNECTIONS_NOTE } from './security/egress.mjs';
import { costMicros, TYPICAL_TURN, typicalCost } from './usage/meter.mjs';
import { createPriceBook } from './usage/prices.mjs';
import { digest as memoryDigest, forgetMemory as forgetMemoryDir } from './runtime/memory.mjs';
import { MEMORY_DIR } from './runtime/logbook.mjs';
import { findWow, wowRunningAsync, installAddon, checkAddonsPermissions, isAddonFolder, windowsTool, ADDON_NAME, RUNNING_LINE, UNINSTALL_RECORD } from './wow.mjs';
import { AUTO_FUSE } from './usage/fuse.mjs';
import { statusView } from './status-view.mjs';
import { setupKind } from './providers/setup-errors.mjs';
import { displayOf } from './providers/display.mjs';
import { setupView } from './setup-view.mjs';
import { createScreenPermission, ASKED_MS } from './screen-permission.mjs';
import { REPO, LEGACY_CUSTOM } from '../config.mjs';

export const PRODUCT = 'NeverQuestAlone';
export const RETENTION_DAYS = 30;
export const PUSH_DEBOUNCE_MS = 150;
export const WOW_CHECK_MS = 5000;
/** The watchdog's states about the game's window: while WoW is closed, the window says waiting instead. */
export const WINDOW_STATES = new Set(['no_signal', 'blocked']);
/** How often an install armed for when WoW closes looks, and how often Screen Recording is checked while it's off. */
export const ARM_POLL_MS = 2000;
export const PERMISSION_LOOP_MS = 10_000;
// Code health BR-05: a denied Screen Recording was checked every 10 s for as long as the app ran (WoW
// closed included), each check a new helper launched (open -n -W) after a signature check on the
// main thread: about 8,640 launches a day. The checks now back off (10 s, then 60 s, then every
// 5 min; a window focus, an Allow or the loop starting again starts over at 10 s), and run only
// while WoW runs or the window was in front lately (main.mjs asks for a fresh check when it gets
// focus; the API hears nothing else of the window).
export const PERMISSION_BACKOFF_MS = Object.freeze([PERMISSION_LOOP_MS, 60_000, 300_000]);
export const WINDOW_RECENT_MS = 600_000;
// §7.3's typed turn (usage/meter.mjs TYPICAL_TURN): the prompt pack as its cacheable prefix plus 2,000 more, and
// 350 out; 40 a day; priced with its model's thinking at its start level (typicalCost).
export { TYPICAL_TURN };
/**
 * What the bridge keeps in the app's data folder, which uninstall removes (§16.3, OB-3): chat
 * transcripts, character memory, the turn ledger, the caps and usage history, the backend's chat
 * table, the settings, the core's store ('bridge', the default state), and on Windows the WoW
 * folders the addon went into, for the NSIS uninstaller (uninstall.ini; audit CV-07).
 */
export const APP_DATA = Object.freeze(['transcripts', MEMORY_DIR, 'ledger.json', 'caps.json', 'usage-history.json', 'byok-chats.json', 'config.json', 'bridge', UNINSTALL_RECORD]);

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = detail => ({ ok: false, error: 'bad_input', ...(detail ? { detail } : {}) });
// A character's memory folder name ("Thokk-Testrealm"): letters, digits, spaces, ' and -; never a path.
const CHARACTER = /^[\p{L}\p{M}0-9](?:[\p{L}\p{M}0-9' -]{0,62}[\p{L}\p{M}0-9])?$/u;
const isCharName = c => typeof c === 'string' && CHARACTER.test(c);
const PRIVACY_KEYS = ['identity', 'otherNames', 'companion', 'echo', 'gameContext', 'screenReading'];
// On unless the player turned them off (a value the app never wrote reads as on).
const PRIVACY_ON_BY_DEFAULT = new Set(['screenReading']);
// A key as maskKey shows it, with the provider layer's label: a prefix, "…", at most four characters.
const MASKED = /^(?:Bearer )?[A-Za-z0-9.-]{0,12}…[A-Za-z0-9]{0,4} \(redacted\)$|^\[redacted\]$/;
const exists = p => { try { fs.statSync(p); return true; } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// The broad Windows groups the permissions check reports (wow.mjs BROAD_GRANT), by well-known SID.
const BROAD_SIDS = [[/^Everyone$/i, '*S-1-1-0'], [/^(?:BUILTIN\\)?Users$/i, '*S-1-5-32-545'], [/^(?:NT AUTHORITY\\)?Authenticated Users$/i, '*S-1-5-11'], [/^(?:NT AUTHORITY\\)?INTERACTIVE$/i, '*S-1-5-4']];
/** What the Windows command does, and what to ask for when there's no command (D-37). Plain words, the Mac line's shape (UX-W42). */
export const ADMIN_EXPLAIN = Object.freeze({
  win32: 'Stops other accounts from changing the AddOns folder; yours still can.',
  posix: 'Stops other accounts from changing these folders; nothing else changes.',
  noSid: 'Ask an administrator to remove write access for Users from this folder.',
});
/** A Windows account SID as whoami prints it: S-1-5-21-…-RID and friends. */
const SID_RE = /^S-1-\d{1,2}(?:-\d{1,10}){1,14}$/;

/**
 * This account's SID on Windows (D-37): `whoami /user /fo csv /nh` by its full System32 path (as
 * windowsTool does), whose last field is the SID, whatever the account's name ("José", "山田", none).
 * null when whoami fails or prints no SID.
 */
export function accountSid({ run = spawnSync, env = process.env } = {}) {
  let r;
  try { r = run(windowsTool('whoami', env), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); } catch { return null; }
  if (!r || r.status !== 0) return null;
  const fields = [...String(r.stdout ?? '').matchAll(/"([^"]*)"/g)].map(m => m[1].trim());
  const sid = fields.reverse().find(f => SID_RE.test(f));
  return sid ?? null;
}

/**
 * The fix for loose AddOns permissions an administrator can run (TH12; desktop UI critic D-23,
 * D-37), built from the check's own paths, never from the window, with the sentence that says what
 * that exact command does. → {command, explanation}; command null when there's nothing to run.
 * POSIX: `sudo chmod go-w` on each loose folder (links are left out: those are for the player to
 * look at). Windows: icacls on the AddOns folder, keeping inherited grants as its own, replacing the
 * broad groups' write grants with read and run, and granting this account modify by its SID (so the
 * app can still install and update the addon whatever the account's name). Without a SID there's
 * no command (it could lock the player out), only what to ask an administrator for.
 */
export function adminCommand(perm, { platform = process.platform, addonsDir = null, sid = null } = {}) {
  const none = { command: null, explanation: null };
  if (!isObj(perm) || perm.ok !== false) return none;
  if (platform === 'win32') {
    if (typeof addonsDir !== 'string' || !addonsDir || /["%^&|<>!\r\n]/.test(addonsDir)) return none;
    const groups = (Array.isArray(perm.grants) ? perm.grants : []).map(g => String(g).split(':')[0].trim());
    const sids = [...new Set(groups.map(g => BROAD_SIDS.find(([re]) => re.test(g))?.[1]).filter(Boolean))];
    if (!sids.length) return none;
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return { command: null, explanation: ADMIN_EXPLAIN.noSid };
    return {
      command: `icacls "${addonsDir}" /inheritance:d /grant:r ${sids.map(s => `${s}:(OI)(CI)RX`).join(' ')} *${sid}:(OI)(CI)M`,
      explanation: ADMIN_EXPLAIN.win32,
    };
  }
  const links = new Set(Array.isArray(perm.links) ? perm.links : []);
  const paths = (Array.isArray(perm.paths) ? perm.paths : []).filter(x => typeof x === 'string' && x && !links.has(x) && !/[\u0000-\u001f]/.test(x));
  if (!paths.length) return none;
  const q = x => `'${x.replace(/'/g, `'\\''`)}'`;
  return { command: `sudo chmod go-w ${paths.map(q).join(' ')}`, explanation: ADMIN_EXPLAIN.posix };
}

/** §10 kinds an rt state already says (the window's state card for rt covers them). */
const RT_KINDS = new Set(['auth_invalid', 'oauth_expired', 'no_key', 'rate_limited', 'rate_limited_daily', 'out_of_credit', 'overloaded', 'timeout', 'local_unreachable', 'cap_spend']);
/**
 * The backend's last failure as the window shows it (desktop UI critic D-01): a kind no rt state
 * covers whose in-game line sends the player to the app ("See the details in the NeverQuestAlone
 * app.", "Pick another AI in the NeverQuestAlone app.", …): region_blocked, identifier_blocked, spend_limit,
 * egress_blocked, bad_request, unknown; and empty_reply, whose fix is also Thinking or the model here
 * (WINDOW_FIX). → {kind, at, headline, detail, action, notice?, retest?}
 * (desktopLine), or null. notice: a one-off bad_request/unknown (D-33); retest: fixed at the
 * provider, so the window offers a key test (D-32). The backend clears it on the next reply that
 * goes through, a provider change, or a passing key test for the provider in use. Model
 * errors are the start-time check's notice, and in-game fixes (a new chat, send again) stay in game.
 */
export function lastErrorView(err, names = {}) {
  if (!isObj(err) || typeof err.kind !== 'string' || RT_KINDS.has(err.kind) || err.kind === 'model_not_found') return null;
  const u = userLine(err, { ...names, product: names.product ?? PRODUCT, final: true });
  if (!u.action?.desktop && !ON_THIS_COMPUTER.has(err.kind) && !WINDOW_FIX.has(err.kind)) return null;
  const d = desktopLine(err, names);
  // One bad_request or unknown is an event, not a state: a notice with Okay, no tray attention, no OS
  // notification. Two in a row (no reply between) is a state again (D-33).
  const oneOff = ONE_OFF_KINDS.has(err.kind) && !((Number(err.streak) || 1) >= 2);
  return {
    // A write on this computer: the fix is the player's own (space, permissions) and Retry is the game's, so no button here.
    kind: err.kind, at: Number.isFinite(err.at) ? err.at : null, headline: d.headline, detail: d.detail, action: ON_THIS_COMPUTER.has(err.kind) ? null : d.action,
    // A block of the app's own making (fix-102) is fixed by a restart, not at the AI company: no key test.
    ...(oneOff ? { notice: true } : {}), ...(FIXED_AT_PROVIDER.has(err.kind) && !needsRestart(err) ? { retest: true } : {}),
  };
}
/** Kinds fixed on this computer, not in the game: the window says them too, though the game's Retry sends (SY-18). */
const ON_THIS_COMPUTER = new Set(['local_write', 'tls']);
/** Kinds that are one-offs until they repeat (D-33). */
const ONE_OFF_KINDS = new Set(['bad_request', 'unknown']);
/** Kinds the player fixes at the provider: the card offers a key test, whose pass clears it (D-32). */
const FIXED_AT_PROVIDER = new Set(['spend_limit', 'region_blocked', 'egress_blocked']);
/**
 * Kinds the game offers Retry for whose other fix is a setting in this window, and the window's
 * action for it (fix-empty-reply): an empty reply, twice, goes to the model and its Thinking.
 */
const WINDOW_FIX = new Map([['empty_reply', 'pick_model']]);

/**
 * What the window shows of a provider's manifest (desktop UI critic D-22): its privacy card and
 * notes in the player's words (privacy.player, terms.playerNotes), never the developer fields
 * beside them (privacy.retention/zdr/sets/notes, terms.login/notes), which name request fields,
 * headers and API paths. → {privacyCard: {keeps, trains, zeroRetention, sets, short, link, class}, notes}.
 */
export { displayOf };

export function playerCard(m) {
  const pl = isObj(m?.privacy?.player) ? m.privacy.player : {};
  const str = v => (typeof v === 'string' ? v : '');
  return {
    privacyCard: {
      keeps: str(pl.keeps), trains: str(pl.trains), zeroRetention: str(pl.zeroRetention), sets: str(pl.sets), short: str(pl.short),
      link: `${m?.id}.privacy`, class: m?.privacy?.class ?? (m?.local ? 'local' : 'cloud'),
    },
    notes: (Array.isArray(m?.terms?.playerNotes) ? m.terms.playerNotes : []).filter(n => typeof n === 'string' && n).slice(0, 4),
    display: displayOf(m),
  };
}


/** A model notice with its models' names from the manifest (only where a name isn't the id itself). */
function namedNotice(n, m) {
  const label = id => { const l = (m?.models?.list ?? []).find(e => e.id === id)?.label; return typeof l === 'string' && l && l !== id ? l : null; };
  const out = { ...n };
  if (n.kind === 'model_switched') {
    const from = label(n.from);
    const to = label(n.to);
    if (from) out.fromName = from;
    if (to) out.toName = to;
  } else if (n.kind === 'model_retired') {
    const name = label(n.model ?? n.from);
    if (name) out.name = name;
  } else if (n.kind === 'model_retiring') {
    const name = label(n.model);
    const to = label(n.to);
    if (name) out.name = name;
    if (to) out.toName = to;
  }
  return out;
}

/** "a" or "an" before a provider's name: an Anthropic, an OpenAI, an OpenRouter, an xAI, a Google. */
const article = name => (/^(?:[aeiou]|x[A-Z])/i.test(String(name ?? '')) ? 'an' : 'a');

/**
 * A §10 line as the desktop window shows it (D-01): the in-game headline and its action id
 * (providers/errors.mjs userLine, final: no retries left), with a second line that names the fix
 * in the window ("Replace your key…") instead of the in-game "…in the NeverQuestAlone app". The in-game
 * lines are unchanged. names: provider, model, fallbackModel, companion, product, platform, now,
 * capMicros (the player's own daily cap), thinking (false: the model has no thinking levels).
 * → {headline, detail, action (the userLine action id, WINDOW_FIX's where the window has its own, or null), line}.
 */
export function desktopLine(err, names = {}) {
  const l = userLine(err, { ...names, product: names.product ?? PRODUCT, final: true });
  const P = names.provider || err?.provider || 'your AI company';
  const M = names.model || 'this model';
  // Where a window card already names the state, the key test says it in the card's words, and the
  // next step names the window's own button: Test key, Raise limit, Check again (bones-ux-writer
  // onboarding r3, UX-W31; renderer/strings.js homeCard.*, usage.limits.reached).
  const headlineFor = { network_before_send: `Can't reach ${P}.` };
  const detail = (() => {
    switch (err?.kind) {
      case 'no_key':
        if (err.code !== 'keystore_error') return `Add your ${P} key.`;
        return names.platform === 'win32' ? 'Click Test key, or restart Windows if it keeps happening.' : names.platform === 'darwin' ? 'Unlock your login keychain, then click Test key.' : 'Unlock your keyring, then click Test key.';
      // The app's own guard refusing the AI's own host: a restart, never the player's internet (fix-102).
      case 'egress_blocked': return needsRestart(err) ? 'Click Quit and reopen.' : 'Check Connections.';
      case 'auth_invalid': return `Replace your key, or make a new one at ${P}.`;
      case 'out_of_credit': return `Add credit at ${P}, then click Test key.`;
      case 'cap_spend': return 'Click Raise limit, or it resets at midnight.'; // only ever the player's own cap
      case 'model_not_found': return names.fallbackModel ? `Switched to ${names.fallbackModel} for now. You can pick another model.` : 'Pick another model.';
      case 'context_too_long': return err.reason === 'num_ctx' ? `Raise the context length for ${M} in ${P}, or pick another model.` : l.detail;
      case 'network_before_send': case 'network_after_send': return 'Check your internet, then click Test key.';
      case 'local_unreachable': return `Start ${P}, then click Check again.`;
      case 'oauth_expired': return 'Sign in again.';
      case 'region_blocked': return 'Pick another AI.';
      case 'identifier_blocked': return `${P} blocks an install after a serious policy violation. Pick another AI, or copy diagnostics if you think it’s a mistake.`;
      // A wait, then the window's own button (bones-ux-writer onboarding r4, UX-W31), as setup says it.
      case 'timeout': case 'overloaded': return 'Wait a minute, then click Test key.';
      case 'rate_limited': {
        const wait = durWords(names.retryInMs ?? err.retryAfterMs);
        return wait ? `Wait ${wait}, then click Test key.` : 'Wait a minute, then click Test key.';
      }
      // This computer, not the AI (SY-12, SY-18): the fix is here, and the message goes from the game,
      // in the table's words: "click" for anything on screen, "Retry in game" (bones-ux-writer r2, UX-W22).
      case 'tls': return ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'].includes(err.code) ? 'Check your computer’s date and time, then click Retry in game.' : 'Turn off HTTPS scanning in your antivirus, then click Retry in game.';
      case 'local_write': return err.code === 'ENOSPC' ? 'Free up space, then click Retry in game.' : 'Click Retry in game, or restart your computer.'; // Home's card's line (bones-ux-writer UX-W07): 8 words
      // No text, twice (fix-empty-reply): Thinking on Your AI, or another model where it has no levels.
      case 'empty_reply': return names.thinking === false ? 'Pick another model, or ask again in game.' : 'Lower Thinking in Your AI, or ask again in game.';
      case 'spend_limit': case 'rate_limited_daily': case 'content_blocked': case 'interrupted':
        return l.detail;
      default: return 'Copy diagnostics if it keeps happening.';
    }
  })();
  const action = WINDOW_FIX.get(err?.kind) ?? l.action?.id ?? null;
  // Desktop text only: one kind of apostrophe, the window's curly one (D-30). The in-game lines keep theirs.
  const curly = t => String(t ?? '').replace(/'/g, '’');
  const headline = curly(headlineFor[err?.kind] ?? l.headline);
  const next = curly(detail || '');
  return { headline, detail: next, action, line: [headline, next].filter(Boolean).join(' ') };
}

/** The slot count of a config (transport.slots, default 200). */
const slotsOf = config => Number(config?.transport?.slots) || SLOT_COUNT;

export function createAppApi(opts = {}) {
  const {
    keystore, config, paths = {}, log = () => {}, openExternal = null, egress = null, saveConfig = null,
    fetch = globalThis.fetch, platform = process.platform, env = process.env, home = os.homedir(), now = Date.now,
    logLines = () => [], restart = null, halt = null, wow = {}, keystoreNote = null, version = null, settingsReset = false,
    patchDay = () => null,
    screenReading = null, // boot's applyScreenReading: the capture helper alone starts or stops (never the core)
    configFile = null, // the app's config.json: where the install's one fold of the parts' row is recorded (C-119)
    signIns = null, // boot's sign-ins (signin/index.mjs): a plan in place of a key (ChatGPT)
  } = opts;
  if (!config || typeof config !== 'object') throw new TypeError('createAppApi needs the config');
  if (!keystore) throw new TypeError('createAppApi needs the key store');
  const manifests = opts.manifests ?? loadManifests();
  const priceBook = opts.priceBook ?? createPriceBook();
  const S = { bridge: opts.bridge ?? null, backend: opts.backend ?? null, capture: opts.capture ?? null };
  const listeners = new Set();
  const masks = new Map(); // provider → masked key, or null when none is saved (never the key)
  let lastPush = null;
  let pushTimer = null;
  let wowSeen = { at: 0, running: false };
  const chosenRoots = new Set(); // install roots the player pointed at with "Choose folder…" (useWowFolder)
  let wowPick = null;            // the install the player chose, when findWow's own pick isn't it
  let stopped = false;
  // Stopped, or its egress guard is (boot's stop uninstalls it): nothing reaches an AI until the app starts again (fix-102).
  const down = () => stopped || (typeof egress?.stopped === 'function' && egress.stopped() === true);
  // Setup (onboarding spec §9.3): the last findWow (status reads it, never searches), an install in
  // flight or its last outcome, an install armed for when WoW closes, the Screen Recording checks.
  let lastFind = null;
  let finding = null;
  let inst = null;               // {state: 'installing'|'current'|'eperm'|'disk_full'|'failed'|'race', path, admin?, othersCanWrite?, update?}
  let armed = null;              // {path, timer, at}
  let badFolder = false;         // the last "Choose folder…" wasn't a WoW folder
  let probe = { permission: null, at: 0 };
  let permLoop = null;           // the next Screen Recording check (BR-05)
  let permWant = false;          // whether the loop runs (syncPermLoop's last word)
  let permStep = 0;              // its backoff's place (PERMISSION_BACKOFF_MS)
  let permTicking = false;       // a loop check in flight
  let windowAt = 0;              // when the window was last in front (a fresh check, an Allow)
  let requesting = null;
  const screen = opts.screenPermission ?? null;

  config.byok = isObj(config.byok) ? config.byok : {};
  const B = () => config.byok;
  B().caps = isObj(B().caps) ? B().caps : {};
  B().privacy = isObj(B().privacy) ? B().privacy : {};
  B().authBy = isObj(B().authBy) ? B().authBy : {};
  config.wow = isObj(config.wow) ? config.wow : {};
  B().terms = isObj(B().terms) ? B().terms : {};
  B().keyState = isObj(B().keyState) ? B().keyState : {};
  config.capture = isObj(config.capture) ? config.capture : {};

  // Other's manifest is built from the player's settings (byok.custom), so it's null until they're set.
  const manifest = id => manifestFor(id, manifests, B().custom);
  const visible = id => { const m = manifest(id); return m && !m.hidden ? m : null; };
  const isCustom = m => m?.custom === true;
  /** Other's service by its host ("openrouter.ai", "localhost:11434"): the name the window gives it. */
  const customName = () => { const c = checkCustomUrl(B().custom?.baseUrl); return c.ok ? new URL(c.baseUrl).host : null; };
  const companion = () => B().persona?.name || 'NeverQuestAlone';
  // Keys out (the patterns, then every key the log knows as an exact match); for the diagnostics
  // bundle also the home folder (SL-7), which the window's own views may show.
  const scrub = (t) => {
    let s = redact(String(t ?? ''));
    try { if (typeof log.scrub === 'function') s = String(log.scrub(s)); } catch { /* the patterns stay */ }
    return s;
  };
  const scrubHome = t => (typeof home === 'string' && home.length > 3 ? scrub(t).split(home).join('~') : scrub(t));
  const clean = v => JSON.parse(scrub(JSON.stringify(v ?? null)));
  const persist = () => {
    if (typeof saveConfig !== 'function') return true;
    try { saveConfig(config); return true; } catch (e) { log('app-config-save-failed', { error: scrub(e?.message ?? e).slice(0, 160) }); return false; }
  };
  /** A model's display name from its manifest (never the raw id where a name exists). */
  const modelLabel = (m, id) => (m?.models?.list ?? []).find(e => e.id === id)?.label || id || null;
  /** A failed key test, the window's way (desktopLine). */
  const failureOf = (err, m, model) => ({
    ok: false, error: err?.kind ?? 'unknown',
    ...desktopLine(err, { provider: m?.name, model: modelLabel(m, model), companion: companion(), platform, now: now() }),
  });
  const addonsDir = () => (config.wow.flavorDir ? path.join(config.wow.flavorDir, 'Interface', 'AddOns') : null);
  const addonHere = () => !!addonsDir() && exists(path.join(addonsDir(), ADDON_NAME, `${ADDON_NAME}.toc`));

  // ---------------------------------------------------------------- change pushes
  function changed() {
    if (stopped || !listeners.size) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      let st;
      try { st = await api.status(); } catch { return; }
      const text = JSON.stringify(st);
      if (text === lastPush) return;
      lastPush = text;
      for (const cb of listeners) { try { cb(JSON.parse(text)); } catch { /* a listener never breaks the bridge */ } }
    }, PUSH_DEBOUNCE_MS);
    pushTimer.unref?.();
  }

  // ---------------------------------------------------------------- views
  /**
   * Is WoW running? The capture helper's own {game} events first (the core keeps the game's pid
   * while it runs: no process list at all); else the process list, at most every WOW_CHECK_MS
   * unless forced, through async execFile so it never blocks the main thread (SY-07).
   */
  async function wowRunningNow(force = false, bst = undefined) {
    let b = bst;
    if (b === undefined) { try { b = S.bridge?.status?.() ?? null; } catch { b = null; } }
    if (Number.isInteger(b?.companion?.gamePid) && b.companion.gamePid > 0) { wowSeen = { at: now(), running: true }; return true; }
    const t = now();
    if (!force && t - wowSeen.at < WOW_CHECK_MS) return wowSeen.running;
    let running = false;
    try {
      const dir = config.wow.flavorDir && isDir(config.wow.flavorDir) ? config.wow.flavorDir : null;
      running = (await (wow.running ?? wowRunningAsync)({ platform, flavorDir: dir, run: wow.run })).running === true;
    } catch { running = false; }
    wowSeen = { at: t, running };
    return running;
  }

  function captureView(bst) {
    const sig = bst?.token?.sig;
    const signals = sig ? (sig === 'ok' ? 'ok' : 'sound_off') : 'unknown';
    let cs = null;
    try { cs = S.capture?.status?.() ?? null; } catch { cs = null; }
    const steps = {
      game: !!(bst?.companion?.gamePid || cs?.window),
      strip: (cs?.stats?.decoded ?? 0) > 0 || !!bst?.lastPayloadAt,
      message: (bst?.seq ?? 0) > 0,
      reply: (bst?.push ?? 0) > 0,
    };
    // The published state is the capture watchdog's (bridge status().capture; display DR-04, SY-20): the
    // same the game's row reads, never a ranking of the helper's errors of the app's own. "Connected"
    // alone names nothing. While nothing is published, the app's own states (DR-06, SY-27): WoW closed
    // (the bridge's game state, SY-30), or the helper not started, is waiting; a live window_minimized
    // is said, never an alarm; and "can see the game" needs a strip read since the helper's current
    // attach (else watching: no claim either way). A problem with the game's window (no_signal,
    // blocked) gives way to waiting while WoW is closed: there's no window to read (SY-30's rule).
    const health = isObj(bst?.capture) ? bst.capture : null;
    const gameDown = bst?.game?.state === 'down';
    let state;
    if (!S.bridge) state = 'no_game';
    else if (!S.capture) state = 'off';
    else if (cs?.kind === 'none') state = 'unsupported';
    else if (!health) state = cs?.connected && !gameDown ? 'watching' : 'waiting';
    else if (health.state !== 'ok' && !(WINDOW_STATES.has(health.state) && (!health.game || gameDown))) state = health.state;
    else if (!health.game || !health.connected || gameDown) state = 'waiting';
    else if (health.minimized) state = 'window_minimized';
    else state = health.seen ? 'ok' : 'watching';
    // No screen reading: the app runs no helper, or the addon said it uses the reload path
    // (/bones mode reload; the addon's hello carries mode=reload, token.mode).
    const mode = !S.capture || bst?.token?.mode === 'reload' || bst?.token?.mode === 'stream' ? 'reload' : 'capture';
    return { state, mode, signals, steps };
  }

  function priceHint(m, e) {
    if (m.local) return { local: true };
    // A plan (a sign-in): no charge per reply; its usage limits are the plan's.
    if (isSignIn(m)) return { plan: true };
    // Another service's prices aren't known here: no cost is shown for it (§2 rule 8).
    if (isCustom(m)) return undefined;
    // With the thinking it does at its start level (SY-102-1: every AI bills it as output).
    try { return typicalCost(priceBook.priceFor(m.id, e.id, now()), { thinkRoom: startThinkRoom(m, e.id) }); } catch { return undefined; }
  }

  // A day's dollars at each thinking level the model offers (CL-design-37): the typical turn with
  // that level's room, so Your AI's rows and the track's line follow the level picked.
  function levelDays(m, e) {
    if (m.local || isCustom(m) || isSignIn(m) || e.effort !== true) return undefined;
    try {
      const price = priceBook.priceFor(m.id, e.id, now());
      return Object.fromEntries(effortLevels(m, e.id).map(l => [l, typicalCost(price, { thinkRoom: THINK_ROOM[l] ?? 0 }).dayUsd]));
    } catch { return undefined; }
  }

  // Every model an AI offers, newest first as its manifest lists them: its tier (default, smarter or
  // other), whether it has thinking levels and which (efforts: cheapest first, the manifest's effort
  // map), its cost at a typical turn (priceHint; the window's "about $X a day") and at each level
  // (levelDays), its cost rank, and whether a newer model replaces it (older).
  function modelsOf(m) {
    const list = (m.models?.list ?? []).map(e => ({
      id: e.id, name: e.label || e.id,
      tier: e.id === m.models.default ? 'default' : e.id === m.models.smarter ? 'smarter' : 'other',
      effort: e.effort === true, efforts: e.effort === true ? effortLevels(m, e.id) : [], priceHint: priceHint(m, e),
      levelDays: levelDays(m, e), costRank: Number.isInteger(e.costRank) ? e.costRank : null, older: typeof e.replacedBy === 'string',
    }));
    return list;
  }
  /** The level a model starts at when the player picks it (DB22: low), or null for one without levels. */
  function startEffort(m, model) {
    return nearestEffort(effortLevels(m, model), START_EFFORT);
  }

  async function keyView(id) {
    if (!masks.has(id)) {
      let key = null;
      try { key = await keystore.get(id); } catch (e) { return { saved: false, state: 'unreadable', error: e.code || 'keystore_error' }; }
      masks.set(id, key ? maskKey(key) : null);
    }
    const masked = masks.get(id);
    if (!masked) return { saved: false };
    const signedIn = isSignIn(manifest(id));
    let state = 'ok';
    if (id === B().provider) { try { state = S.backend?.status?.()?.provider?.keyState ?? 'ok'; } catch { /* ok */ } }
    // A first key saved while its account had no credit (T1): saved, and says so until a test passes.
    if (B().keyState[id]?.state === 'no_credit' && (state === 'ok' || state === 'missing')) state = 'no_credit';
    return signedIn ? { saved: true, signedIn: true, state } : { saved: true, masked, state };
  }

  function linkId(m, kind) {
    return `${m.id}.${kind}`;
  }

  /** Remove the bridge's data under paths.userData (by name only; never the folder itself). Returns the count. */
  function removeAppData() {
    const root = typeof paths.userData === 'string' && path.isAbsolute(paths.userData) ? paths.userData : null;
    if (!root) return 0;
    const names = [...APP_DATA];
    // The core's store (outbox, records, chat state), when it sits inside the data folder.
    if (typeof paths.state === 'string' && path.dirname(path.resolve(paths.state)) === path.resolve(root)) names.push(path.basename(paths.state));
    let n = 0;
    for (const name of new Set(names)) {
      const p = path.join(root, name);
      try { fs.lstatSync(p); } catch { continue; }
      try { fs.rmSync(p, { recursive: true, force: true }); n += 1; } catch (e) { log('app-uninstall-data-failed', { name, error: e.code || 'failed' }); }
    }
    return n;
  }

  /** The permissions check as the window gets it (no Windows grant lines, which name groups and rights). */
  const permissionsView = perm => ({
    ok: perm?.ok ?? null, fixable: perm?.fixable === true, fixed: Array.isArray(perm?.fixed) ? perm.fixed : [],
    paths: Array.isArray(perm?.paths) ? perm.paths : [], detail: typeof perm?.detail === 'string' ? perm.detail : '',
  });
  // This account's SID, for the Windows command (D-37); read once, on Windows only.
  let sidCache;
  const mySid = () => {
    if (platform !== 'win32') return null;
    if (sidCache === undefined) sidCache = (wow.sid ?? accountSid)({ run: wow.run ?? spawnSync, env });
    return sidCache;
  };
  const withCommand = (perm, ad) => ({ ...permissionsView(perm), ...adminCommand(perm, { platform, addonsDir: ad, sid: mySid() }) });

  /** Every Forever install: the usual places, and the folders the player chose. */
  function installs() {
    const find = wow.find ?? findWow;
    let list = [];
    try { list = find({ platform, env, home, roots: wow.roots ?? null, run: wow.run }); } catch { list = []; }
    if (chosenRoots.size) {
      let more = [];
      try { more = find({ platform, env, home, roots: [...chosenRoots], run: wow.run }); } catch { more = []; }
      for (const w of more) if (!list.some(x => x.flavorDir === w.flavorDir)) list.push(w);
    }
    return list;
  }
  const addonAt = dir => exists(path.join(dir, 'Interface', 'AddOns', ADDON_NAME, `${ADDON_NAME}.toc`));

  /** A pasted key's shape against its provider (setKey and testStagedKey), or null when it passes. */
  function keyProblem(m, k) {
    if (typeof k !== 'string' || !k) return bad('key');
    log.addSecret?.(k);
    const shape = pickProviderForKey(k, manifests);
    if (shape.reason === 'admin_key') return { ok: false, error: 'admin_key', detail: `That’s an admin key, which can’t send messages. Make a normal API key at ${m.name}.` };
    if (!shape.id) return { ok: false, error: 'not_a_key', detail: `That doesn’t look like a key from ${m.name}. Copy the whole key and paste it again.` };
    if (shape.id !== m.id) {
      const other = manifest(shape.id)?.name ?? shape.id;
      return { ok: false, error: 'key_mismatch', guess: shape.id, detail: `That’s a key from ${other}. Pick ${other}, or paste a key from ${m.name}.` };
    }
    return null;
  }

  /** A passing test for the provider in use clears the backend's trouble and last failure (D-32, D-38). */
  function afterPassingTest() {
    try {
      if (typeof S.backend?.clearAfterTest === 'function') S.backend.clearAfterTest();
      else S.backend?.clearLastError?.();
    } catch { /* the next reply clears it */ }
  }

  /**
   * The model list, then (a cloud provider) one tiny request to the model; getKey is the key's source.
   * Other (custom) gets the tiny request alone: one request to the player's own endpoint, since an
   * OpenAI-compatible server's model list is optional and the model is the player's.
   */
  async function runTest(m, getKey, { saved, context = null }) {
    const provider = m.id;
    // A plan's sign-in: its session's fresh token (and account header), whatever getKey was given.
    const session = signIns?.for(m);
    if (session) getKey = () => session.credentials();
    // Other's model is the one its manifest was built with (the service being connected, or the one in use).
    const model = (isCustom(m) ? m.models?.default : null) || (B().provider === provider && B().model) || m.models?.default || null;
    // Setup's test (onboarding spec §9.3): its own results, each with its fix (setupFailure).
    const failure = context === 'setup' ? (err, mm, mod) => setupFailure(err, mm, mod) : failureOf;
    const release = egress?.widen?.(m.hosts ?? [], m.local ? 'local_model' : 'key_test') ?? (() => {});
    try {
      const prov = createProvider(m, { getKey, fetch, log, now });
      let models = model ? [model] : [];
      if (!isCustom(m)) {
        const v = await prov.validate({ signal: AbortSignal.timeout(30_000) });
        if (!v.ok) return failure(v.error, m, model);
        models = [...new Set(v.models ?? [])].slice(0, 500);
      }
      const t = await prov.testCall({ model, signal: AbortSignal.timeout(60_000) });
      if (!t.ok) return failure(t.error, m, model);
      let micros = 0;
      try { micros = m.local || m.priceSource === 'free' ? 0 : costMicros(t.usage ?? {}, priceBook.priceFor(provider, model, now())); } catch { micros = 0; }
      if (saved && B().provider === provider) {
        try { await S.backend?.refresh?.({ keyChanged: true }); } catch { /* status only */ }
        // What the player fixed at the provider (credit, a spend limit, a region) is fixed: the card goes (D-32, D-38).
        afterPassingTest();
      }
      // A passing test of a saved key clears its no-credit mark (T1).
      if (saved && B().keyState[provider]) { delete B().keyState[provider]; persist(); }
      if (saved) changed();
      return { ok: true, models, testCall: { ok: true, usage: t.usage ?? null, micros } };
    } catch (e) {
      log('app-test-failed', { provider, error: scrub(e?.message).slice(0, 120) });
      return { ok: false, error: 'failed' };
    } finally { release(); }
  }

  /** A failed setup test: the setup result (setupKind), the names its words need, never the provider's text. */
  function setupFailure(err, m, model) {
    const k = setupKind(err, m.id);
    return {
      ok: false, error: k.error, kind: err?.kind ?? 'unknown', documented: k.documented, inferred: k.inferred, tier: k.tier,
      ...(Number.isFinite(k.resetAt) ? { resetAt: k.resetAt } : {}), model: modelLabel(m, model),
    };
  }
  /** The cloud AIs' terms, recorded at the version setup showed (onboarding spec §9.3). Other (custom) has none of ours to show. */
  const termsOk = m => !!m && (m.local === true || isCustom(m) || (Number(B().terms[m.id]?.v) || 0) >= displayOf(m).termsVersion);

  // The usage block the window reads (status().backend.usage, usage().today): the backend's, with
  // autoPaused: true while the bridge's runaway fuse holds (spec §9.9; the core keeps it, not the
  // backend; left out otherwise), as the slot's bridge.usage has it.
  function usageBlock(bk, bst) {
    if (!bk?.usage) return null;
    // The check-ins fuse (automatic turns; spec §9.9, systems plan D4): autoPaused while it holds,
    // with the window that tripped (the core's companion.autoPausedBy, else the per-minute one).
    const by = isObj(bst?.companion?.autoPausedBy) ? bst.companion.autoPausedBy : AUTO_FUSE;
    const fuse = { turns: Number.isInteger(by?.turns) ? by.turns : AUTO_FUSE.turns, windowMs: Number.isFinite(by?.windowMs) ? by.windowMs : AUTO_FUSE.windowMs };
    return { ...bk.usage, needs: bk.usage.needs ?? null, ...(bst?.companion?.autoPaused === true ? { autoPaused: true, fuse } : {}) };
  }
  /**
   * The typed guard (systems plan D4): more than `turns` typed messages in `windowMs` pauses
   * sending until the player presses Resume sending in the window. The core or the backend
   * reports it as status().sending = {paused: true, turns, windowMs, at?}. → {turns, windowMs} | null.
   */
  function sendingPausedOf(bst, bk) {
    const sp = [bst?.sending, bk?.sending].find(x => isObj(x) && x.paused === true);
    if (!sp) return null;
    return { turns: Number.isInteger(sp.turns) ? sp.turns : 20, windowMs: Number.isFinite(sp.windowMs) ? sp.windowMs : 60_000, ...(Number.isFinite(sp.at) ? { at: sp.at } : {}) };
  }

  // ---------------------------------------------------------------- setup (onboarding spec §9.3)
  /** The addon's version as a TOC says it ("## Version: 0.4.9"), or null. */
  const tocVersion = (dir) => {
    try { return /^##\s*Version:\s*(\S+)/m.exec(fs.readFileSync(path.join(dir, `${ADDON_NAME}.toc`), 'utf8'))?.[1] ?? null; } catch { return null; }
  };
  const shipped = () => tocVersion(wow.addonSource ?? path.join(REPO, 'addon', ADDON_NAME));
  /**
   * An install whose addon is older than the one this app ships (it updates when WoW closes). Older,
   * never just different: a newer copy (a store's, a test build's) is never downgraded (2026-10-05).
   */
  const verOf = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')); return m ? [+m[1], +m[2], +m[3]] : null; };
  const olderAt = (dir) => {
    const have = tocVersion(path.join(dir, 'Interface', 'AddOns', ADDON_NAME));
    const ship = shipped();
    if (!have || !ship) return false;
    const a = verOf(have), b = verOf(ship);
    if (!a || !b) return have !== ship;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  /** findWow in the background, once at a time; status() reads what it found. */
  function refreshFind() {
    if (finding) return finding;
    finding = api.findWow().catch(() => null).finally(() => { finding = null; });
    return finding;
  }
  /** The installs as findWow lists them, without asking whether WoW runs (the first status()). */
  function findNow() {
    const list = installs();
    const pick = list.find(w => w.flavorDir === wowPick) ?? list.find(w => w.flavorDir === config.wow.flavorDir) ?? list[0] ?? null;
    lastFind = pick
      ? { found: true, path: pick.flavorDir, running: wowSeen.running, candidates: list.map(w => ({ path: w.flavorDir, ...(w.version ? { version: w.version } : {}), ...(w.account ? { account: w.account } : {}), addon: addonAt(w.flavorDir) })) }
      : { found: false, running: wowSeen.running, candidates: [] };
    return lastFind;
  }
  /** Row 1 of Say hi in game: the addon's state, from the last findWow and what setup did since. */
  function installView(running, found = null) {
    const w = found ?? lastFind;
    const cands = Array.isArray(w?.candidates) ? w.candidates.map(c => ({ path: c.path, ...(c.version ? { version: c.version } : {}), ...(c.account ? { account: c.account } : {}), addon: !!c.addon })) : [];
    const base = { path: w?.path ?? null, candidates: cands, admin: null, othersCanWrite: null };
    if (armed) return { ...base, state: 'armed', path: armed.path };
    if (inst?.state === 'installing') return { ...base, state: 'installing', path: inst.path };
    // update: the failed install was an update of an older addon there (the row says update, not install).
    if (inst && ['eperm', 'disk_full', 'failed', 'race'].includes(inst.state)) return { ...base, state: inst.state, path: inst.path, admin: inst.admin ?? null, update: inst.update === true };
    if (!w) return installView(running, findNow());
    if (!w.found) return { ...base, state: badFolder ? 'bad_folder' : 'not_found' };
    if (cands.length > 1 && !wowPick && !cands.some(c => c.addon) && !cands.some(c => c.path === config.wow.flavorDir)) return { ...base, state: 'choose' };
    const at = w.path;
    if (addonAt(at)) {
      const others = inst?.state === 'current' && inst.path === at ? inst.othersCanWrite ?? null : null;
      return { ...base, state: olderAt(at) ? 'older' : 'current', path: at, othersCanWrite: others };
    }
    return { ...base, state: running ? 'running' : 'found', path: at };
  }
  /** The Battle.net app, for Start WoW's button: {found, path}. */
  function launcherOf() {
    if (typeof wow.launcher === 'function') { try { const l = wow.launcher(); return { found: !!l?.found, path: l?.path ?? null }; } catch { return { found: false, path: null }; } }
    const candidates = platform === 'darwin' ? ['/Applications/Battle.net.app']
      : platform === 'win32' ? [path.win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Battle.net', 'Battle.net Launcher.exe')] : [];
    const found = candidates.find(exists) ?? null;
    return { found: !!found, path: found };
  }
  let launcherCache = null;
  function setupNow(bst, running) {
    let cs = null;
    try { cs = S.capture?.status?.() ?? null; } catch { cs = null; }
    launcherCache ??= launcherOf();
    // A typed error the helper didn't keep in its status: the watchdog's published cause (its one
    // publisher, display DR-04), never a copy of the helper's errors of the app's own.
    const pub = isObj(bst?.capture) && bst.capture.state !== 'ok' && typeof bst.capture.cause === 'string' ? { kind: bst.capture.cause } : null;
    const view = setupView({
      platform, now: now(), core: bst, cs, captureOn: !!S.capture, captureError: pub, readingOff: B().privacy?.screenReading === false,
      requestedAt: config.capture.permissionRequestedAt ?? null, probe, addon: installView(running), wowRunning: running, launcher: launcherCache.found,
    });
    // The loop's reason to run can change with any status (asked, WoW started, a mode): keep it right.
    syncPermLoop(view);
    return view;
  }

  /**
   * Install the addon for setup (Install, or armed for when WoW closes): the install's outcome as
   * the row shows it. EPERM carries the administrator's command (D-37); ENOSPC is disk_full.
   */
  async function setupInstall(target) {
    // An addon already there makes this an update: a failure then says "didn't update" (onboarding strings).
    let update = false;
    try { update = !!addonAt(target); } catch { update = false; }
    inst = { state: 'installing', path: target };
    changed();
    let r;
    try { r = await api.installAddon({ flavorDir: target }); } catch (e) { r = { ok: false, error: 'install_failed', steps: [{ ok: false, error: e?.code || 'failed' }] }; }
    const codes = (Array.isArray(r?.steps) ? r.steps : []).map(x => x?.error).filter(Boolean);
    if (r?.ok) {
      // WoW started while the files went in: they didn't load (a restart of WoW does it).
      const race = await wowRunningNow(true);
      const pm = r.permissions;
      inst = race ? { state: 'race', path: target } : { state: 'current', path: target, othersCanWrite: pm && pm.ok === false ? true : pm ? false : null };
    } else if (r?.error === 'wow_running') {
      inst = null;
    } else if (codes.some(c => c === 'EPERM' || c === 'EACCES')) {
      // Windows: icacls gives this account its own change permission there (D-37), so its command
      // fixes what the row says. A Mac has no such command here: chmod go-w (adminCommand's POSIX
      // fix) takes write access from other accounts and doesn't give this one the folder, so the row
      // says what to ask an administrator for instead (bones-ux-writer r2, UX-W28).
      let admin = null;
      if (platform === 'win32') {
        try {
          const ad = path.join(target, 'Interface', 'AddOns');
          const pm = (wow.permissions ?? checkAddonsPermissions)(ad, { platform, run: wow.run ?? spawnSync });
          const cmd = adminCommand(pm, { platform, addonsDir: ad, sid: mySid() });
          admin = cmd.command ? cmd : null;
        } catch { admin = null; }
      }
      inst = { state: 'eperm', path: target, admin, update };
    } else if (codes.includes('ENOSPC')) {
      inst = { state: 'disk_full', path: target, update };
    } else {
      inst = { state: 'failed', path: target, update };
    }
    await refreshFind();
    changed();
    return r;
  }
  function disarm() {
    if (!armed) return;
    clearInterval(armed.timer);
    armed = null;
  }

  // Screen Recording (macOS): the check and the request run the capture helper as a new instance.
  function screenRunner() {
    if (screen) return screen;
    if (platform !== 'darwin') return null;
    const app = paths.captureApp ?? (typeof config.capture.app === 'string' && config.capture.app ? (path.isAbsolute(config.capture.app) ? config.capture.app : path.join(REPO, config.capture.app)) : null);
    return createScreenPermission({
      app,
      // Off the main thread, with time limits, and once per run for a helper as it is on disk (BR-05).
      verify: async (a) => {
        const { checkCaptureAppAsync } = await import('../transport/capture.mjs');
        const run = wow.run ? async (cmd, args, o) => wow.run(cmd, args, o) : undefined;
        return (await checkCaptureAppAsync(a, { teamId: paths.captureTeamId ?? config.capture.teamId ?? null, ...(run ? { run } : {}) })).ok;
      },
    });
  }
  /**
   * A check's answer. A flip from no to yes while the socket helper runs restarts it: it still holds
   * the answer it read at its start (macOS gives a process the grant only when it starts again).
   */
  async function notePermission(r, source) {
    let helperSaid = null;
    try { helperSaid = S.capture?.status?.()?.permission ?? null; } catch { helperSaid = null; }
    const was = probe.permission === true || helperSaid === true ? true : probe.permission === false || helperSaid === false ? false : null;
    probe = { permission: typeof r?.permission === 'boolean' ? r.permission : probe.permission, at: now(), ...(r?.error ? { error: r.error } : {}) };
    if (was === false && probe.permission === true && S.capture) {
      // The helper alone starts again (a new process gets the grant), never the core: a reply in flight stays (SY-04).
      log('app-screen-permission-granted', { source });
      try { S.capture.restart?.('screen recording granted'); } catch (e) { log('app-restart-failed', { error: scrub(e?.message).slice(0, 160) }); }
    }
    if (was !== probe.permission) changed();
    return probe;
  }
  async function checkPermission() {
    const runner = screenRunner();
    if (!runner) return probe;
    let r;
    try { r = await runner.probe(); } catch { r = { permission: null }; }
    return notePermission(r, 'check');
  }
  /**
   * While Screen Recording isn't on, unless the addon's Screen Reading is off, and while WoW runs or
   * (it was asked for, or denied, and the window was in front lately): a check after 10 s, then
   * 60 s, then every 5 min (BR-05); it stops once granted (onboarding spec §9.3).
   */
  function syncPermLoop(view) {
    const windowLately = windowAt > 0 && now() - windowAt < WINDOW_RECENT_MS;
    permWant = platform === 'darwin' && !stopped && view.permission !== 'granted' && view.captureState !== 'off'
      && (view.game.running || (windowLately && (view.permission === 'asked' || view.permission === 'denied')));
    if (permWant && !permLoop && !permTicking) { permStep = 0; armPermLoop(); } else if (!permWant && permLoop) { clearTimeout(permLoop); permLoop = null; }
  }
  function armPermLoop() {
    permLoop = setTimeout(permTick, PERMISSION_BACKOFF_MS[Math.min(permStep, PERMISSION_BACKOFF_MS.length - 1)]);
    permLoop.unref?.();
  }
  // One check of the loop: still wanted (WoW, the window, the permission, as status() would say)?
  // Then the check, and the next one a step further out.
  async function permTick() {
    permLoop = null;
    permTicking = true;
    try {
      let bst = null;
      try { bst = S.bridge?.status?.() ?? null; } catch { bst = null; }
      setupNow(bst, await wowRunningNow(false, bst));
      if (!permWant || stopped) return;
      permStep += 1;
      await checkPermission().catch(() => {});
    } finally {
      permTicking = false;
      if (permWant && !stopped && !permLoop) armPermLoop();
    }
  }
  // The player is at the window (its focus asks for a fresh check; Allow): the loop starts over at 10 s
  // (its tick says whether it's wanted at all).
  function windowHere() {
    windowAt = now();
    permStep = 0;
    if (platform !== 'darwin' || stopped || permTicking) return;
    if (permLoop) clearTimeout(permLoop);
    armPermLoop();
  }

  /** The route on the map now (the bridge's route, CL-design-41): {next, stops, title}, its words clipped; null with none. */
  const routeOf = (bst) => {
    const r = bst?.route;
    if (!isObj(r) || typeof r.next !== 'string' || !r.next.trim()) return null;
    const stops = Number.isInteger(r.stops) && r.stops > 0 ? r.stops : 1;
    return { next: r.next.trim().slice(0, 80), stops, title: typeof r.title === 'string' ? r.title.slice(0, 80) : '' };
  };

  // ---------------------------------------------------------------- calls
  const api = {
    async status() {
      let bst = null;
      let bk = null;
      try { bst = S.bridge?.status?.() ?? null; } catch { bst = null; }
      try { bk = S.backend?.status?.() ?? null; } catch { bk = null; }
      // A stopped boot (fix-102) is the app needing a restart, whatever its parts last said: its guard
      // lets nothing through (the window's not-running card, with Quit and reopen).
      const rt = down() ? { state: 'not_running', reason: 'app_stopped' } : bk?.rt ?? { state: 'provider_down', reason: 'no_backend' };
      const flavorDir = config.wow.flavorDir;
      const found = !!flavorDir && isDir(flavorDir);
      const usage = usageBlock(bk, bst);
      // The model check's notice (PV-3, §10): {kind: 'model_switched', from, to, at} | {kind: 'model_retired', model, at},
      // with each model's name from the manifest (fromName, toName, name), so the window never says a
      // raw id (spec §2 rule 4; bones-ux-writer onboarding r3, UX-W35). Without one, a model in use
      // whose company announced its retirement (the manifest's retiresAfter, SY-102-5) is said before
      // the day: {kind: 'model_retiring', model, after, to, at: null}, to being the manifest's moveTo.
      const pv = bk?.provider ?? null;
      const retiring = !isObj(bk?.notice) && pv?.model ? retiringOf(manifest(pv.id), pv.model) : null;
      const notice = isObj(bk?.notice) ? namedNotice(bk.notice, manifest(pv?.id))
        : retiring ? namedNotice({ kind: 'model_retiring', ...retiring, at: null }, manifest(pv.id)) : null;
      // The last failure the desktop explains (D-01), in the window's words; never the provider's text.
      // thinking: whether the model has levels (efforts), so an empty reply's line names Thinking only then.
      const lastError = lastErrorView(bk?.lastError, { provider: pv?.name, model: pv?.modelName ?? pv?.model, companion: companion(), platform, now: now(), thinking: !!pv?.efforts });
      const sendingPaused = sendingPausedOf(bst, bk);
      // Patch day (SY-29): the addon's TOCs set to a new World of Warcraft's interface number.
      let pd = null;
      try { pd = patchDay() ?? null; } catch { pd = null; }
      const patch = isObj(pd) && typeof pd.to === 'string'
        ? { to: pd.to, ...(typeof pd.version === 'string' ? { version: pd.version } : {}), restart: pd.restart === true, ...(pd.failed ? { failed: true } : {}) } : null;
      // A first key saved while its account had no credit (T1), until a test passes or a reply comes.
      let provider = pv;
      const mark = pv ? B().keyState[pv.id] : null;
      if (mark?.state === 'no_credit') {
        const turns = Number(bk?.usage?.turns) || 0;
        if (turns > (Number(mark.turns) || 0)) { delete B().keyState[pv.id]; persist(); } else if (pv.keyState === 'ok') provider = { ...pv, keyState: 'no_credit' };
      }
      const wowRun = await wowRunningNow(false, bst);
      const out = clean({
        bridge: { version: bst?.version ?? BRIDGE_VERSION, running: !!S.bridge && !down(), paused: rt.state === 'paused', ...(down() ? { error: 'stopped' } : S.bridge ? {} : { error: !found ? 'wow_not_found' : addonHere() ? 'not_started' : 'addon_not_installed' }) },
        backend: { rt, provider, usage, ...(notice ? { notice } : {}), ...(lastError ? { lastError } : {}), ...(sendingPaused ? { sendingPaused } : {}) },
        capture: captureView(bst),
        wow: { found, ...(found ? { path: flavorDir } : {}), running: wowRun, addon: found && addonHere(), ...(patch ? { patch } : {}), ...(routeOf(bst) ? { route: routeOf(bst) } : {}) },
        setup: setupNow(bst, wowRun),
        // Where keys live: persistent false is boot's memory fallback (no Secret Service, or Windows
        // without Credential Manager): the window says a key is kept until the app quits.
        keys: { persistent: keystore.persistent !== false },
        // This start found config.json unreadable, moved it aside and began on the defaults (SY-12).
        ...(settingsReset ? { settings: { reset: true } } : {}),
        // A write the disk refused that the core's store hasn't made since (code health BR-11): {file, code,
        // at, diskFull}, the core's own status().store.writeError; Home's card says so (status-view.mjs savingLines).
        ...(isObj(bst?.store?.writeError) ? { store: { writeError: bst.store.writeError } } : {}),
      });
      // The one vocabulary (status-view.mjs): the words, tone and lines the window and the tray show.
      out.view = statusView(out, { platform });
      return out;
    },

    async providers() {
      const out = [];
      for (const t of manifests) {
        if (isCustom(t)) {
          // Other: the template until the player connects a service, then that service by its host.
          const m = manifest(t.id);
          const c = checkCustomUrl(B().custom?.baseUrl);
          out.push({
            id: t.id,
            name: customName() ?? t.name,
            hidden: !!t.hidden,
            auth: 'custom',
            local: !!m?.local,
            custom: c.ok ? { baseUrl: c.baseUrl, host: new URL(c.baseUrl).host, model: typeof B().custom?.model === 'string' ? B().custom.model : null, local: c.local } : null,
            models: m ? modelsOf(m) : [],
            ...playerCard(m ?? t),
            terms: { link: null, recorded: true },
            key: await keyView(t.id),
          });
          continue;
        }
        const local = t.local === true;
        out.push({
          id: t.id,
          name: t.name,
          hidden: !!t.hidden,
          auth: local ? 'local' : isSignIn(t) ? 'signin' : 'key',
          models: modelsOf(t),
          ...playerCard(t),
          terms: { link: linkId(t, local ? 'privacy' : 'terms'), recorded: termsOk(t) },
          key: local ? null : await keyView(t.id),
        });
      }
      return clean(out);
    },

    async setKey(provider, key) {
      const m = visible(provider);
      if (!m || m.local || isCustom(m) || isSignIn(m)) return bad('provider'); // Other's key comes with its service (connectCustom); a plan signs in
      const k = typeof key === 'string' ? key.trim() : null;
      const problem = keyProblem(m, k);
      if (problem) return problem;
      try { await keystore.set(provider, k); } catch (e) { return { ok: false, error: e.code || 'keystore_error' }; }
      masks.set(provider, maskKey(k));
      B().authBy[provider] = 'key';
      if (B().provider === provider && B().auth !== 'key') {
        B().auth = 'key';
        try { await S.backend?.setConfig?.({ auth: 'key' }); } catch { /* refresh below */ }
      }
      persist();
      try { await S.backend?.refresh?.({ keyChanged: true }); } catch (e) { log('app-refresh-failed', { error: scrub(e?.message).slice(0, 120) }); }
      changed();
      log('app-key-set', { provider });
      return { ok: true, masked: maskKey(k) };
    },

    async testKey(provider) {
      const m = visible(provider);
      if (!m) return bad('provider');
      return runTest(m, id => keystore.get(id), { saved: true });
    },

    /**
     * Test a key before it's stored (D-03): the pasted key, read through getKey (the desktop
     * shell's stager; nothing is written), gets the same checks as setKey and the same model list
     * and tiny test request as testKey. The saved key, if any, is untouched whatever the outcome;
     * the shell stores the new one only after this passes.
     */
    async testStagedKey(provider, getKey, o = {}) {
      const m = visible(provider);
      if (!m || m.local || isCustom(m) || isSignIn(m)) return bad('provider');
      // Nothing goes to an AI company before its terms are recorded (onboarding spec §9.3).
      if (!termsOk(m)) return { ok: false, error: 'terms_required' };
      let key = null;
      try { key = typeof getKey === 'function' ? await getKey(provider) : null; } catch { key = null; }
      if (typeof key !== 'string' || !key) return { ok: false, error: 'key_expired' };
      const k = key.trim();
      const problem = keyProblem(m, k);
      if (problem) return problem;
      return runTest(m, async () => k, { saved: false, context: o?.context === 'setup' ? 'setup' : null });
    },

    async deleteKey(provider) {
      // Other's key can go whether or not its service is set (the template names the entry).
      const m = manifest(provider) ?? (provider === CUSTOM_ID ? manifests.find(isCustom) : null);
      if (!m || (m.local && !isCustom(m))) return bad('provider');
      try { await keystore.delete(provider); } catch (e) { return { ok: false, error: e.code || 'keystore_error' }; }
      signIns?.for(m)?.signOut();
      masks.set(provider, null);
      delete B().authBy[provider];
      persist();
      try { await S.backend?.refresh?.({ keyChanged: true }); } catch { /* status only */ }
      changed();
      log('app-key-deleted', { provider });
      return { ok: true };
    },

    /**
     * Other (custom): connect the player's own OpenAI-compatible service. v: {baseUrl, model, key?}.
     * The base URL must pass checkCustomUrl (https, or http for this computer); the key is optional
     * (a server on this computer takes none). One tiny test request goes to <baseUrl>/chat/completions,
     * the service's host allowed for that one request; only when it answers are the service, its
     * model and the key saved and made the AI in use. No key given: a key saved for Other before goes.
     * → {ok, name, model, local, masked?, testCall} | {ok: false, error: bad_url|https_required|
     *   credentials|query|not_http|empty|too_long|bad_model|<a setup failure>, …}.
     */
    async connectCustom(v = {}) {
      const template = manifests.find(isCustom);
      if (!template) return { ok: false, error: 'unsupported' };
      const c = checkCustomUrl(v?.baseUrl);
      if (!c.ok) return { ok: false, error: c.error };
      const model = typeof v?.model === 'string' ? v.model.trim() : '';
      if (!CUSTOM_MODEL_RE.test(model)) return { ok: false, error: 'bad_model' };
      const key = typeof v?.key === 'string' && v.key.trim() ? v.key.trim() : null;
      if (key) {
        log.addSecret?.(key);
        if (key.length > 1024 || /[\s\u0000-\u001f\u007f]/.test(key)) return { ok: false, error: 'not_a_key' };
      }
      const m = customManifest(template, { baseUrl: c.baseUrl, model });
      if (!m) return { ok: false, error: 'bad_url' };
      const t = await runTest(m, async () => key, { saved: false, context: 'setup' });
      if (t?.ok !== true) return t;
      try {
        if (key) await keystore.set(CUSTOM_ID, key);
        else await keystore.delete(CUSTOM_ID);
      } catch (e) { return { ok: false, error: 'keystore_error', code: e?.code ?? null }; }
      masks.set(CUSTOM_ID, key ? maskKey(key) : null);
      B().custom = { baseUrl: c.baseUrl, model };
      B().authBy[CUSTOM_ID] = 'key';
      delete B().keyState[CUSTOM_ID];
      Object.assign(B(), { provider: CUSTOM_ID, model, effort: null, auth: 'key' });
      try { await S.backend?.setConfig?.({ provider: CUSTOM_ID, model, custom: { baseUrl: c.baseUrl, model }, effort: null, auth: 'key' }); } catch (e) {
        log('app-custom-failed', { error: scrub(e?.message).slice(0, 120) });
        persist();
        changed();
        return { ok: false, error: 'failed' };
      }
      persist();
      try { await S.backend?.refresh?.({ keyChanged: true }); } catch { /* status only */ }
      afterPassingTest();
      changed();
      log('app-connect', { provider: CUSTOM_ID, local: c.local, key: !!key });
      return { ok: true, name: new URL(c.baseUrl).host, model, local: c.local, ...(key ? { masked: maskKey(key) } : {}), testCall: t.testCall };
    },

    async choose(v) {
      const m = visible(v?.provider);
      if (!m) return bad('provider');
      const listed = (m.models?.list ?? []).some(e => e.id === v.model);
      if (!listed && m.models?.allowAny !== true) return { ok: false, error: 'unknown_model' };
      if (v.effort != null && !EFFORT_LEVELS.includes(v.effort)) return bad('effort');
      // Saved as the level the model runs at: its nearest to the one asked for (a level picked for
      // another model), none for a model without levels, and none asked stays none (the model's own).
      const effort = v.effort == null ? null : nearestEffort(effortLevels(m, v.model), v.effort);
      const auth = isSignIn(m) ? 'oauth' : 'key';
      // Other's model is part of its service's settings: a new one is saved with them.
      const custom = isCustom(m) ? { baseUrl: m.baseUrl, model: v.model } : undefined;
      if (custom) B().custom = custom;
      Object.assign(B(), { provider: m.id, model: v.model, effort, auth });
      try { await S.backend?.setConfig?.({ provider: m.id, model: v.model, effort, auth, ...(custom ? { custom } : {}) }); } catch (e) {
        log('app-choose-failed', { error: scrub(e?.message).slice(0, 120) });
        return { ok: false, error: 'failed' };
      }
      persist();
      changed();
      log('app-choose', { provider: m.id, model: v.model, effort });
      return { ok: true };
    },

    /**
     * The player's own daily spend cap, and today's spend beside it. The public build has no usage
     * limits of its own (maintainer, 2026-09-26): dailyUsd is null until the player sets one, never a
     * default. → {dailyUsd: <USD>|null, spentTodayMicros: <integer>|null (null: no backend to ask)}
     */
    async caps() {
      const c = B().caps;
      const dailyUsd = typeof c.dailyUsd === 'number' && Number.isFinite(c.dailyUsd) && c.dailyUsd >= 0 ? c.dailyUsd : null;
      let spent = null;
      try { const u = S.backend?.caps?.snapshot?.(); if (Number.isInteger(u?.spentMicros)) spent = u.spentMicros; } catch { spent = null; }
      return { dailyUsd, spentTodayMicros: spent };
    },

    /**
     * Set the player's daily spend cap ({dailyUsd: 0–100 with cents}), or clear it ({dailyUsd: null}).
     * Saved as byok.caps {v: 2, dailyUsd} (v: 2, so config.mjs migrateByokCaps never takes a $1.00
     * the player set for the old default). Other fields (an older window's typedPerDay,
     * autoPerDay) are ignored: those limits are gone.
     */
    async setCaps(v) {
      const dailyUsd = v?.dailyUsd ?? null;
      // The backend takes it first: one it refused is neither shown (caps()) nor saved as if it held.
      try { await S.backend?.setConfig?.({ caps: { dailyUsd } }); } catch { return { ok: false, error: 'failed' }; }
      const prev = B().caps;
      const keep = Object.fromEntries(['perTurnInput', 'perTurnOutput'].filter(k => Object.hasOwn(prev, k)).map(k => [k, prev[k]]));
      B().caps = { v: 2, dailyUsd, ...keep };
      persist();
      changed();
      log('app-caps', { dailyUsd });
      return { ok: true };
    },

    async privacy() {
      const p = B().privacy;
      return { identity: p.identity === true, otherNames: p.otherNames === true, companion: p.companion === true, echo: p.echo === true, gameContext: p.gameContext !== false, screenReading: p.screenReading !== false };
    },

    async setPrivacy(v) {
      const p = Object.fromEntries(PRIVACY_KEYS.map(k => [k, PRIVACY_ON_BY_DEFAULT.has(k) ? v?.[k] !== false : v?.[k] === true]));
      const prev = B().privacy;
      const readingWas = prev?.screenReading !== false;
      // The one place the switches live (code health BR-28): the core reads automatic turns
      // (companion) from it live, and boot's privacy wrapper whether a typed turn carries game context
      // and what the slot tells the addon (bridge.reading, bridge.echo).
      B().privacy = p;
      try { await S.backend?.setConfig?.({ privacy: { identity: p.identity, otherNames: p.otherNames } }); } catch { B().privacy = prev; return { ok: false, error: 'failed' }; }
      // Screen reading that couldn't be saved isn't applied: it would come back at the next launch (SY-05).
      if (!persist() && readingWas !== p.screenReading) {
        B().privacy = prev;
        try { await S.backend?.setConfig?.({ privacy: { identity: prev?.identity === true, otherNames: prev?.otherNames === true } }); } catch { /* as it was */ }
        return { ok: false, error: 'failed' };
      }
      // Screen Reading: the capture helper alone stops or starts; a reply in flight is never touched.
      // Turned on, a Mac's helper asks for Screen Recording only as it starts (never before).
      if (readingWas !== p.screenReading && typeof screenReading === 'function') {
        try { await screenReading(); } catch (e) { log('app-screen-reading-failed', { error: scrub(e?.message).slice(0, 160) }); }
      }
      changed();
      log('app-privacy', p);
      return { ok: true };
    },

    async usage({ days = 30 } = {}) {
      const be = S.backend;
      let bk = null;
      let bst = null;
      try { bk = be?.status?.() ?? null; } catch { bk = null; }
      try { bst = S.bridge?.status?.() ?? null; } catch { bst = null; }
      const today = usageBlock(bk, bst);
      // The backend's usage history (usage/history.mjs: every day of the window oldest first, the
      // last turns newest first), else the caps file's days.
      let hist = null;
      if (typeof be?.usageHistory === 'function') { try { hist = await be.usageHistory({ days }); } catch { hist = null; } }
      const cut = new Date(now() - (days - 1) * 86400_000);
      const cutDay = `${cut.getFullYear()}-${String(cut.getMonth() + 1).padStart(2, '0')}-${String(cut.getDate()).padStart(2, '0')}`;
      let rawDays = Array.isArray(hist?.days) ? hist.days : null;
      if (!rawDays) {
        let det = null;
        try { det = be?.caps?.details?.() ?? null; } catch { det = null; }
        rawDays = Array.isArray(det?.history) ? det.history : [];
      }
      rawDays = rawDays.filter(d => isObj(d) && typeof d.day === 'string' && d.day >= cutDay);
      const micros = x => x?.spentMicros ?? x?.micros ?? 0;
      const dayRows = rawDays.map(d => ({ day: d.day, spentMicros: micros(d), turns: d.turns ?? 0, auto: d.auto ?? 0 }))
        .sort((a, b) => (a.day < b.day ? 1 : -1)); // newest first, as the window lists them
      const agg = {};
      for (const d of rawDays) {
        for (const [p, x] of Object.entries(isObj(d.byProvider) ? d.byProvider : {})) {
          // turns: all of the provider's turns; auto: the automatic ones among them (the window shows
          // messages, turns − auto, beside them, as the 30-day rows split them).
          const a = (agg[p] ??= { spentMicros: 0, turns: 0, auto: 0 });
          a.spentMicros += micros(x);
          a.turns += x?.turns ?? 0;
          a.auto += Number.isInteger(x?.auto) && x.auto >= 0 ? x.auto : 0;
        }
      }
      const perProvider = Object.entries(agg).map(([p, a]) => ({ provider: p, name: manifest(p)?.name ?? p, ...a }));
      let recent = Array.isArray(hist?.recent) ? hist.recent : Array.isArray(hist?.replies) ? hist.replies : null;
      if (!recent) {
        let rows = [];
        try { rows = be?.ledger?.list?.() ?? []; } catch { rows = []; }
        recent = rows.filter(e => e.state === 'done').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20)
          .map(e => ({ at: e.updatedAt, model: e.meta?.model ?? '', micros: e.extra?.outMicros ?? e.meta?.outMicros ?? 0 }));
      }
      const replies = recent.filter(isObj).slice(0, 50).map(r => ({
        at: r.at ?? 0, model: String(r.model ?? ''), in: r.in ?? 0, out: r.out ?? 0, micros: r.micros ?? 0, exact: r.exact === true,
        ...(r.provider ? { provider: r.provider } : {}), ...(r.auto ? { auto: true } : {}), ...(r.error ? { error: String(r.error) } : {}),
      }));
      return clean({ today, caps: await api.caps(), days: dayRows, perProvider, replies });
    },

    async connections() {
      const rows = egress?.ledger?.() ?? [];
      const strip = r => ({ host: r.host, port: r.port, count: r.count, first: r.first, last: r.last, feature: r.feature });
      return clean({
        rows: rows.filter(r => r.allowed).map(strip),
        blocked: rows.filter(r => !r.allowed).map(strip),
        note: CONNECTIONS_NOTE,
      });
    },

    async lastRequest(chatId) {
      const be = S.backend;
      if (typeof be?.lastRequest !== 'function') return { ok: false, error: 'unsupported' };
      let r;
      try { r = await be.lastRequest(chatId ?? undefined); } catch { return { ok: false, error: 'failed' }; }
      // The window's shape: {chats, chatId, at, provider, model, request: {method, url, headers, body}}.
      const chats = S.bridge?.store?.state?.chats ?? {};
      const chatList = Object.entries(chats).map(([id, c]) => ({ id, title: String(c?.name ?? c?.label ?? id).slice(0, 64) }));
      // Requests are kept in memory only: a chat with none yet this session keeps the chat list, so
      // the window can still offer the others (request: null is "No requests yet").
      if (!r) return clean({ chats: chatList, chatId: chatId ?? null, at: null, provider: null, model: null, request: null });
      const out = {
        chats: Array.isArray(r.chats) ? r.chats : chatList,
        chatId: r.chatId ?? chatId ?? null, at: r.at ?? null, provider: r.provider ?? null, model: r.model ?? null,
        ...(r.purpose ? { purpose: r.purpose } : {}),
        request: isObj(r.request) ? r.request : { method: r.method ?? 'POST', url: r.url ?? null, headers: r.headers ?? {}, body: r.body ?? null },
      };
      // The auth header arrives as the provider layer's mask ("sk-ant-…A1b2 (redacted)", KY-8), which
      // the view shows as it is; every other value goes through the redactor again.
      const headers = isObj(out.request.headers) ? out.request.headers : {};
      out.request = { ...out.request, headers: {} };
      const cleaned = clean(out);
      for (const [k, v] of Object.entries(headers)) cleaned.request.headers[k] = typeof v === 'string' && MASKED.test(v) ? v : scrub(v);
      return cleaned;
    },

    async memory(char) {
      const be = S.backend;
      const root = path.join(paths.userData ?? '', MEMORY_DIR);
      if (char === undefined || char === null) {
        let chars = null;
        if (typeof be?.memory === 'function') {
          try { const r = await be.memory(); chars = r?.characters ?? r?.chars ?? null; } catch { chars = null; }
        }
        if (!Array.isArray(chars)) {
          try { chars = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { chars = []; }
        }
        return clean({ chars });
      }
      if (!isCharName(char)) return bad('char'); // a folder name: checked where it becomes a path
      if (!isDir(path.join(root, char))) return { ok: false, error: 'not_found' };
      // The window's shape: {char, digest (text), notes: [{at, text}], updated}. Never the folder's path.
      let d = null;
      let text = '';
      let updated = 0;
      if (typeof be?.memory === 'function') {
        let r = null;
        try { r = await be.memory(char); } catch { return { ok: false, error: 'failed' }; }
        if (!r || r.ok === false) return { ok: false, error: 'not_found' };
        d = isObj(r.digest) ? r.digest : null;
        text = typeof r.text === 'string' ? r.text : '';
        updated = Math.max(0, ...(Array.isArray(r.files) ? r.files.map(f => f?.modifiedAt ?? 0) : []));
      } else {
        const i = char.indexOf('-');
        d = memoryDigest(i > 0 ? { name: char.slice(0, i), realm: char.slice(i + 1) } : { name: char }, { dataDir: paths.userData, identity: true });
        try { updated = fs.statSync(path.join(root, char)).mtimeMs; } catch { updated = 0; }
      }
      if (!text && d) text = [...(d.character ?? []), ...(d.recent ?? [])].join('\n');
      return clean({ char, digest: text, notes: (d?.notes ?? []).map(t => ({ at: updated, text: String(t) })), updated });
    },

    async forgetMemory(char) {
      if (!isCharName(char)) return bad('char'); // a folder name: checked where it becomes a path
      const be = S.backend;
      try {
        if (typeof be?.forgetMemory === 'function') await be.forgetMemory(char);
        else {
          const i = char.indexOf('-');
          forgetMemoryDir(paths.userData, i > 0 ? { name: char.slice(0, i), realm: char.slice(i + 1) } : { name: char });
        }
      } catch { return { ok: false, error: 'failed' }; }
      log('app-memory-forgot', {});
      return { ok: true };
    },

    async transcripts(v = {}) {
      const tr = S.backend?.transcripts;
      const retentionDays = B().transcripts?.retentionDays ?? RETENTION_DAYS;
      if (!tr) return { ok: false, error: 'unsupported' };
      let count = 0;
      try { count = tr.chats().length; } catch { count = 0; }
      if (v?.deleteAll !== true) return { ok: true, count, retentionDays };
      try { (tr.deleteAll ?? tr.forgetAll)(); } catch { return { ok: false, error: 'failed' }; }
      // The core's ring of published replies goes too (final review L5-1).
      try { S.bridge?.forgetChatRecords?.(null); } catch (e) { log('app-records-forget-failed', { error: scrub(e?.message).slice(0, 120) }); }
      log('app-transcripts-deleted', { chats: count });
      return { ok: true, deleted: count, retentionDays };
    },

    /** How long transcripts are kept (§6.4, §13.1; final review L5-5): 1 to 365 days, applied at once. */
    async setRetention(days) {
      B().transcripts = { ...(isObj(B().transcripts) ? B().transcripts : {}), retentionDays: days };
      try { await S.backend?.setConfig?.({ transcripts: { retentionDays: days } }); } catch { return { ok: false, error: 'failed' }; }
      persist();
      try { S.bridge?.pruneRecords?.(); } catch { /* the next record prunes it */ }
      changed();
      log('app-retention', { days });
      return { ok: true, retentionDays: days };
    },

    /**
     * What keeping conversations for `days` would delete now (desktop UI critic D-24; the IPC's
     * confirm): {ok: true, retentionDays (the saved one), days, chats (conversations deleted whole),
     * trimmed (conversations that lose their older messages), messages}. Reads only.
     */
    async retentionPreview(days) {
      const retentionDays = B().transcripts?.retentionDays ?? RETENTION_DAYS;
      const tr = S.backend?.transcripts;
      let chats = 0;
      let trimmed = 0;
      let messages = 0;
      if (tr && typeof tr.chats === 'function' && typeof tr.rows === 'function') {
        const old = now() - days * 86400_000;
        try {
          for (const c of tr.chats()) {
            const rows = tr.rows(c, 0);
            const gone = rows.filter(r => Number(r?.t) < old).length;
            if (!gone) continue;
            messages += gone;
            if (gone === rows.length) chats += 1; else trimmed += 1;
          }
        } catch { /* a count we can't make says nothing */ }
      }
      return { ok: true, retentionDays, days, chats, trimmed, messages };
    },

    /** A new random safety_identifier for the providers that take one (OpenAI; §7.2, §13.1; final review L5-6). */
    async regenerateSafetyId() {
      if (typeof S.backend?.regenerateSafetyId !== 'function') return { ok: false, error: 'unsupported' };
      if (Object.hasOwn(B(), 'safetyId')) { delete B().safetyId; persist(); } // a pinned one would keep winning
      try { S.backend.regenerateSafetyId(); } catch { return { ok: false, error: 'failed' }; }
      log('app-safety-id', { regenerated: true });
      return { ok: true };
    },

    async findWow() {
      const list = installs();
      const cur = config.wow.flavorDir;
      const pick = list.find(w => w.flavorDir === wowPick) ?? list.find(w => w.flavorDir === cur) ?? list[0] ?? null;
      const running = await wowRunningNow(true);
      if (!pick) { lastFind = { found: false, running, candidates: [] }; return { found: false, running, candidates: [] }; }
      lastFind = {
        found: true, path: pick.flavorDir, running,
        candidates: list.map(w => ({ path: w.flavorDir, ...(w.version ? { version: w.version } : {}), ...(w.account ? { account: w.account } : {}), addon: addonAt(w.flavorDir) })),
      };
      return {
        found: true, path: pick.flavorDir, flavor: pick.flavor, ...(pick.version ? { version: pick.version } : {}), ...(pick.account ? { account: pick.account } : {}),
        running, addon: addonAt(pick.flavorDir),
        candidates: list.map(w => ({ path: w.flavorDir, flavor: w.flavor, ...(w.version ? { version: w.version } : {}), ...(w.account ? { account: w.account } : {}), addon: addonAt(w.flavorDir) })),
      };
    },

    /**
     * "Choose folder…" (D-09): the folder the player picked in the shell's native dialog. It must
     * hold a Forever client (the folder itself, or its flavor folder under it), found by the same
     * rules as findWow; then findWow offers it (picked) and installAddon accepts it.
     */
    async useWowFolder(dir) {
      if (typeof dir !== 'string' || !dir || dir.length > 1024 || /[\u0000-\u001f]/.test(dir) || !path.isAbsolute(dir)) return bad('dir');
      const d = path.resolve(dir);
      let list = [];
      try { list = (wow.find ?? findWow)({ platform, env, home, roots: [d, path.dirname(d)], run: wow.run }); } catch { list = []; }
      const here = list.filter(w => w.flavorDir === d || path.dirname(w.flavorDir) === d);
      if (!here.length) { badFolder = true; changed(); return { ok: false, error: 'not_wow', detail: 'That folder doesn’t have World of Warcraft: Forever in it. Pick the folder the game is installed in.' }; }
      badFolder = false;
      if (inst && inst.state !== 'installing') inst = null;
      chosenRoots.add(path.dirname(here[0].flavorDir));
      wowPick = here[0].flavorDir;
      log('app-wow-folder', { flavor: here[0].flavor });
      return { ok: true, ...(await api.findWow()) };
    },

    async installAddon(v = {}) {
      const o = isObj(v) ? v : {};
      let target = null;
      if (o.flavorDir !== undefined) {
        const found = await api.findWow();
        const known = [config.wow.flavorDir, ...(found.candidates ?? []).map(c => c.path)];
        if (!known.includes(o.flavorDir)) return { ok: false, error: 'wow_not_found' };
        target = o.flavorDir;
      } else {
        const found = await api.findWow();
        target = found.found ? found.path : (config.wow.flavorDir && isDir(config.wow.flavorDir) ? config.wow.flavorDir : null);
      }
      if (!target) return { ok: false, error: 'wow_not_found', detail: 'NeverQuestAlone couldn’t find World of Warcraft: Forever.' };
      const r = (wow.install ?? installAddon)({ flavorDir: target, platform, run: wow.run, tighten: o.tighten === true, addonSource: wow.addonSource, slots: slotsOf(config), configFile });
      wowSeen = { at: 0, running: false };
      if (!r.ok) { changed(); return clean({ ok: false, error: r.error, ...(r.detail ? { detail: r.detail } : {}), ...(r.steps ? { steps: r.steps } : {}) }); }
      if (target !== config.wow.flavorDir || !S.bridge) {
        config.wow.flavorDir = target;
        config.wow.account = '';
        persist();
        if (typeof restart === 'function') {
          try { await restart(); } catch (e) { log('app-restart-failed', { error: scrub(e?.message).slice(0, 160) }); return { ok: false, error: 'restart_failed', detail: scrub(e?.message).slice(0, 200), steps: r.steps }; }
        }
      }
      changed();
      log('app-addon-installed', { steps: r.steps.length, iface: r.iface, partsFold: r.partsFold ?? null });
      const perms = r.permissions ? withCommand(r.permissions, path.join(target, 'Interface', 'AddOns')) : r.permissions;
      return clean({ ok: true, steps: r.steps, restartNeeded: true, restartLine: r.restartLine, permissions: perms });
    },

    async wowRunning() {
      return { running: await wowRunningNow(true) };
    },

    /**
     * Tighten the AddOns folder's permissions, and nothing else (D-29): the TH12 check with
     * tighten, which removes group and world write from the folders this account owns. No reinstall,
     * so WoW may be running. → {ok: true, permissions: (after), fixed: [paths]} | {ok: false, error}.
     */
    async tightenAddonPermissions() {
      const ad = addonsDir();
      if (!ad || !isDir(ad)) return { ok: false, error: 'wow_not_found' };
      let perm;
      try { perm = (wow.permissions ?? checkAddonsPermissions)(ad, { platform, run: wow.run ?? spawnSync, tighten: true }); } catch { return { ok: false, error: 'failed' }; }
      log('app-permissions-tightened', { fixed: Array.isArray(perm?.fixed) ? perm.fixed.length : 0, ok: perm?.ok ?? null });
      return clean({ ok: true, permissions: withCommand(perm, ad) });
    },

    /**
     * The AddOns folder's permissions, checked now (TH12; the window's Diagnostics card, D-23):
     * {ok: true, permissions: {ok, fixable, detail, paths, command}} (permissions.ok null: couldn't
     * tell), or {ok: true, permissions: null} with no WoW folder. command: adminCommand's.
     */
    async addonPermissions() {
      const ad = addonsDir();
      if (!ad || !isDir(ad)) return { ok: true, permissions: null };
      let perm;
      try { perm = (wow.permissions ?? checkAddonsPermissions)(ad, { platform, run: wow.run ?? spawnSync }); } catch { return { ok: false, error: 'failed' }; }
      return clean({ ok: true, permissions: withCommand(perm, ad) });
    },

    /**
     * Restart screen reading (display DR-06, the screen card's one action for no_signal). The watchdog
     * counts its backoff from this restart (the core's captureHealth.reset()), so it doesn't start the
     * helper over again right after. A helper that isn't running (missing, a socket that wouldn't open,
     * one waiting on its backoff) is tried again at once with its backoff started over (retryNow()); a
     * running one is started over (restart(): the Mac's socket dropped, the Windows child killed, either
     * relaunched as after any exit). One or the other, never both: a start waiting on its backoff isn't
     * tried twice. No probe: the next strip payload (the addon's self-probe, or the player's next
     * message) clears what is published. → { ok: true, restarted } | { ok: false, error: 'no_capture' }
     */
    async restartCapture() {
      if (!S.capture) return { ok: false, error: 'no_capture' };
      try { S.bridge?.captureHealth?.reset(); } catch { /* the helper starts over anyway */ }
      let restarted = false;
      try { restarted = S.capture.retryNow?.() === true; } catch { restarted = false; }
      if (!restarted) {
        try { restarted = S.capture.restart?.('the app\'s Restart screen reading') === true; } catch { restarted = false; }
      }
      log('app-capture-restart', { restarted });
      changed();
      return { ok: true, restarted };
    },

    /**
     * Resume sending (systems plan D4): the typed guard paused sending after more than its limit of
     * typed messages at machine speed; the player's press here is the only thing that ends it (a
     * typed message can't: the loop is made of them). → {ok: true} | {ok: false, error: 'not_paused'|'unsupported'}
     */
    async resumeSending() {
      let bst = null;
      let bk = null;
      try { bst = S.bridge?.status?.() ?? null; } catch { bst = null; }
      try { bk = S.backend?.status?.() ?? null; } catch { bk = null; }
      if (!sendingPausedOf(bst, bk)) return { ok: false, error: 'not_paused' };
      const target = typeof S.bridge?.resumeSending === 'function' ? S.bridge : typeof S.backend?.resumeSending === 'function' ? S.backend : null;
      if (!target) return { ok: false, error: 'unsupported' };
      try { await target.resumeSending(); } catch { return { ok: false, error: 'failed' }; }
      log('app-resume-sending', {});
      changed();
      return { ok: true };
    },

    async setPaused(paused) {
      try { S.backend?.pause?.(paused); } catch { return { ok: false, error: 'failed' }; }
      changed();
      return { ok: true, paused };
    },

    async diagnostics() {
      // The transport's counts (SY-08, SY-18): what the slot writes and the doorbells met (the NTFS
      // retries on Windows), whether the last publish was read, and what the store couldn't read.
      const transportLine = () => {
        let b = null;
        try { b = S.bridge?.status?.() ?? null; } catch { b = null; }
        if (!b) return 'no bridge';
        const p = b.publishes ?? {};
        const n = v => (Number.isFinite(v) ? v : 0);
        const probs = Array.isArray(b.store?.problems) ? b.store.problems.map(x => `${x.file ?? '?'}:${x.error ?? '?'}`) : [];
        return [
          `push ${n(b.push)} (ok ${n(b.pushOk)})`,
          `unread ${Math.round(n(b.reading?.unreadMs) / 1000)} s`,
          `publishes ${n(p.publishes)}, last ${n(p.lastFiles)} files in ${n(p.ms)} ms`,
          `slot errors ${n(p.slotErrors)}, retries ${n(p.slotRetries)}`,
          `bell errors ${n(b.signalErrors)}, retries ${n(b.signalRetries)}`,
          `window ${b.slotWindow ? `${b.slotWindow.mode} ${b.slotWindow.from}-${b.slotWindow.to}` : 'all'}`,
          `store ${probs.length ? `moved aside ${probs.join(' ')}` : 'ok'}${b.store?.behind ? ', caught up' : ''}`,
        ].join(' · ');
      };
      const st = await api.status();
      // The first reply's first words, which setup's last screen quotes (status().setup.firstWords),
      // stay out: a bundle carries no message or reply text (PRIVACY.md, the README), only their length.
      if (isObj(st.setup)) {
        const words = st.setup.firstWords;
        delete st.setup.firstWords;
        st.setup.firstWordsLength = typeof words === 'string' ? words.length : 0;
      }
      let bd = null;
      try { bd = S.backend?.diagnostics?.() ?? null; } catch { bd = null; }
      const tokens = Object.keys(S.bridge?.store?.state?.tokens ?? {});
      const cfg = { wow: { flavorDir: config.wow.flavorDir ?? null }, byok: { ...B() } };
      const conns = egress?.ledger?.() ?? [];
      const lines = [
        `== ${PRODUCT} (bridge) ==`,
        `bridge ${BRIDGE_VERSION}${version ? ` · app ${version}` : ''} · Node ${process.versions.node}${process.versions.electron ? ` · Electron ${process.versions.electron}` : ''}`,
        `${platform} ${os.release()} ${process.arch}`,
        `keys: ${keystore.label ?? keystore.backend ?? 'key store'}${keystoreNote ? ` (${keystoreNote})` : ''}`,
        `config: ${JSON.stringify(cfg)}`,
        `status: ${JSON.stringify(st)}`,
        `slots: ${addonsDir() ? countSlots(addonsDir()) : 0} of ${slotsOf(config)}`,
        `connections: ${conns.map(r => `${r.allowed ? '' : 'refused '}${r.host}:${r.port ?? '?'} ×${r.count} (${r.feature})`).join(', ') || 'none'}`,
        `transport: ${transportLine()}`,
        `capture: ${(() => { try { return JSON.stringify(S.bridge?.status?.()?.capture ?? null); } catch { return 'null'; } })()}`,
        `backend: ${JSON.stringify(bd)}`,
        '',
        '== Last log lines ==',
        ...[].concat(logLines() ?? []).slice(-200).map(String),
      ];
      let text = scrubHome(lines.join('\n'));
      text = redact(text, tokens);
      return { text };
    },

    async uninstall(v = {}) {
      const removeAddon = v?.removeAddon === true;
      if (removeAddon && await wowRunningNow(true)) return { ok: false, error: 'wow_running', detail: RUNNING_LINE };
      const removed = [];
      let keys = 0;
      // Every provider's key, and one saved for an AI Other (custom) replaced (an OpenRouter key boot couldn't move).
      for (const id of [...manifests.filter(m => !m.local).map(m => m.id), ...Object.keys(LEGACY_CUSTOM)]) {
        try { if (await keystore.delete(id)) keys += 1; } catch { /* nothing saved, or the store is gone */ }
        masks.set(id, null);
      }
      removed.push('keys');
      // Stop everything that writes (capture, the core's slots and state, the backend's ledger and
      // history) first, so nothing is made again behind the removal. boot's halt also keeps its
      // own stop() from writing them once more at quit.
      if (typeof halt === 'function') { try { await halt(); } catch (e) { log('app-uninstall-halt-failed', { error: scrub(e?.message ?? e).slice(0, 120) }); } } else {
        try { S.capture?.stop?.(); } catch { /* stopping */ }
        try { if (S.bridge) await S.bridge.stop?.(); else await S.backend?.stop?.(); } catch { /* stopping */ }
      }
      S.capture = null;
      S.bridge = null;
      S.backend = null;
      // App data (§16.3, OB-3): what the bridge keeps in the data folder. The desktop shell then
      // removes the folder itself, the logs and the caches when it quits (app/desktop/src/uninstall.mjs).
      const gone = removeAppData();
      removed.push('data');
      if (removeAddon && addonsDir() && isDir(addonsDir())) {
        const ad = addonsDir();
        let n = 0;
        for (const name of fs.readdirSync(ad)) {
          if (isAddonFolder(name)) {
            fs.rmSync(path.join(ad, name), { recursive: true, force: true });
            n += 1;
          }
        }
        removed.push('addon', 'slots', 'doorbells');
        log('app-uninstall-addon', { folders: n });
      }
      // The game's own copy of the chats (code health AP-11): every WoW account's
      // SavedVariables/NeverQuestAlone.lua and its .bak, by the Windows uninstaller's rule
      // (app/desktop/build/installer.nsh un.bonesCleanFlavor), so Uninstall leaves none in WoW on
      // either OS. WoW isn't running (checked above), so it can't write them back at logout.
      if (removeAddon && config.wow.flavorDir) {
        const accounts = path.join(config.wow.flavorDir, 'WTF', 'Account');
        let names = [];
        try { names = fs.readdirSync(accounts); } catch { /* no accounts folder: nothing saved */ }
        let files = 0;
        for (const account of names) {
          for (const name of [`${ADDON_NAME}.lua`, `${ADDON_NAME}.lua.bak`]) {
            const file = path.join(accounts, account, 'SavedVariables', name);
            try { fs.lstatSync(file); } catch { continue; }
            try { fs.rmSync(file, { force: true }); files += 1; } catch (e) { log('app-uninstall-saved-failed', { error: scrub(e?.code ?? e?.message ?? e).slice(0, 60) }); }
          }
        }
        if (files) removed.push('savedVariables');
        log('app-uninstall-saved', { files });
      }
      log('app-uninstall', { keys, data: gone });
      return { ok: true, removed };
    },

    // ---------------------------------------------------------------- setup (onboarding spec §9.3)

    /**
     * The AI company's terms, agreed to in setup's dialog (the version it showed). Recorded before
     * the first request to that company: testStagedKey refuses without it.
     */
    async recordTerms(provider, v) {
      const m = visible(provider);
      if (!m || m.local || isCustom(m)) return bad('provider');
      const want = displayOf(m).termsVersion;
      const ver = Number.isInteger(v) && v > 0 ? v : want;
      B().terms[m.id] = { at: now(), v: ver };
      persist();
      log('app-terms', { provider: m.id, v: ver });
      return { ok: true, v: ver };
    },

    /**
     * Save a key that passed setup's test (or, with noCredit, one whose company documents "no
     * credit yet", on a first key only: T1), and use it. The first key for an AI that isn't in use
     * picks its default model (thinking low). → {ok, masked, model, first} | {ok: false, error}.
     */
    async connect(provider, key, o = {}) {
      const m = visible(provider);
      if (!m || m.local || isCustom(m) || isSignIn(m)) return bad('provider');
      const k = typeof key === 'string' ? key.trim() : null;
      const problem = keyProblem(m, k);
      if (problem) return problem;
      let had = false;
      try { had = !!(await keystore.get(provider)); } catch { had = false; }
      const noCredit = o?.noCredit === true;
      if (noCredit && had) return { ok: false, error: 'bad_input', detail: 'noCredit is for a first key only' };
      try { await keystore.set(provider, k); } catch (e) { return { ok: false, error: 'keystore_error', code: e?.code ?? null }; }
      masks.set(provider, maskKey(k));
      B().authBy[provider] = 'key';
      if (noCredit) B().keyState[provider] = { state: 'no_credit', at: now(), turns: Number(S.backend?.status?.()?.usage?.turns) || 0 };
      else delete B().keyState[provider];
      const inUse = B().provider === provider && had;
      let model = B().provider === provider ? B().model : null;
      if (!inUse) {
        const want = m.models?.default;
        const r = await api.choose({ provider, model: want, effort: startEffort(m, want) });
        if (r?.ok !== true) { persist(); changed(); return { ok: false, error: 'failed', saved: true }; }
        model = want;
      } else {
        if (B().auth !== 'key') {
          B().auth = 'key';
          try { await S.backend?.setConfig?.({ auth: 'key' }); } catch { /* refresh below */ }
        }
        persist();
        try { await S.backend?.refresh?.({ keyChanged: true }); } catch (e) { log('app-refresh-failed', { error: scrub(e?.message).slice(0, 120) }); }
      }
      if (!noCredit && B().provider === provider) afterPassingTest();
      changed();
      log('app-connect', { provider, first: !had, noCredit });
      return { ok: true, masked: maskKey(k), model: modelLabel(m, model), first: !had };
    },

    /**
     * Use the key saved for an AI (Connect <AI>, returning): one tiny test of it, setup's way, then
     * the AI is the one in use. → {ok, masked, testCall} | a setup failure | {ok:false, error:'read_failed'}.
     */
    async useSavedKey(provider) {
      const m = visible(provider);
      if (!m || m.local || isCustom(m)) return bad('provider');
      if (!termsOk(m)) return { ok: false, error: 'terms_required' };
      let key = null;
      try { key = await keystore.get(provider); } catch { return { ok: false, error: 'read_failed' }; }
      if (!key) return { ok: false, error: 'no_key' };
      const t = await runTest(m, async () => key, { saved: true, context: 'setup' });
      if (t?.ok === true && isSignIn(m)) {
        if (B().provider !== provider) {
          const want = m.models?.default;
          const r = await api.choose({ provider, model: want, effort: startEffort(m, want) });
          if (r?.ok !== true) return { ok: false, error: 'failed' };
        }
        changed();
        return { ok: true, signedIn: true, testCall: t.testCall };
      }
      if (t?.ok !== true) return t;
      if (B().provider !== provider) {
        const want = m.models?.default;
        const r = await api.choose({ provider, model: want, effort: startEffort(m, want) });
        if (r?.ok !== true) return { ok: false, error: 'failed' };
      }
      changed();
      return { ok: true, masked: maskKey(key), testCall: t.testCall };
    },

    /**
     * Sign in with a plan (ChatGPT): the player's own browser opens the company's sign-in page (the
     * shell's opener, which takes that page's URL only), a listener on 127.0.0.1 catches the redirect,
     * the code becomes tokens, one tiny test request runs, and the plan becomes the AI in use. Its
     * terms are recorded first (setup's dialog, recordTerms), as a key's are.
     * → {ok, plan, model, testCall} | {ok:false, error: provider|terms_required|unsupported|
     *   port_busy|browser_failed|cancelled|timeout|network|sign_in_failed|keystore_error|<a setup failure>}.
     */
    async signIn(provider) {
      const m = visible(provider);
      const session = m ? signIns?.for(m) : null;
      if (!m || !session) return bad('provider');
      if (!termsOk(m)) return { ok: false, error: 'terms_required' };
      if (typeof openExternal !== 'function') return { ok: false, error: 'unsupported' };
      const openUrl = async (url) => {
        if (!isAuthorizeUrl(url)) throw new Error('not the sign-in page');
        await openExternal(url);
      };
      // The sign-in service (the token exchange) and the plan's own host, for this one job.
      const release = egress?.widen?.(m.hosts ?? [], 'sign_in') ?? (() => {});
      let r;
      try { r = await session.start({ openUrl }); } finally { release(); }
      if (r?.ok !== true) { log('app-signin-failed', { provider: m.id, error: r?.error ?? 'failed' }); return r ?? { ok: false, error: 'failed' }; }
      masks.set(m.id, 'signed-in');
      B().authBy[m.id] = 'oauth';
      delete B().keyState[m.id];
      persist();
      const t = await runTest(m, null, { saved: true, context: 'setup' });
      if (t?.ok !== true) { changed(); return t; }
      let model = B().provider === m.id ? B().model : null;
      if (B().provider !== m.id) {
        const want = m.models?.default;
        const c = await api.choose({ provider: m.id, model: want, effort: startEffort(m, want) });
        if (c?.ok !== true) { changed(); return { ok: false, error: 'failed', saved: true }; }
        model = want;
      } else {
        B().auth = 'oauth';
        try { await S.backend?.setConfig?.({ auth: 'oauth' }); } catch { /* refresh below */ }
        persist();
        try { await S.backend?.refresh?.({ keyChanged: true }); } catch { /* status only */ }
      }
      afterPassingTest();
      changed();
      log('app-signin', { provider: m.id, plan: r.plan ?? null });
      return { ok: true, plan: r.plan ?? null, model: modelLabel(m, model), testCall: t.testCall };
    },

    /** Stop a sign-in waiting on the browser (the window's Cancel). */
    async cancelSignIn(provider) {
      const m = visible(provider);
      const session = m ? signIns?.for(m) : null;
      if (!session) return bad('provider');
      session.cancel();
      return { ok: true };
    },

    /** Setup's Install: the addon into the install the row shows (or the player's pick). */
    async setupInstall(v = {}) {
      disarm();
      const found = await api.findWow();
      const target = typeof v?.flavorDir === 'string' ? v.flavorDir : found.path;
      if (!target || ![found.path, ...(found.candidates ?? []).map(c => c.path)].includes(target)) return { ok: false, error: 'wow_not_found' };
      if (found.running) return { ok: false, error: 'wow_running', detail: RUNNING_LINE };
      return setupInstall(target);
    },

    /**
     * Install when WoW closes (PF-5): for the one install found, or the player's pick. Every
     * ARM_POLL_MS it asks whether WoW runs; the first time it doesn't, the addon installs once. In
     * memory only: a quit disarms it.
     */
    async armInstall(v = {}) {
      const found = await api.findWow();
      const cands = found.candidates ?? [];
      const target = typeof v?.flavorDir === 'string' ? v.flavorDir : (cands.length <= 1 ? found.path : null);
      if (!target || ![found.path, ...cands.map(c => c.path)].includes(target)) return { ok: false, error: 'wow_not_found' };
      disarm();
      if (inst && inst.state !== 'installing') inst = null;
      if (!(await wowRunningNow(true))) return setupInstall(target);
      const a = { path: target, at: now(), timer: null, busy: false };
      a.timer = setInterval(async () => {
        if (armed !== a || a.busy) return;
        a.busy = true;
        try {
          if (await wowRunningNow(true)) return;
          disarm();
          await setupInstall(target);
        } finally { a.busy = false; }
      }, ARM_POLL_MS);
      a.timer.unref?.();
      armed = a;
      changed();
      log('app-install-armed', {});
      return { ok: true, armed: true, path: target };
    },

    /** Cancel an install armed for when WoW closes. */
    async cancelInstall() {
      const was = !!armed;
      disarm();
      changed();
      return { ok: true, cancelled: was };
    },

    /** Start WoW's launcher: {found, path} (the shell opens it; this only says where it is). */
    async launcher() {
      launcherCache = launcherOf();
      return launcherCache;
    },

    /**
     * Ask macOS for Screen Recording (Allow): the helper's own request, as a new instance, which
     * shows macOS's box once and waits up to 2 minutes for the answer. The call returns at once;
     * the row reads "asked" meanwhile and ticks when a check says yes.
     */
    async requestScreenPermission() {
      if (platform !== 'darwin') return { ok: false, error: 'unsupported' };
      const runner = screenRunner();
      if (!runner) return { ok: false, error: 'unsupported' };
      config.capture.permissionRequestedAt = now();
      windowHere();
      persist();
      changed();
      if (!requesting) {
        if (probe.permission === null) probe = { permission: false, at: now() }; // asking: not yet
        requesting = runner.request().then(r => notePermission(r, 'request')).catch(() => null).finally(() => { requesting = null; changed(); });
      }
      return { ok: true, requestedAt: config.capture.permissionRequestedAt };
    },

    /** Check Screen Recording now (fresh), or say what the last check found. */
    async screenPermission(o = {}) {
      if (platform !== 'darwin') return { ok: true, permission: null };
      if (o?.fresh === true) windowHere(); // main.mjs, when the window gets focus
      if (o?.fresh === true || !probe.at || now() - probe.at > PERMISSION_LOOP_MS) await checkPermission();
      return { ok: true, permission: probe.permission, asked: Number.isFinite(config.capture.permissionRequestedAt) && now() - config.capture.permissionRequestedAt < ASKED_MS };
    },

    onChange(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async stop() {
      stopped = true;
      clearTimeout(pushTimer);
      listeners.clear();
      disarm();
      if (permLoop) { clearTimeout(permLoop); permLoop = null; }
    },

    // ---- for boot.mjs, not the window
    /** After boot restarts the bridge (a new WoW folder): the parts calls go to now. */
    rebind(parts = {}) {
      for (const k of ['bridge', 'backend', 'capture']) if (Object.hasOwn(parts, k)) S[k] = parts[k] ?? null;
      changed();
    },
    changed,
  };
  return api;
}
