-- UI.lua: the window, in the game's own look (PRD §8.1, the maintainer's ruling): the
-- frame templates of Mail and Communities (gold-trimmed border, dark stone
-- background, gold title), Blizzard's red buttons, insets and scroll bars.
--
-- Every template is tried in order and falls back to the next, ending with a
-- BackdropTemplate dialog border, so a template this client lacks never costs
-- the window. Intrinsic templates (DropdownButton, EventFrame scroll bars) are
-- not used at all: their OnLoad errors can't be caught.
--
--   left:   chats (New chat, rows with busy and unread badges, right-click menu)
--   right:  the transcript (bubbles; click one to copy it), the working bubble
--           with Stop, and the composer (Enter sends, Shift+Enter a new line)
--   header: the status light, the chat's name, a status line
--   Esc minimizes to a small bar with the light and the unread badge.

local _, ns = ...
local U = {}
ns.UI = U
local R = ns.R
local ui = {}
U.ui = ui

local PANEL_W = 220 -- the chat list: its 12-pt names need the room
-- The chat list (maintainer: "not so crammed"; the rest "not limited by the
-- invisible scrollbar"): its buttons and its rows' words LIST_IN from both
-- edges; a row's two lines centred in ROW_H, ROW_GAP between; the scroll
-- bar's room only while the chats don't fit.
local ROW_H = 52
local LIST_IN = 10
local ROW_IN = 6 -- a row's words from its edges: the rows sit LIST_IN - ROW_IN in
local ROW_GAP = 4
local SCROLL_GUTTER = 26
local LIST_FOOT = 8 -- the rows end 8 above the list's bottom edge
local COMPOSER_H = 62
local CONTEXT_H = 24 -- above the composer: game data (a tick) and how hard Bones thinks (a menu)
local SEND_W = 86
local BOTTOM = 14 -- the window's gutter at the bottom
local EDGE = 14 -- and at its sides: no button touches the frame's border
local FOOTER_H = 18
local MAX_BUBBLES = 100
local WORK_H = 46
-- A bubble's spacing, on the HUD's 4-unit rhythm: 10 in from its sides, 8 in
-- from its top and bottom, 4 under the name, 8 between blocks and bubbles.
local BUBBLE_X, BUBBLE_Y, BUBBLE_GAP = 10, 8, 8
local BODY_TOP = BUBBLE_Y + 12 + 4 -- under the name's line
-- A reply while the HUD doesn't show it (closed, off, the compass) is one
-- banner at the top middle, where it's seen (maintainer: "top middle so the user
-- sees it"). It hangs 4 under the game's top-centre widgets (battleground
-- scores, capture bars; UIWidgetTopCenterContainerFrame at TOP -15, which
-- grows down), as the game's own Return to Graveyard button does
-- (GhostFrame.lua), else at TOP -30: clear of the breath bar (MirrorTimer at
-- TOP -100), the error line (TOP -122) and the zone's name (TOP -128). As
-- wide as the error line (512). It stays until Okay (read, put away) or Open
-- Chat, as the HUD's news does: nothing goes by itself. A newer reply takes
-- its place.
local TOAST_MAX = 1
local TOAST_W = 512
-- [ingame-clarity] The smallest the grip makes it: the composer, Send and the working line still fit
-- (a player, 2026-10-05: "In game window is too big/can't see").
local MIN_W, MIN_H = 400, 300
local CHIP_H, PILL_H = 24, 20
local STICK_SLACK = 24 -- within this many units of the bottom counts as "at the bottom"
-- The small bar's default place: top right, left of the quest tracker and
-- under the buffs (the top-centre is the game's).
local DOCK_POINT, DOCK_X, DOCK_Y = "TOPRIGHT", -272, -264
local EVENT_ICON = {
	level_up = "Interface\\Icons\\Spell_ChargePositive",
	route_done = "Interface\\Icons\\INV_Misc_Map_01",
	route_stale = "Interface\\Icons\\INV_Misc_Note_01",
	zone_first = "Interface\\Icons\\Ability_Townwatch",
}
local EVENT_COLOR = { 0.78, 0.72, 0.60 }
U.EVENT_ICON = EVENT_ICON
local PIN_ATLAS = "Waypoint-MapPin-Tracked" -- Forever's map pin (Blizzard_SharedMapDataProviders)
local PIN_FALLBACK = "Interface\\TargetingFrame\\UI-RaidTargetingIcon_1"
-- Store.lua's defaults: left of the middle of the world, the chat list folded. [ingame-clarity] Half
-- the screen's height at most (560 by 540 was 70% of a 768-unit screen; a size you set is kept, Store.lua).
local DEFAULT_W, DEFAULT_H = 420, 380
-- Where the window opens by default: top left, where the game's own panels
-- open (the character sheet, the spellbook), clear of the middle of the world.
local HOME_POINT, HOME_X, HOME_Y = "TOPLEFT", 16, -116
-- Bones's faces: the app icon's glass skull in Media. Round slots (this window's
-- portrait, the HUD's) take the round portrait, its 64 px twin where it's
-- drawn under 52 pixels (U.RoundFace); square slots (the reply banner's icon,
-- the addon compartment, the HUD's fallback face) the square icon. The round
-- texture in a square slot would show a hard dark square with a small skull.
U.FACE = {
	round = "Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone-portrait",
	round64 = "Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone-portrait-64",
	square = "Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone",
}
local TOAST_FACE = U.FACE.square
local LIGHT = {
	green = "Interface\\FriendsFrame\\StatusIcon-Online",
	yellow = "Interface\\FriendsFrame\\StatusIcon-Away",
	red = "Interface\\FriendsFrame\\StatusIcon-DnD",
	grey = "Interface\\FriendsFrame\\StatusIcon-Offline",
	wait = "Interface\\FriendsFrame\\StatusIcon-Offline",
	paste = "Interface\\FriendsFrame\\StatusIcon-Offline", -- Copy and Paste: no app yet, and nothing wrong (Transport.Light)
}
local ROLE_COLOR = {
	user = { 0.49, 0.78, 1.00 },
	assistant = { 1.00, 0.82, 0.00 },
	system = { 0.70, 0.70, 0.70 },
	error = { 1.00, 0.44, 0.44 },
}
local BACKDROPS = {
	dialog = {
		bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background-Dark",
		edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
		tile = true, tileSize = 32, edgeSize = 32,
		insets = { left = 11, right = 12, top = 12, bottom = 11 },
	},
	inset = {
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	},
	tooltip = {
		bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 16,
		insets = { left = 4, right = 4, top = 4, bottom = 4 },
	},
}

---------------------------------------------------------------------------
-- Guarded construction
---------------------------------------------------------------------------

-- true or false when the client can say whether a template exists; nil when it can't.
local function TemplateKnown(name)
	if type(C_XMLUtil) == "table" and type(C_XMLUtil.GetTemplateInfo) == "function" then
		local ok, info = pcall(C_XMLUtil.GetTemplateInfo, name)
		if ok then return info ~= nil end
	end
	return nil
end

-- The first of `templates` this client can build, else a plain frame.
local function Create(kind, name, parent, templates)
	for _, tpl in ipairs(templates or {}) do
		if TemplateKnown(tpl) ~= false then
			local ok, f = pcall(CreateFrame, kind, name, parent, tpl)
			if ok and f then return f, tpl end
		end
	end
	return CreateFrame(kind, name, parent), nil
end

-- A template child (a frame table), or nil.
local function Child(f, key)
	local v = f and f[key]
	return type(v) == "table" and v or nil
end

local Call = ns.Call -- a method this client has, called safely (Store.lua)

local function Backdrop(f, style, r, g, b, a)
	if type(f.SetBackdrop) == "function" then
		f:SetBackdrop(BACKDROPS[style])
		if r and type(f.SetBackdropColor) == "function" then f:SetBackdropColor(r, g, b, a) end
	else
		local bg = f:CreateTexture(nil, "BACKGROUND")
		bg:SetAllPoints()
		bg:SetColorTexture(r or 0.05, g or 0.05, b or 0.05, a or 0.92)
	end
end

local function Button(parent, label, width, onClick, name)
	local b = Create("Button", name, parent, { "UIPanelButtonTemplate" })
	b:SetSize(width, 22)
	b:SetText(label)
	b:SetScript("OnClick", onClick)
	return b
end

local function ScrollArea(name, parent)
	local sf, tpl = Create("ScrollFrame", name, parent, { "UIPanelScrollFrameTemplate" })
	local content = CreateFrame("Frame", name .. "Content", sf)
	content:SetSize(10, 10)
	sf:SetScrollChild(content)
	if not tpl then
		-- No scroll bar without the template; the mouse wheel still scrolls.
		sf:EnableMouseWheel(true)
		sf:SetScript("OnMouseWheel", function(self, delta)
			local range = self:GetVerticalScrollRange() or 0
			local v = (self:GetVerticalScroll() or 0) - delta * 40
			self:SetVerticalScroll(math.max(0, math.min(range, v)))
		end)
	end
	return sf, content
end

-- Tooltips, one shape everywhere (maintainer: consistent language, titles and
-- structure), the game's own (SharedTooltipTemplates.lua: GameTooltip_SetTitle,
-- then its normal, instruction and disabled lines):
--   title    what it is, in Title Case: white; a key in gold after it
--   text     what it does or shows, one or two plain sentences: gold
--   lines    what it carries (a stop's note, a message): white
--   actions  what the mouse does, one each ("Click to ...", "Right-click for
--            ...", "Drag to ...", "Shift-click to ..."): green, in <brackets>
--   note     a command, or what else to know: grey
local TIP_GOLD, TIP_GREEN, TIP_GREY = { 1, 0.82, 0 }, { 0.1, 1, 0.1 }, { 0.5, 0.5, 0.5 }
function ns.TipLines(tip, t)
	if not tip or type(t) ~= "table" then return end
	tip:SetText((t.title or "") .. (t.key and (" |cffffd100(" .. t.key .. ")|r") or ""), 1, 1, 1, 1, true)
	if t.text and t.text ~= "" then tip:AddLine(t.text, TIP_GOLD[1], TIP_GOLD[2], TIP_GOLD[3], true) end
	for _, l in ipairs(t.lines or {}) do tip:AddLine(l, 1, 1, 1, true) end
	for _, a in ipairs(t.actions or {}) do tip:AddLine("<" .. a .. ">", TIP_GREEN[1], TIP_GREEN[2], TIP_GREEN[3], true) end
	if t.note and t.note ~= "" then tip:AddLine(t.note, TIP_GREY[1], TIP_GREY[2], TIP_GREY[3], true) end
end
function ns.Tip(owner, t, anchor)
	if not GameTooltip or not owner then return end
	GameTooltip:SetOwner(owner, anchor or "ANCHOR_RIGHT")
	ns.TipLines(GameTooltip, t)
	GameTooltip:Show()
end
-- [UX-5] Our own words in the companion's name: ns.P on title, text,
-- actions and note, never on lines (data). raw: already display-ready, data
-- inside.
function ns.OurTip(t)
	if type(t) ~= "table" or t.raw then return t end
	local o = {}
	for k, v in pairs(t) do o[k] = v end
	for _, k in ipairs({ "title", "text", "note" }) do if type(o[k]) == "string" then o[k] = ns.P(o[k]) end end
	if type(t.actions) == "table" then
		o.actions = {}
		for i, a in ipairs(t.actions) do o.actions[i] = ns.P(a) end
	end
	return o
end
local function ShowTip(owner, t) ns.Tip(owner, ns.OurTip(t)) end

local function HideTip()
	if GameTooltip then GameTooltip:Hide() end
end

-- The chat font at the size the player picked (/bones text small|medium|large).
-- [C-07] baseName: another font object sized the same way (an error's
-- details, a reply's cost: "GameFontDisable"), never under 11 pt (maintainer:
-- nothing under 11); maxDelta: the most it grows. Main's calls pass neither.
-- Without GetFont (an old client or the test stub) the font object's own size stays.
local MIN_PT = 11
local function ApplyTextSize(fs, baseName, maxDelta)
	local base = baseName and _G[baseName] or ChatFontNormal
	if not fs or type(base) ~= "table" or type(base.GetFont) ~= "function" then return end
	local file, size, flags = base:GetFont()
	if not file or not size then return end
	local pick = ns.db and ns.db.settings.textSize or "medium"
	local delta = ns.TEXT_SIZES[pick] or 0
	delta = math.min(delta, maxDelta or delta)
	pcall(fs.SetFont, fs, file, baseName and math.max(MIN_PT, size + delta) or (size + delta), flags or "")
end
U.ApplyTextSize = ApplyTextSize

-- The composer's hint stops at Large's size: two lines of it fit main's box.
local HINT_MAX = 3

-- A new text size: the box you type in and every bubble, keeping your place.
function U.TextSizeChanged()
	if ui.input then ApplyTextSize(ui.input) end
	if ui.hint then ApplyTextSize(ui.hint, nil, HINT_MAX) end -- Extra Large's hint stays Large
	if ui.frame and ns.Chats.Active() then U.RenderTranscript("size") end
end

-- Message times or the name on your messages changed (Settings): the
-- conversation and the chat list, as they're shown.
function U.LookChanged()
	if ui.frame and ns.Chats.Active() then U.RenderTranscript("size") end
	U.RenderList()
end

-- Copy is Cmd+C on a Mac, Ctrl+C elsewhere.
local function CopyKey()
	return (type(IsMacClient) == "function" and IsMacClient()) and "Cmd+C" or "Ctrl+C"
end

-- A small rounded button with a label: chips (suggested replies) and
-- reference pills. Pooled by the caller.
local function MakeChip(parent, height)
	local c = CreateFrame("Button", nil, parent)
	c:SetHeight(height)
	-- A 1-unit bronze edge: a texture one unit bigger, under the fill (sublevels).
	c.edge = c:CreateTexture(nil, "BACKGROUND", nil, -8)
	c.edge:SetPoint("TOPLEFT", c, "TOPLEFT", -1, 1)
	c.edge:SetPoint("BOTTOMRIGHT", c, "BOTTOMRIGHT", 1, -1)
	c.edge:SetColorTexture(0.42, 0.32, 0.19, 0.9)
	c.bg = c:CreateTexture(nil, "BACKGROUND", nil, 0)
	c.bg:SetAllPoints()
	c.bg:SetColorTexture(0.13, 0.11, 0.08, 0.95)
	local hl = c:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	hl:SetColorTexture(1, 0.82, 0, 0.14)
	c.label = c:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	c.label:SetPoint("LEFT", c, "LEFT", 9, 0)
	c.label:SetJustifyH("LEFT")
	c.label:SetWordWrap(false)
	c:RegisterForClicks("LeftButtonUp")
	return c
end

-- Lay chips out left to right, wrapping at width; returns the height used.
local function FlowChips(chips, parent, x0, y0, width, height, gap)
	local x, y = x0, y0
	for _, c in ipairs(chips) do
		if c:IsShown() then
			-- The text's own width, not what an earlier SetWidth left (pooled chips).
			local tw = (c.label.GetUnboundedStringWidth and c.label:GetUnboundedStringWidth()) or c.label:GetStringWidth() or 60
			local w = math.min(width, math.floor(tw + 18))
			if x > x0 and x + w > x0 + width then
				x = x0
				y = y + height + gap
			end
			c:SetWidth(w)
			c.label:SetWidth(w - 12)
			c:ClearAllPoints()
			c:SetPoint("TOPLEFT", parent, "TOPLEFT", x, -y)
			x = x + w + gap
		end
	end
	return (y - y0) + height
end
U.MakeChip, U.FlowChips = MakeChip, FlowChips
U.Create, U.Child, U.Button = Create, Child, Button

-- The default place for the HUD, the small bar and the navigator: left of the
-- quest tracker and level with its top, anchored to it so they follow it
-- wherever Edit Mode puts it (right of it when its left leaves no room).
-- Anchoring to the tracker reads it; nothing of the game's is moved. dy: how
-- far below its top. Without the tracker, top right under the buffs.
function U.Dock(f, dy)
	f:ClearAllPoints()
	local t = type(ObjectiveTrackerFrame) == "table" and ObjectiveTrackerFrame or nil
	local left = t and ns.Try(t.GetLeft, t)
	if type(left) == "number" then
		local es = ns.Try(t.GetEffectiveScale, t) or 1
		local us = ns.Try(UIParent.GetEffectiveScale, UIParent) or 1
		left = left * es / us
		if left >= (f:GetWidth() or 300) + 24 then
			f:SetPoint("TOPRIGHT", t, "TOPLEFT", -12, dy or 0)
		else
			f:SetPoint("TOPLEFT", t, "TOPRIGHT", 12, dy or 0)
		end
		return
	end
	f:SetPoint(DOCK_POINT, UIParent, DOCK_POINT, DOCK_X, DOCK_Y + (dy or 0))
end

-- The status light: a friends-list status icon with the SD-1 tooltip.
-- The corner's buttons, one family for the HUD and the window: the game's red
-- set ("128-redbutton-minus", "-plus", "-exit"; UIButtonTemplate's
-- SetButtonArtKit names their states), so + is the exact inverse of -, beside
-- the same X. Where a kit is missing, the older red set, then the older panel
-- buttons. KitArt gives a button a kind's art (the list's - turns +).
local OLD_RED = { minus = "RedButton-MiniCondense", plus = "RedButton-Expand", exit = "RedButton-Exit" }
local OLD_FILE = { minus = "UI-Panel-SmallerButton", plus = "UI-Panel-BiggerButton", exit = "UI-Panel-MinimizeButton" }
function U.KitArt(b, kind)
	local function Has(atlas) return C_Texture and ns.Try(C_Texture.GetAtlasExists, atlas) end
	local kit = "128-redbutton-" .. kind
	if b.SetNormalAtlas and Has(kit) then
		Call(b, "SetNormalAtlas", kit)
		if Has(kit .. "-Pressed") then Call(b, "SetPushedAtlas", kit .. "-Pressed") end
		if Has(kit .. "-Disabled") then Call(b, "SetDisabledAtlas", kit .. "-Disabled") end
		if Has(kit .. "-Highlight") then Call(b, "SetHighlightAtlas", kit .. "-Highlight") else Call(b, "SetHighlightAtlas", "RedButton-Highlight", "ADD") end
	elseif b.SetNormalAtlas and Has(OLD_RED[kind]) then
		Call(b, "SetNormalAtlas", OLD_RED[kind])
		Call(b, "SetHighlightAtlas", "RedButton-Highlight", "ADD")
	else
		Call(b, "SetNormalTexture", "Interface\\Buttons\\" .. OLD_FILE[kind] .. "-Up")
		Call(b, "SetPushedTexture", "Interface\\Buttons\\" .. OLD_FILE[kind] .. "-Down")
		Call(b, "SetHighlightTexture", "Interface\\Buttons\\UI-Panel-MinimizeButton-Highlight", "ADD")
	end
	b.kind = kind
end
function U.KitButton(parent, kind, onClick, size)
	local b = CreateFrame("Button", nil, parent)
	b:SetSize(size or 24, size or 24)
	U.KitArt(b, kind)
	b:SetScript("OnClick", function(self)
		HideTip()
		if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
		onClick(self)
	end)
	return b
end

local function MakeLight(parent, name)
	local holder = CreateFrame("Frame", name, parent)
	holder:SetSize(16, 16)
	holder.icon = holder:CreateTexture(nil, "OVERLAY")
	holder.icon:SetAllPoints()
	holder.icon:SetTexture(LIGHT.wait)
	holder:EnableMouse(true)
	holder:SetScript("OnEnter", function(self) -- [UX-2, UX-W23] with cap ekind, where its click goes
		ShowTip(self, { title = "Connection", text = self.tip, actions = ns.HasCap("ekind") and { "Click to see this in the window" } or nil })
	end)
	holder:SetScript("OnLeave", HideTip)
	-- [UX-2] With cap ekind its reasons are a click away too: the window opens on them.
	holder:SetScript("OnMouseUp", function(self, button)
		if button == "LeftButton" and ns.HasCap("ekind") then U.ShowDetails(self.tip) end
	end)
	return holder
end

---------------------------------------------------------------------------
-- Visibility
---------------------------------------------------------------------------

-- A status line's words, in the window: open, and said in the chat you're on
-- (the HUD's status lines, a click away).
function U.ShowDetails(text)
	if type(text) ~= "string" or text == "" then return end
	HideTip()
	U.Toggle(true)
	ns.Chats.Notice(ns.Chats.Active(), text)
end

function U.IsOpen()
	return ui.frame ~= nil and ui.frame:IsShown() and true or false
end

-- Is this chat on screen right now?
function U.IsShowing(chatId)
	return U.IsOpen() and ns.db ~= nil and ns.db.activeChat == chatId
end

function U.Toggle(show)
	if not ui.frame then return end
	if show == nil then show = not ui.frame:IsShown() end
	local db = ns.db
	if show then
		db.settings.minimized = false
		db.settings.miniHidden = nil
		local c = ns.Chats.Active()
		if c then c.unread = 0 end
	end
	if ui.mini then ui.mini:Hide() end
	if not show then ui.quitting = true end
	ui.frame:SetShown(show)
	ui.quitting = nil
	db.settings.shown = show
	ns.Refresh("all")
end

-- The Bones HUD (HUD.lua) stands in for the mini bar while it's on. It's a new
-- file, so after a /reload without a restart it isn't there: the bar is.
function U.HUDActive()
	return ns.HUD ~= nil and ns.db ~= nil and ns.db.settings.hud == true
end

-- Esc and the X collapse the window to the HUD (or the mini bar); the bar's
-- own X hides all.
function U.Minimize(mini)
	if not ui.frame then return end
	if mini == nil then mini = not ns.db.settings.minimized end
	if mini then
		ns.db.settings.minimized = true
		ns.db.settings.shown = true
		ui.frame:Hide()
		if ui.mini and not U.HUDActive() then ui.mini:Show() end
		ns.Refresh("status")
	else
		U.Toggle(true)
	end
end

function U.FocusInput()
	if ui.input then ui.input:SetFocus() end
end

-- The key binding (Bindings.xml): opens the window with the cursor in the box,
-- or closes it when it's already open. While you type, the box has the
-- keyboard and the binding can't fire, so the box catches the same key itself
-- (U.KeyClosesWindow).
function U.OpenAndType()
	if ui.frame and ui.frame:IsShown() then
		U.Close()
		return
	end
	U.Toggle(true)
	-- The key that opened us must not be typed into the box: its character event
	-- arrives right after the binding runs, so focus moves in on the next frame,
	-- and a character within 0.2 s of opening is taken back all the same.
	if ui.input then ui.input.nqaOpenedAt, ui.input.nqaOpenText = GetTime(), ui.input:GetText() end
	if C_Timer and C_Timer.After then C_Timer.After(0, U.FocusInput) else U.FocusInput() end
end

-- Open with the cursor in the box, never close (/br, [reply] links).
function U.OpenAndFocus()
	U.Toggle(true)
	U.FocusInput()
end

-- Close the window (the draft stays with its chat).
function U.Close()
	U.SaveDraft()
	if ui.input then ui.input:ClearFocus() end
	U.Toggle(false)
end

-- The pressed key as a binding string: "CTRL-B", "F9", "ALT-SHIFT-X".
local function ChordFor(key)
	if type(CreateKeyChordStringUsingMetaKeyState) == "function" then
		local ok, chord = pcall(CreateKeyChordStringUsingMetaKeyState, key)
		if ok and type(chord) == "string" and chord ~= "" then return chord end
	end
	local chord = ""
	if type(IsAltKeyDown) == "function" and IsAltKeyDown() then chord = chord .. "ALT-" end
	if type(IsControlKeyDown) == "function" and IsControlKeyDown() then chord = chord .. "CTRL-" end
	if type(IsShiftKeyDown) == "function" and IsShiftKeyDown() then chord = chord .. "SHIFT-" end
	if type(IsMetaKeyDown) == "function" and IsMetaKeyDown() then chord = chord .. "META-" end
	return chord .. key
end

-- Whether a key pressed in the input box is the NeverQuestAlone binding. Only keys a
-- typist can't mean as text count: a chord with Ctrl, Alt or Cmd, or a
-- function key. Bound to a plain letter, the letter still types (Esc first).
function U.KeyClosesWindow(key)
	if type(key) ~= "string" or type(GetBindingKey) ~= "function" then return false end
	local chord = ChordFor(key)
	for _, bound in pairs({ GetBindingKey("NQA_OPEN_AND_TYPE") }) do
		if type(bound) == "string" and bound == chord then
			local base = bound:gsub("^.*%-", "")
			if bound:find("ALT%-") or bound:find("CTRL%-") or bound:find("META%-") or base:find("^F%d+$") then return true end
		end
	end
	return false
end

function U.RestoreShown()
	local s = ns.db.settings
	if not s.shown then return end
	if s.minimized then U.Minimize(true) else U.Toggle(true) end
end

-- [both:B B-3] (L1-1) A key is never kept as a draft: the box is cleared and the
-- refusal said (quiet: the caller says it, as a chat switch does in the chat
-- you land on). Returns true when it refused one.
function U.SaveDraft(quiet)
	local chat = ns.Chats.Active()
	if not ui.input or not chat then return end
	local text = ui.input:GetText() or ""
	if ns.Chats.KeyShaped(text) then
		chat.draft = nil
		ui.input:SetText("")
		if not quiet then ns.Notify.Game(ns.Chats.KeyRefused(), true) end
		return true
	end
	chat.draft = ns.Trim(text) ~= "" and text or nil
end

-- The words in the box survive a reload or a logout (a Reload the window asks for, say):
-- kept with their chat at PLAYER_LOGOUT, back in the box at the next login (Commands.lua).
-- With Game Data unchecked they come back unchecked too: their message goes without it.
ns.On("PLAYER_LOGOUT", function()
	U.SaveDraft(true)
	local chat = ns.Chats.Active()
	if chat then chat.draftBare = (chat.draft ~= nil and R.skipGameData) and true or nil end
end)

function U.RestoreDraft(chat)
	if not ui.input then return end
	local draft = chat and chat.draft or ""
	if ns.Chats.KeyShaped(draft) then draft = "" end -- [both:B B-3] (L1-1) one kept before the fix: never back in the box
	ui.input:SetText(draft)
	if chat then
		if chat.draftBare and draft ~= "" then R.skipGameData = true end -- unchecked when it was kept (above)
		chat.draft, chat.draftBare = nil, nil
	end
end

-- A leading / in the box runs a command instead of sending it: /think high,
-- /new, /stop, /help, /bones <anything>, /br <text>. A / word that isn't a
-- command says so, and nothing is sent.
local function RunTyped(text)
	local body = text:match("^/(.*)$")
	if not body then return false end
	if ns.Chats.KeyShaped(text) then -- [both:B B-2] (KY-10) before any command keeps it or echoes it
		ns.Chats.RefuseKey()
		return true
	end
	local word, rest = body:match("^(%S*)%s*(.-)$")
	word = (word or ""):lower()
	-- [UX-6] /bones, or the short /nqa.
	if word == "bones" or word == "nqa" then
		if ns.HandleCommand then ns.HandleCommand(rest) end
	elseif word == "br" then
		if ns.HandleReply then ns.HandleReply(rest) end
	elseif ns.IsCommand and ns.IsCommand(word, rest) then
		ns.HandleCommand(body)
	else
		ns.Chats.Notice(ns.Chats.Active(), ns.Fill(ns.P("Not a command: /{word}. /help lists them. To send it to NeverQuestAlone as it is, leave out the /."), { word = ns.Escape(word) })) -- [UX-5]
	end
	return true
end
U.RunTyped = RunTyped

function U.SendFromInput()
	if not ui.input then return end
	local text = ui.input:GetText() or ""
	local trimmed = ns.Trim(text)
	if trimmed == "" then return end
	if trimmed:sub(1, 1) == "/" then
		ui.input:SetText("")
		ui.recall = nil
		RunTyped(trimmed)
		return
	end
	-- Too long: the text stays in the box to be shortened (Chats.Send says why).
	-- Game data's tick belongs to this box: unticked, what's sent from here goes
	-- without it until it's ticked again.
	local key, _, refused = ns.Chats.Send(text, nil, { skipGameData = R.skipGameData })
	if key then
		ui.input:SetText("")
		ui.recall = nil
		ui.input:ClearFocus() -- hand the keyboard back to the game
		U.RenderContext()
	elseif refused == "key" then -- [both:B B-2] (KY-10) an API key goes from the box at once, so no draft keeps it
		ui.input:SetText("")
		ui.recall = nil
	end
end

-- Up and Down on an empty box (or on a line Up brought back) step through
-- what you sent in this chat, newest first, like the game's chat box.
function U.Recall(dir)
	local input = ui.input
	local chat = ns.Chats.Active()
	if not input or not chat then return false end
	local text = input:GetText() or ""
	local r = ui.recall
	if r and r.chat ~= chat.id then r = nil end
	if text ~= "" and not (r and text == r.shown) then return false end
	local list = ns.Chats.SentTexts(chat)
	if #list == 0 then return false end
	local i = (r and r.i or 0) + (dir == "UP" and 1 or -1)
	if i < 1 then
		ui.recall = nil
		input:SetText("")
		return true
	end
	i = math.min(i, #list)
	ui.recall = { chat = chat.id, i = i, shown = list[i] }
	input:SetText(list[i])
	if input.SetCursorPosition then input:SetCursorPosition(#list[i]) end
	return true
end

-- The only way NeverQuestAlone reloads the UI: from a click or a typed command, which
-- are hardware events. Never from an event handler or a timer (upstream #7).
function ns.Reload()
	if ns.InCombat() then
		ns.Notify.Local("Can't reload during combat. The Reload button comes back when the fight ends.")
		return false
	end
	if type(ReloadUI) == "function" then ReloadUI() end
	return true
end

---------------------------------------------------------------------------
-- Dialogs and the chat menu
---------------------------------------------------------------------------

local function DialogBox(dialog)
	return (type(dialog.GetEditBox) == "function" and dialog:GetEditBox()) or dialog.editBox
end

StaticPopupDialogs["NQA_RENAME"] = {
	text = "Rename this chat",
	button1 = "Rename",
	button2 = CANCEL,
	hasEditBox = 1,
	maxLetters = ns.NAME_MAX,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = DialogBox(dialog)
		if box then
			box:SetText(data and data.name or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = DialogBox(dialog)
		if data and box then ns.Chats.Rename(data.id, box:GetText()) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["NQA_RENAME"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- [G-2, UX-W08] Where the chat's history lives (here and in the desktop
-- app), that it's for good, and the verb on its button.
StaticPopupDialogs["NQA_DELETE"] = {
	text = "Delete the chat \"%s\"?\n\nIts chat history is deleted here and in the NeverQuestAlone app. This can't be undone.",
	button1 = "Delete",
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then ns.Chats.Delete(data.id) end
	end,
}

function U.RenamePrompt(id)
	local c = ns.Chats.Find(id) or ns.Chats.Active()
	if c then StaticPopup_Show("NQA_RENAME", nil, nil, { id = c.id, name = c.name }) end
end

function U.ConfirmDelete(id)
	local c = ns.Chats.Find(id) or ns.Chats.Active()
	if c then StaticPopup_Show("NQA_DELETE", ns.Escape(c.name), nil, { id = c.id }) end
end

-- Our own small menu, where Blizzard's MenuUtil isn't available.
local function FallbackMenu()
	if ui.menu then return ui.menu end
	local menu, tpl = Create("Frame", "NQAChatMenu", UIParent, { "TooltipBackdropTemplate", "BackdropTemplate" })
	if tpl ~= "TooltipBackdropTemplate" then Backdrop(menu, "tooltip", 0.05, 0.05, 0.05, 0.95) end
	menu:SetSize(130, 4 * 20 + 12)
	menu:SetFrameStrata("TOOLTIP")
	menu:EnableMouse(true)
	menu.title = menu:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -8)
	menu.title:SetPoint("RIGHT", menu, "RIGHT", -8, 0)
	menu.title:SetJustifyH("LEFT")
	menu.title:SetWordWrap(false)
	local function Item(label, order, onClick)
		local it = CreateFrame("Button", nil, menu)
		it:SetSize(118, 20)
		it:SetPoint("TOPLEFT", menu, "TOPLEFT", 6, -6 - order * 20)
		local hl = it:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.12)
		it.label = it:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		it.label:SetPoint("LEFT", it, "LEFT", 6, 0)
		it.label:SetText(label)
		it:SetScript("OnClick", function()
			menu:Hide()
			onClick(menu.chatId)
		end)
		return it
	end
	menu.pin = Item("Pin to Top", 1, function(id) ns.Chats.SetPinned(id) end)
	menu.rename = Item("Rename…", 2, U.RenamePrompt)
	menu.delete = Item("Delete", 3, U.ConfirmDelete)
	-- Close once the mouse has wandered away from the menu and its row.
	menu:SetScript("OnUpdate", function(self, dt)
		if self:IsMouseOver() or (self.owner and self.owner:IsMouseOver()) then
			self.away = 0
		else
			self.away = (self.away or 0) + dt
			if self.away > 0.5 then self:Hide() end
		end
	end)
	menu:Hide()
	ui.menu = menu
	return menu
end

-- Right-click on a chat row: Pin to Top (or Unpin), Rename, Delete.
function U.ChatMenu(chatId, anchor)
	local c = ns.Chats.Find(chatId)
	if not c then return end
	if type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local ok = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
			root:CreateTitle(ns.Escape(c.name))
			root:CreateButton(c.pinned and "Unpin" or "Pin to Top", function() ns.Chats.SetPinned(chatId) end)
			root:CreateButton("Rename…", function() U.RenamePrompt(chatId) end)
			root:CreateButton("Delete", function() U.ConfirmDelete(chatId) end)
		end)
		if ok then return end
	end
	local menu = FallbackMenu()
	if menu:IsShown() and menu.chatId == chatId then
		menu:Hide()
		return
	end
	menu.chatId, menu.owner, menu.away = chatId, anchor, 0
	menu.title:SetText(ns.Escape(c.name))
	menu.pin.label:SetText(c.pinned and "Unpin" or "Pin to Top")
	menu:ClearAllPoints()
	menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 8, 2)
	menu:Show()
end

-- A small right-click menu: the game's (MenuUtil) where it's there, else a
-- plain one of ours. items: { { label, onClick }, ... }.
function U.PopupMenu(anchor, title, items)
	if type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local ok = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
			root:CreateTitle(title)
			for _, it in ipairs(items) do root:CreateButton(it[1], it[2]) end
		end)
		if ok then return end
	end
	local menu = ui.popup
	if not menu then
		local tpl
		menu, tpl = Create("Frame", "NQAPopupMenu", UIParent, { "TooltipBackdropTemplate", "BackdropTemplate" })
		if tpl ~= "TooltipBackdropTemplate" then Backdrop(menu, "tooltip", 0.05, 0.05, 0.05, 0.95) end
		menu:SetFrameStrata("TOOLTIP")
		menu:EnableMouse(true)
		menu.title = menu:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
		menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -8)
		menu.title:SetJustifyH("LEFT")
		menu.items = {}
		menu:SetScript("OnUpdate", function(self, dt)
			if self:IsMouseOver() or (self.owner and self.owner:IsMouseOver()) then
				self.away = 0
			else
				self.away = (self.away or 0) + dt
				if self.away > 0.5 then self:Hide() end
			end
		end)
		ui.popup = menu
	end
	menu.title:SetText(title)
	for i, it in ipairs(items) do
		local b = menu.items[i]
		if not b then
			b = CreateFrame("Button", nil, menu)
			b:SetSize(200, 20)
			b:SetPoint("TOPLEFT", menu, "TOPLEFT", 6, -6 - i * 20)
			local hl = b:CreateTexture(nil, "HIGHLIGHT")
			hl:SetAllPoints()
			hl:SetColorTexture(1, 1, 1, 0.12)
			b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
			b.label:SetPoint("LEFT", b, "LEFT", 6, 0)
			menu.items[i] = b
		end
		b.label:SetText(it[1])
		b:SetScript("OnClick", function()
			menu:Hide()
			it[2]()
		end)
		b:Show()
	end
	for i = #items + 1, #menu.items do menu.items[i]:Hide() end
	menu:SetSize(212, (#items + 1) * 20 + 12)
	menu.owner, menu.away = anchor, 0
	menu:ClearAllPoints()
	menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, -2)
	menu:Show()
end

-- How to bring NeverQuestAlone back once everything is hidden, a click first: the
-- minimap's addon menu, where the game has one (nil without it: the command).
-- note: the Hide Bar tooltip's words, else the line its click prints.
function U.WayBack(note)
	if not (ns.Settings and ns.Settings.compartment) then return nil end
	return string.format(note and "Click %s in the minimap's addon menu, or type /nqa, to bring it back."
		or "NeverQuestAlone is hidden. Click %s in the minimap's addon menu, or type /nqa, to bring it back.", ns.Settings.compartmentName)
end

-- The window's portrait menu, as the HUD's portrait has one: the ways in that
-- the window has no button for.
function U.WindowMenu(anchor)
	U.PopupMenu(anchor, ns.Chats.AgentName(), {
		{ "Open Settings", function() if ns.Settings then ns.Settings.Open() end end },
		{ "Bind Keys", function() if ns.Settings then ns.Settings.OpenKeybindings() end end },
	})
end

---------------------------------------------------------------------------
-- The copy box: FontStrings can't be selected, so a click on a bubble opens
-- its text here, selected, for Ctrl+C. It shows what the agent wrote (colour
-- codes gone, || back to | wherever that can't start an escape; ns.CopyText)
-- and puts it back if you type into it.
---------------------------------------------------------------------------

function U.ShowCopy(text)
	if not ui.copy then
		local cf, tpl = Create("Frame", "NQACopy", UIParent, { "BasicFrameTemplateWithInset", "BackdropTemplate" })
		if tpl ~= "BasicFrameTemplateWithInset" then Backdrop(cf, "dialog") end
		cf:SetSize(580, 340)
		cf:SetPoint("CENTER")
		cf:SetFrameStrata("FULLSCREEN_DIALOG")
		cf:SetMovable(true)
		cf:SetClampedToScreen(true)
		cf:EnableMouse(true)
		cf:RegisterForDrag("LeftButton")
		cf:SetScript("OnDragStart", cf.StartMoving)
		cf:SetScript("OnDragStop", cf.StopMovingOrSizing)
		tinsert(UISpecialFrames, "NQACopy")
		local title = Child(cf, "TitleText") or cf:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		if not Child(cf, "TitleText") then title:SetPoint("TOP", cf, "TOP", 0, -14) end
		title:SetText(ns.Fill("Press {key} to Copy", { key = CopyKey() }))
		if not Child(cf, "CloseButton") then
			local x = Create("Button", nil, cf, { "UIPanelCloseButton" })
			x:SetPoint("TOPRIGHT", cf, "TOPRIGHT", -4, -4)
			x:SetScript("OnClick", function() cf:Hide() end)
		end
		local sc = Create("ScrollFrame", "NQACopyScroll", cf, { "UIPanelScrollFrameTemplate" })
		sc:SetPoint("TOPLEFT", cf, "TOPLEFT", 16, -36)
		sc:SetPoint("BOTTOMRIGHT", cf, "BOTTOMRIGHT", -34, 16)
		local eb = CreateFrame("EditBox", "NQACopyBox", sc)
		eb:SetMultiLine(true)
		eb:SetAutoFocus(false)
		eb:SetFontObject(ChatFontNormal)
		eb:SetMaxLetters(0)
		eb:SetSize(520, 280)
		eb:SetScript("OnEscapePressed", function() cf:Hide() end)
		eb:SetScript("OnTextChanged", function(self, userInput)
			if userInput and ui.copyText and self:GetText() ~= ui.copyText then
				self:SetText(ui.copyText)
				self:HighlightText()
			end
		end)
		sc:SetScrollChild(eb)
		sc:HookScript("OnSizeChanged", function(_, w) eb:SetWidth(w) end)
		ui.copy, ui.copyBox = cf, eb
	end
	ui.copyText = text
	ui.copyBox:SetText(text)
	ui.copy:Show()
	ui.copyBox:SetFocus()
	ui.copyBox:HighlightText()
end

-- The words a bubble shows, as they were written. What you typed goes in
-- escaped too, so it reads back literally.
function U.CopyTextOf(entry)
	if entry.role == "user" then return ns.CopyText(ns.Escape(entry.text)) end
	return ns.CopyText(entry.text)
end

---------------------------------------------------------------------------
-- Toasts (PRD §8.2), only while the HUD doesn't show news (closed, off, the
-- compass): one banner at the top middle until Okay or Open. Clicks go through
-- it to the world, except on its buttons.
---------------------------------------------------------------------------

local function LayoutToasts()
	local widgets = type(UIWidgetTopCenterContainerFrame) == "table" and UIWidgetTopCenterContainerFrame or nil
	for _, t in ipairs(ui.toastOrder) do
		t:ClearAllPoints()
		if widgets then
			t:SetPoint("TOP", widgets, "BOTTOM", 0, -4)
		else
			t:SetPoint("TOP", UIParent, "TOP", 0, -30)
		end
	end
end

local TOAST_ICON = {
	reply = TOAST_FACE,
	error = "Interface\\DialogFrame\\UI-Dialog-Icon-AlertNew",
	aborted = "Interface\\DialogFrame\\UI-Dialog-Icon-AlertNew",
}

-- A banner's reply read and put away (its chat's unread count goes too);
-- follow: its Okay button follows what the reply drew, the Okay key doesn't.
local function PutAwayToast(t, follow)
	t:Hide()
	U.DropToast(t)
	local c = t.chatId and ns.Chats.Find(t.chatId)
	if c then c.unread = 0 end
	local drew = t.drew
	t.drew = nil
	if follow and drew and type(NQAMap) == "table" and NQAMap.FollowDrawn then ns.Try(NQAMap.FollowDrawn, drew) end
	ns.Refresh("status")
end

-- The Okay key with no news in the HUD (closed, off, the compass: replies are
-- this banner then): its reply read and put away, following nothing (C-103).
function U.OkayToast()
	local t = ui.toastOrder and ui.toastOrder[1]
	if not t or not t:IsShown() then return false end
	PutAwayToast(t, false)
	return true
end

local function NewToast(i)
	local t, tpl = Create("Frame", "NQAToast" .. i, UIParent, { "TooltipBackdropTemplate", "BackdropTemplate" })
	if tpl ~= "TooltipBackdropTemplate" then Backdrop(t, "tooltip", 0.05, 0.05, 0.05, 0.92) end
	t:SetSize(TOAST_W, 46)
	t:SetFrameStrata("MEDIUM")
	t:EnableMouse(false)
	t.icon = t:CreateTexture(nil, "ARTWORK")
	t.icon:SetSize(30, 30)
	t.icon:SetPoint("LEFT", t, "LEFT", 9, 0)
	t.icon:SetTexture(TOAST_FACE)
	-- Bones's tile full-bleed (its rounded rim cropped) in a thin dark frame,
	-- as alert toasts frame their icons (C-151); the alert icons drawn whole.
	t.iconRim = t:CreateTexture(nil, "BORDER")
	t.iconRim:SetPoint("TOPLEFT", t.icon, "TOPLEFT", -1, 1)
	t.iconRim:SetPoint("BOTTOMRIGHT", t.icon, "BOTTOMRIGHT", 1, -1)
	Call(t.iconRim, "SetColorTexture", 0, 0, 0, 0.9)
	-- The HUD's type (C-95): the name a label (12, gold), his words primary
	-- (13, white) on up to two lines; nothing under 11.
	-- Their width set outright (46 in, 168 clear of the buttons: Open Chat's 84,
	-- the first button's up to 60 for "Follow", 8 around each), as the HUD's
	-- wrapped texts are, so the banner measures two lines before it's ever
	-- been placed (C-97).
	local hudFont = ns.HUD and ns.HUD.Font
	local textW = TOAST_W - 46 - 168
	t.title = t:CreateFontString(nil, "OVERLAY", hudFont and hudFont("L") or "GameFontNormal")
	t.title:SetPoint("TOPLEFT", t, "TOPLEFT", 46, -8)
	t.title:SetWidth(textW)
	t.title:SetJustifyH("LEFT")
	t.title:SetWordWrap(false)
	t.line = t:CreateFontString(nil, "OVERLAY", hudFont and hudFont("P") or "GameFontHighlight")
	t.line:SetPoint("TOPLEFT", t.title, "BOTTOMLEFT", 0, -4)
	t.line:SetWidth(textW)
	t.line:SetJustifyH("LEFT")
	t.line:SetJustifyV("TOP")
	t.line:SetWordWrap(true)
	if t.line.SetMaxLines then t.line:SetMaxLines(2) end
	t.open = Button(t, "Open Chat", 84, function() -- as the HUD's news says it
		t:Hide()
		U.DropToast(t)
		t.drew = nil
		if t.chatId and ns.Chats.Find(t.chatId) then ns.Chats.Switch(t.chatId) end
		U.Toggle(true)
	end)
	t.open:SetPoint("RIGHT", t, "RIGHT", -8, 0)
	t.open:SetScript("OnEnter", function(self) ShowTip(self, { title = "Open Chat", text = "Opens the reply's chat in the window, where you can answer." }) end)
	t.open:SetScript("OnLeave", HideTip)
	-- Okay: read and put away (its chat's unread count goes too); nothing is
	-- sent. A route the reply drew, or a pin it put, is followed, as the HUD's
	-- Okay does (HUD.OkayTip).
	t.okay = Button(t, "Okay", 52, function() PutAwayToast(t, true) end)
	t.okay:SetPoint("RIGHT", t.open, "LEFT", -8, 0)
	t.okay:SetScript("OnEnter", function(self)
		ShowTip(self, ns.HUD and ns.HUD.OkayTip and ns.HUD.OkayTip(t.drew, true) or { title = "Okay", text = "Marks the reply read and puts it away; nothing is sent." })
	end)
	t.okay:SetScript("OnLeave", HideTip)
	t:Hide()
	return t
end

function U.DropToast(t)
	for i, x in ipairs(ui.toastOrder) do
		if x == t then
			table.remove(ui.toastOrder, i)
			break
		end
	end
	LayoutToasts()
end

function U.Toast(title, line, chatId, kind, drew)
	ui.toasts = ui.toasts or {}
	ui.toastOrder = ui.toastOrder or {}
	local t, covered
	if #ui.toastOrder >= TOAST_MAX then
		t = table.remove(ui.toastOrder) -- the oldest makes room
		covered = t.drew -- what it drew waits for the next banner's Okay
	else
		for i = 1, TOAST_MAX do
			ui.toasts[i] = ui.toasts[i] or NewToast(i)
			if not ui.toasts[i]:IsShown() then
				t = ui.toasts[i]
				break
			end
		end
		t = t or table.remove(ui.toastOrder)
	end
	t.title:SetText(title)
	t.line:SetText(line or "")
	-- As tall as its words: 8, the name, 4, one or two lines, 8.
	local th, lh = t.title:GetStringHeight() or 14, t.line:GetStringHeight() or 16
	t:SetHeight(math.max(46, math.ceil(8 + th + 4 + lh + 8)))
	t.chatId = chatId
	t.drew = drew or covered
	-- Its first button says when it follows what the reply drew (C-100).
	local label = ns.HUD and ns.HUD.OkayLabel and ns.HUD.OkayLabel(t.drew, true) or "Okay"
	t.okay:SetText(label)
	t.okay:SetWidth(label == "Okay" and 52 or 60)
	if t.icon then
		local icon = TOAST_ICON[kind or "reply"] or TOAST_FACE
		local c = icon == TOAST_FACE and 0.08 or 0
		t.icon:SetTexture(icon)
		Call(t.icon, "SetTexCoord", c, 1 - c, c, 1 - c)
		if t.iconRim then t.iconRim:SetShown(c > 0) end
	end
	if t.title.SetTextColor then
		if kind == "error" then t.title:SetTextColor(1, 0.44, 0.44) else t.title:SetTextColor(1, 0.82, 0) end
	end
	table.insert(ui.toastOrder, 1, t)
	LayoutToasts()
	t:Show()
end

-- A banner whose chat you've opened is read: it goes.
local function DropShownToasts()
	for i = #(ui.toastOrder or {}), 1, -1 do
		local t = ui.toastOrder[i]
		if t.chatId and U.IsShowing(t.chatId) then
			t:Hide()
			table.remove(ui.toastOrder, i)
		end
	end
end

---------------------------------------------------------------------------
-- Building the window
---------------------------------------------------------------------------

-- A row's lines, centred together (maintainer: "left middle vertically aligned"):
-- the name, then the newest line and its age; a chat with nothing yet, its
-- name alone in the middle. Every name starts ROW_IN in; a pin sits at the
-- right of the name's line, before "2 new" or "working", where the delete
-- button shows under the mouse.
local function PlaceRow(row, pinned)
	local nh = row.label:GetStringHeight() or 0
	if nh < 1 then nh = 14 end
	local two = (row.preview:GetText() or "") ~= "" or (row.age:GetText() or "") ~= ""
	local ph = two and (row.preview:GetStringHeight() or 0) or 0
	if two and ph < 1 then ph = 12 end
	local top = math.floor((ROW_H - nh - (two and (ROW_GAP + ph) or 0)) / 2 + 0.5)
	local mid, mid2 = top + nh / 2, top + nh + ROW_GAP + ph / 2 -- the two lines' middles
	row.badge:ClearAllPoints()
	row.badge:SetPoint("RIGHT", row, "TOPRIGHT", -ROW_IN, -mid)
	local stop = row.badge -- what the name stops short of
	row.pin:ClearAllPoints()
	if pinned then
		if (row.badge:GetText() or "") ~= "" then
			row.pin:SetPoint("RIGHT", row.badge, "LEFT", -4, 0)
		else
			row.pin:SetPoint("RIGHT", row, "TOPRIGHT", -ROW_IN, -mid)
		end
		stop = row.pin
	end
	row.label:ClearAllPoints()
	row.label:SetPoint("LEFT", row, "TOPLEFT", ROW_IN, -mid)
	row.label:SetPoint("RIGHT", stop, "LEFT", -4, 0)
	row.age:ClearAllPoints()
	row.age:SetPoint("RIGHT", row, "TOPRIGHT", -ROW_IN, -mid2)
	row.preview:ClearAllPoints()
	row.preview:SetPoint("LEFT", row, "TOPLEFT", ROW_IN, -mid2)
	row.preview:SetPoint("RIGHT", row.age, "LEFT", -6, 0)
	row.del:ClearAllPoints()
	row.del:SetPoint("RIGHT", row, "TOPRIGHT", -(ROW_IN - 2), -mid)
end

local function MakeRow(i)
	local b = CreateFrame("Button", nil, ui.listContent)
	b:SetSize(ui.listW or (PANEL_W - 2 * (LIST_IN - ROW_IN)), ROW_H)
	b:SetPoint("TOPLEFT", ui.listContent, "TOPLEFT", 0, -(i - 1) * ROW_H)
	b.selected = b:CreateTexture(nil, "BACKGROUND")
	b.selected:SetAllPoints()
	b.selected:SetTexture("Interface\\QuestFrame\\UI-QuestLogTitleHighlight")
	b.selected:SetVertexColor(1, 0.82, 0, 0.35)
	b.selected:Hide()
	local hl = b:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	hl:SetTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight")
	hl:SetBlendMode("ADD")
	b.del = CreateFrame("Button", nil, b)
	b.del:SetSize(16, 16) -- on the name's line, at its right (PlaceRow)
	if type(C_Texture) == "table" and type(C_Texture.GetAtlasExists) == "function" and C_Texture.GetAtlasExists("128-RedButton-Delete") then
		b.del:SetNormalAtlas("128-RedButton-Delete")
		b.del:SetPushedAtlas("128-RedButton-Delete-Pressed")
		b.del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
	else
		b.del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
		b.del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
	end
	-- Delete shows only under the mouse (it's in the right-click menu too), so
	-- 40 red buttons don't sit beside the rows you click to switch.
	b.del:SetAlpha(0.8)
	b.del:Hide()
	b.del:SetScript("OnClick", function() U.ConfirmDelete(b.chatId) end)
	b.del:SetScript("OnEnter", function(self)
		self:SetAlpha(1)
		ShowTip(self, { title = "Delete Chat", text = "Deletes this chat and its history, here and in the NeverQuestAlone app.", note = "It asks first." }) -- [G-2, UX-W08]
	end)
	b.del:SetScript("OnLeave", function(self)
		self:SetAlpha(0.8)
		HideTip()
		if not b:IsMouseOver() then
			self:Hide()
			b.badge:SetAlpha(1)
			b.pin:SetAlpha(1)
		end
	end)
	b:SetScript("OnEnter", function()
		b.del:Show()
		b.badge:SetAlpha(0)
		b.pin:SetAlpha(0)
	end)
	b:SetScript("OnLeave", function()
		if not b.del:IsMouseOver() then
			b.del:Hide()
			b.badge:SetAlpha(1)
			b.pin:SetAlpha(1)
		end
	end)
	-- Pinned: Blizzard's gold map pin (a raid-marker star where that atlas is
	-- missing), at the right of the name's line, so every name starts at the
	-- same place (maintainer: "left ... aligned"; PlaceRow).
	b.pin = b:CreateTexture(nil, "OVERLAY")
	local info = type(C_Texture) == "table" and type(C_Texture.GetAtlasExists) == "function" and C_Texture.GetAtlasExists(PIN_ATLAS)
		and type(C_Texture.GetAtlasInfo) == "function" and C_Texture.GetAtlasInfo(PIN_ATLAS)
	if info then
		b.pin:SetAtlas(PIN_ATLAS)
		b.pin:SetSize(14 * (info.width or 1) / math.max(1, info.height or 1), 14)
	else
		b.pin:SetTexture(PIN_FALLBACK)
		b.pin:SetSize(12, 12)
	end
	b.pin:Hide()
	-- A thin gold line under the last pinned chat.
	b.sep = b:CreateTexture(nil, "ARTWORK")
	b.sep:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", ROW_IN, 0)
	b.sep:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -ROW_IN, 0)
	b.sep:SetHeight(1)
	b.sep:SetColorTexture(1, 0.82, 0, 0.35)
	b.sep:Hide()
	-- "2 new" or "working", right-aligned on the name's line (the delete
	-- button takes its place under the mouse). Placed by PlaceRow.
	b.badge = b:CreateFontString(nil, "OVERLAY", "GameFontNormal") -- the name's size, on its line
	b.badge:SetJustifyH("RIGHT")
	b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	b.label:SetJustifyH("LEFT")
	b.label:SetWordWrap(false)
	-- The second line: the chat's newest line, and how long ago.
	b.age = b:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	b.age:SetJustifyH("RIGHT")
	b.preview = b:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	b.preview:SetJustifyH("LEFT")
	b.preview:SetWordWrap(false)
	b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	b:SetScript("OnClick", function(self, button)
		if button == "RightButton" then
			U.ChatMenu(self.chatId, self)
		else
			ns.Chats.Switch(self.chatId)
		end
	end)
	ui.rows[i] = b
	return b
end

local function MakeBubble(i)
	local b = CreateFrame("Frame", nil, ui.content)
	b.bg = b:CreateTexture(nil, "BACKGROUND")
	b.bg:SetAllPoints()
	-- A faint lift under the mouse: a click copies the bubble (it says so).
	b.hover = b:CreateTexture(nil, "BORDER")
	b.hover:SetAllPoints()
	b.hover:SetColorTexture(1, 1, 1, 0.04)
	b.hover:Hide()
	b.accent = b:CreateTexture(nil, "ARTWORK")
	b.accent:SetPoint("TOPLEFT", b, "TOPLEFT", 0, 0)
	b.accent:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 0, 0)
	b.accent:SetWidth(2)
	-- Game events carry an icon of their kind (EVENT_ICON).
	b.icon = b:CreateTexture(nil, "ARTWORK")
	b.icon:SetSize(18, 18)
	b.icon:SetPoint("TOPLEFT", b, "TOPLEFT", 10, -5)
	b.icon:Hide()
	b.who = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", BUBBLE_X, -BUBBLE_Y)
	b.who:SetJustifyH("LEFT")
	b.when = b:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	b.when:SetPoint("TOPRIGHT", b, "TOPRIGHT", -BUBBLE_X, -BUBBLE_Y)
	-- Bones's TL;DR, first: what the reply comes to, before the whole of it.
	b.tldr = b:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	b.tldr:SetJustifyH("LEFT")
	b.tldr:SetJustifyV("TOP")
	b.tldr:SetWordWrap(true)
	b.tldr:Hide()
	b.body = b:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
	b.body:SetPoint("TOPLEFT", b, "TOPLEFT", BUBBLE_X, -BODY_TOP)
	b.body:SetJustifyH("LEFT")
	b.body:SetJustifyV("TOP")
	b.body:SetWordWrap(true)
	b.body:SetNonSpaceWrap(true)
	b.pills, b.chips = {}, {}
	-- [UX-2, UX-3] An error's parts: its details, a click away; where the fix
	-- is on the desktop, a line that says so; its Okay, Retry and Details chips
	-- (b.acts). A reply's cost, when you asked for it. Hidden until used.
	b.acts = {}
	b.details = b:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	b.details:SetJustifyH("LEFT")
	b.details:SetJustifyV("TOP")
	b.details:SetWordWrap(true)
	b.details:Hide()
	b.hint = b:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	b.hint:SetJustifyH("LEFT")
	b.hint:SetWordWrap(true)
	b.hint:Hide()
	b.cost = b:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	b.cost:SetJustifyH("LEFT")
	b.cost:Hide()
	-- Copy: a button under the mouse, or a right-click. A plain click does
	-- nothing, so clicking to bring the window forward never opens a box.
	b.copy = CreateFrame("Button", nil, b)
	b.copy:SetSize(40, 16)
	b.copy:SetPoint("RIGHT", b.when, "LEFT", -8, 0)
	b.copy.label = b.copy:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.copy.label:SetPoint("RIGHT", b.copy, "RIGHT", 0, 0)
	b.copy.label:SetText("Copy")
	b.copy:SetScript("OnClick", function() if b.entry then U.ShowCopy(U.CopyTextOf(b.entry)) end end)
	b.copy:SetScript("OnEnter", function(self) ShowTip(self, { title = "Copy", text = "Opens this message in a box you can copy from.", note = "Right-clicking the message does the same." }) end)
	b.copy:SetScript("OnLeave", function(self)
		HideTip()
		if not b:IsMouseOver() then
			self:Hide()
			b.hover:Hide()
		end
	end)
	b.copy:Hide()
	b:EnableMouse(true)
	b:SetScript("OnMouseUp", function(self, button)
		if button == "RightButton" and self.entry then U.ShowCopy(U.CopyTextOf(self.entry)) end
	end)
	b:SetScript("OnEnter", function(self)
		if not self.entry then return end
		self.hover:Show()
		self.copy:Show()
	end)
	b:SetScript("OnLeave", function(self)
		if self.copy:IsMouseOver() then return end
		self.hover:Hide()
		self.copy:Hide()
	end)
	ui.bubbles[i] = b
	return b
end

---------------------------------------------------------------------------
-- References (PROTOCOL §4.1 `refs`): quest, item and spell ids Bones named,
-- shown as real game links. Only the ids come from the bridge; the names come
-- from the client, so nothing Bones wrote becomes a live link (TB3).
---------------------------------------------------------------------------

local function Pipeless(s) return (tostring(s or ""):gsub("|", "")) end

-- Items the client hadn't loaded when their pill was drawn: the redraw comes
-- when the game says it has them (one per burst, and the reading place kept).
local waitingItems, itemRedraw = {}, false

-- { label, r, g, b, hyperlink (for tooltips), link (for shift-click), questID }
function U.RefInfo(kind, id)
	id = tonumber(id)
	if not id then return nil end
	if kind == "q" then
		local title = ns.Try(C_QuestLog and C_QuestLog.GetTitleForQuestID, id)
		title = (type(title) == "string" and title ~= "") and Pipeless(title) or ns.Fill("Quest {id}", { id = ns.Int(id) })
		return { label = "[" .. title .. "]", r = 1, g = 1, b = 0, hyperlink = "quest:" .. ns.Int(id),
			link = "|cffffff00|Hquest:" .. ns.Int(id) .. ":-1|h[" .. title .. "]|h|r", questID = id }
	elseif kind == "i" then
		local name, link, quality = ns.Try(C_Item and C_Item.GetItemInfo, id)
		if type(name) ~= "string" then
			if not waitingItems[id] then
				waitingItems[id] = true
				ns.Try(C_Item and C_Item.RequestLoadItemDataByID, id) -- GET_ITEM_INFO_RECEIVED redraws
			end
			return { label = ns.Fill("[Item {id}]", { id = ns.Int(id) }), r = 1, g = 1, b = 1, hyperlink = "item:" .. ns.Int(id) }
		end
		local r, g, bl = 1, 1, 1
		local color = type(ITEM_QUALITY_COLORS) == "table" and type(quality) == "number" and ITEM_QUALITY_COLORS[quality]
		if type(color) == "table" and tonumber(color.r) then r, g, bl = color.r, color.g, color.b end
		return { label = "[" .. Pipeless(name) .. "]", r = r, g = g, b = bl, hyperlink = "item:" .. ns.Int(id), link = type(link) == "string" and link or nil }
	elseif kind == "s" then
		local name = ns.Try(C_Spell and C_Spell.GetSpellName, id)
		if type(name) ~= "string" then
			local info = ns.Try(C_Spell and C_Spell.GetSpellInfo, id)
			name = type(info) == "table" and info.name or nil
		end
		name = type(name) == "string" and Pipeless(name) or ns.Fill("Spell {id}", { id = ns.Int(id) })
		local link = ns.Try(C_Spell and C_Spell.GetSpellLink, id)
		return { label = "[" .. name .. "]", r = 0.44, g = 0.84, b = 1, hyperlink = "spell:" .. ns.Int(id), link = type(link) == "string" and link or nil }
	end
end

ns.On("GET_ITEM_INFO_RECEIVED", function(_, itemID)
	itemID = tonumber(itemID)
	if not itemID or not waitingItems[itemID] then return end
	waitingItems[itemID] = nil
	if itemRedraw then return end
	itemRedraw = true
	local function Redraw()
		itemRedraw = false
		if ui.frame and ui.frame:IsShown() then U.RenderTranscript("items") end
	end
	if C_Timer and C_Timer.After then C_Timer.After(0.2, Redraw) else Redraw() end
end)

-- Shift-click puts the link in the box, as shift-clicking in the game does.
function U.InsertLink(link)
	if not ui.input or type(link) ~= "string" then return end
	U.Toggle(true)
	ui.input:SetFocus()
	ui.input:Insert(link)
end

-- A click does what clicking the same link in chat does (SetItemRef: the
-- item's or spell's tooltip); a quest you're on opens in the quest log. Both
-- go through ShowUIPanel, so in a fight they open once it ends
-- (ns.AfterCombat). A shift-click only fills the box, so it works in one.
local function InLog(ref)
	return ref.questID and ns.Try(C_QuestLog and C_QuestLog.IsOnQuest, ref.questID) and type(QuestMapFrame_OpenToQuestDetails) == "function"
end

-- queued: from ns.AfterCombat, as the fight ends. A link then opens as a plain
-- click does (SetItemRef's own branch, ItemRef.lua:21-25 at 70009): SetItemRef
-- reads the modifier keys when it runs, and one held as the fight ends would
-- put the link in chat or open the Dressing Room instead.
local function OpenRef(ref, queued)
	if InLog(ref) then
		pcall(QuestMapFrame_OpenToQuestDetails, ref.questID)
	elseif queued and type(ItemRefTooltip) == "table" and type(ShowUIPanel) == "function" then
		local tip = ItemRefTooltip
		pcall(ShowUIPanel, tip)
		if not tip:IsShown() then pcall(tip.SetOwner, tip, UIParent, "ANCHOR_PRESERVE") end
		pcall(tip.ItemRefSetHyperlink or tip.SetHyperlink, tip, ref.hyperlink)
	elseif type(SetItemRef) == "function" then
		pcall(SetItemRef, ref.hyperlink, ref.link or ref.label, "LeftButton")
	end
end

local function PillClick(self)
	local ref = self.ref
	if not ref then return end
	if type(IsShiftKeyDown) == "function" and IsShiftKeyDown() then
		U.InsertLink(ref.link)
		return
	end
	-- {quest}, {link}: the name the pill shows ("[Swoop Hunting]"); never the subject, since
	-- "[Leather Gloves] opens" and "[Battered Junkbox] opens" read wrong (bones-ux-writer SCW-07).
	local line = ns.Fill(InLog(ref) and "Your quest log opens to {quest} after the fight." or "The {link} link opens after the fight.", { quest = ref.label, link = ref.label })
	if not ns.AfterCombat(function() OpenRef(ref, true) end, line) then OpenRef(ref) end
end

local function PillEnter(self)
	if not self.ref or not GameTooltip then return end
	GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
	if not pcall(GameTooltip.SetHyperlink, GameTooltip, self.ref.hyperlink) then GameTooltip:SetText(self.ref.label, 1, 1, 1) end
	-- In a fight a click opens it as the fight ends (PillClick).
	local fight = type(InCombatLockdown) == "function" and InCombatLockdown()
	GameTooltip:AddLine(fight and "<Click to open it after the fight>" or "<Click to open it>", TIP_GREEN[1], TIP_GREEN[2], TIP_GREEN[3])
	GameTooltip:AddLine("<Shift-click to link it in your message>", TIP_GREEN[1], TIP_GREEN[2], TIP_GREEN[3])
	GameTooltip:Show()
end

-- Pills for an entry's refs, laid out under its text; returns the height used.
local function LayoutPills(b, entry, y, width)
	local n = 0
	for _, kind in ipairs({ "q", "i", "s" }) do
		for _, id in ipairs(entry.refs and entry.refs[kind] or {}) do
			local ref = U.RefInfo(kind, id)
			if ref then
				n = n + 1
				local p = b.pills[n]
				if not p then
					p = MakeChip(b, PILL_H)
					p:SetScript("OnClick", PillClick)
					p:SetScript("OnEnter", PillEnter)
					p:SetScript("OnLeave", HideTip)
					b.pills[n] = p
				end
				p.ref = ref
				p.label:SetText(ref.label)
				p.label:SetTextColor(ref.r, ref.g, ref.b)
				p:Show()
			end
		end
	end
	for i = n + 1, #b.pills do b.pills[i]:Hide() end
	if n == 0 then return 0 end
	return FlowChips(b.pills, b, BUBBLE_X, y, width - 2 * BUBBLE_X, PILL_H, 6)
end

-- Suggested replies under Bones's latest reply (PROTOCOL §4.1 `chips`): a click
-- sends the words.
local function ChipClick(self)
	if self.send then
		local chat = ns.Chats.Find(self.chatId) or ns.Chats.Active()
		if chat then ns.Chats.Send(self.send, chat.id, self.intro and { intro = true } or nil) end -- [G2] Say hi's
	end
end

-- [UX-8] A chip given as { label, send } sends those words under its
-- own label (the setup checklist's Say hi).
local function LayoutChips(b, list, chatId, y, width)
	local n = 0
	for _, text in ipairs(list or {}) do
		local label, intro = text, nil
		if type(text) == "table" then label, text, intro = text.label or text.send, text.send, text.intro end
		n = n + 1
		local c = b.chips[n]
		if not c then
			c = MakeChip(b, CHIP_H)
			c:SetScript("OnClick", ChipClick)
			c:SetScript("OnEnter", function(self) ShowTip(self, { title = ns.Fill("Send to {name}", { name = ns.Chats.AgentName() }), lines = { ns.Escape(self.send or "") } }) end)
			c:SetScript("OnLeave", HideTip)
			b.chips[n] = c
		end
		c.send, c.chatId, c.intro = text, chatId, intro
		c.label:SetText(ns.Escape(text))
		if label ~= text and U.Checklist() then c.label:SetText(ns.Escape(label)) end -- [UX-8] the setup checklist's chip: its own label
		c.label:SetTextColor(0.95, 0.9, 0.8)
		c:Show()
	end
	for i = n + 1, #b.chips do b.chips[i]:Hide() end
	if n == 0 then return 0 end
	return FlowChips(b.chips, b, BUBBLE_X, y, width - 2 * BUBBLE_X, CHIP_H, 6)
end

local function MakeWorkBubble()
	local w = CreateFrame("Frame", "NQAWorking", ui.content)
	w.bg = w:CreateTexture(nil, "BACKGROUND")
	w.bg:SetAllPoints()
	w.bg:SetColorTexture(1, 0.82, 0, 0.05)
	w.text = w:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	w.text:SetPoint("LEFT", w, "LEFT", BUBBLE_X, 0)
	w.text:SetPoint("RIGHT", w, "RIGHT", -(BUBBLE_X + 90 + 8), 0)
	w.text:SetJustifyH("LEFT")
	w.text:SetWordWrap(false)
	-- Stop; Paste Reply while the message waits for a pasted reply (Paste.lua); while the
	-- message is stuck, its one action ([DR-07] U.WorkButton). No global name: it sends.
	w.stop = Button(w, "Stop", 90, function()
		local chat = ns.Chats.Active()
		if w.stuck then U.StuckAct(w.stuck)
		elseif ns.Paste and chat and ns.Paste.Waiting(chat) then ns.Paste.Open(chat.id)
		else ns.Chats.Stop() end
	end)
	w.stop:SetPoint("RIGHT", w, "RIGHT", -BUBBLE_X, 0)
	w:SetHeight(WORK_H)
	w:Hide()
	ui.work = w
end

-- Where the window is, and how it moves. Home is top left, where the game's
-- own panels open (StepAside). Anywhere else it's one anchor, its top-left
-- corner against the screen's bottom-left in whole units, whatever point the
-- engine chose when a drag or a resize stopped: so a size change (the chat
-- list's - and +, the grip, the height trimmed to the screen) grows it from
-- that corner instead of around a centre or a far corner, and a /reload puts
-- it back exactly. The small bar and the HUD keep theirs the same way.
local function AtHome()
	local s = ns.db.settings
	return s.point == nil or (s.point == HOME_POINT and s.x == HOME_X and s.y == HOME_Y)
end
local function KeepPlace(f, s)
	local left, top = f:GetLeft(), f:GetTop()
	if type(left) ~= "number" or type(top) ~= "number" then
		local point, _, relPoint, x, y = f:GetPoint()
		s.point, s.relPoint, s.x, s.y = point, relPoint, x, y
		return
	end
	left, top = math.floor(left + 0.5), math.floor(top + 0.5)
	f:ClearAllPoints()
	f:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", left, top)
	s.point, s.relPoint, s.x, s.y = "TOPLEFT", "BOTTOMLEFT", left, top
end
function U.BeginMove(f)
	ui.moving = true
	f:StartMoving()
end
function U.EndMove(f, s)
	f:StopMovingOrSizing()
	ui.moving = nil
	Call(f, "SetUserPlaced", false)
	KeepPlace(f, s)
end

local function BuildMini()
	local s = ns.db.settings
	local m, tpl = Create("Frame", "NQAMini", UIParent, { "TooltipBackdropTemplate", "BackdropTemplate" })
	if tpl ~= "TooltipBackdropTemplate" then Backdrop(m, "tooltip", 0.05, 0.05, 0.05, 0.92) end
	ui.mini = m
	m:SetSize(272, 30) -- the HUD's bar's width, so a route's bar under it lines up (C-92)
	if s.miniPoint then
		m:SetPoint(s.miniPoint, UIParent, s.miniRelPoint or s.miniPoint, s.miniX or 0, s.miniY or 0)
	else
		U.Dock(m, 0)
	end
	m:SetFrameStrata("DIALOG")
	m:SetMovable(true)
	Call(m, "SetDontSavePosition", true)
	m:SetClampedToScreen(true)
	m:EnableMouse(true)
	m:RegisterForDrag("LeftButton")
	m:SetScript("OnDragStart", function(self)
		self.dragging = true
		self:StartMoving()
	end)
	m:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		Call(self, "SetUserPlaced", false)
		local place = {}
		KeepPlace(self, place)
		s.miniPoint, s.miniRelPoint, s.miniX, s.miniY = place.point, place.relPoint, place.x, place.y
		C_Timer.After(0, function() self.dragging = nil end)
	end)
	m:SetScript("OnMouseUp", function(self, button)
		if button == "LeftButton" and not self.dragging then U.Minimize(false) end
	end)
	m:Hide()
	ui.miniLight = MakeLight(m, "NQAMiniLight")
	ui.miniLight:SetPoint("LEFT", m, "LEFT", 9, 0)
	local label = m:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	label:SetPoint("LEFT", ui.miniLight, "RIGHT", 6, 0)
	ui.miniLabel = label
	local badge = m:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	badge:SetPoint("LEFT", label, "RIGHT", 8, 0)
	badge:SetPoint("RIGHT", m, "RIGHT", -28, 0)
	badge:SetJustifyH("LEFT")
	badge:SetWordWrap(false)
	ui.miniBadge = badge
	local close = Create("Button", nil, m, { "UIPanelCloseButton" })
	close:SetSize(24, 24)
	close:SetPoint("RIGHT", m, "RIGHT", -2, 0)
	-- Your choice to hide everything: it stays hidden until you open Bones again.
	close:SetScript("OnClick", function()
		ns.db.settings.miniHidden = true
		U.Toggle(false)
		ns.Notify.Local(ns.P(U.WayBack() or "NeverQuestAlone is hidden. Type /nqa to bring it back.")) -- [UX-5]
	end)
	close:SetScript("OnEnter", function(self) ShowTip(self, { title = "Hide Bar", text = "Hides this bar; replies still come in.", note = U.WayBack(true) or "Type /nqa to bring it back." }) end)
	close:SetScript("OnLeave", HideTip)
	ui.miniClose = close
end

-- RV-4 and the reload path: a banner with a Reload button (the click is the
-- hardware event), above the window or below the mini bar, hidden in combat.
local function BuildBanner()
	local b, tpl = Create("Frame", "NQABanner", UIParent, { "TooltipBackdropTemplate", "BackdropTemplate" })
	if tpl ~= "TooltipBackdropTemplate" then Backdrop(b, "tooltip", 0.2, 0.12, 0, 0.92) end
	b:SetSize(420, 34)
	b:SetFrameStrata("DIALOG")
	b:SetClampedToScreen(true) -- above a window at the top of the screen it overlaps instead
	b.text = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.text:SetPoint("LEFT", b, "LEFT", 12, 0)
	b.text:SetPoint("RIGHT", b, "RIGHT", -96, 0)
	b.text:SetJustifyH("LEFT")
	-- [DR-07] Its one button: Reload, or Discard after a Reload that didn't deliver.
	b.reload = Button(b, "Reload", 80, function() U.StuckAct(b.action) end)
	b.reload:SetPoint("RIGHT", b, "RIGHT", -8, 0)
	b:Hide()
	ui.banner = b
end

function U.Build()
	if ui.frame then return end
	local s = ns.db.settings
	local f, tpl = Create("Frame", "NQAFrame", UIParent,
		{ "PortraitFrameTemplate", "ButtonFrameTemplate", "BasicFrameTemplateWithInset", "BackdropTemplate" })
	ui.frame, ui.template = f, tpl
	local portrait = tpl == "PortraitFrameTemplate" or tpl == "ButtonFrameTemplate"
	-- Where the content starts under each template's title area.
	local L
	if portrait then
		-- The header row clear of the close button. The chat's name in the middle
		-- of the band between the title bar (24 down) and the panes (64): the
		-- 16-tall light at -36; with a status line under it (30 in all), -29.
		L = { top = -64, headerX = 64, headerY = -36, headerY2 = -29, statusLine = 12 }
	elseif tpl == "BasicFrameTemplateWithInset" then
		L = { top = -54, headerX = 12, headerY = -28 }
	else
		L = { top = -60, headerX = 18, headerY = -36 }
		Backdrop(f, "dialog")
	end
	f:SetSize(s.width, s.height)
	if s.point then
		f:SetPoint(s.point, UIParent, s.relPoint or s.point, s.x or 0, s.y or 0)
	else
		f:SetPoint(HOME_POINT, UIParent, HOME_POINT, HOME_X, HOME_Y)
	end
	-- The game's own panels' strata: whichever you clicked last is on top.
	f:SetFrameStrata("MEDIUM")
	f:SetToplevel(true)
	f:SetMovable(true)
	-- Our settings are where it is: not the game's layout cache too, which
	-- saves a named frame the player moved and puts it back at its own time
	-- (the HUD opted out the same way).
	Call(f, "SetDontSavePosition", true)
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	if type(f.SetResizeBounds) == "function" then
		f:SetResizeBounds(MIN_W, MIN_H) -- and a maximum: the screen (FitToScreen)
	elseif type(f.SetMinResize) == "function" then
		f:SetMinResize(MIN_W, MIN_H)
	end
	-- It takes the mouse, so a click on it never reaches the world, but moves
	-- only by its title bar and its portrait (C-98): a press on its bare frame
	-- (a gutter, a hair off the resize grip) moved it, a press a little further
	-- in didn't, and nothing said which was which.
	f:EnableMouse(true)
	f:SetScript("OnDragStop", function(self)
		U.EndMove(self, s)
		U.FitToScreen() -- away from home, the size you saved, at once
	end)
	f:Hide()
	tinsert(UISpecialFrames, "NQAFrame")

	-- Esc (UISpecialFrames) and the X only hide; treat that as minimize unless
	-- we hide on purpose, or the whole UI is going away.
	f:SetScript("OnShow", function()
		U.FitToScreen()
		U.StepAside()
	end)
	f:SetScript("OnHide", function()
		ui.moving = nil -- a drag the hide ended
		if ui.quitting then return end
		if not ns.db or not ns.db.settings.shown or (UIParent and not UIParent:IsShown()) then return end
		ns.db.settings.minimized = true
		if ui.mini and not U.HUDActive() then ui.mini:Show() end
		ns.Refresh("status")
	end)

	-- The portrait: set its texture directly (SetPortraitToTexture, which the
	-- mixin's SetPortraitToAsset calls, is missing on 70009), else hide it.
	if portrait then
		local tex = (Child(f, "PortraitContainer") and Child(f.PortraitContainer, "portrait")) or Child(f, "portrait")
		ui.portraitTex = tex
		local ok = U.SetRoundFace(f, tex, U.WindowFaceSize())
		if not ok and type(ButtonFrameTemplate_HidePortrait) == "function" then pcall(ButtonFrameTemplate_HidePortrait, f) end
		-- A click on it (either button) opens the window's menu, as the HUD's
		-- portrait does; a drag moves the window. Over the template's portrait,
		-- so at frame level 510 or more; the whole ring (5 out, 7 up) is this one
		-- control, the glow's size.
		local pb = CreateFrame("Button", nil, f)
		pb:SetSize(62, 62)
		pb:SetPoint("TOPLEFT", f, "TOPLEFT", -5, 7)
		pb:SetFrameLevel(math.max(510, (f:GetFrameLevel() or 1) + 10))
		pb:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		pb:RegisterForDrag("LeftButton")
		-- The round highlight a bag's portrait shows under the pointer, as the HUD's portrait has.
		local glow = pb:CreateTexture(nil, "HIGHLIGHT")
		glow:SetSize(62, 62)
		glow:SetPoint("CENTER", pb, "CENTER", 0, 0)
		if not (C_Texture and ns.Try(C_Texture.GetAtlasExists, "bags-roundhighlight") and pcall(glow.SetAtlas, glow, "bags-roundhighlight")) then
			glow:SetTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
		end
		Call(glow, "SetBlendMode", "ADD")
		pb.glow = glow
		pb:SetScript("OnDragStart", function()
			HideTip()
			U.BeginMove(f) -- ui.moving, so nothing re-anchors it mid-drag (R39, C-114)
		end)
		pb:SetScript("OnDragStop", function()
			pb.movedAt = GetTime()
			f:GetScript("OnDragStop")(f)
		end)
		pb:SetScript("OnClick", function(self)
			HideTip()
			if self.movedAt and GetTime() - self.movedAt < 0.3 then return end -- the click that ends a drag
			U.WindowMenu(self)
		end)
		pb:SetScript("OnEnter", function(self)
			ShowTip(self, { title = ns.Chats.AgentName(), actions = { "Click for Settings and key bindings", "Drag to move the window" } })
		end)
		pb:SetScript("OnLeave", HideTip)
		ui.portraitBtn = pb
	end
	-- ButtonFrameTemplate and BasicFrameTemplateWithInset bring one big inset;
	-- the window draws its own three, so it would only double the border.
	if Child(f, "Inset") then f.Inset:Hide() end
	local title = (Child(f, "TitleContainer") and Child(f.TitleContainer, "TitleText")) or Child(f, "TitleText")
	if not title then
		title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
		title:SetPoint("TOP", f, "TOP", 0, portrait and -6 or -16)
	end
	ui.title = title

	local close = Child(f, "CloseButton")
	if not close then
		close = Create("Button", nil, f, { "UIPanelCloseButton" })
		close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -6, -6)
	end
	close:SetSize(24, 24) -- the red set's size, as the - or + beside it
	close:SetScript("OnClick", function() U.Minimize(true) end)
	-- The corner, as the HUD's (maintainer: an icon to fold the chats away): the
	-- game's red set, - or + flush left of the X, in the minimizable border's
	-- double corner (as CommunitiesFrame folds its list away): - folds the chat
	-- list away, + opens it.
	if portrait then Call(f, "SetBorder", "PortraitFrameTemplateMinimizable") end
	U.KitArt(close, "exit")
	ui.closeBtn = close
	ui.listBtn = U.KitButton(f, ns.db.settings.listShown and "minus" or "plus", function() U.SetListShown(not ns.db.settings.listShown) end)
	ui.listBtn:SetPoint("RIGHT", close, "LEFT", 0, 0)
	ui.listBtn:SetFrameLevel(math.max(510, close:GetFrameLevel() or 0))
	ui.listBtn:SetScript("OnEnter", function(self)
		if ns.db.settings.listShown then
			ShowTip(self, { title = "Hide Chats", text = "Folds your list of chats away; the chat keeps its width." })
		else
			ShowTip(self, { title = "Show Chats", text = "Opens your list of chats beside this chat.", note = "/nqa chat lists them too." })
		end
	end)
	ui.listBtn:SetScript("OnLeave", HideTip)

	-- The title bar drags the window, whatever the template puts there (its
	-- title container can take the mouse); the close button stays clickable.
	local drag = CreateFrame("Frame", nil, f)
	drag:SetPoint("TOPLEFT", f, "TOPLEFT", portrait and 60 or 8, 0)
	drag:SetPoint("TOPRIGHT", f, "TOPRIGHT", -56, 0) -- clear of the corner's two buttons
	drag:SetHeight(24)
	drag:SetFrameLevel(f:GetFrameLevel() + 20)
	drag:EnableMouse(true)
	drag:RegisterForDrag("LeftButton")
	drag:SetScript("OnDragStart", function() U.BeginMove(f) end)
	drag:SetScript("OnDragStop", function() f:GetScript("OnDragStop")(f) end)
	ui.drag = drag
	close:SetScript("OnEnter", function(self)
		-- Where the reply shows: the HUD while it shows news; else (its compass
		-- form, closed or off) the banner at the top of the screen (E-2).
		local hud = ns.HUD and ns.HUD.ShowsNews and ns.HUD.ShowsNews()
		ShowTip(self, { title = "Close", key = "Esc", text = hud and "Closes the window. NeverQuestAlone keeps working, and the HUD shows the reply when it lands."
			or "Closes the window. NeverQuestAlone keeps working, and the reply shows at the top of the screen when it lands." })
	end)
	close:SetScript("OnLeave", HideTip)

	-- Header: the light and the chat you're in, and a status line that only
	-- speaks when something needs you.
	ui.light = MakeLight(f, "NQALight")
	ui.light:SetPoint("TOPLEFT", f, "TOPLEFT", L.headerX, L.headerY)
	ui.chatName = f:CreateFontString(nil, "OVERLAY", "GameFontNormalMed2")
	ui.chatName:SetPoint("LEFT", ui.light, "RIGHT", 6, 0)
	ui.chatName:SetJustifyH("LEFT")
	ui.chatName:SetWordWrap(false)
	-- The header's right edge (the chat list's - and + are in the corner now).
	local hr = CreateFrame("Frame", nil, f)
	hr:SetSize(1, 16)
	hr:SetPoint("TOPRIGHT", f, "TOPRIGHT", -EDGE, L.headerY)
	ui.headerRight = hr
	ui.status = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	ui.status:SetPoint("TOPLEFT", ui.light, "BOTTOMLEFT", 0, -3)
	ui.status:SetJustifyH("LEFT")
	ui.status:SetJustifyV("TOP")
	-- [ingame-clarity] Two lines when the window is too narrow for one (it opens narrower now): its
	-- width set outright, so it measures its lines before it's drawn, and the panes a line lower while
	-- it takes two (U.PlaceHeader).
	ui.status:SetWordWrap(true)
	if ui.status.SetMaxLines then ui.status:SetMaxLines(2) end
	-- The line's words a click away while it has more to say, as the HUD's
	-- status lines are (0.4.9): a button that lights under the pointer, never
	-- a hover the line doesn't mention (C-115). Under the title strip, so no drag.
	ui.statusHit = CreateFrame("Button", nil, f)
	ui.statusHit:SetAllPoints(ui.status)
	local shl = ui.statusHit:CreateTexture(nil, "HIGHLIGHT")
	shl:SetPoint("TOPLEFT", ui.statusHit, "TOPLEFT", -4, 3)
	shl:SetPoint("BOTTOMRIGHT", ui.statusHit, "BOTTOMRIGHT", 4, -3)
	shl:SetTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight")
	Call(shl, "SetBlendMode", "ADD")
	ui.statusHit:SetScript("OnClick", function(self)
		local tip = self.tip
		if tip then U.ShowDetails(tip.text .. (tip.note and ("\n\n" .. tip.note) or "")) end
	end)
	ui.statusHit:SetScript("OnEnter", function(self)
		if self.tip then ShowTip(self, { title = "Details", actions = { "Click to see all of it" } }) end
	end)
	ui.statusHit:SetScript("OnLeave", HideTip)
	ui.statusHit:Hide()
	ui.chatName:SetPoint("RIGHT", hr, "LEFT", 0, 0)
	ui.hrEdge = hr -- [UX-3] where the usage line sits (U.RenderStatus)
	ui.L = L

	-- Chats
	local list, ltpl = Create("Frame", nil, f, { "InsetFrameTemplate", "BackdropTemplate" })
	if ltpl ~= "InsetFrameTemplate" then Backdrop(list, "inset", 0, 0, 0, 0.5) end
	list:SetPoint("TOPLEFT", f, "TOPLEFT", EDGE, L.top)
	list:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", EDGE, BOTTOM)
	list:SetWidth(PANEL_W)
	ui.list = list
	-- New Chat and the foot never scroll: the list's width, LIST_IN in from
	-- both edges (maintainer: not limited by the scroll bar).
	local newBtn = Button(list, "New Chat", PANEL_W - 2 * LIST_IN, function() ns.Chats.New() end, "NQANewChat")
	newBtn:SetPoint("TOPLEFT", list, "TOPLEFT", LIST_IN, -LIST_IN)
	ui.listScroll, ui.listContent = ScrollArea("NQAChatScroll", list)
	ui.listScroll:SetPoint("TOPLEFT", list, "TOPLEFT", LIST_IN - ROW_IN, -(LIST_IN + 22 + 8))
	ui.listScroll:SetPoint("BOTTOMRIGHT", list, "BOTTOMRIGHT", -(LIST_IN - ROW_IN), LIST_FOOT)
	-- The scroll bar only while the chats don't fit (the game's own
	-- ScrollFrame_OnScrollRangeChanged hides it), and the rows take its room
	-- back then (U.FitListWidth).
	ui.listScroll.scrollBarHideable = true
	if ui.listScroll.HookScript then
		ui.listScroll:HookScript("OnScrollRangeChanged", function(_, _, yrange) U.FitListWidth((tonumber(yrange) or 0) >= 1) end)
	end
	U.ListBar(false) -- nothing to scroll yet (the template's OnLoad showed it)
	-- [G-1] No foot: the app keeps the addon up to date, so the rows take the room.
	ui.listW = PANEL_W - 2 * (LIST_IN - ROW_IN)
	ui.listContent:SetWidth(ui.listW)
	ui.rows = {}
	-- Where the conversation starts: right of the list, or near the window's
	-- left edge with the list folded away (U.SetListShown moves it).
	local edge = CreateFrame("Frame", nil, f)
	edge:SetWidth(1)
	ui.edge = edge

	-- Transcript
	local inset, itpl = Create("Frame", nil, f, { "InsetFrameTemplate", "BackdropTemplate" })
	if itpl ~= "InsetFrameTemplate" then Backdrop(inset, "inset", 0, 0, 0, 0.5) end
	inset:SetPoint("TOPLEFT", edge, "TOPRIGHT", 6, 0)
	inset:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -EDGE, BOTTOM + COMPOSER_H + CONTEXT_H + 8)
	ui.inset = inset
	ui.scroll, ui.content = ScrollArea("NQAScroll", inset)
	ui.scroll:SetPoint("TOPLEFT", inset, "TOPLEFT", 6, -6)
	ui.scroll:SetPoint("BOTTOMRIGHT", inset, "BOTTOMRIGHT", -28, 6)
	-- A new width re-wraps every bubble: drawn again, on the newest. [ingame-clarity] A new height
	-- alone (the header's status line on two lines or back on one, the grip's height) keeps the reader's
	-- place, or the bottom for one who was at it: a status line that wrapped threw a reader to the newest.
	ui.scroll:HookScript("OnSizeChanged", function(self, w)
		w = math.floor((tonumber(w) or self:GetWidth() or 0) + 0.5)
		local newWidth = w ~= ui.scrollW
		ui.scrollW = w -- kept while closed too: opening draws it again at the width it has
		if not U.IsOpen() then return end
		if newWidth then
			ns.Refresh("all")
		elseif U.AtBottom() then
			U.ScrollTo("bottom")
		else
			U.ScrollTo(nil, self:GetVerticalScroll() or 0)
		end
	end)
	ui.scroll:HookScript("OnVerticalScroll", function()
		if ui.newPill and U.AtBottom() then ui.newPill:Hide() end
	end)
	ui.bubbles = {}
	MakeWorkBubble()

	-- "New reply ↓": a reply landed while you were reading further up.
	local pill = MakeChip(inset, CHIP_H)
	pill:SetPoint("BOTTOM", inset, "BOTTOM", 0, 8)
	pill:SetWidth(120)
	pill:SetFrameLevel((inset:GetFrameLevel() or 1) + 20)
	pill.label:SetText("Show New Reply")
	pill.label:SetTextColor(1, 0.82, 0)
	pill:SetScript("OnClick", function(self)
		self:Hide()
		U.ScrollTo("newest")
	end)
	pill:Hide()
	ui.newPill = pill

	-- A command's answer (Chats.Notice): grey, with an X; a click copies it.
	local note = CreateFrame("Frame", nil, ui.content)
	note.bg = note:CreateTexture(nil, "BACKGROUND")
	note.bg:SetAllPoints()
	note.bg:SetColorTexture(0.7, 0.7, 0.7, 0.07)
	note.who = note:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	note.who:SetPoint("TOPLEFT", note, "TOPLEFT", BUBBLE_X, -BUBBLE_Y)
	note.who:SetText("NeverQuestAlone")
	note.body = note:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	note.body:SetPoint("TOPLEFT", note, "TOPLEFT", BUBBLE_X, -BODY_TOP)
	note.body:SetJustifyH("LEFT")
	note.body:SetJustifyV("TOP")
	note.body:SetWordWrap(true)
	note.close = Create("Button", nil, note, { "UIPanelCloseButton" })
	note.close:SetSize(20, 20)
	note.close:SetPoint("TOPRIGHT", note, "TOPRIGHT", -2, -2)
	note.close:SetScript("OnClick", function() ns.Chats.DismissNotice(note.chatId) end)
	note:EnableMouse(true)
	note:SetScript("OnMouseUp", function(self, button)
		if button == "LeftButton" and self.text then U.ShowCopy(ns.CopyText(self.text)) end
	end)
	note:Hide()
	ui.notice = note

	-- Above the composer, what goes with your next message: game data (a tick;
	-- what it holds, the place, level, quests and gear, is in its tooltip only)
	-- and, at the right, how hard Bones thinks in this chat (a menu). The row is
	-- the text box's width, so the menu ends where the box does (maintainer).
	local ctx = CreateFrame("Frame", nil, f)
	ctx:SetPoint("BOTTOMLEFT", edge, "BOTTOMRIGHT", 6, COMPOSER_H + 4)
	ctx:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -(EDGE + SEND_W + 8), BOTTOM + COMPOSER_H + 4) -- the text box's width (maintainer)
	ctx:SetHeight(CONTEXT_H)
	ctx.toggle = Create("CheckButton", nil, ctx, { "UICheckButtonTemplate" })
	ctx.toggle:SetSize(24, 24)
	ctx.toggle:SetPoint("LEFT", ctx, "LEFT", -3, 0) -- the box's art sits 3 in: its edge meets the composer's
	ctx.toggle:SetScript("OnClick", function()
		R.skipGameData = not R.skipGameData
		U.RenderContext()
	end)
	ctx.toggle:SetScript("OnEnter", function(self)
		ShowTip(self, { title = "Game Data", text = ctx.detail, lines = ctx.lines, actions = ctx.actions, note = ctx.note })
	end)
	ctx.toggle:SetScript("OnLeave", HideTip)
	Call(ctx.toggle, "SetMotionScriptsWhileDisabled", true) -- off for good, it still says how to turn it on
	ctx.text = ctx:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	ctx.text:SetPoint("LEFT", ctx.toggle, "RIGHT", 2, 0)
	ctx.text:SetJustifyH("LEFT")
	ctx.text:SetWordWrap(false)
	-- How hard Bones thinks: "Thinks medium" and an arrow; a menu on a click.
	ui.header = ctx:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	ui.header:SetJustifyH("RIGHT")
	ui.header:SetWordWrap(false)
	ui.thinkArrow = ctx:CreateTexture(nil, "OVERLAY")
	ui.thinkArrow:SetPoint("RIGHT", ctx, "RIGHT", 0, 0)
	if type(C_Texture) == "table" and type(C_Texture.GetAtlasExists) == "function" and C_Texture.GetAtlasExists("friendslist-categorybutton-arrow-down") then
		ui.thinkArrow:SetAtlas("friendslist-categorybutton-arrow-down")
		ui.thinkArrow:SetSize(12, 12)
	else
		ui.thinkArrow:SetTexture("Interface\\Buttons\\Arrow-Down-Up")
		ui.thinkArrow:SetSize(14, 14)
	end
	ui.header:SetPoint("RIGHT", ui.thinkArrow, "LEFT", -3, 0)
	local think = CreateFrame("Button", nil, ctx)
	think:SetPoint("TOPLEFT", ui.header, "TOPLEFT", -4, 4)
	think:SetPoint("BOTTOMRIGHT", ui.thinkArrow, "BOTTOMRIGHT", 3, -3)
	local thl = think:CreateTexture(nil, "HIGHLIGHT")
	thl:SetAllPoints()
	thl:SetTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight")
	thl:SetBlendMode("ADD")
	think:SetScript("OnClick", function(self) U.ThinkMenu(self) end)
	think:SetScript("OnEnter", function(self)
		local chat = ns.Chats.Active()
		-- [UX-4] the provider's word for it: effort
		local say = chat and select(3, U.HeaderParts(chat)) or nil
		local models = #U.ModelChoices() > 0
		ShowTip(self, { title = models and "Model" or "Thinking", text = models and "Choose the AI model for this chat. Your choice starts with your next message." or "How hard NeverQuestAlone thinks in this chat: Low is quicker, High is slower and deeper.", actions = { "Click to change it" }, note = say }) -- [UX-W19]
	end)
	think:SetScript("OnLeave", HideTip)
	ui.thinkBtn = think
	ctx.text:SetPoint("RIGHT", think, "LEFT", -8, 0) -- never under the menu, however narrow the row
	ui.ctx = ctx

	-- Composer: a multi-line box; Enter sends, Shift+Enter starts a new line.
	local comp, ctpl = Create("Frame", nil, f, { "InsetFrameTemplate", "BackdropTemplate" })
	if ctpl ~= "InsetFrameTemplate" then Backdrop(comp, "inset", 0, 0, 0, 0.6) end
	comp:SetPoint("BOTTOMLEFT", edge, "BOTTOMRIGHT", 6, 0)
	comp:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -(EDGE + SEND_W + 8), BOTTOM)
	comp:SetHeight(COMPOSER_H)
	-- The hint in an empty box.
	ui.hint = comp:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	ui.hint:SetPoint("TOPLEFT", comp, "TOPLEFT", 8, -6) -- where the words you type start, at their size
	ApplyTextSize(ui.hint, nil, HINT_MAX) -- up to Large: two lines of it fit the box
	U.RenderHintText()
	local inScroll = Create("ScrollFrame", "NQAInputScroll", comp, { "UIPanelScrollFrameTemplate" })
	inScroll:SetPoint("TOPLEFT", comp, "TOPLEFT", 8, -6)
	inScroll:SetPoint("BOTTOMRIGHT", comp, "BOTTOMRIGHT", -28, 6)
	-- The hint stays inside the text area: wrapped, two lines at most.
	ui.hint:SetPoint("RIGHT", inScroll, "RIGHT", 0, 0)
	ui.hint:SetJustifyH("LEFT")
	ui.hint:SetJustifyV("TOP")
	ui.hint:SetWordWrap(true)
	if ui.hint.SetMaxLines then ui.hint:SetMaxLines(2) end
	local input = CreateFrame("EditBox", nil, inScroll) -- no global name: it sends
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFontObject(ChatFontNormal)
	input:SetMaxLetters(0)
	input:SetSize(400, 44)
	input:SetScript("OnEnterPressed", function(self)
		if type(IsShiftKeyDown) == "function" and IsShiftKeyDown() then
			self:Insert("\n")
		else
			U.SendFromInput()
		end
	end)
	input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	-- Up and Down on an empty box bring back what you sent (U.Recall).
	input:SetScript("OnArrowPressed", function(_, key)
		if key == "UP" or key == "DOWN" then U.Recall(key) end
	end)
	input:SetScript("OnEditFocusGained", function() U.RenderHint() end)
	input:SetScript("OnEditFocusLost", function() U.RenderHint() end)
	-- The NeverQuestAlone key closes the window even while you type (U.KeyClosesWindow).
	input:SetScript("OnKeyDown", function(self, key)
		if U.KeyClosesWindow(key) then
			self.nqaSwallow = self:GetText() -- a character the chord might still type is taken back
			U.Close()
			if C_Timer and C_Timer.After then C_Timer.After(0, function() self.nqaSwallow = nil end) end
		end
	end)
	input:SetScript("OnChar", function(self)
		if self.nqaSwallow then
			local before = self.nqaSwallow
			self.nqaSwallow = nil
			self:SetText(before)
		elseif self.nqaOpenedAt then
			local opened, before = self.nqaOpenedAt, self.nqaOpenText
			self.nqaOpenedAt, self.nqaOpenText = nil, nil
			if GetTime() - opened < 0.2 then self:SetText(before or "") end
		end
	end)
	-- Blizzard's ScrollingEdit helpers keep the cursor in view in a long message.
	input:SetScript("OnTextChanged", function(self)
		if type(ScrollingEdit_OnTextChanged) == "function" then pcall(ScrollingEdit_OnTextChanged, self, inScroll) end
		U.UpdateCounter()
		U.RenderHint()
	end)
	if type(ScrollingEdit_OnCursorChanged) == "function" then input:SetScript("OnCursorChanged", ScrollingEdit_OnCursorChanged) end
	if type(ScrollingEdit_OnUpdate) == "function" then
		input:SetScript("OnUpdate", function(self, elapsed) pcall(ScrollingEdit_OnUpdate, self, elapsed, inScroll) end)
	end
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(_, w) input:SetWidth(w) end)
	-- A short message makes the box one line tall, and clicks below it land on
	-- the scroll frame or the inset: both put the cursor in the box, at the end
	-- (Blizzard's InputScrollFrame does the same).
	local function FocusAtEnd()
		input:SetFocus()
		if input.SetCursorPosition then input:SetCursorPosition(#(input:GetText() or "")) end
	end
	inScroll:EnableMouse(true)
	inScroll:SetScript("OnMouseDown", FocusAtEnd)
	comp:EnableMouse(true)
	comp:SetScript("OnMouseDown", FocusAtEnd)
	ui.input = input

	local send = Button(f, "Send", SEND_W, function() U.SendFromInput() end)
	send:SetHeight(28)
	send:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -EDGE, BOTTOM + (COMPOSER_H - 28) / 2) -- centred on the box
	ui.send = send
	ui.counter = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	ui.counter:SetPoint("BOTTOM", send, "TOP", 0, 6)
	ApplyTextSize(input)

	local grip = CreateFrame("Button", nil, f)
	grip:SetSize(16, 16)
	grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -4, 4)
	grip:SetHitRectInsets(-4, -4, -4, -4) -- a near miss still sizes it (C-98)
	grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
	grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
	grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")
	grip:SetScript("OnMouseDown", function()
		ui.moving = true
		f:StartSizing("BOTTOMRIGHT")
	end)
	grip:SetScript("OnMouseUp", function()
		f:StopMovingOrSizing()
		ui.moving = nil
		Call(f, "SetUserPlaced", false)
		s.width, s.height = f:GetSize()
		s.heightSet = true -- your own size: the home place's 140 rule leaves it alone
		-- The top-left corner stays where it was: home keeps its own anchor, a
		-- place you chose keeps one anchor at that corner (KeepPlace).
		if AtHome() then U.StepAside() else KeepPlace(f, s) end
	end)
	ui.grip = grip

	BuildMini()
	BuildBanner()
	U.SetListShown(s.listShown, true)
	U.FitToScreen()
	local ev = CreateFrame("Frame")
	for _, e in ipairs({ "UI_SCALE_CHANGED", "DISPLAY_SIZE_CHANGED" }) do pcall(ev.RegisterEvent, ev, e) end
	ev:SetScript("OnEvent", function()
		U.FitToScreen()
		U.PickFaces()
	end)
