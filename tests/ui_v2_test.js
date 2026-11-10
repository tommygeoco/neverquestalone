'use strict';
// NeverQuestAlone UI v2 (the UI review of 2026-09-25, in the owner's notes):
// the window's quick fixes (landing on a reply, notices, event cards, rows,
// the box's commands and recall, text size, toasts), one-click replies and
// game links, the context bar, the HUD, quick asks, the game's own waypoint,
// /nqa roll, tooltip verdicts, settings, and the ways in from the game's UI.
// Same VM as tests/nqa_addon_test.js: the real addon in fengari on the stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM, reloadVM, lstr, ADDON } = require('./helpers/nqa-vm');
const { byokSlot, provider } = require('./helpers/byok-slots');
// The addon's version, from Store.lua (the TOC's is checked against it in nqa_addon_test.js).
const VERSION = require('node:fs').readFileSync(require('node:path').join(ADDON, 'Store.lua'), 'utf8').match(/ns\.VERSION = "([^"]+)"/)[1];
const VERSION_RE = VERSION.replace(/\./g, '\\.');

// ---------------------------------------------------------------- helpers (as in nqa_addon_test.js)
function ring(vm, bell = null) {
  if (!bell) bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false);
  vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true);
  vm.run('NS.Transport.Poll()');
  return vm;
}
function slotLua({ push = 0, nonce = null, acked = [], records = [], chats = '{}', extra = '', bridgeExtra = '' } = {}) {
  return `{ v = 2, ts = "2026-09-25T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.3.0", push = ${push}, nonce = ${nonce ? `"${nonce}"` : 'nil'}, acked = { ${acked.map(k => `"${k}"`).join(', ')} }${bridgeExtra} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = ${chats}, records = { ${records.join(', ')} }${extra} }`;
}
function confirmHello(vm) {
  vm.advance(3.1);
  vm.slot(slotLua({ nonce: vm.evaluate('NS.R.nonce'), push: 0 }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}
const apply = (vm, slot) => vm.run(`NS.Transport.HandleSlotData(${slot}, "slot")`);
function replyRec(seq, chat, text, extra = '') {
  return `{ seq = ${seq}, t = "reply", chat = "${chat}", mid = "m-${seq}", agent = "main", text = ${lstr(text)}, summary = "", more = 0${extra} }`;
}
function errorRec(seq, chat, kind, action, text) {
  return `{ seq = ${seq}, t = "error", chat = "${chat}", kind = "${kind}"${action ? `, action = "${action}"` : ''}, text = ${lstr(text)} }`;
}
const activeId = vm => vm.evaluate('NQADB.activeChat');
const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
const lastWire = vm => { const o = vm.outboxWires(); return o.length ? o[o.length - 1].wire : null; };
const sentText = (vm, t) => vm.outboxWires().some(e => e.wire.endsWith('\x1f' + t) || e.wire.includes('\x1d' + t));
const type = (vm, text) => vm.run(`NS.UI.ui.input:SetText(${lstr(text)}); NS.UI.SendFromInput()`);

// Text taller than 200 characters is 600 units high; SetFont records its size.
const TALL = `
local mt = getmetatable(UIParent)
local idx = mt.__index
mt.__index = function(t, k)
	if k == "GetStringHeight" then return function(self) return #(tostring(rawget(self, "text") or "")) > 200 and 600 or 14 end end
	if k == "SetFont" then return function(self, file, size) rawset(self, "fontSize", size) end end
	return idx(t, k)
end
`;

// The world map, a zone (Loch Modan 1432 on Eastern Kingdoms 1415) and a quest log (as the navigator tests).
const MAP_STUB = `
Enum = Enum or {}
Enum.UIMapType = { Continent = 2, Zone = 3 }
local MAPS = { [1432] = { name = "Loch Modan", mapType = 3, parentMapID = 1415 }, [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 }, [947] = { name = "Azeroth", mapType = 1, parentMapID = 0 } }
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { name = m.name, mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
C_Map.GetBestMapForUnit = function() return 1432 end
C_Map.GetMapRectOnMap = function(child, parent) if child == 1432 and parent == 1415 then return 0.5, 0.6, 0.4, 0.5 end end
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1415 then return 0, { x = v.x * 10000, y = v.y * 15000 } end end
function GetPlayerFacing() return 0 end
local canvas = CreateFrame("Frame", "WorldMapCanvas")
canvas.width, canvas.height = 1000, 700
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
function WorldMapFrame:GetCanvas() return canvas end
function WorldMapFrame:GetMapID() return 1432 end
function WorldMapFrame:GetCanvasScale() return 1 end
function WorldMapFrame:OnMapChanged() end
function WorldMapFrame:AddCanvasClickHandler(fn, priority) STUB.mapClick, STUB.mapClickPriority = fn, priority end
STUB.posX, STUB.posY = 0.5, 0.4
STUB.log = {
	{ id = 761, title = "The Hunt Continues", complete = false, objectives = { { text = "Prairie Wolf Paw: 3/8", finished = false } } },
	{ id = 766, title = "Swoop Hunting", complete = true, objectives = { { text = "Trophy Swoop Quill: 8/8", finished = true } } },
}
STUB.done = {}
local function Q(id) for _, q in ipairs(STUB.log) do if q.id == id then return q end end end
C_QuestLog = {
	GetNumQuestLogEntries = function() return #STUB.log end,
	GetInfo = function(i) local q = STUB.log[i]; if q then return { title = q.title, questID = q.id, isHeader = false } end end,
	IsOnQuest = function(id) return Q(id) ~= nil end,
	IsComplete = function(id) local q = Q(id); return q ~= nil and q.complete end,
	ReadyForTurnIn = function(id) local q = Q(id); return q ~= nil and q.complete end,
	IsQuestFlaggedCompleted = function(id) return STUB.done[id] == true end,
	GetTitleForQuestID = function(id) local q = Q(id); return q and q.title end,
	GetQuestObjectives = function(id) local q = Q(id); return q and q.objectives or {} end,
	GetQuestsOnMap = function(mapID) return STUB.onMap or {} end,
}
-- The game's own waypoint (Forever's C_Map and C_SuperTrack, and the UiMapPoint mixin).
UiMapPoint = { CreateFromCoordinates = function(mapID, x, y) return { uiMapID = mapID, position = { x = x, y = y } } end }
STUB.waypoints, STUB.superTrack, STUB.cleared = {}, {}, 0
C_Map.CanSetUserWaypointOnMap = function(id) return STUB.noWaypointMap ~= id end
C_Map.SetUserWaypoint = function(p) table.insert(STUB.waypoints, p); STUB.userWaypoint = p; return true end
C_Map.GetUserWaypoint = function() return STUB.userWaypoint end
C_Map.ClearUserWaypoint = function() STUB.userWaypoint = nil; STUB.cleared = STUB.cleared + 1 end
C_SuperTrack = { SetSuperTrackedUserWaypoint = function(on) table.insert(STUB.superTrack, on) end }
`;
const ROUTE = `, map = { epoch = "e1", version = 1, layers = { { name = "mulgore", title = "Mulgore quests", ordered = true, loop = false, points = {
  { 1432, 56, 40, "2. Wolves and plainstriders", "kill", "Kill 8 Prairie Wolves and 6 Plainstriders; loot 8 Prairie Wolf Paws.", { 761 } },
  { 1432, 50, 34, "3. Harken: Swoop Hunting", "turnin", "", { 766 } },
  { 1432, 80, 60, "4. Far stop", "flight" } } } } }`;

// ---------------------------------------------------------------- the window

test('landing: a reply taller than the pane opens at its first line; reading further up, a new reply leaves you there with a pill', () => {
  const vm = confirmHello(newVM({ extra: TALL }).login());
  vm.slash('');
  const id = activeId(vm);
  // A pane 200 units tall whose scroll range follows the content.
  vm.run('local sf = NS.UI.ui.scroll; sf.height = 200; sf.GetVerticalScrollRange = function() return math.max(0, NS.UI.ui.content.height - 200) end');
  type(vm, 'plan my evening');
  apply(vm, slotLua({ records: [replyRec(1, id, 'Short answer.')] }));
  vm.advance(0);
  apply(vm, slotLua({ records: [replyRec(2, id, 'A long plan. '.repeat(30))] }));
  vm.advance(0);
  const top = vm.num('NS.UI.ui.newestTop');
  assert.ok(vm.num('NS.UI.ui.newestHeight') > 200, 'the reply is taller than the pane');
  assert.equal(vm.num('NS.UI.ui.scroll:GetVerticalScroll()'), top - 4, 'it opens at its first line, not its TL;DR');
  assert.ok(vm.num('NS.UI.ui.scroll:GetVerticalScrollRange()') > top - 4);
  // Reading further up: an ack or a new reply doesn't move you, and the pill says so.
  vm.run('NS.UI.ui.scroll:SetVerticalScroll(0)');
  apply(vm, slotLua({ records: [replyRec(3, id, 'And one more thing.')] }));
  vm.advance(0);
  assert.equal(vm.num('NS.UI.ui.scroll:GetVerticalScroll()'), 0, 'still where you were reading');
  assert.equal(vm.evaluate('NS.UI.ui.newPill.shown'), 'true');
  vm.run('local p = NS.UI.ui.newPill; p.scripts.OnClick(p)');
  vm.advance(0);
  assert.equal(vm.evaluate('NS.UI.ui.newPill.shown'), 'false');
  assert.ok(vm.num('NS.UI.ui.scroll:GetVerticalScroll()') > 0, 'the pill takes you down to it');
  // What you send always shows.
  vm.run('NS.UI.ui.scroll:SetVerticalScroll(0)');
  type(vm, 'thanks');
  vm.advance(0);
  assert.ok(vm.num('NS.UI.ui.scroll:GetVerticalScroll()') > 0);
});

test('notices: a command\'s answer shows once at the end of the chat, is never saved, and goes with its X or the next one', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const before = vm.history().length;
  vm.slash('help all');
  assert.match(notice(vm), /\/nqa new \[name\]/);
  assert.equal(vm.history().length, before, 'not in the conversation');
  assert.equal(vm.evaluate('NS.UI.ui.notice.shown'), 'true');
  assert.equal(vm.evaluate('NS.UI.ui.notice.who.text'), 'NeverQuestAlone');
  assert.doesNotMatch(vm.saved(), /nqa new \[name\]/, 'not in the saved data');
  vm.slash('slots');
  assert.match(notice(vm), /parts are free this session/, 'the next one replaces it');
  vm.run('local c = NS.UI.ui.notice.close; c.scripts.OnClick(c)');
  assert.equal(notice(vm), null);
  assert.equal(vm.evaluate('NS.UI.ui.notice.shown'), 'false');
  // A settings switch typed with the window closed answers in the chat frame instead.
  vm.slash('');
  vm.run('STUB.chat = {}');
  vm.slash('text large');
  assert.equal(vm.evaluate('NQADB.settings.textSize'), 'large');
  assert.ok(vm.chatLines().some(l => l.includes('Chat Text Size: Large. Settings has it too.')));
});

test('events look like events: their icon, "Sent by the game", the summary in gold', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  vm.run('NS.Chats.AddHistory(NS.Chats.Active(), { role = "user", event = "level_up", text = "Level up: 9 → 10", key = "k1" }); NS.Refresh()');
  const b = 'NS.UI.ui.bubbles[1]';
  assert.equal(vm.evaluate(`${b}.icon.shown`), 'true');
  assert.equal(vm.evaluate(`${b}.icon.texture`), 'Interface\\Icons\\Spell_ChargePositive');
  assert.equal(vm.evaluate(`${b}.who.text`), 'Sent by the game');
  assert.deepEqual(vm.json(`${b}.body.textColor`), [1, 0.82, 0]);
  vm.run('NS.Chats.AddHistory(NS.Chats.Active(), { role = "assistant", text = "Train at Narm." }); NS.Refresh()');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[2].icon.shown'), 'false', 'only events carry an icon');
});

test('rows: two lines (the newest line and its age), delete only under the mouse, the most recent chat first', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const first = activeId(vm);
  type(vm, 'hi there');
  vm.slash('new Later');
  vm.advance(120);
  apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${first}", mid = "m1", agent = "main", text = "Hello!", summary = "Hello back.", more = 0 }`] }));
  vm.run('NS.UI.RenderList()');
  assert.equal(vm.evaluate('NQADB.chats[1].id'), first, 'a reply moves its chat to the top');
  assert.equal(vm.evaluate('NS.UI.ui.rows[1].preview.text'), 'NeverQuestAlone: Hello back.');
  assert.equal(vm.evaluate('NS.UI.ui.rows[1].age.text'), 'now');
  assert.equal(vm.evaluate('NS.UI.ui.rows[2].preview.text'), '', 'a new chat has nothing to preview');
  assert.equal(vm.evaluate('NS.UI.ui.rows[1].del.shown'), 'false');
  vm.run('local r = NS.UI.ui.rows[1]; r.scripts.OnEnter(r)');
  assert.equal(vm.evaluate('NS.UI.ui.rows[1].del.shown'), 'true');
  vm.run('local r = NS.UI.ui.rows[1]; r.scripts.OnLeave(r)');
  assert.equal(vm.evaluate('NS.UI.ui.rows[1].del.shown'), 'false');
  assert.equal(vm.evaluate('NS.UI.Age(time() - 7200)'), '2 h');
  assert.equal(vm.evaluate('NS.UI.Age(time() - 3 * 86400)'), '3 days');
  assert.equal(vm.evaluate('NS.UI.Age(time() - 86400)'), '1 day');
  // A message's time as the game's own clock shows it (STYLE §8): 24-hour unless its 12-hour setting is on.
  vm.run('date = function(fmt) if fmt == "*t" then return { hour = 17, min = 7 } end return "17:07" end');
  assert.equal(vm.evaluate('NS.ClockText(time())'), '17:07', '24-hour when the game says nothing');
  vm.run('STUB.cvars.timeMgrUseMilitaryTime = "0"');
  assert.equal(vm.evaluate('NS.ClockText(time())'), '5:07 PM', 'the game\'s 12-hour clock');
  vm.run('STUB.cvars.timeMgrUseMilitaryTime = "1"');
  assert.equal(vm.evaluate('NS.ClockText(time())'), '17:07');
});

test('the list (the owner, 2026-09-27: "better alignment. not so crammed"; "left middle vertically aligned"): New Chat and the words 10 from both edges; no foot, the rows to 8 from the bottom; a row\'s lines centred; every name starts at the same place, a pin at its line\'s right; the scroll bar\'s room only while the chats don\'t fit; the chat\'s name in the middle of its band', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const first = activeId(vm);
  type(vm, 'hi there');
  vm.slash('new Later');
  vm.slash('pin Later');
  apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${first}", mid = "m1", agent = "main", text = "Hello!", summary = "Hello back.", more = 0 }`] }));
  vm.run('NS.UI.SetListShown(true); NS.UI.RenderList()');
  // New Chat never scrolls: the list's width, 10 in from both edges. No foot (the app keeps the
  // addon up to date: no version line, no update button): the rows reach 8 from the list's bottom.
  assert.deepEqual(vm.json('{ NQANewChat.width, NQANewChat.points.TOPLEFT.x, NQANewChat.points.TOPLEFT.y }'), [200, 10, -10]);
  assert.equal(vm.evaluate('NQAUpdateButton'), null);
  assert.equal(vm.evaluate('NS.UI.ui.version'), null);
  // The rows 4 in, their words 6 further: 10, as the buttons; while the chats fit, to 10 from the right edge too.
  assert.deepEqual(vm.json('{ NQAChatScroll.points.TOPLEFT.x, NQAChatScroll.points.BOTTOMRIGHT.x, NQAChatScroll.points.BOTTOMRIGHT.y, NS.UI.ui.rows[1].width }'), [4, -4, 8, 212]);
  // Pinned Later first: no history, its name alone in the middle of the row; the pin at the right of its line.
  assert.equal(vm.evaluate('NS.UI.ui.rows[1].label.text'), 'Later');
  assert.deepEqual(vm.json('{ NS.UI.ui.rows[1].label.points.LEFT.x, NS.UI.ui.rows[1].label.points.LEFT.y, NS.UI.ui.rows[1].pin.shown, NS.UI.ui.rows[1].pin.points.RIGHT.x, NS.UI.ui.rows[1].pin.points.RIGHT.y }'),
    [6, -26, true, -6, -26]);
  // Then the chat with a reply: its two lines centred as a block, 10 over and under them, 4 between.
  assert.equal(vm.evaluate('NS.UI.ui.rows[2].preview.text'), 'NeverQuestAlone: Hello back.');
  assert.deepEqual(vm.json('{ NS.UI.ui.rows[2].label.points.LEFT.x, NS.UI.ui.rows[2].label.points.LEFT.y, NS.UI.ui.rows[2].preview.points.LEFT.x, NS.UI.ui.rows[2].preview.points.LEFT.y, NS.UI.ui.rows[2].age.points.RIGHT.y }'),
    [6, -17, 6, -35, -35], 'names, and the lines under them, start at the same place in every row');
  assert.equal(vm.evaluate('NS.UI.ui.rows[2].pin.shown'), 'false');
  // A pin before "2 new"; the delete button on the name's line, and the pin gives way to it under the mouse.
  vm.run('NS.Chats.Find(NS.UI.ui.rows[1].chatId).unread = 2; NS.UI.RenderList()');
  assert.deepEqual(vm.json('{ NS.UI.ui.rows[1].pin.points.RIGHT.rel == NS.UI.ui.rows[1].badge, NS.UI.ui.rows[1].label.points.RIGHT.rel == NS.UI.ui.rows[1].pin }'), [true, true]);
  vm.run('local r = NS.UI.ui.rows[1]; r.scripts.OnEnter(r)');
  assert.deepEqual(vm.json('{ NS.UI.ui.rows[1].del.shown, NS.UI.ui.rows[1].del.points.RIGHT.y, NS.UI.ui.rows[1].pin.alpha, NS.UI.ui.rows[1].badge.alpha }'), [true, -26, 0, 0]);
  vm.run('local r = NS.UI.ui.rows[1]; r.scripts.OnLeave(r)');
  assert.deepEqual(vm.json('{ NS.UI.ui.rows[1].pin.alpha, NS.UI.ui.rows[1].badge.alpha }'), [1, 1]);
  // More chats than fit: the bar's room comes back, and goes again when they fit.
  const range = y => vm.run(`local sf = NQAChatScroll; for _, fn in ipairs(sf.hooks.OnScrollRangeChanged) do fn(sf, 0, ${y}) end`);
  range(120);
  assert.deepEqual(vm.json('{ NQAChatScroll.points.BOTTOMRIGHT.x, NQAChatScroll.points.BOTTOMRIGHT.y, NS.UI.ui.rows[1].width, NS.UI.ui.listContent.width, NQANewChat.width }'), [-26, 8, 190, 190, 200], 'the buttons keep the list\'s width');
  range(0);
  assert.deepEqual(vm.json('{ NQAChatScroll.points.BOTTOMRIGHT.x, NQAChatScroll.points.BOTTOMRIGHT.y, NS.UI.ui.rows[1].width }'), [-4, 8, 212]);
  assert.equal(vm.evaluate('NQAChatScroll.scrollBarHideable'), 'true', 'the game\'s own scroll frame hides its bar when nothing scrolls');
  // The chat's name in the middle of the band over the panes; with a status line, the two together.
  vm.run('NS.Refresh("all")');
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), '');
  assert.equal(vm.num('NQALight.points.TOPLEFT.y'), -36);
  vm.run('NS.UI.StatusText = function() return "Waiting for a reload to send" end; NS.Refresh("all")');
  assert.deepEqual(vm.json('{ NQALight.points.TOPLEFT.y, NS.UI.ui.headerRight.points.TOPRIGHT.y }'), [-29, -29]);
});

test('the chat list\'s scroll bar (the owner, 0.5.0: "the chat session scrollbar covers up the other UI elements"): hidden beside a short list, though the template\'s OnLoad showed it and the range never changed; shown only while the chats don\'t fit, inside the list', () => {
  // As the game builds UIPanelScrollFrameTemplate: its ScrollBar child, shown by
  // ScrollFrame_OnLoad before the addon can set scrollBarHideable.
  const BAR = `local cf = CreateFrame
CreateFrame = function(kind, name, parent, template)
  local f = cf(kind, name, parent, template)
  if type(template) == "string" and template:find("UIPanelScrollFrameTemplate") then
    f.ScrollBar = cf("Slider", name and (name .. "ScrollBar") or nil, f)
    f.ScrollBar.shown = true
  end
  return f
end`;
  const vm = confirmHello(newVM({ extra: BAR }).login());
  vm.slash('');
  assert.equal(vm.evaluate('NQAChatScroll.ScrollBar ~= nil'), 'true');
  assert.equal(vm.evaluate('NQAChatScroll.ScrollBar.shown'), 'false', 'the chats fit: no bar hanging over the conversation');
  const range = y => vm.run(`local sf = NQAChatScroll; for _, fn in ipairs(sf.hooks.OnScrollRangeChanged) do fn(sf, 0, ${y}) end`);
  range(120);
  assert.equal(vm.evaluate('NQAChatScroll.ScrollBar.shown'), 'true', 'more chats than fit: the bar');
  assert.equal(vm.num('NQAChatScroll.points.BOTTOMRIGHT.x'), -26, 'inside the list: the frame gives the bar its room');
  range(0);
  assert.equal(vm.evaluate('NQAChatScroll.ScrollBar.shown'), 'false', 'and it goes again when they fit');
  // The other scroll frames keep the game's own handling.
  assert.equal(vm.evaluate('NQAInputScroll.ScrollBar.shown'), 'true');
});

test('the box: a leading / runs a command (and says so when it isn\'t one), Up and Down recall what you sent', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  type(vm, '/echo full');
  assert.equal(vm.evaluate('NQADB.settings.echo'), 'full');
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '', 'the box is cleared');
  type(vm, '/new Plans');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Plans');
  type(vm, '/dance with me');
  assert.match(notice(vm), /^Not a command: \/dance\./);
  assert.equal(vm.outboxWires().length, 0, 'nothing went to NeverQuestAlone');
  type(vm, '/nqa where is the forge');
  assert.ok(sentText(vm, 'where is the forge'), '/nqa <words> sends the words');
  type(vm, 'second thing');
  const arrow = key => vm.run(`local i = NS.UI.ui.input; i.scripts.OnArrowPressed(i, "${key}")`);
  const box = () => vm.evaluate('NS.UI.ui.input:GetText()');
  arrow('UP');
  assert.equal(box(), 'second thing');
  arrow('UP');
  assert.equal(box(), 'where is the forge');
  arrow('UP');
  assert.equal(box(), 'where is the forge', 'the oldest stays');
  arrow('DOWN');
  assert.equal(box(), 'second thing');
  arrow('DOWN');
  assert.equal(box(), '');
  vm.run('NS.UI.ui.input:SetText("typing")');
  arrow('UP');
  assert.equal(box(), 'typing', 'text you typed is never replaced');
});

test('a window saved narrow opens wide enough for the chat list; the Delete confirm says Delete', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = { settings = { width = 560, height = 500, listShown = true } }' }).login());
  vm.run('NS.UI.Toggle(true)');
  assert.equal(vm.num('NQADB.settings.width'), 400 + 226, 'saved: the narrowest the conversation goes, and the list');
  assert.equal(vm.num('NS.UI.ui.frame:GetWidth()'), 400 + 226, 'drawn');
  assert.equal(vm.evaluate('StaticPopupDialogs.NQA_DELETE.button1'), 'Delete');
});

test('with no replies left the HUD says what waits, not "hover me"', () => {
  const vm = newVM({ db: 'NQADB = { settings = { hud = true } }', extra: 'for i = 1, 200 do STUB.loaded[string.format("NQA_S%03d", i)] = true end' }).login();
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Reload to keep going');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Messages and replies wait until you do.');
});

test('copy says Cmd+C on a Mac, Ctrl+C elsewhere; text size follows /nqa text', () => {
  const mac = confirmHello(newVM().login());
  mac.run('NS.UI.ShowCopy("x")');
  assert.ok(mac.list('STUB.texts').some(t => t === 'Press Cmd+C to Copy'));
  const pc = confirmHello(newVM({ extra: 'function IsMacClient() return false end' }).login());
  pc.run('NS.UI.ShowCopy("x")');
  assert.ok(pc.list('STUB.texts').some(t => t === 'Press Ctrl+C to Copy'));
  const sized = confirmHello(newVM({ extra: TALL + 'ChatFontNormal = { GetFont = function() return "Fonts\\\\ARIALN.TTF", 14, "" end }' }).login());
  sized.slash('');
  const id = activeId(sized);
  apply(sized, slotLua({ records: [replyRec(1, id, 'Hi.')] }));
  assert.equal(sized.num('NS.UI.ui.bubbles[1].body.fontSize'), 14);
  sized.slash('text large');
  assert.equal(sized.num('NS.UI.ui.bubbles[1].body.fontSize'), 17);
  assert.equal(sized.num('NS.UI.ui.input.fontSize'), 17, 'the box you type in too');
  sized.slash('text small');
  assert.equal(sized.num('NS.UI.ui.bubbles[1].body.fontSize'), 12);
});

test('toasts only while the HUD doesn\'t show news: one banner at the top middle (the owner: "so the user sees it"), 4 under the game\'s top-centre widgets as its Return to Graveyard button hangs, clear of the breath bar, the error line and the zone\'s name; in the HUD\'s type; until Okay or Open Chat; clicks going through it but for its buttons, with an icon; errors in red', () => {
  const vm = confirmHello(newVM({ extra: 'UIWidgetTopCenterContainerFrame = CreateFrame("Frame", "UIWidgetTopCenterContainerFrame")' }).login());
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Done.')] }));
  assert.equal(vm.evaluate('NQAToast1'), null, 'with the HUD on, the HUD shows it: one place');
  vm.slash('hud off');
  apply(vm, slotLua({ records: [replyRec(2, id, 'Done again.')] }));
  assert.deepEqual(vm.json('{ NS.UI.ui.toastOrder[1].anchor.point, NS.UI.ui.toastOrder[1].anchor.rel == UIWidgetTopCenterContainerFrame, NS.UI.ui.toastOrder[1].anchor.relPoint, NS.UI.ui.toastOrder[1].points.TOP.y, NS.UI.ui.toastOrder[1].width }'),
    ['TOP', true, 'BOTTOM', -4, 512], 'it moves down with battleground widgets instead of covering them (C-94)');
  // The HUD's type (C-95): his words 13 and white, on up to two lines; the name a gold label.
  assert.deepEqual(vm.json('{ NS.UI.ui.toastOrder[1].line.font == NS.HUD.Font("P"), NS.UI.ui.toastOrder[1].line.maxLines, NS.UI.ui.toastOrder[1].line.wordWrap, NS.UI.ui.toastOrder[1].title.font == NS.HUD.Font("L") }'),
    [true, 2, true, true], 'the fonts the HUD\'s news uses');
  // Its buttons' tooltips are the HUD's (C-96).
  vm.run('local o = NS.UI.ui.toastOrder[1].okay; o.scripts.OnEnter(o)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Okay');
  vm.run('local o = NS.UI.ui.toastOrder[1].open; o.scripts.OnEnter(o)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Open Chat');
  assert.deepEqual(vm.json('{ NS.UI.ui.toastOrder[1].okay.shown, NS.UI.ui.toastOrder[1].open.shown, NS.UI.ui.toastOrder[1].okay.anchor.rel == NS.UI.ui.toastOrder[1].open }'), [true, true, true], 'Okay, then Open');
  assert.equal(vm.evaluate('NS.UI.ui.toastOrder[1].mouse'), 'false', 'a click on it reaches the world');
  apply(vm, slotLua({ records: [`{ seq = 3, t = "error", chat = "${id}", kind = "gateway", text = "The service is restarting." }`] }));
  assert.deepEqual([vm.num('#NS.UI.ui.toastOrder'), vm.evaluate('NS.UI.ui.toastOrder[1].line.text')], [1, 'The service is restarting.'], 'one banner: the newest takes its place');
  assert.equal(vm.evaluate('NS.UI.ui.toastOrder[1].icon.texture'), 'Interface\\DialogFrame\\UI-Dialog-Icon-AlertNew');
  assert.deepEqual(vm.json('NS.UI.ui.toastOrder[1].title.textColor'), [1, 0.44, 0.44]);
  vm.run('local o = NS.UI.ui.toastOrder[1].open; o.scripts.OnClick(o)');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true', 'its Open opens the chat');
  // A banner whose chat you open some other way goes too: it's read.
  vm.run('NS.UI.Toggle(false)');
  apply(vm, slotLua({ records: [replyRec(4, id, 'And one more.')] }));
  assert.equal(vm.num('#NS.UI.ui.toastOrder'), 1);
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  assert.equal(vm.num('#NS.UI.ui.toastOrder'), 0);
  // His words have their own width (298: 46 in, 168 clear of the buttons, room for "Follow"), so a long reply measures two lines
  // and the banner is as tall as they are, however early it's measured (C-97).
  vm.run('NS.UI.Toggle(false); STUB.metrics = true');
  apply(vm, slotLua({ records: [replyRec(5, id, 'The Thornweavers camp on the ridge north of the Fold; pull them one at a time, since they cast from range and flee at low health.')] }));
  assert.deepEqual(vm.json('{ NS.UI.ui.toastOrder[1].line.width, NS.UI.ui.toastOrder[1].title.width }'), [298, 298]);
  assert.ok(vm.num('NS.UI.ui.toastOrder[1].line:GetStringHeight()') > 20, 'two lines');
  assert.equal(vm.num('NS.UI.ui.toastOrder[1].height'), Math.ceil(8 + vm.num('NS.UI.ui.toastOrder[1].title:GetStringHeight()') + 4 + vm.num('NS.UI.ui.toastOrder[1].line:GetStringHeight()') + 8));
  assert.ok(vm.num('NS.UI.ui.toastOrder[1].height') >= 60, 'about 66 tall');
  vm.run('STUB.metrics = false');
});

test('rows: moving from a row onto its delete button keeps the button, and leaving both hides it; the menu closes once the mouse is away from it and its row', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  vm.run('NS.UI.RenderList(); local r = NS.UI.ui.rows[1]; r.scripts.OnEnter(r)');
  const del = () => vm.evaluate('NS.UI.ui.rows[1].del.shown');
  // The row's OnLeave fires as the mouse reaches the button (the client's IsMouseOver says where it is).
  vm.run('local r = NS.UI.ui.rows[1]; r.del.IsMouseOver = function() return true end; r.scripts.OnLeave(r)');
  assert.equal(del(), 'true');
  vm.run('local r = NS.UI.ui.rows[1]; r.IsMouseOver = function() return true end; r.del.IsMouseOver = function() return false end; r.del.scripts.OnLeave(r.del)');
  assert.equal(del(), 'true', 'back on the row');
  vm.run('local r = NS.UI.ui.rows[1]; r.IsMouseOver = function() return false end; r.del.scripts.OnLeave(r.del)');
  assert.equal(del(), 'false', 'away from both');
  vm.run('NS.UI.ChatMenu(NQADB.chats[1].id, NS.UI.ui.rows[1])');
  vm.run('local m = NQAChatMenu; m.IsMouseOver = function() return true end; m.scripts.OnUpdate(m, 2)');
  assert.equal(vm.evaluate('NQAChatMenu.shown'), 'true', 'still under the mouse');
  vm.run('local m = NQAChatMenu; m.IsMouseOver = function() return false end; m.scripts.OnUpdate(m, 0.3)');
  assert.equal(vm.evaluate('NQAChatMenu.shown'), 'true', 'a moment away is forgiven');
  vm.run('local m = NQAChatMenu; m.scripts.OnUpdate(m, 0.3)');
  assert.equal(vm.evaluate('NQAChatMenu.shown'), 'false');
});

test('rows: the preview shows what was said, pipes and all, and never draws a colour code or a link; your linked items show by name', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const id = activeId(vm);
  const preview = () => { vm.run('NS.UI.RenderList()'); return vm.evaluate('NS.UI.ui.rows[1].preview.text'); };
  type(vm, 'is |cffff0000this|r red?');
  assert.equal(preview(), 'You: is ||cffff0000this||r red?');
  apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id}", mid = "m1", agent = "main", text = "x", summary = "Type ||cffff0000 like this||r, not |cffff0000this|r.", more = 0 }`] }));
  assert.equal(preview(), 'NeverQuestAlone: Type ||cffff0000 like this||r, not this.', 'his escaped pipes show as pipes; the bridge\'s colours go');
  vm.run('NS.Chats.AddHistory(NS.Chats.Active(), { role = "user", event = "zone_first", text = "First visit: |Hx|hThe Barrens|h", key = "k9" })');
  assert.equal(preview(), 'First visit: ||Hx||hThe Barrens||h');
  vm.run('NS.Chats.AddHistory(NS.Chats.Active(), { role = "user", text = "Is this good? [Band of Ash]\\n\\n--- Linked from the game ---\\n[Band of Ash] item 111", key = "k10" })');
  assert.equal(preview(), 'You: Is this good? [Band of Ash]', 'not the tooltips that went with it');
});

