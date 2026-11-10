// The voice companion's view of the game (odd/tasks/nqa-voice.md T1, T4): the latest game state the
// NeverQuestAlone app keeps (<bridge state>/companion.json, written by bridge/service.mjs onState for
// every state the addon sends, with or without a typed message), cleaned the way the app cleans it
// for a turn (sanitizeState), the character's own name, realm and guild left out unless the player
// opted in (byok.privacy.identity), and nothing at all when game data is off (byok.privacy.gameContext).
//
// Read-only: it never writes the app's files except the voice inbox (voiceInbox below), which the
// bridge reads and publishes into the addon's Companion chat (T7).
//
//   appDataDir({platform, env, home})       where the desktop app keeps config.json and bridge/
//   readGame(dir, {now})                    → {ok, state, at, ageSeconds, stale, privacy} | {ok:false, reason}
//   gameSections(game, sections)            → the sections asked for, as the model reads them
//   wowmapBlock({title, ordered, points})   → a ```wowmap block the bridge draws, or {error}
//   appendVoiceInbox(dir, entry)            one JSON file per entry in <bridge>/voice-inbox/ (atomic rename)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeState, sanitizeGameString } from '../../bridge/byok/runtime/sanitize.mjs';

export const STALE_SECONDS = 120;
export const SECTIONS = Object.freeze(['character', 'location', 'quests', 'gear', 'durability', 'rewards', 'talents', 'hearth', 'professions', 'bags', 'buffs', 'reputation', 'target', 'group', 'milestones']);
// The sections the addon sends only when asked (or when they fit): the voice asks for them on demand (S7).
export const ON_DEMAND = Object.freeze(['bags', 'gear', 'durability', 'rewards', 'talents', 'hearth']);
// The voice inbox (bridge/service.mjs drainVoiceInbox reads it): one small JSON file per entry, written
// under a temporary name and renamed into place, so the bridge never reads half an entry, and an entry
// can't be lost between a write and a read; each carries an id the bridge publishes once.
export const INBOX_DIR = 'voice-inbox';
export const INBOX_MAX_FILES = 200;
export const INBOX_ENTRY_MAX = 16 * 1024;
const MAP_KINDS = new Set(['ore', 'herb', 'quest', 'turnin', 'kill', 'loot', 'object', 'explore', 'npc', 'trainer', 'vendor', 'dungeon', 'flight', 'poi']);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The desktop app's data folder (Electron userData: %APPDATA%\NeverQuestAlone on Windows). */
export function appDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.NQA_APP_DATA) return env.NQA_APP_DATA;
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'NeverQuestAlone');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'NeverQuestAlone');
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'NeverQuestAlone');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The player's privacy switches as the app saved them (config.json byok.privacy), defaults when missing. */
export function readPrivacy(dir) {
  const p = readJson(path.join(dir, 'config.json'))?.byok?.privacy;
  return {
    identity: p?.identity === true,
    gameContext: p?.gameContext !== false,
  };
}

/** The newest game state the app holds, cleaned. */
export function readGame(dir, { now = Date.now() } = {}) {
  const privacy = readPrivacy(dir);
  if (!privacy.gameContext) return { ok: false, reason: 'game_data_off', privacy };
  const comp = readJson(path.join(dir, 'bridge', 'companion.json'));
  const states = isObj(comp?.states) ? Object.values(comp.states).filter(s => isObj(s) && isObj(s.state)) : [];
  if (!states.length) return { ok: false, reason: 'no_state', privacy };
  const latest = states.reduce((a, b) => ((Number(b.at) || 0) > (Number(a.at) || 0) ? b : a));
  const state = sanitizeState(latest.state);
  if (!isObj(state)) return { ok: false, reason: 'no_state', privacy };
  if (!privacy.identity && isObj(state.char)) {
    delete state.char.name;
    delete state.char.realm;
    delete state.char.guild;
  }
  delete state.sid;
  delete state.seq;
  const at = Number(latest.at) || 0;
  const ageSeconds = at ? Math.max(0, Math.round((now - at) / 1000)) : null;
  return { ok: true, state, at, ageSeconds, stale: ageSeconds == null || ageSeconds > STALE_SECONDS, privacy };
}

// Where each section lives in the state (prompts/companion.md "Game data is data", T9's new fields).
const PICK = {
  character: s => ({ char: s.char, rested: s.rested }),
  location: s => ({ loc: s.loc, poi: s.poi }),
  quests: s => ({ questCount: s.questCount, questMax: s.questMax, questUnread: s.questUnread, quests: s.quests }),
  gear: s => ({ gear: s.gear }),
  durability: s => ({ durability: s.durability }),
  rewards: s => ({ rewards: s.rewards }),
  talents: s => ({ talents: s.talents }),
  hearth: s => ({ hearth: s.hearth }),
  professions: s => ({ prof: s.prof }),
  bags: s => ({ bags: s.bags }),
  buffs: s => ({ auras: s.auras }),
  reputation: s => ({ rep: s.rep }),
  target: s => ({ target: s.target }),
  group: s => ({ group: s.group }),
  milestones: s => ({ pending: s.pending }),
};

