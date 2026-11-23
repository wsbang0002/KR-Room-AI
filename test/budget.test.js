import test from 'node:test';
import assert from 'node:assert/strict';
import {checkApifyBudget} from '../lib/apify-budget.js';
import {statusData} from '../api/status.js';
const env = {ENABLE_LIVE_COLLECTION:'true', APIFY_TOKEN:'test-only'};
const reply = (spent, limit=5) => async () => ({ok:true,json:async()=>({data:{limits:{maxMonthlyUsageUsd:limit},current:{monthlyUsageUsd:spent}}})});
test('disabled by default', async()=>assert.equal((await checkApifyBudget({env:{}})).code,'COLLECTION_DISABLED'));
test('hard limit above $10 fails closed', async()=>assert.equal((await checkApifyBudget({env,fetcher:reply(0,10.01)})).code,'HARD_LIMIT_NOT_SET'));
test('at $4.2 with $0.51 estimate blocks', async()=>assert.equal((await checkApifyBudget({env,fetcher:reply(4.2)})).code,'BUDGET_EXHAUSTED'));
test('at $3.5 with $0.51 estimate allows', async()=>assert.equal((await checkApifyBudget({env,fetcher:reply(3.5)})).allowed,true));
test('usage lookup failure fails closed', async()=>assert.equal((await checkApifyBudget({env,fetcher:async()=>{throw Error('network');}})).code,'LIMIT_LOOKUP_FAILED'));
test('invalid amounts fail closed', async()=>assert.equal((await checkApifyBudget({env,fetcher:reply(NaN)})).code,'INVALID_LIMIT_DATA'));

test('a $10 account with observed usage can reserve up to the $9 projected stop', async()=>{
 const account=await checkApifyBudget({env,fetcher:reply(.152325265,10)});
 assert.equal(account.allowed,true);
 assert.equal(account.hardLimitUsd,10);
 assert.equal(account.spentUsd,.152325265);
 assert.equal(account.appStopUsd,9);
 assert.equal(account.estimatedRunUsd,.51);
 assert.equal((await checkApifyBudget({env,fetcher:reply(8.49,10)})).allowed,true);
 for(const spent of [8.490001,9,10]){
  assert.equal((await checkApifyBudget({env,fetcher:reply(spent,10)})).code,'BUDGET_EXHAUSTED');
 }
});

test('a lower account ceiling or an explicit lower app stop independently restricts collections', async()=>{
 const checked=await checkApifyBudget({env,fetcher:reply(3.99,5)});
 assert.equal(checked.allowed,true);
 assert.equal(checked.appStopUsd,4.5);
 const smaller={...env,APIFY_MONTHLY_BUDGET_USD:'5',APIFY_SOFT_STOP_USD:'4.50'};
 const atBoundary=await checkApifyBudget({env:smaller,fetcher:reply(3.99,10)});
 assert.equal(atBoundary.allowed,true);
 assert.equal(atBoundary.appStopUsd,4.5);
 assert.equal((await checkApifyBudget({env:smaller,fetcher:reply(3.990001,10)})).code,'BUDGET_EXHAUSTED');
});

test('per-run estimates above $0.51 are blocked before any account request', async()=>{
 const result=await checkApifyBudget({env,estimatedRunUsd:.510001,fetcher:()=>assert.fail('no account lookup for an invalid estimate')});
 assert.equal(result.code,'INVALID_ESTIMATE');
 assert.equal(statusData({APIFY_MAX_COST_USD:'.45'}).apifyMaxCostUsd,.45);
});

test('status exposes configured app limits, independent of any account lookup',()=>{
 for(const [settings,monthly,soft] of [
  [{},10,9],
  [{APIFY_MONTHLY_BUDGET_USD:'5',APIFY_SOFT_STOP_USD:'4.5'},5,4.5],
 ]){
  const status=statusData(settings);
  assert.equal(status.apifyMonthlyHardCapUsd,monthly);
  assert.equal(status.apifySoftStopUsd,soft);
  assert.equal(status.apifyMaxResults,20);
  assert.equal(status.apifyMaxCostUsd,.51);
  assert.equal(status.liveCollectionEnabled,false);
 }
});
