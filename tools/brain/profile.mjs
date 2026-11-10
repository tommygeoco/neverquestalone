// The player in the brain (odd/tasks/nqa-brain.md B4, S2b-c): per character, what the game says about
// them (source "game"), what they said about themselves (source "player": role, goals, preferences),
// and the history of what was said (said table: the player, the brain, the voice). A model's words go
// to said only, never to fact.
//
//   charKey(state)                         → "Name-Realm" or null (local only; never sent to a model)
//   updateFromState(db, state, now)         → facts from the game (class, race, level, professions, talents, zone)
//   learnFromPlayer(db, key, text, now)     → facts the player stated about themselves (rule-based)
//   recordSaid(db, key, who, channel, text) → one history row
//   profileLines(db, key)                   → "[game] level: 22" / "[player] role: healer" lines for a turn
import { sanitizeGameString } from '../../bridge/byok/runtime/sanitize.mjs';

export const SAID_MAX = 2000; // characters kept per row
export const PROFILE_KEYS = ['class', 'race', 'level', 'professions', 'talents', 'gear', 'quests', 'zone', 'role', 'goal', 'style'];
const SLOT = { 1: 'head', 2: 'neck', 3: 'shoulder', 5: 'chest', 6: 'waist', 7: 'legs', 8: 'feet', 9: 'wrist', 10: 'hands', 11: 'finger', 12: 'finger', 13: 'trinket', 14: 'trinket', 15: 'back', 16: 'main hand', 17: 'off hand', 18: 'ranged' };

export function charKey(state) {
  const c = state?.char;
  const name = sanitizeGameString(String(c?.name || ''), 40);
  if (!name) return null;
  const realm = sanitizeGameString(String(c?.realm || ''), 60);
  return realm ? `${name}-${realm}` : name;
}

const put = (db, key, k, value, source, now, max = 300) => db.prepare('INSERT INTO fact (char_key, key, value, source, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(char_key, key) DO UPDATE SET value = excluded.value, source = excluded.source, at = excluded.at')
  .run(key, k, String(value).slice(0, max), source, now);

/** What the game state says about the character. */
export function updateFromState(db, state, now = Date.now()) {
  const key = charKey(state);
  if (!key) return null;
  const c = state.char || {};
  if (c.class) put(db, key, 'class', c.class, 'game', now);
  if (c.race) put(db, key, 'race', c.race, 'game', now);
  if (Number.isInteger(c.level)) put(db, key, 'level', c.level, 'game', now);
  if (Array.isArray(state.prof) && state.prof.length) put(db, key, 'professions', state.prof.map(p => `${p.name} ${p.rank}/${p.max}`).join(', '), 'game', now);
  if (Array.isArray(state.talents) && state.talents.length) put(db, key, 'talents', state.talents.map(t => `${t.name} ${t.points}`).join(' / '), 'game', now);
  if (state.loc?.zone) put(db, key, 'zone', state.loc.zone, 'game', now);
  // What they wear (names from the brain's item table when the strip sent ids only) and their quest log.
  if (Array.isArray(state.gear) && state.gear.length) {
    const nameOf = id => { try { return db.prepare('SELECT name FROM item WHERE id = ?').get(id)?.name ?? null; } catch { return null; } };
    put(db, key, 'gear', state.gear.filter(g => SLOT[g?.slot]).map(g => `${SLOT[g.slot]} ${sanitizeGameString(String(g.name || nameOf(g.id) || `item ${g.id}`), 40)}${g.ilvl ? ` (${g.ilvl})` : ''}`).join(', '), 'game', now, 600);
  }
  if (Array.isArray(state.quests) && state.quests.length) put(db, key, 'quests', state.quests.map(q => `${q.id} ${sanitizeGameString(String(q.title || ''), 40)}`).join('; '), 'game', now, 1500);
  return key;
}

// The player saying what they play and want ("soy sanador", "juego de tanque", "mi meta es llegar a 40",
// "quiero farmear oro", "prefiero misiones a mazmorras"). Only their own words, kept as they said them.
const ROLE_RE = /\b(?:soy|juego(?:\s+de)?|voy\s+de|i'?m\s+(?:a|the)?|i\s+play)\s+(tanque|tank|sanador|curandero|healer|heal|dps|da[ñn]o|damage)\b/i;
const GOAL_RE = /\b(?:mi\s+(?:meta|objetivo)\s+es|quiero|my\s+goal\s+is|i\s+want\s+to)\s+([^.!?\n]{4,120})/i;
const STYLE_RE = /\b(?:prefiero|me\s+gusta(?:\s+m[aá]s)?|i\s+prefer|i\s+like)\s+([^.!?\n]{4,120})/i;
const ROLE = { tanque: 'tank', tank: 'tank', sanador: 'healer', curandero: 'healer', healer: 'healer', heal: 'healer', dps: 'damage', 'daño': 'damage', dano: 'damage', damage: 'damage' };

export function learnFromPlayer(db, key, text, now = Date.now()) {
  if (!key || typeof text !== 'string') return [];
  const learned = [];
  const t = text.slice(0, 1000);
  // A negation right before the claim ("no soy sanador", "I'm not a healer", "no quiero…") teaches nothing.
  const negated = m => m && (/\b(no|nunca|jam[aá]s|not|never)\s+$/i.test(t.slice(Math.max(0, m.index - 12), m.index)) || /\b(not|no)\b/i.test(m[0]));
  const role = t.match(ROLE_RE);
  if (role && !negated(role)) { put(db, key, 'role', ROLE[role[1].toLowerCase()] || role[1], 'player', now); learned.push('role'); }
  // A goal or a preference only when it isn't a question ("¿quiero...?" is asking, not telling).
  if (!/[?¿]/.test(t)) {
    const goal = t.match(GOAL_RE);
    if (goal && !negated(goal)) { put(db, key, 'goal', goal[1].trim(), 'player', now); learned.push('goal'); }
    const style = t.match(STYLE_RE);
    if (style && !negated(style)) { put(db, key, 'style', style[1].trim(), 'player', now); learned.push('style'); }
  }
  return learned;
}

export function recordSaid(db, key, who, channel, text, now = Date.now()) {
  if (!key || !text) return;
  db.prepare('INSERT INTO said (char_key, at, who, channel, text) VALUES (?, ?, ?, ?, ?)').run(key, now, who, channel || null, String(text).slice(0, SAID_MAX));
}

/** The character's profile as short sourced lines for a turn. */
export function profileLines(db, key) {
  if (!key) return [];
  let rows = [];
  try { rows = db.prepare('SELECT key, value, source, at FROM fact WHERE char_key = ?').all(key); } catch { return []; }
  const order = k => { const i = PROFILE_KEYS.indexOf(k); return i < 0 ? 99 : i; };
  const live = new Set(['gear', 'quests']); // the turn's game data has them fresh
  return rows.filter(r => PROFILE_KEYS.includes(r.key) && !live.has(r.key)).sort((a, b) => order(a.key) - order(b.key)).map(r => `[${r.source} ${new Date(r.at).toISOString().slice(0, 10)}] ${r.key}: ${r.value}`);
}