test('landing: reading further up in a full chat (past the 100 bubbles drawn and the 200 entries kept), a new reply keeps the line you were on', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const id = activeId(vm);
  vm.run('local sf = NS.UI.ui.scroll; sf.height = 200; sf.GetVerticalScrollRange = function() return math.max(0, NS.UI.ui.content.height - 200) end');
  vm.run('local c = NS.Chats.Active(); for i = 1, 200 do NS.Chats.AddHistory(c, { role = i % 2 == 0 and "assistant" or "user", text = "Line " .. i }) end; NS.Refresh("all")');
  vm.advance(0);
  assert.equal(vm.num('#NS.Chats.Active().history'), 200);
  vm.run('local e = NS.Chats.Active().history[150]; NS.UI.ui.scroll:SetVerticalScroll(NS.UI.ui.entryTops[e] + 5)');
  const before = vm.num('NS.UI.ui.scroll:GetVerticalScroll()');
  apply(vm, slotLua({ records: [replyRec(1, id, 'A new reply.')] }));
  vm.advance(0);
  const e150 = 'NS.Chats.Active().history[149]';
  assert.equal(vm.evaluate(`${e150}.text`), 'Line 150', 'the oldest entry fell out');
  const now = vm.num('NS.UI.ui.scroll:GetVerticalScroll()');
  assert.notEqual(now, before, 'everything above it moved up a bubble');
  assert.equal(now, vm.num(`NS.UI.ui.entryTops[${e150}]`) + 5, 'the same line stays at the top of the pane');
  assert.equal(vm.evaluate('NS.UI.ui.newPill.shown'), 'true');
  // The window lands on the newest and a reply comes in the same frame: it follows the landing.
  vm.run('NS.UI.ui.scroll:SetVerticalScroll(0); NS.Refresh("all")');
  apply(vm, slotLua({ records: [replyRec(2, id, 'Another.')] }));
  vm.advance(0);
  assert.equal(vm.num('NS.UI.ui.scroll:GetVerticalScroll()'), vm.num('NS.UI.ui.scroll:GetVerticalScrollRange()'));
  assert.equal(vm.evaluate('NS.UI.ui.newPill.shown'), 'false');
});

test('/nqa chat numbers are the ones the last list showed, although a reply has since moved that chat up', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const first = activeId(vm);
  vm.slash('new Beta');
  vm.slash('new Gamma');
  vm.slash('chat');
  assert.match(notice(vm), /\n1\. Gamma  \(current\)\n2\. Beta\n3\. Chat 1$/);
  vm.advance(60);
  apply(vm, slotLua({ records: [replyRec(1, first, 'Hi.')] }));
  assert.equal(vm.evaluate('NQADB.chats[1].id'), first, 'the reply moved Chat 1 to the top');
  vm.slash('chat 2');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Beta', 'number 2 as listed, not as sorted since');
  vm.slash('pin 3');
  assert.equal(vm.evaluate(`NS.Chats.Find("${first}").pinned`), 'true');
  vm.slash('chat 7');
  assert.match(notice(vm), /^No chat 7 in that list any more\. Chats \(\/nqa chat <number> opens one\):\n1\. Chat 1  \(pinned\)/);
});

test('window: narrow by default with the chat list folded (the corner\'s + opens it, - folds it away, the conversation keeps its width); in the game\'s panels\' strata; it steps right of a panel you open, and back', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.panels = {}; function GetUIPanel(key) return STUB.panels[key] end; function ShowUIPanel(f) STUB.panels.left = f; f:Show() end; function HideUIPanel(f) STUB.panels.left = nil; f:Hide() end' }).login());
  vm.slash('');
  assert.equal(vm.evaluate('NQAFrame.strata'), 'MEDIUM', 'with the character sheet and the spellbook: whichever you clicked last is on top');
  assert.equal(vm.num('NQAFrame:GetWidth()'), 420);
  assert.equal(vm.evaluate('NS.UI.ui.list.shown'), 'false', 'the list is folded');
  // The corner (the owner: an icon to fold the chats away): + beside the X, the HUD's red set, in the double corner.
  assert.equal(vm.evaluate('NS.UI.ui.chatsBtn'), null, 'no Chats button in the header');
  assert.deepEqual(vm.json('{ NS.UI.ui.listBtn.normalArt, NS.UI.ui.closeBtn.normalArt, NS.UI.ui.listBtn.anchor.rel == NS.UI.ui.closeBtn, NS.UI.ui.listBtn.anchor.point }'),
    ['128-redbutton-plus', '128-redbutton-exit', true, 'RIGHT']);
  vm.run('local b = NS.UI.ui.listBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NS.UI.ui.list.shown'), 'true');
  assert.equal(vm.num('NQAFrame:GetWidth()'), 420 + 220 + 6, 'the window grows by the list');
  assert.equal(vm.evaluate('NS.UI.ui.listBtn.normalArt'), '128-redbutton-minus', '- folds it away');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local b = NS.UI.ui.listBtn; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Hide Chats');
  vm.run('local b = NS.UI.ui.listBtn; b.scripts.OnClick(b)');
  assert.equal(vm.num('NQAFrame:GetWidth()'), 420);
  assert.equal(vm.evaluate('NS.UI.ui.listBtn.normalArt'), '128-redbutton-plus');
  // Replies waiting in other chats: in the title, as the HUD's.
  const id = activeId(vm);
  vm.slash('new Other');
  apply(vm, slotLua({ records: [replyRec(1, id, 'Over here.')] }));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.title.text'), 'NeverQuestAlone  |cff1aff1a1 new|r', 'the game\'s green, one for every surface');
  // A panel of the game's opens at the top left: the window steps right of it, and back.
  vm.run('STUB.sheet = CreateFrame("Frame", "CharacterFrame"); function STUB.sheet:GetRight() return 350 end; ShowUIPanel(STUB.sheet)');
  vm.advance(0);
  assert.deepEqual([vm.num('NQAFrame.x'), vm.num('NQAFrame.y')], [358, -116]);
  vm.run('HideUIPanel(STUB.sheet)');
  vm.advance(0);
  assert.deepEqual([vm.num('NQAFrame.x'), vm.num('NQAFrame.y')], [16, -116]);
  // Only while that keeps clear of the HUD: beside a wide panel it stays home.
  vm.run('HideUIPanel(STUB.sheet); function NQAHUD:GetLeft() return 805 end; function NQAHUDBar:GetLeft() return 805 end; function STUB.sheet:GetRight() return 631 end; ShowUIPanel(STUB.sheet)');
  vm.advance(0);
  assert.deepEqual([vm.num('NQAFrame.x'), vm.num('NQAFrame.y')], [16, -116], 'it would cover the HUD: home, and the sheet raises itself');
  vm.run('HideUIPanel(STUB.sheet)');
  vm.advance(0);
  // A window you moved stays where you put it.
  vm.run('function STUB.sheet:GetRight() return 200 end; NQADB.settings.point, NQADB.settings.x = "CENTER", 5; ShowUIPanel(STUB.sheet)');
  vm.advance(0);
  assert.notEqual(vm.num('NQAFrame.x'), 208);
});

test('window: in its home place it keeps 140 above the bottom of the screen, clear of the action bars, as the game\'s panels do; one you moved keeps its height', () => {
  // A UI as short as 600 units (a large UI scale on a 16:10 screen): the default 380 doesn't fit at home.
  const vm = confirmHello(newVM({ extra: 'UIParent.height = 600' }).login());
  vm.slash('');
  assert.equal(vm.num('NQAFrame:GetHeight()'), 600 - 116 - 140, '344 at 600: above a second bar');
  assert.equal(vm.num('NQADB.settings.height'), 380, 'the saved size stays yours');
  vm.run('NQADB.settings.point, NQADB.settings.x, NQADB.settings.y = "CENTER", 0, 0; NS.UI.FitToScreen()');
  assert.equal(vm.num('NQAFrame:GetHeight()'), 380, 'moved: the size you chose');
  const big = confirmHello(newVM().login());
  big.slash('');
  assert.equal(big.num('NQAFrame:GetHeight()'), 380, 'on the owner\'s 894-tall screen it already clears the bars');
  assert.ok(380 <= 768 / 2, 'the default is half a 768-unit screen at most (a player, 2026-10-05: "too big/can\'t see")');
  // A height you set with the grip is yours, at home too.
  big.run('NQAFrame:SetSize(560, 700); local g = NS.UI.ui.grip; g.scripts.OnMouseUp(g)');
  big.run('NS.UI.Toggle(false); NS.UI.Toggle(true); NS.UI.FitToScreen()');
  assert.equal(big.num('NQAFrame:GetHeight()'), 700, 'your height, not trimmed');
  big.slash('window reset');
  assert.equal(big.evaluate('NQADB.settings.heightSet'), null, 'a reset makes it the default again');
  // Dragged away from home, a trimmed window gets its saved height back at once.
  const small = confirmHello(newVM({ extra: 'UIParent.height = 600' }).login());
  small.slash('');
  assert.equal(small.num('NQAFrame:GetHeight()'), 344);
  small.run('local d = NS.UI.ui.drag; d.scripts.OnDragStart(d); d.scripts.OnDragStop(d)');
  assert.equal(small.num('NQAFrame:GetHeight()'), 380);
});

test('window drag (the owner: "the dragging of the chat box is kind of wonky"): our settings are the only place it is saved; a drop keeps one anchor at its top-left corner in whole units; an edge a hair past the screen is not "off screen"; a window off screen comes back onto it, not home; nothing re-anchors it mid-drag; the grip and the list keep its corner; the small bar the same', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  // Not the game's layout cache too (a named frame the player moved is saved there and put back at its own time).
  assert.deepEqual(vm.json('{ NQAFrame.dontSavePosition, NQAMini.dontSavePosition }'), [true, true]);
  // Where it was dropped: its top-left corner against the screen's bottom-left, rounded; whatever the engine chose.
  const place = (l, t, w = 560, h = 540) => vm.run(`function NQAFrame:GetLeft() return ${l} end; function NQAFrame:GetTop() return ${t} end
    function NQAFrame:GetRight() return ${l} + ${w} end; function NQAFrame:GetBottom() return ${t} - ${h} end`);
  // Only its title bar and its portrait move it; a press on its bare frame doesn't (C-98), and the grip takes a near miss.
  assert.equal(vm.evaluate('NQAFrame.scripts.OnDragStart'), null, 'the bare frame doesn\'t drag');
  assert.deepEqual(vm.json('NS.UI.ui.grip.hitInsets'), [-4, -4, -4, -4]);
  place(300.4, 700.6);
  vm.run('local p = NS.UI.ui.portraitBtn; p.scripts.OnDragStart(p)');
  assert.equal(vm.evaluate('NQAFrame.moving'), 'true', 'the portrait moves it, as the HUD\'s');
  vm.run('local p = NS.UI.ui.portraitBtn; p.scripts.OnDragStop(p)');
  assert.deepEqual(vm.json('{ NQADB.settings.point, NQADB.settings.relPoint, NQADB.settings.x, NQADB.settings.y, NQAFrame.userPlaced }'), ['TOPLEFT', 'BOTTOMLEFT', 300, 701, false]);
  assert.deepEqual(vm.json('{ NQAFrame.points.TOPLEFT.relPoint, NQAFrame.points.TOPLEFT.x, NQAFrame.points.TOPLEFT.y }'), ['BOTTOMLEFT', 300, 701]);
  // Against the right edge: a hair past it measures on screen, so it stays where it was dropped (it went home).
  vm.run('UIParent.width, UIParent.height = 1200, 800');
  place(640.2, 700, 560.3);
  vm.run('local d = NS.UI.ui.drag; d.scripts.OnDragStart(d); d.scripts.OnDragStop(d)');
  assert.deepEqual(vm.json('{ NQADB.settings.point, NQADB.settings.x }'), ['TOPLEFT', 640], 'not sent home');
  // Where the unit's slack decides it: 0.9 past the edge is on screen, so it stays at 641 (without the slack it was nudged to 640).
  place(640.9, 700, 560);
  vm.run('local d = NS.UI.ui.drag; d.scripts.OnDragStart(d); d.scripts.OnDragStop(d)');
  assert.deepEqual(vm.json('{ NQADB.settings.x, NQAFrame.points.TOPLEFT.x }'), [641, 641]);
  // Truly off screen (a place saved on a bigger UI): moved just back onto it, not home.
  place(700, 780);
  vm.run('NS.UI.FitToScreen()');
  assert.deepEqual(vm.json('{ NQAFrame.points.TOPLEFT.x, NQAFrame.points.TOPLEFT.y, NQADB.settings.x }'), [640, 780, 640], 'nudged 60 left, onto the screen');
  // Nothing re-anchors it mid-drag, from the portrait either (C-114: its button is the whole ring, and the handle the player grabs).
  {
    const pv = confirmHello(newVM().login());
    pv.slash('');
    pv.run('UIParent.width, UIParent.height = 1200, 800');
    pv.run('function NQAFrame:GetLeft() return 16 end; function NQAFrame:GetTop() return 684 end; function NQAFrame:GetRight() return 576 end; function NQAFrame:GetBottom() return 144 end');
    pv.slash('window reset');
    assert.equal(pv.evaluate('NS.UI.ui.portraitDrag'), null, 'one control over the portrait, not a handle under it');
    assert.deepEqual(pv.json('{ NS.UI.ui.portraitBtn.width, NS.UI.ui.portraitBtn.height, NS.UI.ui.portraitBtn.anchor.point, NS.UI.ui.portraitBtn.x, NS.UI.ui.portraitBtn.y }'), [62, 62, 'TOPLEFT', -5, 7]);
    pv.run('local p = NS.UI.ui.portraitBtn; p.scripts.OnDragStart(p)');
    assert.equal(pv.evaluate('tostring(NS.UI.ui.moving)'), 'true');
    pv.run('STUB.sheet = CreateFrame("Frame", "PaperDollFake"); STUB.sheet.shown = true; function STUB.sheet:GetRight() return 400 end; GetUIPanel = function(k) if k == "left" then return STUB.sheet end end; NS.UI.StepAside()');
    assert.equal(pv.num('NQAFrame.points.TOPLEFT.x'), 16, 'still home while the portrait moves it');
  }
  // Nothing re-anchors it mid-drag: a game panel opening while you drag it home doesn't move it under the pointer.
  place(16, 684); // home on this 800-tall screen: 16 in, 116 down
  vm.slash('window reset');
  vm.run('local d = NS.UI.ui.drag; d.scripts.OnDragStart(d)');
  vm.run('STUB.sheet = CreateFrame("Frame", "PaperDollFake"); STUB.sheet.shown = true; function STUB.sheet:GetRight() return 400 end; GetUIPanel = function(k) if k == "left" then return STUB.sheet end end; NS.UI.StepAside()');
  assert.equal(vm.num('NQAFrame.points.TOPLEFT.x'), 16, 'still home while it moves');
  vm.run('local f = NQAFrame; f.scripts.OnHide(f); f:Show()');
  // A hide mid-drag ends the drag: the window steps aside for the sheet again, 8 right of it.
  vm.run('NS.UI.StepAside()');
  assert.equal(vm.num('NQAFrame.points.TOPLEFT.x'), 408, 'no drag left over after the hide');
  // The grip keeps its corner: at home, home's anchor; away, the one anchor at the top-left.
  vm.run('local g = NS.UI.ui.grip; g.scripts.OnMouseDown(g); NQAFrame:SetSize(700, 600); g.scripts.OnMouseUp(g)');
  assert.deepEqual(vm.json('{ NQADB.settings.point, NQADB.settings.x, NQADB.settings.width }'), ['TOPLEFT', 16, 700], 'home stays home');
  place(200, 650, 700, 600);
  vm.run('local d = NS.UI.ui.drag; d.scripts.OnDragStart(d); d.scripts.OnDragStop(d)');
  vm.run('local g = NS.UI.ui.grip; g.scripts.OnMouseDown(g); NQAFrame:SetSize(760, 600); g.scripts.OnMouseUp(g)');
  assert.deepEqual(vm.json('{ NQADB.settings.point, NQADB.settings.relPoint, NQADB.settings.x, NQADB.settings.y }'), ['TOPLEFT', 'BOTTOMLEFT', 200, 650]);
  assert.deepEqual(vm.json('{ NQAFrame.points.CENTER == nil, NQAFrame.points.TOPLEFT.relPoint, NQAFrame.points.TOPLEFT.x, NQAFrame.points.TOPLEFT.y }'), [true, 'BOTTOMLEFT', 200, 650],
    'the grip\'s end re-anchors it (the engine\'s own point here is its centre): back to the one anchor at its top-left');
  // The chat list's + away from home: the right edge stays, so the + is still under the pointer; the list opens leftwards.
  place(300, 650, 760, 600);
  vm.run('local b = NS.UI.ui.listBtn; b.scripts.OnClick(b)');
  const w = vm.num('NQAFrame:GetWidth()');
  assert.ok(w > 760, 'wider by the list');
  assert.equal(vm.num('NQAFrame.points.TOPLEFT.x'), Math.round(300 + 760 - w), 'its right edge where it was');
  // The small bar keeps its place the same way.
  vm.run('local m = NQAMini; function m:GetLeft() return 900.6 end; function m:GetTop() return 500.2 end; m.scripts.OnDragStart(m); m.scripts.OnDragStop(m)');
  assert.deepEqual(vm.json('{ NQADB.settings.miniPoint, NQADB.settings.miniRelPoint, NQADB.settings.miniX, NQADB.settings.miniY, NQAMini.userPlaced }'), ['TOPLEFT', 'BOTTOMLEFT', 901, 500, false]);
});

test('window: an old default window (820 wide, list always there) becomes the narrow one; a size you chose is kept', () => {
  const old = confirmHello(newVM({ db: 'NQADB = { settings = { width = 820, height = 540 } }' }).login());
  assert.deepEqual([old.num('NQADB.settings.width'), old.num('NQADB.settings.height')], [420, 380], 'and the smaller one since');
  const mine = confirmHello(newVM({ db: 'NQADB = { settings = { width = 700, height = 500 } }' }).login());
  assert.equal(mine.num('NQADB.settings.width'), 700);
});

test('window: one still at the old default (560 by 540; 786 wide with the chat list) opens at the new, smaller one; a size set with the grip, and any other size, is kept (a player, 2026-10-05: "In game window is too big/can\'t see")', () => {
  const size = vm => [vm.num('NQADB.settings.width'), vm.num('NQADB.settings.height')];
  const drawn = vm => { vm.run('NS.UI.Toggle(true)'); return [vm.num('NQAFrame:GetWidth()'), vm.num('NQAFrame:GetHeight()')]; };
  const at = settings => confirmHello(newVM({ db: `NQADB = { settings = { ${settings} } }` }).login());
  const old = at('width = 560, height = 540');
  assert.deepEqual(size(old), [420, 380], 'the old default: the new one');
  assert.deepEqual(drawn(old), [420, 380]);
  const list = at('width = 786, height = 540, listShown = true');
  assert.deepEqual(size(list), [420 + 226, 380], 'with the chat list shown: the new default and the list');
  assert.deepEqual(drawn(list), [420 + 226, 380]);
  assert.deepEqual(size(at('width = 560, height = 540, heightSet = true')), [560, 540], 'sized with the grip to just that: yours');
  assert.deepEqual(size(at('width = 600, height = 540')), [600, 540], 'any other size: kept');
  assert.deepEqual(size(at('width = 560, height = 500')), [560, 500]);
  assert.deepEqual(size(at('width = 786, height = 540')), [786, 540], '786 with the list folded was a size you chose');
  // A fresh install: the new default, and the grip goes down to 400 by 300.
  const fresh = confirmHello(newVM().login());
  assert.deepEqual(drawn(fresh), [420, 380]);
  fresh.run('NQAFrame:SetSize(320, 200); local g = NS.UI.ui.grip; g.scripts.OnMouseUp(g); NS.UI.FitToScreen()');
  assert.equal(fresh.num('NQAFrame:GetWidth()'), 400, 'no narrower than its minimum');
});

test('bubbles: NeverQuestAlone\'s TL;DR on top in a strip, not repeated at the end; a plain click does nothing (right-click or Copy copies); links open as in chat', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.refs = {}; function SetItemRef(link, text, button) table.insert(STUB.refs, link) end\nC_Item.GetItemInfo = function(id) if id == 4804 then return "Prairie Wolf Paw", "|cff9d9d9d|Hitem:4804::::::::|h[Prairie Wolf Paw]|h|r", 1 end end' }).login());
  vm.slash('');
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Line one.\n\nLine two.\n\nTL;DR: Go north.', ', summary = "Go north.", refs = { i = { 4804 } }')] }));
  const b = 'NS.UI.ui.bubbles[1]';
  assert.equal(vm.evaluate(`${b}.tldr.text`), '|cffffd100TL;DR|r  Go north.');
  assert.equal(vm.evaluate(`${b}.tldr.shown`), 'true');
  assert.equal(vm.evaluate(`${b}.body.text`), 'Line one.\n\nLine two.', 'the TL;DR line left the end');
  vm.run(`local x = ${b}; x.scripts.OnMouseUp(x, "LeftButton")`);
  assert.equal(vm.evaluate('NQACopy'), null, 'a plain click opens nothing');
  vm.run(`local x = ${b}; x.scripts.OnEnter(x)`);
  assert.equal(vm.evaluate(`${b}.copy.shown`), 'true', 'under the mouse: Copy');
  vm.run(`local c = ${b}.copy; c.scripts.OnClick(c)`);
  assert.equal(vm.evaluate('NQACopy.shown'), 'true');
  vm.run('NQACopy:Hide()');
  vm.run(`local p = ${b}.pills[1]; p.scripts.OnClick(p)`);
  assert.deepEqual(vm.list('STUB.refs'), ['item:4804'], 'an item link opens its tooltip, as in chat');
  // A reply with no TL;DR has no strip.
  apply(vm, slotLua({ records: [replyRec(2, id, 'Just this.')] }));
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[2].tldr.shown'), 'false');
});

test('rows: "2 new" or "working" on the name\'s line, right-aligned; a double-click only switches', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const id = activeId(vm);
  vm.slash('new Other');
  apply(vm, slotLua({ records: [replyRec(1, id, 'a'), replyRec(2, id, 'b')] }));
  vm.run('NS.UI.SetListShown(true); NS.UI.RenderList()');
  const row = vm.evaluate(`(function() for i, c in ipairs(NQADB.chats) do if c.id == "${id}" then return i end end end)()`);
  assert.equal(vm.evaluate(`NS.UI.ui.rows[${row}].badge.text`), '|cff1aff1a2 new|r');
  assert.equal(vm.evaluate(`NS.UI.ui.rows[${row}].label.text`), 'Chat 1', 'the name alone');
  assert.equal(vm.evaluate(`NS.UI.ui.rows[${row}].scripts.OnDoubleClick`), null);
});

test('the header: the chat\'s model and its thinking level; a level you just picked shows at once, from your next message, with an arrow that says it opens a menu', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  apply(vm, byokSlot({ p: provider({ effort: 'medium' }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · Medium', 'the model, and a level as the menu that sets it');
  vm.slash('think high');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · High |cff9d9d9d(from your next message)|r', 'the level you picked, at once');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local b = NS.UI.ui.thinkBtn; b.scripts.OnEnter(b)');
  assert.ok(vm.list('STUB.tip').includes('Thinking: High, from your next message.'), 'when it starts, in its tooltip');
  assert.equal(vm.evaluate('NS.UI.ui.thinkArrow ~= nil'), 'true');
});

test('warnings from the transport: a notice in the open chat (never saved into it), a line in the chat frame, and the HUD\'s status line with the whole text a click away (never a hover)', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, qolAsked = true }' }).login());
  const before = vm.history().length;
  vm.run('NS.Transport.Warn("t", "The whole long story about the doorbells.", "Replies come slower this session")');
  assert.equal(vm.history().length, before, 'not saved into the conversation');
  assert.equal(vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), 'The whole long story about the doorbells.');
  assert.ok(vm.chatLines().some(l => l.endsWith('The whole long story about the doorbells.')));
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Replies come slower this session');
  assert.equal(vm.evaluate('NS.HUD.h.tip'), 'The whole long story about the doorbells.');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Click for the details.');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true');
  vm.run('NS.UI.Toggle(false); NS.R.notices[NQADB.activeChat] = nil; local b = NS.HUD.h.statusBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), 'The whole long story about the doorbells.', 'the whole text, in the window');
  vm.run('NS.Transport.Warn("t", "again")');
  assert.equal(vm.chatLines().filter(l => l.endsWith('again')).length, 0, 'once a session');
});

test('/nqa <text>: with the window open, to the chat on screen; closed, to Quick questions, as the HUD\'s asks go', () => {
  const vm = confirmHello(newVM().login());
  const first = activeId(vm);
  vm.slash('where is the forge');
  const quick = vm.evaluate('NS.QuickChat().id');
  assert.notEqual(quick, first);
  assert.equal(vm.evaluate(`NS.Chats.Find("${quick}").history[1].text`), 'where is the forge');
  assert.equal(activeId(vm), first, 'the window keeps its chat');
  vm.slash('');
  vm.slash('and the trainer?');
  assert.equal(vm.lastHistory().text, 'and the trainer?', 'the open chat');
  assert.equal(activeId(vm), first);
});

// ---------------------------------------------------------------- one-click replies and game links

test('chips: NeverQuestAlone\'s suggested replies under his newest reply; a click sends the words; they go once you answer', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'The forge is east.', ', chips = { "Route me there", "Where do I train?", "Thanks|cffff0000!", "a fourth" }')] }));
  const chips = () => vm.json('(function() local o = {} for _, c in ipairs(NS.UI.ui.bubbles[1].chips) do if c.shown then o[#o + 1] = c.label.text end end return o end)()');
  assert.deepEqual(chips(), ['Route me there', 'Where do I train?', 'Thankscffff0000!'], 'three at most, and | never gets through');
  vm.run('local c = NS.UI.ui.bubbles[1].chips[1]; c.scripts.OnClick(c)');
  assert.ok(sentText(vm, 'Route me there'));
  assert.deepEqual(vm.lastHistory().text, 'Route me there');
  const shown = vm.json('(function() local n = 0 for _, c in ipairs(NS.UI.ui.bubbles[1].chips) do if c.shown then n = n + 1 end end return n end)()');
  assert.equal(shown, 0, 'answered: the chips go');
  // An empty chat says how to ask, with no ready-made asks (the owner, 2026-09-26), once setup is
  // done (before that it shows the setup checklist): the app's AI connected, and a reply came.
  apply(vm, byokSlot());
  vm.slash('new Fresh');
  const offered = vm.json('(function() local n = 0 for _, c in ipairs(NS.UI.ui.bubbles[1].chips or {}) do if c.shown then n = n + 1 end end return n end)()');
  assert.equal(offered, 0);
  assert.match(vm.evaluate('NS.UI.ui.bubbles[1].body.text'), /^Shift-click an item, spell or quest to link it/, 'how to, once; the box\'s hint says "Ask anything"');
  assert.equal(vm.evaluate('NS.UI.ui.hint.text'), 'Ask anything (Up Arrow brings back what you sent)');
  assert.deepEqual(vm.json('{ NS.UI.ui.hint.maxLines, NS.UI.ui.hint.wordWrap }'), [2, true], 'it wraps inside the box, never under Send');
});

test('refs: quest, item and spell ids become real game links named by the client; shift-click links one; no agent text is a link', () => {
  const vm = confirmHello(newVM({ extra: MAP_STUB + `
ITEM_QUALITY_COLORS = { [1] = { r = 1, g = 1, b = 1 }, [2] = { r = 0.12, g = 1, b = 0 } }
C_Item.GetItemInfo = function(id) if id == 4804 then return "Prairie Wolf Paw", "|cff9d9d9d|Hitem:4804::::::::|h[Prairie Wolf Paw]|h|r", 1 end end
C_Spell = { GetSpellName = function(id) if id == 8017 then return "Rockbiter Weapon" end end, GetSpellLink = function(id) return "|cff71d5ff|Hspell:" .. id .. "|h[Rockbiter Weapon]|h|r" end }
STUB.hyper = {}
function GameTooltip:SetHyperlink(h) table.insert(STUB.hyper, h) end
` }).login());
  vm.slash('');
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Do [Swoop Hunting] |Hquest:1|h.', ', refs = { q = { 766, "x", -3 }, i = { 4804, 9999 }, s = { 8017 } }')] }));
  const pills = vm.json('(function() local o = {} for _, p in ipairs(NS.UI.ui.bubbles[1].pills) do if p.shown then o[#o + 1] = p.label.text end end return o end)()');
  assert.deepEqual(pills, ['[Swoop Hunting]', '[Prairie Wolf Paw]', '[Item 9999]', '[Rockbiter Weapon]'], 'names from the client, ids only from NeverQuestAlone');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].body.text'), 'Do [Swoop Hunting] ||Hquest:1||h.', 'his text stays inert');
  vm.run('local p = NS.UI.ui.bubbles[1].pills[1]; p.scripts.OnEnter(p)');
  assert.deepEqual(vm.list('STUB.hyper'), ['quest:766']);
  vm.run('STUB.shift = true; local p = NS.UI.ui.bubbles[1].pills[1]; p.scripts.OnClick(p); STUB.shift = false');
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '|cffffff00|Hquest:766:-1|h[Swoop Hunting]|h|r');
  vm.run('NS.UI.ui.input:SetText(""); STUB.shift = true; local p = NS.UI.ui.bubbles[1].pills[4]; p.scripts.OnClick(p); STUB.shift = false');
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '|cff71d5ff|Hspell:8017|h[Rockbiter Weapon]|h|r');
  // Saved as clean ids only.
  assert.deepEqual(vm.json(`NS.Chats.Find("${id}").history[1].refs`), { q: [766], i: [4804, 9999], s: [8017] });
});

test('game data: a tick above the box says it rides along (what it holds is in its tooltip only, the owner); unticked, what you send goes without it until you tick it again, and each such message says so', () => {
  const vm = confirmHello(newVM().login());
  // The app's companion switch on (cap usage, usage.autoOn): off, the gear stays home (QL-F-14).
  vm.run('NS.R.bridge.caps = NS.R.bridge.caps or {}; table.insert(NS.R.bridge.caps, "usage"); NS.R.bridge.usage = { autoOn = true }');
  vm.slash('');
  vm.run('NS.UI.RenderContext()');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.text.text'), 'Game Data', 'short: no "Sending with" line');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.toggle.template'), 'UICheckButtonTemplate', 'the game\'s own tick box');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.detail'), 'Sent with your messages, so NeverQuestAlone knows what you know.', 'no "he" (C-14)');
  assert.match(vm.list('NS.UI.ui.ctx.lines')[0], /^Duskwood, Darkshire · level 23 · gear$/, 'what it holds, as the tooltip\'s content line (C-79)');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local t = NS.UI.ui.ctx.toggle; t.scripts.OnEnter(t)');
  assert.ok(vm.json('STUB.tip').some(l => /Duskwood, Darkshire/.test(l)));
  // You moved (the context changed), but this one message goes without it.
  vm.run('STUB.zone = "Westfall"; local t = NS.UI.ui.ctx.toggle; t.scripts.OnClick(t)');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.text.text'), 'Game Data', 'the label stays; the tick says it');
  assert.equal(vm.bool('NS.UI.ui.ctx.toggle.checked'), false);
  assert.equal(vm.evaluate('NS.UI.ui.ctx.detail'), 'Left out of what you send from here; each of those messages says "no game data".');
  assert.match(vm.list('NS.UI.ui.ctx.lines')[0], /^Westfall/, 'what\'s left out, as the content line');
  assert.deepEqual(vm.list('NS.UI.ui.ctx.actions'), ['Click to send it again'], 'what a click does, in green');
  type(vm, 'no context please');
  const bare = lastWire(vm);
  assert.match(bare, /;ctx=0;/);
  assert.match(bare, /;bare=1/, 'so the bridge adds neither its stored context nor the data block');
  assert.doesNotMatch(bare, /st=/);
  assert.ok(bare.endsWith('\x1fno context please'), 'the body is just the words');
  assert.equal(vm.bool('NS.R.skipGameData'), true, 'off until you tick it (C-69: it no longer ticks itself)');
  assert.equal(vm.bool('NS.UI.ui.ctx.toggle.checked'), false);
  vm.run('NS.Refresh("all")');
  const label = () => vm.json('(function() local out = {} for _, b in ipairs(NS.UI.ui.bubbles) do if b.shown and b.who then out[#out + 1] = b.who.text end end return out end)()');
  assert.ok(label().some(t => /^You · no game data/.test(t)), 'the message says it went without');
  type(vm, 'still without');
  assert.match(lastWire(vm), /;bare=1/, 'the next one too');
  vm.run('local t = NS.UI.ui.ctx.toggle; t.scripts.OnClick(t)');
  assert.equal(vm.bool('NS.UI.ui.ctx.toggle.checked'), true, 'ticked again');
  type(vm, 'now with it');
  assert.match(lastWire(vm), /;ctx=1;/, 'the next message carries the changed context');
  assert.doesNotMatch(lastWire(vm), /bare=/);
  assert.match(lastWire(vm), /Location: Westfall/);
  vm.slash('context off');
  vm.run('NS.UI.RenderContext()');
  assert.match(vm.evaluate('NS.UI.ui.ctx.text.text'), /Game Data: Off/);
  assert.equal(vm.bool('NS.UI.ui.ctx.toggle.disabled'), true, 'greyed out');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.detail'), 'Off in every chat: NeverQuestAlone sees only your words.');
  assert.match(vm.evaluate('NS.UI.ui.ctx.note'), /^Game Data with Messages, in Settings, turns it back on\.$/, 'how to turn it on, a click (Settings), as the note');
});

