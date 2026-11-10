// Bridge configuration (PRD Appendix A; BYOK PRD §8.1, §9.4, §13.1, SL-6; BUILD-PLAN "config").
// Everything has a default, so a file only needs what differs. The desktop app keeps its config at
// <userData>/config.json, written by saveConfig; the developer command line (bridge/nqa.mjs) at
// <its data folder>/config.json; bridge/config.json (gitignored) is a checkout's own, for the tools
// that run from it (tools/shotproof). No WoW folder is a default: the app finds one (bridge/byok/wow.mjs
// findWow), and everything else is told which.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IDENTITY } from './identity.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(REPO, 'bridge', 'config.json');

export const DEFAULTS = {
  // No folder by default (a default would be a real game's folder on some machine).
  wow: { flavorDir: null, account: '' },
  // deflate: the addon may send the game state deflated for the strip (cap z, PROTOCOL §2.6); false asks for plain JSON.
  transport: { slots: 200, deflate: true },
  // app: a checkout's own capture app (bridge/capture/mac/build-app.sh), named as the app's identity
  // names its helper (none: an app without one). teamId: a Developer ID team the capture app may be
  // signed by, besides your local identity (PF-6).
  capture: { enabled: true, intervalMs: 250, app: IDENTITY.captureHelper ? `bridge/capture/mac/build/${IDENTITY.captureHelper.app}.app` : null, teamId: null },
  // The player's AI and its settings (read by bridge/byok/backend.mjs settingsOf and the app API).
  // provider/model/effort: Claude until setup connects an AI (no key: setup's first screen), effort
  // low (DB22): a WoW turn runs at it unless its chat has a /bones think of its own. custom: Other's
  // {baseUrl, model} (providers/index.mjs customManifest), set when provider is 'custom'. auth:
  // 'key', or 'oauth' for a plan that signs in (ChatGPT plan; authBy per provider).
  // caps: the player's own daily spend cap (§9.4, DB8), none by default: the public build has no usage
  // limits of its own (maintainer, 2026-09-26; migrateByokCaps below, which adds v: 2; never here, or an old
  // section merged with the defaults would pass for a migrated one). privacy: DB14 / §13.1, the one place
  // the player's switches live (the core reads companion and gameContext from here: code health BR-28);
  // companion: automatic turns (game events start a turn in the Companion chat, PROTOCOL §2.6, with no
  // daily or zone limit, only the runaway fuse), off until the player opts in.
  // transcripts: RT-6.
  byok: {
    provider: 'anthropic',
    model: null,
    effort: 'low',
    auth: 'key',
    authBy: {},
    persona: { name: 'NeverQuestAlone' },
    caps: { dailyUsd: null },
    privacy: { identity: false, otherNames: false, companion: false, echo: false, gameContext: true },
    transcripts: { retentionDays: 30 },
  },
};

function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k]) && v && typeof v === 'object' && !Array.isArray(v)) ? merge(a[k], v) : v;
  return out;
}

/** The daily spend cap the app pre-filled before 2026-09-26, in USD (migrateByokCaps drops it). */
export const OLD_DEFAULT_DAILY_USD = 1;

/**
 * The public build's byok.caps from 2026-09-26 on, when the maintainer dropped the build's own limits ("no
 * limits on anything for public release"; spec §9.9, PRD §9.4): {v: 2, dailyUsd: <USD>|null}, plus
 * the per-turn ceiling fields when a config names them. A section with no v: 2 is from the capped
 * build (tester installs), which pre-filled dailyUsd with the old default and saved it with the
 * rest: typedPerDay and autoPerDay go, dailyUsd goes when it's the old default, $1.00, and any other
 * amount stays (the player chose it; $0 included). One marked setBy: 'player' (a build between the
 * two) was the player's whatever the amount. A section with v: 2 is as the player left it. Boot
 * writes the result back once (v: 2), so it runs once; setCaps writes v: 2 too.
 */
export function migrateByokCaps(caps) {
  const c = caps && typeof caps === 'object' && !Array.isArray(caps) ? caps : {};
  const amount = typeof c.dailyUsd === 'number' && Number.isFinite(c.dailyUsd) && c.dailyUsd >= 0;
  const keep = amount && (c.v === 2 || c.setBy === 'player' || c.dailyUsd !== OLD_DEFAULT_DAILY_USD);
  const out = { v: 2, dailyUsd: keep ? c.dailyUsd : null };
  for (const k of ['perTurnInput', 'perTurnOutput']) if (Number.isInteger(c[k]) && c[k] >= 0) out[k] = c[k];
  return out;
}

