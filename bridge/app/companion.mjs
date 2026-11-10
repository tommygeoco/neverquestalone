// The companion's bridge side (companion PRD F1, F3, F6; PROTOCOL §2.6): validating the game state
// the addon sends, the quest log's count and titles, the fixed summary of each event kind, and the
// session recap from SavedVariables. Pure functions; service.mjs wires them, and the backend's
// request (byok/runtime/context.mjs) writes an event's fixed line from eventSummary.

// The state's JSON (PROTOCOL §2.6): the addon fits it to one strip frame,
// deflated with cap z, and to 12,000 bytes of JSON for a bridge with cap qlog
// (2,800 without). Its z=1 body: at most the base64 of 12,000 bytes that don't
// deflate at all.
export const STATE_JSON_MAX = 12000;
export const STATE_BODY_MAX = 16384;
// The most quests a state can hold: more than 12,000 bytes of JSON can (a
// quest is at least 9 bytes, {"id":1},), so it bounds a forged list where one
// is read outside validateState (BYOK's sanitizeState) and never cuts a real one.
export const QUEST_LIST_MAX = 1500;
// Whole quest titles kept per token (fillTitles), the least recently seen go first.
export const TITLE_CACHE_MAX = 1000;
export const EVENT_KINDS = ['level_up', 'route_done', 'route_stale', 'zone_first', 'bags_full', 'gear_breaking'];

