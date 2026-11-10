import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { sanitizeState } from '../bridge/byok/runtime/sanitize.mjs';
const { newVM } = createRequire(import.meta.url)('./helpers/nqa-vm.js');
const DATA = `
STUB.log={{id=748,title='Quest',level=10,objectives={}}}
C_QuestLog={GetNumQuestLogEntries=function() return #STUB.log end,
 GetInfo=function(i) local q=STUB.log[i]; if q then return {questID=q.id,title=q.title,level=q.level} end end}
C_QuestLog.GetSelectedQuest=function() return 748 end
function GetNumQuestLogRewards() return 1 end
function GetNumQuestLogChoices() return 1 end
function GetQuestLogRewardInfo(i) return 'Reward',nil,2,2,true,100 end
function GetQuestLogChoiceInfo(i) return 'Choice',nil,1,3,true,101 end
function GetInventoryItemID(u,s) if s==1 then return 100 end end
function GetInventoryItemDurability(s) if s==1 then return 9,10 elseif s==5 then return 0,20 end end
C_Item=C_Item or {}
C_Item.GetItemInfo=function(id) return 'Item',nil,2,12,8,nil,nil,20,'INVTYPE_HEAD',nil,4321 end
C_Container={GetContainerNumSlots=function(b) return b==0 and 1 or 0 end,
 GetContainerNumFreeSlots=function() return 0 end,
 GetContainerItemInfo=function() return {itemID=100,stackCount=3} end,
 GetContainerItemQuestInfo=function() return {isQuestItem=true} end,
 GetItemCooldown=function(id) assert(id==6948); return GetTime(),90,1 end}
function GetXPExhaustion() return 2500 end
function GetBindLocation() return 'Crossroads' end
function GetNumTalentTabs() return 3 end
function GetTalentTabInfo(i) return 'Tree'..i,nil,i*5 end
`;
const gather = vm => JSON.parse(vm.evaluate('NS.Companion.Encode(NS.Companion.Gather(), {}, 1, 1)'));

test('T18 gathers rewards, sorted durability, cached item metadata, rested, hearth and talent totals', () => {
  const s=gather(newVM({extra:DATA}).login());
  assert.deepEqual(s.rewards,[{id:748,items:[
    {id:100,name:'Reward',quality:2,equipLoc:'INVTYPE_HEAD',ilvl:12,minLevel:8,count:2,choice:false},
    {id:101,name:'Choice',quality:3,equipLoc:'INVTYPE_HEAD',ilvl:12,minLevel:8,count:1,choice:true}]}]);
  assert.deepEqual(s.durability,[{slot:5,pct:0},{slot:1,pct:90}]);
  assert.equal(s.gear[0].quality,2); assert.equal(s.gear[0].sell,4321);
  assert.equal(s.bags.items[0].quality,2); assert.equal(s.bags.items[0].sell,4321);
  assert.equal(s.rested,2500);
  assert.deepEqual(s.hearth,{bind:'Crossroads',left:90});
  assert.deepEqual(s.talents,[1,2,3].map(i=>({tree:i,name:'Tree'+i,points:i*5})));
});

for (const [section,reader] of [['rewards','Rewards({{id=748}})'],['durability','Durability()'],['rested','Rested()'],['hearth','Hearth()'],['talents','Talents()'],['gear','Gear()'],['bags','Bags()']]) {
  test(`T18 ${section}: no API reads in combat; missing and throwing APIs stay optional`,()=>{
    const vm=newVM({extra:DATA}).login();
    const api=`GetNumQuestLogRewards=nil; GetNumQuestLogChoices=nil; GetInventoryItemDurability=nil;
      GetXPExhaustion=nil; GetBindLocation=nil; GetNumTalentTabs=nil; GetInventoryItemID=nil; C_Container=nil; C_Item=nil; GetItemInfo=nil`;
    vm.run(api);
    assert.equal(vm.evaluate(`NS.Companion.${reader}`),null);
    vm.run(DATA+`STUB.reads=0; local function fail() STUB.reads=STUB.reads+1; error('restricted') end
      GetNumQuestLogRewards=fail; GetNumQuestLogChoices=fail; GetInventoryItemDurability=fail;
      GetXPExhaustion=fail; GetBindLocation=fail; GetNumTalentTabs=fail; GetInventoryItemID=fail;
      C_Container.GetContainerNumSlots=fail; C_Container.GetItemCooldown=fail; C_Item.GetItemInfo=fail;
      STUB.combat=true`);
    assert.equal(vm.evaluate(`NS.Companion.${reader}`),null);
    assert.equal(vm.num('STUB.reads'),0);
    vm.run('STUB.combat=false');
    assert.doesNotThrow(()=>vm.evaluate(`NS.Companion.${reader}`));
  });
}

