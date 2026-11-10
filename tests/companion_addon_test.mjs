// The companion's addon side (companion PRD F1, F3, F4, F5, F6; PROTOCOL
// §2.6), in the fengari VM running the real addon: the state JSON and its
// limits, the caps gate, st=, events, milestones, the link compare, and the
// session recap's lastSession.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseRecord, parsePayload, inflateBody } from '../bridge/transport/records.mjs';
import { validateState, readLastSession, finishRecap } from '../bridge/app/companion.mjs';
import { classify } from '../bridge/byok/runtime/logbook.mjs';
import { withState } from '../bridge/app/context.mjs';

const require = createRequire(import.meta.url);
const { newVM, reloadVM, lstr } = require('./helpers/nqa-vm.js');
const V = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol-v2.json'), 'utf8'));

const SID = 'a1b2c3d4e5f60718';
const STUB = `
STUB.log = {
	{ id = 748, title = "Poison Water", level = 5, complete = false, trivial = false, objectives = { { text = "Prairie Wolf Paw: 3/6", numFulfilled = 3, numRequired = 6, finished = false } } },
	{ id = 761, title = "Swoop Hunting", level = 8, complete = true, trivial = true, objectives = { { text = "Trophy Swoop Quill: 8/8", numFulfilled = 8, numRequired = 8, finished = true } } },
}
STUB.done = {}
local function Q(id) for _, q in ipairs(STUB.log) do if q.id == id then return q end end end
C_QuestLog = {
	GetNumQuestLogEntries = function() return #STUB.log end,
	GetInfo = function(i) local q = STUB.log[i]; if q then return { title = q.title, questID = q.id, level = q.level, isHeader = false } end end,
	IsOnQuest = function(id) return Q(id) ~= nil end,
	IsComplete = function(id) local q = Q(id); return q ~= nil and q.complete end,
	ReadyForTurnIn = function(id) local q = Q(id); return q ~= nil and q.complete end,
	IsQuestTrivial = function(id) local q = Q(id); return q ~= nil and q.trivial end,
	IsQuestFlaggedCompleted = function(id) return STUB.done[id] == true end,
	GetTitleForQuestID = function(id) local q = Q(id); return q and q.title end,
	GetQuestObjectives = function(id) local q = Q(id); return q and q.objectives or {} end,
	GetQuestsOnMap = function(map) return STUB.poi end,
}
function UnitName(unit) if unit == "player" then return STUB.name or "Tavi", "" end end -- two values, as the client (E-020)
function GetRealmName() return "Testrealm" end
function UnitRace() return "Tauren", "Tauren" end
function UnitClass() return "Shaman", "SHAMAN" end
STUB.level, STUB.money, STUB.xp, STUB.xpMax = 7, 11800, 300, 1400
function UnitXP() return STUB.xp end
function UnitXPMax() return STUB.xpMax end
STUB.zone, STUB.subzone = "Mulgore", "Bloodhoof Village"
function GetRealZoneText() return STUB.zone end
STUB.posX, STUB.posY = 0.496, 0.663
C_Map.GetBestMapForUnit = function() return 1412 end
STUB.inv, STUB.equipLoc, STUB.ilvl = {}, {}, {}
function GetInventoryItemID(unit, slot) local i = STUB.inv[slot]; return i and i.id end
function GetInventoryItemLink(unit, slot) local i = STUB.inv[slot]; return i and i.link end
C_Item.GetItemInfoInstant = function(item)
	local id = tonumber(tostring(item):match("item:(%d+)")) or tonumber(item)
	if id then return id, "Armor", "Misc", STUB.equipLoc[id] or "" end
end
C_Item.GetDetailedItemLevelInfo = function(link) local id = tonumber(tostring(link):match("item:(%d+)")); return id and STUB.ilvl[id] end
function IsInInstance() return STUB.instance == true end
`;

// A saved companion table with a known session id for Tavi.
const DB = (extra = '') => `NQADB = { companion = { chars = { ["Tavi-Testrealm"] = { sid = "${SID}" } }${extra} } }`;

// caps: true for { "state", "evt" }, false for none, or a list of names. With any, the app's
// check-ins switch is on too (cap usage, usage.autoOn): the companion sends nothing until the
// app says so (C-05).
function slot({ nonce = null, acked = [], caps = true, stateSeq = null, stateSid = null, records = [], push = 0 } = {}) {
  const names = caps === true ? ['state', 'evt'] : (caps || []);
  const c = names.length ? `, caps = { ${[...names, 'usage'].map(x => `"${x}"`).join(', ')} }, usage = { autoOn = true }` : '';
  const s = (stateSeq != null ? `, stateSeq = ${stateSeq}` : '') + (stateSid ? `, stateSid = "${stateSid}"` : '');
  return `{ v = 2, ts = "2026-09-25T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.2.0", push = ${push}, nonce = ${nonce ? `"${nonce}"` : 'nil'}, acked = { ${acked.map(k => `"${k}"`).join(', ')} }${c}${s} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {}, records = { ${records.join(', ')} } }`;
}
const apply = (vm, s) => vm.run(`NS.Transport.HandleSlotData(${s}, "slot")`);
// A command's answer (Chats.Notice): shown in the window, never saved.
const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');

// Logged in, the hello up and answered by a bridge with (or without) the caps.
function ready({ caps = true, db = DB(), extra = '', stateSeq = null } = {}) {
  const vm = newVM({ extra: STUB + extra, db }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)'); // as after a /reload: the saved sid stays
  vm.advance(3.1);
  apply(vm, slot({ nonce: vm.evaluate('NS.R.nonce'), caps, stateSeq }));
  return vm;
}
const wires = vm => vm.stripWires().map(w => parseRecord(w)).filter(r => r.ok).map(r => r.record);
const outbox = vm => vm.outboxWires().map(e => parseRecord(e.wire)).filter(r => r.ok).map(r => r.record);
const stateJSON = vm => JSON.parse(vm.evaluate('NS.Companion.Build().json'));

test('caps: with no caps from the bridge nothing new is drawn (no state, no evt, no st=); once it lists them, a waiting level-up goes', () => {
  const vm = ready({ caps: false });
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8)');
  vm.advance(2.1);
  vm.send('what next?');
  assert.deepEqual(wires(vm).map(r => r.type), ['msg'], 'the msg alone: no state beside it');
  assert.equal(wires(vm)[0].args.st, undefined, 'no st=');
  assert.ok(!outbox(vm).some(r => r.type === 'evt'), 'the level-up waits');
  apply(vm, slot({ caps: true }));
  vm.advance(2.1);
  const evt = outbox(vm).find(r => r.type === 'evt');
  assert.ok(evt, 'sent once the bridge lists evt');
  assert.equal(evt.args.kind, 'level_up');
});

test('state (F1): the JSON in key order with 5.1-safe numbers and cleaned strings; seq only moves when the body does; sid new at initial login, kept over /reload', () => {
  const vm = newVM({ extra: STUB, db: DB() }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)'); // a /reload: the saved sid stays
  // The app's companion switch on (cap usage, usage.autoOn): off, the state is the quest log alone (QL-F-14).
  vm.run('NS.R.bridge = { caps = { "usage" }, usage = { autoOn = true } }');
  const json = vm.evaluate('NS.Companion.Build().json');
  const s = JSON.parse(json);
  assert.equal(JSON.stringify(s), json, 'canonical JSON: no spaces, whole numbers without .0');
  assert.deepEqual(Object.keys(s), ['v', 'sid', 'seq', 't', 'char', 'loc', 'questCount', 'questMax', 'quests', 'prof', 'pending', 'talents', 'omitted'], 'no poi or gear when the client has none (talents: the stub has points; T18)');
  assert.deepEqual({ ...s, t: 0 }, {
    v: 1, sid: SID, seq: 1, t: 0,
    char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 7, xp: 300, xpMax: 1400, money: 11800 },
    loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66.3 },
    questCount: 2, questMax: 40,
    quests: [
      { id: 748, title: 'Poison Water', level: 5, trivial: false, complete: false, obj: [{ text: 'Prairie Wolf Paw', have: 3, need: 6 }] },
      { id: 761, title: 'Swoop Hunting', level: 8, trivial: true, complete: true, obj: [{ text: 'Trophy Swoop Quill', have: 8, need: 8 }] },
    ],
    prof: [{ name: 'Skinning', rank: 75, max: 75 }, { name: 'First Aid', rank: 40, max: 75 }],
    pending: [],
    talents: [{ tree: 1, name: 'Beast Mastery', points: 10 }, { tree: 2, name: 'Marksmanship', points: 5 }, { tree: 3, name: 'Survival', points: 0 }],
    omitted: [],
  });
  assert.ok(validateState(json).ok, 'the bridge accepts it');
  vm.advance(30);
  assert.equal(stateJSON(vm).seq, 1, 'nothing changed: the same seq (and t)');
  vm.run('STUB.money = 12000');
  assert.equal(stateJSON(vm).seq, 2);
  // Game text is data: escapes, links, | and control characters go; 60 bytes, cut on a character.
  vm.run(`STUB.log[1].title = ${lstr('|cffff0000Red|r |Hquest:748|h[Linked]|h\nnext|line ' + 'é'.repeat(40))}`);
  const title = stateJSON(vm).quests[0].title;
  assert.ok(title.startsWith('Red Linked nextline é'), title);
  assert.ok(Buffer.byteLength(title) <= 60 && !title.includes('�'));
  // /reload keeps the sid and the seq counter; an initial login draws a new sid.
  const vm2 = reloadVM(vm, { extra: STUB });
  vm2.login().run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  vm2.run('NS.R.bridge = { caps = { "usage" }, usage = { autoOn = true } }');
  vm2.run(`STUB.money = 12000; STUB.log[1].title = ${lstr('|cffff0000Red|r |Hquest:748|h[Linked]|h\nnext|line ' + 'é'.repeat(40))}`);
  const s2 = stateJSON(vm2);
  assert.equal(s2.sid, SID);
  assert.equal(s2.seq, 3, 'the same body after a /reload keeps its seq');
  vm2.run('STUB.money = 13000');
  assert.equal(stateJSON(vm2).seq, 4);
  vm2.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  const s3 = stateJSON(vm2);
  assert.match(s3.sid, /^[0-9a-f]{16}$/);
  assert.notEqual(s3.sid, SID);
  assert.equal(s3.seq, 5);
});