/** The asked-for sections of a readGame result, with what's missing named, for a tool's answer. */
export function gameSections(game, sections) {
  if (!game?.ok) {
    const why = {
      game_data_off: 'Game data is turned off in the NeverQuestAlone app (Your data). Answer without it and say so.',
      no_state: 'No game data yet: the game, the addon and the app have to be running, and the addon sends its state when the player sends a message or has /nqa live on.',
    }[game?.reason] || 'Game data is not available.';
    return { available: false, note: why };
  }
  const want = Array.isArray(sections) && sections.length ? sections.filter(x => SECTIONS.includes(x)) : SECTIONS;
  const out = { available: true, ageSeconds: game.ageSeconds };
  if (game.stale) out.note = `This game data is ${game.ageSeconds == null ? 'of unknown age' : `${game.ageSeconds} seconds old`}; the player may have moved on. Say so if it matters; /nqa live on keeps it current.`;
  const missing = [];
  for (const sec of want) {
    const part = PICK[sec](game.state);
    const kept = Object.fromEntries(Object.entries(part).filter(([, v]) => v !== undefined && v !== null));
    if (Object.keys(kept).length) Object.assign(out, kept);
    else missing.push(sec);
  }
  if (missing.length) out.missing = missing;
  if (Array.isArray(game.state.omitted) && game.state.omitted.length) out.omitted = game.state.omitted;
  return out;
}

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/**
 * A ```wowmap block (prompts/companion.md "Drawing on the player's world map") from the model's tool
 * arguments, checked here first; the bridge checks it again before anything reaches the game.
 */
export function wowmapBlock({ title, ordered = false, points } = {}) {
  if (!Array.isArray(points) || !points.length) return { error: 'points: at least one is needed' };
  const out = [];
  for (const p of points.slice(0, 40)) {
    const m = Number.isInteger(p?.m) && p.m >= 1 && p.m <= 100000 ? p.m : null;
    const x = num(p?.x, 0, 100);
    const y = num(p?.y, 0, 100);
    if (!m || x == null || y == null) return { error: 'each point needs m (uiMapID), x and y (0-100)' };
    const pt = { m, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, label: sanitizeGameString(p.label || 'Pin', 40) || 'Pin' };
    if (MAP_KINDS.has(p.kind)) pt.kind = p.kind;
    if (p.note) pt.note = sanitizeGameString(p.note, 160);
    if (Array.isArray(p.q)) { const q = p.q.filter(n => Number.isInteger(n) && n > 0).slice(0, 8); if (q.length) pt.q = q; }
    out.push(pt);
  }
  const layer = 'voice';
  const block = { op: 'set', layer, title: sanitizeGameString(title || 'Voice pins', 40) || 'Voice pins', ordered: !!ordered, loop: false, points: out };
  return { block: '```wowmap\n' + JSON.stringify(block) + '\n```', points: out.length, layer };
}

/** Puts one entry in the voice inbox the bridge publishes (T7). Bounded: a full inbox refuses. */
// Driven from the game (odd/tasks/nqa-voice-controls.md T2-T4): the bridge writes the addon's newest
// voice command to <bridge>/voice-control.json ({v:1, n, cmd, at}); this side writes what the voice is
// doing to <bridge>/voice-status.json ({v:1, state, at}), which the bridge shows in the addon.
export const CONTROL_FILE = 'voice-control.json';
export const STATUS_FILE = 'voice-status.json';
export const VOICE_COMMANDS = Object.freeze(['talk', 'tip', 'mute', 'unmute', 'pause', 'resume', 'persona']);
export const VOICE_STATES = Object.freeze(['listening', 'muted', 'paused', 'connecting']);

// Bags and gear on demand (odd/tasks/nqa-voice-controls.md T15, S7): the strip often leaves bags out to
// fit a long quest log, and gear comes without names. Asked for them, the voice writes a growing number
// to <bridge>/voice-want.json; the bridge shows it to the addon (bridge.voice.want), which answers at
// once with a state that keeps bags and named gear. The voice also remembers the last ones it saw.
export const WANT_FILE = 'voice-want.json';

