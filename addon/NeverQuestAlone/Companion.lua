-- Companion.lua: the companion's game side (companion PRD F1, F3, F4, F6;
-- docs/PROTOCOL.md §2.6).
--
--   State (F1): the game as JSON (character, place, every quest in the log
--     with live counts and where its chain leads, the chains the character
--     can start, quest points, professions, gear, milestones), fitted to
--     one strip frame: per-quest detail goes first, then professions and
--     milestones (they wait for the next state), then the end of titles, and a
--     quest never does: each keeps its id and ready flag at the least. It
--     travels with a message or event, or optional throttled Live state, while the bridge
--     hasn't confirmed its seq (bridge.stateSeq), and once after each hello.
--     With a typed message it goes whatever Check-Ins says: Game Data with
--     Messages is the switch for what goes with a message.
--   Events (F3, A2): a level-up, a finished route, 3 or more quests that no
--     route covers, a first visit to a zone. Each becomes a turn for Bones in
--     the Check-ins chat. Never in combat, 2 minutes apart (level-ups
--     excepted), once each. No daily limit: only the bridge's runaway
--     fuse, which pauses automatic help after a burst no play makes (P.AutoPaused).
--   Milestones (F4): first zone visits, a profession's max rank going up and
--     quests turned in, held in the state until the bridge confirms a state
--     that carried them.
--   Session (F6): XP, money, quests and zones since the initial login, written
--     to NQADB.companion.lastSession at logout for the bridge's recap.
--
-- Nothing is sent until the bridge lists "state" and "evt" in bridge.caps, so
-- an older bridge never sees a record it would leave unacked. Nothing here acts
-- in the game: it reads the game and sends that to Bones.

local _, ns = ...
local P = {}
ns.Companion = P
local R = ns.R
local Try = ns.Try
local S -- ns.MapShared, once Map.lua has loaded

P.CHAT_ID = ns.COMPANION_CHAT -- the Companion chat: fixed, so every session finds it again

-- The companion rides on the chat's paths (sending, slots, the hello): an error
-- in it must never break those. Other files call in through P.Call, which
-- catches it, keeps it for /bones state and /bones diag, and returns nothing.
function P.Call(name, ...)
	local fn = P[name]
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c = pcall(fn, ...)
	if ok then return a, b, c end
	R.companionError = { text = tostring(a), at = GetTime(), where = name }
	return nil
end
local KINDS = { "level_up", "route_done", "route_stale", "zone_first", "bags_full", "gear_breaking" } -- flush order
local WORDS = { level = "level_up", route = "route_done", stale = "route_stale", zone = "zone_first", bags = "bags_full", repair = "gear_breaking", recap = "recap" }
local LABEL = {
	level_up = "level-ups",
	route_done = "a finished route",
	route_stale = "3 or more quests no route covers",
	zone_first = "a first visit to a zone",
	bags_full = "bags almost full",
	gear_breaking = "gear needs repair",
	recap = "a recap after you log off",
}
local STALE_QUESTS = 3 -- picked up, and on no map stop
local STALE_WAIT = 90 -- s after the last pickup: a quest hub hands out several
local GAP = 120 -- s between automatic turns (level-ups excepted)
local AFTER_COMBAT = 3
-- Bytes (F1, PROTOCOL §2.6): the body on the strip (deflated with cap z; a
-- frame's 3,200 less the record's header), and the JSON a bridge with cap qlog
-- takes, else an older bridge's 2,800; titles shortened to fit, as prefixes.
local STATE_BUDGET = { BODY = 3100, JSON = 12000, LEGACY_JSON = 2800, TITLE_SHORT = 24, TITLE_TINY = 12 }
local STATE_DWELL = 8 -- s a state stays on the strip after it's queued, with or without a record beside it
local STR_MAX = 60 -- bytes per game string
-- No limit on quests: the whole log goes, whatever its cap (ns.QuestLogMax).
local LIMITS = { obj = 5, poi = 40, prof = 6, gear = 19, pending = 10, zones = 20 }
-- What goes while over budget: optional bags, auras, reputation, target and
-- group first, then the existing order (F1): detail,
-- first the objectives of quests ready to turn in (all done), then from every
-- quest, then where their chains lead (Chains.lua) and their levels; the
-- chains to start go before the objectives' texts; then professions (a message then
-- sends its context's Professions line: P.ForSend) and the milestones (those
-- wait for the next state); then titles cut to 24 bytes, then 12 (a bridge
-- with cap qlog puts back the ones it has seen whole), and titles last of
-- all: every quest's id and ready flag, the least that goes. A quest itself
-- never goes.
local DROP_ORDER = { "bags", "auras", "rep", "target", "group", "rewards", "rested", "hearth", "talents", "durability", "gear", "poi", "quests.obj.done", "chainStarts", "quests.obj.text", "quests.obj", "quests.chain", "quests.level",
	"prof", "pending", "quests.title.short", "quests.title.tiny", "quests.title" }
-- When the voice companion asks for bags and gear (odd/tasks/nqa-voice-controls.md T15): they stay
-- until the quests' detail has gone, so a long quest log can't push them out of the frame.
-- The small sections (rested, hearth, talents) stay too: they cost a few bytes and the voice asked for them.
local INV_DROP_ORDER = { "auras", "rep", "target", "group", "poi", "quests.obj.done", "chainStarts", "quests.obj.text", "quests.obj", "quests.chain", "quests.level",
	"prof", "pending", "rewards", "rested", "hearth", "talents", "quests.title.short", "quests.title.tiny", "quests.title", "bags", "gear", "durability" }
-- Quest titles go before bags and gear here: a long log (30 quests of long titles) doesn't fit beside
-- them otherwise, and the bridge puts the titles back from the ones it already holds (fillTitles, cap
-- qlog); every quest keeps its id and ready flag.
local FIRED_MAX = 300
local LEVEL_SETTLE = 2 -- s: during PLAYER_LEVEL_UP the unit's level and XP can still be the old ones
local QUEUE_STALE = 1800 -- s: a queued event older than this (a long fight, a relog) is dropped

local uncovered = {} -- quest id -> time() it was picked up, while no stop names it
local asked = {} -- quest ids a route_stale turn already asked about (this session)
local titles = {} -- quest id -> title, so a turn-in can be named after the quest has left the log

---------------------------------------------------------------------------
-- Saved data: NQADB.companion (account-wide), one table per character
---------------------------------------------------------------------------

local function DB()
	local db = ns.db
	if type(db.companion) ~= "table" then db.companion = {} end
	local c = db.companion
	if c.on == nil then c.on = true end
	if type(c.kinds) ~= "table" then c.kinds = {} end
	for _, k in ipairs(KINDS) do
		if c.kinds[k] == nil then c.kinds[k] = true end
	end
	if c.kinds.recap == nil then c.kinds.recap = true end
	if type(c.fired) ~= "table" then c.fired = {} end
	if type(c.chars) ~= "table" then c.chars = {} end
	c.count = tonumber(c.count) or 0
	c.seq = math.floor(tonumber(c.seq) or 0)
	if type(c.carried) ~= "table" then c.carried = {} end -- seq -> { sid, ids }: the milestones each state carried (F4)
	return c
end
P.DB = DB

local CharKey = ns.CharKey -- "Name-Realm" (Chats.lua; code health AD-14)

local function CharDB()
	local c = DB()
	local key = CharKey()
	local ch = c.chars[key]
	if type(ch) ~= "table" then
		ch = {}
		c.chars[key] = ch
	end
	if type(ch.zones) ~= "table" then ch.zones = {} end
	if type(ch.profMax) ~= "table" then ch.profMax = {} end
	if type(ch.pending) ~= "table" then ch.pending = {} end
	if type(ch.queue) ~= "table" then ch.queue = {} end -- kind -> { args, onces, due, at }: events waiting for their moment
	if type(ch.nudgeKinds) ~= "table" then ch.nudgeKinds = {} end
	if ch.nudgeKinds.bags_full == nil then ch.nudgeKinds.bags_full = true end
	if ch.nudgeKinds.gear_breaking == nil then ch.nudgeKinds.gear_breaking = true end
	return ch, key
end
P.CharDB = CharDB

-- Inventory switches are per character; keep the older switches' storage.
function P.KindOn(kind)
	if kind == "bags_full" or kind == "gear_breaking" then return CharDB().nudgeKinds[kind] end
	return DB().kinds[kind]
end

local function NewSid()
	return string.format("%04x%04x%04x%04x", math.random(0, 0xFFFF), math.random(0, 0xFFFF), math.random(0, 0xFFFF), math.random(0, 0xFFFF))
end

-- A "once" key is remembered with its time; the oldest go past FIRED_MAX.
local function Fire(key)
	local c = DB()
	c.fired[key] = time()
	local n, oldestK, oldestT = 0, nil, nil
	for k, t in pairs(c.fired) do
		n = n + 1
		local tt = tonumber(t) or 0
		if not oldestT or tt < oldestT then oldestK, oldestT = k, tt end
	end
	if n > FIRED_MAX and oldestK then c.fired[oldestK] = nil end
end

---------------------------------------------------------------------------
-- A small JSON writer: objects keep their key order, so sizes, the drop order
-- and the bridge's hash are deterministic. Whole numbers print without ".0"
-- on Lua 5.1 (the game) and 5.3 (the test VM).
---------------------------------------------------------------------------

local J = {}
P.JSON = J

-- O("k1", v1, "k2", v2, ...): an object; nil values are left out.
local function O(...)
	local list, n = {}, select("#", ...)
	for i = 1, n, 2 do
		local k, v = select(i, ...)
		list[#list + 1] = { k, v }
	end
	return { _o = list }
end
J.O = O

-- An object's value for k (O's), or nil.
local function Get(o, k)
	for _, kv in ipairs(type(o) == "table" and type(o._o) == "table" and o._o or {}) do
		if kv[1] == k then return kv[2] end
	end
end

local ESC = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function Str(s)
	local body = tostring(s):gsub('[%c"\\]', function(ch) return ESC[ch] or string.format("\\u%04x", ch:byte()) end)
	return '"' .. body .. '"'
end

local function Num(n)
	if n ~= n or n == math.huge or n == -math.huge then return "0" end
	if n == math.floor(n) and math.abs(n) < 2 ^ 53 then return string.format("%d", n) end
	local s = string.format("%.2f", n):gsub("0+$", ""):gsub("%.$", "")
	return s
end