test('T18 rewards: selection is never changed; no selection or a quest outside the log is unknown; six items max',()=>{
  const vm=newVM({extra:DATA}).login();
  vm.run(`SetQuestLogSelection=function() error('selection write') end; C_QuestLog.SetSelectedQuest=SetQuestLogSelection
    GetNumQuestLogRewards=function() return 100 end; GetNumQuestLogChoices=function() return 100 end`);
  assert.equal(gather(vm).rewards[0].items.length,6);
  vm.run('C_QuestLog.GetSelectedQuest=function() return 999 end');
  assert.equal(gather(vm).rewards,undefined);
  vm.run('C_QuestLog.GetSelectedQuest=nil');
  assert.equal(gather(vm).rewards,undefined);
  vm.run(`C_QuestLog.GetSelectedQuest=function() return 748 end; STUB.q={}
    for i=1,20 do STUB.q[i]={id=i} end; STUB.q[21]={id=748}`);
  assert.equal(vm.evaluate('NS.Companion.Rewards(STUB.q)'),null);
  vm.run(`GetNumQuestLogRewards=function() return 1 end; GetNumQuestLogChoices=nil; GetQuestLogChoiceInfo=nil`);
  assert.equal(gather(vm).rewards[0].items.length,1,'missing choices never duplicate guaranteed rewards');
});

test('T18 detail readers handle throwing APIs and cap talent/durability gathering',()=>{
  const vm=newVM({extra:DATA}).login();
  vm.run(`GetNumTalentTabs=function() return 100 end
    GetInventoryItemDurability=function(s) return s,100 end`);
  let s=gather(vm); assert.equal(s.talents.length,5); assert.equal(s.durability.length,19);
  vm.run(`GetQuestLogRewardInfo=function() error('reward unavailable') end
    GetQuestLogChoiceInfo=GetQuestLogRewardInfo; C_Item.GetItemInfo=GetQuestLogRewardInfo
    GetTalentTabInfo=GetQuestLogRewardInfo; GetInventoryItemDurability=function() return 10,0 end`);
  s=gather(vm); assert.equal(s.rewards,undefined); assert.equal(s.talents,undefined); assert.equal(s.durability,undefined);
  assert.equal(s.gear[0].sell,undefined); assert.equal(s.bags.items[0].sell,undefined);
  vm.run(`STUB.combat=true; STUB.reads=0; C_Item.GetItemInfo=function() STUB.reads=STUB.reads+1 end`);
  gather(vm); vm.run('NS.Companion.ItemData(100)');
  assert.equal(vm.num('STUB.reads'),0);
});

test('T18 unknown metadata and disabled cooldowns stay absent; zero rested and vendor prices are retained',()=>{
  const vm=newVM({extra:DATA}).login();
  vm.run(`C_Item.GetItemInfo=function() return nil end; C_Container.GetItemCooldown=function() return 0,90,0 end; GetXPExhaustion=function() return 0 end`);
  let s=gather(vm);
  assert.equal(s.gear[0].sell,undefined); assert.equal(s.bags.items[0].quality,undefined);
  assert.equal(s.rewards[0].items[0].equipLoc,undefined); assert.equal(s.hearth.left,undefined); assert.equal(s.rested,0);
  vm.run(`C_Item.GetItemInfo=nil; GetItemInfo=function() return 'Legacy',nil,0,1,0,nil,nil,1,'',nil,0 end
    C_Container.GetItemCooldown=nil; GetItemCooldown=function() return 0,0,1 end`);
  s=gather(vm); assert.equal(s.gear[0].sell,0); assert.equal(s.bags.items[0].quality,0); assert.equal(s.hearth.left,0);
});