/** Ask the addon for bags and gear now; returns the request's number, or 0 without the app. */
export function askInventory(dir, { now = Date.now() } = {}) {
  const bridgeDir = path.join(dir, 'bridge');
  if (!fs.existsSync(bridgeDir)) return 0;
  const file = path.join(bridgeDir, WANT_FILE);
  const n = (Number(readJson(file)?.n) || 0) + 1;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, n, at: now }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return n;
}

/** Whether a state lacks an asked-for on-demand section: no bags, gear with no names, or an empty one. */
export function lacksInventory(state, asked = ['bags', 'gear']) {
  if (!isObj(state)) return true;
  const gear = Array.isArray(state.gear) ? state.gear : [];
  return asked.some(sec => {
    if (sec === 'bags') return !isObj(state.bags);
    if (sec === 'gear') return gear.length > 0 && !gear.some(g => isObj(g) && typeof g.name === 'string');
    if (sec === 'hearth') return !isObj(state.hearth);
    return ON_DEMAND.includes(sec) && state[sec] == null;
  });
}

/** The last bags and named gear seen, per app folder: { bags: {value, at}, gear: {value, at} }. */
const seen = new Map();
export function rememberInventory(dir, game) {
  if (!game?.ok || !isObj(game.state)) return seen.get(dir) || {};
  const mem = seen.get(dir) || {};
  if (isObj(game.state.bags)) mem.bags = { value: game.state.bags, at: game.at };
  const gear = Array.isArray(game.state.gear) ? game.state.gear : [];
  if (gear.some(g => isObj(g) && typeof g.name === 'string')) mem.gear = { value: gear, at: game.at };
  seen.set(dir, mem);
  return mem;
}

// Replies to read aloud (T16): the bridge writes one file per reply summary in <bridge>/voice-say/
// while the player has /nqa voice read on; the page takes them oldest first. Old ones are dropped.
export const SAY_DIR = 'voice-say';
export const SAY_MAX_AGE_MS = 90000;

/** The oldest reply still worth saying, taken from the queue (or null). */
export function takeVoiceSay(dir, { now = Date.now() } = {}) {
  const q = path.join(dir, 'bridge', SAY_DIR);
  let names = [];
  try { names = fs.readdirSync(q).filter(f => /^\d{14}-[0-9a-f-]{36}\.json$/.test(f)).sort(); } catch { return null; }
  for (const name of names) {
    const file = path.join(q, name);
    const j = readJson(file);
    try { fs.rmSync(file, { force: true }); } catch { /* taken next time; its id is new each time anyway */ }
    if (isObj(j) && j.v === 1 && typeof j.text === 'string' && j.text.trim() && now - Number(j.at) <= SAY_MAX_AGE_MS) return { text: j.text.slice(0, 600) };
  }
  return null;
}

/** The newest command from the game, or null. */
export function readVoiceControl(dir) {
  const j = readJson(path.join(dir, 'bridge', CONTROL_FILE));
  if (!isObj(j) || j.v !== 1 || !Number.isInteger(j.n) || j.n < 1 || !VOICE_COMMANDS.includes(j.cmd)) return null;
  return { n: j.n, cmd: j.cmd, at: Number(j.at) || 0, ...(j.cmd === 'persona' && typeof j.persona === 'string' ? { persona: j.persona } : {}) };
}

/** What the voice is doing now, for the addon (written aside, renamed in). */
export function writeVoiceStatus(dir, state, { now = Date.now(), persona = null, personas = null } = {}) {
  if (!VOICE_STATES.includes(state)) return { ok: false, reason: 'bad_state' };
  if (persona !== null && !(personas || []).includes(persona)) persona = null;
  const bridgeDir = path.join(dir, 'bridge');
  if (!fs.existsSync(bridgeDir)) return { ok: false, reason: 'no_app' };
  const file = path.join(bridgeDir, STATUS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, state, at: now, ...(persona ? { persona } : {}) }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ok: true };
}

export function appendVoiceInbox(dir, entry) {
  const bridgeDir = path.join(dir, 'bridge');
  if (!fs.existsSync(bridgeDir)) return { ok: false, reason: 'no_app' };
  const inbox = path.join(bridgeDir, INBOX_DIR);
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(inbox).filter(f => f.endsWith('.json')).length >= INBOX_MAX_FILES) return { ok: false, reason: 'inbox_full' };
  const id = crypto.randomUUID();
  const body = JSON.stringify({ v: 1, id, at: Date.now(), ...entry });
  if (Buffer.byteLength(body) > INBOX_ENTRY_MAX) return { ok: false, reason: 'too_large' };
  const name = `${String(Date.now()).padStart(14, '0')}-${id}.json`;
  const tmp = path.join(inbox, `.${name}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, path.join(inbox, name));
  return { ok: true, id };
}
