// What the brain knows that matters for one question (odd/tasks/nqa-brain.md B5): the quests, NPCs,
// items and zones the question names (found by name, FTS5) and the player's own quests it's about,
// expanded with where things are and who gives, takes or drops them; every line carries its source.
// Synchronous (node:sqlite) and bounded, so a turn waits well under 100 ms for it.
//
//   retrieve({ db, question, state, now }) → { facts: [{ kind, id, name, text, source }], lines, ms }
//
// lines is what goes to the model: one fact per line, "[source] text", at most MAX_FACTS.
import fs from 'node:fs';
import { tooltipFact } from './web.mjs';

// Reviewed boss abilities, each with its source page and dates (tools/brain/mechanics.json).
let mechanicsData = null;
export function mechanics() {
  if (mechanicsData) return mechanicsData;
  try { mechanicsData = JSON.parse(fs.readFileSync(new URL('./mechanics.json', import.meta.url), 'utf8')); } catch { mechanicsData = {}; }
  return mechanicsData;
}
function mechanicsFact(id) {
  const m = mechanics()[String(id)];
  if (!m || !Array.isArray(m.abilities)) return null;
  const text = `${m.name} abilities (from ${m.url}, updated ${m.updated}, read ${m.read}): ` + m.abilities.map(a => `${a.name} (spell ${a.spell}): ${a.text}`).join(' | ') + (m.advice ? `. The guide's advice: ${m.advice}` : '');
  return { kind: 'mechanics', id, name: m.name, text, source: m.source || 'reviewed' };
}
import { bossLoot, dungeonFact, factionOf, farmFact, isInstance, npcForMe, questForMe, slotFact } from './gear.mjs';
export { factionOf };

export const MAX_FACTS = 14;
export const MAX_SPAWNS = 3;

const QUOTED_RE = /["“«']([^"”»']{3,60})["”»']/g;
// Runs of capitalised words, with the small words names keep inside ("Call of Water", "Mutanus the Devourer").
const NAME_RUN_RE = /\b([A-Z][\w'’-]+(?:\s+(?:of|the|de|del|la|el|and|y)?\s*[A-Z][\w'’-]+)*)/g;
const STOP = new Set(['Dónde', 'Donde', 'Cómo', 'Como', 'Qué', 'Que', 'Quién', 'Quien', 'No', 'Me', 'Mi', 'Mis', 'Hay', 'Para', 'El', 'La', 'Los', 'Las', 'Un', 'Una', 'Y', 'En', 'De', 'Del', 'Es', 'Lo', 'Te', 'Tengo', 'Voy']);

const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const fmt = n => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toFixed(1) : '?');

const letters = s => String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
function lev(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** Whether a spoken question names a title approximately: some run of its words, joined, is within
 * 40% edits of the title ("viet hides" ~ "Deviate Hides"). Only for the player's own quest titles. */
export function soundsLike(question, title) {
  const t = letters(title).join('');
  if (t.length < 6) return false;
  const w = letters(question);
  const n = letters(title).length;
  for (let k = Math.max(1, n - 1); k <= n + 1; k++) {
    for (let i = 0; i + k <= w.length; i++) {
      const s = w.slice(i, i + k).join('');
      if (Math.abs(s.length - t.length) > t.length * 0.4) continue;
      if (lev(s, t) <= Math.floor(t.length * 0.4)) return true;
    }
  }
  return false;
}

/** The names a question may be about: quoted phrases, runs of capitalised words, quest titles from the log. */
export function candidates(question, state, db = null) {
  const q = String(question || '');
  const out = new Set();
  for (const m of q.matchAll(QUOTED_RE)) out.add(m[1].trim());
  for (const m of q.matchAll(NAME_RUN_RE)) {
    const words = m[1].split(/\s+/).filter(w => !STOP.has(w));
    if (words.length && words.join(' ').length >= 4) out.add(words.join(' '));
  }
  const low = q.toLowerCase();
  for (const quest of Array.isArray(state?.quests) ? state.quests : []) {
    const t = typeof quest?.title === 'string' ? quest.title : '';
    if (t.length >= 4 && low.includes(t.toLowerCase())) out.add(t);
  }
  // Names typed or dictated without capitals ("dónde está islen waterseer"): runs of 1-4 words that are
  // exactly a name in the brain (single words only when long: "nalpak", not "agua").
  if (db && out.size < 8) {
    const words = low.normalize('NFC').split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);
    const small = new Set([...STOP].map(w => w.toLowerCase()));
    const check = db.prepare('SELECT name FROM name_index WHERE name_index MATCH ? LIMIT 20');
    for (let k = 4; k >= 1 && out.size < 8; k--) {
      for (let i = 0; i + k <= words.length && out.size < 8; i++) {
        const run = words.slice(i, i + k);
        if (small.has(run[0]) || small.has(run[k - 1]) || (k === 1 && run[0].length < 5)) continue;
        const phraseText = run.join(' ');
        if ([...out].some(n => n.toLowerCase().includes(phraseText))) continue;
        let rows = [];
        try { rows = check.all(phrase(phraseText)); } catch { rows = []; }
        const hit = rows.find(r => String(r.name).toLowerCase() === phraseText);
        if (hit) out.add(hit.name);
      }
    }
  }
  return [...out].slice(0, 8);
}