// 30 quests with 6 objectives each, multibyte names past 60 bytes, quest
// points, a full set of gear, and 10 milestones: the worst case (F1).
const WORST = `
STUB.log = {}
for i = 1, 30 do
	local obj = {}
	for j = 1, 6 do obj[j] = { text = "Übergroße Ωmega-Trophäe Nº" .. j .. " des Eisigen Ödlands: 1/9", numFulfilled = 1, numRequired = 9 } end
	STUB.log[i] = { id = 1000 + i, title = "Die unerträglich lange Questreihe Ñandú Ωmega Teil " .. i, level = 10 + i % 5, complete = i % 7 == 0, trivial = i % 4 == 0, objectives = obj }
end
STUB.poi = {}
for i = 1, 30 do STUB.poi[i] = { questID = 1000 + i, x = 0.1234 + i / 100, y = 0.5678 } end
for slot = 1, 19 do STUB.inv[slot] = { id = 20000 + slot, link = "|cff1eff00|Hitem:" .. (20000 + slot) .. "::::::::|h[Gear " .. slot .. "]|h|r" }; STUB.ilvl[20000 + slot] = 20 + slot end
`;
const PENDING10 = Array.from({ length: 10 }, (_, i) => `{ pid = ${i + 1}, kind = "zone", zone = "Zone ${i + 1} of the Ünbekannte Länder", t = 1700000000 }`).join(', ');

// The fit's steps in order (Companion.lua DROP_ORDER): detail (the objectives of quests ready to
// turn in first), then professions and milestones (they wait for the next state), then the end of
// titles, titles last.
// T18's sections go first when they're there (Companion.lua DROP_ORDER).
const LADDER = ['rewards', 'rested', 'hearth', 'talents', 'durability', 'gear', 'poi', 'quests.obj.done', 'quests.obj.text', 'quests.obj', 'quests.level', 'prof', 'pending', 'quests.title.short', 'quests.title.tiny', 'quests.title'];
// Past what any client's log holds: n quests.
const LOG = n => `for i = 31, ${n} do STUB.log[i] = { id = 1000 + i, title = "Die unerträglich lange Questreihe Ñandú Ωmega Teil " .. i, level = 10, complete = false, trivial = false, objectives = {} } end`;