// ---------------------------------------------------------------- the HUD

// Past the first reply and the Quality of Life step: main's widget, as a player sees it every day
// (before the first reply the setup block stands in the Welcome's place).
const WELCOMED = 'NQADB = { hudIntro = true, firstReply = true, qolAsked = true }';

test('a question stays "working" from the ack to the reply, even when the ack\'s snapshot still says the chat is idle (the run starts a moment after)', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const id = activeId(vm);
  vm.send('wheres the nearest forge');
  const key = vm.outboxWires().pop().key;
  const idle = `{ { id = "${id}", key = "wow:${id}", agent = "main", busy = false, queued = 0 } }`;
  const busy = `{ { id = "${id}", key = "wow:${id}", agent = "main", busy = true, queued = 0, run = { started = time(), actions = 0, last = "" } } }`;
  // The ack's slot: acked, and the chat not yet busy (as the bridge before 0.3.1 wrote it).
  apply(vm, slotLua({ acked: [key], chats: idle }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Active())'), true, 'not taken as answered');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Thinking…');
  assert.match(vm.evaluate('NS.HUD.h.sub.text'), /^\d+ s$/);
  // Seen working, then idle with no reply: done.
  apply(vm, slotLua({ chats: busy }));
  apply(vm, slotLua({ chats: idle }));
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Active())'), false);
  // Never seen working: done anyway 2 minutes after the ack.
  vm.send('and the trainer?');
  const key2 = vm.outboxWires().pop().key;
  apply(vm, slotLua({ acked: [key2], chats: idle }));
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Active())'), true);
  vm.advance(121);
  apply(vm, slotLua({ chats: idle }));
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Active())'), false);
});

test('HUD: the game\'s portrait frame with NeverQuestAlone in its corner, as a bag has its own; beside him the state, the connection first; idle it is quiet (grey, no dot) at your opacity, with your last session for the first 10 minutes; Ask is always a click away', () => {
  const last = '{"v":1,"kind":"session","sid":"aaaaaaaaaaaaaaaa","char":{"name":"Testchar","realm":"Test Realm","class":"HUNTER","race":"Night Elf"},"start":{"t":1790383008,"level":9,"xp":1505,"xpMax":6500,"money":583},"end":{"t":1790384890,"level":9,"xp":3457,"xpMax":6500,"money":583},"xpGained":1952,"moneyDelta":0,"questsTurnedIn":1,"zones":["Mulgore"],"ended":"unknown"}';
  const vm = confirmHello(newVM({ db: `NQADB = { hudIntro = true, firstReply = true, qolAsked = true, companion = { lastSession = ${lstr(last)} } }` }).login());
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true', 'on by default');
  assert.equal(vm.evaluate('NQAHUD.mouse'), 'false', 'click-through: only its controls take the mouse');
  assert.equal(vm.evaluate('NQAHUD.portraitTexture'), 'Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone-portrait-64', 'NeverQuestAlone in the frame\'s own portrait slot');
  assert.equal(vm.num('NS.HUD.h.portraitBtn.level'), 510, 'over the border (500), as the game\'s own corner buttons are');
  assert.equal(vm.num('NS.HUD.h.minBtn.level'), 510, 'the minimize button too: it was under the border in 0.3.1');
  // The corner (the owner: a minimize icon, and an X close beside it): the game's own hide and close buttons.
  // The X in the close button's socket as Forever places its own (Camelot's TOPRIGHT -2, 1; retail's 1, 0 left it
  // 3 past the frame's edge: the owner, "a little awkward placed").
  assert.deepEqual(vm.json('{ NS.HUD.h.closeBtn.anchor.point, NS.HUD.h.closeBtn.x, NS.HUD.h.closeBtn.y, NS.HUD.h.closeBtn.level }'), ['TOPRIGHT', -2, 1, 510], 'the X in the close button\'s socket');
  assert.deepEqual(vm.json('{ NS.HUD.h.minBtn.anchor.point, NS.HUD.h.minBtn.anchor.rel == NS.HUD.h.closeBtn, NS.HUD.h.minBtn.normalArt, NS.HUD.h.closeBtn.normalArt }'),
    ['RIGHT', true, '128-redbutton-minus', '128-redbutton-exit'], 'minimize flush left of the X: the game\'s red set, a -, not an arrow');
  assert.equal(vm.evaluate('NQAHUD.layoutType'), 'HeldBagLayout', 'the backpack\'s small corner, as every bag has it');
  assert.deepEqual(vm.json('{ NS.HUD.h.portraitBtn.width, NS.HUD.h.portraitBtn.anchor.point, NS.HUD.h.portraitBtn.x, NS.HUD.h.portraitBtn.y }'), [40, 'CENTER', 14, -17], 'over the 36-unit portrait at -4, +1');
  assert.equal(vm.evaluate('NS.HUD.h.title.text'), 'NeverQuestAlone');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.equal(vm.evaluate('NS.HUD.h.status.style'), 'P', 'one size for the status, busy or not');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [0.6, 0.6, 0.6], 'idle: grey');
  assert.equal(vm.evaluate('NS.HUD.h.dot.shown'), 'false', 'idle: no dot on the portrait');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Last time: 31\u00a0min · +1,952\u00a0XP · 1\u00a0quest', 'a number keeps its unit (no-break spaces)');
  assert.equal(vm.num('NQAHUD.alpha'), 1, 'your opacity (100 %): nothing dims by itself');
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.shown'), 'false', 'nothing to say Okay to');
  assert.equal(vm.evaluate('NS.HUD.h.askBtn.shown'), 'true');
  assert.deepEqual(vm.json('{ NS.HUD.h.askBtn.anchor.point, NS.HUD.h.askBtn.x, NS.HUD.h.askBtn.y }'), ['TOPRIGHT', -12, -36],
    'Ask 12 under the corner\'s buttons (0 to 24), clear of the corner\'s metal (the owner), on the right gutter with the rest (C-74)');
  assert.equal(vm.evaluate('NS.HUD.h.chatsBtn'), null, 'no Chats button: the portrait opens your chats');
  assert.equal(vm.evaluate('NS.HUD.h.headZone'), null, 'nothing reads the pointer');
  vm.run('NS.R.loginAt = GetTime() - 601; NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '', 'the last session only in the first 10 minutes');
  // The connection, when it needs saying (the light's states).
  const light = (state, extra = '') => vm.run(`NS.Transport.Light = function() return "${state}", "the light's tip" end; ${extra} NS.HUD.Render()`);
  light('red', 'NS.Transport.BridgeAge = function() return 300 end;');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), "Can't reach the NeverQuestAlone app");
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'No word for 5 minutes. Is it running?');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 0.13, 0.13], 'red: errors only');
  assert.equal(vm.evaluate('NS.HUD.h.dot.shown'), 'true');
  assert.deepEqual(vm.json('NS.HUD.h.dot.fill.vcolor'), [1, 0.13, 0.13, 1], 'a red dot');
  vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'true');
  vm.run('local b = NS.HUD.h.replyBox; b.scripts.OnEscapePressed(b)');
  light('grey');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Not ready');
  light('yellow', 'NS.R.gw = { state = "connecting" };');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), "Can't reach your AI");
  light('green');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.equal(vm.evaluate('NS.HUD.h.dot.shown'), 'false');
  // A send that can't go out without a reload says so, not "Sending…".
  vm.run('NS.Transport.StripOut = function() return false end');
  vm.send('hello?');
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Waiting for a reload');
  // Your opacity, 60 to 100 %, for both of its shapes.
  vm.run('NQADB.settings.hudAlpha = 70; NS.HUD.Render()');
  assert.equal(vm.num('NQAHUD.alpha'), 0.7);
  assert.equal(vm.num('NQAHUDBar.alpha'), 0.7);
});


test('NeverQuestAlone\'s faces are the Ember mascot: round slots take the round portrait, its 64 px twin under 52 pixels (picked again on a UI scale or display change), square slots the square icon', () => {
  const MEDIA = 'Interface\\AddOns\\NeverQuestAlone\\Media\\';
  const vm = confirmHello(newVM({ db: WELCOMED, extra: 'AddonCompartmentFrame = { RegisterAddon = function(self, d) STUB.compartment = d end }' }).login());
  // The stub's screen is 1080 pixels tall at UI scale 1: the HUD's 36-unit portrait is drawn 50.6 px, the window's 62 at 87.
  assert.equal(vm.evaluate('NQAHUD.portraitTexture'), `${MEDIA}NeverQuestAlone-portrait-64`, 'the HUD under 52 px: the 64');
  vm.slash('');
  assert.equal(vm.evaluate('NQAFrame.portraitTexture'), `${MEDIA}NeverQuestAlone-portrait`, 'the window from 52 px: the 128');
  assert.deepEqual([vm.evaluate('NS.UI.RoundFace(nil, 37)'), vm.evaluate('NS.UI.RoundFace(nil, 36.97)')],
    [`${MEDIA}NeverQuestAlone-portrait`, `${MEDIA}NeverQuestAlone-portrait-64`], 'the switch sits at 52 px (37 units are 52.03 px here, 36.97 are 51.99)');
  // A retina display (1800 tall): both take the 128 once the game says the display changed.
  vm.run('GetPhysicalScreenSize = function() return 2880, 1800 end; STUB.FireEvent("DISPLAY_SIZE_CHANGED")');
  assert.equal(vm.evaluate('NQAHUD.portraitTexture'), `${MEDIA}NeverQuestAlone-portrait`, 'the HUD on retina: the 128');
  assert.equal(vm.evaluate('NQAFrame.portraitTexture'), `${MEDIA}NeverQuestAlone-portrait`);
  // And back on a small 1x display at a small UI scale: the 64 for both.
  vm.run('GetPhysicalScreenSize = function() return 1366, 768 end; STUB.FireEvent("UI_SCALE_CHANGED")');
  assert.equal(vm.evaluate('NQAHUD.portraitTexture'), `${MEDIA}NeverQuestAlone-portrait-64`);
  assert.equal(vm.evaluate('NQAFrame.portraitTexture'), `${MEDIA}NeverQuestAlone-portrait`, '62 units at 768 is 62 px: still the 128');
  // Square slots: the addon compartment and the reply banner take the square icon, never the round portrait.
  assert.equal(vm.evaluate('STUB.compartment.icon'), `${MEDIA}NeverQuestAlone`);
  assert.equal(vm.evaluate('NS.UI.FACE.square'), `${MEDIA}NeverQuestAlone`);
});
test('HUD: before the first reply the setup block stands in main\'s Welcome\'s place; work and news come before it; the first reply ends it for good, and the Quality of Life step waits for a later session', () => {
  const vm = confirmHello(newVM().login());
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'setup');
  assert.equal(vm.evaluate('NS.HUD.h.label.text'), 'Welcome');
  vm.send('where is the forge?');
  vm.run('NS.UI.Toggle(false); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'working', 'work first');
  const id = activeId(vm);
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(vm, slotLua({ records: [replyRec(1, id, 'Hi.')] }));
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says', 'news first');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Hi.');
  vm.run('local b = NS.HUD.h.okBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'idle', 'the first reply ended the setup block, and the step waits for a later session');
  assert.equal(vm.evaluate('NS.HUD.h.label.shown'), 'false');
  const later = confirmHello(reloadVM(vm).login());
  assert.equal(later.evaluate('NS.HUD.h.label.text'), 'Quality of Life');
  later.run('local b = NS.HUD.h.qolSkip; b.scripts.OnClick(b)');
  assert.equal(later.evaluate('NS.HUD.h.label.shown'), 'false');
});

test('HUD: news: "NeverQuestAlone says", what he says (its one primary line), and only Okay and Open chat, as buttons (the owner, 2026-09-26: no second bubble, buttons not icons); nothing dims or folds by itself; Okay puts it away read and sends nothing; Open chat opens that chat', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const id = activeId(vm);
  apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id}", mid = "m1", agent = "main", text = "Long.\\n\\nTL;DR: Go north.", summary = "Go north.", more = 0, chips = { "Route me there", "Thanks" } }`] }));
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 0.82, 0], 'a speaker\'s name in gold, over his words in white');
  assert.deepEqual(vm.json('NS.HUD.h.body.textColor'), [1, 1, 1]);
  assert.deepEqual(vm.json('NS.HUD.h.dot.fill.vcolor'), [1, 0.82, 0, 1], 'news: a gold dot on the portrait');
  assert.equal(vm.evaluate('NS.HUD.h.title.text'), 'NeverQuestAlone  |cff1aff1a1 new|r');
  assert.equal(vm.evaluate('NS.HUD.h.label.shown'), 'false', 'no "TL;DR" title over what he says');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Go north.');
  assert.equal(vm.evaluate('NS.HUD.h.body.style'), 'P');
  assert.deepEqual(['okBtn', 'openBtn'].map(b => vm.evaluate(`NS.HUD.h.${b}.shown`)), ['true', 'true']);
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.text'), 'Okay');
  assert.deepEqual(vm.json('{ NS.HUD.h.openBtn.text, NS.HUD.h.openBtn.anchor.rel == NS.HUD.h.okBtn }'), ['Open Chat', true], 'a button beside Okay, not an icon; its label in Title Case, as its tooltip\'s title (C-80)');
  assert.equal(vm.evaluate('NS.HUD.h.askBtn.shown'), 'false', 'while a reply shows, its two buttons are the only ways to talk');
  assert.deepEqual([vm.evaluate('NS.HUD.h.chips'), vm.evaluate('NS.HUD.h.replyBtn')], [null, null], 'nothing else to click: no chips, no Reply');
  assert.equal(vm.num('NQAHUD.alpha'), 1);
  // Nothing moves on the 2-second status tick: no control is hidden and shown again.
  vm.run('HIDES = 0; for _, c in ipairs({ NS.HUD.h.okBtn, NS.HUD.h.openBtn, NS.HUD.h.body }) do local hide = c.Hide; c.Hide = function(self) HIDES = HIDES + 1; return hide(self) end end; NS.Refresh("status"); NS.Refresh("status")');
  assert.equal(vm.num('HIDES'), 0);
  // Nothing on a timer: 20 s on, it's all still there, whole.
  vm.advance(20);
  vm.run('NS.HUD.Tick(0.1)');
  assert.equal(vm.evaluate('NS.HUD.h.body.shown'), 'true');
  assert.equal(vm.num('NQAHUD.alpha'), 1);
  // Okay: read and put away; nothing is sent.
  const before = vm.outboxWires().length;
  vm.run('local b = NS.HUD.h.okBtn; b.scripts.OnClick(b)');
  assert.equal(vm.num(`NS.Chats.Find("${id}").unread`), 0);
  assert.equal(vm.evaluate('NS.HUD.h.title.text'), 'NeverQuestAlone');
  assert.equal(vm.evaluate('NS.HUD.h.body.shown'), 'false');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.equal(vm.evaluate('NS.HUD.h.askBtn.shown'), 'true', 'Ask is back');
  assert.equal(vm.outboxWires().length, before, 'Okay sends nothing');
  // The key does the same (Bindings.xml, NQA_OKAY).
  apply(vm, slotLua({ records: [`{ seq = 2, t = "reply", chat = "${id}", mid = "m2", agent = "main", text = "Also.", summary = "Also.", more = 0 }`] }));
  assert.equal(vm.evaluate('NS.HUD.h.body.shown'), 'true');
  vm.run('NeverQuestAlone.Okay()');
  assert.equal(vm.evaluate('NS.HUD.h.body.shown'), 'false');
  // Open chat: the window, on the reply's own chat (its tooltip names it).
  const other = vm.evaluate('NS.Chats.New("Other").id');
  vm.run(`NS.Chats.Switch("${id}"); NS.UI.Toggle(false)`);
  apply(vm, slotLua({ records: [`{ seq = 3, t = "reply", chat = "${other}", mid = "m3", agent = "main", text = "Over here.", summary = "Over here.", more = 0 }`] }));
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Over here.');
  assert.match(vm.evaluate('NS.HUD.h.openBtn.tip.text'), /^Opens Other in the window/);
  vm.advance(0.5); // past the Okay click's guard (C-72)
  vm.run('local b = NS.HUD.h.openBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(activeId(vm), other, 'on the reply\'s chat');
});

// The owner, 2026-09-27: "when bones suggests a path, im clicking okay and then its not adopting the path".
const DRAWN = (version, layers) => `, map = { epoch = "e1", version = ${version}, layers = { { name = "mulgore", title = "Mulgore quests", ordered = true, loop = false, points = {
  { 1432, 56, 40, "2. Wolves and plainstriders", "kill", "Kill 8 Prairie Wolves and 6 Plainstriders; loot 8 Prairie Wolf Paws.", { 761 } },
  { 1432, 50, 34, "3. Harken: Swoop Hunting", "turnin", "", { 766 } },
  { 1432, 80, 60, "4. Far stop", "flight" } } }${layers} } }`;
const LOOP = `, { name = "loop", title = "Red Cloud loop", ordered = true, loop = false, points = { { 1432, 40, 60, "1. Camp (approx)", "kill" }, { 1432, 45, 70, "2. Well", "object" } } }`;
const PIN = `, { name = "kreenig", title = "Kreenig Snarlsnout", ordered = false, loop = false, points = { { 1432, 30, 70, "Kreenig Snarlsnout (approx)", "kill" } } }`;
const MARKS = `, { name = "copper", title = "Copper veins", ordered = false, loop = false, points = { { 1432, 20, 20, "Vein", "ore" }, { 1432, 25, 25, "Vein", "ore" } } }`;

test('HUD: Okay on a reply that drew a route follows it, though you were on another (the owner: "its not adopting the path"); a pin it put is a detour, back to your route once there; its tooltip says which; the banner\'s Okay does the same; newer news keeps it for its Okay; a reply that drew nothing, or only marks, leaves your route', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  const id = activeId(vm);
  const nav = () => vm.json('{ NQAMapDB.nav.layer, NQAMapDB.nav.index }');
  const okay = () => { vm.advance(0.5); vm.run('local b = NS.HUD.h.okBtn; b.scripts.OnClick(b)'); };
  apply(vm, slotLua({ extra: ROUTE }));
  assert.deepEqual(nav(), ['mulgore', 1]);
  // A route drawn while you follow another waits for your Okay.
  apply(vm, slotLua({ records: [replyRec(1, id, 'A loop.', ', drew = { "loop" }')], extra: DRAWN(2, LOOP) }));
  assert.deepEqual(nav(), ['mulgore', 1], 'not taken over while you read it');
  // Its first button says it follows (C-100), and its tooltip what.
  assert.deepEqual(vm.json('{ NS.HUD.h.okBtn.text, NS.HUD.h.okBtn.width, NS.HUD.h.okBtn.tip.title, NS.HUD.h.openBtn.anchor.rel == NS.HUD.h.okBtn }'), ['Follow Route', 104, 'Follow Route', true]);
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.tip.text'), 'Marks the reply read and follows the route it drew: Red Cloud loop.');
  okay();
  assert.deepEqual(nav(), ['loop', 1]);
  assert.equal(vm.evaluate('NS.MapShared.navView.layer'), 'loop', 'the HUD shows it');
  assert.equal(vm.evaluate('NS.HUD.h.body.shown'), 'false', 'and the reply is put away');
  // A pin: a detour. Reaching it goes back to the route where you left it, and
  // the route isn't finished, so NeverQuestAlone isn't told it is.
  vm.run('NQAMapDB.nav.index = 2');
  apply(vm, slotLua({ records: [replyRec(2, id, 'Kreenig is here.', ', drew = { "kreenig" }')], extra: DRAWN(3, LOOP + PIN) }));
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.tip.text'), 'Marks the reply read and points the arrow at the pin it put: Kreenig Snarlsnout.');
  assert.deepEqual(vm.json('{ NS.HUD.h.okBtn.text, NS.HUD.h.okBtn.tip.title }'), ['Follow Pin', 'Follow Pin']);
  okay();
  assert.deepEqual(vm.json('{ NQAMapDB.nav.layer, NQAMapDB.nav.back.layer, NQAMapDB.nav.back.index }'), ['kreenig', 'loop', 2]);
  vm.run('DONE = 0; NS.MapShared.OnRouteDone = function() DONE = DONE + 1 end; NQAMap.Step(1, true)');
  assert.deepEqual(nav(), ['loop', 2], 'back where you left it');
  assert.equal(vm.num('DONE'), 0, 'no "route done" for a detour');
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text')], ['Reached Kreenig Snarlsnout', 'Back to Red Cloud loop.']);
  assert.equal(vm.evaluate('STUB.prints[#STUB.prints]'), '|cff7ec8ff[NeverQuestAlone]|r Reached Kreenig Snarlsnout (approx). Back to Red Cloud loop.');
  // A reply that drew nothing, or only marks with no order: Okay leaves your route.
  apply(vm, slotLua({ records: [replyRec(3, id, 'Nice.')] }));
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.tip.text'), 'Marks the reply read and puts it away; nothing is sent.');
  assert.deepEqual(vm.json('{ NS.HUD.h.okBtn.text, NS.HUD.h.okBtn.width }'), ['Okay', 64], 'nothing to follow: Okay');
  okay();
  apply(vm, slotLua({ records: [replyRec(4, id, 'Copper here.', ', drew = { "copper" }')], extra: DRAWN(4, LOOP + MARKS) }));
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.tip.text'), 'Marks the reply read and puts it away; nothing is sent.');
  okay();
  assert.deepEqual(nav(), ['loop', 2]);
  // The route you already follow: nothing to say, and Okay keeps your stop.
  apply(vm, slotLua({ records: [replyRec(5, id, 'Same loop.', ', drew = { "loop" }')] }));
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.tip.text'), 'Marks the reply read and puts it away; nothing is sent.');
  okay();
  assert.deepEqual(nav(), ['loop', 2]);
  // Newer news covers the route's reply (another chat checks in): Okay still follows it.
  const other = vm.evaluate('NS.Chats.New("Other").id');
  vm.run(`NS.Chats.Switch("${id}"); NS.UI.Toggle(false)`);
  apply(vm, slotLua({ records: [replyRec(6, id, 'Mulgore again.', ', drew = { "mulgore" }')] }));
  apply(vm, slotLua({ records: [replyRec(7, other, 'Level 10.')] }));
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Level 10.');
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.tip.text'), 'Marks the reply read and follows the route it drew: Mulgore quests.');
  okay();
  assert.deepEqual(nav(), ['mulgore', 1]);
  // The Okay key only puts it away: its name says okay, and the button says Follow when it follows (C-102).
  apply(vm, slotLua({ records: [replyRec(8, id, 'The loop again.', ', drew = { "loop" }')] }));
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.text'), 'Follow Route');
  vm.run('NeverQuestAlone.Okay()');
  assert.deepEqual([vm.evaluate('NS.HUD.h.body.shown'), vm.num(`NS.Chats.Find("${id}").unread`)], ['false', 0], 'read and put away');
  assert.deepEqual(nav(), ['mulgore', 1], 'the route you follow stays');
  // Asking something instead of Okay: the reply's route stays where it was.
  apply(vm, slotLua({ records: [replyRec(9, id, 'The loop.', ', drew = { "loop" }')] }));
  vm.run(`NS.HUD.Asked("${id}")`);
  apply(vm, slotLua({ records: [replyRec(10, id, 'Answered.')] }));
  okay();
  assert.deepEqual(nav(), ['mulgore', 1]);
  // The compass shows no news: the banner does, and its Okay follows the route, though a newer banner covers it.
  vm.run('NQADB.settings.hudMin = true; NQADB.settings.hudCompass = true; NS.HUD.Render()');
  apply(vm, slotLua({ records: [replyRec(11, id, 'The loop, then.', ', drew = { "loop" }')] }));
  apply(vm, slotLua({ records: [replyRec(12, id, 'And one more thing.')] }));
  assert.deepEqual([vm.evaluate('NQAToast1.shown'), vm.evaluate('NS.UI.ui.toastOrder[1].line.text'), vm.evaluate('NQAToast2')], ['true', 'And one more thing.', null]);
  assert.deepEqual(vm.json('{ NS.UI.ui.toastOrder[1].okay.text, NS.UI.ui.toastOrder[1].okay.width }'), ['Follow', 60], 'the banner\'s first button says it follows too');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local o = NS.UI.ui.toastOrder[1].okay; o.scripts.OnEnter(o)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Follow');
  assert.ok(vm.list('STUB.tip').includes('Marks the reply read and follows the route it drew: Red Cloud loop.'), vm.list('STUB.tip').join(' | '));
  vm.run('local t = NS.UI.ui.toastOrder[1]; t.okay.scripts.OnClick(t.okay)');
  assert.deepEqual(nav(), ['loop', 1]);
  // The Okay key with the HUD showing no news (the compass): the banner's reply read and put away, nothing followed (C-103).
  apply(vm, slotLua({ records: [replyRec(13, id, 'Mulgore once more.', ', drew = { "mulgore" }')] }));
  assert.deepEqual([vm.evaluate('NQAToast1.shown'), vm.num(`NS.Chats.Find("${id}").unread`)], ['true', 1]);
  vm.run('NeverQuestAlone.Okay()');
  assert.deepEqual([vm.evaluate('NQAToast1.shown'), vm.num('#NS.UI.ui.toastOrder'), vm.num(`NS.Chats.Find("${id}").unread`)], ['false', 0, 0]);
  assert.deepEqual(nav(), ['loop', 1], 'the key follows nothing');
  // Open Chat reads it instead: the route stays.
  apply(vm, slotLua({ records: [replyRec(14, id, 'Mulgore, then.', ', drew = { "mulgore" }')] }));
  vm.run('local t = NS.UI.ui.toastOrder[1]; t.open.scripts.OnClick(t.open); NS.UI.Toggle(false)');
  apply(vm, slotLua({ records: [replyRec(15, id, 'Later.')] }));
  vm.run('local t = NS.UI.ui.toastOrder[1]; t.okay.scripts.OnClick(t.okay)');
  assert.deepEqual(nav(), ['loop', 1]);
  // A detour's pin taken off the map: back to the route.
  vm.run('NQADB.settings.hudMin = false; NQADB.settings.hudCompass = false; NS.HUD.Render()');
  apply(vm, slotLua({ records: [replyRec(16, id, 'Kreenig.', ', drew = { "kreenig" }')], extra: DRAWN(5, LOOP + PIN) }));
  okay();
  assert.equal(vm.evaluate('NQAMapDB.nav.layer'), 'kreenig');
  apply(vm, slotLua({ extra: DRAWN(6, LOOP) }));
  assert.deepEqual(nav(), ['loop', 1]);
});

test('HUD: "Sending…" has its one line from the start (how long it has waited), and once the message has been on screen unread for 15 s, that it hasn\'t been read, with the row\'s button its one action, Reload (DR-07; no promise the strip fixes itself); nothing moves when it speaks (2026-09-27: the HUD said nothing for 5 minutes while the capture saw no strip, and the owner pressed Stop); after the first reply the same', () => {
  // Before the first reply (the setup block's time).
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, qolAsked = true }' }).login());
  vm.send('where is the forge');
  vm.run('NS.HUD.Render()');
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text'), vm.evaluate('NS.HUD.h.sub.maxLines')], ['Sending…', '0 s', '1']);
  const y = vm.num('NS.HUD.h.stopBtn.y');
  // The bridge is up (its beats come), but the message is never read.
  for (let t = 0; t < 3; t++) { vm.advance(10.5); vm.run('NS.Transport.Beat()'); }
  vm.run('NS.HUD.Render()');
  assert.match(vm.evaluate('NS.HUD.h.sub.text'), /^3\d s · not read yet$/);
  assert.equal(vm.evaluate('NS.HUD.h.sub.maxLines'), '1');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Reload', 'the same button, its one action');
  assert.equal(vm.num('NS.HUD.h.stopBtn.y'), y, 'where Stop was');
  assert.equal(vm.evaluate('NS.UI.StatusText()'), '|cffffd100NeverQuestAlone hasn\'t read your message yet.|r', 'the window says it too');
  // Stop before it was picked up (and before it's stuck): one line under "Stopping…" too, the time alone, so Stop stays put.
  const early = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, qolAsked = true }' }).login());
  early.send('where is the forge');
  early.run('NS.HUD.Render()');
  const ye = early.num('NS.HUD.h.stopBtn.y');
  early.advance(10.5); early.run('NS.Transport.Beat()');
  early.run('local b = NS.HUD.h.stopBtn; b.scripts.OnClick(b)');
  assert.equal(early.evaluate('NS.HUD.h.status.text'), 'Stopping…');
  assert.match(early.evaluate('NS.HUD.h.sub.text'), /^1\d s$/);
  assert.deepEqual([early.evaluate('NS.HUD.h.sub.maxLines'), early.num('NS.HUD.h.stopBtn.y')], ['1', ye]);
  // After the first reply: the same line and the same button, and still nothing moves.
  const after = confirmHello(newVM({ db: WELCOMED }).login());
  after.send('where is the forge');
  after.run('NS.HUD.Render()');
  const y2 = after.num('NS.HUD.h.stopBtn.y');
  for (let t = 0; t < 3; t++) { after.advance(10.5); after.run('NS.Transport.Beat()'); }
  after.run('NS.HUD.Render()');
  assert.equal(after.evaluate('NS.HUD.h.status.text'), 'Sending…');
  assert.match(after.evaluate('NS.HUD.h.sub.text'), /^3\d s · not read yet$/);
  assert.deepEqual([after.evaluate('NS.HUD.h.stopBtn.text'), after.evaluate('NS.HUD.h.sub.maxLines'), after.num('NS.HUD.h.stopBtn.y')], ['Reload', '1', y2]);
});

test('HUD: Stop clicked while the message is still being sent: the header keeps its lines, so Stop stays under the pointer (C-72)', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.send('where is the forge');
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Sending…');
  const sub = vm.evaluate('NS.HUD.h.sub.text');
  const y = vm.num('NS.HUD.h.stopBtn.y');
  vm.run('local b = NS.HUD.h.stopBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Stopping…');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), sub, 'the second line as it was');
  assert.equal(vm.num('NS.HUD.h.stopBtn.y'), y, 'Stop, greyed, where it was');
});

test('HUD: working: what you asked in plain words, or what the game sent, led by a gold "You asked:"; Stop, then the same button greyed, "Stopping…" (nothing moves under a second click), and no second stop', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.send('where is the forge');
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.label.shown'), 'false', 'no title line');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), '|cffffd100You asked:|r where is the forge');
  assert.equal(vm.evaluate('NS.HUD.h.body.style'), 'B', 'what you asked is body text; the status is the live line');
  const key = vm.outboxWires().pop().key;
  vm.slot(slotLua({ acked: [key], nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm);
  vm.advance(1.6);
  vm.run('STUB.onLoadAddOn = nil; NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Thinking…', 'the voice alone: it never wraps as the clock runs');
  assert.match(vm.evaluate('NS.HUD.h.sub.text'), /^\d+ s$/, 'the time under it');
  assert.equal(vm.evaluate('NS.HUD.h.dot.fill.vcolor[1]'), '0.49', 'thinking: a blue dot');
  assert.equal(vm.evaluate('NS.HUD.h.dot.pulse.playing'), 'true', 'that breathes');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.shown'), 'true');
  const stopY = vm.num('NS.HUD.h.stopBtn.y');
  vm.run('local b = NS.HUD.h.stopBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'NeverQuestAlone was asked to stop.', 'picked up: the header\'s second line says so');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Stopping…');
  assert.deepEqual([vm.evaluate('NS.HUD.h.stopBtn.shown'), vm.evaluate('NS.HUD.h.stopBtn.text'), vm.evaluate('NS.HUD.h.stopBtn.disabled')], ['true', 'Stopping…', 'true'],
    'the same button, greyed: no second Stop to click, and nothing slides under the pointer (C-72)');
  assert.equal(vm.num('NS.HUD.h.stopBtn.y'), stopY);
  const stops = () => vm.outboxWires().filter(e => /\x1fstop\x1f/.test(e.wire)).length;
  assert.equal(stops(), 1);
  vm.slash('stop');
  assert.equal(stops(), 1, 'one stop at a time');
  // A game event the companion sent reads as the game's.
  vm.run('NS.Companion.Send("level_up", { from = 9, to = 10 }, "t:1")');
  const comp = vm.evaluate('NS.COMPANION_CHAT');
  vm.run(`NS.HUD.Asked("${comp}")`);
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), '|cffffd100From the game:|r Level-up: 9 → 10');
});

test('HUD: the corner\'s X is placed by the game\'s own close-button anchor code where the client has it (UIPanelCloseButtonDefaultAnchorsMixin), so it sits where the window\'s X does', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, qolAsked = true }', extra: 'UIPanelCloseButtonDefaultAnchorsMixin = { OnLoad = function(self) self:SetPoint("TOPRIGHT", -7, 3) end }' }).login());
  assert.deepEqual(vm.json('{ NS.HUD.h.closeBtn.anchor.point, NS.HUD.h.closeBtn.x, NS.HUD.h.closeBtn.y }'), ['TOPRIGHT', -7, 3]);
  assert.equal(vm.evaluate('NS.HUD.h.minBtn.anchor.rel == NS.HUD.h.closeBtn'), 'true', 'the - flush left of it');
});

