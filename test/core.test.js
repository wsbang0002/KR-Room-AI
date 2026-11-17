import test from 'node:test';import assert from 'node:assert/strict';import {parseConditions,normalize,rank,DEMO} from '../lib/core.js';
test('natural language extracts money and minutes',()=>{const a=parseConditions('보증금 500만원 이하, 관리비 포함 45만원 이하, 학교 도보 15분, 에어컨');assert.equal(a.maxDeposit,500);assert.equal(a.maxMonthly,45);assert.equal(a.maxWalk,15);assert.deepEqual(a.wants,['에어컨']);});
test('fee missing is unknown, not 0',()=>{assert.equal(normalize({deposit:300,rent:35}).fee,null);});
test('filters with total including fee',()=>{const x=rank(DEMO,{maxMonthly:42});assert.equal(x.some(r=>r.id==='demo-c'),true);assert.equal(x.some(r=>r.id==='demo-a'),true);assert.equal(x.some(r=>r.id==='demo-d'),false);});
test('strict walk excludes unknown',()=>{assert.ok(rank(DEMO,{maxWalk:15}).every(r=>r.walkMinutes!=null&&r.walkMinutes<=15));});
test('apify standard output fields',()=>{const x=normalize({id:'X',deposit:1000,rent:45,maintenance_cost:70000,latitude:37,longitude:127,propertyTitle:'테스트'});assert.equal(x.fee,7);assert.equal(x.rent,45);});

test('apify KRW fee converts exactly once and survives re-normalization',()=>{
 const raw={id:'x',rent:22,deposit:200,rent_krw:220000,deposit_krw:2000000,maintenance_cost:50000,dong_name:'단계동',latitude:37.34,longitude:127.93};
 const first=normalize(raw),second=normalize(first);
 assert.equal(first.fee,5);assert.equal(first.rent,22);assert.equal(second.fee,5);assert.equal(second.deposit,200);
 assert.equal(second.dong,'단계동');assert.equal(second.walkMinutes,null);
});
test('no fabricated walking time, exact walk constraint excludes unverified listings',()=>{
 const room=normalize({id:'x',rent:22,deposit:200,maintenance_cost:50000,latitude:37.34,longitude:127.93});
 assert.equal(room.walkMinutes,null);assert.equal(rank([room],{maxWalk:15}).length,0);
 assert.equal(rank([room],{maxMonthly:27}).length,1);
 assert.equal(rank([room],{maxMonthly:26}).length,0);
});
