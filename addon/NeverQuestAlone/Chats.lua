-- Chats.lua: chats, their history, and what goes into a message.
--
-- Each WoW chat is one of the app's conversations (CS-1), made by the bridge
-- on the chat's first msg, which carries name= (CS-3). A rename sends patch
-- label=, a delete sends forget (the app deletes the chat's history there,
-- CS-4). Messages are limited to 2,900 bytes (SE-1); shift-clicked
-- links become [Name] plus their tooltip (SE-6); the game context rides along
-- when it changed (SE-7); every msg is q=followup, so a send while Bones works
-- queues (SE-4).
--
-- History entries: { role = user|assistant|system, text, t, key, mid, agent,
-- more, kind, queued }. Assistant and system text is stored display-ready
-- (the bridge escaped it); what the player typed is stored as typed and
-- escaped when shown.

local _, ns = ...
local C = {}
ns.Chats = C
local R = ns.R

local LINK_LINES_MAX = 30 -- tooltip lines kept per link (upstream)
local LINK_BYTES_MAX = 900 -- bytes kept per link (upstream)
local AGENT_FALLBACK = { main = "NeverQuestAlone" }

---------------------------------------------------------------------------
-- Lookup and names
---------------------------------------------------------------------------

function C.Find(id)
	if type(id) ~= "string" then return nil end
	for i, c in ipairs(ns.db.chats) do
		if c.id == id then return c, i end
	end
end

function C.Active()
	return C.Find(ns.db.activeChat)
end

-- An agent's display name: the bridge's agents list ("NeverQuestAlone" for
-- main), kept in the saved data so it survives a /reload.
function C.AgentName(id)
	id = (type(id) == "string" and id ~= "") and id or ns.DEFAULT_AGENT
	local name = ns.db.agentNames[id] or AGENT_FALLBACK[id] or (id:sub(1, 1):upper() .. id:sub(2))
	return ns.Escape(name)
end

-- "Bones", the companion's default name until 1.4.9 (the owner, 2026-10-05),
-- from an app that still says it: the default, NeverQuestAlone (AGENT_FALLBACK).
local function EarlierDefault(name) return type(name) == "string" and name:lower() == "bones" end

function C.SetAgents(list)
	local before = ns.db.agentNames[ns.DEFAULT_AGENT]
	for _, a in ipairs(list) do
		if type(a) == "table" and type(a.id) == "string" and type(a.name) == "string" and a.name ~= "" then
			ns.db.agentNames[a.id] = not EarlierDefault(a.name) and a.name or nil
		end
	end
	if ns.db.agentNames[ns.DEFAULT_AGENT] ~= before then ns.PersonaChanged() end -- [UX-5] the bindings follow the name
end

-- [UX-5] The companion's name from bridge.provider.companion, over the
-- agents list's: plain words, at most a chat name's length (ns.NoteSlot
-- calls it only with a provider).
function C.SetCompanionName(name)
	name = ns.Str(type(name) == "string" and name:gsub("%%", "") or nil, ns.NAME_MAX) -- no %: it goes into format strings
	if EarlierDefault(name) then name = false end -- the default: no name of its own
	if name == nil or ns.db.agentNames[ns.DEFAULT_AGENT] == (name or nil) then return end
	ns.db.agentNames[ns.DEFAULT_AGENT] = name or nil
	ns.PersonaChanged()
end

---------------------------------------------------------------------------
-- History
---------------------------------------------------------------------------

