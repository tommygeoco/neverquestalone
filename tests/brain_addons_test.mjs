import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openBrain} from '../tools/brain/db.mjs';
import {parseSavedVariables,decodePriceCBOR,importAddons,DEFAULT_WOW_DIR} from '../tools/brain/addons.mjs';
test('literal parser: nesting, keys, escapes, scalars and rejection of code',()=>{
 const x=parseSavedVariables('A = { "first", nil, -2.5e2, [4] = true, named = { ["q"] = "a\\n\\065\\\"" }, no = false }').A;
 assert.equal(x[1],'first'); assert.equal(x[2],undefined); assert.equal(x[3],-250); assert.equal(x[4],true); assert.equal(x.named.q,'a\nA"'); assert.equal(x.no,false);
 for(const s of ['A=os.execute("x")','A={f()}','A={} evil()','A="unfinished'])assert.throws(()=>parseSavedVariables(s));
 assert.equal(parseSavedVariables('A={__proto__={x=1}}').A.__proto__.x,1);
});
test('CBOR byte string map',()=>{ const x=decodePriceCBOR(Buffer.from([0xa1,0x43,49,50,51,0xa1,0x41,109,0x19,1,244]).toString('latin1')); assert.equal(x['123'].m,500); assert.throws(()=>decodePriceCBOR('\xa1')); });
test('real-shaped fixtures, source replacement, privacy, missing files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nqa-addons-')); const db=openBrain(':memory:');
 try { const base=path.join(root,'WTF/Account/test'); const account=path.join(base,'SavedVariables'),char=path.join(base,'91/Tester/SavedVariables');fs.mkdirSync(account,{recursive:true});fs.mkdirSync(char,{recursive:true});
 for(const name of ['Auctionator','Syndicator','RXPGuides'])fs.copyFileSync(new URL(`./fixtures/brain-addons/${name}.lua`,import.meta.url),path.join(name==='RXPGuides'?char:account,name+'.lua'));
 const a=importAddons({wowDir:root,db,now:1234});assert.equal(a.auctionator.rows,1);assert.equal(a.syndicator.rows,4);assert.equal(a.rxpguides.rows,1);
 assert.equal(db.prepare('SELECT copper FROM price').get().copper,500);assert.equal(db.prepare('SELECT count(*) AS n FROM holding WHERE item_id=999').get().n,0);assert.equal(db.prepare('SELECT char_key FROM guide').get().char_key,'Tester-PvE');assert.equal(db.prepare('SELECT step FROM guide').get().step,8);
 importAddons({wowDir:root,db,now:2345});assert.equal(db.prepare('SELECT count(*) AS n FROM holding').get().n,2);
 assert.equal(importAddons({wowDir:path.join(root,'absent'),db}).auctionator.missing,true);
 } finally { db.close(); fs.rmSync(root,{recursive:true,force:true}); }
});
test('installed SavedVariables integration', {skip:!fs.existsSync(path.join(DEFAULT_WOW_DIR,'WTF/Account'))},t=>{
 const db=openBrain(':memory:');try { const start=performance.now(); const counts=importAddons({db});t.diagnostic(JSON.stringify({counts,elapsed_ms:performance.now()-start}));assert.ok(counts.syndicator.rows>0);assert.ok(counts.auctionator.rows>0); }finally{db.close();}
});

test('the app\'s import: into an existing brain from the WTF folder; never creates one', async () => {
 const { importAddonsIntoBrain } = await import('../tools/brain/addons.mjs');
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-addons-app-'));
 try {
  const account = path.join(root, 'game/WTF/Account/test/SavedVariables'); fs.mkdirSync(account, { recursive: true });
  fs.copyFileSync(new URL('./fixtures/brain-addons/Auctionator.lua', import.meta.url), path.join(account, 'Auctionator.lua'));
  const file = path.join(root, 'app/brain/brain.sqlite');
  assert.equal(importAddonsIntoBrain({ brainFile: file, wtfDir: path.join(root, 'game/WTF') }), null, 'no brain yet: nothing made');
  assert.equal(fs.existsSync(file), false);
  fs.mkdirSync(path.dirname(file), { recursive: true }); openBrain(file).close();
  const rows = importAddonsIntoBrain({ brainFile: file, wtfDir: path.join(root, 'game/WTF') });
  assert.equal(rows.auctionator, 1);
  const db = openBrain(file, { readOnly: true }); try { assert.equal(db.prepare('SELECT copper FROM price').get().copper, 500); } finally { db.close(); }
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
