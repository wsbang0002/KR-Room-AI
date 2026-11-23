import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script=readFileSync(new URL('../public/collect-region.js',import.meta.url),'utf8');
function setup(respond){
 const fields=new Map(),reads=[];
 function field(id){
  if(!fields.has(id))fields.set(id,{textContent:'',addEventListener(type,handle){this[type]=handle;}});
  return fields.get(id);
 }
 const context=vm.createContext({document:{getElementById:field},AbortController,
  window:{confirm(){assert.fail('State recovery must never prompt for a paid job');}}});
 const factory=vm.runInContext(script+'\nregionCollection',context);
 const app=factory(async(path,body,signal)=>{
  assert.equal(body,undefined);
  reads.push(path);
  assert.equal(path,'/api/collect-status?active=1');
  return respond(signal);
 },()=>assert.fail('Checking a receipt must not submit a search'),()=>{});
 return {field,reads,update:(signedIn,location)=>app.update({signedIn,enabled:true,busy:false,conditions:location?{location}:null})};
}

test('home recovers on explicit GET without an existing search; a foreign unsettled job blocks a new start',async()=>{
 const results=[
  {state:'UNIDENTIFIED'},
  {state:'START_UNCONFIRMED',jobId:'receipt',conditions:{location:'서울특별시 관악구'}},
  {state:'SUCCEEDED',jobId:'receipt',conditions:{location:'서울특별시 관악구'},persistedCount:4,costSettled:false},
  {state:'FAILED',conditions:{location:'서울특별시 관악구'},costSettled:true},
  {state:'IDLE'}
 ];
 const {field,reads,update}=setup(()=>results.shift());
 update(false);
 assert.equal(field('collectionPanel').hidden,true);
 await field('recoverCollection').click();
 update(true);
 assert.equal(field('collectionPanel').hidden,false);
 assert.equal(field('collectRegion').hidden,true);
 assert.deepEqual(reads,[]);
 const check=()=>field('recoverCollection').click();
 await check();
 assert.match(field('collectionFeedback').textContent,/식별/);
 update(true,'원주시 무실동');
 assert.equal(field('collectRegion').disabled,true);
 await check();
 assert.match(field('collectionFeedback').textContent,/서울특별시 관악구.*시작/);
 await check();
 assert.match(field('collectionFeedback').textContent,/서울특별시 관악구.*저장한 매물 4건.*비용 정산 확인 중/);
 await field('collectRegion').click();
 assert.equal(reads.length,3);
 await check();
 assert.match(field('collectionFeedback').textContent,/서울특별시 관악구.*수집 실패.*정산이 끝/);
 assert.equal(field('collectRegion').disabled,false);
 await check();
 assert.match(field('collectionFeedback').textContent,/수집이 없어요/);
 assert.equal(reads.length,5);
});

test('home discards an in-flight previous-job response after logout',async()=>{
 let release,signal;
 const held=new Promise(resolve=>{release=resolve;});
 const {field,reads,update}=setup(current=>{signal=current;return held;});
 update(true);
 const waiting=field('recoverCollection').click();
 assert.equal(field('recoverCollection').disabled,true);
 update(false);
 assert.equal(signal.aborted,true);
 release({state:'RUNNING',conditions:{location:'서울특별시 관악구'}});
 await waiting;
 update(true);
 assert.equal(field('collectionFeedback').textContent,'');
 assert.equal(field('recoverCollection').disabled,false);
 assert.equal(reads.length,1);
});
