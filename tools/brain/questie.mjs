// Local, read-only QuestieDB 1.0.13 Forever importer. No game API, network or addon writes.
// The TOC contains the static corrections already. Dynamic providers are executed with the
// addon's own registry/tablePatch/normalizers using the existing fengari dependency.
// Shared rows contain only context-independent facts. Differing fields are null and named
// in raw._conditionalFields; questie_variant stores their patches for each faction/class.
// Retrieval MUST select a variant before answering about a conditional field (see below).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { openBrain, brainFile, upsertSource, inTransaction } from './db.mjs';

export const DEFAULT_ADDON_DIR = 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns\\QuestieDB';
export const SOURCE = 'questiedb-1.0.13';
const ENTITIES = ['Quest', 'Npc', 'Item', 'Object'];
const require = createRequire(import.meta.url);

/** CBOR major types 0..7, including indefinite containers and IEEE half/single/double.
 * Maps retain Lua's numeric keys (1-based); arrays are JS arrays (0-based). Tags unwrap.
 * Unsafe integers, duplicate map keys, malformed/truncated data and trailing bytes fail. */
export function decodeCBOR(input) {
  const b = Buffer.from(input);
  let pos = 0;
  const fail = message => { throw new Error(`CBOR at byte ${pos}: ${message}`); };
  const take = n => {
    if (!Number.isSafeInteger(n) || n < 0 || n > b.length - pos) fail('truncated value');
    const p = pos; pos += n; return p;
  };
  const uint = ai => {
    if (ai < 24) return ai;
    if (ai === 24) return b.readUInt8(take(1));
    if (ai === 25) return b.readUInt16BE(take(2));
    if (ai === 26) return b.readUInt32BE(take(4));
    if (ai === 27) {
      const n = b.readBigUInt64BE(take(8));
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('unsafe integer');
      return Number(n);
    }
    fail('invalid additional information');
  };
  const read = (depth = 0) => {
    if (depth > 100) fail('nesting limit');
    const byte = b[take(1)], major = byte >> 5, ai = byte & 31;
    if (major === 7) {
      if (ai === 20 || ai === 21) return ai === 21;
      if (ai === 22 || ai === 23) return null;
      if (ai === 25) {
        const h = b.readUInt16BE(take(2)), e = (h >> 10) & 31, f = h & 1023;
        return (h & 32768 ? -1 : 1) * (e === 31 ? (f ? NaN : Infinity) : e === 0 ? f * 2 ** -24 : (1 + f / 1024) * 2 ** (e - 15));
      }
      if (ai === 26) return b.readFloatBE(take(4));
      if (ai === 27) return b.readDoubleBE(take(8));
      fail('unsupported simple value or unexpected break');
    }
    const indefinite = ai === 31;
    if (indefinite && (major < 2 || major > 5)) fail('invalid indefinite value');
    const n = indefinite ? null : uint(ai);
    if (major === 0) return n;
    if (major === 1) {
      if (!Number.isSafeInteger(-1 - n)) fail('unsafe negative integer');
      return -1 - n;
    }
    if (major === 2 || major === 3) {
      if (!indefinite) {
        const p = take(n), bytes = b.subarray(p, p + n);
        return major === 2 ? Buffer.from(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
      const parts = [];
      while (b[pos] !== 255) {
        if (pos >= b.length || b[pos] >> 5 !== major || (b[pos] & 31) === 31) fail('invalid string chunk');
        parts.push(read(depth + 1));
      }
      take(1);
      return major === 2 ? Buffer.concat(parts) : parts.join('');
    }
    if (major === 4 || major === 5) {
      if (n !== null && n > b.length - pos) fail('impossible container length');
      const out = major === 4 ? [] : Object.create(null);
      let i = 0;
      while (indefinite ? b[pos] !== 255 : i < n) {
        let key = read(depth + 1);
        if (major === 4) out.push(key);
        else {
          // WoW serializes Lua strings as byte strings, including map key "p".
          if (Buffer.isBuffer(key)) key = new TextDecoder('utf-8', { fatal: true }).decode(key);
          if (typeof key !== 'string' && typeof key !== 'number') fail('unsupported map key');
          if (Object.hasOwn(out, key)) fail('duplicate map key');
          out[key] = read(depth + 1);
        }
        i++;
      }
      if (indefinite) take(1);
      return out;
    }
    if (major === 6) return read(depth + 1);
    fail('invalid major type');
  };
  const value = read();
  if (pos !== b.length) fail('trailing bytes');
  return value;
}

export function parseMetadata(toc) {
  const out = new Map();
  for (const line of toc.split(/\r?\n/)) {
    const match = /^## ([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (out.has(match[1])) throw new Error(`Duplicate metadata key ${match[1]}`);
    out.set(match[1], match[2].trim());
  }
  return out;
}

export function storedValue(metadata, key) {
  const value = metadata.get(key);
  if (!value?.startsWith('~')) return value;
  const match = /^~([1-9]\d*)~$/.exec(value);
  if (!match || +match[1] > 100000) throw new Error(`Invalid chunk header for ${key}`);
  const parts = [];
  for (let i = 1; i <= +match[1]; i++) {
    const part = metadata.get(`${key}-${i}`);
    if (part === undefined) throw new Error(`${key}: part ${i} is missing`);
    parts.push(part);
  }
  return parts.join('');
}

function base64(value, key) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid or missing base64 metadata ${key}`);
  }
  return Buffer.from(value, 'base64');
}

function addonCBOR(bytes) {
  const strings = v => {
    if (Buffer.isBuffer(v)) return new TextDecoder('utf-8', { fatal: true }).decode(v);
    if (Array.isArray(v)) return v.map(strings);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strings(x)]));
    return v;
  };
  return strings(decodeCBOR(bytes));
}

// A Lua table's position n regardless of its CBOR array/map representation.
const at = (v, n) => Array.isArray(v) ? v[n - 1] : v?.[n];
const values = v => v == null ? [] : Object.values(v);
const entries = v => Array.isArray(v) ? v.map((x, i) => [i + 1, x]) : Object.entries(v ?? {});
const json = v => JSON.stringify(v ?? null);

function luaRuntime() {
  const { lua, lauxlib, lualib, to_luastring: str, to_jsstring: text } = require('fengari');
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const push = v => {
    if (v == null) lua.lua_pushnil(L);
    else if (typeof v === 'string') lua.lua_pushstring(L, str(v));
    else if (typeof v === 'number') lua.lua_pushnumber(L, v); // Fengari integers are 32-bit.
    else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
    else {
      lua.lua_newtable(L);
      for (const [k, child] of entries(v)) {
        if (child == null) continue;
        push(/^\d+$/.test(String(k)) ? Number(k) : k); push(child); lua.lua_settable(L, -3);
      }
    }
  };
  const get = (idx, depth = 0) => {
    if (depth > 80) throw new Error('Lua table depth exceeded');
    const type = lua.lua_type(L, idx);
    if (type === lua.LUA_TNIL) return null;
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx);
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
    if (type === lua.LUA_TSTRING) return text(lua.lua_tostring(L, idx));
    if (type !== lua.LUA_TTABLE) throw new Error('Expected Lua data, not executable value');
    const abs = lua.lua_absindex(L, idx), out = Object.create(null);
    lua.lua_pushnil(L);
    while (lua.lua_next(L, abs)) {
      const k = get(-2, depth + 1);
      out[k] = get(-1, depth + 1);
      lua.lua_pop(L, 1);
    }
    const keys = Object.keys(out);
    if (keys.length && keys.every((k, i) => k === String(i + 1))) return keys.map(k => out[k]);
    return Object.fromEntries(Object.entries(out));
  };
  const run = (code, name = 'importer') => {
    const top = lua.lua_gettop(L);
    try {
      if (lauxlib.luaL_loadbuffer(L, str(code), null, str(name)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
        throw new Error(`Lua ${name}: ${text(lua.lua_tostring(L, -1))}`);
      }
      return get(-1);
    } finally { lua.lua_settop(L, top); }
  };
  const bind = (name, fn) => {
    lua.lua_pushjsfunction(L, () => {
      try {
        const args = Array.from({ length: lua.lua_gettop(L) }, (_, i) => get(i + 1));
        push(fn(...args)); return 1;
      } catch (e) { lua.lua_pushstring(L, str(e.message)); return lua.lua_error(L); }
    });
    lua.lua_setglobal(L, str(name));
  };
  // No filesystem/process/module capabilities are exposed to addon code. load is used only
  // for the addon's embedded support tables, in this same restricted environment.
  run('io=nil; os=nil; package=nil; require=nil; dofile=nil; loadfile=nil; debug=nil; print=function() end; Lib={}; loadstring=load');
  return { run, bind, close: () => lua.lua_close(L) };
}

function loadAddon(addonDir) {
  const toc = fs.readFileSync(path.join(addonDir, 'QuestieDB_Forever.toc'), 'utf8');
  const metadata = parseMetadata(toc);
  if (metadata.get('Version') !== '1.0.13' || metadata.get('X-Flavor') !== 'Forever') {
    throw new Error('This importer requires QuestieDB 1.0.13 Forever; refusing to label another version as this source');
  }
  const vm = luaRuntime();
  const readFile = relative => fs.readFileSync(path.join(addonDir, relative), 'utf8');
  const load = relative => vm.run(`local function chunk(...)\n${readFile(relative)}\nend\nchunk("QuestieDB", Lib)`, relative);
  try {
    load('src/config.lua'); load('src/meta/normalize.lua');
    for (const entity of ENTITIES) load(`src/meta/${entity.toLowerCase()}Meta.lua`);
    const metas = vm.run('return {Quest=Lib.Meta.Quest,Npc=Lib.Meta.Npc,Item=Lib.Meta.Item,Object=Lib.Meta.Object}');
    const rows = {};
    for (const entity of ENTITIES) {
      const meta = metas[entity], prefix = `X-${entity}-`;
      // Verified against this release: method 1 is zlib-wrapped DEFLATE (inflateSync).
      // inflateRaw and gunzip both reject the actual IDS payloads.
      const ids = decodeCBOR(inflateSync(base64(storedValue(metadata, prefix + 'IDS'), prefix + 'IDS'), { maxOutputLength: 32 * 1024 * 1024 }));
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error(`Invalid ${entity} IDS`);
      rows[entity] = new Map();
      for (const id of ids) {
        const key = `${prefix}${id}`, scalar = addonCBOR(base64(storedValue(metadata, key + '-S'), key + '-S'));
        const row = {};
        for (const [name, index] of Object.entries(meta.keys)) {
          const type = at(meta.types, index);
          const constant = at(meta.constantValues, index);
          let value = constant ?? at(scalar, index);
          if (type === 'table') {
            value = null;
            if (Math.floor((scalar.p ?? 0) / 2 ** (index - 1)) % 2 === 1) {
              value = addonCBOR(base64(storedValue(metadata, `${key}-${index}`), `${key}-${index}`));
            }
          }
          // Baked tables/scalars are normalized at generation. Reconstruct omitted defaults.
          if (value == null && type === 'number') value = 0;
          if (value == null && ['questgivers', 'objectives'].includes(at(meta.structures, index))) value = {};
          row[name] = value ?? null;
        }
        rows[entity].set(id, row);
      }
    }
    vm.run('Lib.mode="baked"; Lib.flavor=Lib.config.flavorByName.Forever; FACTION="Horde"; CLASS="SHAMAN"; UnitFactionGroup=function() return FACTION end; UnitClassBase=function() return CLASS end');
    load('src/corrections/tablePatch.lua');
    const files = toc.split(/\r?\n/).map(s => s.trim().replaceAll('\\', '/'));
    for (const f of files.filter(f => /^src\/corrections\/enum\/[a-zA-Z]+\.lua$/.test(f))) load(f);
    load('src/support/data.lua'); load('src/support/_begin.lua');
    for (const f of files.filter(f => /^support\/Forever\/(Zones|DropTables)\/[a-zA-Z]+\.lua$/.test(f))) load(f);
    load('src/support/_end.lua');
    const support = vm.run(`
      local z=Lib.Support.Get("ZoneDB").private
      local function decode(v) if type(v)=="string" then return assert(load(v))() end return v or {} end
      local function merged(base, over) local t=decode(base); for k,v in pairs(decode(over)) do t[k]=v end return t end
      local drops=Lib.Support.Get("QuestieClassicItemDrops")
      return {maps=merged(z.areaIdToUiMapId,z.areaIdToUiMapIdOverride),
        parents=merged(z.subZoneToParentZone,z.subZoneToParentZoneOverride),dungeons=z.dungeons,
        wowhead=decode(drops.wowheadData),pserver=decode(drops.cmangosData),
        dropCorrections=Lib.Support.Get("QuestieItemDropCorrections").Era,
        dropKeys=Lib.Enum.dropCorrectionKeys}
    `);
    // Numeric assignments' source comments supply human names; enum tokens are not names.
    support.names = {};
    for (const line of readFile('support/Forever/Zones/areaIdToUiMapId.lua').split(/\r?\n/)) {
      const m = /^\s*\[(\d+)\]\s*=\s*\d+,\s*-- (.+)$/.exec(line);
      if (m && !/^(Existing|Synthetic|Referenced|Legacy|No |Retain)/i.test(m[2])) support.names[m[1]] = m[2].split(/\s+->\s+|:\s+/)[0].trim();
    }
    for (const [id, dungeon] of entries(support.dungeons)) support.names[id] = at(dungeon, 1);
    load('src/corrections/registry.lua'); load('src/corrections/compat.lua'); load('src/corrections/register.lua');
    load('src/corrections/_begin.lua');
    const correctionFiles = files.filter(f => /^src\/corrections\/Forever\/(legacy\/classic|forever)(Quest|NPC|Item|Object)Fixes\.lua$/.test(f));
    if (correctionFiles.length !== 8) throw new Error('Expected all eight Forever dynamic provider files');
    for (const f of correctionFiles) load(f);
    load('src/corrections/manifest.lua'); load('src/corrections/_end.lua');
    vm.bind('baseField', (entity, id, index) => rows[entity].get(id)?.[at(metas[entity].names, index)] ?? null);
    vm.run(`for _,e in ipairs(Lib.config.entityTypes) do
      local name=e.name
      Lib[name]={GetRaw=function(id,key) return baseField(name,id,key) end, SetOverlay=function() end}
    end`);
    const classes = vm.run('return Lib.Enum.byExpansion.Forever.classKeys or Lib.Enum.byExpansion.Classic.classKeys');
    const classNames = Object.keys(classes).filter(k => /^[A-Z]+$/.test(k) && k !== 'ALL' && classes[k] > 0);
    if (!classNames.includes('SHAMAN') || !classNames.includes('WARRIOR')) throw new Error('Missing class enum');
    const contexts = [];
    for (const faction of ['Horde', 'Alliance']) for (const cls of classNames) {
      // Both are from bounded enums, not interpolated user input.
      const overlay = vm.run(`FACTION="${faction}"; CLASS="${cls}"
        Lib.Corrections.ApplyRegisteredCorrections("QuestieDB")
        local out={}
        for entity, byId in pairs(Lib.Corrections.composed) do
          local m=Lib.Meta[entity]; out[entity]={}
          for id, fields in pairs(byId) do
            local row={}; out[entity][id]=row
            for index,v in pairs(fields) do
              if v==Lib.Corrections.NIL then v=Lib.Meta.normalize.default(m,index) end
              -- A wrapped value retains explicit nil deletes through Lua -> JS conversion.
              row[m.names[index]]={value=v}
            end
          end
        end
        return out`);
      contexts.push({ faction, cls, overlay });
    }
    const variants = [], conditional = {};
    for (const entity of ENTITIES) {
      const ids = new Set(contexts.flatMap(c => Object.keys(c.overlay[entity] ?? {}).map(Number)));
      conditional[entity] = 0;
      for (const id of ids) {
        const base = rows[entity].get(id) ?? {};
        const fields = new Set(contexts.flatMap(c => Object.keys(c.overlay[entity]?.[id] ?? {})));
        const common = { ...base }, different = [];
        for (const field of fields) {
          const effective = contexts.map(c => {
            const patch = c.overlay[entity]?.[id];
            return patch && Object.hasOwn(patch, field) ? patch[field].value ?? null : base[field] ?? null;
          });
          if (effective.every(v => isDeepStrictEqual(v, effective[0]))) common[field] = effective[0];
          else { common[field] = null; different.push(field); }
        }
        if (different.length) {
          common._conditionalFields = different.sort(); conditional[entity]++;
          for (const c of contexts) {
            const patch = {};
            for (const field of different) {
              const override = c.overlay[entity]?.[id];
              patch[field] = override && Object.hasOwn(override, field) ? override[field].value ?? null : base[field] ?? null;
            }
            variants.push({ kind: entity.toLowerCase(), id, faction: c.faction, cls: c.cls, patch });
          }
        }
        rows[entity].set(id, common);
      }
    }
    return { rows, support, variants, correctionFiles, conditional, contexts: contexts.length };
  } finally { vm.close(); }
}

/** Return named source fields with the character's dynamic corrections applied.
 * Without a matching context, _conditionalFields tells retrieval what it cannot assert. */
export function questieEntity(db, kind, id, { faction, class: cls } = {}) {
  if (!['quest', 'npc', 'item', 'object'].includes(kind)) throw new Error('Invalid entity kind');
  const result = db.prepare(`SELECT raw, source FROM ${kind} WHERE id=?`).get(id);
  if (!result || result.source !== SOURCE) return null;
  const row = JSON.parse(result.raw);
  if (faction && cls) {
    const variant = db.prepare('SELECT raw FROM questie_variant WHERE kind=? AND id=? AND faction=? AND class=? AND source=?').get(kind, id, faction, cls.toUpperCase(), SOURCE);
    if (variant) { Object.assign(row, JSON.parse(variant.raw)); delete row._conditionalFields; }
  }
  return row;
}

function assertOutputOutsideAddon(addonDir, file) {
  if (!file || file === ':memory:') return;
  const sourceDir = fs.realpathSync(addonDir), output = path.resolve(file);
  let existing = path.dirname(output);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const resolved = path.join(fs.realpathSync(existing), path.relative(existing, output));
  const protectedDirs = [sourceDir];
  const addons = path.dirname(sourceDir), iface = path.dirname(addons), client = path.dirname(iface);
  if (path.basename(addons).toLowerCase() === 'addons' && path.basename(iface).toLowerCase() === 'interface') {
    protectedDirs.push(/^_.+_$/.test(path.basename(client)) ? path.dirname(client) : client);
  }
  const inside = target => protectedDirs.some(dir => {
    const rel = path.relative(dir.toLowerCase(), target.toLowerCase());
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  });
  if (inside(resolved) || (fs.existsSync(output) && inside(fs.realpathSync(output)))) {
    throw new Error('Brain output must not be inside the read-only addon or game directory');
  }
}

/** One atomic, repeatable source replacement. now is a millisecond timestamp or Date. */
export function importQuestie({ addonDir = DEFAULT_ADDON_DIR, db, now = Date.now() }) {
  const started = performance.now(), readAt = Number(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(readAt)) throw new Error('Invalid import timestamp');
  for (const database of db.prepare('PRAGMA database_list').all()) assertOutputOutsideAddon(addonDir, database.file);
  const data = loadAddon(addonDir);
  const counts = { quest: 0, npc: 0, item: 0, object: 0, spawn: 0, zone: 0, item_source: 0, name_index: 0, variants: 0 };
  const { rows, support } = data;
  const detail = {
    addonDir: path.resolve(addonDir), flavor: 'Forever', language: 'enUS', compression: 'zlib/DEFLATE',
    staticCorrections: 'Already baked into TOC; not applied twice', dynamicProviders: data.correctionFiles,
    contexts: data.contexts, conditionalEntities: data.conditional,
    conditionalPolicy: 'Shared conditional fields are null; select questie_variant by faction/class or use questieEntity. Conditional spawns/drops live in the variant, not in shared spawn/item_source rows.',
    drops: 'Only entity npcDrops are eligible; manual Era correction > cmangos > wowhead, including reference sentinels',
    limitations: ['No external consumer/third-party corrections or locale overlays',
      'No live game facts or player state; only the bundled faction/class contexts',
      'Item quality and equipment slot are absent from this schema and remain null',
      'Coordinates are stored percentages, including (-1,-1) instance-presence sentinels; no route is inferred',
      'Faction-dependent dungeon entrances are not imported; dungeon names and parent areas only']
  };
  inTransaction(db, () => {
    db.prepare('DELETE FROM name_index WHERE rowid IN (SELECT rowid FROM brain_name_owner WHERE source=?)').run(SOURCE);
    db.prepare('DELETE FROM brain_name_owner WHERE source=?').run(SOURCE);
    for (const table of ['quest', 'npc', 'item', 'object', 'spawn', 'zone', 'item_source', 'questie_variant']) db.prepare(`DELETE FROM ${table} WHERE source=?`).run(SOURCE);
    const insert = (table, columns) => db.prepare(`INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${columns.split(',').map(() => '?').join(',')})`);
    const q = insert('quest', 'id,name,level,req_level,zone_area,starts,ends,objectives_text,objectives,pre_quests,next_quest,races,classes,raw,source,read_at');
    const n = insert('npc', 'id,name,subname,min_level,max_level,zone_area,friendly,raw,source,read_at');
    const o = insert('object', 'id,name,zone_area,raw,source,read_at');
    const it = insert('item', 'id,name,quality,level,slot,raw,source,read_at');
    const sp = insert('spawn', 'kind,id,area_id,x,y,source,read_at');
    const iz = insert('zone', 'area_id,name,ui_map_id,parent_area,source,read_at');
    const src = insert('item_source', 'item_id,kind,id,chance,source,read_at');
    const ix = db.prepare('INSERT INTO name_index (name,kind,id) VALUES (?,?,?)');
    const owner = insert('brain_name_owner', 'rowid,source,read_at');
    const variant = insert('questie_variant', 'kind,id,faction,class,raw,source,read_at');
    const names = new Set(), areas = new Set();
    const addName = (kind, id, name) => {
      if (typeof name !== 'string' || !name.trim() || names.has(`${kind}:${id}:${name}`)) return;
      names.add(`${kind}:${id}:${name}`);
      const r = ix.run(name, kind, id); owner.run(r.lastInsertRowid, SOURCE, readAt); counts.name_index++;
    };
    const addArea = id => { if (Number.isSafeInteger(Number(id)) && Number(id) > 0) areas.add(Number(id)); };
    const givers = v => v == null ? null : json({ npc: values(at(v, 1)), object: values(at(v, 2)), item: values(at(v, 3)) });
    for (const [id, r] of rows.Quest) {
      q.run(id, r.name, r.questLevel, r.requiredLevel, r.zoneOrSort, givers(r.startedBy), givers(r.finishedBy),
        r.objectivesText == null ? null : values(r.objectivesText).join('\n'), json(r.objectives),
        json({ group: r.preQuestGroup, single: r.preQuestSingle }), r.nextQuestInChain, r.requiredRaces, r.requiredClasses, json(r), SOURCE, readAt);
      addName('quest', id, r.name); addArea(r.zoneOrSort); counts.quest++;
    }
    for (const entity of ['Npc', 'Object']) for (const [id, r] of rows[entity]) {
      const kind = entity.toLowerCase();
      if (kind === 'npc') n.run(id, r.name, r.subName, r.minLevel, r.maxLevel, r.zoneID, r.friendlyToFaction, json(r), SOURCE, readAt);
      else o.run(id, r.name, r.zoneID, json(r), SOURCE, readAt);
      addName(kind, id, r.name); addArea(r.zoneID); counts[kind]++;
      for (const [area, points] of entries(r.spawns)) for (const point of values(points)) {
        const x = at(point, 1), y = at(point, 2);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isSafeInteger(Number(area))) throw new Error(`Invalid spawn ${entity}:${id}:${area}`);
        sp.run(kind, id, Number(area), x, y, SOURCE, readAt); addArea(area); counts.spawn++;
      }
    }
    const chance = (itemId, npcId) => {
      const manual = support.dropCorrections?.[itemId]?.[npcId];
      const wowhead = support.wowhead?.[itemId]?.[npcId], pserver = support.pserver?.[itemId]?.[npcId];
      if (manual >= 0) return manual;
      if (manual === support.dropKeys.WOWHEAD && wowhead != null) return wowhead;
      if (manual === support.dropKeys.PSERVER && pserver != null) return pserver;
      return pserver ?? wowhead ?? null;
    };
    for (const [id, r] of rows.Item) {
      it.run(id, r.name, r.quality ?? null, r.itemLevel, r.inventoryType ?? null, json(r), SOURCE, readAt);
      addName('item', id, r.name); counts.item++;
      for (const [field, kind] of [['npcDrops', 'npc'], ['objectDrops', 'object'], ['itemDrops', 'item'], ['vendors', 'vendor']]) {
        for (const holder of new Set(values(r[field]))) {
          if (!Number.isSafeInteger(holder) || holder <= 0) throw new Error(`Invalid ${field} for item ${id}`);
          src.run(id, kind, holder, kind === 'npc' ? chance(id, holder) : null, SOURCE, readAt); counts.item_source++;
        }
      }
    }
    for (const key of Object.keys(support.maps)) addArea(key);
    for (const [key, parent] of entries(support.parents)) { addArea(key); addArea(parent); }
    for (const key of Object.keys(support.names)) addArea(key);
    for (const id of areas) {
      const name = support.names[id] ?? null;
      iz.run(id, name, support.maps[id] ?? null, support.parents[id] ?? at(support.dungeons?.[id], 3) ?? null, SOURCE, readAt);
      addName('zone', id, name); counts.zone++;
    }
    for (const v of data.variants) {
      variant.run(v.kind, v.id, v.faction, v.cls, json(v.patch), SOURCE, readAt); counts.variants++;
      if (v.patch.name) addName(v.kind, v.id, v.patch.name);
    }
    upsertSource(db, SOURCE, { version: '1.0.13', detail: json(detail), at: readAt });
  });
  return { ...counts, elapsed_ms: performance.now() - started, corrections: detail };
}

function main(args) {
  if (args.shift() !== 'import') throw new Error('Usage: node tools/brain/questie.mjs import [--addon-dir <dir>] [--brain <file>]');
  let addonDir = DEFAULT_ADDON_DIR;
  let file = brainFile(path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'NeverQuestAlone', 'dev'));
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value || !['--addon-dir', '--brain'].includes(flag)) throw new Error(`Unknown or incomplete option ${flag}`);
    if (flag === '--addon-dir') addonDir = value; else file = value;
  }
  // Reject even an explicit output below the read-only source directory before opening SQLite.
  assertOutputOutsideAddon(addonDir, file);
  const db = openBrain(file);
  let result;
  try {
    result = importQuestie({ addonDir, db });
    const start = performance.now();
    const hits = db.prepare("SELECT kind,id,name FROM name_index WHERE name_index MATCH ? LIMIT 10").all('"Sharptalon"');
    result.lookup_ms = performance.now() - start; result.lookup = hits;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  console.log(JSON.stringify({ brain: path.resolve(file), bytes: fs.statSync(file).size, ...result }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
