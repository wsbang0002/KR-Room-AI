import test from 'node:test';
import assert from 'node:assert/strict';
import {handleConditions} from '../api/conditions.js';
import {searchTurn,validateTurnConditions} from '../lib/search-turn.js';
import {locationMatch} from '../lib/regions.js';

const wonju='강원특별자치도 원주시';
const initial=()=>searchTurn({query:'원주시 무실동 원룸, 관리비 포함 월 50만 원 이하, 보증금 500만원, 대중교통 20분, 에어컨 필수'}).conditions;

test('a bare ambiguous neighborhood asks before changing results, then accepts a typed city and retains every other filter',()=>{
 const previous=initial();
 const first=searchTurn({query:'중앙동으로 바꿔줘',previous});
 assert.equal(first.state,'clarify');assert.ok(!first.conditions);
 assert.equal(first.candidates[0],wonju+' 중앙동');
 assert.equal(first.candidates.length,31);
 const next=searchTurn({query:'원주시요',previous,pending:first.pending});
 assert.equal(next.state,'ready');
 assert.deepEqual(next.conditions,{...previous,location:wonju+' 중앙동'});
 assert.equal(next.conditions.maxMonthlyTotal,50);assert.equal(next.conditions.maxDeposit,500);
 assert.equal(next.conditions.maxCommuteMinutes,20);assert.equal(next.conditions.transportMode,'transit');
 assert.deepEqual(next.conditions.requiredOptions,['에어컨']);assert.deepEqual(next.conditions.roomTypes,['ONE_ROOM']);
 assert.equal(previous.location,wonju+' 무실동');
});

test('district answers can narrow twice, include the 31st nationwide candidate, and cannot pick an unrelated place',()=>{
 const ask=searchTurn({query:'중앙동, 월세 48만원 이하 원룸'});
 const retries=searchTurn({query:'춘천시요',pending:ask.pending});
 assert.equal(retries.state,'clarify');assert.equal(retries.candidates.length,31);
 for(const query of ['청주시요','청주시 상당구',ask.candidates.at(-1)]){
  const {conditions}=searchTurn({query,pending:ask.pending});
  assert.equal(conditions.location,'충청북도 청주시상당구 중앙동');assert.equal(conditions.maxRent,48);
 }
 const province=searchTurn({query:'경기도요',pending:ask.pending});
 assert.equal(province.state,'clarify');assert.ok(province.candidates.every(x=>x.startsWith('경기도 ')));
 assert.equal(searchTurn({query:'평택시요',pending:province.pending}).conditions.location,'경기도 평택시 중앙동');
});

test('explicit city or same-city intent resolves directly, unknown input requests a corrected area',()=>{
 const previous=initial();
 for(const query of ['같은 시에서 중앙동으로 바꿔줘','원주시 중앙동으로','원주 중앙동']){
  assert.deepEqual(searchTurn({query,previous}).conditions,{...previous,location:wonju+' 중앙동'});
 }
 const ask=searchTurn({query:'없는동으로 바꾸고 월세 42만원',previous});
 assert.equal(ask.state,'clarify');assert.deepEqual(ask.candidates,[]);
 const answer=searchTurn({query:'원주시 단계동',previous,pending:ask.pending});
 assert.equal(answer.conditions.location,wonju+' 단계동');assert.equal(answer.conditions.maxRent,42);
});

test('an absent area can introduce a homonymous neighborhood, then narrow to a city without losing filter constraints',()=>{
 const first=searchTurn({query:'월세 44만원 원룸'});
 assert.equal(first.state,'clarify');
 const second=searchTurn({query:'중앙동',pending:first.pending});
 assert.equal(second.state,'clarify');
 const third=searchTurn({query:'원주시요',pending:second.pending});
 assert.equal(third.conditions.maxRent,44);assert.equal(third.conditions.location,wonju+' 중앙동');
});

test('follow-up numeric, option, commute and budget edits apply only the requested changes',()=>{
 let previous=initial();
 previous=searchTurn({query:'관리비 포함 월 45만원으로',previous}).conditions;
 assert.equal(previous.maxMonthlyTotal,45);assert.equal(previous.maxDeposit,500);
 previous=searchTurn({query:'보증금 제한 해제, 에어컨 필수 빼줘, 도보 15분',previous}).conditions;
 assert.equal(previous.maxDeposit,null);assert.deepEqual(previous.requiredOptions,[]);
 assert.deepEqual(previous.preferredOptions,[]);assert.equal(previous.maxCommuteMinutes,15);assert.equal(previous.transportMode,'walk');
 assert.equal(previous.maxMonthlyTotal,45);assert.equal(previous.location,wonju+' 무실동');
});

