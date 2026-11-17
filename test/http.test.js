import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('local HTTP serves UI and enforces API methods, JSON, auth, safety defaults',async t=>{
 const server=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',GEMINI_API_KEY:'',APIFY_TOKEN:'',ADMIN_API_KEY:'',UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:'',ENABLE_LIVE_COLLECTION:'false',DATA_RIGHTS_REVIEWED:'false'},stdio:['ignore','pipe','pipe']});
 t.after(()=>server.kill());
 const port=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('server startup timeout')),5000);server.stdout.on('data',chunk=>{output+=chunk;const m=output.match(/localhost:(\d+)/);if(m){clearTimeout(timeout);resolve(m[1]);}});server.on('error',reject);});
 const base=`http://127.0.0.1:${port}`;
 const status=await (await fetch(base+'/api/status')).json();assert.equal(status.liveCollectionEnabled,false);assert.equal(status.redisConfigured,false);
 assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/api/search')).status,405);
 assert.equal((await fetch(base+'/api/search',{method:'POST',body:'not-json'})).status,400);
 assert.equal((await fetch(base+'/api/search',{method:'POST',body:JSON.stringify({query:'서울 관악구 원룸'})})).status,401);
 const demo=await (await fetch(base+'/api/search',{method:'POST',body:JSON.stringify({query:'서울 관악구 원룸',demo:true})})).json();assert.equal(demo.mode,'demo');assert.ok(demo.results.length>0);
 assert.equal((await fetch(base+'/api/redis-inspect')).status,401);assert.equal((await fetch(base+'/.env')).status,404);
 server.kill();await once(server,'exit');
});
