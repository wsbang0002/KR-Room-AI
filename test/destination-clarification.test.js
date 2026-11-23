import test from 'node:test';
import assert from 'node:assert/strict';
import {searchTurn} from '../lib/search-turn.js';
import {handleSearch} from '../api/search.js';
import {FakeRedis} from '../test-support/fake-redis.js';

test('location clarification can be followed by destination clarification without losing the original room and budget filters',()=>{
 const query='중앙동에서 관리비 포함 월 48만 원 이하, 에어컨 필수, 학교까지 도보 15분인 원룸';
 const area=searchTurn({query});
 assert.equal(area.kind,'region');
 const next=searchTurn({query:'서울 관악구요',pending:area.pending});
 assert.equal(next.kind,'destination');assert.match(next.question,/도보 15분/);
 assert.equal(next.lookupQuery,undefined);
 const ambiguous=searchTurn({query:'서울대요',pending:next.pending});
 assert.equal(ambiguous.kind,'destination');assert.ok(ambiguous.places.every(p=>p.address&&p.name));
 const final=searchTurn({query:'서울대학교 관악캠퍼스요',pending:ambiguous.pending});
 assert.equal(final.state,'ready');
 assert.equal(final.conditions.destination,'서울대학교 관악캠퍼스');
 assert.equal(final.conditions.location,'서울특별시 관악구 중앙동');assert.equal(final.conditions.maxMonthlyTotal,48);
 assert.deepEqual(final.conditions.requiredOptions,['에어컨']);assert.deepEqual(final.conditions.roomTypes,['ONE_ROOM']);
});

test('typed POIs can use a verified address, survive a budget edit, and never verify a stale or invented ID',async()=>{
 const start=searchTurn({query:'원주시 무실동 월세 45만원, 도보 15분'});
 const busStation=searchTurn({query:'서울역 버스환승센터',pending:start.pending});
 assert.equal(busStation.lookupQuery,'서울역 버스환승센터');assert.equal(busStation.conditions.transportMode,'walk');
 const place=searchTurn({query:'삼성전자 수원사업장이요',pending:start.pending});
 assert.equal(place.state,'clarify');assert.equal(place.lookupQuery,'삼성전자 수원사업장');
 const name='삼성전자 수원사업장',id='osm-N-12345';
 const previous={...place.pending.conditions,destination:name};
 const next=searchTurn({query:'월세 42만원으로',previous,destinationId:id});
 assert.equal(next.state,'ready');assert.equal(next.conditions.destination,name);assert.equal(next.conditions.maxRent,42);
 const store=new FakeRedis();
 await store.set('knuroom:destination:'+id,{id,name,verified:true,lat:37.257,lng:127.054},3600);
 const opts={req:{headers:{}},env:{DATA_RIGHTS_REVIEWED:'true',UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'mock'},store,
  fetcher:()=>assert.fail('a verified Redis POI and a confirmed query need no provider access')};
 const body={query:'월세 42만원으로',confirmedConditions:next.conditions,destinationId:id};
 const result=await handleSearch(body,opts);
 assert.equal(result.status,200);assert.equal(result.data.conditions.destinationPlace.id,id);
 await assert.rejects(handleSearch({...body,destinationId:'knu-wonju'},opts),{status:422});
 await assert.rejects(handleSearch({...body,destinationId:'osm-N-54321'},opts),{status:422});
});

test('every mode asks for a named destination; a default invented by the AI cannot complete a time limit',()=>{
 for(const mode of ['도보','대중교통','자동차','버스로','자가용으로']){
  const ask=searchTurn({query:'원주시 '+mode+' 15분 이내'},{ai:{destination:'강원대학교 원주캠퍼스'}});
  assert.equal(ask.kind,'destination');assert.equal(ask.conditions.destination,null);
  const notNamed=searchTurn({query:'학교요',pending:ask.pending});
  assert.equal(notNamed.kind,'destination');assert.equal(notNamed.lookupQuery,undefined);
  const removed=searchTurn({query:'시간 조건 없이',pending:ask.pending});
  assert.equal(removed.state,'ready');assert.equal(removed.conditions.maxCommuteMinutes,null);
 }
});

test('walking-time follow-ups without a duration limit keep the original listing filters and verify the named destination',()=>{
 const previous=searchTurn({query:'원주시 무실동에서 관리비 포함 월 50만 원 이하인 원룸 찾아줘'}).conditions;
 assert.equal(previous.destination,null);
 const ask=searchTurn({query:'학교까지 도보로 얼마나 걸려?',previous});
 assert.equal(ask.kind,'destination');
 assert.match(ask.question,/어디까지/);
 assert.deepEqual(ask.conditions,previous);
 const ambiguous=searchTurn({query:'강원대요',previous,pending:ask.pending});
 assert.deepEqual(ambiguous.places.map(p=>p.id),['knu-wonju','knu-chuncheon']);
 const selected=searchTurn({query:'강원대학교 원주캠퍼스',pending:ambiguous.pending});
 assert.equal(selected.state,'ready');
 assert.deepEqual(selected.conditions,{...previous,destination:'강원대학교 원주캠퍼스'});
 const station=searchTurn({query:'원주역까지 걸어서 몇 분이야?',previous});
 assert.equal(station.kind,'destination');assert.equal(station.lookupQuery,'원주역');
 const campus=searchTurn({query:'강원대 춘천 캠퍼스까지 도보로 얼마나 걸려?',previous});
 assert.equal(campus.state,'ready');
 assert.deepEqual(campus.conditions,{...previous,destination:'강원대학교 춘천캠퍼스'});
 const cancelled=searchTurn({query:'도보 시간 조건 없이',pending:ask.pending});
 assert.equal(cancelled.state,'ready');assert.deepEqual(cancelled.conditions,previous);
});