test('HUD: the portrait opens your chats (the window with its list) and lights under the pointer, with a tooltip that says so; a plain drag on the title band or the portrait moves it (the click that ends a drag opens nothing); right-click: the menu; in combat and with the window open it is one line', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Hi.')] }));
  assert.equal(vm.evaluate('NS.HUD.h.body.shown'), 'true');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['false', 'true'], 'in combat: one line');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Hi.', 'what he says, cut to the line');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'true', 'Okay, right there');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says', 'the panel\'s texts stay current under it');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['true', 'false']);
  const p = 'local p = NS.HUD.h.portraitBtn;';
  // Hover: the game's round highlight, and a tooltip saying what a click does.
  assert.ok(vm.json(`(function() local o = {} for _, t in ipairs(NS.HUD.h.portraitBtn.textures) do if t.layer == "HIGHLIGHT" then o[#o + 1] = t.texture or t.atlas end end return o end)()`).length > 0, 'it lights under the pointer');
  vm.run(`STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; ${p} p.scripts.OnEnter(p)`);
  assert.equal(vm.evaluate('GameTooltip.text'), 'NeverQuestAlone');
  assert.ok(vm.json('STUB.tip').includes('<Click to open your chats>'), 'in green, as a bag\'s says what a click does');
  vm.run(`${p} p.scripts.OnClick(p, "LeftButton")`);
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true', 'the portrait opens the window');
  assert.equal(vm.evaluate('NS.UI.ui.list.shown'), 'true', 'with the list of your chats');
  assert.equal(vm.evaluate('NQAHUDBar.shown'), 'true', 'the window has it all: the HUD is one line');
  vm.run('NS.UI.Toggle(false)');
  // A plain drag moves it, and the place is kept; the click that ends it opens nothing.
  vm.run(`${p} p.scripts.OnDragStart(p); p.scripts.OnDragStop(p)`);
  assert.equal(vm.evaluate('NQADB.settings.hudPoint'), 'CENTER');
  vm.run(`${p} p.scripts.OnClick(p, "LeftButton")`);
  assert.equal(vm.evaluate('NQAFrame.shown'), 'false', 'a drag is not a click');
  vm.run('NS.HUD.ResetPosition()');
  vm.advance(0.5);
  vm.run('local g = NS.HUD.h.grip; g.scripts.OnDragStart(g); g.scripts.OnDragStop(g)');
  assert.equal(vm.evaluate('NQADB.settings.hudPoint'), 'CENTER', 'the title band moves it too');
  vm.advance(0.5);
  // The menu, from the portrait or the title band: only what the HUD's own buttons don't do (the owner:
  // "only what we need"). - and X are its corner's; putting it back is in Settings and /nqa hud reset.
  vm.run(`${p} p.scripts.OnClick(p, "RightButton")`);
  const items = () => vm.json('(function() local o = {} for _, b in ipairs(NQAPopupMenu.items) do if b.shown then o[#o + 1] = b.label.text end end return o end)()');
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show Less', 'Open Settings'], 'Show Less, as its - does (the owner)');
  vm.run('local b = NQAPopupMenu.items[1]; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true', 'Open Your Chats');
  vm.run('NS.UI.Toggle(false)');
  vm.run('local g = NS.HUD.h.grip; g.scripts.OnMouseUp(g, "RightButton")');
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show Less', 'Open Settings'], 'the same from the title band');
  vm.run('for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == "Show Less" then b.scripts.OnClick(b) end end');
  assert.deepEqual([vm.evaluate('NQADB.settings.hudMin'), vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['true', 'false', 'true'], 'the bar');
  vm.slash('hud full');
  vm.slash('hud reset');
  assert.equal(vm.evaluate('NQADB.settings.hudPoint'), null, 'put back');
  // The X closes for real: nothing stands in, and it says how to come back.
  vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQADB.settings.hud'), vm.evaluate('NQAHUDBar.shown'), vm.evaluate('NQAMini.shown')], ['false', 'false', 'false', 'false'], 'closed, with no bar in its place');
  assert.ok(vm.chatLines().some(l => l.includes('The HUD is closed; replies still show as they come, and a route you follow keeps its bar.')));
  vm.slash('hud');
  assert.ok(vm.chatLines().some(l => l.includes('The HUD is closed: only a route you follow shows, as its bar')), '/nqa hud says what is true');
  // Turned off instead (Settings, /nqa hud off), the small bar stands in, so NeverQuestAlone is never gone.
  vm.slash('hud off');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAMini.shown')], ['false', 'true']);
  vm.slash('hud on');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true', 'and back');
});

test('HUD placement (C-99): a place you chose is its top-right corner, in whole units, and the panel and the one-line HUD each hang their own top-right corner there (so the game keeps each on screen by itself, and the bar never moves with the hidden panel); an older save of the panel\'s top-left converts', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.slash('hud min');
  vm.run('local b = NQAHUDBar; function b:GetRight() return 220.4 end; function b:GetTop() return 150.6 end');
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnDragStart(g); g.scripts.OnDragStop(g)');
  assert.deepEqual(vm.json('{ NQADB.settings.hudPoint, NQADB.settings.hudRelPoint, NQADB.settings.hudX, NQADB.settings.hudY }'), ['TOPRIGHT', 'BOTTOMLEFT', 220, 151]);
  const hung = f => vm.json(`{ ${f}.points.TOPRIGHT.rel == UIParent, ${f}.points.TOPRIGHT.relPoint, ${f}.points.TOPRIGHT.x, ${f}.points.TOPRIGHT.y }`);
  assert.deepEqual(hung('NQAHUDBar'), [true, 'BOTTOMLEFT', 220, 151], 'the bar on the corner itself, not on the hidden panel');
  assert.deepEqual(hung('NQAHUD'), [true, 'BOTTOMLEFT', 220, 151], 'the panel on the same corner');
  // Back to the panel and the compass: the same corner.
  vm.slash('hud full');
  assert.deepEqual(hung('NQAHUD'), [true, 'BOTTOMLEFT', 220, 151]);
  vm.slash('hud compass');
  assert.deepEqual(hung('NQAHUDBar'), [true, 'BOTTOMLEFT', 220, 151]);
  // An older save (the panel's top-left, 0.4.6 and before): its right edge from the panel's width (300).
  const old = confirmHello(newVM({ db: `NQADB = { hudIntro = true, settings = { hudPoint = "TOPLEFT", hudRelPoint = "BOTTOMLEFT", hudX = 400, hudY = 600, hudMin = true } }` }).login());
  assert.deepEqual(old.json('{ NQAHUDBar.points.TOPRIGHT.rel == UIParent, NQAHUDBar.points.TOPRIGHT.x, NQAHUDBar.points.TOPRIGHT.y }'), [true, 700, 600]);
  // Put back by the quest tracker: docked again, the bar on the panel's right edge.
  old.slash('hud reset');
  assert.equal(old.evaluate('NQAHUDBar.points.TOPRIGHT.rel == NQAHUD'), 'true');
});

test('HUD: minimized it is small (the owner: "still a huge hud"): the game\'s small frame in the HUD\'s colours, the panel\'s big arrow at its left (the owner: in place of the skull), one row (the quest it points to, in place of "Ready"; the distance; 2/6) over the route\'s bar; no buttons (the owner: "a right click thing only"): Show Less folds it to the compass (the arrow and the distance), Show More back; remembered; news shows what he says with Okay; a click opens your chats', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator()');
  vm.run('local b = NS.HUD.h.minBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NQADB.settings.hudMin'), 'true');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['false', 'true']);
  assert.deepEqual(vm.json('{ NQAHUDBar.anchor.point, NQAHUDBar.anchor.relPoint, NQAHUDBar.anchor.rel == NQAHUD }'), ['TOPRIGHT', 'TOPRIGHT', true],
    'the panel\'s right edge, by the quest tracker: nothing jumps');
  // Small: the game's tooltip frame (the metal panel's corners are some 150 tall in game).
  assert.equal(vm.evaluate('NQAHUDBar.template'), 'TooltipBackdropTemplate');
  assert.deepEqual([vm.num('NQAHUDBar.width'), vm.num('NQAHUDBar.height')], [272, 44]);
  // The panel's big arrow at the left, in its column: the compass in place of the skull (the owner).
  assert.equal(vm.evaluate('NQAHUDBar.icon'), null, 'no skull');
  assert.deepEqual(vm.json('{ NQAHUDBar.arrowZone.shown, NQAHUDBar.arrowZone.width, NQAHUDBar.arrowZone.points.LEFT.x, NQAHUDBar.arrow.shown, NQAHUDBar.arrow.width, NQAHUDBar.arrow.texture }'),
    [true, 48, 4, true, 44, 'Interface\\Minimap\\MinimapArrow'], 'the panel\'s arrow, as big');
  assert.deepEqual(vm.json('{ NQAHUDBar.expand == nil, NQAHUDBar.closeBtn == nil }'), [true, true], 'no buttons: the menu has them (the owner)');
  // The row: where the arrow points, the stop's quest as the quest log shows it (in place of "Ready"), then 60 yd and 1/3 at the right.
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'The Hunt Continues');
  assert.deepEqual(vm.json('NQAHUDBar.status.textColor'), [1, 0.82, 0], 'the tracker\'s header gold, where the game sets no colour');
  assert.deepEqual(vm.json('{ NQAHUDBar.status.points.LEFT.relPoint, NQAHUDBar.status.points.LEFT.x, NQAHUDBar.status.points.LEFT.y }'), ['TOPLEFT', 52, -16], 'right of the arrow, as much room on its right as on its left (the owner)');
  // No "1/3" (the owner, 2026-09-27: "remove the n/n count on the abbreviated view, not important when we already
  // have the progress bar visible"): the distance has the row's end.
  assert.equal(vm.evaluate('NQAHUDBar.count'), null, 'no count on the bar');
  assert.deepEqual(vm.json('{ NQAHUDBar.dist.text, NQAHUDBar.dist.points.RIGHT.relPoint, NQAHUDBar.dist.points.RIGHT.x, NQAHUDBar.dist.points.RIGHT.y }'), ['60 yd', 'TOPRIGHT', -10, -16]);
  // The route's bar, still, right of the arrow to the row's end, and its parts go to their stops.
  assert.deepEqual([vm.evaluate('NQAHUDBar.segs[1].shown'), vm.evaluate('NQAHUDBar.segs[3].shown'), vm.evaluate('NQAHUDBar.segs[4].shown')], ['true', 'true', 'false'], 'one segment per stop');
  assert.deepEqual(vm.json('{ NQAHUDBar.segs[1].x, NQAHUDBar.segs[1].y }'), [52, -30]);
  assert.equal(Math.round(vm.num('NQAHUDBar.segs[3].x + NQAHUDBar.segs[3].width')), 262, 'to 10 in from the edge, as the words');
  assert.deepEqual(vm.json('NQAHUDBar.segs[1].color'), [1, 0.82, 0, 1], 'where you are: bright gold');
  assert.equal(vm.evaluate('NQAHUDBar.segs.hit[2].shown'), 'true');
  // A stop with no quest: its words, without their number.
  vm.slash('map nav mulgore 3');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Far stop');
  assert.deepEqual(vm.json('NQAHUDBar.status.textColor'), [1, 1, 1]);
  vm.slash('map nav mulgore 1');
  // In an instance the arrow has nowhere to point: no column, the words and the bar from 10, and why where the
  // distance goes, in the grey of 1/3 (C-84); laid out again as soon as it happens, and back (C-85).
  vm.run('local n = NS.MapShared.navView; n.saved = { n.dist, n.bearing }; n.dist, n.bearing, n.where = nil, nil, "off the map"; NS.HUD.TickRoute()');
  assert.deepEqual(vm.json('{ NQAHUDBar.arrowZone.shown, NQAHUDBar.status.points.LEFT.x, NQAHUDBar.why.shown, NQAHUDBar.why.text, NQAHUDBar.why.points.RIGHT.x, NQAHUDBar.dist.shown, NQAHUDBar.segs[1].x, NQAHUDBar.height }'),
    [false, 10, true, 'off the map', -10, false, 10, 44]);
  vm.run('local n = NS.MapShared.navView; n.dist, n.bearing, n.where = n.saved[1], n.saved[2], nil; NS.HUD.TickRoute()');
  assert.deepEqual(vm.json('{ NQAHUDBar.arrowZone.shown, NQAHUDBar.status.points.LEFT.x, NQAHUDBar.why.shown, NQAHUDBar.dist.text, NQAHUDBar.segs[1].x }'), [true, 52, false, '60 yd', 52]);
  // News: what he says, and Okay; the arrow keeps pointing.
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Hi.\nMore.')] }));
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Hi. More.', 'news has the row: his words');
  assert.deepEqual([vm.evaluate('NQAHUDBar.arrow.shown'), vm.evaluate('NQAHUDBar.dist.shown'), vm.evaluate('NQAHUDBar.segs[1].shown')], ['true', 'false', 'true'],
    'the arrow keeps its column and the bar stays; the distance waits for Okay');
  assert.deepEqual(vm.json('{ NQAHUDBar.okBtn.shown, NQAHUDBar.okBtn.points.RIGHT.x }'), [true, -10], 'Okay at the row\'s end, 10 in as the rest (C-89)');
  vm.advance(0.2);
  assert.equal(vm.evaluate('NQAHUDBar.dist.shown'), 'false', 'and the arrow\'s ticks leave the row to him');
  assert.match(vm.evaluate('NS.HUD.h.tip'), /^Hi\.\nMore\./, 'all of his words are in the tooltip');
  vm.run('local b = NQAHUDBar.okBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'false');
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.dist.text')], ['The Hunt Continues', '60 yd'], 'the row is back');
  // The second click of a double one on Okay lands on the bar: it opens nothing.
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "LeftButton")');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'false', 'guarded, as the route\'s bar');
  vm.advance(0.5);
  // All of it: a click opens your chats, as his portrait; right-click the menu; a drag moves it.
  assert.equal(vm.evaluate('NQAHUDBar.mouse'), 'false', 'click-through, as the panel');
  assert.deepEqual(vm.json('{ NQAHUDBar.grip.points.TOPLEFT ~= nil, NQAHUDBar.grip.points.BOTTOMRIGHT ~= nil, NQAHUDBar.grip.points.BOTTOMRIGHT.x }'), [true, true, 0], 'the whole bar');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local g = NQAHUDBar.grip; g.scripts.OnEnter(g)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'NeverQuestAlone');
  assert.ok(vm.json('STUB.tip').includes('<Click to open your chats>'), 'his tooltip: what a click does');
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnDragStart(g); g.scripts.OnDragStop(g)');
  assert.equal(vm.evaluate('NQADB.settings.hudPoint'), 'CENTER');
  assert.equal(vm.evaluate('NQAHUDBar.anchor.rel == NQAHUD'), 'true');
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "LeftButton")');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'false', 'a drag is not a click');
  vm.advance(0.5);
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "LeftButton")');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(vm.evaluate('NS.UI.ui.list.shown'), 'true');
  vm.run('NS.UI.Toggle(false)');
  // The menu steps between the three: Show More (the panel), Show Less (the compass).
  const items = () => vm.json('(function() local o = {} for _, b in ipairs(NQAPopupMenu.items) do if b.shown then o[#o + 1] = b.label.text end end return o end)()');
  const pick = label => vm.run(`for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == ${JSON.stringify(label)} then b.scripts.OnClick(b) end end`);
  const menu = () => vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  menu();
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Show Less', 'Open Settings']);
  pick('Show Less');
  // The compass: the arrow and the distance, nothing else, as wide as they are.
  assert.deepEqual([vm.evaluate('NQADB.settings.hudMin'), vm.evaluate('NQADB.settings.hudCompass'), vm.evaluate('NQAHUDBar.shown')], ['true', 'true', 'true']);
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.shown'), vm.evaluate('NQAHUDBar.okBtn.shown'), vm.evaluate('NQAHUDBar.segs[1].shown')], ['false', 'false', 'false']);
  assert.deepEqual(vm.json('{ NQAHUDBar.arrow.shown, NQAHUDBar.dist.text, NQAHUDBar.dist.points.LEFT.x, NQAHUDBar.dist.points.LEFT.y }'), [true, '60 yd', 52, -22],
    'right at the arrow\'s column');
  // One width for any distance up to 9999 yd, so the arrow never hops as the digits change (C-86).
  const widest = vm.num('(function() local d = NQAHUDBar.dist; local t = d:GetText(); d:SetText("9999 yd"); local w = d:GetStringWidth(); d:SetText(t); return w end)()');
  assert.equal(vm.num('NQAHUDBar.width'), 52 + Math.ceil(widest) + 10, 'as wide as its widest distance');
  assert.equal(vm.num('NQAHUDBar.height'), 44);
  const compassW = vm.num('NQAHUDBar.width');
  for (const yd of [9, 999, 1165]) {
    vm.run(`NS.MapShared.navView.dist = ${yd}; NS.HUD.TickRoute()`);
    assert.equal(vm.num('NQAHUDBar.width'), compassW, `the same at ${yd} yd`);
  }
  vm.run('NS.MapShared.navView.dist = 60; NS.HUD.TickRoute()');
  // Into an instance: the arrow has nowhere to point, so the compass says why at once, and back (C-85).
  vm.run('local n = NS.MapShared.navView; n.saved = { n.dist, n.bearing }; n.dist, n.bearing, n.where = nil, nil, "off the map"; NS.HUD.TickRoute()');
  assert.deepEqual(vm.json('{ NQAHUDBar.status.shown, NQAHUDBar.status.text, NQAHUDBar.dist.shown, NQAHUDBar.arrowZone.shown, NQAHUDBar.height, NQAHUDBar.status.points.LEFT.x }'),
    [true, 'Off the map', false, false, 32, 10], 'why, on its own, capitalised');
  assert.equal(vm.num('NQAHUDBar.width'), 10 + Math.ceil(vm.num('NQAHUDBar.status:GetStringWidth()')) + 10);
  vm.run('local n = NS.MapShared.navView; n.dist, n.bearing, n.where = n.saved[1], n.saved[2], nil; NS.HUD.TickRoute()');
  assert.deepEqual(vm.json('{ NQAHUDBar.status.shown, NQAHUDBar.dist.shown, NQAHUDBar.dist.text, NQAHUDBar.arrowZone.shown, NQAHUDBar.height }'), [false, true, '60 yd', true, 44], 'out again');
  assert.equal(vm.num('NQAHUDBar.width'), compassW);
  // News in the compass: a toast, as with the HUD off; the compass stays the arrow and the distance (C-87).
  apply(vm, slotLua({ records: [replyRec(2, id, 'The ridge is north.')] }));
  assert.equal(vm.evaluate('NS.UI.ui.toastOrder[1].line.text'), 'The ridge is north.');
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.shown'), vm.evaluate('NQAHUDBar.okBtn.shown'), vm.evaluate('NQAHUDBar.dist.text')], ['false', 'false', '60 yd']);
  // Its tooltip names where the arrow points; its menu brings the bar back.
  vm.run('STUB.tip = {}; local g = NQAHUDBar.grip; g.scripts.OnEnter(g)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'The Hunt Continues');
  assert.ok(vm.json('STUB.tip').includes('Stop 1 of 3.'));
  assert.ok(vm.json('STUB.tip').includes('<Right-click for the menu>'));
  menu();
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Open Settings']);
  // In combat, the compass stays the compass (the bar only when you'd see more).
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.deepEqual([vm.evaluate('NQAHUDBar.shown'), vm.evaluate('NQAHUDBar.status.shown')], ['true', 'false']);
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  menu();
  pick('Show More');
  assert.deepEqual([vm.evaluate('NQADB.settings.hudMin'), vm.evaluate('NQADB.settings.hudCompass'), vm.evaluate('NQAHUDBar.status.text'), vm.num('NQAHUDBar.width')], ['true', 'false', 'The Hunt Continues', 272], 'the bar again');
  menu();
  pick('Show More');
  assert.deepEqual([vm.evaluate('NQADB.settings.hudMin'), vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['false', 'true', 'false'], 'the panel');
  // Forced to the bar (combat, the window open), Show More is still there (the owner: "it should always be something
  // the user can select and view"); the next test picks it.
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  menu();
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Show Less', 'Open Settings']);
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  // The commands.
  vm.slash('hud compass');
  assert.deepEqual([vm.evaluate('NQADB.settings.hudCompass'), vm.evaluate('NQAHUDBar.status.shown')], ['true', 'false']);
  assert.ok(vm.chatLines().some(l => l.includes('The HUD is on, as its compass.')));
  vm.slash('hud min');
  assert.deepEqual([vm.evaluate('NQADB.settings.hudCompass'), vm.evaluate('NQAHUDBar.status.shown')], ['false', 'true']);
  // With nothing to point to, no arrow: just the row, as short as it can be.
  vm.run('NQAMap.Stop(); NS.HUD.Render()');
  assert.deepEqual([vm.evaluate('NQAHUDBar.segs[1].shown'), vm.evaluate('NQAHUDBar.arrowZone.shown'), vm.evaluate('NQAHUDBar.dist.shown'), vm.evaluate('NQAHUDBar.status.text')], ['false', 'false', 'false', 'Ready']);
  assert.deepEqual([vm.num('NQAHUDBar.status.points.LEFT.x'), vm.num('NQAHUDBar.status.points.LEFT.y'), vm.num('NQAHUDBar.height')], [10, -16, 32]);
  // The compass with nothing to point to says so, in grey.
  vm.slash('hud compass');
  assert.deepEqual(vm.json('{ NQAHUDBar.status.text, NQAHUDBar.status.points.LEFT.x, NQAHUDBar.height }'), ['No route', 10, 32]);
  assert.deepEqual(vm.json('NQAHUDBar.status.textColor'), [0.6, 0.6, 0.6]);
  assert.equal(vm.num('NQAHUDBar.width'), 10 + Math.ceil(vm.num('NQAHUDBar.status:GetStringWidth()')) + 10);
  vm.slash('hud full');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true');
});

test('HUD: Show More is always in the bar\'s menu (the owner, 2026-09-27: "it should always be something the user can select and view even if something is pending"): folded to the bar by combat or the open window, it shows the whole panel now, and nothing folds it again while you look; Show Less or the panel\'s - puts the bar back; once the fight is over and the window closed, combat and the window fold it as before', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.send('where is the forge'); // NeverQuestAlone is on it: something pending
  vm.run('NS.UI.Toggle(false); NS.HUD.Render()');
  const shown = () => [vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')];
  const PANEL = ['true', 'false'], BAR = ['false', 'true'];
  const items = () => vm.json('(function() local o = {} for _, b in ipairs(NQAPopupMenu.items) do if b.shown then o[#o + 1] = b.label.text end end return o end)()');
  const pick = label => vm.run(`for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == ${JSON.stringify(label)} then b.scripts.OnClick(b) end end`);
  const barMenu = () => vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  const panelMenu = () => vm.run('local g = NS.HUD.h.grip; g.scripts.OnMouseUp(g, "RightButton")');
  const combat = on => vm.run(`STUB.combat = ${on}; STUB.FireEvent("${on ? 'PLAYER_REGEN_DISABLED' : 'PLAYER_REGEN_ENABLED'}")`);
  assert.deepEqual(shown(), PANEL);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Sending…');

  // Combat folds it to the bar; its menu still has Show More, and Show More shows the panel now.
  combat(true);
  assert.deepEqual(shown(), BAR);
  barMenu();
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Show Less', 'Open Settings']);
  pick('Show More');
  assert.deepEqual(shown(), PANEL, 'the whole panel, in combat');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Sending…', 'what is pending, in full');
  assert.equal(vm.evaluate('NQADB.settings.hudMin'), 'false');
  // Nothing folds it again while you look: a redraw, the window opening and closing.
  vm.run('NS.HUD.Render()');
  assert.deepEqual(shown(), PANEL);
  vm.run('NS.UI.Toggle(true)');
  assert.deepEqual(shown(), PANEL, 'the window opening');
  vm.run('NS.UI.Toggle(false)');
  assert.deepEqual(shown(), PANEL);
  // The panel's Show Less: the bar, remembered, as out of combat.
  panelMenu();
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show Less', 'Open Settings']);
  pick('Show Less');
  assert.deepEqual(shown(), BAR);
  assert.equal(vm.evaluate('NQADB.settings.hudMin'), 'true');
  // The bar as your form, in combat: Show More shows the panel too; its - puts the bar back.
  barMenu();
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Show Less', 'Open Settings']);
  pick('Show More');
  assert.deepEqual(shown(), PANEL);
  vm.run('local b = NS.HUD.h.minBtn; b.scripts.OnClick(b)');
  assert.deepEqual(shown(), BAR, 'the panel\'s -');
  assert.equal(vm.evaluate('NQADB.settings.hudMin'), 'true');
  // Show More, then the fight ends: the panel stays; the next fight folds it, as before.
  barMenu();
  pick('Show More');
  combat(false);
  assert.deepEqual(shown(), PANEL);
  combat(true);
  assert.deepEqual(shown(), BAR, 'the next fight folds it again');
  combat(false);
  assert.deepEqual(shown(), PANEL);

  // The window open folds it to the bar; Show More shows the panel beside the window.
  vm.run('NS.UI.Toggle(true)');
  assert.deepEqual(shown(), BAR);
  barMenu();
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Show Less', 'Open Settings']);
  pick('Show More');
  assert.deepEqual(shown(), PANEL, 'with the window open');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  combat(true);
  assert.deepEqual(shown(), PANEL, 'a fight starting doesn\'t fold it either');
  combat(false);
  // The window closed (no fight): next time the window opens, it folds it again.
  vm.run('NS.UI.Toggle(false)');
  assert.deepEqual(shown(), PANEL);
  vm.run('NS.UI.Toggle(true)');
  assert.deepEqual(shown(), BAR, 'folded again, as before');
  vm.run('NS.UI.Toggle(false)');

  // /nqa hud full asks for the panel the same way.
  combat(true);
  assert.deepEqual(shown(), BAR);
  vm.slash('hud full');
  assert.deepEqual(shown(), PANEL, '/nqa hud full, in combat');
  vm.slash('hud min');
  assert.deepEqual(shown(), BAR);
  combat(false);

  // Closed, a Show More from a fight isn't kept: /nqa hud on in the next fight shows the bar.
  vm.slash('hud full');
  combat(true);
  barMenu();
  pick('Show More');
  assert.deepEqual(shown(), PANEL);
  vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton")');
  combat(false);
  combat(true);
  vm.slash('hud on');
  assert.deepEqual(shown(), BAR, 'the fight folds it, as before');
  combat(false);
});

test('HUD: the bar with a route: no n/n count (the route\'s bar under the row shows where you are; the owner, 2026-09-27), the distance at the row\'s end, and a re-plan the row itself says ("Re-planning…" until the new route comes)', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, settings = { hudMin = true } }', extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator(); NS.HUD.Render()');
  assert.deepEqual([vm.evaluate('NQAHUDBar.shown'), vm.evaluate('NQAHUDBar.count'), vm.evaluate('NQAHUDBar.segs[1].shown'), vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.dist.text')],
    ['true', null, 'true', 'The Hunt Continues', '60 yd']);
  // The distance where the count was: the row's end, 10 in; the quest name up to it.
  assert.deepEqual(vm.json('{ NQAHUDBar.dist.points.RIGHT.x, NQAHUDBar.status.points.RIGHT.relPoint, NQAHUDBar.status.anchor.rel == NQAHUDBar.dist }'), [-10, 'LEFT', true]);
  // A re-plan: "Asking: a new route" for its 3 s, then the row says "Re-planning…" while NeverQuestAlone isn't busy, until the new route.
  vm.run('NS.HUD.Replan(); NS.HUD.Render()');
  assert.match(vm.evaluate('NQAHUDBar.status.text'), /^Asking: a new route/);
  vm.advance(3.1);
  const id = vm.evaluate('NS.HUD.View().chat or NQADB.activeChat');
  vm.run('for _, c in ipairs(NQADB.chats) do c.pending = {} end; NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.View().replanning'), 'true');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Re-planning…', 'the click\'s feedback, where 1/3 used to say …');
  // The panel's heading says it too, and the panel keeps its count (only the bar had it twice).
  vm.run('NS.HUD.SetForm("full")');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.routeCount.text'), 'Re-planning…');
});

test('HUD: at login the bridge\'s last word is from before the game started: until this session\'s hello is answered the light waits ("Connecting…"), never a false red "Can\'t reach the bridge" that flips to Ready and moves the panel; a bridge that never answers is red after 2 min, as before', () => {
  const inbox = age => `NQA_Inbox = { v = 2, ts = "x", now = time() - ${age}, token = "old", bridge = { ver = "1.4.0", push = 0, acked = {} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = {}, chats = {}, records = {} }`;
  // An hour idle: the first frame waits, then Ready, and nothing under the header moves (C-106): "Connecting…" has
  // the same "Last time: …" line "Ready" gets.
  const last = src => src.match(/const last = '(\{"v":1,"kind":"session".*?)';/)[1];
  const LAST = last(require('node:fs').readFileSync(__filename, 'utf8'));
  const vm = newVM({ db: `NQADB = { hudIntro = true, firstReply = true, companion = { lastSession = ${lstr(LAST)} } }`, inbox: inbox(3600) }).login();
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.Transport.Light()'), 'wait');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Connecting…');
  assert.match(vm.evaluate('NS.HUD.h.sub.text'), /^Last time: /);
  assert.equal(vm.evaluate('select(2, NS.Transport.Light())'), 'Waiting to hear from the NeverQuestAlone app…', 'one ellipsis character (STYLE)');
  const y = vm.num('NS.HUD.h.mainY');
  confirmHello(vm);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.Transport.Light()'), 'green');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.match(vm.evaluate('NS.HUD.h.sub.text'), /^Last time: /);
  assert.equal(vm.num('NS.HUD.h.mainY'), y, 'nothing moved');
  // A bridge that never answers: red 2 min after login, with how long it has been silent.
  const dead = newVM({ db: WELCOMED, inbox: inbox(3600) }).login();
  dead.advance(60);
  dead.run('NS.HUD.Render()');
  assert.equal(dead.evaluate('NS.Transport.Light()'), 'wait', 'a minute in: still waiting');
  dead.advance(61);
  dead.run('NS.HUD.Render()');
  assert.equal(dead.evaluate('NS.Transport.Light()'), 'red');
  assert.equal(dead.evaluate('NS.HUD.h.status.text'), 'Can\'t reach the NeverQuestAlone app');
  assert.match(dead.evaluate('select(2, NS.Transport.Light())'), /^No word from the NeverQuestAlone app for 1 hour \d minutes?\. Is it running\?/, 'its real silence');
  // A fresh inbox (the bridge just published): green at once, as before.
  const fresh = newVM({ db: WELCOMED, inbox: inbox(5) }).login();
  fresh.run('NS.HUD.Render()');
  assert.equal(fresh.evaluate('NS.Transport.Light()'), 'green');
});

test('HUD: a reply held by Quiet in Combat (C-104): the panel and the bar say "Reply after the fight", with what you asked, not "Ready"; it shows when the fight ends', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const id = activeId(vm);
  vm.send('where is the forge');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  vm.run('NS.UI.Toggle(false)');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  vm.run('for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == "Show More" then b.scripts.OnClick(b) end end');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true');
  apply(vm, slotLua({ records: [replyRec(1, id, 'In Ironforge: the Great Forge.')] }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.num('#NS.R.dndQueue'), 1, 'held: Quiet in Combat is on');
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text')], ['Reply after the fight', 'NeverQuestAlone answered; it shows when the fight ends.']);
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 1, 1], 'white: news waits, quietly');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), '|cffffd100You asked:|r where is the forge', 'what you asked stays');
  assert.deepEqual([vm.evaluate('NS.HUD.h.stopBtn.shown'), vm.evaluate('NS.HUD.h.routeAskBtn.shown')], ['false', 'false'], 'no Stop (it\'s done), no "No route yet"');
  // The bar, the same.
  vm.run('local b = NS.HUD.h.minBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Reply after the fight');
  // The fight ends: the reply shows.
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(1.2);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'In Ironforge: the Great Forge.');
});

test('HUD: a held error says so (C-107), and a reply the window already shows isn\'t "after the fight"', () => {
  function fighting(open) {
    const vm = confirmHello(newVM({ db: WELCOMED }).login());
    vm.send('where is the forge');
    vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
    vm.run(`NS.UI.Toggle(${open})`);
    vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
    return vm;
  }
  const vm = fighting(false);
  apply(vm, slotLua({ records: [errorRec(1, activeId(vm), 'gateway', null, 'The service is unreachable.')] }));
  vm.run('NS.HUD.Render()');
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text'), vm.evaluate('NQAHUDBar.status.text')],
    ['Error after the fight', 'Something went wrong; it shows when the fight ends.', 'Error after the fight']);
  // The window open on that chat: the reply is there already; the HUD says nothing is waiting.
  const w = fighting(true);
  apply(w, slotLua({ records: [replyRec(1, activeId(w), 'In Ironforge.')] }));
  w.run('NS.HUD.Render()');
  assert.notEqual(w.evaluate('NS.HUD.h.status.text'), 'Reply after the fight');
  assert.equal(w.evaluate('NS.HUD.h.status.text'), 'Ready');
});

