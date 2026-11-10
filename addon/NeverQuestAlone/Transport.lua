-- Transport.lua: the addon's two doors (docs/PROTOCOL.md, protocol v2).
--
--   Out: records (§2.2) drawn as a pixel strip (§2.1), newest first within
--        3,200 bytes, or kept in db.outbox for the reload path (§5). Keyed
--        records stay in db.outbox until the bridge acks them and are drawn
--        again verbatim after /reload.
--   In:  doorbells (§3): files that exist at every UI load, which the bridge
--        rings by deleting them for a moment: push (read a slot), alive (its
--        beat) and act (action counts), plus the self-test; slot addons loaded
--        only under the rules of §4.2; records applied with the seq cursor
--        (§4.3); and NQA_Inbox at every login (§5).
--
-- Nothing here calls ReloadUI: only a click or a typed command can (ns.Reload,
-- UI.lua and Commands.lua), never an event or a timer (upstream issue #7).

local _, ns = ...
local T = {}
ns.Transport = T
local R = ns.R
local Codec = NQA_Codec

local CELL, CELLS_PER_ROW, MAX_ROWS = 4, 200, 48 -- upstream's strip geometry, unchanged
local FAST_TICK = 0.25 -- poll while a strip is up or a run is busy (PRD §7)
local SLOW_EVERY = 8 -- ticks: the 2-second ticker
local SELFTEST_EVERY = 60
local HELLO_DELAY = 3 -- after login, like upstream (zone and map are ready by then)
local HELLO_DWELL = 20 -- seconds an unconfirmed hello stays on the strip by itself
local HELLO_RETRY = 60
local LIVE_WAIT = 30 -- no push ring by then: one slot load settles the live self-test
local SLOTONLY_HELLO_WAIT = 8 -- slot-only mode: the hello answer is read after this
local SEEN_DWELL = 5
local SEEN_RECORDS, SEEN_BYTES, SEEN_AFTER = 10, 16384, 30 -- §2.4
local SLOTONLY_SCHEDULE = { 5, 12, 25, 45 } -- §4.2 rule 4
local STOP_CHECK = 3
local IDLE_CHECK = 600 -- §4.2 rule 5
local PROGRESS_BUSY, PROGRESS_EVERY, PROGRESS_PER_RUN, PROGRESS_PER_SESSION = 30, 60, 3, 30 -- rule 3
local RED_AFTER = 120 -- SD-1: no word from the bridge for 2 min
local BELL_DEAD = 10 -- a bell missing this long isn't pulsing (pulses last 3 s at most, §3)
local PUSH_GAP = 1.5 -- a push ring loads a slot, at most one per 1.5 s (§4.2 rule 1)
local BUSY_EVERY, BUSY_SLOW, BUSY_SLOW_AFTER, BUSY_MAX = 30, 60, 300, 20 -- slot-only: rule 4's tail
local BELLS = { "push_a", "push_b", "alive_a", "alive_b", "act" }
-- [code health AD-09] The app's beat pulses an alive bell for 2.5 s (bridge signals.mjs
-- PULSE_MS), so the 2-second tick always reads one: they're read there, not 4 times a second.
local SLOW_BELLS = { alive_a = true, alive_b = true }
T.LOW_SLOTS = 25 -- RV-4
T.CAPTURE_WARN = 30 -- seconds a record may wait on the strip before we say so (T.StripStalled)
-- [DR-07, DR-08, DR-09] The display clocks (display design rev 5, Layer 3 and 4).
-- They count visible time: the strip's while it's on screen, the interface's while it is (Alt+Z, a
-- cinematic, a movie or a loading screen pause them), so nothing a player couldn't see is judged.
T.STUCK_AFTER = 15 -- a record on the strip this long unread is stuck; a Reload's record this long after the new session's first slot load, refused
T.CAUSE_AFTER = 8 -- a published capture state names its cause once it has held this long (a restart's quick heal never shows)
T.PROBE_EVERY = 60 -- while no_signal is published: a seen on the strip this often, so the bridge sees capture read again
T.MISS_AFTER = 10 -- slot-only: a load this long after a send that brings no ack proves the strip went unread
-- [code health AD-03] The strip's self-heal (T.Heal), in visible seconds. A frame that waits this
-- long for its ack is drawn again in full, once: the slowest ack in normal play is the one that
-- starts a turn, which the app rings for within 8 s (bridge ACK_RING_MS, PROTOCOL §3.1), and the
-- capture's read (every 0.25 s), the bell's poll (0.25 s) and the push gap (PUSH_GAP, 1.5 s) bring
-- it to about 10 s. 12 leaves 2 s for a busy computer and still comes before T.STUCK_AFTER.
T.HEAL_ACK = 12
T.HEAL_EVERY = 30 -- and while anything on the strip waits, a full draw this often, however often it changes

local function SigPath(family, name)
	return ns.SIG .. family .. "\\" .. name .. ".wav"
end

-- PlaySoundFile returns true (and a handle, stopped at once) for a file that
-- existed when the UI loaded and still exists, and false for a missing one;
-- files made after the load read as missing until the next /reload (§3, build 70009).
local function Probe(path)
	local S = R.sig
	if type(PlaySoundFile) ~= "function" then return false end
	S.checks = S.checks + 1
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if not ok then
		S.error = tostring(willPlay)
		return false
	end
	if handle and type(StopSound) == "function" then pcall(StopSound, handle) end
	if willPlay then
		S.hits = S.hits + 1
		S.lastHit = GetTime()
	end
	return willPlay and true or false
end

-- [code health AD-09] The doorbells' paths and present.wav's, made once: they were
-- built again for every probe, 20 a second while a reply was on its way.
local bellPaths = {}
local function BellPath(name)
	local path = bellPaths[name]
	if not path then
		path = SigPath("ctl", name == "present" and "present" or ("bell_" .. name))
		bellPaths[name] = path
	end
	return path
end

local function LoadFn(name)
	if type(C_AddOns) == "table" and type(C_AddOns.LoadAddOn) == "function" then return C_AddOns.LoadAddOn(name) end
	if type(LoadAddOn) == "function" then return LoadAddOn(name) end
	return false, "NO_API"
end

local function IsLoaded(name)
	if type(C_AddOns) == "table" and type(C_AddOns.IsAddOnLoaded) == "function" then return C_AddOns.IsAddOnLoaded(name) end
	if type(IsAddOnLoaded) == "function" then return IsAddOnLoaded(name) end
	return false
end

T.SigPath = SigPath
T.Probe = Probe

---------------------------------------------------------------------------
-- Modes
---------------------------------------------------------------------------

-- Records go out on the strip, rather than waiting in db.outbox for a reload
-- (§5: /bones mode reload, stream mode, and the fallback at 0 free slots).
function T.StripOut()
	local s = ns.db.settings
	return s.mode == "pixel" and not s.stream and not R.reloadFallback and not T.DesktopReadingOff() and not R.toldOff
end

-- The desktop app's Screen Reading switch (its Your data page): off there,
-- nothing is drawn, whatever this addon's own switch says; off on either side
-- wins, and this addon's own setting is kept as it was. Without the cap (an app
-- from before it) only this addon's switch decides.
function T.DesktopReadingOff()
	return ns.HasCap("reading") and type(R.bridge) == "table" and R.bridge.reading == "off" or false
end

-- Slots can be loaded (stream mode only changes the way out).
function T.SlotsIn()
	return ns.db.settings.mode == "pixel" and not R.reloadFallback and not R.slots.broken
end

-- The signal self-test passed (§3). Otherwise the addon is in slot-only mode
-- and no signal file is trusted: if missing files "played", every ack would.
function T.SignalsOK()
	return R.sig.static == "ok" and R.sig.live ~= "fail"
end

-- Without the strip (stream and reload modes) the addon can't tell the bridge
-- what it has read, so every ring would repeat: those modes run slot-only too.
-- Off in the app, the bell is still heard (T.Poll) and rung once a publish: no timers (SY-15).
function T.SlotOnly()
	return not (T.SignalsOK() and (T.StripOut() or T.DesktopReadingOff()))
end

-- This session told an app that stops reading for it (cap reading, SF-01) that its screen reading is
-- off (its hello or a mode seen said stream or reload): back on here, nothing is drawn until the reload
-- that tells it (SY-13), and the lines say so. An older app keeps reading: back on at once, as before.
function T.NoteToldOff(mode)
	-- Only while the app reads: with its own switch off its helper is stopped and nobody heard (SY-17).
	if (mode == "stream" or mode == "reload") and ns.HasCap("reading") and not T.DesktopReadingOff() then R.toldOff = true end
end

-- An install is linked once a NeverQuestAlone app (or the bridge) has
-- answered it: its beat heard, or a slot or the reload inbox read from it.
-- Until then messages go by Copy and Paste (Paste.lua), and nothing is drawn
-- or loaded on the addon's own: no hello, no strip, no slot loads.
function T.Linked()
	return ns.db ~= nil and ns.db.linked == true
end

-- The app showed life. The first time, the install is linked: the hello
-- that waited goes up, and the player hears that replies now come back by
-- themselves.
function T.Heard()
	local db = ns.db
	if not db or db.linked then return end
	db.linked = true
	if R.helloDeferred then
		R.helloDeferred = nil
		T.SayHello()
	end
	if ns.Paste and ns.Paste.OnLinked then ns.Paste.OnLinked() end
	ns.Refresh()
end

