// Gear, boss loot and farming in the brain (odd/tasks/nqa-brain.md B5, S1): which items a class can
// use, what a dungeon's bosses drop, which better piece for a slot has a known source, and what pays
// to farm at the player's level by Auctionator's prices. Every line is built from sourced rows only:
// QuestieDB (sources, levels, item class), Wowhead's cached tooltips (slot, stats) and Auctionator.
//
//   usable(cls, level, itemClass, subClass)    → true | false | null (unknown class)
//   bossLoot(db, npcId, state)                 → "Mutant Scale Breastplate (Chest Mail, req 18; you: not until 40)" list
//   dungeonFact(db, areaId, state)             → one fact: the bosses of an instance and their gear
//   slotFact(db, question, state)              → one fact: better pieces for the slot asked, or null
//   farmFact(db, question, state)              → one fact: the best drops to sell at your level, or null
//   gearCandidates(db, state)                  → item ids worth a Wowhead tooltip (for the slot answers)
//   isInstance(db, areaId)                     → true when its spawns have no map coordinates
const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Classic proficiencies a class can train (item subclasses). Armor: 1 cloth, 2 leather, 3 mail,
// 4 plate, 6 shield. Weapons: 0 1h axe, 1 2h axe, 2 bow, 3 gun, 4 1h mace, 5 2h mace, 6 polearm,
// 7 1h sword, 8 2h sword, 10 staff, 13 fist, 15 dagger, 16 thrown, 18 crossbow, 19 wand.
const PROF = {
  WARRIOR: { armor: [1, 2, 3, 4, 6], weapon: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 15, 16, 18], at40: 4 },
  PALADIN: { armor: [1, 2, 3, 4, 6], weapon: [0, 1, 4, 5, 6, 7, 8], at40: 4 },
  HUNTER: { armor: [1, 2, 3], weapon: [0, 1, 2, 3, 6, 7, 8, 10, 13, 15, 16, 18], at40: 3 },
  ROGUE: { armor: [1, 2], weapon: [2, 3, 4, 7, 13, 15, 16, 18] },
  PRIEST: { armor: [1], weapon: [4, 10, 15, 19] },
  SHAMAN: { armor: [1, 2, 3, 6], weapon: [0, 1, 4, 5, 10, 13, 15], at40: 3 },
  MAGE: { armor: [1], weapon: [7, 10, 15, 19] },
  WARLOCK: { armor: [1], weapon: [7, 10, 15, 19] },
  DRUID: { armor: [1, 2], weapon: [4, 5, 10, 13, 15] },
};
const ARMOR = { 0: 'misc', 1: 'cloth', 2: 'leather', 3: 'mail', 4: 'plate', 6: 'shield' };
const WEAPON = { 0: 'one-hand axe', 1: 'two-hand axe', 2: 'bow', 3: 'gun', 4: 'one-hand mace', 5: 'two-hand mace', 6: 'polearm', 7: 'one-hand sword', 8: 'two-hand sword', 10: 'staff', 13: 'fist weapon', 15: 'dagger', 16: 'thrown', 18: 'crossbow', 19: 'wand' };

const classOf = state => String(state?.char?.class || '').toUpperCase();
const HORDE_RACES = /^(orc|troll|tauren|undead|scourge)$/i;
export const factionOf = state => { const r = String(state?.char?.race || '').replace(/\s+/g, ''); return r ? (HORDE_RACES.test(r) ? 'Horde' : 'Alliance') : null; };
// QuestieDB's race and class masks: Horde races 2|16|32|128, Alliance 1|4|8|64; class bits by class id.
const RACE_MASK = { Horde: 178, Alliance: 77 };
const CLASS_BIT = { WARRIOR: 1, PALADIN: 2, HUNTER: 4, ROGUE: 8, PRIEST: 16, SHAMAN: 64, MAGE: 128, WARLOCK: 256, DRUID: 1024 };
/** Whether a quest is open to this character's faction and class (unknown → true). */
export function questForMe(db, questId, state) {
  const r = json(db.prepare('SELECT raw FROM quest WHERE id = ?').get(questId)?.raw);
  if (!r) return true; // no record of its rules: don't hide it
  const f = factionOf(state), bit = CLASS_BIT[classOf(state)];
  const races = Number(r.requiredRaces) || 0, classes = Number(r.requiredClasses) || 0;
  // The mask may carry high bits (newer races); only its classic part decides.
  if (f && races && (races % 4096) && !((races % 4096) & RACE_MASK[f])) return false;
  if (bit && classes && !(classes & bit)) return false;
  return true;
}
/** Whether an NPC deals with this character's faction (a vendor or quest giver). */
export function npcForMe(db, npcId, state) {
  const fr = db.prepare('SELECT friendly FROM npc WHERE id = ?').get(npcId)?.friendly;
  const f = factionOf(state);
  if (!f || !fr) return !!fr || !f;
  return String(fr).includes(f[0]);
}
const levelOf = state => (Number.isInteger(state?.char?.level) ? state.char.level : null);