// FTS5 phrase query for a name, words only (no operators from the player's text).
const phrase = s => `"${String(s).toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/["']/g, ' ').trim().split(/\s+/).join(' ')}"`;

function findByName(db, name, limit = 5) {
  const exact = String(name).toLowerCase();
  let rows = [];
  try { rows = db.prepare('SELECT kind, id, name FROM name_index WHERE name_index MATCH ? LIMIT 40').all(phrase(name)); } catch { rows = []; }
  // Exact names first, then the shortest (the closest), then the kinds a player asks about most.
  const rank = { quest: 0, npc: 1, item: 2, zone: 3, object: 4 };
  return rows
    .map(r => ({ ...r, exact: String(r.name).toLowerCase() === exact }))
    .sort((a, b) => (b.exact - a.exact) || (a.name.length - b.name.length) || ((rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)))
    .slice(0, limit);
}

function zoneName(db, areaId) {
  if (!areaId) return null;
  return db.prepare('SELECT name, ui_map_id FROM zone WHERE area_id = ?').get(areaId) || null;
}

/** "Thunder Bluff 43.6,57.2; ..." for an NPC's or object's first spawns. */
function where(db, kind, id) {
  const spawns = db.prepare('SELECT area_id, x, y FROM spawn WHERE kind = ? AND id = ? LIMIT ?').all(kind, id, MAX_SPAWNS);
  return spawns.map(s => {
    const z = zoneName(db, s.area_id);
    if (s.x === -1 && s.y === -1) return `inside ${z?.name || `zone ${s.area_id}`} (dungeon, no map coordinates)`;
    return `${z?.name || `zone ${s.area_id}`} ${fmt(s.x)},${fmt(s.y)}${z?.ui_map_id ? ` (map ${z.ui_map_id})` : ''}`;
  }).join('; ');
}

function nameOf(db, kind, id) {
  const table = { npc: 'npc', object: 'object', item: 'item', quest: 'quest' }[kind];
  if (!table) return null;
  return db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name ?? null;
}

function whoText(db, list) {
  const parts = [];
  for (const kind of ['npc', 'object', 'item']) {
    for (const id of Array.isArray(list?.[kind]) ? list[kind].slice(0, 2) : []) {
      const n = nameOf(db, kind, id) || `${kind} ${id}`;
      const w = kind === 'item' ? '' : where(db, kind, id);
      parts.push(w ? `${n} (${w})` : n);
    }
  }
  return parts.join(' or ');
}

/** The faction/class patch QuestieDB keeps for a conditional field (null when none). */
function variantOf(db, kind, id, state) {
  const f = factionOf(state), c = String(state?.char?.class || '').toUpperCase();
  if (!f || !c) return null;
  try { return json(db.prepare('SELECT raw FROM questie_variant WHERE kind = ? AND id = ? AND faction = ? AND class = ?').get(kind, id, f, c)?.raw); } catch { return null; }
}

