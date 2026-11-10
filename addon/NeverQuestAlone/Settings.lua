-- Settings.lua: every switch in one place, and ways in from the game's own UI.
--   - A page in the game's Settings, in its standard list layout (searchable,
--     with Defaults): Settings.RegisterVerticalLayoutCategory and proxy
--     settings, as Blizzard_Settings_Shared's own guide shows: check boxes,
--     sliders and buttons, never a dropdown (CHOICES, E-047). Where that API
--     is missing, the same switches open as a small window of ours.
--     /bones settings opens it. Its Quality of Life section holds QoL.lua's
--     switches (/bones qol opens the page there).
--   - NeverQuestAlone in the minimap's addon menu (AddonCompartmentFrame:RegisterAddon):
--     click opens Bones, right-click opens these settings.
--   - "Ask Bones About This Quest" in the quest log's right-click menu
--     (Menu.ModifyMenu "MENU_QUEST_MAP_LOG_TITLE", Forever's quest log).
--   - The game's AddOns list: the slots' category row folded once (setup
--     folds it at install; P.FoldParts at a logout where it didn't), so the
--     addon's own row (its TOC's title) is the one there with a check box.
-- Every way in names the addon as that list does, the TOC's Title (C-124): the
-- Settings category, our own window's title, the addon menu's entry, the keys'
-- section in Keybindings (Store.lua, Bindings.xml; C-127) and the label on the
-- window's notices (UI.lua).
-- Nothing here acts in the game; the ask sends like a quick ask (Commands.lua).

local _, ns = ...
local P = {}
ns.Settings = P

local W, ROW = 560, 26

local function S() return ns.db.settings end
local QOL = "Quality of Life"

-- [UX-5] A row's tooltip in the companion's name (ns.P): for the game's
-- list, read when it's shown (a function: the rows that depend on the
-- backend, or Quality of Life's).
local function PTip(t)
	if type(t) == "function" then return function() return ns.P(t()) end end
	return ns.P(t)
end

-- [PR-1] The echo's tooltip, read when shown: with cap echo and the
-- desktop's echo off, it says so (main's words otherwise).
local function EchoTip()
	if ns.Notify and ns.Notify.DesktopEchoOff and ns.Notify.DesktopEchoOff() then -- [UX-W05] whole sentences, the app by its name
		return "Sets how much of each reply also shows in your chat frame; the window always has all of it. It's off in the NeverQuestAlone app right now, so none show: turn on Replies in chat frame under Settings, Show more."
	end
	return "Sets how much of each reply also shows in your chat frame; the window always has all of it."
end

