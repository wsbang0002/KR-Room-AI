import assert from 'node:assert/strict';
import test from 'node:test';
import {handleConditions} from '../api/conditions.js';
import {handleSearch} from '../api/search.js';
import {inventoryOverview} from '../lib/inventory.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const env={
 PUBLIC_SAVED_LISTINGS:'true',DATA_RIGHTS_REVIEWED:'false',AI_PROVIDER:'openrouter-free',
 OPENROUTER_API_KEY:'test-only',ENABLE_WALKING_ROUTES:'true',TMAP_APP_KEY:'test-only'
};
const guest={headers:{}};
const city='강원특별자치도 원주시 무실동';
const room=id=>({id,address:city,rent:35,deposit:300,fee:5,roomType:'원룸',lat:37.34,lng:127.92});

test('guests can discover and filter both saved sources without exposing operational fields',async()=>{
 const store=new FakeRedis();
 const privateFields={runId:'internal-run',owner:{email:'private@example.test'},contact:'internal-contact'};
 store.write('knuroom:listing:stored',JSON.stringify({...room('stored'),...privateFields,
  url:'https://www.dabangapp.com/room/stored?contact=internal-contact'}));
 let requests=0;
 const options={req:guest,store,env:{...env,APIFY_TOKEN:'test-only',APIFY_DATASET_ID:'saved-a'},
  fetcher:async(url,init)=>{
   requests++;
   assert.equal(new URL(url).pathname,'/v2/datasets/saved-a/items');
   assert.equal(init.method||'GET','GET');
   return Response.json([{...room('dataset'),...privateFields}]);
  }};
 const overview=await inventoryOverview(guest,options);
 assert.equal(overview.regions[0].count,2);
 const result=await handleSearch({query:'원주시 무실동 관리비 포함 월 50만원 이하 원룸'},options);
 assert.equal(result.status,200);
 assert.equal(result.data.parser,'local');
 assert.deepEqual(result.data.results.map(item=>item.id).sort(),['dataset','stored']);
 const stored=result.data.results.find(item=>item.id==='stored');
 assert.equal(stored.total,40);
 assert.equal(stored.url,'https://www.dabangapp.com/room/stored');
 assert.doesNotMatch(JSON.stringify(result.data),/internal-run|private@example|internal-contact/);
 const empty=await handleSearch({query:'원주시 무실동 관리비 포함 월 10만원 이하 원룸'},options);
 assert.equal(empty.status,200);
 assert.equal(empty.data.coverage.count,2);
 assert.equal(empty.data.results.length+empty.data.unverified.length,0);
 assert.equal(requests,1);
 assert.ok(store.calls.every(([command])=>['SCAN','MGET'].includes(command)));
});

test('guest mode uses local conditions and reports unverified travel without a provider call',async()=>{
 const store=new FakeRedis();
 store.write('knuroom:listing:a',JSON.stringify(room('a')));
 for(const reviewed of ['true','false']){
  const envWithRights={...env,DATA_RIGHTS_REVIEWED:reviewed};
  let calls=0;
  const unexpected=()=>{calls++;throw Error('Unexpected provider call');};
  const options={env:envWithRights,req:guest,store,fetcher:unexpected,analyze:unexpected,calculateRoute:unexpected};
  const query='원주시 무실동 원룸, 강원대 원주캠퍼스까지 도보 15분';
  const parsed=await handleConditions({query},options);
  assert.equal(parsed.state,'ready');
  assert.equal(parsed.interpretation.mode,'local');
  const response=await handleSearch({query,confirmedConditions:parsed.conditions},options);
  assert.equal(response.status,200);
  assert.equal(response.data.walking.status,'login-required');
  assert.equal(response.data.walking.selectedCount,0);
  assert.equal(response.data.results.length,0);
  assert.deepEqual(response.data.unverified[0].missingConditions,['이동시간']);
  assert.equal(calls,0);
 }
});

test('supplying a collection job requires authentication before any destination or inventory read',async()=>{
 const store=new FakeRedis();
 let fetches=0;
 const options={env,store,req:guest,fetcher:()=>{fetches++;throw Error('unexpected read');}};
 await assert.rejects(handleSearch({query:'원주시 무실동 원룸',jobId:'a'.repeat(64),destinationId:'osm-N-123'},options),{status:401});
 assert.equal(store.calls.length,0);
 assert.equal(fetches,0);
});
