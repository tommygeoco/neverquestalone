import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { sanitizeState } from '../bridge/byok/runtime/sanitize.mjs';
const { newVM, reloadVM } = createRequire(import.meta.url)('./helpers/nqa-vm.js');

const DATA = `
C_Container = {
 GetContainerNumSlots = function(b) return b == 0 and 5 or 0 end,
 GetContainerNumFreeSlots = function(b) return b == 0 and 2 or 0 end,
 GetContainerItemInfo = function(b,s) if s <= 3 then return { itemID = s, stackCount = s * 2 } end end,
 GetContainerItemQuestInfo = function(b,s) return { isQuestItem = s == 1 } end,
}
C_Item.GetItemInfoInstant = function(id) return id, nil, nil, nil, nil, id == 3 and 7 or 0, id == 2 and 5 or 1 end
C_Item.GetItemInfo = function(id) return 'Item' .. id end
C_UnitAuras = { GetAuraDataByIndex = function(u,i,f)
 assert(u == 'player'); if i == 1 then return { spellId = f == 'HELPFUL' and 10 or 11, name = '|cffffffffAura|r', applications = 2, duration = 60, expirationTime = 80, sourceUnit = 'Secret' } end
end }
C_Reputation = {
 GetWatchedFactionData = function() return { factionID = 20, name = 'Watched', reaction = 4, currentStanding = 100, currentReactionThreshold = 0, nextReactionThreshold = 3000 } end,
 GetNumFactions = function() return 2 end,
 GetFactionDataByIndex = function(i) return { factionID = 20 + i, name = 'Faction', reaction = 4, currentStanding = 50, currentReactionThreshold = 0, nextReactionThreshold = 3000 } end,
}
function UnitExists(u) return true end
function UnitIsPlayer(u) return STUB.playerTarget == true end
function UnitPlayerControlled(u) return false end
function UnitName(u) if u == 'target' then STUB.targetNameReads = (STUB.targetNameReads or 0) + 1; return 'NPC' end; return 'Tavi' end
function UnitClassification(u) return 'elite' end
function UnitReaction(u,other) return 3 end
function GetNumGroupMembers() return 2 end
function IsInRaid() return false end
function UnitGroupRolesAssigned(u) return u == 'player' and 'HEALER' or 'TANK' end
`;
const TTS = `
STUB.spoken = {}; STUB.stops = 0
Enum.TtsVoiceType = { Standard = 0 }
C_TTSSettings = { GetVoiceOptionID = function(t) assert(t == 0); return 7 end }
C_VoiceChat = {
 SpeakText = function(...) STUB.spoken[#STUB.spoken+1] = {...} end,
 StopSpeakingText = function() STUB.stops = STUB.stops + 1 end,
 GetTtsVoices = function() return {{voiceID=9}} end,
}
`;
const gather = vm => JSON.parse(vm.evaluate('NS.Companion.Encode(NS.Companion.Gather(), {}, 1, 1)'));
const deliver = (vm, extra='') => vm.run(`NS.Chats.ApplyRecord(NS.Chats.Active(), { t='reply', mid='new', text='Long body must stay silent', summary='<pitch>Brief & useful</pitch>' }, ${extra || 'false'})`);
function liveVM() {
  const vm = newVM().login();
  vm.run(`NS.R.nonce = 'test'; NS.R.bridge = {caps={'state','usage'},usage={autoOn=true}}
   STUB.liveSends = {}; STUB.liveValues = {}; STUB.realQueueState = NS.Companion.QueueState; NS.Companion.QueueState = function() STUB.liveSends[#STUB.liveSends+1] = GetTime(); STUB.liveValues[#STUB.liveValues+1] = STUB.change or 0; return 1 end`);
  return vm;
}

test('T9 gather: bounded bags, player auras, reputation, NPC target and anonymous group', () => {
  const s = gather(newVM({extra:DATA}).login());
  assert.equal(s.bags.free, 2);
  assert.equal(s.bags.slots, 5);
  assert.deepEqual(s.bags.items.map(i=>[i.id,i.count,i.kind]), [[1,2,'quest'],[2,4,'foodDrink'],[3,6,'reagent']]);
  assert.equal(s.auras.length, 2);
  assert.deepEqual(s.auras.map(a=>[a.id,a.kind,a.name]), [[10,'buff','Aura'],[11,'debuff','Aura']]);
  assert.equal(s.rep[0].watched, true);
  assert.equal(s.target.name, 'NPC');
  assert.equal(s.group.size, 2);
  assert.deepEqual(s.group.members.map(m=>m.role), ['HEALER','TANK']);
  assert.ok(!JSON.stringify(s.group).includes('Tavi'));
  assert.ok(!JSON.stringify(s.auras).includes('Secret'));
});