-- [SY-03, DR-08] The way records go out, in the hello's and the mode seen's word:
-- pixel, stream or reload (the 0-slot fallback needs none: the bridge knows the slots' end).
function T.ModeWord()
	local s = ns.db.settings
	return s.mode == "reload" and "reload" or (s.stream and "stream" or "pixel") -- this addon's own (the app knows its own switch)
end

function T.ModeLabel()
	local s = ns.db.settings
	if R.reloadFallback then return "reload (no slots left until you reload)" end
	if s.mode == "reload" then return "reload" end
	if s.stream then return "stream (sends through the reload path)" end
	if T.DesktopReadingOff() then return "stream (off in the NeverQuestAlone app)" end
	return "pixel"
end

---------------------------------------------------------------------------
-- Records (§2.2)
---------------------------------------------------------------------------

-- 2 US token US key US type US chat US args US body. args is a list of
-- { name, value } pairs, drawn in that order; cur comes first on every record.
function T.Record(key, rtype, chat, args, body)
	local parts = {}
	for _, kv in ipairs(args) do
		local v = kv[2]
		if type(v) == "number" then v = ns.Int(v) end
		parts[#parts + 1] = kv[1] .. "=" .. ns.EncodeArg(v)
	end
	return table.concat({ "2", ns.db.token, key, rtype, chat or "", table.concat(parts, ";"), body or "" }, ns.US)
end

-- The fields of a record this addon drew (the outbox after /reload).
function T.ParseRecord(wire)
	if type(wire) ~= "string" then return nil end
	local f, start = {}, 1
	for i = 1, 6 do
		local j = wire:find(ns.US, start, true)
		if not j then return nil end
		f[i] = wire:sub(start, j - 1)
		start = j + 1
	end
	if f[1] ~= "2" then return nil end
	local args = {}
	for pair in (f[6] .. ";"):gmatch("([^;]*);") do
		local k, v = pair:match("^([^=]+)=(.*)$")
		if k then args[k] = ns.DecodeArg(v) end
	end
	return { token = f[2], key = f[3], type = f[4], chat = f[5], args = args, body = wire:sub(start) }
end

-- A body deflated and in base64, for a record marked z=1 (§2.6, when the bridge
-- lists cap z). The strip's payload reaches the bridge as UTF-8 text, so raw
-- deflate bytes wouldn't survive it; base64 does. The client has both halves and
-- the inverse pair to check them. In wow-ui-source's forever branch at bd2470a
-- (client 1.60.1.70009), Blizzard_APIDocumentationGenerated/EncodingUtilDocumentation.lua
-- documents CompressString (lines 10-27), DecodeBase64 (28-44), DecompressString
-- (61-77), EncodeBase64 (108-124) and Enum.CompressionMethod (206-218: Deflate 0,
-- Zlib 1, Gzip 2, so Deflate is raw deflate). Blizzard's CooldownViewer, which
-- loads in Forever ("AllowLoadGameType: standard, camelot"), makes the same calls
-- (CooldownViewerSettingsDataStoreSerialization.lua:269-281).
-- nil, and the body goes as it is, when an API is missing or fails, when the
-- client's own inflate doesn't give back the exact text, or when it's no shorter.
function T.Deflate(text)
	local E = C_EncodingUtil
	if type(text) ~= "string" or type(E) ~= "table" then return nil end
	for _, name in ipairs({ "CompressString", "EncodeBase64", "DecodeBase64", "DecompressString" }) do
		if type(E[name]) ~= "function" then return nil end
	end
	local method = (Enum and Enum.CompressionMethod and Enum.CompressionMethod.Deflate) or 0
	local ok, packed = pcall(E.CompressString, text, method)
	if not ok or type(packed) ~= "string" or packed == "" then return nil end
	local b64
	ok, b64 = pcall(E.EncodeBase64, packed)
	if not ok or type(b64) ~= "string" then return nil end
	b64 = (b64:gsub("%s+", "")) -- in case the client wraps its lines
	if b64 == "" or #b64 >= #text or b64:find("[^%w%+/=]") then return nil end
	local raw, back
	ok, raw = pcall(E.DecodeBase64, b64)
	if not ok or type(raw) ~= "string" then return nil end
	ok, back = pcall(E.DecompressString, raw, method)
	if not ok or back ~= text then return nil end
	return b64
end

local function KeyN(key)
	return tonumber(tostring(key):match("^%x%x%x%x_(%d+)$"))
end

function T.KeyOfThisSession(key)
	return R.nonce ~= nil and tostring(key):sub(1, 5) == R.nonce .. "_"
end

-- R.out is built from db.outbox, whose hex is the one source of truth. Unkeyed
-- entries (a hello or seen left there by the reload path) belong to the
-- session that wrote them and are dropped.
function T.LoadOutbox()
	local keep = {}
	for _, e in ipairs(ns.db.outbox) do
		local wire = ns.FromHex(e.hex)
		local rec = T.ParseRecord(wire)
		local n = KeyN(e.key)
		-- One without a cursor the bridge will never ack: it goes, or it would
		-- stay on the strip for good (an old Check for Updates).
		-- A voice command (vc) is only for the moment it was pressed: one left from before a reload
		-- isn't drawn again (odd/tasks/nqa-voice-controls.md T12, Astra review 6).
		if rec and n and rec.key == e.key and rec.type ~= "vc" and tonumber(rec.args and rec.args.cur) then
			R.out[e.key] = { wire = wire, type = rec.type, chat = rec.chat, cur = tonumber(rec.args.cur) or 0, n = n }
			R.sentAt[e.key] = GetTime() -- on the strip again from now
			-- [DR-07] In SavedVariables at the last logout or /reload, so the app has read it:
			-- judged as delivered or refused from this session's first slot load (T.Undelivered).
			R.carried[e.key] = true
			table.insert(keep, e)
		end
	end
	ns.db.outbox = keep
end

-- A keyed record: the next n, key <nonce>_<n>, into db.outbox until acked (§2.3).
-- Every keyed record carries the cursor (PROTOCOL §2.1): the bridge rejects
-- one without, never acks it, and an unacked record stays on the strip, even
-- through a /reload (0.4.0 to 0.4.4's Check for Updates did). A caller that
-- leaves it out gets it first.
function T.NewKeyed(rtype, chatId, args, body)
	-- No app has answered this install: there's no one to tell, and nothing is drawn.
	if not T.Linked() then return nil end
	local db = ns.db
	local hasCur = false
	for _, a in ipairs(args) do if a[1] == "cur" then hasCur = true end end
	if not hasCur then
		local withCur = { { "cur", db.cursor } }
		for _, a in ipairs(args) do withCur[#withCur + 1] = a end
		args = withCur
	end
	db.sendCounter = math.floor(db.sendCounter) + 1
	local n = db.sendCounter
	local key = R.nonce .. "_" .. ns.Int(n)
	local wire = T.Record(key, rtype, chatId, args, body)
	table.insert(db.outbox, { key = key, hex = ns.ToHex(wire) })
	R.out[key] = { wire = wire, type = rtype, chat = chatId, cur = db.cursor, n = n }
	R.sentAt[key] = GetTime()
	T.RefreshStrip()
	return key
end

-- The reload path keeps this session's hello and latest seen in db.outbox too
-- (key = the nonce), so they reach the bridge with the next SavedVariables write.
function T.PutUnkeyed(wire, rtype)
	local db = ns.db
	for i = #db.outbox, 1, -1 do
		local e = db.outbox[i]
		if e.key == R.nonce then
			local rec = T.ParseRecord(ns.FromHex(e.hex))
			if rec and rec.type == rtype then table.remove(db.outbox, i) end
		end
	end
	table.insert(db.outbox, { key = R.nonce, hex = ns.ToHex(wire) })
end

-- How long the oldest record on the strip has waited unread, once that's
-- CAPTURE_WARN or more while the bridge is up and the strip is the way out;
-- else nil. What the player sees of a stuck send is T.StuckWords' (DR-07).
function T.StripStalled()
	if T.OutboxDepth() == 0 or not T.StripOut() or not T.BridgeAlive() or T.SlotOnly() then return nil end
	local oldest
	for key in pairs(R.out) do
		local at = R.sentAt[key]
		if at and (not oldest or at < oldest) then oldest = at end
	end
	local waited = oldest and GetTime() - oldest
	return (waited and waited >= T.CAPTURE_WARN) and waited or nil
end

function T.OutboxDepth()
	local n = 0
	for _ in pairs(R.out) do n = n + 1 end
	return n
end

-- [code health BR-02, the addon half] At most this many typed messages wait for their
-- ack, the app's own typed guard's number (more than 20 in a minute pause sending): on
-- the reload path they all reach the app in one write, so a macro or a loop could
-- otherwise queue paid messages without end. Chats.Send refuses the next one.
T.TYPED_MAX = 20

-- Typed messages waiting for their ack (on the strip, or for a reload).
function T.TypedWaiting()
	local n = 0
	for _, o in pairs(R.out) do
		if o.type == "msg" then n = n + 1 end
	end
	return n
end

function T.Reported(cur)
	local db = ns.db
	cur = math.floor(tonumber(cur) or 0)
	if cur > db.reported then db.reported = cur end
	if db.reported >= db.cursor then
		R.applyBytes = 0
		R.unreportedSince = nil
	end
end

function T.Acked(key, via)
	local db = ns.db
	for i, e in ipairs(db.outbox) do
		if e.key == key then
			table.remove(db.outbox, i)
			break
		end
	end
	local o = R.out[key]
	-- [code health AD-17] Its strip clocks go with it, as a Discard's do (T.BusyFollow
	-- times a run by its send's own time).
	R.out[key], R.sentAt[key], R.vis[key], R.missed[key], R.carried[key] = nil, nil, nil, nil, nil
	if o then
		T.Reported(o.cur)
		ns.Chats.OnAcked(key, o)
		if ns.Companion then ns.Companion.Call("OnAcked") end
	end
	R.acks[via] = (R.acks[via] or 0) + 1
	if via ~= "inbox" then R.lastAckAt = GetTime() end
	T.NoteBridge()
	T.RefreshStrip()
	ns.Refresh()
end

---------------------------------------------------------------------------
-- The strip (§2.1)
---------------------------------------------------------------------------

local strip
local cellPool = {}
-- [code health AD-03] The strip as drawn: each cell's value, how many cells are shown,
-- and the table every frame is encoded into. A frame touches only the cells that
-- changed (a full draw was 16,800 widget calls and 160 KB of garbage, twice a send).
local cellVal, cellsShown, frameCells = {}, 0, {}

local function StripScale()
	local physH
	if type(GetPhysicalScreenSize) == "function" then
		local ok, _, h = pcall(GetPhysicalScreenSize)
		if ok and type(h) == "number" and h > 0 then physH = h end
	end
	return 768 / (physH or 1080)
end

function T.EnsureStrip()
	if strip then return strip end
	strip = CreateFrame("Frame", "NQAStrip", UIParent)
	strip:SetFrameStrata("TOOLTIP")
	strip:SetFrameLevel(10000)
	-- Scale so that one UI unit is exactly one physical pixel (see Blizzard's PixelUtil).
	if strip.SetIgnoreParentScale then strip:SetIgnoreParentScale(true) end
	-- [DR-08] Nor its alpha: a UIParent another addon fades (to 0.6, say) would blend
	-- the cells into the world and fail their checksum (D-21). Alt+Z still hides it.
	if strip.SetIgnoreParentAlpha then strip:SetIgnoreParentAlpha(true) end
	strip:SetScale(StripScale())
	strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
	strip:SetSize(CELLS_PER_ROW * CELL, MAX_ROWS * CELL)
	strip:Hide()
	T.PlaceStripLabel()
	return strip
end

-- Upstream issue #8: follow UI_SCALE_CHANGED and DISPLAY_SIZE_CHANGED.
function T.UpdateStripScale()
	if strip then strip:SetScale(StripScale()) end
	T.PlaceStripLabel()
end

-- [ingame-clarity] What the strip is, in words, beside it (a player, 2026-10-05: "I have no idea
-- what this is at the top of my screen"). A child of the strip, so it shows and hides with it, at
-- the interface's own scale, so its words are the size of the rest of the UI. It never sits where a
-- decoder reads: the decoders read only their search box at the strip's top-left and the strip's own
-- cells, at a geometry they measure from the strip, all inside the strip's whole area (200 cells by
-- 48 rows, however many rows a frame draws) and the 8-pixel margin every capture keeps past it
-- (decoder.c WC_CROP_MARGIN, Capture.swift stripMarginPx, capture_x11.py SLACK). The label starts
-- LABEL.GAP past that area: right of it, or, on a screen too narrow for that, under it.
-- tests/strip_label_test.mjs proves the decoders never read it, at every row count, screen width and
-- capture scale.
local LABEL = {
	TEXT = "Sending to the NeverQuestAlone app…",
	-- Screen reading just turned off: the strip tells the app so one last time (the mode seen), for a
	-- few seconds, while the notice says nothing is drawn any more (UI critic C-09).
	STOPPING = "Stopping screen reading…",
	GAP = 16, -- strip pixels between the strip's whole area and the label (the capture's margin is 8)
	EDGE = 8, -- strip pixels kept clear of the screen's right edge
	PAD_X = 8, PAD_Y = 6, ICON = 16, ICON_GAP = 6, -- label units: the tooltip frame's padding, the mark
	MIN_TEXT = 140, -- label units for the words beside the strip, at the least (two lines of them); less, and it goes under
}
local label

-- The screen's width in strip pixels (one strip pixel is one physical pixel), and how many strip
-- pixels one of the label's units is (the UI scale's units, which the label draws in).
local function LabelMetrics()
	local ss = StripScale()
	local us = ns.Try(UIParent.GetEffectiveScale, UIParent)
	if type(us) ~= "number" or us <= 0 then us = ss end
	local w = ns.Try(UIParent.GetWidth, UIParent)
	local screen = type(w) == "number" and w > 0 and w * us / ss or nil
	if not screen then
		local ok, pw = pcall(GetPhysicalScreenSize)
		screen = ok and type(pw) == "number" and pw or CELLS_PER_ROW * CELL
	end
	return us / ss, screen
end

-- Where the label goes, in strip pixels from the strip's top-left (y down), for a screen `screen`
-- strip pixels wide, k strip pixels to a label unit and words `textW` label units long on one line.
-- Returns x, y and the words' wrap width in label units (nil: one line). Beside the strip's whole
-- area on one line, else beside it wrapped, else under its whole 48 rows.
function T.StripLabelPlace(screen, k, textW)
	local L = LABEL
	local chrome = 2 * L.PAD_X + L.ICON + L.ICON_GAP
	local besideX = CELLS_PER_ROW * CELL + L.GAP
	local room = math.floor((screen - besideX - L.EDGE) / k) - chrome
	if room >= textW then return besideX, 0, nil end
	if room >= L.MIN_TEXT then return besideX, 0, room end
	local under = math.floor((screen - 2 * L.EDGE) / k) - chrome
	return 0, MAX_ROWS * CELL + L.GAP, (under < textW) and math.max(L.MIN_TEXT, under) or nil
end

-- The label's words for what the strip carries now: sending; or, while it tells the app that screen
-- reading is off (the mode seen, with nothing else going out on it), stopping.
function T.StripLabelWords()
	local s = R.seen
	if not T.StripOut() and s and (s.mode == "stream" or s.mode == "reload") then return LABEL.STOPPING end
	return LABEL.TEXT
end

-- The label made once, then placed for the screen as it is and the words it says (at the strip's
-- making, at every UI scale or display change, and when its words change).
function T.PlaceStripLabel()
	if not strip then return end
	local L = LABEL
	if not label then
		-- The HUD's bar's frame: the game's tooltip frame, its dark centre and gold edge.
		local U = ns.UI
		if not (U and U.Create and U.Child) then return end
		local f, tpl = U.Create("Frame", "NQAStripLabel", strip, { "TooltipBackdropTemplate", "BackdropTemplate" })
		local nine = U.Child(f, "NineSlice")
		if tpl == "TooltipBackdropTemplate" and nine then
			ns.Call(nine, "SetCenterColor", 0.08, 0.07, 0.06, 0.94)
			ns.Call(nine, "SetBorderColor", 0.78, 0.62, 0.3, 1)
		elseif f.SetBackdrop then
			f:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
				tile = true, tileSize = 16, edgeSize = 16, insets = { left = 4, right = 4, top = 4, bottom = 4 } })
			f:SetBackdropColor(0.08, 0.07, 0.06, 0.94)
			f:SetBackdropBorderColor(0.78, 0.62, 0.3, 1)
		else
			local bg = f:CreateTexture(nil, "BACKGROUND")
			bg:SetAllPoints()
			bg:SetColorTexture(0.08, 0.07, 0.06, 0.94)
		end
		ns.Call(f, "EnableMouse", false) -- the world under it still takes clicks
		f.mark = f:CreateTexture(nil, "ARTWORK")
		f.mark:SetSize(L.ICON, L.ICON)
		f.mark:SetTexture("Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone")
		f.mark:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD_X, -(L.PAD_Y - 1))
		f.words = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
		f.words:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD_X + L.ICON + L.ICON_GAP, -L.PAD_Y)
		f.words:SetJustifyH("LEFT")
		f.words:SetJustifyV("TOP")
		label = f
	end
	local k, screen = LabelMetrics()
	label:SetScale(k)
	local fs = label.words
	label.text = T.StripLabelWords()
	fs:SetWidth(0) -- measured on one line, whatever it held
	fs:SetText(label.text)
	local textW = math.ceil(ns.Try(fs.GetUnboundedStringWidth, fs) or ns.Try(fs.GetStringWidth, fs) or 200) + 1
	local x, y, wrap = T.StripLabelPlace(screen, k, textW)
	fs:SetWordWrap(wrap ~= nil)
	fs:SetWidth(wrap or textW)
	local textH = math.max(L.ICON - 2, math.ceil(ns.Try(fs.GetStringHeight, fs) or 14))
	local w, h = 2 * L.PAD_X + L.ICON + L.ICON_GAP + (wrap or textW), textH + 2 * L.PAD_Y
	label:SetSize(w, h)
	label:ClearAllPoints()
	label:SetPoint("TOPLEFT", strip, "TOPLEFT", x / k, -y / k)
	label.rect = { x = x, y = y, w = w * k, h = h * k, k = k, wrap = wrap }
