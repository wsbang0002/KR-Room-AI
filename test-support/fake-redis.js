import {INSPECT_MONTHLY,MONTHLY_RESERVE,SETTLE} from '../lib/monthly-budget.js';
import {RESERVE} from '../lib/store.js';
export class FakeRedis {
 constructor(now=Date.now()){this.now=now;this.data=new Map();this.expires=new Map();this.calls=[];}
 read(k){if(this.expires.has(k)&&this.expires.get(k)<=this.now){this.data.delete(k);this.expires.delete(k);}return this.data.get(k);}
 write(k,v,seconds){this.data.set(k,v);if(seconds!=null)this.expires.set(k,this.now+Number(seconds)*1000);else this.expires.delete(k);return 'OK';}
 raw(args){this.calls.push(args);const [name,...a]=args;
 switch(name){
 case 'PING':return 'PONG';
 case 'GET':return this.read(a[0])??null;
 case 'SET':return this.write(a[0],a[1],a[2]==='EX'?a[3]:null);
 case 'SCAN':{const regex=new RegExp('^'+String(a[2]).replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*')+'$');return ['0',[...this.data.keys()].filter(k=>this.read(k)!=null&&regex.test(k))];}
 case 'SMEMBERS':return [...(this.read(a[0])||[])];
 case 'MGET':return a.map(k=>this.read(k)??null);
 case 'TTL':return this.read(a[0])==null?-2:this.expires.has(a[0])?Math.floor((this.expires.get(a[0])-this.now)/1000):-1;
 case 'EVAL':return this.eval(a[0],a.slice(2,2+a[1]),a.slice(2+a[1]));
 default:throw Error(`Unsupported test command ${name}`);
 }}
 eval(lua,keys,args){
 if(lua===RESERVE){const [value,limit,cost,budget,ttl]=args;const old=this.read(keys[0]);if(old)return old;const count=Number(this.read(keys[1])||0),spent=Number(this.read(keys[2])||0);if(count>=limit||spent+cost>budget)return 'LIMIT';this.write(keys[0],value,ttl);this.write(keys[1],String(count+1),172800);this.write(keys[2],String(spent+cost),172800);return 'RESERVED';}
 if(lua===MONTHLY_RESERVE||lua===INSPECT_MONTHLY){
  const [ledger,activeKey,observedKey,jobKey,reservationKey]=keys;
  const [cost,spent,stop,value,ttl,requestId,reservation]=args;
  if(lua===MONTHLY_RESERVE&&this.read(jobKey)!=null)return this.read(jobKey);
  if(this.read(activeKey)!=null)return ['ACTIVE'];
  const counts=[ledger,observedKey].map(key=>{
   const raw=this.read(key)??'0';
   return /^(0|[1-9]\d*)$/.test(String(raw))?Number(raw):NaN;
  });
  if(!counts.every(Number.isSafeInteger))return ['INVALID_COUNTER'];
  const [reserved,priorObserved]=counts,observed=Math.max(priorObserved,spent);
  if(observed+reserved+cost>stop)return ['MONTHLY_BUDGET_LIMIT',observed,reserved];
  if(lua===INSPECT_MONTHLY)return ['AVAILABLE',observed,reserved];
  this.write(jobKey,value,ttl);
  this.write(ledger,String(reserved+cost),ttl);
  this.write(activeKey,requestId,ttl);
  this.write(reservationKey,reservation,ttl);
  this.write(observedKey,String(observed),ttl);
  return 'RESERVED';
 }
 if(lua===SETTLE){const raw=this.read(keys[0]);if(!raw)return 'MISSING';const reservation=JSON.parse(raw);if(reservation.settled)return 'SETTLED';const refund=Math.max(0,reservation.costMicros-args[0]);this.data.set(keys[1],String(Number(this.read(keys[1])||0)-refund));reservation.actualMicros=args[0];reservation.settled=true;reservation.finishedAt=args[1];this.data.set(keys[0],JSON.stringify(reservation));if(this.read(keys[2])===reservation.requestId){this.data.delete(keys[2]);this.expires.delete(keys[2]);}return 'SETTLED';}
 // Listing UPSERT script. Keep its first-seen timestamp while updating prices.
 if(lua.includes('item.firstCollectedAt')){const prev=this.read(keys[0]);const item=JSON.parse(args[0]);if(prev)item.firstCollectedAt=JSON.parse(prev).firstCollectedAt||item.firstCollectedAt;this.write(keys[0],JSON.stringify(item));const index=this.read(keys[1])||new Set();index.add(keys[0]);this.write(keys[1],index);this.write(keys[2],args[1]);return 1;}
 throw Error('Unknown test Lua script');
 }
 async command(args){return this.raw(args);}
 async get(k){const x=this.raw(['GET',k]);return x?JSON.parse(x):null;}
 async set(k,value,ttl){return this.raw(['SET',k,JSON.stringify(value),...(ttl?['EX',ttl]:[])]);}
 async reserve(o){const r=this.raw(['EVAL',RESERVE,3,o.key,`knuroom:${o.kind}:count:${o.user}`,`knuroom:${o.kind}:budget`,JSON.stringify(o.value),o.limit,o.cost,o.budget,o.ttl]);if(r==='LIMIT'){const e=Error('limit');e.status=429;throw e;}return r==='RESERVED'?null:JSON.parse(r);}
}