test('T18 sanitizer: explicit schemas, integer bounds, 60-character strings and all caps',()=>{
  const long='x'.repeat(100), repeat=(n,v)=>Array.from({length:n},()=>v);
  const s=sanitizeState({
    rewards:repeat(30,{id:748,secret:'no',items:repeat(10,{id:100,name:long,quality:99,sell:1,equipLoc:long,ilvl:-1,minLevel:1.5,count:2,choice:false})}),
    durability:repeat(30,{slot:1,pct:50,name:'no'}),rested:-1,
    hearth:{bind:long,left:Infinity,secret:'no'},talents:repeat(10,{tree:1,name:long,points:1,secret:'no'}),
    gear:repeat(30,{slot:1,id:100,name:long,quality:2,sell:4321,secret:'no'}),
    bags:{items:[{id:100,quality:0,sell:0},{id:101,quality:1.5,sell:-1}]},
  });
  assert.equal(s.rewards.length,20); assert.equal(s.rewards[0].items.length,6);
  assert.deepEqual(s.rewards[0].items[0],{id:100,name:long.slice(0,60),equipLoc:long.slice(0,60),count:2,choice:false});
  assert.equal(s.rewards[0].secret,undefined);
  assert.equal(s.durability.length,19); assert.deepEqual(s.durability[0],{slot:1,pct:50});
  assert.equal(s.rested,undefined); assert.deepEqual(s.hearth,{bind:long.slice(0,60)});
  assert.equal(s.talents.length,5); assert.deepEqual(s.talents[0],{tree:1,name:long.slice(0,60),points:1});
  assert.equal(s.gear.length,19); assert.deepEqual(s.gear[0],{id:100,slot:1,name:long.slice(0,60),quality:2,sell:4321});
  assert.deepEqual(s.bags.items,[{id:100,quality:0,sell:0},{id:101}]);
  assert.deepEqual(sanitizeState({durability:[{slot:20,pct:1},{slot:1,pct:101}],talents:[{tree:0,points:1}],rested:0}),{durability:[],talents:[],rested:0});
});

test('T18 drop orders and encoding: extras go before quest detail, inventory fit retains durability with gear',()=>{
  const src=fs.readFileSync(new URL('../addon/NeverQuestAlone/Companion.lua',import.meta.url),'utf8');
  const order=name=>[...src.match(new RegExp(`local ${name} = \\{([\\s\\S]*?)\\}`))[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  const normal=order('DROP_ORDER'), inv=order('INV_DROP_ORDER');
  for(const k of ['rewards','durability','rested','hearth','talents']) assert.ok(normal.indexOf(k)<normal.indexOf('quests.obj.done'),k);
  for(const k of ['rewards','rested','hearth','talents']) assert.ok(inv.indexOf(k)>inv.indexOf('quests.level'),"the voice's fit keeps "+k+' past the quest detail');
  assert.ok(inv.indexOf('durability')>inv.indexOf('quests.level'));
  assert.ok(Math.abs(inv.indexOf('durability')-inv.indexOf('gear'))===1);
  const vm=newVM({extra:DATA}).login();
  vm.run(`STUB.g=NS.Companion.Gather(); STUB.drop={rewards=true,durability=true,rested=true,hearth=true,talents=true}`);
  const s=JSON.parse(vm.evaluate('NS.Companion.Encode(STUB.g,STUB.drop,1,1)'));
  for(const k of Object.keys({rewards:1,durability:1,rested:1,hearth:1,talents:1})) { assert.equal(s[k],undefined); assert.ok(s.omitted.includes(k)); }
  assert.equal(s.quests[0].id,748);
  vm.run(`STUB.g.quests={}; for i=1,50 do STUB.g.quests[i]={id=i,complete=false,title=string.rep('q',60),obj={{text=string.rep('o',60),have=0,need=1}}} end
    STUB.fit=NS.Companion.Fit(STUB.g,1,1,{qlog=true,z=false})`);
  const fitted=JSON.parse(vm.evaluate('STUB.fit'));
  assert.ok(Buffer.byteLength(JSON.stringify(fitted))<=3100);
  assert.equal(fitted.quests.length,50);
  for(const k of ['rewards','durability','rested','hearth','talents']) assert.ok(fitted.omitted.includes(k),k);
});