test('T9 auras: seconds left on the session clock, none for a permanent aura, never the raw expirationTime', () => {
  const vm = newVM({extra:DATA}).login();
  vm.run(`STUB.auraNow = GetTime()
   C_UnitAuras.GetAuraDataByIndex = function(u,i,f)
    if f ~= 'HELPFUL' then return nil end
    if i == 1 then return { spellId = 10, name = 'Timed', duration = 600, expirationTime = STUB.auraNow + 90.4 } end
    if i == 2 then return { spellId = 12, name = 'Forever', duration = 0, expirationTime = 0 } end
    if i == 3 then return { spellId = 13, name = 'Gone', duration = 30, expirationTime = STUB.auraNow - 5 } end
   end`);
  const a = gather(vm).auras;
  assert.deepEqual(a.map(x=>[x.id,x.left]), [[10,90],[12,undefined],[13,0]]);
  assert.ok(a.every(x=>!('expires' in x)));
  vm.advance(60);
  assert.equal(gather(vm).auras[0].left, 30, 'left counts down with the game clock');
  const clean = sanitizeState({auras:[{id:10,kind:'buff',left:90,expires:123456},{id:11,kind:'buff',left:-1},{id:12,kind:'buff',left:1.5}]}).auras;
  assert.deepEqual(clean, [{id:10,kind:'buff',left:90},{id:11,kind:'buff'},{id:12,kind:'buff'}]);
});

test('T9 privacy: player target name is never read; no new APIs are read in combat', () => {
  const vm = newVM({extra:DATA}).login();
  vm.run('STUB.playerTarget=true; STUB.targetNameReads=0');
  assert.equal(gather(vm).target, undefined);
  assert.equal(vm.num('STUB.targetNameReads'), 0);
  vm.run('STUB.playerTarget=false; UnitPlayerControlled=nil');
  assert.equal(gather(vm).target,undefined,'unknown control status must stay private');
  assert.equal(vm.num('STUB.targetNameReads'),0);
  vm.run(`STUB.combat=true; C_Container.GetContainerNumSlots=function() error('combat read') end`);
  const s = gather(vm);
  for (const k of ['bags','auras','rep','target','group']) assert.equal(s[k], undefined);
});

test('T9 missing or throwing optional APIs never break gathering', () => {
  const vm = newVM({extra:`C_Container={GetContainerNumSlots=function() error('restricted') end}; C_UnitAuras={GetAuraDataByIndex=function() error('restricted') end}; C_Reputation={GetNumFactions=function() error('restricted') end}`}).login();
  assert.doesNotThrow(()=>gather(vm));
});

test('T9 budget: new sections drop first in a fixed order, quest identities survive', () => {
  const vm = newVM({extra:DATA}).login();
  vm.run(`STUB.g=NS.Companion.Gather(); local O=NS.Companion.JSON.O
   STUB.g.quests={}; for i=1,70 do STUB.g.quests[i]={id=i,complete=false,title=string.rep('q',60),obj={{text=string.rep('o',60),have=0,need=1}}} end
   STUB.fit=NS.Companion.Fit(STUB.g,1,1,{qlog=true,z=false})`);
  const s = JSON.parse(vm.evaluate('STUB.fit'));
  assert.ok(Buffer.byteLength(JSON.stringify(s))<=12000);
  assert.deepEqual(s.omitted.slice(0,5), ['bags','auras','rep','target','group']);
  assert.equal(s.quests.length,70);
  assert.ok(s.quests.every((q,i)=>q.id===i+1));
});

