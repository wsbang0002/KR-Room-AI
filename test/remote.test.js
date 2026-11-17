import test from 'node:test';
import assert from 'node:assert/strict';
import {loadListings,apifyEnabled} from '../lib/apify.js';
import {statusData} from '../api/status.js';
test('API configuration has two independent providers',()=>{
 const env={GEMINI_API_KEY:'x',APIFY_TOKEN:'token',APIFY_DATASET_ID:'dataset'};
 assert.equal(statusData(env).geminiConfigured,true);
 assert.equal(statusData(env).apifyConfigured,true);
 assert.equal(apifyEnabled({APIFY_TOKEN:'x'}),false);
});
test('fetch external Apify Dataset through token header and normalize prices',async()=>{
 const raw=[{id:'from-api',propertyTitle:'원룸',deposit:300,rent:30,maintenance_cost:50000,dong_name:'흥업면',room_type:'원룸',url:'https://www.dabangapp.com/room/from-api'}];
 let called=false;
 const result=await loadListings({env:{APIFY_TOKEN:'secret',APIFY_DATASET_ID:'abc'},fetcher:async(url,init)=>{called=true;assert.match(url,/\/v2\/datasets\/abc\/items/);assert.equal(init.headers.Authorization,'Bearer secret');return {ok:true,json:async()=>raw};}});
 assert.equal(called,true);assert.equal(result.source,'apify-api');assert.equal(result.items[0].fee,5);
});