test('HUD: a Re-plan waiting its 3 s when a fight starts (C-105): taken back only when the fight folds the panel; with the panel held (Show More) its Undo stays and it sends', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator(); NS.UI.Toggle(true)');
  const replans = () => vm.outboxWires().filter(e => /Re-plan my route/.test(e.wire)).length;
  // The window open folds the panel; Show More holds it.
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  vm.run('for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == "Show More" then b.scripts.OnClick(b) end end');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true');
  vm.run('local b = NS.HUD.h.replanIcon; b.scripts.OnClick(b, "LeftButton")');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true', 'still up');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Asking: a new route', 'not taken back');
  assert.equal(vm.evaluate('NS.HUD.h.replanIcon.icon.atlas'), 'common-icon-undo', 'its Undo still under the pointer');
  vm.advance(3.1);
  assert.equal(replans(), 1, 'sent at 3 s');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
});

test('HUD: a closed HUD\'s route bar: Show More in a fight brings the whole panel back, now', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator()');
  vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton")');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['false', 'true'], 'the route\'s bar');
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  vm.run('for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == "Show More" then b.scripts.OnClick(b) end end');
  assert.deepEqual([vm.evaluate('NQADB.settings.hud'), vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['true', 'true', 'false'], 'the panel, in combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
});

test('HUD: each quest\'s name is as the game\'s quest log and tracker show it (the owner): in its colour for its level against yours when the map\'s quest-difficulty filter is on, "[12]" before it when you show levels or use colourblind mode (C-78); gold where no colour is set', () => {
  const GAME = `STUB.cvar = { showQuestDifficultyColor = true, showQuestLevel = false, colorblindMode = false }
STUB.diff = { [761] = 4 }
local colours = { [1] = "40bf40", [4] = "ff1a1a" }
-- The game's own (DifficultyUtil.lua), over the stub's CVars.
function SetQuestTitleLevelAndDifficultyColor(id, title)
  if STUB.cvar.showQuestLevel or (STUB.cvar.colorblindMode and STUB.cvar.showQuestDifficultyColor) then title = "[12] " .. title end
  if STUB.cvar.showQuestDifficultyColor then title = "|cff" .. (colours[STUB.diff[id]] or "ffd100") .. title .. "|r" end
  return title
end`;
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB + GAME }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  const draw = () => vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 25); NQAMap.UpdateNavigator(); NS.HUD.Render()');
  draw();
  assert.equal(vm.evaluate('NS.HUD.h.qTitles[1].text'), '|cffff1a1aThe Hunt Continues|r', 'far above you: red, as the tracker has it');
  vm.run('STUB.diff[761] = 1'); draw();
  assert.equal(vm.evaluate('NS.HUD.h.qTitles[1].text'), '|cff40bf40The Hunt Continues|r', 'after a ding, easy: green');
  assert.match(vm.evaluate('NQANavigator.quests.text'), /^\|cff40bf40The Hunt Continues\|r/, 'the map\'s quest lines too');
  // Colours off in the game: no colour, the tracker's header gold.
  vm.run('STUB.cvar.showQuestDifficultyColor = false'); draw();
  assert.equal(vm.evaluate('NS.HUD.h.qTitles[1].text'), 'The Hunt Continues');
  assert.deepEqual(vm.json('NS.HUD.h.qTitles[1].textColor'), [1, 0.82, 0]);
  assert.match(vm.evaluate('NQANavigator.quests.text'), /^\|cffffd100The Hunt Continues\|r/);
  // Levels shown (or colourblind mode): "[12]" before it.
  vm.run('STUB.cvar.showQuestLevel = true'); draw();
  assert.equal(vm.evaluate('NS.HUD.h.qTitles[1].text'), '[12] The Hunt Continues');
});

test('tooltips: one shape everywhere (the owner): the title white, what it does in gold, content in white, what the mouse does in green <brackets>, a note in grey', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.run(`STUB.lines = {}
local t = { SetText = function(self, text, r, g, b) table.insert(STUB.lines, { text, r, g, b }) end, AddLine = function(self, text, r, g, b) table.insert(STUB.lines, { text, r, g, b }) end }
NS.TipLines(t, { title = "End Route", key = "E", text = "Stops following this route.", lines = { "a stop" }, actions = { "Click to go here" }, note = "/nqa map nav" })`);
  assert.deepEqual(vm.json('STUB.lines'), [
    ['End Route |cffffd100(E)|r', 1, 1, 1],
    ['Stops following this route.', 1, 0.82, 0],
    ['a stop', 1, 1, 1],
    ['<Click to go here>', 0.1, 1, 0.1],
    ['/nqa map nav', 0.5, 0.5, 0.5],
  ]);
  // The HUD's, the window's and the map's all go through it: titles in Title Case.
  const title = (lua) => { vm.run(`STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; ${lua}`); return vm.evaluate('GameTooltip.text'); };
  assert.equal(title('local b = NS.HUD.h.minBtn; b.scripts.OnEnter(b)'), 'Minimize');
  assert.equal(title('local b = NS.HUD.h.closeBtn; b.scripts.OnEnter(b)'), 'Close HUD');
  assert.equal(title('local b = NS.HUD.h.askBtn; b.scripts.OnEnter(b)'), 'Ask');
  assert.equal(title('local b = NS.HUD.h.grip; b.scripts.OnEnter(b)'), 'NeverQuestAlone HUD');
  assert.deepEqual(vm.list('STUB.tip').filter(l => /^</.test(l)), ['<Drag to move the HUD>', '<Right-click for the menu>']);
  assert.equal(title('local b = NS.HUD.h.portraitBtn; b.scripts.OnEnter(b)'), 'NeverQuestAlone');
  assert.ok(vm.list('STUB.tip').includes('<Click to open your chats>'));
  vm.slash('');
  assert.equal(title('local b = NS.UI.ui.listBtn; b.scripts.OnEnter(b)'), 'Show Chats');
  assert.equal(title('local b = NS.UI.ui.thinkBtn; b.scripts.OnEnter(b)'), 'Thinking');
  assert.equal(title('local t = NS.UI.ui.ctx.toggle; t.scripts.OnEnter(t)'), 'Game Data');
  assert.equal(title('local l = NQALight; l.scripts.OnEnter(l)'), 'Connection');
});

test('HUD: by default it docks left of the quest tracker, level with its top, and follows it (right of it when the tracker sits too far left)', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: 'ObjectiveTrackerFrame = CreateFrame("Frame", "ObjectiveTrackerFrame"); STUB.trackerLeft = 1100; function ObjectiveTrackerFrame:GetLeft() return STUB.trackerLeft end' }).login());
  const anchor = () => vm.json('{ NQAHUD.anchor.point, NQAHUD.anchor.relPoint, NQAHUD.x, NQAHUD.y, NQAHUD.anchor.rel == ObjectiveTrackerFrame }');
  assert.deepEqual(anchor(), ['TOPRIGHT', 'TOPLEFT', -12, 0, true]);
  vm.run('STUB.trackerLeft = 200; STUB.FireEvent("EDIT_MODE_LAYOUTS_UPDATED")');
  assert.deepEqual(anchor(), ['TOPLEFT', 'TOPRIGHT', 12, 0, true]);
  // The small bar docks the same way when the HUD is off.
  vm.slash('hud off');
  assert.equal(vm.evaluate('NQAMini.anchor.rel == ObjectiveTrackerFrame'), 'true');
});

test('HUD: Ask opens its box right here, taller than a line and in the chat font; Enter sends to your Quick questions chat; open, Ask is the box\'s X: a click puts it away, your words kept', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const first = activeId(vm);
  vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox:HasFocus()'), 'true', 'one click, and you type');
  assert.equal(vm.evaluate('NS.HUD.h.replyHint.text'), 'Ask anything: Enter sends, Esc closes');
  assert.equal(vm.num('NS.HUD.h.replyBox.height'), 28, 'room to type');
  assert.equal(vm.evaluate('NS.HUD.h.asks'), null, 'no ready-made asks (the owner, 2026-09-26)');
  assert.equal(activeId(vm), first, 'the window stays on the chat you had');
  vm.run('local b = NS.HUD.h.replyBox; b:SetText("any good fishing here?"); b.scripts.OnEnterPressed(b)');
  assert.ok(sentText(vm, 'any good fishing here?'));
  assert.equal(vm.evaluate('NS.Chats.Find(NS.HUD.h.replyBox.chatId).name'), 'Quick questions');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'false');
  // Open again: Ask turns into the box's X (the owner), a bare gold X, the route icons' kind (not a red one like the corner's close, C-73).
  vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'true');
  assert.deepEqual([vm.evaluate('NS.HUD.h.askBtn.shown'), vm.evaluate('NS.HUD.h.askClose.shown'), vm.evaluate('NS.HUD.h.askClose.icon.atlas')], ['false', 'true', 'common-icon-yellowx'], 'the button turns into the box\'s X');
  assert.deepEqual(vm.json('{ NS.HUD.h.askClose.anchor.point, NS.HUD.h.askClose.x, NS.HUD.h.askClose.y }'), ['RIGHT', -10, -47], 'its glyph on the gutter, level with where Ask was');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local b = NS.HUD.h.askClose; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Close Box');
  // Typed, the X puts the box away and sends nothing; your words wait for next time.
  vm.run('NS.HUD.h.replyBox:SetText("and the wolves?"); local b = NS.HUD.h.askClose; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'false', 'the X puts it away');
  assert.ok(!sentText(vm, 'and the wolves?'), 'nothing sent: an X closes');
  assert.deepEqual([vm.evaluate('NS.HUD.h.askBtn.shown'), vm.evaluate('NS.HUD.h.askClose.shown')], ['true', 'false'], 'Ask again');
  vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox:GetText()'), 'and the wolves?', 'your words kept');
});

test('HUD: the header row grows to two lines rather than cutting a line; a long run and a lasting error stay whole: nothing dims or folds on a timer', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const top = () => vm.num('NS.HUD.h.mainY');
  const before = top();
  vm.run('NS.HUD.h.status.GetStringHeight = function(self) return #(rawget(self, "text") or "") > 30 and 28 or 14 end');
  vm.run('NS.HUD.Flash("Something went wrong in a chat with a long name", "And a second line.")');
  assert.equal(vm.num('NS.HUD.h.status.maxLines'), 2);
  assert.ok(top() > before, 'the header row grew');
  vm.advance(6.1);
  vm.run('NS.HUD.Tick(0.1)');
  assert.equal(top(), before, 'and back');
  vm.send('plan my whole evening');
  const key = vm.outboxWires().pop().key;
  vm.slot(slotLua({ acked: [key], nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm);
  vm.advance(1.6);
  vm.run('STUB.onLoadAddOn = nil; NS.HUD.Render()');
  vm.advance(60);
  vm.run('NS.HUD.Tick(0.1)');
  assert.equal(vm.num('NQAHUD.alpha'), 1);
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), '|cffffd100You asked:|r plan my whole evening');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.shown'), 'true', 'Stop stays where it was');
  vm.run('NS.Transport.Light = function() return "red", "tip" end; NS.Transport.BridgeAge = function() return 300 end; NS.Chats.Stop(); NS.R.stopAt = {}; for _, c in ipairs(NQADB.chats) do c.pending = {} end; NS.HUD.Render()');
  vm.advance(60);
  vm.run('NS.HUD.Tick(0.1)');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), "Can't reach the NeverQuestAlone app");
  assert.equal(vm.num('NQAHUD.alpha'), 1);
});

test('HUD: a long TL;DR shows four lines, all of it in the portrait\'s tooltip and the window; with a route, all of it at your opacity', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator()');
  const id = activeId(vm);
  const long = 'Go north to the Crossroads, hand in the two quests there, then take the road west; and tell me if you want the Barrens route too.';
  apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id}", mid = "m1", agent = "main", text = ${lstr(long)}, summary = ${lstr(long)}, more = 0 }`] }));
  assert.equal(vm.num('NS.HUD.h.body.maxLines'), 4);
  assert.equal(vm.evaluate('NS.HUD.h.tip'), long, 'the whole of it in the portrait\'s tooltip');
  vm.advance(30);
  vm.run('NS.HUD.Tick(0.1)');
  assert.equal(vm.num('NQAHUD.alpha'), 1);
  assert.equal(vm.num('NS.HUD.h.body.maxLines'), 4, 'the pointer changes nothing');
});

test('HUD: the box you type in stays through combat and the window opening, until Enter or Esc; a send that fails says why', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")');
  vm.run('NS.HUD.h.replyBox:SetText("half typed")');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'true', 'combat folds the HUD, not the box');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true', 'the panel stays for it');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox:HasFocus()'), 'true');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED"); NS.UI.Toggle(true)');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'true', 'nor does the window');
  vm.run('NS.UI.Toggle(false)');
  vm.run(`local b = NS.HUD.h.replyBox; b:SetText(string.rep("x", 3000)); b.scripts.OnEnterPressed(b)`);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Not sent');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Too long: split it into shorter messages.');
  assert.equal(vm.num('#NS.HUD.h.replyBox:GetText()'), 3000, 'your words stay');
});

test('HUD: the route you follow: its name, 1/3 and two icons, Re-plan and End; the bar marks where you are and each part goes to its stop; the minimap\'s arrow with the stop, its distance and which way; what to do; each quest\'s objectives as a list with your counts; the navigator\'s box steps aside', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator()');
  assert.equal(vm.evaluate('NS.HUD.h.routeTitle.text'), 'Mulgore quests');
  assert.equal(vm.evaluate('NS.HUD.h.routeTitle.style'), 'H');
  assert.equal(vm.evaluate('NS.HUD.h.routeCount.text'), '1/3');
  assert.equal(vm.evaluate('NS.HUD.h.routeTitle.anchor.rel == NS.HUD.h.routeCount'), 'true', 'a long name stops short of the count');
  // Only Re-plan and End, two icons of one kind at the heading's right (the owner: not buttons).
  assert.deepEqual([vm.evaluate('NS.HUD.h.replanIcon.shown'), vm.evaluate('NS.HUD.h.endIcon.shown')], ['true', 'true']);
  assert.deepEqual([vm.evaluate('NS.HUD.h.replanIcon.icon.atlas'), vm.evaluate('NS.HUD.h.endIcon.icon.atlas')], ['common-icon-rotateright', 'common-icon-yellowx'], 'the game\'s common icons');
  assert.deepEqual(vm.json('NS.HUD.h.replanIcon.icon.vcolor'), vm.json('NS.HUD.h.endIcon.icon.vcolor'), 'one gold for both');
  assert.deepEqual([vm.evaluate('NS.HUD.h.routeCount.anchor.rel == NS.HUD.h.replanIcon'), vm.evaluate('NS.HUD.h.replanIcon.anchor.rel == NS.HUD.h.endIcon')], ['true', 'true'], '1/3, Re-plan, End');
  assert.deepEqual(vm.json('{ NS.HUD.h.endIcon.anchor.point, NS.HUD.h.endIcon.x }'), ['TOPRIGHT', -10], 'End\'s glyph on the gutter');
  assert.deepEqual([vm.evaluate('NS.HUD.h.skip'), vm.evaluate('NS.HUD.h.replanBtn'), vm.evaluate('NS.HUD.h.endRoute')], [null, null, null], 'no buttons, no Skip');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local b = NS.HUD.h.endIcon; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'End Route');
  // Each part of the bar goes to its stop, ahead or back (the owner); its tooltip names it.
  const part = i => vm.run(`local b = NS.HUD.h.segs.hit[${i}]; b.scripts.OnClick(b, "LeftButton"); NQAMap.UpdateNavigator(); NS.HUD.Render()`);
  assert.deepEqual([1, 2, 3].map(i => vm.evaluate(`NS.HUD.h.segs.hit[${i}].shown`)), ['true', 'true', 'true']);
  vm.run('local b = NS.HUD.h.segs.hit[2]; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), '3. Harken: Swoop Hunting');
  part(3);
  assert.deepEqual([vm.evaluate('NS.HUD.h.routeCount.text'), vm.evaluate('NS.HUD.h.stop.text')], ['3/3', '4. Far stop'], 'ahead');
  // Back to a stop that's done (its quest turned in): held there, not passed over.
  vm.run('STUB.done[766] = true');
  part(2);
  for (let i = 0; i < 3; i++) vm.run('NQAMap.UpdateNavigator()');
  assert.equal(vm.evaluate('NS.HUD.h.routeCount.text'), '2/3', 'back, and it stays: you chose it');
  vm.run('STUB.done[766] = nil');
  part(1);
  assert.deepEqual([vm.evaluate('NS.HUD.h.routeCount.text'), vm.evaluate('NS.HUD.h.stop.text')], ['1/3', '2. Wolves and plainstriders'], 'back to the start');
  // Straight after Okay a part lets the click pass (C-72), as the red buttons do.
  vm.run('NS.HUD.h.guardUntil = GetTime() + 0.4');
  part(3);
  assert.equal(vm.evaluate('NS.HUD.h.routeCount.text'), '1/3', 'guarded');
  vm.run('NS.HUD.h.guardUntil = nil');
  assert.equal(vm.evaluate('NS.HUD.h.stop.text'), '2. Wolves and plainstriders');
  assert.equal(vm.evaluate('NS.HUD.h.stop.style'), 'P');
  assert.equal(vm.num('NS.HUD.h.stop.x'), 68, 'right of the arrow');
  assert.deepEqual([vm.num('NS.HUD.h.arrowZone.width'), vm.num('NS.HUD.h.arrow.width')], [48, 44], 'a big arrow (28 read too small in game)');
  assert.equal(vm.evaluate('NS.HUD.h.arrow.texture'), 'Interface\\Minimap\\MinimapArrow', 'the minimap\'s own arrow, no disc around it');
  assert.equal(vm.evaluate('NS.HUD.h.arrow.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.dist.text'), '60');
  assert.equal(vm.evaluate('NS.HUD.h.dist.style'), 'V');
  assert.match(vm.evaluate('NS.HUD.h.distMeta.text'), /^yd · (ahead|to your (left|right)|behind you|(ahead|behind), (left|right))$/, 'and which way, in words');
  assert.equal(vm.evaluate('NS.HUD.h.note.text'), 'Kill 8 Prairie Wolves and 6 Plainstriders; loot 8 Prairie Wolf Paws.');
  assert.equal(vm.evaluate('NS.HUD.h.note.style'), 'B');
  // The objectives: the quest's name (gold), then a bullet, the words and the count at the right.
  assert.equal(vm.evaluate('NS.HUD.h.qTitles[1].text'), 'The Hunt Continues');
  assert.equal(vm.evaluate('NS.HUD.h.qTitles[1].style'), 'L');
  assert.deepEqual(vm.json('{ NS.HUD.h.qRows[1].text.text, NS.HUD.h.qRows[1].count.text, NS.HUD.h.qRows[1].count.justifyH }'), ['Prairie Wolf Paw', '3/8', 'RIGHT']);
  assert.equal(vm.evaluate('NS.HUD.h.qRows[1].mark.shown'), 'true', 'a bullet');
  assert.deepEqual(vm.json('NS.HUD.h.segs[1].color'), [1, 0.82, 0, 1], 'where you are: bright gold');
  assert.equal(vm.evaluate('NS.HUD.h.segEdge.shown'), 'true', 'with a white edge');
  assert.deepEqual(vm.json('NS.HUD.h.segs[2].color'), [0.35, 0.29, 0.2, 1], 'still to come');
  assert.equal(vm.evaluate('NQANavigator.shown'), 'false', 'the HUD shows the route');
  assert.equal(vm.evaluate('NQANavigator.title.text'), '1/3  2. Wolves and plainstriders', 'the box keeps its texts');
  assert.equal(vm.num('NQAHUD.alpha'), 1);
  // Closed (its X) or off, the HUD still shows the route, on its own bar: only the way there, and a right-click
  // menu whose Show More brings the HUD back (the owner: "no way to expand this"). The navigator's box stays away.
  vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton")');
  vm.run('NQAMap.UpdateNavigator()');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown'), vm.evaluate('NQANavigator.shown'), vm.evaluate('NQADB.settings.hud')],
    ['false', 'true', 'false', 'false']);
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.count'), vm.evaluate('NQAHUDBar.segs[1].shown'), vm.evaluate('NQAHUDBar.arrowZone.shown')],
    ['The Hunt Continues', null, 'true', 'true']);
  // Its tooltip: where the arrow points, then what to do there (the words the bar leaves out).
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local g = NQAHUDBar.grip; g.scripts.OnEnter(g)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'The Hunt Continues');
  assert.ok(vm.json('STUB.tip').some(l => l.includes('Kill 8 Prairie Wolves and 6 Plainstriders')), JSON.stringify(vm.json('STUB.tip')));
  assert.ok(vm.json('STUB.tip').some(l => l.includes('The HUD is closed: Show More in the menu brings it back.')));
  // A reply while it's closed is a toast; the bar stays the route's.
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'The raptors are east.')] }));
  assert.deepEqual([vm.evaluate('NS.UI.ui.toastOrder[1].line.text'), vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.okBtn.shown')],
    ['The raptors are east.', 'The Hunt Continues', 'false']);
  // Right-click: the menu, never a step along the route.
  const items = () => vm.json('(function() local o = {} for _, b in ipairs(NQAPopupMenu.items) do if b.shown then o[#o + 1] = b.label.text end end return o end)()');
  const pick = label => vm.run(`for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == ${JSON.stringify(label)} then b.scripts.OnClick(b) end end`);
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Show Less', 'Open Settings']);
  assert.equal(vm.num('NQAMapDB.nav.index'), 1, 'still the first stop');
  // Show Less: the compass, still closed; its Show More brings the HUD back as the bar.
  pick('Show Less');
  assert.deepEqual([vm.evaluate('NQADB.settings.hud'), vm.evaluate('NQAHUDBar.status.shown'), vm.evaluate('NQAHUDBar.dist.shown')], ['false', 'false', 'true']);
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  assert.deepEqual(items(), ['Open Your Chats', "Ask What's Next", 'Show More', 'Open Settings']);
  pick('Show More');
  assert.deepEqual([vm.evaluate('NQADB.settings.hud'), vm.evaluate('NQADB.settings.hudMin'), vm.evaluate('NQADB.settings.hudCompass'), vm.evaluate('NQAHUDBar.status.text')],
    ['true', 'true', 'false', 'The Hunt Continues'], 'the HUD is back, as the bar (the reply was its toast\'s: one place shows it)');
  // Off (not closed) from the bar: the small bar stands in, and the route's bar sits under it, where the
  // navigator's box did, one width with it, so neither covers the other (C-92).
  vm.advance(0.5);
  vm.slash('hud off');
  assert.deepEqual(vm.json('{ NQAMini.shown, NQAHUDBar.shown, NQAHUDBar.anchor.rel == NQAMini, NQAHUDBar.anchor.point, NQAHUDBar.anchor.relPoint, NQAHUDBar.points.TOPRIGHT.y, NQAMini.width, NQAHUDBar.width }'),
    [true, true, true, 'TOPRIGHT', 'BOTTOMRIGHT', -6, 272, 272]);
  // The window opening hides the small bar, not the route bar's slot under it (C-93).
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  assert.deepEqual(vm.json('{ NQAMini.shown, NQAHUDBar.anchor.rel == NQAMini }'), [false, true]);
  vm.run('NS.UI.Toggle(false); NS.Refresh("all")');
  assert.deepEqual(vm.json('{ NQAMini.shown, NQAHUDBar.anchor.rel == NQAMini }'), [true, true]);
  // Its Show More: the whole panel, and the bar back on the panel's edge.
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  pick('Show More');
  assert.deepEqual([vm.evaluate('NQADB.settings.hud'), vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['true', 'true', 'false'], 'from the closed bar: all of it');
  assert.deepEqual(vm.json('{ NQAMini.shown, NQAHUDBar.anchor.rel == NQAHUD }'), [false, true]);
  // The route moves on with its own ticker even while the box is hidden.
  vm.slash('hud on');
  vm.run('STUB.log[1].complete = true; STUB.FireEvent("QUEST_LOG_UPDATE"); local d = NQAMap.driver; d.scripts.OnUpdate(d, 0.2)');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2);
  vm.run('local d = NQAMap.driver; d.scripts.OnUpdate(d, 0.2)'); // the next tick draws the new stop
  assert.deepEqual(vm.json('NS.HUD.h.segs[1].color'), [0.78, 0.62, 0.1, 1], 'done');
  // A part of the bar ahead, then End.
  vm.run('NS.HUD.Render(); local b = NS.HUD.h.segs.hit[3]; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.num('NQAMapDB.nav.index'), 3, 'went ahead a stop');
  assert.equal(vm.evaluate('NS.HUD.h.routeCount.text'), '3/3');
  vm.run('local b = NS.HUD.h.endIcon; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NQAMapDB.nav'), null);
  assert.equal(vm.evaluate('NS.MapShared.navView'), null);
  assert.deepEqual([vm.evaluate('NS.HUD.h.endIcon.shown'), vm.evaluate('NS.HUD.h.segs.hit[1].shown')], ['false', 'false'], 'no route, no route block');
  assert.equal(vm.evaluate('NS.HUD.h.qRows[1].mark.shown'), 'false', 'nor its list');
  // /nqa map nav, with nothing named, follows the route you last followed.
  vm.slash('map nav');
  assert.equal(vm.evaluate('NQAMapDB.nav.layer'), 'mulgore');
  assert.equal(vm.outboxWires().filter(e => /Map nav/.test(e.wire)).length, 0, 'not sent to NeverQuestAlone');
});

test('HUD: the arrow turns green when you get there and hides with no bearing; which way reads from where you face; a stop\'s words say "approx" once, after the distance; done objectives are checked and grey, a ready quest is green, and an objective its note already says is not said again', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  vm.run(`NS.MapShared.navView = { layer = "barrens", title = "Barrens loop", index = 2, total = 2, gen = 1, rev = 1,
    label = "2. Forgotten Pools (approx)", note = "Approx Classic coords. Explore the waters of the Forgotten Pools.",
    quests = { { id = 1, title = "The Forgotten Pools", state = "active", objectives = { { text = "Explore the waters of the Forgotten Pools", finished = false } } },
      { id = 2, title = "Raptor Thieves", state = "active", objectives = { { text = "1/12 Raptor Head", finished = false }, { text = "Sunscale Scytheclaw slain: 5/5", finished = true } } },
      { id = 3, title = "Fungal Spores", state = "ready", what = "complete, turn it in", objectives = {} } },
    dist = 758, bearing = 1 }; NS.HUD.Render()`);
  assert.equal(vm.evaluate('NS.HUD.h.stop.text'), '2. Forgotten Pools');
  assert.equal(vm.evaluate('NS.HUD.h.note.text'), 'Explore the waters of the Forgotten Pools.');
  assert.equal(vm.evaluate('NS.HUD.h.distMeta.text'), 'yd · ahead, left · approx.', 'facing north, a stop 57° to the left');
  const rows = () => vm.json('(function() local o = {} for _, r in ipairs(NS.HUD.h.qRows) do if r.text.shown then o[#o + 1] = { r.text.text, r.count.shown and r.count.text or "" } end end return o end)()');
  assert.deepEqual(vm.json('(function() local o = {} for _, t in ipairs(NS.HUD.h.qTitles) do if t.shown then o[#o + 1] = t.text end end return o end)()'), ['Raptor Thieves'],
    'The Forgotten Pools has nothing the note doesn\'t say');
  assert.deepEqual(rows(), [['Raptor Head', '1/12'], ['Sunscale Scytheclaw', '5/5'], ['Fungal Spores', 'turn in']], 'without "slain"; the count on its own');
  assert.deepEqual(vm.json('NS.HUD.h.qRows[1].text.textColor'), [0.8, 0.8, 0.8]);
  assert.deepEqual(vm.json('NS.HUD.h.qRows[2].text.textColor'), [0.6, 0.6, 0.6], 'done: grey');
  assert.equal(vm.evaluate('NS.HUD.h.qRows[2].mark.atlas'), 'ui-questtracker-tracker-check', 'and checked, as the quest tracker does');
  assert.equal(vm.evaluate('NS.HUD.h.qRows[1].mark.atlas'), 'ui-questtracker-objective-nub', 'the tracker\'s own bullet');
  assert.deepEqual(vm.json('NS.HUD.h.qRows[3].text.textColor'), [0.1, 1, 0.1], 'ready: green');
  assert.deepEqual(vm.json('NS.HUD.h.arrow.vcolor'), [1, 1, 1, 1], 'the minimap arrow\'s own silver, untinted (the owner: "silver/ white")');
  assert.equal(vm.num('NS.HUD.h.arrow.rotation'), 1, 'turned to the stop');
  vm.run('NS.MapShared.navView.dist = 12; NS.HUD.TickRoute()');
  assert.deepEqual(vm.json('NS.HUD.h.arrow.vcolor'), [0.1, 1, 0.1, 1], 'there: green');
  assert.equal(vm.evaluate('NS.HUD.h.dist.text'), '12');
  vm.run('NS.MapShared.navView.bearing = math.pi; NS.HUD.TickRoute()');
  assert.equal(vm.evaluate('NS.HUD.h.distMeta.text'), 'yd · behind you · approx.');
  vm.run('NS.MapShared.navView.bearing = -math.pi / 2; NS.HUD.TickRoute()');
  assert.equal(vm.evaluate('NS.HUD.h.distMeta.text'), 'yd · to your right · approx.');
  vm.run('local n = NS.MapShared.navView; n.saved = { n.dist, n.bearing }; n.dist, n.bearing, n.where = nil, nil, "on another continent"; NS.HUD.TickRoute()');
  assert.equal(vm.evaluate('NS.HUD.h.arrow.shown'), 'false');
  assert.equal(vm.evaluate('NS.HUD.h.dist.shown'), 'false');
  // No arrow, no column: the stop's words from the gutter, why on its own and capitalised, laid out again at once (C-90).
  assert.deepEqual([vm.evaluate('NS.HUD.h.arrowZone.shown'), vm.num('NS.HUD.h.stop.x'), vm.evaluate('NS.HUD.h.distMeta.text')], ['false', 12, 'On another continent']);
  vm.run('local n = NS.MapShared.navView; n.dist, n.bearing, n.where = n.saved[1], n.saved[2], nil; NS.HUD.TickRoute()');
  assert.deepEqual([vm.evaluate('NS.HUD.h.arrowZone.shown'), vm.num('NS.HUD.h.stop.x'), vm.evaluate('NS.HUD.h.arrow.shown')], ['true', 68, 'true'], 'and back');
  // A note that only restates the list (plurals folded, numbers aside) isn't said twice; one that says more is.
  const restates = (note, rows) => vm.evaluate(`NS.HUD.RestatesList(${JSON.stringify(note)}, { ${rows.map(r => `{ text = ${JSON.stringify(r)} }`).join(', ')} })`);
  assert.equal(restates('8 Water Seekers, 8 Thornweavers, 3 Hunters.', ['Disrupt the Attacks', 'Razormane Water Seeker', 'Razormane Thornweaver', 'Razormane Hunter']), 'true');
  assert.equal(restates('Kill 8 Prairie Wolves and 6 Plainstriders; loot 8 Prairie Wolf Paws.', ['The Hunt Continues', 'Prairie Wolf Paw']), 'false');
  assert.equal(restates('', ['Prairie Wolf Paw']), 'false');
});