function questFact(db, id, mine, state = null) {
  const q = db.prepare('SELECT * FROM quest WHERE id = ?').get(id);
  if (!q) return null;
  const v = variantOf(db, 'quest', id, state);
  if (v && Number.isInteger(v.nextQuestInChain)) q.next_quest = v.nextQuestInChain;
  // QuestieDB: startedBy = [npcs, objects, items], finishedBy = [npcs, objects].
  const who = list => ({ npc: Array.isArray(list?.[0]) ? list[0] : [], object: Array.isArray(list?.[1]) ? list[1] : [], item: Array.isArray(list?.[2]) ? list[2] : [] });
  if (v && Array.isArray(v.startedBy)) q.starts = JSON.stringify(who(v.startedBy));
  if (v && Array.isArray(v.finishedBy)) q.ends = JSON.stringify(who(v.finishedBy));
  if (v && Array.isArray(v.objectivesText)) q.objectives_text = v.objectivesText.join(' ');
  const logged = (Array.isArray(state?.quests) ? state.quests : []).find(l => l?.id === id);
  const starts = whoText(db, json(q.starts));
  const ends = whoText(db, json(q.ends));
  const parts = [`Quest ${q.id} "${q.name}"${q.level ? ` (level ${q.level}${q.req_level ? `, from ${q.req_level}` : ''})` : ''}`];
  if (starts) parts.push(`given by ${starts}`);
  if (ends) parts.push(`turned in to ${ends}`);
  const obj = json(q.objectives);
  const targets = [];
  // Questie keeps objectives by position: creatures, objects, items (then reputation, kill credit,
  // spell); an importer may also have named them.
  // QuestieDB: {1: creatures, 2: objects, 3: items} (Lua's 1-based positions); arrays and named keys too.
  for (const [kind, key, pos] of [['npc', 'creatures', 0], ['object', 'objects', 1], ['item', 'items', 2]]) {
    const list = Array.isArray(obj) ? obj[pos] : (obj?.[key] ?? obj?.[String(pos + 1)]);
    for (const o of Array.isArray(list) ? list.slice(0, 3) : []) {
      const oid = Array.isArray(o) ? o[0] : o;
      if (!Number.isInteger(oid)) continue;
      const n = nameOf(db, kind, oid) || `${kind} ${oid}`;
      const w = kind === 'item' ? itemWhere(db, oid, 2) : where(db, kind, oid);
      const prog = logged && Array.isArray(logged.obj) ? logged.obj.find(o => typeof o?.text === 'string' && n && o.text.toLowerCase().includes(String(n).toLowerCase())) : null;
      targets.push(`${n}${prog ? ` (you have ${prog.have}/${prog.need})` : ''}${w ? `: ${w}` : ''}`);
    }
  }
  if (q.objectives_text) parts.push(`objective: ${String(q.objectives_text).replace(/^\["|"\]$/g, '').slice(0, 200)}`);
  if (targets.length) parts.push(`objectives: ${targets.join(' | ')}`);
  if (logged && Array.isArray(logged.obj) && !targets.length && logged.obj.length) parts.push(`your progress: ${logged.obj.slice(0, 4).map(o => `${o.text} ${o.have}/${o.need}`).join(', ')}`);
  if (logged?.complete) parts.push('complete: ready to turn in');
  const pre = json(q.pre_quests);
  const preIds = (Array.isArray(pre) ? pre.flat() : [...(pre?.single || []), ...(pre?.group || [])]).filter(Number.isInteger).slice(0, 2);
  if (preIds.length) parts.push(`needs first: ${preIds.map(p => nameOf(db, 'quest', p) || p).join(', ')}`);
  if (q.next_quest) parts.push(`next step: quest ${q.next_quest} "${nameOf(db, 'quest', q.next_quest) || '?'}"`);
  if (mine) parts.push('(in your log)');
  return { kind: 'quest', id: q.id, name: q.name, next: q.next_quest || null, text: parts.join('; '), source: q.source };
}

