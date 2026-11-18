import fs from 'node:fs';
import {normalize} from './core.js';

const ttl=5*60*1000;
const pageSize=100;
let cache={};
const unique=input=>[...new Map(input.map(v=>normalize(v)).filter(v=>v.id&&v.rent!==null).map(v=>[v.id,v])).values()];

function readSnapshot(){
 try{
  const raw=JSON.parse(fs.readFileSync(new URL('../data/listings.json',import.meta.url),'utf8'));
  if(!Array.isArray(raw))throw Error('Invalid snapshot');
  const items=unique(raw);
  return {items,partial:raw.length>0&&!items.length};
 }catch(error){
  return {items:[],partial:error.code!=='ENOENT'};
 }
}
export function snapshot(){return readSnapshot().items;}
export function apifyEnabled(env=process.env){return Boolean(env.APIFY_TOKEN&&env.APIFY_DATASET_ID);}

export async function loadListings({fetcher=fetch,env=process.env,now=Date.now()}={}){
 if(!apifyEnabled(env))return {...readSnapshot(),source:'snapshot',notice:'기존 원주 저장 자료입니다. 원본 수집일과 공실 확인 여부를 확인하세요.'};
 // Scope each outstanding request and its cached response to a single dataset and credential.
 const key=[env.APIFY_DATASET_ID,env.APIFY_TOKEN].join('\n');
 if(cache.key!==key)cache={key};
 const current=cache;
 if(current.page&&now-current.at<ttl)return {...current.page,source:'apify-cache',notice:'기존 Apify Dataset 조회 자료입니다.'};
 if(!current.pending){
  const id=encodeURIComponent(env.APIFY_DATASET_ID);
  const url=`https://api.apify.com/v2/datasets/${id}/items?format=json&clean=true&limit=${pageSize}`;
  current.pending=(async()=>{
   const response=await fetcher(url,{headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`},signal:AbortSignal.timeout(7000),redirect:'error'});
   if(!response.ok)throw Error('Dataset request failed');
   const records=await response.json();
   if(!Array.isArray(records))throw Error('Invalid dataset');
   const items=unique(records);
   const totalHeader=response.headers?.get?.('x-apify-pagination-total');
   const total=totalHeader==null?null:Number(totalHeader);
   const truncated=Number.isSafeInteger(total)?total>records.length:records.length>=pageSize;
   current.page={items,partial:truncated||(records.length>0&&!items.length)};
   current.at=now;
   return current.page;
  })().finally(()=>{current.pending=null;});
 }
 try{return {...await current.pending,source:'apify-api',notice:'기존 Apify Dataset 매물입니다. 공실·계약 가능 여부는 미확인입니다.'};}
 catch{
  if(current.page?.items.length)return {...current.page,source:'apify-stale',failed:true,stale:true,notice:'Dataset 조회 장애로 이전 조회 자료를 표시합니다.'};
  return {...readSnapshot(),source:'snapshot-fallback',failed:true,stale:true,notice:'Dataset 조회 장애가 발생했습니다.'};
 }
}
