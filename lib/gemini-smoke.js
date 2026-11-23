import {admin,jsonFetch} from './security.js';
import {geminiThinkingConfig,primaryGeminiModel} from './gemini-model.js';
import {redis} from './store.js';
// Fixed, non-sensitive prompt. Shares Gemini's existing daily generation allowance.
export async function smokeGemini({req,env=process.env,fetcher=fetch,store}={}){
 const user=admin(req,env),model=primaryGeminiModel(env);
 if(!env.GEMINI_API_KEY)return {status:'missing',model,message:'GEMINI_API_KEY 미설정'};
 const key='knuroom:gemini:smoke:'+encodeURIComponent(model);
 const timings={google:{}};const started=performance.now();
 let db;
 try{
  db=store||redis(env,fetcher);
  const reserveStarted=performance.now();
  const old=await db.reserve({key,user,kind:'gemini',limit:20,cost:1,budget:20,ttl:60,value:{pending:true}});
  timings.redisReserveMs=Math.round(performance.now()-reserveStarted);
  if(old)return old.result?{...old.result,cached:true}:{status:'blocked',model,message:'검사 진행 중 또는 재검사 대기 중'};
 }catch{return {status:'blocked',model,message:'호출 제한 또는 Redis 연결 오류'};}
 let result;
 try{
  const data=await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{fetcher,timeoutMs:35000,timings:timings.google,method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify({contents:[{role:'user',parts:[{text:'안녕'}]}],generationConfig:{maxOutputTokens:1024,temperature:1,thinkingConfig:geminiThinkingConfig(model)}})});
  const reply=data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('')||'';
  result={status:reply?'verified':'failed',model,prompt:'안녕',reply:reply.slice(0,300),finishReason:data.candidates?.[0]?.finishReason||null,reason:reply?'live-minimal-generation':'empty-response',message:reply?'최소 생성 요청 성공':'최소 생성 요청에 텍스트가 없습니다.'};
 }catch(e){result={status:'failed',model,reason:Number.isInteger(e.upstreamStatus)?'upstream-http-'+e.upstreamStatus:['TimeoutError','AbortError'].includes(e.name)?'upstream-timeout':'unavailable',message:'JSON 지시 없는 최소 생성 요청도 실패했습니다.'};}
 result.timings={...timings,totalMs:Math.round(performance.now()-started)};
 try{await db.set(key,{result},result.status==='verified'?600:60);}catch{}
 return result;
}