export function usable(cls, level, itemClass, subClass) {
  const p = PROF[String(cls || '').toUpperCase()];
  if (!p) return null;
  if (itemClass === 4) {
    if (subClass === 0) return true; // rings, necks, trinkets, cloaks count as misc/cloth
    if (!p.armor.includes(subClass)) return false;
    if (p.at40 === subClass && Number.isInteger(level) && level < 40) return false;
    return true;
  }
  if (itemClass === 2) return p.weapon.includes(subClass);
  return null;
}

const typeName = (c, sc) => (c === 4 && sc === 0 ? 'ring, neck, trinket or cloak' : (c === 4 ? ARMOR[sc] : c === 2 ? WEAPON[sc] : null)) || (c === 4 ? 'armor' : c === 2 ? 'weapon' : 'item');

// Slot names as Wowhead writes them, and the words a player says for them (Spanish and English).
const SLOTS = [
  { slot: 'Head', inv: [1], re: /\b(casco|cabeza|yelmo|head|helm(?:et)?)\b/i },
  { slot: 'Neck', inv: [2], re: /\b(collar|cuello|amuleto|neck(?:lace)?|amulet)\b/i },
  { slot: 'Shoulder', inv: [3], re: /\b(hombreras?|hombros?|shoulders?)\b/i },
  { slot: 'Back', inv: [15], re: /\b(capa|espalda|cloak|cape|back)\b/i },
  { slot: 'Chest', inv: [5], re: /\b(pecho|peto|pechera|torso|coraza|chest|breastplate|robe|t[uú]nica)\b/i },
  { slot: 'Wrist', inv: [9], re: /\b(mu[ñn]ecas?|brazales?|wrists?|bracers?)\b/i },
  { slot: 'Hands', inv: [10], re: /\b(guantes|manos|gloves|hands|gauntlets)\b/i },
  { slot: 'Waist', inv: [6], re: /\b(cintur[oó]n|cintura|belt|waist)\b/i },
  { slot: 'Legs', inv: [7], re: /\b(pantal[oó]n(?:es)?|piernas|legs|leggings|pants)\b/i },
  { slot: 'Feet', inv: [8], re: /\b(botas|pies|zapatos|boots|feet)\b/i },
  { slot: 'Finger', inv: [11, 12], re: /\b(anillos?|rings?|finger)\b/i },
  { slot: 'Trinket', inv: [13, 14], re: /\b(abalorios?|trinkets?)\b/i },
  { slot: 'Shield', inv: [17], re: /\b(escudo|shield)\b/i },
  { slot: 'Weapon', inv: [16], re: /\b(arma|armas|weapon|mace|maza|hacha|axe|bast[oó]n|staff|daga|dagger)\b/i },
];
const SLOT_IN_TOOLTIP = /\b(Head|Neck|Shoulder|Back|Chest|Wrist|Hands|Waist|Legs|Feet|Finger|Trinket|Off Hand|Held In Off-hand|One-Hand|Two-Hand|Main Hand|Ranged|Thrown)\b/;

/** Slot, item level and required level from a cached tooltip text, or null. */
export function tooltipStats(text) {
  const t = String(text || '');
  // After "Item Level": the name above it may hold a slot word.
  const at = t.indexOf('Item Level');
  const body = at >= 0 ? t.slice(at) : t.split('\n').slice(1).join('\n');
  const slot = body.match(SLOT_IN_TOOLTIP)?.[1] ?? null;
  const ilvl = Number(t.match(/Item Level (\d+)/)?.[1]) || null;
  const req = Number(t.match(/Requires Level (\d+)/)?.[1]) || null;
  return { slot, ilvl, req };
}