end

-- The label's rectangle in strip pixels from the strip's top-left (y down): { x, y, w, h, k, wrap },
-- or nil before the strip is first drawn.
function T.StripLabelRect()
	return label and label.rect or nil
end

-- full: every cell coloured and shown again, and the rest of the pool hidden again, whatever
-- the strip is thought to hold (the self-heal, T.Heal).
local function DrawCells(frameId, payload, full)
	local t0 = R.perf and R.perf.clock() -- [SY-27] timed only while /bones perf measures
	local cells = Codec.Encode(frameId % 65536, payload, frameCells)
	local s = T.EnsureStrip()
	local rows = math.ceil(#cells / CELLS_PER_ROW)
	local total = rows * CELLS_PER_ROW
	for i = 1, total do
		local t = cellPool[i]
		if not t then
			t = s:CreateTexture(nil, "OVERLAY")
			t:SetSize(CELL, CELL)
			local c = (i - 1) % CELLS_PER_ROW
			local r = math.floor((i - 1) / CELLS_PER_ROW)
			t:SetPoint("TOPLEFT", s, "TOPLEFT", c * CELL, -r * CELL)
			cellPool[i] = t
		end
		-- [code health AD-03] A colour only where the value changed, Show only where it was hidden.
		local v = cells[i] or 0
		if full or cellVal[i] ~= v then
			cellVal[i] = v
			local cr, cg, cb = Codec.CellColor(v)
			t:SetColorTexture(cr, cg, cb, 1)
		end
		if full or i > cellsShown then t:Show() end
	end
	-- The rows this frame dropped (the rest of the pool is hidden already).
	for i = total + 1, full and #cellPool or cellsShown do
		cellPool[i]:Hide()
	end
	cellsShown = total
	s:Show()
	-- [code health AD-03] The self-heal's clocks start again: this frame's own, and a full draw's.
	local H = R.heal
	H.drawn = 0
	if full then H.full = 0 end
	if t0 and R.perf then T.PerfAdd(R.perf.clock() - t0, true) end -- [SY-27]
end

function T.HideStrip()
	if strip then strip:Hide() end
	R.stripShown = false
	R.stripPayload = nil
	R.stripWaits = false
end

-- What the strip carries now: unacked keyed records, the hello until the bridge
-- confirms it, the companion's state until the bridge has its seq (beside
-- records, or alone for a few seconds), and a seen for a few seconds. Sorted
-- newest first. waits: the bridge answers it (an ack, the hello's answer).
function T.StripEntries()
	local list = {}
	if not T.StripOut() then
		-- [DR-08] The mode seen that says the strip is no longer the way out stays its few seconds.
		local s = R.seen
		if s and s.mode and GetTime() < s.untilT then list[1] = { wire = s.wire, order = s.order, untilT = s.untilT } end
		return list
	end
	for _, o in pairs(R.out) do
		list[#list + 1] = { wire = o.wire, order = o.n, waits = true }
	end
	local keyed = #list
	local now = GetTime()
	local st = R.stateRec
	local bridgeHas = st and R.bridgeStateSeq == st.seq and (R.bridgeStateSid == nil or R.bridgeStateSid == st.sid)
	if st and not bridgeHas and (keyed > 0 or (st.untilT and now < st.untilT)) then
		list[#list + 1] = { wire = st.wire, order = st.order, untilT = st.untilT, state = true }
	end
	local h = R.hello
	if h and not h.confirmed and not h.viaOutbox and ((h.drawUntil and now < h.drawUntil) or #list > 0) then
		list[#list + 1] = { wire = h.wire, order = h.order, untilT = #list == 0 and h.drawUntil or nil, waits = true }
	end
	local s = R.seen
	if s and now < s.untilT then
		list[#list + 1] = { wire = s.wire, order = s.order, untilT = s.untilT }
	end
	table.sort(list, function(a, b) return a.order > b.order end)
	return list
end

-- Would the companion's state reach the bridge in the same strip frame as a new
-- record of this wire? The state is drawn after every other record (§2.6), so
-- only if they all fit one frame. True when no state waits for the strip: the
-- bridge has it, or the reload path writes it ahead of the record.
function T.StateFitsWith(wire)
	local size, state = #wire, false
	for _, e in ipairs(T.StripEntries()) do
		size = size + 1 + #e.wire
		state = state or e.state == true
	end
	return not state or size <= ns.MAX_PAYLOAD
end

-- Records are drawn newest first until the payload would pass 3,200 bytes;
-- older ones wait for a later frame (§2.2). The frame counter changes whenever
-- the content does. R.stripUntil is when a timed entry (a seen, or a hello on
-- its own) leaves again.
function T.RefreshStrip()
	if not ns.db or not R.nonce then return end
	local parts, size, waits = {}, 0, false
	local now, untilT = GetTime(), nil
	for _, e in ipairs(T.StripEntries()) do
		local add = #e.wire + (#parts > 0 and 1 or 0)
		if size + add > ns.MAX_PAYLOAD then break end
		parts[#parts + 1] = e.wire
		size = size + add
		waits = waits or e.waits == true
		if e.untilT and e.untilT > now and (not untilT or e.untilT < untilT) then untilT = e.untilT end
	end
	R.stripUntil = untilT
	R.stripWaits = waits -- [code health AD-03] what's drawn waits for the bridge's answer (T.Heal)
	if #parts == 0 then
		if R.stripShown then T.HideStrip() end
		return
	end
	local payload = table.concat(parts, ns.RS)
	if label and label.text ~= T.StripLabelWords() then T.PlaceStripLabel() end -- [C-09] its words, before it shows
	if payload ~= R.stripPayload or not R.stripShown then
		R.frame = (R.frame + 1) % 65536
		DrawCells(R.frame, payload)
		R.stripPayload = payload
		R.stripShown = true
	elseif strip and not strip:IsShown() then
		-- [DR-08] Another addon hid it (a frame hider): shown again, at the next refresh
		-- (every 2 s at most), so a message never waits on a strip nobody can see (D-37).
		strip:Show()
	end
end

-- [code health AD-03] The self-heal. A frame changes only the cells whose value changed
-- (DrawCells), so a cell left wrong (another addon recolouring a texture, say) would stay
-- wrong, and the app would stop reading the strip and the replies stop without a word. So
-- while what's drawn waits for the bridge's answer (a record's ack, the hello's), with the
-- bridge up, it's drawn again in full: once a frame that has waited T.HEAL_ACK, and every
-- T.HEAL_EVERY however often it changes. dt: visible seconds since the last tick; onScreen:
-- T.StripOnScreen(), which time off screen doesn't count. Each counted for /bones diag (R.heal).
function T.Heal(dt, onScreen)
	local H = R.heal
	-- An ack or the hello's answer after a full draw: what the draw likely repaired.
	if H.lastAt and not H.answered and R.lastAckAt and R.lastAckAt > H.lastAt then
		H.answered = true
		if R.lastAckAt - H.lastAt <= T.HEAL_ACK then H.heard = H.heard + 1 end
	end
	if not (R.stripWaits and R.stripShown and T.StripOut() and T.BridgeAlive()) then
		H.drawn, H.full = 0, 0
		return
	end
	if not onScreen then return end
	H.drawn, H.full = H.drawn + dt, H.full + dt
	local why = (H.drawn >= T.HEAL_ACK and H.frame ~= R.frame and "ack") or (H.full >= T.HEAL_EVERY and "timer") or nil
	if not why then return end
	H.frame = R.frame
	H[why] = H[why] + 1
	H.lastAt, H.answered = GetTime(), false
	DrawCells(R.frame, R.stripPayload, true)
end

---------------------------------------------------------------------------
-- [DR-07, DR-08, DR-09] Display health: the stuck send, the self-probe,
-- the mode seen and the capture state's words (display design rev 5)
---------------------------------------------------------------------------

-- The game's interface is on screen: not Alt+Z, a cinematic, a movie or a
-- loading screen (they hide UIParent, and the strip with it).
function T.UIVisible()
	if type(UIParent) ~= "table" or type(UIParent.IsVisible) ~= "function" then return true end
	return UIParent:IsVisible() and true or false
end

-- The strip is drawn and on screen, where the app can read it.
function T.StripOnScreen()
	return (R.stripShown and strip ~= nil and strip:IsVisible() and T.UIVisible()) and true or false
end

-- The state the bridge publishes under cap capture (bridge.capture.state), or nil.
function T.CaptureState()
	local b = R.bridge
	if not ns.HasCap("capture") or type(b) ~= "table" or type(b.capture) ~= "table" then return nil end
	return ns.Str(b.capture.state, 20)
end

-- The contract's non-ok states that name a cause (bridge/transport/capture-health.mjs).
-- Any other key names none, "minimized" and "unknown" (an older bridge's) among them:
-- a wrong cause is worse than none (SY-20).
T.CAUSES = { no_permission = true, no_signal = true, blocked = true, damaged = true, unsupported = true }

-- The published cause, once it has held T.CAUSE_AFTER of visible time, else nil.
function T.CaptureCause()
	local st, c = T.CaptureState(), R.cap
	if not st or not T.CAUSES[st] or not c or c.state ~= st or c.vis < T.CAUSE_AFTER then return nil end
	return st
end

-- Each cause in the player's words: { head (a status, 28 characters or fewer), next (the
-- one thing to do), text (the whole of it) }. key_mac: a Mac's, where they differ (a Mac
-- can't have its corner covered, SY-24's and the design's Layer 2; Screen Recording is
-- named only on a Mac and only when macOS took it away).
T.CAUSE_WORDS = {
	no_signal = { "NeverQuestAlone can't see the game", "Keep the top of WoW's window on screen.", "NeverQuestAlone can't see the game: keep the top of WoW's window on screen." },
	no_signal_mac = { "NeverQuestAlone can't see the game", "See why in the NeverQuestAlone app.", "NeverQuestAlone can't see the game: see why in the NeverQuestAlone app." }, -- [C-139] the app is running (BridgeAlive gates it)
	no_permission = { "NeverQuestAlone can't see the game", "Keep the top of WoW's window on screen.", "NeverQuestAlone can't see the game: keep the top of WoW's window on screen." },
	no_permission_mac = { "macOS stopped screen reading", "Allow it on your Mac.", "macOS stopped screen reading: allow it on your Mac." },
	blocked = { "NeverQuestAlone can't see the game", "Close what blocks screen reading.", "NeverQuestAlone can't see the game: close what blocks screen reading." },
	damaged = { "NeverQuestAlone can't see the game", "Reinstall the app.", "NeverQuestAlone can't see the game: reinstall the app." },
	unsupported = { "NeverQuestAlone can't read this screen", "Type /nqa mode reload to use NeverQuestAlone with no screen reading.",
		"NeverQuestAlone can't read this screen: type /nqa mode reload to use NeverQuestAlone with no screen reading." },
}
function T.CauseWords(st)
	local mac = type(IsMacClient) == "function" and IsMacClient()
	local w = (mac and T.CAUSE_WORDS[tostring(st) .. "_mac"]) or T.CAUSE_WORDS[st]
	if not w then return nil end
	return { head = ns.P(w[1]), next = ns.P(w[2]), text = ns.P(w[3]) }
end

-- Stuck (DR-07): how many visible seconds the oldest record has waited on the
-- strip unread, once that's T.STUCK_AFTER or more, while the strip is the way
-- out and the bridge is up; else nil. In slot-only mode acks come only with
-- slot loads, so it also needs one, taken T.MISS_AFTER or more after the send,
-- that came back without the ack (T.NoteLoad). A record carried over a Reload
-- isn't stuck: that Reload delivered it or it was refused (T.Undelivered).
function T.StuckSend()
	if T.OutboxDepth() == 0 or not T.StripOut() or not T.BridgeAlive() then return nil end
	local most
	for key in pairs(R.out) do
		local v = R.vis[key] or 0
		if not R.carried[key] and v >= T.STUCK_AFTER and (not T.SlotOnly() or R.missed[key]) and (not most or v > most) then most = v end
	end
	return most
end

-- Refused (SY-11, SY-29): the keys the last Reload (or logout) put in SavedVariables
-- that are still unacked T.STUCK_AFTER of visible strip time after this session's
-- first slot load (so the bridge read the file and didn't take them), sorted; else nil.
function T.Undelivered()
	if not R.firstLoadAt or not T.StripOut() or not T.BridgeAlive() then return nil end
	local list
	for key in pairs(R.carried) do
		if R.out[key] and (R.vis[key] or 0) >= T.STUCK_AFTER and (not T.SlotOnly() or R.missed[key]) then
			list = list or {}
			list[#list + 1] = key
		end
	end
	if list then table.sort(list) end
	return list
end

-- A slot load came back (mine): the records it didn't ack were drawn long enough
-- ago to have been read (slot-only's proof), and the first one starts a
-- carried record's clock (SY-29: not the new hello's answer, which a blind
-- strip never gets).
function T.NoteLoad()
	local now = GetTime()
	for key in pairs(R.out) do
		local at = R.sentAt[key]
		if at and now - at >= T.MISS_AFTER then R.missed[key] = true end
	end
	if not R.firstLoadAt then
		R.firstLoadAt = now
		for key in pairs(R.carried) do R.vis[key] = 0 end
	end
end

-- Discard (after a Reload that didn't deliver): the refused records leave
-- db.outbox and the strip; their messages say they weren't sent. Returns how many.
function T.Discard(keys)
	keys = keys or T.Undelivered()
	if not keys or #keys == 0 then return 0 end
	local db = ns.db
	for _, key in ipairs(keys) do
		for i = #db.outbox, 1, -1 do
			if db.outbox[i].key == key then table.remove(db.outbox, i) end
		end
		local o = R.out[key]
		R.out[key], R.sentAt[key], R.vis[key], R.missed[key], R.carried[key] = nil, nil, nil, nil, nil
		if o then ns.Chats.OnDiscarded(key, o) end
	end
	R.stuckKey = nil
	T.RefreshStrip()
	ns.Refresh()
	return #keys
end

-- The stuck state in the player's words, or nil: { action ("reload" or "discard"),
-- sub (the HUD's one line under "Sending…"; nil: the time and "not read yet"),
-- short (the bar, a warn line's head), next (a warn line's second line), line (the
-- window's one-line status), text (the whole of it: the banner, the HUD's details) }.
-- One action each: Reload sends it (the app reads the saved file too), Discard
-- drops what a Reload couldn't deliver.
function T.StuckWords()
	if T.Undelivered() then
		return { action = "discard", sub = "Didn't go through", short = "Didn't go through", next = "Click Discard, then send it again.",
			line = "Your message didn't go through.", text = "Your message didn't go through. Click Discard, then send it again." }
	end
	if not T.StuckSend() then return nil end
	local cause = T.CaptureCause()
	local c = cause and T.CauseWords(cause)
	if c then
		local text = ns.Fill("{cause}. Click Reload to send your message.", { cause = c.head })
		return { action = "reload", sub = c.head, short = c.head, next = "Click Reload to send your message.", line = text, text = text }
	end
	return { action = "reload", short = "Not read yet", next = "Click Reload to send it.", line = ns.P("NeverQuestAlone hasn't read your message yet."),
		text = ns.P("NeverQuestAlone hasn't read your message yet. Click Reload to send it.") }
end

-- A seen record (§2.4) for now's cursor and push counter, with slot= in the public
-- build and one more arg when given: its wire, and the strip entry it makes.
function T.SeenRecord(extra)
	local db, P = ns.db, R.push
	local args = { { "cur", db.cursor } }
	if P.known and P.known > 0 then args[2] = { "p", P.known } end
	local withP = args[2] ~= nil -- [SY-03] slot= may come after it
	args[#args + 1] = { "slot", R.slots.nextIndex }
	R.slots.reported = R.slots.nextIndex
	if extra then args[#args + 1] = extra end
	local wire = T.Record(R.nonce, "seen", "", args, "")
	return wire, { wire = wire, cur = db.cursor, p = withP and P.known or nil, order = db.sendCounter + 0.75, untilT = GetTime() + SEEN_DWELL }
end

-- The self-probe (DR-08, SY-14e): while no_signal is published, a seen on the strip
-- for a few seconds every T.PROBE_EVERY of visible time, so the bridge learns that
-- capture reads again (R6) within a minute of it doing so. No slot load. None for
-- the other states: the helper's own "cleared" ends those.
function T.SelfProbe()
	if R.seen or not R.nonce or not T.StripOut() then return end
	local _, seen = T.SeenRecord()
	R.seen = seen
	R.probes = (R.probes or 0) + 1
	T.RefreshStrip()
end

-- The mode seen (DR-08, SY-12, SY-17b): when the way records go out changes, a seen
-- with mode= at once, on the strip (off it, it stays its few seconds before the strip
-- goes) and in the outbox, so the bridge learns it by whichever way still works.
function T.SayMode()
	local m = T.ModeWord()
	if not R.hello or not R.nonce or m == R.saidMode then return end
	R.saidMode = m
	T.NoteToldOff(m)
	local wire, seen = T.SeenRecord({ "mode", m })
	seen.mode = m
	R.seen = seen
	T.PutUnkeyed(wire, "seen")
	T.RefreshStrip()
end

-- Every tick: the clocks move by the time since the last one (at most 1 s: a hitch
-- isn't visible time), the strip's self-heal and the self-probe get their turns, and a
-- change in the stuck state redraws what shows it (the bubbles' labels, the banner, the HUD).
function T.Clocks(now)
	local dt = R.clockAt and math.max(0, math.min(1, now - R.clockAt)) or 0
	R.clockAt = now
	local onScreen = T.StripOnScreen()
	if onScreen then
		for key in pairs(R.out) do R.vis[key] = (R.vis[key] or 0) + dt end
	end
	T.Heal(dt, onScreen) -- [code health AD-03]
	local st = T.CaptureState()
	if not R.cap or R.cap.state ~= st then
		R.cap = { state = st, vis = 0 }
		R.probeVis = 0
	end
	local ui = T.UIVisible()
	if ui then R.cap.vis = R.cap.vis + dt end
	if st == "no_signal" and R.hello and T.StripOut() then
		if ui then R.probeVis = R.probeVis + dt end
		if R.probeVis >= T.PROBE_EVERY then
			R.probeVis = 0
			T.SelfProbe()
		end
	end
	local failed = T.Undelivered()
	local key = failed and ("discard:" .. table.concat(failed, ",")) or (T.StuckSend() and "reload") or nil
	if key ~= R.stuckKey then
		R.stuckKey = key
		for _, o in pairs(R.out) do
			if o.chat and o.chat ~= "" then R.rev[o.chat] = (R.rev[o.chat] or 0) + 1 end
		end
		ns.Refresh()
	end
end

---------------------------------------------------------------------------
-- The bridge's pulse
---------------------------------------------------------------------------

function T.NoteBridge(at)
	at = at or GetTime()
	if not R.bridgeSeenAt or at > R.bridgeSeenAt then R.bridgeSeenAt = at end
end

function T.BridgeAge()
	return R.bridgeSeenAt and math.max(0, GetTime() - R.bridgeSeenAt) or nil
end

-- Without presence beats (slot-only mode) the bridge is only heard from on a
-- slot load, at least every IDLE_CHECK, so red waits that much longer.
function T.RedAfter()
	return T.SlotOnly() and (IDLE_CHECK + RED_AFTER) or RED_AFTER
end

function T.BridgeAlive()
	local age = T.BridgeAge()
	return age ~= nil and age < T.RedAfter()
end

function T.Beat()
	R.lastBeatAt = GetTime()
	T.NoteBridge()
	T.Heard()
end

-- [UX-1] The backend's state in the provider's words (PRD §10 and §16.4), for
-- the light, the HUD and the window's header: nil without rt (an older
-- bridge, or a slot whose provider part failed). light: its colour; head and sub: the
-- status line and its second line (none when ready); ring: the HUD's dot;
-- red: the status line is red (the player has to act), else gold; spend: a
-- state the usage also reports (usage.needs), which the status line says for
-- both; badge: a few words for the small bar; short: for the one-line HUD.
-- Slowed isn't a spend state: it passes on its own, so nothing asks for an Okay.
local RT_LIGHT = {
	ready = "green", slowed = "yellow", cap = "yellow", provider_down = "yellow",
	no_key = "grey", paused = "grey", key_invalid = "red", out_of_credit = "red", local_down = "red",
}
local RT_SPEND = { cap = true, out_of_credit = true, key_invalid = true }
local RT_RED = { cap = true, out_of_credit = true, key_invalid = true, local_down = true }
function T.RetryIn()
	local rt = ns.RT()
	local n = rt and tonumber(rt.retryIn)
	if not n then return nil end
	return math.max(0, math.floor(n - (GetTime() - (R.rtAt or GetTime())) + 0.5))
end
-- Slow mode (UX-1): the signals failed while the strip is out, so replies come
-- on the slot timer. In the player's words (never "slot-only mode"): what it is
-- and what to do ("" when there's nothing to do in game), or nil. With no
-- screen reading (stream and reload modes) it's slot-only by design, and the
-- status line says that instead. -- [C-05]
function T.SlowMode()
	if not (T.SlotOnly() and T.StripOut() and R.sig.static) then return nil end
	-- [UX-W03, UX-W15] what happens and what to do: no "slow mode", no "session"
	if R.sig.static == "sound-off" then return "Replies are slow with game sound off", "Keep Enable Sound on in WoW's sound settings (the volume can be 0)." end
	return "Replies come a little slower for now", ""
end

-- [C-20] When a provider's free daily limit resets, as a local time ("5:00 pm"),
-- from the backend's countdown while the limit holds it (rt cap, retryIn).
-- The provider's day isn't ours, so without it there's no guess at midnight.
function T.FreeResetAt()
	local rt = ns.RT()
	local n = rt and rt.state == "cap" and T.RetryIn()
	if not n or n <= 0 then return nil end
	return ns.Clock(time() + n)
end
function T.RTWords()
	local rt = ns.RT()
	if not rt then return nil end
	local u = ns.Usage()
	local st = rt.state
	local w = { state = st, light = RT_LIGHT[st] or "yellow", ring = RT_RED[st] and "error" or "idle", spend = RT_SPEND[st] == true, red = RT_RED[st] == true }
	-- [UX-W19, UX-W20] The bubble's and the desktop's words (errors.mjs), whole sentences
	-- with named places (§12); a badge is a status, in sentence case (§6).
	local t = { AI = ns.ProviderName(true), app = ns.ProviderName(), company = ns.ProviderOwnName(), model = ns.ModelName() }
	if st == "ready" then
		w.tip = t.model and ns.Fill("Connected to {app} ({model}).", t) or ns.Fill("Connected to {app}.", t)
	elseif st == "no_key" then
		-- No provider chosen yet: the setup checklist's words, not a key for nobody.
		w.head, w.badge = "No key yet", "No key yet"
		w.sub = t.company and ns.Fill("Add your {company} key in the NeverQuestAlone app.", t) or "Connect your AI in the NeverQuestAlone app."
	elseif st == "key_invalid" then
		w.head = t.company and ns.Fill("Your {company} key was rejected", t) or "Your key was rejected"
		w.sub, w.badge, w.short = "Replace it in the NeverQuestAlone app.", "Key rejected", "Key rejected"
	elseif st == "slowed" then
		local n = T.RetryIn()
		t.seconds = (n and n > 0) and ns.DurWords(n) or nil
		w.head = ns.Fill(ns.P("{AI} asked NeverQuestAlone to slow down"), t)
		w.sub, w.badge = t.seconds and ns.Fill("Trying again in {seconds}.", t) or "Trying again shortly.", "Slowed down"
	elseif st == "out_of_credit" then
		w.head = t.company and ns.Fill("Your {company} account is out of credit", t) or "Your account is out of credit"
		w.sub = t.company and ns.Fill("Add credit at {company}, or pick another AI in the NeverQuestAlone app.", t)
			or "Add credit, or pick another AI in the NeverQuestAlone app."
		w.badge, w.short = "Out of credit", "Out of credit"
	elseif st == "cap" and rt.reason == "load_error" then -- [BR-09, UX-W02] held: today's spend couldn't be read, never "reached"
		w.head, w.sub, w.badge, w.short = ns.P("Today's spend couldn't be read, so NeverQuestAlone rests"), "Set your limit again in the NeverQuestAlone app.", "Spend unknown", "Spend unknown"
	elseif st == "cap" and u and (tonumber(u.freeLimit) or 0) > 0 then
		t.limit, t.time = ns.Int(u.freeLimit), T.FreeResetAt()
		w.head, w.badge, w.short = ns.Fill("You've used today's {limit} free requests", t), "Free requests used up", "Free requests used up"
		w.sub = t.time and ns.Fill("It resets at {time}.", t) or "Pick another model in the NeverQuestAlone app, or wait until it resets."
	elseif st == "cap" then
		t.limit = u and tonumber(u.capMicros) and ns.Dollars(u.capMicros) or nil
		w.head = t.limit and ns.Fill("You've reached your daily spend limit ({limit})", t) or "You've reached your daily spend limit"
		w.sub, w.badge, w.short = "Raise it in the NeverQuestAlone app, or it resets at midnight.", "Daily limit reached", "Daily limit reached"
	elseif st == "provider_down" then
		w.head, w.sub, w.badge = ns.Fill("{AI} is busy right now", t), "Trying again…", "Busy"
	elseif st == "local_down" then
		-- The failed message waits for Retry on its bubble (PRD §10): nothing is re-sent by itself.
		w.head, w.badge = ns.Fill(ns.P("NeverQuestAlone can't reach {app}"), t), ns.Fill("Can't reach {app}", t)
		w.sub = ns.Fill("Start {app}, then click Retry on your message.", t)
	elseif st == "paused" then
		w.head, w.sub, w.badge = "NeverQuestAlone is paused", "Messages wait until you resume it in the app.", "Paused"
	else
		w.head = ns.Escape(ns.Str(rt.reason, 80) or ns.Str(st, 40) or "Not ready")
		w.sub = ""
	end
	if w.head then w.tip = w.head .. "." .. (w.sub ~= "" and (" " .. w.sub) or "") end
	return w
end

-- The status light (SD-1, PRD §8.3). Returns a state and its tooltip.
--   green  the app is beating and its AI is ready
--   yellow the app is up, its AI isn't ready (the backend's state, or a
--          reason and the messages that wait)
--   red    no word from the app for 2 min, or a state the player has to fix
--   grey   no key yet, or the app paused
--   wait   just logged in, nothing heard yet
--   paste  no app has answered this install: Copy and Paste
-- [C-05, UX-W03, UX-W10] The app by its name, whole sentences, the time
-- spelled out.
function T.Light()
	local age = T.BridgeAge()
	local gw = type(R.gw) == "table" and R.gw or nil
	local state, tip
	local words = age and age < T.RedAfter() and T.RTWords() or nil -- [UX-1] nil without rt
	local since = GetTime() - (R.loginAt or GetTime())
	-- At login the inbox's word is the bridge's last publish, from before the
	-- game started: until this session's hello is answered, that's no reason
	-- for red (a false alarm at most logins, and a layout that jumps when the
	-- hello lands). Red after RedAfter from login, with the real silence.
	local stale = age and age >= T.RedAfter() and not R.helloAnswered and since < T.RedAfter()
	if not T.Linked() and not age then
		return "paste", "Copy and Paste: each message opens a window where you copy it into your AI and paste its reply back. With the NeverQuestAlone app, replies come back by themselves: type /nqa app for the link."
	end
	if not age or stale then
		if since < T.RedAfter() then
			state, tip = "wait", "Waiting to hear from the NeverQuestAlone app…"
		else
			state = "red"
			tip = ns.Fill("No word from the NeverQuestAlone app for {duration}. Is it running?", { duration = ns.DurWords(math.max(120, since)) })
		end
	elseif age >= T.RedAfter() then
		state = "red"
		tip = ns.Fill("No word from the NeverQuestAlone app for {duration}. Is it running?", { duration = ns.DurWords(math.max(120, age)) })
	elseif words then -- [UX-1] the backend's own state picks it, in the provider's words
		state, tip = words.light, table.concat({ words.tip, ns.Fill("Last heard from the NeverQuestAlone app {duration} ago.", { duration = ns.DurWords(age) }) }, " ")
	elseif gw and gw.state == "ready" then
		state = "green"
		tip = ns.Fill("Connected to {AI}. Last heard from the NeverQuestAlone app {duration} ago.", { AI = ns.ProviderName(), duration = ns.DurWords(age) })
	elseif gw then
		-- The app's own state, where its provider part didn't report (UX-1): the
		-- provider by its name, and why ("connecting", "no key").
		state = "yellow"
		local queued = math.floor(tonumber(gw.queued) or 0)
		local t = { AI = ns.ProviderName(), reason = ns.Escape(gw.reason or gw.state or "unknown") }
		local said = { ns.Fill("The NeverQuestAlone app is running but can't reach {AI}: {reason}.", t) }
		if queued > 0 then said[2] = ns.Plural(queued, "1 message waits.", "{n} messages wait.") end
		tip = table.concat(said, " ")
	else
		state, tip = "yellow", "The NeverQuestAlone app is running. Waiting for its first report…" -- [UX-W03]
	end
	if T.SlotOnly() and T.StripOut() and R.sig.static then -- [UX-W03] no slow mode, no plumbing (none by design: no screen reading)
		if R.sig.static == "sound-off" then
			tip = table.concat({ tip, "Replies are slow with game sound off: keep Enable Sound on in WoW's sound settings (the volume can be 0)." }, "\n")
		else
			tip = table.concat({ tip, "Replies arrive more slowly for now. A /reload usually fixes it." }, "\n")
		end
	end
	if R.bridgeWarn then
		tip = table.concat({ tip, ns.Fill("A note from the NeverQuestAlone app: {text}", { text = ns.Escape(R.bridgeWarn) }) }, "\n")
	end
	return state, tip
end

---------------------------------------------------------------------------
-- Self-test (§3)
---------------------------------------------------------------------------

-- Static part: present.wav plays and a fresh absent_* name doesn't.
function T.SelfTest()
	local S = R.sig
	local wasOK = T.SignalsOK()
	local wasStatic = S.static
	S.lastRun = GetTime()
	S.error = nil
	local reason
	if type(PlaySoundFile) ~= "function" then
		reason = "no-playsoundfile"
	else
		local present = Probe(SigPath("ctl", "present"))
		R.absentCount = R.absentCount + 1
		local absent = Probe(SigPath("ctl", string.format("absent_%s_%d_%04x", R.nonce or "0000", R.absentCount, math.random(0, 0xFFFF))))
		if S.error then
			reason = "error"
		elseif not present then
			-- With all sound off the channel reports nothing at all.
			reason = ns.Try(GetCVar, "Sound_EnableAllSound") == "0" and "sound-off" or "present-missing"
		elseif absent then
			reason = "absent-plays"
		end
	end
	S.static = reason or "ok"
	if wasOK and not T.SignalsOK() then T.EnteredSlotOnly() end
	-- The static part passes again (sound back on): the live part was never
	-- settled while it failed. Before the hello's answer, the live check settles
	-- it; after it, the next push ring does (OnPushRing).
	if S.static == "ok" and wasStatic ~= nil and wasStatic ~= "ok" and R.sig.live == "pending" and not R.helloAnswered then
		T.ArmLiveCheck(LIVE_WAIT)
	end
	return S.static
end

-- One slot load settles the live half of the self-test (HelloAnswered): 30 s after
-- the hello goes up, and again after a send or a new showing of the hello
-- while it's unsettled, at most 3 times a session.
function T.ArmLiveCheck(delay)
	if R.sig.live ~= "pending" or R.helloAnswered or (R.liveChecks or 0) >= 3 then return end
	local at = GetTime() + delay
	if not R.liveCheckAt or at < R.liveCheckAt then R.liveCheckAt = at end
end

-- Slot-only mode from now on: busy sends get the fallback schedule (§4.2 rule 4).
function T.EnteredSlotOnly()
	for _, chat in ipairs(ns.db.chats) do
		if ns.Chats.IsBusy(chat) then T.Schedule(chat.id, SLOTONLY_SCHEDULE, "schedule") end
	end
	ns.Refresh()
end

---------------------------------------------------------------------------
-- hello and seen (§2.4)
---------------------------------------------------------------------------

function T.SayHello()
	if R.hello or not ns.db then return end
	if not T.Linked() then
		R.helloDeferred = true -- T.Heard sends it
		return
	end
	local db = ns.db
	local on = db.settings.context and true or false
	local ctx = on and ns.Chats.GameContext() or ""
	R.contextSent = ctx
	local _, build, _, iface = ns.Try(GetBuildInfo)
	local args = {
		{ "cur", db.cursor }, { "ver", ns.VERSION }, { "build", build or "" }, { "iface", iface or "" },
		{ "n", db.sendCounter }, { "ctx", on and 1 or 0 }, { "sig", R.sig.static or "untested" }, { "slots", R.slots.free },
	}
	-- The push counter read so far (from the reload inbox), so the bridge stops re-ringing at once.
	if R.push.known and R.push.known > 0 then args[#args + 1] = { "p", R.push.known } end
	-- The TOC's version as the game read it when it started (a /reload doesn't
	-- reread it). The app reads nothing from it since its updates from the game
	-- went (the app's updater keeps the addon up to date).
	local toc = type(C_AddOns) == "table" and type(C_AddOns.GetAddOnMetadata) == "function"
		and ns.Try(C_AddOns.GetAddOnMetadata, ns.ADDON, "Version") or nil
	if type(toc) == "string" and toc ~= "" then args[#args + 1] = { "toc", toc } end
	-- [G3] The first meeting: the client's language, and a first reply seen.
	local loc = ns.Try(GetLocale)
	if type(loc) == "string" and loc:match("^%a%a%a%a$") then args[#args + 1] = { "loc", loc } end
	if ns.db and ns.db.firstReply then args[#args + 1] = { "fr", 1 } end
	-- [SY-03] Where this session's next slot load is (the bridge writes only
	-- the slots from there on; a seen says it again after every load) and the way
	-- its records go out (pixel, stream or reload).
	args[#args + 1] = { "slot", R.slots.nextIndex }
	args[#args + 1] = { "mode", T.ModeWord() }
	R.saidMode = T.ModeWord() -- [DR-08] a change from here is said in a seen (T.SayMode)
	T.NoteToldOff(R.saidMode)
	R.slots.reported = R.slots.nextIndex
	-- This character's session: a hello with another sid ends the last one for the recap (companion F6).
	local sid = ns.Companion and ns.Companion.Call("Sid")
	if sid then args[#args + 1] = { "sid", sid } end
	local wire = T.Record(R.nonce, "hello", "", args, ns.CleanField(ctx))
	R.hello = { wire = wire, cur = db.cursor, p = R.push.known, ctx = ctx, order = db.sendCounter + 0.5, createdAt = GetTime() }
	if T.StripOut() then
		R.hello.firstDrawAt = GetTime()
		R.hello.drawUntil = GetTime() + HELLO_DWELL
		T.ArmLiveCheck(LIVE_WAIT)
		T.RefreshStrip()
	else
		R.hello.viaOutbox = true
		T.PutUnkeyed(wire, "hello")
	end
end

-- The bridge handled our hello: a slot says so (bridge.nonce).
function T.HelloConfirmed(via)
	local h = R.hello
	if not h or h.confirmed then return end
	h.confirmed = via
	T.Reported(h.cur)
	if h.p and (not R.push.reported or h.p > R.push.reported) then R.push.reported = h.p end
	R.lastAckAt = GetTime()
	T.RefreshStrip()
end

-- The slot answers our hello (bridge.nonce). Read because push rang (or a ring
-- was heard since the hello went up): the doorbells work. Read by the live
-- check with no ring heard: the bridge answered, but its ring didn't reach this
-- client, so slot-only mode (§3 self-test, part 2).
function T.HelloAnswered(reason)
	if R.sig.live ~= "pending" then return end
	if reason == "push" or R.ringAfterHello then
		R.sig.live = "ok"
	elseif reason == "hello" and T.SignalsOK() then
		R.sig.live = "fail"
		-- [UX-W03] What happens and what fixes it, without signals or sessions.
		T.Warn("live", "Replies arrive more slowly for now: the game can't hear the sound that says a reply is ready. A /reload usually fixes it.",
			"Replies are slower for now")
		T.EnteredSlotOnly()
	end
end

-- /bones probe: the doorbells as this client hears them right now (§3).
function T.ProbeReport()
	local now = GetTime()
	local function ago(t) return t and (ns.FmtDur(now - t) .. " ago") or "never" end
	local out = { "present.wav: " .. (Probe(SigPath("ctl", "present")) and "plays" or "missing (is game sound off?)") }
	for _, name in ipairs(BELLS) do
		local b = R.bells[name]
		local here = Probe(BellPath(name))
		local state
		if b and b.dead then
			state = "dead: missing since " .. ago(b.missingSince) .. " (a /reload brings it back if it was missing when the UI loaded)"
		elseif here then
			state = "armed"
		else
			state = "ringing now"
		end
		out[#out + 1] = string.format("bell_%s.wav: %s; %d ring(s) heard", name, state, b and b.rings or 0)
	end
	local P = R.push
	out[#out + 1] = string.format("Push: read up to %s, told ", P.known and ns.Int(P.known) or "?") .. ns.Product() -- [C-05] the app by its name
		.. string.format(" %s; last ring %s", P.reported and ns.Int(P.reported) or "nothing yet", ago(P.lastRingAt))
	out[#out + 1] = "Self-test: static " .. tostring(R.sig.static or "not run") .. ", live " .. tostring(R.sig.live) .. (T.SlotOnly() and "; slot-only mode" or "; doorbells on")
	return out
end

function T.HelloTick(now)
	if R.liveCheckAt and now >= R.liveCheckAt then
		-- Still no push ring: a slot load settles whether the bridge handled the
		-- hello (if it did, HelloAnswered calls it a failure).
		R.liveCheckAt = nil
		if T.SignalsOK() and R.sig.live == "pending" and not R.helloAnswered and T.SlotsIn() then
			R.liveChecks = (R.liveChecks or 0) + 1
			T.LoadSlot("hello")
		end
	end
	local h = R.hello
	if not h or h.viaOutbox or h.confirmed then return end
	if R.sig.static and R.sig.static ~= "ok" and not R.slotOnlyHelloLoaded and h.firstDrawAt and now - h.firstDrawAt >= SLOTONLY_HELLO_WAIT and T.SlotsIn() then
		-- Slot-only mode: nothing can ack the hello, so read its answer once, a
		-- few seconds after it went up (the closest thing to rule 2 without signals).
		R.slotOnlyHelloLoaded = true
		T.LoadSlot("hello")
	end
	-- Not confirmed and off the strip: show it again once the bridge shows life.
	if not h.confirmed and h.drawUntil and now >= h.drawUntil and R.bridgeSeenAt and R.bridgeSeenAt > h.drawUntil
		and now - (h.lastRetryAt or 0) >= HELLO_RETRY and T.StripOut() then
		h.lastRetryAt = now
		h.drawUntil = now + HELLO_DWELL
		T.ArmLiveCheck(LIVE_WAIT)
		T.RefreshStrip()
	end
end

-- seen: when the applied cursor is 10 records, or 16 KB of record text, past
-- the last reported one, or 30 s after applying a record not yet reported;
-- and right after a slot load brought a newer push counter, so the bridge
-- stops re-ringing (p, §3).
function T.MaybeSeen()
	local db = ns.db
	if not db or not R.nonce or R.seen then return end
	local P = R.push
	local now = GetTime()
	local pushDue = P.known ~= nil and P.known > 0 and T.StripOut() and (P.reported or 0) < P.known
	-- [SY-03] It also goes after every slot load, with where the next one is
	-- (slot=): the bridge writes only the slots from there on. Not before the
	-- hello, which says it first.
	local slotDue = R.hello ~= nil and T.StripOut() and R.slots.nextIndex > (R.slots.reported or 0)
	local curDue = db.cursor > db.reported and (db.cursor - db.reported >= SEEN_RECORDS or R.applyBytes >= SEEN_BYTES
		or (R.unreportedSince ~= nil and now - R.unreportedSince >= SEEN_AFTER))
	if curDue and not pushDue and not slotDue then -- [SY-03] (a keyed record carries no slot=)
		-- A keyed record still waiting for its ack will report this cursor anyway.
		for _, o in pairs(R.out) do
			if o.cur >= db.cursor then return end
		end
	end
	if not (curDue or pushDue or slotDue) then return end -- [SY-03]
	local wire, seen = T.SeenRecord() -- [SY-03] slot= with it
	if T.StripOut() then
		R.seen = seen
		T.RefreshStrip()
	else
		T.PutUnkeyed(wire, "seen")
		T.Reported(db.cursor)
	end
end

---------------------------------------------------------------------------
-- Doorbells (§3)
---------------------------------------------------------------------------

-- The highest push counter read. It only moves forward, except after a big
-- drop, which means the bridge's state was reset. After a smaller one, the
-- ring's seen (Poll) tells the bridge ours, and it counts on from there.
function T.NotePush(bp)
	local P = R.push
	bp = tonumber(bp)
	if not bp then return end
	if P.known and bp < P.known - 100 then
		P.known = bp
		P.reported = nil
		return
	end
	if not P.known or bp > P.known then P.known = bp end
end

-- A message waiting on the app (not for a pasted reply, Paste.lua).
local function WaitsOnApp(chat)
	for _, p in ipairs(chat.pending) do
		if not p.paste then return true end
	end
	return false
end

-- Busy on the app's account: a message it has, or its word that a run goes
-- on. A Copy and Paste wait isn't: no slot load brings its reply.
local function AppBusy(chat)
	if not chat then return false end
	if WaitsOnApp(chat) then return true end
	local s = R.snap and R.snap[chat.id]
	return s ~= nil and s.busy == true
end

-- Is anyone waiting for action counts? Only then is the act bell read.
local function ActWanted()
	for _, chat in ipairs(ns.db.chats) do
		if WaitsOnApp(chat) then return true end
	end
	return false
end

-- A push ring: read one slot as soon as the last load is 1.5 s old (Poll).
-- The bridge rings again every 10 s until a seen reports its push counter.
function T.OnPushRing()
	local P = R.push
	P.rings = P.rings + 1
	P.lastRingAt = GetTime()
	P.pending = true
	if R.hello and not R.helloAnswered then R.ringAfterHello = true end
	-- A ring heard after the hello was answered settles a live test left open.
	if R.sig.live == "pending" and R.helloAnswered then R.sig.live = "ok" end
	T.NoteBridge()
end

-- An act pulse: one more action for the run this session's latest busy send started.
function T.OnAct()
	local key, best = nil, -1
	for _, chat in ipairs(ns.db.chats) do
		for _, p in ipairs(chat.pending) do
			local n = T.KeyOfThisSession(p.key) and KeyN(p.key) or nil
			if n and n > best then key, best = p.key, n end
		end
	end
	if not key then return end
	local a = R.acts[key]
	if not a then a = { count = 0 }; R.acts[key] = a end
	a.count = a.count + 1
	a.last = GetTime()
	T.NoteBridge()
end

-- Both push bells dead: nothing can announce a slot any more, so slot-only
-- mode for this session (a bell missing when the UI loaded stays missing).
function T.BellDied(name)
	local B = R.bells
	if B.push_a and B.push_a.dead and B.push_b and B.push_b.dead and R.sig.live ~= "fail" then
		R.sig.live = "fail"
		-- [UX-W03] What happens and what fixes it, without signals or sessions.
		T.Warn("bells", "Replies arrive more slowly for now: the addon checks for them on a timer. A /reload usually brings the speed back.",
			"Replies are slower for now")
		T.EnteredSlotOnly()
	end
end

-- Read the bells. A missing read counts only when present.wav plays in the
-- same read (else the channel is down, e.g. sound off). present -> missing is
-- a pulse. A bell missing for BELL_DEAD s in a row isn't pulsing: dead until
-- it reads present again. A bell's first read being missing isn't a pulse (it
-- may be mid-pulse, or missing since the load); the bridge re-rings push.
-- fast: a quarter-second poll, which leaves the alive bells to the 2-second one.
function T.PollBells(fast)
	local reads, missing = {}, false
	for _, name in ipairs(BELLS) do
		if (name ~= "act" or ActWanted()) and not (fast and SLOW_BELLS[name]) then
			local here = Probe(BellPath(name))
			reads[#reads + 1] = { name, here }
			if not here then missing = true end
		end
	end
	if missing and not Probe(BellPath("present")) then return end
	local now = GetTime()
	for _, rd in ipairs(reads) do
		local name, here = rd[1], rd[2]
		local b = R.bells[name]
		if not b then b = { rings = 0 }; R.bells[name] = b end
		if here then
			b.dead, b.missingSince, b.armed = nil, nil, true
		elseif not b.missingSince then
			b.missingSince = now
			if b.armed then
				b.rings = b.rings + 1
				if name == "push_a" or name == "push_b" then
					T.OnPushRing()
				elseif name == "act" then
					T.OnAct()
				else
					T.Beat()
				end
			end
		elseif not b.dead and now - b.missingSince >= BELL_DEAD then
			b.dead = true
			T.BellDied(name)
		end
	end
end

-- fast: from the quarter-second tick (T.PollBells).
function T.Poll(fast)
	if not ns.db or not R.nonce then return end
	-- Off in the app (no strip): the push bell is still heard, so the app's switch and a reply reach
	-- the game at once; the bridge rings each publish once then (no re-rings: nothing can say it read).
	if T.SignalsOK() and (T.StripOut() or T.DesktopReadingOff()) then
		T.PollBells(fast)
		local P = R.push
		if P.pending and T.SlotsIn() and (not R.slots.lastAt or GetTime() - R.slots.lastAt >= PUSH_GAP) then
			P.pending = false
			local before = P.known
			-- A ring whose slot has no newer push counter is a re-ring: the bridge never
			-- got the seen that told it (or its state was reset below ours). Say it again,
			-- or each re-ring loads another slot, up to 15 a publish (of 200 a session).
			-- A slot in another protocol wasn't read, so there's nothing to say.
			if T.LoadSlot("push") and P.known == before and not R.protoMismatch then P.reported = nil end
			T.MaybeSeen()
		end
	end
	T.RunSchedules()
end

---------------------------------------------------------------------------
-- Slots (§4)
---------------------------------------------------------------------------

function T.SlotName(i)
	return string.format("%s%03d", ns.SLOT_PREFIX, i)
end

function T.CountFree()
	local free = 0
	for i = 1, ns.SLOT_COUNT do
		if not IsLoaded(T.SlotName(i)) then free = free + 1 end
	end
	R.slots.free = free
	return free
end

function T.NextSlot()
	for i = R.slots.nextIndex, ns.SLOT_COUNT do
		local name = T.SlotName(i)
		if not IsLoaded(name) then
			R.slots.nextIndex = i + 1
			return name
		end
	end
end

-- RV-4: at 0 free slots, the reload path until the next reload.
function T.CheckSlots()
	if R.slots.free <= 0 and not R.reloadFallback then
		R.reloadFallback = true
		T.HideStrip()
		T.Warn("noslots", "Reload to keep going: messages and replies wait until you do. Type /reload when you're ready.", "Reload to keep going",
			"Messages and replies wait until you do.")
	end
end

-- Load the next slot this UI session hasn't loaded, and read what it holds.
--   NQA_SlotData = nil; C_AddOns.LoadAddOn(name); then read NQA_SlotData
-- reason: push | hello | progress | schedule | stop | idle (for /bones diag).
function T.LoadSlot(reason)
	if not T.SlotsIn() then return nil end
	if not T.Linked() and reason ~= "check" then return nil end
	local S = R.slots
	local name = T.NextSlot()
	if not name then
		T.CountFree()
		T.CheckSlots()
		return nil
	end
	NQA_SlotData = nil
	local ok, loaded, why = pcall(LoadFn, name)
	S.loads = S.loads + 1
	S.reasons[reason] = (S.reasons[reason] or 0) + 1
	S.lastAt = GetTime()
	local data = NQA_SlotData
	NQA_SlotData = nil
	if not ok or not loaded then
		local code = tostring(ok and (why or "not loaded") or loaded)
		-- The part's name and the game's reason, for /bones diag only (C-121).
		S.broken = string.format("%s (%s)", name, code)
		if code == "DISABLED" then
			-- The AddOns list's category row has the game's own menu: "Enable All AddOns"
			-- and "Disable All AddOns" (ADDON_LIST_ENABLE_CATEGORY, _DISABLE_CATEGORY), which
			-- on that row turn only its direct children on or off, the parts
			-- (AddonListNodeMixin:SetEnabledAll). Setup writes the parts, not whether they're
			-- on, so the way back is there. The path and the two things to click in the
			-- game's own words, as this client has them; the English of 1.60.1.70009 where
			-- a global is missing (C-128).
			local function G(k, en) local v = _G[k]; return type(v) == "string" and v ~= "" and v or en end
			T.Warn("parts", string.format("NeverQuestAlone Parts are turned off in the AddOns list, so replies wait for a reload. To turn them back on: %s > %s, right-click NeverQuestAlone Parts, click %s (on that row it turns on only the parts), then click %s.",
				G("MAINMENU_BUTTON", "Game Menu"), G("ADDONS", "AddOns"), G("ADDON_LIST_ENABLE_CATEGORY", "Enable All AddOns"), G("RELOADUI", "Reload UI")),
				"Parts turned off: replies wait for a reload")
		else
			-- Missing, or out of date after a game patch: setup writes them again.
			T.Warn("slots", "A part of NeverQuestAlone didn't load, so replies wait for a reload. In the NeverQuestAlone app, click Settings, Show more, then Run setup again, and restart WoW.",
				"A part didn't load: replies wait for a reload")
		end
		T.CountFree()
		ns.Refresh()
		return nil
	end
	T.CountFree()
	R.loadReason = reason
	if type(data) == "table" then T.HandleSlotData(data, "slot") end
	R.loadReason = nil
	local fallback = R.reloadFallback
	T.CheckSlots()
	-- [code health AD-05] HandleSlotData refreshed already: again only for what it didn't see
	-- (an empty slot's free count, or the last free slot gone).
	if type(data) ~= "table" or R.reloadFallback ~= fallback then ns.Refresh() end
	return type(data) == "table" and data or nil
end

-- SD-4: say so, once, when the other side isn't what we expect.
function T.CheckBridgeVersion(ver)
	if type(ver) ~= "string" then return end
	local theirs = tonumber(ver:match("^(%d+)"))
	local ours = tonumber(ns.VERSION:match("^(%d+)"))
	if theirs and ours and theirs ~= ours then
		R.verMismatch = ver
		-- [C-05, UX-W03] the app updates the addon
		T.Warn("ver", ns.Fill("The NeverQuestAlone app is version {appVersion} and this addon is {version}. Update the app; it updates the addon too.", { appVersion = ns.Escape(ver), version = ns.VERSION }),
			"Update NeverQuestAlone")
	else
		R.verMismatch = nil
	end
end

-- A slot file or NQA_Inbox (the same table, §4.1).
function T.HandleSlotData(data, source)
	if type(data) ~= "table" then return false end
	if tonumber(data.v) ~= ns.PROTOCOL then
		R.protoMismatch = tostring(data.v)
		-- [C-05, UX-W03] no protocol in the player's words; the app updates the addon
		T.Warn("proto", "This addon can't read what the NeverQuestAlone app sends, so nothing from it was applied. Update the app; it updates the addon too.", "Update NeverQuestAlone")
		ns.Refresh()
		return false
	end
	R.protoMismatch = nil
	local now = tonumber(data.now)
	if now then T.NoteBridge(GetTime() - math.max(0, time() - now)) end
	local bridge = type(data.bridge) == "table" and data.bridge or {}
	local readingWasOff = T.DesktopReadingOff()
	R.bridge = bridge
	if ns.Companion then ns.Companion.Call("VoiceHeard"); ns.Companion.Call("VoiceWanted") end -- the voice: its buttons, and a request for bags and gear (cap voice)
	T.CheckBridgeVersion(bridge.ver)
	-- SD-4 from the bridge's side: bridge.warn names a version or interface
	-- mismatch it noticed. Said once per session per text, and kept for the
	-- light's tooltip and /bones diag.
	if type(bridge.warn) == "string" and bridge.warn ~= "" then
		R.bridgeWarn = bridge.warn
		-- [C-05, UX-W03] a note, from the app by its name
		T.Warn("bridge:" .. bridge.warn, ns.Fill("A note from the NeverQuestAlone app: {text}", { text = ns.Escape(bridge.warn) }), "A note from the app")
	else
		R.bridgeWarn = nil
	end
	-- [SY-29] Patch day: World of Warcraft has a new version and the app couldn't
	-- update this addon's files for it (bridge.patch "failed"). This addon runs (the
	-- game loaded it anyway), but its next start may not: the one fix is in the app.
	-- When the app could, there's nothing to say here: the app's own line says it.
	if bridge.patch == "failed" then
		T.Warn("patch", "The NeverQuestAlone app couldn't update the addon for the new version of World of Warcraft. See the fix in the app.", "See the fix in the app")
	end
	T.NotePush(bridge.push)
	if type(data.gw) == "table" then R.gw = data.gw end
	-- [UX-1] rt: the backend's own state (BYOK); its retryIn counts from this slot.
	R.rt = type(data.rt) == "table" and data.rt or nil
	R.rtAt = GetTime() - (now and math.max(0, time() - now) or 0)
	if type(data.agents) == "table" then ns.Chats.SetAgents(data.agents) end
	if ns.NoteSlot then ns.NoteSlot() end -- [C-01] the companion's name, the settings page
	local mine = data.token == ns.db.token
	R.mismatch = (not mine) and tostring(data.token) or nil
	-- Written for this install, or by an app running now (its clock is this
	-- one's: a reload inbox from an app that has since quit doesn't count). With
	-- game sound off no beat is heard, and this is how a /reload finds the app.
	if mine or (type(data.bridge) == "table" and now and math.abs(time() - now) < RED_AFTER) then T.Heard() end
	if mine then
		if type(bridge.acked) == "table" then
			for _, key in ipairs(bridge.acked) do
				if type(key) == "string" and R.out[key] then T.Acked(key, source == "inbox" and "inbox" or "slot") end
			end
		end
		if source == "slot" then T.NoteLoad() end -- [DR-07] what this load didn't ack
		local answered = R.nonce ~= nil and bridge.nonce == R.nonce
		if answered then
			R.helloAnswered = true
			T.HelloConfirmed("slot")
			T.HelloAnswered(R.loadReason)
		end
		if ns.Companion then ns.Companion.Call("OnBridge", bridge, answered) end
		T.ApplyRecords(data.records)
		if type(data.map) == "table" and type(NQAMap) == "table" and type(NQAMap.Sync) == "function" then
			pcall(NQAMap.Sync, data.map)
		end
	end
	if type(data.chats) == "table" then ns.Chats.ApplySnapshot(data.chats) end
	-- The app's Screen Reading switch flipped: the strip goes or comes back, and the
	-- app hears the new mode (the hello and the mode seen, by the strip or the outbox).
	if T.DesktopReadingOff() ~= readingWasOff then
		-- On again in the app: its new helper hears this addon's mode again (a mode seen drawn for it, and
		-- the outbox), so an off said while the app wasn't reading reaches it now (SY-17).
		if readingWasOff then R.saidMode = nil end
		T.ModeChanged()
	end
	ns.Refresh()
	return true
end

local APPLIED = { reply = true, error = true, aborted = true }

-- §4.3: every record with seq > db.cursor, in seq order, then db.cursor = seq.
-- A reply applies with nothing pending (RC-6); replay = 1 is silent; a record
-- for a chat this addon doesn't have creates nothing and counts as an orphan,
-- except the Companion chat's, which is made for it (a recap's reply, §2.6).
function T.ApplyRecords(records)
	if type(records) ~= "table" then return 0 end
	local list = {}
	for _, r in pairs(records) do
		if type(r) == "table" and tonumber(r.seq) then list[#list + 1] = r end
	end
	table.sort(list, function(a, b) return tonumber(a.seq) < tonumber(b.seq) end)
	local db = ns.db
	local notes, applied = {}, 0
	for _, r in ipairs(list) do
		local seq = math.floor(tonumber(r.seq))
		if seq > db.cursor then
			local replay = r.replay == 1 or r.replay == true
			if APPLIED[r.t] then
				local chat = ns.Chats.Find(r.chat)
				if not chat and ns.Companion and r.chat == ns.Companion.CHAT_ID then chat = ns.Companion.Call("EnsureChat") end
				if chat then
					local note = ns.Chats.ApplyRecord(chat, r, replay)
					if note then notes[#notes + 1] = note end
				else
					R.orphans = R.orphans + 1
				end
			else
				R.skipped = R.skipped + 1 -- a type from a later protocol milestone
			end
			db.cursor = seq
			applied = applied + 1
			R.applyBytes = R.applyBytes + #(type(r.text) == "string" and r.text or "")
			R.unreportedSince = R.unreportedSince or GetTime()
		end
	end
	if #notes > 0 then ns.Notify.Push(notes) end
	if applied > 0 then T.MaybeSeen() end
	return applied
end

-- §5 In: NeverQuestAlone/Inbox.lua, read at every login and /reload.
function T.ProcessInbox()
	local inbox = NQA_Inbox
	NQA_Inbox = nil -- [code health AD-17] read once: its table (up to 64 KB) needn't stay all session
	if type(inbox) == "table" then T.HandleSlotData(inbox, "inbox") end
end

---------------------------------------------------------------------------
-- The slot budget (§4.2 rules 3-5)
---------------------------------------------------------------------------

function T.Schedule(chatId, steps, why)
	local now = GetTime()
	for _, s in ipairs(steps) do
		table.insert(R.sched, { at = now + s, chat = chatId, why = why })
	end
end

function T.RunSchedules()
	local now = GetTime()
	local i = 1
	while i <= #R.sched do
		local s = R.sched[i]
		if now >= s.at then
			table.remove(R.sched, i)
			local wanted = s.why == "stop" or s.why == "ack" or AppBusy(ns.Chats.Find(s.chat))
			-- One load serves every schedule due at the same moment.
			if wanted and T.SlotOnly() and not (R.slots.lastAt and now - R.slots.lastAt < 2) then
				T.LoadSlot(s.why)
			end
		else
			i = i + 1
		end
	end
end

-- Rule 3: progress text only while the window is open on a chat busy for 30 s
-- or more; at most one load per 60 s, 3 per run and 30 per UI session.
function T.ProgressTick(now)
	if not T.SlotsIn() or not ns.UI.IsOpen() then return end
	local chat = ns.Chats.Active()
	if not chat or not AppBusy(chat) then return end
	local since = ns.Chats.BusySince(chat)
	if not since or time() - since < PROGRESS_BUSY then return end
	local P = R.progress
	if P.session >= PROGRESS_PER_SESSION then return end
	if P.last and now - P.last < PROGRESS_EVERY then return end
	local run = ns.Chats.RunId(chat)
	if not run or (P.perRun[run] or 0) >= PROGRESS_PER_RUN then return end
	P.last = now
	P.session = P.session + 1
	P.perRun[run] = (P.perRun[run] or 0) + 1
	T.LoadSlot("progress")
end

-- A record was queued: draw it, or wait for a reload; slot-only mode reads
-- the answer on rule 4's schedule. A patch or forget there gets one load 5 s
-- later, for its ack (only a slot's acked list can ack it in that mode).
function T.AfterSend(chatId, kind)
	if T.SlotOnly() and T.SlotsIn() then
		if kind == "stop" then
			T.Schedule(chatId, { STOP_CHECK }, "stop")
		elseif kind == "msg" then
			T.Schedule(chatId, SLOTONLY_SCHEDULE, "schedule")
		else
			T.Schedule(chatId, { 5 }, "ack")
		end
	elseif T.StripOut() then
		T.ArmLiveCheck(LIVE_WAIT) -- the hello rides along with it
	end
	T.RefreshStrip()
	ns.Refresh()
end

-- Slot-only mode, the tail of §4.2 rule 4: once a send's schedule is done, a
-- load every 30 s while it's still busy (60 s once it has been busy for 5
-- minutes), at most 20 per send, so a long run's reply isn't left for the
-- 10-minute idle check.
function T.BusyFollow(now)
	if not (T.SlotOnly() and T.SlotsIn()) or #R.sched > 0 then return end
	for _, chat in ipairs(ns.db.chats) do
		local pend = chat.pending[1]
		-- How long it has waited, by its own send time (an acked send has no R.sentAt, AD-17).
		local waited = pend and tonumber(pend.t) and time() - pend.t
		if waited and T.KeyOfThisSession(pend.key) and waited >= SLOTONLY_SCHEDULE[#SLOTONLY_SCHEDULE] then
			local f = R.follow[pend.key]
			if not f then f = { n = 0 }; R.follow[pend.key] = f end
			local every = waited >= BUSY_SLOW_AFTER and BUSY_SLOW or BUSY_EVERY
			if f.n < BUSY_MAX and (not R.slots.lastAt or now - R.slots.lastAt >= every) then
				f.n = f.n + 1
				T.LoadSlot("busy")
				return
			end
		end
	end
end

---------------------------------------------------------------------------
-- Ticks
---------------------------------------------------------------------------

function T.FastActive()
	if R.stripShown or #R.sched > 0 then return true end
	local h = R.hello
	if h and not h.confirmed and h.drawUntil and GetTime() < h.drawUntil then return true end
	for _, chat in ipairs(ns.db.chats) do
		if WaitsOnApp(chat) then return true end
	end
	return false
end

function T.Slow()
	local db = ns.db
	if not db or not R.nonce then return end
	local now = GetTime()
	if not R.sig.lastRun or now - R.sig.lastRun >= SELFTEST_EVERY then T.SelfTest() end
	if T.SlotOnly() and T.SlotsIn() and now - (R.slots.lastAt or R.loginAt) >= IDLE_CHECK then
		T.LoadSlot("idle")
	end
	T.BusyFollow(now)
	T.ProgressTick(now)
	T.MaybeSeen()
	ns.Notify.Tick()
	T.RefreshStrip()
	ns.Refresh("status")
end

-- Every tick, cheaply: a seen whose few seconds are up counts as reported,
-- and a timed entry leaves the strip on time.
function T.Expire(now)
	if R.seen and now >= R.seen.untilT then
		T.Reported(R.seen.cur)
		if R.seen.p and (not R.push.reported or R.seen.p > R.push.reported) then R.push.reported = R.seen.p end
		R.seen = nil
		T.RefreshStrip()
	elseif R.stripUntil and now >= R.stripUntil then
		T.RefreshStrip()
	end
end

function T.OnTick()
	local p = R.perf -- [SY-27] timed only while /bones perf measures
	local t0 = p and p.clock()
	if p then p.inTick = true end
	R.ticks = R.ticks + 1
	local now = GetTime()
	local slow = R.ticks % SLOW_EVERY == 0
	if slow or T.FastActive() then T.Poll(not slow) end
	T.HelloTick(now)
	T.Clocks(now) -- [DR-07, DR-08, DR-09]
	T.Expire(now)
	if slow then T.Slow() end
	if p then
		p.inTick = nil
		T.PerfAdd(p.clock() - t0)
	end
end

---------------------------------------------------------------------------
-- [SY-27] /bones perf: what the addon costs, measured only when asked
---------------------------------------------------------------------------

-- The addon's memory in KB (UpdateAddOnMemoryUsage walks every addon's, so only
-- on the command), with its reply parts loaded this session. nil where the game has
-- no such call.
function T.MemoryKB()
	local api = type(C_AddOns) == "table" and C_AddOns or {}
	local update = api.UpdateAddOnMemoryUsage or UpdateAddOnMemoryUsage
	local get = api.GetAddOnMemoryUsage or GetAddOnMemoryUsage
	if type(update) ~= "function" or type(get) ~= "function" then return nil end
	ns.Try(update)
	local kb = tonumber((ns.Try(get, ns.ADDON)))
	if not kb then return nil end
	for i = 1, ns.SLOT_COUNT do
		local name = T.SlotName(i)
		if IsLoaded(name) then kb = kb + (tonumber((ns.Try(get, name))) or 0) end
	end
	return kb
end

-- The game's own addon profiler (C_AddOnProfiler, on by default in the retail
-- engine): this addon's recent average per frame and its worst frame, in ms.
-- nil when the game has none, or it's off.
function T.ProfilerMs()
	local P = C_AddOnProfiler
	local M = type(Enum) == "table" and Enum.AddOnProfilerMetric or nil
	if type(P) ~= "table" or type(P.GetAddOnMetric) ~= "function" or type(M) ~= "table" or M.RecentAverageTime == nil then return nil end
	if type(P.IsEnabled) == "function" and not ns.Try(P.IsEnabled) then return nil end
	local avg = tonumber((ns.Try(P.GetAddOnMetric, ns.ADDON, M.RecentAverageTime)))
	if not avg then return nil end
	local peak = M.PeakTime ~= nil and tonumber((ns.Try(P.GetAddOnMetric, ns.ADDON, M.PeakTime))) or nil
	return avg, peak
end

-- Without the game's profiler: this file's own work, the 0.25 s tick and the
-- strip's draw (the parts that run while nothing else happens), timed with
-- debugprofilestop for `seconds` against the frames drawn meanwhile. Nothing is
-- timed until this arms R.perf, and the frame counter stops when it's done.
-- done(avgMs, maxMs) once the time is up (maxMs: the frame it cost most); false
-- when it can't measure.
function T.PerfStart(seconds, done)
	if R.perf or type(debugprofilestop) ~= "function" or type(C_Timer) ~= "table" or type(C_Timer.After) ~= "function" then return false end
	local p = { clock = debugprofilestop, ms = 0, cur = 0, max = 0, frames = 0 }
	R.perfFrame = R.perfFrame or CreateFrame("Frame")
	R.perfFrame:SetScript("OnUpdate", function()
		p.frames = p.frames + 1
		if p.cur > p.max then p.max = p.cur end
		p.cur = 0
	end)
	R.perf = p
	C_Timer.After(seconds, function()
		R.perfFrame:SetScript("OnUpdate", nil)
		R.perf = nil
		if p.cur > p.max then p.max = p.cur end
		done(p.ms / math.max(1, p.frames), p.max)
	end)
	return true
end

-- Time spent in a measured part. draw: the strip's draw, which inside the tick
-- is already in the tick's time.
function T.PerfAdd(ms, draw)
	local p = R.perf
	if not p or type(ms) ~= "number" or (draw and p.inTick) then return end
	p.ms = p.ms + ms
	p.cur = p.cur + ms
end

-- The way out changed (mode, stream, reload fallback).
function T.ModeChanged()
	local h = R.hello
	if h and not h.confirmed then
		if T.StripOut() and h.viaOutbox then
			h.viaOutbox = nil
			h.firstDrawAt = GetTime()
			h.drawUntil = GetTime() + HELLO_DWELL
		elseif not T.StripOut() and not h.viaOutbox then
			h.viaOutbox = true
			T.PutUnkeyed(h.wire, "hello")
		end
	end
	if R.stateRec and not T.StripOut() then
		T.PutUnkeyed(R.stateRec.wire, "state")
		R.stateRec = nil
	end
	T.SayMode() -- [DR-08] the bridge learns the new mode, by the strip and the outbox
	T.RefreshStrip()
	ns.Refresh()
end

-- Once a session: a line in your chat frame, a notice in the open chat
-- (never saved into a conversation), and the HUD's status line for a while.
-- short: the HUD's line; sub: its second line (else it says the whole text is a click away,
-- and in its tooltip).
function T.Warn(id, text, short, sub)
	if R.warned[id] then return end
	R.warned[id] = true
	ns.Notify.Local(text)
	local chat = ns.Chats.Active()
	if chat then ns.Chats.Notice(chat, text) end
	if ns.HUD and ns.HUD.Active() then
		short = short or "A note from the app" -- [C-05, UX-W03]
		-- [C-13] With cap ekind the HUD keeps it as a state line with Okay
		-- until you say Okay, and a click on it opens the whole of it in the window.
		if ns.HasCap("ekind") and ns.HUD.Warn then
			ns.HUD.Warn(short, text)
		else
			ns.HUD.Flash(short, sub or "Click for the details.", text, "warn")
		end
	end
end

-- PLAYER_LOGIN (every login and /reload): a new nonce, the outbox redrawn
-- verbatim, the self-test, the reload inbox, then the hello.
function T.Start()
	local db = ns.db
	R.nonce = ns.NewNonce()
	table.insert(db.nonces, 1, R.nonce)
	while #db.nonces > 8 do table.remove(db.nonces) end
	T.LoadOutbox()
	T.CountFree()
	T.CheckSlots()
	T.SelfTest()
	T.ProcessInbox()
	T.RefreshStrip()
	C_Timer.After(HELLO_DELAY, T.SayHello)
	R.ticker = C_Timer.NewTicker(FAST_TICK, T.OnTick)
end
