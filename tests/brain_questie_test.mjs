import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { decodeCBOR, parseMetadata, storedValue, importQuestie, questieEntity, DEFAULT_ADDON_DIR, SOURCE } from '../tools/brain/questie.mjs';
import { openBrain } from '../tools/brain/db.mjs';

test('CBOR: integers, strings, bytes, arrays, maps, booleans, null and floats', () => {
  const decode = hex => decodeCBOR(Buffer.from(hex, 'hex'));
  for (const [hex, value] of [['00', 0], ['1818', 24], ['190100', 256], ['1a00010000', 65536],
    ['1b0000000100000000', 4294967296], ['20', -1], ['3863', -100], ['f4', false], ['f5', true],
    ['f6', null], ['f7', null], ['f93e00', 1.5], ['fa47c35000', 100000], ['fb3ff199999999999a', 1.1],
    ['62c3b1', 'ñ'], ['60', '']]) assert.equal(decode(hex), value);
  assert.deepEqual(decode('43010203'), Buffer.from([1, 2, 3]));
  assert.deepEqual(decode('8301f6820203'), [1, null, [2, 3]]);
  assert.deepEqual({ ...decode('a20161616170820102') }, { 1: 'a', p: [1, 2] });
  assert.deepEqual({ ...decode('a141701a02005086') }, { p: 33575046 });
  assert.equal(decode('c101'), 1); // Tagged value: the underlying value is retained.
  assert.deepEqual(decode('9f0102ff'), [1, 2]);
  assert.equal(decode('7f61616162ff'), 'ab');
  assert.ok(Number.isNaN(decode('f97e00')));
  assert.equal(decode('f97c00'), Infinity);
});

test('CBOR rejects truncated, trailing, unsafe and malformed data', () => {
  for (const hex of ['', '1901', '6161ff', 'ff', '1c', '1bffffffffffffffff', 'a201010102', 'bf01ff', '5f6161ff']) {
    assert.throws(() => decodeCBOR(Buffer.from(hex, 'hex')), /CBOR/);
  }
});

test('metadata chunks are joined in numbered order and missing chunks fail', () => {
  const m = parseMetadata('## X-Quest-IDS: ~2~\n## X-Quest-IDS-2: ID\n## X-Quest-IDS-1: AQ\n## Version: 1.0.13\n');
  assert.equal(storedValue(m, 'X-Quest-IDS'), 'AQID');
  assert.equal(storedValue(m, 'Version'), '1.0.13');
  assert.equal(storedValue(m, 'absent'), undefined);
  m.delete('X-Quest-IDS-2');
  assert.throws(() => storedValue(m, 'X-Quest-IDS'), /part 2/);
  assert.throws(() => storedValue(new Map([['bad', '~0~']]), 'bad'), /chunk/);
  assert.throws(() => parseMetadata('## X-Quest-2-S: a\n## X-Quest-2-S: b'), /Duplicate/);
});

test('schema v1 gains provenance columns without losing existing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-questie-schema-'));
  const file = path.join(dir, 'brain.sqlite');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE spawn(kind TEXT,id INTEGER,area_id INTEGER,x REAL,y REAL,source TEXT); INSERT INTO spawn VALUES('npc',42,17,1,2,'other')");
  old.close();
  const db = openBrain(file);
  try {
    assert.equal(db.prepare('SELECT source FROM spawn WHERE id=42').get().source, 'other');
    assert.equal(db.prepare('SELECT value FROM meta WHERE key=?').get('schema').value, '2');
    for (const table of ['spawn', 'zone', 'item_source']) assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'read_at'));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