const cachedText = (db, id) => { try { return db.prepare("SELECT text FROM web_cache WHERE kind = 'item' AND id = ?").get(id)?.text ?? null; } catch { return null; } };

function itemInfo(db, id) {
  const it = db.prepare('SELECT id, name, level, raw, source FROM item WHERE id = ?').get(id);
  if (!it) return null;
  const r = json(it.raw) || {};
  const tip = tooltipStats(cachedText(db, id));
  return { id: it.id, name: it.name, ilvl: tip.ilvl ?? it.level ?? r.itemLevel ?? null, req: r.requiredLevel ?? tip.req ?? null, cls: r.class, sub: r.subClass,
    drops: Array.isArray(r.npcDrops) ? r.npcDrops.length : 0, quests: r.questRewards, vendors: r.vendors, slot: tip.slot, source: it.source };
}

function describe(it, state) {
  const bits = [];
  if (it.slot) bits.push(it.slot);
  bits.push(typeName(it.cls, it.sub));
  if (it.ilvl) bits.push(`ilvl ${it.ilvl}`);
  if (it.req) bits.push(`req ${it.req}`);
  const u = usable(classOf(state), levelOf(state), it.cls, it.sub);
  const p = PROF[classOf(state)];
  if (u === false) bits.push(p?.at40 === it.sub ? 'you: not until 40' : 'you: cannot use');
  else if (u && Number.isInteger(it.req) && levelOf(state) !== null && it.req > levelOf(state)) bits.push(`you: at ${it.req}`);
  else if (u) bits.push('you: can use now');
  return `${it.name} (${bits.join(', ')})`;
}

// Against what they wear in that slot, when the item's slot is known (cached tooltip): the comparison
// done here, so the model doesn't have to work it out.
const INV = { Head: [1], Neck: [2], Shoulder: [3], Back: [15], Chest: [5], Wrist: [9], Hands: [10], Waist: [6], Legs: [7], Feet: [8], Finger: [11, 12], Trinket: [13, 14], 'Off Hand': [17], 'Held In Off-hand': [17], 'One-Hand': [16], 'Two-Hand': [16], 'Main Hand': [16] };
function vsWorn(db, it, state) {
  const inv = INV[it.slot];
  if (!inv || !Array.isArray(state?.gear) || !state.gear.length || !it.ilvl) return '';
  const worn = state.gear.filter(g => inv.includes(g.slot));
  if (!worn.length) return ' [slot empty]';
  const low = Math.min(...worn.map(g => Number(g.ilvl) || 0));
  return it.ilvl > low ? ` [upgrade over ilvl ${low}]` : ` [not an upgrade: yours is ilvl ${low}]`;
}

/** Gear a boss or elite drops: its own loot (few droppers), weapons and armor only. */
export function bossLoot(db, npcId, state, max = 6, { usableOnly = false } = {}) {
  const rows = db.prepare('SELECT item_id, chance FROM item_source WHERE kind = ? AND id = ?').all('npc', npcId);
  const items = rows.map(r => ({ ...itemInfo(db, r.item_id), chance: r.chance })).filter(it => it.id && (it.cls === 2 || it.cls === 4) && (it.drops <= 3 || (it.chance ?? 0) >= 5));
  const u = it => usable(classOf(state), levelOf(state), it.cls, it.sub);
  items.sort((a, b) => ((u(b) === true) - (u(a) === true)) || ((b.ilvl ?? 0) - (a.ilvl ?? 0)));
  // For a dungeon's list: what they can use, and not what is known to be no better than what they wear.
  const list = usableOnly && PROF[classOf(state)] ? items.filter(it => u(it) !== false && !vsWorn(db, it, state).includes('not an upgrade')) : items;
  // The dungeon's list is terse (everything in it is wearable now or says when): name, slot, type, level.
  if (usableOnly) {
    return list.slice(0, max).map(it => {
      const type = it.cls === 4 && it.sub === 0 ? null : typeName(it.cls, it.sub);
      const later = Number.isInteger(it.req) && levelOf(state) !== null && it.req > levelOf(state) ? `, at ${it.req}` : '';
      return `${it.name} (${[it.slot, type, it.ilvl ? `ilvl ${it.ilvl}` : null].filter(Boolean).join(', ')}${later})${vsWorn(db, it, state)}`;
    });
  }
  return list.slice(0, max).map(it => describe(it, state) + vsWorn(db, it, state) + (it.chance ? ` ${Math.round(it.chance)}%` : ''));
}

