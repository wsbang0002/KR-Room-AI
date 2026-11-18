import {walkingSettings} from '../lib/walking.js';
import {selectedProvider} from '../lib/gemini.js';
import {apifyEnabled} from '../lib/apify.js';
import {collectionReady} from '../lib/collection.js';
import {admin,endpoint} from '../lib/security.js';
export function statusData(env=process.env){return {service:'KNU Room AI',version:'0.6.0',analysisProvider:selectedProvider(env),openrouterConfigured:Boolean(env.OPENROUTER_API_KEY),geminiConfigured:Boolean(env.GEMINI_API_KEY),apifyConfigured:apifyEnabled(env),liveCollectionEnabled:collectionReady(env),privateData:env.DATA_RIGHTS_REVIEWED!=='true',redisConfigured:Boolean(env.UPSTASH_REDIS_REST_URL&&env.UPSTASH_REDIS_REST_TOKEN),apifySoftStopUsd:4.5,apifyMonthlyHardCapUsd:5,routeProvider:'tmap',walking:walkingSettings(env),note:'Configured는 환경변수 존재 여부이며 외부 API 호출 성공을 보증하지 않습니다.'};}
export default endpoint('GET',req=>{
 if(req.query?.scope==='admin'){
  admin(req);
  return {...statusData(),adminAuthenticated:true};
 }
 return statusData();
});
