// The companion's local brain (odd/tasks/nqa-brain.md B4): one SQLite file in the app's data folder,
// through Node's built-in node:sqlite (nothing to install). Two kinds of rows, never mixed:
//   - data: game knowledge and the player's facts, each with its source and when it was read
//     (QuestieDB, Wowhead, the game state, another addon's saved data, the player's own words);
//   - said: what a model said, kept for the history, never read back as a fact.
//
//   openBrain(file)                → db (schema created or migrated)
//   brainFile(appData)             → <appData>/brain/brain.sqlite
//   upsertSource(db, name, info)   → records an import (version, when)
//
// Knowledge is shared by every character (the game is the same); profile, said and history rows
// carry a character key ("Name-Realm"), never sent to a model unless the player shares identity.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- Where data came from: one row per import (questiedb 1.0.13, wowhead, game, auctionator...).
CREATE TABLE IF NOT EXISTS source (name TEXT PRIMARY KEY, version TEXT, read_at INTEGER, detail TEXT);

-- Game knowledge (shared). raw keeps the source's own fields (JSON), the columns are what lookups need.
CREATE TABLE IF NOT EXISTS quest (
  id INTEGER PRIMARY KEY, name TEXT, level INTEGER, req_level INTEGER, zone_area INTEGER,
  starts TEXT, ends TEXT, objectives_text TEXT, objectives TEXT, pre_quests TEXT, next_quest INTEGER,
  races INTEGER, classes INTEGER, raw TEXT, source TEXT NOT NULL, read_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS npc (
  id INTEGER PRIMARY KEY, name TEXT, subname TEXT, min_level INTEGER, max_level INTEGER,
  zone_area INTEGER, friendly TEXT, raw TEXT, source TEXT NOT NULL, read_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS object (
  id INTEGER PRIMARY KEY, name TEXT, zone_area INTEGER, raw TEXT, source TEXT NOT NULL, read_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS item (
  id INTEGER PRIMARY KEY, name TEXT, quality INTEGER, level INTEGER, slot TEXT, raw TEXT,
  source TEXT NOT NULL, read_at INTEGER NOT NULL);
-- Where an NPC or object stands: zone (areaId) and percent coordinates on that zone's map.
CREATE TABLE IF NOT EXISTS spawn (kind TEXT NOT NULL, id INTEGER NOT NULL, area_id INTEGER, x REAL, y REAL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS spawn_by_entity ON spawn (kind, id);
-- Zones: name and the uiMapID the map pins use.
CREATE TABLE IF NOT EXISTS zone (area_id INTEGER PRIMARY KEY, name TEXT, ui_map_id INTEGER, parent_area INTEGER, source TEXT NOT NULL);
-- Who drops, sells or holds an item (from the item's sources), for "where do I get X".
CREATE TABLE IF NOT EXISTS item_source (item_id INTEGER NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL, chance REAL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS item_source_by_item ON item_source (item_id);
CREATE INDEX IF NOT EXISTS item_source_by_holder ON item_source (kind, id);
-- Names to find things by (FTS5): kind is quest, npc, object, item or zone.
CREATE VIRTUAL TABLE IF NOT EXISTS name_index USING fts5 (name, kind UNINDEXED, id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
-- FTS5 cannot gain columns via ALTER TABLE. Track importer-owned names separately.
CREATE TABLE IF NOT EXISTS brain_name_owner (rowid INTEGER PRIMARY KEY, source TEXT NOT NULL, read_at INTEGER NOT NULL);
-- Character-dependent QuestieDB fields must not become universal shared facts.
-- raw is a named-field patch over the shared entity; JSON null explicitly clears a field.
CREATE TABLE IF NOT EXISTS questie_variant (
  kind TEXT NOT NULL, id INTEGER NOT NULL, faction TEXT NOT NULL, class TEXT NOT NULL,
  raw TEXT NOT NULL, source TEXT NOT NULL, read_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id, faction, class));
-- Web lookups by id (Wowhead), kept so a second ask is instant.
CREATE TABLE IF NOT EXISTS web_cache (kind TEXT NOT NULL, id INTEGER NOT NULL, text TEXT, url TEXT, read_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
-- Other addons' saved data (Auctionator prices, Syndicator inventories, RXPGuides step), per what they hold.
CREATE TABLE IF NOT EXISTS price (item_id INTEGER PRIMARY KEY, copper INTEGER, seen_at INTEGER, source TEXT NOT NULL, read_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS holding (char_key TEXT NOT NULL, place TEXT NOT NULL, item_id INTEGER NOT NULL, count INTEGER, source TEXT NOT NULL, read_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS holding_by_item ON holding (item_id);
CREATE TABLE IF NOT EXISTS guide (char_key TEXT PRIMARY KEY, guide TEXT, step INTEGER, step_text TEXT, source TEXT NOT NULL, read_at INTEGER NOT NULL);

-- The player (per character). fact: something known about them with its source (game, or "player"
-- for their own words). said: what a model said (history only, never used as a fact).
CREATE TABLE IF NOT EXISTS fact (char_key TEXT NOT NULL, key TEXT NOT NULL, value TEXT, source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (char_key, key));
CREATE TABLE IF NOT EXISTS said (char_key TEXT NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL, channel TEXT, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS said_by_char ON said (char_key, at);
`;

/** <appData>/brain/brain.sqlite */
export function brainFile(appData) {
  return path.join(appData, 'brain', 'brain.sqlite');
}

/** Open (and create) the brain. WAL so the bridge and the voice server can read while one writes. */
export function openBrain(file, { readOnly = false } = {}) {
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
    db.exec(SCHEMA);
    // Additive v1 -> v2 migration; old callers may continue omitting these columns.
    for (const table of ['spawn', 'zone', 'item_source']) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      if (!columns.has('read_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN read_at INTEGER`);
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema', String(SCHEMA_VERSION));
  }
  return db;
}

/** Record where a set of rows came from. */
export function upsertSource(db, name, { version = null, detail = null, at = Date.now() } = {}) {
  db.prepare('INSERT INTO source (name, version, read_at, detail) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version, read_at = excluded.read_at, detail = excluded.detail')
    .run(name, version, at, detail == null ? null : String(detail));
}

/** Run fn inside one transaction (imports write tens of thousands of rows). */
export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
