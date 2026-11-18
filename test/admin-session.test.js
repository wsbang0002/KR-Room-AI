import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import status from '../api/status.js';

test('admin status requires a matching credential and public status never confirms a login',async t=>{
 const original=process.env.ADMIN_API_KEY;
 const credential=randomUUID();
 process.env.ADMIN_API_KEY=credential;
 t.after(()=>{
  if(original===undefined)delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY=original;
 });
 async function get(query,authorization){
  const reply={setHeader(){},status(code){this.code=code;return this;},json(data){this.body=data;}};
  await status({method:'GET',query,headers:{authorization}},reply);
  return reply;
 }
 const general=await get({},'Bearer '+credential);
 assert.equal(general.code,200);
 assert.equal(general.body.adminAuthenticated,undefined);
 for(const authorization of [undefined,'Bearer '+randomUUID()]){
  assert.equal((await get({scope:'admin'},authorization)).code,401);
 }
 const authenticated=await get({scope:'admin'},'Bearer '+credential);
 assert.equal(authenticated.code,200);
 assert.equal(authenticated.body.adminAuthenticated,true);
 assert.ok(!JSON.stringify(authenticated.body).includes(credential));
});