end

-- The round portrait for a region drawn `units` UI units across: the 64 px
-- twin under 52 screen pixels (units x its effective scale x the physical
-- screen's height / 768: 1x displays at most UI scales), else the 128 (sharper
-- on retina). One bilinear sample of the 128 per pixel steps the jaw, the
-- teeth and the gem's edges at 1x; the 64 is their area average there.
function U.RoundFace(region, units)
	local scale = tonumber(region and ns.Try(region.GetEffectiveScale, region)) or 1
	local _, h = ns.Try(GetPhysicalScreenSize)
	local px = (tonumber(units) or 0) * scale * (tonumber(h) or 768) / 768
	return px < 52 and U.FACE.round64 or U.FACE.round
end

-- Put Bones's round face in a portrait frame's slot (its own
-- SetPortraitTextureRaw, else the texture itself), picked for `units`, and
-- crop it the same in every slot (the HUD's and the window's, C-150): the
-- skull and its wink fill about 68% of the circle, as Blizzard's portraits
-- fill theirs, with the jaw clear of the ring. Set again on every pick, so a
-- UI-scale change keeps it. Returns whether it took.
function U.SetRoundFace(f, tex, units)
	local face = U.RoundFace(tex or f, units)
	local ok = false
	if type(f.SetPortraitTextureRaw) == "function" then ok = pcall(f.SetPortraitTextureRaw, f, face) end
	if not ok and tex then ok = pcall(tex.SetTexture, tex, face) end
	if ok and not Call(f, "SetPortraitTexCoord", 0.12, 0.88, 0.10, 0.86) and tex then
		pcall(tex.SetTexCoord, tex, 0.12, 0.88, 0.10, 0.86)
	end
	return ok