test('T9 sanitizer: typed sections discard forged identities and cap lists, strings and numbers', () => {
  const s = sanitizeState({
    bags:{free:-1,slots:999999,items:Array.from({length:80},()=>({id:1.5,name:'x'.repeat(500),count:-2,kind:'quest'}))},
    auras:Array.from({length:80},()=>({id:10,name:'x'.repeat(500),kind:'buff',count:2,duration:Infinity,sourceUnit:'secret'})),
    rep:Array.from({length:80},()=>({id:1,name:'Faction',value:3.5,watched:true})),
    target:{name:'x'.repeat(500),level:3.5,classification:'elite',reaction:99,playerName:'secret'},
    group:{size:100,members:Array.from({length:80},()=>({class:'MAGE',level:4.5,role:'TANK',name:'secret'}))},
  });
  assert.equal(s.bags.free,undefined);
  assert.ok(s.bags.slots<=1000 || s.bags.slots===undefined);
  assert.deepEqual(s.bags.items,[]);
  assert.equal(s.auras.length,32);
  assert.ok(s.auras[0].name.length<=60);
  assert.equal(s.auras[0].sourceUnit,undefined);
  assert.equal(s.auras[0].duration,undefined);
  assert.equal(s.rep.length,6);
  assert.equal(s.rep[0].value,undefined);
  assert.equal(s.target.level,undefined);
  assert.equal(s.target.playerName,undefined);
  assert.equal(s.target.reaction,undefined);
  assert.equal(s.group.members.length,40);
  assert.equal(s.group.members[0].name,undefined);
  assert.equal(s.group.members[0].level,undefined);
});

test('T10 TTS: off by default, only new assistant summaries are spoken with XML stripped', () => {
  const vm = newVM({extra:TTS}).login();
  assert.equal(vm.bool('NQADB.settings.speak'), false);
  deliver(vm); assert.equal(vm.num('#STUB.spoken'),0);
  vm.slash('speak on'); deliver(vm);
  const spoken = vm.json('STUB.spoken');
  assert.equal(spoken.length,1);
  assert.deepEqual(spoken[0],[7,'pitchBrief useful/pitch',0,100,false]);
  deliver(vm,'true'); assert.equal(vm.num('#STUB.spoken'),1);
  vm.run(`NS.Chats.ApplyRecord(NS.Chats.Active(), {t='error',text='No speaking'},false)`);
  vm.send('Player text is not TTS');
  assert.equal(vm.num('#STUB.spoken'),1);
  vm.slash('speak stop'); assert.equal(vm.num('STUB.stops'),1);
  vm.slash('speak off'); deliver(vm); assert.equal(vm.num('#STUB.spoken'),1);
});

test('T7/T10 TTS: replies the realtime voice already spoke (voice = 1) are not read aloud again', () => {
  const vm = newVM({extra:TTS}).login();
  vm.slash('speak on');
  vm.run(`NS.Chats.ApplyRecord(NS.Chats.Active(), { t='reply', mid='voice:1', text='Said by voice', summary='Said by voice', voice=1 }, false)`);
  assert.equal(vm.num('#STUB.spoken'), 0);
  assert.ok(vm.history().some(e => e.role === 'assistant' && e.text === 'Said by voice'), 'the reply still shows in the chat');
  deliver(vm);
  assert.equal(vm.num('#STUB.spoken'), 1, 'a typed reply is still read aloud');
});

test('T10 TTS: fallback voice, capped text, empty summary and missing APIs are safe', () => {
  const vm = newVM({extra:TTS}).login();
  vm.slash('speak on'); vm.run('C_TTSSettings=nil'); deliver(vm);
  assert.equal(vm.num('STUB.spoken[1][1]'),9);
  vm.run(`NS.Companion.SpeakSummary(string.rep('x',2000)); NS.Companion.SpeakSummary('')`);
  assert.ok(vm.num('#STUB.spoken[2][2]')<=300);
  assert.equal(vm.num('#STUB.spoken'),2);
  vm.run('C_VoiceChat=nil');
  assert.doesNotThrow(()=>{deliver(vm);vm.slash('speak stop');vm.slash('speak on');});
  assert.match(vm.chatLines().join(' '),/TTS.*available/);
});

test('T10/T11: account switches survive reload and invalid saved values stay off', () => {
  const vm = newVM({extra:TTS}).login();
  vm.slash('speak on');vm.slash('live on');
  const next = reloadVM(vm,{extra:TTS}).login();
  assert.ok(next.bool('NQADB.settings.speak') && next.bool('NQADB.settings.live'));
  const forged = newVM({db:`NQADB={settings={speak='yes',live=1}}`}).login();
  assert.equal(forged.bool('NQADB.settings.speak'),false);
  assert.equal(forged.bool('NQADB.settings.live'),false);
});