function J.encode(v)
	local t = type(v)
	if t == "string" then return Str(v) end
	if t == "number" then return Num(v) end
	if t == "boolean" then return v and "true" or "false" end
	if t == "table" then
		local parts = {}
		if v._o then
			for _, kv in ipairs(v._o) do
				if kv[2] ~= nil then parts[#parts + 1] = Str(kv[1]) .. ":" .. J.encode(kv[2]) end
			end
			return "{" .. table.concat(parts, ",") .. "}"
		end
		for i = 1, #v do parts[i] = J.encode(v[i]) end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	return "null"
end

-- Game text as data: escapes and links taken out, then every |, newline and
-- control character; at most 60 bytes, cut at a UTF-8 boundary (F1).
local function Clean(s, max)
	s = tostring(s or "")
	max = tonumber(max) or STR_MAX -- a stray second value (an API's extra return) must not become the limit
	-- Colour codes old (|cAARRGGBB) and new (|cnIQ1:), links (keeping their text), textures, atlases:
	-- [code health AD-14] by the key check's own StripEscapes (Chats.lua), the one stripper, with a
	-- link's name out of its brackets first, as game data names things.
	s = ns.Chats.StripEscapes((s:gsub("|H([^|]*)|h%[([^\r\n]-)%]|h", "|H%1|h%2|h")))
	s = s:gsub("|", ""):gsub("%c", " "):gsub("%s+", " ")
	return ns.Utf8Cut(ns.Trim(s), max)
end
P.Clean = Clean

local function Round1(v)
	return math.floor(v * 10 + 0.5) / 10
end

local function Whole(v)
	v = tonumber(v)
	if not v then return nil end
	return math.floor(v)
end

---------------------------------------------------------------------------
-- Reading the game (F1). Every API is optional: what the client lacks is left
-- out, never guessed (C0: /bones apicheck says what's there).
---------------------------------------------------------------------------

local function QuestObjectives(id)
	local out = {}
	for _, o in ipairs(Try(C_QuestLog and C_QuestLog.GetQuestObjectives, id) or {}) do
		if #out >= LIMITS.obj then break end
		if type(o) == "table" then
			-- The client puts the count in the text too ("Prairie Wolf Paw: 3/6"); have and need carry it.
			local text = tostring(o.text or ""):gsub("^%s*%d+%s*/%s*%d+%s*", ""):gsub("%s*:?%s*%d+%s*/%s*%d+%s*$", "")
			out[#out + 1] = { text = Clean(text), have = Whole(o.numFulfilled) or 0, need = Whole(o.numRequired) or 0 }
		end
	end
	return out
end

-- Every quest in the log, in log order (ns.QuestLog: every row the game lists,
-- under a collapsed header too; headers and hidden quests aren't quests), and
-- { count, max, source, unread } for the state's questCount, questMax and
-- questUnread. The game's cap is only reported: nothing here cuts the list.
-- chain: where the quest's chain leads (Chains.lua), for a quest whose chain
-- leads to a dungeon, a raid or a rare reward. Chains.lua is a newer file than
-- this one: a /reload after an update runs without it until WoW restarts.
function P.Quests()
	local QL = C_QuestLog
	local out = {}
	local list, meta = ns.QuestLog()
	for _, q in ipairs(list) do
		local id = q.id
		local title = Clean(q.title)
		if title ~= "" then titles[id] = title end
		local trivial = Try(QL and QL.IsQuestTrivial, id)
		if type(trivial) ~= "boolean" then trivial = nil end -- the API missing: left out, not guessed
		out[#out + 1] = {
			id = id, title = title, level = Whole(q.level), trivial = trivial,
			complete = q.complete,
			obj = QuestObjectives(id),
			chain = ns.Chains and ns.Chains.Facts(id) or nil,
		}
	end
	return out, meta
end

-- A chain's facts as the state writes them (Chains.Facts), in this order.
local function ChainObj(f)
	if type(f) ~= "table" then return nil end
	local to = Clean(f.to)
	return O("step", f.step, "of", f.of, "to", to ~= "" and to or nil, "kind", f.kind, "item", f.item,
		"quality", f.quality, "choice", f.choice, "next", f.next)
end

-- The chains the character can start (Chains.Starts): each first step's id,
-- title (when the client has it), level and zone, then its chain's facts but
-- the step (always 1); nil when there are none.
local function ChainStarts(level, quests)
	if not ns.Chains then return nil end
	local inLog = {}
	for _, q in ipairs(quests) do inLog[q.id] = true end
	local out = {}
	for _, st in ipairs(ns.Chains.Starts(level, inLog) or {}) do
		local title, zone, f = Clean(st.title), Clean(st.zone), st.facts or {}
		local to = Clean(f.to)
		out[#out + 1] = O("id", st.id, "title", title ~= "" and title or nil, "level", st.level, "zone", zone ~= "" and zone or nil,
			"of", f.of, "to", to ~= "" and to or nil, "kind", f.kind, "item", f.item, "quality", f.quality, "choice", f.choice, "next", f.next)
	end
	if #out == 0 then return nil end
	return out
end

local function Poi(mapId)
	if type(mapId) ~= "number" then return nil end
	local list = Try(C_QuestLog and C_QuestLog.GetQuestsOnMap, mapId)
	if type(list) ~= "table" then return nil end
	local out = {}
	for _, q in ipairs(list) do
		if #out >= LIMITS.poi then break end
		if type(q) == "table" and type(q.questID) == "number" and type(q.x) == "number" and type(q.y) == "number" then
			out[#out + 1] = O("id", q.questID, "map", mapId, "x", Round1(q.x * 100), "y", Round1(q.y * 100))
		end
	end
	if #out == 0 then return nil end -- no points: the key stays out (F1: only if the API returns them)
	return out
end

-- Equipped items: slot, item id and item level (F1 gear; F5 reads them too).
local function ItemLevel(slot, link)
	if type(ItemLocation) == "table" and ItemLocation.CreateFromEquipmentSlot and C_Item and C_Item.GetCurrentItemLevel then
		local loc = Try(ItemLocation.CreateFromEquipmentSlot, ItemLocation, slot)
		local lvl = loc and Try(C_Item.GetCurrentItemLevel, loc)
		if type(lvl) == "number" and lvl > 0 then return math.floor(lvl) end
	end
	if link then
		local lvl = Try(C_Item and C_Item.GetDetailedItemLevelInfo, link)
		if type(lvl) == "number" and lvl > 0 then return math.floor(lvl) end
		local _, _, _, ilvl = Try(C_Item and C_Item.GetItemInfo, link)
		if type(ilvl) == "number" and ilvl > 0 then return math.floor(ilvl) end
	end
	return nil
end
P.ItemLevel = ItemLevel

function P.Gear(withNames)
	if ns.InCombat() or type(GetInventoryItemID) ~= "function" then return nil end
	local out = {}
	for slot = 1, 19 do
		local id = Try(GetInventoryItemID, "player", slot)
		if type(id) == "number" and id > 0 then
			local link = Try(GetInventoryItemLink, "player", slot)
			local info = P.ItemData(id)
			out[#out + 1] = O("slot", slot, "id", id, "name", withNames and info.name or nil, "ilvl", ItemLevel(slot, link),
				"quality", info.quality, "sell", info.sell)
		end
	end
	if #out == 0 then return nil end
	return out
end


-- Optional extra context: no reads in combat, no other player's name or aura
-- source. Missing APIs and uncached item metadata are unknown, never guessed.
local function Int(v, max)
	if type(v) ~= "number" or v ~= v or v < 0 or v > (max or 2147483647) then return nil end
	return math.floor(v)
end

-- ns.Try keeps only seven returns. Item info's equip location and vendor price
-- are returns nine and eleven, so keep them with a guarded pcall here instead.
-- Cached metadata only: no tooltip, request/load call or UI change.
function P.ItemData(id)
	if ns.InCombat() then return {} end
	local fn = C_Item and C_Item.GetItemInfo
	if type(fn) ~= "function" then fn = GetItemInfo end
	if type(fn) ~= "function" then return {} end
	local ok, name, _, quality, ilvl, minLevel, _, _, _, equipLoc, _, sell = pcall(fn, id)
	if not ok or type(name) ~= "string" or name == "" then return {} end
	return { name = Clean(name), quality = Int(quality, 8), sell = Int(sell),
		equipLoc = type(equipLoc) == "string" and equipLoc ~= "" and Clean(equipLoc) or nil,
		ilvl = Int(ilvl, 10000), minLevel = Int(minLevel, 1000) }
end

function P.Rewards(quests)
	if ns.InCombat() then return nil end
	-- These legacy reward readers use the CURRENT selection. Do not select even
	-- temporarily: that could alter the player's quest pane. Read only the already
	-- selected quest, if it is in the first 20 log quests; other rewards are unknown.
	local selected = Int(Try(C_QuestLog and C_QuestLog.GetSelectedQuest))
	if not selected or selected == 0 then return nil end
	local inLog = false
	for i, q in ipairs(quests or {}) do
		if i > 20 then break end
		if q.id == selected then inLog = true; break end
	end
	if not inLog then return nil end
	local items = {}
	for _, choice in ipairs({ false, true }) do
		local countFn, infoFn = GetNumQuestLogRewards, GetQuestLogRewardInfo
		if choice then countFn, infoFn = GetNumQuestLogChoices, GetQuestLogChoiceInfo end
		local n = Int(Try(countFn))
		for i = 1, math.min(n or 0, 6 - #items) do
			local name, _, count, quality, _, id = Try(infoFn, i)
			id = Int(id)
			if id and id > 0 then
				local info = P.ItemData(id)
				name = type(name) == "string" and Clean(name) or info.name
				items[#items + 1] = O("id", id, "name", name, "quality", Int(quality, 8) or info.quality,
					"equipLoc", info.equipLoc, "ilvl", info.ilvl, "minLevel", info.minLevel,
					"count", Int(count, 1000000), "choice", choice)
			end
		end
	end
	if #items > 0 then return { O("id", selected, "items", items) } end
end

function P.Durability()
	if ns.InCombat() then return nil end
	local rows, out = {}, {}
	for slot = 1, 19 do
		local current, maximum = Try(GetInventoryItemDurability, slot)
		current, maximum = Int(current), Int(maximum)
		if current and maximum and maximum > 0 and current <= maximum then
			rows[#rows + 1] = { slot = slot, pct = math.floor(current * 100 / maximum) }
		end
	end
	table.sort(rows, function(a, b) return a.pct < b.pct or (a.pct == b.pct and a.slot < b.slot) end)
	for _, row in ipairs(rows) do out[#out + 1] = O("slot", row.slot, "pct", row.pct) end
	if #out > 0 then return out end
end

function P.Rested()
	if ns.InCombat() then return nil end
	return Int(Try(GetXPExhaustion))
end

function P.Hearth()
	if ns.InCombat() then return nil end
	local bind = Try(GetBindLocation)
	bind = type(bind) == "string" and bind ~= "" and Clean(bind) or nil
	local fn = C_Container and C_Container.GetItemCooldown
	if type(fn) ~= "function" then fn = C_Item and C_Item.GetItemCooldown end
	if type(fn) ~= "function" then fn = GetItemCooldown end
	local start, duration, enabled = Try(fn, 6948)
	local now, left = Try(GetTime), nil
	if Int(start) and Int(duration) and Int(now) and (enabled == 1 or enabled == true) then
		left = Int(math.max(0, math.ceil(start + duration - now)))
	end
	if bind or left then return O("bind", bind, "left", left) end
end

function P.Talents()
	if ns.InCombat() then return nil end
	local n, out = Int(Try(GetNumTalentTabs)), {}
	for i = 1, math.min(n or 0, 5) do
		local name, _, points = Try(GetTalentTabInfo, i)
		points = Int(points, 1000)
		if type(name) == "string" and points then
			out[#out + 1] = O("tree", i, "name", Clean(name), "points", points)
		end
	end
	if #out > 0 then return out end
end

function P.Bags()
	if ns.InCombat() then return nil end
	local C = C_Container
	if not (C and type(C.GetContainerNumSlots) == "function") then return nil end
	local free, slots, known, partial, freeKnown = 0, 0, false, false, true
	local items, byId = {}, {}
	for bag = 0, math.min(Int(NUM_BAG_SLOTS, 10) or 4, 4) do
		local n = Int(Try(C.GetContainerNumSlots, bag), 200)
		local f = Int(Try(C.GetContainerNumFreeSlots, bag), 200)
		if n then slots, known = slots + n, true else partial = true end
		if f then free = free + f else partial, freeKnown = true, false end
		for slot = 1, n or 0 do
			local ok, info = false, nil
			if type(C.GetContainerItemInfo) == "function" then ok, info = pcall(C.GetContainerItemInfo, bag, slot) end
			if not ok then partial = true end
			if type(info) == "table" then
				local id, count = Int(info.itemID), Int(info.stackCount, 1000000)
				local qi = Try(C.GetContainerItemQuestInfo, bag, slot)
				local _, _, _, _, _, class, sub = Try((C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant, id)
				local kind
				if type(qi) == "table" and (qi.isQuestItem == true or (Int(qi.questID) or 0) > 0) then kind = "quest"
				elseif class == 0 and sub == 5 then kind = "foodDrink"
				elseif class == 0 and sub == 1 then kind = "potion"
				elseif class == 5 or class == 7 then kind = "reagent" end
				if not class then partial = true end
				if id and id > 0 and count and count > 0 and kind then
					local key = id .. ":" .. kind
					if byId[key] then
						byId[key].count = math.min(1000000, byId[key].count + count)
					elseif #items < 32 then
						local info = P.ItemData(id)
						local item = { id = id, name = info.name, count = count, kind = kind, quality = info.quality, sell = info.sell }
						items[#items + 1], byId[key] = item, item
					else partial = true end
				end
			end
		end
	end
	if not known then return nil end
	local out = {}
	for _, i in ipairs(items) do out[#out + 1] = O("id", i.id, "name", i.name, "count", i.count, "kind", i.kind, "quality", i.quality, "sell", i.sell) end
	return O("free", freeKnown and free or nil, "slots", slots, "items", out, "partial", partial and true or nil)
end

-- Whole seconds an aura has left when the state is read. expirationTime is on the
-- GetTime() clock, which means nothing outside this session; 0 means it never runs out (nil).
local function AuraLeft(a)
	local e = a.expirationTime
	if type(e) ~= "number" or e ~= e or e <= 0 then return nil end
	return Int(math.max(0, e - GetTime() + 0.5))
end

function P.Auras()
	if ns.InCombat() or not (C_UnitAuras and type(C_UnitAuras.GetAuraDataByIndex) == "function") then return nil end
	local out = {}
	for _, filter in ipairs({ "HELPFUL", "HARMFUL" }) do
		for i = 1, 32 do
			local a = Try(C_UnitAuras.GetAuraDataByIndex, "player", i, filter)
			if type(a) ~= "table" then break end
			local id = Int(a.spellId)
			if id and id > 0 then
				out[#out + 1] = O("id", id, "name", Clean(a.name), "kind", filter == "HELPFUL" and "buff" or "debuff",
					"count", Int(a.applications, 1000000), "duration", Int(a.duration), "left", AuraLeft(a))
			end
			if #out >= 32 then return out end
		end
	end
	return out
end

local function RepValue(v)
	if type(v) == "number" and v == v and math.abs(v) <= 2147483647 then return math.floor(v) end
end

local function LegacyFaction(i)
	if type(GetFactionInfo) ~= "function" then return nil end
	local ok, name, _, reaction, min, max, value, _, _, header, _, _, watched, _, id = pcall(GetFactionInfo, i)
	if ok then return { name = name, reaction = reaction, currentReactionThreshold = min, nextReactionThreshold = max,
		currentStanding = value, isHeader = header, isWatched = watched, factionID = id } end
end

function P.Reputations()
	if ns.InCombat() then return nil end
	local C = C_Reputation
	local n = Int(Try((C and C.GetNumFactions) or GetNumFactions), 1000)
	local watched = Try(C and C.GetWatchedFactionData)
	if not watched and type(GetWatchedFactionInfo) == "function" then
		local name, reaction, min, max, value, id = Try(GetWatchedFactionInfo)
		watched = { name = name, reaction = reaction, currentReactionThreshold = min, nextReactionThreshold = max, currentStanding = value, factionID = id }
	end
	local out, seen = {}, {}
	local function Add(f, isWatched)
		if type(f) ~= "table" or f.isHeader then return end
		local id = Int(f.factionID)
		if not id or id == 0 or seen[id] then return end
		seen[id] = true
		out[#out + 1] = O("id", id, "name", Clean(f.name), "standing", Int(f.reaction, 8),
			"min", RepValue(f.currentReactionThreshold), "max", RepValue(f.nextReactionThreshold), "value", RepValue(f.currentStanding), "watched", isWatched and true or nil)
	end
	Add(watched, true)
	for i = 1, math.min(n or 0, 300) do
		if #out >= 6 then break end
		local f = (C and C.GetFactionDataByIndex) and Try(C.GetFactionDataByIndex, i) or LegacyFaction(i)
		if type(f) == "table" then
			local v, min, max = tonumber(f.currentStanding), tonumber(f.currentReactionThreshold), tonumber(f.nextReactionThreshold)
			if f.isWatched or (v and min and max and v > min and v < max) then Add(f, f.isWatched) end
		end
	end
	return #out > 0 and out or nil
end

function P.Target()
	if ns.InCombat() or not ns.Readable(Try(UnitExists, "target")) or ns.Readable(Try(UnitIsPlayer, "target")) ~= false or ns.Readable(Try(UnitPlayerControlled, "target")) ~= false then return nil end
	-- Check the kind before even calling UnitName: player targets stay private.
	return O("name", Clean(ns.Readable(Try(UnitName, "target"))), "level", Int(Try(UnitLevel, "target"), 1000),
		"classification", Clean(Try(UnitClassification, "target")), "reaction", Int(Try(UnitReaction, "target", "player"), 8))
end

function P.Group()
	if ns.InCombat() then return nil end
	local n = Int(Try(GetNumGroupMembers), 40)
	if not n and type(GetNumPartyMembers) == "function" then
		local party = Int(Try(GetNumPartyMembers), 4)
		if party and party > 0 then n = party + 1 end
	end
	if not n or n == 0 then return nil end
	local raid, members = Try(IsInRaid), {}
	for i = 1, n do
		local unit = raid and ("raid" .. i) or (i == 1 and "player" or ("party" .. (i - 1)))
		local class = select(2, Try(UnitClass, unit))
		if ns.IsSecret(class) then class = nil end
		local role = Try(UnitGroupRolesAssigned, unit)
		if role ~= "TANK" and role ~= "HEALER" and role ~= "DAMAGER" then role = nil end
		members[#members + 1] = O("class", class and Clean(class) or nil, "level", Int(Try(UnitLevel, unit), 1000), "role", role)
	end
	return O("size", n, "members", members)
end

local function Location()
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	local x, y
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" and (pos.x > 0 or pos.y > 0) then
			x, y = Round1(pos.x * 100), Round1(pos.y * 100)
		end
	else
		mapId = nil
	end
	local zone = Clean((Try(GetRealZoneText)) or (Try(GetZoneText)))
	local sub = Clean((Try(GetSubZoneText)))
	return O("map", mapId, "zone", zone ~= "" and zone or nil, "sub", sub ~= "" and sub or nil, "x", x, "y", y), mapId, zone
end

local function Character()
	local _, classFile = Try(UnitClass, "player")
	local race = Try(UnitRace, "player")
	local xpMax = Try(UnitXPMax, "player")
	-- Right after PLAYER_LEVEL_UP the unit may still report the old level; the event's is right.
	local level = Whole(Try(UnitLevel, "player"))
	if R.levelUpTo and (level or 0) < R.levelUpTo then level = R.levelUpTo end
	return O("name", Clean(ns.Readable(Try(UnitName, "player"))), "realm", Clean((Try(GetRealmName))),
		"class", classFile and Clean(classFile) or nil, "race", race and Clean(race) or nil,
		"level", level, "xp", Whole(Try(UnitXP, "player")),
		"xpMax", Whole(xpMax), "money", Whole(Try(GetMoney)))
end

---------------------------------------------------------------------------
-- The state (F1): build, limit, number
---------------------------------------------------------------------------

local function PendingList(ch)
	local out = {}
	for _, p in ipairs(ch.pending) do
		if #out >= LIMITS.pending then break end
		if p.kind == "zone" then
			out[#out + 1] = O("kind", "zone", "zone", p.zone, "t", p.t)
		elseif p.kind == "prof" then
			out[#out + 1] = O("kind", "prof", "name", p.name, "max", p.max, "t", p.t)
		elseif p.kind == "quest_done" then
			out[#out + 1] = O("kind", "quest_done", "id", p.id, "title", p.title, "t", p.t)
		end
	end
	return out
end

-- Which droppable parts the state has at all: only those count as omitted.
local function Present(g)
	local has = { gear = g.gear ~= nil, poi = g.poi ~= nil, chainStarts = g.chainStarts ~= nil, prof = g.prof ~= nil and #g.prof > 0, pending = g.pending ~= nil and #g.pending > 0 } -- [QL-F-14] none in P.ListOnlyOf's
	for _, k in ipairs({ "bags", "auras", "rep", "target", "group", "rewards", "durability", "rested", "hearth", "talents" }) do has[k] = g[k] ~= nil end
	for _, q in ipairs(g.quests) do
		local len = #(q.title or "")
		if len > 0 then has["quests.title"] = true end
		if len > STATE_BUDGET.TITLE_TINY then has["quests.title.tiny"] = true end
		if len > STATE_BUDGET.TITLE_SHORT then has["quests.title.short"] = true end
		if q.level ~= nil or q.trivial ~= nil then has["quests.level"] = true end
		if q.chain ~= nil then has["quests.chain"] = true end
		if #q.obj > 0 then has["quests.obj"] = true end
		if #q.obj > 0 and q.complete then has["quests.obj.done"] = true end
		for _, o in ipairs(q.obj) do
			if o.text and o.text ~= "" then has["quests.obj.text"] = true end
		end
	end
	return has
end

-- The drop's parts the state had, in DROP_ORDER: the state's omitted.
local function Omitted(g, drop)
	local omitted, has = {}, Present(g)
	for _, k in ipairs(DROP_ORDER) do
		if drop[k] and has[k] then omitted[#omitted + 1] = k end
	end
	return omitted
end

-- A quest's title as the drop has it, and true when that shortened it: always
-- a byte prefix of the whole title (cut at a UTF-8 boundary, nothing added),
-- so the bridge can put the rest back from a title it already holds. With
-- titles dropped there's none, and no cut flag either: none says as much.
local function TitleAt(q, drop)
	local title = q.title or ""
	if drop["quests.title"] then return nil, nil end
	local max = (drop["quests.title.tiny"] and STATE_BUDGET.TITLE_TINY) or (drop["quests.title.short"] and STATE_BUDGET.TITLE_SHORT)
	if max and #title > max then return ns.Utf8Cut(title, max), true end
	return title, nil
end

local function Encode(g, drop, seq, t)
	local quests = {}
	for _, q in ipairs(g.quests) do
		local obj
		if not drop["quests.obj"] and not (drop["quests.obj.done"] and q.complete) then
			obj = {}
			for _, o in ipairs(q.obj) do
				obj[#obj + 1] = O("text", (not drop["quests.obj.text"]) and o.text or nil, "have", o.have, "need", o.need)
			end
		end
		local title, cut = TitleAt(q, drop)
		local level, trivial = q.level, q.trivial
		if drop["quests.level"] then level, trivial = nil, nil end
		quests[#quests + 1] = O("id", q.id, "title", title, "cut", cut, "level", level,
			"trivial", trivial, "complete", q.complete, "obj", obj, "chain", (not drop["quests.chain"]) and ChainObj(q.chain) or nil)
	end
	-- The count and the game's cap go before the list, so the bridge can say the
	-- list is whole, or that the game listed some with no id yet (ns.QuestLog: unread).
	local qm = g.questMeta or {}
	local unread = tonumber(qm.unread) or 0
	return J.encode(O("v", 1, "sid", g.sid, "seq", seq, "t", t, "char", g.char, "loc", g.loc,
		"questCount", #g.quests, "questMax", qm.max, "questUnread", unread > 0 and unread or nil, "quests", quests,
		"poi", (not drop.poi) and g.poi or nil, "chainStarts", (not drop.chainStarts) and g.chainStarts or nil,
		"prof", (not drop.prof) and g.prof or nil, "gear", (not drop.gear) and g.gear or nil,
		"pending", (not drop.pending) and g.pending or nil,
		"bags", (not drop.bags) and g.bags or nil, "auras", (not drop.auras) and g.auras or nil,
		"rep", (not drop.rep) and g.rep or nil, "target", (not drop.target) and g.target or nil,
		"group", (not drop.group) and g.group or nil,
		"rewards", (not drop.rewards) and g.rewards or nil, "durability", (not drop.durability) and g.durability or nil,
		"rested", (not drop.rested) and g.rested or nil, "hearth", (not drop.hearth) and g.hearth or nil,
		"talents", (not drop.talents) and g.talents or nil, "omitted", Omitted(g, drop)))
end
P.Encode = Encode

-- What goes in the state, read from the game now.
function P.Gather()
	local ch = CharDB()
	if not ch.sid then ch.sid = NewSid() end
	local loc, mapId = Location()
	local prof = {}
	for _, p in ipairs(ns.Chats.Professions()) do
		if #prof >= LIMITS.prof then break end
		prof[#prof + 1] = O("name", Clean(p.name), "rank", Whole(p.rank), "max", Whole(p.max))
	end
	local pendingIds = {}
	for i, p in ipairs(ch.pending) do
		if i > LIMITS.pending then break end
		pendingIds[#pendingIds + 1] = p.pid
	end
	local quests, questMeta = P.Quests()
	local char = Character()
	return {
		sid = ch.sid, char = char, loc = loc, quests = quests, questMeta = questMeta, poi = Poi(mapId),
		chainStarts = ChainStarts(Get(char, "level"), quests),
		prof = prof, gear = P.Gear(), pending = PendingList(ch), pendingIds = pendingIds,
		bags = P.Bags(), auras = P.Auras(), rep = P.Reputations(), target = P.Target(), group = P.Group(),
		rewards = P.Rewards(quests), durability = P.Durability(), rested = P.Rested(), hearth = P.Hearth(), talents = P.Talents(),
	}
end

-- The JSON for g, fitted (F1, PROTOCOL §2.6): the body as it goes on the strip
-- (deflated with cap z) within STATE_BUDGET.BODY, and the JSON within what the
-- bridge takes (12,000 bytes with cap qlog, else 2,800). While it's over, the
-- parts in DROP_ORDER go, each named in omitted: every quest stays, with its
-- id and whether it's ready to turn in, and the last step leaves those alone
-- (with the character and place): some 30 bytes a quest, so a log of 70
-- quests fits even an older bridge's 2,800. too_large is only past that.
-- how: { z, qlog, from } (from: the step the last Build ended at; the fit
-- starts one step richer, so a state that didn't change takes one or two
-- encodes, and one that shrank gets its detail back a step a Build).
-- Returns json, drop, tooLarge, the deflated body when that is what goes on
-- the strip, and the step it ended at.
function P.Fit(g, seq, t, how)
	how = how or {}
	local ORDER = how.order or DROP_ORDER
	local jsonMax = how.qlog and STATE_BUDGET.JSON or STATE_BUDGET.LEGACY_JSON
	local has = Present(g)
	-- Empty objective lists go with that step too (unnamed in omitted: nothing was in them).
	has["quests.obj"] = has["quests.obj"] or #g.quests > 0
	local drop = {}
	local i = math.max(0, math.min(#ORDER, (tonumber(how.from) or 0) - 1))
	for k = 1, i do drop[ORDER[k]] = has[ORDER[k]] or nil end
	while true do
		local json = Encode(g, drop, seq, t)
		if #json <= jsonMax then
			local packed = how.z and ns.Transport.Deflate(json) or nil
			if #(packed or json) <= STATE_BUDGET.BODY then return json, drop, false, packed, i end
		end
		repeat i = i + 1 until i > #ORDER or has[ORDER[i]]
		if i > #ORDER then break end
		drop[ORDER[i]] = true
	end
	return J.encode(O("v", 1, "sid", g.sid, "seq", seq, "state", "too_large")), drop, true, nil, #ORDER
end

-- Build the state now. seq goes up only when the body (all but seq and t) changed.
function P.Build()
	if not ns.db then return nil end
	local c = DB()
	local g = P.Gather()
	local inv = R.statePreferInv == true -- the voice asked for bags and gear (P.VoiceWanted)
	if inv then g.gear = P.Gear(true) end
	local listOnly = P.ListOnly() -- [QL-F-14] the app's companion switch off: the quest log alone
	if listOnly then g = P.ListOnlyOf(g) end
	local caps = P.Caps()
	local nextSeq = math.max(c.seq, R.bridgeStateSeq or 0) + 1
	-- The fit starts from where the last one ended, for the same caps.
	local fitKey = (caps.z and "z" or "") .. (caps.qlog and "q" or "") .. (listOnly and "l" or "") .. (inv and "i" or "") -- [QL-F-14]
	local from = R.fitStep and R.fitStep.key == fitKey and R.fitStep.i or 0
	if listOnly then from = math.max(from, #DROP_ORDER - 2) end -- [QL-F-14] at the title steps, the last three
	local json, drop, tooLarge, packed, step = P.Fit(g, nextSeq, time(), { z = caps.z, qlog = caps.qlog, from = from, order = inv and INV_DROP_ORDER or nil })
	R.fitStep = { key = fitKey, i = step }
	local core = tooLarge and ("too_large:" .. g.sid) or Encode(g, drop, 0, 0)
	if core ~= c.stateCore or type(c.stateJson) ~= "string" then
		c.seq = nextSeq
		c.stateCore, c.stateJson = core, json
		c.stateOmitted = Omitted(g, drop)
		c.stateTooLarge = tooLarge or nil
		R.statePacked = packed and { seq = c.seq, body = packed } or nil -- deflated once: QueueState sends it
		-- The milestones this state carries, confirmed when the bridge has it (F4);
		-- none when they were left out to fit: they wait for the next state.
		-- Saved, so a confirmation after a /reload still finds them.
		c.carried[c.seq] = { sid = g.sid, ids = (tooLarge or drop.pending) and {} or g.pendingIds }
		for s in pairs(c.carried) do
			if s < c.seq - 20 then c.carried[s] = nil end
		end
	end
	local sp = R.statePacked
	return { json = c.stateJson, seq = c.seq, sid = g.sid, bytes = #c.stateJson, omitted = c.stateOmitted or {}, tooLarge = c.stateTooLarge,
		packed = sp and sp.seq == c.seq and sp.body or nil, quests = g.questMeta }
end

---------------------------------------------------------------------------
-- The bridge: caps, the state it has, and sending the state
---------------------------------------------------------------------------

function P.Caps()
	local caps = {}
	local b = R.bridge
	if type(b) == "table" and type(b.caps) == "table" then
		for _, v in pairs(b.caps) do
			if type(v) == "string" then caps[v] = true end
		end
	end
	return caps
end

-- Does the bridge hold this state? Its seq and its session: after a crash the
-- saved seq can fall behind, so a new session's seq may equal the last one's.
-- (A bridge without stateSid is judged by the seq alone.)
local function BridgeHas(seq, sid)
	return seq ~= nil and R.bridgeStateSeq == seq and (R.bridgeStateSid == nil or R.bridgeStateSid == sid)
end
P.BridgeHas = BridgeHas

-- [C-05] The desktop app's companion switch (bridge.usage.autoOn): off
-- until the player turns it on there (PRD §9.4), so off until it says so.
function P.DesktopOn()
	local u = ns.Usage()
	return u ~= nil and u.autoOn == true
end

-- The public build's one runaway fuse, the bridge's (onboarding spec §9.9,
-- The maintainer, 2026-09-26: no limits on anything for public release, this the single
-- exception): over 10 automatic turns whose send times fall within a minute
-- pause automatic help until the player's next typed message. It holds while
-- bridge.usage.autoPaused says so; the events that come then are held by the
-- bridge and ride along with that message.
function P.AutoPaused()
	local u = ns.Usage()
	return u ~= nil and u.autoPaused == true
end

-- [QL-F-14] With the app's companion switch off, the state a typed
-- message carries is the quest log alone: every quest with its
-- id, title and ready flag, the game information PRIVACY.md lists with the
-- character and the place. Objectives, quest levels, quest chains, gear, points
-- of interest, professions and milestones stay home until it's on (P.Build fits it from the
-- title steps; none of those is named in omitted: they weren't left out to fit).
function P.ListOnly()
	return not P.DesktopOn()
end

function P.ListOnlyOf(g)
	local quests = {}
	for i, q in ipairs(g.quests) do quests[i] = { id = q.id, title = q.title, complete = q.complete, obj = {} } end
	return { sid = g.sid, char = g.char, loc = g.loc, quests = quests, questMeta = g.questMeta, pendingIds = {} }
end

-- May the companion send this record type now? On (here and on the desktop),
-- and the bridge lists it.
function P.Active(rtype)
	local c = DB()
	-- Linked: an app has answered this install. Caps alone can come from an
	-- old inbox an app left behind.
	return c.on and ns.Transport.Linked() and P.DesktopOn() and P.Caps()[rtype] == true and R.nonce ~= nil -- [C-05]
end

-- May the state go now? With a typed message (forMessage), whatever Check-Ins
-- says: that switch is about check-ins, and Game Data with Messages is the one
-- for what goes with a message. A message that names no state gets none of the
-- one the bridge holds, which may be old (PROTOCOL §2.6). Else as events: on.
-- [C-05, QL-F-14] A message's state goes whatever the
-- app's companion switch says: while it's off, the quest log alone (P.ListOnly),
-- so every quest reaches Bones with its title. Events and the state on its own
-- still need the switch on (P.Active).
function P.StateMayGo(forMessage)
	if forMessage then return (ns.db.settings.context and P.Caps().state == true and R.nonce ~= nil) and true or false end
	return P.Active("state")
end

-- The state on the strip until the bridge has its seq: beside every record, and
-- on its own for a few seconds (STATE_DWELL). Stream and reload modes put it in
-- the reload outbox, like the hello. Returns the seq, or nil when the companion
-- or the bridge's caps say no. forMessage: for a typed message (P.StateMayGo).
function P.QueueState(dwell, forMessage)
	if not P.StateMayGo(forMessage) then return nil end
	local st = P.Build()
	if not st then return nil end
	local T, db = ns.Transport, ns.db
	if BridgeHas(st.seq, st.sid) then return st.seq end -- the bridge has it
	local args, body = { { "cur", db.cursor }, { "sid", st.sid }, { "seq", st.seq } }, st.json
	-- When the bridge takes it (cap z), deflated and in base64: about 40% of the
	-- JSON's bytes (2,597 to 1,048 in play), so the state draws some 15 strip rows
	-- instead of 35. If the client can't, the JSON as it is. P.Fit sized it for
	-- one frame either way, and Build kept the deflated body it measured.
	local packed = P.Caps().z and (st.packed or T.Deflate(st.json))
	if packed then
		args[#args + 1] = { "z", 1 }
		body = packed
	end
	local wire = T.Record(R.nonce, "state", "", args, body)
	if T.StripOut() then
		-- Drawn after every keyed record (order -1): if they don't all fit, the records go first (§2.6).
		R.stateRec = { wire = wire, seq = st.seq, sid = st.sid, order = -1, untilT = GetTime() + (dwell or STATE_DWELL) }
	else
		T.PutUnkeyed(wire, "state")
	end
	-- [code health AD-03] For a typed message, the message's own record draws the strip
	-- with this state beside it (Transport.NewKeyed): one draw a send, not two.
	if not forMessage then T.RefreshStrip() end
	return st.seq
end

-- Live snapshots are state records only: no event and no model turn. The
-- same caps and companion switches as QueueState apply, plus screen reading.
-- One leading send and one trailing send with the latest data, 30 s apart.
function P.LiveFlush()
	if not ns.db or ns.db.settings.live ~= true then R.liveDirty = nil; return end
	if not R.liveDirty or ns.InCombat() or not ns.Transport.StripOut() or not P.StateMayGo(false) then return end
	local wait = R.liveLast and (30 - (GetTime() - R.liveLast)) or 0
	if wait > 0 then
		if not R.liveTimer and C_Timer and type(C_Timer.After) == "function" then
			R.liveTimer = true
			C_Timer.After(wait, function() R.liveTimer = nil; P.Call("LiveFlush") end)
		end
		return
	end
	if P.QueueState(STATE_DWELL) ~= nil then R.liveLast, R.liveDirty = GetTime(), nil end
end

function P.LiveChanged()
	if not ns.db or ns.db.settings.live ~= true then return end
	R.liveDirty = true
	P.LiveFlush()
end

function P.LiveSwitch(on)
	if not ns.db then return end
	ns.db.settings.live = on == true
	if on then P.LiveChanged() else R.liveDirty = nil end
end

-- The client's own TTS reads only a new companion reply's explicit summary.
-- Game chat, player messages, errors and replayed replies never reach this.
local function VoiceID()
	if not (C_VoiceChat and type(C_VoiceChat.SpeakText) == "function") then return nil end
	local kind = Enum and Enum.TtsVoiceType and Enum.TtsVoiceType.Standard
	local id = kind ~= nil and Try(C_TTSSettings and C_TTSSettings.GetVoiceOptionID, kind) or nil
	if Int(id) then return Int(id) end
	local voices = Try(C_VoiceChat.GetTtsVoices)
	local first = type(voices) == "table" and voices[1]
	return type(first) == "table" and Int(first.voiceID) or nil
end

function P.StopSpeech()
	if not (C_VoiceChat and type(C_VoiceChat.StopSpeakingText) == "function") then return false end
	return pcall(C_VoiceChat.StopSpeakingText)
end

function P.SpeakSummary(summary)
	if not ns.db or ns.db.settings.speak ~= true or type(summary) ~= "string" then return end
	-- The voice companion reads replies aloud instead (/nqa voice read on): the game's TTS stays quiet.
	if ns.db.settings.voiceRead == true then return end
	local id = VoiceID()
	if not id then return end
	local text = Clean((summary:gsub("[<>&]", "")), 300)
	if text == "" then return end
	return pcall(C_VoiceChat.SpeakText, id, text, 0, 100, false)
end

function P.SpeechCommand(rest)
	if rest == "stop" then return P.StopSpeech() and "Speech stopped." or "TTS isn't available in this client." end
	if rest == "on" or rest == "off" then
		ns.db.settings.speak = rest == "on"
		if rest == "off" then P.StopSpeech() end
	end
	if ns.db.settings.speak == true and VoiceID() == nil then return "TTS isn't available in this client." end
	return "Read replies aloud: " .. (ns.db.settings.speak == true and "on." or "off.")
end

-- The voice companion, driven from the game (odd/tasks/nqa-voice-controls.md): Talk opens its
-- microphone for one question, Mute and Pause stop it listening or end the conversation. A command
-- is a keyed vc record on the strip (cap voice), which the app passes to the voice; the voice's own
-- state comes back in the slot (bridge.voice.state: listening, muted, paused, connecting or off).
-- Nothing here touches the game: the record is read by the app, never by WoW.
local VOICE_CMDS = { talk = true, mute = true, unmute = true, pause = true, resume = true, tip = true }
local VOICE_WORDS = {
	listening = "listening", muted = "microphone off", paused = "paused", connecting = "connecting", off = "not running",
}

function P.VoiceState()
	local b = ns.R and ns.R.bridge
	local v = type(b) == "table" and type(b.voice) == "table" and b.voice.state
	return VOICE_WORDS[v] and v or "off"
end

-- Sends one command; returns a line for the chat.
function P.VoiceCommand(cmd)
	if not VOICE_CMDS[cmd] then return nil end
	if not ns.HasCap("voice") then return "Voice controls need the NeverQuestAlone app with voice support running." end
	-- at: when it was pressed (time(), the computer's clock, which the app shares), so a late one is dropped.
	local key = ns.Transport.NewKeyed("vc", "", { { "cmd", cmd }, { "at", time() } }, "")
	if not key then return "The app isn't connected yet." end
	R.voiceAsked = { cmd = cmd, at = GetTime(), from = P.VoiceState() }
	ns.Transport.AfterSend("", "vc", key)
	if P.VoiceState() == "off" then return "Sent. The voice companion isn't running: start it with the app (tools/voice)." end
	-- Talk isn't open yet: the voice says so (a short sound) once it really listens (Astra review 7).
	if cmd == "tip" then return "Asking the voice what to do next…" end
	return cmd == "talk" and "Getting the microphone ready… speak after the sound." or ("Voice: " .. cmd .. ".")
end

-- The voice companion asked for bags and gear (bridge.voice.want grows): the addon answers with a
-- state fitted with them kept, right away (not in combat, and only as the companion switches allow).
function P.VoiceWanted()
	local b = R.bridge
	local want = type(b) == "table" and type(b.voice) == "table" and tonumber(b.voice.want) or nil
	if not want or want == R.voiceWantSeen then return end
	R.voiceWantSeen = want
	if ns.InCombat() then return end
	R.statePreferInv = true
	local ok = pcall(P.QueueState, STATE_DWELL)
	R.statePreferInv = nil
	return ok
end

-- Called when a slot brings bridge.voice: after a Talk, the first "listening" plays a short sound,
-- so the first word isn't lost. A UI sound only: nothing in the game happens.
function P.VoiceHeard()
	local a = R.voiceAsked
	if not a or a.cmd ~= "talk" or a.done then return end
	if GetTime() - a.at > 20 then a.done = true return end
	if P.VoiceState() == "listening" and (a.from ~= "listening" or a.sawOther) then
		a.done = true
		if type(PlaySound) == "function" and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
		if ns.Refresh then ns.Refresh() end
	elseif P.VoiceState() ~= "listening" then
		a.sawOther = true
	end
end

function P.VoiceToggleMute()
	return P.VoiceCommand(P.VoiceState() == "muted" and "unmute" or "mute")
end

function P.VoiceTogglePause()
	local st = P.VoiceState()
	return P.VoiceCommand((st == "paused" or st == "off") and "resume" or "pause")
end

-- Who speaks (S4): a fixed list, the same as the voice server's PERSONAS (tools/voice/server.mjs) and
-- the bridge's VOICE_PERSONAS; the choice is saved and sent as a vc record (cmd persona).
P.VOICE_PERSONAS = { "skeleton", "orc-shaman", "troll", "forsaken", "tauren" }
local PERSONA_WORDS = { skeleton = "Bones the skeleton", ["orc-shaman"] = "an old orc shaman", troll = "a troll witch doctor",
	forsaken = "a Forsaken apothecary", tauren = "a tauren druid" }

function P.VoicePersona()
	local b = ns.R and ns.R.bridge
	local v = type(b) == "table" and type(b.voice) == "table" and b.voice.persona
	return PERSONA_WORDS[v] and v or nil
end

function P.VoicePickPersona(name)
	if not PERSONA_WORDS[name] then return nil end
	if not ns.HasCap("voice") then return "Voice controls need the NeverQuestAlone app with voice support running." end
	local key = ns.Transport.NewKeyed("vc", "", { { "cmd", "persona" }, { "name", name }, { "at", time() } }, "")
	if not key then return "The app isn't connected yet." end
	ns.db.settings.voicePersona = name
	ns.Transport.AfterSend("", "vc", key)
	return "Voice: switching to " .. PERSONA_WORDS[name] .. " (it reconnects in a few seconds)."
end

-- The voice companion reads new replies aloud (S6, T16): saved here, told to the app (vc read),
-- which hands each reply's summary to the voice; the game's own TTS stays quiet while it's on.
function P.VoiceRead(on)
	if not ns.HasCap("voice") then return "Voice controls need the NeverQuestAlone app with voice support running." end
	local key = ns.Transport.NewKeyed("vc", "", { { "cmd", "read" }, { "on", on and 1 or 0 }, { "at", time() } }, "")
	if not key then return "The app isn't connected yet." end
	ns.db.settings.voiceRead = on == true
	ns.Transport.AfterSend("", "vc", key)
	return "Voice reads replies aloud: " .. (on and "on (the game's own voice stays quiet)." or "off.")
end

-- /nqa voice [talk|mute|unmute|pause|resume|persona <name>|read on|off|bar on|off]
function P.VoiceSlash(rest)
	if rest == "" or rest == "status" then
		local who = P.VoicePersona()
		return "Voice: " .. VOICE_WORDS[P.VoiceState()] .. (who and (", " .. PERSONA_WORDS[who]) or "") .. "."
	end
	local readOn = rest:match("^read%s*(%S*)$")
	if readOn then
		if readOn == "" then return "Voice reads replies aloud: " .. (ns.db.settings.voiceRead == true and "on." or "off.") end
		if readOn ~= "on" and readOn ~= "off" then return "Use /nqa voice read on or off." end
		return P.VoiceRead(readOn == "on")
	end
	local barOn = rest:match("^bar%s*(%S*)$")
	if barOn then
		if barOn ~= "on" and barOn ~= "off" then return "Use /nqa voice bar on or off." end
		return ns.VoiceBar and ns.VoiceBar.Command(barOn == "on") or "The voice bar isn't loaded."
	end
	local name = rest:match("^persona%s*(%S*)$")
	if name then
		if name == "" then return "Voices: " .. table.concat(P.VOICE_PERSONAS, ", ") .. ". Pick one: /nqa voice persona orc-shaman" end
		return P.VoicePickPersona(name) or ("No voice called " .. name .. ". Voices: " .. table.concat(P.VOICE_PERSONAS, ", ") .. ".")
	end
	return P.VoiceCommand(rest) or "Use /nqa voice talk, tip, mute, unmute, pause, resume, persona, read or bar."
end

-- The keys (Bindings.xml): talk, and the two toggles.
NeverQuestAlone.Voice = function(what)
	local msg
	if what == "talk" or what == "tip" then msg = P.Call("VoiceCommand", what)
	elseif what == "toggle_mute" then msg = P.Call("VoiceToggleMute")
	elseif what == "toggle_pause" then msg = P.Call("VoiceTogglePause") end
	if msg and ns.Chats and ns.Chats.Notice and ns.Chats.Active then
		local chat = ns.Chats.Active()
		if chat then ns.Chats.Notice(chat, msg) end
	end
end

-- For a typed message: the seq its st= names, with that state queued (F1),
-- whether the bridge takes the message's game context from that state (cap ctx),
-- so the message may leave its own out (a too_large state carries none of it),
-- and whether that state carries the professions: one that left them out to fit
-- doesn't, so the context's Professions line goes when it changed.
function P.ForSend()
	local seq = P.QueueState(STATE_DWELL, true)
	local c = DB()
	local carries = seq ~= nil and P.Caps().ctx == true and not c.stateTooLarge
	local prof = carries and not P.ListOnly() -- [QL-F-15] nor does the quest log alone (the app's companion switch off)
	for _, k in ipairs(c.stateOmitted or {}) do
		if k == "prof" then prof = false end
	end
	return seq, carries, prof
end

-- This character's session id, for the hello (F6).
function P.Sid()
	return CharDB().sid
end

-- A slot or the reload inbox brought the bridge header (Transport.HandleSlotData).
function P.OnBridge(bridge, helloAnswered)
	local seq = tonumber(bridge and bridge.stateSeq)
	R.bridgeStateSeq = seq and math.floor(seq) or nil
	R.bridgeStateSid = bridge and type(bridge.stateSid) == "string" and bridge.stateSid or nil
	local c = DB()
	local carried = R.bridgeStateSeq and c.carried[R.bridgeStateSeq]
	if carried and BridgeHas(R.bridgeStateSeq, carried.sid) then
		-- The bridge has a state that carried these milestones: they're delivered (F4).
		local done = {}
		for _, id in ipairs(carried.ids or {}) do done[id] = true end
		local ch = CharDB()
		local keep = {}
		for _, p in ipairs(ch.pending) do
			if not done[p.pid] then keep[#keep + 1] = p end
		end
		if #keep ~= #ch.pending then ch.pending = keep end
		for s in pairs(c.carried) do
			if s <= R.bridgeStateSeq then c.carried[s] = nil end
		end
	end
	if R.stateRec and BridgeHas(R.stateRec.seq, R.stateRec.sid) then
		R.stateRec = nil
		ns.Transport.RefreshStrip()
	end
	-- [C-OFF] Check-ins off: the bridge said it holds no state (the off record was heard).
	if R.stateRec and R.stateRec.off and R.bridgeStateSeq == nil then
		R.stateRec = nil
		ns.Transport.RefreshStrip()
	end
	-- Once after each hello: the bridge gets the state without waiting for a turn (F1).
	if helloAnswered and not R.stateAfterHello and P.Active("state") then
		R.stateAfterHello = true
		P.QueueState(STATE_DWELL)
	end
	-- [C-OFF] Once after each hello with check-ins off here, a bridge still holding a state
	-- is told to forget it (turned off while the bridge was away, or its off record was missed).
	if helloAnswered and not R.offAfterHello and c.on == false and R.bridgeStateSeq ~= nil then
		R.offAfterHello = true
		P.QueueOff()
	end
end

-- [C-OFF] Check-ins went off: a state record with off=1 and no body tells the bridge to
-- forget the state it holds for this addon, which it would otherwise give once more to each chat
-- that hadn't had it (PROTOCOL §2.6). Drawn like a state, after every keyed record, until a slot
-- says the bridge holds none; stream and reload modes put it in the reload outbox. Nothing when
-- the bridge holds none, or doesn't take states.
function P.QueueOff()
	if not R.nonce or R.bridgeStateSeq == nil or P.Caps().state ~= true then return end
	local T, db = ns.Transport, ns.db
	local wire = T.Record(R.nonce, "state", "", { { "cur", db.cursor }, { "off", 1 } }, "")
	if T.StripOut() then
		R.stateRec = { wire = wire, off = true, order = -1, untilT = GetTime() + STATE_DWELL }
	else
		T.PutUnkeyed(wire, "state")
	end
	T.RefreshStrip()
end

-- A record was acked: a state that didn't fit beside it gets its turn alone.
function P.OnAcked()
	local s = R.stateRec
	if s and not BridgeHas(s.seq, s.sid) then
		s.untilT = math.max(s.untilT or 0, GetTime() + STATE_DWELL)
	end
end

---------------------------------------------------------------------------
-- Milestones (F4)
---------------------------------------------------------------------------

local function AddPending(entry)
	local ch = CharDB()
	local c = DB()
	c.pendingId = math.floor(tonumber(c.pendingId) or 0) + 1
	entry.pid = c.pendingId
	entry.t = time()
	table.insert(ch.pending, entry)
	while #ch.pending > LIMITS.pending do table.remove(ch.pending, 1) end
end
P.AddPending = AddPending

-- A profession's max rank went up (a new tier trained). The first reading of a
-- profession only sets its baseline.
local function CheckProfessions()
	local ch = CharDB()
	for _, p in ipairs(ns.Chats.Professions()) do
		local name, max = Clean(p.name), Whole(p.max)
		if name ~= "" and max then
			local before = tonumber(ch.profMax[name])
			if before and max > before then AddPending({ kind = "prof", name = name, max = max }) end
			ch.profMax[name] = max
		end
	end
end

---------------------------------------------------------------------------
-- The session (F6)
---------------------------------------------------------------------------

local function Snapshot()
	return { t = time(), level = Whole(Try(UnitLevel, "player")) or 0, xp = Whole(Try(UnitXP, "player")) or 0,
		xpMax = Whole(Try(UnitXPMax, "player")) or 0, money = Whole(Try(GetMoney)) or 0 }
end

local function Session()
	local ch = CharDB()
	if not ch.sid then ch.sid = NewSid() end
	local s = ch.session
	if type(s) ~= "table" or s.sid ~= ch.sid or type(s.start) ~= "table" then
		local now = Snapshot()
		s = { sid = ch.sid, start = now, xpGained = 0, questsTurnedIn = 0, zones = {}, lastXp = now.xp, lastXpMax = now.xpMax, lastLevel = now.level, lastMoney = now.money }
		ch.session = s
	end
	if type(s.zones) ~= "table" then s.zones = {} end
	return s
end
P.Session = Session

-- In PLAYER_LOGOUT on 70009, UnitXP, UnitXPMax and GetMoney read 0 (UnitLevel still
-- reads right). A read with max XP 0 while the session's last reading had an XP bar,
-- at no higher level, is that: it's never counted or kept, and the recap's end takes
-- the values last seen in play. (A level-up to a level with no XP bar still counts.)
local function LogoutRead(s, now)
	return now.xpMax <= 0 and (tonumber(s.lastXpMax) or 0) > 0 and now.level <= (tonumber(s.lastLevel) or 0)
end

-- XP from PLAYER_XP_UPDATE deltas; across a level-up, what was left of the old level counts too.
local function OnXp()
	local s = Session()
	local now = Snapshot()
	if LogoutRead(s, now) then return end
	local lastXp, lastMax, lastLevel = s.lastXp or now.xp, s.lastXpMax or now.xpMax, s.lastLevel or now.level
	local gained
	if now.level > lastLevel or now.xp < lastXp then
		-- A level-up, seen by the level or first by the XP starting over (the events can
		-- come in either order): the rest of the old level, then the new XP. The level
		-- counts as gone up, so seeing it change later adds nothing twice.
		gained = math.max(0, lastMax - lastXp) + now.xp
		s.lastLevel = math.max(now.level, lastLevel + 1)
	else
		gained = now.xp - lastXp
		s.lastLevel = now.level
	end
	s.xpGained = (s.xpGained or 0) + gained
	s.lastXp, s.lastXpMax = now.xp, now.xpMax
end

-- The money last seen in play (PLAYER_MONEY, and each PLAYER_ENTERING_WORLD).
local function OnMoney()
	local s = Session()
	local now = Snapshot()
	if not LogoutRead(s, now) then s.lastMoney = now.money end
end

-- The session's end: read now, except what the logout zeroes. XP and max XP then come
-- from the last reading counted in play, and a money read of 0 from the last money
-- seen in play (a real 0 was seen there too).
local function EndSnapshot(s)
	local now = Snapshot()
	if LogoutRead(s, now) then now.xp, now.xpMax = tonumber(s.lastXp) or now.xp, tonumber(s.lastXpMax) or now.xpMax end
	if now.level <= 0 then now.level = math.max(tonumber(s.lastLevel) or 0, R.levelUpTo or 0) end
	if now.money <= 0 and tonumber(s.lastMoney) then now.money = tonumber(s.lastMoney) end
	return now
end

local function NoteZone(zone)
	local s = Session()
	for _, z in ipairs(s.zones) do
		if z == zone then return end
	end
	if #s.zones < LIMITS.zones then table.insert(s.zones, zone) end
end

-- NQADB.companion.lastSession, at PLAYER_LOGOUT (also at /reload: the
-- bridge tells them apart by the sid of the next state or hello).
function P.SessionJSON()
	local s = Session()
	local now = EndSnapshot(s)
	local function Snap(x) return O("t", x.t, "level", x.level, "xp", x.xp, "xpMax", x.xpMax, "money", x.money) end
	local _, classFile = Try(UnitClass, "player")
	local race = Try(UnitRace, "player")
	local zones = {}
	for _, z in ipairs(s.zones) do zones[#zones + 1] = z end
	return J.encode(O("v", 1, "kind", "session", "sid", s.sid,
		"char", O("name", Clean(ns.Readable(Try(UnitName, "player"))), "realm", Clean((Try(GetRealmName))),
			"class", classFile and Clean(classFile) or nil, "race", race and Clean(race) or nil),
		"start", Snap(s.start), "end", Snap(now), "xpGained", s.xpGained or 0, "moneyDelta", now.money - (s.start.money or 0),
		"questsTurnedIn", s.questsTurnedIn or 0, "zones", zones, "ended", "unknown"))
end

---------------------------------------------------------------------------
-- The Companion chat
---------------------------------------------------------------------------

-- Found, or made (pinned to the top) the first time it's needed. It's reserved
-- on top of the chat limit, so a full list never loses an event or a recap.
-- [UX-W04, CF-UX-03] Its name: "Check-ins" (STYLE §2.1). A saved chat
-- takes it only while it's still called "Companion", its older name (a name
-- the player gave it stays).
local CHAT_NAME = "Check-ins"
function P.NameChat()
	local chat = ns.Chats.Find(P.CHAT_ID)
	if chat and chat.name == "Companion" then ns.Chats.Rename(chat.id, CHAT_NAME) end
end
function P.EnsureChat()
	local chat = ns.Chats.Find(P.CHAT_ID)
	if chat then
		P.NameChat() -- [UX-W04]
		return chat
	end
	local db = ns.db
	chat = ns.NewChatRecord(CHAT_NAME) -- [UX-W04]
	chat.id = P.CHAT_ID
	db.pinCounter = (tonumber(db.pinCounter) or 0) + 1
	chat.pinned, chat.pinOrder = true, db.pinCounter
	table.insert(db.chats, chat)
	ns.SortChats(db.chats)
	ns.Refresh("all")
	return chat
end

---------------------------------------------------------------------------
-- Events (F3, A2)
---------------------------------------------------------------------------

function P.Summary(kind, a)
	if kind == "level_up" then return ns.Fill("Level-up: {from} → {to}", { from = tostring(a.from), to = tostring(a.to) }) end
	if kind == "route_done" then return "Route finished: " .. tostring(a.title or a.layer or "route") end
	if kind == "route_stale" then return string.format("%d quests picked up that no route covers", a.n or 0) end
	if kind == "zone_first" then return "First visit: " .. tostring(a.zone or "a new zone") end
	if kind == "bags_full" then return "Bags are almost full" end
	if kind == "gear_breaking" then return "Equipped gear needs repair" end
	return kind
end

-- The evt record: an empty body; the state it names carries the game data (F3).
function P.Send(kind, a, once)
	local chat = P.EnsureChat()
	if not chat then return nil end
	local db = ns.db
	local st = P.QueueState(STATE_DWELL)
	local args = { { "cur", db.cursor }, { "kind", kind }, { "agent", chat.agent }, { "name", chat.name } }
	for _, f in ipairs({ "from", "to", "n", "layer", "zone", "free", "slots", "pct" }) do
		if a[f] ~= nil then args[#args + 1] = { f, a[f] } end
	end
	local ch = CharDB()
	if ch.sid then args[#args + 1] = { "sid", ch.sid } end
	if st then args[#args + 1] = { "st", st } end
	-- Its send time (PRD SL-4), so the bridge's runaway fuse counts turns
	-- when they went, not when a backlog arrives.
	args[#args + 1] = { "at", time() }
	local key = ns.Transport.NewKeyed("evt", chat.id, args, "")
	if not key then return false end
	if kind == "route_stale" and a.ids then
		for id in tostring(a.ids):gmatch("%d+") do asked[tonumber(id)] = true end
	end
	chat.sent = true
	-- While automatic help is paused the bridge holds the event to ride
	-- along with your next message: no turn is coming, so nothing shows as work.
	if not P.AutoPaused() then table.insert(chat.pending, { key = key, t = time() }) end
	ns.Chats.AddHistory(chat, { role = "user", event = kind, text = P.Summary(kind, a), key = key })
	ns.Transport.AfterSend(chat.id, "msg", key) -- an evt counts as a send for slots (K4)
	local c = DB()
	for _, o in ipairs(type(once) == "table" and once or { once }) do Fire(o) end
	c.count, c.lastAt, c.last = c.count + 1, time(), P.Summary(kind, a)
	return key
end

-- An event to send when the moment allows (Flush), kept per character and saved,
-- so a fight or a /reload doesn't lose it. once: its "already sent" key; due:
-- time() before which it waits. A second level-up before the first went out
-- makes one turn, from the first level to the last.
function P.Queue(kind, a, once, due, noFlush)
	local c = DB()
	if not c.on or not P.KindOn(kind) then return false end
	if once and c.fired[once] then return false end
	local q = CharDB().queue
	local onces = { once }
	local old = q[kind]
	if kind == "level_up" and old and type(old.args) == "table" and old.args.from then
		a = { from = old.args.from, to = a.to }
		for _, o in ipairs(old.onces or {}) do table.insert(onces, 1, o) end
	end
	q[kind] = { args = a or {}, onces = onces, due = due, at = time() }
	if not noFlush then P.Flush() end
	return true
end

-- Send the first event whose moment has come: the bridge takes events (caps),
-- out of combat (a few seconds after it), 2 minutes after the last one (a
-- level-up doesn't wait). One per call; the 2-second ticker calls it again.
function P.Flush()
	if not ns.db or not R.nonce then return end
	P.CheckNudges()
	local c = DB()
	local q = CharDB().queue
	if not next(q) then return end
	if not P.Active("evt") then return end -- no caps yet (or an older bridge): they wait
	if ns.InCombat() or (R.combatEndedAt and GetTime() - R.combatEndedAt < AFTER_COMBAT) then return end
	local today = date("%Y-%m-%d")
	if c.day ~= today then c.day, c.count = today, 0 end
	if q.route_stale then P.CheckStale(true) end -- quests may have left the log since it was queued
	for _, kind in ipairs(KINDS) do
		local e = q[kind]
		if e and (not P.KindOn(kind) or time() - (tonumber(e.at) or 0) > QUEUE_STALE) then
			q[kind] = nil -- switched off, or too old to help now
		elseif e and (not e.due or time() >= e.due) and (kind == "level_up" or not c.lastAt or time() - c.lastAt >= GAP) then
			if P.Send(kind, e.args, e.onces) then q[kind] = nil end
			return
		end
	end
end

-- Read only after a bag/equipment change (or login), never on every idle tick.
-- Latches and pending events survive reload per character. Unknown readings do
-- not rearm a warning; a known recovery does, and cancels obsolete queued advice.
function P.CheckNudges()
	if not ns.db or ns.InCombat() or not R.nudgesDirty then return end
	R.nudgesDirty = nil
	local ch = CharDB()
	if type(ch.nudges) ~= "table" then ch.nudges = {} end
	local seen = ch.nudges
	if type(seen.gear) ~= "table" then seen.gear = {} end
	local free = Get(P.Bags(), "free")
	if free then
		if free > 2 then
			seen.bags, ch.queue.bags_full = nil, nil
		elseif not seen.bags then
			if P.Queue("bags_full", { free = free }, nil, nil, true) then seen.bags = true end
		elseif ch.queue.bags_full then
			ch.queue.bags_full.args.free = free
		end
	end
	local rows = P.Durability()
	if not rows then return end -- unavailable is not repaired
	local pending, slots, lowest, fresh = {}, {}, nil, false
	local old = ch.queue.gear_breaking
	if old then
		for slot in tostring(old.args.slots or ""):gmatch("%d+") do pending[tonumber(slot)] = true end
	end
	local low = {}
	for _, row in ipairs(rows) do
		local slot, pct = Get(row, "slot"), Get(row, "pct")
		if pct > 20 then seen.gear[slot] = nil
		elseif not seen.gear[slot] or pending[slot] then
			low[slot] = pct
			if not seen.gear[slot] then fresh = true end
		end
	end
	for slot = 1, 19 do
		if low[slot] then
			slots[#slots + 1] = slot
			lowest = math.min(lowest or 100, low[slot])
		end
	end
	local args = { slots = table.concat(slots, ","), pct = lowest }
	if fresh and P.Queue("gear_breaking", args, nil, nil, true) then
		for _, slot in ipairs(slots) do seen.gear[slot] = true end
	elseif old then
		if #slots == 0 then ch.queue.gear_breaking = nil else old.args = args end
	end
end

-- Quests picked up that no map stop names (still in the log): 3 or more, 90 s
-- after the last pickup, asks for a re-plan. A new or redrawn route that
-- covers them clears them. Quests already asked about don't count again, so
-- "nothing needs changing" isn't asked for once more at the next pickup.
function P.CheckStale(noFlush)
	local covered = (S and S.CoveredQuests and S.CoveredQuests()) or {}
	local ids, last = {}, 0
	for id, at in pairs(uncovered) do
		if covered[id] or asked[id] or not Try(C_QuestLog and C_QuestLog.IsOnQuest, id) then
			uncovered[id] = nil
		else
			ids[#ids + 1] = id
			if at > last then last = at end
		end
	end
	if #ids < STALE_QUESTS then
		CharDB().queue.route_stale = nil
		return
	end
	table.sort(ids)
	local list = table.concat(ids, ",")
	P.Queue("route_stale", { n = #ids, ids = list }, "route_stale:" .. CharKey() .. ":" .. list, last + STALE_WAIT, noFlush)
end

-- A zone change: a first visit is a milestone (F4) and, outside instances, an
-- event (A2). The first zone a character is seen in is only its baseline.
local function OnZone()
	-- Crossing zones on a flight path isn't visiting them: the landing zone counts (P.Tick).
	if Try(UnitOnTaxi, "player") then
		R.onTaxi = true
		return
	end
	local zone = Clean((Try(GetRealZoneText)) or (Try(GetZoneText)))
	if zone == "" then return end
	local ch, who = CharDB()
	NoteZone(zone)
	if not ch.zonesInit then
		ch.zonesInit = true
		ch.zones[zone] = true
		return
	end
	if ch.zones[zone] then return end
	ch.zones[zone] = true
	AddPending({ kind = "zone", zone = zone })
	if Try(IsInInstance) then return end -- dungeons have their own help
	P.Queue("zone_first", { zone = zone }, "zone_first:" .. who .. ":" .. zone)
end
P.OnZone = OnZone

local function OnTurnIn(id)
	id = tonumber(id)
	if not id then return end
	local s = Session()
	s.questsTurnedIn = (s.questsTurnedIn or 0) + 1
	local title = titles[id] or Clean((Try(C_QuestLog and C_QuestLog.GetTitleForQuestID, id)))
	AddPending({ kind = "quest_done", id = id, title = title ~= "" and title or nil })
end

---------------------------------------------------------------------------
-- Game events
---------------------------------------------------------------------------

-- Like ns.On, but an error stays here (kept for /bones state) instead of
-- reaching the game's error handler.
local function On(event, fn)
	ns.On(event, function(...)
		local ok, err = pcall(fn, ...)
		if not ok then R.companionError = { text = tostring(err), at = GetTime(), where = event } end
	end)
end

On("PLAYER_ENTERING_WORLD", function(_, isInitialLogin)
	if not ns.db then return end
	local ch = CharDB()
	-- A new session at every initial login; a /reload or a zone-in keeps it (F1, F6).
	if isInitialLogin == true or not ch.sid then
		ch.sid = NewSid()
		ch.session = nil
	end
	Session()
	OnMoney() -- after a /reload too, so a session saved without lastMoney gets it
	OnZone()
end)
On("PLAYER_LEVEL_UP", function(_, level)
	level = tonumber(level)
	if not level then return end
	R.levelUpTo = level
	-- Waits a moment, so the state it names has the new level and XP.
	local queued = P.Queue("level_up", { from = level - 1, to = level }, "level_up:" .. CharKey() .. ":" .. level, time() + LEVEL_SETTLE)
	-- The HUD's "Bones is on it" only when it will really go: queued, the bridge
	-- takes events, and automatic help isn't paused (no daily limit).
	local room = not P.AutoPaused()
	R.dingQueued = (queued and P.Active("evt") and room) and level or nil
end)
On("PLAYER_XP_UPDATE", function() OnXp() end)
On("QUEST_ACCEPTED", function(_, id)
	id = tonumber(id)
	if not id then return end
	local covered = (S and S.CoveredQuests and S.CoveredQuests()) or {}
	if covered[id] then return end
	uncovered[id] = time()
	P.CheckStale()
end)
On("QUEST_REMOVED", function(_, id)
	if tonumber(id) then uncovered[tonumber(id)] = nil end
	P.CheckStale(true)
end)
On("QUEST_TURNED_IN", function(_, id) OnTurnIn(id) end)
On("PLAYER_MONEY", function()
	if ns.db then OnMoney() end
end)
On("SKILL_LINES_CHANGED", function() CheckProfessions() end)
On("ZONE_CHANGED_NEW_AREA", function() OnZone() end)
On("PLAYER_REGEN_ENABLED", function()
	R.combatEndedAt = GetTime()
	if C_Timer and C_Timer.After then C_Timer.After(AFTER_COMBAT + 0.1, P.Flush) end
end)
for _, event in ipairs({ "QUEST_LOG_UPDATE", "ZONE_CHANGED_NEW_AREA", "BAG_UPDATE_DELAYED", "PLAYER_LEVEL_UP", "PLAYER_TARGET_CHANGED", "GROUP_ROSTER_UPDATE" }) do
	On(event, P.LiveChanged)
end
On("UNIT_AURA", function(_, unit) if unit == "player" then P.LiveChanged() end end)
On("PLAYER_REGEN_ENABLED", function() P.LiveFlush() end)
for _, event in ipairs({ "PLAYER_ENTERING_WORLD", "BAG_UPDATE_DELAYED", "UPDATE_INVENTORY_DURABILITY", "PLAYER_EQUIPMENT_CHANGED" }) do
	On(event, function() R.nudgesDirty = true end)
end

On("PLAYER_LOGOUT", function()
	if not ns.db then return end
	local c = DB()
	if c.on and c.kinds.recap then
		c.lastSession = P.SessionJSON()
	else
		c.lastSession = nil
	end
end)

-- The 2-second ticker: due events.
-- [code health AD-06] No unconditional background rebuild. Only opt-in Live
-- changes read state between turns, through the same P.QueueState path.
-- Every XP, money, quest log or gear change rebuilt it 2 s later (0.6 ms, 200 KB).
function P.Tick()
	if R.onTaxi and not Try(UnitOnTaxi, "player") then
		R.onTaxi = false
		P.Call("OnZone") -- landed: this zone counts
	end
	P.Call("CheckNudges")
	P.Call("Flush")
	P.Call("LiveFlush")
end

On("PLAYER_LOGIN", function()
	S = ns.MapShared
	if S then
		S.OnRouteDone = function(l)
			local m = S.DB().map
			P.Queue("route_done", { layer = l.name, title = l.title }, "route_done:" .. CharKey() .. ":" .. tostring(l.name) .. ":" .. tostring(m and m.version or 0))
		end
		S.OnRoutesChanged = P.CheckStale
	end
	DB()
	R.nudgesDirty = true
	CheckProfessions()
	if C_Timer and C_Timer.NewTicker then C_Timer.NewTicker(2, P.Tick) end
end)

---------------------------------------------------------------------------
-- /bones companion, /bones state, /bones apicheck
---------------------------------------------------------------------------

-- [C-25] The Settings switch: this addon's side, and a word on the app's
-- side when that's still off.
function P.Switch(on)
	P.Command(on and "on" or "off")
	if on and not P.DesktopOn() then
		ns.Notify.Local("Check-ins are also off in the NeverQuestAlone app: turn them on there too.") -- [UX-W04]
	end
end

function P.Command(rest)
	local c = DB()
	local word, v = (rest or ""):lower():match("^(%S*)%s*(%S*)$")
	if word == "on" or word == "off" then
		c.on = word == "on"
		R.nudgesDirty = true
		if not c.on then
			-- Nothing more goes: the state leaves the strip and the reload outbox, events are dropped.
			R.stateRec = nil
			local q = CharDB().queue
			for k in pairs(q) do q[k] = nil end
			local db = ns.db
			for i = #db.outbox, 1, -1 do
				local e = db.outbox[i]
				local rec = e.key == R.nonce and ns.Transport.ParseRecord(ns.FromHex(e.hex))
				if rec and rec.type == "state" then table.remove(db.outbox, i) end
			end
			P.QueueOff() -- [C-OFF] and the bridge forgets the one it holds
			ns.Transport.RefreshStrip()
		elseif R.stateRec and R.stateRec.off then -- [C-OFF] on again: the off record goes
			R.stateRec = nil
			ns.Transport.RefreshStrip()
		end
	elseif WORDS[word] and (v == "on" or v == "off") then
		local kind = WORDS[word]
		if kind == "bags_full" or kind == "gear_breaking" then CharDB().nudgeKinds[kind] = v == "on"
		else c.kinds[kind] = v == "on" end
		R.nudgesDirty = true
		if v == "off" then CharDB().queue[WORDS[word]] = nil end
	end
	local caps = P.Caps()
	local sent = c.day == date("%Y-%m-%d") and c.count or 0
	local lines
	if not P.DesktopOn() then -- [C-05] the app's switch (bridge.usage.autoOn), said first [UX-W04] check-ins
		lines = { c.on and "Check-ins are off in the NeverQuestAlone app: turn them on there, and they come to your Check-ins chat."
			or "Check-ins are off in the NeverQuestAlone app: turn them on there, and they come to your Check-ins chat. They're off here too: /nqa companion on." }
	else -- [C-05] no bridge, and no allowance of ours [UX-W04] check-ins; the Settings label first (C-116)
		local t = { label = ns.Settings.LABELS.checkins, n = ns.Int(sent) }
		lines = { c.on and ns.P(ns.Fill("{label}: On. NeverQuestAlone checks in on level-ups, finished routes, quests no route covers and first visits to a zone ({n} today). Settings has it too.", t))
			or ns.Fill("{label}: Off. Settings has it too.", t) }
		-- The runaway fuse, said while it holds, with how it ends.
		if P.AutoPaused() then lines[#lines + 1] = "Check-ins paused after a burst of them: your next message turns them back on." end
	end
	if not (caps.state and caps.evt) then -- [UX-W04] the app by its name, whole sentences
		lines[#lines + 1] = R.bridge and "The NeverQuestAlone app doesn't support check-ins yet: update it. Nothing is sent until you do."
			or "Waiting for the first answer from the NeverQuestAlone app."
	end
	for _, w in ipairs({ "level", "route", "stale", "zone", "bags", "repair", "recap" }) do
		local kind = WORDS[w]
		lines[#lines + 1] = string.format("  %s: %s  (/nqa companion %s on||off)", LABEL[kind], P.KindOn(kind) and "on" or "off", w)
	end
	if c.last then lines[#lines + 1] = c.lastAt and ns.Fill("Last check-in: {summary}, {duration} ago.", { summary = ns.Escape(c.last), duration = ns.DurWords(time() - c.lastAt) })
		or ns.Fill("Last check-in: {summary}.", { summary = ns.Escape(c.last) }) end
	return lines
end
P.WORDS = WORDS

-- /bones state: v, seq, size and what was left out (C1.2), and the quest log:
-- how many quests went, against which cap, and where that cap came from.
function P.StateReport()
	if not ns.db then return { "Not ready yet." } end
	local st = P.Build()
	local ch = CharDB()
	local caps = P.Caps()
	local omitted = #st.omitted > 0 and table.concat(st.omitted, ", ") or "none"
	local jsonMax = caps.qlog and STATE_BUDGET.JSON or STATE_BUDGET.LEGACY_JSON
	-- How it travels on the strip (cap z): deflated, or as JSON and why.
	local packed = caps.z and (st.packed or ns.Transport.Deflate(st.json))
	local travels = packed and string.format("It travels deflated: %s of %s bytes on the strip, for %s bytes of JSON.",
			ns.Thousands(#packed), ns.Thousands(STATE_BUDGET.BODY), ns.Thousands(st.bytes))
		or (caps.z and "It travels as JSON: this client can't deflate it, or deflating saves nothing.")
		or ("It travels as JSON: " .. ns.Product() .. " doesn't take it deflated.") -- [C-05] the app by its name
	local q = st.quests or {}
	local from = ({ api = "C_QuestLog.GetMaxNumQuestsCanAccept", const = "the game's own quest log constant", fallback = "the fallback, the game gave none" })[q.source] or "?"
	local unread = tonumber(q.unread) or 0
	local log = unread > 0 and string.format("Quest log: %d quests in the state, not every one (cap %s, from %s). %s", q.count or 0, ns.Int(q.max), from,
			ns.Plural(unread, "The game listed 1 more without a quest id yet.", "The game listed {n} more without a quest id yet."))
		or string.format("Quest log: %d of %s quests, every one in the state (cap from %s).", q.count or 0, ns.Int(q.max), from)
	return {
		string.format("State v=1, seq=%s, sid %s, %s of %s bytes of JSON%s; omitted: %s", ns.Int(st.seq), st.sid, ns.Thousands(st.bytes), ns.Thousands(jsonMax),
			st.tooLarge and " (too large: sent as too_large)" or "", omitted),
		log,
		travels,
		ns.Product() .. string.format(" has seq %s%s", R.bridgeStateSeq and ns.Int(R.bridgeStateSeq) or "none", -- [C-05]
			BridgeHas(st.seq, st.sid) and " (this one)" or (caps.state and ": this one goes with your next message" or "")),
		"Milestones waiting for " .. ns.Product() .. string.format(": %d. Companion %s; ", #ch.pending, DB().on and "on" or "off") -- [C-05]
			.. ns.Product() .. " caps: "
			.. ((caps.state or caps.evt) and ((caps.state and "state " or "") .. (caps.evt and "evt" or "") .. (caps.z and " z" or "") .. (caps.ctx and " ctx" or "")
				.. (caps.qlog and " qlog" or "")) or "none"),
		R.companionError and string.format("Last error (in %s, %s ago): %s", R.companionError.where, ns.FmtDur(GetTime() - R.companionError.at),
			ns.Escape(ns.Utf8Cut(R.companionError.text, 200))) or nil,
	}
end

-- /bones apicheck: each API the state and events use, present or missing, and
-- a sample value (C0 and C1.3, when /dump isn't an option).
function P.ApiCheck()
	local out = {}
	local function Short(v)
		if ns.IsSecret(v) then return "secret" end -- the game kept it back: it can't be read or shown
		local t = type(v)
		if t == "table" then
			local n = 0
			for _ in pairs(v) do n = n + 1 end
			return "table (" .. n .. ")"
		end
		if t == "string" then return '"' .. ns.Escape(ns.Utf8Cut(v, 30)) .. '"' end
		if t == "nil" then return "nil" end
		return tostring(v)
	end
	local function Check(label, fn, ...)
		if type(fn) ~= "function" then
			out[#out + 1] = label .. ": missing"
			return
		end
		local ok, a = pcall(fn, ...)
		out[#out + 1] = label .. ": " .. (ok and ("present, " .. Short(a)) or ("present, error: " .. ns.Escape(ns.Utf8Cut(tostring(a), 60))))
	end
	local QL, CI, CM = C_QuestLog or {}, C_Item or {}, C_Map or {}
	local mapId = Try(CM.GetBestMapForUnit, "player")
	local firstQuest
	local n = Try(QL.GetNumQuestLogEntries)
	for i = 1, (type(n) == "number" and n or 0) do
		local info = Try(QL.GetInfo, i)
		if type(info) == "table" and not info.isHeader and info.questID then firstQuest = info.questID break end
	end
	Check("UnitName", UnitName, "player")
	Check("UnitClass", UnitClass, "player")
	Check("UnitRace", UnitRace, "player")
	Check("UnitXP / UnitXPMax", function() return tostring(UnitXP("player")) .. "/" .. tostring(UnitXPMax("player")) end)
	Check("GetMoney", GetMoney)
	Check("C_Map.GetBestMapForUnit", CM.GetBestMapForUnit, "player")
	Check("C_Map.GetPlayerMapPosition", CM.GetPlayerMapPosition, mapId, "player")
	Check("GetRealZoneText", GetRealZoneText)
	Check("GetSubZoneText", GetSubZoneText)
	Check("C_QuestLog.GetNumQuestLogEntries (entries, quests)", QL.GetNumQuestLogEntries and function()
		local entries, quests = QL.GetNumQuestLogEntries()
		return tostring(entries) .. ", " .. tostring(quests)
	end)
	-- The log's cap (ns.QuestLogMax): the API, else Forever's own constant. MAX_QUESTS is a stale 25 there, never used.
	Check("C_QuestLog.GetMaxNumQuestsCanAccept", QL.GetMaxNumQuestsCanAccept)
	Check("Constants.QuestLogConsts.MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT", function()
		return type(Constants) == "table" and type(Constants.QuestLogConsts) == "table" and Constants.QuestLogConsts.MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT or nil
	end)
	Check("MAX_QUESTS (stale on Forever: not used)", function() return MAX_QUESTS end)
	Check("The quest log's cap as read", function()
		local max, source = ns.QuestLogMax()
		return max .. " (" .. source .. ")"
	end)
	-- The read itself (ns.QuestLog), row by row: the quests, the hidden ones and
	-- those with no id yet, and the quests read under collapsed headers (the game
	-- lists them; none is opened). The game's own count shows here only: whether
	-- it takes in hidden quests isn't known, so it never changes what Bones is told.
	local _, qm = ns.QuestLog()
	out[#out + 1] = string.format("The quest log as read: %d quests, %d hidden, %d with no id yet; the game counts %s; %s", qm.count, qm.hidden, qm.unread,
		qm.total and ns.Int(qm.total) or "none",
		qm.collapsed == 0 and "no collapsed header"
			or string.format("%d of them under %d collapsed %s", qm.folded, qm.collapsed, qm.collapsed == 1 and "header" or "headers"))
	Check("C_QuestLog.GetInfo(1)", QL.GetInfo, 1)
	Check("C_QuestLog.GetQuestObjectives", QL.GetQuestObjectives, firstQuest)
	Check("C_QuestLog.IsQuestTrivial", QL.IsQuestTrivial, firstQuest)
	Check("C_QuestLog.IsComplete", QL.IsComplete, firstQuest)
	Check("C_QuestLog.GetQuestsOnMap", QL.GetQuestsOnMap, mapId)
	Check("C_QuestLog.GetTitleForQuestID", QL.GetTitleForQuestID, firstQuest)
	Check("C_SkillInfo.GetNumSkillLines", C_SkillInfo and C_SkillInfo.GetNumSkillLines)
	Check("GetInventoryItemID (main hand)", GetInventoryItemID, "player", 16)
	Check("GetInventoryItemLink (main hand)", GetInventoryItemLink, "player", 16)
	Check("C_Item.GetItemInfoInstant", CI.GetItemInfoInstant, Try(GetInventoryItemID, "player", 16))
	Check("C_Item.GetCurrentItemLevel", CI.GetCurrentItemLevel and function()
		return CI.GetCurrentItemLevel(ItemLocation:CreateFromEquipmentSlot(16))
	end)
	Check("C_Item.GetDetailedItemLevelInfo", CI.GetDetailedItemLevelInfo, Try(GetInventoryItemLink, "player", 16))
	Check("IsInInstance", IsInInstance)
	Check("C_EncodingUtil.SerializeJSON (not used: NeverQuestAlone writes its own, in a fixed key order)",
		C_EncodingUtil and C_EncodingUtil.SerializeJSON, { level = 12, q = { 761, 766 } })
	-- The state deflated for the strip (cap z): its size, once the client's own inflate gave the JSON back.
	Check("C_EncodingUtil.CompressString (the state, deflated for the strip)", C_EncodingUtil and C_EncodingUtil.CompressString and function()
		local json = P.Build().json
		local packed = ns.Transport.Deflate(json)
		return packed and string.format("%s of %s bytes", ns.Thousands(#packed), ns.Thousands(#json)) or "not usable: it goes as JSON"
	end)
	local events = { "PLAYER_LEVEL_UP", "PLAYER_XP_UPDATE", "PLAYER_MONEY", "PLAYER_EQUIPMENT_CHANGED", "SKILL_LINES_CHANGED",
		"QUEST_TURNED_IN", "QUEST_ACCEPTED", "QUEST_REMOVED", "PLAYER_ENTERING_WORLD", "PLAYER_LOGOUT", "ZONE_CHANGED_NEW_AREA" }
	if C_EventUtils and C_EventUtils.IsEventValid then
		local bad = {}
		for _, e in ipairs(events) do
			if not Try(C_EventUtils.IsEventValid, e) then bad[#bad + 1] = e end
		end
		out[#out + 1] = "Events: " .. (#bad == 0 and ("all " .. #events .. " valid") or ("not valid: " .. table.concat(bad, ", ")))
	else
		out[#out + 1] = "Events: C_EventUtils.IsEventValid missing, not checked"
	end
	return out
end
