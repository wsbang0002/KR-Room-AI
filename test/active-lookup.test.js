import assert from 'node:assert/strict';
import test from 'node:test';
import {findActiveCollection,findRecordedRunId} from '../lib/active-collection.js';
import {reserveMonthly} from '../lib/monthly-budget.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const lock='knuroom:apify:active';
const prefix='knuroom:collect:';
const job={id:'ab'.repeat(32),requestId:'c7342330-e685-483f-9239-a121d2235d13',user:'shared-collection-owner'};
const reservationKey='knuroom:budget:reservation:'+job.requestId;
const expected={jobId:job.id,requestId:job.requestId};

test('new reservations are directly indexed by their raw active-lock value, preserve the lock, and mark conflicts',async()=>{
 const db=new FakeRedis();
 const budget={cycle:{startAt:new Date(db.now-60_000),endAt:new Date(db.now+86400_000)},spentUsd:1,appStopUsd:9};
 const args={job,key:prefix+job.id,budget,cfg:{max:.51},now:db.now};
 assert.deepEqual(await findActiveCollection(db,job.user),{state:'IDLE'});
 await reserveMonthly(db,args);
 assert.equal(db.read(lock),job.requestId);
 assert.equal((await db.get(reservationKey)).jobId,job.id);
 const before=db.calls.length;
 assert.deepEqual(await findActiveCollection(db,job.user),expected);
 assert.deepEqual(db.calls.slice(before).map(command=>command[0]),['GET','GET','MGET']);
 assert.deepEqual(await findActiveCollection(db,'different-owner'),{state:'UNIDENTIFIED'});
 const other={...job,id:'cd'.repeat(32),requestId:'second-request'};
 await assert.rejects(reserveMonthly(db,{...args,key:prefix+other.id,job:other}),{status:409,code:'ACTIVE'});
 assert.equal(db.read(lock),job.requestId);
});

test('legacy lookup follows large cursors and empty pages, skips counters, and checks both key and owner',async()=>{
 const db=new FakeRedis();
 db.write(lock,job.requestId);db.write(reservationKey,JSON.stringify({requestId:job.requestId,settled:false}));
 const wrongId='cd'.repeat(32),wrongKey=prefix+wrongId;
 db.write(wrongKey,JSON.stringify(job));
 db.write(prefix+job.id,JSON.stringify(job));
 const bigCursor='18446744073709551601';
 const pages=new Map([
  ['0',[bigCursor,[]]],
  [bigCursor,['42',['foreign:key','knuroom:collect:count:old',wrongKey]]],
  ['42',['0',[prefix+job.id]]],
 ]);
 const scanned=[];
 const legacy={command:async args=>{
  if(args[0]!=='SCAN')return db.command(args);
  assert.deepEqual(args.slice(2,4),['MATCH',prefix+'*']);
  scanned.push(args[1]);return pages.get(args[1]);
 }};
 assert.deepEqual(await findActiveCollection(legacy,job.user),expected);
 assert.deepEqual(scanned,['0',bigCursor,'42']);
 assert.deepEqual(await findActiveCollection(legacy,'another-owner'),{state:'UNIDENTIFIED'});
 assert.ok(db.calls.every(args=>['GET','MGET'].includes(args[0])&&!args.includes('foreign:key')&&!args.includes('knuroom:collect:count:old')));
 assert.equal(db.read(lock),job.requestId);
});

test('unidentifiable or damaged locks, mismatched records and capped legacy scans stay blocked',async()=>{
 const unknown={state:'UNIDENTIFIED'};
 for(const [raw,reservation,stored] of [
  ['',null,job],[job.requestId,'bad json',job],
  [job.requestId,JSON.stringify({...expected,requestId:'stale'}),job],
  [job.requestId,JSON.stringify(expected),{...job,requestId:'different-request'}],
  [job.requestId,JSON.stringify(expected),{...job,user:'different-owner'}],
  [job.requestId,null,null]
 ]){
  const db=new FakeRedis();db.write(lock,raw);
  if(reservation)db.write(reservationKey,reservation);
  if(stored)db.write(prefix+job.id,JSON.stringify(stored));
  assert.deepEqual(await findActiveCollection(db,job.user),unknown);
  assert.equal(db.read(lock),raw);
 }
 const db=new FakeRedis();db.write(lock,job.requestId);
 let pages=0;
 const unbounded={command:args=>args[0]==='SCAN'?[String(++pages),[]]:db.command(args)};
 assert.deepEqual(await findActiveCollection(unbounded,job.user),unknown);
 assert.ok(pages>1&&pages<=200);
 await assert.rejects(findActiveCollection({command(){throw Error('unavailable');}},job.user),/unavailable/);
});

