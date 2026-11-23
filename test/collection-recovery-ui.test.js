import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script=readFileSync(new URL('../public/admin/app.js',import.meta.url),'utf8');
const credential='recovery-unit-test-credential';

function page(respond){
 const nodes=new Map(),reads=[];
 function field(id){
  if(!nodes.has(id))nodes.set(id,{
   id,textContent:'',value:'',addEventListener(){},focus(){},select(){},removeAttribute(){},
   replaceChildren(){this.textContent='';},querySelector(){return field(id+'-button');}
  });
  return nodes.get(id);
 }
 const context=vm.createContext({
  AbortController,window:{addEventListener(){},confirm(){throw Error('Unexpected paid start confirmation');}},
  document:{getElementById:field,querySelectorAll:()=>[]},
  searchInfo:{inventorySummary:()=>''},
  fetch:async(path,options)=>{
   assert.equal(options.headers.Authorization,'Bearer '+credential);
   assert.equal(options.method||'GET','GET');
   if(path==='/api/status?scope=admin')return Response.json({adminAuthenticated:true,liveCollectionEnabled:false});
   if(path==='/api/status?scope=coverage')return Response.json({});
   reads.push(path);
   assert.equal(path,'/api/collect-status?active=1');
   return Response.json(await respond(options));
  }
 });
 vm.runInContext(script,context);
 return {field,reads,login:async()=>{
  field('adminKey').value=credential;
  await field('loginForm').onsubmit({preventDefault(){}});
 }};
}

test('admin resumes after a fresh login without entering a query, enabling live collection or posting a new job',async()=>{
 const cases=[
  [{state:'IDLE'},/진행 중이거나 정산을 기다리는 수집이 없습니다/],
  [{state:'UNIDENTIFIED'},/실행을 식별할 수 없습니다/],
  [{state:'START_UNCONFIRMED'},/시작 결과 미확인/],
  [{state:'RUNNING',conditions:{location:'원주시 무실동'},maxResults:20},/원주시 무실동.*수집 진행 중.*20건/],
  [{state:'SUCCEEDED',persistedCount:4,costSettled:false},/저장 4건.*비용 정산 대기/],
  [{state:'SUCCEEDED',persistedCount:2,costSettled:false,settlementIssue:'COST_EXCEEDS_RESERVATION'},/저장 2건.*예약액을 초과/],
  [{state:'SUCCEEDED',persistedCount:2,costSettled:false,settlementIssue:'INVALID_LEDGER'},/저장 2건.*월 예산 기록/],
  [{state:'FAILED',costSettled:true},/수집 실패.*비용 정산 완료/]
 ];
 for(const [serverResult,expected] of cases){
  const {field,reads,login}=page(()=>serverResult);
  await login();
  assert.equal(field('query').value,'');
  assert.equal(field('collect').disabled,true);
  assert.equal(field('recoverCollection').disabled,false);
  assert.deepEqual(reads,[]);
  await field('recoverCollection').onclick();
  assert.match(field('collectionProgress').textContent,expected);
  assert.deepEqual(reads,['/api/collect-status?active=1']);
 }
});

test('cancelling a status lookup keeps a late response out of the console and permits a manual recheck',async()=>{
 let finish,signal;
 const held=new Promise(resolve=>{finish=resolve;});
 const {field,login,reads}=page(options=>{signal=options.signal;return held;});
 await login();
 const pending=field('recoverCollection').onclick();
 assert.equal(field('stopCollectionView').hidden,false);
 field('stopCollectionView').onclick();
 assert.equal(signal.aborted,true);
 finish({state:'SUCCEEDED',costSettled:true,persistedCount:99});
 await pending;
 assert.match(field('collectionProgress').textContent,/조회.*중단/);
 assert.doesNotMatch(field('collectionProgress').textContent,/99건/);
 assert.equal(field('stopCollectionView').hidden,true);
 assert.equal(field('recoverCollection').disabled,false);
 assert.equal(reads.length,1);
});

test('a run without an ID can be located in Apify by its original reservation time in Korea',async()=>{
 const createdAt='2026-11-23T15:34:56.000Z';
 const localTime=new Date(createdAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
 for(const [result,showTime] of [
  [{state:'START_UNCONFIRMED',createdAt},true],
  [{state:'RESERVED',createdAt},true],
  [{state:'START_UNCONFIRMED',createdAt:'invalid'},false],
  [{state:'RESERVED',createdAt,runId:'known'},false],
  [{state:'SUCCEEDED',createdAt,costSettled:true},false]
 ]){
  const {field,login}=page(()=>result);
  await login();
  await field('recoverCollection').onclick();
  const summary=field('collectionProgress').textContent;
  assert.equal(summary.includes('수집 요청 시각'),showTime);
  if(showTime){
   assert.ok(summary.includes(localTime+' (한국시간)'));
   assert.equal(field('collectionRunLink').href,'https://console.apify.com/actors/runs');
  }
 }
});
