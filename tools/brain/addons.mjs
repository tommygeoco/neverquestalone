import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { openBrain, brainFile, upsertSource, inTransaction } from './db.mjs';
export const DEFAULT_WOW_DIR = 'C:/Program Files (x86)/World of Warcraft/_forever_';
// Byte-preserving strings are essential: Auctionator embeds CBOR in Lua strings.
export function parseSavedVariables(input) {
  const s = Buffer.isBuffer(input) ? input.toString('latin1') : input;
  let p = s.startsWith('\xef\xbb\xbf') ? 3 : 0;
  const fail = () => { throw new SyntaxError(`Unsupported Lua literal at byte ${p}`); };
  function skip() { for (;;) { while (/\s/.test(s[p] || '') && p < s.length) p++; if (!s.startsWith('--', p)) return; p += 2; if (s.startsWith('[[', p)) { const end=s.indexOf(']]',p+2); if(end<0) fail(); p=end+2; } else { while(p<s.length && s[p]!=='\n') p++; } } }
  function take(c) { skip(); if(s[p]!==c) fail(); p++; }
  function ident() { skip(); const m=/^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(p)); if(!m) fail(); p+=m[0].length; return m[0]; }
  function value(depth=0) {
    if(depth>100) fail(); skip(); const c=s[p];
    if(c==='"' || c==="'") { p++; let out=''; while(p<s.length) { let ch=s[p++]; if(ch===c) return out; if(ch==='\\') { ch=s[p++]; if(/[0-9]/.test(ch)) { let n=ch; while(n.length<3 && /[0-9]/.test(s[p]||'')) n+=s[p++]; if(+n>255) fail(); out+=String.fromCharCode(+n); } else { const e={a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v','\\':'\\','"':'"',"'":"'",'\n':'\n'}; if(!(ch in e)) fail(); out+=e[ch]; } } else out+=ch; } fail(); }
    if(c==='{') { p++; const o=Object.create(null); let i=1; skip(); while(s[p]!=='}') { let k, v; if(s[p]==='[') { p++; k=value(depth+1); take(']'); take('='); v=value(depth+1); } else { const start=p; const m=/^[A-Za-z_][A-Za-z_0-9]*\s*=/.exec(s.slice(p)); if(m) { k=ident(); take('='); v=value(depth+1); } else { p=start; k=i++; v=value(depth+1); } } if(!['string','number','boolean'].includes(typeof k)) fail(); if(v!==null) o[k]=v; else delete o[k]; skip(); if(s[p]===','||s[p]===';') { p++; skip(); } else if(s[p]!=='}') fail(); } p++; return o; }
    const n=/^-?(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i.exec(s.slice(p)); if(n) { p+=n[0].length; const x=Number(n[0]); if(!Number.isFinite(x)) fail(); return x; }
    const id=ident(); if(id==='true') return true; if(id==='false') return false; if(id==='nil') return null; fail();
  }
  const globals=Object.create(null); skip(); while(p<s.length) { const name=ident(); take('='); globals[name]=value(); skip(); if(s[p]===';') p++; skip(); } return globals;
}
const utf = s => Buffer.from(s, 'latin1').toString('utf8');
// Definite-length CBOR subset emitted by LibCBOR; rejects executable/unknown forms.
export function decodePriceCBOR(s) {
 const b=Buffer.from(s,'latin1'); let p=0;
 function read(d=0) { if(d>100||p>=b.length) throw Error('Invalid CBOR'); const h=b[p++],major=h>>5, a=h&31; let n=a; if(a>=24) { const size={24:1,25:2,26:4,27:8}[a]; if(!size||p+size>b.length) throw Error('Invalid CBOR length'); n=size===8?Number(b.readBigUInt64BE(p)):b.readUIntBE(p,size); p+=size; } if(!Number.isSafeInteger(n)||n>b.length && major>=2) throw Error('Invalid CBOR size'); if(major===0)return n; if(major===1)return -1-n; if(major===2||major===3) { if(p+n>b.length)throw Error('Truncated CBOR'); const v=b.subarray(p,p+n).toString('utf8'); p+=n; return v; } if(major===4) return Array.from({length:n},()=>read(d+1)); if(major===5) { const o=Object.create(null); for(let i=0;i<n;i++) { const k=read(d+1); o[k]=read(d+1); } return o; } throw Error('Unsupported CBOR'); }
 const result=read(); if(p!==b.length)throw Error('Trailing CBOR'); return result;
}
function dirs(p) { try { return fs.readdirSync(p,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).map(x=>x.name).sort(); } catch(e) { if(e.code==='ENOENT') return []; throw e; } }
export function importAddons({wowDir=DEFAULT_WOW_DIR,db,now=Date.now()}) {
 const at=typeof now==='function'?now():Number(now), root=path.join(wowDir,'WTF','Account');
 const files=[];
 for(const account of dirs(root)) { const base=path.join(root,account); files.push({dir:path.join(base,'SavedVariables')}); for(const realm of dirs(base).filter(x=>x!=='SavedVariables')) for(const char of dirs(path.join(base,realm))) files.push({dir:path.join(base,realm,char,'SavedVariables'),char,realm}); }
 const result={}; const own=[];
 for(const [addon,source,tables] of [['Syndicator','syndicator',['holding','fact']],['Auctionator','auctionator',['price']],['RXPGuides','rxpguides',['guide']]]) {
  const inputs=[]; for(const f of files) { const file=path.join(f.dir,addon+'.lua'); try { inputs.push({...f,data:parseSavedVariables(fs.readFileSync(file))}); } catch(e) { if(e.code!=='ENOENT') throw e; } }
  const counts={files:inputs.length,missing:inputs.length===0,rows:0}; result[source]=counts; if(!inputs.length)continue;
  inTransaction(db,()=>{
   for(const table of tables)db.prepare(`DELETE FROM ${table} WHERE source=?`).run(source);
   for(const f of inputs) {
    if(source==='syndicator') for(const [rawKey,c] of Object.entries(f.data.SYNDICATOR_DATA?.Characters||{})) {
     const key=utf(rawKey); own.push({key,name:utf(c.details?.character||rawKey.split('-')[0])});
     for(const field of ['level','class']) if(c.details?.[field]!=null) { const v=c.details[field]; db.prepare('INSERT OR IGNORE INTO fact VALUES (?,?,?,?,?)').run(key,field,JSON.stringify(typeof v==='string'?utf(v):v),source,at); counts.rows++; }
     function items(node,place) { if(!node||typeof node!=='object')return; if(Number.isSafeInteger(node.itemID)&&node.itemID>0&&Number.isSafeInteger(node.itemCount)&&node.itemCount>0) { db.prepare('INSERT INTO holding VALUES (?,?,?,?,?,?)').run(key,place,node.itemID,node.itemCount,source,at); counts.rows++; return; } for(const v of Object.values(node))items(v,place); }
     for(const place of ['bags','bank','equipped','mail','auctions','void','reagentBank'])items(c[place],place);
     // Bag containers themselves are owned items, separate from bag contents.
     items(c.containerInfo,'containers');
    }
    if(source==='auctionator') for(const [realm,packed] of Object.entries(f.data.AUCTIONATOR_PRICE_DATABASE||{})) { if(realm.startsWith('__'))continue; const prices=typeof packed==='string'?decodePriceCBOR(packed):packed; for(const [id,v] of Object.entries(prices||{})) { if(!/^\d+$/.test(id)||!Number.isSafeInteger(v.m)||v.m<0)continue;
      // seen_at is the start of the latest recorded scan day (milliseconds), not an exact scan time.
      db.prepare('INSERT OR REPLACE INTO price VALUES (?,?,?,?,?)').run(+id,v.m,Object.keys(v.h||{}).filter(x=>/^\d+$/.test(x)).length ? new Date(2020,0,1 + Math.max(...Object.keys(v.h).filter(x=>/^\d+$/.test(x)).map(Number))).getTime() : null,source,at); counts.rows++;
    } }
    if(source==='rxpguides'&&f.char) { const c=f.data.RXPCData||f.data.RXPData; if(!c?.currentGuideName)continue; const matches=own.filter(x=>x.name.replaceAll(' ','-')===f.char); const key=matches.length===1?matches[0].key:`${f.char}-${f.realm}`; db.prepare('INSERT OR REPLACE INTO guide VALUES (?,?,?,?,?,?)').run(key,utf(c.currentGuideName),Number.isSafeInteger(c.currentStep)?c.currentStep:null,typeof c.currentStepText==='string'?utf(c.currentStepText):null,source,at); counts.rows++; }
   }
   upsertSource(db,source,{at,detail:JSON.stringify(counts)});
  });
 }
 return result;
}
/** For the app (bridge/service.mjs): import into an existing brain file from the game's WTF folder.
 * Returns the rows per source, or null when there is no brain yet. Never creates the brain. */
export function importAddonsIntoBrain({ brainFile, wtfDir, now = Date.now() }) {
  if (!brainFile || !wtfDir || !fs.existsSync(brainFile)) return null;
  const db = openBrain(brainFile);
  try {
    const r = importAddons({ wowDir: path.dirname(wtfDir), db, now });
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.rows]));
  } finally { db.close(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 const args=process.argv.slice(2); if(args.shift()!=='import')throw Error('Usage: addons.mjs import [--wow-dir dir] [--brain file]');
 let wowDir=DEFAULT_WOW_DIR, file=brainFile(path.join(process.env.APPDATA??path.join(os.homedir(),'AppData','Roaming'),'NeverQuestAlone','dev'));
 while(args.length) { const flag=args.shift(),v=args.shift(); if(!v)throw Error('Missing option value'); if(flag==='--wow-dir')wowDir=v; else if(flag==='--brain')file=v; else throw Error('Unknown option'); }
 const db=openBrain(file),start=performance.now(); try { console.log(JSON.stringify({counts:importAddons({wowDir,db}),elapsed_ms:performance.now()-start})); } finally { db.close(); }
}