function npcFact(db, id, state = null) {
  const n = db.prepare('SELECT * FROM npc WHERE id = ?').get(id);
  if (!n) return null;
  const parts = [`NPC ${n.id} ${n.name}${n.subname ? ` <${n.subname}>` : ''}${n.min_level ? ` (level ${n.min_level}${n.max_level && n.max_level !== n.min_level ? `-${n.max_level}` : ''})` : ''}`];
  const w = where(db, 'npc', id);
  if (w) parts.push(`at ${w}`);
  // Each quest with its id, only the ones open to this character, and which are in their log: several
  // quests can share a name ("Call of Water" is a chain of them).
  const mine = new Set((Array.isArray(state?.quests) ? state.quests : []).map(q => q?.id).filter(Number.isInteger));
  const logNames = new Set((Array.isArray(state?.quests) ? state.quests : []).map(q => q?.title).filter(Boolean));
  const list = col => db.prepare(`SELECT q.id, q.name FROM quest q, json_each(q.${col}, '$.npc') j WHERE j.value = ? LIMIT 12`).all(id)
    .filter(r => !state || questForMe(db, r.id, state)).slice(0, 4)
    .map(r => `${r.name} (quest ${r.id}${mine.has(r.id) ? ', in your log' : logNames.has(r.name) ? ', not the one in your log' : ''})`);
  const starts = list('starts');
  const ends = list('ends');
  if (starts.length) parts.push(`gives: ${starts.join(', ')}`);
  if (ends.length) parts.push(`takes: ${ends.join(', ')}`);
  const raw = json(n.raw) || {};
  if (raw.rank === 1 || raw.rank === 3 || isInstance(db, n.zone_area)) {
    const loot = bossLoot(db, n.id, state);
    if (loot.length) parts.push(`its gear loot: ${loot.join('; ')}`);
  }
  return { kind: 'npc', id: n.id, name: n.name, text: parts.join('; '), source: n.source };
}

function itemWhere(db, id, limit = 4) {
  const rows = db.prepare('SELECT kind, id, chance FROM item_source WHERE item_id = ? ORDER BY chance DESC LIMIT ?').all(id, limit);
  return rows.map(r => {
    const n = nameOf(db, r.kind, r.id) || `${r.kind} ${r.id}`;
    const w = r.kind === 'npc' || r.kind === 'object' ? where(db, r.kind, r.id).split('; ')[0] : '';
    const verb = r.kind === 'vendor' ? 'sold by' : r.kind === 'quest' ? 'reward of' : 'drops from';
    return `${verb} ${n}${r.chance ? ` ${fmt(r.chance)}%` : ''}${w ? ` (${w})` : ''}`;
  }).join('; ');
}

function itemFact(db, id) {
  const it = db.prepare('SELECT * FROM item WHERE id = ?').get(id);
  if (!it) return null;
  const parts = [`Item ${it.id} ${it.name}${it.level ? ` (item level ${it.level})` : ''}${it.slot ? ` [${it.slot}]` : ''}`];
  const w = itemWhere(db, id);
  if (w) parts.push(w);
  return { kind: 'item', id: it.id, name: it.name, text: parts.join('; '), source: it.source };
}

function zoneFact(db, id, state = null) {
  const z = db.prepare('SELECT * FROM zone WHERE area_id = ?').get(id);
  if (!z) return null;
  if (isInstance(db, id)) { const d = dungeonFact(db, id, state); if (d) return d; }
  return { kind: 'zone', id: z.area_id, name: z.name, text: `Zone ${z.name}${z.ui_map_id ? ` (map ${z.ui_map_id})` : ''}`, source: z.source };
}

const CLASS_WORDS = { shaman: /cham[aá]n(?:es)?|shaman/i, warrior: /guerrer[oa]s?|warrior/i, paladin: /palad[ií]n(?:es)?|paladin/i, hunter: /cazador(?:es)?|hunter/i, rogue: /p[ií]car[oa]s?|rogue/i, priest: /sacerdot(?:e|isa)s?|priest/i, mage: /\bmag[oa]s?\b|\bmage\b/i, warlock: /brujos?|warlock/i, druid: /druidas?|druid/i };

