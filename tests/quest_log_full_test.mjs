// Every quest in the log reaches NeverQuestAlone on every turn (PROTOCOL §2.6). The
// addon reads the whole log, to its last quest, at the game's own cap; it fits
// the state by trimming per-quest detail, never a quest; and the bridge opens
// every quest list it gives the model with the count, so NeverQuestAlone never takes a
// whole list for a cut one. The case followed is the owner's: "Call of Fire", the
// last quest of a full 40-quest log, under a late "Shaman" header (NeverQuestAlone: "the
// game data only lists 25 quests, and Call of Fire fell off the bottom").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseRecord, inflateBody } from '../bridge/transport/records.mjs';
import { validateState, fillTitles, questLogLine, STATE_JSON_MAX, STATE_BODY_MAX } from '../bridge/app/companion.mjs';
import { withState, staleContext, parseContextLines } from '../bridge/app/context.mjs';
import { questFacts } from '../bridge/byok/runtime/logbook.mjs';
import { QLOG_STUB, entriesLua, fullLog, worstLog, worstOthers } from './helpers/quest-log.mjs';

const require = createRequire(import.meta.url);
const { newVM, lstr } = require('./helpers/nqa-vm.js');
const V = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol-v2.json'), 'utf8'));

const SID = 'a1b2c3d4e5f60718';
const DB = `NQADB = { companion = { chars = { ["Tavi-Testrealm"] = { sid = "${SID}" } } } }`;
// The character, place and gear the state reads; the quest log comes from QLOG_STUB.
const BASE = `
function UnitName(unit) if unit == "player" then return "Tavi", "" end end
function GetRealmName() return "Testrealm" end
function UnitRace() return "Tauren", "Tauren" end
function UnitClass() return "Shaman", "SHAMAN" end
STUB.level, STUB.money, STUB.xp, STUB.xpMax = 20, 11800, 300, 1400
function UnitXP() return STUB.xp end
function UnitXPMax() return STUB.xpMax end
STUB.zone, STUB.subzone = "Mulgore", "Bloodhoof Village"
function GetRealZoneText() return STUB.zone end
C_Map.GetBestMapForUnit = function() return 1412 end
STUB.inv, STUB.equipLoc, STUB.ilvl = {}, {}, {}
function GetInventoryItemID(unit, slot) local i = STUB.inv[slot]; return i and i.id end
function GetInventoryItemLink(unit, slot) local i = STUB.inv[slot]; return i and i.link end
C_Item.GetDetailedItemLevelInfo = function(link) local id = tonumber(tostring(link):match("item:(%d+)")); return id and STUB.ilvl[id] end
function IsInInstance() return false end
`;
const NEW_BRIDGE = ['state', 'evt', 'z', 'ctx', 'qlog'];

// The addon logged in with this log; caps: what the bridge lists (set as a slot would), with the
// app's companion switch on (cap usage, usage.autoOn), as tests/companion_addon_test.mjs sets it.
// Chains.lua isn't loaded: three of this log's made-up quests have real ids from the Barrens' chain to
// Wailing Caverns (1489 to 1491), and the shared vector is the quest log's, not the chains'. A full log
// with chains, and the order they drop in to fit, is tests/quest_chains_test.mjs's.
function vmWith(entries, { caps = NEW_BRIDGE, extra = '' } = {}) {
  const vm = newVM({ extra: BASE + QLOG_STUB + entriesLua(entries) + extra, db: DB, skip: ['Chains.lua'] }).login();
  vm.run(`NS.R.bridge = { caps = { ${[...caps, 'usage'].map(c => `"${c}"`).join(', ')} }, usage = { autoOn = true } }; NS.R.nonce = "a3f1"`);
  return vm;
}
const quests = vm => vm.json('(NS.Companion.Quests())');
// The state as P.Build makes it, at a send or an event (code health AD-06: never in the background).
const build = vm => { const st = vm.json('NS.Companion.Build()'); return { ...st, tooLarge: st.tooLarge ?? null, state: JSON.parse(st.json) }; };
const ids = entries => entries.filter(e => !e.header && !e.hidden).map(e => e.id);
const FULL = fullLog();

// ---------------------------------------------------------------- T1: the addon reads the whole log

test('the log: P.Quests reads all 40 quests of a full log (15 zone headers, one hidden quest) in log order; the last is 1527 Call of Fire, ready to turn in', () => {
  const vm = vmWith(FULL);
  assert.equal(vm.num('(C_QuestLog.GetNumQuestLogEntries())'), 56, '15 headers, 40 quests and a hidden one');
  const q = quests(vm);
  assert.equal(q.length, 40);
  assert.deepEqual(q.map(x => x.id), ids(FULL), 'every quest, in log order; no header, not the hidden one');
  assert.deepEqual([q[39].id, q[39].title, q[39].complete], [1527, 'Call of Fire', true]);
  const meta = vm.json('select(2, NS.Companion.Quests())');
  assert.deepEqual([meta.count, meta.max, meta.source, meta.unread], [40, 40, 'api', 0]);
});