test('a lock or collection replaced during discovery cannot expose the stale job',async()=>{
 const db=new FakeRedis();db.write(lock,job.requestId);
 db.write(reservationKey,JSON.stringify(expected));
 for(const [current,stored,result] of [
  [null,job,{state:'IDLE'}],
  ['new-request',job,{state:'UNIDENTIFIED'}],
  [job.requestId,{...job,requestId:'new-request'},{state:'UNIDENTIFIED'}]
 ]){
  const changing={command:args=>args[0]==='MGET'?[current,JSON.stringify(stored)]:db.command(args)};
  assert.deepEqual(await findActiveCollection(changing,job.user),result);
 }
});

test('a missing run ID can be recovered only from one exact job and request pair in the run index',async()=>{
 const db=new FakeRedis();
 const runPrefix='knuroom:apify:run:';
 const target='matchingRun';
 db.write(runPrefix+target,JSON.stringify({...expected,state:'RUNNING'}));
 db.write(runPrefix+'otherRequest',JSON.stringify({...expected,requestId:'prior-request'}));
 db.write(runPrefix+'otherRegion',JSON.stringify({...expected,jobId:'cd'.repeat(32)}));
 db.write(runPrefix+'otherState',JSON.stringify({createdAt:job.createdAt,region:job.region,state:'RUNNING'}));
 db.write('foreign:'+target,JSON.stringify(expected));
 const scoped={command:args=>{
  if(args[0]==='SCAN')assert.equal(args[3],runPrefix+'*');
  else assert.ok(['GET','MGET'].includes(args[0])&&args.slice(1).every(key=>key.startsWith(runPrefix)));
  return db.command(args);
 }};
 assert.equal(await findRecordedRunId(scoped,job),target);
 db.write(runPrefix+'secondMatch',JSON.stringify(expected));
 assert.equal(await findRecordedRunId(scoped,job),null);
 const before=db.calls.length;
 for(const skipped of [undefined,{...job,runId:'known'},{...job,id:'invalid'},{...job,requestId:''}]){
  assert.equal(await findRecordedRunId(scoped,skipped),null);
 }
 assert.equal(db.calls.length,before);
});

test('repeated pages, disappearing run records and incomplete searches cannot bind a guessed run',async()=>{
 const runKey='knuroom:apify:run:verifiedRun';
 const viable=JSON.stringify(expected);
 for(const [pages,recheck,result] of [
  [[['42',[runKey]],['0',[runKey]]],viable,'verifiedRun'],
  [[['42',[runKey]],['42',[]]],viable,null],
  [[['0',[runKey]]],null,null],
  [[['0',[]]],viable,null]
 ]){
  let page=0;
  const db={command:async args=>{
   if(args[0]==='SCAN')return pages[page++];
   if(args[0]==='MGET')return args.slice(1).map(()=>viable);
   assert.deepEqual(args,['GET',runKey]);return recheck;
  }};
  assert.equal(await findRecordedRunId(db,job),result);
 }
 const many=Array.from({length:5000},(_,i)=>'knuroom:apify:run:run'+i);
 let reads=0;
 const oversized={command:async args=>{
  if(args[0]==='SCAN')return ['0',many];
  assert.equal(args[0],'MGET');reads+=args.length-1;
  return args.slice(1).map(key=>key===many[0]?viable:null);
 }};
 assert.equal(await findRecordedRunId(oversized,job),null);
 assert.ok(reads>0&&reads<many.length);
});