const tocFile = path.join(DEFAULT_ADDON_DIR, 'QuestieDB_Forever.toc');
test('real Forever import: facts, corrections, provenance, atomicity, repeatability and lookup', { skip: !fs.existsSync(tocFile) }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-questie-integration-'));
  const file = path.join(dir, 'brain.sqlite'), db = openBrain(file);
  const hash = () => createHash('sha256').update(fs.readFileSync(tocFile)).digest('hex');
  const before = hash(), now = 1794200000000;
  try {
    db.prepare('INSERT INTO name_index(name,kind,id) VALUES(?,?,?)').run('External fact', 'item', 9999999);
    db.prepare('INSERT INTO item(id,name,source,read_at) VALUES(?,?,?,?)').run(9999999, 'External fact', 'other', 1);
    db.prepare('INSERT INTO fact(char_key,key,value,source,at) VALUES(?,?,?,?,?)').run('Private-Character', 'role', 'healer', 'player', 1);
    const result = importQuestie({ addonDir: DEFAULT_ADDON_DIR, db, now });
    assert.deepEqual([result.quest, result.npc, result.item, result.object], [5233, 13417, 21442, 7045]);
    assert.equal(result.corrections.dynamicProviders.length, 8);
    assert.equal(result.corrections.contexts, 20); // Ten positive Forever class masks, two factions.
    const quest = db.prepare('SELECT * FROM quest WHERE id=2').get();
    // Literal facts decoded from X-Quest-2-S/-2/-3/-8 in the installed 1.0.13 TOC.
    assert.equal(quest.name, "Sharptalon's Claw");
    assert.deepEqual(JSON.parse(quest.starts), { npc: [], object: [], item: [16305] });
    assert.deepEqual(JSON.parse(quest.ends), { npc: [12696], object: [], item: [] });
    assert.match(quest.objectives_text, /Senani Thunderheart.*Splintertree Post, Ashenvale/);
    assert.equal(quest.races, 8589934770, '64-bit CBOR mask must not truncate to 32 bits');
    assert.equal(quest.source, SOURCE); assert.equal(quest.read_at, now);
    assert.deepEqual(JSON.parse(quest.pre_quests), { group: null, single: [6383] });
    const npc = questieEntity(db, 'npc', 5901);
    assert.equal(npc.name, 'Islen Waterseer');
    assert.deepEqual(npc.spawns, { 17: [[65.83, 43.78]] });
    assert.equal(npc.minLevelHealth, 0); assert.equal(npc.maxLevelHealth, 1);
    const spawn = db.prepare("SELECT * FROM spawn WHERE kind='npc' AND id=5901").get();
    assert.deepEqual([spawn.area_id, spawn.x, spawn.y, spawn.read_at], [17, 65.83, 43.78, now]);
    assert.equal(db.prepare("SELECT id FROM item_source WHERE item_id=16305 AND kind='npc'").get().id, 12676);
    // classicItemDrops.lua: Cmangos quest-item 182 / NPC 103 is 100 percent.
    assert.equal(db.prepare("SELECT chance FROM item_source WHERE item_id=182 AND kind='npc' AND id=103").get().chance, 100);
    // itemDropCorrections.lua explicitly selects WOWHEAD for item 725 / NPC 98.
    assert.equal(db.prepare("SELECT chance FROM item_source WHERE item_id=725 AND kind='npc' AND id=98").get().chance, 14.1684);
    const zone = db.prepare('SELECT * FROM zone WHERE area_id=718').get();
    assert.deepEqual([zone.name, zone.ui_map_id, zone.parent_area], ['Wailing Caverns', 279, 17]);
    assert.equal(db.prepare('SELECT ui_map_id FROM zone WHERE area_id=17').get().ui_map_id, 1413);
    assert.equal(db.prepare('SELECT quality FROM item WHERE id=16305').get().quality, null);
    // Original legacy dynamic providers: quest 8315 varies by class, NPC 12138 by faction.
    assert.equal(questieEntity(db, 'quest', 8315).nextQuestInChain, null);
    assert.equal(questieEntity(db, 'quest', 8315, { faction: 'Horde', class: 'SHAMAN' }).nextQuestInChain, 8380);
    assert.equal(questieEntity(db, 'quest', 8315, { faction: 'Horde', class: 'WARRIOR' }).nextQuestInChain, 8316);
    assert.deepEqual(questieEntity(db, 'npc', 12138, { faction: 'Horde', class: 'DRUID' }).spawns, { 17: [[41.96, 60.79]] });
    assert.equal(questieEntity(db, 'npc', 12138).spawns, null);
    // Forever/foreverQuestFixes.lua, LoadDynamic: Horde correction wins over baked data.
    assert.deepEqual(questieEntity(db, 'quest', 78124, { faction: 'Horde', class: 'SHAMAN' }).startedBy, [[211022], [409496]]);
    assert.match(questieEntity(db, 'quest', 78124, { faction: 'Horde', class: 'SHAMAN' }).objectivesText[0], /Owen Thadd in Undercity/);
    assert.equal(db.prepare('SELECT read_at FROM source WHERE name=?').get(SOURCE).read_at, now);
    const started = performance.now();
    const hits = db.prepare('SELECT name,kind,id FROM name_index WHERE name_index MATCH ? LIMIT 10').all('"Islen Waterseer"');
    const lookupMs = performance.now() - started;
    assert.ok(hits.some(h => h.kind === 'npc' && h.id === 5901));
    assert.ok(lookupMs < 100, `name lookup took ${lookupMs} ms`);
    const totals = () => Object.fromEntries(['quest','npc','item','object','spawn','zone','item_source','name_index','questie_variant','brain_name_owner'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
    const firstTotals = totals();
    const repeat = importQuestie({ addonDir: DEFAULT_ADDON_DIR, db, now: now + 1 });
    assert.deepEqual(totals(), firstTotals);
    assert.equal(repeat.spawn, result.spawn); assert.equal(repeat.item_source, result.item_source);
    assert.equal(db.prepare('SELECT read_at FROM quest WHERE id=2').get().read_at, now + 1);
    assert.equal(db.prepare('SELECT source FROM item WHERE id=9999999').get().source, 'other');
    assert.equal(db.prepare('SELECT count(*) AS n FROM name_index WHERE name=?').get('External fact').n, 1);
    assert.equal(db.prepare('SELECT value FROM fact WHERE char_key=?').get('Private-Character').value, 'healer');
    // Fail after deletion and entity inserts: every old entity/name/source must roll back.
    db.exec("CREATE TEMP TRIGGER reject_import BEFORE INSERT ON spawn BEGIN SELECT RAISE(ABORT, 'forced import failure'); END");
    assert.throws(() => importQuestie({ addonDir: DEFAULT_ADDON_DIR, db, now: now + 2 }), /forced import failure/);
    assert.deepEqual(totals(), firstTotals);
    assert.equal(db.prepare('SELECT read_at FROM source WHERE name=?').get(SOURCE).read_at, now + 1);
    assert.equal(db.prepare('SELECT read_at FROM quest WHERE id=2').get().read_at, now + 1);
    assert.equal(hash(), before, 'the real addon TOC remains unchanged');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    t.diagnostic(JSON.stringify({ import_ms: result.elapsed_ms, repeat_ms: repeat.elapsed_ms, lookup_ms: lookupMs, bytes: fs.statSync(file).size, counts: firstTotals }));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI rejects output inside the read-only addon before creating it', { skip: !fs.existsSync(tocFile) }, () => {
  const file = path.join(DEFAULT_ADDON_DIR, 'nqa-forbidden-output.sqlite');
  assert.equal(fs.existsSync(file), false);
  const result = spawnSync(process.execPath, ['tools/brain/questie.mjs', 'import', '--brain', file], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /read-only addon/);
  assert.equal(fs.existsSync(file), false);
});