test('the state: questCount 40 and questMax 40 before the list; every quest with its id, title and ready flag; only detail trimmed; with z and qlog it draws in one frame, and the bridge takes it and lists all 40', () => {
  const vm = vmWith(FULL);
  const st = build(vm);
  const s = st.state;
  assert.deepEqual(Object.keys(s).slice(0, 9), ['v', 'sid', 'seq', 't', 'char', 'loc', 'questCount', 'questMax', 'quests']);
  assert.deepEqual([s.questCount, s.questMax, 'questUnread' in s, st.tooLarge], [40, 40, false, null]);
  assert.equal(s.quests.length, 40);
  for (const q of s.quests) {
    assert.ok(Number.isInteger(q.id) && typeof q.complete === 'boolean', JSON.stringify(q));
    assert.ok(typeof q.title === 'string' && q.title.length > 0 && !q.cut, `${q.id}: its whole title`);
  }
  assert.deepEqual(s.quests.at(-1), { id: 1527, title: 'Call of Fire', level: 20, trivial: false, complete: true });
  assert.deepEqual(s.omitted, ['talents', 'quests.obj.done'], 'optional talents go before completed objectives; the others keep their texts');
  assert.ok(s.quests.filter(q => !q.complete).every(q => q.obj.length && q.obj.every(o => typeof o.text === 'string')), 'objective texts of the quests in progress');
  assert.ok(Buffer.byteLength(st.json) > 2800 && Buffer.byteLength(st.json) <= STATE_JSON_MAX, `${Buffer.byteLength(st.json)} bytes of JSON`);
  // The vector the bridge tests send (tests/fixtures/protocol-v2.json fullLogState).
  assert.equal(st.json, V.fullLogState.json.replace('"t":0', `"t":${s.t}`), 'the shared vector (t aside)');
  // On the strip: the state's record, deflated, in one frame.
  vm.run('NS.Companion.QueueState()');
  const wire = vm.evaluate('NS.R.stateRec.wire');
  assert.ok(Buffer.byteLength(wire) <= vm.num('NS.MAX_PAYLOAD'), `${Buffer.byteLength(wire)} bytes`);
  const rec = parseRecord(wire).record;
  assert.equal(rec.args.z, '1');
  assert.ok(rec.body.length <= 3100, `${rec.body.length} bytes of body`);
  const back = inflateBody(rec.body, { maxBody: STATE_BODY_MAX, maxText: STATE_JSON_MAX });
  assert.deepEqual(back, { ok: true, text: st.json });
  assert.ok(validateState(back.text).ok);
  assert.equal(questLogLine(JSON.parse(back.text)), 'Quest log: 40 of 40 quests (the log is full), every one listed.');
  // /nqa state says the count and the cap's source.
  vm.slash('state');
  const text = vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
  assert.match(text, /\nQuest log: 40 of 40 quests, every one in the state \(cap from C_QuestLog\.GetMaxNumQuestsCanAccept\)\.\n/);
  assert.match(text, /\nIt travels deflated: 1,\d{3} of 3,100 bytes on the strip, for 10,\d{3} bytes of JSON\.\n/);
  assert.match(text, /NeverQuestAlone caps: state evt z ctx qlog$/); // the app by its name (C-05)
});

test('the context: the Quest log line has all 40 ids after "40 of 40 quests, all listed", ends 1527*, and is never cut: long lines before it are', () => {
  const long = `
function GetGuildInfo() return ${lstr('The Guild of ' + 'Very Long Names '.repeat(18))}, "Member", 1 end
function GetTalentTabInfo(i) return ${lstr('Elemental Enhancement Restoration Talent Tree '.repeat(3))} .. i, "x", 10 end`;
  const vm = vmWith(FULL, { extra: long });
  const ctx = vm.evaluate('NS.Chats.GameContext()');
  assert.ok(Buffer.byteLength(ctx) <= 900, `${Buffer.byteLength(ctx)} bytes`);
  const line = ctx.split('\n').at(-1);
  const want = ids(FULL).map(id => `${id}${FULL.find(e => e.id === id).complete ? '*' : ''}`);
  assert.equal(line, `Quest log (id, * = ready to turn in): 40 of 40 quests, all listed: ${want.join(',')}`);
  assert.ok(line.endsWith(',1527*'));
  assert.ok(ctx.startsWith('Game: World of Warcraft'), 'what was cut is from the lines before it');
  // The bridge writes the same line from the state.
  const state = build(vm).state;
  assert.equal(withState(ctx, state).split('\n').at(-1), line);
});

