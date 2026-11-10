-- Commands.lua: /nqa (and /bones, its silent alias), /br, and the addon's start-up. -- [UX-6]
--
-- /bones <text> sends; a word that is a command runs only when the rest of
-- the line fits that command, so "delete the unused imports" is a message and
-- "delete" deletes (upstream's COMMAND_ARGS). Upstream's /r capture is gone for good: it replaced
-- Blizzard edit-box methods and tainted /cast. /br and the "Bones: open and
-- type" key binding replace it.

local _, ns = ...
local R = ns.R

-- /bones help: only what a player might type (maintainer, 2026-09-27: "the user
-- really shouldn't have to use them often"). Everything else is a click in the
-- window, the HUD or Settings, and every command is in /bones help all.
local HELP = table.concat({
	"/nqa  Open or close the window",
	"/nqa <message>  Ask anything",
	"/br <message>  Reply to your latest notification",
	"/nqa settings  Open Settings to turn off Screen Reading",
	"/nqa mode reload  Hold messages and replies for a reload",
	"/nqa help all  Show every command",
}, "\n")
-- With no app yet (Copy and Paste), screen reading means nothing: the way
-- back to a waiting message and the app's link stand in for it.
local HELP_PASTE = table.concat({
	"/nqa  Open or close the window",
	"/nqa <message>  Ask anything",
	"/br <message>  Reply to your latest notification",
	"/nqa paste  Open Copy and Paste again",
	"/nqa app  Show the link to download the NeverQuestAlone app",
	"/nqa help all  Show every command",
}, "\n")

-- [G3, UX-W09] The public build's /bones help opens with "Getting around",
-- main's Welcome in the product's voice (the setup block shows in the Welcome's
-- place, so its lessons live here), then main's short list.
local GETTING_AROUND = "Getting around:\nClick Ask to ask anything, or click the portrait for all your chats. Drag the HUD's title to move it; the – at its right minimizes it, and the X closes it. Click a part of a route's bar to go to that stop. Ctrl+right-click the world map to ask about a spot; right-click a quest in your log to ask about it."

-- [C-05, UX-W09, PUI-22] /bones help all: every command, one line each, in
-- the order a player meets them; each fits one line of the window at its
-- default size (a test). Hidden aliases (chats, hud min, options, config, ?)
-- stay out, as do /bones update (the app keeps the addon up to date) and the
-- diagnostics but /bones diag.
local HELP_ALL = table.concat({
	"Every command. Most are also a click in a menu or Settings.",
	"/nqa  Open or close the window",
	"/nqa <message>  Ask anything",
	"/br <message>  Reply to your latest notification",
	"/nqa new [name]  Start a new chat",
	"/nqa chat [number or name]  Switch to a chat, or list them",
	"/nqa rename [name]  Rename this chat",
	"/nqa delete  Delete this chat, after you confirm",
	"/nqa pin|unpin [chat]  Pin a chat to the top, or unpin it",
	"/nqa stop  Stop work on this chat's message",
	"/nqa paste  Open Copy and Paste again",
	"/nqa replies auto|paste  Pick how replies come",
	"/nqa app  Show the link to download the NeverQuestAlone app",
	"/nqa copy  Open the last reply to copy it",
	"/nqa think [level|default]  Set Thinking",
	"/nqa model [id]  Show or change this chat's model",
	"/nqa ask next  Ask what to do next",
	"/nqa ask target  Ask about your target",
	"/nqa ask item  Ask about the hovered item",
	"/nqa settings  Open Settings",
	"/nqa qol  Open Quality of Life in Settings",
	"/nqa qol on|off  Turn Quality of Life options on or off",
	"/nqa qol last  Show what Quality of Life did lately",
	"/nqa usage  Show today's spend and messages",
	"/nqa cost on|off  Show or hide what each reply costs",
	"/nqa setup  Show the setup checklist",
	"/nqa help  Show the short list of commands",
	"/nqa hud on|off  Show or hide the HUD",
	"/nqa hud full|bar|compass  Pick the HUD's form",
	"/nqa hud reset  Put the HUD back where it started",
	"/nqa window reset  Put the window back where it started",
	"/nqa echo summary|full|short|off  Set chat frame replies",
	"/nqa speak on|off|stop  Read reply summaries aloud",
	"/nqa live on|off  Keep game data current between messages",
	"/nqa voice talk|tip|mute|pause  Control the voice",
	"/nqa voice persona [name]  Pick who speaks",
	"/nqa voice read on|off  The voice reads replies aloud",
	"/nqa voice bar on|off  Show or hide the voice bar",
	"/nqa context [on|off]  Show game data, or turn it on or off",
	"/nqa companion  List the kinds of check-in",
	"/nqa companion on|off  Turn all check-ins on or off",
	"/nqa companion <kind> on|off  Turn one kind on or off",
	"/nqa dnd combat on|off  Turn Quiet in Combat on or off",
	"/nqa text small|medium|large|xlarge  Set the text size", -- one drawn line with xlarge (454 units)
	"/nqa waypoint on|off  Show the next stop as a waypoint",
	"/nqa tooltips on|off  Show upgrade verdicts on items",
	"/nqa quips on|off  Show one-liners when you die",
	"/nqa map  List your routes, marks and map commands",
	"/nqa roll  Pick a quest here and set a waypoint",
	"/nqa reading on|off  Turn Screen Reading on or off",
	"/nqa mode reload  Hold messages and replies for a reload",
	"/nqa mode pixel  Go back to screen reading",
	"/nqa reload  Reload the interface now",
	"/nqa diag  Show diagnostics for a bug report",
	"/nqa perf  Show the addon's memory and frame time", -- [SY-27]
	"Keys: click the window's portrait, then Bind Keys.",
	"Start a message in the window with / to run a command: /new.",
}, "\n")

-- A help list as the window shows it: each "/command  what it does" line
-- with its command in gold, as the game's own /help colours them; every
-- other line as it is. Escaped, so "reload|pixel" shows its |.
local function HelpShown(text)
	local out = {}
	for line in (text .. "\n"):gmatch("(.-)\n") do
		local cmd, what = line:match("^(/.-)  (.*)$")
		out[#out + 1] = cmd and ("|cffffd100" .. ns.Escape(cmd) .. "|r  " .. ns.Escape(what)) or ns.Escape(line)
	end
	return table.concat(out, "\n")
end

local ONOFF = { [""] = true, on = true, off = true }

local function ChatArgument(rest)
	if rest == "" or tonumber(rest) or not rest:find("%s") then return true end
	for _, c in ipairs(ns.db.chats) do
		if c.name:lower() == rest:lower() then return true end
	end
	return false
end

-- ore, herb and filter were upstream's node pins' (gone, code health AD-19): still commands,
-- so they never go to Bones as a message; /bones map answers with what it has.
local MAP_WORDS = { ore = ONOFF, herb = ONOFF, minimap = ONOFF, filter = { all = true, skill = true }, next = { [""] = true }, prev = { [""] = true }, stop = { [""] = true } }

local function MapArgument(rest)
	if rest == "" then return true end
	local word, arg = rest:match("^(%S+)%s*(.-)$")
	word = word:lower()
	if MAP_WORDS[word] then return MAP_WORDS[word][arg:lower()] == true end
	if word == "show" or word == "hide" then return arg ~= "" and not arg:find("%s") end
	if word == "nav" then return arg == "" or arg:match("^%S+%s*%d*$") ~= nil end
	return false
end

local function DndArgument(rest)
	if rest == "" then return true end
	local what, v = rest:lower():match("^(%a+)%s*(%a*)$")
	return (what == "combat" or what == "instance" or what == "boss") and ONOFF[v] == true
end

local COMMAND_ARGS = {
	help = { [""] = true, all = true }, ["?"] = 0, slots = 0, probe = 0, delete = 0, stop = 0, reload = 0, copy = 0, state = 0, apicheck = 0,
	diag = { [""] = true, full = true }, -- [UX-7] /bones diag full: the install token too
	new = true, rename = true, chat = ChatArgument, chats = ChatArgument, pin = ChatArgument, unpin = ChatArgument,
	echo = { [""] = true, summary = true, full = true, short = true, off = true },
	speak = { [""] = true, on = true, off = true, stop = true }, live = ONOFF,
	voice = true, -- talk|mute|unmute|pause|resume|persona <name> (Companion.VoiceSlash checks it)
	context = ONOFF, dnd = DndArgument, map = MapArgument,
	stream = ONOFF, reading = ONOFF, mode = { [""] = true, reload = true, pixel = true }, window = { reset = true },
	paste = 0, replies = { [""] = true, auto = true, paste = true }, app = 0,
	companion = function(rest)
		local w, v = rest:lower():match("^(%S*)%s*(%S*)$")
		if w == "" or ((w == "on" or w == "off") and v == "") then return true end
		return ns.Companion ~= nil and ns.Companion.WORDS[w] ~= nil and (v == "on" or v == "off")
	end,
	think = { [""] = true, off = true, minimal = true, low = true, medium = true, high = true, xhigh = true, max = true, default = true },
	ask = { next = true, target = true, item = true },
	hud = { [""] = true, on = true, off = true, reset = true, min = true, bar = true, compass = true, full = true }, -- bar: the form's name (min stays)
	update = { [""] = true, install = true },
	text = { [""] = true, small = true, medium = true, large = true, xlarge = true }, -- Extra Large
	waypoint = ONOFF, tooltips = ONOFF, quips = ONOFF, roll = 0, settings = 0, options = 0, config = 0, -- options, config: other addons' words for settings
	qol = { [""] = true, on = true, off = true, last = true },
	-- [UX-3, UX-6, UX-8] Commands even before the app has answered (C-01).
	perf = 0, -- [SY-27] /bones perf
	usage = 0, cost = ONOFF, setup = 0, model = 1,
}

local function IsCommand(cmd, rest)
	local spec = COMMAND_ARGS[cmd]
	if spec == nil then return false end
	if spec == true then return true end
	if spec == 0 then return rest == "" end
	if spec == 1 then return not rest:find("%s") end
	if type(spec) == "table" then return spec[rest:lower()] == true end
	return spec(rest) == true
end

-- [SY-27] /bones perf: the addon's memory and frame time in two lines, for
-- a performance check (the PRD's B0.5 and B3.8: WoW's frame time within 2% of
-- itself with the app on). Nothing is measured until it's typed: the game's own
-- addon profiler when it has one, at once; else the addon's own busiest parts
-- (its 0.25 s checks and what it draws for screen reading) for PERF_SECONDS.
local PERF_SECONDS = 5
local function PerfLines(avg, peak, own)
	local kb = ns.Transport.MemoryKB()
	local size = kb and (kb >= 1024 and string.format("%.1f MB", kb / 1024) or string.format("%d KB", math.floor(kb + 0.5)))
	local ms = function(v) return string.format("%.2f", v) end
	local frame
	if not avg then
		frame = "The game can't time the addon here."
	elseif own then
		-- {n}: seconds measured; {avg}, {peak}: ms
		frame = ns.Fill("Over {n} seconds, its checks and what it draws for screen reading took {avg} ms a frame on average, and {peak} ms at most.", { n = PERF_SECONDS, avg = ms(avg), peak = ms(peak or avg) })
	elseif peak then
		-- {avg}, {peak}: ms
		frame = ns.Fill("It takes {avg} ms a frame on average, and {peak} ms at most.", { avg = ms(avg), peak = ms(peak) })
	else
		frame = ns.Fill("It takes {avg} ms a frame on average.", { avg = ms(avg) })
	end
	return (size and ns.Fill("The addon uses {size} of memory.", { size = size }) or "The game doesn't say how much memory the addon uses.") .. "\n" .. frame
end
local function Perf(chat)
	local avg, peak = ns.Transport.ProfilerMs()
	if avg then
		ns.Chats.Notice(chat, PerfLines(avg, peak, false))
		ns.UI.Toggle(true)
		return
	end
	local started = ns.Transport.PerfStart(PERF_SECONDS, function(a, p)
		ns.Chats.Notice(chat, PerfLines(a, p, true))
		ns.UI.Toggle(true)
	end)
	if not started and not R.perf then
		ns.Chats.Notice(chat, PerfLines(nil))
		ns.UI.Toggle(true)
	end
end

local function Ago(t)
	return t and (ns.FmtDur(GetTime() - t) .. " ago") or "never this session"
end

-- SD-2: what /bones diag reports. [UX-7] The install token is hidden
-- unless you ask for all of it (/bones diag full): the lines get copied and
-- shared.
local function DiagLines(full)
	local T, db = ns.Transport, ns.db
	local lines = {}
	local function Add(s) lines[#lines + 1] = s end
	local version, build, _, toc = ns.Try(GetBuildInfo)
	Add(string.format("NeverQuestAlone addon %s, protocol v%d; client %s.%s (interface %s)", ns.VERSION, ns.PROTOCOL, tostring(version or "?"), tostring(build or "?"), tostring(toc or "?"))) -- [C-04]
	if ns.Companion then
		local caps = ns.Companion.Call("Caps") or {}
		local c = db.companion or {}
		-- [C-05] the desktop app's switch (public build)
		local on = c.on == false and "off" or ((ns.Companion.Call("DesktopOn") == false) and "off on the desktop")
			or (ns.Companion.Call("AutoPaused") == true and "paused by the runaway fuse until the next typed message") or "on"
		Add(string.format("Companion: %s; caps %s; state seq %s, %s has %s%s", on, -- [C-05]
			(caps.state and caps.evt) and ("state+evt" .. (caps.z and "+z" or "") .. (caps.ctx and "+ctx" or "")) or "none", ns.Int(c.seq or 0), ns.Product(), R.bridgeStateSeq and ns.Int(R.bridgeStateSeq) or "none",
			R.companionError and ("; last error in " .. R.companionError.where .. ": " .. ns.Escape(ns.Utf8Cut(R.companionError.text, 120))) or ""))
	end
	Add("Mode: " .. T.ModeLabel() .. (T.SlotOnly() and "; slot-only (doorbells unavailable)" or "; doorbells on"))
	Add("Capture seen: " .. (R.lastAckAt and ("last ack " .. Ago(R.lastAckAt)) or "no ack yet this session")
		.. string.format(" (acks by slot list %d, by the reload inbox %d)", R.acks.slot or 0, R.acks.inbox or 0))
	Add("Self-test: static " .. tostring(R.sig.static or "not run") .. ", live " .. tostring(R.sig.live) .. ", last run " .. Ago(R.sig.lastRun)
		.. string.format(" (%d checks, %d hits)", R.sig.checks, R.sig.hits) .. (R.sig.error and (", error: " .. ns.Escape(R.sig.error)) or ""))
	local reasons = {}
	for k, v in pairs(R.slots.reasons) do reasons[#reasons + 1] = k .. " " .. v end
	table.sort(reasons)
	Add(string.format("Free slots: %d of %d; %d loaded this session%s%s", R.slots.free, ns.SLOT_COUNT, R.slots.loads,
		#reasons > 0 and (" (" .. table.concat(reasons, ", ") .. ")") or "", R.slots.broken and (", unavailable: " .. ns.Escape(R.slots.broken)) or ""))
	local dead = {}
	for name, b in pairs(R.bells) do if b.dead then dead[#dead + 1] = name end end
	table.sort(dead)
	Add("Push: " .. (R.push.known and ("read up to " .. ns.Int(R.push.known)) or "not known yet") .. string.format(", %d ring(s) heard, last ", R.push.rings) .. Ago(R.push.lastRingAt)
		.. (#dead > 0 and ("; dead bells: " .. table.concat(dead, ", ")) or ""))
	local gw = type(R.gw) == "table" and R.gw or nil
	local p = ns.Provider()
	if p then
		-- [C-05] The backend in its own words: the provider, the model, the key's state, where the words go.
		Add(string.format("Provider: %s; model %s; %s, key %s; %s", ns.ProviderName(), ns.ModelName() or "?", ns.Escape(ns.Str(p.auth, 20) or "?"),
			ns.Escape(ns.Str(p.keyState, 20) or "?"), ns.Escape(ns.Str(p.privacy, 20) or "?")))
		-- [UX-7] The backend's own state, and today's usage on one line.
		local rt = ns.RT()
		Add(string.format("Backend: %s%s; queued %s", rt and ns.Escape(ns.Str(rt.state, 30) or "?") or "no state yet",
			(T.RetryIn() and ("; retry in " .. ns.FmtDur(T.RetryIn()))) or "", ns.Escape(tostring(gw and gw.queued or 0))))
		if ns.Usage() and ns.UI.UsageLines then
			local parts = {}
			for i, l in ipairs(ns.UI.UsageLines()) do parts[i] = (l:gsub("%.$", "")) end
			Add("Usage: " .. table.concat(parts, "; ") .. ".")
		end
	else
		Add("Provider: no report from " .. ns.Product() .. " yet") -- [C-05]
	end
	Add(ns.Product() .. ": " .. (R.bridge and R.bridge.ver and ns.Escape(tostring(R.bridge.ver)) or "version unknown") .. "; last word " .. Ago(R.bridgeSeenAt) .. "; last beat " .. Ago(R.lastBeatAt))
	local keys = {}
	for key in pairs(R.out) do keys[#keys + 1] = key end
	table.sort(keys)
	Add(string.format("Outbox: %d waiting%s", #keys, #keys > 0 and (" (" .. table.concat(keys, ", ") .. ")") or ""))
	-- [code health AD-03] The strip's self-heal (Transport's T.Heal): a strip the app stopped reading shows here.
	local H = R.heal
	if H.ack + H.timer == 0 then
		Add("Strip self-heal: no full redraws this session")
	else
		Add(string.format("Strip self-heal: %d full redraw(s) (%d with no ack for %d s, %d on the %d s timer), %d followed by an ack; last %s",
			H.ack + H.timer, H.ack, T.HEAL_ACK, H.timer, T.HEAL_EVERY, H.heard, Ago(H.lastAt)))
	end
	Add(string.format("Cursor: %s (reported %s); orphans %d; records of later versions skipped %d", ns.Int(db.cursor), ns.Int(db.reported), R.orphans, R.skipped))
	local showToken = full -- [UX-7]
	Add(string.format("Nonce %s, token %s, next n %s", tostring(R.nonce), showToken and db.token or "hidden (/nqa diag full shows it)", ns.Int(db.sendCounter + 1)))
	if R.mismatch then Add("The slots are written for another install (token " .. (showToken and ns.Escape(R.mismatch) or "hidden") .. "), so their records aren't applied.") end
	-- [C-05] The desktop app by its name.
	if R.protoMismatch then Add("|cffff5555" .. ns.Product() .. " writes protocol v" .. ns.Escape(R.protoMismatch) .. "; this addon reads v2.|r") end
	if R.verMismatch then Add("|cffffd100" .. ns.Product() .. " is version " .. ns.Escape(R.verMismatch) .. ", this addon " .. ns.VERSION .. ".|r") end
	if R.bridgeWarn then Add("|cffffd100" .. ns.Product() .. " warns: " .. ns.Escape(R.bridgeWarn) .. "|r") end
	local _, tip = T.Light()
	Add("Light: " .. tip)
	return lines
end

-- /bones mode and /bones stream: screen reading, in the words Settings uses.
-- Its Screen Reading switch is stream mode (the orchestrator's ruling,
-- 2026-09-27): nothing is drawn, your messages wait for a reload, and replies
-- still come in. /bones mode reload is stricter: replies wait for a reload too.
local SCREEN_READING = {
	on = "Screen reading is on: only the top of WoW's window is read, and your messages go at once. Screen Reading, in Settings, turns it off.",
	stream = "Screen reading is off: nothing is drawn on your screen, so your messages wait for a reload, and replies still come in. Screen Reading, in Settings, turns it back on.",
	reload = "Screen reading is off: nothing is drawn on your screen, and your messages and replies wait for a reload. Screen Reading, in Settings, turns it back on.",
	full = "Screen reading is on, but no more replies fit before a reload, so your messages and replies wait for one.",
	-- Turned back on here while the app's reading was stopped for it: the app hears it at the next reload.
	resume = "Screen reading starts at your next reload: until then, your messages wait for it.",
	app = "Screen reading is off in the NeverQuestAlone app: nothing is drawn on your screen, so your messages wait for a reload, and replies still come in. Screen reading, on the app's Your data page, turns it back on.",
	-- Off here and in the app: both switches have to go back on.
	bothStream = "Screen reading is off here and in the NeverQuestAlone app: nothing is drawn on your screen, so your messages wait for a reload, and replies still come in. Turn it back on in Settings and on the app's Your data page.",
	bothReload = "Screen reading is off here and in the NeverQuestAlone app: nothing is drawn on your screen, and your messages and replies wait for a reload. Turn it back on in Settings and on the app's Your data page.",
}
local function ModeLine()
	local s = ns.db.settings
	if ns.Transport.StripOut() then return SCREEN_READING.on end
	local appOff = ns.Transport.DesktopReadingOff()
	if s.mode == "reload" then return appOff and SCREEN_READING.bothReload or SCREEN_READING.reload end
	if s.stream then return appOff and SCREEN_READING.bothStream or SCREEN_READING.stream end
	if appOff then return SCREEN_READING.app end
	if R.toldOff then return SCREEN_READING.resume end
	return SCREEN_READING.full
end

-- /bones think: how hard Bones thinks in this chat (maintainer, 2026-09-25). The
-- bridge sends the level with each of the chat's turns; a chat without its
-- own gets the bridge's default (medium). A patch record carries it (§2.4).
-- [UX-4, C-05, C-11, C-17] With cap model: the provider's word for it,
-- effort, and the model's default. The level shown is the bridge's for the
-- chat (chats[].effort), else bridge.provider.effort. A model without an
-- effort control has nothing to set.
-- [UX-W19] The player's word is thinking (effort is the providers' API
-- word), in whole sentences with named places (§12); a level as a label, "Low".
-- A model offers the levels its AI company documents (ns.UI.ChatEfforts); one
-- it doesn't offer is asked as its nearest (ns.NearestThink, the bridge's rule).
local function LevelWord(l) l = tostring(l or ""); return ns.ThinkLabel(l) or (l:sub(1, 1):upper() .. l:sub(2)) end
local function ModelThink(chat, level)
	local T = ns.Transport
	local model = ns.UI.ChatModelName(chat)
	if not model then
		return "There's no model yet: pick one in the NeverQuestAlone app. Nothing changed."
	end
	if level == "" then
		if ns.UI.NoEffort(chat) then return ns.Fill("{model} has no thinking levels.", { model = model }) end
		local shown = ns.UI.ChatEffort(chat)
		local t = { chat = chat.name, Level = shown and LevelWord(shown), asked = chat.think and LevelWord(chat.think) }
		local said = { (not shown and ns.Fill("Thinking in {chat}: the model's default.", t))
			or (not chat.think and ns.Fill("Thinking in {chat}: {Level} (the model's default).", t))
			or ns.Fill("Thinking in {chat}: {Level}.", t) }
		if chat.think and chat.think ~= shown then said[#said + 1] = ns.Fill("You asked for {asked}: it starts with your next message.", t) end
		said[#said + 1] = ns.Fill("/nqa think {levels} sets it for this chat; /nqa think default goes back to the model's default.", { levels = table.concat(ns.UI.ChatEfforts(chat), "|") })
		return table.concat(said, " ")
	end
	if not ns.HasCap("think") then return "The NeverQuestAlone app doesn't take thinking levels yet. Nothing changed." end
	if ns.UI.NoEffort(chat) then return ns.Fill("{model} has no thinking levels. Nothing changed.", { model = model }) end
	-- A level this model doesn't offer: its nearest, said as such.
	local asked, note = level, nil
	if level ~= "default" then
		level = ns.NearestThink(ns.UI.ChatEfforts(chat), level) or level
		if level ~= asked then
			note = asked == "off" and ns.Fill("{model} always thinks.", { model = model })
				or ns.Fill("{model} has no {Asked} level.", { model = model, Asked = LevelWord(asked) })
		end
	end
	local key = T.NewKeyed("patch", chat.id, { { "cur", ns.db.cursor }, { "agent", chat.agent }, { "think", level } }, "")
	T.AfterSend(chat.id, "patch", key)
	chat.think = level ~= "default" and level or nil
	chat.thinkAsked = level -- asked until the chats snapshot names it (Chats.ConfirmThink)
	if level == "default" then return "Thinking in this chat goes back to the model's default from your next message." end
	local said = ns.Fill("Thinking in this chat: {Level}, from your next message.", { Level = LevelWord(level) })
	return note and (note .. " " .. said) or said
end

-- [UX-6, C-11] /bones model [id]: the model this chat uses, set with a
-- patch record (model=, cap model) as /bones think sets the effort. The bridge
-- checks the id against the provider's list; the desktop app lists them. What
-- you asked for stays "asked for" (chat.modelAsked) until a reply's usage.model
-- or the chats snapshot names it (Chats.ConfirmModel).
local function Model(chat, id)
	if id == "" then -- [UX-W19] whole sentences with named places (§12)
		local model = ns.UI.ChatModelName(chat)
		local own = model and ns.Str(chat.model, 80) and true
		local t = { model = model, asked = chat.modelAsked and (chat.modelAsked == "default" and "the default model" or ns.Escape(chat.modelAsked)) }
		local said = { (not model and "No model yet: pick one in the NeverQuestAlone app.")
			or (own and ns.Fill("Model in this chat: {model}.", t)) or ns.Fill("Model: {model}.", t) }
		if t.asked then said[#said + 1] = ns.Fill("You asked for {asked}: it starts with your next message, if your AI company offers it.", t) end
		said[#said + 1] = "/nqa model <id> changes it for this chat (/nqa model default goes back); the NeverQuestAlone app lists the IDs."
		return table.concat(said, " ")
	end
	if ns.Chats.KeyShaped(id) then return ns.Chats.KeyRefused() end -- KY-10: never a chat's model
	if #id > 80 or not id:match("^[%w%._:/%-]+$") then
		return "That isn't a model ID (letters, digits and . _ : / - only). Nothing changed." -- [UX-W19]
	end
	local key = ns.Transport.NewKeyed("patch", chat.id, { { "cur", ns.db.cursor }, { "agent", chat.agent }, { "model", id } }, "")
	ns.Transport.AfterSend(chat.id, "patch", key)
	local p = ns.Provider()
	local current = ns.Str(chat.model, 80) or (p and ns.Str(p.model, 80))
	if id:lower() == "default" then
		chat.modelAsked = ns.Str(chat.model, 80) and "default" or nil
		return "The model in this chat goes back to the default from your next message."
	end
	chat.modelAsked = id ~= current and id or nil
	return ns.Fill("Asked for {model} in this chat, from your next message (if your AI company offers it).", { model = ns.Escape(id) }) -- [UX-W19]
end

local function Think(chat, level)
	if ns.HasCap("model") then return ModelThink(chat, level) end -- [UX-4]
	local snap = R.snap and R.snap[chat.id]
	local now = snap and type(snap.think) == "string" and snap.think or nil
	local b, caps = R.bridge, {}
	-- The bridge's default (bridge.think), for a chat it doesn't know yet (nothing sent since its state began).
	local default = type(b) == "table" and type(b.think) == "string" and b.think or nil
	local app = ns.Product() -- [C-05] the desktop app by its name
	if level == "" then
		local shown = now or chat.think or default
		return string.format("Thinking in %s: %s%s. /nqa think low|medium|high sets it for this chat; /nqa think default goes back to %s's.",
			chat.name, shown or ns.P("the default"), (shown and not chat.think) and (" (" .. app .. "'s default)") or "", app)
	end
	if type(b) == "table" and type(b.caps) == "table" then
		for _, v in pairs(b.caps) do caps[v] = true end
	end
	if not caps.think then return app .. " doesn't take thinking levels yet. Nothing was changed." end
	-- An app from before each model had its own levels knows low, medium and high: a newer level
	-- asks for its nearest (the bridge's rule).
	if level ~= "default" then level = ns.NearestThink({ "low", "medium", "high" }, level) or level end
	local key = ns.Transport.NewKeyed("patch", chat.id, { { "cur", ns.db.cursor }, { "agent", chat.agent }, { "think", level } }, "")
	ns.Transport.AfterSend(chat.id, "patch", key)
	chat.think = level ~= "default" and level or nil
	if level == "default" then return "Thinking in this chat goes back to " .. app .. "'s default from your next message." end
	return string.format("Thinking in this chat: %s, from your next message.", level)
end

---------------------------------------------------------------------------
-- Quick asks: one key press or click sends a fixed question plus game data,
-- no typing. The public NeverQuestAlone.QuickAsk takes only "next", "target" and
-- "item", so another addon can at most ask one of those for you (TB5), never
-- send words of its own.
---------------------------------------------------------------------------

local QUICK_CHAT = "Quick questions"

-- The chat quick asks go to: "Quick questions", made the first time and kept.
function ns.QuickChat()
	for _, c in ipairs(ns.db.chats) do
		if c.quick then return c end
	end
	local c = ns.Chats.New(QUICK_CHAT, { quiet = true }) -- the window stays on the chat you had
	if c then c.quick = true end
	return c
end

-- "Plainstrider", "level 7, beast, hostile"; nil without a target, and false
-- for the name where the game keeps it secret. In a fight an NPC's name is a
-- secret value (UnitName is SecretWhenUnitNameIdentityRestricted at 70009;
-- UnitCreatureType SecretWhenUnitIdentityRestricted), which raises an error
-- when compared or joined, so every read is checked first (ns.Readable) and
-- the ask goes without what the game keeps back.
local function TargetLine()
	if not ns.Readable(ns.Try(UnitExists, "target")) then return nil end
	local name = ns.Try(UnitName, "target")
	if ns.IsSecret(name) then
		name = false
	elseif type(name) ~= "string" or name == "" then
		return nil
	end
	local parts = {}
	local lvl = ns.Readable(ns.Try(UnitLevel, "target"))
	if type(lvl) == "number" then parts[#parts + 1] = lvl > 0 and ("level " .. ns.Int(lvl)) or "level ??" end
	local class = ns.Readable(ns.Try(UnitClassification, "target"))
	if type(class) == "string" and class ~= "normal" and class ~= "minus" and class ~= "trivial" then
		parts[#parts + 1] = class == "rareelite" and "rare elite" or class == "worldboss" and "world boss" or class
	end
	local ctype = ns.Readable(ns.Try(UnitCreatureType, "target"))
	if type(ctype) == "string" and ctype ~= "" then parts[#parts + 1] = ctype:lower() end
	if ns.Readable(ns.Try(UnitIsPlayer, "target")) then parts[#parts + 1] = "a player" end
	local reaction = ns.Readable(ns.Try(UnitReaction, "target", "player"))
	if type(reaction) == "number" then parts[#parts + 1] = reaction <= 3 and "hostile" or (reaction == 4 and "neutral" or "friendly") end
	return name and (name:gsub("|", "")), table.concat(parts, ", ")
end

-- The link for the item in the tooltip under the mouse. Only the item string
-- is taken from the tooltip; the link sent is the client's own for it, so no
-- text another addon put in a tooltip travels with the ask (TB5).
local function MouseoverItem()
	if type(GameTooltip) ~= "table" or not GameTooltip:IsShown() or type(GameTooltip.GetItem) ~= "function" then return nil end
	local _, link = ns.Try(GameTooltip.GetItem, GameTooltip)
	local itemString = type(link) == "string" and link:match("|H(item:[%-%d:]+)|h") or nil
	if not itemString then return nil end
	local _, own = ns.Try(C_Item and C_Item.GetItemInfo, itemString)
	if type(own) == "string" and own:find("|Hitem:", 1, true) then return own end
end

-- The HUD's Re-plan (and, with no route, its "Route my quests" ask): a fresh
-- route from where you are for the quests you have; the game data rides along.
-- A route on screen is named with its map layer, so Bones replaces that layer
-- rather than adding a second one.
function ns.RouteAsk()
	local nav = ns.MapShared and ns.MapShared.navView
	if nav then
		return string.format("Re-plan my route \"%s\" (map layer %s) from where I am now: skip what's done, keep the quests I still have, shortest path. Replace that layer.",
			(tostring(nav.title or "route"):gsub("[|\"]", "")), (tostring(nav.layer or "?"):gsub("[|\"]", "")))
	end
	return "Plan me a route for my quests from where I am now: shortest path, turn-ins on the way."
end

-- An ask made with the window closed is confirmed where you asked, in the
-- game's own line (the HUD may be the compass, which shows no asks; C-87).
-- While Bones can't be reached (the light red, grey, or yellow for anything
-- but connecting), it says the ask waits.
local function Confirm()
	if ns.Paste and ns.Paste.On() then return end -- Copy and Paste: its window opened
	local light = ns.Transport.Light()
	local gw = type(R.gw) == "table" and R.gw or nil
	local reachable = light == "green" or light == "wait"
		or (light == "yellow" and (gw == nil or gw.state == "connecting"))
	-- [UX-5] In the companion's name, never "he" (C-14).
	ns.Notify.Game(ns.P(reachable and "Asked NeverQuestAlone." or "Your message waits until NeverQuestAlone can be reached."))
end

-- Returns the key it sent, or nil (a note says why).
function ns.QuickAsk(kind, data)
	if not ns.db or not R.nonce then return nil end
	local text
	if kind == "next" then
		text = "What should I do next?"
	elseif kind == "target" then
		local name, desc = TargetLine()
		if name == nil then
			ns.Notify.Game(ns.P("Target something first, then ask NeverQuestAlone about it."), true) -- [UX-5]
			return nil
		end
		-- Nothing about it can be read: an ask would cost a reply that can't help.
		if not name and desc == "" then
			ns.Notify.Game("The game hides your target from addons right now. Ask again after the fight.", true)
			return nil
		end
		if name and ns.Readable(ns.Try(UnitIsUnit, "target", "player")) then name = "myself" end -- [both:B B-5] (L5-3) never your character's name
		-- {name}: the target's, where the game gives it; {desc}: "level 7, beast, hostile".
		local ask = name and (desc ~= "" and "What do you know about my target: {name} ({desc})?" or "What do you know about my target: {name}?")
			or "What do you know about my target ({desc})? The game hides its name from addons right now."
		text = ns.Fill(ask, { name = name, desc = desc })
	elseif kind == "item" then
		local link = MouseoverItem()
		if not link then
			ns.Notify.Game(ns.P("Hover over an item first, then ask NeverQuestAlone about it."), true) -- [UX-5]
			return nil
		end
		text = "Is this an upgrade for me? " .. link
	elseif kind == "spot" and type(data) == "table" and tonumber(data.mapID) and tonumber(data.x) and tonumber(data.y) then
		text = string.format("What's at %.1f, %.1f on %s (map %s)? Anything there worth doing at my level?",
			data.x * 100, data.y * 100, tostring(data.mapName or "this map"):gsub("|", ""), ns.Int(data.mapID))
	elseif kind == "quest" and type(data) == "table" and tonumber(data.id) then
		text = string.format("Help me with this quest: %s (quest %s). What's left, and where?", tostring(data.title or "?"):gsub("|", ""), ns.Int(data.id))
	elseif kind == "route" then
		text = ns.RouteAsk()
	else
		return nil
	end
	local chat = ns.QuickChat() or ns.Chats.Active()
	if not chat then return nil end
	local key = ns.Chats.Send(text, chat.id)
	if key and ns.HUD then ns.HUD.Asked(chat.id) end
	-- Said where you asked, as the game says things: the map, the quest log, a key.
	if key then
		Confirm()
	else
		ns.Notify.Game("Not sent: open the window (/nqa) to see why.", true)
	end
	return key
end

-- The key bindings' quick asks (Bindings.xml). It sends: a fixed question to Bones, so a
-- paid message, as /bones <question> is, which any addon or macro can type too (code
-- health AD-16); the outbox's cap (Transport.TYPED_MAX) holds a loop of them.
NeverQuestAlone.QuickAsk = function(kind)
	if kind == "next" or kind == "target" or kind == "item" then return ns.QuickAsk(kind) ~= nil end
	return false
end

-- A chat named by number or name. Numbers are the ones the last /bones chat
-- listing showed (the list re-sorts by recency, so the order now may differ);
-- before any listing, the list's order now.
local function FindChat(rest)
	local db = ns.db
	local n = tonumber(rest)
	if n then
		local ids = R.chatNumbers
		if ids then return ids[n] and ns.Chats.Find(ids[n]) or nil end
		return db.chats[n]
	end
	for _, c in ipairs(db.chats) do
		if c.name:lower() == rest:lower() then return c end
	end
end

-- A command's answer: in the window when it's open, else in your chat frame.
-- Say takes display-ready text as it is (the bridge's words joined in); Tell
-- takes our own words only, and puts the companion's name in them. -- [UX-5]
local function Say(chat, text)
	if ns.UI.IsOpen() then ns.Chats.Notice(chat, text) else ns.Notify.Local(text) end
end
local function Tell(chat, text) Say(chat, ns.P(text)) end

-- [C-01] The public build's commands before the app has answered this session.
local function NotYet()
	return "The NeverQuestAlone app hasn't answered yet. Is it running?" -- [UX-W03, UX-W19]
end

local function Handle(msg)
	local db = ns.db
	if not db then return end
	msg = ns.Trim(msg)
	-- [both:B B-1] (KY-10) A key-shaped line is refused before anything runs, so no
	-- command keeps it (a chat's name) and no message sends it.
	if ns.Chats.KeyShaped(msg) then
		ns.Chats.RefuseKey()
		return
	end
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	cmd = cmd and cmd:lower() or ""
	rest = rest or ""
	-- Anything that isn't a command, or a command word followed by something
	-- it doesn't take, is a message for Bones.
	if cmd ~= "" and not IsCommand(cmd, rest) then
		-- With the window open, to the chat you're looking at; closed, to Quick
		-- questions, as the HUD's asks go.
		-- [G2] "/bones hi" before the first reply is Say hi's (the public build's).
		local intro = (not db.firstReply and msg:lower() == "hi") and { intro = true } or nil
		if ns.UI.IsOpen() then
			ns.Chats.Send(msg, nil, intro)
		else
			local chat = ns.QuickChat() or ns.Chats.Active()
			local key, _, refused
			if chat then key, _, refused = ns.Chats.Send(msg, chat.id, intro) end
			if key then
				if ns.HUD then ns.HUD.Asked(chat.id) end
				Confirm()
			elseif refused == "key" then -- [both:B B-2] (KY-10) said on the game's error line
				ns.Notify.Game(ns.Chats.KeyRefused(), true)
			else
				ns.Notify.Game("Not sent: open the window (/nqa) to see why.", true)
			end
		end
		return
	end
	local chat = ns.Chats.Active()
	local s = db.settings
	if cmd == "" then
		ns.UI.Toggle()
	elseif cmd == "model" then -- [UX-6]
		if not ns.HasCap("model") then return Say(chat, NotYet()) end
		ns.Chats.Notice(chat, Model(chat, rest))
		ns.UI.Toggle(true)
	elseif cmd == "usage" then -- [UX-3]
		Say(chat, ns.HasCap("usage") and table.concat(ns.UI.UsageLines(true), "\n") or NotYet())
	elseif cmd == "cost" then -- [UX-3]
		s.replyCost = rest:lower() == "on" or (rest == "" and s.replyCost)
		ns.Refresh("all")
		-- [UX-W19] Reply Cost, the Settings row's name; a cost without tokens (§10)
		local said = { s.replyCost and "Reply Cost: on. /nqa cost on||off changes it." or "Reply Cost: off. /nqa cost on||off changes it." }
		if not ns.HasCap("usage") then said[2] = NotYet() end
		Tell(chat, table.concat(said, " "))
	elseif cmd == "setup" then -- [UX-8]
		ns.Chats.Notice(chat, table.concat(ns.UI.ChecklistLines(), "\n"))
		ns.UI.Toggle(true)
	elseif cmd == "new" then
		ns.Chats.New(rest)
		ns.UI.Toggle(true)
	elseif cmd == "chat" or cmd == "chats" then
		local target = rest ~= "" and FindChat(rest) or nil
		if target then
			ns.Chats.Switch(target.id)
		else
			local lines, ids = {}, {}
			for i, c in ipairs(db.chats) do
				ids[i] = c.id
				lines[#lines + 1] = i .. ". " .. ns.Escape(c.name) .. (c.pinned and "  (pinned)" or "") .. (c.id == db.activeChat and "  (current)" or "")
					.. (ns.Chats.IsBusy(c) and "  working" or "") .. (c.unread > 0 and ("  " .. c.unread .. " new") or "")
			end
			R.chatNumbers = ids
			local miss = ""
			if rest ~= "" then
				miss = tonumber(rest) and ("No chat " .. ns.Escape(rest) .. " in that list any more. ") or ("No chat called \"" .. ns.Escape(rest) .. "\". ")
			end
			ns.Chats.Notice(chat, miss .. "Chats (/nqa chat <number> opens one):\n" .. table.concat(lines, "\n"))
		end
		ns.UI.Toggle(true)
	elseif cmd == "pin" or cmd == "unpin" then
		local target = rest ~= "" and FindChat(rest) or nil
		if rest ~= "" and not target then
			ns.Chats.Notice(chat, (tonumber(rest) and ("No chat " .. ns.Escape(rest) .. " in the last list. ") or ("No chat called \"" .. ns.Escape(rest) .. "\". ")) .. "/nqa chat lists them.")
		else
			target = ns.Chats.SetPinned((target or chat).id, cmd == "pin")
			ns.Chats.Notice(chat, (cmd == "pin" and "Pinned to the top: " or "Unpinned: ") .. ns.Escape(target.name))
		end
		ns.UI.Toggle(true)
	elseif cmd == "rename" then
		if rest ~= "" then ns.Chats.Rename(chat.id, rest) else ns.UI.RenamePrompt(chat.id) end
		ns.UI.Toggle(true)
	elseif cmd == "delete" then
		ns.UI.ConfirmDelete(chat.id)
	elseif cmd == "stop" then
		ns.Chats.Stop(chat.id)
	elseif cmd == "echo" then
		if rest ~= "" then s.echo = rest:lower() end
		local label, words = ns.Settings.Choice("echo")
		if ns.Notify.DesktopEchoOff() then
			-- [PR-1] The desktop's switch decides (cap echo): say where it's set.
			-- [UX-W19] the app by its name, one sentence each (§12)
			Tell(chat, ns.Fill("{label}: {words}. It's off in the NeverQuestAlone app right now, so none show: turn on Replies in chat frame under Settings, Show more.", { label = label, words = words }))
		else
			Tell(chat, string.format("%s: %s. Settings has it too.", label, words))
		end
	elseif cmd == "context" then
		rest = rest:lower()
		if rest == "on" or rest == "off" then s.context = rest == "on" end
		local ctx = ns.Chats.GameContext()
		ns.Chats.Notice(chat, string.format(ns.P(s.context -- [UX-5] in the companion's name, before the game data joins
			and "%s: On. Your next message carries this when it has changed. Settings has it too.\n\n%s"
			or "%s: Off. Your next message tells NeverQuestAlone to forget the game data sent before. Settings has it too. When it's on, your messages carry this:\n\n%s"),
			ns.Settings.LABELS.context, ns.Escape(ctx)))
		ns.UI.Toggle(true)
	elseif cmd == "dnd" then
		local what, v = rest:lower():match("^(%a*)%s*(%a*)$")
		if what == "combat" and (v == "on" or v == "off") then
			s.dndCombat = v == "on"
			if not s.dndCombat then ns.Notify.Flush() end
		elseif what == "instance" or what == "boss" then
			Tell(chat, "Quiet in instances and boss fights comes in a later version.")
			return
		end
		Tell(chat, string.format(s.dndCombat and "%s: On. In a fight only the unread count moves, and the rest arrives just after. Settings has it too."
			or "%s: Off. Settings has it too.", ns.Settings.LABELS.dnd))
	elseif cmd == "map" then
		if type(NQAMap) == "table" and type(NQAMap.Command) == "function" then
			NQAMap.Command(rest)
		else
			ns.Notify.Local("The addon's map didn't load. A full restart of WoW usually fixes it.")
		end
	elseif cmd == "paste" then
		if not (ns.Paste and ns.Paste.Open()) then Tell(chat, "Nothing is waiting for a pasted reply. Send a message and Copy and Paste opens with it.") end
	elseif cmd == "app" then
		-- The page to copy into a browser (an addon can't open one).
		if ns.Paste then ns.UI.ShowCopy(ns.Paste.APP_PAGE) end
		-- [UX-W01] Copy is Cmd+C on a Mac.
		Tell(chat, string.format("The link to the NeverQuestAlone app is selected. Press %s, then paste it into your browser to download the app. Once it's set up, replies come back by themselves.",
			(type(IsMacClient) == "function" and IsMacClient()) and "Cmd+C" or "Ctrl+C"))
	elseif cmd == "replies" then
		rest = rest:lower()
		if rest == "auto" or rest == "paste" then
			s.replies = rest
			ns.Refresh()
		end
		local label, words = ns.Settings.Choice("replies")
		Tell(chat, string.format(s.replies == "paste"
			and "%s: %s. You copy each message into your AI and paste its reply back, even with the NeverQuestAlone app running. Settings has it too."
			or "%s: %s. Replies come back by themselves while the NeverQuestAlone app runs, and by Copy and Paste when it doesn't. Settings has it too.",
			label or "Connection", words or s.replies))
	elseif cmd == "stream" or cmd == "reading" then
		-- /bones reading on|off says the direction in Screen Reading's own word (the app's command);
		-- /bones stream on is the same switch the other way round, and still answers. Reading on
		-- ends /bones mode reload too, as the Settings switch does, so it's the one way back.
		rest = rest:lower()
		if rest == "on" or rest == "off" then
			s.stream = (rest == "on") == (cmd == "stream")
			if cmd == "reading" and rest == "on" then s.mode = "pixel" end
			ns.Transport.ModeChanged()
		end
		Tell(chat, ModeLine())
	elseif cmd == "mode" then
		rest = rest:lower()
		if rest == "pixel" or rest == "reload" then
			s.mode = rest
			ns.Transport.ModeChanged()
		end
		Tell(chat, ModeLine())
	elseif cmd == "reload" then
		ns.Reload()
	elseif cmd == "copy" then
		for i = #chat.history, 1, -1 do
			if chat.history[i].role == "assistant" then
				ns.UI.ShowCopy(ns.UI.CopyTextOf(chat.history[i]))
				break
			end
		end
	elseif cmd == "diag" then
		ns.Chats.Notice(chat, "Diagnostics:\n" .. table.concat(DiagLines(rest:lower() == "full"), "\n")) -- [UX-7]
		ns.UI.Toggle(true)
	elseif cmd == "probe" then
		ns.Chats.Notice(chat, "Signal probe:\n" .. table.concat(ns.Transport.ProbeReport(), "\n"))
		ns.UI.Toggle(true)
	elseif cmd == "perf" then -- [SY-27]
		Perf(chat)
	elseif cmd == "speak" then
		Tell(chat, ns.Companion and ns.Companion.Call("SpeechCommand", rest:lower()) or "TTS isn't available in this client.")
	elseif cmd == "voice" then
		Tell(chat, ns.Companion and ns.Companion.Call("VoiceSlash", rest:lower()) or "Voice controls hit an error. /nqa diag shows it for a bug report.")
	elseif cmd == "live" then
		if rest:lower() == "on" or rest:lower() == "off" then
			if ns.Companion then ns.Companion.Call("LiveSwitch", rest:lower() == "on") end
		end
		Tell(chat, "Live Game Data: " .. (s.live == true and "on." or "off."))
	elseif cmd == "companion" then
		if ns.Companion then
			ns.Chats.Notice(chat, table.concat(ns.Companion.Call("Command", rest) or { "Check-ins hit an error. /nqa diag shows it for a bug report." }, "\n"))
		else
			ns.Notify.Local("The addon's check-ins didn't load. A full restart of WoW usually fixes it.")
		end
		ns.UI.Toggle(true)
	elseif cmd == "state" or cmd == "apicheck" then
		if ns.Companion then
			local lines = ns.Companion.Call(cmd == "state" and "StateReport" or "ApiCheck")
				or { "It hit an error: " .. ns.Escape(tostring(R.companionError and R.companionError.text or "?")) }
			ns.Chats.Notice(chat, (cmd == "state" and "Companion state:\n" or "Game APIs the companion reads:\n") .. table.concat(lines, "\n"))
		else
			ns.Notify.Local("The addon's check-ins didn't load. A full restart of WoW usually fixes it.")
		end
		ns.UI.Toggle(true)
	elseif cmd == "think" then
		if chat then ns.Chats.Notice(chat, ns.Escape(Think(chat, rest:lower()))) end
		ns.UI.Toggle(true)
	elseif cmd == "ask" then
		ns.QuickAsk(rest:lower())
	elseif cmd == "update" then
		Tell(chat, "The NeverQuestAlone app keeps the addon up to date.") -- [N-1, UX-W19]
	elseif cmd == "hud" then
		rest = rest:lower()
		if rest == "bar" then rest = "min" end
		if rest == "on" or rest == "off" then s.hud = rest == "on" end
		if rest == "off" then s.miniHidden = nil end -- off: the small bar stands in (the X closes both)
		if not ns.HUD then
			Tell(chat, "The HUD shows after a full restart of WoW; a /reload isn't enough.")
			return
		end
		if rest == "reset" then ns.HUD.ResetPosition() end
		if rest == "min" or rest == "compass" or rest == "full" then
			ns.HUD.SetForm(rest == "min" and "bar" or rest) -- full: the panel now, as Show More
		end
		ns.HUD.Refresh()
		ns.UI.RenderMini()
		local now = s.hud and (s.hudMin and (s.hudCompass and "The HUD is on, as its compass." or "The HUD is on, as its bar.") or "The HUD is on.")
			or s.miniHidden and "The HUD is closed: only a route you follow shows, as its bar. Show More in its right-click menu brings the HUD back."
			or string.format("The HUD is off: the small bar shows when the window is closed. %s, in Settings, turns it back on.", ns.Settings.LABELS.hud)
		Tell(chat, string.format("%s Change it with /nqa hud on, off, full, bar, compass or reset.", now))
	elseif cmd == "text" then
		rest = rest:lower()
		if ns.TEXT_SIZES[rest] then s.textSize = rest end
		ns.UI.TextSizeChanged()
		local label, words = ns.Settings.Choice("textSize")
		Tell(chat, string.format("%s: %s. Settings has it too.", label, words))
	elseif cmd == "waypoint" or cmd == "tooltips" or cmd == "quips" then
		rest = rest:lower()
		if rest == "on" or rest == "off" then s[cmd] = rest == "on" end
		if cmd == "waypoint" and type(NQAMap) == "table" and type(NQAMap.WaypointSettingChanged) == "function" then NQAMap.WaypointSettingChanged() end
		Tell(chat, string.format(s[cmd] and "%s: On. Settings has it too." or "%s: Off. Settings has it too.", ns.Settings.LABELS[cmd]))
	elseif cmd == "roll" then
		if type(NQAMap) == "table" and type(NQAMap.Roll) == "function" then NQAMap.Roll() end
	elseif cmd == "settings" or cmd == "options" or cmd == "config" then
		if ns.Settings then
			ns.Settings.Open()
		else
			Tell(chat, "Settings show after a full restart of WoW.")
		end
	elseif cmd == "qol" then
		-- Quality of Life (QoL.lua): typed by the player, never from a reply.
		if not ns.QoL then
			Tell(chat, "Quality of Life isn't loaded yet. Restart WoW to load it: /reload isn't enough.")
			return
		end
		rest = rest:lower()
		if rest == "on" then
			-- The step's five (those this client has), as its Turn On with all checked.
			ns.QoL.TurnOn(true, function(line) Tell(chat, line) end)
		elseif rest == "off" then
			ns.QoL.AllOff()
			Tell(chat, "Your Quality of Life options are off. Auto Loot and Auto Track Quests are the game's own settings, so they stay as they were.")
		elseif rest == "last" then
			local last = ns.QoL.Last()
			-- %s: the lines, newest first, one a line
			Tell(chat, #last == 0 and "Your Quality of Life options haven't done anything since you logged in or reloaded."
				or string.format("What your Quality of Life options did, newest first:\n%s", table.concat(last, "\n")))
		else
			-- Settings has every option, so the HUD's step is answered too.
			ns.QoL.Answer()
			if ns.HUD and ns.HUD.Render then ns.HUD.Render() end
			if ns.Settings then ns.Settings.Open("Quality of Life") end
		end
	elseif cmd == "window" then
		ns.UI.ResetWindow()
	elseif cmd == "slots" then -- [UX-W13] "parts", the AddOns list's word, never "slots"
		ns.Chats.Notice(chat, string.format("%d of %d parts are free this session (a reload frees them all).", R.slots.free, ns.SLOT_COUNT))
		ns.UI.Toggle(true)
	elseif cmd == "help" or cmd == "?" then
		-- [C-05, G3, PUI-22] "Getting around", then the short list (Copy and
		-- Paste's while it's the way); or every command
		local short = ns.Paste and ns.Paste.On() and HELP_PASTE or HELP
		local text = rest:lower() == "all" and HELP_ALL or (GETTING_AROUND .. "\n\n" .. short)
		ns.Chats.Notice(chat, ns.P(HelpShown(text)))
		ns.UI.Toggle(true)
	end
end

-- /br: reply in the chat that last pinged you.
local function HandleReply(msg)
	if not ns.db then return end
	local chat = ns.Notify.LastPingChat() or ns.Chats.Active()
	if not chat then return end
	if ns.db.activeChat ~= chat.id then ns.Chats.Switch(chat.id) end
	local text = ns.Trim(msg)
	if text == "" then
		ns.UI.OpenAndFocus()
		return
	end
	local _, _, refused = ns.Chats.Send(text, chat.id)
	if refused == "key" then ns.Notify.Game(ns.Chats.KeyRefused(), true) end -- [both:B B-2] (KY-10)
end

-- /nqa is the command every help line and doc shows (the owner, 2026-10-05:
-- the companion is NeverQuestAlone, never Bones). /bones still works, unlisted,
-- for players who learned it. The IDs (BONES, BONESREPLY) stay as they were.
SLASH_BONES1 = "/nqa"
SLASH_BONES2 = "/bones" -- [UX-6] the earlier command, a silent alias
SlashCmdList["BONES"] = Handle
SLASH_BONESREPLY1 = "/br"
SlashCmdList["BONESREPLY"] = HandleReply

-- A slot came: the companion's name it brings, the check-ins chat's name, the
-- spend line's Okay, and the settings page, whose rows now know the companion's
-- name (C-18). -- [C-01]
function ns.NoteSlot()
	local db = ns.db
	if not db then return end
	-- [UX-5] The companion's name from bridge.provider.companion.
	local p = ns.Provider()
	if p then ns.Chats.SetCompanionName(p.companion) end
	-- [UX-W04] The check-ins chat is "Check-ins" (a saved one still called "Companion" takes it).
	if ns.Companion then ns.Companion.Call("NameChat") end
	-- [C-23] The HUD's spend line you said Okay to stays put away only while
	-- the usage still says that: once it clears or says something else, the same
	-- words later in the day show again.
	if db.spendOkay and db.spendOkay ~= ns.SpendKey() then db.spendOkay = nil end
	if ns.Settings and ns.Settings.Ready then ns.Settings.Ready() end
end

ns.DiagLines = DiagLines
ns.IsCommand = IsCommand
ns.COMMAND_ARGS = COMMAND_ARGS
ns.HandleCommand = Handle
ns.HandleReply = HandleReply

---------------------------------------------------------------------------
-- Start-up and events
---------------------------------------------------------------------------

ns.On("ADDON_LOADED", function(_, name)
	if name == ns.ADDON then ns.InitDB() end
end)

ns.On("PLAYER_LOGIN", function()
	if not ns.db then ns.InitDB() end
	ns.ResetRuntime()
	ns.UI.Build()
	ns.UI.RestoreDraft(ns.Chats.Active()) -- what was in the box at the last logout or reload
	ns.Transport.Start()
	ns.UI.RestoreShown()
	ns.Refresh("all")
end)

ns.On("PLAYER_REGEN_DISABLED", function()
	R.inCombat = true
	ns.Refresh("status")
end)

ns.On("PLAYER_REGEN_ENABLED", function()
	ns.Notify.OnRegenEnabled()
	ns.Refresh("status")
end)

-- Upstream issue #8: the strip keeps one UI unit per pixel.
ns.On("UI_SCALE_CHANGED", function() ns.Transport.UpdateStripScale() end)
ns.On("DISPLAY_SIZE_CHANGED", function() ns.Transport.UpdateStripScale() end)

-- A Sound_* CVar changed: the self-test runs again (§3).
ns.On("CVAR_UPDATE", function(_, name)
	if type(name) == "string" and name:lower():find("^sound_") and R.nonce then
		ns.Transport.SelfTest()
		ns.Refresh("status")
	end
end)
