-- The NeverQuestAlone addon: a chat window in World of Warcraft: Forever for
-- talking to Bones, the companion, through the NeverQuestAlone app on the same
-- machine (its service is the bridge here), or by Copy and Paste without it.
--
-- Store.lua: shared state, saved data (NQADB) and small helpers.
--
-- Every file of the addon shares one private table, `ns` (the second value of
-- `...`). NeverQuestAlone exports no function that sends words of a caller's own (PRD §5,
-- TB5): the public table, NeverQuestAlone, opens the window, puts a reply away (Okay)
-- and asks the key bindings' quick questions (QuickAsk: one of three fixed questions,
-- which is sent to Bones, so a paid message, as /bones <question> is; code health AD-16),
-- and the frames that send (the input, Send, Stop) have no global names. That narrows what other
-- addons, WeakAuras or pasted /run macros can do without removing it: the
-- slash commands, the saved outbox and the strip itself are reachable by any
-- of them, so the real guard is on the bridge's side.
--
-- Saved data, schema 1:
--   token        install token: 8 lowercase hex (docs/PROTOCOL.md §2.2)
--   sendCounter  n of the newest keyed record; only ever increases (§2.3)
--   cursor       seq of the last applied record (§4.3)
--   reported     the highest cursor the bridge is known to have (cur / seen)
--   outbox       { { key = "<nonce>_<n>", hex = "<the whole v2 record>" }, ... }:
--                keyed records not acked yet, drawn again verbatim after /reload
--                (§2.3) and read by the bridge from this file on the reload path (§5)
--   nonces       the last few login nonces, so a new one never repeats them
--   chats        { { id, name, agent, history, unread, pending, sent, created, lastAt } }
--   activeChat, lastPing, agentNames, settings
--   weights      { ["Name-Realm"] = { str = 1, sta = 0.8, ... } }: Bones's stat
--                weights for each character's build (tooltip verdicts, Tooltips.lua)
--   runTimes     the last 20 reply times in seconds (the HUD's "usually ~20 s")
--   spendOkay    "<day>:<needs>": the HUD's spend line you said Okay to (public build)
--   firstReply   true once a reply has come (the public build's setup checklist)
--   askDraft     { chat, text }: the HUD's Ask box's words at the last logout or reload, put back at login
--   qolAsked     the HUD's Quality of Life step was answered (QoL.lua)
--   qolTold      the one line about that step was said, once ever (QoL.lua)
--   partsFolded  the AddOns list's category of slots this addon folded, once,
--                by its name (Settings.lua, P.FoldParts)

local ADDON_NAME, ns = ...

ns.ADDON = ADDON_NAME or "NeverQuestAlone"
ns.VERSION = "1.4.19"
ns.PROTOCOL = 2
ns.SLOT_COUNT = 200
ns.SLOT_PREFIX = "NQA_S"
-- The slots' category in the game's AddOns list, as the bridge names it in
-- their TOCs (bridge/transport/slots.mjs SLOT_CATEGORY; addon_list_test holds
-- the two equal). Settings.lua folds it once (P.FoldParts).
ns.SLOT_CATEGORY = "NeverQuestAlone Parts"
ns.SIG = "Interface\\AddOns\\NeverQuestAlone\\sig\\"
ns.MAX_TEXT = 2900 -- bytes of one message (SE-1)
ns.MAX_PAYLOAD = 3200 -- bytes of one strip frame's payload (§2.1)
ns.CONTEXT_MAX = 900 -- bytes of game context per record (upstream)
ns.MAX_CHATS = 40 -- chats you make; the Companion chat is reserved on top of them
ns.COMPANION_CHAT = "c0ffee0" -- the companion's fixed chat (PROTOCOL §2.6)
ns.MAX_HISTORY = 200
ns.HISTORY_BYTES = 1500000 -- what all chats keep in saved data: words, and 150 bytes an entry (PF-06, AD-07; Chats.AddHistory)
ns.NAME_MAX = 24
ns.DEFAULT_AGENT = "main"
ns.RS, ns.US, ns.GS = "\30", "\31", "\29"
-- The stat weights Bones may send in a reply (PROTOCOL §4.1 `weights`), by
-- short name; Tooltips.lua maps them to the client's stat keys.
ns.WEIGHT_KEYS = {
	str = true, agi = true, sta = true, int = true, spi = true, armor = true, dps = true,
	ap = true, rap = true, crit = true, hit = true, sp = true, heal = true, mp5 = true,
	def = true, dodge = true, parry = true, block = true,
}

-- The public, send-free surface: Map.lua reads the skill lines, and the key
-- binding (Bindings.xml) opens the window. Filled in by Chats.lua and UI.lua.
NeverQuestAlone = { version = ns.VERSION }

-- One green for "done", "here" and "N new" on every surface: the game's own
-- (GREEN_FONT_COLOR), as a colour and as a text code.
do
	local g = type(GREEN_FONT_COLOR) == "table" and type(GREEN_FONT_COLOR.GetRGB) == "function" and { GREEN_FONT_COLOR:GetRGB() } or nil
	ns.GREEN = (g and type(g[1]) == "number") and g or { 0.1, 1, 0.1 }
	ns.GREEN_HEX = string.format("|cff%02x%02x%02x", math.floor(ns.GREEN[1] * 255 + 0.5), math.floor(ns.GREEN[2] * 255 + 0.5), math.floor(ns.GREEN[3] * 255 + 0.5))
end

-- The name of the keys' own section in Options > Keybindings: each key's
-- category in Bindings.xml is this global, and the page names the section
-- after its value (C-127). The addon's name as the AddOns list shows it (the
-- TOC's Title, C-124). Its ID stays NQA.
BINDING_HEADER_NQA = "NeverQuestAlone"
-- The keys' names, each whole in its row's label on that page (170 units at
-- 12 pt): "Ask About the Item Under the Mouse" was cut there (found drawing
-- C-127's section). The item key's miss line says "Hover over an item first".
-- ns.PersonaChanged sets them again in the companion's name. -- [UX-5]
local BINDING_WORDS = {
	NQA_OPEN_AND_TYPE = "Open or Close the Window",
	NQA_ASK_NEXT = "Ask What to Do Next",
	NQA_ASK_TARGET = "Ask About My Target",
	NQA_ASK_ITEM = "Ask About the Hovered Item",
	NQA_OKAY = "Okay the Newest Reply",
	NQA_VOICE_TALK = "Talk to the Voice",
	NQA_VOICE_TIP = "Voice: What Should I Do?",
	NQA_VOICE_MUTE = "Voice: Microphone On/Off",
	NQA_VOICE_PAUSE = "Voice: Pause/Resume",
}
for k, v in pairs(BINDING_WORDS) do _G["BINDING_NAME_" .. k] = v end

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

function ns.Trim(s)
	return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", ""))
end

-- A whole number as text, the same on Lua 5.1 (the game) and 5.3 (the test VM):
-- tostring(41.0) is "41.0" on 5.3.
function ns.Int(n)
	return string.format("%d", math.floor(tonumber(n) or 0))
end

-- "1,952": a whole number with thousands commas.
function ns.Thousands(n)
	local s = ns.Int(n)
	local neg = s:sub(1, 1) == "-"
	if neg then s = s:sub(2) end
	while true do
		local k
		s, k = s:gsub("^(%d+)(%d%d%d)", "%1,%2")
		if k == 0 then break end
	end
	return (neg and "-" or "") .. s
end

function ns.ToHex(s)
	return (tostring(s or ""):gsub(".", function(c)
		return string.format("%02x", c:byte())
	end))
end

-- nil for anything that isn't an even-length run of hex digits.
function ns.FromHex(h)
	if type(h) ~= "string" or #h % 2 ~= 0 or h:find("[^%x]") then return nil end
	return (h:gsub("%x%x", function(pair)
		return string.char(tonumber(pair, 16))
	end))
end

-- Args values are percent-encoded: %, ;, = and bytes below 0x20 or 0x7F (§2.2).
function ns.EncodeArg(v)
	return (tostring(v or ""):gsub(".", function(c)
		local b = c:byte()
		if b < 32 or b == 127 or c == "%" or c == ";" or c == "=" then
			return string.format("%%%02X", b)
		end
	end))
end

function ns.DecodeArg(v)
	return (tostring(v or ""):gsub("%%(%x%x)", function(h)
		return string.char(tonumber(h, 16))
	end))
end

-- User text and context never carry the record separators: GS, RS and US
-- become spaces (§2.2).
function ns.CleanField(s)
	return (tostring(s or ""):gsub("[\29\30\31]", " "))
end

-- Text we didn't get from the bridge (chat names, what the player typed, tool
-- titles) is shown with every | doubled, so it reads literally and can never
-- form a game escape.
function ns.Escape(s)
	return (tostring(s or ""):gsub("|", "||"))
end

-- Agent text arrives escaped by the bridge: every | doubled, and the only
-- escapes left are its own colour codes (|cAARRGGBB ... |r). It is shown as is.
-- Anything else that starts with a single | (a link, a texture, an atlas) is
-- doubled too, so text that didn't come through the bridge's renderer can't
-- form a live escape either. For conforming text this changes nothing.
function ns.SafeText(s)
	s = tostring(s or "")
	if not s:find("|", 1, true) then return s end
	local out, i, n = {}, 1, #s
	while i <= n do
		local j = s:find("|", i, true)
		if not j then
			out[#out + 1] = s:sub(i)
			break
		end
		out[#out + 1] = s:sub(i, j - 1)
		local nxt = s:sub(j + 1, j + 1)
		if nxt == "|" then
			out[#out + 1] = "||"
			i = j + 2
		elseif nxt == "r" then
			out[#out + 1] = "|r"
			i = j + 2
		elseif nxt == "c" and s:sub(j + 2, j + 9):match("^%x%x%x%x%x%x%x%x$") then
			out[#out + 1] = s:sub(j, j + 9)
			i = j + 10
		else
			out[#out + 1] = "||"
			i = j + 1
		end
	end
	return table.concat(out)
end

-- Agent text (as the bridge escaped it) back to plain words: its colour codes
-- go and every || is one |. Show the result with ns.Escape, never as it is.
function ns.Unescape(s)
	s = tostring(s or "")
	if not s:find("|", 1, true) then return s end
	local out, i, n = {}, 1, #s
	while i <= n do
		local j = s:find("|", i, true)
		if not j then
			out[#out + 1] = s:sub(i)
			break
		end
		out[#out + 1] = s:sub(i, j - 1)
		local nxt = s:sub(j + 1, j + 1)
		if nxt == "|" then
			out[#out + 1] = "|"
			i = j + 2
		elseif nxt == "r" then
			i = j + 2
		elseif nxt == "c" and s:sub(j + 2, j + 9):match("^%x%x%x%x%x%x%x%x$") then
			i = j + 10
		else
			out[#out + 1] = "|"
			i = j + 1
		end
	end
	return table.concat(out)
end

-- What the agent wrote, for the copy box: the bridge's colour codes go, and a
-- doubled | becomes one again, except where a single | would start a live
-- escape (a | before a letter or digit: |H links, |T textures, |c colours,
-- |r, |n, ...). Those stay doubled, which an EditBox shows as one |, so
-- nothing in the box can become a link, texture or colour.
function ns.CopyText(s)
	s = tostring(s or "")
	if not s:find("|", 1, true) then return s end
	local out, i, n = {}, 1, #s
	while i <= n do
		local j = s:find("|", i, true)
		if not j then
			out[#out + 1] = s:sub(i)
			break
		end
		out[#out + 1] = s:sub(i, j - 1)
		local nxt = s:sub(j + 1, j + 1)
		if nxt == "|" then
			out[#out + 1] = s:sub(j + 2, j + 2):match("^%w$") and "||" or "|"
			i = j + 2
		elseif nxt == "r" then
			i = j + 2
		elseif nxt == "c" and s:sub(j + 2, j + 9):match("^%x%x%x%x%x%x%x%x$") then
			i = j + 10
		else
			out[#out + 1] = "||"
			i = j + 1
		end
	end
	return table.concat(out)
end

-- The first `max` bytes of s, never cutting a UTF-8 character in half.
function ns.Utf8Cut(s, max)
	s = tostring(s or "")
	max = tonumber(max) or #s
	if #s <= max then return s end
	local cut = max
	while cut > 0 do
		local b = s:byte(cut + 1)
		if not b or b < 128 or b >= 192 then break end
		cut = cut - 1
	end
	return s:sub(1, cut)
end

function ns.FmtDur(sec)
	sec = math.max(0, math.floor(sec or 0))
	if sec < 60 then return sec .. " s" end
	if sec < 3600 then
		local s = sec % 60
		return math.floor(sec / 60) .. " min" .. (s > 0 and (" " .. s .. " s") or "")
	end
	return math.floor(sec / 3600) .. " h " .. (math.floor(sec / 60) % 60) .. " min"
end

-- A sentence with named places, one whole string per sentence so a translation
-- can move them (STYLE §12): ns.Fill("Stop {i} of {n}.", { i = 2, n = 5 }).
-- A place with no value stays as written.
function ns.Fill(template, vars)
	return (tostring(template):gsub("{(%a[%w_]*)}", function(k)
		local v = vars and vars[k]
		if v == nil then return "{" .. k .. "}" end
		return tostring(v)
	end))
end

-- One of two whole sentences by count, with {n} filled: ns.Plural(n, "1 reply waits.", "{n} replies wait.").
-- A quest objective as the HUD's list and the map's pins show it: its words
-- without the count (and without a kill's "slain"), and the count on its own
-- ("1/8"), so "1/8 Razormane Water Seeker slain" reads "Razormane Water Seeker 1/8".
function ns.SplitObjective(text)
	text = tostring(text or "")
	local count = text:match("(%d+%s*/%s*%d+)")
	local words = text:gsub("^%s*%d+%s*/%s*%d+%s*", ""):gsub("%s*:?%s*%d+%s*/%s*%d+%s*$", "")
	words = words:gsub("%s+[Ss]lain$", "")
	return words, count and count:gsub("%s", "") or nil
end

function ns.Plural(n, one, many, vars)
	local t = { n = ns.Int(n) }
	for k, v in pairs(vars or {}) do t[k] = v end
	return ns.Fill(math.floor(tonumber(n) or 0) == 1 and one or many, t)
end

-- A duration inside a sentence, spelled out (STYLE §8): "12 seconds", "5 minutes",
-- "2 hours 12 minutes". Compact lines keep ns.FmtDur.
function ns.DurWords(sec)
	sec = math.max(0, math.floor(sec or 0))
	if sec < 60 then return ns.Plural(sec, "1 second", "{n} seconds") end
	if sec < 3600 then return ns.Plural(math.floor(sec / 60), "1 minute", "{n} minutes") end
	local h, m = ns.Plural(math.floor(sec / 3600), "1 hour", "{n} hours"), math.floor(sec / 60) % 60
	return m > 0 and ns.Fill("{h} {m}", { h = h, m = ns.Plural(m, "1 minute", "{n} minutes") }) or h
end

-- A clock time as the game's own clock shows it (STYLE §8): "17:07" with its
-- 24-hour setting on, else "5:07 PM"; 24-hour when the client can't say.
function ns.ClockText(t)
	local ok, d = pcall(date, "*t", t)
	if not ok or type(d) ~= "table" or not tonumber(d.hour) then return "" end
	local mil = ns.Try(GetCVar, "timeMgrUseMilitaryTime")
	if mil == nil or mil == "1" then return string.format("%02d:%02d", d.hour, d.min) end
	local h = d.hour % 12
	return string.format("%d:%02d %s", h == 0 and 12 or h, d.min, d.hour < 12 and "AM" or "PM")
end

-- Call a game API that may not exist or may throw, and get its returns or nothing.
function ns.Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d, e, f, g = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g end
end

-- A method this client has (a CheckButton's SetChecked, say), called safely
-- (code health AD-14: the one copy, for UI.lua and HUD.lua).
function ns.Call(obj, method, ...)
	if obj and type(obj[method]) == "function" then return pcall(obj[method], obj, ...) end
end

function ns.InCombat()
	if ns.R and ns.R.inCombat then return true end
	return type(InCombatLockdown) == "function" and InCombatLockdown() and true or false
end

-- Secret values (build 70009 has them): where the game restricts a unit's
-- identity, a read gives a secret instead. In a fight an NPC's name is one
-- (UnitName is SecretWhenUnitNameIdentityRestricted in UnitDocumentation.lua;
-- UnitCreatureType and UnitGUID are SecretWhenUnitIdentityRestricted). An
-- addon that compares, joins or indexes a secret raises an error, so, as
-- Blizzard's own code does (SecureTypes.lua, Dump.lua), ask issecretvalue
-- first (an answer it can't give counts as a secret); type() is safe on one.
-- A client without issecretvalue has none.
function ns.IsSecret(v)
	if type(v) == "nil" or type(issecretvalue) ~= "function" then return false end
	local ok, secret = pcall(issecretvalue, v)
	return not ok or secret == true
end

-- v, or nil where it's a secret: a read the addon can compare and show.
function ns.Readable(v)
	if ns.IsSecret(v) then return nil end
	return v
end

---------------------------------------------------------------------------
-- The backend (docs/byok/BUILD-PLAN.md, "Contract: what the addon reads").
-- The bridge lists provider, usage, ekind and model in bridge.caps and sends
-- bridge.provider, bridge.usage and rt; a slot whose provider part failed
-- lists none of them, and what hangs off them waits. -- [C-01]
---------------------------------------------------------------------------

function ns.HasCap(name)
	local b = ns.R and ns.R.bridge
	if type(b) ~= "table" or type(b.caps) ~= "table" then return false end
	for _, v in pairs(b.caps) do
		if v == name then return true end
	end
	return false
end

-- A short string from the bridge, or nil: no | (it can't form an escape) and
-- no control bytes, cut at max bytes.
function ns.Str(v, max)
	if type(v) ~= "string" then return nil end
	v = ns.Trim((v:gsub("|", ""):gsub("%c", " ")))
	if v == "" then return nil end
	return ns.Utf8Cut(v, max or 60)
end

-- bridge.provider { id, name, model, modelName, effort, effortSupported, efforts,
-- auth, keyState, privacy, product, companion, models? [{id,label}] }, with the provider cap.
-- efforts: the model's thinking levels, cheapest first, space-separated.
function ns.Provider()
	if not ns.HasCap("provider") then return nil end
	local p = ns.R.bridge.provider
	return type(p) == "table" and p or nil
end

-- The thinking levels, cheapest first: the player's words for the AI
-- companies' effort levels (the app's EFFORT_LEVELS). A model offers the ones
-- its AI company documents (bridge.provider.efforts, chats[].efforts). A level
-- is a label: Title Case in game (STYLE §6), "Extra High".
ns.THINK_LEVELS = { "off", "minimal", "low", "medium", "high", "xhigh", "max" }
local THINK_LABELS = { off = "Off", minimal = "Minimal", low = "Low", medium = "Medium", high = "High", xhigh = "Extra High", max = "Max" }
function ns.ThinkLabel(level) return THINK_LABELS[level] end

-- The levels a bridge list names ("off low medium"), in order; nil for none.
function ns.ThinkLevelList(s)
	if type(s) ~= "string" then return nil end
	local seen, out = {}, {}
	for w in s:gmatch("%S+") do if THINK_LABELS[w] then seen[w] = true end end
	for _, l in ipairs(ns.THINK_LEVELS) do if seen[l] then out[#out + 1] = l end end
	return #out > 0 and out or nil
end

-- The level a model runs for want (the bridge's rule): want if it has it,
-- else its next one up, else its highest.
function ns.NearestThink(levels, want)
	if type(levels) ~= "table" or #levels == 0 then return nil end
	local at = 0
	for i, l in ipairs(ns.THINK_LEVELS) do if l == want then at = i end end
	for _, l in ipairs(levels) do if l == want then return l end end
	for _, l in ipairs(levels) do
		for i, v in ipairs(ns.THINK_LEVELS) do if v == l and i > at then return l end end
	end
	return levels[#levels]
end

-- [UX-3] bridge.usage { day, spentMicros, capMicros, turns, auto, exact,
-- freeUsed, freeLimit, keyLeftMicros, needs, autoOn, autoPaused }, with the
-- usage cap. The public build has no limits of its own: capMicros only while
-- the player has set a daily spend limit.
function ns.Usage()
	if not ns.HasCap("usage") then return nil end
	local u = ns.R.bridge.usage
	return type(u) == "table" and u or nil
end

-- [UX-1] rt { state, retryIn, reason }: the backend's own state (gw stays
-- "ready" whenever it's usable), with the provider cap.
function ns.RT()
	if not ns.HasCap("provider") then return nil end
	local rt = ns.R.rt
	return type(rt) == "table" and type(rt.state) == "string" and rt or nil
end

-- The provider's own name ("Anthropic", "Ollama"), or nil when it has none.
function ns.ProviderOwnName()
	local p = ns.Provider()
	local name = p and (ns.Str(p.name, 40) or ns.Str(p.id, 40))
	return name and ns.Escape(name) or nil
end

-- "Anthropic", "Ollama"; "your AI" when none is named yet ("Your AI" to start
-- a sentence). -- [UX-W19] STYLE §2.2: AI, never provider
function ns.ProviderName(start)
	return ns.ProviderOwnName() or (start and "Your AI" or "your AI")
end

-- "Claude Haiku 4.5", or nil.
function ns.ModelName()
	local p = ns.Provider()
	local m = p and (ns.Str(p.modelName, 60) or ns.Str(p.model, 60))
	return m and ns.Escape(m) or nil
end

-- The desktop app's name, for "fix it on your desktop" lines (public build).
function ns.Product()
	local p = ns.Provider()
	return ns.Escape((p and ns.Str(p.product, 40)) or "NeverQuestAlone")
end

-- The name on your own messages (Settings, Name on Your Messages): "You",
-- or your character's name. Display only: nothing sent reads it, and the saved
-- data keeps the choice, never the name. Display-ready.
function ns.YouName()
	if ns.db and ns.db.settings and ns.db.settings.youName == "character" then
		local n = ns.Readable(ns.Try(UnitName, "player")) -- the first return only (70009 returns a second); never a secret
		if type(n) == "string" and n ~= "" then return ns.Escape(n) end
	end
	return "You"
end

-- [C-23] What the HUD's Okay on a spend state puts away: "day:state",
-- the backend's own spend state first (rt: cap, out of credit, a rejected
-- key), else usage.needs; nil when there's none. The Okay holds only while
-- this stays the same (ns.NoteSlot clears it).
local RT_SPEND_STATE = { cap = true, out_of_credit = true, key_invalid = true }
function ns.SpendKey()
	local u, rt = ns.Usage(), ns.RT()
	local st = rt and RT_SPEND_STATE[rt.state] and rt.state or (u and ns.Str(u.needs, 20))
	if not st then return nil end
	return tostring(u and u.day or "") .. ":" .. st
end

-- [UX-3] Money comes as whole micro-dollars (1,000,000 = $1). "$0.18",
-- "$12.40". [UX-W20] Below a cent as the desktop says it (format.js
-- usdMicros, STYLE §8): "$0" at zero, "0.4¢" (one decimal from 0.1¢, two
-- below: "0.04¢"), and "under $0.0001" below that.
function ns.Dollars(micros)
	local m = math.max(0, math.floor(tonumber(micros) or 0))
	if m == 0 then return "$0" end
	if m < 100 then return "under $0.0001" end
	if m < 10000 then return string.format(m < 1000 and "%.2f¢" or "%.1f¢", m / 10000) end
	local cents = math.floor(m / 10000)
	return "$" .. ns.Thousands(cents / 100) .. "." .. string.format("%02d", cents % 100)
end

-- A reply's cost: "0.4¢", "12¢", "<0.1¢", "$1.05".
function ns.Cents(micros)
	local m = math.max(0, math.floor(tonumber(micros) or 0))
	if m == 0 then return "0¢" end
	if m < 1000 then return "<0.1¢" end
	if m >= 1000000 then return ns.Dollars(m) end
	local tenths = math.floor(m / 1000) -- tenths of a cent
	if tenths >= 100 or tenths % 10 == 0 then return ns.Int(tenths / 10) .. "¢" end
	return ns.Int(tenths / 10) .. "." .. ns.Int(tenths % 10) .. "¢"
end

-- [C-20] A local clock time (one format for every time the public build
-- shows: an error's, a reset), main's ns.ClockText, or nil when the client can't say.
function ns.Clock(t)
	local s = ns.ClockText(t)
	return s ~= "" and s or nil
end

-- The companion's name (UX-5): the agents list's name for the default agent
-- (the app's persona: NeverQuestAlone, the product's own name, unless the
-- player renamed it), kept in the saved data. Display-ready.
ns.COMPANION_NAME = "NeverQuestAlone"
function ns.Name()
	if ns.Chats and ns.db then return ns.Chats.AgentName(ns.DEFAULT_AGENT) end
	return ns.COMPANION_NAME
end

-- The addon's own words name the companion "NeverQuestAlone" (the owner,
-- 2026-10-05: one name, never Bones); with another name from the bridge, P
-- puts it in. Where the words mean the app, the addon in the game's menus or
-- an update, the product's name stays (KEEP; none holds a pattern character).
-- s is display-ready text of ours, and only ours: P goes on a template before
-- a chat's name, a quest, an item or the bridge's words join it, and once. The
-- result is display-ready, and can be a format string (the name brings no %).
local KEEP = { "NeverQuestAlone app", "NeverQuestAlone addon", "> NeverQuestAlone", "Update NeverQuestAlone" }
function ns.P(s)
	s = tostring(s or "")
	local name = (ns.Name():gsub("%%", ""))
	if name == ns.COMPANION_NAME or not s:find(ns.COMPANION_NAME, 1, true) then return s end
	for i, k in ipairs(KEEP) do s = s:gsub(k, "\1" .. i .. "\2") end
	s = s:gsub(ns.COMPANION_NAME, name)
	return (s:gsub("\1(%d)\2", function(i) return KEEP[tonumber(i)] end))
end

-- The key bindings follow the companion's name; their section keeps the
-- product's, NeverQuestAlone (C-124, C-127). -- [UX-5]
function ns.PersonaChanged()
	for k, v in pairs(BINDING_WORDS) do _G["BINDING_NAME_" .. k] = ns.P(v) end
end

---------------------------------------------------------------------------
-- The quest log: every quest in it, and the game's cap (PROTOCOL §2.6)
---------------------------------------------------------------------------

-- The most quests the log can hold, read at run time, and where that came
-- from: the larger of C_QuestLog.GetMaxNumQuestsCanAccept ("api") and the
-- constant Forever's own quest log counts against ("const": 40 on 70009), else
-- 40 ("fallback"), at least every client's cap (Classic 20, TBC to MoP 25,
-- retail 35, Forever 40). The larger: it's only reported, and an API answering
-- a stale 25 would make a log of 30 look full. Never MAX_QUESTS: on Forever
-- that UI global is a stale 25. atLeast (the quests read) keeps it from ever
-- saying fewer than the log holds. It's never a cut: the log is always read to
-- its end.
function ns.QuestLogMax(atLeast)
	local function Whole(v) return type(v) == "number" and v >= 1 and v == math.floor(v) and v or nil end
	local api = Whole(ns.Try(C_QuestLog and C_QuestLog.GetMaxNumQuestsCanAccept))
	local qc = type(Constants) == "table" and type(Constants.QuestLogConsts) == "table" and Constants.QuestLogConsts or nil
	local const = Whole(qc and qc.MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT)
	local max, source = 40, "fallback"
	if api and (not const or api >= const) then max, source = api, "api" elseif const then max, source = const, "const" end
	atLeast = tonumber(atLeast) or 0
	if max < atLeast then max = atLeast end
	return max, source
end

-- Every quest in the player's log, in log order, to the last one. Returns
-- { { id, title, level, complete } ... } and meta { count, max, source,
-- unread, total, hidden, collapsed, folded }.
--   One pass over every entry C_QuestLog.GetInfo lists. On WoW: Forever that
--   takes in the quests under a collapsed header: the game's own quest list
--   reads them and hides them itself while it draws (Mainline QuestMapFrame.lua
--   QuestLogQuests_ShouldShowQuestButton: "its header is collapsed"). So no
--   header is ever opened or closed, and nothing is kept between reads.
--   A quest is a row that list would show but for a collapsed header or a
--   search: not a header, not hidden, not a task (a bonus objective), a bounty
--   only once it's complete. unread: such rows the game gave no quest id yet,
--   told to the model, never dropped unsaid.
--   total (the game's own count, GetNumQuestLogEntries' second value), hidden,
--   collapsed (collapsed headers) and folded (quests read under them) are for
--   /bones apicheck only: whether the count takes in hidden quests isn't known,
--   so it never changes what the model is told.
--   While R.questShare is set for this frame (one send), the context and the
--   state share one read.
function ns.QuestLog()
	local R = ns.R or {}
	local share = R.questShare
	if share and share.at == GetTime() and share.list then return share.list, share.meta end
	local QL = C_QuestLog or {}
	local function Complete(id)
		local c = ns.Try(QL.IsComplete, id)
		if c == nil then c = ns.Try(QL.ReadyForTurnIn, id) end
		return c and true or false
	end
	local n, total = ns.Try(QL.GetNumQuestLogEntries)
	local result, meta = {}, { unread = 0, total = type(total) == "number" and total or nil, hidden = 0, collapsed = 0, folded = 0 }
	local shut = false -- the rows since a collapsed header
	for i = 1, type(n) == "number" and n or 0 do
		local info = ns.Try(QL.GetInfo, i)
		if type(info) == "table" and next(info) ~= nil then
			if info.isHeader then
				shut = info.isCollapsed and true or false
				if shut then meta.collapsed = meta.collapsed + 1 end
			elseif info.isHidden then
				meta.hidden = meta.hidden + 1
			elseif not info.isTask and (not info.isBounty or Complete(info.questID)) then
				if type(info.questID) == "number" and info.questID > 0 then
					result[#result + 1] = { id = info.questID, title = info.title, level = info.level, complete = Complete(info.questID) }
					if shut then meta.folded = meta.folded + 1 end
				else
					meta.unread = meta.unread + 1
				end
			end
		end
	end
	local cap, source = ns.QuestLogMax()
	meta.count, meta.max, meta.source = #result, math.max(cap, #result), source
	if share and share.at == GetTime() then share.list, share.meta = result, meta end
	return result, meta
end

-- The count that goes before the ids on the context's Quest log line: "27 of
-- 40 quests, all listed", or, for quests the game gave no id yet, that they
-- aren't listed and are still in the log, so Bones never takes the list for a
-- cut one or a quest for gone. The bridge writes the same words from the state
-- (bridge/app/companion.mjs questCountPhrase). No colon in it: the bridge finds
-- the count by the first.
function ns.QuestCountPhrase(count, max, unread)
	count, unread = tonumber(count) or 0, tonumber(unread) or 0
	if unread == 0 then
		return max and string.format("%d of %d quests, all listed", count, max) or string.format("%d quests, all listed", count)
	end
	return string.format("%d quests listed%s, not the whole log (the game listed %d more without a quest id yet; still in the log)",
		count, max and string.format(" (max %d)", max) or "", unread)
end

---------------------------------------------------------------------------
-- Ids
---------------------------------------------------------------------------

function ns.NewToken()
	return string.format("%04x%04x", math.random(0, 0xFFFF), math.random(0, 0xFFFF))
end

-- A fresh nonce for this UI session (§2.3): 4 lowercase hex, never one of the
-- last few sessions' (their keys may still be in the bridge's dedupe window).
function ns.NewNonce()
	local recent = {}
	for _, n in ipairs(ns.db and ns.db.nonces or {}) do recent[n] = true end
	local nonce
	for _ = 1, 50 do
		nonce = string.format("%04x", math.random(0, 0xFFFF))
		if not recent[nonce] then break end
	end
	return nonce
end

function ns.NewChatId()
	local taken = {}
	for _, c in ipairs(ns.db and ns.db.chats or {}) do taken[c.id] = true end
	local id
	for _ = 1, 50 do
		id = string.format("c%06x", math.random(0, 0xFFFFFF))
		if not taken[id] then break end
	end
	return id
end

function ns.NewChatRecord(name)
	return {
		id = ns.NewChatId(),
		name = name or "Chat 1",
		agent = ns.DEFAULT_AGENT,
		history = {},
		pending = {},
		unread = 0,
		created = time(),
	}
end

---------------------------------------------------------------------------
-- Events: one frame, handlers per event (registered by the other files)
---------------------------------------------------------------------------

local handlers = {}
local eventFrame = CreateFrame("Frame")
eventFrame:SetScript("OnEvent", function(_, event, ...)
	for _, fn in ipairs(handlers[event] or {}) do fn(event, ...) end
end)

function ns.On(event, fn)
	if not handlers[event] then
		handlers[event] = {}
		-- Events this client doesn't know would error; skip them quietly.
		pcall(eventFrame.RegisterEvent, eventFrame, event)
	end
	table.insert(handlers[event], fn)
end

-- The game's panels (Settings, the quest log, a link's tooltip) open through
-- ShowUIPanel, which turns an addon away in a fight with "Interface action
-- failed because of an AddOn" (UIParentPanelManager.lua:853-861 at 70009;
-- Settings.OpenToCategory calls C_SettingsUtil.OpenSettingsPanel, which has
-- restrictions, then ShowUIPanel). So a click that opens one in a fight waits
-- for the fight's end: the game's own line says so, and fn runs then (the
-- newest such click only). True when it waits, and the caller stops there.
function ns.AfterCombat(fn, line)
	if not (type(InCombatLockdown) == "function" and InCombatLockdown()) then return false end
	ns.R.afterCombat = fn
	ns.Notify.Game(line)
	return true
end

-- Combat lockdown ends before PLAYER_REGEN_ENABLED fires. A fight that ended
-- in your death opens nothing: Release Spirit comes first. Protected, so a
-- failed open never stops the event's other handlers (held replies, the HUD).
ns.On("PLAYER_REGEN_ENABLED", function()
	local fn = ns.R.afterCombat
	ns.R.afterCombat = nil
	if fn and not ns.Try(UnitIsDeadOrGhost, "player") then pcall(fn) end
end)

---------------------------------------------------------------------------
-- Runtime state (per UI session; a /reload starts over). One table for the
-- life of the file, reset in place, so every file can keep a local to it.
---------------------------------------------------------------------------

ns.R = {}

function ns.ResetRuntime()
	local R = ns.R
	for k in pairs(R) do R[k] = nil end
	local fresh = {
		loginAt = GetTime(),
		nonce = nil,
		out = {}, -- key -> { wire, type, chat, cur, n } for every outbox entry (decoded hex)
		sentAt = {}, -- key -> GetTime() when this session first drew or queued it
		ticks = 0,
		frame = math.random(0, 65535), -- strip frame counter
		stripShown = false,
		stripPayload = nil,
		stripWaits = false, -- [code health AD-03] what's drawn waits for the bridge's answer
		-- [code health AD-03] The strip's self-heal (Transport's T.Heal): its clocks in visible seconds
		-- (drawn: since this frame was drawn; full: since the last full draw, while something waits),
		-- the full draws it made (ack: a frame that waited too long; timer: the periodic one), how many
		-- an ack followed within T.HEAL_ACK (heard), the frame it last drew and when.
		heal = { drawn = 0, full = 0, ack = 0, timer = 0, heard = 0, frame = nil, lastAt = nil, answered = nil },
		hello = nil, -- { wire, cur, p, ctx, order, firstDrawAt, drawUntil, confirmed }
		helloAnswered = false,
		liveChecked = false,
		seen = nil, -- { wire, cur, order, untilT }
		contextSent = nil,
		sig = { static = nil, live = "pending", checks = 0, hits = 0 },
		absentCount = 0,
		push = { known = nil, reported = nil, rings = 0, lastRingAt = nil, pending = false }, -- §3: the push counter read, and told the bridge
		bells = {}, -- name -> { rings, armed, missingSince, dead } (§3 doorbells)
		ringAfterHello = false,
		lastBeatAt = nil,
		bridgeSeenAt = nil,
		gw = nil,
		bridge = nil,
		snap = {},
		slots = { loads = 0, reasons = {}, nextIndex = 1, free = ns.SLOT_COUNT, broken = nil, lastAt = nil },
		progress = { last = nil, session = 0, perRun = {} },
		acts = {},
		follow = {}, -- key -> { n }: slot-only loads after a send's schedule (§4.2 rule 4)
		sched = {},
		acks = { slot = 0 },
		lastAckAt = nil,
		orphans = 0,
		skipped = 0,
		mismatch = nil,
		applyBytes = 0,
		unreportedSince = nil,
		dndQueue = {},
		inCombat = false,
		regenAt = nil,
		stopAt = {},
		warned = {},
		rev = {}, -- chatId -> history revision, for redraws
		reloadFallback = false,
		notices = {}, -- chatId -> { text, t }: a command's answer, shown once and never saved
		skipGameData = false, -- the composer's Game data tick, unticked: sends from there go without it (until ticked, or a /reload; words kept through one keep it, UI.lua)
		-- [DR-07, DR-08, DR-09] The display clocks (Transport's T.Clocks), in visible seconds.
		vis = {}, -- key -> seconds on the strip while the strip was on screen (since the first slot load, for a carried key)
		missed = {}, -- key -> true: a slot load T.MISS_AFTER or more after it was drawn came back without its ack
		carried = {}, -- key -> true: in the outbox at login, so in SavedVariables at the last logout or /reload
		firstLoadAt = nil, -- this session's first slot load (a carried key's clock starts there, SY-29)
		cap = nil, -- { state, vis }: the published capture state, and how long it has held on screen
		probeVis = 0, -- visible seconds since the last self-probe while no_signal is published
		clockAt = nil,
		saidMode = nil, -- the mode the hello or the last mode seen said
		stuckKey = nil, -- what the stuck state was at the last tick, to redraw on a change
	}
	for k, v in pairs(fresh) do R[k] = v end
	return R
end

---------------------------------------------------------------------------
-- Saved data: create, validate, migrate
---------------------------------------------------------------------------

local SETTINGS_DEFAULTS = {
	speak = false, -- read companion summaries with the client's TTS
	live = false, -- live state snapshots between messages
	echo = "summary", -- summary | full | short | off (RC-8)
	context = true, -- game context rides along (SE-7)
	dndCombat = true, -- NT-2
	mode = "pixel", -- pixel | reload (§5)
	stream = false, -- D6: sends through the reload path, no strip
	width = 420, -- the conversation alone; the chat list adds its own width when shown (UI.lua's DEFAULT_W)
	height = 380,
	listShown = false, -- the chat list, folded away by default (the Chats button)
	textSize = "medium", -- the transcript's text: small | medium | large
	hud = true, -- the Bones HUD (HUD.lua); off brings back the mini bar
	hudMin = false, -- the HUD as one bar (its minimize button, /bones hud min)
	hudCompass = false, -- minimized further: the arrow and the distance (the bar's Show Less, /bones hud compass)
	hudAlpha = 100, -- the HUD's opacity in percent, 60 to 100 (Settings)
	waypoint = true, -- a route's next stop is the game's own waypoint (Map.lua)
	tooltips = true, -- Bones's verdict in item tooltips, once he sent weights (Tooltips.lua)
	chains = true, -- where a quest's chain leads, under its title on the quest pages (Chains.lua)
	quips = false, -- Bones's local one-liners (a death, a hearth); off by default
	replyCost = false, -- [UX-3] "0.4¢ · 1.2k tokens" under each reply, when the bridge reports usage
	-- Appearance options whose default is main's look (the public build's Settings rows):
	times = true, -- the time on each message
	youName = "you", -- your messages say "You", or your character's name ("character")
	replies = "auto", -- auto: the NeverQuestAlone app once it answers, Copy and Paste until then; paste: always Copy and Paste (Paste.lua)
	-- Quality of Life (QoL.lua): every option off until the player turns it on.
	qolAccept = false, -- Auto Accept Quests
	qolTurnIn = false, -- Auto Turn In Quests
	qolRewards = "you", -- Quest Rewards: you (Your Pick) | bones (Best Upgrade) | sell (Highest Price)
	qolSkip = false, -- Auto Skip to Quests
	qolJunk = false, -- Auto Sell Junk
	qolRepair = false, -- Auto Repair
}
local ECHO_MODES = { summary = true, full = true, short = true, off = true }
ns.TEXT_SIZES = { small = -2, medium = 0, large = 3, xlarge = 6 } -- xlarge the public build's; points added to the chat font's size

local function Count(n, default)
	n = tonumber(n)
	if not n or n < 0 then return default or 0 end
	return math.floor(n)
end

local function CleanChat(c)
	if type(c) ~= "table" or type(c.id) ~= "string" or not c.id:match("^c%x%x%x%x%x%x$") then return nil end
	c.id = c.id:lower()
	c.name = (type(c.name) == "string" and c.name ~= "") and c.name or "Chat"
	c.agent = (type(c.agent) == "string" and c.agent ~= "") and c.agent or ns.DEFAULT_AGENT
	if type(c.history) ~= "table" then c.history = {} end
	local pending = {}
	for _, p in ipairs(type(c.pending) == "table" and c.pending or {}) do
		if type(p) == "table" and type(p.key) == "string" then table.insert(pending, p) end
	end
	c.pending = pending
	c.unread = Count(c.unread)
	c.created = Count(c.created, time())
	-- The time of the chat's newest message (the list shows the most recent first).
	local newest = c.history[#c.history]
	c.lastAt = Count(c.lastAt, type(newest) == "table" and tonumber(newest.t) or c.created)
	-- Pinned chats sit at the top of the list; pinOrder is when (a counter, newest pin first).
	if c.pinned == true then c.pinOrder = Count(c.pinOrder) else c.pinned, c.pinOrder = nil, nil end
	return c
end

-- Pinned chats first, newest pin on top; then the rest, the most recently
-- active first (ties keep their order). The list, /bones chat <n> and the
-- saved data all use this order.
function ns.SortChats(chats)
	local pinned, rest = {}, {}
	for i, c in ipairs(chats) do
		c.sortPos = i
		if c.pinned then pinned[#pinned + 1] = c else rest[#rest + 1] = c end
	end
	table.sort(pinned, function(a, b) return a.pinOrder > b.pinOrder end)
	table.sort(rest, function(a, b)
		local la, lb = a.lastAt or 0, b.lastAt or 0
		if la ~= lb then return la > lb end
		return a.sortPos < b.sortPos
	end)
	for i, c in ipairs(pinned) do chats[i] = c end
	for i, c in ipairs(rest) do chats[#pinned + i] = c end
	for _, c in ipairs(chats) do c.sortPos = nil end
end

function ns.InitDB()
	if type(NQADB) ~= "table" then NQADB = {} end
	local db = NQADB
	ns.db = db
	db.schema = 1
	if type(db.token) ~= "string" or not db.token:match("^[0-9a-f]+$") or #db.token ~= 8 then
		db.token = ns.NewToken()
	end
	db.sendCounter = Count(db.sendCounter)
	db.cursor = Count(db.cursor)
	db.reported = Count(db.reported)
	if db.reported > db.cursor then db.reported = db.cursor end

	-- Outbox entries are { key, hex }; anything else can't be sent verbatim.
	local outbox = {}
	for _, e in ipairs(type(db.outbox) == "table" and db.outbox or {}) do
		if type(e) == "table" and type(e.key) == "string" and ns.FromHex(e.hex) then
			table.insert(outbox, { key = e.key, hex = e.hex })
		end
	end
	db.outbox = outbox

	local nonces = {}
	for _, n in ipairs(type(db.nonces) == "table" and db.nonces or {}) do
		if type(n) == "string" then table.insert(nonces, n) end
	end
	db.nonces = nonces

	if type(db.settings) ~= "table" then db.settings = {} end
	local s = db.settings
	-- Before 0.3.1 the window was 820 wide with the list always there: a window
	-- still at that default becomes the narrow one.
	if s.listShown == nil and tonumber(s.width) == 820 and tonumber(s.height) == 540 then s.width = nil end
	-- [ingame-clarity] It opened at 560 by 540 before (a player, 2026-10-05: "too big"): a window still
	-- at that size (786 wide with the chat list's 226, or 0.3.1's just above) and never sized with the
	-- grip opens at the new default. A size you set with the grip (heightSet) is yours and stays.
	if not s.heightSet and tonumber(s.height) == 540 and (s.width == nil or tonumber(s.width) == 560 or (s.listShown and tonumber(s.width) == 786)) then
		s.width, s.height = s.listShown and 420 + 226 or nil, nil
	end
	for k, v in pairs(SETTINGS_DEFAULTS) do
		if s[k] == nil then s[k] = v end
	end
	s.listShown = s.listShown and true or false
	s.heightSet = s.heightSet and true or nil -- a height you set with the grip (UI.FitToScreen)
	if not ECHO_MODES[s.echo] then s.echo = "summary" end
	if s.mode ~= "pixel" and s.mode ~= "reload" then s.mode = "pixel" end
	if s.replies ~= "auto" and s.replies ~= "paste" then s.replies = "auto" end
	s.speak, s.live = s.speak == true, s.live == true
	-- The voice companion's persona (Companion.VOICE_PERSONAS): a name it knows, else none.
	if type(s.voicePersona) ~= "string" or not s.voicePersona:match("^[a-z%-]+$") or #s.voicePersona > 24 then s.voicePersona = nil end
	-- The voice bar (VoiceBar.lua): on unless turned off; where you dragged it, whole numbers on screen.
	s.voiceBar = s.voiceBar ~= false
	s.voiceRead = s.voiceRead == true -- the voice companion reads replies aloud (Companion.VoiceRead)
	for _, k in ipairs({ "voiceBarX", "voiceBarY" }) do
		local v = s[k]
		if type(v) ~= "number" or v ~= v or v < -100 or v > 10000 then s[k] = nil else s[k] = math.floor(v) end
	end
	s.stream = s.stream and true or false
	if not ns.TEXT_SIZES[s.textSize] then s.textSize = "medium" end
	for _, k in ipairs({ "hud", "hudMin", "hudCompass", "waypoint", "tooltips", "quips", "replyCost", "times" }) do s[k] = s[k] and true or false end -- [UX-3] replyCost; times
	if s.youName ~= "you" and s.youName ~= "character" then s.youName = "you" end
	-- Quality of Life: on only when saved as true, never from a stray value.
	for _, k in ipairs({ "qolAccept", "qolTurnIn", "qolSkip", "qolJunk", "qolRepair" }) do s[k] = s[k] == true end
	if s.qolRewards ~= "you" and s.qolRewards ~= "bones" and s.qolRewards ~= "sell" then s.qolRewards = "you" end
	local alpha = tonumber(s.hudAlpha)
	s.hudAlpha = alpha and math.max(60, math.min(100, math.floor(alpha / 5 + 0.5) * 5)) or 100
	db.hudIntro = db.hudIntro and true or nil -- the first reply came (or 0.5.3's Welcome was put away): the Quality of Life step may follow
	db.qolAsked = db.qolAsked and true or nil -- the HUD's Quality of Life step, answered
	db.qolTold = db.qolTold and true or nil -- the line about it, said once ever
	db.backend = nil -- 0.5.3 kept which of its two builds the last slot came from; there is one now
	db.spendOkay = type(db.spendOkay) == "string" and db.spendOkay or nil -- [C-23] the HUD's spend line you said Okay to
	db.firstReply = db.firstReply and true or nil -- [UX-8] a reply has come (the setup checklist)
	-- [both:B B-3] (L1-1) A key kept as a draft before the fix: gone from the saved data at load.
	if ns.Chats and ns.Chats.KeyShaped then
		for _, c in ipairs(type(db.chats) == "table" and db.chats or {}) do
			if type(c) == "table" and type(c.draft) == "string" and ns.Chats.KeyShaped(c.draft) then c.draft = nil end
		end
	end
	-- linked: a NeverQuestAlone app (or the bridge) has answered this install, so
	-- messages go to it (Transport.Heard); until then they go by Copy and Paste
	-- (Paste.lua). Saved data from before 0.5.3 that ever sent or read a record
	-- came from an install with the bridge: it's linked. Once only: after that,
	-- only an app's answer links (Transport.Heard).
	if not db.linkMigrated then
		if db.linked == nil and (db.sendCounter > 0 or db.cursor > 0) then db.linked = true end
		db.linkMigrated = true
	end
	db.linked = db.linked and true or nil

	-- Stat weights per character: numbers only, under the keys Tooltips.lua knows.
	local weights = {}
	for who, w in pairs(type(db.weights) == "table" and db.weights or {}) do
		if type(who) == "string" and type(w) == "table" then
			local clean, n = {}, 0
			for k, v in pairs(w) do
				local x = tonumber(v)
				-- As the bridge takes them: finite and under 100 either way.
				if type(k) == "string" and ns.WEIGHT_KEYS[k] and x and x == x and x > -100 and x < 100 then
					clean[k] = x
					n = n + 1
				end
			end
			if n > 0 then weights[who] = clean end
		end
	end
	db.weights = weights
	local runTimes = {}
	for _, v in ipairs(type(db.runTimes) == "table" and db.runTimes or {}) do
		if tonumber(v) and tonumber(v) >= 0 then runTimes[#runTimes + 1] = tonumber(v) end
	end
	db.runTimes = runTimes

	local chats, seen, own = {}, {}, 0
	for _, c in ipairs(type(db.chats) == "table" and db.chats or {}) do
		c = CleanChat(c)
		if c and not seen[c.id] and (c.id == ns.COMPANION_CHAT or own < ns.MAX_CHATS) then
			seen[c.id] = true
			table.insert(chats, c)
			if c.id ~= ns.COMPANION_CHAT then own = own + 1 end
		end
	end
	db.chats = chats
	if #db.chats == 0 then table.insert(db.chats, ns.NewChatRecord("Chat 1")) end
	db.pinCounter = Count(db.pinCounter)
	ns.SortChats(db.chats)
	local active = false
	for _, c in ipairs(db.chats) do
		if c.id == db.activeChat then active = true end
	end
	if not active then db.activeChat = db.chats[1].id end
	if type(db.agentNames) ~= "table" then db.agentNames = {} end
	-- "Bones" was the companion's default name until 1.4.9 (the owner, 2026-10-05):
	-- a saved one goes, so the name is NeverQuestAlone until the app says otherwise.
	for id, n in pairs(db.agentNames) do if type(n) == "string" and n:lower() == "bones" then db.agentNames[id] = nil end end
	ns.PersonaChanged() -- [UX-5]
	return db
end