test('Map: a stop naming a quest finds it past the 60th entry (40 quests under 30 headers, 70 entries) and under a collapsed header, no header opened; a change in the log right after a read reaches its lines (critic r5 QL-F-17)', () => {
  const log = fullLog({ headers: 30 });
  const vm = vmWith(log);
  assert.equal(vm.num('(C_QuestLog.GetNumQuestLogEntries())'), 72, '31 headers, 40 quests, a hidden one');
  const stop = 'NS.MapShared.StopLines({ 1412, 50, 50, "Turn in Call of Fire", "turnin" })';
  assert.ok(vm.list(stop).some(l => l.includes('Call of Fire')), JSON.stringify(vm.list(stop)));
  vm.run('STUB.collapsed["Shaman"] = true; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.ok(vm.list(stop).some(l => l.includes('Call of Fire')), 'under the collapsed header');
  // A kill stop's objective lines: the last kill lands 0.4 s after a send's state read the log.
  const q = log.find(e => e.id && !e.hidden && !e.complete && e.objectives.length);
  const kill = `NS.MapShared.StopLines({ 1412, 50, 50, "Kill things", "kill", nil, { ${q.id} } })`;
  const clean = l => l.replace(/\|c[0-9a-fA-F]{8}|\|r|\|T[^|]*\|t/g, '');
  assert.ok(vm.list(kill).map(clean).some(l => /0\/6 Collected thing 1/.test(l)), JSON.stringify(vm.list(kill)));
  vm.run('STUB.FireEvent("PLAYER_XP_UPDATE")');
  build(vm);
  vm.advance(0.4);
  vm.run(`for _, e in ipairs(STUB.entries) do if e.id == ${q.id} then e.complete = true end end; STUB.FireEvent("QUEST_LOG_UPDATE")`);
  assert.ok(vm.list(kill).map(clean).some(l => /complete, turn it in/i.test(l)), JSON.stringify(vm.list(kill).map(clean)));
  assert.equal(vm.num('STUB.headerCalls'), 0, 'no header opened or closed');
});

test('the cap: C_QuestLog.GetMaxNumQuestsCanAccept, else Forever\'s own constant, else 40; the stale MAX_QUESTS (25) never lowers it; never below the quests read', () => {
  const vm = vmWith(FULL, { extra: 'MAX_QUESTS = 25' });
  const cap = () => vm.json('{ NS.QuestLogMax() }');
  assert.deepEqual(cap(), [40, 'api']);
  vm.run('STUB.maxQuests = 35');
  assert.deepEqual(cap(), [35, 'api']);
  vm.run('C_QuestLog.GetMaxNumQuestsCanAccept = nil; Constants = { QuestLogConsts = { MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT = 40 } }');
  assert.deepEqual(cap(), [40, 'const']);
  vm.run('Constants = nil');
  assert.deepEqual(cap(), [40, 'fallback'], 'not MAX_QUESTS');
  vm.run('C_QuestLog.GetMaxNumQuestsCanAccept = function() return 25 end');
  assert.deepEqual(vm.json('{ NS.QuestLogMax(41) }'), [41, 'api'], 'never below the quests read');
  // Both there: the larger (an API answering a stale 25 never makes a log of 30 look full).
  vm.run('Constants = { QuestLogConsts = { MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT = 40 } }');
  assert.deepEqual(cap(), [40, 'const'], 'the API\'s 25 under the constant\'s 40');
  vm.run('C_QuestLog.GetMaxNumQuestsCanAccept = function() return 45 end');
  assert.deepEqual(cap(), [45, 'api']);
  vm.run('Constants = nil');
  // 41 quests in a log whose API says 40: all 41 go, and questMax says 41.
  vm.run(`C_QuestLog.GetMaxNumQuestsCanAccept = function() return 40 end
    table.insert(STUB.entries, { id = 1600, title = "One more", level = 20, objectives = {} })`);
  const s = build(vm).state;
  assert.deepEqual([s.quests.length, s.questCount, s.questMax], [41, 41, 41]);
});

// A fight, and the quest log on screen: the read is the same in both.
const IN_COMBAT = 'InCombatLockdown = function() return true end';
const ON_SCREEN = 'QuestMapFrame = { IsVisible = function() return true end }';

test('a quest under a collapsed header (listed by C_QuestLog.GetInfo, as on WoW: Forever) reaches the model: Call of Fire under a collapsed Shaman is in the state, the block, the context and the window\'s count, "every one listed", in a fight or with the quest log on screen too; no header is ever opened or closed, and one send reads the log once', () => {
  for (const [label, pre] of [['out of combat', ''], ['in a fight', IN_COMBAT], ['the quest log on screen', ON_SCREEN]]) {
    const vm = vmWith(FULL);
    vm.advance(4); // past the hello
    const initial = build(vm);
    // T18 deliberately stops reading talents in combat. Enter combat before measuring
    // header folding: that transition changes omitted, but folding must change nothing.
    vm.run(pre);
    const before = build(vm);
    assert.deepEqual(before.state.quests, initial.state.quests, `${label}: entering combat does not change the quest log`);
    assert.deepEqual(before.state.omitted, label === 'in a fight' ? ['quests.obj.done'] : ['talents', 'quests.obj.done'], label);
    assert.equal(before.seq, initial.seq + (label === 'in a fight' ? 1 : 0), `${label}: only the combat transition changes the state`);
    // The player folds three zones (the game fires QUEST_LOG_UPDATE): nothing in the log changed.
    vm.run('STUB.collapsed["Mulgore"] = true; STUB.collapsed["The Barrens"] = true; STUB.collapsed["Shaman"] = true; STUB.FireEvent("QUEST_LOG_UPDATE")');
    vm.advance(3);
    const st = build(vm);
    const s = st.state;
    assert.deepEqual(s.quests.map(q => q.id), ids(FULL), `${label}: every quest, in log order`);
    assert.deepEqual(s.quests.at(-1), { id: 1527, title: 'Call of Fire', level: 20, trivial: false, complete: true }, label);
    assert.deepEqual([s.questCount, s.questMax, 'questUnread' in s, 'questUnreadHeaders' in s], [40, 40, false, false], label);
    assert.equal(st.seq, before.seq, `${label}: the same state, no new seq`);
    assert.equal(st.json, before.json, `${label}: folding headers leaves the entire state unchanged`);
    assert.equal(questLogLine(s), 'Quest log: 40 of 40 quests (the log is full), every one listed.', label);
    const ctx = vm.evaluate('NS.Chats.GameContext()');
    assert.match(ctx, /\nQuest log \(id, \* = ready to turn in\): 40 of 40 quests, all listed: [\d*,]+,1527\*$/, label);
    assert.equal(withState(ctx, s).split('\n').at(-1), ctx.split('\n').at(-1), `${label}: the bridge writes the same line from the state`);
    vm.run('NS.UI.Toggle(true); NS.UI.RenderContext()');
    assert.match(vm.list('NS.UI.ui.ctx.lines')[0], / · 40 quests · gear$/, `${label}: the window counts the 40`);
    assert.equal(vm.num('STUB.headerCalls'), 0, `${label}: no header opened or closed`);
  }
  // One send reads the log once: the state and the context share it (R.questShare).
  const vm = vmWith(FULL);
  vm.advance(4);
  vm.run('NS.reads = 0; local n = C_QuestLog.GetNumQuestLogEntries; C_QuestLog.GetNumQuestLogEntries = function() NS.reads = NS.reads + 1; return n() end');
  vm.run('NS.R.questShare = { at = GetTime() }');
  build(vm);
  vm.evaluate('NS.Chats.GameContext()');
  vm.run('NS.R.questShare = nil');
  assert.equal(vm.num('NS.reads'), 1, 'one read for the send');
});

test('a real change right after a read reaches the state (critic r5 QL-F-17): a quest finished 0.4 s after a send\'s state read the log, with a collapsed header, is ready to turn in in the state the bridge gets next', () => {
  const vm = vmWith(FULL);
  vm.advance(6);
  vm.run('STUB.collapsed["Shaman"] = true; STUB.FireEvent("QUEST_LOG_UPDATE")');
  const q = FULL.find(e => e.id && !e.hidden && !e.complete);
  const flag = () => build(vm).state.quests.find(x => x.id === q.id).complete; // a send's state (P.Build)
  assert.equal(flag(), false);
  vm.run('STUB.FireEvent("PLAYER_XP_UPDATE")');
  assert.equal(flag(), false);
  vm.advance(0.4);
  vm.run(`for _, e in ipairs(STUB.entries) do if e.id == ${q.id} then e.complete = true end end; STUB.FireEvent("QUEST_LOG_UPDATE")`);
  assert.equal(flag(), true, 'the next state has it');
  assert.equal(JSON.parse(vm.evaluate('NS.db.companion.stateJson')).quests.find(x => x.id === q.id).complete, true, 'and the stored state');
});

// [code health AD-06] Every XP, money, quest log or gear change rebuilt the whole state 2 s later
// (0.6 ms and 200 KB each, several times a minute), and nothing read it before a send, which builds
// it again. Only a send, an event or /nqa state builds it now.
test('no background rebuild: quest log, XP, money and gear changes build no state until a send, which has them (code health AD-06)', () => {
  const vm = vmWith(FULL);
  vm.advance(6); // past the hello's state
  vm.run('NS.builds = 0; local b = NS.Companion.Build; NS.Companion.Build = function(...) NS.builds = NS.builds + 1; return b(...) end');
  const seq = Number(vm.evaluate('NS.db.companion.seq'));
  vm.run(`STUB.xp = 900; STUB.money = 99999
    for _, ev in ipairs({ "QUEST_LOG_UPDATE", "PLAYER_XP_UPDATE", "PLAYER_MONEY", "PLAYER_EQUIPMENT_CHANGED", "SKILL_LINES_CHANGED", "PLAYER_LEVEL_CHANGED" }) do STUB.FireEvent(ev, "player") end`);
  vm.advance(30);
  assert.equal(vm.num('NS.builds'), 0, 'nothing built in the background');
  assert.equal(Number(vm.evaluate('NS.db.companion.seq')), seq, 'the stored state is as the last send left it');
  vm.send('what now?');
  assert.equal(vm.num('NS.builds'), 1, 'the send builds it');
  assert.equal(Number(vm.evaluate('NS.db.companion.seq')), seq + 1, 'with the changes');
  const s = JSON.parse(vm.evaluate('NS.db.companion.stateJson'));
  assert.equal(s.char.money, 99999);
  vm.slash('state');
  assert.equal(vm.num('NS.builds'), 2, '/nqa state builds it too');
});

// The game's quest count without hidden quests, with none at all, and one far off: the list never depends on it.
const NOHID = `local nq = C_QuestLog.GetNumQuestLogEntries
C_QuestLog.GetNumQuestLogEntries = function() local s, n = nq(); for _, e in ipairs(STUB.entries) do if e.hidden then n = n - 1 end end; return s, n end`;
const NOCOUNT = `local nq = C_QuestLog.GetNumQuestLogEntries
C_QuestLog.GetNumQuestLogEntries = function() return (nq()) end`;
const FAROFF = `local nq = C_QuestLog.GetNumQuestLogEntries
C_QuestLog.GetNumQuestLogEntries = function() return (nq()), 99 end`;
// The quests in the log as the game has them (not headers, not hidden), in log order.
const truth = vm => vm.json('(function() local t = {} for _, e in ipairs(STUB.entries) do if not e.header and not e.hidden then t[#t + 1] = e.id end end return t end)()');
// A quest put first under a header.
const underHeader = (header, quest) => `local at; for i, e in ipairs(STUB.entries) do if e.header == ${lstr(header)} then at = i end end; table.insert(STUB.entries, at + 1, ${quest})`;
const setHidden = (id, hidden) => `for _, e in ipairs(STUB.entries) do if e.id == ${id} then e.hidden = ${hidden} end end`;

test('whatever changed under a collapsed header and whatever the game counts (the breaker\'s r4 F1 and F2, the critic\'s r4 QL-F-13, the breaker\'s r5 false cut): every read lists the log as it is and says so; the game\'s own count never changes what the model is told', () => {
  const cases = [
    // F1: 7001, a quest under Shaman, turns hidden, and Call of Fire is picked up there.
    ['F1, the count without hidden quests', [...FULL.filter(e => e.id !== 1527), { id: 7001, title: 'Shaman errand', level: 20, objectives: [] }], NOHID,
      `${setHidden(7001, true)}; ${underHeader('Shaman', '{ id = 1527, title = "Call of Fire", level = 20, complete = true, objectives = {} }')}`],
    // F2: hidden 7002 under Shaman turns into a quest.
    ['F2, the count with hidden quests', [...FULL, { id: 7002, title: 'Shaman tracking', level: 20, hidden: true, objectives: [] }], '', setHidden(7002, false)],
    // QL-F-13's last case: the hidden 90001 turns visible under its own collapsed header (Mulgore).
    ['QL-F-13, hidden to visible under its own header', FULL, '', `${setHidden(90001, false)}; STUB.collapsed["Mulgore"] = true`],
    ['a quest new under a collapsed header, visible to hidden elsewhere', FULL, '', `${setHidden(1500, true)}; ${underHeader('Shaman', '{ id = 9997, title = "Also New", level = 20, objectives = {} }')}`],
    ['no quest count from the game', FULL, NOCOUNT, ''],
    ['a quest count far off (99)', FULL, FAROFF, ''],
  ];
  for (const [label, log, extra, change] of cases) {
    for (const pre of ['', ON_SCREEN]) {
      const vm = vmWith(log, { extra });
      vm.advance(4);
      build(vm);
      vm.run(`${change}; STUB.collapsed["Shaman"] = true; ${pre}`);
      const all = truth(vm);
      const s = build(vm).state;
      assert.deepEqual(s.quests.map(q => q.id), all, label);
      assert.deepEqual(['questUnread' in s, 'questUnreadHeaders' in s], [false, false], label);
      assert.match(questLogLine(s), new RegExp(`^Quest log: ${all.length} of ${Math.max(40, all.length)} quests.*, every one listed\\.$`), label);
      assert.equal(vm.num('STUB.headerCalls'), 0, label);
    }
  }
});

test('what a quest is (the game\'s own list, QuestLogQuests_ShouldShowQuestButton, less its collapse and search): not a task row, a bounty only once complete; a row with no quest id yet is told to the model as not listed and still in the log, never dropped unsaid (the breaker\'s r5 task rows)', () => {
  const log = [...FULL.slice(0, 3),
    { id: 8001, title: 'Bonus objective', level: 20, task: true, objectives: [] },
    { id: 8002, title: 'Bounty, not done', level: 20, bounty: true, objectives: [] },
    { id: 8003, title: 'Bounty, done', level: 20, bounty: true, complete: true, objectives: [] },
    ...FULL.slice(3)];
  const s = build(vmWith(log)).state;
  const got = s.quests.map(q => q.id);
  assert.deepEqual(got, [...ids(FULL).slice(0, 2), 8003, ...ids(FULL).slice(2)], 'no task row, no bounty not yet done; the done bounty in its place');
  assert.equal(questLogLine(s), 'Quest log: 41 of 41 quests (the log is full), every one listed.');
  // A quest the game hasn't given an id yet: counted, whatever the game's count.
  const blank = vmWith(FULL, { extra: `${NOHID}
local gi = C_QuestLog.GetInfo
C_QuestLog.GetInfo = function(i) local t = gi(i); if t and t.questID == 1500 then t.questID = nil end; return t end` });
  const b = build(blank).state;
  assert.deepEqual([b.quests.length, b.questUnread, 'questUnreadHeaders' in b], [39, 1, false]);
  const line = 'Quest log: 39 quests listed (max 40), not the whole log: the game listed 1 more without a quest id yet. They\'re still in the log: a quest that isn\'t listed may be one of them.';
  assert.equal(questLogLine(b), line);
  const ctx = blank.evaluate('NS.Chats.GameContext()');
  assert.ok(ctx.split('\n').at(-1).startsWith('Quest log (id, * = ready to turn in): 39 quests listed (max 40), not the whole log (the game listed 1 more without a quest id yet; still in the log): '), ctx.split('\n').at(-1));
  assert.equal(withState(ctx, b).split('\n').at(-1), ctx.split('\n').at(-1), 'the bridge writes the same line from the state');
  assert.match(questFacts(b), /\. 39 active quests listed \(max 40\), not the whole log: the game listed 1 more without a quest id yet, still in the log\. /);
  blank.slash('state');
  assert.match(blank.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), /\nQuest log: 39 quests in the state, not every one \(cap 40, from C_QuestLog\.GetMaxNumQuestsCanAccept\)\. The game listed 1 more without a quest id yet\.\n/);
  blank.run('NS.UI.Toggle(true); NS.UI.RenderContext()');
  assert.match(blank.list('NS.UI.ui.ctx.lines')[0], / · 40 quests · gear$/, 'the window counts every quest NeverQuestAlone gets');
});

