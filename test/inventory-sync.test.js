import test from 'node:test';
import assert from 'node:assert/strict';
import {syncInventory} from '../lib/inventory-sync.js';
import collect from '../api/collect.js';
import {issueSearchSession} from '../lib/search-session.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const env={ADMIN_API_KEY:'local-test-operator-key-for-sync',APIFY_TOKEN:'local-apify',APIFY_DATASET_ID:'configured'};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
const rooms=[{id:'wonju-test',address:'강원특별자치도 원주시 무실동',rent:35,metadata:{scrapedAt:'2026-01-02T03:04:05Z'}}];
const store=()=>new FakeRedis();

test('operator can verify the target in Redis even if the previous run has no receipt',async()=>{
 const db=store();
 db.write('knuroom:apify:active','orphan');
 const fetcher=async(url,options)=>{
  assert.equal(options.method,'GET');
  assert.equal(new URL(url).pathname,'/v2/datasets/configured/items');
  return Response.json(rooms);
 };
 const result=await syncInventory({req,env,fetcher,store:db,location:'원주시 흥업면'});
 assert.equal(result.previous.state,'UNIDENTIFIED');
 assert.deepEqual(result.issues,[]);
 assert.equal(result.dataset.verifiedPresent,1);
 assert.deepEqual(result.database,{total:1,location:'강원특별자치도 원주시 흥업면',regionCount:0,unlocated:0});
 const failed=await syncInventory({req,env,store:db,location:'원주시 무실동',fetcher:async()=>Response.json({}, {status:503})});
 assert.equal(failed.dataset,null);
 assert.equal(failed.database.regionCount,1);
 assert.equal(failed.issues.length,1);
 assert.equal(db.read('knuroom:apify:active'),'orphan');
});

test('sync requires an operator and an unrecognized action never falls through to a paid collection',async t=>{
 const previous=process.env.ADMIN_API_KEY;
 process.env.ADMIN_API_KEY=env.ADMIN_API_KEY;
 t.after(()=>{if(previous===undefined)delete process.env.ADMIN_API_KEY;else process.env.ADMIN_API_KEY=previous;});
 t.mock.method(globalThis,'fetch',()=>assert.fail('unexpected service call'));
 const cookie=issueSearchSession(process.env).cookie.split(';')[0];
 for(const [headers,action,expected] of [[{},'sync-existing',401],[{cookie},'sync-existing',401],[req.headers,'sync-existng',400]]){
  const res={setHeader(){},status(code){this.code=code;return this;},json(){}};
  await collect({method:'POST',headers,body:{query:'원주시 흥업면',action}},res);
  assert.equal(res.code,expected);
 }
});
