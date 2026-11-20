import assert from 'node:assert/strict';
import test from 'node:test';
import {buildConditions} from '../lib/conditions.js';
import {recommend} from '../lib/recommend.js';

const now=Date.parse('2026-11-20T03:00:00Z');
const conditions=buildConditions('원주시 무실동 관리비 포함 월 60만원');
const listing=(id,details)=>({id,address:'강원특별자치도 원주시 무실동',rent:35,fee:5,...details});

test('only observations within 168 hours compete for rank; older and undated rows keep no score',()=>{
 const boundary='2026-11-13T12:00:00+09:00';
 const expired='2026-11-13T02:59:59.999Z';
 const older='2026-11-01T01:00:00Z';
 const rooms=[
  listing('unknown',{syncStatus:'current',rent:1}),
  listing('old-cheap',{collectedAt:older,rent:2}),
  listing('just-expired',{lastSeenAt:expired,syncStatus:'current',rent:3}),
  listing('boundary',{lastSeenAt:boundary,collectedAt:older,rent:40}),
  listing('collected',{collectedAt:'2026-11-20',rent:30}),
  listing('missing-fee',{lastSeenAt:boundary,fee:null}),
  listing('over-budget',{collectedAt:older,rent:80})
 ];
 const {results,unverified}=recommend(rooms,conditions,{now});
 assert.deepEqual(results.map(item=>item.id),['collected','boundary']);
 assert.deepEqual(unverified.map(item=>item.id),['missing-fee','just-expired','old-cheap','unknown']);
 assert.ok(Number.isFinite(unverified[0].score));
 assert.deepEqual(unverified.slice(1).map(item=>[item.syncStatus,item.score]),
  [['stale',null],['stale',null],['unknown',null]]);
 assert.ok(unverified[1].missingConditions.includes('최근 7일 이내 매물 정보'));
 assert.ok(unverified[3].missingConditions.includes('매물 수집·관측일'));
});

test('invalid or future dates never establish freshness, and a valid collection date is a fallback',()=>{
 const rooms=[
  listing('valid-fallback',{lastSeenAt:'2027-01-01',collectedAt:'2026-11-20'}),
  listing('malformed',{collectedAt:'2026-02-30'}),
  listing('future',{collectedAt:'2026-11-21'}),
  listing('no-evidence',{firstCollectedAt:'2026-11-20',syncStatus:'current'})
 ];
 const {results,unverified}=recommend(rooms,conditions,{now});
 assert.deepEqual(results.map(item=>item.id),['valid-fallback']);
 assert.equal(results[0].lastSeenAt,null);
 assert.equal(unverified.length,3);
 assert.ok(unverified.every(item=>item.syncStatus==='unknown'&&item.score===null));
});