test('explicit fresh search drops previous conditions, including while a clarification is pending',()=>{
 const previous=initial();
 const {pending}=searchTurn({query:'중앙동으로',previous});
 for(const prefix of ['새 검색','새로운 검색','새로 검색','처음부터','조건 초기화']){
  const {conditions}=searchTurn({query:prefix+' 서울 관악구 투룸',previous,pending});
  assert.equal(conditions.location,'서울특별시 관악구');assert.equal(conditions.maxMonthlyTotal,null);
  assert.equal(conditions.transportMode,'walk');assert.deepEqual(conditions.roomTypes,['TWO_ROOM']);
 }
});

test('only validated ready filters and bounded clarification context are accepted',()=>{
 assert.equal(validateTurnConditions(initial()),true);
 for(const body of [{query:' '}, {query:'원룸',previous:{location:'원주' }},
  {query:'선택',pending:{query:'중앙동',candidates:['not a verified address']}},
  {query:'선택',pending:{query:'중앙동',scope:Array(100).fill('가')}},
  {query:'원룸',actorId:'x'},{query:'원룸',previous:{location:wonju,maxRent:-1}}]){
  assert.throws(()=>searchTurn(body),{status:400});
 }
});

test('private visitors, edits, ambiguous queries and replies never make an AI request; reviewed fresh searches use only the free provider',async()=>{
 const calls=[];
 const analyze=async(query,opts)=>{calls.push(opts.publicFree);return {ai:{location:'경기도 여주시',maxMonthlyTotal:90,maxRent:35,requiredOptions:['주차']}};};
 const env={AI_PROVIDER:'openrouter-free',DATA_RIGHTS_REVIEWED:'true'};
 const body={query:'원주시 무실동 관리비 포함 50만 원'};
 assert.equal((await handleConditions(body,{env:{...env,DATA_RIGHTS_REVIEWED:'false'},analyze})).conditions.maxRent,null);
 await handleConditions(body,{env:{...env,AI_PROVIDER:'gemini'},analyze});
 const {pending}=await handleConditions({query:'중앙동'},{env,analyze});
 await handleConditions({query:'원주시요',pending},{env,analyze});
 await handleConditions({query:'월세 45만원',previous:initial()},{env,analyze});
 assert.deepEqual(calls,[]);
 const fresh=await handleConditions(body,{env,analyze});
 assert.deepEqual(calls,[true]);assert.equal(fresh.conditions.maxRent,35);
 assert.equal(fresh.conditions.maxMonthlyTotal,50);assert.equal(fresh.conditions.location,wonju+' 무실동');
});

test('authenticated private searches may call their configured AI once; invalid keys cannot use a provider',async()=>{
 const env={DATA_RIGHTS_REVIEWED:'false',ADMIN_API_KEY:'test-only-editor-credential-long'};
 let calls=0;
 const analyze=async(_,opts)=>{calls++;assert.equal(opts.publicFree,false);throw Error('unavailable');};
 const body={query:'원주시 단계동 월세 40만원'};
 await assert.rejects(handleConditions(body,{env,req:{headers:{authorization:'Bearer wrong'}},analyze}),{status:401});
 assert.equal(calls,0);
 const administrator={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
 assert.equal((await handleConditions(body,{req:administrator,env,analyze})).conditions.maxRent,40);
 assert.equal(calls,1);
});

test('a neighborhood edit excludes contradictory administrative evidence and preserves genuinely unknown addresses',()=>{
 const selected=wonju+' 중앙동';
 assert.equal(locationMatch({address:'무실동',dong:'무실동'},selected),'mismatch');
 assert.equal(locationMatch({address:'서울특별시 관악구 중앙동'},selected),'mismatch');
 assert.equal(locationMatch({address:selected,dong:'중앙동'},selected),'match');
 assert.equal(locationMatch({address:'중앙동'},selected),'unknown');
 assert.equal(locationMatch({address:'서울특별시 관악구 봉천동'},'서울특별시 관악구 중앙동'),'unknown');
 assert.equal(locationMatch({region:'강원특별자치도'},selected),'unknown');
 assert.equal(locationMatch({address:'충청북도 청주시 상당구 중앙동'},'청주시 상당구 중앙동'),'match');
});