test('/nqa apicheck reads the quest log row by row: the quests, the hidden ones and those with no id yet, the game\'s own count (shown only here), and the quests read under collapsed headers', () => {
  const vm = vmWith(FULL);
  vm.advance(4);
  const line = () => { vm.slash('apicheck'); return vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text').split('\n').find(l => l.startsWith('The quest log as read: ')); };
  assert.equal(line(), 'The quest log as read: 40 quests, 1 hidden, 0 with no id yet; the game counts 41; no collapsed header');
  vm.run('STUB.collapsed["Mulgore"] = true; STUB.collapsed["Shaman"] = true');
  assert.equal(line(), 'The quest log as read: 40 quests, 1 hidden, 0 with no id yet; the game counts 41; 4 of them under 2 collapsed headers');
  assert.equal(vm.num('STUB.headerCalls'), 0);
});

// ---------------------------------------------------------------- T4: the byte budget at the cap

test('the byte budget: 40 quests of 60-byte titles and 5 objectives of 60-byte text, in words, random ASCII and CJK, with full gear, 25 quest points, 6 professions and 10 milestones: with z and qlog never too_large, one frame, every quest with its id, ready flag and at least 24 bytes of title', () => {
  for (const kind of ['words', 'random', 'cjk']) {
    const log = worstLog(kind);
    const vm = vmWith(log);
    vm.run(worstOthers(kind));
    const st = build(vm);
    const s = st.state;
    assert.equal(st.tooLarge, null, kind);
    assert.equal(s.quests.length, 40, kind);
    assert.ok(st.packed && st.packed.length <= 3100, `${kind}: ${st.packed?.length} bytes on the strip`);
    const titled = s.omitted.some(k => k.startsWith('quests.title'));
    for (const q of s.quests) {
      assert.ok(Number.isInteger(q.id) && typeof q.complete === 'boolean', `${kind} ${q.id}`);
      assert.ok(typeof q.title === 'string' && Buffer.byteLength(q.title) >= 24, `${kind} ${q.id}: "${q.title}"`);
      const whole = log.find(e => e.id === q.id).title.trim();
      if (q.title !== whole) assert.ok(q.cut === true && titled && whole.startsWith(q.title), `${kind} ${q.id}: shortened only as a prefix, with cut and a title step in omitted`);
      else assert.equal(q.cut, undefined);
    }
    assert.ok(!s.omitted.includes('quests.title'), `${kind}: titles never go altogether`);
    const back = inflateBody(st.packed, { maxBody: STATE_BODY_MAX, maxText: STATE_JSON_MAX });
    assert.equal(back.text, st.json, kind);
    assert.ok(validateState(back.text).ok, kind);
    assert.equal(fillTitles(s, []).state.quests.length, 40, `${kind}: the bridge keeps all 40`);
    if (kind === 'words') assert.deepEqual(s.omitted, ['talents', 'gear', 'poi', 'quests.obj.done', 'quests.obj.text'], 'words: objective counts kept');
    // Professions and milestones go before any title is cut (the breaker's r2 case 3): words and CJK
    // keep every title whole; only random ASCII (which doesn't deflate) cuts them, to 24 bytes.
    if (kind !== 'random') assert.ok(!titled && s.quests.every(q => !q.cut), `${kind}: every title whole`);
    else assert.deepEqual(s.omitted.slice(-3), ['prof', 'pending', 'quests.title.short'], 'random: titles after the extras');
    // Deflate off (transport.deflate false): the JSON as it is, within the body's 3,100 bytes;
    // titles go last, and the bridge puts back the ones it has seen whole.
    const plain = vmWith(log, { caps: ['state', 'evt', 'qlog'] });
    plain.run(worstOthers(kind));
    const p = build(plain);
    assert.equal(p.tooLarge, null, `${kind} plain`);
    assert.ok(Buffer.byteLength(p.json) <= 3100, `${kind} plain: ${Buffer.byteLength(p.json)}`);
    assert.equal(p.state.quests.length, 40, `${kind} plain`);
    assert.ok(p.state.quests.every(q => Number.isInteger(q.id) && typeof q.complete === 'boolean'), `${kind} plain`);
    // A bridge that saw these titles whole in an earlier state (a smaller log) puts every one back.
    const earlier = { v: 1, quests: log.filter(e => !e.header).map(e => ({ id: e.id, title: e.title.trim(), complete: false })) };
    const filled = fillTitles(p.state, fillTitles(earlier, []).cache);
    assert.deepEqual([filled.stillCut.length, filled.state.quests.map(q => q.title)], [0, earlier.quests.map(q => q.title)], `${kind} plain: every title back whole`);
  }
});

test('the byte budget: a bridge without qlog (2,800 bytes of JSON) still gets all 40 quests of a full log, titles last', () => {
  for (const caps of [['state', 'evt'], ['state', 'evt', 'z']]) {
    const s = build(vmWith(FULL, { caps })).state;
    assert.equal(s.quests.length, 40, caps.join(' '));
    assert.ok(Buffer.byteLength(JSON.stringify(s)) <= 2800);
    assert.deepEqual(s.quests.map(q => q.id), ids(FULL));
    assert.equal(s.quests.at(-1).complete, true);
  }
});

test('the byte budget, deflate off (the breaker\'s case b): 40 quests with 10 milestones and 6 professions keep 12-byte titles; professions and milestones wait for the next state, which carries them when there\'s room', () => {
  const vm = vmWith(worstLog('words'), { caps: ['state', 'evt', 'qlog'] });
  vm.run(worstOthers('words'));
  const p = build(vm);
  assert.equal(p.tooLarge, null);
  assert.ok(Buffer.byteLength(p.json) <= 3100, `${Buffer.byteLength(p.json)}`);
  assert.deepEqual(p.state.omitted, ['talents', 'gear', 'poi', 'quests.obj.done', 'quests.obj.text', 'quests.obj', 'quests.level', 'prof', 'pending', 'quests.title.short', 'quests.title.tiny']);
  assert.ok(p.state.quests.every(q => Buffer.byteLength(q.title) === 12 && q.cut === true), 'every title, 12 bytes of it');
  assert.equal('pending' in p.state, false);
  // The milestones weren't in it, so the bridge confirming it doesn't clear them.
  vm.run(`NS.Companion.OnBridge({ stateSeq = ${p.seq}, stateSid = "${SID}", caps = { "state", "evt", "qlog" } })`);
  assert.equal(vm.num('#NS.Companion.CharDB().pending'), 10, 'still waiting');
  // A smaller log: the next states carry them (the fit gets its detail back a step a build).
  vm.run('for i = #STUB.entries, 10, -1 do table.remove(STUB.entries, i) end');
  let s;
  for (let i = 0; i < 10; i++) s = build(vm).state;
  assert.equal(s.pending.length, 10, 'the milestones go now');
  assert.ok(!s.omitted.includes('pending') && !s.omitted.includes('quests.title.tiny'));
  // Only past some 70 quests (no client's log) would even an older bridge's 2,800 bytes need too_large.
  const legacy = vmWith([{ header: 'All' }, ...Array.from({ length: 70 }, (_, i) => ({ id: 20000 + i, title: `Quest ${i}`, level: 30, complete: i % 3 === 0, objectives: [] }))], { caps: ['state', 'evt'], extra: 'STUB.maxQuests = 70' });
  legacy.run(worstOthers('words'));
  const l = build(legacy);
  assert.equal(l.tooLarge, null);
  assert.equal(l.state.quests.length, 70);
  assert.ok(l.state.quests.every(q => Number.isInteger(q.id) && typeof q.complete === 'boolean'));
});

test('the fit starts where the last one ended (QL-F-05): an unchanged state deflates once, not the whole ladder again', () => {
  const vm = vmWith(worstLog('random'));
  vm.run(worstOthers('random'));
  vm.run('NS.deflates = 0; local d = NS.Transport.Deflate; NS.Transport.Deflate = function(...) NS.deflates = NS.deflates + 1; return d(...) end');
  const first = build(vm);
  const fresh = vm.num('NS.deflates');
  vm.run('NS.deflates = 0; STUB.money = STUB.money + 1');
  const again = build(vm);
  assert.deepEqual(again.state.omitted, first.state.omitted, 'the same fit');
  assert.ok(vm.num('NS.deflates') <= 2 && vm.num('NS.deflates') < fresh, `${vm.num('NS.deflates')} deflates, ${fresh} fresh`);
  assert.equal(vm.evaluate('NS.R.fitStep.key'), 'zq');
});

// ---------------------------------------------------------------- T5a: no path cuts quests below the cap

test('no path cuts quests: 60 quests (a log past every cap) go whole through the addon\'s read, its context and the map, and the bridge\'s context from the state and the logbook', () => {
  const log = [{ header: 'Everywhere' }, ...Array.from({ length: 60 }, (_, i) => ({ id: 3000 + i, title: `Sixty quests, number ${i}`, level: 30, complete: i === 59, objectives: [{ text: 'Thing', have: 0, need: 1 }] }))];
  const all = log.slice(1).map(q => q.id);
  const vm = vmWith(log, { extra: 'STUB.maxQuests = 60' });
  assert.deepEqual(quests(vm).map(q => q.id), all, 'P.Quests');
  const ctx = vm.evaluate('NS.Chats.GameContext()');
  assert.deepEqual(ctx.split('\n').at(-1).split(': ').at(-1).split(',').map(x => Number(x.replace('*', ''))), all, 'C.GameContext');
  const lines = vm.list('NS.MapShared.StopLines({ 1412, 50, 50, "Sixty quests, number 59", "turnin" })');
  assert.ok(lines.some(l => l.includes('Sixty quests, number 59')), 'QuestLogTitles');
  const s = build(vm).state;
  assert.deepEqual(s.quests.map(q => q.id), all, 'the state');
  const ws = withState(ctx, s).split('\n').at(-1);
  assert.equal(ws, ctx.split('\n').at(-1), 'withState');
  const facts = questFacts(s);
  assert.equal([...facts.matchAll(/^- (\d+) /gm)].length, 60, 'questFacts');
  assert.match(facts, /\. 60 active quests \(the whole log, max 60\)\. /);
});

test('a log past any client\'s cap (200 quests, 5-digit ids, the breaker\'s r2 d200): the context keeps its Game and Character lines with the whole quest line, so the bridge still gives the turn its game context', () => {
  const log = [{ header: 'Everywhere' }, ...Array.from({ length: 200 }, (_, i) => ({ id: 20000 + i, title: `Quest ${i}`, level: 30, complete: i % 5 === 0, objectives: [] }))];
  const vm = vmWith(log, { extra: 'STUB.maxQuests = 200' });
  const ctx = vm.evaluate('NS.Chats.GameContext()');
  const lines = ctx.split('\n');
  assert.match(lines[0], /^Game: World of Warcraft/);
  assert.match(lines[1], /^Character: Tavi on Testrealm/);
  assert.equal(lines.at(-1).split(': ').at(-1).split(',').length, 200, 'every id');
  assert.ok(lines.at(-1).endsWith(',20195*,20196,20197,20198,20199'));
  const f = parseContextLines(withState(ctx, build(vm).state));
  assert.ok(f.game && f.character, 'the lines the bridge needs to send a game context');
  assert.ok(f.quests.startsWith('200 of 200 quests, all listed: 20000*,'), f.quests);
});

test('staleContext: a stored context\'s "all listed" is marked as of an earlier read; a line that isn\'t whole, and the other lines, stay', () => {
  const ctx = 'Game: World of Warcraft\nCharacter: Tavi on Testrealm, level 20\nQuest log (id, * = ready to turn in): 40 of 40 quests, all listed: 1488,1527*';
  assert.equal(staleContext(ctx), ctx.replace(', all listed:', ', all listed as of an earlier read (a quest picked up since may not be on it):'));
  const notWhole = 'Quest log (id, * = ready to turn in): 39 quests listed (max 40), not the whole log (the game listed 1 more without a quest id yet; still in the log): 1488';
  assert.equal(staleContext(notWhole), notWhole);
  assert.equal(staleContext('Money: 1g 0s 0c'), 'Money: 1g 0s 0c');
});