/** Class trainers in the zone asked about or the player's zone ("el entrenador de chamanes"). */
function trainerFact(db, question, state, areaHint) {
  const q = String(question || '');
  if (!/entrenador|trainer|entrenar/i.test(q)) return null;
  const cls = Object.keys(CLASS_WORDS).find(k => CLASS_WORDS[k].test(q)) || String(state?.char?.class || '').toLowerCase();
  if (!cls) return null;
  const title = cls[0].toUpperCase() + cls.slice(1) + ' Trainer';
  const rows = db.prepare("SELECT DISTINCT n.id, n.name, s.area_id, s.x, s.y FROM npc n JOIN spawn s ON s.kind = 'npc' AND s.id = n.id WHERE n.subname = ?").all(title);
  const zoneArea = areaHint || db.prepare('SELECT area_id FROM zone WHERE name = ?').get(state?.loc?.zone || '')?.area_id;
  const ok = rows.filter(r => !state || npcForMe(db, r.id, state));
  const here = ok.filter(r => r.area_id === zoneArea);
  const pick = (here.length ? here : ok).slice(0, 3);
  if (!pick.length) return null;
  const parts = pick.map(r => {
    const z = zoneName(db, r.area_id);
    return `${r.name} (${z?.name || r.area_id} ${fmt(r.x)},${fmt(r.y)}${z?.ui_map_id ? ` (map ${z.ui_map_id})` : ''})`;
  });
  return { kind: 'trainer', id: title, name: title, text: `${title}s: ${parts.join('; ')}`, source: 'questiedb-1.0.13' };
}

const NEXT_RE = /siguiente|pr[oó]xim[oa]|next|despu[eé]s|luego|continuar/i;

/** The facts for one question. */
export function retrieve({ db, question, state = null, now = Date.now() } = {}) {
  const t0 = performance.now();
  const facts = [];
  const seen = new Set();
  const mineIds = new Set((Array.isArray(state?.quests) ? state.quests : []).map(q => q?.id).filter(Number.isInteger));
  const add = f => { if (f && !seen.has(`${f.kind}:${f.id}`) && facts.length < MAX_FACTS) { seen.add(`${f.kind}:${f.id}`); facts.push(f); } };
  let zoneHit = null;
  // Questions about gear for a slot or what to farm come first: they name no entity.
  try { add(slotFact(db, question, state)); } catch { /* a missing column or table: no gear fact */ }
  try { add(farmFact(db, question, state)); } catch { /* idem */ }
  for (const name of candidates(question, state, db)) {
    for (const hit of findByName(db, name, 3)) {
      // A quest in the player's log wins over a same-named one they can't have.
      if (hit.kind === 'quest') {
        const sameName = db.prepare("SELECT q.id FROM quest q JOIN name_index n ON n.kind = 'quest' AND n.id = q.id WHERE name_index MATCH ?").all(phrase(name)).map(r => r.id);
        const mine = sameName.find(id => mineIds.has(id));
        const f = questFact(db, mine ?? hit.id, mine !== undefined, state);
        add(f);
        // "¿Cuál es el siguiente paso?": the next quest in the chain, with its giver and place.
        if (f?.next && NEXT_RE.test(String(question || ''))) add(questFact(db, f.next, mineIds.has(f.next), state));
      } else if (hit.kind === 'npc') { add(npcFact(db, hit.id, state)); add(mechanicsFact(hit.id)); }
      else if (hit.kind === 'item') add(itemFact(db, hit.id));
      else if (hit.kind === 'zone') { zoneHit = zoneHit ?? hit.id; add(zoneFact(db, hit.id, state)); }
    }
  }
  // A misheard title ("Viet Hides") only when no name in the question matched anything exactly:
  // "call of fire" finds Call of Fire, never the Call of Water in the log.
  if (!facts.some(f => ['quest', 'npc', 'item', 'dungeon', 'zone'].includes(f.kind))) {
    const low = String(question || '').toLowerCase();
    for (const quest of Array.isArray(state?.quests) ? state.quests : []) {
      const t = typeof quest?.title === 'string' ? quest.title : '';
      if (Number.isInteger(quest?.id) && t.length >= 4 && soundsLike(low, t)) add(questFact(db, quest.id, true, state));
    }
  }
  try { add(trainerFact(db, question, state, zoneHit)); } catch { /* idem */ }
  // Wowhead's cached tooltip for a quest or item found (B9): what QuestieDB doesn't hold (stats, text).
  const lines = [];
  for (const f of facts) {
    lines.push(`[${f.source}] ${f.text}`);
    if ((f.kind === 'quest' || f.kind === 'item') && lines.length < MAX_FACTS + 4) { const w = tooltipFact(db, f.kind, f.id); if (w) lines.push(w); }
  }
  return { facts, lines, ms: Math.round((performance.now() - t0) * 10) / 10, at: now };
}
