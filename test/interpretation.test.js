import assert from 'node:assert/strict';
import test from 'node:test';
import {handleConditions} from '../api/conditions.js';
import {buildConditions,localConditions} from '../lib/conditions.js';

const env={AI_PROVIDER:'openrouter-free',DATA_RIGHTS_REVIEWED:'true'};
const local={env:{AI_PROVIDER:'local'}};
const area='원주시 무실동 ';

test('optional appliances clear positive requirements and explicitly unsupported exclusions never qualify as preferred',async()=>{
 const first=await handleConditions({query:area+'에어컨과 세탁기 필수, 주차 필수'},local);
 assert.deepEqual(first.conditions.requiredOptions,['에어컨','세탁기','주차']);
 const optional=await handleConditions({query:'에어컨과 세탁기는 없어도 괜찮아',previous:first.conditions},local);
 assert.deepEqual(optional.conditions.requiredOptions,['주차']);
 assert.deepEqual(optional.conditions.preferredOptions,['주차']);
 assert.deepEqual(optional.interpretation,{mode:'local',unsupported:[]});
 const exclude=await handleConditions({query:'주차 없는 매물만',previous:optional.conditions},local);
 assert.deepEqual(exclude.conditions.requiredOptions,[]);
 assert.deepEqual(exclude.conditions.preferredOptions,[]);
 assert.deepEqual(exclude.interpretation.unsupported,['주차 없는 매물만']);
 assert.deepEqual(localConditions('세탁기 없는 방은 제외').requiredOptions,['세탁기']);
 assert.deepEqual(localConditions('주차 공간 말고 냉장고 있는 곳').preferredOptions,['냉장고']);
});

test('price and commute comparisons use their expressed direction and compact Korean money units',async()=>{
 const original=await handleConditions({query:area+'보증금 500에 월세 40'},local);
 assert.equal(original.conditions.maxDeposit,500);assert.equal(original.conditions.maxRent,40);
 const {conditions:near}=await handleConditions({query:'월세보다 학교가 가까운 게 중요해',previous:original.conditions},local);
 assert.ok(near.weights.commute>near.weights.cost);
 assert.equal(near.maxRent,40);assert.equal(near.maxDeposit,500);
 const {conditions:cheap}=await handleConditions({query:'학교 거리보다 월세가 더 중요해',previous:near},local);
 assert.ok(cheap.weights.cost>cheap.weights.commute);
 for(const query of ['학교까지 도보로 15분','도보 최대 15분','통학 시간은 최대 15분']){
  assert.equal(localConditions(query).maxCommuteMinutes,15);
 }
});

test('AI, local and fallback results report their actual interpreter and sunlight/noise limitations',async()=>{
 const input={query:area+'햇빛 잘 드는 조용한 방, 세탁기 없어도 괜찮아'};
 const ai={preferredOptions:['세탁기'],requiredOptions:['세탁기']};
 const success=await handleConditions(input,{env,analyze:async()=>({ai,parser:'openrouter-cache'})});
 assert.deepEqual(success.interpretation,{mode:'ai',unsupported:['채광','소음']});
 assert.deepEqual(success.conditions.preferredOptions,[]);
 assert.deepEqual(buildConditions(input.query,ai).requiredOptions,[]);
 for(const analyze of [async()=>({ai:null,parserReason:'daily-rate-limit'}),async()=>{throw Error('unavailable');}]){
  const result=await handleConditions(input,{env,analyze});
  assert.deepEqual(result.interpretation,{mode:'fallback',unsupported:['채광','소음']});
 }
 const prepared=await handleConditions(input,{env:{...env,DATA_RIGHTS_REVIEWED:'false'},analyze:()=>assert.fail()});
 assert.equal(prepared.interpretation.mode,'local');
});

test('unsupported conditions are replayed through the ambiguity question and cleared by an explicit new search',async()=>{
 const first=await handleConditions({query:'중앙동 햇빛 잘 드는 조용한 방'},local);
 assert.equal(first.state,'clarify');assert.deepEqual(first.interpretation.unsupported,['채광','소음']);
 const answer=await handleConditions({query:'원주시요',pending:first.pending},local);
 assert.equal(answer.state,'ready');assert.deepEqual(answer.interpretation.unsupported,['채광','소음']);
 const restart=await handleConditions({query:'새 검색 원주시 무실동',pending:first.pending},local);
 assert.deepEqual(restart.interpretation.unsupported,[]);
});
