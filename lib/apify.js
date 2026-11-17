import fs from 'node:fs';
import {normalize} from './core.js';

const cache = {at:0, items:null, pending:null,key:null};
const ttl = 5 * 60 * 1000;
const unique = input => [...new Map(input.map(v=>normalize(v)).filter(v=>v.id&&v.rent!==null).map(v=>[v.id,v])).values()];
export function snapshot() {
  try {const raw=JSON.parse(fs.readFileSync(new URL('../data/listings.json',import.meta.url),'utf8'));return unique(Array.isArray(raw)?raw:[]);} catch {return [];}
}
export function apifyEnabled(env=process.env){return Boolean(env.APIFY_TOKEN&&env.APIFY_DATASET_ID);}
export async function loadListings({fetcher=fetch,env=process.env,now=Date.now()}={}){
 const stored=snapshot();
 const key=`${env.APIFY_DATASET_ID||''}:${env.APIFY_TOKEN||''}`;
 if(cache.key!==key){cache.at=0;cache.items=null;cache.pending=null;cache.key=key;}
 if(!apifyEnabled(env))return {items:stored,source:'snapshot',notice:'Apify API 미설정: GitHub에 포함된 수집 시점의 매물 데이터입니다.'};
 if(cache.items&&now-cache.at<ttl)return {items:cache.items,source:'apify-cache',notice:'Apify Dataset API 조회 결과(임시 캐시)입니다.'};
 if(!cache.pending){
  cache.pending=(async()=>{
   const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),7000);
   try{
    const id=encodeURIComponent(env.APIFY_DATASET_ID);
    const url=`https://api.apify.com/v2/datasets/${id}/items?format=json&clean=true&limit=100`;
    const response=await fetcher(url,{headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`},signal:controller.signal});
    if(!response.ok)throw new Error(`Apify HTTP ${response.status}`);
    const records=await response.json();if(!Array.isArray(records))throw new Error('Dataset 형식 오류');
    const converted=unique(records);
    if(converted.length===0)throw new Error('Dataset 매물 0건');
    cache.items=converted;cache.at=Date.now();return converted;
   }finally{clearTimeout(timeout);}
  })().finally(()=>{cache.pending=null;});
 }
 try{return {items:await cache.pending,source:'apify-api',notice:'Apify Dataset API에서 조회한 매물입니다. 공실과 정확한 위치는 별도 검증이 필요합니다.'};}
 catch(e){return {items:stored,source:'snapshot-fallback',notice:'Apify 조회 실패. 기존 원주 스냅샷 자료로 검색합니다.'};}
}