test('HUD: a quest that\'s a step of a chain shows where it leads under its name (a ready quest\'s or one to pick up\'s under its row), with its payoff\'s icon on the bullets\' column, in words with no hover and no link; none for a quest that leads nowhere, a ready last step to a place, or with Quest Chains off; the list closes up', () => {
  // A human warrior (the records by class need UnitClass's id), with the reward icons the game gives.
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB + `
function UnitRace() return "Human", "Human", 1 end
function UnitClass() return "Warrior", "WARRIOR", 1 end
C_Item.GetItemIconByID = function(id) return 1000 + id end` }).login());
  vm.run(`NS.MapShared.navView = { layer = "w", title = "Westfall loop", index = 1, total = 2, gen = 1, rev = 1, label = "1. Sentinel Hill", note = "",
    quests = { { id = 6822, title = "The Molten Core", state = "ready", what = "complete, turn it in", objectives = {} },
      { id = 65, title = "The Defias Brotherhood", state = "active", objectives = {} },
      { id = 1718, title = "The Islander", state = "active", objectives = { { text = "Trophy of the Islander: 0/1", finished = false } } },
      { id = 871, title = "Disrupt the Attacks", state = "active", objectives = { { text = "1/8 Razormane Water Seeker slain", finished = false } } } },
    dist = 200, bearing = 1 }; NS.HUD.Render()`);
  const shown = () => Object.values(vm.json(`(function() local o = {} for _, c in ipairs(NS.HUD.h.qChains) do if c.text.shown then
    o[#o + 1] = { c.text.text, c.mark.shown and (c.mark.atlas or c.mark.texture) or false } end end return o end)()`));
  const lines = shown();
  assert.deepEqual(lines.map(l => l[0]), [
    'Leads to |cffffd100Molten Core|r · step 3 of 5',
    'Leads to |cffffd100The Deadmines|r · step 1 of 7',
    'Leads to |cff0070ddWhirlwind Axe|r or 2 more · step 1 of 6',
  ], 'the quest page\'s words, the place in the HUD\'s gold and a reward\'s name in its quality\'s colour; nothing for Disrupt the Attacks');
  assert.ok(lines.every(l => !/\|H|\[/.test(l[0])), 'no link and no brackets: nothing on the HUD can be hovered or shift-clicked [UC-01]');
  assert.deepEqual(lines.map(l => l[1]), ['questlog-questtypeicon-raid', 'questlog-questtypeicon-dungeon', 1000 + 6975],
    'the quest log\'s raid and dungeon marks, the reward\'s own icon');
  assert.deepEqual(vm.json('NS.HUD.h.qChains[3].mark.texCoord'), [0.08, 0.92, 0.08, 0.92], 'the icon without its border');
  assert.deepEqual(vm.json('NS.HUD.h.qChains[1].text.textColor'), [0.6, 0.6, 0.6], 'the meta style: grey, the place in gold');
  // 4 under its name or row, on the objectives' text column to the right gutter (the mark on the bullets'); the list 4 under it.
  const top = e => -vm.num(`${e}.points.TOPLEFT.y`);
  const x = e => vm.num(`${e}.points.TOPLEFT.x`);
  assert.equal(top('NS.HUD.h.qChains[1].text'), top('NS.HUD.h.qRows[1].text') + 14 + 4, 'under the ready quest\'s row (its bullet\'s 12 high, as rows are)');
  assert.equal(top('NS.HUD.h.qChains[2].text'), top('NS.HUD.h.qTitles[1]') + 14 + 4, 'under the quest\'s name');
  assert.equal(top('NS.HUD.h.qRows[2].text'), top('NS.HUD.h.qChains[3].text') + 14 + 4, 'the objective 4 under the line');
  assert.deepEqual([x('NS.HUD.h.qChains[2].text'), x('NS.HUD.h.qRows[2].text'), x('NS.HUD.h.qChains[2].mark')], [30, 30, 13], 'with the objectives\' words; the mark centred on the bullets');
  assert.equal(vm.num('NS.HUD.h.qChains[2].text.width'), 300 - 12 - 30, 'to the right gutter, where the counts end [UC-05]');
  assert.equal(top('NS.HUD.h.qChains[2].mark'), top('NS.HUD.h.qChains[2].text'));
  assert.deepEqual(vm.json('{ NS.HUD.h.qChains[1].mark.width, NS.HUD.h.qChains[1].mark.height }'), [12, 12]);
  // Wider than the list: where it leads, without the step, in two lines at most [UC-03].
  vm.run('NS.HUD.h.qChains[3].text.GetUnboundedStringWidth = function() return 300 end; NS.HUD.h.layoutKey = nil; NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.qChains[3].text.text'), 'Leads to |cff0070ddWhirlwind Axe|r or 2 more');
  assert.equal(vm.num('NS.HUD.h.qChains[3].text.maxLines'), 2);
  // A client without the quest log's icons, or a reward with no icon: the words alone [UC-06].
  vm.run('C_Texture.GetAtlasExists = function() return false end; C_Item.GetItemIconByID = function() end; NS.HUD.h.layoutKey = nil; NS.HUD.Render()');
  assert.deepEqual(shown().map(l => l[1]), [false, false, false]);
  // Settings' Quest Chains off: no lines, and the list closes up at once; on again, they're back.
  const before = top('NS.HUD.h.qRows[2].text');
  vm.run('for _, sw in ipairs(NS.Settings.SWITCHES) do if sw[2] == "Quest Chains" then sw[4](false) end end');
  assert.equal(shown().length, 0, 'no lines');
  assert.equal(vm.evaluate('NS.HUD.h.qChains[1].mark.shown'), 'false');
  assert.equal(top('NS.HUD.h.qRows[2].text'), before - 3 * (14 + 4), 'the three lines above it gone');
  vm.run('for _, sw in ipairs(NS.Settings.SWITCHES) do if sw[2] == "Quest Chains" then sw[4](true) end end');
  assert.equal(shown().length, 3);
  // A ready last step: to a place, nothing (you've been there) [UC-04]; to a reward, its line (handing it in gives it).
  // One to pick up at this stop says where it leads too [UC-02]; one missing elsewhere, nothing.
  vm.run(`local n = NS.MapShared.navView; n.rev = 2; n.quests = {
    { id = 166, title = "The Defias Brotherhood", state = "ready", what = "complete, turn it in", objectives = {} },
    { id = 396, title = "An Audience with the King", state = "ready", what = "complete, turn it in", objectives = {} },
    { id = 65, title = "The Defias Brotherhood", state = "missing", what = "pick it up here", pickup = true, objectives = {} },
    { id = 132, title = "The Defias Brotherhood", state = "missing", what = "not in your quest log", objectives = {} } }; NS.HUD.Render()`);
  assert.deepEqual(shown().map(l => l[0]), ['Leads to |cff0070ddSeal of Wrynn|r · step 12 of 12', 'Leads to |cffffd100The Deadmines|r · step 1 of 7']);
  // Rows 4 apart; a row's chain line 4 under it and the next row 8 under the line, so it reads as its own row's [UC-07].
  assert.equal(top('NS.HUD.h.qRows[2].text'), top('NS.HUD.h.qRows[1].text') + 14 + 4);
  assert.equal(top('NS.HUD.h.qChains[1].text'), top('NS.HUD.h.qRows[2].text') + 14 + 4);
  assert.equal(top('NS.HUD.h.qRows[3].text'), top('NS.HUD.h.qChains[1].text') + 14 + 8);
  assert.equal(top('NS.HUD.h.qRows[4].text'), top('NS.HUD.h.qChains[2].text') + 14 + 8);
  // A stop with one chained quest left: the other lines hide.
  vm.run('local n = NS.MapShared.navView; n.quests = { n.quests[3] }; n.rev = 3; NS.HUD.Render()');
  assert.deepEqual(shown().map(l => l[0]), ['Leads to |cffffd100The Deadmines|r · step 1 of 7']);
});

// A ghost and a corpse (C_DeathInfo, build 70009), for the corpse tests.
const CORPSE = `
UnitIsGhost = function(unit) return unit == "player" and STUB.ghost == true end
C_DeathInfo = { GetCorpseMapPosition = function(mapID) local c = STUB.corpse; if c and mapID == (c.map or 1432) then return CreateVector2D(c[1], c[2]) end end }
`;

test('HUD: dead and released, the arrow points to your corpse ("Your corpse", how far and which way) until you\'re alive, and the route steps aside (the owner: "its not relevant at all"), in the panel and the bar; a ghost arrives at no stop; with no route the corpse still gets its row; one line says "Your corpse"', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB + CORPSE }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator()');
  // The map's ticker, then the HUD's (in the game both run every 0.1 s). The map's runs only
  // while there's a route or a corpse (code health AD-20): releasing and coming back start it.
  const tick = () => vm.run('local d = NQAMap.driver; if d.scripts.OnUpdate then d.scripts.OnUpdate(d, 0.2) end; NS.HUD.Tick(0.1)');
  assert.equal(vm.evaluate('NS.HUD.h.stop.text'), '2. Wolves and plainstriders');
  // Dead, not yet released: nothing changes (you're standing on it).
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick();
  assert.equal(vm.evaluate('NS.HUD.h.stop.text'), '2. Wolves and plainstriders');
  // Released: a ghost, the corpse 150 yd straight ahead (north).
  vm.run('STUB.ghost = true; STUB.corpse = { 0.5, 0.3 }; STUB.FireEvent("PLAYER_ALIVE")');
  tick();
  assert.equal(vm.evaluate('NS.HUD.h.stop.text'), 'Your corpse');
  assert.equal(vm.evaluate('NS.HUD.h.dist.text'), '150');
  assert.equal(vm.evaluate('NS.HUD.h.distMeta.text'), 'yd · ahead');
  assert.deepEqual(vm.json('NS.HUD.h.arrow.vcolor'), [1, 1, 1, 1], 'its own silver, as for a stop');
  assert.equal(vm.num('NS.HUD.h.arrow.rotation'), 0);
  assert.deepEqual([vm.evaluate('NS.HUD.h.note.shown'), vm.evaluate('NS.HUD.h.qRows[1].mark.shown')], ['false', 'false'], 'no stop\'s note or list');
  // The route steps aside: no heading, count, icons or bar; the header (with Ask) and the divider stay.
  assert.deepEqual([vm.evaluate('NS.HUD.h.routeTitle.shown'), vm.evaluate('NS.HUD.h.routeCount.shown'), vm.evaluate('NS.HUD.h.replanIcon.shown'), vm.evaluate('NS.HUD.h.endIcon.shown'),
    vm.evaluate('NS.HUD.h.segs[1].shown'), vm.evaluate('NS.HUD.h.segs.hit[1].shown')], ['false', 'false', 'false', 'false', 'false', 'false'], 'no route while you\'re a ghost');
  assert.deepEqual([vm.evaluate('NS.HUD.h.askBtn.shown'), vm.evaluate('NS.HUD.h.sep.shown')], ['true', 'true']);
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local z = NS.HUD.h.arrowZone; z.scripts.OnEnter(z)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Way to Your Corpse');
  assert.ok(vm.json('STUB.tip').some(l => l.includes('Reach your corpse to come back to life; your route comes back then.')), 'the route isn\'t lost');
  // The bar, the same: the arrow, "Your corpse" and how far, no route's bar or 1/3; the row level with the arrow.
  vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()');
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.dist.text'), vm.evaluate('NQAHUDBar.segs[1].shown')],
    ['Your corpse', '150 yd', 'false']);
  assert.deepEqual([vm.num('NQAHUDBar.status.points.LEFT.y'), vm.num('NQAHUDBar.height')], [-22, 44]);
  // News as a ghost: his words have the row, the arrow keeps pointing, and the distance is back after Okay (C-88).
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'Run north.')] }));
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.dist.shown'), vm.evaluate('NQAHUDBar.arrow.shown'), vm.evaluate('NQAHUDBar.okBtn.shown')],
    ['Run north.', 'false', 'true', 'true']);
  vm.run('local b = NQAHUDBar.okBtn; b.scripts.OnClick(b)');
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.dist.text')], ['Your corpse', '150 yd']);
  vm.advance(0.5);
  vm.run('NQADB.settings.hudMin = false; NS.HUD.Render()');
  // Running back: nearly there, green.
  vm.run('STUB.corpse = { 0.5, 0.39 }');
  tick();
  assert.equal(vm.evaluate('NS.HUD.h.dist.text'), '15');
  assert.deepEqual(vm.json('NS.HUD.h.arrow.vcolor'), [0.1, 1, 0.1, 1]);
  // Alive again: back to the stop, with its note.
  vm.run('STUB.ghost = false; STUB.corpse = nil; STUB.FireEvent("PLAYER_UNGHOST")');
  tick();
  assert.equal(vm.evaluate('NS.HUD.h.stop.text'), '2. Wolves and plainstriders');
  assert.equal(vm.evaluate('NS.HUD.h.note.shown'), 'true');
  assert.deepEqual(vm.json('NS.HUD.h.arrow.vcolor'), [1, 1, 1, 1], 'silver, away from the stop');
  assert.deepEqual([vm.evaluate('NS.HUD.h.routeTitle.text'), vm.evaluate('NS.HUD.h.routeCount.text'), vm.evaluate('NS.HUD.h.replanIcon.shown'), vm.evaluate('NS.HUD.h.endIcon.shown')],
    ['Mulgore quests', '1/3', 'true', 'true'], 'alive: the route is back');
  assert.equal(vm.evaluate('NS.HUD.h.segs.hit[1].shown'), 'true', 'and its bar takes clicks');
  // A ghost running over a stop doesn't arrive there; alive, you do.
  vm.slash('map nav mulgore 3');
  vm.run('STUB.ghost = true; STUB.corpse = { 0.2, 0.2 }; STUB.posX, STUB.posY = 0.8, 0.6; STUB.FireEvent("PLAYER_ALIVE")');
  tick();
  assert.equal(vm.num('NQAMapDB.nav.index'), 3, 'no arrival as a ghost');
  vm.run('STUB.ghost = false; STUB.corpse = nil; STUB.FireEvent("PLAYER_UNGHOST")');
  tick();
  tick();
  assert.equal(vm.evaluate('NQAMapDB.nav'), null, 'alive at the last stop: the route is done');
  vm.advance(7); // past the "Route finished" moment
  tick();
  // No route: the corpse still gets its row, under a divider.
  vm.run('STUB.posX, STUB.posY = 0.5, 0.4; STUB.ghost = true; STUB.corpse = { 0.5, 0.3 }; STUB.FireEvent("PLAYER_ALIVE")');
  tick();
  assert.equal(vm.evaluate('NS.HUD.h.stop.text'), 'Your corpse');
  assert.equal(vm.evaluate('NS.HUD.h.stop.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.sep.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.routeTitle.shown'), 'false');
  // One line: "Your corpse", the arrow and the distance (no "2/6").
  vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Your corpse');
  assert.equal(vm.evaluate('NQAHUDBar.dist.text'), '150 yd');
  assert.deepEqual(vm.json('NQAHUDBar.arrow.vcolor'), [1, 1, 1, 1]);
  // Not on any map around you (it's in an instance): said, with no arrow.
  vm.run('STUB.corpse = { 0.5, 0.3, map = 9999 }');
  tick();
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Your corpse: not on this map');
  assert.equal(vm.evaluate('NQAHUDBar.arrow.shown'), 'false');
  // Alive: gone.
  vm.run('STUB.ghost = false');
  tick();
  assert.equal(vm.evaluate('NS.MapShared.corpseView'), null);
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Ready');
});

test('HUD: Re-plan asks NeverQuestAlone for a fresh route from where you are after 3 s (meanwhile its icon is Undo and a second click takes it back), naming the route\'s layer; its heading says "Re-planning…" until his answer; combat takes a waiting one back', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator()');
  const replans = () => vm.outboxWires().filter(e => /Re-plan my route/.test(e.wire)).length;
  const y0 = vm.num('NS.HUD.h.endIcon.y');
  vm.run('local b = NS.HUD.h.replanIcon; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Asking: a new route');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '', 'one line: nothing under it moves (C-67)');
  assert.equal(vm.evaluate('NS.HUD.h.replanIcon.icon.atlas'), 'common-icon-undo', 'the icon itself says a click takes it back');
  assert.equal(vm.num('NS.HUD.h.endIcon.y'), y0, 'still under the pointer');
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local b = NS.HUD.h.replanIcon; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Undo Re-plan');
  vm.run('local b = NS.HUD.h.replanIcon; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.replanIcon.icon.atlas'), 'common-icon-rotateright');
  vm.advance(3.1);
  assert.equal(replans(), 0, 'a second click takes it back');
  vm.run('local b = NS.HUD.h.replanIcon; b.scripts.OnClick(b, "LeftButton")');
  vm.advance(3.1);
  assert.ok(sentText(vm, 'Re-plan my route "Mulgore quests" (map layer mulgore) from where I am now: skip what\'s done, keep the quests I still have, shortest path. Replace that layer.'));
  assert.equal(vm.evaluate('NS.HUD.h.routeCount.text'), 'Re-planning…');
  const q = vm.evaluate('NS.QuickChat().id');
  apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${q}", mid = "m1", agent = "main", text = "Done.", summary = "Done.", more = 0 }`] }));
  assert.equal(vm.evaluate('NS.HUD.h.routeCount.text'), '1/3', 'his answer ends the wait');
  // Combat takes a waiting one back, and says so.
  vm.run('local b = NS.HUD.h.replanIcon; b.scripts.OnClick(b, "LeftButton")');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  vm.advance(3.1);
  assert.equal(replans(), 1, 'not sent');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ask taken back');
});

test('HUD: no route (the owner, 2026-09-27: "its ass"; a button "in the zero content state"): the route\'s place says what will be there, and Ask for a Route asks for one after 3 s (meanwhile the button is Undo); the panel is never shorter than its metal corners need', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: MAP_STUB }).login());
  const shown = () => vm.json('{ NS.HUD.h.sep.shown, NS.HUD.h.emptyText.shown, NS.HUD.h.routeAskBtn.shown }');
  assert.deepEqual(shown(), [true, true, true]);
  assert.equal(vm.evaluate('NS.HUD.h.emptyText.text'), "No route yet. Ask for one: it's drawn from the quests in your log.");
  assert.equal(vm.evaluate('NS.HUD.h.routeAskBtn.text'), 'Ask for a Route');
  // Under the divider as a route's heading is, the button a gutter under the words, then a group to the edge.
  const sepY = vm.num('NS.HUD.h.sep.y');
  assert.equal(vm.num('NS.HUD.h.emptyText.y'), sepY - 1 - 8, 'offsets down from the top are negative');
  assert.equal(vm.num('NS.HUD.h.routeAskBtn.x'), 12);
  assert.ok(vm.num('NQAHUD.height') >= 83, 'the metal corners whole (75 + 32 - 16 - 8)');
  assert.equal(vm.num('NQAHUD.height'), -vm.num('NS.HUD.h.routeAskBtn.y') + 22 + 12);
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local b = NS.HUD.h.routeAskBtn; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Ask for a Route');
  // A click: 3 s to take it back, the button itself says Undo, nothing moves.
  const asks = () => vm.outboxWires().filter(e => /Plan me a route for my quests from where I am now/.test(e.wire)).length;
  const y0 = vm.num('NS.HUD.h.routeAskBtn.y');
  vm.run('local b = NS.HUD.h.routeAskBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.routeAskBtn.text'), vm.num('NS.HUD.h.routeAskBtn.y')], ['Asking: a route', 'Undo', y0]);
  vm.run('STUB.tip = {}; local b = NS.HUD.h.routeAskBtn; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Undo');
  vm.advance(0.5);
  vm.run('local b = NS.HUD.h.routeAskBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NS.HUD.h.routeAskBtn.text'), 'Ask for a Route');
  vm.advance(3.1);
  assert.equal(asks(), 0, 'a second click takes it back');
  vm.advance(0.5);
  vm.run('local b = NS.HUD.h.routeAskBtn; b.scripts.OnClick(b, "LeftButton")');
  vm.advance(3.1);
  assert.equal(asks(), 1, 'the route ask, to your Quick questions chat');
  vm.run('NS.HUD.Render()');
  assert.deepEqual(shown(), [false, false, false], 'NeverQuestAlone at work: what you asked shows instead');
  // NeverQuestAlone's route: the route shows, and no empty state.
  const q = vm.evaluate('NS.QuickChat().id');
  const key = vm.outboxWires().filter(e => /Plan me a route/.test(e.wire)).pop().key;
  apply(vm, slotLua({ acked: [key], records: [replyRec(1, q, 'Here is your route.', ', drew = { "mulgore" }')], extra: ROUTE }));
  vm.run('local b = NS.HUD.h.okBtn; b.scripts.OnClick(b)');
  vm.run('NQAMap.UpdateNavigator(); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.MapShared.navView.layer'), 'mulgore');
  assert.deepEqual([vm.evaluate('NS.HUD.h.emptyText.shown'), vm.evaluate('NS.HUD.h.routeAskBtn.shown'), vm.evaluate('NS.HUD.h.routeTitle.shown')], ['false', 'false', 'true']);
  // Ended: back to the empty state. Minimized: the bar, no empty state.
  vm.run('NQAMap.Stop(); NS.HUD.Render()');
  assert.deepEqual(vm.json('{ NS.HUD.h.view.mode, NS.HUD.h.view.empty == true, NS.HUD.h.view.route == nil, NS.HUD.h.view.compact == true }'), ['idle', true, true, false]);
  assert.deepEqual(shown(), [true, true, true]);
  vm.run('local b = NS.HUD.h.minBtn; b.scripts.OnClick(b)');
  assert.deepEqual([vm.evaluate('NQAHUD.shown'), vm.evaluate('NQAHUDBar.shown')], ['false', 'true'], 'the panel, and its button with it, away');
});

test('HUD: a ding says "NeverQuestAlone is on it" only when the companion will send it; a route followed to its end gets a gold moment; quips stay local', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ding! Level 24');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '', 'the bridge takes no events here: no promise');
  vm.advance(11);
  vm.run('NS.HUD.Tick(0.1)');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready', 'the moment passes');
  apply(vm, slotLua({ bridgeExtra: ', caps = { "state", "evt", "think" }' }));
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 25)');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '', 'check-ins are off in the app: no promise');
  vm.advance(11);
  apply(vm, slotLua({ bridgeExtra: ', caps = { "state", "evt", "think", "usage" }, usage = { autoOn = true, autoPaused = true }' }));
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 26)');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '', 'automatic help paused (the runaway fuse): no promise');
  vm.advance(11);
  apply(vm, slotLua({ bridgeExtra: ', caps = { "state", "evt", "think", "usage" }, usage = { autoOn = true }' }));
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 27)');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'NeverQuestAlone is on it.');
  vm.advance(11);
  vm.run('NS.HUD.RouteDone("Mulgore quests", 7)');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Route finished');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '7 stops on Mulgore quests. Nice work.');
  assert.deepEqual(vm.json('NS.HUD.h.dot.fill.vcolor'), [1, 0.82, 0, 1]);
  // Quips: off by default, local, one a minute at most.
  const q2 = confirmHello(newVM({ db: WELCOMED }).login());
  q2.run('STUB.FireEvent("PLAYER_DEAD")');
  assert.doesNotMatch(q2.evaluate('NS.HUD.h.status.text'), /nap|pull|ghost|logbook|coming/, 'quips are off by default');
  q2.slash('quips on');
  q2.run('STUB.FireEvent("PLAYER_DEAD")');
  const q = q2.evaluate('NS.HUD.h.status.text');
  assert.match(q, /coming|nap|pull|ghost|logbook/);
  q2.run('STUB.FireEvent("PLAYER_UNGHOST")');
  assert.equal(q2.evaluate('NS.HUD.h.status.text'), q, 'one a minute at most');
  assert.equal(q2.outboxWires().length, 0, 'nothing is sent');
});

test('HUD: the Ask box stays open with your words when news lands, aimed where it was, and keeps them when a send fails; a quick ask clears the news', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const first = activeId(vm);
  const other = vm.evaluate('NS.Chats.New("Other").id');
  vm.run('NS.UI.Toggle(false)');
  vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")');
  const quick = vm.evaluate('NS.HUD.h.replyBox.chatId');
  assert.equal(vm.evaluate('NS.Chats.Find(NS.HUD.h.replyBox.chatId).name'), 'Quick questions');
  vm.run('NS.HUD.h.replyBox:SetText("half a thought")');
  apply(vm, slotLua({ records: [replyRec(1, other, 'Other news.')] }));
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'true', 'not taken away mid-sentence');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox:GetText()'), 'half a thought');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.chatId'), quick, 'still aimed where it was');
  vm.run('NS.HUD.h.replyBox:ClearFocus()');
  apply(vm, slotLua({ records: [replyRec(2, first, 'Even more.')] }));
  assert.equal(vm.evaluate('NS.HUD.h.replyBox.shown'), 'true', 'news never closes the box, focused or not');
  vm.run('local real = NS.Chats.Send; NS.Chats.Send = function() return nil end; local b = NS.HUD.h.replyBox; b.scripts.OnEnterPressed(b); NS.Chats.Send = real');
  assert.equal(vm.evaluate('NS.HUD.h.replyBox:GetText()'), 'half a thought', 'a failed send keeps the words');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Not sent');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 0.13, 0.13]);
  vm.advance(6.1);
  vm.run('NS.HUD.Tick(0.1)');
  assert.notEqual(vm.evaluate('NS.HUD.h.status.text'), 'Not sent', 'for a while');
  vm.run('local b = NS.HUD.h.replyBox; b.scripts.OnEscapePressed(b)');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Even more.');
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("next")'), 'true');
  assert.notEqual(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says', 'the ask takes over');
  assert.match(vm.evaluate('NS.HUD.h.status.text'), /^Sending/);
});

// ---------------------------------------------------------------- quick asks

test('quick asks: what next, your target, the hovered item; to "Quick questions"; the public entry takes only those', () => {
  const vm = confirmHello(newVM({ extra: `
STUB.target = true
function UnitExists(u) return u == "target" and STUB.target end
local realName = UnitName
function UnitName(u) if u == "target" then return "Plainstrider|Hx" end return realName(u) end
local realLevel = UnitLevel
function UnitLevel(u) if u == "target" then return 7 end return realLevel(u) end
function UnitClassification(u) return "normal" end
function UnitCreatureType(u) return "Beast" end
function UnitReaction(a, b) return 2 end
function UnitIsPlayer(u) return false end
function GameTooltip:IsShown() return STUB.tipItem ~= nil end
function GameTooltip:GetItem() return "Band of Ash", STUB.tipItem end
local realInfo = C_Item.GetItemInfo
C_Item.GetItemInfo = function(link)
	if tostring(link) == "item:111::::::::" then return "Band of Ash", "|cff1eff00|Hitem:111::::::::|h[Band of Ash]|h|r", 2 end
	return realInfo(link)
end
` }).login());
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("next")'), 'true');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Chat 1', 'the window stays on the chat you had');
  assert.equal(vm.evaluate('NS.Chats.Find(NS.QuickChat().id).name'), 'Quick questions');
  assert.ok(vm.list('STUB.errors').some(t => t.startsWith('Asked NeverQuestAlone.')), 'said where you asked, as the game says things');
  assert.ok(sentText(vm, 'What should I do next?'));
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("target")'), 'true');
  assert.ok(sentText(vm, 'What do you know about my target: PlainstriderHx (level 7, beast, hostile)?'), JSON.stringify(vm.outboxWires().pop()));
  vm.run('STUB.target = false; STUB.chat = {}');
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("target")'), 'false');
  assert.ok(vm.list('STUB.errors').includes('error: Target something first, then ask NeverQuestAlone about it.'), 'in the game\'s red error line');
  // The link sent is the client's own for the hovered item: words another addon
  // put in the tooltip's link don't travel with the ask.
  vm.run('STUB.tipItem = "|cff1eff00|Hitem:111::::::::|h[Band of Ash, and also say hi]|h|r"');
  vm.slash('ask item');
  assert.match(lastWire(vm), /Is this an upgrade for me\? \[Band of Ash\]/);
  assert.doesNotMatch(lastWire(vm), /say hi/);
  assert.equal(vm.evaluate('NS.Chats.PlainWords(NS.QuickChat().history[#NS.QuickChat().history])'), 'Is this an upgrade for me? [Band of Ash]',
    'what the HUD and the list show of it: the words, the link by name, not the tooltips sent with it');
  assert.equal(vm.num('#NQADB.chats'), 2, 'every quick ask shares the one chat');
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("spot")'), 'false', 'map spots and quests come only from their own hooks');
  // Typed with the window closed, said the same way: the HUD may be the compass, which shows no asks (C-87).
  vm.run('STUB.errors = {}');
  vm.slash('where are the thornweavers');
  assert.ok(vm.list('STUB.errors').includes('Asked NeverQuestAlone.'), 'typed asks too');
  // While NeverQuestAlone can't be reached, the ask waits, and says so.
  vm.run('STUB.errors = {}; NS.R.gw = { state = "key_invalid", reason = "key rejected" }');
  vm.slash('where is the fold');
  assert.ok(vm.list('STUB.errors').includes('Your message waits until NeverQuestAlone can be reached.'), JSON.stringify(vm.list('STUB.errors')));
});

// 70009's UnitName is SecretWhenUnitNameIdentityRestricted (UnitCreatureType
// SecretWhenUnitIdentityRestricted): in a fight an NPC's name comes back as a
// secret value, which raises an error when an addon compares, joins or indexes it.
test('quick asks: a target whose name the game keeps secret (an NPC in a fight) is asked about without it, and the ask says so; nothing touches the secret', () => {
  const vm = confirmHello(newVM({ extra: `
STUB.target = true
STUB.names.target = "Plainstrider"
function UnitExists(u) return u == "target" and STUB.target end
-- STUB.secretAll: every read about the target is a secret, not only its identity.
local function Kept(u, v) if STUB.secretAll and STUB.secretNames[u] then return STUB.Secret(v) end return v end
local realLevel = UnitLevel
function UnitLevel(u) if u == "target" then return Kept(u, 7) end return realLevel(u) end
function UnitClassification(u) return Kept(u, STUB.class or "elite") end
function UnitCreatureType(u) if STUB.secretNames[u] then return STUB.Secret("Beast") end return "Beast" end
function UnitReaction(a, b) return Kept(a, 2) end
function UnitIsPlayer(u) return Kept(u, false) end
` }).login());
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("target")'), 'true');
  assert.ok(sentText(vm, 'What do you know about my target: Plainstrider (level 7, elite, beast, hostile)?'), lastWire(vm));
  vm.run('STUB.class = "rareelite"');
  vm.slash('ask target');
  assert.ok(sentText(vm, 'What do you know about my target: Plainstrider (level 7, rare elite, beast, hostile)?'), 'the game\'s own words, not its keys');
  vm.run('STUB.class = nil');
  // In a fight: the name and the creature type are secrets (the stub's are as strict as the game's).
  vm.run('STUB.secretNames.target = true; STUB.errors = {}');
  assert.deepEqual([vm.evaluate('issecretvalue(UnitName("target"))'), vm.evaluate('type(UnitName("target"))')], ['true', 'string']);
  assert.throws(() => vm.run('local n = UnitName("target"); local _ = n:gsub("|", "")'), /secret value/, 'as the pre-fix TargetLine did');
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("target")'), 'true', 'the ask still goes');
  assert.ok(sentText(vm, 'What do you know about my target (level 7, elite, hostile)? The game hides its name from addons right now.'), lastWire(vm));
  assert.ok(vm.list('STUB.errors').includes('Asked NeverQuestAlone.'));
  // Every read a secret: nothing to ask about, so nothing is sent (a reply that can't help still costs one).
  vm.run('STUB.secretAll = true; STUB.errors = {}');
  const sent = vm.outboxWires().length;
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("target")'), 'false');
  assert.equal(vm.outboxWires().length, sent);
  assert.deepEqual(vm.list('STUB.errors'), ['error: The game hides your target from addons right now. Ask again after the fight.']);
  // No target is still no ask.
  vm.run('STUB.target = false; STUB.errors = {}');
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("target")'), 'false');
  assert.deepEqual(vm.list('STUB.errors'), ['error: Target something first, then ask NeverQuestAlone about it.']);
});

test('secret values: every other unit read (your own name, the game data, the check-ins, the HUD\'s last session, /nqa apicheck) is checked first, so a secret never reaches a compare, a join or a saved key', () => {
  // Your own name is never secret on 70009 (you're player-controlled); this makes it one to prove each read is checked.
  const vm = confirmHello(newVM({ extra: 'STUB.secretNames.player = true' }).login());
  assert.equal(vm.evaluate('NS.CharKey()'), '?-Test Realm');
  assert.doesNotMatch(vm.evaluate('NS.Chats.GameContext()'), /Character:/, 'the game data leaves out the line it can\'t read');
  vm.slash('');
  type(vm, 'hello');
  assert.ok(sentText(vm, 'hello'), 'sending, with the game data, still works');
  vm.run('NQADB.companion = NQADB.companion or {}; NQADB.companion.lastSession = [[{"v":1,"kind":"session","sid":"a1b2","char":{"name":"Testchar"},"start":{"t":100},"end":{"t":700},"xpGained":5,"questsTurnedIn":0}]]');
  assert.deepEqual(vm.json('NS.HUD.LastSession()'), { minutes: 10, xp: 5, quests: 0 }, 'an unknown name is never compared: the recap shows');
  assert.ok(vm.evaluate('NS.Companion.Call("SessionJSON")').includes('"char":{"name":""'), 'the recap leaves the name empty');
  assert.equal(vm.evaluate('NS.R.companionError'), null, 'no check-in read hit an error');
  assert.ok(vm.list('NS.Companion.Call("ApiCheck")').includes('UnitName: present, secret'), '/nqa apicheck names a secret without reading it');
  // A client with no issecretvalue has no secrets: the reads are as they were.
  const plain = confirmHello(newVM({ extra: 'issecretvalue = nil' }).login());
  assert.equal(plain.evaluate('NS.CharKey()'), 'Testchar-Test Realm');
  assert.match(plain.evaluate('NS.Chats.GameContext()'), /Character: Testchar on Test Realm/);
});