export function isInstance(db, areaId) {
  if (!areaId) return false;
  return !!db.prepare("SELECT 1 FROM spawn WHERE kind = 'npc' AND area_id = ? AND x = -1 LIMIT 1").get(areaId);
}

/** The bosses of an instance (NPCs there with their own gear loot) and that gear, as one fact. */
export function dungeonFact(db, areaId, state, maxBosses = 8) {
  const z = db.prepare('SELECT * FROM zone WHERE area_id = ?').get(areaId);
  if (!z) return null;
  const npcs = db.prepare("SELECT DISTINCT s.id, n.name, n.min_level, n.max_level FROM spawn s JOIN npc n ON n.id = s.id WHERE s.kind = 'npc' AND s.area_id = ?").all(areaId);
  const bosses = [];
  // A boss has gear of its own: at least two weapons or armor pieces that one or two monsters drop.
  const own = db.prepare(`SELECT count(*) AS n FROM item_source s JOIN item i ON i.id = s.item_id
    WHERE s.kind = 'npc' AND s.id = ? AND json_extract(i.raw, '$.class') IN (2, 4) AND json_array_length(json_extract(i.raw, '$.npcDrops')) <= 2`);
  for (const n of npcs) {
    const rank = (json(db.prepare('SELECT raw FROM npc WHERE id = ?').get(n.id)?.raw) || {}).rank;
    const mine = own.get(n.id).n;
    if (rank !== 3 && mine < 2) continue;
    const loot = bossLoot(db, n.id, state, 3, { usableOnly: true });
    if (loot.length) bosses.push({ ...n, loot, mine: rank === 3 ? 99 : mine });
  }
  // The most own gear first (the real bosses), then by level for reading.
  bosses.sort((a, b) => b.mine - a.mine);
  bosses.splice(maxBosses);
  bosses.sort((a, b) => (a.max_level ?? 0) - (b.max_level ?? 0));
  if (!bosses.length) return null;
  const lv = bosses.map(n => n.max_level).filter(Number.isInteger);
  const range = lv.length ? ` (their levels ${Math.min(...lv)}-${Math.max(...lv)})` : '';
  const text = `Dungeon ${z.name}${range}; monsters there with gear of their own (likely bosses; QuestieDB has no boss flag) and the gear of theirs you can use: ` + bosses.map(b => `${b.name} (${b.max_level ?? '?'}): ${b.loot.join('; ')}`).join(' | ');
  return { kind: 'dungeon', id: z.area_id, name: z.name, text, source: z.source };
}

/** The slot the question asks about, or null. */
export function slotAsked(question) {
  const q = String(question || '');
  return SLOTS.find(s => s.re.test(q)) || null;
}

/** Items worth a tooltip so slot answers can know their slot: usable gear near the player's level
 * with a known source (a quest reward, a vendor, or a few droppers: a boss's own loot). */
export function gearCandidates(db, state, { below = 7, above = 5, limit = 900 } = {}) {
  const lvl = levelOf(state);
  if (lvl === null) return [];
  const rows = db.prepare(`SELECT id, raw FROM item WHERE json_extract(raw, '$.class') IN (2, 4) AND json_extract(raw, '$.requiredLevel') BETWEEN ? AND ?`).all(Math.max(1, lvl - below), lvl + above);
  const out = [];
  for (const row of rows) {
    const r = json(row.raw) || {};
    if (usable(classOf(state), lvl, r.class, r.subClass) === false) continue;
    const drops = Array.isArray(r.npcDrops) ? r.npcDrops.length : 0;
    const quest = Array.isArray(r.questRewards) && r.questRewards.some(q => questForMe(db, q, state));
    const vendor = Array.isArray(r.vendors) && r.vendors.some(v => npcForMe(db, v, state));
    if (quest || vendor || (drops > 0 && drops <= 3)) out.push(row.id);
    if (out.length >= limit) break;
  }
  return out;
}