test('state limits (F1): the worst case keeps every quest: for a bridge with qlog, detail goes and titles are at most shortened; for an older one (2,800 bytes of JSON), titles go last; each matches its shared vector', () => {
  const strings = (s) => { const out = []; (function walk(v) { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(s); return out; };
  // The app's companion switch on (cap usage, usage.autoOn): off, the state is the quest log alone (QL-F-14).
  for (const [name, caps, vector] of [['qlog', '{ "state", "evt", "z", "ctx", "qlog", "usage" }', 'worstState'], ['older', '{ "usage" }', 'legacyWorstState']]) {
    const vm = newVM({ extra: STUB + WORST, db: DB() }).login();
    vm.run(`NS.Companion.CharDB().pending = { ${PENDING10} }`);
    vm.run(`NS.R.bridge = { caps = ${caps}, usage = { autoOn = true } }`);
    const st = vm.json('NS.Companion.Build()');
    const json = st.json;
    const s = JSON.parse(json);
    assert.ok(!st.tooLarge, name);
    assert.equal(s.quests.length, 30, `${name}: every quest`);
    assert.deepEqual([s.questCount, s.questMax], [30, 40]);
    assert.deepEqual(s.omitted, LADDER.filter(k => s.omitted.includes(k)), `${name}: in the fit's order`);
    assert.ok(s.omitted.every(k => LADDER.includes(k)), `${name}: only detail`);
    for (const q of s.quests) assert.ok(Number.isInteger(q.id) && typeof q.complete === 'boolean', `${name}: ${q.id}`);
    // The milestones go, or wait for a state with room (never lost: still pending in the saved data).
    if (name === 'qlog') assert.equal(s.pending.length, 10);
    else assert.ok(s.pending?.length === 10 || s.omitted.includes('pending'), `${name}: the milestones`);
    assert.equal(vm.num('#NS.Companion.CharDB().pending'), 10);
    for (const x of strings(s)) assert.ok(Buffer.byteLength(x) <= 60 && !x.includes('�'), x);
    assert.ok(validateState(json).ok, `${name}: the bridge accepts it`);
    if (name === 'qlog') {
      assert.ok(s.quests.every(q => q.title && Buffer.byteLength(q.title) >= 24), 'qlog: every title, at least its first 24 bytes');
      assert.ok(st.packed.length <= 3100, `qlog: ${st.packed.length} bytes on the strip`);
    } else {
      assert.ok(Buffer.byteLength(json) <= 2800, `older: ${Buffer.byteLength(json)} bytes`);
    }
    // The shared vector is this state (PRD §6: a worst-case state).
    assert.equal(json, V[vector].json.replace('"t":0', `"t":${s.t}`), `${name}: the vector (t aside)`);
  }
  // Past what any log holds (120 quests), nothing fits an older bridge's 2,800 bytes, even with every step: too_large. A bridge with qlog takes it.
  const BIG = `${LOG(120)}
    NS.Chats.Professions = function() local out = {} for i = 1, 6 do out[i] = { name = string.rep("Ω", 30) .. i, rank = 300, max = 300 } end return out end
    local p = {} for i = 1, 10 do p[i] = { pid = i, id = 100 + i, kind = "quest_done", title = string.rep("Ü", 30), t = 1700000000 + i } end
    NS.Companion.CharDB().pending = p
    STUB.zone, STUB.subzone = string.rep("Ö", 30), string.rep("Ä", 30)`;
  const vm = newVM({ extra: STUB + WORST, db: DB() }).login();
  vm.run(BIG);
  const big = vm.json('NS.Companion.Build()');
  assert.equal(big.tooLarge, true);
  assert.deepEqual(Object.keys(JSON.parse(big.json)), ['v', 'sid', 'seq', 'state']);
  assert.equal(JSON.parse(big.json).state, 'too_large');
  assert.ok(validateState(big.json).ok);
  assert.equal(classify(JSON.parse(big.json)), 'too_large', 'the logbook takes it as too large: no facts to write');
  vm.run('NS.R.bridge = { caps = { "state", "evt", "z", "ctx", "qlog", "usage" }, usage = { autoOn = true } }');
  const fits = vm.json('NS.Companion.Build()');
  assert.ok(!fits.tooLarge, 'with qlog it fits');
  assert.equal(JSON.parse(fits.json).quests.length, 120);
});

test('sending (F1): a message carries st= and the state rides beside it until the bridge has that seq; alone for a few seconds after each hello', () => {
  const vm = ready();
  const first = wires(vm);
  assert.deepEqual(first.map(r => r.type), ['state'], 'once after the hello, on its own');
  assert.equal(first[0].key, vm.evaluate('NS.R.nonce'), 'unkeyed: the key is the nonce');
  assert.equal(first[0].chat, '');
  const seq = Number(first[0].args.seq);
  assert.equal(first[0].args.sid, SID);
  assert.equal(JSON.parse(first[0].body).seq, seq);
  vm.advance(9);
  assert.deepEqual(wires(vm), [], 'gone after its dwell');
  vm.run('STUB.money = 15000');
  const frame = vm.num('NS.R.frame');
  vm.send('what should I do next?');
  assert.equal(vm.num('NS.R.frame') - frame, 1, 'one draw a send, the state with the message (code health AD-03: it was the state alone, then both)');
  const w = wires(vm);
  assert.deepEqual(w.map(r => r.type), ['msg', 'state'], 'the newest msg first, its state beside it');
  assert.equal(Number(w[0].args.st), Number(w[1].args.seq), 'st= names the state it rides with');
  assert.equal(Number(w[1].args.seq), seq + 1);
  const { records } = parsePayload(vm.strip().payload);
  assert.deepEqual(records.map(r => r.type), ['msg', 'state'], 'the bridge parses the frame');
  // The bridge acks the msg and has the state: the strip clears.
  apply(vm, slot({ acked: [w[0].key], stateSeq: seq + 1 }));
  assert.deepEqual(wires(vm), []);
  // Unchanged state: st= names it, and nothing extra is drawn.
  vm.send('and then?');
  assert.deepEqual(wires(vm).map(r => r.type), ['msg']);
  assert.equal(Number(wires(vm)[0].args.st), seq + 1);
});

test('sending (F1): a state that doesn\'t fit beside the message gets its turn alone once the message is acked', () => {
  const vm = ready({ extra: WORST, stateSeq: 0 });
  vm.advance(9);
  vm.slash('x'.repeat(2800));
  const w = wires(vm);
  assert.deepEqual(w.map(r => r.type), ['msg'], 'the msg fills the frame; the state waits');
  apply(vm, slot({ acked: [w[0].key], stateSeq: 0 }));
  assert.deepEqual(wires(vm).map(r => r.type), ['state'], 'then the state, on its own');
  vm.advance(9);
  assert.deepEqual(wires(vm), []);
});

test('events (F3, A2): a level-up is one evt with an empty body, sid, st and its send time, in the pinned Check-ins chat; combat holds it; once per level; gaps, toggles and off', () => {
  const vm = ready();
  vm.advance(9);
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_LEVEL_UP", 8)');
  vm.advance(4);
  assert.ok(!outbox(vm).some(r => r.type === 'evt'), 'held in combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(3.2);
  const evts = () => outbox(vm).filter(r => r.type === 'evt');
  assert.equal(evts().length, 1);
  const e = evts()[0];
  assert.equal(e.chat, 'c0ffee0');
  assert.equal(e.body, '', 'no game text in an evt: the state carries it');
  assert.deepEqual({ kind: e.args.kind, from: e.args.from, to: e.args.to, sid: e.args.sid, agent: e.args.agent, name: e.args.name },
    { kind: 'level_up', from: '7', to: '8', sid: SID, agent: 'main', name: 'Check-ins' });
  assert.match(e.args.at, /^\d{9,}$/, 'when it went (SL-4), so the runaway fuse counts sends, not a backlog');
  const st = wires(vm).find(r => r.type === 'state');
  assert.equal(e.args.st, st.args.seq, 'st= names the state drawn beside it');
  assert.equal(vm.evaluate('NQADB.chats[1].id'), 'c0ffee0', 'the Check-ins chat, pinned to the top');
  assert.equal(vm.evaluate('NQADB.chats[1].pinned'), 'true');
  assert.equal(vm.evaluate('NQADB.chats[1].history[1].event'), 'level_up');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8)');
  vm.advance(2.1);
  assert.equal(evts().length, 1, 'once per character and level');
  // A first zone visit waits 2 minutes after the last event (level-ups don't wait).
  vm.run('STUB.zone = "Thunder Bluff"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.advance(60);
  assert.equal(evts().length, 1, 'the 2-minute gap');
  vm.advance(61);
  assert.equal(evts()[1].args.kind, 'zone_first');
  // Per kind: zone off still records the milestone, but asks nothing.
  vm.slash('companion zone off');
  vm.run('STUB.zone = "The Barrens"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.advance(130);
  assert.equal(evts().length, 2);
  assert.ok(stateJSON(vm).pending.some(p => p.kind === 'zone' && p.zone === 'The Barrens'));
  // Off: no evt. A typed message still names its state, which goes beside it: Check-Ins is about
  // check-ins, and Game Data with Messages is the switch for what a message carries (the breaker's
  // r2 case: with no state sent, the bridge's old one read as the whole log).
  vm.slash('companion off');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 9)');
  vm.advance(2.1);
  assert.equal(evts().length, 2);
  vm.advance(10); // the hello's state off the strip
  // The bridge speaks again (after two silent minutes Automatic would send by Copy and Paste).
  apply(vm, slot({ nonce: vm.evaluate('NS.R.nonce'), caps: true }));
  vm.send('hello?');
  const msg = wires(vm).find(r => r.type === 'msg' && r.text === 'hello?');
  const stRec = wires(vm).find(r => r.type === 'state');
  assert.ok(msg.args.st !== undefined && stRec && stRec.args.seq === msg.args.st, 'the state goes with the message');
  // Game Data with Messages off: no st=, and no new state goes.
  vm.slash('context off');
  vm.run('STUB.money = STUB.money + 1');
  vm.send('and now?');
  assert.equal(wires(vm).find(r => r.type === 'msg' && r.text === 'and now?').args.st, undefined);
  assert.ok(wires(vm).every(r => r.type !== 'state' || r.args.seq === stRec.args.seq), 'no new state');
  vm.slash('context on');
  vm.slash('companion');
  assert.match(notice(vm), /^Check-Ins: Off\. Settings has it too\.\n/, 'its Settings label first, as every switch answer (C-116)');
});

test('milestones (F4): a first zone visit, a new profession tier and a turn-in wait in state.pending until the bridge confirms a state that carried them', () => {
  const vm = ready({ extra: `
    STUB.skills = { { "Professions", true }, { "Skinning", false, 75, 75 } }
    function GetNumSkillLines() return #STUB.skills end
    function GetSkillLineInfo(i) local s = STUB.skills[i]; return s[1], s[2] or nil, false, s[3], 0, 0, s[4] end` });
  vm.run('STUB.zone = "Thunder Bluff"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.run('STUB.skills[2] = { "Skinning", false, 75, 150 }; STUB.FireEvent("SKILL_LINES_CHANGED")');
  vm.run('C_QuestLog.GetInfo(2); STUB.FireEvent("QUEST_TURNED_IN", 761, 450, 0)');
  const pending = stateJSON(vm).pending.map(({ t, ...p }) => p);
  assert.deepEqual(pending, [{ kind: 'zone', zone: 'Thunder Bluff' }, { kind: 'prof', name: 'Skinning', max: 150 }, { kind: 'quest_done', id: 761, title: 'Swoop Hunting' }]);
  vm.send('what now?');
  const st = wires(vm).find(r => r.type === 'state');
  assert.equal(JSON.parse(st.body).pending.length, 3, 'carried by the state beside the message');
  apply(vm, slot({ stateSeq: Number(st.args.seq) }));
  assert.deepEqual(stateJSON(vm).pending, [], 'delivered: gone from the next state');
  assert.equal(vm.num('#NS.Companion.CharDB().pending'), 0);
});

test('session (F6): XP across a level-up, money, turn-ins and zones since the initial login; lastSession at logout in the agreed shape, read back by the bridge', () => {
  const vm = newVM({ extra: STUB, db: DB() }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  const sid = vm.evaluate('NS.Companion.CharDB().sid');
  vm.run('STUB.xp = 900; STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
  vm.run('STUB.level, STUB.xp, STUB.xpMax = 8, 100, 1600; STUB.FireEvent("PLAYER_LEVEL_UP", 8); STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
  vm.run('C_QuestLog.GetInfo(1); STUB.FireEvent("QUEST_TURNED_IN", 748, 300, 0)');
  vm.run('STUB.zone = "Thunder Bluff"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.advance(3600);
  vm.run('STUB.money = 15000; STUB.FireEvent("PLAYER_LOGOUT")');
  const doc = JSON.parse(vm.evaluate('NQADB.companion.lastSession'));
  assert.deepEqual(Object.keys(doc), ['v', 'kind', 'sid', 'char', 'start', 'end', 'xpGained', 'moneyDelta', 'questsTurnedIn', 'zones', 'ended']);
  assert.deepEqual({ ...doc, start: { ...doc.start, t: 0 }, end: { ...doc.end, t: 0 } }, {
    v: 1, kind: 'session', sid, char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren' },
    start: { t: 0, level: 7, xp: 300, xpMax: 1400, money: 11800 }, end: { t: 0, level: 8, xp: 100, xpMax: 1600, money: 15000 },
    xpGained: 1200, moneyDelta: 3200, questsTurnedIn: 1, zones: ['Mulgore', 'Thunder Bluff'], ended: 'unknown',
  });
  assert.equal(doc.end.t - doc.start.t, 3600);
  // The bridge reads it out of SavedVariables as the client writes them, and finishes it.
  const json = readLastSession(Buffer.from('NQADB = ' + vm.saved(), 'utf8').toString('latin1')); // the file's bytes
  assert.equal(json, vm.evaluate('NQADB.companion.lastSession'));
  assert.equal(finishRecap(json, 'quit').doc.ended, 'quit');
  // A /reload keeps the session (same sid, totals go on); recap off writes none.
  const vm2 = reloadVM(vm, { extra: STUB });
  vm2.login().run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  vm2.run('STUB.xp = 400; STUB.FireEvent("PLAYER_XP_UPDATE", "player"); STUB.FireEvent("PLAYER_LOGOUT")');
  const doc2 = JSON.parse(vm2.evaluate('NQADB.companion.lastSession'));
  assert.equal(doc2.sid, sid);
  assert.equal(doc2.xpGained, 1500);
  vm2.slash('companion recap off');
  vm2.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm2.evaluate('NQADB.companion.lastSession'), null);
});

test('link compare (F5): a linked ring brings both equipped rings, with item ids, levels and tooltips; past 2,900 bytes the tooltips go first, then the names', () => {
  const vm = ready({ extra: `
    STUB.equipLoc[5001] = "INVTYPE_FINGER"; STUB.equipLoc[5002] = "INVTYPE_2HWEAPON"
    STUB.inv[11] = { id = 111, link = "|cff1eff00|Hitem:111::::::::|h[Band of Ash]|h|r" }; STUB.ilvl[111] = 18
    STUB.inv[12] = { id = 112, link = "|cffffffff|Hitem:112::::::::|h[Copper Ring]|h|r" }; STUB.ilvl[112] = 9
    STUB.inv[16] = { id = 116, link = "|cffffffff|Hitem:116::::::::|h[Walking Stick]|h|r" }; STUB.ilvl[116] = 5
    STUB.tooltips["item:5001::::::::"] = { "Ring of the Plains", "+3 Stamina" }
    STUB.tooltips["item:111::::::::"] = { "Band of Ash", "+2 Spirit" }
    STUB.tooltips["item:112::::::::"] = { "Copper Ring" }
    STUB.tooltips["item:116::::::::"] = { "Walking Stick", "Two-Hand" }` });
  vm.advance(9);
  vm.send('upgrade? |cff1eff00|Hitem:5001::::::::|h[Ring of the Plains]|h|r');
  const msg = wires(vm).find(r => r.type === 'msg');
  assert.ok(msg.text.includes('--- Linked from the game ---\n[Ring of the Plains] item 5001'), msg.text);
  assert.ok(msg.text.includes('[Equipped: finger 1] Band of Ash, item 111, item level 18\n  Band of Ash\n  +2 Spirit'));
  assert.ok(msg.text.includes('[Equipped: finger 2] Copper Ring, item 112, item level 9'));
  vm.send('this staff? |cff1eff00|Hitem:5002::::::::|h[Staff]|h|r');
  const msg2 = wires(vm).filter(r => r.type === 'msg').find(r => r.text.startsWith('this staff'));
  assert.ok(msg2.text.includes('[Equipped: main hand] Walking Stick, item 116, item level 5'));
  assert.ok(!msg2.text.includes('finger'));
  // Near the limit: the equipped tooltips go, then the names; ids and item levels stay.
  const link = ' |cff1eff00|Hitem:5001::::::::|h[Ring of the Plains]|h|r';
  const size = level => vm.num(`#(NS.Chats.ExpandLinks(${lstr('x' + link)}, ${level}))`) - 1;
  const [s0, s1, s2] = [size(0), size(1), size(2)];
  assert.ok(s0 > s1 && s1 > s2, 'each level is shorter');
  const sent = n => { vm.send('x'.repeat(n) + link); return wires(vm).filter(r => r.type === 'msg').filter(r => r.text.startsWith('xxx')).pop(); };
  vm.advance(9);
  let m = sent(2900 - s1);
  assert.equal(Buffer.byteLength(m.text), 2900);
  assert.ok(m.text.includes('[Equipped: finger 1] Band of Ash, item 111, item level 18') && !m.text.includes('+2 Spirit'), 'tooltips dropped first');
  apply(vm, slot({ acked: [m.key] }));
  m = sent(2900 - s2);
  assert.ok(m.text.includes('[Equipped: finger 1] item 111, item level 18') && !m.text.includes('Band of Ash'), 'then the names');
  assert.ok(Buffer.byteLength(m.text) <= 2900);
});

test('the Check-ins chat is made for a record addressed to it (a recap\'s reply at the next login), pinned; /nqa state and /nqa apicheck answer', () => {
  const vm = ready();
  apply(vm, slot({ records: ['{ seq = 1, t = "reply", chat = "c0ffee0", mid = "m-1", agent = "main", text = "Recap: 1,200 XP an hour.", summary = "", more = 0 }'] }));
  assert.equal(vm.evaluate('NS.Chats.Find("c0ffee0").name'), 'Check-ins');
  assert.equal(vm.evaluate('NS.Chats.Find("c0ffee0").pinned'), 'true');
  assert.equal(vm.evaluate('NS.Chats.Find("c0ffee0").history[1].text'), 'Recap: 1,200 XP an hour.');
  assert.equal(vm.num('NS.R.orphans'), 0);
  vm.slash('state');
  const text = notice(vm);
  assert.match(text, /^Companion state:\nState v=1, seq=\d+, sid a1b2c3d4e5f60718, \d+ of 2,800 bytes of JSON; omitted: none\nQuest log: 2 of 40 quests, every one in the state \(cap from the fallback, the game gave none\)\.\n/);
  assert.match(text, /Milestones waiting for NeverQuestAlone: 0\. Companion on; NeverQuestAlone caps: state evt$/);
  vm.slash('apicheck');
  const api = notice(vm);
  assert.match(api, /^Game APIs the companion reads:\n/);
  assert.match(api, /\nC_QuestLog\.GetQuestObjectives: present, table \(1\)\n/);
  assert.match(api, /\nC_Item\.GetCurrentItemLevel: missing\n/);
  assert.match(api, /\nEvents: C_EventUtils\.IsEventValid missing, not checked$/);
});

test('reload path (F1): in stream mode the state goes into the reload outbox beside the message, like the hello, and the bridge parses it', () => {
  const vm = ready();
  vm.slash('stream on');
  vm.advance(5.1); // the mode seen's 5 s on the strip (DR-08), then the strip goes
  vm.run('STUB.money = 20000');
  vm.send('what next?');
  const recs = outbox(vm);
  const st = recs.find(r => r.type === 'state');
  const msg = recs.find(r => r.type === 'msg');
  assert.ok(st && msg);
  assert.equal(st.key, vm.evaluate('NS.R.nonce'));
  assert.equal(msg.args.st, st.args.seq);
  assert.equal(JSON.parse(st.body).char.money, 20000);
  assert.deepEqual(vm.stripWires(), [], 'nothing drawn in stream mode');
});

test('isolation: a companion that throws never breaks chat: messages still go (without st=), slots still apply, and /nqa state and diag say what failed', () => {
  const vm = ready();
  vm.advance(9);
  vm.run('NS.Companion.Build = function() error("boom in Build") end; NS.Companion.OnBridge = function() error("boom in OnBridge") end');
  vm.send('does chat still work?');
  const msg = outbox(vm).find(r => r.type === 'msg');
  assert.ok(msg, 'sent');
  assert.equal(msg.args.st, undefined, 'without st=');
  assert.match(vm.evaluate('NS.R.companionError.text'), /boom in Build/);
  apply(vm, slot({ acked: [msg.key], records: ['{ seq = 1, t = "reply", chat = NQADB.activeChat, mid = "m-1", agent = "main", text = "Yes.", summary = "", more = 0 }'] }));
  assert.equal(outbox(vm).filter(r => r.type === 'msg').length, 0, 'acked');
  assert.equal(vm.lastHistory().text, 'Yes.', 'the reply applied');
  assert.match(vm.evaluate('NS.R.companionError.where'), /OnBridge/);
  vm.slash('diag');
  assert.match(notice(vm), /\nCompanion: on; caps state\+evt; state seq \d+, NeverQuestAlone has none; last error in OnBridge: .*boom in OnBridge/);
  vm.slash('state');
  assert.match(notice(vm), /It hit an error: .*boom in Build/);
});

test('events (A2): 3 quests no route covers ask for a re-plan 90 s after the last pickup, once; those quests don\'t count again', () => {
  const vm = ready();
  vm.advance(9);
  const evts = () => outbox(vm).filter(r => r.type === 'evt' && r.args.kind === 'route_stale');
  const pick = (id) => vm.run(`table.insert(STUB.log, { id = ${id}, title = "Quest ${id}", level = 7, complete = false, objectives = {} }); STUB.FireEvent("QUEST_ACCEPTED", ${id})`);
  pick(901); pick(902);
  vm.advance(100);
  assert.equal(evts().length, 0, 'two are not enough');
  pick(903);
  vm.advance(60);
  assert.equal(evts().length, 0, 'waits 90 s after the last pickup');
  vm.advance(35);
  assert.equal(evts().length, 1);
  assert.equal(evts()[0].args.n, '3');
  // A fourth pickup: the three already asked about don't count again.
  pick(904);
  vm.advance(300);
  assert.equal(evts().length, 1, 'one new quest is not three');
  pick(905); pick(906);
  vm.advance(300);
  assert.equal(evts().length, 2, 'three new ones ask again');
  assert.equal(evts()[1].args.n, '3');
});

test('milestones (F4) after a crash: a new session\'s seq equal to the one the bridge holds from the last session isn\'t taken as delivered', () => {
  // The last save (a /reload before the crash) left seq 5 and an unconfirmed milestone;
  // the bridge later got seq 6 from that session, which the crash never saved.
  const vm = newVM({ extra: STUB, db: `NQADB = { companion = { seq = 5, pendingId = 1, chars = { ["Tavi-Testrealm"] = { sid = "${SID}",
    zones = { ["Mulgore"] = true, ["Thunder Bluff"] = true }, zonesInit = true,
    pending = { { kind = "zone", zone = "Thunder Bluff", t = 1790000100, pid = 1 } } } } } }` }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)'); // the relaunch: a new sid
  vm.advance(3.1); // the rebuild after the event runs before any header: seq 6 again
  const sid = vm.evaluate('NS.Companion.CharDB().sid');
  assert.notEqual(sid, SID);
  assert.equal(stateJSON(vm).seq, 6, 'the collision the review found');
  apply(vm, slot({ nonce: vm.evaluate('NS.R.nonce'), stateSeq: 6, stateSid: SID })); // the hello's answer: the dead session's seq 6
  assert.deepEqual(stateJSON(vm).pending.map(p => p.zone), ['Thunder Bluff'], 'still pending');
  const drawn = wires(vm).filter(r => r.type === 'state').map(r => JSON.parse(r.body));
  assert.ok(drawn.some(s => s.sid === sid && s.pending.some(p => p.zone === 'Thunder Bluff')), 'and on its way to the bridge');
  // The bridge has this session's state: now it's delivered.
  const seq = drawn[0].seq;
  apply(vm, slot({ stateSeq: seq, stateSid: sid }));
  assert.deepEqual(stateJSON(vm).pending, []);
});

// ---------------------------------------------------------------- the peer review of 2c57015 (addon)

test('review: an acked evt leaves pending when its reply comes, so the Companion chat isn\'t busy forever', () => {
  const vm = ready();
  vm.advance(9);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8)');
  vm.advance(2.1);
  const e = outbox(vm).find(r => r.type === 'evt');
  assert.ok(e);
  apply(vm, slot({ acked: [e.key] }));
  apply(vm, slot({ records: ['{ seq = 1, t = "reply", chat = "c0ffee0", mid = "m-1", agent = "main", text = "Grats on 8.", summary = "", more = 0 }'] }));
  assert.equal(vm.num('#NS.Chats.Find("c0ffee0").pending'), 0);
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Find("c0ffee0"))'), false);
});

test('review: a level-up waits a moment, and its state has the new level even if the unit still reports the old one', () => {
  const vm = ready();
  vm.advance(9);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8)'); // UnitLevel still says 7 during the event
  vm.advance(1);
  assert.ok(!outbox(vm).some(r => r.type === 'evt'), 'not sent inside the event');
  vm.advance(1.1);
  const e = outbox(vm).find(r => r.type === 'evt');
  const st = wires(vm).find(r => r.type === 'state' && r.args.seq === e.args.st);
  assert.equal(JSON.parse(st.body).char.level, 8);
});

test('review: two level-ups in one fight make one turn, first level to last; a /reload doesn\'t lose a held event', () => {
  const vm = ready();
  vm.advance(9);
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_LEVEL_UP", 8); STUB.FireEvent("PLAYER_LEVEL_UP", 9)');
  vm.advance(5);
  const vm2 = reloadVM(vm, { extra: STUB }); // still in the fight when the UI reloads
  vm2.login().run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  vm2.advance(3.1);
  apply(vm2, slot({ nonce: vm2.evaluate('NS.R.nonce') }));
  vm2.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm2.advance(3.2);
  const evts = outbox(vm2).filter(r => r.type === 'evt');
  assert.equal(evts.length, 1);
  assert.deepEqual([evts[0].args.from, evts[0].args.to], ['7', '9']);
  vm2.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8); STUB.FireEvent("PLAYER_LEVEL_UP", 9)');
  vm2.advance(3);
  assert.equal(outbox(vm2).filter(r => r.type === 'evt').length, 1, 'both levels count as turned');
});

test('review: the state is drawn after every keyed record: an older large message isn\'t starved by the post-hello state', () => {
  // A 1,500-byte message left unacked across a /reload, and a state too big to share its frame.
  const vm = ready({ extra: WORST });
  vm.advance(9);
  vm.slash('m'.repeat(1500));
  const vm2 = reloadVM(vm, { extra: STUB + WORST });
  vm2.login().run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  vm2.advance(3.1);
  apply(vm2, slot({ nonce: vm2.evaluate('NS.R.nonce') })); // the hello's answer: the state is queued
  const types = wires(vm2).map(r => r.type);
  assert.equal(types[0], 'msg', 'the message goes first');
  assert.ok(!types.includes('state') || types.indexOf('state') > types.indexOf('msg'));
});

test('review: a milestone confirmed after a /reload is still cleared (what each state carried is saved)', () => {
  const vm = ready();
  vm.run('STUB.zone = "Thunder Bluff"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.send('hi');
  const st = wires(vm).find(r => r.type === 'state');
  const vm2 = reloadVM(vm, { extra: STUB });
  vm2.login().run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  vm2.advance(3.1);
  apply(vm2, slot({ nonce: vm2.evaluate('NS.R.nonce'), stateSeq: Number(st.args.seq), stateSid: st.args.sid }));
  assert.equal(vm2.num('#NS.Companion.CharDB().pending'), 0, 'the bridge got that state before the reload');
});

test('review: a queued re-plan is re-checked when it goes (quests that left the log don\'t count), and switching a kind off cancels it', () => {
  const vm = ready();
  vm.advance(9);
  const pick = (id) => vm.run(`table.insert(STUB.log, { id = ${id}, title = "Quest ${id}", level = 7, complete = false, objectives = {} }); STUB.FireEvent("QUEST_ACCEPTED", ${id})`);
  pick(901); pick(902); pick(903);
  vm.run('table.remove(STUB.log); STUB.FireEvent("QUEST_REMOVED", 903)'); // abandoned before the 90 s were up
  vm.advance(200);
  assert.ok(!outbox(vm).some(r => r.type === 'evt'), 'two left: no re-plan');
  vm.run('STUB.combat = true; STUB.zone = "Thunder Bluff"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")'); // held in the fight
  vm.slash('companion zone off');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(200);
  assert.ok(!outbox(vm).some(r => r.type === 'evt'), 'the queued first visit was cancelled with its switch');
});

test('review: a first visit\'s zone rides with its event; crossing zones on a flight path doesn\'t count, the landing zone does', () => {
  const vm = ready({ extra: 'function UnitOnTaxi() return STUB.taxi == true end' });
  vm.advance(9);
  vm.run('STUB.taxi = true; STUB.zone = "The Barrens"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA"); STUB.zone = "Durotar"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.advance(4);
  assert.equal(vm.bool('NS.Companion.CharDB().zones["The Barrens"]'), false, 'flown over');
  vm.run('STUB.taxi = false');
  vm.advance(2.1); // the ticker sees the landing
  const e = outbox(vm).find(r => r.type === 'evt');
  assert.equal(e.args.kind, 'zone_first');
  assert.equal(e.args.zone, 'Durotar');
  assert.equal(vm.bool('NS.Companion.CharDB().zones["The Barrens"]'), false);
});

test('review: at 40 chats the Companion chat is still made (reserved), and it survives the next load', () => {
  const chats = Array.from({ length: 40 }, (_, i) => `{ id = "c${String(i).padStart(6, '0')}", name = "Chat ${i + 1}", agent = "main", history = {}, pending = {}, unread = 0 }`).join(', ');
  const vm = ready({ db: `NQADB = { chats = { ${chats} }, companion = { chars = { ["Tavi-Testrealm"] = { sid = "${SID}" } } } }` });
  vm.advance(9);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8)');
  vm.advance(2.1);
  assert.ok(outbox(vm).some(r => r.type === 'evt'), 'the event went');
  assert.equal(vm.num('#NQADB.chats'), 41);
  const vm2 = reloadVM(vm, { extra: STUB });
  vm2.login();
  assert.equal(vm2.num('#NQADB.chats'), 41, 'no chat of yours was dropped to fit it');
  assert.ok(vm2.evaluate('NS.Chats.Find("c0ffee0")'));
});

test('review: XP across a level-up is the same whichever event comes first', () => {
  for (const order of ['level first', 'xp first']) {
    const vm = newVM({ extra: STUB, db: DB() }).login();
    vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
    vm.run('STUB.xp = 900; STUB.FireEvent("PLAYER_XP_UPDATE", "player")'); // +600
    if (order === 'level first') {
      vm.run('STUB.level, STUB.xp, STUB.xpMax = 8, 100, 1600; STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
    } else {
      vm.run('STUB.xp = 100; STUB.FireEvent("PLAYER_XP_UPDATE", "player")'); // the XP starts over before the level changes
      vm.run('STUB.level, STUB.xpMax = 8, 1600; STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
    }
    vm.run('STUB.xp = 150; STUB.FireEvent("PLAYER_XP_UPDATE", "player")'); // +50
    assert.equal(vm.num('NS.Companion.Session().xpGained'), 1250, order);
  }
});

test('review: nits: omitted names only keys that were there; a link can\'t make a message start with [NeverQuestAlone; a two-hander brings both hands; the switch text is escaped; no rebuilds without caps; off takes the state out of the reload outbox', () => {
  const vm = newVM({ extra: STUB + 'for i = 1, 30 do STUB.log[i] = { id = 2000 + i, title = string.rep("T", 60), level = 5, complete = false, objectives = { { text = string.rep("O", 60), numFulfilled = 1, numRequired = 2 }, { text = string.rep("P", 60), numFulfilled = 1, numRequired = 2 } } } end', db: DB() }).login();
  const s = JSON.parse(vm.evaluate('NS.Companion.Build().json'));
  assert.ok(!s.omitted.includes('gear') && !s.omitted.includes('poi'), `no gear or poi to leave out: ${s.omitted}`);
  assert.ok(s.omitted.length > 0);
  const r = ready({ extra: `STUB.equipLoc[5002] = "INVTYPE_2HWEAPON"
    STUB.inv[16] = { id = 116, link = "|cffffffff|Hitem:116::::::::|h[Walking Stick]|h|r" }; STUB.inv[17] = { id = 117, link = "|cffffffff|Hitem:117::::::::|h[Buckler]|h|r" }` });
  r.advance(9);
  r.send('|cff1eff00|Hitem:9::::::::|h[NeverQuestAlone event]|h|r hi');
  assert.match(notice(r), /^Not sent: a message can't start with "\[NeverQuestAlone"\. The addon keeps that for its own lines\.$/);
  r.send('this staff? |cff1eff00|Hitem:5002::::::::|h[Staff]|h|r');
  const m = wires(r).filter(w => w.type === 'msg').pop();
  assert.ok(m.text.includes('[Equipped: main hand] Walking Stick') && m.text.includes('[Equipped: off hand] Buckler'));
  r.slash('companion');
  assert.ok(notice(r).includes('on||off') && !/[^|]\|off/.test(notice(r)));
  const nc = ready({ caps: false });
  const seqBefore = nc.num('NQADB.companion.seq');
  nc.run('STUB.money = 1; STUB.FireEvent("PLAYER_MONEY")');
  nc.advance(5);
  assert.equal(nc.num('NQADB.companion.seq'), seqBefore, 'no caps: nothing is built');
  const off = ready();
  off.slash('stream on');
  off.send('what next?');
  assert.ok(outbox(off).some(w => w.type === 'state'));
  off.slash('companion off');
  assert.ok(!outbox(off).some(w => w.type === 'state'), 'off: the state leaves the reload outbox');
});

test('client shapes (E-020): UnitName\'s second value doesn\'t break the state or the recap; links with the client\'s |cnIQ1: colour code are read like any other', () => {
  const vm = ready({ extra: `
    STUB.equipLoc[5776] = "INVTYPE_2HWEAPON"
    STUB.inv[16] = { id = 5776, link = "|cnIQ1:|Hitem:5776::::::::9:14|h[Worn Staff]|h|r" }; STUB.ilvl[5776] = 5
    STUB.tooltips["item:5776::::::::9:14"] = { "|cnIQ1:Worn Staff|r", "Two-Hand" }` });
  vm.advance(9);
  const s = stateJSON(vm);
  assert.equal(s.char.name, 'Tavi', 'built despite the extra value');
  assert.equal(vm.evaluate('NS.R.companionError'), null, 'no error kept');
  vm.slash('state');
  assert.match(notice(vm), /^Companion state:\nState v=1, seq=\d+/);
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(JSON.parse(vm.evaluate('NQADB.companion.lastSession')).char.name, 'Tavi');
  vm.send('is this better? |cnIQ1:|Hitem:5776::::::::9:14|h[Worn Staff]|h|r');
  const msg = wires(vm).filter(r => r.type === 'msg').pop();
  assert.ok(msg.text.startsWith('is this better? [Worn Staff]\n\n--- Linked from the game ---\n[Worn Staff] item 5776'), msg.text);
  assert.ok(!msg.text.includes('|cn'), 'no colour codes reach NeverQuestAlone');
  assert.ok(msg.text.includes('[Equipped: main hand] Worn Staff, item 5776, item level 5\n  Worn Staff\n  Two-Hand'));
});

// ---------------------------------------------------------------- a real logout on 70009 (2026-09-26)

// In PLAYER_LOGOUT the client reads UnitXP, UnitXPMax and GetMoney as 0 (one value each, as in
// play) while UnitLevel still reads right. The saved recap had end { level 9, xp 0, xpMax 0,
// money 0 } after a start of { 9, 1505, 6500, 583 } and 1,952 XP counted in play.
const LOGOUT_READS = 'STUB.xp, STUB.xpMax, STUB.money = 0, 0, 0';
const endOf = vm => {
  const d = JSON.parse(vm.evaluate('NQADB.companion.lastSession'));
  return { start: { ...d.start, t: 0 }, end: { ...d.end, t: 0 }, xpGained: d.xpGained, moneyDelta: d.moneyDelta };
};

test('session (F6) at a real logout (70009): XP, max XP and money read 0 there; the end is what play last saw, and 0 reads in the teardown count for nothing', () => {
  for (const teardown of ['PLAYER_LOGOUT alone', 'change events first']) {
    const vm = newVM({ extra: STUB + 'STUB.level, STUB.xp, STUB.xpMax, STUB.money = 9, 1505, 6500, 583', db: DB() }).login();
    vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
    vm.run('STUB.xp = 2400; STUB.FireEvent("PLAYER_XP_UPDATE", "player"); STUB.xp = 3457; STUB.FireEvent("PLAYER_XP_UPDATE", "player")'); // +1,952
    vm.run('STUB.money = 703; STUB.FireEvent("PLAYER_MONEY")'); // looted 1s 20c
    vm.advance(2400);
    const events = teardown === 'change events first' ? 'STUB.FireEvent("PLAYER_XP_UPDATE", "player"); STUB.FireEvent("PLAYER_MONEY"); ' : '';
    vm.run(`${LOGOUT_READS}; ${events}STUB.FireEvent("PLAYER_LOGOUT")`);
    assert.deepEqual(endOf(vm), {
      start: { t: 0, level: 9, xp: 1505, xpMax: 6500, money: 583 },
      end: { t: 0, level: 9, xp: 3457, xpMax: 6500, money: 703 },
      xpGained: 1952, moneyDelta: 120,
    }, `${teardown}: not end { xp 0, xpMax 0, money 0 } and moneyDelta -583`);
    assert.equal(vm.evaluate('NS.R.companionError'), null, teardown);
    const fin = finishRecap(vm.evaluate('NQADB.companion.lastSession'), 'quit');
    assert.equal(fin.zeroed, false, 'the bridge sends it as it is');
    assert.equal(fin.doc.moneyDelta, 120);
  }
});

test('session (F6) at a real logout, the edges: a real 0 money, a session saved before lastMoney, a level-up to a level with no XP bar, a level read as 0 too', () => {
  // Spent down to nothing in play: PLAYER_MONEY saw the 0, so the logout's 0 stands.
  let vm = newVM({ extra: STUB, db: DB() }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  vm.run('STUB.money = 0; STUB.FireEvent("PLAYER_MONEY")');
  vm.run(`${LOGOUT_READS}; STUB.FireEvent("PLAYER_LOGOUT")`);
  assert.deepEqual(endOf(vm).end, { t: 0, level: 7, xp: 300, xpMax: 1400, money: 0 });
  assert.equal(endOf(vm).moneyDelta, -11800);
  // A session the addon saved before this fix (no lastMoney) goes on after a /reload: the
  // PLAYER_ENTERING_WORLD takes the money, so the logout's 0 has something to fall back on.
  vm = newVM({ extra: STUB + 'STUB.money = 12500', db: `NQADB = { companion = { chars = { ["Tavi-Testrealm"] = { sid = "${SID}", session = {
    sid = "${SID}", start = { t = 1700000000, level = 7, xp = 300, xpMax = 1400, money = 11800 }, xpGained = 0, questsTurnedIn = 0,
    zones = { "Mulgore" }, lastXp = 300, lastXpMax = 1400, lastLevel = 7 } } } } }` }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  vm.run(`${LOGOUT_READS}; STUB.FireEvent("PLAYER_LOGOUT")`);
  assert.deepEqual(endOf(vm).end, { t: 0, level: 7, xp: 300, xpMax: 1400, money: 12500 });
  assert.equal(endOf(vm).moneyDelta, 700);
  // If the client reads max XP 0 at the level cap, reaching it isn't the teardown: the rest
  // of the old level counts, and later 0 reads there are right as they are.
  vm = newVM({ extra: STUB + 'STUB.level, STUB.xp, STUB.xpMax = 59, 208000, 209800', db: DB() }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  vm.run('STUB.level, STUB.xp, STUB.xpMax = 60, 0, 0; STUB.FireEvent("PLAYER_LEVEL_UP", 60); STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
  vm.run('STUB.money = 15000; STUB.FireEvent("PLAYER_MONEY")');
  vm.run(`${LOGOUT_READS}; STUB.FireEvent("PLAYER_LOGOUT")`);
  assert.deepEqual(endOf(vm), {
    start: { t: 0, level: 59, xp: 208000, xpMax: 209800, money: 11800 },
    end: { t: 0, level: 60, xp: 0, xpMax: 0, money: 15000 },
    xpGained: 1800, moneyDelta: 3200,
  });
  // A level-up in the session, then a logout that reads the level as 0 as well: the level play saw.
  vm = newVM({ extra: STUB, db: DB() }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false)');
  vm.run('STUB.level, STUB.xp, STUB.xpMax = 8, 100, 1600; STUB.FireEvent("PLAYER_LEVEL_UP", 8); STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
  vm.run(`${LOGOUT_READS}; STUB.level = 0; STUB.FireEvent("PLAYER_LOGOUT")`);
  assert.deepEqual(endOf(vm), {
    start: { t: 0, level: 7, xp: 300, xpMax: 1400, money: 11800 },
    end: { t: 0, level: 8, xp: 100, xpMax: 1600, money: 11800 },
    xpGained: 1200, moneyDelta: 0,
  });
});

// ---------------------------------------------------------------- the state deflated for the strip (cap z)

// A state about the size of the owner's live one (2,597 bytes on 2026-09-26): level 9 in
// Mulgore, 8 quests, 8 quest points, 10 items of gear, 5 professions, 3 milestones.
const REAL = `
STUB.level, STUB.xp, STUB.xpMax, STUB.money = 9, 3457, 6500, 703
STUB.posX, STUB.posY = 0.473, 0.589
local function Quest(id, title, level, trivial, complete, objs)
	local o = {}
	for i, x in ipairs(objs) do o[i] = { text = x[1] .. ": " .. x[2] .. "/" .. x[3], numFulfilled = x[2], numRequired = x[3], finished = x[2] >= x[3] } end
	return { id = id, title = title, level = level, trivial = trivial, complete = complete, objectives = o }
end
STUB.log = {
	Quest(743, "Dangers of the Windfury", 10, false, false, { { "Windfury Talon", 3, 8 } }),
	Quest(745, "Sharing the Land", 10, false, false, { { "Palemane Tanner slain", 4, 10 }, { "Palemane Skinner slain", 2, 8 }, { "Palemane Poacher slain", 0, 5 } }),
	Quest(746, "Dwarven Digging", 10, false, false, { { "Broken Tools", 0, 1 } }),
	Quest(748, "Poison Water", 5, true, true, { { "Prairie Wolf Paw", 6, 6 }, { "Plainstrider Talon", 4, 4 } }),
	Quest(750, "The Hunt Continues", 7, false, false, { { "Tough Mountain Cougar Flesh", 5, 10 } }),
	Quest(754, "Winterhoof Cleansing", 6, false, true, { { "Cleanse the Winterhoof Water Well", 1, 1 } }),
	Quest(757, "Rite of Strength", 10, false, false, { { "Bristleback Belt", 3, 12 } }),
	Quest(761, "Swoop Hunting", 8, false, false, { { "Trophy Swoop Quill", 2, 8 } }),
}
STUB.poi = {}
for i, p in ipairs({ { 743, 0.421, 0.307 }, { 745, 0.324, 0.498 }, { 746, 0.588, 0.475 }, { 748, 0.475, 0.602 }, { 750, 0.469, 0.611 }, { 757, 0.594, 0.256 }, { 761, 0.468, 0.604 }, { 754, 0.485, 0.599 } }) do
	STUB.poi[i] = { questID = p[1], x = p[2], y = p[3] }
end
for _, g in ipairs({ { 1, 3280, 8 }, { 3, 4644, 9 }, { 5, 154, 5 }, { 6, 3601, 7 }, { 7, 9519, 7 }, { 8, 2961, 10 }, { 9, 4692, 6 }, { 10, 4667, 7 }, { 15, 4671, 8 }, { 16, 2495, 5 } }) do
	STUB.inv[g[1]] = { id = g[2], link = "|cffffffff|Hitem:" .. g[2] .. "::::::::|h[Item " .. g[2] .. "]|h|r" }
	STUB.ilvl[g[2]] = g[3]
end
STUB.skills = { { "Professions", true }, { "Mining", false, 23, 75 }, { "Herbalism", false, 15, 75 }, { "Secondary Skills", true }, { "First Aid", false, 12, 75 }, { "Cooking", false, 8, 75 }, { "Fishing", false, 1, 75 } }
function GetNumSkillLines() return #STUB.skills end
function GetSkillLineInfo(i) local s = STUB.skills[i]; return s[1], s[2] or nil, false, s[3], 0, 0, s[4] end
`;
const REAL_DB = `NQADB = { companion = { chars = { ["Tavi-Testrealm"] = { sid = "${SID}", pending = {
  { pid = 1, kind = "zone", zone = "Thunder Bluff", t = 1790410100 }, { pid = 2, kind = "prof", name = "Herbalism", max = 75, t = 1790410800 },
  { pid = 3, kind = "quest_done", id = 747, title = "The Hunt Begins", t = 1790411500 } } } } } }`;
const WITH_Z = ['state', 'evt', 'z'];
// Strip rows for a payload, as Codec.lua and DrawCells count them: 8 frame bytes, 3 bits a cell, 200 cells a row.
const rowsOf = vm => Math.ceil(Math.ceil((vm.strip().len + 8) * 8 / 3) / 200);

test('state, deflated (cap z): with z in the bridge\'s caps the state goes as base64 of its deflated JSON, marked z=1, and the bridge gets the exact JSON back; about 2,600 bytes of state draw 18 strip rows instead of 36', () => {
  const plain = ready({ extra: REAL, db: REAL_DB });
  const zvm = ready({ extra: REAL, db: REAL_DB, caps: WITH_Z });
  const json = zvm.evaluate('NS.Companion.Build().json');
  assert.equal(json, plain.evaluate('NS.Companion.Build().json'), 'the same state either way');
  const bytes = Buffer.byteLength(json);
  assert.ok(bytes > 2500 && bytes <= 2800, `${bytes} bytes, near the live 2,597`);
  const [p] = wires(plain);
  const [z] = wires(zvm);
  assert.deepEqual([p.type, p.args.z, p.body], ['state', undefined, json], 'without z: the JSON as it is');
  assert.equal(z.type, 'state');
  assert.deepEqual(z.args, { ...p.args, z: '1' }, 'the same cur, sid and seq, plus z=1');
  assert.match(z.body, /^[A-Za-z0-9+/]+={0,2}$/, 'base64, nothing else');
  assert.ok(z.body.length < bytes / 2, `${z.body.length} of ${bytes} bytes`);
  const back = inflateBody(z.body, 2800);
  assert.deepEqual(back, { ok: true, text: json }, 'the bridge inflates it to the exact JSON');
  assert.ok(validateState(back.text).ok);
  // The band at the top of the screen: this state alone, as it goes after each hello.
  const [before, after] = [rowsOf(plain), rowsOf(zvm)];
  // Deflated, it takes half the rows or fewer (18 before T18's sections, 19 with them).
  assert.ok(before >= 35 && after <= Math.ceil(before / 2), `${before} rows plain, ${after} deflated`);
  // With a message: the msg first and the deflated state beside it, one frame.
  zvm.advance(9);
  zvm.run('STUB.money = 800');
  zvm.send('where do I turn in Poison Water?');
  const w = wires(zvm);
  assert.deepEqual(w.map(r => [r.type, r.args.z]), [['msg', undefined], ['state', '1']], 'only the state is deflated');
  assert.equal(Number(w[0].args.st), Number(w[1].args.seq));
  assert.equal(JSON.parse(inflateBody(w[1].body, 2800).text).char.money, 800);
  // /nqa state, /nqa apicheck and /nqa diag say how it travels.
  zvm.slash('state');
  assert.match(notice(zvm), /\nIt travels deflated: 1,\d{3} of 3,100 bytes on the strip, for 2,\d{3} bytes of JSON\.\n/);
  assert.match(notice(zvm), /NeverQuestAlone caps: state evt z$/);
  zvm.slash('apicheck');
  assert.match(notice(zvm), /\nC_EncodingUtil\.CompressString \(the state, deflated for the strip\): present, "1,\d{3} of 2,\d{3} bytes"\n/);
  zvm.slash('diag');
  assert.match(notice(zvm), /\nCompanion: on; caps state\+evt\+z; /);
  plain.slash('state');
  assert.match(notice(plain), /\nIt travels as JSON: NeverQuestAlone doesn't take it deflated\.\n/);
  // Stream mode (the reload path): deflated in the outbox too, and the bridge reads it the same way.
  zvm.slash('stream on');
  zvm.run('STUB.money = 900');
  zvm.send('and after that?');
  const st = outbox(zvm).find(r => r.type === 'state');
  assert.equal(st.args.z, '1');
  assert.equal(JSON.parse(inflateBody(st.body, 2800).text).char.money, 900);
});

test('state, deflated (cap z): the JSON goes as it is when the bridge doesn\'t list z, or the client lacks the API, or a call fails, returns nothing, or doesn\'t give the JSON back', () => {
  const vm = ready({ extra: REAL, db: REAL_DB, caps: WITH_Z });
  vm.run('CLIENT = {}; for k, f in pairs(C_EncodingUtil) do CLIENT[k] = f end');
  const cases = {
    'no C_EncodingUtil': 'C_EncodingUtil = nil',
    'no CompressString': 'C_EncodingUtil.CompressString = nil',
    'no DecompressString to check it': 'C_EncodingUtil.DecompressString = nil',
    'CompressString raises': 'C_EncodingUtil.CompressString = function() error("no deflate here") end',
    'CompressString returns nothing': 'C_EncodingUtil.CompressString = function() end',
    'EncodeBase64 raises': 'C_EncodingUtil.EncodeBase64 = function() error("no base64 here") end',
    'EncodeBase64 gives something that isn\'t base64': 'C_EncodingUtil.EncodeBase64 = function() return "not base64!" end',
    'the inflate gives something else back': 'C_EncodingUtil.DecompressString = function() return "{}" end',
    'the round trip loses a byte': 'C_EncodingUtil.DecompressString = function(...) return (CLIENT.DecompressString(...)):sub(2) end',
  };
  let money = 1000;
  const next = (lua) => {
    vm.run(`C_EncodingUtil = {}; for k, f in pairs(CLIENT) do C_EncodingUtil[k] = f end; ${lua}`);
    vm.run(`STUB.money = ${++money}; NS.Companion.QueueState()`); // a new state, queued as a send would
    return parseRecord(vm.evaluate('NS.R.stateRec.wire')).record;
  };
  assert.equal(next('').args.z, '1', 'the client as it is: deflated');
  for (const [name, lua] of Object.entries(cases)) {
    const st = next(lua);
    assert.equal(st.args.z, undefined, name);
    assert.equal(st.body, vm.evaluate('NS.Companion.Build().json'), `${name}: the JSON`);
    assert.equal(JSON.parse(st.body).char.money, money, name);
    vm.slash('state');
    assert.match(notice(vm), /\nIt travels as JSON: this client can't deflate it, or deflating saves nothing\.\n/, name);
  }
  assert.equal(vm.evaluate('NS.R.companionError'), null, 'nothing thrown');
  // A bridge that stops listing z gets JSON from the next state on.
  apply(vm, slot({ caps: true }));
  assert.equal(next('').args.z, undefined, 'no z in the caps');
  // A state too small to gain (too_large's stub) goes as JSON too.
  vm.run('X = NS.Transport.Deflate(\'{"v":1,"sid":"a1b2c3d4e5f60718","seq":1,"state":"too_large"}\')');
  assert.equal(vm.evaluate('X'), null, 'no shorter: nil');
  const off = newVM({ extra: STUB, db: DB(), encoding: false }).login();
  off.slash('apicheck');
  assert.match(notice(off), /\nC_EncodingUtil\.CompressString \(the state, deflated for the strip\): missing\n/);
});

// ---------------------------------------------------------------- the game context from the state (cap ctx)

const CTX_Z = ['state', 'evt', 'z', 'ctx'];
// The context's other lines, as the test sets them: the map's name, the faction, the guild, talents.
const CONTEXT_STUB = `
C_Map.GetMapInfo = function(id) return { name = "Mulgore", mapID = id } end
function UnitFactionGroup() return "Horde", "Horde" end
STUB.guild = "Sunwalkers"
function GetGuildInfo() return STUB.guild, "Member", 1 end
STUB.talents = { { "Elemental", 0 }, { "Enhancement", 0 }, { "Restoration", 0 } }
function GetNumTalentTabs() return #STUB.talents end
function GetTalentTabInfo(i) return STUB.talents[i][1], "x", STUB.talents[i][2] end
`;
// Some play since the hello: moved, a kill, loot, a quest counter, a level.
const PLAY = 'STUB.posX, STUB.posY = 0.502, 0.561; STUB.xp = 3790; STUB.money = 812; STUB.level = 10; STUB.log[1].objectives[1].numFulfilled = 4; STUB.log[1].objectives[1].text = "Windfury Talon: 4/8"';
const newestMsg = vm => outbox(vm).filter(r => r.type === 'msg').pop();

test('context from the state (cap ctx): beside its state a message leaves the game context out, its 493 bytes, 6 or 7 strip rows fewer, and the bridge rebuilds the very same context from the hello\'s and the state', () => {
  const vm = ready({ extra: REAL + CONTEXT_STUB, db: REAL_DB, caps: CTX_Z });
  const old = ready({ extra: REAL + CONTEXT_STUB, db: REAL_DB, caps: WITH_Z }); // a bridge without cap ctx
  const hello = vm.evaluate('NS.R.hello.ctx');
  for (const v of [vm, old]) {
    v.advance(9);
    v.run(PLAY);
    v.send('where do I turn in Poison Water?');
  }
  const [m, st] = wires(vm);
  assert.deepEqual([m.type, st.type], ['msg', 'state'], 'one frame: the message and its state');
  assert.deepEqual([m.args.ctx, m.context, m.text], ['0', null, 'where do I turn in Poison Water?'], 'no context in it');
  assert.equal(Number(m.args.st), Number(st.args.seq));
  const [om] = wires(old);
  assert.equal(om.args.ctx, '1', 'without cap ctx: the context goes, as before');
  const fresh = vm.evaluate('NS.Chats.GameContext()');
  assert.equal(om.context, fresh);
  // The bridge: the stored (hello's) context with the state put in is, line for line, the context the addon has now.
  assert.notEqual(fresh, hello, 'the place, money, XP, level and a quest changed since the hello');
  const state = JSON.parse(inflateBody(st.body, 2800).text);
  assert.equal(withState(hello, state), fresh, 'the same context lines for NeverQuestAlone');
  // The band at the top of the screen: the frame is exactly the context's bytes shorter (the state
  // beside the message is the same in both), and that's 6 or 7 rows by where the frame's rows break.
  // The deflated state's size moves with the zlib Node ships (6 on Node 26, 7 on Node 22: CI 36645719445).
  assert.equal(old.strip().len - vm.strip().len, 493, 'the context\'s bytes, exactly');
  const [rows, before] = [rowsOf(vm), rowsOf(old)];
  assert.ok(before - rows >= 6 && before - rows <= 7, `${before} rows with the context, ${rows} without`);
});

test('context from the state (cap ctx): it still goes when a line the state doesn\'t carry changed (talents, guild), once; when the state won\'t reach the bridge in the message\'s frame; and to turn it off. A new level alone doesn\'t send it', () => {
  const vm = ready({ extra: REAL + CONTEXT_STUB, db: REAL_DB, caps: CTX_Z });
  vm.advance(9);
  // Each send acked, and its state held by the bridge, as a slot would say.
  const send = (text) => {
    vm.send(text);
    const m = newestMsg(vm);
    const st = wires(vm).find(r => r.type === 'state');
    apply(vm, slot({ caps: CTX_Z, acked: [m.key], stateSeq: st ? Number(st.args.seq) : vm.num('NQADB.companion.seq'), stateSid: SID }));
    return m;
  };
  vm.run('STUB.posX = 0.51');
  assert.equal(send('one').args.ctx, '0');
  vm.run('STUB.level = 10');
  assert.equal(send('a new level').args.ctx, '0', 'the state carries the level');
  vm.run('STUB.talents[2][2] = 1');
  const t = send('a talent point');
  assert.equal(t.args.ctx, '1', 'talents changed: the context goes');
  assert.match(t.context, /\nTalents: Elemental 0 \/ Enhancement 1 \/ Restoration 0\n/);
  vm.run('STUB.posX = 0.52');
  assert.equal(send('and on').args.ctx, '0', 'once');
  vm.run('STUB.guild = "Earthcallers"; STUB.posX = 0.53');
  assert.match(send('a new guild').context, /, guild <Earthcallers>\n/);
  // A long message: its state can't share the frame, so the context goes with it (it fits).
  vm.run('STUB.posX = 0.54');
  const long = send('x'.repeat(2000));
  assert.equal(long.args.ctx, '1');
  assert.ok(Buffer.byteLength(long.text) === 2000 && Buffer.byteLength(long.context) > 400);
  // Off: one message says so (an empty context), then nothing.
  vm.slash('context off');
  vm.run('STUB.posX = 0.55');
  const offMsg = send('context off now');
  assert.deepEqual([offMsg.args.ctx, offMsg.context], ['1', '']);
  assert.equal(send('still off').args.ctx, '0');
  vm.slash('context on');
  vm.run('STUB.posX = 0.56');
  assert.equal(send('back on').args.ctx, '1', 'on again: the whole context once');
  vm.run('STUB.posX = 0.57');
  assert.equal(send('and on').args.ctx, '0');
});

test('context from the state (cap ctx): a state that left the professions out to fit (the critic\'s r4 QL-F-15) doesn\'t stand for them, so a rank change sends the context and the bridge\'s Professions line is the new one; one that carries them does', () => {
  // 40 quests of long titles with objectives, full gear and quest points: an older bridge's 2,800 bytes of JSON leave the professions out.
  const vm = ready({ extra: WORST + LOG(40), caps: CTX_Z });
  vm.run('STUB.prof = { { name = "Mining", rank = 45, max = 75 } }; NS.Chats.Professions = function() return STUB.prof end');
  vm.advance(9);
  const sender = v => (text) => {
    v.send(text);
    const m = newestMsg(v);
    const st = wires(v).find(r => r.type === 'state');
    apply(v, slot({ caps: CTX_Z, acked: [m.key], stateSeq: st ? Number(st.args.seq) : v.num('NQADB.companion.seq'), stateSid: SID }));
    return m;
  };
  const send = sender(vm);
  vm.run('STUB.posX = 0.51');
  const first = send('one');
  assert.ok(stateJSON(vm).omitted.includes('prof'), 'the state leaves the professions out');
  assert.equal(first.args.ctx, '1', 'the professions changed since the hello\'s context: it goes');
  vm.run('STUB.posX = 0.52');
  assert.equal(send('two').args.ctx, '0', 'nothing the state leaves out changed');
  vm.run('STUB.prof[1].rank = 60; STUB.posX = 0.53');
  const m = send('mining up');
  assert.equal(m.args.ctx, '1', 'a rank change: the context goes');
  assert.match(m.context, /\nProfessions: Mining 60\/75\n/);
  assert.match(withState(m.context, stateJSON(vm)), /\nProfessions: Mining 60\/75\n/, 'what the bridge builds for the turn');
  // A state that carries them (a short log): the bridge takes the rank from it, and the context stays out.
  const small = ready({ caps: CTX_Z });
  small.run('STUB.prof = { { name = "Mining", rank = 45, max = 75 } }; NS.Chats.Professions = function() return STUB.prof end');
  small.advance(9);
  const sendSmall = sender(small);
  small.run('STUB.posX = 0.51');
  assert.equal(sendSmall('one').args.ctx, '0');
  small.run('STUB.prof[1].rank = 60; STUB.posX = 0.52');
  assert.equal(sendSmall('mining up').args.ctx, '0', 'the state says 60/75');
  assert.deepEqual(stateJSON(small).prof, [{ name: 'Mining', rank: 60, max: 75 }]);
});

test('context from the state (cap ctx): without a state that carries it (companion off, too_large, bare) a message goes as before; in stream mode the state goes ahead of the message', () => {
  const vm = ready({ extra: REAL + CONTEXT_STUB, db: REAL_DB, caps: CTX_Z });
  vm.advance(9);
  // Leave it out once: no context, no st=, bare=1 (as before).
  vm.run('STUB.posX = 0.51');
  vm.run(`NS.Chats.Send(${lstr('just words')}, nil, { skipGameData = true })`);
  const bare = newestMsg(vm);
  assert.deepEqual([bare.args.ctx, bare.args.st, bare.args.bare], ['0', undefined, '1']);
  // Stream mode: the state goes into the reload outbox ahead of the message, which leaves the context out.
  vm.slash('stream on');
  vm.run('STUB.posX = 0.52');
  vm.send('in stream mode');
  const recs = outbox(vm);
  const [si, mi] = [recs.findIndex(r => r.type === 'state'), recs.findIndex(r => r.type === 'msg' && r.text === 'in stream mode')];
  assert.ok(si >= 0 && si < mi, 'the state first');
  assert.equal(recs[mi].args.ctx, '0');
  vm.slash('stream off');
  // Check-Ins off: the state still goes with the message (the breaker's r2 case), so the context stays out.
  vm.slash('companion off');
  vm.run('STUB.posX = 0.53');
  vm.send('companion off');
  const offMsg = newestMsg(vm);
  assert.deepEqual([offMsg.args.ctx, offMsg.args.st !== undefined], ['0', true]);
  // Game Data with Messages off: no state, and an empty context turns the bridge's off (as before).
  vm.slash('context off');
  vm.send('context off');
  const noData = newestMsg(vm);
  assert.deepEqual([noData.args.ctx, noData.args.st, noData.context], ['1', undefined, '']);
  // A too_large state carries none of the context: it goes. (Past what any log holds: 110 quests.)
  const big = ready({ extra: WORST + LOG(110) + '\nSTUB.zone, STUB.subzone = string.rep("Ö", 30), string.rep("Ä", 30)', caps: CTX_Z });
  big.run(`NS.Chats.Professions = function() local out = {} for i = 1, 6 do out[i] = { name = string.rep("Ω", 30) .. i, rank = 300, max = 300 } end return out end
    local p = {} for i = 1, 10 do p[i] = { pid = i, id = 100 + i, kind = "quest_done", title = string.rep("Ü", 30), t = 1700000000 + i } end
    NS.Companion.CharDB().pending = p`);
  big.advance(9);
  big.run('STUB.posX = 0.51; STUB.log[1].complete = true'); // the quest line changes (a long one leaves no room for the position)
  big.send('big');
  assert.equal(big.bool('NS.Companion.Build().tooLarge'), true);
  const bm = wires(big).find(r => r.type === 'msg');
  assert.deepEqual([bm.args.ctx, bm.args.st !== undefined], ['1', true], 'the context goes, and st= still names the state');
});