// The stub's secrets can't raise on ==, ~= or a truth test, as the game's do, so no VM test
// would catch `name ~= ""` on a target's read: this reads the source instead.
test('secret values: every identity read of a unit other than your own goes through ns.Readable or ns.IsSecret first', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // 70009's SecretWhenUnit(Name)IdentityRestricted reads the addon could reach for, UnitIsPlayer
  // and Blizzard's GetUnitName wrapper.
  const API = ['UnitName', 'UnitFullName', 'UnitNameUnmodified', 'UnitPVPName', 'GetUnitName', 'UnitGUID', 'UnitOwnerGUID', 'UnitNameFromGUID',
    'UnitTokenFromGUID', 'UnitCreatureType', 'UnitCreatureFamily', 'UnitCreatureID', 'UnitClass', 'UnitClassBase', 'UnitRace', 'UnitSex', 'UnitIsPlayer'];
  const read = new RegExp(`\\b(?:${API.join('|')})\\b\\s*[,(]\\s*([^,)]+)`, 'g');
  const bad = [];
  let reads = 0;
  for (const f of fs.readdirSync(ADDON).filter(n => n.endsWith('.lua'))) {
    const lines = fs.readFileSync(path.join(ADDON, f), 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const code = raw.replace(/--.*$/, '');
      for (const m of code.matchAll(read)) {
        if (m[1].trim() === '"player"') continue; // your own: player-controlled, never secret
        reads++;
        const local = (code.match(/local\s+(\w+)\s*=/) || [])[1];
        const next = lines[i + 1] || '';
        if (!/ns\.(Readable|IsSecret)\(/.test(code) && !(local && next.includes(`ns.IsSecret(${local})`))) bad.push(`${f}:${i + 1}: ${raw.trim()}`);
      }
    });
  }
  assert.ok(reads >= 6, `the scan finds the target's three reads and the quest giver's three (${reads})`);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- the map

test('waypoint: the next stop is the game\'s own waypoint, super-tracked; only ours is ever cleared; /nqa waypoint off', () => {
  const vm = confirmHello(newVM({ extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator()');
  assert.deepEqual(vm.json('STUB.waypoints[#STUB.waypoints]'), { uiMapID: 1432, position: { x: 0.56, y: 0.4 } });
  assert.deepEqual(vm.list('STUB.superTrack'), [true]);
  const n = vm.num('#STUB.waypoints');
  vm.run('NQAMap.UpdateNavigator()');
  assert.equal(vm.num('#STUB.waypoints'), n, 'set once per stop, not every tick');
  vm.slash('map next');
  vm.run('NQAMap.UpdateNavigator()');
  assert.deepEqual(vm.json('STUB.waypoints[#STUB.waypoints].position'), { x: 0.5, y: 0.34 });
  assert.equal(vm.evaluate('NS.MapShared.navView.waypoint'), 'true', 'the compass\'s tooltip says the game\'s waypoint marks it');
  // Your own pin replaced ours: stopping the route leaves it alone.
  vm.run('STUB.userWaypoint = { uiMapID = 1432, position = { x = 0.1, y = 0.1 } }');
  vm.slash('map stop');
  assert.equal(vm.num('STUB.cleared'), 0);
  // Ours is cleared when the route stops.
  vm.slash('map nav mulgore 1');
  vm.run('NQAMap.UpdateNavigator()');
  vm.slash('map stop');
  assert.equal(vm.num('STUB.cleared'), 1);
  // Off: cleared and not set again.
  vm.slash('map nav mulgore 1');
  vm.run('NQAMap.UpdateNavigator()');
  const before = vm.num('#STUB.waypoints');
  vm.slash('waypoint off');
  assert.equal(vm.num('STUB.cleared'), 2);
  vm.slash('map next');
  vm.run('NQAMap.UpdateNavigator()');
  assert.equal(vm.num('#STUB.waypoints'), before);
  // A map the game won't pin: no waypoint, and no error.
  vm.run('STUB.noWaypointMap = 1432');
  vm.slash('waypoint on');
  vm.run('NQAMap.UpdateNavigator()');
  assert.equal(vm.num('#STUB.waypoints'), before);
  vm.run('STUB.noWaypointMap = nil; NQAMap.UpdateNavigator()');
  assert.equal(vm.num('#STUB.waypoints'), before + 1, 'on again, where it can be');
});

test('/nqa roll picks one of your quests on this map and pins it; Ctrl+right-click on the map asks NeverQuestAlone about that spot', () => {
  const vm = confirmHello(newVM({ extra: MAP_STUB + 'function IsControlKeyDown() return STUB.ctrl == true end' }).login());
  vm.slash('roll');
  assert.ok(vm.list('STUB.prints').some(p => p.includes('None of your quests has a point on this map.')));
  vm.run('STUB.onMap = { { questID = 766, x = 0.47, y = 0.62 } }');
  vm.slash('roll');
  assert.ok(vm.list('STUB.prints').some(p => p.includes('NeverQuestAlone rolled: Swoop Hunting. Waypoint set.')));
  assert.deepEqual(vm.json('STUB.waypoints[#STUB.waypoints].position'), { x: 0.47, y: 0.62 });
  // The map click: only Ctrl+right-click, and it's handled (no zoom-out).
  vm.run('STUB.FireEvent("ADDON_LOADED", "Blizzard_WorldMap")');
  assert.equal(vm.num('STUB.mapClickPriority'), 100);
  assert.equal(vm.evaluate('STUB.mapClick(nil, "RightButton", 0.452, 0.612)'), 'false', 'a plain right-click still zooms out');
  vm.run('STUB.ctrl = true');
  assert.equal(vm.evaluate('STUB.mapClick(nil, "RightButton", 0.452, 0.612)'), 'true');
  assert.ok(sentText(vm, 'What\'s at 45.2, 61.2 on Loch Modan (map 1432)? Anything there worth doing at my level?'));
});

// ---------------------------------------------------------------- tooltips

test('tooltip verdicts: NeverQuestAlone\'s weights score every item against what you wear; upgrade, not, empty, two hands, off', () => {
  const vm = confirmHello(newVM({ extra: `
STUB.stats = {
	["item:1"] = { ITEM_MOD_STRENGTH_SHORT = 10, ITEM_MOD_STAMINA_SHORT = 10 },
	["item:2"] = { ITEM_MOD_STRENGTH_SHORT = 5, ITEM_MOD_STAMINA_SHORT = 5 },
	["item:3"] = { ITEM_MOD_STRENGTH_SHORT = 20 },
	["item:4"] = { ITEM_MOD_STRENGTH_SHORT = 10 },
}
local LOC = { ["item:1"] = "INVTYPE_CHEST", ["item:2"] = "INVTYPE_CHEST", ["item:3"] = "INVTYPE_2HWEAPON", ["item:4"] = "INVTYPE_WEAPON", ["item:9"] = "INVTYPE_FEET" }
local function key(link) return "item:" .. tostring(link):match("item:(%d+)") end
C_Item.GetItemStats = function(link) return STUB.stats[key(link)] end
C_Item.GetItemInfoInstant = function(link) return tonumber(tostring(link):match("item:(%d+)")), nil, nil, LOC[key(link)] end
STUB.worn = { [5] = "|Hitem:2|h[Old Vest]|h", [16] = "|Hitem:4|h[Old Sword]|h" }
function GetInventoryItemLink(unit, slot) return STUB.worn[slot] end
STUB.stats["item:9"] = { ITEM_MOD_STAMINA_SHORT = 3 }
STUB.lines = {}
function GameTooltip:AddLine(t) table.insert(STUB.lines, t) end
function GameTooltip:GetItem() return "x", STUB.hover end
` }).login());
  const id = activeId(vm);
  const hover = link => { vm.run(`STUB.lines = {}; STUB.hover = ${lstr(link)}; NS.Tooltips.OnItemTooltip(GameTooltip)`); return vm.list('STUB.lines'); };
  assert.deepEqual(hover('|Hitem:1|h[New Vest]|h'), [], 'no weights yet: nothing');
  apply(vm, slotLua({ records: [replyRec(1, id, 'Set your weights.', ', weights = { str = 1, sta = 0.5, bogus = 9 }')] }));
  assert.deepEqual(vm.json('NQADB.weights["Testchar-Test Realm"]'), { str: 1, sta: 0.5 });
  assert.deepEqual(hover('|Hitem:1|h[New Vest]|h'), ['NeverQuestAlone: an upgrade for your build, +100% over Old Vest']);
  assert.deepEqual(hover('|Hitem:2|h[Old Vest]|h'), ['NeverQuestAlone: you\'re wearing this']);
  assert.deepEqual(hover('|Hitem:9|h[Boots]|h'), ['NeverQuestAlone: fills an empty slot']);
  assert.deepEqual(hover('|Hitem:3|h[Great Axe]|h'), ['NeverQuestAlone: an upgrade for your build, +100% over Old Sword'], 'a two-hander against both hands');
  vm.run('STUB.stats["item:3"] = { ITEM_MOD_STRENGTH_SHORT = 1 }');
  assert.deepEqual(hover('|Hitem:3|h[Great Axe]|h'), ['NeverQuestAlone: not an upgrade, 90% under Old Sword']);
  vm.slash('tooltips off');
  assert.deepEqual(hover('|Hitem:1|h[New Vest]|h'), []);
  // They survive a reload, and junk in the saved data is dropped.
  const again = reloadVM(vm, { extra: '' }).login();
  assert.deepEqual(again.json('NQADB.weights["Testchar-Test Realm"]'), { str: 1, sta: 0.5 });
});

test('tooltip verdicts: a ring or trinket fills a free slot first, else faces the weaker one; an off-hand beside a two-hander; your own two-hander; a suffix is its own item', () => {
  const vm = confirmHello(newVM({ extra: `
STUB.stats = {
	["item:20"] = { ITEM_MOD_STAMINA_SHORT = 10 },
	["item:21"] = { ITEM_MOD_STAMINA_SHORT = 4 },
	["item:22"] = { ITEM_MOD_STAMINA_SHORT = 8 },
	["item:30"] = { ITEM_MOD_STAMINA_SHORT = 5 },
	["item:31"] = { ITEM_MOD_STRENGTH_SHORT = 12 },
	["item:40"] = { ITEM_MOD_STRENGTH_SHORT = 6 },
}
local LOC = { ["item:20"] = "INVTYPE_FINGER", ["item:21"] = "INVTYPE_FINGER", ["item:22"] = "INVTYPE_FINGER", ["item:30"] = "INVTYPE_SHIELD", ["item:31"] = "INVTYPE_2HWEAPON", ["item:40"] = "INVTYPE_CLOAK" }
local function key(link) return "item:" .. tostring(link):match("item:(%d+)") end
C_Item.GetItemStats = function(link) return STUB.stats[key(link)] end
C_Item.GetItemInfoInstant = function(link) return tonumber(tostring(link):match("item:(%d+)")), nil, nil, LOC[key(link)] end
STUB.worn = { [11] = "|Hitem:21::::::::|h[Copper Band]|h" }
function GetInventoryItemLink(unit, slot) return STUB.worn[slot] end
STUB.lines = {}
function GameTooltip:AddLine(t) table.insert(STUB.lines, t) end
function GameTooltip:GetItem() return "x", STUB.hover end
` }).login());
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'Weights.', ', weights = { str = 1, sta = 1 }')] }));
  const hover = link => { vm.run(`STUB.lines = {}; STUB.hover = ${lstr(link)}; NS.Tooltips.OnItemTooltip(GameTooltip)`); return vm.list('STUB.lines'); };
  assert.deepEqual(hover('|Hitem:20::::::::|h[Silver Ring]|h'), ['NeverQuestAlone: fills an empty slot'], 'the second ring slot is free');
  vm.run('STUB.worn[12] = "|Hitem:22::::::::|h[Iron Band]|h"');
  assert.deepEqual(hover('|Hitem:20::::::::|h[Silver Ring]|h'), ['NeverQuestAlone: an upgrade for your build, +150% over Copper Band'], 'against the weaker of the two');
  vm.run('STUB.worn[16] = "|Hitem:31::::::::|h[Great Axe]|h"');
  assert.deepEqual(hover('|Hitem:30::::::::|h[Buckler]|h'), ['NeverQuestAlone: only with a one-hander (you wield a two-hander)']);
  assert.deepEqual(hover('|Hitem:31::::::::|h[Great Axe]|h'), ['NeverQuestAlone: you\'re wearing this']);
  vm.run('STUB.worn[15] = "|Hitem:40:0:0:0:0:0:1182|h[Cloak of the Eagle]|h"');
  assert.deepEqual(hover('|Hitem:40:0:0:0:0:0:1182|h[Cloak of the Eagle]|h'), ['NeverQuestAlone: you\'re wearing this']);
  assert.deepEqual(hover('|Hitem:40:0:0:0:0:0:1190|h[Cloak of the Bear]|h'), ['NeverQuestAlone: about the same as Cloak of the Eagle'], 'the same id with another suffix is another item');
});

test('refs: an item the client hasn\'t loaded shows by number, then by name once the game has it (one redraw per burst, your place kept)', () => {
  const vm = confirmHello(newVM({ extra: `
STUB.known, STUB.requested = {}, {}
C_Item.GetItemInfo = function(id) if STUB.known[id] then return "Linen Cloth", "|cffffffff|Hitem:" .. id .. "::::::::|h[Linen Cloth]|h|r", 1 end end
C_Item.RequestLoadItemDataByID = function(id) table.insert(STUB.requested, id) end
` }).login());
  vm.slash('');
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Bring cloth.', ', refs = { i = { 2589 } }')] }));
  const pill = () => vm.evaluate('NS.UI.ui.bubbles[1].pills[1].label.text');
  assert.equal(pill(), '[Item 2589]');
  vm.run('NS.Refresh("status"); NS.UI.RenderTranscript("x")');
  assert.deepEqual(vm.list('STUB.requested'), [2589], 'asked for once');
  vm.run('STUB.known[2589] = true; STUB.FireEvent("GET_ITEM_INFO_RECEIVED", 2589, true); STUB.FireEvent("GET_ITEM_INFO_RECEIVED", 2589, true)');
  assert.equal(pill(), '[Item 2589]', 'not yet: the redraw waits a moment');
  vm.advance(0.3);
  assert.equal(pill(), '[Linen Cloth]');
});

test('tooltip verdicts follow what the game says in red: can\'t use it, or not yet (at level N); a big upgrade instead of a silly percentage', () => {
  const vm = confirmHello(newVM({ extra: `
STUB.stats = { ["item:50"] = { ITEM_MOD_STRENGTH_SHORT = 20 }, ["item:51"] = { ITEM_MOD_STRENGTH_SHORT = 1 }, ["item:52"] = { ITEM_MOD_STRENGTH_SHORT = 30 } }
local LOC = { ["item:50"] = "INVTYPE_CHEST", ["item:51"] = "INVTYPE_CHEST", ["item:52"] = "INVTYPE_CHEST" }
local function key(link) return "item:" .. tostring(link):match("item:(%d+)") end
C_Item.GetItemStats = function(link) return STUB.stats[key(link)] end
C_Item.GetItemInfoInstant = function(link) return tonumber(tostring(link):match("item:(%d+)")), nil, nil, LOC[key(link)] end
local realInfo = C_Item.GetItemInfo
C_Item.GetItemInfo = function(link) if key(link) == "item:52" then return "Fine Vest", link, 2, 30, 30 end return realInfo(link) end
ITEM_MIN_LEVEL, DURABILITY_TEMPLATE = "Requires Level %d", "Durability %d / %d"
STUB.worn = { [5] = "|Hitem:51::::::::|h[Rags]|h" }
function GetInventoryItemLink(unit, slot) return STUB.worn[slot] end
STUB.lines = {}
function GameTooltip:AddLine(t) table.insert(STUB.lines, t) end
function GameTooltip:GetItem() return "x", STUB.hover end
` }).login());
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'Weights.', ', weights = { str = 1 }')] }));
  const RED = '{ r = 1, g = 0.125, b = 0.125 }';
  const hover = (link, lines = '{}') => { vm.run(`STUB.lines = {}; STUB.hover = ${lstr(link)}; NS.Tooltips.OnItemTooltip(GameTooltip, { lines = ${lines} })`); return vm.list('STUB.lines'); };
  assert.deepEqual(hover('|Hitem:50::::::::|h[Plate Vest]|h', `{ { leftText = "Chest", rightText = "Plate", rightColor = ${RED} } }`), ['NeverQuestAlone: you can\'t use this'], 'red armour type');
  assert.deepEqual(hover('|Hitem:50::::::::|h[Vest]|h', `{ { leftText = "Durability 0 / 45", leftColor = ${RED} } }`), ['NeverQuestAlone: a big upgrade over Rags'], 'broken is not unusable; next to nothing worn: "a big upgrade"');
  assert.deepEqual(hover('|Hitem:52::::::::|h[Fine Vest]|h', `{ { leftText = "Requires Level 30", leftColor = ${RED} } }`), ['NeverQuestAlone: a big upgrade at level 30 over Rags']);
  vm.run('STUB.stats["item:51"] = { ITEM_MOD_STRENGTH_SHORT = 25 }');
  assert.deepEqual(hover('|Hitem:52::::::::|h[Fine Vest]|h', `{ { leftText = "Requires Level 30", leftColor = ${RED} } }`), ['NeverQuestAlone: an upgrade at level 30, +20% over Rags']);
  assert.deepEqual(hover('|Hitem:50::::::::|h[Vest]|h'), ['NeverQuestAlone: not an upgrade, 20% under Rags']);
  // Nothing your weights count on either (a shirt, white gear under caster weights): no verdict, not a contradiction.
  vm.run('STUB.stats["item:50"] = {}; STUB.stats["item:51"] = {}');
  assert.deepEqual(hover('|Hitem:50::::::::|h[Vest]|h'), []);
});

// ---------------------------------------------------------------- settings and ways in

// The game's Settings API (Blizzard_Settings_Shared/Blizzard_Settings.lua at bd2470a) as the list
// uses it: each control and its tooltip, each slider's options, the settings told to read their
// value again (NotifyUpdate), a row's indent, gray-out tests and watched settings. Every way the
// API has to make a dropdown counts itself in STUB.dropdowns, and every parent link in
// STUB.parentLinks: NeverQuestAlone makes none (E-047, QL-36).
const SETTINGS_API = `
STUB.controls, STUB.settings, STUB.inits, STUB.layoutInits, STUB.sliders, STUB.tips, STUB.notified, STUB.dropdowns = {}, {}, {}, {}, {}, {}, {}, {}
STUB.parentLinks, STUB.rows = {}, {}
local function Init(name)
	local i = { control = name }
	-- The Options search reads a row's parent link unguarded (Blizzard_SettingsPanel.lua:712).
	function i:SetParentInitializer(parent, predicate) table.insert(STUB.parentLinks, name); self.parent, self.predicate = parent.control, predicate end
	function i:Indent() self.indent = 15 end
	function i:AddModifyPredicate(fn) self.predicates = self.predicates or {}; table.insert(self.predicates, fn) end
	function i:AddEvaluateStateCVar(var) self.watches = self.watches or {}; table.insert(self.watches, var) end
	function i:SetSettingIntercept(fn) self.intercept = fn end
	STUB.rows[name] = i
	return i
end
local function Dropdown(name) return function() table.insert(STUB.dropdowns, name) end end
local function Template(name) return function(template, ...) if tostring(template):find("Dropdown") then table.insert(STUB.dropdowns, name .. " " .. tostring(template)) end return Init(tostring(template)) end end
Settings = {
	VarType = { Boolean = "boolean", String = "string", Number = "number" },
	RegisterVerticalLayoutCategory = function(name)
		STUB.category = { name = name, GetID = function() return 42 end }
		return STUB.category, { AddInitializer = function(self, i) table.insert(STUB.layoutInits, i) end }
	end,
	RegisterInitializer = function(cat, i) assert(cat == STUB.category); table.insert(STUB.inits, i) end,
	RegisterProxySetting = function(cat, var, vt, name, def, get, set)
		local s = { var = var, name = name, def = def, get = get, set = set, vt = vt }
		function s:NotifyUpdate() table.insert(STUB.notified, self.var) end
		STUB.settings[var] = s
		return s
	end,
	CreateCheckbox = function(cat, setting, tip) table.insert(STUB.controls, "checkbox: " .. setting.name); STUB.tips[setting.name] = tip; return Init(setting.name) end,
	CreateControlTextContainer = function() local c = { data = {} }; function c:Add(v, l, t) table.insert(self.data, { value = v, label = l, tooltip = t }) end; function c:GetData() return self.data end; return c end,
	CreateSliderOptions = function(min, max, step) local o = { minValue = min, maxValue = max, step = step }; function o:SetLabelFormatter(kind, fn) self.kind, self.fmt = kind, fn end; return o end,
	CreateSlider = function(cat, setting, options, tip)
		STUB.sliders[setting.name], STUB.tips[setting.name] = options, tip
		table.insert(STUB.controls, "slider: " .. setting.name .. " " .. options.minValue .. "-" .. options.maxValue .. " by " .. options.step)
		return Init(setting.name)
	end,
	CreateDropdown = Dropdown("Settings.CreateDropdown"),
	CreateDropdownInitializer = Dropdown("Settings.CreateDropdownInitializer"),
	CreateDropdownOptionInserter = Dropdown("Settings.CreateDropdownOptionInserter"),
	CreateDropdownButton = Dropdown("Settings.CreateDropdownButton"),
	CreateDropdownCheckbox = Dropdown("Settings.CreateDropdownCheckbox"),
	InitDropdown = Dropdown("Settings.InitDropdown"),
	SetupCVarDropdown = Dropdown("Settings.SetupCVarDropdown"),
	SetupModifiedClickDropdown = Dropdown("Settings.SetupModifiedClickDropdown"),
	CreateElementInitializer = Template("Settings.CreateElementInitializer"),
	CreateSettingInitializer = Template("Settings.CreateSettingInitializer"),
	CreateControlInitializer = Template("Settings.CreateControlInitializer"),
	RegisterAddOnCategory = function(c) STUB.registered = c end,
	OpenToCategory = function(id, name) STUB.opened, STUB.openedAt = id, name end,
	KEYBINDINGS_CATEGORY_ID = 7,
}
CreateSettingsCheckboxDropdownInitializer = Dropdown("CreateSettingsCheckboxDropdownInitializer")
function CreateSettingsListSectionHeaderInitializer(name) return { header = name } end
function CreateSettingsButtonInitializer(name, text, click, tip, tags) return { button = text, name = name, click = click, tags = tags } end
MinimalSliderWithSteppersMixin = { Label = { Left = 1, Right = 2 } }
`;

test('settings: the game\'s standard list (searchable, with Defaults), words not raw values, Bind keys; our own window without that API; the addon compartment; Ask NeverQuestAlone in the quest log', () => {
  const vm = confirmHello(newVM({ extra: MAP_STUB + `
AddonCompartmentFrame = { RegisterAddon = function(self, d) STUB.compartment = d end }
STUB.menus = {}
Menu = { ModifyMenu = function(tag, fn) STUB.menus[tag] = fn end }
` }).login());
  vm.slash('settings');
  assert.equal(vm.evaluate('NQASettings.shown'), 'true');
  // The HUD switch: unchecked turns it off, and the small bar stands in.
  vm.run('local cb = NS.Settings.page.checks[1]; cb.GetChecked = function() return false end; cb.scripts.OnClick(cb)');
  assert.equal(vm.evaluate('NQADB.settings.hud'), 'false');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'false');
  // The choices say what they mean.
  assert.equal(vm.evaluate('NS.Settings.page.cycles[1].text'), 'TL;DR');
  assert.equal(vm.evaluate('NS.Settings.page.cycles[2].text'), 'Medium');
  vm.run('local b = NS.Settings.page.cycles[2]; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NQADB.settings.textSize'), 'large');
  assert.equal(vm.evaluate('NS.Settings.page.cycles[2].text'), 'Large');
  // The compartment: click opens NeverQuestAlone, right-click the settings.
  assert.equal(vm.evaluate('STUB.compartment.text'), 'NeverQuestAlone');
  vm.run('NQASettings:Hide(); STUB.compartment.func(nil, { buttonName = "LeftButton" })');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  vm.run('STUB.compartment.func(nil, { buttonName = "RightButton" })');
  assert.equal(vm.evaluate('NQASettings.shown'), 'true');
  // The quest log's right-click menu.
  vm.run(`STUB.items = {}
    local root = { CreateDivider = function() end, CreateButton = function(self, text, fn) STUB.items[#STUB.items + 1] = text; STUB.itemFn = fn end }
    STUB.menus.MENU_QUEST_MAP_LOG_TITLE({ questID = 766 }, root)`);
  assert.deepEqual(vm.list('STUB.items'), ['Ask NeverQuestAlone About This Quest']);
  vm.run('STUB.itemFn()');
  assert.ok(sentText(vm, 'Help me with this quest: Swoop Hunting (quest 766). What\'s left, and where?'));
  // With the game's Settings API: a vertical list of proxy settings, headers and buttons.
  const withApi = confirmHello(newVM({ extra: SETTINGS_API }).login());
  assert.equal(withApi.evaluate('STUB.category.name'), 'NeverQuestAlone');
  assert.equal(withApi.evaluate('STUB.registered == STUB.category'), 'true');
  const controls = withApi.list('STUB.controls');
  assert.ok(controls.includes('checkbox: NeverQuestAlone HUD'));
  // E-047: no dropdown in the game's Settings, from any of the game's ways to make one. Opening
  // one there (Quest Rewards', 0.5.2) crashed the game: Blizzard_Menu asserted in AcquireMenu
  // (Menu.lua:2212, lua-5.1 ldebug.c:747), the dropdown's owner a Blizzard_SettingControls button.
  assert.deepEqual(withApi.list('STUB.dropdowns'), [], 'no dropdown');
  // Quest Rewards (QoL.lua, loaded here): a check box per rule, as radio buttons are (qol_test has the rest).
  assert.deepEqual(controls.filter(c => c.includes('Quest Rewards')),
    ['checkbox: Quest Rewards: Your Pick', 'checkbox: Quest Rewards: Best Upgrade', 'checkbox: Quest Rewards: Highest Price']);
  // QL-36: no row links to a parent (the Options search reads that link unguarded); Quest Rewards' rows are
  // indented and grayed with the calls only a row's own setup reads.
  assert.deepEqual(withApi.list('STUB.parentLinks'), [], 'no parent link');
  assert.equal(withApi.num('STUB.rows["Quest Rewards: Highest Price"].indent'), 15);
  assert.deepEqual(withApi.list('STUB.rows["Quest Rewards: Highest Price"].watches'), [withApi.evaluate('STUB.settings.NQA_SWITCH_12.var')]);
  assert.equal(withApi.evaluate('STUB.settings.NQA_SWITCH_12.name'), 'Auto Turn In Quests', 'the row it sits under');
  // C-123: the Map section's first row fits the list's label column at 12 pt (about 195 units; the critics'
  // measure, up to 0.52 em a character), where "Route Stops as the Game's Own Waypoint" (237) was cut.
  const waypoint = withApi.evaluate('STUB.settings.NQA_SWITCH_2.name');
  assert.equal(waypoint, 'Next Stop as a Waypoint');
  assert.ok(waypoint.length * 12 * 0.52 <= 195, `${Math.round(waypoint.length * 12 * 0.52)} units`);
  // Quest Rewards' rows are indented (15 in: about 180).
  for (const c of controls.filter(c => c.includes('Quest Rewards: '))) assert.ok((c.length - 'checkbox: '.length) * 12 * 0.52 <= 180, c);
  // The Replies section's switches (Reply Cost and Message Times after Quiet in Combat), then the two choices
  // whose options run in order: a slider each, least to most, its value in words beside it.
  const replies = controls.slice(controls.indexOf('checkbox: Quiet in Combat'), controls.indexOf('checkbox: Quiet in Combat') + 6);
  assert.deepEqual(replies, ['checkbox: Quiet in Combat', 'checkbox: Reply Cost', 'checkbox: Message Times', 'checkbox: Read replies aloud', 'slider: Replies in Your Chat Frame 1-4 by 1', 'slider: Chat Text Size 1-4 by 1']);
  // Copy and Paste's Connection (E-050): its two options don't run in order, so a check box each, exactly one
  // checked, as Quest Rewards' are; both carry the choice's one tooltip, in the product's name.
  const at = controls.indexOf('checkbox: Quiet in Combat') + 6;
  assert.deepEqual(controls.slice(at, at + 2), ['checkbox: Connection: Automatic', 'checkbox: Connection: Copy and Paste']);
  for (const c of controls.slice(at, at + 2)) assert.ok((c.length - 'checkbox: '.length) * 12 * 0.52 <= 195, c);
  for (const row of ['Connection: Automatic', 'Connection: Copy and Paste']) {
    assert.equal(withApi.evaluate(`STUB.tips[${lstr(row)}]`), 'Sets how replies come: Automatic uses the NeverQuestAlone app while it runs, and Copy and Paste when it doesn\'t; Copy and Paste never uses the app.', row);
  }
  assert.deepEqual([withApi.evaluate('STUB.settings.NQA_REPLIES_AUTO.get()'), withApi.evaluate('STUB.settings.NQA_REPLIES_PASTE.get()')], ['true', 'false'], 'Automatic, the default');
  assert.deepEqual([withApi.evaluate('STUB.settings.NQA_REPLIES_AUTO.def'), withApi.evaluate('STUB.settings.NQA_REPLIES_PASTE.def')], ['true', 'false'], 'Defaults picks Automatic');
  withApi.run('STUB.notified = {}; STUB.settings.NQA_REPLIES_PASTE.set(true)');
  assert.equal(withApi.evaluate('NQADB.settings.replies'), 'paste');
  assert.deepEqual([withApi.evaluate('STUB.settings.NQA_REPLIES_AUTO.get()'), withApi.evaluate('STUB.settings.NQA_REPLIES_PASTE.get()')], ['false', 'true'], 'one checked');
  assert.deepEqual(withApi.list('STUB.notified'), ['NQA_REPLIES_AUTO'], 'the row it replaced is told, so the list redraws it unchecked');
  withApi.slash('replies auto');
  assert.deepEqual([withApi.evaluate('STUB.settings.NQA_REPLIES_AUTO.get()'), withApi.evaluate('STUB.settings.NQA_REPLIES_PASTE.get()')], ['true', 'false'], '/nqa replies reads back on the list');
  const words = (name, n) => withApi.evaluate(`STUB.sliders[${lstr(name)}].fmt(${n})`);
  assert.deepEqual([1, 2, 3, 4].map(n => words('Replies in Your Chat Frame', n)), ['Off', 'One Line', 'TL;DR', 'Whole Reply']);
  assert.deepEqual([1, 2, 3, 4].map(n => words('Chat Text Size', n)), ['Small', 'Medium', 'Large', 'Extra Large']);
  assert.equal(withApi.num('STUB.sliders["Chat Text Size"].kind'), 2, 'on the slider\'s right, as HUD Opacity\'s');
  assert.equal(words('Chat Text Size', 2.4), 'Medium', 'a step between two reads as the nearer');
  // Read when shown (the app's echo switch changes it, PR-1): main's words while that switch doesn't say.
  assert.equal(withApi.evaluate('STUB.tips["Replies in Your Chat Frame"]()'), 'Sets how much of each reply also shows in your chat frame; the window always has all of it.');
  // Each settable from the list and read back: whole steps, never past the ends, never nil.
  assert.equal(withApi.num('STUB.settings.NQA_ECHO.get()'), 3, 'TL;DR, the default');
  assert.equal(withApi.num('STUB.settings.NQA_ECHO.def'), 3);
  for (const [n, value] of [[4, 'full'], [1, 'off'], [2.4, 'short'], [9, 'full'], [3, 'summary']]) {
    withApi.run(`STUB.settings.NQA_ECHO.set(${n})`);
    assert.equal(withApi.evaluate('NQADB.settings.echo'), value, `set(${n})`);
  }
  assert.equal(withApi.num('STUB.settings.NQA_ECHO.get()'), 3);
  withApi.run('NQADB.settings.echo = nil');
  assert.equal(withApi.num('STUB.settings.NQA_ECHO.get()'), 3, 'never nil: the list\'s slider would stop with an error');
  assert.equal(withApi.num('STUB.settings.NQA_TEXTSIZE.def'), 2, 'Medium');
  // The HUD's opacity: a slider, 60–100 % by 5, that always has a number for the list.
  assert.ok(controls.includes('slider: HUD Opacity 60-100 by 5'));
  assert.equal(withApi.num('STUB.settings.NQA_HUDALPHA.get()'), 100);
  assert.equal(withApi.evaluate('STUB.sliders["HUD Opacity"].fmt(80)'), '80%');
  withApi.run('STUB.settings.NQA_HUDALPHA.set(73)');
  assert.equal(withApi.num('NQADB.settings.hudAlpha'), 75, 'whole steps');
  withApi.run('STUB.settings.NQA_HUDALPHA.set(10)');
  assert.equal(withApi.num('NQADB.settings.hudAlpha'), 60, 'never fainter than 60 %');
  withApi.run('NQADB.settings.hudAlpha = nil');
  assert.equal(withApi.num('STUB.settings.NQA_HUDALPHA.get()'), 100, 'never nil: the list\'s slider would stop with an error');
  assert.deepEqual(withApi.list('(function() local o = {} for _, i in ipairs(STUB.inits) do if i.header then o[#o + 1] = i.header end end return o end)()'),
    ['The HUD', 'Map', 'Quests', 'Replies', 'Tooltips', 'What NeverQuestAlone Knows', 'Personality', 'Quality of Life', 'Usage', 'Keys and Places']);
  // E-026: headers and buttons go in through Settings.RegisterInitializer (the secure way in), and no
  // button adds search tags: CreateSettingsButtonInitializer writes those from its caller, so they
  // would carry our taint into every Options search (the Discord Sign In row was blocked).
  assert.equal(withApi.num('#STUB.layoutInits'), 0, 'nothing straight into the layout');
  assert.deepEqual(withApi.list('(function() local o = {} for _, i in ipairs(STUB.inits) do if i.button then o[#o + 1] = i.button .. ":" .. tostring(i.tags) end end return o end)()'),
    ['Show Usage:false', 'Bind Keys:false', 'Put It Back:false', 'Put It Back:false']);
  // Proxy settings read and write ours; each has its default (the Defaults button).
  assert.equal(withApi.evaluate('STUB.settings.NQA_SWITCH_1.get()'), 'true');
  withApi.run('STUB.settings.NQA_SWITCH_1.set(false)');
  assert.equal(withApi.evaluate('NQADB.settings.hud'), 'false');
  assert.equal(withApi.evaluate('STUB.settings.NQA_SWITCH_1.def'), 'true');
  withApi.run('STUB.settings.NQA_TEXTSIZE.set(3)');
  assert.equal(withApi.evaluate('NQADB.settings.textSize'), 'large');
  assert.equal(withApi.num('STUB.settings.NQA_TEXTSIZE.get()'), 3);
  withApi.run('STUB.settings.NQA_TEXTSIZE.set(1)');
  assert.equal(withApi.evaluate('NQADB.settings.textSize'), 'small');
  // A command's choice reads back on the list (the list reads each row as it draws it).
  withApi.slash('echo off');
  assert.equal(withApi.num('STUB.settings.NQA_ECHO.get()'), 1);
  withApi.slash('settings');
  assert.equal(withApi.num('STUB.opened'), 42);
  assert.equal(withApi.evaluate('NQASettings'), null, 'no window of our own');
  withApi.run('for _, i in ipairs(STUB.inits) do if i.button == "Bind Keys" then i.click() end end');
  assert.deepEqual([withApi.num('STUB.opened'), withApi.evaluate('STUB.openedAt')], [7, 'NeverQuestAlone'], 'Keybindings, at the keys\' own section (the C-127 test: it is there)');
});