-- Saved history has a byte budget as well as a count (PF-06: the count alone
-- let it reach some 50 MB, parsed at every login and /reload). Over it, the
-- oldest entries go: from the other chats, unpinned before pinned, used least
-- recently first (the Companion's last), down to their newest HISTORY_KEEP,
-- then down to their newest one; only then from the chat just written to, down
-- to HISTORY_KEEP.
local HISTORY_KEEP = 20
-- [code health AD-07] An entry's weight in saved data: its words (the text, the TL;DR, what
-- was typed, the chips) and about 150 bytes of the rest (keys, role, times, ids, usage,
-- refs). The text and TL;DR alone let saved data reach 4.6 MB under the 1.5 MB budget.
local ENTRY_OVERHEAD = 150
local function EntryBytes(e)
	local n = ENTRY_OVERHEAD + (type(e.text) == "string" and #e.text or 0) + (type(e.summary) == "string" and #e.summary or 0)
		+ (type(e.typed) == "string" and #e.typed or 0)
	if type(e.chips) == "table" then
		for _, chip in ipairs(e.chips) do
			if type(chip) == "string" then n = n + #chip end
		end
	end
	return n
end
-- [code health AD-08] Every chat's entries together, kept as entries come and go (nil:
-- counted again, once), where each new entry walked every saved one (0.33 ms an entry
-- at 7,900 entries). History changes only here and when a chat is deleted.
local function HistoryBytes()
	if not R.historyBytes then
		local total = 0
		for _, c in ipairs(ns.db.chats) do
			for _, e in ipairs(c.history) do total = total + EntryBytes(e) end
		end
		R.historyBytes = total
	end
	return R.historyBytes
end
local function TrimToBudget(current)
	local budget, total = ns.HISTORY_BYTES, HistoryBytes()
	if total <= budget then return end
	local others = {}
	for _, c in ipairs(ns.db.chats) do
		if c ~= current and c.id ~= ns.COMPANION_CHAT then others[#others + 1] = c end
	end
	table.sort(others, function(a, b)
		if (a.pinned and true or false) ~= (b.pinned and true or false) then return not a.pinned end -- unpinned first (C-113)
		return (a.lastAt or 0) < (b.lastAt or 0)
	end)
	local comp = C.Find(ns.COMPANION_CHAT)
	if comp and comp ~= current then others[#others + 1] = comp end
	local function Cut(c, keep)
		local cut = false
		while total > budget and #c.history > keep do
			total = total - EntryBytes(table.remove(c.history, 1))
			cut = true
		end
		R.historyBytes = total
		if cut then R.rev[c.id] = (R.rev[c.id] or 0) + 1 end
		return total <= budget
	end
	for _, keep in ipairs({ HISTORY_KEEP, 1 }) do
		for _, c in ipairs(others) do
			if Cut(c, keep) then return end
		end
	end
	Cut(current, HISTORY_KEEP)
end

function C.AddHistory(chat, entry)
	entry.t = entry.t or time()
	local bytes = HistoryBytes() + EntryBytes(entry) -- [code health AD-08] the total, kept
	table.insert(chat.history, entry)
	while #chat.history > ns.MAX_HISTORY do
		bytes = bytes - EntryBytes(table.remove(chat.history, 1))
	end
	R.historyBytes = bytes
	TrimToBudget(chat)
	R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
	-- The list shows the most recently active chats first (pins stay on top).
	chat.lastAt = entry.t
	ns.SortChats(ns.db.chats)
end

-- A system line; text is display-ready (anything user-made in it escaped).
function C.System(chat, text)
	if not chat then return end
	C.AddHistory(chat, { role = "system", text = text })
	ns.Refresh()
end

-- A command's answer (/bones help, diag, state, ...): shown at the end of the
-- chat until it's dismissed or the next one replaces it, and never saved, so
-- it doesn't bury the conversation. Text is display-ready, like System's.
function C.Notice(chat, text)
	if not chat then return end
	R.notices[chat.id] = { text = text, t = GetTime() }
	R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
	ns.Refresh()
end

function C.DismissNotice(chatId)
	if not R.notices[chatId] then return end
	R.notices[chatId] = nil
	R.rev[chatId] = (R.rev[chatId] or 0) + 1
	ns.Refresh()
end

-- "You: where's the forge" or "Bones: ...": a chat's newest line for the list,
-- plain and short.
-- What you wrote, as plain words: links became their [Name] when it was sent,
-- and the tooltips that went after them are left out. Escape it to show it.
function C.PlainWords(e)
	if type(e) ~= "table" then return "" end
	local body = tostring(e.text or "")
	local at = body:find("\n\n--- Linked from the game ---", 1, true)
	return at and body:sub(1, at - 1) or body
end

function C.Preview(chat, max)
	local e = chat.history[#chat.history]
	if type(e) ~= "table" then return "" end
	max = max or 60
	-- Plain words first (yours and the game's as they are, display-ready text
	-- unescaped), cut short, then escaped once: no | in any of them can form a
	-- live escape in the list.
	local plain, who
	if e.role == "user" then
		who = e.event and "" or (ns.YouName() .. ": ") -- display only (Settings' Name on Your Messages)
		plain = (e.event and tostring(e.text or "") or C.PlainWords(e)):sub(1, max * 4)
	else
		who = e.role == "assistant" and (C.AgentName(e.agent or chat.agent) .. ": ") or ""
		local src = (e.role == "assistant" and type(e.summary) == "string" and e.summary ~= "") and e.summary or tostring(e.text or "")
		plain = ns.Unescape(src:sub(1, max * 4))
	end
	plain = ns.Trim(plain:gsub("%s+", " "))
	local cut = #plain > max
	if cut then plain = ns.Utf8Cut(plain, max) end
	return who .. ns.Escape(plain) .. (cut and "…" or "")
end

-- What you typed in this chat, newest first (for Up in the box; not events).
function C.SentTexts(chat, max)
	local out = {}
	for i = #chat.history, 1, -1 do
		local e = chat.history[i]
		if e.role == "user" and not e.event and type(e.text) == "string" and e.text ~= "" then
			local typed = e.typed or e.text
			if out[#out] ~= typed then out[#out + 1] = typed end
			if #out >= (max or 20) then break end
		end
	end
	return out
end

-- "Name-Realm", the key per-character data is kept under.
function ns.CharKey()
	return tostring(ns.Readable(ns.Try(UnitName, "player")) or "?") .. "-" .. tostring((ns.Try(GetRealmName)) or "?")
end

-- Suggested replies from a reply record: at most 3 short lines of plain text
-- (the bridge takes | out; this does too, so a chip can't form an escape).
local CHIPS_MAX, CHIP_BYTES = 3, 80
function C.CleanChips(list)
	if type(list) ~= "table" then return nil end
	local out = {}
	for _, s in ipairs(list) do
		if #out >= CHIPS_MAX then break end
		if type(s) == "string" then
			s = ns.Trim(ns.Utf8Cut((s:gsub("|", ""):gsub("%c", " "):gsub("%s+", " ")), CHIP_BYTES))
			if s ~= "" then out[#out + 1] = s end
		end
	end
	return #out > 0 and out or nil
end

-- Game references from a reply record: quest, item and spell ids (whole
-- numbers only, 8 of each at most). The window turns them into real game links.
local REFS_MAX = 8
function C.CleanRefs(refs)
	if type(refs) ~= "table" then return nil end
	local out, any = {}, false
	for _, k in ipairs({ "q", "i", "s" }) do
		local list = {}
		for _, v in ipairs(type(refs[k]) == "table" and refs[k] or {}) do
			v = tonumber(v)
			if v and v > 0 and v < 2147483647 and v == math.floor(v) and #list < REFS_MAX then list[#list + 1] = v end
		end
		if #list > 0 then
			out[k] = list
			any = true
		end
	end
	return any and out or nil
end

-- The map layers a reply drew (PROTOCOL §4.1 `drew`): names as the bridge
-- checks them, at most 12. Okay on that reply follows what it drew.
local DREW_MAX = 12
function C.CleanDrew(drew)
	if type(drew) ~= "table" then return nil end
	local out = {}
	for _, name in ipairs(drew) do
		if type(name) == "string" and #name <= 32 and name:match("^[%w_%.%-]+$") and #out < DREW_MAX then out[#out + 1] = name end
	end
	return #out > 0 and out or nil
end

-- Stat weights for this character's build, from a reply record (PROTOCOL
-- §4.1 `weights`); kept per character for the tooltip verdicts.
function C.SaveWeights(w)
	if type(w) ~= "table" then return false end
	local clean, n = {}, 0
	for k, v in pairs(w) do
		v = tonumber(v)
		if type(k) == "string" and ns.WEIGHT_KEYS[k] and v and v == v and v > -100 and v < 100 then
			clean[k] = v
			n = n + 1
		end
	end
	if n == 0 then return false end
	ns.db.weights[ns.CharKey()] = clean
	if ns.Tooltips then ns.Tooltips.Changed() end
	return true
end

-- How long replies take (send to reply), the last 20, for the HUD's "usually".
function C.NoteRunTime(sec)
	sec = tonumber(sec)
	if not sec or sec < 0 or sec > 3600 then return end
	local t = ns.db.runTimes
	t[#t + 1] = math.floor(sec + 0.5)
	while #t > 20 do table.remove(t, 1) end
end

function C.TypicalRunTime()
	local t = ns.db.runTimes
	if #t < 3 then return nil end
	local sorted = {}
	for i, v in ipairs(t) do sorted[i] = v end
	table.sort(sorted)
	return sorted[math.floor((#sorted + 1) / 2)]
end

function C.HasMid(chat, mid)
	if type(mid) ~= "string" or mid == "" then return false end
	for i = #chat.history, math.max(1, #chat.history - 50), -1 do
		if chat.history[i].mid == mid then return true end
	end
	return false
end

---------------------------------------------------------------------------
-- Busy state: sends waiting for their answer, plus the bridge's snapshot
---------------------------------------------------------------------------

function C.IsBusy(chat)
	if not chat then return false end
	if #chat.pending > 0 then return true end
	local s = R.snap[chat.id]
	return s ~= nil and s.busy == true
end

-- Unix time the current run started (the bridge's word for it, else our send).
function C.BusySince(chat)
	local s = R.snap[chat.id]
	if s and type(s.run) == "table" and tonumber(s.run.started) then return tonumber(s.run.started) end
	local p = chat.pending[1]
	return p and tonumber(p.t) or nil
end

function C.RunId(chat)
	local p = chat.pending[1]
	if p then return p.key end
	local s = R.snap[chat.id]
	return "run:" .. chat.id .. ":" .. tostring(s and type(s.run) == "table" and s.run.started or "?")
end

-- For the working bubble: "Working · 7 actions · 42 s · <title>".
function C.Progress(chat)
	local p = chat.pending[1]
	local s = R.snap[chat.id]
	local run = s and type(s.run) == "table" and s.run or nil
	local out = { pendingKey = p and p.key, acked = not p or p.acked == true, actions = 0, paste = p ~= nil and p.paste == true }
	if p and R.acts[p.key] then out.actions = R.acts[p.key].count end
	if run and tonumber(run.actions) and tonumber(run.actions) > out.actions then out.actions = math.floor(tonumber(run.actions)) end
	if run and type(run.last) == "string" and run.last ~= "" then out.title = ns.Escape(run.last) end
	local since = C.BusySince(chat)
	out.elapsed = since and math.max(0, time() - since) or 0
	out.sentAt = p and R.sentAt[p.key]
	out.stopping = R.stopAt[chat.id] ~= nil
	return out
end

-- The oldest send the bridge has acked gets its answer (a reply, error or
-- abort). With nothing acked there's nothing to pop: an unsolicited reply
-- (a subagent's result, RC-6) leaves pending sends alone.
local function PopPending(chat, replay, key)
	for i, p in ipairs(chat.pending) do
		if (key and p.key == key) or (not key and p.acked and not p.paste and not (replay and ns.Transport.KeyOfThisSession(p.key))) then
			table.remove(chat.pending, i)
			R.acts[p.key] = nil
			return p
		end
	end
end

-- A bubble's label follows its send ("sending", "queued"), so a change here
-- redraws the transcript like a history change does.
local function Touch(chat)
	R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
end

function C.OnAcked(key, o)
	if o.type ~= "msg" and o.type ~= "evt" then return end -- an evt is a turn too: its reply pops it
	local chat = C.Find(o.chat)
	if not chat then return end
	for _, p in ipairs(chat.pending) do
		if p.key == key then
			p.acked = true
			p.ackedAt = GetTime()
			Touch(chat)
		end
	end
end

-- [DR-07] Discarded after a Reload that didn't deliver it: the send waits no
-- more, and its message says it wasn't sent (the bubble's label).
function C.OnDiscarded(key, o)
	local chat = C.Find(o.chat)
	if not chat then return end
	for i = #chat.pending, 1, -1 do
		if chat.pending[i].key == key then
			table.remove(chat.pending, i)
			R.acts[key] = nil
		end
	end
	for _, e in ipairs(chat.history) do
		if e.key == key then e.notSent = true end
	end
	if o.type == "stop" then R.stopAt[chat.id] = nil end
	Touch(chat)
end

-- The bridge's chats snapshot (§4.1): busy, queued, run. When it says a chat
-- is idle with nothing queued and the gateway is ready, sends it acked are done:
-- but only once that chat was seen working after the ack (or a while has
-- passed), since an older bridge could say "idle" in the moment between the
-- ack and the start of the run.
local ACK_IDLE_GRACE = 120 -- s after the ack an idle chat's send counts as done anyway

-- [C-11] A model the bridge says a chat now uses (a reply's usage.model,
-- or the chats snapshot's model; nil: the provider's default): what /bones
-- model asked for is in effect once it's named. Nothing changes before.
function C.ConfirmModel(chat, id, fromSnapshot)
	if not chat then return end
	local asked = chat.modelAsked
	id = type(id) == "string" and ns.Str(id, 80) or nil
	if not asked then
		-- Once in effect, the snapshot's word is the chat's model, none included:
		-- the bridge drops a chat's own model (another provider in the app, the
		-- provider answered model_not_found, its state began again), and the chat
		-- is on the provider's then.
		if fromSnapshot and chat.model ~= id then
			chat.model = id
			R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
		end
		return
	end
	local p = ns.Provider()
	if asked == "default" then
		if (fromSnapshot and id == nil) or (id and p and id == p.model) then
			chat.model, chat.modelAsked = nil, nil
			R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
		end
	elseif id == asked then
		chat.model, chat.modelAsked = asked, nil
		R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
	end
end

-- [C-11] The level the bridge keeps for a chat (with cap model, the
-- snapshot's think is the chat's own /bones think, no default folded in; nil:
-- none). What /bones think asked for (chat.thinkAsked) is in effect once the
-- snapshot names it; with nothing asked, the snapshot's word is the chat's level.
function C.ConfirmThink(chat, level)
	if not chat then return end
	level = type(level) == "string" and ns.ThinkLabel(level) and level or nil
	local asked = chat.thinkAsked
	if asked then
		if level == (asked ~= "default" and asked or nil) then
			chat.thinkAsked = nil
			R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
		end
		return
	end
	if chat.think ~= level then
		chat.think = level
		R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
	end
end

function C.ApplySnapshot(list)
	local snap = {}
	for _, s in ipairs(list) do
		if type(s) == "table" and type(s.id) == "string" then snap[s.id] = s end
	end
	R.snap = snap
	local ready = type(R.gw) == "table" and R.gw.state == "ready"
	local now = GetTime()
	local models = ns.HasCap("model") -- [C-11]
	for _, chat in ipairs(ns.db.chats) do
		local s = snap[chat.id]
		if s and models then
			C.ConfirmModel(chat, s.model, true)
			C.ConfirmThink(chat, s.think)
		end
		if s and s.busy == true then
			for _, p in ipairs(chat.pending) do
				if p.acked then p.seenBusy = true end
			end
		elseif s and s.busy == false and (tonumber(s.queued) or 0) == 0 and ready then
			-- While the public build's runaway fuse holds, the bridge takes no
			-- event turn (it holds them to ride along): one it acked in the idle
			-- Companion chat is done now.
			local held = chat.id == ns.COMPANION_CHAT and ns.Companion ~= nil and ns.Companion.Call("AutoPaused") == true
			for i = #chat.pending, 1, -1 do
				local p = chat.pending[i]
				-- A message waiting for a pasted reply was never the bridge's (Paste.lua).
				if p.acked and not p.paste and (held or p.seenBusy or not p.ackedAt or now - p.ackedAt >= ACK_IDLE_GRACE) then
					R.acts[p.key] = nil
					table.remove(chat.pending, i)
					Touch(chat)
				end
			end
		end
		if not C.IsBusy(chat) then R.stopAt[chat.id] = nil end
	end
end

---------------------------------------------------------------------------
-- Applying records (§4.3): reply, error, aborted
---------------------------------------------------------------------------

-- [UX-3] A reply's usage (PROTOCOL: usage = { in, out, micros, model, exact }):
-- whole numbers and a short model name, or nil.
function C.CleanUsage(u)
	if type(u) ~= "table" then return nil end
	local function N(v)
		v = tonumber(v)
		if not v or v ~= v or v < 0 or v > 1e12 then return nil end
		return math.floor(v)
	end
	local out = { tin = N(u["in"]), tout = N(u.out), micros = N(u.micros), model = ns.Str(u.model, 60), exact = u.exact ~= false }
	if not (out.tin or out.tout or out.micros) then return nil end
	return out
end

-- [UX-2] What an error bubble offers (PRD §10), from the record's action
-- (cap ekind); a message cut off by a restart or a dropped connection is sent again.
local ERROR_ACTIONS = { retry = true, desktop = true, send_again = true, none = true }
local SEND_AGAIN = { interrupted = true, network_after_send = true }

-- Error records that answer no message of yours: the answer to a /bones stop
-- ("Nothing was running.", kind stop; "Couldn't stop: …", kind gateway after a
-- stop). They pop nothing, so the message still running waits for its own
-- answer (E-3).
function C.AnswersNothing(chat, r)
	local kind = r and r.kind
	if kind == "stop" then return true end
	return kind == "gateway" and chat ~= nil and R.stopAt[chat.id] ~= nil
end

-- Returns a notification for Notify, or nil (replay, or an abort you asked for).
function C.ApplyRecord(chat, r, replay)
	local kind = r.t
	local text, summary, drew, errEntry
	if kind == "reply" then
		if replay and C.HasMid(chat, r.mid) then return nil end
		text = ns.SafeText(r.text)
		summary = ns.SafeText(type(r.summary) == "string" and r.summary or "")
		local more = math.max(0, math.floor(tonumber(r.more) or 0))
		drew = C.CleanDrew(r.drew)
		local usage = C.CleanUsage(r.usage) -- [UX-3] nil when the bridge didn't report it
		C.AddHistory(chat, { role = "assistant", text = text, summary = summary, more = more, mid = type(r.mid) == "string" and r.mid or nil,
			agent = type(r.agent) == "string" and r.agent or nil, chips = C.CleanChips(r.chips), refs = C.CleanRefs(r.refs), drew = drew, usage = usage })
		-- A voice companion's exchange (voice = 1, odd/tasks/nqa-voice.md T7) was already spoken
		-- by the realtime voice, so the game's TTS doesn't say it a second time.
		local spokenByVoice = r.voice == 1 or r.voice == true
		if not replay and not spokenByVoice and ns.Companion then ns.Companion.Call("SpeakSummary", summary) end
		if usage and usage.model and not replay then C.ConfirmModel(chat, usage.model) end
		if type(r.weights) == "table" then C.SaveWeights(r.weights) end
		-- [G2, G4] The Quality of Life step waits for a later UI session than
		-- the first reply's (R.qolHold; spec G4).
		if not ns.db.firstReply then R.qolHold = true end
		ns.db.hudIntro = true
		ns.db.firstReply = true -- [UX-8] the setup checklist
		-- How long it took, from the send it answers (the HUD's "usually ~20 s");
		-- not a pasted reply, whose time is the player's copying.
		local p = chat.pending[1]
		if not replay and not r.pasteKey and p and p.acked and not p.paste and tonumber(p.t) then C.NoteRunTime(time() - tonumber(p.t)) end
	elseif kind == "error" then
		text = ns.SafeText(r.text)
		errEntry = { role = "system", text = text, kind = type(r.kind) == "string" and r.kind or "error", err = true }
		-- [C-31] A line that answers no message (only a BYOK bridge sends
		-- these: answers = "none", a map block that didn't draw) pops nothing, so
		-- the message still running or queued waits for its own answer; it's shown
		-- as a note, and a map line isn't news.
		if r.answers == "none" or errEntry.kind == "map_block" then errEntry.info = true end
		-- [UX-2] The bridge names what the player can do about it (cap
		-- ekind): Okay on every one, and Retry, Send again or "on your desktop".
		if ns.HasCap("ekind") then
			local e = errEntry
			e.action = ERROR_ACTIONS[r.action] and r.action or "none"
			if SEND_AGAIN[e.kind] then e.action = "send_again" end
			-- Where it happened, unless automatic help paused itself (no provider's doing).
			if e.kind ~= "auto_paused" then e.provider, e.model = ns.ProviderName(true), ns.UI.ChatModelName and ns.UI.ChatModelName(chat) or nil end
			e.rid = ns.Str(r.requestId or r.rid, 64)
			-- The model you asked for isn't there: it isn't coming, so it's no longer "asked for".
			if e.kind == "model_not_found" then chat.modelAsked = nil end
		end
		C.AddHistory(chat, errEntry)
	else
		text = ns.SafeText((type(r.text) == "string" and r.text ~= "") and r.text or "Stopped.")
		C.AddHistory(chat, { role = "system", text = text, kind = "aborted" })
	end
	-- An abort after our own /bones stop is the answer to it, not news.
	local asked = kind == "aborted" and R.stopAt[chat.id] ~= nil
	local info = errEntry ~= nil and errEntry.info -- [C-31]
	local nothing = info or (kind == "error" and C.AnswersNothing(chat, r)) -- a stop's answer pops nothing (E-3)
	local answered = not nothing and PopPending(chat, replay, r.pasteKey) or nil
	if errEntry and answered and errEntry.action then errEntry.sendKey = answered.key end -- [UX-2] what Retry sends again
	if kind == "aborted" or not C.IsBusy(chat) then R.stopAt[chat.id] = nil end
	if replay or asked or (errEntry and errEntry.kind == "map_block") then return nil end
	if not ns.UI.IsShowing(chat.id) then chat.unread = chat.unread + 1 end
	-- Automatic help paused itself: said in the held look (gold), not an error's red.
	return { chat = chat.id, kind = kind, text = text, summary = summary, agent = r.agent, drew = drew, held = (errEntry and errEntry.kind == "auto_paused") or nil }
end

-- [UX-2, C-31] The words an error answers, to send again: the message it
-- popped (sendKey), else the last thing you typed before it. nil for a game
-- event's turn, and for a line that answers no message (nothing to send twice).
function C.ResendText(chat, entry)
	if entry and entry.info then return nil end
	local at
	for i = #chat.history, 1, -1 do
		if chat.history[i] == entry then at = i break end
	end
	if not at then return nil end
	local fallback
	for i = at - 1, 1, -1 do
		local e = chat.history[i]
		if e.role == "user" then
			if entry.sendKey and e.key == entry.sendKey then
				if e.event then return nil end
				return e.typed or e.text
			end
			if not fallback then fallback = e end
		end
	end
	if entry.sendKey or not fallback or fallback.event then return nil end
	return fallback.typed or fallback.text
end

-- [UX-2] Okay on an error bubble: it's read, its buttons go (it stays in the chat).
function C.OkayError(chat, entry)
	if not entry or not entry.err then return end
	entry.okay = true
	R.rev[chat.id] = (R.rev[chat.id] or 0) + 1
	if ns.HUD and ns.HUD.DismissChat then ns.HUD.DismissChat(chat.id) end
	ns.Refresh()
end

-- [UX-2] Retry and Send again: the same words, as a new message.
function C.ResendError(chat, entry)
	local text = entry and C.ResendText(chat, entry)
	if not text then return nil end
	local key = C.Send(text, chat.id)
	if key then C.OkayError(chat, entry) end
	return key
end

---------------------------------------------------------------------------
-- Chat management (CS-2 to CS-4)
---------------------------------------------------------------------------

function C.Switch(id)
	local c = C.Find(id)
	if not c then return end
	-- [both:B B-3] (L1-1) A key left in the box isn't kept as a draft; the chat you switch to says so.
	local refused = ns.UI.SaveDraft(true)
	ns.db.activeChat = c.id
	c.unread = 0
	ns.UI.RestoreDraft(c)
	if refused then C.Notice(c, C.KeyRefused()) end
	ns.Refresh("all")
end

-- Chats you made (the Companion chat doesn't count toward the limit).
function C.OwnCount()
	local n = 0
	for _, c in ipairs(ns.db.chats) do
		if c.id ~= ns.COMPANION_CHAT then n = n + 1 end
	end
	return n
end

-- opts.quiet: make it without switching to it (a quick ask's chat).
function C.New(name, opts)
	local db = ns.db
	if C.OwnCount() >= ns.MAX_CHATS then
		C.Notice(C.Active(), ns.Fill("You have {n} chats, the most the window holds. Delete one first: right-click it in the list.", { n = ns.MAX_CHATS }))
		return nil
	end
	name = ns.Trim(name)
	if C.KeyShaped(name) then -- [both:B B-1] (KY-10) never a chat's saved name
		C.RefuseKey()
		return nil
	end
	if name == "" then name = "Chat " .. (#db.chats + 1) end
	local c = ns.NewChatRecord(ns.Utf8Cut(name, ns.NAME_MAX))
	c.lastAt = c.created
	-- The newest chat goes first after the pinned ones (the list is most recent first).
	local at = 1
	while db.chats[at] and db.chats[at].pinned do at = at + 1 end
	table.insert(db.chats, at, c)
	ns.SortChats(db.chats)
	if opts and opts.quiet then ns.Refresh() else C.Switch(c.id) end
	return c
end

function C.Rename(id, name)
	local c = C.Find(id) or C.Active()
	if C.KeyShaped(name) then -- [both:B B-1] (KY-10) before the cut: a key's first 24 characters are still a key's
		C.RefuseKey(c)
		return
	end
	name = ns.Utf8Cut(ns.Trim(name), ns.NAME_MAX)
	if not c or name == "" or name == c.name then return end
	c.name = name
	-- The bridge knows the chat once it has sent something; before that the name
	-- simply rides on the first msg.
	if c.sent then
		local key = ns.Transport.NewKeyed("patch", c.id, { { "cur", ns.db.cursor }, { "label", name } }, "")
		ns.Transport.AfterSend(c.id, "patch", key)
	end
	ns.Refresh("all")
end

-- Pin a chat to the top of the list, or unpin it (on = nil toggles). The pin
-- is kept in the saved data; the newest pin goes on top.
function C.SetPinned(id, on)
	local c = C.Find(id) or C.Active()
	if not c then return nil end
	if on == nil then on = not c.pinned end
	if on then
		ns.db.pinCounter = ns.db.pinCounter + 1
		c.pinned, c.pinOrder = true, ns.db.pinCounter
	else
		c.pinned, c.pinOrder = nil, nil
	end
	ns.SortChats(ns.db.chats)
	ns.Refresh("all")
	return c
end

-- Delete: the bridge archives the session (forget); a chat it never heard of
-- just goes. There is always one chat to type into.
function C.Delete(id)
	local db = ns.db
	local c, idx = C.Find(id)
	if not c then c, idx = C.Active() end
	if not c then return end
	if c.sent then
		local key = ns.Transport.NewKeyed("forget", c.id, { { "cur", db.cursor } }, "")
		ns.Transport.AfterSend(c.id, "forget", key)
	end
	for _, p in ipairs(c.pending) do R.acts[p.key] = nil end
	table.remove(db.chats, idx)
	R.historyBytes = nil -- [code health AD-08] counted again at the next entry
	if #db.chats == 0 then table.insert(db.chats, ns.NewChatRecord("Chat 1")) end
	if db.activeChat == c.id then
		db.activeChat = db.chats[math.min(idx, #db.chats)].id
		local a = C.Active()
		a.unread = 0
		ns.UI.RestoreDraft(a)
	end
	ns.Refresh("all")
end

---------------------------------------------------------------------------
-- Game context and links (upstream's GameContext, SkillLines, ExpandLinks)
---------------------------------------------------------------------------

-- The agent only sees text, so two things about the game are spelled out for
-- it: who is asking (the character and where they are; the hello body, and a
-- msg when it changed), and what the player shift-clicked into the message.
-- Every game API here is optional: whatever the client lacks is left out.

local Try = ns.Try

local function Money(copper)
	copper = tonumber(copper) or 0
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	if g > 0 then return g .. "g " .. s .. "s " .. c .. "c" end
	if s > 0 then return s .. "s " .. c .. "c" end
	return c .. "c"
end

-- Profession and secondary skill lines by skill id (vanilla ids).
local PROFESSION_SKILL_IDS = {
	[164] = true, [165] = true, [171] = true, [182] = true, [186] = true, [197] = true, [202] = true,
	[333] = true, [393] = true, [129] = true, [185] = true, [356] = true,
}

-- The character's skill lines as { name, isHeader, rank, maxRank, skillID }.
-- Forever only has C_SkillInfo (one table per line); the classic globals
-- (multiple returns) are the fallback for other clients.
function C.SkillLines()
	local out = {}
	if type(C_SkillInfo) == "table" and C_SkillInfo.GetNumSkillLines then
		local n = Try(C_SkillInfo.GetNumSkillLines)
		local seen = {}
		for i = 1, (type(n) == "number" and n or 0) do
			local sk = Try(C_SkillInfo.GetSkillLineInfo, i)
			-- Child lines (parentSkillLineID ~= 0) repeat their parent; Blizzard's
			-- skills frame skips them too.
			if type(sk) == "table" and type(sk.name) == "string" and (sk.parentSkillLineID or 0) == 0 then
				local key = sk.isHeader and ("h:" .. sk.name) or (sk.skillID or sk.name)
				if not seen[key] then
					seen[key] = true
					out[#out + 1] = { name = sk.name, isHeader = sk.isHeader, rank = sk.rank, maxRank = sk.maxRank, skillID = sk.skillID }
				end
			end
		end
		return out
	end
	local n = Try(GetNumSkillLines)
	for i = 1, (type(n) == "number" and n or 0) do
		local sname, isHeader, _, rank, _, _, maxRank = Try(GetSkillLineInfo, i)
		if type(sname) == "string" then
			out[#out + 1] = { name = sname, isHeader = isHeader and true or false, rank = rank, maxRank = maxRank }
		end
	end
	return out
end

-- Professions and secondary skills as { name, rank, max } (the game context
-- and the companion's state read the same list).
function C.Professions()
	local header, out = nil, {}
	local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
	for _, sk in ipairs(C.SkillLines()) do
		if sk.isHeader then
			header = sk.name
		elseif (header and wanted[header]) or PROFESSION_SKILL_IDS[sk.skillID] then
			out[#out + 1] = { name = sk.name, rank = sk.rank, max = sk.maxRank }
		end
	end
	return out
end

function C.GameContext()
	local lines = {}
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then game = "World of Warcraft: Forever" end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)

	local name = ns.Readable(Try(UnitName, "player"))
	if name then
		local realm = Try(GetRealmName)
		local level = Try(UnitLevel, "player")
		local race = Try(UnitRace, "player")
		local class = Try(UnitClass, "player")
		local faction = Try(UnitFactionGroup, "player")
		local guild = Try(GetGuildInfo, "player")
		local who = "Character: " .. tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
		local desc = {}
		if level then table.insert(desc, "level " .. tostring(level)) end
		if race then table.insert(desc, tostring(race)) end
		if class then table.insert(desc, tostring(class)) end
		if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
		if faction then who = who .. " (" .. tostring(faction) .. ")" end
		if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
		table.insert(lines, who)
	end

	local zone = Try(GetZoneText)
	local sub = Try(GetSubZoneText)
	if zone and zone ~= "" then
		table.insert(lines, "Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (" - " .. sub) or ""))
	end

	-- Map coordinates, as the minimap shows them (0-100 across the current map;
	-- addons get no world x/y/z). Modern C_Map first, the vanilla call as fallback.
	local x, y, mapName
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" then x, y = pos.x, pos.y end
		local info = Try(C_Map.GetMapInfo, mapId)
		if type(info) == "table" and type(info.name) == "string" then mapName = info.name end
	end
	if not x then
		local px, py = Try(GetPlayerMapPosition, "player")
		if type(px) == "number" and type(py) == "number" then x, y = px, py end
	end
	if x and y and (x > 0 or y > 0) then
		local where = (mapName and mapName ~= zone) and (" on " .. mapName) or ""
		table.insert(lines, string.format("Position: %.1f, %.1f%s%s", x * 100, y * 100, where, mapId and (" (map " .. mapId .. ")") or ""))
	end

	local progress = {}
	local copper = Try(GetMoney)
	if copper then table.insert(progress, "Money: " .. Money(copper)) end
	local xp, xpMax = Try(UnitXP, "player"), Try(UnitXPMax, "player")
	if type(xp) == "number" and type(xpMax) == "number" and xpMax > 0 then
		table.insert(progress, "XP: " .. xp .. "/" .. xpMax)
	end
	if #progress > 0 then table.insert(lines, table.concat(progress, "; ")) end

	-- Classic-style talent tabs: name, icon, points spent.
	local tabs = Try(GetNumTalentTabs)
	if type(tabs) == "number" and tabs > 0 then
		local parts = {}
		for i = 1, tabs do
			local tname, _, points = Try(GetTalentTabInfo, i)
			if type(tname) == "string" and type(points) == "number" then
				table.insert(parts, tname .. " " .. points)
			end
		end
		if #parts > 0 then table.insert(lines, "Talents: " .. table.concat(parts, " / ")) end
	end

	-- Skill lines under the Professions and Secondary Skills headers.
	local parts = {}
	for _, pr in ipairs(C.Professions()) do
		table.insert(parts, pr.name .. (pr.rank and (" " .. tostring(pr.rank) .. (pr.max and ("/" .. tostring(pr.max)) or "")) or ""))
	end
	if #parts > 0 then table.insert(lines, "Professions: " .. table.concat(parts, ", ")) end

	-- Quest log ids (what is accepted, and which are done), so route planning can
	-- skip pickups and turn-ins that no longer apply: every quest in the log
	-- (ns.QuestLog: under a collapsed header too; headers and hidden quests
	-- aren't quests), after its count against the game's cap, so Bones never
	-- takes the list for a cut one. The bridge writes the same line from the
	-- state (context.mjs withState).
	local quests = {}
	local list, meta = ns.QuestLog()
	for _, q in ipairs(list) do table.insert(quests, tostring(q.id) .. (q.complete and "*" or "")) end
	local questLine
	if #quests > 0 or meta.unread > 0 then
		questLine = "Quest log (id, * = ready to turn in): " .. ns.QuestCountPhrase(meta.count, meta.max, meta.unread)
			.. (#quests > 0 and (": " .. table.concat(quests, ",")) or "")
	end

	-- At most CONTEXT_MAX bytes, but the quest line is never cut, nor the Game
	-- and Character lines (the bridge uses a context only with one of them): the
	-- lines between go, whole, from the last. Only a log past any client's cap
	-- (some 110 quests) takes the context over CONTEXT_MAX.
	local s = ns.CleanField(table.concat(lines, "\n"))
	if not questLine then return ns.Utf8Cut(s, ns.CONTEXT_MAX) end
	questLine = ns.CleanField(questLine)
	while #lines > 2 and #s + 1 + #questLine > ns.CONTEXT_MAX do
		table.remove(lines)
		s = ns.CleanField(table.concat(lines, "\n"))
	end
	if #lines <= 2 then s = ns.Utf8Cut(s, math.max(ns.CONTEXT_MAX - 1 - #questLine, math.min(#s, 240))) end
	return s ~= "" and (s .. "\n" .. questLine) or questLine
end

-- The context's lines that the companion's state doesn't carry (PROTOCOL §2.6,
-- cap ctx): the game and client, the character line less its level (race,
-- class, faction, guild) and talents, and the professions when the state left
-- them out (prof false: P.ForSend). The bridge takes the rest from the state,
-- so beside the state a message sends its context only when these changed.
local IN_STATE = { Location = true, Position = true, Money = true, XP = true, Professions = true, ["Quest log (id, * = ready to turn in)"] = true }
local function NotInState(ctx, prof)
	local keep = {}
	for line in (tostring(ctx or "") .. "\n"):gmatch("([^\n]*)\n") do
		local key = line:match("^([^:]*):") or ""
		if not IN_STATE[key] or (key == "Professions" and not prof) then
			if line:find("^Character: ") then line = line:gsub(", level %d+", "") end
			keep[#keep + 1] = line
		end
	end
	return table.concat(keep, "\n")
end

-- Tooltip text without its colour codes, links, textures and atlases: the agent reads
-- plain words, and the bubble doesn't show raw codes. [code health AD-14] By the key
-- check's StripEscapes (below), the one stripper; called when a link is sent, after it loads.
local function PlainTip(s)
	return C.StripEscapes(s)
end

-- A link's tooltip, one line per row: the game's own tooltip data
-- (C_TooltipInfo.GetHyperlink), before any frame or addon post-call touches
-- it. Never a rendered tooltip frame: another addon's post-call adds its lines
-- to every one (a bag tracker's naming an alt went out with a linked item,
-- CV-03). A client without that data: no lines, only what the link is.
local function TooltipLines(payload)
	local lines = {}
	local get = type(C_TooltipInfo) == "table" and C_TooltipInfo.GetHyperlink
	local ok, data = false, nil
	if type(get) == "function" then ok, data = pcall(get, payload) end
	if not ok or type(data) ~= "table" or type(data.lines) ~= "table" then return lines end
	for i = 1, math.min(#data.lines, LINK_LINES_MAX) do
		local line = data.lines[i]
		if type(line) == "table" then
			-- Older clients keep the words in args until TooltipUtil surfaces them.
			if line.leftText == nil and line.args and TooltipUtil and TooltipUtil.SurfaceArgs then pcall(TooltipUtil.SurfaceArgs, line) end
			local l = ns.Trim(PlainTip(type(line.leftText) == "string" and line.leftText or ""))
			local r = ns.Trim(PlainTip(type(line.rightText) == "string" and line.rightText or ""))
			if r ~= "" then l = l .. "  " .. r end
			if l ~= "" then table.insert(lines, l) end
		end
	end
	return lines
end

-- What a link is, in words: "item 2140 (Uncommon)", "spell 1978", "quest 176".
local function DescribeLink(payload)
	local kind, id = payload:match("^(%a+):(%d+)")
	if not kind then return payload:match("^(%a+)") or "link" end
	local s = kind .. " " .. id
	if kind == "item" then
		local _, _, quality = Try((C_Item and C_Item.GetItemInfo) or GetItemInfo, payload)
		local desc = type(quality) == "number" and _G["ITEM_QUALITY" .. quality .. "_DESC"]
		if desc then s = s .. " (" .. desc .. ")" end
	end
	return s
end

-- Where an item goes: inventory slots by itemEquipLoc (companion F5). Rings,
-- trinkets and one-hand weapons have two candidates.
local EQUIP_SLOTS = {
	INVTYPE_HEAD = { 1 }, INVTYPE_NECK = { 2 }, INVTYPE_SHOULDER = { 3 }, INVTYPE_BODY = { 4 },
	INVTYPE_CHEST = { 5 }, INVTYPE_ROBE = { 5 }, INVTYPE_WAIST = { 6 }, INVTYPE_LEGS = { 7 },
	INVTYPE_FEET = { 8 }, INVTYPE_WRIST = { 9 }, INVTYPE_HAND = { 10 }, INVTYPE_FINGER = { 11, 12 },
	INVTYPE_TRINKET = { 13, 14 }, INVTYPE_CLOAK = { 15 }, INVTYPE_WEAPON = { 16, 17 },
	INVTYPE_2HWEAPON = { 16, 17 }, -- a two-hander replaces the off hand too
	INVTYPE_WEAPONMAINHAND = { 16 }, INVTYPE_WEAPONOFFHAND = { 17 },
	INVTYPE_SHIELD = { 17 }, INVTYPE_HOLDABLE = { 17 }, INVTYPE_RANGED = { 18 }, INVTYPE_RANGEDRIGHT = { 18 },
	INVTYPE_THROWN = { 18 }, INVTYPE_RELIC = { 18 }, INVTYPE_TABARD = { 19 },
}
local SLOT_NAMES = { "head", "neck", "shoulder", "shirt", "chest", "waist", "legs", "feet", "wrist", "hands",
	"finger 1", "finger 2", "trinket 1", "trinket 2", "back", "main hand", "off hand", "ranged", "tabard" }
local EQUIPPED_TIP_MAX = 600 -- bytes of an equipped item's tooltip (F5)
C.EQUIP_SLOTS = EQUIP_SLOTS

-- What's worn where a linked item would go, for "is this an upgrade?" (F5).
-- level 0: name, id, item level and tooltip; 1: no tooltip; 2: id and item level only.
local function EquippedBlocks(payload, level)
	if not payload:match("^item:%d+") then return {} end
	local getInstant = C_Item and C_Item.GetItemInfoInstant
	local _, _, _, equipLoc = Try(getInstant, payload)
	local slots = type(equipLoc) == "string" and EQUIP_SLOTS[equipLoc]
	if not slots then return {} end
	local out = {}
	for _, slot in ipairs(slots) do
		local link = Try(GetInventoryItemLink, "player", slot)
		local id = Try(GetInventoryItemID, "player", slot)
		if type(link) == "string" or type(id) == "number" then
			local name = type(link) == "string" and link:match("|h%[([^%]]*)%]|h") or nil
			id = id or (type(link) == "string" and tonumber(link:match("item:(%d+)")))
			local ilvl = ns.Companion and ns.Companion.Call("ItemLevel", slot, link)
			local parts = {}
			if level < 2 and name then parts[#parts + 1] = name end
			if id then parts[#parts + 1] = "item " .. ns.Int(id) end
			if ilvl then parts[#parts + 1] = "item level " .. ns.Int(ilvl) end
			local block = "[Equipped: " .. SLOT_NAMES[slot] .. "] " .. table.concat(parts, ", ")
			if level == 0 and type(link) == "string" then
				local lp = link:match("|H(item:[^|]+)|h")
				local tip = lp and table.concat(TooltipLines(lp), "\n  ") or ""
				if tip ~= "" then
					if #tip > EQUIPPED_TIP_MAX then tip = ns.Utf8Cut(tip, EQUIPPED_TIP_MAX) .. "..." end
					block = block .. "\n  " .. tip
				end
			end
			out[#out + 1] = block
		end
	end
	return out
end

-- Turn the links in a message into text the agent can use: each becomes [Name]
-- in place, and a block at the end lists what the tooltip says about it, and,
-- for an item you could wear, what you're wearing there (F5). level trims the
-- equipped part to fit (see EquippedBlocks). Returns the new text and the
-- number of links found.
function C.ExpandLinks(text, level)
	level = level or 0
	local links, seen = {}, {}
	local function Take(payload, name)
		if not seen[payload] then
			seen[payload] = true
			table.insert(links, { payload = payload, name = name })
		end
		return "[" .. name .. "]"
	end
	-- Coloured links first (|cAARRGGBB or the client's |cnIQ1: colour, then |H...|h[Name]|h|r), then bare ones.
	local out = text:gsub("|c%x%x%x%x%x%x%x%x|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|cn[^:|]*:|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|H([^|]+)|h%[([^%]]*)%]|h", Take)
	if #links == 0 then return text, 0 end
	local blocks = {}
	for _, l in ipairs(links) do
		local head = "[" .. l.name .. "] " .. DescribeLink(l.payload)
		local body = table.concat(TooltipLines(l.payload), "\n  ")
		local block = body ~= "" and (head .. "\n  " .. body) or head
		if #block > LINK_BYTES_MAX then block = ns.Utf8Cut(block, LINK_BYTES_MAX) .. "..." end
		table.insert(blocks, block)
		-- The compare is extra: if the client answers something unexpected, the message goes without it.
		local ok, eqs = pcall(EquippedBlocks, l.payload, level)
		for _, eq in ipairs(ok and eqs or {}) do table.insert(blocks, eq) end
	end
	return out .. "\n\n--- Linked from the game ---\n" .. table.concat(blocks, "\n"), #links
end


---------------------------------------------------------------------------
-- Sending (SE-1 to SE-4, SE-6, SE-7, SE-9)
---------------------------------------------------------------------------

-- First few words of a message, as a chat title (upstream).
local function AutoTitle(text)
	local words = {}
	for w in tostring(text or ""):gmatch("%S+") do
		w = w:gsub("^[%p]+", ""):gsub("[%p]+$", "")
		if w ~= "" then
			table.insert(words, w)
			if #words >= 5 then break end
		end
	end
	local title = table.concat(words, " ")
	if #title > ns.NAME_MAX then title = ns.Utf8Cut(title, ns.NAME_MAX):gsub("%s+%S*$", "") end
	if title == "" then return nil end
	return title:sub(1, 1):upper() .. title:sub(2)
end

-- [both:B B-1] (KY-10) Text shaped like a provider's API key is never sent or
-- saved. The block below is generated from the bridge's own check (it checks
-- again), so the two can't drift; tests/byok/addon_security_test.js compares them.
-- KY-10: generated from bridge/byok/security/keycheck.mjs (KEY_SHAPES, GLUED_SHAPES); do not edit by hand.
local KEY_PATTERNS = {
	"%f[%w]sk%-ant%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"%f[%w]sk%-proj%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"%f[%w]sk%-svcacct%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"%f[%w]sk%-admin%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"%f[%w]sk%-None%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"%f[%w]sk%-or%-[%w%-][%w%-][%w%-][%w%-][%w%-][%w%-][%w%-][%w%-][%w%-][%w%-]",
	"%f[%w]sk%-%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w",
	"%f[%w]AIza[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"%f[%w]AQ%.[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"%f[%w]xai%-[%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_]",
	"%f[%w]gsk_%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w",
	"sk%-ant%-api[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"sk%-ant%-admin[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"sk%-ant%-oat[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"sk%-or%-v1%-%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w",
	"AIza[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]",
	"gsk_%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w%w",
}
-- Glued shapes that also need a digit in the run after the prefix: { pattern, prefix length }.
local KEY_DIGIT_PATTERNS = {
	{ "sk%-proj%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]*", 8 },
	{ "sk%-svcacct%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]*", 11 },
	{ "sk%-admin%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]*", 9 },
	{ "sk%-None%-[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]*", 8 },
	{ "AQ%.[%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-][%w_%-]*", 3 },
	{ "xai%-[%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_][%w_]*", 4 },
}
C.LooksLikeKey = function(s)
	if type(s) ~= "string" or #s < 13 then return false end
	for i = 1, #KEY_PATTERNS do
		if string.find(s, KEY_PATTERNS[i]) then return true end
	end
	for i = 1, #KEY_DIGIT_PATTERNS do
		local p, n, init = KEY_DIGIT_PATTERNS[i][1], KEY_DIGIT_PATTERNS[i][2], 1
		while true do
			local a, b = string.find(s, p, init)
			if not a then break end
			if string.find(string.sub(s, a + n, b), "%d") then return true end
			init = a + 1
		end
	end
	return false
end
C.KEY_REFUSED = "That looks like an API key, so it wasn't sent. Keys go in the NeverQuestAlone app, never in game." -- the bridge's own refusal, word for word (HOW-IT-WORKS.md quotes it; UX-W08)
-- [both:B B-4] (L5-2) KY-10: what can hide inside a pasted key,
-- generated with the bridge's typedLooksLikeKey; tests compare them.
-- KY-10: generated from bridge/byok/runtime/sanitize.mjs (typedLooksLikeKey); do not edit by hand.
local KEY_HIDDEN = {
	{0x0, 0x8}, {0xB, 0xC}, {0xE, 0x1F}, {0x7F, 0x9F}, {0xAD, 0xAD}, {0x34F, 0x34F},
	{0x600, 0x605}, {0x61C, 0x61C}, {0x6DD, 0x6DD}, {0x70F, 0x70F}, {0x890, 0x891}, {0x8E2, 0x8E2},
	{0x115F, 0x1160}, {0x17B4, 0x17B5}, {0x180B, 0x180F}, {0x200B, 0x200F}, {0x202A, 0x202E}, {0x2060, 0x206F},
	{0x3164, 0x3164}, {0xD800, 0xDFFF}, {0xFE00, 0xFE0F}, {0xFEFF, 0xFEFF}, {0xFFA0, 0xFFA0}, {0xFFF0, 0xFFFB},
	{0x110BD, 0x110BD}, {0x110CD, 0x110CD}, {0x13430, 0x1343F}, {0x1BCA0, 0x1BCA3}, {0x1D173, 0x1D17A}, {0xE0000, 0xE0FFF},
}
local KEY_SPACES = {
	{0xA0, 0xA0}, {0x1680, 0x1680}, {0x2000, 0x200A}, {0x202F, 0x202F}, {0x205F, 0x205F}, {0x3000, 0x3000},
}
local function KeyIn(ranges, cp)
	local lo, hi = 1, #ranges
	while lo <= hi do
		local mid = math.floor((lo + hi) / 2)
		if cp < ranges[mid][1] then hi = mid - 1
		elseif cp > ranges[mid][2] then lo = mid + 1
		else return true end
	end
	return false
end
local function KeyDrop(s, ranges)
	s = string.gsub(s, "%c", function(c) if KeyIn(ranges, string.byte(c)) then return "" end end)
	if not string.find(s, "[\128-\255]") then return s end
	return (string.gsub(s, "[\192-\247][\128-\191]*", function(c)
		local n, b = #c, string.byte(c)
		local cp, min
		if n == 2 and b < 224 then cp, min = b % 32, 128
		elseif n == 3 and b >= 224 and b < 240 then cp, min = b % 16, 2048
		elseif n == 4 and b >= 240 then cp, min = b % 8, 65536
		else return nil end
		for i = 2, n do cp = cp * 64 + string.byte(c, i) % 64 end
		if cp >= min and cp <= 1114111 and KeyIn(ranges, cp) then return "" end
	end))
end
C.Visible = function(s)
	return (string.gsub(KeyDrop(tostring(s or ""), KEY_HIDDEN), "\226\128[\168\169]", "\n"))
end
C.StripEscapes = function(s)
	s = tostring(s or "")
	if not string.find(s, "|", 1, true) then return s end
	s = string.gsub(s, "|c%x%x%x%x%x%x%x%x", "")
	s = string.gsub(s, "|cn[^:|]*:", "")
	s = string.gsub(s, "|r", "")
	s = string.gsub(s, "|H[^|]*|h([^\r\n]-)|h", "%1")
	s = string.gsub(s, "|T[^|]*|t", "")
	s = string.gsub(s, "|A[^|]*|a", "")
	return s
end
C.KeyShaped = function(s)
	if type(s) ~= "string" then return false end
	if C.LooksLikeKey(s) then return true end
	local v = C.Visible(s)
	return C.LooksLikeKey(v) or C.LooksLikeKey(KeyDrop(C.StripEscapes(v), KEY_SPACES))
end

-- The refusal as the player reads it, where keys do go (C.KEY_REFUSED).
function C.KeyRefused()
	return C.KEY_REFUSED
end

-- Says a key-shaped line was refused: in the window when it's open, else on
-- the game's error line (a command, the HUD's box, /bones with the window shut).
function C.RefuseKey(chat)
	chat = chat or C.Active()
	if chat and ns.UI and ns.UI.IsOpen() then C.Notice(chat, C.KeyRefused()) else ns.Notify.Game(C.KeyRefused(), true) end
end

-- Send text to a chat (the active one by default). Returns the key, or nil,
-- a reason, and "key" when it was refused as an API key (the box you typed
-- it in is cleared, so no draft keeps it).
-- opts.skipGameData (or the composer's toggle, R.skipGameData) sends this one
-- message without the game context and the companion's state.
function C.Send(text, chatId, opts)
	local db = ns.db
	if not db or not R.nonce then return nil, "Not ready yet: try again in a moment." end -- before PLAYER_LOGIN
	local chat = (chatId and C.Find(chatId)) or C.Active()
	if not chat then return nil, "There's no chat to send it to." end
	text = ns.Trim(text)
	if text == "" then return nil, "There's nothing to send." end
	-- [both:B B-1] (KY-10) Before anything keeps it: no history, no outbox, no draft; invisible characters or not (L5-2).
	if C.KeyShaped(text) then
		chat.draft = nil
		C.Notice(chat, C.KeyRefused())
		return nil, C.KeyRefused(), "key"
	end
	-- "[NeverQuestAlone" starts only what the addon and bridge write (game events), so
	-- typed text can't pass for one (TB5).
	if text:find("^%[[Nn][Ee][Vv][Ee][Rr][Qq][Uu][Ee][Ss][Tt][Aa][Ll][Oo][Nn][Ee]") then
		C.Notice(chat, "Not sent: a message can't start with \"[NeverQuestAlone\". The addon keeps that for its own lines.")
		return nil, "It can't start with \"[NeverQuestAlone\"."
	end
	-- Linked items with what's equipped there; past 2,900 bytes the equipped
	-- tooltips go first, then the equipped names (F5).
	local raw, links = text, 0
	for level = 0, 2 do
		text, links = C.ExpandLinks(raw, level)
		if #text <= ns.MAX_TEXT then break end
	end
	if text:find("^%[[Nn][Ee][Vv][Ee][Rr][Qq][Uu][Ee][Ss][Tt][Aa][Ll][Oo][Nn][Ee]") then -- a link named like one, now expanded
		C.Notice(chat, "Not sent: a message can't start with \"[NeverQuestAlone\". The addon keeps that for its own lines.")
		return nil, "It can't start with \"[NeverQuestAlone\"."
	end
	if #text > ns.MAX_TEXT then
		C.Notice(chat, links > 0 and "That message is too long to send: each linked item adds its tooltip's text. Split it into shorter messages."
			or "That message is too long to send. Split it into shorter messages.")
		return nil, "Too long: split it into shorter messages."
	end
	if not chat.sent and chat.name:match("^Chat %d+$") then chat.name = AutoTitle(text) or chat.name end
	local wasBusy = C.IsBusy(chat)
	-- bare: this message goes without game data (the composer's Game data tick,
	-- unticked): no context, no st=, and bare=1 so the bridge adds neither its
	-- stored context nor the data block (PROTOCOL §2.4).
	local skip = (opts and opts.skipGameData) and true or false
	-- With no NeverQuestAlone app yet (or Copy and Paste picked in Settings), the
	-- message waits in the Copy and Paste window for the player's AI (Paste.lua).
	if ns.Paste and ns.Paste.On() then return ns.Paste.Send(chat, text, raw, skip, wasBusy) end
	-- [code health BR-02, the addon half] A full outbox takes no more typed messages, so a
	-- macro or a loop can't pile up paid ones for the reload path (Transport.TYPED_MAX).
	-- With Screen Reading on they go as the app reads them; else they wait for a reload,
	-- counted as the banner above the window counts them (U.BannerText).
	if ns.Transport.TypedWaiting() >= ns.Transport.TYPED_MAX then
		if ns.Transport.StripOut() then
			local n = ns.Transport.TypedWaiting()
			C.Notice(chat, ns.Plural(n, "Not sent: 1 message is still sending. Send your message again once that one's gone out.",
				"Not sent: {n} messages are still sending. Send your message again once they've gone out."))
			return nil, ns.Plural(n, "1 message is still sending. Send yours again soon.", "{n} messages are still sending. Send yours again soon.")
		end
		C.Notice(chat, ns.Plural(ns.Transport.OutboxDepth(), "Not sent: 1 message waits for a reload to go out. Click Reload above the window to send that one.",
			"Not sent: {n} messages wait for a reload to go out. Click Reload above the window to send them."))
		return nil, "Reload to send the others first."
	end
	-- The companion's state goes beside it, and st= names it (companion F1).
	-- stCarries: the bridge takes the game context from that state (cap ctx);
	-- stProf: that state carries the professions too.
	local st, stCarries, stProf
	-- One read of the quest log for this send: the state and the context share it (ns.QuestLog).
	R.questShare = { at = GetTime() }
	if not skip and ns.Companion then st, stCarries, stProf = ns.Companion.Call("ForSend") end
	-- [G2] Say hi's "hi" (the HUD's setup block, the checklist's chip,
	-- /bones hi) tells the bridge it's the first meeting, until a reply came.
	local intro = opts and opts.intro and not db.firstReply
	local function Args(ctxFlag)
		local a = { { "cur", db.cursor }, { "agent", chat.agent }, { "name", chat.name }, { "ctx", ctxFlag }, { "q", "followup" } }
		if intro then a[#a + 1] = { "intro", 1 } end
		if st then a[#a + 1] = { "st", st } end
		if skip then a[#a + 1] = { "bare", 1 } end
		return a
	end
	local args, body = Args(0), ns.CleanField(text)
	-- The game context rides along when the bridge doesn't have this version yet
	-- (an empty one turns it off there), and only if the record still fits one
	-- frame; otherwise a later message carries it. Beside a state the bridge takes
	-- it from (cap ctx), it stays out, some 430 bytes (5 or 6 strip rows), unless a line
	-- the state doesn't carry changed, or the state won't reach the bridge in this
	-- message's frame (PROTOCOL §2.6).
	-- A bare message reads none of it (nor the quest log).
	local ctx = (not skip and db.settings.context) and C.GameContext() or ""
	R.questShare = nil
	if not skip and ctx ~= (R.contextSent or "") then
		local nextKey = R.nonce .. "_" .. ns.Int(db.sendCounter + 1)
		local inState = stCarries and ctx ~= "" and NotInState(ctx, stProf) == NotInState(R.contextSent, stProf)
			and ns.Transport.StateFitsWith(ns.Transport.Record(nextKey, "msg", chat.id, args, body))
		local withArgs, withBody = Args(1), ns.CleanField(ctx) .. ns.GS .. body
		if not inState and #ns.Transport.Record(nextKey, "msg", chat.id, withArgs, withBody) <= ns.MAX_PAYLOAD then
			args, body = withArgs, withBody
			R.contextSent = ctx
		end
	end
	local key = ns.Transport.NewKeyed("msg", chat.id, args, body)
	if not key then
		-- No app has answered this install, and Copy and Paste (Paste.lua)
		-- isn't loaded: a /reload after an update runs the old file list.
		C.Notice(chat, "Restart WoW to finish updating the addon; your message wasn't sent.")
		return nil, "Restart WoW to finish updating the addon."
	end
	chat.sent = true
	table.insert(chat.pending, { key = key, t = time() })
	-- typed: the words as typed, links and all, when expanding them changed the text (Up recalls it).
	C.AddHistory(chat, { role = "user", text = text, typed = raw ~= text and raw or nil, key = key, queued = wasBusy or nil, bare = skip or nil })
	ns.Transport.AfterSend(chat.id, "msg", key)
	return key
end

-- /bones stop and the Stop button: abort the chat's current run (SE-9).
function C.Stop(chatId)
	local chat = (chatId and C.Find(chatId)) or C.Active()
	if not chat then return nil end
	if ns.Paste and ns.Paste.Waiting(chat) then return ns.Paste.Stop(chat) end
	if not chat.sent then
		C.Notice(chat, "Nothing to stop: this chat hasn't sent anything yet.")
		return nil
	end
	-- One stop at a time: a second click while the first is on its way sends nothing.
	if R.stopAt[chat.id] and C.IsBusy(chat) and GetTime() - R.stopAt[chat.id] < 60 then return nil end
	local key = ns.Transport.NewKeyed("stop", chat.id, { { "cur", ns.db.cursor } }, "")
	if not key then return nil end -- no app to tell
	R.stopAt[chat.id] = GetTime()
	if not C.IsBusy(chat) then C.Notice(chat, ns.P("Asked NeverQuestAlone to stop.")) end -- [UX-5]
	ns.Transport.AfterSend(chat.id, "stop", key)
	return key
end