end

-- The window's portrait slot, in UI units (the template's 62 where its
-- texture has no size yet).
function U.WindowFaceSize()
	local w = tonumber(ui.portraitTex and ns.Try(ui.portraitTex.GetWidth, ui.portraitTex))
	return w and w > 0 and w or 62
end

-- The UI scale or the display changed: the window's round portrait picked
-- again for its drawn size (the HUD picks its own, HUD.lua H.PickFace).
function U.PickFaces()
	if ui.frame and ui.portraitTex then U.SetRoundFace(ui.frame, ui.portraitTex, U.WindowFaceSize()) end
end

-- The chat list, shown or folded away. The conversation keeps its width: the
-- window grows or shrinks by the list's (initial: as saved, no change).
function U.SetListShown(shown, initial)
	local f = ui.frame
	if not f or not ui.list then return end
	local s = ns.db.settings
	shown = shown and true or false
	local was = s.listShown and true or false
	s.listShown = shown
	ui.list:SetShown(shown)
	local edge, L = ui.edge, ui.L
	edge:ClearAllPoints()
	if shown then
		edge:SetPoint("TOPRIGHT", ui.list, "TOPRIGHT", 0, 0)
		edge:SetPoint("BOTTOMRIGHT", ui.list, "BOTTOMRIGHT", 0, 0)
	else
		edge:SetPoint("TOPRIGHT", f, "TOPLEFT", EDGE - 6, U.PaneTop()) -- the transcript and composer 6 right of it: at the gutter
		edge:SetPoint("BOTTOMRIGHT", f, "BOTTOMLEFT", EDGE - 6, BOTTOM)
	end
	if not initial and was ~= shown then
		local w = math.max(MIN_W + (shown and (PANEL_W + 6) or 0), f:GetWidth() + (shown and 1 or -1) * (PANEL_W + 6))
		-- Away from home the right edge stays, so the corner's - or + you just
		-- clicked is still under the pointer; the list opens to the left (or
		-- rightwards, where that would leave the screen). Home grows rightwards.
		local right, top = f:GetRight(), f:GetTop()
		f:SetWidth(w)
		s.width = w
		if not AtHome() and type(right) == "number" and type(top) == "number" and right - w >= 0 then
			local x, y = math.floor(right - w + 0.5), math.floor(top + 0.5)
			f:ClearAllPoints()
			f:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", x, y)
			s.point, s.relPoint, s.x, s.y = "TOPLEFT", "BOTTOMLEFT", x, y
		end
		U.FitToScreen()
		U.StepAside()
		-- [ingame-clarity] The header refitted on the click (its status line one line or two), not at
		-- the next tick: the panes never move by themselves after it.
		if U.IsOpen() then U.RenderWindowStatus(ns.Chats.Active()) end
	end
	U.RenderListButton()