function sourceText(db, it, state) {
  const parts = [];
  const q = Array.isArray(it.quests) ? it.quests.filter(x => questForMe(db, x, state)).slice(0, 2) : [];
  for (const qid of q) {
    const row = db.prepare('SELECT name, starts FROM quest WHERE id = ?').get(qid);
    if (!row?.name) continue;
    // Where the quest starts: its giver and zone, or the item that starts it and where that drops.
    const st = json(row.starts) || {};
    let from = '';
    const npc = Array.isArray(st.npc) ? st.npc[0] : null;
    const item = Array.isArray(st.item) ? st.item[0] : null;
    if (npc) {
      const n = db.prepare('SELECT name FROM npc WHERE id = ?').get(npc)?.name;
      const sp = db.prepare("SELECT z.name, s.x, s.y FROM spawn s LEFT JOIN zone z ON z.area_id = s.area_id WHERE s.kind = 'npc' AND s.id = ? LIMIT 1").get(npc);
      if (n) from = ` from ${n}${sp?.name ? ` (${sp.x === -1 ? `inside ${sp.name}` : `${sp.name} ${sp.x.toFixed(1)},${sp.y.toFixed(1)}`})` : ''}`;
    } else if (item) {
      const n = db.prepare('SELECT name FROM item WHERE id = ?').get(item)?.name;
      const d = db.prepare("SELECT z.name FROM item_source s JOIN spawn p ON p.kind = 'npc' AND p.id = s.id LEFT JOIN zone z ON z.area_id = p.area_id WHERE s.item_id = ? AND s.kind = 'npc' LIMIT 1").get(item);
      if (n) from = ` started by the item ${n}${d?.name ? ` (drops in ${d.name})` : ''}`;
    }
    parts.push(`reward of quest "${row.name}"${from}`);
  }
  const drops = db.prepare("SELECT s.id, s.chance, n.name FROM item_source s JOIN npc n ON n.id = s.id WHERE s.item_id = ? AND s.kind = 'npc' ORDER BY s.chance DESC LIMIT 2").all(it.id);
  for (const d of drops) {
    const sp = db.prepare("SELECT z.name, s.x FROM spawn s LEFT JOIN zone z ON z.area_id = s.area_id WHERE s.kind = 'npc' AND s.id = ? LIMIT 1").get(d.id);
    parts.push(`drops from ${d.name}${d.chance ? ` ${Math.round(d.chance)}%` : ''}${sp?.name ? ` (${sp.x === -1 ? 'inside ' : ''}${sp.name})` : ''}`);
  }
  const vendor = !parts.length && Array.isArray(it.vendors) ? it.vendors.find(v => npcForMe(db, v, state)) : null;
  if (vendor) {
    const v = db.prepare('SELECT name FROM npc WHERE id = ?').get(vendor)?.name;
    const sp = db.prepare("SELECT z.name, s.x, s.y FROM spawn s LEFT JOIN zone z ON z.area_id = s.area_id WHERE s.kind = 'npc' AND s.id = ? LIMIT 1").get(vendor);
    if (v) parts.push(`sold by ${v}${sp?.name ? ` (${sp.name} ${sp.x.toFixed(1)},${sp.y.toFixed(1)})` : ''}`);
  }
  return parts.join(', ');
}

/** Better pieces for the slot asked than what the player wears, among items whose slot is known. */
export function slotFact(db, question, state, max = 5) {
  const s = slotAsked(question);
  if (!s || levelOf(state) === null) return null;
  const gearKnown = Array.isArray(state?.gear) && state.gear.length > 0;
  const worn = (gearKnown ? state.gear : []).filter(g => s.inv.includes(g.slot));
  const wornIlvl = worn.length ? Math.min(...worn.map(g => Number(g.ilvl) || 0)) : 0;
  const wornName = worn.length ? (db.prepare('SELECT name FROM item WHERE id = ?').get(worn[0].id)?.name || `item ${worn[0].id}`) : null;
  const ids = gearCandidates(db, state);
  const known = [];
  let unknown = 0;
  for (const id of ids) {
    const it = itemInfo(db, id);
    if (!it) continue;
    if (!it.slot) { unknown++; continue; }
    const fits = s.slot === 'Weapon' ? /One-Hand|Two-Hand|Main Hand/.test(it.slot) : s.slot === 'Shield' ? it.sub === 6 : it.slot === s.slot;
    if (!fits || usable(classOf(state), levelOf(state), it.cls, it.sub) === false) continue;
    if ((it.ilvl ?? 0) <= wornIlvl) continue;
    known.push(it);
  }
  // What they can wear now first (best first), then what comes in the next levels.
  const later = it => ((it.req ?? 0) > levelOf(state) ? 1 : 0);
  known.sort((a, b) => later(a) - later(b) || (b.ilvl ?? 0) - (a.ilvl ?? 0));
  const head = !gearKnown ? `${s.slot} pieces for you (what you wear now is unknown: no gear in the game data)` : `Better ${s.slot.toLowerCase()} for you than ${wornName ? `${wornName} (ilvl ${wornIlvl})` : 'nothing worn'}`;
  if (!known.length) return { kind: 'gear', id: s.slot, name: s.slot, text: `${head}: none known yet among ${ids.length} sourced items near your level (${unknown} without a cached slot)`, source: 'questiedb-1.0.13+wowhead' };
  const text = `${head}: ` + known.slice(0, max).map(it => `${describe(it, state)} — ${sourceText(db, it, state) || 'source unknown'}`).join(' | ');
  return { kind: 'gear', id: s.slot, name: s.slot, text, source: 'questiedb-1.0.13+wowhead' };
}