/** The fixed summary per event kind: game text never goes into the header. */
export function eventSummary(kind, a = {}) {
  const num = v => /^\d+$/.test(String(v ?? '')) ? String(v) : null;
  switch (kind) {
    case 'level_up': return num(a.from) && num(a.to) ? `Level-up: ${a.from} → ${a.to}` : 'Level-up';
    case 'route_done': return 'The route is finished';
    case 'route_stale': return num(a.n) ? `${a.n} quests picked up that no route covers` : 'Quests picked up that no route covers';
    case 'zone_first': return 'First visit to a zone';
    case 'bags_full': return 'Bags are almost full';
    case 'gear_breaking': return 'Equipped gear needs repair';
    case 'recap': return 'Session recap';
    default: return null;
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/**
 * A state record's body: JSON, v 1, sid of 16 hex, a whole seq, at most 12,000
 * bytes. Returns { ok, state, json } or { ok: false, reason }.
 */
export function validateState(body) {
  const json = String(body ?? '');
  if (Buffer.byteLength(json) > STATE_JSON_MAX) return { ok: false, reason: 'too large' };
  let s;
  try { s = JSON.parse(json); } catch { return { ok: false, reason: 'not JSON' }; }
  if (!isObj(s) || s.v !== 1) return { ok: false, reason: 'version' };
  if (typeof s.sid !== 'string' || !/^[0-9a-f]{16}$/.test(s.sid)) return { ok: false, reason: 'sid' };
  if (!Number.isInteger(s.seq) || s.seq < 0) return { ok: false, reason: 'seq' };
  return { ok: true, state: s, json };
}

// The state's quests, in log order: every one the addon sent.
const questsOf = s => (Array.isArray(s?.quests) ? s.quests.filter(q => isObj(q) && Number.isInteger(q.id)) : []);
const whole = v => (Number.isInteger(v) && v > 0 ? v : 0);
// Why a list isn't the whole log: quests the game listed with no id yet (questUnread).
const notRead = unread => `the game listed ${unread} more without a quest id yet`;

/**
 * The count before the ids on the context's Quest log line (withState): "27 of
 * 40 quests, all listed", or which quests aren't listed and that they're still
 * in the log, word for word as the addon writes it (Store.lua
 * QuestCountPhrase), so Bones never takes the list for a cut one. null for an
 * older addon's state (no questCount), whose line had no count.
 */
export function questCountPhrase(state) {
  const s = isObj(state) ? state : {};
  if (!Number.isInteger(s.questCount)) return null;
  const n = questsOf(s).length;
  const unread = whole(s.questUnread);
  const max = whole(s.questMax);
  if (!unread) return max ? `${n} of ${max} quests, all listed` : `${n} quests, all listed`;
  return `${n} quests listed${max ? ` (max ${max})` : ''}, not the whole log (${notRead(unread)}; still in the log)`;
}

// Said after the count when a turn goes with a state older than the one its message named.
export const STALE_NOTE = 'This game data is from before the latest change in game: a quest picked up in the last few seconds may not be in it yet.';

/**
 * The line that opens the quest section of every data block (F1): how many
 * quests the log has against the game's cap, and that every one is listed, or
 * which quests aren't and that they're still in the log. Bones reads it
 * before the list, so he never says a quest "fell off" a list that is whole,
 * nor that one is gone from a list that isn't. stale: the state is older than
 * the one the turn named (STALE_NOTE).
 */
export function questLogLine(state, { stale = false } = {}) {
  const s = isObj(state) ? state : {};
  const all = questsOf(s);
  const n = all.length;
  let line;
  if (!Number.isInteger(s.questCount)) {
    // An older addon kept the first 25 quests of the log, and cut nothing else from it.
    if (!n) line = 'Quest log: empty.';
    else line = n < 25 ? `Quest log: ${n} quest${n === 1 ? '' : 's'}, every one listed.` : `Quests listed: ${n}. An older addon sends at most 25; more may be in the log.`;
  } else {
    const unread = whole(s.questUnread);
    const max = whole(s.questMax);
    if (unread) {
      line = `Quest log: ${n} quest${n === 1 ? '' : 's'} listed${max ? ` (max ${max})` : ''}, not the whole log: ${notRead(unread)}. They're still in the log: a quest that isn't listed may be one of them.`;
    } else if (!n) line = max ? `Quest log: empty (0 of ${max} quests).` : 'Quest log: empty.';
    else if (max && n >= max) line = `Quest log: ${n} of ${max} quests (the log is full), every one listed.`;
    else line = `Quest log: ${n} ${max ? `of ${max} quests` : `quest${n === 1 ? '' : 's'}`}, every one listed.`;
  }
  return stale ? `${line} ${STALE_NOTE}` : line;
}

/**
 * Whole titles for the quests a state sent shortened (cut: true, a prefix of
 * the title) or without one, from those this token's earlier states sent whole
 * (the addon shortens those first). Every whole title is learned; a strict
 * prefix of a known title never replaces it, another title does (a locale
 * switch). cache: [[id, title], ...], least recently seen first, at most
 * TITLE_CACHE_MAX. Returns { state (a copy), cache, filled, stillCut }.
 */
export function fillTitles(state, cache = []) {
  const map = new Map((Array.isArray(cache) ? cache : []).filter(e => Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === 'string'));
  if (!isObj(state) || !Array.isArray(state.quests)) return { state, cache: [...map], filled: [], stillCut: [] };
  const filled = [], stillCut = [];
  const quests = state.quests.map((q) => {
    if (!isObj(q) || !Number.isInteger(q.id)) return q;
    const sent = typeof q.title === 'string' ? q.title : '';
    const known = map.get(q.id);
    map.delete(q.id); // seen now: last to go
    if (!q.cut && sent) {
      const keep = known && known !== sent && known.startsWith(sent) ? known : sent;
      map.set(q.id, keep);
      return keep === sent ? q : { ...q, title: keep };
    }
    if (known !== undefined) map.set(q.id, known);
    if (known && known.startsWith(sent)) {
      filled.push(q.id);
      const { cut, ...rest } = q;
      return { ...rest, title: known };
    }
    stillCut.push(q.id);
    return q;
  });
  const out = [...map];
  return { state: { ...state, quests }, cache: out.slice(Math.max(0, out.length - TITLE_CACHE_MAX)), filled, stillCut };
}
/**
 * NQADB.companion.lastSession from the SavedVariables file: a Lua string
 * literal holding the recap JSON (F6). svText is the file decoded as latin1
 * (one character per byte), so raw UTF-8 and \ddd escapes both come out
 * right. Returns the JSON text or null.
 */
export function readLastSession(svText) {
  const m = String(svText ?? '').match(/\["lastSession"\]\s*=\s*"((?:[^"\\]|\\[\s\S])*)"/);
  if (!m) return null;
  const s = m[1].replace(/\\(\d{1,3}|.)/g, (_, e) => {
    if (/^\d+$/.test(e)) return String.fromCharCode(Number(e));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', "'": "'" }[e] ?? e;
  });
  // Lua writes bytes: \ddd escapes are UTF-8 bytes, so re-decode them.
  return Buffer.from(s, 'latin1').toString('utf8');
}

/**
 * A recap document, checked and with `ended` set (the addon can't tell quit from
 * logout). An end with XP, max XP and money all 0 after a start with an XP bar is
 * what the 70009 client reads in PLAYER_LOGOUT, which an addon before the fix wrote
 * as it was: those three and moneyDelta go as null, unknown rather than a loss
 * (`zeroed`). The addon's XP count from play (xpGained) stands.
 */
export function finishRecap(json, ended) {
  let d;
  try { d = JSON.parse(json); } catch { return null; }
  if (!isObj(d) || d.v !== 1 || d.kind !== 'session' || typeof d.sid !== 'string' || !/^[0-9a-f]{16}$/.test(d.sid)) return null;
  d.ended = ['quit', 'logout'].includes(ended) ? ended : 'unknown';
  const e = d.end;
  const zeroed = isObj(d.start) && Number(d.start.xpMax) > 0 && isObj(e) && !(Number(e.xpMax) > 0) && !(Number(e.xp) > 0) && !(Number(e.money) > 0);
  if (zeroed) {
    d.end = { ...e, xp: null, xpMax: null, money: null };
    d.moneyDelta = null;
  }
  return { doc: d, json: JSON.stringify(d), zeroed };
}