end

-- "Chats", with how many replies wait in the others while the list is folded.
-- The corner's - (the list is shown) or +; the replies you haven't read in
-- your other chats are in the title, as the HUD's ("Bones  2 new").
function U.RenderListButton()
	local b = ui.listBtn
	if not b then return end
	local kind = ns.db.settings.listShown and "minus" or "plus"
	if b.kind ~= kind then U.KitArt(b, kind) end
end
function U.UnreadElsewhere()
	local unread = 0
	for _, c in ipairs(ns.db.chats) do
		if c.id ~= ns.db.activeChat then unread = unread + (tonumber(c.unread) or 0) end
	end
	return unread
end

-- In its home place (top left, where the game's own panels open), the window
-- steps right of any of the game's panels that's open (the character sheet,
-- the spellbook), and back when they close. A window you moved stays put, and
-- one being dragged or sized is left alone.
function U.StepAside()
	local f = ui.frame
	if not f or not f:IsShown() or not ns.db or not AtHome() or ui.moving then return end
	local x = HOME_X
	if type(GetUIPanel) == "function" then
		local us = ns.Try(UIParent.GetEffectiveScale, UIParent) or 1
		for _, key in ipairs({ "left", "center", "doublewide" }) do
			local p = ns.Try(GetUIPanel, key)
			if type(p) == "table" and p ~= f and p.IsShown and p:IsShown() then
				local right = ns.Try(p.GetRight, p)
				if type(right) == "number" then
					x = math.max(x, math.floor(right * (ns.Try(p.GetEffectiveScale, p) or 1) / us + 8))
				end
			end
		end
	end
	-- Beside them only while that keeps clear of the HUD (or, with it off, the
	-- quest tracker) by 12: else home, over them (the game's panels raise
	-- themselves; whichever you clicked last is on top).
	local limit = (UIParent:GetWidth() or 0) - 8
	local hud = ns.HUD and ns.HUD.Active() and ns.HUD.Frame()
	local other = (hud and hud:IsShown() and hud) or (type(ObjectiveTrackerFrame) == "table" and ObjectiveTrackerFrame) or nil
	local left = other and ns.Try(other.GetLeft, other)
	if type(left) == "number" then
		left = left * (ns.Try(other.GetEffectiveScale, other) or 1) / (ns.Try(UIParent.GetEffectiveScale, UIParent) or 1)
		limit = math.min(limit, left - 12)
	end
	if x ~= HOME_X and x + (f:GetWidth() or 0) > limit then x = HOME_X end
	f:ClearAllPoints()
	f:SetPoint(HOME_POINT, UIParent, HOME_POINT, x, HOME_Y)
end

-- The game's panels open and close through ShowUIPanel and HideUIPanel:
-- post-hooks, so nothing of theirs is replaced; the move waits a frame for
-- the game to place its panel.
local function StepAsideSoon()
	if C_Timer and C_Timer.After then C_Timer.After(0, U.StepAside) else U.StepAside() end
end
if type(hooksecurefunc) == "function" then
	if type(ShowUIPanel) == "function" then hooksecurefunc("ShowUIPanel", StepAsideSoon) end
	if type(HideUIPanel) == "function" then hooksecurefunc("HideUIPanel", StepAsideSoon) end
end

-- The window is never bigger than the screen: one that is can't be dragged
-- (it's clamped to the screen) and its resize grip ends up off screen. Runs at
-- load, on show, on a UI scale or display change, and for /bones window reset.
local SCREEN_MARGIN = 16
local BAR_CLEARANCE = 140 -- the game keeps its side panels this far above the bottom, clear of the action bars (ClampUIPanelY's bottomClamp)
function U.FitToScreen()
	local f = ui.frame
	if not f or not UIParent or not ns.db then return end
	local s = ns.db.settings
	local minW = MIN_W + (s.listShown and (PANEL_W + 6) or 0)
	local maxW = math.max(minW, math.floor(UIParent:GetWidth() - 2 * SCREEN_MARGIN))
	local maxH = math.max(MIN_H, math.floor(UIParent:GetHeight() - 2 * SCREEN_MARGIN))
	if type(f.SetResizeBounds) == "function" then f:SetResizeBounds(minW, MIN_H, maxW, maxH) end
	local w, h = f:GetSize()
	-- A saved width from before the list was shown (or from a smaller UI) grows to fit it.
	if w < minW then
		w = minW
		f:SetWidth(w)
		s.width = w
	end
	if w > maxW or h > maxH then
		w, h = math.min(w, maxW), math.min(h, maxH)
		f:SetSize(w, h)
		s.width, s.height = w, h
	end
	-- In its home place (with the game's panels), the default height keeps
	-- clear of the action bars as they do: no lower than 140 above the bottom.
	-- Only what's shown is trimmed, and never a height you set with the grip.
	local home = s.point == nil or (s.point == HOME_POINT and s.x == HOME_X and s.y == HOME_Y)
	local homeMax = math.floor(UIParent:GetHeight() + HOME_Y - BAR_CLEARANCE)
	local want = math.min(tonumber(s.height) or h, maxH)
	if home and not s.heightSet and homeMax >= MIN_H then want = math.min(want, homeMax) end
	if want ~= h then f:SetHeight(want) end
	-- Off screen (a saved place from a bigger UI): moved just back onto it,
	-- not sent home. A window dropped against an edge measures a hair past it
	-- (the clamp is in pixels, this in units), so a unit either way is on.
	local left, right, top, bottom = f:GetLeft(), f:GetRight(), f:GetTop(), f:GetBottom()
	local sw, sh = UIParent:GetWidth(), UIParent:GetHeight()
	if type(left) == "number" and type(right) == "number" and type(top) == "number" and type(bottom) == "number"
		and (left < -1 or bottom < -1 or right > sw + 1 or top > sh + 1) then
		local dx = left < 0 and -left or (right > sw and sw - right or 0)
		local dy = bottom < 0 and -bottom or (top > sh and sh - top or 0)
		local x, y = math.floor(left + dx + 0.5), math.floor(top + dy + 0.5)
		f:ClearAllPoints()
		f:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", x, y)
		if not AtHome() then s.point, s.relPoint, s.x, s.y = "TOPLEFT", "BOTTOMLEFT", x, y end
	end
end

-- /bones window reset: the default size, top left where the game's panels open.
function U.ResetWindow()
	if not ui.frame then return end
	local s = ns.db.settings
	U.SetListShown(false)
	s.width, s.height, s.heightSet = DEFAULT_W, DEFAULT_H, nil
	s.point, s.relPoint, s.x, s.y = HOME_POINT, HOME_POINT, HOME_X, HOME_Y
	ui.frame:ClearAllPoints()
	ui.frame:SetPoint(HOME_POINT, UIParent, HOME_POINT, HOME_X, HOME_Y)
	ui.frame:SetSize(DEFAULT_W, DEFAULT_H)
	U.FitToScreen()
	U.Toggle(true)
end

---------------------------------------------------------------------------
-- Drawing
---------------------------------------------------------------------------

-- The chat's name in the middle of the band over the panes; with a status
-- line under it, the two lines in the middle together (maintainer: "left middle
-- vertically aligned").
-- [ingame-clarity] wraps: the status line takes two lines; the panes start a line lower meanwhile.
function U.PlaceHeader(two, wraps)
	local L = ui.L
	if not (L and ui.light and ui.headerRight) then return end
	local y = two and (L.headerY2 or L.headerY) or L.headerY
	if ui.headerAt ~= y then
		ui.headerAt = y
		ui.light:ClearAllPoints()
		ui.light:SetPoint("TOPLEFT", ui.frame, "TOPLEFT", L.headerX, y)
		ui.headerRight:ClearAllPoints()
		ui.headerRight:SetPoint("TOPRIGHT", ui.frame, "TOPRIGHT", -EDGE, y)
	end
	local drop = (two and wraps and L.statusLine) or 0
	if (ui.statusDrop or 0) == drop or not ui.list then return end
	ui.statusDrop = drop
	ui.list:SetPoint("TOPLEFT", ui.frame, "TOPLEFT", EDGE, U.PaneTop())
	if not ns.db.settings.listShown then ui.edge:SetPoint("TOPRIGHT", ui.frame, "TOPLEFT", EDGE - 6, U.PaneTop()) end
end
-- Where the panes (the chat list, the transcript) start: under the header, a line lower while its
-- status line takes two.
function U.PaneTop()
	return ui.L.top - (ui.statusDrop or 0)
end

function U.UpdateCounter()
	if not ui.counter or not ui.input then return end
	local n = #(ui.input:GetText() or "")
	if n > ns.MAX_TEXT - 400 then
		ui.counter:SetText((n > ns.MAX_TEXT and "|cffff5555" or "") .. n .. " / " .. ns.MAX_TEXT .. (n > ns.MAX_TEXT and "|r" or ""))
	else
		ui.counter:SetText("")
	end
end

-- "now", "5 min", "2 h", "3 days": how long ago, for the list (STYLE §8).
function U.Age(t)
	t = tonumber(t)
	if not t then return "" end
	local d = math.max(0, time() - t)
	if d < 60 then return "now" end
	if d < 3600 then return ns.Fill("{n} min", { n = math.floor(d / 60) }) end
	if d < 86400 then return ns.Fill("{n} h", { n = math.floor(d / 3600) }) end
	return ns.Plural(math.floor(d / 86400), "1 day", "{n} days")
end

function U.RenderList()
	if not ui.rows then return end
	local chats = ns.db.chats
	for i, c in ipairs(chats) do
		local row = ui.rows[i] or MakeRow(i)
		row.label:SetText(ns.Escape(c.name))
		if c.unread > 0 then
			row.badge:SetText(ns.GREEN_HEX .. c.unread .. " new|r")
		elseif ns.Chats.IsBusy(c) then
			row.badge:SetText("|cffffd100Working|r")
		else
			row.badge:SetText("")
		end
		row.preview:SetText(ns.Chats.Preview(c, 48))
		row.age:SetText(#c.history > 0 and U.Age(c.lastAt) or "")
		row.pin:SetShown(c.pinned == true)
		PlaceRow(row, c.pinned == true)
		local nextChat = chats[i + 1]
		row.sep:SetShown(c.pinned == true and nextChat ~= nil and not nextChat.pinned)
		row.chatId = c.id
		row.selected:SetShown(c.id == ns.db.activeChat)
		row:Show()
	end
	for i = #chats + 1, #ui.rows do
		ui.rows[i]:Hide()
	end
	ui.listContent:SetHeight(math.max(1, #chats * ROW_H))
	U.FitListWidth((ui.listScroll and ui.listScroll.GetVerticalScrollRange and ui.listScroll:GetVerticalScrollRange() or 0) >= 1)
end

-- The chat list's scroll bar, shown only while the chats don't fit, when the
-- list makes room for it inside its edge. The template's OnLoad shows it before
-- scrollBarHideable can be set, and a range that stays 0 never calls
-- OnScrollRangeChanged, so beside a short list it hung over the conversation
-- and the Game Data box (maintainer, 0.5.0): the addon sets it itself.
function U.ListBar(show)
	local sf = ui.listScroll
	if not sf then return end
	local _, name = Call(sf, "GetName")
	local bar = sf.ScrollBar
	if type(bar) ~= "table" then bar = type(name) == "string" and _G[name .. "ScrollBar"] or nil end
	if type(bar) == "table" then Call(bar, "SetShown", show and true or false) end
end

-- The rows' width: the list's, less the scroll bar's room while it shows
-- (the chats don't fit); otherwise their words end where the buttons do.
function U.FitListWidth(scrolls)
	if not (ui.listScroll and ui.list) then return end
	U.ListBar(scrolls)
	local right = scrolls and SCROLL_GUTTER or (LIST_IN - ROW_IN)
	local w = PANEL_W - (LIST_IN - ROW_IN) - right
	if ui.listW == w then return end
	ui.listW = w
	ui.listScroll:SetPoint("BOTTOMRIGHT", ui.list, "BOTTOMRIGHT", -right, LIST_FOOT)
	ui.listContent:SetWidth(w)
	for _, r in ipairs(ui.rows or {}) do r:SetWidth(w) end
end

-- [UX-2, C-10] What an error is, by its kind (PRD §10), once the bridge names kinds
-- (cap ekind; an error then has an action): one that passes on its own or on
-- a retry is gold, "Didn't go through"; one the player fixes is red, "Needs
-- you"; a refusal is grey, "Declined". The window's bubbles and the HUD's
-- headline use the same map. Older errors keep "Error" in red.
local ERROR_CLASS = {
	overloaded = "retry", rate_limited = "retry", timeout = "retry", network_after_send = "retry", interrupted = "retry",
	network_before_send = "retry", rate_limited_daily = "retry", provider_down = "retry", bad_request = "retry", unknown = "retry",
	auth_invalid = "fix", out_of_credit = "fix", spend_limit = "fix", cap_spend = "fix",
	model_not_found = "fix", context_too_long = "fix", local_unreachable = "fix", region_blocked = "fix",
	identifier_blocked = "fix", oauth_expired = "fix", key_invalid = "fix", no_key = "fix", egress_blocked = "fix",
	content_blocked = "declined",
	-- The bridge's own: a key-shaped message wasn't sent; a map that didn't draw;
	-- automatic help paused itself (the runaway fuse): it waits for your
	-- next message, which turns it back on (it answers no message).
	refused = "notsent", map_block = "note", auto_paused = "held",
}
local ERROR_LOOK = {
	retry = { "Didn't go through", { 1, 0.82, 0 } },
	fix = { "Needs you", { 1, 0.44, 0.44 } },
	declined = { "Declined", { 0.7, 0.7, 0.7 } },
	notsent = { "Not sent", { 0.7, 0.7, 0.7 } },
	note = { "Note", { 0.7, 0.7, 0.7 } },
	held = { "Waits for your next message", { 1, 0.82, 0 } },
}
-- An error entry's label, colour and class ("retry", "fix", "declined"):
-- "Needs you", { r, g, b }, "fix". Without a kind (an older bridge): "Error".
function U.ErrorLook(entry)
	if not (entry and entry.err and entry.action) then return "Error", ROLE_COLOR.error, nil end
	-- A line that answers no message is a note, whatever its kind (C-31).
	-- Held (automatic help paused) keeps its look though it answers nothing.
	local class = (ERROR_CLASS[entry.kind] == "held" and "held") or (entry.info and "note") or ERROR_CLASS[entry.kind] or "retry"
	local look = ERROR_LOOK[class]
	return look[1], look[2], class
end

local function WhoLabel(chat, entry)
	if entry.role == "user" then
		local p
		for _, x in ipairs(chat.pending) do
			if x.key == entry.key then p = x end
		end
		local you = ns.YouName() -- "You" by default, as main
		local who = entry.event and "Sent by the game" or (entry.bare and (you .. " · no game data") or you)
		-- [DR-07] A message a Reload couldn't deliver, and one discarded then.
		if entry.notSent then return ns.Fill("{who} · not sent", { who = who }) end
		if p and not p.acked then
			local failed = ns.Transport.Undelivered()
			for _, k in ipairs(failed or {}) do
				if k == p.key then return ns.Fill("{who} · didn't go through", { who = who }) end
			end
			return who .. (ns.Transport.StripOut() and " · sending" or " · waiting for a reload")
		end
		if p and entry.queued and chat.pending[1] ~= p then return who .. " · queued" end
		return who
	elseif entry.role == "assistant" or entry.starter then
		return ns.Chats.AgentName(entry.agent or chat.agent)
	end
	if entry.err then return (U.ErrorLook(entry)) end -- [C-10] "Error" without a kind, as main's
	return "System"
end

-- Bones's TL;DR, for the strip on top of his bubble; nil when there's none.
local function Tldr(entry)
	if entry.role ~= "assistant" or type(entry.summary) ~= "string" or entry.summary == "" then return nil end
	return entry.summary
end

-- Where the reply's own TL;DR line starts (the last line beginning with it,
-- when what follows is the summary), so the strip isn't repeated at the end.
local function TldrStart(text, summary)
	local at, pos = nil, 1
	while true do
		local s = text:find("\n[ \t]*[Tt][Ll];?[Dd][Rr]", pos) or text:find("\n[ \t]*|c%x%x%x%x%x%x%x%x[Tt][Ll];?[Dd][Rr]", pos)
		if not s then break end
		at, pos = s, s + 1
	end
	if at and text:find(summary:sub(1, 12), at, true) then return at end
end

local function BodyText(entry)
	if entry.role == "user" then return ns.Escape(entry.text) end
	local text = entry.text or ""
	local summary = Tldr(entry)
	if summary then
		local at = TldrStart(text, summary)
		if at then text = (text:sub(1, at - 1):gsub("%s+$", "")) end
	end
	if (entry.more or 0) > 0 then
		text = text .. ns.P("\n\n|cff9d9d9d(… the rest didn't fit in the window: ask for it)|r") -- [UX-5] in the companion's name
	end
	return text
end

-- [UX-2, UX-3] An error's details, for a click on its Show Details: what happened, where,
-- and what its button does. Display-ready.
-- [UX-W21, UX-W19] The glossary's words: your AI company (the "Where:" line under
-- them names it), a message, check-ins; {app} is a local model's app ("Ollama").
local ERROR_WORDS = {
	auth_invalid = "your key was rejected", out_of_credit = "your account is out of credit",
	spend_limit = "the spend limit you set at your AI company", cap_spend = "your daily spend limit",
	rate_limited = "your AI company asked NeverQuestAlone to slow down",
	rate_limited_daily = "your AI company's daily limit", overloaded = "your AI company is busy",
	model_not_found = "the model isn't available on your account", context_too_long = "the chat is too long for the model",
	content_blocked = "the model declined to answer", network_before_send = "no connection to your AI company",
	network_after_send = "the connection dropped after the message went", local_unreachable = "{app} isn't running",
	region_blocked = "your AI company isn't available where you are", identifier_blocked = "your AI company blocked this install",
	oauth_expired = "your sign-in ended", interrupted = "NeverQuestAlone restarted before the reply came",
	timeout = "no answer in time", bad_request = "your AI company couldn't take that message", unknown = "something unexpected",
	no_key = "no key yet", egress_blocked = "NeverQuestAlone blocked a connection it doesn't allow",
	refused = "it wasn't sent", map_block = "the reply came, but its map didn't draw",
	auto_paused = "check-ins paused themselves because too many came at once; your next message turns them back on",
}
function U.ErrorDetails(entry, chat)
	-- [UX-W10] whole lines with named places (§12); the time as the game's clock shows it
	local said = ERROR_WORDS[entry.kind] and ns.Fill(ns.P(ERROR_WORDS[entry.kind]), { app = ns.ProviderOwnName() or "your AI" })
	local lines = { ns.Fill("What happened: {what}.", { what = said or ns.Escape(tostring(entry.kind or "an error")) }) }
	if entry.provider then
		local t = { AI = entry.provider, model = entry.model }
		lines[#lines + 1] = entry.model and ns.Fill("Where: {AI} · {model}.", t) or ns.Fill("Where: {AI}.", t)
	end
	local at = entry.t and ns.Clock(entry.t)
	if at then lines[#lines + 1] = ns.Fill("When: {time}.", { time = at }) end
	if entry.rid then lines[#lines + 1] = ns.Fill("Request ID: {id}.", { id = ns.Escape(entry.rid) }) end
	-- What its button does (the desktop line under it says where the fix is).
	-- With the chat, only a button it has: nothing of yours to send again, no Retry.
	local resend = not chat or ns.Chats.ResendText(chat, entry) ~= nil
	local what = { -- [UX-W02] Retry, the one resend label; the risk to name is a second charge
		retry = resend and "Retry sends your message again." or nil,
		send_again = resend and "It may have reached your AI company before the connection dropped. Retry sends it again." or nil,
		desktop = (chat and resend) and "Once it's fixed in the app, Retry sends your message again." or nil,
		none = "Okay puts it away; it stays in the chat.",
	}
	lines[#lines + 1] = what[entry.action] or "Okay puts it away; it stays in the chat."
	return table.concat(lines, "\n")
end

-- Which error bubbles show their details (not saved).
ui.errOpen = setmetatable({}, { __mode = "k" })
function U.ToggleErrorDetails(entry)
	ui.errOpen[entry] = not ui.errOpen[entry] or nil
	local chat = ns.Chats.Active()
	if chat then R.rev[chat.id] = (R.rev[chat.id] or 0) + 1 end
	ns.Refresh()
end

-- Under an error the bridge says what to do about (cap ekind, UX-2): its
-- details when open, the app's line, then Retry, Okay and Show Details.
-- Okay puts the buttons away. Returns the y under them.
local function ErrorParts(b, chat, entry, y, width)
	b.errEntry = (entry.err and entry.action ~= nil) and entry or nil
	local n = 0
	if entry.err and entry.action and ui.errOpen[entry] then
		b.details:ClearAllPoints()
		b.details:SetPoint("TOPLEFT", b, "TOPLEFT", BUBBLE_X, -(y + 8))
		b.details:SetWidth(width - 2 * BUBBLE_X)
		ApplyTextSize(b.details, "GameFontDisable")
		b.details:SetText(U.ErrorDetails(entry, chat))
		b.details:Show()
		local dh = b.details:GetStringHeight()
		if not dh or dh < 1 then dh = 12 end
		y = y + 8 + dh
	else
		b.details:Hide()
	end
	if entry.err and entry.action and not entry.okay then
		-- The app once: the line only when the error's own words don't name it (the
		-- bridge's name "the NeverQuestAlone app"; an older one's, "on your desktop"). [UX-W21]
		local says = tostring(entry.text or "")
		if entry.action == "desktop" and not (says:find("NeverQuestAlone app", 1, true) or says:lower():find("on your desktop", 1, true)) then
			b.hint:ClearAllPoints()
			b.hint:SetPoint("TOPLEFT", b, "TOPLEFT", BUBBLE_X, -(y + 8))
			b.hint:SetWidth(width - 2 * BUBBLE_X)
			ApplyTextSize(b.hint, "GameFontNormal")
			b.hint:SetText("Fix it in the NeverQuestAlone app.") -- [UX-W21]
			b.hint:Show()
			local hh = b.hint:GetStringHeight()
			if not hh or hh < 1 then hh = 12 end
			y = y + 8 + hh
		else
			b.hint:Hide()
		end
		-- [UX-W21, UX-W02] The fix first (§5): Retry for every resend (after a
		-- fix in the app too, so the message needn't be typed twice), then Okay,
		-- then the disclosure, Show Details or Hide Details.
		local acts = {}
		if (entry.action == "retry" or entry.action == "send_again" or entry.action == "desktop") and ns.Chats.ResendText(chat, entry) then
			acts[#acts + 1] = { "Retry", function() ns.Chats.ResendError(chat, entry) end, { 0.95, 0.9, 0.8 } }
		end
		acts[#acts + 1] = { "Okay", function() ns.Chats.OkayError(chat, entry) end, { 1, 0.82, 0 } }
		acts[#acts + 1] = { ui.errOpen[entry] and "Hide Details" or "Show Details", function() U.ToggleErrorDetails(entry) end, { 0.7, 0.7, 0.7 } }
		for i, a in ipairs(acts) do
			local c = b.acts[i]
			if not c then
				c = MakeChip(b, CHIP_H)
				c:SetScript("OnLeave", HideTip)
				b.acts[i] = c
			end
			c.label:SetText(a[1])
			c.label:SetTextColor(a[3][1], a[3][2], a[3][3])
			c:SetScript("OnClick", a[2])
			c:SetScript("OnEnter", nil)
			c:Show()
			n = i
		end
	else
		b.hint:Hide()
	end
	for i = n + 1, #b.acts do b.acts[i]:Hide() end
	if n > 0 then y = y + 8 + FlowChips(b.acts, b, BUBBLE_X, y + 8, width - 2 * BUBBLE_X, CHIP_H, 6) end
	return y
end

-- "0.4¢" ("~0.4¢" when it's the app's estimate): a reply's cost, alone. [UX-W19] no tokens (§10)
function U.CostText(u)
	if type(u) ~= "table" then return "" end
	return (u.exact == false and "~" or "") .. ns.Cents(u.micros)
end

-- opts: chips (a list of sends to show under it), chatId (where they go).
local function PlaceBubble(n, chat, entry, y, width, opts)
	local b = ui.bubbles[n] or MakeBubble(n)
	local event = entry.event and entry.role == "user"
	-- [C-10] An error in its kind's colour (main's red without a kind).
	local color = event and EVENT_COLOR or (entry.err and select(2, U.ErrorLook(entry))) or ROLE_COLOR[entry.role] or ROLE_COLOR.system
	b:SetWidth(width)
	b.bg:SetColorTexture(color[1], color[2], color[3], event and 0.08 or 0.06)
	b.accent:SetColorTexture(color[1], color[2], color[3], 0.8)
	-- A game event: its kind's icon, "Sent by the game", the summary in gold.
	b.icon:SetShown(event)
	if event then b.icon:SetTexture(EVENT_ICON[entry.event] or EVENT_ICON.route_done) end
	b.who:ClearAllPoints()
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", event and 34 or BUBBLE_X, -BUBBLE_Y)
	b.who:SetText(WhoLabel(chat, entry))
	b.who:SetTextColor(color[1], color[2], color[3])
	b.when:SetText(ns.db.settings.times ~= false and entry.t and ns.ClockText(entry.t) or "") -- none with Message Times off
	-- The TL;DR strip, then the reply (without its TL;DR line at the end).
	local top = BODY_TOP
	local tldr = Tldr(entry)
	local body = BodyText(entry)
	if tldr and body ~= "" then
		b.tldr:ClearAllPoints()
		b.tldr:SetPoint("TOPLEFT", b, "TOPLEFT", BUBBLE_X, -top)
		b.tldr:SetWidth(width - 2 * BUBBLE_X)
		ApplyTextSize(b.tldr)
		b.tldr:SetText("|cffffd100TL;DR|r  " .. tldr)
		b.tldr:Show()
		local th = b.tldr:GetStringHeight()
		if not th or th < 1 then th = 14 end
		top = top + th + 8
	else
		b.tldr:Hide()
	end
	b.body:ClearAllPoints()
	b.body:SetPoint("TOPLEFT", b, "TOPLEFT", event and 34 or BUBBLE_X, -top)
	b.body:SetWidth(width - (event and 34 or BUBBLE_X) - BUBBLE_X)
	ApplyTextSize(b.body)
	b.body:SetText(body)
	if event then b.body:SetTextColor(1, 0.82, 0) else b.body:SetTextColor(0.93, 0.93, 0.93) end
	local h = b.body:GetStringHeight()
	if not h or h < 1 then h = 14 end
	local extra = ErrorParts(b, chat, entry, top + h, width) -- [UX-2] top + h without an action
	if entry.role == "assistant" and entry.refs then
		local ph = LayoutPills(b, entry, extra + 8, width)
		if ph > 0 then extra = extra + 8 + ph end
	else
		LayoutPills(b, {}, 0, width)
	end
	local ch = LayoutChips(b, opts and opts.chips, opts and opts.chatId, extra + 8, width)
	if ch > 0 then extra = extra + 8 + ch end
	-- [UX-3] Its cost, when the bridge reported it and you asked to see it (Settings, /bones cost).
	if entry.role == "assistant" and entry.usage and ns.db.settings.replyCost then
		b.cost:ClearAllPoints()
		b.cost:SetPoint("TOPLEFT", b, "TOPLEFT", BUBBLE_X, -(extra + 6))
		ApplyTextSize(b.cost, "GameFontDisable")
		b.cost:SetText(U.CostText(entry.usage))
		b.cost:Show()
		local ch2 = b.cost:GetStringHeight()
		if not ch2 or ch2 < 1 then ch2 = 12 end
		extra = extra + 6 + ch2
	elseif b.cost:IsShown() then
		b.cost:Hide()
	end
	b:SetHeight(extra + BUBBLE_Y)
	b:ClearAllPoints()
	b:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
	b.entry = entry.role and entry.text and not entry.starter and entry or nil
	b:Show()
	return y + b:GetHeight() + BUBBLE_GAP
end

-- Bones in a word, for what he's doing (HUD.lua shows it; the plain title
-- stays in its tooltip and in the window). [UX-5] There are two things
-- to do: write, or think.
function U.Voice(title)
	local t = tostring(title or ""):lower()
	return (t:find("writ", 1, true) or t:find("text", 1, true)) and "Writing…" or "Thinking…"
end

-- The working bubble's line: "Working · 7 actions · 42 s (usually 20 s) · <title>".
function U.WorkingText(chat)
	local p = ns.Chats.Progress(chat)
	if p.paste then return "Waiting for your AI" end
	if not p.acked then
		if ns.Transport.StripOut() then
			-- [DR-07] Stuck: not read yet, or (after a Reload) didn't go through.
			local w = ns.Transport.StuckWords()
			if w and w.action == "discard" then return w.short end
			if w then return ns.Fill("Sending · {duration} · not read yet", { duration = ns.FmtDur(GetTime() - (p.sentAt or GetTime())) }) end
			return "Sending · " .. ns.FmtDur(GetTime() - (p.sentAt or GetTime()))
		end
		return "Waiting for a reload to go out"
	end
	local parts = { p.stopping and "Stopping" or "Working" }
	if p.actions > 0 then parts[#parts + 1] = p.actions .. (p.actions == 1 and " action" or " actions") end
	local typical = ns.Chats.TypicalRunTime()
	parts[#parts + 1] = ns.FmtDur(p.elapsed) .. (typical and (" (usually " .. ns.FmtDur(typical) .. ")") or "")
	if p.title then parts[#parts + 1] = p.title end
	return table.concat(parts, " · ")
end

-- The newest assistant entry's index, if nothing you sent came after it (its
-- chips are the suggested replies still worth a click).
local function ChipsIndex(chat)
	for i = #chat.history, 1, -1 do
		local e = chat.history[i]
		if e.role == "assistant" then return e.chips and i or nil end
		if e.role == "user" then return nil end
	end
end

-- Where to scroll after a redraw: nil keeps the place.
--   "newest": the start of the newest entry when it's taller than the pane, else the bottom
--   "bottom": the bottom
--   nil with keepAt: that offset (the place you were reading, after a redraw)
function U.ScrollTo(mode, keepAt)
	local sf = ui.scroll
	if not sf or (not mode and not keepAt) then return end
	-- The latest decision wins, and one still waiting for its frame counts as
	-- where you are (a render right after "land on the newest" follows it).
	ui.scrollGen = (ui.scrollGen or 0) + 1
	local gen = ui.scrollGen
	ui.pendingScroll = mode or "keep"
	C_Timer.After(0, function()
		if gen ~= ui.scrollGen then return end
		ui.pendingScroll = nil
		local range = sf:GetVerticalScrollRange() or 0
		local v = range
		if not mode then
			v = math.min(range, math.max(0, keepAt))
		elseif mode == "newest" and ui.newestTop and ui.newestHeight and ui.newestHeight > (sf:GetHeight() or 0) then
			v = math.min(range, math.max(0, ui.newestTop - 4))
		end
		sf:SetVerticalScroll(v)
		if ui.newPill and range - v <= STICK_SLACK then ui.newPill:Hide() end
	end)
end

function U.AtBottom()
	local sf = ui.scroll
	if not sf then return true end
	return (sf:GetVerticalScrollRange() or 0) - (sf:GetVerticalScroll() or 0) <= STICK_SLACK
end

-- A command's answer (Chats.Notice): after the conversation, with an X, never saved.
-- [ingame-clarity] A help list (Commands.lua: "/command  what it does", the command in gold) with a
-- line the notice can't hold on one: every command on a line of its own and its words under it,
-- wrapped here so each of their lines keeps the indent, so the gold commands stay a column in a narrow
-- window (it opens narrower now) and at any text size. Worked out once for a text, width and size.
local HELP_LINE, HELP_INDENT = "^(|cffffd100/.-|r)  (.+)$", "    "
local helpFit, helpWidths, helpWidthsSize = {}, {}, nil -- the size apart from the widths: "size" is a word too (C-10)
local function FitHelp(body, text, width)
	if not text:find("|cffffd100/", 1, true) then return text end
	local size = tostring(select(2, ns.Try(body.GetFont, body)) or body.fontSize or "")
	local key = text .. "\0" .. math.floor(width) .. "\0" .. size
	if helpFit.key == key then return helpFit.out end
	-- Each piece measured once at a size, so a grip dragged with the list open only adds them up
	-- (the critic's round 2: some 340 SetText calls a new width).
	if helpWidthsSize ~= size then helpWidths, helpWidthsSize = {}, size end
	local function Width(str)
		local w = helpWidths[str]
		if not w then
			body:SetText(str)
			w = ns.Try(body.GetUnboundedStringWidth, body) or ns.Try(body.GetStringWidth, body) or 0
			helpWidths[str] = w
		end
		return w
	end
	local lines, wide = {}, false
	for line in (text .. "\n"):gmatch("(.-)\n") do
		lines[#lines + 1] = line
		if not wide and line:match(HELP_LINE) then wide = Width(line) > width end
	end
	local out = text
	if wide then
		-- Two units to spare: the sum of a line's pieces can run a hair under the line as drawn.
		local limit, space = width - 2, Width("x x") - Width("xx")
		for i, line in ipairs(lines) do
			local cmd, what = line:match(HELP_LINE)
			if cmd then
				local under, cur, curW = {}, nil, 0
				for word in what:gmatch("%S+") do
					local ww = Width(word)
					if cur and curW + space + ww > limit then
						under[#under + 1] = cur
						cur, curW = nil, 0
					end
					if cur then
						cur, curW = cur .. " " .. word, curW + space + ww
					else
						cur, curW = HELP_INDENT .. word, Width(HELP_INDENT .. "x") - Width("x") + ww
					end
				end
				under[#under + 1] = cur
				lines[i] = cmd .. "\n" .. table.concat(under, "\n")
			end
		end
		out = table.concat(lines, "\n")
	end
	helpFit.key, helpFit.out = key, out
	return out
end

local function PlaceNotice(chat, y, width)
	local note = R.notices[chat.id]
	local f = ui.notice
	if not note or not f then
		if f then f:Hide() end
		return y
	end
	f:SetWidth(width)
	f.body:SetWidth(width - 44)
	ApplyTextSize(f.body)
	f.body:SetText(FitHelp(f.body, note.text, width - 44))
	local h = f.body:GetStringHeight()
	if not h or h < 1 then h = 14 end
	f:SetHeight(BODY_TOP + h + BUBBLE_Y)
	f:ClearAllPoints()
	f:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
	f.chatId, f.text = chat.id, note.text
	f:Show()
	ui.noteTop, ui.noteHeight = y, f:GetHeight()
	return y + f:GetHeight() + BUBBLE_GAP
end

-- reason "all": the window opened or the chat changed hands; land on the newest.
function U.RenderTranscript(reason)
	local chat = ns.Chats.Active()
	if not chat or not ui.content then return end
	local width = ui.scroll:GetWidth()
	if not width or width < 80 then width = 400 end
	ui.content:SetWidth(width)
	local wasAtBottom = U.AtBottom() or ui.pendingScroll == "newest" or ui.pendingScroll == "bottom"
	local sameChat = ui.renderedChat == chat.id
	-- A new entry is a new newest entry (the history is capped at 200, so the
	-- count can stay the same).
	local newest = chat.history[#chat.history]
	local grew = sameChat and newest ~= nil and newest ~= ui.renderedNewest
	-- Reading further up: remember the entry at the top of the pane and how far
	-- into it you are, so the redraw puts you back there even when older entries
	-- fall out above (the 100-bubble window, the 200-entry history).
	local anchor, anchorDelta
	if sameChat and not wasAtBottom and ui.entryTops then
		local cur, best = ui.scroll:GetVerticalScroll() or 0, nil
		for e, top in pairs(ui.entryTops) do
			if top + (ui.entryHeights[e] or 0) > cur and (not best or top < best) then best, anchor = top, e end
		end
		if anchor then anchorDelta = cur - best end
	end
	ui.entryTops, ui.entryHeights = setmetatable({}, { __mode = "k" }), setmetatable({}, { __mode = "k" })
	local chipsAt = ChipsIndex(chat)
	local y, n = 0, 0
	ui.newestTop, ui.newestHeight = nil, nil
	for i = math.max(1, #chat.history - MAX_BUBBLES + 1), #chat.history do
		n = n + 1
		local top = y
		local e = chat.history[i]
		y = PlaceBubble(n, chat, e, y, width, i == chipsAt and { chips = e.chips, chatId = chat.id } or nil)
		ui.entryTops[e], ui.entryHeights[e] = top, y - top - BUBBLE_GAP
		if i == #chat.history then ui.newestTop, ui.newestHeight = top, y - top - BUBBLE_GAP end
	end
	local busy = ns.Chats.IsBusy(chat)
	ui.renderedStarter = nil -- [UX-8] the checklist this draw shows, if any (StarterStale)
	if #chat.history == 0 and not busy then
		-- With no app yet, how asking works comes first (Copy and Paste, Paste.lua).
		if ns.Paste and ns.Paste.On() then
			n = n + 1
			y = PlaceBubble(n, chat, { role = "system", starter = true, text = ns.Paste.Named(ns.Paste.STARTER) }, y, width)
		end
		n = n + 1
		-- [UX-8] Until everything works, an empty chat shows the setup checklist
		-- in main's starter bubble; [C-137] never with no app yet and Copy and Paste on
		-- (Ask works, and the checklist can't be finished without the app).
		local check = U.StarterCheck()
		if check and not check.done then
			y = PlaceBubble(n, chat, { role = "system", starter = true, text = check.text }, y, width, { chips = check.chips, chatId = chat.id })
		else
			y = PlaceBubble(n, chat, { role = "system", starter = true, text = "Shift-click an item, spell or quest to link it into your message. Click the portrait for Settings and key bindings." }, y, width)
		end
		ui.renderedStarter = check and check.key or nil
	end
	for i = n + 1, #ui.bubbles do
		ui.bubbles[i]:Hide()
	end
	local noteKey = R.notices[chat.id]
	y = PlaceNotice(chat, y, width)
	if busy then
		ui.work:ClearAllPoints()
		ui.work:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
		ui.work:SetWidth(width)
		ui.work.text:SetText(U.WorkingText(chat))
		U.WorkButton() -- [DR-07] its button: Stop, Paste Reply, or the stuck send's one action
		ui.work:Show()
		y = y + WORK_H + BUBBLE_GAP
	else
		ui.work:Hide()
	end
	ui.content:SetHeight(math.max(y, 1))
	-- Where to land: a chat opened or switched shows its newest entry from the
	-- start; a new entry while you follow along does the same; a new entry while
	-- you're reading further up leaves you there, with a "New reply" pill.
	local mode
	local newNote = noteKey ~= nil and noteKey ~= ui.renderedNote
	-- A new notice (a command's answer) lands on its start when it's taller
	-- than the pane (/bones help all), and a redraw before that lands keeps it.
	if newNote or (noteKey ~= nil and ui.landNote == noteKey and ui.pendingScroll == "newest") then
		ui.newestTop, ui.newestHeight, ui.landNote = ui.noteTop, ui.noteHeight, noteKey
		mode = "newest"
	elseif reason == "all" or not sameChat then
		mode = "newest"
	elseif grew then
		if wasAtBottom or (newest.role == "user" and not newest.event) then
			mode = "newest"
		elseif ui.newPill then
			ui.newPill:Show()
		end
	elseif newNote or wasAtBottom then
		mode = "bottom"
	end
	if mode and ui.newPill then ui.newPill:Hide() end
	local keepAt = (not mode and anchor and ui.entryTops[anchor]) and (ui.entryTops[anchor] + anchorDelta) or nil
	ui.renderedChat, ui.renderedRev, ui.renderedBusy, ui.renderedNewest, ui.renderedNote = chat.id, R.rev[chat.id], busy, newest, noteKey
	U.ScrollTo(mode, keepAt)
end

---------------------------------------------------------------------------
-- [UX-8, UX-3] The setup checklist (PRD §16.1 and OB-4): what works so far, from the
-- slots. Everything is set up in the desktop app; the game shows the state,
-- and a copy box for anything to type. Nothing here asks for a key.
---------------------------------------------------------------------------

local function Mark(done)
	local atlas = done and "UI-LFG-ReadyMark" or "UI-LFG-PendingMark" -- the ready check's marks (Mainline ReadyCheck.lua)
	if type(C_Texture) == "table" and ns.Try(C_Texture.GetAtlasExists, atlas) then
		if type(CreateAtlasMarkup) == "function" then
			local ok, m = pcall(CreateAtlasMarkup, atlas, 14, 14)
			if ok and type(m) == "string" then return m end
		end
		return "|A:" .. atlas .. ":14:14|a"
	end
	return done and (ns.GREEN_HEX .. "Done:|r") or "|cff9d9d9dTo do:|r"
end

U.Mark = Mark -- [G1] the HUD's setup rows use the same marks

-- [G1] The three setup rows the HUD's setup block and the window's
-- checklist share (onboarding spec §3.10 G1): the app, the AI, the game read
-- (STYLE §1's order and words; [UX-W01, CF-UX-04]).
-- Each one line of 40 characters at most; while the first seconds after login
-- say nothing yet (the light waits, no word from the app), "Looking for" and
-- "Checking", never a to-do the player can't act on.
--   { rows = { text, ... }, ok = { bool, ... }, done = n, ready = bool, slow = bool, key = string }
-- [DR-09] The published states the row names (the contract's, bridge/transport/capture-health.mjs):
-- a key not here names nothing ("minimized" and "unknown" are gone, SY-20). A Mac's corner can't be
-- covered, so its no_signal words are neutral; Screen Recording is named only when macOS took it away.
local SETUP_CAPTURE = {
	no_permission = "Allow Screen Recording on your Mac.", no_signal = "Keep the top of WoW's window on screen.",
	no_signal_mac = "The app can't see WoW: see why there.", blocked = "Close what blocks screen reading.",
	damaged = "Reinstall the NeverQuestAlone app.", unsupported = "Type /nqa mode reload for this screen.",
}
function U.SetupRows()
	local p = ns.Provider() or {} -- none yet: a fresh install before the app has answered
	local T, rt = ns.Transport, ns.RT()
	local alive = T.BridgeAlive()
	local unknown = not alive and T.Light() == "wait"
	local rows, ok = {}, {}
	-- The app. "The app" in the rows under it: this one names it (STYLE §2.1). [UX-W01]
	rows[1] = alive and "The NeverQuestAlone app is running." or (unknown and "Looking for the NeverQuestAlone app…" or "Open the NeverQuestAlone app.") -- [C-131]
	ok[1] = alive
	-- The AI.
	local Co, M, st, ks = ns.ProviderOwnName(), ns.ModelName(), rt and rt.state, p.keyState
	local t = { company = Co or "your AI", Company = Co or "Your AI", model = M }
	ok[2] = (ks == "ok" or p.auth == "local") and alive and not (st == "no_key" or st == "key_invalid" or st == "out_of_credit" or st == "local_down")
	if ok[2] then
		rows[2] = M and ns.Fill("Connected to {model}.", t) or "Your AI is connected."
		if #rows[2] > 40 then rows[2] = "Your AI is connected." end
	elseif unknown then
		rows[2] = "Checking your AI…"
	elseif st == "key_invalid" or ks == "invalid" then
		rows[2] = Co and ns.Fill("Replace your {company} key in the app.", t) or "Replace your key in the app."
	elseif st == "out_of_credit" then
		rows[2] = ns.Fill("{Company} needs credit: open the app.", t)
	elseif ks == "expired" then
		rows[2] = ns.Fill("Sign in to {company} again in the app.", t)
	elseif st == "local_down" then
		rows[2] = ns.Fill("Start {company} on your computer.", t)
	elseif Co and p.auth == "key" then
		rows[2] = ns.Fill("Add your {company} key in the app.", t)
	else
		rows[2] = "Connect your AI in the app."
	end
	-- 40 characters at most (the English cap): a long provider's name gives way.
	if #rows[2] > 40 then rows[2] = ok[2] and "Your AI is connected." or ((st == "key_invalid" or ks == "invalid") and "Replace your key in the app.") or "Your AI needs you: open the app." end
	-- [DR-09] The game read: the bridge's capture state when it sends one (cap
	-- capture), else (an older bridge) the hello drawn on the strip or a message acked
	-- while messages go out on it (the reload path proves nothing). A cause shows once
	-- it has held 8 s on screen (a restart's quick heal never does); a message stuck on
	-- the strip means it can't see now, whatever it could before (no latch, D-28); a
	-- state the addon doesn't know, or none yet, is "checking", never a guess.
	local capture = T.CaptureState()
	local cause = T.CaptureCause()
	local mac = type(IsMacClient) == "function" and IsMacClient()
	local sees = (R.hello ~= nil and R.hello.confirmed ~= nil and not R.hello.viaOutbox) or ((R.acks.slot or 0) > 0 and T.StripOut())
	if capture == "off" then
		ok[3], rows[3] = true, "Screen reading is off."
	elseif cause then
		local k = (cause == "no_permission" and not mac) and "no_signal" or cause -- (Windows has no such permission)
		ok[3], rows[3] = false, (mac and SETUP_CAPTURE[k .. "_mac"]) or SETUP_CAPTURE[k]
	elseif (capture == "ok" or (capture == nil and sees)) and not T.StuckSend() then
		ok[3], rows[3] = true, "The app can see WoW."
	else
		ok[3], rows[3] = false, "Checking the app can see WoW…"
	end
	local done = (ok[1] and 1 or 0) + (ok[2] and 1 or 0) + (ok[3] and 1 or 0)
	local slow = T.SlotOnly() and T.StripOut() and R.sig.static == "sound-off" -- (stream and reload modes ring no doorbells)
	return { rows = rows, ok = ok, done = done, ready = done == 3, slow = slow,
		key = table.concat(rows, "|") .. (slow and "s" or "") .. (T.StripOut() and "" or "o") } -- [ingame-clarity] the HUD's line under Say Hi follows it
end

-- [UX-8, G3] The window's setup checklist in main's starter bubble:
-- { rows, text, chips, done, key }; the addon, the HUD's three rows, a first
-- reply (a fresh install before the app has answered too).
function U.Checklist()
	local setup = U.SetupRows()
	if not setup then return nil end
	local T = ns.Transport
	local rows, keys, chips = {}, {}, {}
	local function Row(done, text)
		rows[#rows + 1] = Mark(done) .. " " .. text
		keys[#keys + 1] = done and "1" or "0"
	end
	Row(true, ns.Fill("The addon is loaded ({version}).", { version = ns.VERSION }))
	for i = 1, 3 do Row(setup.ok[i], setup.rows[i]) end
	local first = ns.db.firstReply == true
	-- The one ask is a click: the Say hi chip sends "hi" (UX-8, the maintainer's one-click
	-- rule), offered once it can work: the three rows done (C-26).
	Row(first, first and ns.P("NeverQuestAlone answered.") or (setup.ready and "Say hi: click Say Hi, or type hi below." or "Say hi once the steps above are done.")) -- [UX-W01]
	if not first and setup.ready then chips[#chips + 1] = { label = "Say Hi", send = "hi", intro = true } end
	local slow = T.SlotOnly() and T.StripOut() and R.sig.static ~= nil -- as T.SlowMode: never in stream or reload mode
	if slow then
		rows[#rows + 1] = table.concat({ "|cffffd100", R.sig.static == "sound-off" -- [UX-W03] no slow mode, no signals
			and "Replies are slow with game sound off: keep Enable Sound on in WoW's sound settings (the volume can be 0)."
			or "Replies come a little slower for now. A /reload usually fixes it.", "|r" })
	end
	local text = table.concat({ "Setting up NeverQuestAlone:", table.concat(rows, "\n") }, "\n") -- [UX-W01] the product's setup
	return { rows = rows, text = text, chips = #chips > 0 and chips or nil,
		done = setup.ready and first, key = table.concat(keys) .. (slow and "s" or "") .. setup.key }
end

-- The checklist an empty chat shows: none with no app yet and Copy and Paste on [C-137].
function U.StarterCheck()
	if ns.HUD and ns.HUD.PasteWelcome and ns.HUD.PasteWelcome() then return nil end
	return U.Checklist()
end

-- The empty chat's checklist is out of date (a slot changed a row).
function U.StarterStale(chat)
	if #chat.history > 0 or ns.Chats.IsBusy(chat) then return false end
	local check = U.StarterCheck()
	return (check and check.key or nil) ~= ui.renderedStarter
end

-- /bones setup: the same rows as lines.
function U.ChecklistLines()
	local check = U.Checklist()
	if not check then return { "Setup: " .. ns.Product() .. " doesn't report it." } end
	local lines = { "Setting up NeverQuestAlone:" } -- [UX-W01]
	for _, r in ipairs(check.rows) do lines[#lines + 1] = r end
	if check.done then lines[#lines + 1] = "All set." end
	return lines
end

---------------------------------------------------------------------------
-- Usage (UX-3, PRD §9.5): a line in the window's header, a small panel on a
-- click, /bones usage. Money is whole micro-dollars; "~" marks an estimate.
---------------------------------------------------------------------------

-- "$0.18 today", "$0.18 of $1.00 today" (only with a daily limit the player
-- set: usage.capMicros), "$0.18 today · key $4.12 left", "Free: 12 of 50
-- today", "Local · Ollama" (the header beside it names the model; without the
-- model cap, "Local · Ollama qwen3:8b"); nil without the usage cap. Coloured
-- when spend needs you (usage.needs).
local NEEDS_COLOR = { near_cap = "|cffffd100", slowed = "|cffffd100", cap = "|cffff5555", out_of_credit = "|cffff5555", key_invalid = "|cffff5555" }
-- short: the window is narrower than 480 (it opens at 420): the line's first part, so the chat's
-- name keeps its room; the rest is in the usage panel, a click on the line away. [ingame-clarity]
function U.UsageLine(short)
	local u, p = ns.Usage(), ns.Provider()
	if not u then return nil end
	local text
	local freeLimit = tonumber(u.freeLimit)
	-- [UX-W20] The desktop's words (format.js usageLine), whole, with named places (§12).
	if p and (p.auth == "local" or p.privacy == "local") then
		local t = { app = ns.ProviderName(), model = not short and not ns.HasCap("model") and ns.ModelName() or nil }
		text = t.model and ns.Fill("On this computer · {app} · {model}", t) or ns.Fill("On this computer · {app}", t)
	elseif freeLimit and freeLimit > 0 then
		text = ns.Fill("Free: {used} of {limit} requests today", { used = ns.Int(u.freeUsed), limit = ns.Int(freeLimit) })
	elseif u.held == "load_error" then -- [BR-09, UX-W05] today's spend couldn't be read: no "~$", no "of $cap"
		text = "Today's spend unknown"
	else
		local t = { spent = (u.exact == false and "~" or "") .. ns.Dollars(u.spentMicros) }
		if tonumber(u.keyLeftMicros) and not short then
			t.left = ns.Dollars(u.keyLeftMicros)
			text = ns.Fill("{spent} today · {left} left on your key", t)
		elseif tonumber(u.capMicros) then -- present: the player set a limit ($0 is one: free models only)
			t.limit = ns.Dollars(u.capMicros)
			text = ns.Fill("{spent} of {limit} today", t)
		else
			text = ns.Fill("{spent} today", t)
		end
	end
	-- Near or at a limit only with one: the player's own (capMicros) or a provider's free tier.
	local needs = u.needs
	if (needs == "near_cap" or needs == "cap") and not tonumber(u.capMicros) and not (freeLimit and freeLimit > 0) then needs = nil end
	local color = NEEDS_COLOR[needs]
	return color and (color .. text .. "|r") or text
end

-- Seconds until local midnight, when the client can say.
local function UntilMidnight()
	local ok, t = pcall(date, "*t")
	if not ok or type(t) ~= "table" or not tonumber(t.hour) then return nil end
	return 86400 - (t.hour * 3600 + t.min * 60 + t.sec)
end

-- The newest reply that says what it cost, in any chat.
local function LastUsage()
	local best
	for _, c in ipairs(ns.db.chats) do
		for i = #c.history, 1, -1 do
			local e = c.history[i]
			if e.role == "assistant" and e.usage then
				if not best or (e.t or 0) > (best.t or 0) then best = e end
				break
			end
		end
	end
	return best and best.usage or nil
end

-- The panel's lines (and /bones usage's): the provider and model, today's
-- spend and messages, the companion's remarks, the rate limit, and the last
-- reply. The public build has no limits of its own: today's figures are
-- information, and a limit shows only when the player set one (usage.capMicros,
-- with when it resets) or a provider has one (a free tier, a key's balance).
-- Display-ready.
function U.UsageLines()
	local u, p = ns.Usage(), ns.Provider()
	if not u then return { "Usage: " .. ns.Product() .. " doesn't report it." } end
	local lines = {}
	local M = ns.ModelName()
	local effort = M and p and p.effortSupported ~= false and ns.Str(p.effort, 12) -- no model, no effort to honour
	-- [UX-W19, UX-W20] Thinking, the player's word; whole lines with named places (§12).
	local t = { AI = ns.ProviderName(true), model = M, Level = effort and ns.Escape(ns.ThinkLabel(effort) or (effort:sub(1, 1):upper() .. effort:sub(2))) or nil, company = ns.ProviderOwnName() }
	lines[#lines + 1] = (effort and ns.Fill("{AI} · {model} · Thinking: {Level}", t)) or (M and ns.Fill("{AI} · {model}", t)) or t.AI
	local parts = {}
	local freeLimit = tonumber(u.freeLimit)
	if freeLimit and freeLimit > 0 then
		parts[#parts + 1] = ns.Fill("{used} of {limit} free requests", { used = ns.Int(u.freeUsed), limit = ns.Int(freeLimit) })
	end
	local cap = tonumber(u.capMicros) -- nil: no limit set; $0 is one
	parts[#parts + 1] = (u.exact == false and "~" or "") .. ns.Dollars(u.spentMicros) .. (cap and (" of " .. ns.Dollars(cap)) or "")
	if u.held == "load_error" then parts[#parts] = "spend unknown" end -- [BR-09, UX-W05] couldn't be read: no "~$", no "of $cap"
	parts[#parts + 1] = ns.Int(u.turns) .. (tonumber(u.turns) == 1 and " message" or " messages")
	lines[#lines + 1] = "Today: " .. table.concat(parts, " · ")
	-- The companion's remarks today (usage.auto: game events and recaps), as
	-- information; off on the desktop, said so.
	local auto = tonumber(u.auto)
	if u.autoPaused == true then -- the runaway fuse holds [UX-W04] check-ins
		lines[#lines + 1] = "Check-ins: paused after a burst of them; your next message turns them back on"
	elseif u.autoOn ~= true then
		lines[#lines + 1] = "Check-ins: off in the NeverQuestAlone app"
	elseif auto then
		lines[#lines + 1] = ns.Fill("Check-ins: {n} today", { n = ns.Int(auto) })
	end
	if tonumber(u.keyLeftMicros) then
		t.amount = ns.Dollars(u.keyLeftMicros)
		lines[#lines + 1] = t.company and ns.Fill("Left on your {company} key: {amount}", t) or ns.Fill("Left on your key: {amount}", t)
	end
	-- A daily limit the player set resets at local midnight (the bridge's day);
	-- a provider's free limit on its own clock, said only when the bridge says when.
	if cap then
		local reset = UntilMidnight()
		lines[#lines + 1] = reset and ns.Fill("Your daily spend limit resets at midnight, in {duration}.", { duration = ns.DurWords(math.floor(reset / 60) * 60) })
			or "Your daily spend limit resets at midnight."
	end
	local free = freeLimit and freeLimit > 0
	local at = free and ns.Transport.FreeResetAt()
	if at then lines[#lines + 1] = ns.Fill("Free requests reset at {time}.", { time = at }) end
	local rt = ns.RT()
	if rt and rt.state == "slowed" then -- (not slowed: nothing to say)
		local n = ns.Transport.RetryIn()
		t.duration = (n and n > 0) and ns.DurWords(n) or nil
		lines[#lines + 1] = t.duration and ns.Fill(ns.P("{AI} asked NeverQuestAlone to slow down: trying again in {duration}."), t) or ns.Fill(ns.P("{AI} asked NeverQuestAlone to slow down."), t)
	end
	local last = LastUsage()
	if last then lines[#lines + 1] = ns.Fill("Last reply: {cost}", { cost = U.CostText(last) }) end
	if u.exact == false then lines[#lines + 1] = "~ means an estimate from NeverQuestAlone's price list." end
	return lines
end

function U.RenderUsagePanel()
	local panel = ui.usagePanel
	if not panel or not panel:IsShown() then return end
	if ns.Usage() then
		panel.body:SetText(table.concat(U.UsageLines(), "\n"))
		local bh = panel.body:GetStringHeight()
		if not bh or bh < 1 then bh = 60 end
		panel:SetHeight(12 + 16 + 6 + bh + 10 + 22 + 10)
	else
		panel:Hide() -- the bridge stopped reporting it
	end
end

-- The usage line's click: the panel opens under it, in the tooltip's dress and
-- main's type; Okay (or a second click, or Esc) closes it. Made the first time.
function U.ToggleUsage()
	if ui.usagePanel and ui.usagePanel:IsShown() then
		ui.usagePanel:Hide()
		return
	end
	if ui.usage and ns.Usage() then
		if not ui.usagePanel then
			local panel, tpl = Create("Frame", "NQAUsage", ui.frame, { "TooltipBackdropTemplate", "BackdropTemplate" })
			if tpl ~= "TooltipBackdropTemplate" then Backdrop(panel, "tooltip", 0.05, 0.05, 0.05, 0.95) end
			panel:SetWidth(300)
			panel:SetFrameStrata("DIALOG")
			panel:EnableMouse(true)
			panel.title = panel:CreateFontString(nil, "OVERLAY", "GameFontNormal")
			panel.title:SetPoint("TOPLEFT", panel, "TOPLEFT", 12, -12)
			panel.title:SetText("Usage Today")
			panel.body = panel:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
			panel.body:SetPoint("TOPLEFT", panel.title, "BOTTOMLEFT", 0, -6)
			panel.body:SetWidth(276)
			panel.body:SetJustifyH("LEFT")
			panel.body:SetJustifyV("TOP")
			panel.body:SetWordWrap(true)
			panel.okay = Button(panel, "Okay", 72, function() panel:Hide() end)
			panel.okay:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -10, 10)
			if type(UISpecialFrames) == "table" then tinsert(UISpecialFrames, "NQAUsage") end
			ui.usagePanel = panel
		end
		ui.usagePanel:ClearAllPoints()
		ui.usagePanel:SetPoint("TOPRIGHT", ui.usage, "BOTTOMRIGHT", 4, -4)
		ui.usagePanel:Show()
		U.RenderUsagePanel()
	end
end

-- [UX-4, C-11]
-- The chat's model as shown: its own (confirmed) or the provider's; nil when
-- there's none yet. Display-ready.
function U.ChatModelName(chat)
	local p = ns.Provider()
	local snap = chat and R.snap and R.snap[chat.id]
	local own = chat and ns.Str(chat.model, 80)
	if own and not (p and own == p.model) then
		local named = snap and snap.model == own and ns.Str(snap.modelName, 60)
		return ns.Escape(named or own)
	end
	return ns.ModelName()
end

-- No effort to set in this chat (UX-4): the model has no control, or there's
-- no model yet. A chat's own model is judged by the snapshot's word for it.
function U.NoEffort(chat)
	if not ns.HasCap("model") then return true end -- before the app answers: no model yet
	local p = ns.Provider()
	if not p then return false end
	chat = chat or ns.Chats.Active()
	local own = chat and ns.Str(chat.model, 80)
	if own and own ~= p.model then
		local snap = R.snap and R.snap[chat.id]
		return snap ~= nil and snap.model == own and snap.effortSupported == false
	end
	if not ns.ModelName() then return true end
	return p.effortSupported == false
end

-- The effort the bridge will use in this chat: its word for the chat, else the provider's.
function U.ChatEffort(chat)
	local snap = chat and R.snap and R.snap[chat.id]
	local p = ns.Provider()
	return (snap and ns.Str(snap.effort, 12)) or (p and ns.Str(p.effort, 12)) or nil
end

-- The thinking levels of the model this chat uses, cheapest first: the
-- snapshot's for the chat (its own model's when it has one), else the
-- provider's; Low, Medium and High from an app that doesn't list them.
function U.ChatEfforts(chat)
	local snap = chat and R.snap and R.snap[chat.id]
	local p = ns.Provider()
	local own = chat and ns.Str(chat.model, 80)
	local list
	if own and not (p and own == p.model) then
		list = snap and snap.model == own and ns.ThinkLevelList(snap.efforts)
	else
		list = (snap and ns.ThinkLevelList(snap.efforts)) or (p and ns.ThinkLevelList(p.efforts))
	end
	return list or { "low", "medium", "high" }
end

-- The status line's details, where one line can't say it all (a click on the
-- line puts them in the chat as a notice): the way back first.
local STATUS_TIPS = {
	stream = { title = "No Screen Reading", text = "Nothing is drawn on your screen, so your messages wait for a reload, and replies still come in. Click Reload above the window when a message waits.",
		note = "Screen Reading, in Settings, turns it back on." },
	reload = { title = "No Screen Reading", text = "Nothing is drawn on your screen, so your messages and replies wait for a reload. Type /reload, or click Reload above the window when a message waits.",
		note = "Screen Reading, in Settings, turns it back on." },
	-- Off in the desktop app (its Your data page): turned back on there.
	app = { title = "No Screen Reading", text = "Nothing is drawn on your screen, so your messages wait for a reload, and replies still come in. Click Reload above the window when a message waits.",
		note = "Screen reading, on the NeverQuestAlone app's Your data page, turns it back on." },
	-- Off here and in the app: both switches have to go back on.
	streamBoth = { title = "No Screen Reading", text = "Nothing is drawn on your screen, so your messages wait for a reload, and replies still come in. Click Reload above the window when a message waits.",
		note = "Turn it back on in Settings and on the NeverQuestAlone app's Your data page." },
	reloadBoth = { title = "No Screen Reading", text = "Nothing is drawn on your screen, so your messages and replies wait for a reload. Type /reload, or click Reload above the window when a message waits.",
		note = "Turn it back on in Settings and on the NeverQuestAlone app's Your data page." },
}

-- The status line under the header: what needs attention, else Ready. A
-- second value is its details, where the line has more to say.
local function StateText() -- [C-16] U.StatusText adds the header's note
	local T = ns.Transport
	if R.protoMismatch then -- [UX-W03] no protocol in the player's words; the app updates the addon
		return "|cffff5555This addon can't read what the NeverQuestAlone app sends. Update the app; it updates the addon too.|r"
	elseif R.reloadFallback then
		return "|cffffd100Reload to keep going: messages and replies wait until you do.|r"
	elseif R.slots.broken then
		return "|cffffd100Replies can't load right now: they arrive when you reload.|r"
	end
	-- [UX-1] The backend's own state, in the provider's words (nil without rt).
	local words = T.BridgeAlive() and T.RTWords() or nil
	if words and words.head then
		return (words.red and "|cffff5555" or "|cffffd100") .. words.head .. "." .. (words.sub ~= "" and (" " .. words.sub) or "") .. "|r"
	end
	-- [UX-1] The app silent for 2 min (a fresh install before it runs, too).
	local light, tip = T.Light()
	if light == "red" then return "|cffff5555" .. (tip:match("^[^\n]*") or "") .. "|r" end
	local depth = T.OutboxDepth()
	if depth > 0 and not T.StripOut() then
		return ns.Plural(depth, "|cffffd1001 message waits for a reload to go out.|r", "|cffffd100{n} messages wait for a reload to go out.|r")
	end
	-- [DR-07] A message stuck on the strip (15 s on screen,
	-- unread; slot-only too, once a load proves it), or one a Reload didn't deliver, in
	-- one line; the banner above has its words and its one button.
	do
		local w = T.StuckWords()
		if w then return "|cffffd100" .. w.line .. "|r" end
	end
	-- (In slot-only mode acks only come with slot loads, so a wait says nothing.)
	if #R.dndQueue > 0 then return ns.Plural(#R.dndQueue, "1 reply waits until the fight ends.", "{n} replies wait until the fight ends.") end
	-- [C-05] Slow mode in the player's words, only when the signals failed:
	-- with no screen reading (or stream mode) it's slot-only by design, and says so below.
	local slow, how = T.SlowMode()
	if slow then return slow .. "." .. (how ~= "" and (" " .. how) or "") end
	-- The transport only speaks up when it's worth knowing (the old footer's facts).
	if T.SlotsIn() and R.slots.free <= T.LOW_SLOTS then
		return ns.Plural(R.slots.free, "|cffffd100Reload soon: 1 more reply fits before the next reload.|r", "|cffffd100Reload soon: {n} more replies fit before the next reload.|r")
	end
	local appOff = ns.Transport.DesktopReadingOff()
	if ns.db.settings.mode == "reload" then return "No screen reading: your messages and replies wait for a reload.", appOff and STATUS_TIPS.reloadBoth or STATUS_TIPS.reload end
	if ns.db.settings.stream then return "No screen reading: your messages wait for a reload, and replies still come in.", appOff and STATUS_TIPS.streamBoth or STATUS_TIPS.stream end
	if appOff then return "No screen reading: your messages wait for a reload, and replies still come in.", STATUS_TIPS.app end
	-- On here again, while the app still reads nothing (it stopped for the off): it starts at the next reload.
	if ns.R.toldOff and not T.StripOut() then return "Screen reading starts at your next reload: until then, your messages wait for it." end
	return ""
end

-- [C-16] The status line, and after it what the header had no room for
-- ("Effort high from your next message.", U.FitHeader; the public build's).
function U.StatusText()
	local text, tip = StateText()
	local note = ui.headerNote
	if not note then return text, tip end
	if text == "" then return "|cff9d9d9d" .. note .. "|r", tip end
	return text .. " |cff9d9d9d" .. note .. "|r", tip
end

-- [UX-4, C-16] The header stops short of the Game data label: a long model
-- name is cut ("Claude Sonn… · high": the effort stays), on one line; when the
-- whole of it doesn't fit, its grey "(from your next message)" goes to the
-- status line instead, as a sentence (ui.headerNote).
function U.FitHeader(chat)
	ui.headerNote = nil
	local h, c = ui.header, ui.ctx
	if not (h and c and chat) then return end
	local function Natural()
		return (type(h.GetUnboundedStringWidth) == "function" and h:GetUnboundedStringWidth()) or h:GetStringWidth() or 0
	end
	local textW = (type(c.text.GetUnboundedStringWidth) == "function" and c.text:GetUnboundedStringWidth()) or c.text:GetStringWidth() or 0
	local arrow = ui.thinkArrow:IsShown() and (3 + (ui.thinkArrow:GetWidth() or 12)) or 0
	local avail = (c:GetWidth() or 0) - ((c.toggle:GetWidth() or 24) - 3 + 2) - textW - (8 + 4) - arrow
	local natural = Natural()
	if avail > 0 and natural > avail then
		local base, note, say, name, suffix = U.HeaderParts(chat)
		if note then
			h:SetText(base)
			ui.headerNote = say
			natural = Natural()
		end
		-- Still too long: the model's name gives way, the effort stays.
		if natural > avail and name and suffix and suffix ~= "" then
			for k = #name - 1, 4, -1 do
				local cut = ns.Utf8Cut(name, k)
				if #cut == k then
					h:SetText(ns.Trim(cut) .. "…" .. suffix)
					natural = Natural()
					if natural <= avail then break end
				end
			end
		end
	end
	if avail > 0 then h:SetWidth(math.max(40, math.floor(math.min(math.ceil(natural) + 1, avail)))) end
end

-- A thinking level as a label: "Low", "Extra High".
local function Level(l) l = tostring(l or ""); return ns.Escape(ns.ThinkLabel(l) or (l:sub(1, 1):upper() .. l:sub(2))) end
-- [UX-4, C-11, C-16] The window's header: the chat's model and its
-- effort, "Haiku 4.5 · low", in main's Thinking control. A level you just
-- picked shows at once, and says it starts with your next message.
-- base: the header's words; note: what's asked but not yet in effect, as the
-- header's grey "(…)"; say: the same as a sentence, for the status line when
-- the header has no room for it; model and suffix: base in two (the model's
-- name, and " · low"), so a cut shortens the name and keeps the effort.
function U.HeaderParts(chat)
	local model = U.ChatModelName(chat)
	local notes, says = {}, {}
	if chat.modelAsked then -- [UX-W10] whole sentences with named places (§12)
		local t = { model = chat.modelAsked == "default" and "the default model" or ns.Escape(chat.modelAsked) }
		notes[#notes + 1] = ns.Fill("asked for {model}", t)
		says[#says + 1] = chat.modelAsked == "default" and "The default model from your next message." or ns.Fill("Model {model} from your next message.", t)
	end
	local name, suffix = model or "No model yet", ""
	if model and not U.NoEffort(chat) then
		local level = U.ChatEffort(chat)
		-- [UX-W19, CF-UX-16] Thinking, the player's word, and a level as a label ("· Low")
		if chat.think and chat.think ~= level then
			suffix = " · " .. Level(chat.think)
			notes[#notes + 1] = #notes > 0 and "thinking from your next message" or "from your next message"
			says[#says + 1] = ns.Fill("Thinking: {Level}, from your next message.", { Level = Level(chat.think) })
		elseif level then
			suffix = " · " .. Level(level)
		end
	end
	return name .. suffix, #notes > 0 and table.concat(notes, "; ") or nil, #says > 0 and table.concat(says, " ") or nil, name, suffix
end

function U.HeaderText(chat) -- [UX-4] the model and its effort
	local base, note = U.HeaderParts(chat)
	return note and (base .. " |cff9d9d9d(" .. note .. ")|r") or base
end

-- The app's supported model choices. Older apps omit this optional list.
function U.ModelChoices()
	local p, out, seen = ns.Provider(), {}, {}
	if not ns.HasCap("model") or not p or type(p.models) ~= "table" then return out end
	for i = 1, math.min(#p.models, 24) do
		local m = p.models[i]
		local id = type(m) == "table" and m.id
		if type(id) == "string" and #id <= 80 and id:match("^[%w%._:/%-]+$") and not ns.Chats.KeyShaped(id) and not seen[id] then
			seen[id] = true
			out[#out + 1] = { id = id, label = ns.Escape(ns.Str(m.label, 60) or id) }
		end
	end
	return out
end

function U.ModelMenu(anchor, choices)
	local items = {}
	local function Add(label, id)
		items[#items + 1] = { label, function() if ns.HandleCommand then ns.HandleCommand("model " .. id) end end }
	end
	Add("Default (" .. (ns.ModelName() or "App") .. ")", "default")
	for _, m in ipairs(choices) do Add(m.label, m.id) end
	if not U.NoEffort(ns.Chats.Active()) then
		items[#items + 1] = { "Thinking...", function() U.ThinkMenu(anchor, true) end }
	end
	U.PopupMenu(anchor, "Model for This Chat", items)
end

function U.ThinkMenu(anchor, thinkingOnly)
	local choices = U.ModelChoices()
	if not thinkingOnly and #choices > 0 then return U.ModelMenu(anchor, choices) end
	local function Set(level)
		if ns.HandleCommand then ns.HandleCommand("think " .. level) end
	end
	local chat = ns.Chats.Active()
	local levels = U.ChatEfforts(chat)
	-- Each level's tooltip says what it trades.
	local tips = {
		off = "Answers without thinking first: the quickest, and costs the least.",
		minimal = "Thinks for a moment before it answers.",
		low = "Thinks a little. Plenty for most questions.",
		medium = "Balances speed and depth.",
		high = "Slower, and goes deeper.",
		xhigh = "Slower still, for hard questions.",
		max = "Thinks as long as it needs: the slowest, and costs the most.",
	}
	if type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local ok = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
			local function Tip(b, title, text)
				if type(b) == "table" and type(b.SetTooltip) == "function" then
					b:SetTooltip(function(tip) ns.TipLines(tip, { title = title, text = text }) end)
				end
			end
			local model = ns.HasCap("model") and U.ChatModelName(chat) -- [C-11] [UX-W19] Thinking, the player's word
			root:CreateTitle(ns.HasCap("model") and (model and ns.Fill("Thinking for {model}", { model = model }) or "Thinking for This Model") or "Thinking")
			for _, l in ipairs(levels) do
				local label = ns.ThinkLabel(l) or l
				Tip(root:CreateButton(label, function() Set(l) end), label, tips[l] or "")
			end
			local p = ns.Provider() -- [C-11] the provider's default level, named
			local level = p and ns.Str(p.effort, 12)
			Tip(root:CreateButton(level and ns.Fill("Default ({Level})", { Level = Level(level) }) or "Default", function() Set("default") end), -- [C-05, UX-W07]
				"Default", ns.P("The level NeverQuestAlone uses when you don't pick one."))
		end)
		if ok then return end
	end
	-- No menu here: each click moves to the next level, then back to the default.
	local order = {}
	for i, l in ipairs(levels) do order[l] = levels[i + 1] or "default" end
	Set(order[chat and chat.think or ""] or levels[1])
end

-- Game data's tick: on; off for what you send from this box until you tick it
-- again (each such message says so); or off for good (/bones context off),
-- greyed out.
function U.RenderContext()
	local c = ui.ctx
	if not c then return end
	local toggle = c.toggle
	if not ns.db.settings.context then
		-- Off for good: the tick greyed out, and how to turn it back on.
		Call(toggle, "SetChecked", false)
		Call(toggle, "Disable")
		c.text:SetText("|cff9d9d9dGame Data: Off|r")
		c.detail, c.actions, c.lines = "Off in every chat: NeverQuestAlone sees only your words.", nil, nil
		c.note = string.format("%s, in Settings, turns it back on.", ns.Settings.LABELS.context)
		return
	end
	Call(toggle, "Enable")
	local parts = {}
	local zone = ns.Try(GetRealZoneText) or ns.Try(GetZoneText)
	local sub = ns.Try(GetSubZoneText)
	if type(zone) == "string" and zone ~= "" then
		parts[#parts + 1] = ns.Escape(zone) .. ((type(sub) == "string" and sub ~= "" and sub ~= zone) and (", " .. ns.Escape(sub)) or "")
	end
	local level = ns.Try(UnitLevel, "player")
	if type(level) == "number" and level > 0 then parts[#parts + 1] = "level " .. ns.Int(level) end
	-- Every quest Bones gets (ns.QuestLog), those with no id yet too.
	local _, qm = ns.QuestLog()
	local quests = qm.count + qm.unread
	if quests > 0 then parts[#parts + 1] = ns.Int(quests) .. (quests == 1 and " quest" or " quests") end
	-- [QL-F-14] the gear goes with a message only while the app's companion switch is on (PRIVACY.md)
	if not (ns.Companion and ns.Companion.Call("DesktopOn") == false) then parts[#parts + 1] = "gear" end
	local what = table.concat(parts, " · ")
	c.text:SetText("Game Data")
	c.note = string.format("%s, in Settings, turns it off in every chat.", ns.Settings.LABELS.context)
	if R.skipGameData then
		Call(toggle, "SetChecked", false)
		c.detail, c.lines = "Left out of what you send from here; each of those messages says \"no game data\".", { what }
		c.actions = { "Click to send it again" }
	else
		Call(toggle, "SetChecked", true)
		c.detail, c.lines = "Sent with your messages, so NeverQuestAlone knows what you know.", { what } -- [C-14, UX-W07]
		c.actions = { "Click to leave it out" }
	end
end

function U.RenderHint()
	if not ui.hint or not ui.input then return end
	ui.hint:SetShown((ui.input:GetText() or "") == "" and not ui.input:HasFocus())
end

-- [UX-3] The usage line's button: today's spend (against a daily limit
-- only when the player set one), at the right of the title row, in main's grey;
-- a click opens a small panel with the rest.
local function UsageButton()
	local usage = CreateFrame("Button", nil, ui.frame)
	usage:SetHeight(16)
	usage:SetWidth(120)
	usage:SetPoint("RIGHT", ui.hrEdge, "LEFT", 0, 0)
	usage.label = usage:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	usage.label:SetPoint("RIGHT", usage, "RIGHT", 0, 0)
	usage.label:SetJustifyH("RIGHT")
	usage.label:SetWordWrap(false)
	local uhl = usage:CreateTexture(nil, "HIGHLIGHT")
	uhl:SetAllPoints()
	uhl:SetTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight")
	uhl:SetBlendMode("ADD")
	usage:SetScript("OnClick", function() U.ToggleUsage() end)
	usage:SetScript("OnEnter", function(self)
		if ns.Usage() then ShowTip(self, { title = "Usage Today", text = "Shows your model, today's spend and messages, and what the last reply cost.", actions = { "Click for the details" } }) end -- [UX-W05]
	end)
	usage:SetScript("OnLeave", HideTip)
	usage:Hide()
	ui.usage = usage
	return usage
end

function U.RenderStatus()
	U.RenderListButton()
	local T = ns.Transport
	local chat = ns.Chats.Active()
	local state, tip = T.Light()
	for _, l in ipairs({ ui.light, ui.miniLight }) do
		if l then
			if l.state ~= state then l.icon:SetTexture(LIGHT[state] or LIGHT.wait) end -- [code health AD-18] its art on a change
			l.state, l.tip = state, tip
		end
	end
	-- [code health AD-18] The window's header, status line and buttons only while it shows:
	-- the 2-second tick redrew them, hidden, for no one. Opening it renders them (U.Toggle).
	if U.IsOpen() then U.RenderWindowStatus(chat) end
	U.RenderMini(state)
	U.RenderBanner()
	DropShownToasts()
	if ns.HUD then ns.HUD.Render() end
end

-- The window's part of the status: its title, header, chat name, usage line, status
-- line, Send or Queue, the working line, the Game Data box and the composer's hint.
function U.RenderWindowStatus(chat)
	local agent = chat and ns.Chats.AgentName(chat.agent) or ns.Name() -- [UX-5]
	local unread = U.UnreadElsewhere()
	if ui.title then ui.title:SetText(agent .. (unread > 0 and ("  " .. ns.GREEN_HEX .. unread .. " new|r") or "")) end
	if ui.header and chat then
		-- Thinking levels are the app's: by Copy and Paste the menu would change nothing.
		local paste = ns.Paste and ns.Paste.On()
		ui.header:SetText(paste and "" or U.HeaderText(chat))
		local menu = not paste and (#U.ModelChoices() > 0 or not U.NoEffort(chat))
		ui.thinkArrow:SetShown(menu)
		ui.thinkBtn:SetShown(menu)
	end
	if ui.chatName and chat then ui.chatName:SetText(ns.Escape(chat.name or "")) end
	-- Without a model list or effort control, the header takes the arrow's place.
	local alone = #U.ModelChoices() == 0 and U.NoEffort(chat)
	if ui.thinkBtn and alone ~= (ui.headerAlone == true) then
		ui.headerAlone = alone
		ui.header:ClearAllPoints()
		if alone then ui.header:SetPoint("RIGHT", ui.ctx, "RIGHT", 0, 0) else ui.header:SetPoint("RIGHT", ui.thinkArrow, "LEFT", -3, 0) end
	end
	-- [UX-3] The usage line, with a bridge that reports it (made the first
	-- time it has something to say); the chat's name stops short of it while it
	-- shows, re-anchored only when that changes.
	local line = U.UsageLine((ui.frame and ui.frame:GetWidth() or 0) < 480)
	if ns.Usage() and line and ui.frame then
		local u = ui.usage or UsageButton()
		u.label:SetText(line)
		u:SetWidth(math.floor((u.label:GetStringWidth() or 100) + 8))
		if not u:IsShown() then
			u:Show()
			ui.chatName:SetPoint("RIGHT", u, "LEFT", -8, 0)
		end
		U.RenderUsagePanel()
	elseif ui.usage and ui.usage:IsShown() and not ns.Usage() then
		ui.usage:Hide()
		ui.chatName:SetPoint("RIGHT", ui.hrEdge, "LEFT", 0, 0)
		if ui.usagePanel then ui.usagePanel:Hide() end
	end
	if chat then U.FitHeader(chat) end -- [UX-4] the public build's header, fitted
	if ui.status then
		local text, tip = U.StatusText()
		ui.status:SetWidth(math.max(40, math.floor((ui.frame:GetWidth() or 0) - ui.L.headerX - EDGE)))
		ui.status:SetText(text)
		-- Two lines of its 10-point type are about 24 tall; one, 12.
		U.PlaceHeader(text ~= "", text ~= "" and (ns.Try(ui.status.GetStringHeight, ui.status) or 0) > 18)
		-- The line is a button only while it has more to say.
		if ui.statusHit then ui.statusHit.tip = tip; ui.statusHit:SetShown(tip ~= nil) end
	end
	-- Queue while Bones works on this chat; a message waiting for a pasted reply
	-- holds nothing up (Copy and Paste, Paste.lua).
	local queues = chat and ns.Chats.IsBusy(chat) and not (ns.Paste and ns.Paste.Waiting(chat))
	if ui.send then ui.send:SetText(queues and "Queue" or "Send") end
	if ui.work and ui.work:IsShown() and chat then
		ui.work.text:SetText(U.WorkingText(chat))
		U.WorkButton() -- [DR-07]
	end
	U.RenderContext()
	U.RenderHint()
	U.RenderHintText() -- [UX-5] in the companion's name, as it comes
end

-- [UX-5, PUI-22] The composer's hint, main's words in the companion's name.
function U.RenderHintText()
	if ui.hint then ui.hint:SetText(ns.P("Ask anything (Up Arrow brings back what you sent)")) end
end

-- With the HUD off (not closed), the bar stands in whenever the window isn't
-- open, so something of Bones is always on screen. A closed HUD's route bar
-- keeps its slot under it, the window open or not (HUD.lua, C-92, C-93).
function U.MiniStandsIn()
	return not U.HUDActive() and not ns.db.settings.miniHidden
end
function U.MiniWanted()
	return not U.IsOpen() and U.MiniStandsIn()
end
function U.MiniFrame() return ui.mini end

-- light: the light's state, when the caller has it (RenderStatus).
function U.RenderMini(light)
	if not ui.miniBadge then return end
	local want = U.MiniWanted() and true or false
	if ui.mini:IsShown() ~= want then ui.mini:SetShown(want) end
	local unread, working = 0, 0
	for _, c in ipairs(ns.db.chats) do
		unread = unread + c.unread
		if ns.Chats.IsBusy(c) then working = working + 1 end
	end
	local parts = {}
	if unread > 0 then parts[#parts + 1] = ns.GREEN_HEX .. unread .. " new|r" end
	if working > 0 then parts[#parts + 1] = "|cffffd100" .. working .. " working|r" end
	if R.reloadFallback then
		parts[#parts + 1] = "|cffff5555Reload now|r"
	elseif R.slots.free <= ns.Transport.LOW_SLOTS then
		parts[#parts + 1] = "|cffffd100Reload soon|r"
	end
	-- [C-15] The light's state in a few words, first, whenever it isn't
	-- green: never "idle" while the key is rejected (the provider's words).
	local T = ns.Transport
	local w = T.BridgeAlive() and T.RTWords() or nil
	light = light or T.Light() -- [code health AD-18] once, not twice
	if w and w.badge and (light == "red" or light == "yellow" or light == "grey") then
		table.insert(parts, 1, (light == "red" and "|cffff5555" or light == "yellow" and "|cffffd100" or "|cff9d9d9d") .. w.badge .. "|r")
	elseif light == "red" then
		table.insert(parts, 1, "|cffff5555No word from the app|r") -- [UX-W07] a status, in sentence case
	end
	if #parts == 0 then parts[1] = "|cff999999Idle|r" end
	-- [code health AD-18] Its words only when they change.
	local label, badge = ns.Chats.AgentName(ns.DEFAULT_AGENT), table.concat(parts, "  ")
	if label ~= ui.miniLabelText then ui.miniLabelText = label; ui.miniLabel:SetText(label) end
	if badge ~= ui.miniBadgeText then ui.miniBadgeText = badge; ui.miniBadge:SetText(badge) end
	ui.miniUnread = unread
end

-- [DR-07] The working line's button: Stop, or while a message is stuck its one action
-- (its text changes; it doesn't move).
function U.WorkButton()
	local w = ui.work
	if not w then return end
	local s = ns.Transport.StuckWords()
	w.stuck = s and s.action or nil
	local chat = ns.Chats.Active()
	w.stop:SetText(w.stuck and (w.stuck == "discard" and "Discard" or "Reload")
		or (chat and ns.Chats.Progress(chat).paste and "Paste Reply") or "Stop")
end

-- [DR-07] The stuck send's one action, from the banner, the window's working line or the HUD's row: Discard drops
-- what a Reload didn't deliver; anything else is the Reload (the click is the hardware event).
function U.StuckAct(action)
	if action == "discard" then return ns.Transport.Discard() end
	return ns.Reload()
end

function U.BannerText()
	local T = ns.Transport
	if R.reloadFallback then
		return "Reload to keep going: messages and replies wait until you do."
	end
	local depth = T.OutboxDepth()
	if depth > 0 and not T.StripOut() then
		return ns.Plural(depth, "1 message waits for a reload to go out.", "{n} messages wait for a reload to go out.")
	end
	-- [DR-07] A message stuck on the strip: what's wrong and its one action
	-- (Reload sends it; after a Reload that didn't, Discard drops it).
	local w = T.StuckWords()
	if w then return w.text, w.action end
	if T.SlotsIn() and R.slots.free <= T.LOW_SLOTS then
		return ns.Plural(R.slots.free, "Reload soon: 1 more reply fits before the next reload.", "Reload soon: {n} more replies fit before the next reload.")
	end
end

function U.RenderBanner()
	local b = ui.banner
	if not b then return end
	local text, action = U.BannerText() -- [DR-07] action: the stuck send's (Reload or Discard)
	local anchor
	local hud = ns.HUD and ns.HUD.Frame and ns.HUD.Frame()
	if U.IsOpen() then
		anchor = "window"
	elseif ui.mini and ui.mini:IsShown() then
		anchor = "mini"
	elseif hud and hud:IsShown() then
		anchor = "hud"
	end
	-- [DR-07] The HUD's row, or the window's working line, has the stuck send's button
	-- itself: no second one beside it.
	local shownThere = action and ((anchor == "hud" and ns.HUD.StuckShown and ns.HUD.StuckShown())
		or (anchor == "window" and ui.work and ui.work:IsShown() and ui.work.stuck ~= nil))
	if not text or ns.InCombat() or not anchor or shownThere then
		if b.key then b:Hide(); b.key = nil end -- [code health AD-18] a hide only when it showed
		return
	end
	-- [code health AD-18] Shown with the same words, button and place: nothing to redo.
	local key = table.concat({ text, tostring(action), anchor }, "\30")
	if key == b.key and b:IsShown() then return end
	b.key = key
	b.action = action
	b.reload:SetText(action == "discard" and "Discard" or "Reload")
	b.text:SetText(text)
	b:ClearAllPoints()
	if anchor == "window" then
		b:SetPoint("BOTTOM", ui.frame, "TOP", 0, 2)
	elseif anchor == "hud" then
		b:SetPoint("TOPRIGHT", hud, "BOTTOMRIGHT", 0, -4)
	else
		b:SetPoint("TOP", ui.mini, "BOTTOM", 0, -2)
	end
	b:Show()
end

-- what: "status" for the light, header, badges and banner (every tick);
-- anything else redraws the chat list and, if it changed, the transcript.
-- [code health AD-05] Those two only while the window shows: hidden, a reply drew the
-- list and its 100 bubbles for no one. Opening it renders everything (U.Toggle: "all").
function U.Render(what)
	if not ui.frame or not ns.db then return end
	if what ~= "status" and U.IsOpen() then
		U.RenderList()
		local chat = ns.Chats.Active()
		if chat and (what == "all" or ui.renderedChat ~= chat.id or ui.renderedRev ~= R.rev[chat.id] or ui.renderedBusy ~= ns.Chats.IsBusy(chat)
			or U.StarterStale(chat)) then -- [UX-8] the checklist's rows changed
			U.RenderTranscript(what)
		end
	end
	U.RenderStatus()
end

function ns.Refresh(what)
	U.Render(what)
end

NeverQuestAlone.OpenAndType = function() U.OpenAndType() end

---------------------------------------------------------------------------
-- Shift-clicked links go into our box when it has the keyboard (SE-6). On
-- this client every shift-click ends in ChatFrameUtil.InsertLink;
-- ChatEdit_InsertLink is the older name, hooked only where the new one is
-- missing so one click inserts once. Post-hooks only: nothing of Blizzard's
-- chat is replaced, and its edit boxes are never touched (no /cast taint).
---------------------------------------------------------------------------

local function TakeLink(text)
	if type(text) == "string" and text ~= "" and ui.input and ui.input:HasFocus() then
		ui.input:Insert(text)
	end
end

if type(hooksecurefunc) == "function" then
	if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.InsertLink) == "function" then
		hooksecurefunc(ChatFrameUtil, "InsertLink", TakeLink)
	elseif type(ChatEdit_InsertLink) == "function" then
		hooksecurefunc("ChatEdit_InsertLink", TakeLink)
	end
end