const FARM_RE = /\b(farm\w*|oro|gold|dinero|money|plata|ganar)\b/i;
const money = c => { const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100; return [g && `${g}g`, s && `${s}s`, (!g && cc) && `${cc}c`].filter(Boolean).join(' ') || '0c'; };

/** What pays to farm at the player's level: monsters near it whose drops sell well (Auctionator). */
export function farmFact(db, question, state, max = 4) {
  if (!FARM_RE.test(String(question || ''))) return null;
  const lvl = levelOf(state);
  if (lvl === null) return null;
  let rows = [];
  try {
    rows = db.prepare(`SELECT p.item_id, p.copper, p.seen_at, s.id AS npc, s.chance, n.name AS npc_name, n.min_level, n.max_level, i.name AS item_name
      FROM price p CROSS JOIN item_source s ON s.item_id = p.item_id AND s.kind = 'npc' JOIN npc n ON n.id = s.id JOIN item i ON i.id = p.item_id
      WHERE s.chance >= 2 AND n.max_level BETWEEN ? AND ? AND (n.friendly IS NULL OR n.friendly = 0)
      ORDER BY p.copper * s.chance DESC LIMIT 60`).all(Math.max(1, lvl - 6), lvl + 1);
  } catch { return null; }
  const picked = [];
  const seenNpc = new Set(), seenItem = new Set();
  for (const r of rows) {
    if (seenNpc.has(r.npc) || seenItem.has(r.item_id)) continue;
    const npcRaw = json(db.prepare('SELECT raw FROM npc WHERE id = ?').get(r.npc)?.raw) || {};
    if (npcRaw.rank === 2 || npcRaw.rank === 4) continue; // rares: not a farm
    const sp = db.prepare("SELECT s.x, s.y, z.name, z.ui_map_id FROM spawn s LEFT JOIN zone z ON z.area_id = s.area_id WHERE s.kind = 'npc' AND s.id = ? LIMIT 1").get(r.npc);
    if (!sp) continue;
    seenNpc.add(r.npc); seenItem.add(r.item_id);
    const where = sp.x === -1 ? `inside ${sp.name}` : `${sp.name} ${sp.x.toFixed(1)},${sp.y.toFixed(1)}${sp.ui_map_id ? ` (map ${sp.ui_map_id})` : ''}`;
    picked.push(`${r.npc_name} (level ${r.min_level}${r.max_level !== r.min_level ? `-${r.max_level}` : ''}, ${where}) drops ${r.item_name} ${Math.round(r.chance)}%, auction ~${money(r.copper)} each (about ${money(Math.round(r.copper * r.chance / 100))} a kill)`);
    if (picked.length >= max) break;
  }
  if (!picked.length) return null;
  const seen = rows.map(r => r.seen_at).filter(Number.isFinite);
  const when = seen.length ? new Date(Math.max(...seen)).toISOString().slice(0, 10) : null;
  return { kind: 'farm', id: lvl, name: 'farm', text: `Farming at level ${lvl} by auction prices${when ? ` (scanned up to ${when})` : ''}: ${picked.join(' | ')}`, source: 'questiedb-1.0.13+auctionator' };
}