-- Section, label, getter, setter, tooltip, default (as Store.lua's). A
-- tooltip or default may be a function, read when it's needed.
local SWITCHES = {
	{ "The HUD", "NeverQuestAlone HUD", function() return S().hud end, function(v) if ns.HUD then ns.HUD.SetShown(v) else S().hud = v end end,
		"A small panel beside the quest tracker: what NeverQuestAlone is doing and saying, and your route. When it's off, a small bar stands in, and a route you follow keeps its bar.", true },
	-- The label fits the list's label column (about 195 wide at 12 pt, E-047).
	{ "Map", "Next Stop as a Waypoint", function() return S().waypoint end,
		function(v) S().waypoint = v; if type(NQAMap) == "table" and NQAMap.WaypointSettingChanged then NQAMap.WaypointSettingChanged() end end,
		"Marks the route's next stop in the world with the game's own waypoint and its distance, like a map pin you Ctrl-click.", true },
	{ "Map", "Minimap Pins", function() return NQAMapDB == nil or NQAMapDB.minimap ~= false end,
		function(v) if type(NQAMap) == "table" and NQAMap.Command then NQAMap.Command("minimap " .. (v and "on" or "off")) end end,
		"Shows route stops and marks near you on the minimap, and the next stop on its edge when it's far.", true },
	{ "Replies", "Quiet in Combat", function() return S().dndCombat end, function(v) S().dndCombat = v; if not v then ns.Notify.Flush() end end,
		"Holds replies until the fight ends; only the unread count moves meanwhile.", true },
	{ "What NeverQuestAlone Knows", "Game Data with Messages", function() return S().context end, function(v) S().context = v; ns.Refresh("status") end,
		function()
			-- [QL-F-14] the app's companion switch off: the quest log goes with a message, the gear doesn't
			if ns.Companion and ns.Companion.Call("DesktopOn") == false then
				return "Sends your character, where you are and your quests, so NeverQuestAlone knows what you know. Your gear and quest objectives go too once check-ins are on in the app."
			end
			return "Sends your character, where you are, your quests and gear, so NeverQuestAlone knows what you know."
		end, true },
	{ "What NeverQuestAlone Knows", "Check-Ins", function() return ns.db.companion == nil or ns.db.companion.on ~= false end,
		function(v) if ns.Companion then ns.Companion.Call("Switch", v) end end, -- [C-25]
		function() -- [C-05] no allowance: there's no daily limit
			-- [C-05] the desktop's switch, while it's off [UX-W04, UX-W05] check-ins, whole sentences
			if ns.Companion and ns.Companion.Call("DesktopOn") == false then
				return "NeverQuestAlone checks in on level-ups, finished routes, quests no route covers and first visits to a zone. They're off in the NeverQuestAlone app right now; turn them on there too."
			end
			return "NeverQuestAlone checks in on level-ups, finished routes, quests no route covers and first visits to a zone."
		end, true },
	-- No screen reading, one click. Off is stream mode (/bones stream on; the
	-- orchestrator's ruling, 2026-09-27): nothing is drawn, your messages wait
	-- for a reload, and replies still come in. On ends /bones mode reload too.
	{ "What NeverQuestAlone Knows", "Screen Reading", function() return S().mode ~= "reload" and not S().stream end,
		function(v)
			S().stream = not v
			if v then S().mode = "pixel" end
			ns.Transport.ModeChanged()
		end,
		function()
			-- Off in the desktop app (its Your data page): that switch wins, as Check-Ins' does.
			if ns.Transport.DesktopReadingOff() then
				return "Reads only the top of WoW's window, where the addon draws, so your messages go at once. It's off on the NeverQuestAlone app's Your data page right now, so your messages wait for a reload; turn it back on there too."
			end
			return "Reads only the top of WoW's window, where the addon draws, so your messages go at once. When it's off, nothing is drawn, so your messages wait for a reload, and replies still come in."
		end, true },
	{ "Tooltips", "Upgrade Verdicts in Item Tooltips", function() return S().tooltips end, function(v) S().tooltips = v end,
		"Rates each item against what you wear, once NeverQuestAlone has sent stat weights for your build: \"an upgrade, +12% over Band of Ash\".", true },
	{ "Personality", "One-Liners", function() return S().quips end, function(v) S().quips = v; if ns.HUD then ns.HUD.Render() end end,
		"Adds a line to the HUD when you die or come back to life; it's made here, and nothing is sent.", false },
}

-- The labels other files name, so a note or an answer says where the switch is.
-- By position: a merge that moves a row fails commands_ux_test ("each answer
-- names its own row").
P.LABELS = { hud = SWITCHES[1][2], waypoint = SWITCHES[2][2], dnd = SWITCHES[4][2], context = SWITCHES[5][2], checkins = SWITCHES[6][2], screen = SWITCHES[7][2],
	tooltips = SWITCHES[8][2], quips = SWITCHES[9][2] }

-- Section, label, setting key, { value, words, tooltip }..., tooltip, default.
-- The game's Settings list shows a choice with its own sliders and check
-- boxes, never a dropdown: on 70009, opening a Blizzard dropdown there that
-- this addon fills crashed the game in Blizzard_Menu (E-047). A choice whose
-- options run from least to most (steps, listed in that order) is a slider
-- through them, the option's words at its right; any other is a row per
-- option, exactly one checked, as radio buttons are.
local CHOICES = {
	{ "Replies", "Replies in Your Chat Frame", "echo", { { "off", "Off" }, { "short", "One Line" }, { "summary", "TL;DR" }, { "full", "Whole Reply" } },
		"Sets how much of each reply also shows in your chat frame; the window always has all of it.", "summary", steps = true,
		pubTip = EchoTip }, -- [PR-1] the public build's tooltip, read when shown: main's words without cap echo
	{ "Replies", "Chat Text Size", "textSize", { { "small", "Small" }, { "medium", "Medium" }, { "large", "Large" }, { "xlarge", "Extra Large" } }, -- Extra Large
		"Sets the size of the text in the window's chat and its box.", "medium", steps = true },
	-- Copy and Paste (Paste.lua): the way with no app, or by choice. Its two
	-- options don't run in order, so a row each ("Connection: Automatic"),
	-- exactly one checked; the one tooltip says what both do, since the
	-- Options search can show either row on its own.
	{ "Replies", "Connection", "replies", { { "auto", "Automatic" }, { "paste", "Copy and Paste" } },
		"Sets how replies come: Automatic uses the NeverQuestAlone app while it runs, and Copy and Paste when it doesn't; Copy and Paste never uses the app.", "auto" },
}

-- Quality of Life (QoL.lua), each row in its place in the section (pos); the
-- game's own two show only where this client has them (when), and Quest
-- Rewards' rows (one per rule, each with its own tooltip, which says what the
-- rule is for: a search shows the rows on their own) sit under Auto Turn In
-- Quests, indented and grayed while it's off (parent; Under, below). Each
-- row's name fits the list's label column at 12 pt, indented (about 180).
-- QoL.lua is a new file: a /reload after an update runs this file without
-- it (the game reads a new file only at its start), and the page then goes
-- without the section.
if ns.QoL then
	local Q = ns.QoL
	local function Switch(key, pos)
		return { QOL, Q.LABELS[key], function() return Q.Get(key) end, function(v) Q.Set(key, v) end,
			function() return Q.Describe(key) end, Q.CVARS[key] and function() return Q.CVarDefault(key) end or false,
			pos = pos, key = key, when = Q.CVARS[key] and function() return Q.HasCVar(key) end or nil }
	end
	for _, row in ipairs({ Switch("loot", 1), Switch("qolAccept", 2), Switch("qolTurnIn", 3), Switch("qolSkip", 5),
		Switch("qolJunk", 6), Switch("qolRepair", 7), Switch("track", 8) }) do
		SWITCHES[#SWITCHES + 1] = row
	end
	local function Rule(value, words) return { value, words, function() return Q.RewardTip(value) end } end
	CHOICES[#CHOICES + 1] = { QOL, Q.LABELS.qolRewards, "qolRewards",
		{ Rule("you", "Your Pick"), Rule("bones", "Best Upgrade"), Rule("sell", "Highest Price") },
		function() return Q.Describe("qolRewards") end, "you", pos = 4, parent = "qolTurnIn" }
end
-- [UX-3, pub:S] These rows come after Quality of Life's (so the numbers
-- before them stay as they were).
SWITCHES[#SWITCHES + 1] = { "Replies", "Reply Cost", function() return S().replyCost end, function(v) S().replyCost = v; ns.Refresh("all") end, -- [UX-W05] a toggle names its setting
	"Shows what each reply cost under it (\"0.4¢\"), as NeverQuestAlone reports it; /nqa cost on|off does the same.", false }
SWITCHES[#SWITCHES + 1] = { "Replies", "Message Times", function() return S().times ~= false end, function(v) S().times = v and true or false; ns.UI.LookChanged() end,
	"Shows the time on each message in the window.", true } -- [UX-W05]
-- Chains.lua's line on the game's quest pages and under a quest's name on the HUD. The facts still go
-- with the game data.
SWITCHES[#SWITCHES + 1] = { "Quests", "Quest Chains", function() return S().chains ~= false end,
	function(v) S().chains = v and true or false; if ns.Chains then ns.Chains.Refresh() end; if ns.HUD then ns.HUD.Render() end end,
	"Shows where a quest's chain leads, in a line under its title when a quest giver offers it, in your quest log and on the HUD: \"Leads to The Deadmines · step 1 of 7\". Only chains to a dungeon, a raid or a rare or better reward get one.", true }
CHOICES[#CHOICES + 1] = { "Replies", "Name on Your Messages", "youName", function() -- [UX-W05] a label, not a clause
		local n = ns.Readable(ns.Try(UnitName, "player")) -- "You", or your character's name (read when shown; never a secret, ns.Readable)
		n = (type(n) == "string" and n ~= "") and ns.Escape(n) or "Your Character's Name"
		return { { "you", "You" }, { "character", n } }
	end,
	"Sets the name on your own messages in the window and the chat list; it's shown only here and never sent.", "you" }
-- Section, label, setting key, min, max, step, default, tooltip.
local SLIDERS = {
	{ "The HUD", "HUD Opacity", "hudAlpha", 60, 100, 5, 100, "Sets how solid the HUD is over the world; the pointer never changes it." },
}
SWITCHES[#SWITCHES + 1] = { "Replies", "Read replies aloud", function() return S().speak == true end,
	function(v)
		if ns.Companion then ns.Notify.Local(ns.Companion.Call("SpeechCommand", v and "on" or "off") or "TTS isn't available in this client.") end
	end, "Reads only new replies' TL;DR with the game's own text-to-speech voice. /nqa speak stop stops it.", false }
SWITCHES[#SWITCHES + 1] = { "What NeverQuestAlone Knows", "Live Game Data", function() return S().live == true end,
	function(v) if ns.Companion then ns.Companion.Call("LiveSwitch", v) end end,
	"Keeps game data current between messages, at most once every 30 seconds, outside combat. Check-Ins and Screen Reading must be on here and in the app.", false }

P.SWITCHES, P.CHOICES, P.SLIDERS = SWITCHES, CHOICES, SLIDERS
local SECTIONS = { "The HUD", "Map", "Quests", "Replies", "Tooltips", "What NeverQuestAlone Knows", "Personality", QOL }

-- A label, tooltip or default that may be a function.
local function Value(x)
	if type(x) == "function" then return x() end
	return x
end
-- Whether a row shows on this client (a row with no `when` always does).
local function Shown(row)
	if type(row.when) ~= "function" then return true end
	local ok, on = pcall(row.when)
	return ok and on and true or false
end
-- A choice's options: a list, or a function that gives one (Name on Your
-- Messages', read when shown; QL-37).
local function Opts(ch) return type(ch[4]) == "function" and ch[4]() or ch[4] end

local function Words(choice, value)
	for _, o in ipairs(Opts(choice)) do
		if o[1] == value then return Value(o[2]) end
	end
	return tostring(value)
end

-- A value's place among its choice's options, or nil.
local function Place(choice, value)
	for i, o in ipairs(Opts(choice)) do
		if o[1] == value then return i end
	end
end
-- The place of the value now, else of the default: never nil (a slider given
-- no number stops the Settings list with an error).
local function PlaceNow(choice)
	return Place(choice, S()[choice[3]]) or Place(choice, choice[6]) or 1
end

-- A choice's label and the words for its value now ("Replies in Your Chat
-- Frame", "Whole Reply"): what a command answers with.
function P.Choice(key)
	for _, ch in ipairs(CHOICES) do
		if ch[3] == key then return ch[2], Words(ch, S()[key]) end
	end
end

-- A slider's value, whole steps within its range (the getter never returns nil:
-- a slider given no number stops the Settings list with an error).
local function SliderValue(sl)
	local v = tonumber(S()[sl[3]]) or sl[7]
	return math.max(sl[4], math.min(sl[5], v))
end
local function SetSlider(sl, v)
	v = tonumber(v) or sl[7]
	S()[sl[3]] = math.max(sl[4], math.min(sl[5], math.floor(v / sl[6] + 0.5) * sl[6]))
	if ns.HUD then ns.HUD.Render() end
	if P.Refresh then P.Refresh() end
end
P.SetSlider = SetSlider

local function SetChoice(key, value)
	if key == "qolRewards" then
		if ns.QoL then ns.QoL.SetRewards(value) end
	else
		S()[key] = value
	end
	if key == "textSize" then ns.UI.TextSizeChanged() elseif key == "youName" then ns.UI.LookChanged() else ns.Refresh("status") end -- youName
	if P.Refresh then P.Refresh() end
end

-- [UX-3] The Usage row's click: the usage panel's lines in your chat frame.
function P.PrintUsage()
	for _, l in ipairs(ns.UI.UsageLines()) do ns.Notify.Local(l) end
end

-- Key bindings: the game's Keybindings page, at the keys' own section (C-127);
-- in a fight, once it ends (ns.AfterCombat).
-- The page scrolls to the element named what we pass (ScrollToElementByName),
-- and that section is named BINDING_HEADER_NQA's value (Bindings.xml).
-- It opens collapsed, as the game's own sections do.
function P.OpenKeybindings()
	if type(Settings) == "table" and type(Settings.OpenToCategory) == "function" and Settings.KEYBINDINGS_CATEGORY_ID then
		if ns.AfterCombat(P.OpenKeybindings, "The Keybindings page opens after the fight.") then return true end
		if pcall(Settings.OpenToCategory, Settings.KEYBINDINGS_CATEGORY_ID, BINDING_HEADER_NQA or "NeverQuestAlone") then return true end
	end
	ns.Notify.Local("Bind keys in the game menu: Options > Keybindings > NeverQuestAlone.")
	return false
end

---------------------------------------------------------------------------
-- The game's Settings, standard list
---------------------------------------------------------------------------

local function RegisterList()
	if type(Settings) ~= "table" or type(Settings.RegisterVerticalLayoutCategory) ~= "function"
		or type(Settings.RegisterProxySetting) ~= "function" or type(Settings.CreateCheckbox) ~= "function" then
		return false
	end
	local category, layout = Settings.RegisterVerticalLayoutCategory("NeverQuestAlone")
	if not category then return false end
	-- Headers and buttons go in through Settings.RegisterInitializer, the
	-- secure way in (Blizzard_SettingsInbound.lua), like the checkboxes.
	local function Add(initializer)
		if type(Settings.RegisterInitializer) == "function" then
			Settings.RegisterInitializer(category, initializer)
		elseif layout and type(layout.AddInitializer) == "function" then
			layout:AddInitializer(initializer)
		end
	end
	local function Header(name)
		if type(CreateSettingsListSectionHeaderInitializer) == "function" then
			Add(CreateSettingsListSectionHeaderInitializer(name))
		end
	end
	local section
	local function Section(name)
		if name ~= section then
			section = name
			Header(ns.P(name)) -- [UX-5]
		end
	end
	-- Section by section: each one's switches, then its sliders, then its
	-- choices, unless a row names its place (pos), as Quality of Life's do.
	local inits = {} -- a switch's key -> its setting's variable and getter, for a row under it
	local function AddSwitch(i, sw)
		local setting
		-- A setter that didn't take the value (the page's Defaults leave the game's
		-- own Auto Loot and quest tracking as they are): once the game has drawn
		-- the default, the row reads the real value again (SettingMixin:ApplyValue
		-- tells the control after the setter, Blizzard_Setting.lua:124-136).
		local function Set(v)
			v = v and true or false
			sw[4](v)
			if (sw[3]() and true or false) ~= v and type(C_Timer) == "table" and type(C_Timer.After) == "function"
				and type(setting) == "table" and type(setting.NotifyUpdate) == "function" then
				C_Timer.After(0, function() setting:NotifyUpdate() end)
			end
		end
		setting = Settings.RegisterProxySetting(category, "NQA_SWITCH_" .. i, Settings.VarType and Settings.VarType.Boolean or "boolean",
			ns.P(sw[2]), Value(sw[6]) and true or false, function() return sw[3]() and true or false end, Set) -- [UX-5]
		Settings.CreateCheckbox(category, setting, PTip(sw[5]))
		-- For a row under it (Under): its setting's variable, and its value.
		if sw.key then inits[sw.key] = { variable = "NQA_SWITCH_" .. i, get = sw[3] } end
	end
	local function AddSlider(sl)
		local setting = Settings.RegisterProxySetting(category, "NQA_" .. sl[3]:upper(), Settings.VarType and Settings.VarType.Number or "number",
			sl[2], sl[7], function() return SliderValue(sl) end, function(v) SetSlider(sl, v) end)
		local options = Settings.CreateSliderOptions(sl[4], sl[5], sl[6])
		local labels = type(MinimalSliderWithSteppersMixin) == "table" and MinimalSliderWithSteppersMixin.Label
		if labels and type(options.SetLabelFormatter) == "function" then
			options:SetLabelFormatter(labels.Right, function(v) return ns.Int(v) .. "%" end)
		end
		Settings.CreateSlider(category, setting, options, PTip(sl[8])) -- [UX-5]
	end
	local sliders = type(Settings.CreateSlider) == "function" and type(Settings.CreateSliderOptions) == "function"
	-- The slider's words at its right (MinimalSliderWithSteppersMixin.Label).
	local labels = type(MinimalSliderWithSteppersMixin) == "table" and type(MinimalSliderWithSteppersMixin.Label) == "table"
		and MinimalSliderWithSteppersMixin.Label.Right
	-- Under its switch: indented, and grayed while that's off, from the three
	-- calls whose fields only the row's own setup reads
	-- (Blizzard_SettingControls.lua at bd2470a): Indent (:192, its indent),
	-- AddModifyPredicate (:137, the test that grays it) and AddEvaluateStateCVar
	-- (:175, the switch's setting, so the row looks again when it changes,
	-- :330-335). Never SetParentInitializer (QL-36): it writes the row's
	-- parentInitializer from our code, and the Options search reads that
	-- field unguarded for every row it finds (Blizzard_SettingsPanel.lua:712).
	-- A search that found one of these rows would show all its results with
	-- our taint, and the Discord row among them makes a restricted call
	-- (C_Discord.IsUserOAuthed), so the game would block it with E-026's
	-- "NeverQuestAlone has been blocked" popup. Without that link the rows show at
	-- 12 pt, not the game's 10 for a sub-setting.
	local function Under(init, key)
		local parent = key and inits[key]
		if not parent or type(init) ~= "table" then return end
		if type(init.Indent) == "function" then init:Indent() end
		if type(init.AddModifyPredicate) == "function" then
			init:AddModifyPredicate(function()
				local ok, on = pcall(parent.get)
				return ok and on and true or false
			end)
		end
		if type(init.AddEvaluateStateCVar) == "function" then init:AddEvaluateStateCVar(parent.variable) end
	end
	-- A choice in order: a slider from its first option to its last, one step
	-- each, the option's words at its right (as HUD Opacity's percent is). The
	-- saved value stays the option's ("summary"), never the step's number.
	local function AddSteps(ch)
		local n = #Opts(ch)
		local function At(v) return math.max(1, math.min(n, math.floor((tonumber(v) or PlaceNow(ch)) + 0.5))) end
		local setting = Settings.RegisterProxySetting(category, "NQA_" .. ch[3]:upper(), Settings.VarType and Settings.VarType.Number or "number",
			ns.P(ch[2]), Place(ch, ch[6]) or 1, function() return PlaceNow(ch) end, function(v) SetChoice(ch[3], Opts(ch)[At(v)][1]) end) -- [UX-5]
		local options = Settings.CreateSliderOptions(1, n, 1)
		if type(options.SetLabelFormatter) == "function" then
			options:SetLabelFormatter(labels, function(v) return Value(Opts(ch)[At(v)][2]) end)
		end
		Under(Settings.CreateSlider(category, setting, options, PTip(ch.pubTip or ch[5])), ch.parent) -- [PR-1, pub:D UX-5]
	end
	-- Any other choice: a check box row per option ("Quest Rewards: Your
	-- Pick"), each with its option's own tooltip, exactly one checked, as
	-- radio buttons are. The game redraws a row only when its own setting
	-- changes, so a new pick tells the row it replaced (NotifyUpdate); a click
	-- on the checked row keeps it the pick.
	local function AddRows(ch)
		local rows = {}
		for _, o in ipairs(Opts(ch)) do
			local row = { value = o[1] }
			local function Set(v)
				local was = S()[ch[3]]
				if v and was ~= o[1] then
					SetChoice(ch[3], o[1])
					for _, r in ipairs(rows) do
						if r.value == was and type(r.setting) == "table" and type(r.setting.NotifyUpdate) == "function" then r.setting:NotifyUpdate() end
					end
				elseif not v and was == o[1] and type(C_Timer) == "table" and type(C_Timer.After) == "function"
					and type(row.setting) == "table" and type(row.setting.NotifyUpdate) == "function" then
					-- Once the game has drawn the click (SettingMixin:ApplyValue tells the
					-- control after the setter), the row reads its value again: checked.
					C_Timer.After(0, function() row.setting:NotifyUpdate() end)
				end
			end
			-- The name is a string, never a function: the game calls a function name
			-- inside its secure handler, which would carry our taint there.
			row.setting = Settings.RegisterProxySetting(category, "NQA_" .. ch[3]:upper() .. "_" .. o[1]:upper(),
				Settings.VarType and Settings.VarType.Boolean or "boolean", ns.P(Value(ch[2])) .. ": " .. Value(o[2]), o[1] == ch[6], -- [UX-5] the label's words, then the option's (a name of its own: once)
				function() return S()[ch[3]] == o[1] end, Set)
			Under(Settings.CreateCheckbox(category, row.setting, PTip(o[3] or ch.pubTip or ch[5])), ch.parent) -- [PR-1, pub:D UX-5]
			rows[#rows + 1] = row
		end
	end
	-- A slider without its words would say nothing, so where this client lacks
	-- them a choice in order gets rows too.
	local function AddChoice(ch)
		if ch.steps and sliders and labels then AddSteps(ch) else AddRows(ch) end
	end
	for _, name in ipairs(SECTIONS) do
		local rows = {}
		for i, sw in ipairs(SWITCHES) do
			if sw[1] == name and Shown(sw) then rows[#rows + 1] = { add = function() AddSwitch(i, sw) end, pos = sw.pos } end
		end
		for _, sl in ipairs(SLIDERS) do
			if sl[1] == name and sliders then rows[#rows + 1] = { add = function() AddSlider(sl) end } end
		end
		for _, ch in ipairs(CHOICES) do
			if ch[1] == name and Shown(ch) then rows[#rows + 1] = { add = function() AddChoice(ch) end, pos = ch.pos } end
		end
		for n, r in ipairs(rows) do r.order = r.pos or (1000 + n) end
		table.sort(rows, function(a, b) return a.order < b.order end)
		for _, r in ipairs(rows) do
			Section(name)
			r.add()
		end
	end
	-- The buttons stay out of the Options search (addSearchTags false).
	-- CreateSettingsButtonInitializer writes a button's search tags from its
	-- caller, so they would carry our taint. The search reads every tag
	-- unguarded (SettingsPanelMixin:FindInitializersMatchingSearchText), so
	-- every search would then build its results tainted, and a row that calls
	-- a restricted API gets blocked: the Discord Sign In row calls
	-- C_Discord.IsUserOAuthed, and "NeverQuestAlone has been blocked from an action
	-- only available to the Blizzard UI" popped up (E-026).
	if type(CreateSettingsButtonInitializer) == "function" then
		-- [UX-3] Today's usage, one click away (the list page only; /bones
		-- usage says the same). No search tags (E-026).
		Header("Usage")
		Add(CreateSettingsButtonInitializer("Usage Today", "Show Usage", P.PrintUsage,
			"Shows today's spend and messages in your chat frame; you can set a daily spend limit in the NeverQuestAlone app.", false)) -- [UX-W05]
		Header("Keys and Places")
		Add(CreateSettingsButtonInitializer("Keybindings", "Bind Keys", P.OpenKeybindings,
			"Opens the game's keybindings: one key each to open the window, ask what's next, ask about your target or the hovered item, or Okay the newest reply.", false))
		Add(CreateSettingsButtonInitializer("The Window", "Put It Back", function() ns.UI.ResetWindow() end,
			"Puts the window back at its first size and place.", false))
		Add(CreateSettingsButtonInitializer("The HUD", "Put It Back", function() if ns.HUD then ns.HUD.ResetPosition() end end,
			"Puts the HUD back beside the quest tracker.", false))
	end
	Settings.RegisterAddOnCategory(category)
	P.category = category
	return true
end

---------------------------------------------------------------------------
-- Our own window, where the game's Settings list is missing
---------------------------------------------------------------------------

local function Check(parent, label, tip)
	local cb = ns.UI.Create("CheckButton", nil, parent, { "UICheckButtonTemplate" })
	cb:SetSize(24, 24)
	cb.label = cb:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	cb.label:SetPoint("LEFT", cb, "RIGHT", 4, 0)
	cb.label:SetText(label)
	-- The template's own label (a frame field; anything else isn't one).
	local own = rawget(cb, "Text")
	if type(own) == "table" and type(own.SetText) == "function" then own:SetText("") end
	cb:SetScript("OnEnter", function(self) ns.Tip(self, { title = label, text = Value(tip) }) end)
	cb:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
	return cb
end

-- The page: switches, then choices, then buttons.
function P.BuildPage(parent)
	local page = CreateFrame("Frame", nil, parent)
	page:SetSize(W, 20 + (#SWITCHES + #CHOICES + #SLIDERS + 4) * ROW) -- [UX-3, pub:S]
	page.title = page:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	page.title:SetPoint("TOPLEFT", page, "TOPLEFT", 16, -16)
	page.title:SetText("NeverQuestAlone")
	page.checks, page.cycles = {}, {}
	local y = -48
	for i, sw in ipairs(SWITCHES) do
		if Shown(sw) then
			local cb = Check(page, ns.P(sw[2]), PTip(sw[5])) -- [UX-5]
			cb:SetPoint("TOPLEFT", page, "TOPLEFT", 16, y)
			cb:SetScript("OnClick", function(self)
				sw[4](self:GetChecked() and true or false)
				P.Refresh()
			end)
			page.checks[i] = cb
			y = y - ROW
		end
	end
	y = y - 8
	for i, ch in ipairs(CHOICES) do
		if Shown(ch) then
			local label = page:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
			label:SetPoint("TOPLEFT", page, "TOPLEFT", 20, y - 4)
			label:SetText(ch[2])
			-- Each click moves to the next choice; the button says the one in use.
			local b = ns.UI.Button(page, "", 150, function()
				local list, at = Opts(ch), 1
				for k, o in ipairs(list) do if o[1] == S()[ch[3]] then at = k end end
				SetChoice(ch[3], list[at % #list + 1][1])
			end)
			b:SetPoint("TOPLEFT", page, "TOPLEFT", 260, y)
			page.cycles[i] = b
			y = y - ROW
		end
	end
	-- Sliders, as a button that steps down and wraps (100%, 90%, … 60%, 100%).
	page.steps = {}
	for i, sl in ipairs(SLIDERS) do
		local label = page:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
		label:SetPoint("TOPLEFT", page, "TOPLEFT", 20, y - 4)
		label:SetText(sl[2])
		local b = ns.UI.Button(page, "", 150, function()
			local v = SliderValue(sl) - 2 * sl[6]
			SetSlider(sl, v < sl[4] and sl[5] or v)
		end)
		b:SetPoint("TOPLEFT", page, "TOPLEFT", 260, y)
		page.steps[i] = b
		y = y - ROW
	end
	y = y - 10
	local keys = ns.UI.Button(page, "Bind Keys", 110, P.OpenKeybindings)
	keys:SetPoint("TOPLEFT", page, "TOPLEFT", 16, y)
	local reset = ns.UI.Button(page, "Put the Window Back", 160, function() ns.UI.ResetWindow() end)
	reset:SetPoint("LEFT", keys, "RIGHT", 10, 0)
	local hud = ns.UI.Button(page, "Put the HUD Back", 150, function() if ns.HUD then ns.HUD.ResetPosition() end end)
	hud:SetPoint("LEFT", reset, "RIGHT", 10, 0)
	page:SetScript("OnShow", function() P.Refresh() end)
	P.page = page
	P.Refresh()
	return page
end

function P.Refresh()
	local page = P.page
	if not page or not ns.db then return end
	for i, sw in ipairs(SWITCHES) do
		if page.checks[i] then
			local ok, v = pcall(sw[3])
			page.checks[i]:SetChecked(ok and v and true or false)
		end
	end
	for i, ch in ipairs(CHOICES) do
		if not page.cycles[i] then -- a row that doesn't show here
		else
		page.cycles[i]:SetText(Words(ch, S()[ch[3]]))
		if ch.parent and ns.QoL and type(page.cycles[i].SetEnabled) == "function" then page.cycles[i]:SetEnabled(ns.QoL.Get(ch.parent)) end
		end
	end
	for i, sl in ipairs(SLIDERS) do page.steps[i]:SetText(ns.Int(SliderValue(sl)) .. "%") end
end

local function RegisterWindow()
	local win = ns.UI.Create("Frame", "NQASettings", UIParent, { "BasicFrameTemplateWithInset" })
	win:SetSize(W + 20, 20 + (#SWITCHES + #CHOICES + #SLIDERS + 5) * ROW + 40) -- [UX-3, pub:S]
	win:SetPoint("CENTER")
	win:SetFrameStrata("DIALOG")
	win:SetMovable(true)
	win:EnableMouse(true)
	win:RegisterForDrag("LeftButton")
	win:SetScript("OnDragStart", win.StartMoving)
	win:SetScript("OnDragStop", win.StopMovingOrSizing)
	if type(UISpecialFrames) == "table" then tinsert(UISpecialFrames, "NQASettings") end
	local page = P.BuildPage(win)
	page:SetPoint("TOPLEFT", win, "TOPLEFT", 4, -18)
	win:Hide()
	P.window = win
end

local function Register()
	if P.registered then return end
	P.registered = true
	local ok, done = pcall(RegisterList)
	if ok and done then return end
	RegisterWindow()
end

-- section: a header to scroll to ("Quality of Life"; Settings.OpenToCategory
-- finds a row by its name, Blizzard_SettingsList.lua:152). The game's Settings
-- open in a fight once it ends (ns.AfterCombat); our own window, where the
-- game's list is missing, opens at once.
function P.Open(section)
	Register()
	if P.category and type(Settings.OpenToCategory) == "function" then
		if ns.AfterCombat(function() P.Open(section) end, "Settings opens after the fight.") then return end
		local id = type(P.category.GetID) == "function" and P.category:GetID() or P.category.ID
		if pcall(Settings.OpenToCategory, id, section) then return end
	end
	if P.window then
		P.Refresh()
		P.window:Show()
	end
end

---------------------------------------------------------------------------
-- Ways in from the game's own UI
---------------------------------------------------------------------------

-- The minimap's addon menu: click opens Bones, right-click opens settings.
-- Its entry's name, which the ways back name (UI.WayBack).
P.compartmentName = "NeverQuestAlone"
local function Compartment()
	if type(AddonCompartmentFrame) ~= "table" or type(AddonCompartmentFrame.RegisterAddon) ~= "function" then return end
	pcall(AddonCompartmentFrame.RegisterAddon, AddonCompartmentFrame, {
		text = P.compartmentName,
		icon = ns.UI.FACE.square, -- a square slot: the square icon
		notCheckable = true,
		func = function(_, input)
			if type(input) == "table" and input.buttonName == "RightButton" then P.Open() else ns.UI.Toggle() end
		end,
		funcOnEnter = function(button)
			ns.Tip(button, { title = P.compartmentName, actions = { ns.P("Click to talk to NeverQuestAlone"), "Right-click for Settings" } }, "ANCHOR_LEFT") -- [UX-5]
		end,
		funcOnLeave = function() if GameTooltip then GameTooltip:Hide() end end,
	})
	P.compartment = true
end

-- "Ask Bones About This Quest" in the quest log's right-click menu.
local function QuestMenus()
	if type(Menu) ~= "table" or type(Menu.ModifyMenu) ~= "function" then return end
	pcall(Menu.ModifyMenu, "MENU_QUEST_MAP_LOG_TITLE", function(owner, root)
		local id = type(owner) == "table" and tonumber(owner.questID)
		if not id or type(root) ~= "table" or type(root.CreateButton) ~= "function" then return end
		if type(root.CreateDivider) == "function" then root:CreateDivider() end
		root:CreateButton(ns.P("Ask NeverQuestAlone About This Quest"), function() -- [UX-5]
			ns.QuickAsk("quest", { id = id, title = ns.Try(C_QuestLog and C_QuestLog.GetTitleForQuestID, id) })
		end)
	end)
	P.questMenu = true
end

-- The game's AddOns list. The 200 slots that bring replies in (docs/PROTOCOL.md
-- §1, §4) sit under a category row of their own there, named in their TOCs
-- (the bridge's slots.mjs), so the list shows that row and the addon's own,
-- with its check box (Blizzard_AddOnList, AddonList_Update). The list keeps which
-- categories are folded in g_addonCategoriesCollapsed, saved for the whole
-- computer (WTF/SavedVariables/Blizzard_AddOnList.lua) and read at character
-- select too. Setup folds the slots' row at install, before the game's first
-- start (the bridge's foldSlotCategory, C-119). This is the backstop, for an
-- install whose setup didn't (E-047):
--   - found folded at login (by setup, or by the player): remembered, and
--     never written, so a player who opens it later keeps it open;
--   - else at PLAYER_LOGOUT (a logout, a quit or a /reload), just before the
--     game saves that table: nothing of the game reads our write in this
--     session, and the next one reads it back from disk as the game's own,
--     so the game's AddOns list never runs with our taint and no protected
--     call follows from it;
--   - only our key, in the game's own table, which is never replaced or made;
--   - the category the client read from the slots' TOCs, else the name the
--     bridge writes now (ns.SLOT_CATEGORY: TOCs rewritten while the game ran
--     count from its next start, and the row is folded by then);
--   - once per name (db.partsFolded): a player who unfolds it keeps it open.
-- login: only look (PLAYER_LOGIN); the fold itself waits for the logout.
function P.FoldParts(login)
	local db, folded = ns.db, g_addonCategoriesCollapsed
	if type(db) ~= "table" or type(folded) ~= "table" then return end -- Blizzard_AddOnList not loaded: the next logout
	local category = type(C_AddOns) == "table" and ns.Try(C_AddOns.GetAddOnMetadata, string.format("%s%03d", ns.SLOT_PREFIX, 1), "Category")
	if type(category) ~= "string" or category == "" then category = ns.SLOT_CATEGORY end
	if type(category) ~= "string" or db.partsFolded == category then return end
	if folded[category] then
		db.partsFolded = category
		return
	end
	if login then return end
	folded[category] = true
	db.partsFolded = category
end

-- [C-18] A slot came (Commands.lua, ns.NoteSlot): the page, if it waited
-- for one, now that the companion's name is known.
function P.Ready()
	Register()
end

-- The page waits for the first slot (P.Ready), or 10 s: its labels are fixed
-- when it's made, and the companion's name comes with that slot (at once
-- where there's no timer). -- [C-18]
ns.On("PLAYER_LOGIN", function()
	if C_Timer and C_Timer.After then
		C_Timer.After(10, Register)
	else
		Register()
	end
	Compartment()
	QuestMenus()
	pcall(P.FoldParts, true)
end)
-- Last of the addon's logout work (this file loads last), and never an error.
ns.On("PLAYER_LOGOUT", function() pcall(P.FoldParts) end)