test('C-124: every way in names the addon as the AddOns list does (the TOC\'s Title): Options, Keybindings, the minimap\'s addon menu, the window\'s notices, our own window, and the lines that point there', () => {
  const toc = require('node:fs').readFileSync(require('node:path').join(ADDON, 'NeverQuestAlone.toc'), 'utf8');
  const name = toc.match(/^## Title: (.*)$/m)[1];
  assert.equal(name, 'NeverQuestAlone');
  const COMPARTMENT = '\nAddonCompartmentFrame = { RegisterAddon = function(self, d) STUB.compartment = d end }';
  // With the game's Settings API (Forever): the category under Options > AddOns, the keys' section in
  // Keybindings (that Bind Keys lands on it, with the five keys in it: the C-127 test), the addon menu's
  // entry and its tooltip, and the label on a command's answer.
  const vm = confirmHello(newVM({ extra: SETTINGS_API + COMPARTMENT }).login());
  assert.equal(vm.evaluate('STUB.category.name'), name, 'Options > AddOns');
  assert.equal(vm.evaluate('BINDING_HEADER_NQA'), name, 'Options > Keybindings: the name of the keys\' section');
  assert.equal(vm.evaluate('STUB.compartment.text'), name, 'the minimap\'s addon menu');
  vm.run('STUB.compartment.funcOnEnter({})');
  assert.equal(vm.evaluate('GameTooltip.text'), name, 'its tooltip\'s title');
  assert.equal(vm.evaluate('NS.UI.WayBack()'), `NeverQuestAlone is hidden. Click ${name} in the minimap's addon menu, or type /nqa, to bring it back.`);
  vm.slash('');
  vm.slash('help');
  assert.equal(vm.evaluate('NS.UI.ui.notice.who.text'), name, 'a command\'s answer in the window');
  // Without that API: our own settings window, and the line Bind Keys prints instead.
  const own = confirmHello(newVM({ extra: COMPARTMENT }).login());
  own.slash('settings');
  assert.equal(own.evaluate('NQASettings.shown'), 'true');
  assert.equal(own.evaluate('NS.Settings.page.title.text'), name, 'our own window\'s title');
  own.run('NS.Settings.OpenKeybindings()');
  assert.equal(own.chatLines().pop().replace(/\|c[0-9a-f]{8}|\|r/g, ''), `[NeverQuestAlone] Bind keys in the game menu: Options > Keybindings > ${name}.`);
});

test('C-127: the keys have a Keybindings section of their own, named as the AddOns list names the addon, and Bind Keys opens the page at it', async () => {
  // Forever's Keybindings page, modeled from Blizzard's source (tests/helpers/keybindings.mjs): a key's category
  // names its section (_G[category]), a header is a blank row, and Bind Keys' OpenToCategory scrolls to the
  // element named what it passes, a section's own name.
  const { bindingsXml, keybindingSections, scrollTarget, GAME_STRINGS } = await import('./helpers/keybindings.mjs');
  const fs = require('node:fs'), path = require('node:path');
  const name = fs.readFileSync(path.join(ADDON, 'NeverQuestAlone.toc'), 'utf8').match(/^## Title: (.*)$/m)[1];
  const bindings = bindingsXml(fs.readFileSync(path.join(ADDON, 'Bindings.xml'), 'utf8'));
  // The binding names stay, so keys bound before keep working; each is in the addon's own category, as
  // Blizzard_PingUI's keys are in theirs, and none has a header.
  assert.deepEqual(bindings.map(b => b.name), ['NQA_OPEN_AND_TYPE', 'NQA_ASK_NEXT', 'NQA_ASK_TARGET', 'NQA_ASK_ITEM', 'NQA_VOICE_TALK', 'NQA_VOICE_TIP', 'NQA_VOICE_MUTE', 'NQA_VOICE_PAUSE', 'NQA_OKAY']);
  for (const b of bindings) {
    assert.equal(b.category, 'BINDING_HEADER_NQA', `${b.name}: its category`);
    assert.equal(b.header, undefined, `${b.name}: no header (the page draws one as a blank row)`);
  }
  const vm = confirmHello(newVM({ extra: SETTINGS_API }).login());
  const G = k => { const v = vm.evaluate(`type(_G[${lstr(k)}]) == "string" and _G[${lstr(k)}] or nil`); return v ?? GAME_STRINGS[k]; };
  assert.equal(G('BINDING_HEADER_NQA'), name, 'the category\'s name on the page is the TOC\'s Title');
  const sections = keybindingSections(bindings, G, { game: true });
  const ours = sections.filter(s => s.entries.some(e => /^NQA_/.test(e.action || '')));
  assert.deepEqual(ours.map(s => s.name), [name], 'all five keys in one section, named NeverQuestAlone');
  assert.deepEqual(ours[0].entries, bindings.map(b => ({ action: b.name })), 'the five keys and nothing else: no blank row');
  // Bind Keys opens the game's Keybindings at that section.
  vm.run('for _, i in ipairs(STUB.inits) do if i.button == "Bind Keys" then i.click() end end');
  assert.equal(vm.num('STUB.opened'), 7, 'the Keybindings page');
  assert.equal(scrollTarget(sections, vm.evaluate('STUB.openedAt')), sections.indexOf(ours[0]), 'it lands on the keys\' section');
  // Each key's name is whole in its row: the row's label is 170 wide in GameFontNormal, 12 pt, one line cut
  // with "…" (KeyBindingFrameBindingTemplate, Blizzard_Keybindings.xml:45-47), by the critics' measure (0.52 em
  // a character).
  for (const b of bindings) {
    const words = G(`BINDING_NAME_${b.name}`);
    assert.ok(words.length * 12 * 0.52 <= 170, `${b.name}: "${words}" is ${Math.round(words.length * 12 * 0.52)} units`);
  }
  // Round 3's page (d3ac2a7), in the same model: category="ADDONS" and a header on the first key put the five
  // in the game's AddOns section after a blank row, and nothing on the page was named NeverQuestAlone, so
  // Bind Keys opened the page at its top.
  const before = keybindingSections(bindings.map((b, i) => ({ ...b, category: 'ADDONS', header: i === 0 ? 'NQA' : undefined })), G, { game: true });
  assert.deepEqual(before.find(s => s.name === 'AddOns').entries, [{ spacer: true }, ...bindings.map(b => ({ action: b.name }))]);
  assert.equal(scrollTarget(before, name), -1, 'no section of that name');
});

test('E-047: where the client lacks a slider\'s words, a choice in order gets a row per option too; still no dropdown', () => {
  const vm = confirmHello(newVM({ extra: SETTINGS_API + '\nMinimalSliderWithSteppersMixin = nil' }).login());
  const controls = vm.list('STUB.controls');
  assert.deepEqual(vm.list('STUB.dropdowns'), []);
  assert.deepEqual(controls.filter(c => c.includes('Replies in Your Chat Frame')),
    ['Off', 'One Line', 'TL;DR', 'Whole Reply'].map(w => `checkbox: Replies in Your Chat Frame: ${w}`), 'no slider that can\'t say where it is');
  assert.equal(vm.evaluate('STUB.settings.NQA_ECHO_SUMMARY.get()'), 'true');
  vm.run('STUB.notified = {}; STUB.settings.NQA_ECHO_FULL.set(true)');
  assert.equal(vm.evaluate('NQADB.settings.echo'), 'full');
  assert.deepEqual(vm.list('STUB.notified'), ['NQA_ECHO_SUMMARY'], 'the row it replaced reads its value again');
  assert.equal(vm.evaluate('STUB.settings.NQA_ECHO_SUMMARY.get()'), 'false');
});

test('E-047: no Blizzard dropdown anywhere in the addon, and no Settings row linked to a parent (QL-36); its right-click menus hang on its own frames, and its one entry in a game menu goes in through Menu.ModifyMenu', () => {
  const fs = require('node:fs'), path = require('node:path');
  const files = fs.readdirSync(ADDON).filter(f => /\.(lua|xml)$/.test(f));
  assert.ok(files.includes('Settings.lua') && files.includes('Bindings.xml'));
  const seen = { context: 0, modify: 0 };
  for (const f of files) {
    const code = fs.readFileSync(path.join(ADDON, f), 'utf8').replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(code, /Dropdown|DropDown|SetupMenu|WowStyle\d|EasyMenu/, `${f}: a dropdown (DropdownButton, WowStyle1DropdownTemplate, Settings.CreateDropdown, UIDropDownMenu, SetupMenu…)`);
    // QL-36: no Settings row links to a parent row. The Options search reads that link unguarded
    // (Blizzard_SettingsPanel.lua:712), so a search that found the row would run tainted.
    assert.doesNotMatch(code, /SetParentInitializer|parentInitializer/, `${f}: a Settings row's parent link`);
    // MenuUtil.CreateContextMenu only with an anchor of ours, and Menu.ModifyMenu (the documented way into the game's own menus) only for the quest log's.
    const call = name => new RegExp(`(?:pcall\\(\\s*${name}\\s*,|${name}\\s*\\()\\s*"?([A-Za-z_.]+)`, 'g');
    for (const m of code.matchAll(call('MenuUtil\\.CreateContextMenu'))) { seen.context++; assert.equal(m[1], 'anchor', `${f}: a context menu on ${m[1]}`); }
    for (const m of code.matchAll(call('Menu\\.ModifyMenu'))) { seen.modify++; assert.equal(m[1], 'MENU_QUEST_MAP_LOG_TITLE', f); }
  }
  assert.ok(seen.context >= 1 && seen.modify === 1, `the scan found the calls it checks: ${JSON.stringify(seen)}`);
});

// The game's Settings, the quest log and a link's tooltip open through ShowUIPanel, which
// turns an addon away in a fight ("Interface action failed because of an AddOn":
// UIParentPanelManager.lua:853-861 at 70009). Each call they'd make is recorded here.
const PANELS = `
STUB.opens = {}
Settings = {
	VarType = { Boolean = "boolean", String = "string", Number = "number" },
	RegisterVerticalLayoutCategory = function(name) return { GetID = function() return 42 end }, {} end,
	RegisterProxySetting = function(cat, var) return { var = var } end,
	CreateCheckbox = function() return {} end,
	CreateDropdown = function() return {} end,
	RegisterAddOnCategory = function() end,
	OpenToCategory = function(id, name) table.insert(STUB.opens, "settings " .. id .. (name and (" at " .. name) or "")) end,
	KEYBINDINGS_CATEGORY_ID = 7,
}
function QuestMapFrame_OpenToQuestDetails(id) table.insert(STUB.opens, "quest log at " .. id) end
-- SetItemRef reads the modifier keys as it runs (ItemRef.lua:17): Shift puts the link in chat.
function IsModifiedClick() return STUB.shift or false end
function SetItemRef(link) table.insert(STUB.opens, (IsModifiedClick() and "chat link " or "link ") .. link) end
-- Its plain-click branch: ShowUIPanel(ItemRefTooltip), then the link in it.
function ShowUIPanel(f) f:Show() end
ItemRefTooltip = CreateFrame("GameTooltip", "ItemRefTooltip", UIParent)
ItemRefTooltip:Hide()
function ItemRefTooltip:ItemRefSetHyperlink(link) table.insert(STUB.opens, "link " .. link) end
function UnitIsDeadOrGhost(u) return u == "player" and STUB.dead or false end
C_Item.GetItemInfo = function(id) if id == 4804 then return "Prairie Wolf Paw", "|cff9d9d9d|Hitem:4804::::::::|h[Prairie Wolf Paw]|h|r", 1 end end
STUB.tip = {}
function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end
`;

test('in a fight, Settings, Keybindings and the window\'s quest and item links open once it ends, and the game\'s own line says so; out of one they open at once', () => {
  const vm = confirmHello(newVM({ extra: MAP_STUB + PANELS }).login());
  const opens = () => vm.list('STUB.opens');
  const said = () => vm.list('STUB.errors');
  const fresh = () => vm.run('STUB.opens = {}; STUB.errors = {}');
  const fight = on => vm.run(`STUB.combat = ${on}; STUB.FireEvent("${on ? 'PLAYER_REGEN_DISABLED' : 'PLAYER_REGEN_ENABLED'}")`);
  fresh();
  vm.slash('settings');
  vm.slash('qol');
  vm.run('NS.Settings.OpenKeybindings()');
  assert.deepEqual(opens(), ['settings 42', 'settings 42 at Quality of Life', 'settings 7 at NeverQuestAlone'], 'out of a fight, at once');
  assert.deepEqual(said(), []);
  fresh();
  fight(true);
  vm.slash('settings');
  assert.deepEqual(opens(), [], 'nothing reaches ShowUIPanel in a fight');
  assert.deepEqual(said(), ['Settings opens after the fight.'], 'in the game\'s own line, yellow: it will happen');
  fight(false);
  assert.deepEqual(opens(), ['settings 42'], 'as the fight ends');
  fight(true);
  fight(false);
  assert.deepEqual(opens(), ['settings 42'], 'once: the next fight\'s end opens nothing');
  // The newest click in a fight is the one that opens; /nqa qol keeps its section.
  fresh();
  fight(true);
  vm.slash('qol');
  vm.run('NS.Settings.OpenKeybindings()');
  assert.deepEqual(said(), ['Settings opens after the fight.', 'The Keybindings page opens after the fight.']);
  fight(false);
  assert.deepEqual(opens(), ['settings 7 at NeverQuestAlone'], 'nothing piles up for the fight\'s end');
  fresh();
  fight(true);
  vm.slash('qol');
  fight(false);
  assert.deepEqual(opens(), ['settings 42 at Quality of Life']);
  // A fight that ends in your death opens nothing: Release Spirit comes first.
  fresh();
  fight(true);
  vm.slash('settings');
  vm.run('STUB.dead = true');
  fight(false);
  vm.run('STUB.dead = false');
  fight(true);
  fight(false);
  assert.deepEqual(opens(), [], 'dropped, not kept for the next fight\'s end');
  // The window's pills: a quest you're on opens in the quest log; an item, or a quest you're not on, its tooltip.
  vm.slash('');
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Take the quills to Harken.', ', refs = { q = { 766 }, i = { 4804 } }'), replyRec(2, id, 'Then this one.', ', refs = { q = { 999 } }')] }));
  const click = (b, i, shift = false) => vm.run(`STUB.shift = ${shift}; local p = NS.UI.ui.bubbles[${b}].pills[${i}]; p.scripts.OnClick(p); STUB.shift = false`);
  fresh();
  click(1, 1);
  click(1, 2);
  click(2, 1);
  assert.deepEqual(opens(), ['quest log at 766', 'link item:4804', 'link quest:999'], 'out of a fight, at once');
  fresh();
  fight(true);
  click(1, 1);
  assert.deepEqual([opens(), said()], [[], ['Your quest log opens to [Swoop Hunting] after the fight.']]);
  fight(false);
  assert.deepEqual(opens(), ['quest log at 766']);
  fresh();
  fight(true);
  click(2, 1);
  assert.deepEqual([opens(), said()], [[], ['The [Quest 999] link opens after the fight.']], 'a quest you\'re not on is a link');
  fight(false);
  assert.deepEqual(opens(), ['link quest:999']);
  fresh();
  fight(true);
  vm.run('STUB.tip = {}; local p = NS.UI.ui.bubbles[1].pills[2]; p.scripts.OnEnter(p)');
  assert.ok(vm.list('STUB.tip').includes('<Click to open it after the fight>'), 'its tooltip says when');
  click(1, 2);
  assert.deepEqual([opens(), said()], [[], ['The [Prairie Wolf Paw] link opens after the fight.']]);
  vm.run('NS.UI.ui.input:SetText("")');
  click(1, 2, true);
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '|cff9d9d9d|Hitem:4804::::::::|h[Prairie Wolf Paw]|h|r', 'shift-click only fills the box, so it works in a fight');
  // Shift held as the fight ends (a looting key, the killing blow on a Shift bind): still a plain open, never a chat link.
  vm.run('STUB.shift = true');
  fight(false);
  vm.run('STUB.shift = false');
  assert.deepEqual(opens(), ['link item:4804']);
  assert.equal(vm.evaluate('ItemRefTooltip.shown'), 'true', 'the link\'s own tooltip, as a click in chat opens it');
  vm.run('STUB.tip = {}; local p = NS.UI.ui.bubbles[1].pills[2]; p.scripts.OnEnter(p)');
  assert.ok(vm.list('STUB.tip').includes('<Click to open it>'));
  // Without the game's Settings list, our own window stands in: it's no game panel, so it opens in a fight.
  const own = confirmHello(newVM().login());
  own.run('STUB.errors = {}; STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  own.slash('settings');
  assert.equal(own.evaluate('NQASettings.shown'), 'true');
  assert.deepEqual(own.list('STUB.errors'), []);
});

test('how long replies take: the median of the last 20, in the working bubble and the HUD', () => {
  const vm = confirmHello(newVM().login());
  assert.equal(vm.evaluate('NS.Chats.TypicalRunTime()'), null, 'not before three');
  vm.run('for _, s in ipairs({ 30, 10, 20, 25, 15 }) do NS.Chats.NoteRunTime(s) end');
  assert.equal(vm.num('NS.Chats.TypicalRunTime()'), 20);
  vm.run('for i = 1, 30 do NS.Chats.NoteRunTime(5) end');
  assert.equal(vm.num('#NQADB.runTimes'), 20);
  assert.equal(vm.num('NS.Chats.TypicalRunTime()'), 5);
  vm.slash('');
  type(vm, 'hello');
  const key = vm.outboxWires().pop().key;
  vm.slot(slotLua({ acked: [key], nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm);
  vm.advance(1.6);
  vm.run('STUB.onLoadAddOn = nil; NS.Refresh("status")');
  assert.match(vm.evaluate('NS.UI.ui.work.text.text'), /^Working · \d+ s \(usually 5 s\)$/);
  // The HUD: the voice alone on the status line (it never wraps as the clock runs), the time
  // and what's usual on the line under it; the one-line HUD keeps the time beside the voice.
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Thinking…');
  assert.match(vm.evaluate('NS.HUD.h.sub.text'), /^\d+ s · usually 5 s$/);
  assert.equal(vm.num('NS.HUD.h.sub.maxLines'), 1, 'cut, never wrapped: the clock moves nothing below it');
  // NeverQuestAlone's voice for what he's doing: writing, else thinking (no tools, so nothing else to name).
  vm.run('local real = NS.Chats.Progress; NS.Chats.Progress = function(c) local p = real(c); p.title = "Writing the reply"; return p end; NS.HUD.Render(); NS.Chats.Progress = real');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Writing…', 'NeverQuestAlone\'s voice for what he\'s doing');
  vm.run('local real = NS.Chats.Progress; NS.Chats.Progress = function(c) local p = real(c); p.title = "browser"; return p end; NS.HUD.Render(); NS.Chats.Progress = real');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Thinking…', 'any other title');
  vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()');
  assert.match(vm.evaluate('NQAHUDBar.status.text'), /^Thinking… \d+ s$/);
  vm.run('NQADB.settings.hudMin = false; NS.HUD.Render()');
  // A reply records how long it took.
  vm.advance(12);
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'Hi!')] }));
  const t = vm.list('NQADB.runTimes');
  assert.ok(t[t.length - 1] >= 12, JSON.stringify(t));
});

// ---------------------------------------------------------------- E-1 to E-4 (public-ui e2d5a3a), on main's widget
// Bugs real in main's own code, fixed since 0.4.9; tests/byok/addon_fixes_test.js has more.
const TIP_STUB = 'STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end';
// The HUD as its bar, with an unread reply.
function barWithReply() {
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, firstReply = true, settings = { hudMin = true } }', extra: TIP_STUB }).login());
  vm.send('where is the forge');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  vm.run('NS.UI.Toggle(false)');
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'In Ironforge: the Great Forge.')] }));
  vm.run('NS.HUD.Render()');
  return vm;
}
const barRow = vm => [vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.okBtn.shown'), vm.evaluate('NQAHUDBar.okBtn.text')];
const unreadOf = (vm, id) => vm.num(`NS.Chats.Find("${id}").unread`);
const okTip = vm => { vm.run('STUB.tip = {}; local b = NQAHUDBar.okBtn; b.scripts.OnEnter(b)'); return vm.json('STUB.tip').at(-1); };
const clickOk = vm => vm.run('local b = NQAHUDBar.okBtn; b.scripts.OnClick(b, "LeftButton")');

test('E-1 (C-30): on the bar, a ding, a finished route or a flash over an unread reply: Okay ends that line first (its tooltip says so) and the reply stays unread; then the same Okay puts the reply away', () => {
  for (const [label, trigger, head] of [
    ['ding', 'STUB.FireEvent("PLAYER_LEVEL_UP", 24)', 'Ding! Level 24'],
    ['route done', 'NS.HUD.RouteDone("Copper veins", 6)', 'Route finished'],
    ['flash', 'NS.HUD.Flash("Not sent", "Too long.")', 'Not sent'],
  ]) {
    const vm = barWithReply();
    const id = activeId(vm);
    assert.deepEqual(barRow(vm), ['In Ironforge: the Great Forge.', 'true', 'Okay'], 'the reply, with its Okay');
    vm.run(`${trigger}; NS.HUD.Render()`);
    assert.deepEqual(barRow(vm).slice(0, 3), [head, 'true', 'Okay'], label);
    assert.equal(okTip(vm), 'Puts it away; nothing is sent.', `${label}: the tooltip says what it does`);
    clickOk(vm);
    assert.equal(unreadOf(vm, id), 1, `${label}: the reply is still unread`);
    assert.deepEqual(barRow(vm), ['In Ironforge: the Great Forge.', 'true', 'Okay'], `${label}: the row falls back to the reply`);
    assert.equal(okTip(vm), 'Marks the reply read and puts it away; nothing is sent.');
    vm.advance(1); // the guard after an Okay (C-72)
    clickOk(vm);
    assert.equal(unreadOf(vm, id), 0, `${label}: the second Okay reads the reply`);
  }
});

test('E-1 (C-30): a pending re-plan over an unread reply: the bar\'s Okay sends it now, once, and leaves the reply alone', () => {
  const vm = barWithReply();
  const id = activeId(vm);
  const sent = vm.outboxWires().length;
  vm.run('NS.HUD.Replan(); NS.HUD.Render()');
  assert.match(barRow(vm)[0], /^Asking: /);
  assert.deepEqual(barRow(vm).slice(1), ['true', 'Send'], 'the button says what it does (C-112)');
  assert.equal(okTip(vm), 'Sends it now, without the 3 s wait.');
  clickOk(vm);
  assert.equal(vm.outboxWires().length, sent + 1, 'sent now, not after the 3 s');
  assert.equal(unreadOf(vm, id), 1, 'the reply untouched');
  vm.advance(4);
  assert.equal(vm.outboxWires().length, sent + 1, 'once: the wait\'s own send doesn\'t follow');
});

test('E-1 (C-29): "Can\'t reach the NeverQuestAlone app" over an unread reply on the bar: no Okay (it would read a reply you haven\'t seen); Show More, and the reply\'s Okay is under its words', () => {
  const vm = barWithReply();
  const id = activeId(vm);
  vm.advance(200);
  vm.run('NS.HUD.Render()');
  assert.deepEqual(barRow(vm).slice(0, 2), ['Can\'t reach the NeverQuestAlone app', 'false']);
  vm.run('NS.HUD.BarOkay()');
  assert.equal(unreadOf(vm, id), 1, 'still unread');
  vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  vm.run('for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == "Show More" then b.scripts.OnClick(b) end end');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Can\'t reach the NeverQuestAlone app');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'In Ironforge: the Great Forge.');
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.shown'), 'true');
  vm.run('local b = NS.HUD.h.okBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(unreadOf(vm, id), 0, 'read there');
});

test('E-1 (C-109): the bar\'s Okay changes meaning under the pointer, so it takes the same double-click guard as the panel\'s buttons: a ding over unread news, a double-click ends the ding and nothing more', () => {
  const vm = barWithReply();
  const id = activeId(vm);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 24); NS.HUD.Render()');
  clickOk(vm);
  vm.advance(0.15);
  clickOk(vm);
  assert.equal(unreadOf(vm, id), 1, 'the second click of a double one reads nothing');
  assert.equal(barRow(vm)[0], 'In Ironforge: the Great Forge.', 'the reply shows, unread');
  vm.advance(1);
  clickOk(vm);
  assert.equal(unreadOf(vm, id), 0, 'a deliberate click later reads it');
});

test('E-1 (C-110): a connection state over unread news has the bar\'s row, so the row keeps the distance (only the news\'s own row gives it to Okay)', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, firstReply = true, settings = { hudMin = true } }', extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ROUTE }));
  vm.run('NQAMap.UpdateNavigator(); NS.UI.Toggle(false)');
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'Hi.')] }));
  vm.run('NS.HUD.Render()');
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.dist.shown')], ['Hi.', 'false'], 'the news\'s row: his words and Okay');
  vm.advance(200);
  vm.run('NS.HUD.Render(); NS.HUD.TickRoute()');
  assert.deepEqual([vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.okBtn.shown'), vm.evaluate('NQAHUDBar.dist.shown')], ['Can\'t reach the NeverQuestAlone app', 'false', 'true'], 'the connection\'s row keeps the distance');
});

test('E-2: the window\'s X says where the reply will show: the HUD while it shows news; else (its compass form, closed, off) the banner at the top of the screen', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: TIP_STUB }).login());
  vm.slash('');
  const get = () => { vm.run('STUB.tip = {}; local c = NS.UI.ui.closeBtn; c.scripts.OnEnter(c)'); return vm.json('STUB.tip').at(-1); };
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the HUD shows the reply when it lands.');
  vm.slash('hud compass');
  vm.slash('');
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the reply shows at the top of the screen when it lands.', 'the compass: the banner');
  vm.slash('hud full');
  vm.run('NS.HUD.Close()');
  vm.slash('');
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the reply shows at the top of the screen when it lands.', 'closed: the banner, never "the small bar"');
  vm.slash('hud off');
  vm.slash('');
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the reply shows at the top of the screen when it lands.', 'off: the small bar badges it, the banner shows it');
});

test('E-3: a /nqa stop\'s answer ("Nothing was running.", kind stop; "Couldn\'t stop: …", kind gateway after a stop) pops no pending send: the running message stays busy and its own reply answers it', () => {
  for (const [kind, text] of [['gateway', 'Couldn\'t stop: the gateway is unreachable.'], ['stop', 'Nothing was running.']]) {
    const vm = confirmHello(newVM({ db: WELCOMED }).login());
    const id = activeId(vm);
    vm.send('where is the forge');
    vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
    const pending = () => vm.num(`#NS.Chats.Find("${id}").pending`);
    assert.equal(pending(), 1);
    vm.slash('stop');
    apply(vm, slotLua({ records: [errorRec(1, id, kind, null, text)] }));
    assert.equal(pending(), 1, `${kind}: the running message still waits for its answer`);
    assert.equal(vm.evaluate(`NS.Chats.IsBusy(NS.Chats.Find("${id}"))`), 'true');
    vm.run('NS.UI.Toggle(false); NS.HUD.Render()');
    assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Something went wrong', 'shown as an error is');
    apply(vm, slotLua({ records: [replyRec(2, id, 'The forge is in the middle of the city.')] }));
    assert.equal(pending(), 0, `${kind}: its own reply answers it`);
  }
  // An ordinary gateway error (no stop asked) still answers the message.
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  const id = activeId(vm);
  vm.send('where is the forge');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(vm, slotLua({ records: [errorRec(1, id, 'gateway', null, 'The service is unreachable.')] }));
  assert.equal(vm.num(`#NS.Chats.Find("${id}").pending`), 0);
});

test('E-4: the /nqa hud and /nqa text answers name their choices in words, with commas (commands-ux), never a raw "|" whose |r made "fulleset"', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.slash('hud');
  const hud = vm.chatLines().at(-1);
  assert.ok(hud.endsWith('Change it with /nqa hud on, off, full, bar, compass or reset.'), hud);
  vm.slash('text');
  const text = vm.chatLines().at(-1);
  assert.ok(text.endsWith('Chat Text Size: Medium. Settings has it too.'), text);
  // As the chat frame shows it: no |r or |c escape is left in the words (a lone | would open one).
  for (const line of [hud, text]) {
    assert.doesNotMatch(line.replace(/\|\|/g, '').replace(/^\|cff7ec8ff\[NeverQuestAlone\]\|r /, ''), /\|[rc]/, 'no escape left in the words');
  }
});

test('the status lines point to a click, never a hover (string clarity): while the header has more to say (not ready, the AI unreachable, the app silent, a send that didn\'t go), the lines are a button whose click opens the window with the light\'s words', () => {
  const vm = confirmHello(newVM({ db: WELCOMED, extra: TIP_STUB }).login());
  vm.run('NS.UI.Toggle(false)');
  const TIP = 'The NeverQuestAlone app is running but can\'t reach your AI: connecting.';
  const light = (state, extra = '') => vm.run(`NS.Transport.Light = function() return "${state}", ${lstr(TIP)} end; ${extra} NS.HUD.Render()`);
  light('grey');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Not ready');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Click to see why in the window.');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true');
  vm.run('STUB.tip = {}; local b = NS.HUD.h.statusBtn; b.scripts.OnEnter(b)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Details');
  assert.ok(vm.json('STUB.tip').includes('<Click to see all of it in the window>'), JSON.stringify(vm.json('STUB.tip')));
  vm.run('local b = NS.HUD.h.statusBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true', 'the window');
  assert.equal(notice(vm), TIP, 'the light\'s words, in the chat');
  vm.run('NS.UI.Toggle(false)');
  light('yellow', 'NS.R.gw = { state = "connecting" };');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), "Can't reach your AI");
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Click to see why in the window.');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true');
  // Nothing more to say: no button, and a click there reaches the world.
  light('green');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'false');
  // No status line anywhere points to a tooltip.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'addon', 'NeverQuestAlone', 'HUD.lua'), 'utf8');
  assert.doesNotMatch(src, /tooltip says (how|why)/);
  // A message sent meanwhile: "Sending…" borrows the connection's line, and its click with it (UXC-UI-21).
  light('grey');
  vm.send('wheres the nearest forge');
  vm.run('NS.UI.Toggle(false); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Sending…');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Click to see why in the window.');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true', 'the line that says click is a button');
  vm.run('local b = NS.HUD.h.statusBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.equal(notice(vm), TIP);
});

test('the addon\'s own chat lines lead with the companion\'s name, as its replies do: [NeverQuestAlone] for the owner\'s agent, whatever the bridge names it', () => {
  const vm = confirmHello(newVM({ db: WELCOMED }).login());
  vm.run('NS.Notify.Local("Minimap pins hidden.")');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[NeverQuestAlone]|r Minimap pins hidden.');
  vm.run('NQADB.agentNames.main = "Skully"; NS.Notify.Local("Hello.")');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[Skully]|r Hello.');
  vm.run('NQADB.agentNames.main = "A|cffff0000red"; NS.Notify.Local("Hi.")');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[A||cffff0000red]|r Hi.', 'escaped: a name never forms a game escape');
});

test('the Welcome\'s lessons say Click Ask (STYLE: controls are clicked, keys pressed): the setup block stands in its place, and /nqa help opens with them', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = {}' }).login());
  vm.run('NS.UI.Toggle(false); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'setup');
  vm.slash('help');
  assert.match(notice(vm), /^Getting around:\nClick Ask to ask anything/);
});