test('T11 live: off by default; leading send, 30-second throttle, latest trailing send', () => {
  const vm=liveVM();
  vm.run('STUB.FireEvent("BAG_UPDATE_DELAYED")');vm.advance(31);
  assert.equal(vm.num('#STUB.liveSends'),0);
  vm.slash('live on');
  const before=vm.num('#STUB.liveSends');
  vm.run('STUB.change=1; STUB.FireEvent("BAG_UPDATE_DELAYED")');vm.advance(5);
  vm.run('STUB.change=2; STUB.FireEvent("QUEST_LOG_UPDATE"); STUB.FireEvent("UNIT_AURA","target")');vm.advance(24.9);
  assert.equal(vm.num('#STUB.liveSends'),before);
  vm.advance(0.2);
  assert.equal(vm.num('#STUB.liveSends'),before+1);
  assert.equal(vm.num('STUB.liveValues[#STUB.liveValues]'),2,'trailing send reads the latest change');
  const times=vm.json('STUB.liveSends');
  assert.ok(times.every((t,i)=>!i || t-times[i-1]>=30));
  vm.advance(31);assert.equal(vm.num('#STUB.liveSends'),before+1);
});

test('T11 live: combat holds changes, regen sends; screen reading and companion gates win', () => {
  const vm=liveVM();
  vm.slash('live on');vm.advance(31);vm.run('STUB.liveSends={}; STUB.combat=true; STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  vm.advance(35);assert.equal(vm.num('#STUB.liveSends'),0);
  vm.run('STUB.combat=false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');vm.advance(2.1);
  assert.equal(vm.num('#STUB.liveSends'),1);
  vm.advance(31);
  vm.run('NQADB.settings.stream=true; STUB.FireEvent("GROUP_ROSTER_UPDATE")');vm.advance(31);
  assert.equal(vm.num('#STUB.liveSends'),1);
  vm.run('NQADB.settings.stream=false; NQADB.companion.on=false; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');vm.advance(31);
  assert.equal(vm.num('#STUB.liveSends'),1);
  vm.slash('live off');vm.run('NQADB.companion.on=true');vm.advance(31);
  assert.equal(vm.num('#STUB.liveSends'),1);
});

test('T11 live: each requested event queues state; unrelated unit auras do not', () => {
  const vm=liveVM(); vm.slash('live on');vm.advance(31);
  vm.run('STUB.liveSends={}; STUB.FireEvent("UNIT_AURA","target")');vm.advance(31);
  assert.equal(vm.num('#STUB.liveSends'),0);
  for(const [evt,arg] of [['QUEST_LOG_UPDATE'],['ZONE_CHANGED_NEW_AREA'],['BAG_UPDATE_DELAYED'],['PLAYER_LEVEL_UP',12],['UNIT_AURA','player'],['PLAYER_TARGET_CHANGED'],['GROUP_ROSTER_UPDATE']]) {
    const n=vm.num('#STUB.liveSends');
    vm.run(`STUB.FireEvent(${JSON.stringify(evt)}${arg===undefined?'':','+JSON.stringify(arg)})`);vm.advance(31);
    assert.ok(vm.num('#STUB.liveSends')>n,evt);
  }
});

test('T12 prompt: new data, comparisons, dungeon uncertainty and price evidence are explicit', () => {
  const p=fs.readFileSync(new URL('../prompts/companion.md',import.meta.url),'utf8');
  for(const key of ['`bags`','`auras`','`rep`','`target`','`group`']) assert.ok(p.includes(key),key);
  assert.match(p,/gear and talents/i);
  assert.match(p,/three key mechanics/i);
  assert.match(p,/never invent prices/i);
  assert.match(p,/ask the player for prices/i);
});


test('T9 gather caps and legacy reputation fallback preserve negative standings', () => {
  const vm = newVM({extra:DATA}).login();
  vm.run(`C_Container.GetContainerNumSlots=function(b) return b==0 and 100 or 0 end
   C_Container.GetContainerItemInfo=function(b,s) return {itemID=s,stackCount=2} end
   C_Container.GetContainerItemQuestInfo=function() return {isQuestItem=true} end
   C_UnitAuras.GetAuraDataByIndex=function(u,i,f) return {spellId=i,name='Aura'} end
   C_Reputation=nil
   function GetWatchedFactionInfo() return 'Watched',2,-6000,-3000,-5500,20 end
   function GetNumFactions() return 100 end
   function GetFactionInfo(i) return 'Faction',nil,4,0,3000,100,false,false,false,false,false,false,false,20+i end
   function GetNumGroupMembers() return 40 end
   function IsInRaid() return true end`);
  const s = gather(vm);
  assert.equal(s.bags.items.length,32); assert.equal(s.bags.partial,true);
  assert.equal(s.auras.length,32); assert.equal(s.rep.length,6);
  assert.equal(s.rep[0].min,-6000); assert.equal(s.rep[0].value,-5500);
  assert.equal(s.group.members.length,40);
  assert.deepEqual(sanitizeState(s.rep),s.rep);
});

test('T9 sanitizer: explicit schemas honor smaller string and depth budgets and are idempotent', () => {
  const state={bags:{free:2,slots:5,items:[{id:1,name:'long item name',count:3,kind:'quest'}]},target:{name:'long NPC name',classification:'elite'}};
  const clean=sanitizeState(state,{max:4});
  assert.equal(clean.target.name,'long'); assert.equal(clean.bags.items[0].name,'long');
  assert.equal(sanitizeState(state,{depth:2}).bags.items,undefined);
  assert.deepEqual(sanitizeState(sanitizeState(state)),sanitizeState(state));
});

test('T11 live: the real QueueState produces a standalone state record without a message', () => {
  const vm=liveVM();
  vm.run(`NS.Companion.QueueState=STUB.realQueueState`);
  vm.slash('live on');
  assert.ok(vm.bool('NS.R.stateRec ~= nil'));
  assert.match(vm.evaluate('NS.R.stateRec.wire'),/state/);
  assert.equal(vm.history().filter(e=>e.role==='user').length,0);
});

// The voice companion's controls (odd/tasks/nqa-voice-controls.md T2, T5, T9, T10, T12).
const VOICE = `STUB.played = {}
PlaySound = function(id) STUB.played[#STUB.played + 1] = id end
SOUNDKIT = SOUNDKIT or {}; SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON = 856`;
function voiceVM(caps = ['state', 'voice']) {
  const vm = newVM({ extra: VOICE }).login();
  vm.run(`NQADB.linked = true; NS.R.nonce = 'ab12'; NS.R.bridge = { caps = ${JSON.stringify(caps).replace('[', '{').replace(/]$/, '}')}, voice = { state = 'muted' } }`);
  return vm;
}

test('voice controls: talk, toggles and personas send a vc record with the time pressed; none without cap voice or for an unknown voice', () => {
  const none = voiceVM(['state']);
  none.slash('voice talk');
  assert.match(none.chatLines().join(' '), /voice support/);
  assert.equal(none.num('(function() local n = 0 for _, o in pairs(NS.R.out) do if o.type == "vc" then n = n + 1 end end return n end)()'), 0);
  const vm = voiceVM();
  vm.slash('voice talk');
  assert.match(vm.chatLines().join(' '), /Getting the microphone ready/);
  vm.run('NS.Companion.VoiceToggleMute()'); // muted → unmute
  vm.slash('voice persona orc-shaman');
  vm.slash('voice persona dragon');
  assert.match(vm.chatLines().join(' '), /No voice called dragon/);
  const wires = vm.json(`(function() local t = {} for _, o in pairs(NS.R.out) do if o.type == 'vc' then t[#t + 1] = o.wire end end table.sort(t) return t end)()`);
  assert.equal(wires.length, 3);
  const all = wires.join('\n');
  assert.match(all, /cmd=talk/);
  assert.match(all, /cmd=unmute/);
  assert.match(all, /cmd=persona;name=orc-shaman/);
  for (const w of wires) assert.match(w, /;at=\d{9,}/, 'each carries the time it was pressed');
  assert.equal(vm.evaluate('NQADB.settings.voicePersona'), 'orc-shaman');
});

test('voice controls: a vc record left from before a reload is not drawn again; the persona choice survives', () => {
  const vm = voiceVM();
  vm.slash('voice pause');
  vm.slash('voice persona troll');
  const next = reloadVM(vm, { extra: VOICE }).login();
  assert.equal(next.num('(function() local n = 0 for _, o in pairs(NS.R.out) do if o.type == "vc" then n = n + 1 end end return n end)()'), 0);
  assert.equal(next.evaluate('NQADB.settings.voicePersona'), 'troll');
  const forged = newVM({ db: `NQADB={settings={voicePersona='x; rm -rf',voiceBar=1,voiceBarX=1/0}}` }).login();
  assert.equal(forged.evaluate('NQADB.settings.voicePersona'), null);
  assert.equal(forged.bool('NQADB.settings.voiceBar'), true);
  assert.equal(forged.evaluate('NQADB.settings.voiceBarX'), null);
});

test('voice controls: after Talk, the first "listening" plays one short UI sound; the bar shows only with cap voice', () => {
  const vm = voiceVM();
  vm.slash('voice talk');
  vm.run(`NS.R.bridge.voice = { state = 'connecting' }; NS.Companion.VoiceHeard()`);
  assert.equal(vm.num('#STUB.played'), 0);
  vm.run(`NS.R.bridge.voice = { state = 'listening', persona = 'orc-shaman' }; NS.Companion.VoiceHeard(); NS.Companion.VoiceHeard()`);
  assert.equal(vm.num('#STUB.played'), 1);
  vm.run('NS.VoiceBar.Refresh()');
  assert.ok(vm.bool('NQAVoiceBar ~= nil and NQAVoiceBar:IsShown()'));
  assert.match(vm.evaluate('NQAVoiceBar.status:GetText()'), /Listening/);
  assert.match(vm.evaluate('NQAVoiceBar.who:GetText()'), /Orc/);
  assert.equal(vm.evaluate('NQAVoiceBar.mute:GetText()'), 'Close mic', 'listening: the mic button closes it');
  assert.equal(vm.evaluate('NQAVoiceBar.read:GetText()'), 'Read: off');
  vm.slash('voice bar off');
  assert.equal(vm.bool('NQAVoiceBar:IsShown()'), false);
  const old = voiceVM(['state']);
  old.run('NS.VoiceBar.Refresh()');
  assert.equal(old.bool('NQAVoiceBar ~= nil and NQAVoiceBar:IsShown()'), false);
});

test('T15: with a long quest log (40 quests, 60-byte titles) the voice\'s inventory fit still keeps bags and named gear, dropping quest titles first (ids stay), in one frame', () => {
  // A quest log of 40 (the companion tests' C_QuestLog stub, cut down).
  const LOG40 = `STUB.log = {}
local function Q(id) for _, q in ipairs(STUB.log) do if q.id == id then return q end end end
C_QuestLog = { GetNumQuestLogEntries = function() return #STUB.log end,
 GetInfo = function(i) local q = STUB.log[i]; if q then return { title = q.title, questID = q.id, level = q.level, isHeader = false } end end,
 IsOnQuest = function(id) return Q(id) ~= nil end, IsComplete = function() return false end, ReadyForTurnIn = function() return false end,
 IsQuestTrivial = function() return false end, IsQuestFlaggedCompleted = function() return false end,
 GetTitleForQuestID = function(id) local q = Q(id); return q and q.title end, GetQuestObjectives = function(id) local q = Q(id); return q and q.objectives or {} end,
 GetQuestsOnMap = function() return {} end }`;
  const vm = newVM({ extra: DATA + LOG40 }).login();
  vm.run(`NQADB.linked = true; NS.R.nonce = 'ab12'; NS.R.bridge = { caps = { 'state', 'evt', 'z', 'qlog', 'voice', 'usage' }, usage = { autoOn = true } }
   math.randomseed(42)
   local function words() local t = {} for k = 1, 60 do t[k] = string.char(97 + math.random(0, 25)) end return table.concat(t) end
   for i = 1, 40 do STUB.log[i] = { id = 2000 + i, title = words(), level = 10, complete = false, trivial = false, objectives = { { text = words(), numFulfilled = 0, numRequired = 1 } } } end
   C_Item.GetItemInfo = function(id) return 'Item' .. id, nil, 2, nil, nil, nil, nil, nil, nil, nil, 5 end
   function GetInventoryItemID(u, slot) if slot <= 16 then return 100 + slot end end`);
  const normal = JSON.parse(vm.evaluate('NS.Companion.Build().json'));
  vm.run('NS.R.statePreferInv = true; STUB.inv = NS.Companion.Build(); NS.R.statePreferInv = nil');
  const inv = JSON.parse(vm.evaluate('STUB.inv.json'));
  assert.ok(normal.omitted.includes('bags'), 'a plain fit leaves bags out with this log');
  assert.ok(inv.bags && Array.isArray(inv.bags.items), 'the inventory fit keeps bags');
  assert.ok(Array.isArray(inv.gear) && inv.gear.some(g => typeof g.name === 'string'), 'and named gear');
  assert.equal(inv.quests.length, 40, 'every quest');
  assert.ok(inv.quests.every(q => Number.isInteger(q.id)), 'each with its id');
  assert.ok(vm.num('#(STUB.inv.packed or STUB.inv.json)') <= 3100, 'one frame');
  assert.notEqual(vm.evaluate('STUB.inv.seq'), String(normal.seq), 'a new seq, so it is sent');
});