/**
 * The providers Other (custom) replaced on 2026-09-29, by the base URL of their OpenAI-compatible
 * endpoint and the model they defaulted to: a saved choice of one loads as Other with that URL.
 */
export const LEGACY_CUSTOM = Object.freeze({
  openrouter: Object.freeze({ baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' }),
  ollama: Object.freeze({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' }),
  lmstudio: Object.freeze({ baseUrl: 'http://127.0.0.1:1234/v1', model: null }),
});

/**
 * A byok section saved when OpenRouter, Ollama or LM Studio was an AI of its own, as Other (custom):
 * provider 'custom' with custom {baseUrl, model} (the saved model, else the old default), auth
 * 'key'. OpenRouter was also the no-key default, so it moves only when a key was saved for it
 * (openRouterKey: the caller looked in the key store; boot moves that key to 'custom'); otherwise
 * the section starts on the new default. Every other section comes back as it was.
 * → {byok, from: <old id> | null}
 */
export function migrateLegacyProvider(byok, { openRouterKey = false } = {}) {
  const b = byok && typeof byok === 'object' && !Array.isArray(byok) ? byok : {};
  const from = typeof b.provider === 'string' && Object.hasOwn(LEGACY_CUSTOM, b.provider) ? b.provider : null;
  if (!from) return { byok: b, from: null };
  const out = { ...b };
  for (const k of ['authBy', 'terms', 'keyState']) {
    if (out[k] && typeof out[k] === 'object') { out[k] = { ...out[k] }; for (const id of Object.keys(LEGACY_CUSTOM)) delete out[k][id]; }
  }
  out.auth = 'key';
  if (from === 'openrouter' && !openRouterKey) {
    out.provider = DEFAULTS.byok.provider;
    out.model = null;
    return { byok: out, from };
  }
  const legacy = LEGACY_CUSTOM[from];
  const model = typeof b.model === 'string' && b.model ? b.model : legacy.model;
  out.provider = 'custom';
  out.model = model;
  out.custom = { baseUrl: legacy.baseUrl, model };
  return { byok: out, from };
}

/** A config (a loaded one, or a partial one) with every default filled in, as a fresh copy. */
export function configWithDefaults(user = {}) {
  return structuredClone(merge(DEFAULTS, user));
}

/**
 * NeverQuestAlone's load (SY-12): a config.json that can't be read or parsed is moved aside to
 * config.json.corrupt-<ms> and the app starts on the defaults, instead of failing at every start.
 * → {config, reset: {keptAs} | null} (keptAs: the moved file, or null if it couldn't be moved).
 * loadConfig itself refuses one (the developer command line's): a developer fixes the file.
 */
export function loadConfigOrReset(file = CONFIG_FILE, { now = Date.now } = {}) {
  try { return { config: loadConfig(file), reset: null }; } catch {
    const keptAs = `${file}.corrupt-${now()}`;
    let moved = false;
    try { fs.renameSync(file, keptAs); moved = true; } catch { /* left in place: a save then fails, and is logged */ }
    return { config: fromUser({}), reset: { keptAs: moved ? keptAs : null } };
  }
}

export function loadConfig(file = CONFIG_FILE) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`); }
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error(`${file}: not a settings object`);
  return fromUser(user);
}

function fromUser(user) {
  // Only the sections the bridge reads: the M0 spike's upstream-shaped keys (addonDir, slots, …) and
  // an older build's are ignored: gateway, owner, backend, and the knobs nothing read or the player's
  // privacy switches overwrote (code health BR-28): logLevel, sessions (its thinking level),
  // gameContext and companion (byok.privacy's gameContext and companion are the switches). A file
  // keeps them (saveConfig writes only wow and byok); nothing loads them.
  return merge(DEFAULTS, { wow: user.wow, transport: user.transport, capture: user.capture,
    ...(user.byok !== undefined ? { byok: user.byok } : {}) });
}

/**
 * Write the parts of a config the app changes (wow, byok) into its file, keeping every other key
 * the file has. Atomic (a temp file renamed over it) and 0600: it names no key, but it
 * says which provider and what spend cap the player set, which is the player's business.
 */
export function saveConfig(cfg, file = CONFIG_FILE) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`); }
  if (!user || typeof user !== 'object' || Array.isArray(user)) user = {};
  const out = { ...user };
  if (cfg.wow) out.wow = { ...(user.wow || {}), ...cfg.wow };
  if (cfg.byok) out.byok = JSON.parse(JSON.stringify(cfg.byok));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: the per-user folder's ACL */ }
  fs.renameSync(tmp, file);
  return file;
}
