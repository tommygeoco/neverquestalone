// The brain's gear, loot and farming facts (odd/tasks/nqa-brain.md B5, S1, S8): what a class can use,
// a dungeon's bosses and their own gear, a better piece for a slot, what pays to farm, faction rules,
// QuestieDB's real objective shape, and the names the voice is told so it hears them right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrain, upsertSource } from '../tools/brain/db.mjs';
import { usable, tooltipStats, slotAsked, slotFact, farmFact, dungeonFact, bossLoot, questForMe, npcForMe, factionOf, gearCandidates, isInstance } from '../tools/brain/gear.mjs';
import { retrieve } from '../tools/brain/retrieve.mjs';
import { gameNames, sessionConfig } from '../tools/voice/server.mjs';

const SRC = 'questiedb-test';
const HORDE = 8589934770; // QuestieDB's mask for the Horde races (with a high bit)
function seed() {
  const db = openBrain(':memory:');
  const now = Date.now();
  const item = db.prepare('INSERT INTO item (id, name, level, raw, source, read_at) VALUES (?,?,?,?,?,?)');
  const it = (id, name, ilvl, cls, sub, req, extra = {}) => item.run(id, name, ilvl, JSON.stringify({ name, itemLevel: ilvl, class: cls, subClass: sub, requiredLevel: req, ...extra }), SRC, now);
  it(6627, 'Mutant Scale Breastplate', 23, 4, 3, 18, { npcDrops: [3654] });
  it(6461, 'Slime-encrusted Pads', 25, 4, 1, 20, { npcDrops: [3654] });
  it(6463, 'Deep Fathom Ring', 24, 4, 0, 19, { npcDrops: [3654] });
  it(5243, 'Firebelcher', 23, 2, 19, 18, { npcDrops: [3654] });
  it(1000, 'Common Vest', 20, 4, 2, 21, { npcDrops: [1, 2, 3, 4, 5] }); // a world drop: not a boss's own
  it(2000, 'Dreamer\'s Chestguard', 32, 4, 2, 21, { questRewards: [6922] });
  it(2001, 'Alliance Robe', 30, 4, 1, 21, { vendors: [7000] });
  it(2002, 'Grunt\'s Harness', 27, 4, 2, 22, { vendors: [7001] });
  it(3000, 'Tough Condor Meat', 1, 7, 0, 0, { npcDrops: [8000] });
  it(6443, 'Deviate Hide', 1, 12, 0, 0, { npcDrops: [3654, 3630] });
  it(16782, 'Strange Water Globe', 1, 12, 0, 0, { npcDrops: [3630] });
  const npc = db.prepare('INSERT INTO npc (id, name, subname, min_level, max_level, zone_area, friendly, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  npc.run(3654, 'Mutanus the Devourer', null, 22, 22, 718, null, JSON.stringify({ rank: 1 }), SRC, now);
  npc.run(3630, 'Deviate Coiler', null, 15, 16, 718, null, JSON.stringify({ rank: 1 }), SRC, now);
  npc.run(7000, 'Wynne Larson', 'Robe Merchant', 30, 30, 1519, 'A', '{}', SRC, now);
  npc.run(7001, 'Sura Wildmane', 'War Harness Vendor', 30, 30, 1638, 'H', '{}', SRC, now);
  npc.run(8000, 'Dire Condor', null, 18, 19, 44, null, JSON.stringify({ rank: 0 }), SRC, now);
  npc.run(8001, 'Rare Condor', null, 20, 20, 44, null, JSON.stringify({ rank: 4 }), SRC, now);
  npc.run(5767, 'Nalpak', null, 25, 25, 17, 'AH', '{}', SRC, now);
  const q = db.prepare('INSERT INTO quest (id, name, level, starts, ends, objectives_text, objectives, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  q.run(6922, 'Baron Aquanis', 24, JSON.stringify({ npc: [], object: [], item: [16782] }), JSON.stringify({ npc: [5767] }), null, '{}', JSON.stringify({ requiredRaces: HORDE, requiredClasses: 0 }), SRC, now);
  q.run(1486, 'Deviate Hides', 17, JSON.stringify({ npc: [5767] }), JSON.stringify({ npc: [5767] }), 'Nalpak wants 20 Deviate Hides.', JSON.stringify({ 3: [[6443, null, 0]] }), JSON.stringify({ requiredRaces: 0 }), SRC, now);
  q.run(7777, 'For the Alliance', 20, JSON.stringify({ npc: [5767] }), JSON.stringify({ npc: [5767] }), null, '{}', JSON.stringify({ requiredRaces: 77 }), SRC, now);
  q.run(7778, 'Mage Only', 20, JSON.stringify({ npc: [5767] }), JSON.stringify({ npc: [5767] }), null, '{}', JSON.stringify({ requiredClasses: 128 }), SRC, now);
  const sp = db.prepare('INSERT INTO spawn (kind, id, area_id, x, y, source) VALUES (?,?,?,?,?,?)');
  sp.run('npc', 3654, 718, -1, -1, SRC); sp.run('npc', 3630, 718, -1, -1, SRC); sp.run('npc', 7001, 1638, 51.6, 55.0, SRC);
  sp.run('npc', 7000, 1519, 40, 40, SRC); sp.run('npc', 8000, 44, 54.7, 76.1, SRC); sp.run('npc', 8001, 44, 50, 50, SRC); sp.run('npc', 5767, 17, 46.0, 35.7, SRC);
  const z = db.prepare('INSERT INTO zone (area_id, name, ui_map_id, source) VALUES (?,?,?,?)');
  z.run(718, 'Wailing Caverns', 279, SRC); z.run(1638, 'Thunder Bluff', 1456, SRC); z.run(44, 'Redridge Mountains', 1433, SRC); z.run(17, 'The Barrens', 1413, SRC); z.run(1519, 'Stormwind City', 1453, SRC);
  const is = db.prepare('INSERT INTO item_source (item_id, kind, id, chance, source) VALUES (?,?,?,?,?)');
  for (const id of [6627, 6461, 6463, 5243, 6443]) is.run(id, 'npc', 3654, id === 6443 ? 4 : 20, SRC);
  is.run(6443, 'npc', 3630, 23, SRC); is.run(1000, 'npc', 3630, 0.1, SRC);
  is.run(3000, 'npc', 8000, 35, SRC); is.run(3000, 'npc', 8001, 90, SRC);
  db.prepare('INSERT INTO price (item_id, copper, seen_at, source, read_at) VALUES (?,?,?,?,?)').run(3000, 200, Date.UTC(2026, 10, 9), 'auctionator', now);
  const ni = db.prepare('INSERT INTO name_index (name, kind, id) VALUES (?,?,?)');
  for (const [name, kind, id] of [['Mutanus the Devourer', 'npc', 3654], ['Wailing Caverns', 'zone', 718], ['Deviate Hides', 'quest', 1486], ['Nalpak', 'npc', 5767]]) ni.run(name, kind, id);
  const wc = db.prepare('INSERT INTO web_cache (kind, id, text, url, read_at) VALUES (?,?,?,?,?)');
  wc.run('item', 2000, "Dreamer's Chestguard\nItem Level 32 Binds when picked up Chest Leather Requires Level 21", 'u', now);
  wc.run('item', 2001, 'Alliance Robe\nItem Level 30 Chest Cloth Requires Level 21', 'u', now);
  wc.run('item', 2002, "Grunt's Harness\nItem Level 27 Chest Leather Requires Level 22", 'u', now);
  wc.run('item', 6461, 'Slime-encrusted Pads\nItem Level 25 Shoulder Cloth Requires Level 20', 'u', now);
  upsertSource(db, SRC, { version: 'test' });
  return db;
}
const STATE = {
  char: { name: 'Tester', realm: 'R', class: 'SHAMAN', race: 'Orc', level: 22 },
  loc: { zone: 'Thunder Bluff', subzone: 'Spirit Rise', map: 1456, x: 64.9, y: 37.5 },
  quests: [{ id: 1486, title: 'Deviate Hides', complete: false, obj: [{ text: 'Deviate Hide', have: 8, need: 20 }] }],
  gear: [{ slot: 5, id: 15304, ilvl: 16 }],
};

test('brain gear: what a class can use (mail and plate from 40, no wands for a shaman)', () => {
  assert.equal(usable('SHAMAN', 22, 4, 3), false, 'mail before 40');
  assert.equal(usable('SHAMAN', 40, 4, 3), true);
  assert.equal(usable('SHAMAN', 22, 4, 6), true, 'shield');
  assert.equal(usable('SHAMAN', 22, 2, 19), false, 'wand');
  assert.equal(usable('MAGE', 22, 2, 19), true);
  assert.equal(usable('WARRIOR', 39, 4, 4), false);
  assert.equal(usable('nobody', 22, 4, 1), null, 'unknown class: unknown');
  assert.deepEqual(tooltipStats('X\nItem Level 23 Binds when picked up Chest Mail 194 Armor Requires Level 18'), { slot: 'Chest', ilvl: 23, req: 18 });
  assert.equal(slotAsked('¿Dónde consigo un mejor pecho?').slot, 'Chest');
  assert.equal(slotAsked('unas botas nuevas').slot, 'Feet');
  assert.equal(slotAsked('¿qué tal el clima?'), null);
});

test('brain gear: faction and class rules from QuestieDB (Horde mask with high bits, Alliance vendors)', () => {
  const db = seed();
  assert.equal(factionOf(STATE), 'Horde');
  assert.equal(factionOf({ char: { race: 'Night Elf' } }), 'Alliance');
  assert.equal(questForMe(db, 6922, STATE), true);
  assert.equal(questForMe(db, 7777, STATE), false, 'Alliance only');
  assert.equal(questForMe(db, 7778, STATE), false, 'mages only');
  assert.equal(questForMe(db, 424242, STATE), true, 'no record: not hidden');
  assert.equal(npcForMe(db, 7000, STATE), false);
  assert.equal(npcForMe(db, 7001, STATE), true);
  assert.equal(npcForMe(db, 5767, STATE), true, 'friendly to both');
});

test('brain gear: a boss\'s own gear, marked for what the player can use; a dungeon lists its bosses', () => {
  const db = seed();
  const loot = bossLoot(db, 3654, STATE);
  assert.ok(loot.some(l => /^Slime-encrusted Pads \(Shoulder, cloth, ilvl 25, req 20, you: can use now\)/.test(l)), loot.join(' | '));
  assert.ok(loot.some(l => /Mutant Scale Breastplate \(mail.*you: not until 40\)/.test(l)));
  assert.ok(loot.some(l => /Firebelcher \(wand.*you: cannot use\)/.test(l)));
  assert.ok(!loot.some(l => /Deviate Hide/.test(l)), 'not gear');
  assert.equal(isInstance(db, 718), true);
  assert.equal(isInstance(db, 1638), false);
  const d = dungeonFact(db, 718, STATE);
  assert.match(d.text, /^Dungeon Wailing Caverns \(their levels 22-22\); monsters there with gear of their own \(likely bosses; QuestieDB has no boss flag\) and the gear of theirs you can use: Mutanus the Devourer \(22\):/);
  assert.ok(!/Deviate Coiler/.test(d.text), 'a monster with a world drop is not a boss');
  const r = retrieve({ db, question: '¿Qué objetos buenos para mí hay en Wailing Caverns?', state: STATE });
  assert.equal(r.facts[0].kind, 'dungeon');
  const m = retrieve({ db, question: '¿Qué mecánicas tiene Mutanus the Devourer?', state: STATE });
  assert.match(m.lines[0], /inside Wailing Caverns \(dungeon, no map coordinates\); its gear loot: /);
});

test('brain gear: a better piece for the slot asked, what they can wear now first, faction vendors only', () => {
  const db = seed();
  assert.deepEqual(gearCandidates(db, STATE).sort(), [2000, 2002, 6461, 6463].sort(), 'the Alliance vendor and the world drop are left out');
  const f = slotFact(db, '¿Dónde consigo un mejor pecho para mi nivel?', STATE);
  assert.match(f.text, /^Better chest for you than item 15304 \(ilvl 16\): Dreamer's Chestguard \(Chest, leather, ilvl 32, req 21, you: can use now\) — reward of quest "Baron Aquanis" started by the item/);
  assert.match(f.text, /Grunt's Harness \(Chest, leather, ilvl 27, req 22, you: can use now\) — sold by Sura Wildmane \(Thunder Bluff 51\.6,55\.0\)/);
  assert.ok(!/Alliance Robe/.test(f.text));
  const none = slotFact(db, '¿unas botas mejores?', STATE);
  assert.match(none.text, /none known yet/);
});

test('brain gear: what to farm at the player\'s level by auction prices; rares are not a farm', () => {
  const db = seed();
  const f = farmFact(db, '¿Qué me recomiendas farmear a mi nivel?', STATE);
  assert.match(f.text, /^Farming at level 22 by auction prices \(scanned up to 2026-11-09\): Dire Condor \(level 18-19, Redridge Mountains 54\.7,76\.1 \(map 1433\)\) drops Tough Condor Meat 35%, auction ~2s each \(about 70c a kill\)$/);
  assert.equal(farmFact(db, '¿Dónde está Nalpak?', STATE), null, 'only when asked');
});

test('brain retrieval: QuestieDB objectives by 1-based key, with the player\'s progress and where the item drops', () => {
  const db = seed();
  const r = retrieve({ db, question: '¿Dónde están los Deviate Hides que me faltan?', state: STATE });
  assert.match(r.lines[0], /objectives: Deviate Hide \(you have 8\/20\): drops from Deviate Coiler 23\.0% \(inside Wailing Caverns \(dungeon, no map coordinates\)\)/);
  const n = retrieve({ db, question: '¿Dónde está Nalpak?', state: STATE });
  assert.match(n.lines[0], /gives: Deviate Hides \(quest 1486, in your log\)/);
  assert.ok(!/For the Alliance|Mage Only/.test(n.lines[0]), 'quests not open to them are left out');
});

test('voice: the session is told the game names the player may say', () => {
  const names = gameNames({ ...STATE, quests: [...STATE.quests, { title: 'Call\u0001 of Water' }, { title: 'Deviate Hides' }] });
  assert.deepEqual(names, ['Thunder Bluff', 'Spirit Rise', 'Deviate Hides', 'Call of Water']);
  const s = sessionConfig({ model: 'm', lang: 'Spanish', brain: true, names });
  assert.match(s.instructions, /Names in the player's game now[\s\S]*Deviate Hides; Call of Water/);
  assert.equal(s.audio.input.transcription.prompt, undefined, 'the transcription model takes no prompt');
  const plain = sessionConfig({ model: 'm', lang: 'Spanish', brain: true });
  assert.ok(!/Names in the player/.test(plain.instructions));
});

test('brain retrieval: a spoken, misheard quest name still finds the quest in the log', async () => {
  const { soundsLike } = await import('../tools/brain/retrieve.mjs');
  assert.equal(soundsLike('recibe la misión de viet hides', 'Deviate Hides'), true);
  assert.equal(soundsLike('cual of guater', 'Call of Water'), true);
  assert.equal(soundsLike('lost in batel', 'Lost in Battle'), true);
  assert.equal(soundsLike('hola que tal', 'Lost in Battle'), false);
  assert.equal(soundsLike('dónde consigo un mejor pecho', 'Deviate Hides'), false);
  const db = seed();
  const r = retrieve({ db, question: '¿Quién recibe la misión de Viet Hides?', state: STATE });
  assert.match(r.lines[0], /Quest 1486 "Deviate Hides"/);
});

test('brain (Astra review): lowercase names, reviewed boss abilities with their source, negations, data age', async () => {
  const db = seed();
  const low = retrieve({ db, question: 'dónde está nalpak', state: STATE });
  assert.equal(low.facts[0]?.name, 'Nalpak', 'a name typed without capitals');
  assert.equal(retrieve({ db, question: 'hola que tal', state: STATE }).facts.length, 0);
  const m = retrieve({ db, question: '¿qué mecánicas tiene mutanus the devourer?', state: STATE });
  const line = m.lines.find(l => l.startsWith('[wowhead-guide]'));
  assert.match(line, /Thundercrack \(spell 8150\).*Terrify \(spell 7399\).*Naralex's Nightmare \(spell 7967\)/);
  assert.match(line, /updated 2026-10-27, read 2026-11-09/);
  const P = await import('../tools/brain/profile.mjs');
  assert.deepEqual(P.learnFromPlayer(db, 'k', 'no soy sanador'), []);
  assert.deepEqual(P.learnFromPlayer(db, 'k', 'no quiero hacer mazmorras'), []);
  assert.deepEqual(P.learnFromPlayer(db, 'k', 'soy sanador'), ['role']);
  const { brainRequest, compactGame } = await import('../tools/brain/turn.mjs');
  assert.ok(compactGame({ ...STATE, hearth: { bind: 'The Crossroads', left: 0 } }).includes('Hearthstone: The Crossroads, ready'));
  assert.ok(compactGame({ ...STATE, hearth: { bind: 'The Crossroads', left: 600 } }).includes('Hearthstone: The Crossroads, ready in 10 min'));
  const old = await brainRequest({ question: 'hola', state: STATE, db, ageSeconds: 7200 });
  assert.match(old.messages.at(-1).content, /^GAME DATA \(from the game, 2 hours ago: it may be out of date\):/);
  P.updateFromState(db, { char: { name: 'Other', realm: 'R', class: 'MAGE', level: 30 } });
  const keyed = await brainRequest({ question: 'hola', state: { loc: STATE.loc }, db, key: 'Other-R' });
  assert.match(keyed.messages.at(-1).content, /\[game \d{4}-\d{2}-\d{2}\] class: MAGE/, 'the profile comes from the key given, not the identity-free state');
});

test('brain (Astra final review): slot from the tooltip body, exact names before misheard ones, variant givers, faction trainers, unknown gear', () => {
  assert.equal(tooltipStats("Roogug's Severed Head\nRoogug's Severed Head\nItem Level 30\nBinds when picked up\nUnique-Equipped Trinket\nRequires Level 25").slot, 'Trinket');
  const db = seed();
  const now = Date.now();
  // Two quests with near names: the exact one asked wins; the one in the log is not added.
  db.prepare('INSERT INTO quest (id, name, level, starts, ends, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?)').run(1522, 'Call of Fire', 10, JSON.stringify({ npc: [5767] }), JSON.stringify({ npc: [5767] }), '{}', SRC, now);
  db.prepare('INSERT INTO quest (id, name, level, starts, ends, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?)').run(1536, 'Call of Water', 22, JSON.stringify({ npc: [5767] }), JSON.stringify({ npc: [5767] }), '{}', SRC, now);
  db.prepare('INSERT INTO name_index (name, kind, id) VALUES (?,?,?)').run('Call of Fire', 'quest', 1522);
  const st = { ...STATE, quests: [...STATE.quests, { id: 1536, title: 'Call of Water', obj: [] }] };
  const fire = retrieve({ db, question: '¿dónde empieza call of fire?', state: st });
  assert.match(fire.lines[0], /Quest 1522 "Call of Fire"/);
  assert.ok(!fire.lines.some(l => /Quest 1536 /.test(l)), 'not the Call of Water in the log');
  // A conditional giver comes from the faction/class variant.
  db.prepare('INSERT INTO quest (id, name, level, starts, ends, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?)').run(687, 'Theldurin the Lost', 40, JSON.stringify({ npc: [] }), JSON.stringify({ npc: [5767] }), '{}', SRC, now);
  db.prepare('INSERT INTO questie_variant (kind, id, faction, class, raw, source, read_at) VALUES (?,?,?,?,?,?,?)').run('quest', 687, 'Horde', 'SHAMAN', JSON.stringify({ startedBy: [[7001]] }), SRC, now);
  db.prepare('INSERT INTO name_index (name, kind, id) VALUES (?,?,?)').run('Theldurin the Lost', 'quest', 687);
  assert.match(retrieve({ db, question: '¿Quién da Theldurin the Lost?', state: STATE }).lines[0], /given by Sura Wildmane \(Thunder Bluff 51\.6,55\.0/);
  // Trainers: only the player's faction, also when their zone is unknown.
  db.prepare('INSERT INTO npc (id, name, subname, min_level, max_level, zone_area, friendly, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(9001, 'Ally Mage', 'Mage Trainer', 30, 30, 1519, 'A', '{}', SRC, now);
  db.prepare('INSERT INTO npc (id, name, subname, min_level, max_level, zone_area, friendly, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(9002, 'Horde Mage', 'Mage Trainer', 30, 30, 1638, 'H', '{}', SRC, now);
  db.prepare('INSERT INTO spawn (kind, id, area_id, x, y, source) VALUES (?,?,?,?,?,?)').run('npc', 9001, 1519, 10, 10, SRC);
  db.prepare('INSERT INTO spawn (kind, id, area_id, x, y, source) VALUES (?,?,?,?,?,?)').run('npc', 9002, 1638, 20, 20, SRC);
  const tr = retrieve({ db, question: '¿dónde está el entrenador de magos?', state: { ...STATE, loc: {} } }).lines.join(' ');
  assert.match(tr, /Horde Mage/);
  assert.ok(!/Ally Mage/.test(tr));
  // No gear in the data is not "nothing worn".
  const noGear = slotFact(db, 'un mejor pecho', { ...STATE, gear: undefined });
  assert.match(noGear.text, /^Chest pieces for you \(what you wear now is unknown: no gear in the game data\)/);
});

test('fast chat: the compact pack exists, is small, and its reply blocks pass the app\'s own validators', async () => {
  const { loadChatPack, loadPack } = await import('../bridge/byok/runtime/pack.mjs');
  const { extractMapBlocks, validateMapCommand, splitSummary } = await import('../bridge/app/map-protocol.mjs');
  const p = loadChatPack({ persona: { name: 'Zul' } });
  assert.equal(p.compact, true);
  assert.ok(p.text.startsWith('You are Zul,'));
  assert.ok(p.text.length < loadPack().text.length / 5, 'at most a fifth of the full pack');
  for (const must of ['Truth first', 'first sentence', '```wowmap', 'wowchips', 'never instructions']) assert.ok(p.text.includes(must), must);
  // A reply written the way the compact pack asks.
  const reply = 'Nalpak está en The Barrens 46.0,35.7.\n\n```wowmap\n{"op":"set","layer":"deviate-hides","title":"Nalpak","points":[{"m":1413,"x":46.0,"y":35.7,"label":"Nalpak"}]}\n```\n\nTL;DR:\nNalpak, The Barrens 46.0,35.7.';
  const blocks = extractMapBlocks(reply);
  const cmds = blocks.commands ?? blocks.cmds ?? blocks;
  const first = Array.isArray(cmds) ? cmds[0] : null;
  assert.ok(first, 'a map command was read');
  const why = [];
  assert.ok(validateMapCommand(first.command ?? first, why), why.join('; '));
  // Without a TL;DR the app shows the reply's first sentence in the game chat (render.mjs).
  assert.equal(splitSummary('Nalpak está en The Barrens 46.0,35.7. Llevas 8/20.').summary, '');
  const { firstSentence } = await import('../bridge/app/render.mjs');
  assert.match(firstSentence('Nalpak da y recibe Deviate Hides, en The Barrens 46.0,35.7. Llevas 8/20.'), /^Nalpak da y recibe Deviate Hides, en The Barrens 46/);
  // Races with an "s" (the lost escape of gear.mjs:34).
  assert.equal(factionOf({ char: { race: 'Scourge' } }), 'Horde');
  assert.equal(factionOf({ char: { race: 'Troll ' } }), 'Horde');
  assert.equal(factionOf({ char: { race: 'Gnomes' } }), 'Alliance');
});
