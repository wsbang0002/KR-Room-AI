import {inventoryOverview} from '../lib/inventory.js';
import {listingRouteSettings,walkingSettings} from '../lib/walking.js';
import {selectedProvider} from '../lib/gemini.js';
import {primaryGeminiModel} from '../lib/gemini-model.js';
import {apifyEnabled} from '../lib/apify.js';
import {apifyBudgetSettings,apifyRunBudgetUsd} from '../lib/apify-budget.js';
import {collectionReady,MAX_COLLECTION_RESULTS} from '../lib/collection.js';
import {admin,endpoint} from '../lib/security.js';
export function statusData(env=process.env){
 const analysisProvider=selectedProvider(env);
 const model=primaryGeminiModel(env);
 const budget=apifyBudgetSettings(env);
 const listingRoutes={};
 for(const mode of ['car','bus']){
  const {enabled,keyConfigured,dailyLimit,provider}=listingRouteSettings(mode,env);
  listingRoutes[mode]={enabled,keyConfigured,dailyLimit,provider};
 }
 return {
  service:'KNU Room AI',version:'0.6.0',analysisProvider,
  geminiModel:analysisProvider==='gemini'&&/^gemini-\d+\.\d+-flash(?:-lite)?$/.test(model)?model:null,
  openrouterConfigured:Boolean(env.OPENROUTER_API_KEY),geminiConfigured:Boolean(env.GEMINI_API_KEY),
  apifyConfigured:apifyEnabled(env),liveCollectionEnabled:collectionReady(env),privateData:env.DATA_RIGHTS_REVIEWED!=='true',
  apifyMaxResults:MAX_COLLECTION_RESULTS,apifyMaxCostUsd:apifyRunBudgetUsd(env),
  redisConfigured:Boolean(env.UPSTASH_REDIS_REST_URL&&env.UPSTASH_REDIS_REST_TOKEN),
  apifySoftStopUsd:budget?.softStopUsd??null,apifyMonthlyHardCapUsd:budget?.monthlyBudgetUsd??null,routeProvider:'tmap',walking:walkingSettings(env),listingRoutes,
  note:'Configured는 환경변수 존재 여부이며 외부 API 호출 성공을 보증하지 않습니다.'
 };
}
export default endpoint('GET',req=>{
 if(req.query?.scope==='coverage')return inventoryOverview(req);
 if(req.query?.scope==='admin'){
  admin(req);
  return {...statusData(),adminAuthenticated:true};
 }
 return statusData();
});
