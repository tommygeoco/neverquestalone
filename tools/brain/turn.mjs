// One brain turn (odd/tasks/nqa-brain.md B6, B7): a compact prompt (brain-prompt.md), a compact view
// of the player's game data, the sourced facts the brain retrieved for this question, the last few
// turns, and the question. Used by the voice's ask_brain tool and the bench; the typed chat keeps its
// own pack and gets the same facts in its game data (bridge side).
//
//   brainRequest({ appData, question, state, history, db, lang, name }) → { messages, maxTokens, meta }
//   compactGame(state) → the few lines of game data a brain turn needs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrain, brainFile } from './db.mjs';
import { retrieve } from './retrieve.mjs';
import { charKey, profileLines } from './profile.mjs';
import { sanitizeState, sanitizeGameString } from '../../bridge/byok/runtime/sanitize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRAIN_MAX_TOKENS = 400; // short answers (S4): a few sentences and a pin block fit
const SLOT = { 1: 'head', 2: 'neck', 3: 'shoulder', 4: 'shirt', 5: 'chest', 6: 'waist', 7: 'legs', 8: 'feet', 9: 'wrist', 10: 'hands', 11: 'finger', 12: 'finger', 13: 'trinket', 14: 'trinket', 15: 'back', 16: 'main hand', 17: 'off hand', 18: 'ranged', 19: 'tabard' };

let promptText = null;
export function brainPrompt({ name = 'NeverQuestAlone', lang = 'Spanish' } = {}) {
  promptText ??= fs.readFileSync(path.join(HERE, 'brain-prompt.md'), 'utf8');
  return promptText.replace(/\{\{name\}\}/g, name).replace(/\{\{language\}\}/g, `Answer in ${lang} unless the player writes in another language`);
}

/** The game data a brain turn needs, as short lines (identity left out). Gear the strip sent without
 * names gets them from the brain's item table (QuestieDB) when db is given. */
export function compactGame(raw, db = null) {
  const itemName = id => { try { return db ? db.prepare('SELECT name FROM item WHERE id = ?').get(id)?.name ?? null : null; } catch { return null; } };
  const s = sanitizeState(raw) || {};
  const lines = [];
  const c = s.char || {};
  if (c.level || c.class) lines.push(`Character: level ${c.level ?? '?'} ${c.race ?? ''} ${c.class ?? ''}`.replace(/\s+/g, ' ').trim()
    + (Number.isFinite(c.money) ? `, money ${Math.floor(c.money / 10000)}g ${Math.floor(c.money / 100) % 100}s` : '')
    + (Number.isFinite(c.xp) && Number.isFinite(c.xpMax) ? `, XP ${c.xp}/${c.xpMax}` : '')
    + (Number.isFinite(s.rested) ? `, rested ${s.rested}` : ''));
  const l = s.loc || {};
  if (l.zone) lines.push(`Location: ${l.zone}${l.sub ? ` - ${l.sub}` : ''}${Number.isFinite(l.x) ? ` at ${l.x},${l.y}` : ''}${l.map ? ` (map ${l.map})` : ''}`);
  if (Array.isArray(s.talents) && s.talents.length) lines.push(`Talents: ${s.talents.map(t => `${t.name} ${t.points}`).join(' / ')}`);
  if (Array.isArray(s.prof) && s.prof.length) lines.push(`Professions: ${s.prof.map(p => `${p.name} ${p.rank}/${p.max}`).join(', ')}`);
  if (Array.isArray(s.gear) && s.gear.length) lines.push(`Gear: ${s.gear.map(g => `${SLOT[g.slot] || g.slot} ${g.name || itemName(g.id) || `item ${g.id}`}${g.ilvl ? ` (${g.ilvl})` : ''}`).join(', ')}`);
  if (Array.isArray(s.durability) && s.durability.length) lines.push(`Durability: ${s.durability.slice(0, 4).map(d => `${SLOT[d.slot] || d.slot} ${d.pct ?? d.percent ?? '?'}%`).join(', ')}`);
  if (s.bags) lines.push(`Bags: ${s.bags.free ?? '?'} free of ${s.bags.slots ?? '?'}`);
  if (Array.isArray(s.quests) && s.quests.length) {
    lines.push(`Quest log (${s.quests.length}): ${s.quests.slice(0, 40).map(q => {
      const prog = Array.isArray(q.obj) && q.obj.length ? ` ${q.obj.map(o => `${o.have ?? '?'}/${o.need ?? '?'}`).join(',')}` : '';
      return `${q.id} ${sanitizeGameString(q.title || '', 40)}${q.complete ? ' [ready]' : prog}`;
    }).join('; ')}`);
  }
  const left = Number.isFinite(s.hearth?.left) ? s.hearth.left : s.hearth?.cooldown;
  if (s.hearth?.location || s.hearth?.bind) lines.push(`Hearthstone: ${s.hearth.location || s.hearth.bind}${Number.isFinite(left) ? (left > 0 ? `, ready in ${Math.ceil(left / 60)} min` : ', ready') : ''}`);
  return lines;
}

// How old the game data is, said plainly: an old read can be out of date (the player moved, looted…).
const ageText = s => (!Number.isFinite(s) ? 'now' : s < 90 ? 'now' : s < 3600 ? `${Math.round(s / 60)} minutes ago` : `${Math.round(s / 3600)} hours ago: it may be out of date`);

/** The request for one brain turn. db may be passed (tests); otherwise the app's brain file. */
export async function brainRequest({ appData, question, heard = '', state, history = [], db = null, lang = 'Spanish', name = 'NeverQuestAlone', maxHistory = 4, ageSeconds = null, key = null } = {}) {
  let own = null;
  if (!db) {
    const file = brainFile(appData);
    if (fs.existsSync(file)) own = db = openBrain(file, { readOnly: true });
  }
  try {
    // Spoken: retrieval looks at both the voice's wording and what the transcription heard.
    const asked = heard && heard !== question ? `${question}
${heard}` : question;
    const found = db ? retrieve({ db, question: asked, state }) : { lines: [], facts: [], ms: 0 };
    const game = compactGame(state, db);
    const user = [
      `GAME DATA (from the game, ${ageText(ageSeconds)}):`, ...(game.length ? game : ['(none)']),
      ...(db ? (() => { const who = profileLines(db, key || charKey(state)); return who.length ? ['', 'PLAYER (what we know about them, with its source):', ...who] : []; })() : []),
      '', 'FACTS (sourced, for this question):', ...(found.lines.length ? found.lines : ['(nothing found for this question)']),
      '', `QUESTION: ${String(question || '').slice(0, 1000)}`,
      ...(heard && heard !== question ? [`(spoken: the transcription heard "${String(heard).slice(0, 500)}"; names may be misheard in both)`] : []),
    ].join('\n');
    const hist = (Array.isArray(history) ? history : []).slice(-maxHistory)
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) }));
    return {
      maxTokens: BRAIN_MAX_TOKENS,
      messages: [{ role: 'system', content: brainPrompt({ name, lang }) }, ...hist, { role: 'user', content: user }],
      meta: { facts: found.facts.length, retrieveMs: found.ms, factKinds: found.facts.map(f => f.kind) },
    };
  } finally {
    if (own) own.close();
  }
}
