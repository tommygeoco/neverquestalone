-- VoiceBar.lua: a small bar for the voice companion (odd/tasks/nqa-voice-controls.md T5, T9, T10),
-- so it can be driven without leaving the game: Talk (open the microphone for one question), Tips (what to
-- do now, said aloud), Open/Close mic (always listening), Pause, who speaks (click for the next voice,
-- right-click for the one before) and Read (the voice reads new replies aloud). Its line says what
-- the voice is doing, as the app reports it (bridge.voice). It shows only while the app has voice
-- support (cap voice); drag it to move it; /nqa voice bar off hides it.
-- Nothing here acts in the game: every button sends a vc record to the NeverQuestAlone app.

local _, ns = ...
local V = {}
ns.VoiceBar = V

local WORDS = { listening = "Listening", muted = "Mic off", paused = "Paused", connecting = "Connecting…", off = "Voice not running" }
local NAMES = { skeleton = "Bones", ["orc-shaman"] = "Orc", troll = "Troll", forsaken = "Forsaken", tauren = "Tauren" }
local W, H = 268, 78

local bar

local function Comp(name, ...)
	return ns.Companion and ns.Companion.Call(name, ...)
end

-- A line from a button goes to the chat you have open, as /nqa voice's does.
local function Say(msg)
	if not msg or not ns.Chats or not ns.Chats.Active then return end
	local chat = ns.Chats.Active()
	if chat and ns.Chats.Notice then ns.Chats.Notice(chat, msg) end
end

local function NextPersona(step)
	local list = ns.Companion and ns.Companion.VOICE_PERSONAS or {}
	local cur = (ns.Companion and ns.Companion.Call("VoicePersona")) or (ns.db and ns.db.settings.voicePersona) or list[1]
	local at = 1
	for i, p in ipairs(list) do if p == cur then at = i end end
	return list[((at - 1 + step) % #list) + 1]
end

function V.Shown()
	return ns.db ~= nil and ns.db.settings.voiceBar ~= false and ns.HasCap("voice")
end

function V.Ensure()
	if bar then return bar end
	local UI = ns.UI
	bar = CreateFrame("Frame", "NQAVoiceBar", UIParent)
	bar:SetSize(W, H)
	bar:SetFrameStrata("MEDIUM")
	bar:SetClampedToScreen(true)
	bar:SetMovable(true)
	bar:EnableMouse(true)
	bar:RegisterForDrag("LeftButton")
	bar:SetScript("OnDragStart", function(self) self:StartMoving() end)
	bar:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local x, y = self:GetLeft(), self:GetTop()
		if ns.db and x and y then ns.db.settings.voiceBarX, ns.db.settings.voiceBarY = math.floor(x), math.floor(y) end
	end)
	local bg = bar:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	bg:SetColorTexture(0.05, 0.05, 0.05, 0.85)
	bar.status = bar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	bar.status:SetPoint("TOPLEFT", bar, "TOPLEFT", 8, -6)
	bar.status:SetPoint("TOPRIGHT", bar, "TOPRIGHT", -8, -6)
	bar.status:SetJustifyH("LEFT")
	local function Btn(label, w, onClick)
		return UI.Button(bar, label, w, onClick)
	end
	-- Row 1: talking. Row 2: who speaks and whether it reads replies.
	bar.talk = Btn("Talk", 52, function() Say(Comp("VoiceCommand", "talk")) end)
	bar.talk:SetPoint("TOPLEFT", bar, "TOPLEFT", 6, -22)
	bar.tip = Btn("Tips", 52, function() Say(Comp("VoiceCommand", "tip")) end)
	bar.tip:SetPoint("LEFT", bar.talk, "RIGHT", 4, 0)
	bar.mute = Btn("Open mic", 82, function() Say(Comp("VoiceToggleMute")) end)
	bar.mute:SetPoint("LEFT", bar.tip, "RIGHT", 4, 0)
	bar.pause = Btn("Pause", 62, function() Say(Comp("VoiceTogglePause")) end)
	bar.pause:SetPoint("LEFT", bar.mute, "RIGHT", 4, 0)
	bar.who = Btn("Voice", 128, function(_, button)
		local name = NextPersona(button == "RightButton" and -1 or 1)
		if name then Say(Comp("VoicePickPersona", name)) end
	end)
	bar.who:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	bar.who:SetPoint("TOPLEFT", bar.talk, "BOTTOMLEFT", 0, -4)
	bar.read = Btn("Read: off", 124, function() Say(Comp("VoiceRead", not (ns.db and ns.db.settings.voiceRead == true))) end)
	bar.read:SetPoint("LEFT", bar.who, "RIGHT", 4, 0)
	local s = ns.db and ns.db.settings
	if s and type(s.voiceBarX) == "number" and type(s.voiceBarY) == "number" then
		bar:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", s.voiceBarX, s.voiceBarY)
	else
		bar:SetPoint("TOP", UIParent, "TOP", 0, -120)
	end
	-- Twice a second is plenty: the state comes with slot loads, about once a second at most.
	local since = 0
	bar:SetScript("OnUpdate", function(_, dt)
		since = since + dt
		if since >= 0.5 then since = 0; V.Refresh() end
	end)
	bar:Hide()
	return bar
end

function V.Refresh()
	if not V.Shown() then
		if bar then bar:Hide() end
		return
	end
	V.Ensure()
	local st = (ns.Companion and ns.Companion.Call("VoiceState")) or "off"
	local who = ns.Companion and ns.Companion.Call("VoicePersona")
	local asked = ns.R and ns.R.voiceAsked
	local readying = asked and asked.cmd == "talk" and not asked.done and GetTime() - asked.at < 20
	bar.status:SetText(readying and "Getting the microphone ready…" or (WORDS[st] or WORDS.off) .. (who and ("  ·  " .. (NAMES[who] or who)) or ""))
	bar.mute:SetText(st == "listening" and "Close mic" or "Open mic")
	bar.read:SetText("Read: " .. ((ns.db and ns.db.settings.voiceRead == true) and "on" or "off"))
	bar.pause:SetText((st == "paused" or st == "off") and "Resume" or "Pause")
	bar.who:SetText("Voice: " .. (NAMES[who or (ns.db and ns.db.settings.voicePersona) or ""] or "…"))
	bar:Show()
end

-- /nqa voice bar on|off
function V.Command(on)
	if ns.db then ns.db.settings.voiceBar = on end
	V.Refresh()
	if on and not ns.HasCap("voice") then return "The voice bar shows once the NeverQuestAlone app with voice support is running." end
	return "Voice bar: " .. (on and "on." or "off.")
end

-- It shows itself once a slot names cap voice (checked with each refresh of the addon).
local ev = CreateFrame("Frame")
ev:RegisterEvent("PLAYER_LOGIN")
ev:SetScript("OnEvent", function()
	local since = 0
	ev:SetScript("OnUpdate", function(_, dt)
		since = since + dt
		if since < 2 then return end
		since = 0
		if V.Shown() and not (bar and bar:IsShown()) then V.Refresh() end
	end)
end)
